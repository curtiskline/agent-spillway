import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.js";
import { parseTask } from "../src/task.js";
import type { NewAttempt } from "../src/contracts.js";
let root: string;
let store: Store;
const spec = (id = "fix-one", after: string[] = []) =>
  parseTask(
    `---\nid: ${id}\nrepo: /fixture\nbase: main\nclass: tests\nafter: [${after.join(", ")}]\nscope: [src/**]\ncontext: [src/file.ts]\nchecks: [npm test]\n---\n## Objective\nFix it.\n## Acceptance criteria\nTest it.\n`,
  );
const attempt = (taskId = "fix-one"): NewAttempt => ({
  taskId,
  endpoint: "fixture",
  profileId: "fixture",
  model: "fixture-model",
  modelArtifact: "fixture-artifact",
  harness: "opencode",
  harnessVersion: "1.0.0",
  baseSha: "a".repeat(40),
  branch: `spillway/${taskId}`,
  worktree: "",
  logPath: "",
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "spillway-store-"));
  store = new Store(join(root, "data"));
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});
describe("durable transactional queue", () => {
  it("persists records, copies, events and restrictive file permissions across reopen", () => {
    store.addTask(spec(), "raw", "fixture", "local");
    const copy = store.getTask("fix-one")!;
    copy.spec.scope.push("private");
    expect(store.getTask("fix-one")!.spec.scope).toEqual(["src/**"]);
    store.close();
    store = new Store(join(root, "data"));
    expect(store.listTasks()).toHaveLength(1);
    expect(store.listEvents("fix-one")[0]?.type).toBe("task_added");
    expect(statSync(join(root, "data")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "data", "queue.sqlite")).mode & 0o777).toBe(
      0o600,
    );
  });
  it("rejects duplicates and missing, self and repeated dependencies atomically", () => {
    store.addTask(spec(), "raw", "fixture", "local");
    expect(() => store.addTask(spec(), "other", "fixture", "local")).toThrow(
      /already exists/,
    );
    expect(() =>
      store.addTask(spec("fix-two", ["missing"]), "raw", "fixture", "local"),
    ).toThrow(/does not exist/);
    expect(() =>
      store.addTask(
        { ...spec("fix-two"), after: ["fix-two"] },
        "raw",
        "fixture",
        "local",
      ),
    ).toThrow(/acyclic/);
    expect(() =>
      store.addTask(
        { ...spec("fix-two"), after: ["fix-one", "fix-one"] },
        "raw",
        "fixture",
        "local",
      ),
    ).toThrow(/unique/);
    expect(store.listTasks()).toHaveLength(1);
    expect(
      store.addTask(spec("fix-two", ["fix-one"]), "raw", "fixture", "local")
        .spec.after,
    ).toEqual(["fix-one"]);
  });
  it("enforces valid state changes, terminal decisions, and review strengthening", () => {
    store.addTask(spec(), "raw", "fixture", "local");
    expect(() => store.setTaskState("fix-one", "accepted")).toThrow(
      /transition/,
    );
    store.setTaskState("fix-one", "queued", "endpoint down");
    expect(store.getTask("fix-one")!.reason).toBe("endpoint down");
    expect(() => store.setTaskReview("fix-one", "checks-only")).toThrow(
      /weakened/,
    );
    store.setTaskReview("fix-one", "frontier");
    store.createAttempt(attempt());
    store.setTaskState("fix-one", "verifying");
    store.setTaskState("fix-one", "ready");
    store.setTaskState("fix-one", "accepted");
    expect(() => store.setTaskState("fix-one", "queued")).toThrow(/transition/);
  });
  it("holds the one active slot throughout verification and permits exactly a new finalized attempt", () => {
    store.addTask(spec(), "raw", "fixture", "local");
    store.addTask(spec("fix-two"), "raw", "fixture", "local");
    const first = store.createAttempt(attempt());
    store.updateAttempt(first.id, {
      worktree: "/private/worktree",
      logPath: "/private/log",
    });
    store.setTaskState("fix-one", "verifying");
    expect(() => store.createAttempt(attempt("fix-two"))).toThrow(
      /already active/,
    );
    const otherConnection = new Store(join(root, "data"));
    try {
      expect(() => otherConnection.createAttempt(attempt("fix-two"))).toThrow(
        /already active/,
      );
    } finally {
      otherConnection.close();
    }
    store.updateAttempt(first.id, {
      outcome: "completed",
      resultSha: "b".repeat(40),
      verification: {
        passed: true,
        changedPaths: ["src/file.ts"],
        flags: [],
        checks: [],
      },
    });
    expect(store.getAttempt(first.id)?.endedAt).not.toBeNull();
    expect(store.createAttempt(attempt("fix-two")).id).toBeGreaterThan(
      first.id,
    );
    expect(() =>
      store.updateAttempt(first.id, { summary: "rewrite evidence" }),
    ).toThrow(/immutable/);
  });
  it("recovers running attempts uncertain and held without re-running and can finalize inspected evidence", () => {
    store.addTask(spec(), "raw", "fixture", "local");
    const first = store.createAttempt(attempt());
    store.setTaskState("fix-one", "verifying");
    expect(store.recoverInflight().map((value) => value.outcome)).toEqual([
      "uncertain",
    ]);
    expect(store.getTask("fix-one")?.state).toBe("held");
    expect(store.recoverInflight().map((value) => value.id)).toEqual([
      first.id,
    ]);
    expect(() => store.updateAttempt(first.id, { outcome: "running" })).toThrow(
      /restart/,
    );
    store.setTaskState("fix-one", "verifying");
    store.updateAttempt(first.id, {
      outcome: "completed",
      verification: { passed: true, changedPaths: [], flags: [], checks: [] },
    });
    expect(store.getAttempt(first.id)?.outcome).toBe("completed");
  });
  it("supports transport retry by finalizing old attempt before requeue", () => {
    store.addTask(spec(), "raw", "fixture", "local");
    const first = store.createAttempt(attempt());
    store.updateAttempt(first.id, { outcome: "transport_error" });
    store.setTaskState("fix-one", "queued");
    expect(store.createAttempt(attempt()).id).toBeGreaterThan(first.id);
    expect(store.listAttempts("fix-one")).toHaveLength(2);
  });
  it("validates patch and prevents non-JSON events from partially updating state", () => {
    store.addTask(spec(), "raw", "fixture", "local");
    const first = store.createAttempt(attempt());
    expect(() =>
      store.updateAttempt(first.id, {
        outcome: "running",
        endedAt: new Date().toISOString(),
      }),
    ).toThrow(/end time/);
    expect(() =>
      store.updateAttempt(first.id, { usage: { costUsd: -1 } }),
    ).toThrow();
    expect(() => store.addEvent("fix-one", "event", undefined)).toThrow(/JSON/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => store.addEvent("fix-one", "event", cyclic)).toThrow();
    expect(store.getAttempt(first.id)?.outcome).toBe("running");
  });
  it("enforces database foreign keys and schema version", () => {
    const db = new DatabaseSync(join(root, "data", "queue.sqlite"));
    db.exec("PRAGMA foreign_keys=ON");
    expect(() =>
      db
        .prepare(
          "INSERT INTO events(task_id,type,payload,created_at) VALUES(?,?,?,?)",
        )
        .run("missing", "event", "{}", "now"),
    ).toThrow(/FOREIGN KEY/);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
    db.close();
  });
  it("refuses data in a Git checkout or symlinked database", () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    expect(() => new Store(join(repo, "data"))).toThrow(/outside/);
    const data = join(root, "symlink");
    mkdirSync(data);
    symlinkSync(join(root, "data", "queue.sqlite"), join(data, "queue.sqlite"));
    expect(() => new Store(data)).toThrow(/regular file/);
  });
  it("finalizes attempt/state/review/events atomically and rolls back invalid transitions", () => {
    store.addTask(spec(), "raw", "fixture", "local");
    const a = store.createAttempt(attempt());
    store.setTaskState("fix-one", "verifying");
    const before = store.listEvents("fix-one").length;
    expect(() =>
      store.finalizeAttempt(a.id, { outcome: "completed" }, "accepted"),
    ).toThrow(/transition/);
    expect(store.getAttempt(a.id)?.outcome).toBe("running");
    expect(store.getTask("fix-one")?.state).toBe("verifying");
    expect(store.listEvents("fix-one")).toHaveLength(before);
    expect(() =>
      store.finalizeAttempt(
        a.id,
        { outcome: "completed" },
        "ready",
        undefined,
        "checks-only",
      ),
    ).toThrow(/weakened/);
    expect(store.getAttempt(a.id)?.outcome).toBe("running");
    store.finalizeAttempt(
      a.id,
      { outcome: "completed" },
      "held",
      "frontier review pending",
      "frontier",
    );
    expect(store.getAttempt(a.id)?.outcome).toBe("completed");
    expect(store.getTask("fix-one")?.state).toBe("held");
    expect(store.getTask("fix-one")?.reviewTier).toBe("frontier");
  });
  it("holds legacy stranded finalizations without changing finalized evidence", () => {
    store.addTask(spec(), "raw", "fixture", "local");
    const a = store.createAttempt(attempt());
    store.setTaskState("fix-one", "verifying");
    store.updateAttempt(a.id, { outcome: "completed" });
    store.close();
    store = new Store(join(root, "data"));
    store.recoverInflight();
    expect(store.getTask("fix-one")?.state).toBe("held");
    expect(store.getAttempt(a.id)?.outcome).toBe("completed");
  });
  it("claims and releases the controller lease atomically without stealing a live owner", () => {
    store.acquireControllerLease(process.pid, "first");
    const other = new Store(join(root, "data"));
    try {
      expect(() => other.acquireControllerLease(process.pid, "second")).toThrow(
        /already running/,
      );
      other.releaseControllerLease("wrong");
      expect(() => other.acquireControllerLease(process.pid, "second")).toThrow(
        /already running/,
      );
      store.releaseControllerLease("first");
      other.acquireControllerLease(process.pid, "second");
      other.releaseControllerLease("second");
    } finally {
      other.close();
    }
  });
  it("migrates v1 to v2 while preserving queued tasks", () => {
    store.addTask(spec(), "raw", "fixture", "local");
    store.close();
    const db = new DatabaseSync(join(root, "data", "queue.sqlite"));
    db.exec("DROP TABLE controller_lease;PRAGMA user_version=1;");
    db.close();
    store = new Store(join(root, "data"));
    expect(store.getTask("fix-one")?.state).toBe("queued");
    store.acquireControllerLease(process.pid, "migration");
    store.releaseControllerLease("migration");
  });
});
