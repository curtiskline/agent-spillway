import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  SpillwayError,
  type HarnessAdapter,
  type ReviewTier,
  type SpillwayConfig,
  type TaskDetail,
  type TaskRecord,
  type AttemptRecord,
  type Usage,
  type NextAction,
} from "./contracts.js";
import { parseTask } from "./task.js";
import { getPolicy } from "./policy.js";
import { Store } from "./store.js";
import { GitWorkspace, within } from "./git.js";
import { OpenCodeAdapter, probeEndpoint } from "./harness.js";
import { verifyAttempt } from "./verify.js";
import { REVIEW_RUBRIC, parseReviewReport, runLocalReview } from "./review.js";

const sensitive =
  /(^|\/)(\.github|\.gitlab|migrations?|auth|authentication|authorization|permissions?|secrets?)(\/|$)|(^|\/)(package\.json|[^/]*lock[^/]*|Cargo\.toml|go\.mod|pyproject\.toml|requirements[^/]*\.txt|Dockerfile)$/i;
const tierRank = { "checks-only": 0, local: 1, frontier: 2 };
const policyRank = (value: string) =>
  ["local-only", "open-weight-hosted-ok", "frontier-ok"].indexOf(value);
const endpointRank = (value: string) =>
  ["local", "open-weight-hosted", "frontier"].indexOf(value);

export class Controller {
  private busy = false;
  private idle: Promise<void> = Promise.resolve();
  constructor(
    readonly config: SpillwayConfig,
    readonly store: Store,
    private adapter: HarnessAdapter = new OpenCodeAdapter(),
    private signal?: AbortSignal,
  ) {}
  private async withSlot<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy)
      throw new SpillwayError(
        "BUSY",
        "Execution or review is already running.",
        409,
      );
    this.busy = true;
    let done: () => void = () => {};
    this.idle = new Promise((resolve) => {
      done = resolve;
    });
    try {
      return await action();
    } finally {
      this.busy = false;
      done();
    }
  }
  waitForIdle(): Promise<void> {
    return this.idle;
  }
  private workspace(task: TaskRecord): GitWorkspace {
    return new GitWorkspace(task.spec.repo, this.config.data_dir);
  }
  private artifacts(attemptId: number): string {
    return join(this.config.data_dir, "artifacts", String(attemptId));
  }
  private latest(taskId: string): AttemptRecord | undefined {
    return this.store.listAttempts(taskId).at(-1);
  }
  private hasUncertainty(): boolean {
    return this.store
      .listTasks()
      .some(
        (task) =>
          !["abandoned", "accepted", "rejected"].includes(task.state) &&
          (this.store
            .listAttempts(task.id)
            .some((a) => a.outcome === "uncertain") ||
            this.store
              .listReviews(task.id)
              .some((r) => r.outcome === "uncertain")),
      );
  }
  private activeExecution(): boolean {
    return this.store
      .listTasks()
      .some(
        (task) =>
          this.store
            .listAttempts(task.id)
            .some((a) => a.outcome === "running") ||
          this.store.listReviews(task.id).some((r) => r.outcome === "running"),
      );
  }
  private frontierAllowed(task: TaskRecord): boolean {
    return (
      this.store.getFrontierState().available &&
      this.config.repositories.some(
        (repo) =>
          repo.path === task.spec.repo && repo.data_policy === "frontier-ok",
      )
    );
  }
  private requireFrontier(task: TaskRecord): void {
    if (!this.store.getFrontierState().available)
      throw new SpillwayError(
        "FRONTIER_OFF",
        "Frontier work is unavailable; local work can continue.",
        409,
      );
    if (
      !this.config.repositories.some(
        (repo) =>
          repo.path === task.spec.repo && repo.data_policy === "frontier-ok",
      )
    )
      throw new SpillwayError(
        "DATA_POLICY",
        "Repository data policy does not permit frontier session work.",
        403,
      );
  }
  private tierFor(task: TaskRecord): ReviewTier {
    let tier = task.reviewTier;
    const policy = getPolicy(this.config.policy);
    const required =
      task.spec.review === "default"
        ? policy.classes[task.spec.class].review
        : task.spec.review;
    if (tierRank[required] > tierRank[tier]) tier = required;
    if (
      !task.spec.checks.length ||
      task.spec.class === "risky" ||
      task.spec.scope.some((path) => sensitive.test(path))
    )
      tier = "frontier";
    if (tier === "checks-only" && !this.config.allow_checks_only)
      tier = "local";
    return tier;
  }
  async addTask(raw: string): Promise<TaskRecord> {
    const spec = parseTask(raw);
    spec.repo = await realpath(spec.repo.replace(/^~(?=\/)/, homedir()));
    const repo = this.config.repositories.find(
      (entry) => entry.path === spec.repo,
    );
    if (!repo)
      throw new SpillwayError(
        "UNREGISTERED_REPO",
        "Register the repository in private config before banking tasks.",
      );
    if (spec.class === "design")
      throw new SpillwayError(
        "PLANNER_WORK",
        "Design tasks require planner decisions before banking.",
      );
    const policy = getPolicy(this.config.policy);
    const local = policy.classes[spec.class].local_eligible;
    const profile = this.config.profiles.find(
      (entry) => entry.id === this.config.default_profile,
    );
    if (!profile)
      throw new SpillwayError(
        "PROFILE_MISSING",
        "Default profile is not configured.",
      );
    if (local) {
      const endpoint = this.config.endpoints.find(
        (entry) => entry.id === profile.endpoint,
      );
      if (
        !endpoint ||
        endpoint.kind === "frontier" ||
        endpointRank(endpoint.kind) > policyRank(repo.data_policy)
      )
        throw new SpillwayError(
          "DATA_POLICY",
          "Repository data policy does not permit the selected local endpoint.",
        );
      if (!profile.qualified_classes.includes(spec.class))
        throw new SpillwayError(
          "UNQUALIFIED_CLASS",
          "Selected profile does not qualify for this task class.",
        );
    }
    let tier: ReviewTier =
      spec.review === "default"
        ? policy.classes[spec.class].review
        : spec.review;
    if (
      !local ||
      !spec.checks.length ||
      spec.class === "risky" ||
      spec.scope.some((path) => sensitive.test(path))
    )
      tier = "frontier";
    if (tier === "checks-only" && !this.config.allow_checks_only)
      throw new SpillwayError(
        "REVIEW_POLICY",
        "Checks-only requires explicit experimental opt-in.",
      );
    this.store.addTask(spec, raw, profile.id, tier);
    if (!local)
      this.store.setTaskAction(
        spec.id,
        "held",
        "frontier-worker",
        "This class requires an owner frontier session.",
        tier,
      );
    return this.getDetail(spec.id).task;
  }
  getDetail(id: string): TaskDetail {
    const task = this.store.getTask(id);
    if (!task) throw new SpillwayError("NOT_FOUND", "Task not found.", 404);
    return {
      task,
      attempts: this.store.listAttempts(id),
      events: this.store.listEvents(id),
      reviews: this.store.listReviews(id),
    };
  }
  async decide(
    id: string,
    decision: "accepted" | "rejected",
  ): Promise<TaskRecord> {
    const task = this.getDetail(id).task;
    if (task.state !== "ready")
      throw new SpillwayError(
        "NOT_READY",
        "Owner decisions require a verified ready task.",
        409,
      );
    const attempt = this.latest(id);
    await this.requirePinned(task, attempt);
    const tier = this.tierFor(task);
    if (tier !== "checks-only") {
      const review = this.store
        .listReviews(id)
        .find(
          (row) =>
            row.attemptId === attempt!.id &&
            row.tier === tier &&
            row.outcome === "completed" &&
            row.resultSha === attempt!.resultSha &&
            row.report?.verdict === "accept",
        );
      if (!review)
        throw new SpillwayError(
          "REVIEW_REQUIRED",
          "The currently required review has not approved this commit.",
          409,
        );
    }
    this.store.setTaskState(id, decision);
    this.store.addEvent(id, "owner-decision", {
      decision,
      resultSha: attempt!.resultSha,
    });
    return this.getDetail(id).task;
  }
  private async requirePinned(
    task: TaskRecord,
    attempt: AttemptRecord | undefined,
  ): Promise<void> {
    if (
      !attempt?.resultSha ||
      !attempt.verification?.passed ||
      attempt.verification.resultSha !== attempt.resultSha ||
      attempt.outcome !== "completed"
    )
      throw new SpillwayError(
        "NO_RESULT",
        "No independently verified result exists.",
        409,
      );
    const w = this.workspace(task);
    const inspected = await w.inspect(
      attempt.worktree,
      attempt.baseSha,
      attempt.branch,
    );
    if (
      !inspected.clean ||
      inspected.head !== attempt.resultSha ||
      inspected.branch !== attempt.branch ||
      (await w.resolveBase(attempt.branch)) !== attempt.resultSha
    )
      throw new SpillwayError(
        "RESULT_CHANGED",
        "Result checkout or branch changed after verification.",
        409,
      );
  }
  async inspect(id: string) {
    const { task, attempts, reviews } = this.getDetail(id);
    const a = attempts.at(-1);
    return {
      worker: a?.worktree
        ? await this.workspace(task).inspect(a.worktree, a.baseSha, a.branch)
        : null,
      reviews: reviews ?? [],
    };
  }
  reconcile(id: string): TaskRecord {
    this.store.resolveUncertainty(id);
    return this.getDetail(id).task;
  }
  async recover(): Promise<void> {
    for (const a of this.store.recoverInflight()) {
      const task = this.getDetail(a.taskId).task;
      try {
        this.store.addEvent(
          task.id,
          "recovery-inspection",
          await this.workspace(task).inspect(a.worktree, a.baseSha, a.branch),
        );
      } catch {
        /*owner inspection still required*/
      }
      this.store.setTaskAction(
        task.id,
        "held",
        null,
        "Interrupted execution: inspect and stop surviving workers/reviewers before reconciliation.",
      );
    }
  }
  async runOnce(): Promise<string | null> {
    return this.withSlot(async () => {
      if (this.signal?.aborted) return null;
      if (this.hasUncertainty()) {
        for (const task of this.store
          .listTasks()
          .filter((t) => t.state === "queued"))
          this.store.setTaskAction(
            task.id,
            "queued",
            task.nextAction ?? "worker",
            "Queue paused for interrupted execution; inspect and reconcile after stopping surviving workers.",
          );
        return null;
      }
      if (this.activeExecution()) return null;
      for (const task of this.store.listTasks()) {
        if (
          task.nextAction === "frontier-worker" &&
          ["held", "escalated"].includes(task.state)
        ) {
          this.store.setTaskAction(
            task.id,
            this.frontierAllowed(task) ? "escalated" : "held",
            "frontier-worker",
            this.frontierAllowed(task)
              ? "Ready for an authorized Claude Code session to claim."
              : "Frontier session required; availability or repository policy holds this work.",
            "frontier",
          );
          continue;
        }
        if (task.nextAction === "review" && task.state === "held") {
          const tier = this.tierFor(task);
          if (tier !== task.reviewTier) this.store.setTaskReview(task.id, tier);
          if (tier === "frontier") {
            this.store.setTaskAction(
              task.id,
              "held",
              "review",
              this.frontierAllowed(task)
                ? "Awaiting owner-session frontier review."
                : "Frontier review held by availability or repository data policy.",
              "frontier",
            );
            continue;
          }
          if (await this.performLocalReview(this.getDetail(task.id).task))
            return task.id;
          continue;
        }
        if (
          (task.state === "queued" &&
            (task.nextAction === "worker" || !task.nextAction)) ||
          (task.nextAction === "repair" &&
            ["queued", "needs-repair"].includes(task.state))
        ) {
          if (await this.performLocalAttempt(task)) return task.id;
        }
      }
      return null;
    });
  }
  private async localBinding(task: TaskRecord, review = false) {
    const profileId = review
      ? (this.config.review_profile ?? task.profileId)
      : task.profileId;
    const profile = this.config.profiles.find((p) => p.id === profileId);
    const endpoint = this.config.endpoints.find(
      (e) => e.id === profile?.endpoint,
    );
    const repo = this.config.repositories.find(
      (r) => r.path === task.spec.repo,
    );
    if (
      !profile ||
      !endpoint ||
      !repo ||
      endpoint.kind === "frontier" ||
      endpointRank(endpoint.kind) > policyRank(repo.data_policy) ||
      !profile.qualified_classes.includes(task.spec.class)
    ) {
      this.store.setTaskAction(
        task.id,
        "held",
        null,
        "Configuration, qualification or repository data policy disallows local execution.",
      );
      return undefined;
    }
    if (
      !review &&
      !getPolicy(this.config.policy).classes[task.spec.class].local_eligible
    ) {
      this.store.setTaskAction(
        task.id,
        "held",
        "frontier-worker",
        "Policy now requires an owner frontier worker.",
        "frontier",
      );
      return undefined;
    }
    const health = await probeEndpoint(endpoint, profile.model);
    if (!health.healthy) {
      this.store.setTaskAction(
        task.id,
        review ? "held" : "queued",
        review ? "review" : (task.nextAction ?? "worker"),
        health.reason ?? "Endpoint unavailable.",
      );
      return undefined;
    }
    let version: string;
    try {
      version = await this.adapter.version();
    } catch {
      this.store.setTaskAction(
        task.id,
        "held",
        null,
        "Configured harness is unavailable.",
      );
      return undefined;
    }
    if (
      version !== profile.harness_version ||
      this.adapter.id !== profile.harness
    ) {
      this.store.setTaskAction(
        task.id,
        "held",
        null,
        "Harness version does not match the pinned profile.",
      );
      return undefined;
    }
    return { profile, endpoint, version };
  }
  private async dependenciesSatisfied(
    task: TaskRecord,
    workspace: GitWorkspace,
    baseSha: string,
  ): Promise<boolean> {
    for (const depId of task.spec.after) {
      const dep = this.store.getTask(depId);
      const result = this.latest(depId)?.resultSha;
      if (
        dep?.state !== "accepted" ||
        dep.spec.repo !== task.spec.repo ||
        !result ||
        !(await workspace.isAncestor(result, baseSha))
      )
        return false;
    }
    return true;
  }
  private canRepair(task: TaskRecord): boolean {
    const local = this.store
      .listAttempts(task.id)
      .filter((a) => a.kind !== "frontier" && a.outcome !== "transport_error");
    return (
      getPolicy(this.config.policy).max_repairs === 1 &&
      local.filter((a) => a.kind === "repair").length === 0 &&
      local.length < task.spec.limits.max_attempts
    );
  }
  private async performLocalAttempt(task: TaskRecord): Promise<boolean> {
    if (task.reviewTier === "checks-only" && !this.config.allow_checks_only) {
      this.store.setTaskAction(
        task.id,
        "held",
        "review",
        "Checks-only opt-in revoked; stronger review required.",
        "local",
      );
      return false;
    }
    const binding = await this.localBinding(task);
    if (!binding) return false;
    const repair = task.nextAction === "repair";
    const latest = this.latest(task.id);
    const prior = repair
      ? this.store
          .listAttempts(task.id)
          .filter((a) => a.outcome !== "transport_error")
          .at(-1)
      : latest;
    const w = this.workspace(task);
    let baseSha: string;
    try {
      baseSha =
        repair && prior ? prior.baseSha : await w.resolveBase(task.spec.base);
    } catch {
      this.store.setTaskAction(
        task.id,
        "held",
        null,
        "Base commit cannot be resolved.",
      );
      return false;
    }
    if (!repair && !(await this.dependenciesSatisfied(task, w, baseSha))) {
      this.store.setTaskAction(
        task.id,
        "queued",
        "worker",
        "Waiting for accepted dependencies to be merged into the base.",
      );
      return false;
    }
    if (repair && !this.canRepair(task)) {
      this.store.setTaskAction(
        task.id,
        "held",
        "frontier-worker",
        "Local repair budget exhausted.",
        "frontier",
      );
      return false;
    }
    const history = this.store.listAttempts(task.id);
    const coding = history.filter(
      (a) => a.kind !== "frontier" && a.outcome !== "transport_error",
    );
    if (coding.length >= task.spec.limits.max_attempts) {
      this.store.setTaskAction(
        task.id,
        "held",
        "frontier-worker",
        "Local attempt budget exhausted.",
        "frontier",
      );
      return false;
    }
    if (task.state !== "queued")
      this.store.setTaskAction(
        task.id,
        "queued",
        "repair",
        "One bounded repair scheduled.",
      );
    const a = this.store.createAttempt({
      taskId: task.id,
      endpoint: binding.endpoint.id,
      profileId: binding.profile.id,
      model: binding.profile.model,
      modelArtifact: binding.profile.model_artifact,
      harness: this.adapter.id,
      harnessVersion: binding.version,
      baseSha,
      branch: `spillway/${task.id}`,
      worktree: "",
      logPath: "",
      kind: repair ? "repair" : "worker",
      ...(repair && prior ? { parentAttemptId: prior.id } : {}),
    });
    const artifacts = this.artifacts(a.id);
    const logPath = join(artifacts, "worker.log");
    let executionUncertain = false;
    try {
      await mkdir(artifacts, { recursive: true, mode: 0o700 });
      this.store.updateAttempt(a.id, { logPath });
      let startSha = baseSha;
      if (repair) {
        if (!prior?.resultSha)
          throw new SpillwayError(
            "NO_REPAIR_RESULT",
            "No committed result exists for repair.",
          );
        const inspected = await w.inspect(
          prior.worktree,
          prior.baseSha,
          prior.branch,
        );
        if (
          !inspected.clean ||
          inspected.head !== prior.resultSha ||
          !(await w.isAncestor(prior.baseSha, inspected.head))
        )
          throw new SpillwayError("RESULT_CHANGED", "Repair source changed.");
        if (latest?.outcome !== "transport_error")
          await w.archiveWorker(prior.worktree, task.id, prior.id);
        startSha = prior.resultSha;
        this.store.addEvent(task.id, "repair-source-preserved", {
          attemptId: prior.id,
        });
      }
      const worktree = await w.createWorker(task.id, startSha, a.id);
      this.store.updateAttempt(a.id, { worktree });
      let prompt = await this.prompt(task, worktree);
      if (repair && prior)
        prompt += "\n" + (await this.repairContext(task, prior, w));
      if (Buffer.byteLength(prompt) > 128 * 1024)
        throw new SpillwayError(
          "PROMPT_TOO_LARGE",
          "Combined repair prompt exceeds its bound.",
        );
      executionUncertain = true;
      const result = await this.adapter.run({
        worktree,
        prompt,
        endpoint: binding.endpoint,
        profile: binding.profile,
        timeoutSec: task.spec.limits.max_minutes * 60,
        logPath,
        purpose: "worker",
        ...(this.signal ? { signal: this.signal } : {}),
      });
      executionUncertain = false;
      if (this.signal?.aborted)
        throw new SpillwayError("INTERRUPTED", "Dispatch interrupted.");
      this.store.updateAttempt(a.id, {
        usage: result.usage ?? null,
        summary: result.summary ?? null,
      });
      if (result.exit !== "completed") {
        const retry =
          result.exit === "transport_error" &&
          history.filter((row) => row.outcome === "transport_error").length ===
            0;
        if (retry) {
          await w.preserveTransportWorker(worktree, task.id, a.id);
          this.store.addEvent(task.id, "transport-checkout-preserved", {
            attemptId: a.id,
          });
        }
        this.store.finalizeAttempt(
          a.id,
          { outcome: result.exit, endedAt: new Date().toISOString() },
          retry ? "queued" : "held",
          retry
            ? "Transport failed; one retry permitted."
            : `Worker ${result.exit}; owner frontier session required.`,
          retry ? task.reviewTier : "frontier",
          retry ? (repair ? "repair" : "worker") : "frontier-worker",
        );
      } else {
        this.store.setTaskState(task.id, "verifying");
        await this.finishVerification(this.getDetail(task.id).task, a.id, w);
      }
    } catch {
      const current = this.store.getAttempt(a.id);
      if (current?.outcome === "running")
        this.store.finalizeAttempt(
          a.id,
          {
            outcome:
              this.signal?.aborted || executionUncertain
                ? "uncertain"
                : "failed",
            endedAt: new Date().toISOString(),
          },
          "held",
          "Dispatch interrupted or could not complete; inspect private artifacts.",
          undefined,
          null,
        );
    }
    return true;
  }
  private async prompt(task: TaskRecord, worktree: string): Promise<string> {
    const blocks = [
      task.raw,
      `Commit all changes on spillway/${task.id}. Work only within declared scope. Preserve protected fixtures. Do not push, merge or deploy. Your claims do not authorize acceptance.`,
    ];
    let size = Buffer.byteLength(task.raw);
    for (const name of task.spec.context) {
      const path = await realpath(join(worktree, name));
      if (!within(path, worktree))
        throw new SpillwayError(
          "CONTEXT_PATH",
          "Context escapes the checkout.",
        );
      const bytes = (await stat(path)).size;
      if (size + bytes > 128 * 1024)
        throw new SpillwayError(
          "CONTEXT_SIZE",
          "Context exceeds 128 KiB; bank a smaller task.",
        );
      const content = await readFile(path, "utf8");
      size += Buffer.byteLength(content);
      blocks.push(`Context ${name}:\n${content}`);
    }
    return blocks.join("\n\n");
  }
  private async repairContext(
    task: TaskRecord,
    prior: AttemptRecord,
    w: GitWorkspace,
  ): Promise<string> {
    const diff = prior.resultSha
      ? await w.diff(prior.baseSha, prior.resultSha)
      : "";
    const failures: string[] = [];
    for (const check of prior.verification?.checks ?? []) {
      if (check.exitCode !== 0 || check.timedOut)
        failures.push(
          (
            await readFile(check.logPath, "utf8").catch(
              () => "Missing check artifact",
            )
          ).slice(0, 32768),
        );
    }
    const findings = this.store
      .listReviews(task.id)
      .filter((row) => row.attemptId === prior.id)
      .flatMap((row) => row.report?.findings ?? []);
    const context = `Bounded repair: fix the observed failure without weakening tests or protected files. Original base is ${prior.baseSha}.\nDiff:\n${diff}\nFailing checks:\n${failures.join("\n")}\nReview findings:\n${JSON.stringify(findings)}`;
    if (Buffer.byteLength(context) > 128 * 1024)
      throw new SpillwayError(
        "REPAIR_SIZE",
        "Repair context exceeds the bounded handoff limit.",
      );
    return context;
  }
  private async finishVerification(
    task: TaskRecord,
    attemptId: number,
    w: GitWorkspace,
  ): Promise<void> {
    const a = this.store.getAttempt(attemptId);
    if (!a) throw new SpillwayError("NO_ATTEMPT", "Attempt missing.");
    const artifacts = this.artifacts(attemptId);
    const verification = await verifyAttempt({
      spec: task.spec,
      attempt: a,
      workspace: w,
      artifactDir: artifacts,
      ...(this.signal ? { signal: this.signal } : {}),
    });
    if (this.signal?.aborted)
      throw new SpillwayError("INTERRUPTED", "Verification interrupted.");
    const tier = verification.flags.length ? "frontier" : this.tierFor(task);
    const reportPath = join(artifacts, "report.json");
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          taskId: task.id,
          attemptId,
          baseSha: a.baseSha,
          resultSha: verification.resultSha ?? null,
          reviewTier: tier,
          verification,
          usage: a.usage,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    let state: "ready" | "held" | "needs-repair" = "held";
    let nextAction: NextAction | null = null;
    let reason: string | undefined;
    let finalTier = tier;
    if (verification.passed) {
      if (tier === "checks-only") state = "ready";
      else {
        nextAction = "review";
        reason = `${tier} review required.`;
      }
    } else if (
      a.kind !== "frontier" &&
      verification.resultSha &&
      verification.checks.some((c) => c.exitCode !== 0 || c.timedOut) &&
      this.canRepair(task)
    ) {
      state = "needs-repair";
      nextAction = "repair";
      reason = "A check failed; one bounded local repair is scheduled.";
    } else {
      reason = verification.reason ?? "Verification failed.";
      if (a.kind !== "frontier") {
        nextAction = "frontier-worker";
        finalTier = "frontier";
        reason += " Owner frontier session required.";
      }
    }
    this.store.finalizeAttempt(
      a.id,
      {
        outcome: verification.passed ? "completed" : "failed",
        endedAt: new Date().toISOString(),
        resultSha: verification.resultSha ?? null,
        verification,
        reportPath,
      },
      state,
      reason,
      finalTier,
      nextAction,
    );
  }
  private async performLocalReview(task: TaskRecord): Promise<boolean> {
    const a = this.latest(task.id);
    try {
      await this.requirePinned(task, a);
    } catch {
      this.store.setTaskAction(
        task.id,
        "held",
        null,
        "Verified result changed; owner inspection required.",
      );
      return false;
    }
    const binding = await this.localBinding(task, true);
    if (!binding) return false;
    const artifacts = join(this.artifacts(a!.id), `review-${randomUUID()}`);
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const review = this.store.createReview({
      taskId: task.id,
      attemptId: a!.id,
      tier: "local",
      source: "service-local",
      profileId: binding.profile.id,
      model: binding.profile.model,
      resultSha: a!.resultSha!,
      logPath: join(artifacts, "reviewer.log"),
    });
    try {
      const result = await runLocalReview({
        reviewId: review.id,
        task,
        attempt: a!,
        workspace: this.workspace(task),
        adapter: this.adapter,
        endpoint: binding.endpoint,
        profile: binding.profile,
        artifactDir: artifacts,
        timeoutSec: getPolicy(this.config.policy).review_timeout_minutes * 60,
        ...(this.signal ? { signal: this.signal } : {}),
      });
      if (result.outcome !== "completed" || !result.report) {
        this.store.finishReview(
          review.id,
          {
            outcome: this.signal?.aborted
              ? "uncertain"
              : result.outcome === "uncertain"
                ? "uncertain"
                : "failed",
            usage: result.usage ?? null,
            reason: result.reason ?? "Review did not provide a valid decision.",
          },
          "held",
          null,
          result.reason ?? "Review failed; owner inspection required.",
        );
        return true;
      }
      await this.requirePinned(task, a);
      const currentTier = this.tierFor(this.getDetail(task.id).task);
      if (currentTier !== task.reviewTier)
        this.store.setTaskReview(task.id, currentTier);
      const report = result.report;
      let state: "ready" | "held" | "needs-repair" | "failed";
      let action: NextAction | null = null;
      let reason: string | undefined;
      if (report.verdict === "accept") {
        state = currentTier === "frontier" ? "held" : "ready";
        if (state === "held") {
          action = "review";
          reason = "Frontier review now required by stronger policy.";
        }
      } else if (report.verdict === "reject") {
        state = "failed";
        reason = "Local reviewer rejected the result.";
      } else if (this.canRepair(task)) {
        state = "needs-repair";
        action = "repair";
        reason = "Local review requested the one bounded repair.";
      } else {
        state = "held";
        action = "frontier-worker";
        reason = "Repair budget exhausted; owner frontier session required.";
        this.store.setTaskReview(task.id, "frontier");
      }
      this.store.finishReview(
        review.id,
        { outcome: "completed", report, usage: result.usage ?? null },
        state,
        action,
        reason,
      );
      return true;
    } catch {
      if (this.store.getReview(review.id)?.outcome === "running")
        this.store.finishReview(
          review.id,
          {
            outcome: "uncertain",
            reason:
              "Review interrupted or result changed; inspect before reconciliation.",
          },
          "held",
          null,
          "Review execution is uncertain; owner inspection required.",
        );
      return true;
    }
  }
  async getReviewPacket(id: string) {
    const task = this.getDetail(id).task;
    this.requireFrontier(task);
    if (
      task.reviewTier !== "frontier" ||
      task.nextAction !== "review" ||
      task.state !== "held"
    )
      throw new SpillwayError(
        "NOT_REVIEWABLE",
        "Task is not awaiting frontier review.",
        409,
      );
    const a = this.latest(id);
    await this.requirePinned(task, a);
    const diff = await this.workspace(task).diff(a!.baseSha, a!.resultSha!);
    if (Buffer.byteLength(diff) > 128 * 1024)
      throw new SpillwayError(
        "REVIEW_SIZE",
        "Diff exceeds the bounded session handoff limit.",
        409,
      );
    await this.requirePinned(task, a);
    this.requireFrontier(this.getDetail(id).task);
    return {
      taskId: id,
      attemptId: a!.id,
      resultSha: a!.resultSha,
      rubric: REVIEW_RUBRIC,
      task,
      worktree: a!.worktree,
      verification: a!.verification,
      diff,
    };
  }
  async submitFrontierReview(
    id: string,
    input: unknown,
    meta: { model?: string; usage?: Usage } = {},
  ) {
    return this.withSlot(async () => {
      const packet = await this.getReviewPacket(id);
      if (input === undefined)
        throw new SpillwayError(
          "INVALID_REVIEW",
          "A review report is required.",
          400,
        );
      const report = parseReviewReport(JSON.stringify(input));
      this.requireFrontier(this.getDetail(id).task);
      if (report.resultSha !== packet.resultSha)
        throw new SpillwayError(
          "STALE_REVIEW",
          "Review does not match the verified commit.",
          409,
        );
      const row = this.store.createReview({
        taskId: id,
        attemptId: packet.attemptId,
        tier: "frontier",
        source: "owner-session",
        resultSha: report.resultSha,
        ...(meta.model ? { model: meta.model } : {}),
      });
      let state: "ready" | "held" | "needs-repair" | "failed";
      let action: NextAction | null = null;
      let reason: string | undefined;
      if (report.verdict === "accept") state = "ready";
      else if (report.verdict === "reject") {
        state = "failed";
        reason = "Owner-session reviewer rejected the result.";
      } else if (
        this.latest(id)?.kind !== "frontier" &&
        this.canRepair(packet.task)
      ) {
        state = "needs-repair";
        action = "repair";
        reason = "Owner-session review requested the remaining bounded repair.";
      } else {
        state = "held";
        reason =
          "Owner-session review requested changes; automatic repair budget is exhausted.";
      }
      this.store.finishReview(
        row.id,
        { outcome: "completed", report, usage: meta.usage ?? null },
        state,
        action,
        reason,
      );
      return this.getDetail(id);
    });
  }
  async claimFrontier(id: string) {
    return this.withSlot(async () => {
      if (this.hasUncertainty() || this.activeExecution())
        throw new SpillwayError(
          "BUSY",
          "Interrupted or active execution prevents another claim.",
          409,
        );
      const task = this.getDetail(id).task;
      this.requireFrontier(task);
      if (
        task.nextAction !== "frontier-worker" ||
        !["held", "escalated"].includes(task.state)
      )
        throw new SpillwayError(
          "NOT_CLAIMABLE",
          "Task is not awaiting a frontier worker.",
          409,
        );
      if (this.store.listAttempts(id).some((a) => a.kind === "frontier"))
        throw new SpillwayError(
          "FRONTIER_BUDGET",
          "One frontier session attempt is already recorded.",
          409,
        );
      const prior = this.latest(id);
      const w = this.workspace(task);
      const baseSha = prior?.baseSha ?? (await w.resolveBase(task.spec.base));
      if (!(await this.dependenciesSatisfied(task, w, baseSha))) {
        this.store.setTaskAction(
          id,
          "held",
          "frontier-worker",
          "Waiting for accepted dependencies to be merged into the base.",
        );
        throw new SpillwayError(
          "DEPENDENCIES",
          "Accepted dependency results must be merged into the pinned base before frontier work.",
          409,
        );
      }
      this.requireFrontier(this.getDetail(id).task);
      this.store.setTaskReview(id, "frontier");
      const a = this.store.createAttempt({
        taskId: id,
        endpoint: "owner-session",
        profileId: "owner-session",
        model: "not-reported",
        modelArtifact: "not-reported",
        harness: "claude-code-session",
        harnessVersion: "owner-attested",
        baseSha,
        branch: `spillway/${id}`,
        worktree: "",
        logPath: "",
        kind: "frontier",
        ...(prior ? { parentAttemptId: prior.id } : {}),
      });
      try {
        const artifacts = this.artifacts(a.id);
        await mkdir(artifacts, { recursive: true, mode: 0o700 });
        let start = baseSha;
        if (prior?.worktree) {
          const inspected = await w.inspect(
            prior.worktree,
            prior.baseSha,
            prior.branch,
          );
          if (inspected.branch === prior.branch) {
            if (
              inspected.clean &&
              prior.resultSha === inspected.head &&
              inspected.descendant
            )
              start = inspected.head;
            await w.archiveWorker(prior.worktree, id, prior.id);
          }
        }
        const worktree = await w.createWorker(id, start, a.id);
        this.store.updateAttempt(a.id, { worktree });
        let prompt = await this.prompt(task, worktree);
        if (prior) prompt += "\n" + (await this.repairContext(task, prior, w));
        if (Buffer.byteLength(prompt) > 128 * 1024)
          throw new SpillwayError(
            "PROMPT_TOO_LARGE",
            "Session handoff exceeds its bound.",
          );
        await writeFile(join(artifacts, "frontier-handoff.md"), prompt, {
          mode: 0o600,
        });
        this.requireFrontier(this.getDetail(id).task);
        return {
          taskId: id,
          attemptId: a.id,
          baseSha,
          branch: a.branch,
          worktree,
          prompt,
        };
      } catch {
        this.store.finalizeAttempt(
          a.id,
          { outcome: "failed" },
          "held",
          "Frontier handoff could not be prepared; inspect evidence.",
          undefined,
          null,
        );
        throw new SpillwayError(
          "HANDOFF_FAILED",
          "Frontier handoff could not be prepared.",
          409,
        );
      }
    });
  }
  async completeFrontier(id: string, attemptId: number) {
    return this.withSlot(async () => {
      const task = this.getDetail(id).task;
      // Completion performs local verification only; availability gates new frontier work.
      const a = this.latest(id);
      if (
        !a ||
        a.id !== attemptId ||
        a.kind !== "frontier" ||
        a.outcome !== "running" ||
        task.state !== "dispatched"
      )
        throw new SpillwayError(
          "STALE_ATTEMPT",
          "No matching active frontier session attempt.",
          409,
        );
      this.store.setTaskState(id, "verifying");
      try {
        await this.finishVerification(task, a.id, this.workspace(task));
      } catch {
        if (this.store.getAttempt(a.id)?.outcome === "running")
          this.store.finalizeAttempt(
            a.id,
            { outcome: "uncertain" },
            "held",
            "Frontier verification interrupted; inspect before reconciliation.",
            undefined,
            null,
          );
        throw new SpillwayError(
          "VERIFICATION_FAILED",
          "Frontier verification could not finish.",
          409,
        );
      }
      return this.getDetail(id);
    });
  }
}
