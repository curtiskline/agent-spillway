import { describe, it, expect } from "vitest";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { Controller } from "../src/controller.js";
import { Store } from "../src/store.js";
import { GitWorkspace, gitCommand } from "../src/git.js";
import { fixture } from "./helpers.js";

describe("controller vertical slice", () => {
  it("runs a subprocess in a real Git worktree, verifies independently, reports and accepts without merging", async () => {
    const f = await fixture();
    const store = new Store(f.data);
    const controller = new Controller(f.config, store, f.adapter);
    try {
      await controller.addTask(f.markdown());
      expect(await controller.runOnce()).toBe("hello");
      const detail = controller.getDetail("hello");
      expect(detail.task.state).toBe("ready");
      expect(detail.attempts[0]?.verification?.passed).toBe(true);
      expect(detail.attempts[0]?.usage).toBeNull();
      expect(
        JSON.parse(await readFile(detail.attempts[0]!.reportPath!, "utf8"))
          .resultSha,
      ).toBe(detail.attempts[0]?.resultSha);
      expect(await readFile(join(f.repo, "src/message.cjs"), "utf8")).toContain(
        "wrong",
      );
      await controller.decide("hello", "accepted");
      expect(controller.getDetail("hello").task.state).toBe("accepted");
      expect(f.calls).toBe(1);
    } finally {
      store.close();
      await f.cleanup();
    }
  }, 20000);
  it("waits for unavailable/mismatched catalog without spending attempts, then drains", async () => {
    const f = await fixture();
    const store = new Store(f.data);
    const c = new Controller(f.config, store, f.adapter);
    try {
      await c.addTask(f.markdown());
      f.setHealthy(false);
      expect(await c.runOnce()).toBeNull();
      expect(c.getDetail("hello").attempts).toHaveLength(0);
      expect(c.getDetail("hello").task.reason).toBeTruthy();
      f.setHealthy(true);
      f.setModel("other");
      expect(await c.runOnce()).toBeNull();
      f.setModel("fixture-model");
      expect(await c.runOnce()).toBe("hello");
    } finally {
      store.close();
      await f.cleanup();
    }
  }, 20000);
  it("holds default local review, forbids owner acceptance, and denies hosted transmission", async () => {
    const f = await fixture();
    const store = new Store(f.data);
    const c = new Controller(f.config, store, f.adapter);
    try {
      await c.addTask(f.markdown("review", "default"));
      await c.runOnce();
      expect(c.getDetail("review").task.state).toBe("held");
      expect(c.getDetail("review").task.reviewTier).toBe("local");
      await expect(c.decide("review", "accepted")).rejects.toThrow("ready");
      f.config.endpoints[0]!.kind = "open-weight-hosted";
      await expect(c.addTask(f.markdown("hosted"))).rejects.toThrow(
        "data policy",
      );
    } finally {
      store.close();
      await f.cleanup();
    }
  }, 20000);
  it("requires dependency result ancestry after acceptance, then dispatches on merged base", async () => {
    const f = await fixture();
    const store = new Store(f.data);
    const c = new Controller(f.config, store, f.adapter);
    try {
      await c.addTask(f.markdown("first"));
      await c.runOnce();
      await c.decide("first", "accepted");
      await c.addTask(f.markdown("second", "checks-only", "after: [first]\n"));
      expect(await c.runOnce()).toBeNull();
      expect(c.getDetail("second").attempts).toHaveLength(0);
      await gitCommand(f.repo, ["merge", "--ff-only", "spillway/first"]);
      expect(await c.runOnce()).toBe("second");
      expect(c.getDetail("second").task.state).toBe("held");
      expect(c.getDetail("second").task.nextAction).toBe("frontier-worker");
      expect(c.getDetail("second").attempts.at(-1)?.outcome).toBe("failed");
    } finally {
      store.close();
      await f.cleanup();
    }
  }, 20000);
  it("pins harness version and rechecks data policy before dispatch", async () => {
    const f = await fixture();
    const store = new Store(f.data);
    const c = new Controller(f.config, store, f.adapter);
    try {
      await c.addTask(f.markdown("pin"));
      f.config.profiles[0]!.harness_version = "other";
      expect(await c.runOnce()).toBeNull();
      expect(c.getDetail("pin").task.state).toBe("held");
      await c.addTask(f.markdown("policy"));
      f.config.endpoints[0]!.kind = "frontier";
      expect(await c.runOnce()).toBeNull();
      expect(c.getDetail("policy").task.state).toBe("held");
      expect(f.calls).toBe(0);
    } finally {
      store.close();
      await f.cleanup();
    }
  });
  it("recover inspects and holds committed work without invoking the worker again", async () => {
    const f = await fixture();
    let store = new Store(f.data);
    let c = new Controller(f.config, store, f.adapter);
    try {
      const task = await c.addTask(f.markdown("recover"));
      const w = new GitWorkspace(f.repo, f.data);
      const base = await w.resolveBase("main");
      const a = store.createAttempt({
        taskId: task.id,
        endpoint: "fixture",
        profileId: "fixture",
        model: "fixture-model",
        modelArtifact: "fixture-only",
        harness: "opencode",
        harnessVersion: "fixture-v1",
        baseSha: base,
        branch: "spillway/recover",
        worktree: "",
        logPath: "",
      });
      const worktree = await w.createWorker("recover", base, a.id);
      store.updateAttempt(a.id, { worktree });
      await writeFile(
        join(worktree, "src/message.cjs"),
        "module.exports=()=> 'hello';\n",
      );
      await gitCommand(worktree, ["add", "."]);
      await gitCommand(worktree, [
        "commit",
        "-m",
        "Committed before interruption",
      ]);
      store.close();
      store = new Store(f.data);
      c = new Controller(f.config, store, f.adapter);
      await c.recover();
      expect(c.getDetail("recover").task.state).toBe("held");
      expect(c.getDetail("recover").attempts[0]?.outcome).toBe("uncertain");
      expect(
        c
          .getDetail("recover")
          .events.some((e) => e.type === "recovery-inspection"),
      ).toBe(true);
      expect(f.calls).toBe(0);
      expect(c.getDetail("recover").attempts).toHaveLength(1);
    } finally {
      store.close();
      await f.cleanup();
    }
  }, 20000);
  it("recover holds dirty interrupted work and never reruns it", async () => {
    const f = await fixture();
    const store = new Store(f.data);
    const c = new Controller(f.config, store, f.adapter);
    try {
      const task = await c.addTask(f.markdown("dirty"));
      const w = new GitWorkspace(f.repo, f.data);
      const base = await w.resolveBase("main");
      const a = store.createAttempt({
        taskId: task.id,
        endpoint: "fixture",
        profileId: "fixture",
        model: "fixture-model",
        modelArtifact: "fixture-only",
        harness: "opencode",
        harnessVersion: "fixture-v1",
        baseSha: base,
        branch: "spillway/dirty",
        worktree: "",
        logPath: "",
      });
      const worktree = await w.createWorker("dirty", base, a.id);
      store.updateAttempt(a.id, { worktree });
      await writeFile(join(worktree, "src/message.cjs"), "uncommitted");
      await c.recover();
      expect(c.getDetail("dirty").task.state).toBe("held");
      expect(c.getDetail("dirty").attempts[0]?.outcome).toBe("uncertain");
      expect(f.calls).toBe(0);
    } finally {
      store.close();
      await f.cleanup();
    }
  }, 20000);
});

it("expands home-relative task repos under a clean daemon environment", async () => {
  const f = await fixture();
  const home = homedir();
  const sample = await mkdtemp(join(home, ".spillway-home-fixture-"));
  const repo = join(sample, "repo");
  const savedHome = process.env.HOME;
  const store = new Store(f.data);
  try {
    await gitCommand(f.repo, ["clone", "--no-hardlinks", f.repo, repo]);
    f.config.repositories = [{ path: repo, data_policy: "local-only" }];
    const c = new Controller(f.config, store, f.adapter);
    delete process.env.HOME;
    const raw = f
      .markdown("home-relative")
      .replace(`repo: ${f.repo}`, `repo: ~/${relative(home, repo)}`);
    expect((await c.addTask(raw)).spec.repo).toBe(repo);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    store.close();
    await f.cleanup();
    await rm(sample, { recursive: true, force: true });
  }
});
