import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    expect(() => store.updateAttempt(first.id, { outcome: 'completed' })).toThrow(/Uncertain/);
    store.resolveUncertainty('fix-one');
    expect(store.getTask('fix-one')?.state).toBe('abandoned');
    expect(store.getAttempt(first.id)?.outcome).toBe('uncertain');
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
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
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
    db.exec("DROP TABLE reviews; DROP TABLE settings; DROP TABLE setting_events; DROP TABLE controller_lease; ALTER TABLE tasks DROP COLUMN next_action; ALTER TABLE attempts DROP COLUMN kind; ALTER TABLE attempts DROP COLUMN parent_attempt_id; PRAGMA user_version=1;");
    db.close();
    store = new Store(join(root, "data"));
    expect(store.getTask("fix-one")?.state).toBe("queued");
    store.acquireControllerLease(process.pid, "migration");
    store.releaseControllerLease("migration");
  });
});

const resultSha = 'b'.repeat(40);
function verifiedTask(id = 'fix-one', tier: 'local' | 'frontier' = 'local') {
  store.addTask(spec(id),'raw','fixture',tier);
  const a = store.createAttempt(attempt(id)); store.setTaskState(id,'verifying');
  store.finalizeAttempt(a.id,{ outcome: 'completed',resultSha,verification: { passed: true,resultSha,changedPaths: ['src/file.ts'],flags: [],checks: [] } },'held');
  return a;
}
function reviewInput(id = 'fix-one', attemptId = store.listAttempts(id).at(-1)!.id) {
  return { taskId: id,attemptId,tier: 'local' as const,source: 'service-local' as const,resultSha,profileId: 'fixture',model: 'fixture-model' };
}
const acceptedReport = () => ({ resultSha,verdict: 'accept' as const,findings: [] });

describe('phase two review and continuation integrity', () => {
  it('records additive attempt metadata and derives pending review after atomic verification', () => {
    const a = verifiedTask(); expect(store.getAttempt(a.id)?.kind).toBe('worker'); expect(store.getAttempt(a.id)?.parentAttemptId).toBeNull();
    expect(store.getTask('fix-one')?.nextAction).toBe('review');
    const r = store.createReview(reviewInput()); expect(store.getTask('fix-one')?.state).toBe('reviewing');
    store.finishReview(r.id,{ outcome: 'completed',report: acceptedReport(),usage: { inputTokens: 12 } },'ready',null);
    expect(store.getTask('fix-one')?.state).toBe('ready'); expect(store.getTask('fix-one')?.nextAction).toBeNull();
    expect(store.getReview(r.id)?.report).toEqual(acceptedReport()); expect(store.getReview(r.id)?.endedAt).not.toBeNull();
    const copy = store.getReview(r.id)!; copy.report!.findings.push({ severity: 'blocking',message: 'changed copy' });
    expect(store.getReview(r.id)?.report?.findings).toEqual([]);
    expect(() => store.finishReview(r.id,{ outcome: 'failed' },'held',null)).toThrow(/cannot be rewritten/);
  });
  it('enforces the global slot across reviews and workers, including another connection', () => {
    verifiedTask(); store.addTask(spec('fix-two'),'raw','fixture','local'); const r = store.createReview(reviewInput());
    expect(() => store.createAttempt(attempt('fix-two'))).toThrow(/already active/);
    const other = new Store(join(root,'data'));
    try { expect(() => other.createAttempt(attempt('fix-two'))).toThrow(/already active/); } finally { other.close(); }
    store.finishReview(r.id,{ outcome: 'failed',reason: 'Reviewer failed' },'held',null,'Reviewer failed');
    expect(store.createAttempt(attempt('fix-two')).outcome).toBe('running');
  });
  it('blocks review creation while an unrelated attempt is running', () => {
    verifiedTask(); store.addTask(spec('fix-two'),'raw','fixture','local'); store.createAttempt(attempt('fix-two'));
    expect(() => store.createReview(reviewInput())).toThrow(/already active/);
    expect(store.getTask('fix-one')?.state).toBe('held'); expect(store.listReviews('fix-one')).toEqual([]);
  });
  it('rejects replay, wrong SHA, missing checks and incorrect source/tier', () => {
    const a = verifiedTask();
    expect(() => store.createReview({ ...reviewInput(),resultSha: 'c'.repeat(40) })).toThrow(/verified result/);
    expect(() => store.createReview({ ...reviewInput(),tier: 'frontier' })).toThrow(/Owner sessions/);
    expect(() => store.createReview({ ...reviewInput(),source: 'owner-session' })).toThrow(/Owner sessions/);
    expect(() => store.createReview({ ...reviewInput(),tier: 'frontier',source: 'owner-session' })).toThrow(/requirement/);
    const r = store.createReview(reviewInput()); store.finishReview(r.id,{ outcome: 'failed' },'held',null);
    store.setTaskAction('fix-one','held','review'); expect(() => store.createReview(reviewInput())).toThrow(/already has a review/);
    expect(store.getReview(r.id)?.attemptId).toBe(a.id);
  });
  it('rejects old attempts even when the old SHA and checks are valid', () => {
    const old = verifiedTask(); store.setTaskAction('fix-one','queued','worker');
    const next = store.createAttempt(attempt()); store.setTaskState('fix-one','verifying');
    const latestSha = 'c'.repeat(40);
    store.finalizeAttempt(next.id,{ outcome: 'completed',resultSha: latestSha,verification: { passed: true,resultSha: latestSha,changedPaths: [],flags: [],checks: [] } },'held');
    expect(() => store.createReview(reviewInput('fix-one',old.id))).toThrow(/latest/);
    expect(store.createReview({ ...reviewInput(),resultSha: latestSha }).attemptId).toBe(next.id);
  });
  it('requires passed independent verification, not just completed worker output', () => {
    store.addTask(spec(),'raw','fixture','local'); const a = store.createAttempt(attempt()); store.setTaskState('fix-one','verifying');
    store.finalizeAttempt(a.id,{ outcome: 'completed',resultSha,verification: { passed: false,resultSha,changedPaths: [],flags: [],checks: [] } },'held',undefined,undefined,'review');
    expect(() => store.createReview(reviewInput())).toThrow(/independently verified/);
  });
  it('rolls back report, task and events for stale or invalid finalization', () => {
    verifiedTask(); const r = store.createReview(reviewInput()); const before = store.listEvents('fix-one').length;
    expect(() => store.finishReview(r.id,{ outcome: 'completed',report: { ...acceptedReport(),resultSha: 'c'.repeat(40) } },'ready',null)).toThrow(/exact verified SHA/);
    expect(() => store.finishReview(r.id,{ outcome: 'completed',report: acceptedReport() },'accepted',null)).toThrow(/Accepting reviews/);
    expect(store.getReview(r.id)?.outcome).toBe('running'); expect(store.getReview(r.id)?.report).toBeNull(); expect(store.getTask('fix-one')?.state).toBe('reviewing');
    expect(store.listEvents('fix-one')).toHaveLength(before);
  });
  it('rejects blocking accept, unknown properties, bad paths, malformed SHA and oversized findings', () => {
    verifiedTask(); const r = store.createReview(reviewInput());
    expect(() => store.finishReview(r.id,{ outcome: 'completed',report: { ...acceptedReport(),findings: [{ severity: 'blocking',message: 'Broken' }] } },'ready',null)).toThrow(/blocking/);
    expect(() => store.finishReview(r.id,{ outcome: 'completed',report: { ...acceptedReport(),findings: [{ severity: 'warning',message: 'Unsafe path',path: '../outside' }] } },'ready',null)).toThrow(/relative/);
    expect(() => store.finishReview(r.id,{ outcome: 'completed',report: { ...acceptedReport(),resultSha: 'b'.repeat(41) } },'ready',null)).toThrow();
    expect(() => store.finishReview(r.id,{ outcome: 'completed',report: { ...acceptedReport(),findings: Array.from({ length: 51 },() => ({ severity: 'warning' as const,message: 'Warning' })) } },'ready',null)).toThrow();
    expect(() => store.finishReview(r.id,{ outcome: 'completed',report: { ...acceptedReport(),findings: [{ severity: 'warning',message: 'x'.repeat(4001) }] } },'ready',null)).toThrow();
    const unknown: unknown = { outcome: 'completed',report: acceptedReport(),authority: 'worker' };
    expect(() => store.finishReview(r.id,unknown as Parameters<Store['finishReview']>[1],'ready',null)).toThrow();
    expect(store.getReview(r.id)?.outcome).toBe('running');
  });
  it('holds failed reviews and denies verdict/state bypasses', () => {
    verifiedTask(); const r = store.createReview(reviewInput());
    expect(() => store.finishReview(r.id,{ outcome: 'completed' },'ready',null)).toThrow(/report/);
    expect(() => store.finishReview(r.id,{ outcome: 'failed' },'ready',null)).toThrow(/must hold/);
    expect(() => store.finishReview(r.id,{ outcome: 'completed',report: { ...acceptedReport(),verdict: 'reject' } },'ready',null)).toThrow(/Rejected/);
    expect(() => store.finishReview(r.id,{ outcome: 'completed',report: { ...acceptedReport(),verdict: 'needs-repair' } },'ready',null)).toThrow(/Needs-repair/);
    store.finishReview(r.id,{ outcome: 'failed',reason: 'Review checkout was mutated' },'held',null,'Review checkout was mutated');
    expect(store.getTask('fix-one')?.reason).toMatch(/mutated/); expect(store.getReview(r.id)?.reason).toMatch(/mutated/);
  });
  it('preserves a local accepting report while stronger frontier review is pending', () => {
    verifiedTask(); const local = store.createReview(reviewInput()); store.setTaskReview('fix-one','frontier');
    expect(() => store.finishReview(local.id,{ outcome: 'completed',report: acceptedReport() },'ready',null)).toThrow(/required tier/);
    store.finishReview(local.id,{ outcome: 'completed',report: acceptedReport() },'held','review');
    const frontier = store.createReview({ ...reviewInput(),tier: 'frontier',source: 'owner-session' });
    store.finishReview(frontier.id,{ outcome: 'completed',report: acceptedReport() },'ready',null);
    expect(store.listReviews('fix-one').map(r => r.source)).toEqual(['service-local','owner-session']);
  });
  it('persists repair lineage and original base, refusing stale or foreign parents', () => {
    const a = verifiedTask(); const r = store.createReview(reviewInput());
    store.finishReview(r.id,{ outcome: 'completed',report: { ...acceptedReport(),verdict: 'needs-repair',findings: [{ severity: 'blocking',message: 'Add a boundary case' }] } },'queued','repair');
    expect(() => store.createAttempt({ ...attempt(),kind: 'repair' })).toThrow(/latest committed parent/);
    expect(() => store.createAttempt({ ...attempt(),kind: 'repair',parentAttemptId: a.id,baseSha: resultSha })).toThrow(/original base/);
    const repaired = store.createAttempt({ ...attempt(),kind: 'repair',parentAttemptId: a.id });
    expect(repaired.parentAttemptId).toBe(a.id); expect(repaired.kind).toBe('repair'); expect(repaired.baseSha).toBe(a.baseSha);
  });
  it('creates frontier attempts only from explicit frontier action', () => {
    store.addTask(spec(),'raw','fixture','frontier'); expect(() => store.createAttempt({ ...attempt(),kind: 'frontier' })).toThrow(/awaiting/);
    store.setTaskAction('fix-one','escalated','frontier-worker');
    expect(store.createAttempt({ ...attempt(),kind: 'frontier' }).kind).toBe('frontier'); expect(store.getTask('fix-one')?.nextAction).toBeNull();
  });
  it('keeps task action/review changes atomic on invalid transitions', () => {
    store.addTask(spec(),'raw','fixture','local');
    expect(() => store.setTaskAction('fix-one','ready','review',undefined,'frontier')).toThrow();
    expect(store.getTask('fix-one')?.reviewTier).toBe('local'); expect(store.getTask('fix-one')?.nextAction).toBe('worker');
    expect(() => store.setTaskAction('fix-one','queued',null)).toThrow(/require a worker/);
  });
  it('recovers orphan reviews uncertain, fences every inference kind, and reconciles without rewriting evidence', () => {
    verifiedTask(); const r = store.createReview(reviewInput()); store.addTask(spec('fix-two'),'raw','fixture','local');
    expect(store.recoverInflight()).toEqual([]); const interrupted = store.getReview(r.id)!;
    expect(interrupted.outcome).toBe('uncertain'); expect(store.getTask('fix-one')?.nextAction).toBeNull(); expect(store.hasUnresolvedExecution()).toBe(true);
    expect(() => store.createAttempt(attempt('fix-two'))).toThrow(/reconciliation/);
    expect(() => store.finishReview(r.id,{ outcome: 'completed',report: acceptedReport() },'ready',null)).toThrow(/cannot be rewritten/);
    store.close(); store = new Store(join(root,'data')); store.recoverInflight();
    expect(store.getReview(r.id)).toEqual(interrupted); store.resolveUncertainty('fix-one');
    expect(store.getTask('fix-one')?.state).toBe('abandoned'); expect(store.getReview(r.id)).toEqual(interrupted); expect(store.hasUnresolvedExecution()).toBe(false);
    expect(store.createAttempt(attempt('fix-two')).outcome).toBe('running');
  });
  it('records explicit uncertain review outcomes as held fences', () => {
    verifiedTask(); const r = store.createReview(reviewInput());
    store.finishReview(r.id,{ outcome: 'uncertain',reason: 'Reviewer interrupted' },'held',null,'Reviewer interrupted');
    expect(store.hasUnresolvedExecution()).toBe(true); expect(() => store.resolveUncertainty('missing')).toThrow(/does not exist/);
    store.resolveUncertainty('fix-one'); expect(store.hasUnresolvedExecution()).toBe(false);
  });
});

describe('frontier availability scheduling', () => {
  it('starts unavailable and retains explicit state after reopening', () => {
    expect(store.getFrontierState()).toMatchObject({ available: false,resetAt: null });
    const on = store.setFrontierState(true); store.close(); store = new Store(join(root,'data')); expect(store.getFrontierState()).toEqual(on);
  });
  it('uses the exact offset instant and resumes once, with private audit records', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-12T12:00:00Z')); store.setFrontierState(false,'2026-10-12T08:00:00-05:00');
      expect(store.getFrontierState().available).toBe(false); vi.setSystemTime(new Date('2026-10-12T12:59:59Z')); expect(store.getFrontierState().available).toBe(false);
      vi.setSystemTime(new Date('2026-10-12T13:00:00Z')); expect(store.getFrontierState()).toMatchObject({ available: true,resetAt: null });
      store.getFrontierState(); const db = new DatabaseSync(join(root,'data','queue.sqlite'));
      try { expect(db.prepare("SELECT COUNT(*) AS n FROM setting_events WHERE type='frontier_scheduled_reset'").get()?.n).toBe(1); } finally { db.close(); }
    } finally { vi.useRealTimers(); }
  });
  it('clears schedules on explicit changes and rejects ambiguous local timestamps', () => {
    store.setFrontierState(false,'2999-01-01T00:00:00Z'); store.setFrontierState(false); expect(store.getFrontierState().resetAt).toBeNull();
    expect(() => store.setFrontierState(false,'2026-10-12T09:00:00')).toThrow(); expect(() => store.setFrontierState(false,'not-a-time')).toThrow();
    expect(() => store.setFrontierState(true,'2999-01-01T00:00:00Z')).toThrow(/only while/);
  });
});

describe('v3 migrations preserve legacy evidence', () => {
  it('infers only safe pending reviews and queued workers from v2', () => {
    const pending = verifiedTask('pending'); const rejected = verifiedTask('rejected'); store.setTaskState('rejected','rejected');
    store.addTask(spec('queued'),'queued raw','fixture','local'); store.addTask(spec('interrupted'),'raw','fixture','local');
    const interrupted = store.createAttempt(attempt('interrupted')); store.recoverInflight();
    const pendingBefore = store.getAttempt(pending.id); const rejectedBefore = store.getAttempt(rejected.id); const interruptedBefore = store.getAttempt(interrupted.id);
    store.close(); const db = new DatabaseSync(join(root,'data','queue.sqlite'));
    db.exec('DROP TABLE reviews; DROP TABLE settings; DROP TABLE setting_events; ALTER TABLE tasks DROP COLUMN next_action; ALTER TABLE attempts DROP COLUMN kind; ALTER TABLE attempts DROP COLUMN parent_attempt_id; PRAGMA user_version=2;'); db.close();
    store = new Store(join(root,'data'));
    expect(store.getTask('pending')?.nextAction).toBe('review'); expect(store.getTask('queued')?.nextAction).toBe('worker');
    expect(store.getTask('rejected')?.nextAction).toBeNull(); expect(store.getTask('interrupted')?.nextAction).toBeNull();
    expect(store.getAttempt(pending.id)).toEqual(pendingBefore); expect(store.getAttempt(rejected.id)).toEqual(rejectedBefore); expect(store.getAttempt(interrupted.id)).toEqual(interruptedBefore);
    expect(store.getFrontierState().available).toBe(false); expect(store.hasUnresolvedExecution()).toBe(true);
  });
});

describe('repair transport retry lineage', () => {
  it('retries a repair from its committed source after an intervening transport failure', () => {
    const source = verifiedTask();
    store.setTaskAction('fix-one','queued','repair');
    const transport = store.createAttempt({ ...attempt(),kind: 'repair',parentAttemptId: source.id });
    store.finalizeAttempt(transport.id,{ outcome: 'transport_error' },'queued','Transport unavailable',undefined,'repair');
    const retry = store.createAttempt({ ...attempt(),kind: 'repair',parentAttemptId: source.id });
    expect(retry.parentAttemptId).toBe(source.id); expect(retry.baseSha).toBe(source.baseSha);
    expect(store.getAttempt(transport.id)?.outcome).toBe('transport_error');
  });
  it('rejects an older repair source after an intervening coding outcome without a commit', () => {
    const source = verifiedTask(); store.setTaskAction('fix-one','queued','repair');
    const coding = store.createAttempt({ ...attempt(),kind: 'repair',parentAttemptId: source.id });
    store.finalizeAttempt(coding.id,{ outcome: 'failed' },'held'); store.setTaskAction('fix-one','queued','repair');
    expect(() => store.createAttempt({ ...attempt(),kind: 'repair',parentAttemptId: source.id })).toThrow(/latest committed parent/);
    expect(store.listAttempts('fix-one')).toHaveLength(2);
  });
  it('rejects a foreign parent and committed source lacking verification after transport failure', () => {
    const foreign = verifiedTask('other'); const source = verifiedTask(); store.setTaskAction('fix-one','queued','repair');
    expect(() => store.createAttempt({ ...attempt(),kind: 'repair',parentAttemptId: foreign.id })).toThrow(/latest committed parent/);
    const transport = store.createAttempt({ ...attempt(),kind: 'repair',parentAttemptId: source.id });
    store.finalizeAttempt(transport.id,{ outcome: 'transport_error' },'queued',undefined,undefined,'repair');
    expect(() => store.createAttempt({ ...attempt(),kind: 'repair',parentAttemptId: source.id,baseSha: resultSha })).toThrow(/original base/);
    store.setTaskAction('fix-one','queued','worker'); const unverified = store.createAttempt(attempt());
    store.finalizeAttempt(unverified.id,{ outcome: 'failed',resultSha },'held'); store.setTaskAction('fix-one','queued','repair');
    expect(() => store.createAttempt({ ...attempt(),kind: 'repair',parentAttemptId: unverified.id })).toThrow(/latest committed parent/);
  });
});

it("preserves admission order for same-millisecond tasks across restart", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
    store.addTask(spec("z-first"), "fixture", "fixture", "local");
    store.addTask(spec("a-second"), "fixture", "fixture", "local");
    expect(store.listTasks().map((task) => task.id)).toEqual(["z-first", "a-second"]);
    store.close();
    store = new Store(join(root, "data"));
    expect(store.listTasks().map((task) => task.id)).toEqual(["z-first", "a-second"]);
  } finally { vi.useRealTimers(); }
});
