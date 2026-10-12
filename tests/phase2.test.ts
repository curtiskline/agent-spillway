import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Controller } from "../src/controller.js";
import { Store } from "../src/store.js";
import { gitCommand } from "../src/git.js";
import { defaultPolicy } from "../src/policy.js";
import type {
  HarnessAdapter,
  HarnessInput,
  HarnessResult,
  ReviewReport,
} from "../src/contracts.js";
import { fixture } from "./helpers.js";

async function phase2Fixture() {
  const f = await fixture();
  const store = new Store(f.data);
  const workers: { worktree: string; startSha: string; prompt: string }[] = [];
  const reviewers: HarnessInput[] = [];
  let worker:
    ((input: HarnessInput, call: number) => Promise<HarnessResult>) | undefined;
  let reviewer:
    ((input: HarnessInput, call: number) => Promise<HarnessResult>) | undefined;
  const accept = async (
    input: HarnessInput,
    verdict: ReviewReport["verdict"] = "accept",
  ): Promise<HarnessResult> => {
    const resultSha = (
      await gitCommand(input.worktree, ["rev-parse", "HEAD"])
    ).trim();
    return {
      exit: "completed",
      summary: JSON.stringify({
        resultSha,
        verdict,
        findings:
          verdict === "needs-repair"
            ? [
                {
                  severity: "blocking",
                  message:
                    "Add the required repair marker without weakening checks.",
                  path: "src/message.cjs",
                },
              ]
            : [],
      }),
      usage: { inputTokens: 12, outputTokens: 7 },
    };
  };
  const adapter: HarnessAdapter = {
    id: "opencode",
    version: () => f.adapter.version(),
    async run(input) {
      if (input.purpose === "review") {
        reviewers.push(input);
        expect(
          (
            await gitCommand(input.worktree, [
              "rev-parse",
              "--abbrev-ref",
              "HEAD",
            ])
          ).trim(),
        ).toBe("HEAD");
        await writeFile(
          input.logPath,
          "Fixture-only structured review; no capability evidence.\n",
          { mode: 0o600 },
        );
        return reviewer ? reviewer(input, reviewers.length) : accept(input);
      }
      workers.push({
        worktree: input.worktree,
        startSha: (
          await gitCommand(input.worktree, ["rev-parse", "HEAD"])
        ).trim(),
        prompt: input.prompt,
      });
      return worker ? worker(input, workers.length) : f.adapter.run(input);
    },
  };
  const controller = new Controller(f.config, store, adapter);
  return {
    ...f,
    store,
    controller,
    workers,
    reviewers,
    accept,
    setWorker(next: NonNullable<typeof worker>) {
      worker = next;
    },
    setReviewer(next: NonNullable<typeof reviewer>) {
      reviewer = next;
    },
    async cleanup() {
      store.close();
      await f.cleanup();
    },
  };
}

async function commit(
  input: HarnessInput,
  content: string,
): Promise<HarnessResult> {
  await writeFile(join(input.worktree, "src/message.cjs"), content);
  await gitCommand(input.worktree, ["add", "src/message.cjs"]);
  await gitCommand(input.worktree, ["commit", "-m", "Fixture continuation"]);
  await writeFile(input.logPath, "Fixture committed continuation.\n", {
    mode: 0o600,
  });
  return { exit: "completed" };
}

describe("Phase 2 controller integration (fixture inference only)", () => {
  let f: Awaited<ReturnType<typeof phase2Fixture>>;
  beforeEach(async () => {
    f = await phase2Fixture();
  });
  afterEach(async () => {
    await f.cleanup();
  });
  it("moves default local work through independent verification and exact-SHA review to readiness", async () => {
    const c = f.controller;
    await c.addTask(f.markdown("local", "default"));
    expect(await c.runOnce()).toBe("local");
    const verified = c.getDetail("local");
    expect(verified.task.state).toBe("held");
    expect(verified.task.nextAction).toBe("review");
    expect(verified.attempts[0]?.verification?.passed).toBe(true);
    await expect(c.decide("local", "accepted")).rejects.toThrow("ready");
    expect(await c.runOnce()).toBe("local");
    const ready = c.getDetail("local");
    expect(ready.task.state).toBe("ready");
    expect(ready.task.nextAction).toBeNull();
    expect(ready.reviews).toHaveLength(1);
    expect(ready.reviews?.[0]).toMatchObject({
      tier: "local",
      source: "service-local",
      outcome: "completed",
      resultSha: ready.attempts[0]?.resultSha,
      report: { verdict: "accept" },
    });
    expect(f.workers).toHaveLength(1);
    expect(f.reviewers).toHaveLength(1);
    expect(
      await gitCommand(f.reviewers[0]!.worktree, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]).catch(() => "removed"),
    ).toBe("removed");
    await c.decide("local", "accepted");
    expect(c.getDetail("local").task.state).toBe("accepted");
    expect(await readFile(join(f.repo, "src/message.cjs"), "utf8")).toContain(
      "wrong",
    );
  });
  it("repairs from a reviewed commit while preserving cumulative original-base scope and lineage", async () => {
    f.setWorker(async (input, call) =>
      commit(
        input,
        call === 1
          ? "module.exports=()=> 'hello';\n"
          : "module.exports=()=> 'hello';\n// required repair marker\n",
      ),
    );
    f.setReviewer((input, call) =>
      f.accept(input, call === 1 ? "needs-repair" : "accept"),
    );
    const c = f.controller;
    await c.addTask(f.markdown("repair", "default"));
    await c.runOnce();
    await c.runOnce();
    expect(c.getDetail("repair").task).toMatchObject({
      state: "needs-repair",
      nextAction: "repair",
    });
    const first = c.getDetail("repair").attempts[0]!;
    expect(await c.runOnce()).toBe("repair");
    const second = c.getDetail("repair").attempts[1]!;
    expect(second).toMatchObject({
      kind: "repair",
      parentAttemptId: first.id,
      baseSha: first.baseSha,
    });
    expect(second.verification?.passed).toBe(true);
    expect(second.verification?.changedPaths).toEqual(["src/message.cjs"]);
    expect(f.workers[1]?.startSha).toBe(first.resultSha);
    expect(f.workers[1]?.prompt).toContain(first.baseSha);
    expect(f.workers[1]?.prompt).toContain("required repair marker");
    expect(
      (
        await gitCommand(first.worktree, ["rev-parse", "--abbrev-ref", "HEAD"])
      ).trim(),
    ).toBe(`spillway/repair-attempt-${first.id}`);
    const diff = await readFile(second.verification!.diffPath!, "utf8");
    expect(diff).toContain("-module.exports = () => 'wrong'");
    expect(diff).toContain("required repair marker");
    await c.runOnce();
    expect(c.getDetail("repair").task.state).toBe("ready");
    expect(c.getDetail("repair").reviews).toHaveLength(2);
  });
  it("uses one committed check-failure repair with failing output instead of trusting the worker claim", async () => {
    f.setWorker((input, call) =>
      commit(
        input,
        call === 1
          ? "module.exports=()=> 'still wrong';\n"
          : "module.exports=()=> 'hello';\n",
      ),
    );
    const c = f.controller;
    await c.addTask(f.markdown("checks", "default"));
    await c.runOnce();
    const first = c.getDetail("checks").attempts[0]!;
    expect(first.outcome).toBe("failed");
    expect(first.verification?.passed).toBe(false);
    expect(first.verification?.checks[0]?.exitCode).not.toBe(0);
    expect(c.getDetail("checks").task.nextAction).toBe("repair");
    expect(f.reviewers).toHaveLength(0);
    await c.runOnce();
    expect(f.workers[1]?.prompt).toContain("ERR_ASSERTION");
    expect(f.workers[1]?.startSha).toBe(first.resultSha);
    expect(c.getDetail("checks").attempts[1]?.baseSha).toBe(first.baseSha);
    await c.runOnce();
    expect(c.getDetail("checks").task.state).toBe("ready");
    expect(f.workers).toHaveLength(2);
    expect(f.reviewers).toHaveLength(1);
  });
  it("keeps a free transport retry inside the same bounded repair lineage and preserves all evidence", async () => {
    f.setWorker(async (input, call) => {
      if (call === 2) {
        await writeFile(
          join(input.worktree, "transport.txt"),
          "partial repair transport evidence",
        );
        return { exit: "transport_error" };
      }
      return commit(
        input,
        call === 1
          ? "module.exports=()=> 'hello';\n"
          : "module.exports=()=> 'hello';\n// required repair marker\n",
      );
    });
    f.setReviewer((input, call) =>
      f.accept(input, call === 1 ? "needs-repair" : "accept"),
    );
    const c = f.controller;
    await c.addTask(f.markdown("retry", "default"));
    await c.runOnce();
    await c.runOnce();
    await c.runOnce();
    const history = c.getDetail("retry").attempts;
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      kind: "repair",
      outcome: "transport_error",
      parentAttemptId: history[0]!.id,
    });
    expect(c.getDetail("retry").task).toMatchObject({
      state: "queued",
      nextAction: "repair",
    });
    expect(
      await readFile(join(history[1]!.worktree, "transport.txt"), "utf8"),
    ).toContain("partial repair");
    await c.runOnce();
    const repaired = c.getDetail("retry").attempts[2]!;
    expect(repaired).toMatchObject({
      kind: "repair",
      parentAttemptId: history[0]!.id,
      baseSha: history[0]!.baseSha,
      outcome: "completed",
    });
    expect(f.workers[2]?.startSha).toBe(history[0]!.resultSha);
    expect(
      (
        await gitCommand(history[1]!.worktree, [
          "rev-parse",
          "--abbrev-ref",
          "HEAD",
        ])
      ).trim(),
    ).toBe(`spillway/retry-transport-${history[1]!.id}`);
    await c.runOnce();
    expect(c.getDetail("retry").task.state).toBe("ready");
    expect(c.getDetail("retry").attempts).toHaveLength(3);
  });
  it("exhausts one repair even when the task permits many attempts", async () => {
    f.setWorker((input, call) =>
      commit(input, `module.exports=()=> 'hello';\n// version ${call}\n`),
    );
    f.setReviewer((input) => f.accept(input, "needs-repair"));
    const c = f.controller;
    await c.addTask(
      f.markdown("bounded", "default", "limits: {max_attempts: 5}\n"),
    );
    await c.runOnce();
    await c.runOnce();
    await c.runOnce();
    await c.runOnce();
    expect(c.getDetail("bounded").task).toMatchObject({
      state: "held",
      nextAction: "frontier-worker",
      reviewTier: "frontier",
    });
    expect(c.getDetail("bounded").attempts).toHaveLength(2);
    expect(await c.runOnce()).toBeNull();
    expect(f.workers).toHaveLength(2);
  });
  it.each(["attempt-limit", "policy-limit"])(
    "respects the %s before scheduling any repair",
    async (limit) => {
      if (limit === "policy-limit")
        f.config.policy = { ...defaultPolicy(), max_repairs: 0 };
      f.setReviewer((input) => f.accept(input, "needs-repair"));
      const c = f.controller;
      await c.addTask(
        f.markdown(
          "budget",
          "default",
          limit === "attempt-limit" ? "limits: {max_attempts: 1}\n" : "",
        ),
      );
      await c.runOnce();
      await c.runOnce();
      expect(c.getDetail("budget").task.nextAction).toBe("frontier-worker");
      expect(await c.runOnce()).toBeNull();
      expect(f.workers).toHaveLength(1);
    },
  );
  it("holds malformed review output without acceptance or an unnecessary orphan fence", async () => {
    f.setReviewer(async () => ({
      exit: "completed",
      summary: "Worker says done",
      usage: { inputTokens: 12 },
    }));
    const c = f.controller;
    await c.addTask(f.markdown("invalid", "default"));
    await c.runOnce();
    await c.runOnce();
    expect(c.getDetail("invalid").task).toMatchObject({
      state: "held",
      nextAction: null,
    });
    expect(c.getDetail("invalid").reviews?.[0]).toMatchObject({
      outcome: "failed",
      report: null,
      usage: { inputTokens: 12 },
    });
    await expect(c.decide("invalid", "accepted")).rejects.toThrow("ready");
    expect(() => c.reconcile("invalid")).toThrow();
    await c.addTask(f.markdown("other", "default"));
    f.setReviewer((input) => f.accept(input));
    expect(await c.runOnce()).toBe("other");
    await c.runOnce();
    expect(c.getDetail("other").task.state).toBe("ready");
  });
  it("fences mutating reviewers until explicit reconciliation while preserving immutable evidence", async () => {
    f.setReviewer(async (input) => {
      await writeFile(
        join(input.worktree, "residue.txt"),
        "unexpected reviewer mutation",
      );
      return f.accept(input);
    });
    const c = f.controller;
    await c.addTask(f.markdown("mutation", "default"));
    await c.runOnce();
    await c.runOnce();
    const review = c.getDetail("mutation").reviews![0]!;
    expect(review.outcome).toBe("uncertain");
    expect(review.report).toBeNull();
    expect(c.getDetail("mutation").task).toMatchObject({
      state: "held",
      nextAction: null,
    });
    const checkout = join(f.data, "worktrees", `review-${review.id}`);
    expect(await readFile(join(checkout, "residue.txt"), "utf8")).toContain(
      "mutation",
    );
    await c.addTask(f.markdown("queued", "default"));
    expect(await c.runOnce()).toBeNull();
    expect(c.getDetail("queued").attempts).toHaveLength(0);
    expect(c.reconcile("mutation").state).toBe("abandoned");
    expect(c.getDetail("mutation").reviews?.[0]).toEqual(review);
    await expect(access(checkout)).resolves.toBeUndefined();
    f.setReviewer((input) => f.accept(input));
    expect(await c.runOnce()).toBe("queued");
    await c.runOnce();
    expect(c.getDetail("queued").task.state).toBe("ready");
  });
  it("recovers an interrupted review without rerunning it and keeps the global fence until reconciliation", async () => {
    const c = f.controller;
    await c.addTask(f.markdown("interrupted", "default"));
    await c.runOnce();
    const attempt = c.getDetail("interrupted").attempts[0]!;
    const pending = f.store.createReview({
      taskId: "interrupted",
      attemptId: attempt.id,
      tier: "local",
      source: "service-local",
      resultSha: attempt.resultSha!,
      profileId: "fixture",
    });
    await c.recover();
    expect(f.store.getReview(pending.id)?.outcome).toBe("uncertain");
    expect(c.getDetail("interrupted").task.nextAction).toBeNull();
    await c.addTask(f.markdown("next", "default"));
    expect(await c.runOnce()).toBeNull();
    expect(f.reviewers).toHaveLength(0);
    expect(c.getDetail("next").attempts).toHaveLength(0);
    c.reconcile("interrupted");
    expect(f.store.getReview(pending.id)?.outcome).toBe("uncertain");
    expect(await c.runOnce()).toBe("next");
  });
  it("fences unknown worker execution after adapter throws until explicit owner reconciliation", async () => {
    f.setWorker(async () => {
      throw new Error("Subprocess completion cannot be established");
    });
    const c = f.controller;
    await c.addTask(f.markdown("unknown", "default"));
    await c.addTask(f.markdown("later", "default"));
    expect(await c.runOnce()).toBe("unknown");
    const interrupted = c.getDetail("unknown").attempts[0]!;
    expect(interrupted.outcome).toBe("uncertain");
    expect(c.getDetail("unknown").task).toMatchObject({
      state: "held",
      nextAction: null,
    });
    expect(await c.runOnce()).toBeNull();
    expect(c.getDetail("later").attempts).toHaveLength(0);
    expect(c.reconcile("unknown").state).toBe("abandoned");
    expect(c.getDetail("unknown").attempts[0]).toEqual(interrupted);
    f.setWorker((input) => f.adapter.run(input));
    expect(await c.runOnce()).toBe("later");
    await c.runOnce();
    expect(c.getDetail("later").task.state).toBe("ready");
    await expect(access(interrupted.worktree)).resolves.toBeUndefined();
  });
  it("keeps local work moving while frontier worker and review tasks are unavailable", async () => {
    const c = f.controller;
    expect(f.store.getFrontierState().available).toBe(false);
    await c.addTask(
      f
        .markdown("risky", "default")
        .replace("class: mechanical", "class: risky"),
    );
    await c.addTask(f.markdown("frontier-review", "frontier"));
    await c.addTask(f.markdown("local", "default"));
    expect(await c.runOnce()).toBe("frontier-review");
    expect(c.getDetail("frontier-review").task.nextAction).toBe("review");
    expect(await c.runOnce()).toBe("local");
    expect(await c.runOnce()).toBe("local");
    expect(c.getDetail("local").task.state).toBe("ready");
    expect(c.getDetail("risky").attempts).toHaveLength(0);
    expect(c.getDetail("risky").task).toMatchObject({
      state: "held",
      nextAction: "frontier-worker",
    });
    expect(c.getDetail("frontier-review").reviews).toHaveLength(0);
    expect(f.reviewers).toHaveLength(1);
    await expect(c.claimFrontier("risky")).rejects.toThrow("unavailable");
  });
}, 30000);
