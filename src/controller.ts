import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import {
  SpillwayError,
  type HarnessAdapter,
  type ReviewTier,
  type SpillwayConfig,
  type TaskDetail,
  type TaskRecord,
} from "./contracts.js";
import { parseTask } from "./task.js";
import { Store } from "./store.js";
import { GitWorkspace } from "./git.js";
import { OpenCodeAdapter, probeEndpoint } from "./harness.js";
import { verifyAttempt } from "./verify.js";

const sensitive =
  /(^|\/)(\.github|\.gitlab|migrations?|auth|authentication|authorization|permissions?|secrets?)(\/|$)|(^|\/)(package\.json|[^/]*lock[^/]*|Cargo\.toml|go\.mod|pyproject\.toml|requirements[^/]*\.txt|Dockerfile)$/i;
function policyRank(value: string): number {
  return ["local-only", "open-weight-hosted-ok", "frontier-ok"].indexOf(value);
}
function endpointRank(value: string): number {
  return ["local", "open-weight-hosted", "frontier"].indexOf(value);
}

export class Controller {
  private busy = false;
  private idle: Promise<void> = Promise.resolve();
  private idleResolve?: () => void;
  constructor(
    readonly config: SpillwayConfig,
    readonly store: Store,
    private adapter: HarnessAdapter = new OpenCodeAdapter(),
    private signal?: AbortSignal,
  ) {}

  async addTask(raw: string): Promise<TaskRecord> {
    const spec = parseTask(raw);
    spec.repo = await realpath(
      spec.repo.replace(/^~(?=\/)/, process.env.HOME ?? ""),
    );
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
    const profile = this.config.profiles.find(
      (entry) => entry.id === this.config.default_profile,
    );
    if (!profile)
      throw new SpillwayError(
        "PROFILE_MISSING",
        "The default profile is not configured.",
      );
    const endpoint = this.config.endpoints.find(
      (entry) => entry.id === profile.endpoint,
    );
    if (!endpoint || endpointRank(endpoint.kind) > policyRank(repo.data_policy))
      throw new SpillwayError(
        "DATA_POLICY",
        "Repository data policy does not permit the selected endpoint.",
      );
    if (!profile.qualified_classes.includes(spec.class))
      throw new SpillwayError(
        "UNQUALIFIED_CLASS",
        "The selected profile does not qualify for this task class.",
      );
    let tier: ReviewTier =
      spec.review === "default"
        ? spec.class === "risky"
          ? "frontier"
          : "local"
        : spec.review;
    if (
      !spec.checks.length ||
      spec.class === "risky" ||
      spec.scope.some((path) => sensitive.test(path))
    )
      tier = "frontier";
    if (tier === "checks-only" && !this.config.allow_checks_only)
      throw new SpillwayError(
        "REVIEW_POLICY",
        "Checks-only requires explicit experimental opt-in in private config.",
      );
    return this.store.addTask(spec, raw, profile.id, tier);
  }

  getDetail(id: string): TaskDetail {
    const task = this.store.getTask(id);
    if (!task) throw new SpillwayError("NOT_FOUND", "Task not found.", 404);
    return {
      task,
      attempts: this.store.listAttempts(id),
      events: this.store.listEvents(id),
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
    const attempt = this.store.listAttempts(id).at(-1);
    if (!attempt?.resultSha || !attempt.verification?.passed)
      throw new SpillwayError("NO_RESULT", "No verified result exists.", 409);
    const workspace = new GitWorkspace(task.spec.repo, this.config.data_dir);
    const current = await workspace.resolveBase(attempt.branch);
    if (current !== attempt.resultSha)
      throw new SpillwayError(
        "RESULT_CHANGED",
        "The result branch changed after verification.",
        409,
      );
    this.store.setTaskState(id, decision);
    this.store.addEvent(id, "owner-decision", {
      decision,
      resultSha: attempt.resultSha,
    });
    return this.getDetail(id).task;
  }

  async inspect(id: string) {
    const { task, attempts } = this.getDetail(id);
    const attempt = attempts.at(-1);
    if (!attempt?.worktree) return null;
    return new GitWorkspace(task.spec.repo, this.config.data_dir).inspect(
      attempt.worktree,
      attempt.baseSha,
      attempt.branch,
    );
  }

  reconcile(id: string): TaskRecord {
    const { task, attempts } = this.getDetail(id);
    if (task.state !== "held" || attempts.at(-1)?.outcome !== "uncertain")
      throw new SpillwayError(
        "NOT_UNCERTAIN",
        "Only held interrupted execution can be reconciled.",
        409,
      );
    // The authenticated owner explicitly attests that surviving workers were
    // stopped. Preserve all evidence; do not reuse the uncertain result.
    this.store.setTaskState(
      id,
      "abandoned",
      "Owner confirmed surviving worker processes stopped.",
    );
    this.store.addEvent(id, "execution-reconciled", { workerStopped: true });
    return this.getDetail(id).task;
  }

  async recover(): Promise<void> {
    for (const attempt of this.store.recoverInflight()) {
      const task = this.getDetail(attempt.taskId).task;
      try {
        const workspace = new GitWorkspace(
          task.spec.repo,
          this.config.data_dir,
        );
        const inspected = await workspace.inspect(
          attempt.worktree,
          attempt.baseSha,
          attempt.branch,
        );
        this.store.addEvent(task.id, "recovery-inspection", inspected);
        // SIGKILL can leave detached harness descendants alive. A clean commit
        // alone cannot prove that execution has stopped, so recovery holds.
        this.store.setTaskState(
          task.id,
          "held",
          "Interrupted attempt: inspect worktree and stop surviving harness processes before proceeding.",
        );
      } catch {
        this.store.setTaskState(
          task.id,
          "held",
          "Interrupted work requires owner inspection.",
        );
      }
    }
  }

  async runOnce(): Promise<string | null> {
    if (this.busy)
      throw new SpillwayError("BUSY", "A dispatch is already running.", 409);
    this.busy = true;
    this.idle = new Promise((resolve) => {
      this.idleResolve = resolve;
    });
    try {
      if (this.signal?.aborted) return null;
      const uncertain = this.store
        .listTasks()
        .find(
          (task) =>
            task.state === "held" &&
            this.store.listAttempts(task.id).at(-1)?.outcome === "uncertain",
        );
      if (uncertain) {
        for (const task of this.store
          .listTasks()
          .filter((entry) => entry.state === "queued"))
          this.store.setTaskState(
            task.id,
            "queued",
            `Queue paused for interrupted execution ${uncertain.id}; inspect and reconcile after stopping surviving workers.`,
          );
        return null;
      }
      for (const task of this.store
        .listTasks()
        .filter((entry) => entry.state === "queued")) {
        const profile = this.config.profiles.find(
          (entry) => entry.id === task.profileId,
        );
        const endpoint = this.config.endpoints.find(
          (entry) => entry.id === profile?.endpoint,
        );
        const repo = this.config.repositories.find(
          (entry) => entry.path === task.spec.repo,
        );
        if (
          !profile ||
          !endpoint ||
          !repo ||
          endpointRank(endpoint.kind) > policyRank(repo.data_policy) ||
          !profile.qualified_classes.includes(task.spec.class)
        ) {
          this.store.setTaskState(
            task.id,
            "held",
            "Configuration or repository data policy changed.",
          );
          continue;
        }
        if (
          task.reviewTier === "checks-only" &&
          !this.config.allow_checks_only
        ) {
          this.store.setTaskState(
            task.id,
            "held",
            "Checks-only opt-in was revoked; review policy requires owner inspection.",
          );
          continue;
        }
        const workspace = new GitWorkspace(
          task.spec.repo,
          this.config.data_dir,
        );
        let baseSha: string;
        try {
          baseSha = await workspace.resolveBase(task.spec.base);
        } catch {
          this.store.setTaskState(
            task.id,
            "held",
            "Base commit cannot be resolved.",
          );
          continue;
        }
        let dependenciesReady = true;
        for (const dependencyId of task.spec.after) {
          const dependency = this.store.getTask(dependencyId);
          const result = this.store
            .listAttempts(dependencyId)
            .at(-1)?.resultSha;
          if (
            dependency?.state !== "accepted" ||
            dependency.spec.repo !== task.spec.repo ||
            !result ||
            !(await workspace.isAncestor(result, baseSha))
          )
            dependenciesReady = false;
        }
        if (!dependenciesReady) {
          this.store.setTaskState(
            task.id,
            "queued",
            "Waiting for accepted dependencies to be merged into the base.",
          );
          continue;
        }
        const health = await probeEndpoint(endpoint, profile.model);
        if (!health.healthy) {
          this.store.setTaskState(
            task.id,
            "queued",
            health.reason ?? "Endpoint unavailable.",
          );
          continue;
        }
        let version: string;
        try {
          version = await this.adapter.version();
        } catch {
          this.store.setTaskState(
            task.id,
            "held",
            "Configured harness is unavailable.",
          );
          continue;
        }
        if (
          version !== profile.harness_version ||
          this.adapter.id !== profile.harness
        ) {
          this.store.setTaskState(
            task.id,
            "held",
            "Harness version does not match the pinned profile.",
          );
          continue;
        }
        const previous = this.store.listAttempts(task.id);
        if (
          previous.filter((entry) => entry.outcome !== "transport_error")
            .length >= task.spec.limits.max_attempts
        ) {
          this.store.setTaskState(task.id, "held", "Attempt budget exhausted.");
          continue;
        }
        const branch = `spillway/${task.id}`;
        const attempt = this.store.createAttempt({
          taskId: task.id,
          endpoint: endpoint.id,
          profileId: profile.id,
          model: profile.model,
          modelArtifact: profile.model_artifact,
          harness: this.adapter.id,
          harnessVersion: version,
          baseSha,
          branch,
          worktree: "",
          logPath: "",
        });
        const artifacts = join(
          this.config.data_dir,
          "artifacts",
          String(attempt.id),
        );
        await mkdir(artifacts, { recursive: true, mode: 0o700 });
        const logPath = join(artifacts, "worker.log");
        this.store.updateAttempt(attempt.id, { logPath });
        try {
          const worktree = await workspace.createWorker(
            task.id,
            baseSha,
            attempt.id,
          );
          this.store.updateAttempt(attempt.id, { worktree });
          const prompt = await this.prompt(task, worktree);
          const result = await this.adapter.run({
            worktree,
            prompt,
            endpoint,
            profile,
            timeoutSec: task.spec.limits.max_minutes * 60,
            logPath,
            ...(this.signal ? { signal: this.signal } : {}),
          });
          if (this.signal?.aborted)
            throw new SpillwayError("INTERRUPTED", "Dispatch interrupted.");
          this.store.updateAttempt(attempt.id, {
            usage: result.usage ?? null,
            summary: result.summary ?? null,
          });
          if (result.exit !== "completed") {
            if (
              result.exit === "transport_error" &&
              previous.filter((entry) => entry.outcome === "transport_error")
                .length === 0
            ) {
              // Preserve failed checkout for inspection; one transport retry gets a fresh worker.
              await workspace.preserveTransportWorker(
                worktree,
                task.id,
                attempt.id,
              );
              this.store.addEvent(task.id, "transport-checkout-preserved", {
                attemptId: attempt.id,
                branch: `spillway/${task.id}-transport-${attempt.id}`,
              });
              this.store.finalizeAttempt(
                attempt.id,
                { outcome: result.exit, endedAt: new Date().toISOString() },
                "queued",
                "Transport failed; one retry permitted.",
              );
            } else
              this.store.finalizeAttempt(
                attempt.id,
                { outcome: result.exit, endedAt: new Date().toISOString() },
                result.exit === "transport_error" ? "held" : "failed",
                `Worker ${result.exit}; inspect private artifacts.`,
              );
          } else {
            this.store.setTaskState(task.id, "verifying");
            await this.finishVerification(task, attempt.id, workspace);
          }
        } catch {
          const current = this.store.getAttempt(attempt.id);
          const state = this.store.getTask(task.id)?.state;
          if (
            (current?.outcome === "running" ||
              current?.outcome === "uncertain") &&
            (state === "dispatched" ||
              state === "verifying" ||
              state === "reviewing" ||
              state === "queued" ||
              state === "held")
          )
            this.store.finalizeAttempt(
              attempt.id,
              {
                outcome: this.signal?.aborted ? "uncertain" : "failed",
                endedAt: new Date().toISOString(),
              },
              "held",
              "Dispatch interrupted or could not complete; inspect private artifacts.",
            );
        }
        return task.id;
      }
      return null;
    } finally {
      this.busy = false;
      this.idleResolve?.();
    }
  }

  waitForIdle(): Promise<void> {
    return this.idle;
  }

  private async prompt(task: TaskRecord, worktree: string): Promise<string> {
    const blocks = [
      task.raw,
      `\nWork only within the declared scope. Preserve protected fixtures. Commit all changes on spillway/${task.id}. Do not push or merge. Your claims do not authorize acceptance.`,
    ];
    let size = 0;
    for (const context of task.spec.context) {
      const path = await realpath(join(worktree, context));
      const rel = relative(worktree, path);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw new SpillwayError(
          "CONTEXT_PATH",
          "Context file escapes the worktree.",
        );
      const content = await readFile(path, "utf8");
      size += Buffer.byteLength(content);
      if (size > 128 * 1024)
        throw new SpillwayError(
          "CONTEXT_SIZE",
          "Context exceeds 128 KiB; bank a smaller task.",
        );
      blocks.push(`\nContext: ${context}\n${content}`);
    }
    return blocks.join("\n");
  }

  private async finishVerification(
    task: TaskRecord,
    attemptId: number,
    workspace: GitWorkspace,
  ): Promise<void> {
    const attempt = this.store.getAttempt(attemptId);
    if (!attempt) throw new SpillwayError("NO_ATTEMPT", "Attempt missing.");
    const artifacts = join(
      this.config.data_dir,
      "artifacts",
      String(attemptId),
    );
    const verification = await verifyAttempt({
      spec: task.spec,
      attempt,
      workspace,
      artifactDir: artifacts,
      ...(this.signal ? { signal: this.signal } : {}),
    });
    if (this.signal?.aborted)
      throw new SpillwayError("INTERRUPTED", "Verification interrupted.");
    const tier = verification.flags.length
      ? "frontier"
      : task.reviewTier === "checks-only" && !this.config.allow_checks_only
        ? "local"
        : task.reviewTier;
    const reportPath = join(artifacts, "report.json");
    const report = {
      taskId: task.id,
      attemptId,
      baseSha: attempt.baseSha,
      resultSha: verification.resultSha ?? null,
      reviewTier: tier,
      verification,
      usage: attempt.usage,
      generatedAt: new Date().toISOString(),
    };
    await writeFile(reportPath, JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
    const state = !verification.passed
      ? "failed"
      : tier === "checks-only"
        ? "ready"
        : "held";
    const reason = !verification.passed
      ? (verification.reason ?? "Verification failed.")
      : tier === "checks-only"
        ? undefined
        : `${tier} review required; review execution arrives in Phase 2.`;
    this.store.finalizeAttempt(
      attemptId,
      {
        outcome: verification.passed ? "completed" : "failed",
        endedAt: new Date().toISOString(),
        resultSha: verification.resultSha ?? null,
        verification,
        reportPath,
      },
      state,
      reason,
      tier,
    );
    this.store.addEvent(task.id, "verification", {
      passed: verification.passed,
      flags: verification.flags,
      reviewTier: tier,
    });
  }
}
