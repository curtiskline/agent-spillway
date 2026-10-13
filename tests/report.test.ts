import { describe, it, expect } from "vitest";
import { buildScorecard, formatReport } from "../src/report.js";
import type {
  AttemptRecord,
  ReportSnapshot,
  TaskDetail,
  TaskState,
  AuditRecord,
} from "../src/contracts.js";

const time = (seconds: number) =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
function task(id: string, state: TaskState = "accepted"): TaskDetail {
  return {
    task: {
      id,
      state,
      profileId: "profile-private",
      reviewTier: "local",
      raw: "private",
      reason: null,
      createdAt: time(0),
      updatedAt: time(10),
      spec: {
        id,
        repo: "/private/repo",
        base: "main",
        class: "small-fix",
        after: [],
        scope: ["src/**"],
        protected: [],
        context: ["src/a.ts"],
        checks: ["private check"],
        review: "default",
        limits: { max_minutes: 1, max_attempts: 2 },
        body: "private",
      },
      origin: "ordinary",
      readyAt: time(8),
      completedWhileFrontierOff: true,
    },
    attempts: [],
    reviews: [],
    events: [],
  };
}
function attempt(
  taskId: string,
  id = 1,
  extra: Partial<AttemptRecord> = {},
): AttemptRecord {
  return {
    id,
    taskId,
    endpoint: "private",
    profileId: "profile-private",
    model: "private-model",
    modelArtifact: "unknown",
    harness: "opencode",
    harnessVersion: "1.2.3",
    baseSha: "a".repeat(40),
    branch: "spillway/private",
    worktree: "/private/worktree",
    startedAt: time(1),
    endedAt: time(5),
    outcome: "completed",
    usage: null,
    summary: "private",
    logPath: "/private/log",
    resultSha: "b".repeat(40),
    verification: null,
    reportPath: null,
    kind: "worker",
    ...extra,
  };
}
function snapshot(tasks: TaskDetail[]): ReportSnapshot {
  return {
    tasks,
    decisions: tasks
      .filter((t) => t.task.state === "accepted" || t.task.state === "rejected")
      .map((t) => ({
        taskId: t.task.id,
        decision: t.task.state === "accepted" ? "accepted" : "rejected",
        resultSha: "b".repeat(40),
        reviewTier: "local",
        ownerMinutes: null,
        decidedAt: time(10),
      })),
    audits: [],
    planning: [],
    generatedAt: time(20),
  };
}
function audit(
  taskId: string,
  id: number,
  status: "pending" | "completed",
  verdict: "accept" | "needs-repair" | "reject" = "accept",
): AuditRecord {
  return {
    id,
    taskId,
    attemptId: 1,
    resultSha: "b".repeat(40),
    reviewTier: "local",
    status,
    report:
      status === "completed"
        ? {
            resultSha: "b".repeat(40),
            verdict,
            findings:
              verdict === "accept"
                ? [{ severity: "warning", message: "warning" }]
                : [{ severity: "blocking", message: "miss" }],
          }
        : null,
    model: null,
    usage: null,
    createdAt: time(10),
    completedAt: status === "completed" ? time(15) : null,
  };
}

describe("ordinary-work scorecard", () => {
  it("initializes every fixed declaration bucket, including empty snapshots", () => {
    const features = buildScorecard(snapshot([])).taskSpecs;
    expect(features.version).toBe(1);
    expect(features.measures).toBe("declared-only");
    expect(Object.keys(features.byCheckPlan)).toEqual(["checks", "justified-no-checks", "missing-checks", "unknown"]);
    expect(Object.keys(features.byContext)).toEqual(["listed", "empty", "unknown"]);
    expect(Object.keys(features.byScopePatterns)).toEqual(["one-pattern", "multiple-patterns", "empty", "unknown"]);
    expect(Object.keys(features.byBodySize)).toEqual(["up-to-1k", "1k-to-4k", "over-4k", "unknown"]);
    for (const buckets of [features.byCheckPlan, features.byContext, features.byScopePatterns, features.byBodySize])
      for (const bucket of Object.values(buckets))
        expect(bucket).toEqual({ total: 0, accepted: 0, rejected: 0, undecided: 0,
          acceptance: { numerator: 0, denominator: 0, percent: null } });
  });
  it("places every ordinary outcome once in each dimension and excludes qualification", () => {
    const accepted = task("accepted");
    const rejected = task("rejected", "rejected");
    rejected.task.spec = { ...rejected.task.spec, checks: [], no_checks_justification: "Owner explanation", context: [], scope: ["src/a", "src/b"], body: "x".repeat(1025) };
    const held = task("held", "held");
    held.task.spec = { ...held.task.spec, checks: [], context: [], scope: [], body: "x".repeat(4097) };
    const legacy = task("legacy", "abandoned");
    delete legacy.task.origin;
    (legacy.task.spec as unknown as Record<string, unknown>).body = null;
    const qualification = task("qualification");
    qualification.task.origin = "qualification";
    const data = snapshot([accepted, rejected, held, legacy, qualification]);
    const before = JSON.stringify(data);
    const result = buildScorecard(data);
    expect(result.qualificationExcluded).toBe(1);
    expect(result.taskSpecs.byCheckPlan.checks).toMatchObject({ total: 1, accepted: 1 });
    expect(result.taskSpecs.byCheckPlan["justified-no-checks"]).toMatchObject({ total: 1, rejected: 1 });
    expect(result.taskSpecs.byCheckPlan["missing-checks"]).toMatchObject({ total: 1, undecided: 1 });
    expect(result.taskSpecs.byContext.empty.total).toBe(2);
    expect(result.taskSpecs.byScopePatterns["one-pattern"].total).toBe(1);
    expect(result.taskSpecs.byScopePatterns["multiple-patterns"].total).toBe(1);
    expect(result.taskSpecs.byScopePatterns.empty.total).toBe(1);
    expect(result.taskSpecs.byBodySize["up-to-1k"].total).toBe(1);
    expect(result.taskSpecs.byBodySize["1k-to-4k"].total).toBe(1);
    expect(result.taskSpecs.byBodySize["over-4k"].total).toBe(1);
    for (const buckets of [result.taskSpecs.byCheckPlan, result.taskSpecs.byContext,
      result.taskSpecs.byScopePatterns, result.taskSpecs.byBodySize]) {
      expect(buckets.unknown).toMatchObject({ total: 1, accepted: 0, rejected: 0, undecided: 1 });
      const total = Object.values(buckets).reduce((sum, bucket) => sum + bucket.total, 0);
      expect(total).toBe(4);
    }
    expect(JSON.stringify(data)).toBe(before);
  });
  it.each([
    ["x".repeat(1024), "up-to-1k"], ["x".repeat(1025), "1k-to-4k"],
    ["x".repeat(4096), "1k-to-4k"], ["x".repeat(4097), "over-4k"],
    ["🙂".repeat(256), "up-to-1k"], ["🙂".repeat(257), "1k-to-4k"],
    ["🙂".repeat(1024), "1k-to-4k"], ["🙂".repeat(1025), "over-4k"],
  ] as const)("uses inclusive UTF-8 body bucket boundaries (%#)", (body, bucket) => {
    const detail = task("boundary");
    detail.task.spec.body = body;
    expect(buildScorecard(snapshot([detail])).taskSpecs.byBodySize[bucket].total).toBe(1);
  });
  it("uses owner-decided bucket denominators, preserves legacy decisions and suppresses small-sample percentages", () => {
    const tasks = Array.from({ length: 19 }, (_, index) => task(`accepted-${index}`));
    tasks.push(task("rejected", "rejected"));
    tasks.push(...Array.from({ length: 30 }, (_, index) => task(`held-${index}`, "held")));
    const data = snapshot(tasks);
    data.decisions = [];
    const bucket = buildScorecard(data).taskSpecs.byCheckPlan.checks;
    expect(bucket).toEqual({ total: 50, accepted: 19, rejected: 1, undecided: 30,
      acceptance: { numerator: 19, denominator: 20, percent: 95 } });
    tasks[19]!.task.state = "held";
    expect(buildScorecard(data).taskSpecs.byCheckPlan.checks.acceptance).toEqual({ numerator: 19, denominator: 19, percent: null });
  });
  it("counts declarations independently of actual attempts or changed files and states measurement limits", () => {
    const detail = task("declarations");
    detail.task.spec.no_checks_justification = "An extra explanation does not replace declared checks";
    detail.task.spec.scope = ["**/*"];
    detail.task.raw = "raw markdown ".repeat(1000);
    detail.attempts = [attempt("declarations", 1, { verification: {
      passed: true, changedPaths: ["a", "b", "c"], flags: [], checks: [],
    } })];
    const result = buildScorecard(snapshot([detail]));
    expect(result.taskSpecs.byScopePatterns["one-pattern"].total).toBe(1);
    expect(result.taskSpecs.byCheckPlan.checks.total).toBe(1);
    expect(result.taskSpecs.byCheckPlan["justified-no-checks"].total).toBe(0);
    expect(result.taskSpecs.byBodySize["up-to-1k"].total).toBe(1);
    const formatted = formatReport(result);
    expect(formatted).toContain("declared-only");
    expect(formatted).toContain("do not establish quality, changed-file size, causality or eligibility");
    expect(formatted).toContain("Scope patterns:");
    expect(formatted).not.toContain(detail.task.raw);
  });
  it("uses owner-decided denominators and retains held/failed/abandoned outcomes", () => {
    const result = buildScorecard(
      snapshot([
        task("a"),
        task("r", "rejected"),
        task("held", "held"),
        task("failed", "failed"),
        task("abandoned", "abandoned"),
      ]),
    );
    expect(result.tasks).toMatchObject({
      total: 5,
      accepted: 1,
      rejected: 1,
      undecided: 3,
      acceptance: { numerator: 1, denominator: 2, percent: null },
    });
    expect(result.tasks.states).toMatchObject({
      held: 1,
      failed: 1,
      abandoned: 1,
    });
    expect(formatReport(result)).not.toContain("%");
  });
  it("shows percentages only with at least20 decided/audited outcomes", () => {
    const nineteen = buildScorecard(
      snapshot(Array.from({ length: 19 }, (_, i) => task(String(i)))),
    );
    expect(nineteen.tasks.acceptance.percent).toBeNull();
    const twenty = buildScorecard(
      snapshot(Array.from({ length: 20 }, (_, i) => task(String(i)))),
    );
    expect(twenty.tasks.acceptance.percent).toBe(100);
    expect(formatReport(twenty)).toContain("100.0%");
  });
  it("excludes qualification in every denominator and usage/timing/audit aggregate", () => {
    const ordinary = task("ordinary");
    ordinary.attempts = [attempt("ordinary")];
    const qualification = task("qualification");
    qualification.task.origin = "qualification";
    qualification.attempts = [
      attempt("qualification", 2, {
        usage: { inputTokens: 999, costUsd: 999 },
        kind: "repair",
      }),
    ];
    const data = snapshot([ordinary, qualification]);
    data.audits = [audit("qualification", 1, "completed", "reject")];
    data.planning = [
      {
        id: 1,
        taskId: "qualification",
        usage: { inputTokens: 999 },
        createdAt: time(0),
      },
    ];
    const result = buildScorecard(data);
    expect(result.qualificationExcluded).toBe(1);
    expect(result.tasks.accepted).toBe(1);
    expect(result.attempts.total).toBe(1);
    expect(result.usage.worker.inputTokens.total).toBe(0);
    expect(result.audits.selected).toBe(0);
    expect(result.usage.planning.records).toBe(1);
  });
  it("records legacy readiness/decisions and missing usage as unknown rather than zero", () => {
    const legacy = task("legacy");
    delete legacy.task.origin;
    delete legacy.task.readyAt;
    delete legacy.task.completedWhileFrontierOff;
    legacy.attempts = [attempt("legacy")];
    const data = snapshot([legacy]);
    data.decisions = [];
    const result = buildScorecard(data);
    expect(result.tasks.accepted).toBe(1);
    expect(result.tasks.legacyDecisions).toBe(1);
    expect(result.tasks.acceptedWhileFrontierOff).toEqual({
      yes: 0,
      no: 0,
      unknown: 1,
    });
    expect(result.timing.readiness).toMatchObject({ known: 0, missing: 1 });
    expect(result.ownerMinutes).toEqual({ known: 0, missing: 1, total: 0 });
    expect(result.usage.worker.inputTokens).toEqual({
      total: 0,
      known: 0,
      missing: 1,
      perAcceptedReported: null,
    });
  });
  it("distinguishes zero reported usage, partial field coverage, and optional planning", () => {
    const a = task("a");
    a.attempts = [
      attempt("a", 1, { usage: { inputTokens: 0, costUsd: 0 } }),
      attempt("a", 2, { usage: { outputTokens: 20 } }),
    ];
    const b = task("b", "held");
    b.attempts = [attempt("b", 3)];
    const data = snapshot([a, b]);
    data.planning = [
      {
        id: 1,
        taskId: "a",
        usage: { inputTokens: 40, costUsd: 0.2 },
        createdAt: time(0),
      },
    ];
    const result = buildScorecard(data);
    expect(result.usage.worker.inputTokens).toEqual({
      total: 0,
      known: 1,
      missing: 2,
      perAcceptedReported: 0,
    });
    expect(result.usage.worker.outputTokens).toEqual({
      total: 20,
      known: 1,
      missing: 2,
      perAcceptedReported: 20,
    });
    expect(result.usage.planning.inputTokens).toMatchObject({
      total: 40,
      known: 1,
      missing: 1,
      perAcceptedReported: 40,
    });
    expect(result.usage.worker.tasksMissingUsage).toBe(1);
    expect(formatReport(result)).toContain("reported partial totals");
  });
  it("does not count transport repair attempts or frontier requests as completed repair/escalation work", () => {
    const a = task("a");
    a.attempts = [
      attempt("a", 1),
      attempt("a", 2, { kind: "repair", outcome: "transport_error" }),
      attempt("a", 3, { kind: "repair" }),
    ];
    const held = task("held", "held");
    held.task.nextAction = "frontier-worker";
    const result = buildScorecard(snapshot([a, held]));
    expect(result.attempts).toMatchObject({
      total: 3,
      transportFailures: 1,
      transportRetries: 1,
      repairExecutions: 1,
      tasksRepaired: 1,
      escalationExecutions: 0,
      tasksEscalated: 0,
      awaitingFrontierWorker: 1,
      repairRate: { numerator: 1, denominator: 1, percent: null },
    });
  });
  it("keeps role-tagged escalation/review/audit usage separate without counting pending audits as executions", () => {
    const a = task("a");
    a.attempts = [
      attempt("a", 1, { kind: "frontier", usage: { inputTokens: 100 } }),
    ];
    a.reviews = [
      {
        id: 1,
        taskId: "a",
        attemptId: 1,
        tier: "frontier",
        source: "owner-session",
        profileId: null,
        model: null,
        resultSha: "b".repeat(40),
        outcome: "completed",
        report: null,
        usage: { inputTokens: 30 },
        logPath: null,
        startedAt: time(5),
        endedAt: time(6),
        reason: null,
      },
    ];
    const data = snapshot([a]);
    data.audits = [audit("a", 1, "pending")];
    const result = buildScorecard(data);
    expect(result.usage.worker.records).toBe(0);
    expect(result.usage.escalation.inputTokens.total).toBe(100);
    expect(result.usage.review.inputTokens.total).toBe(30);
    expect(result.usage.audit.records).toBe(0);
    expect(result.audits.pending).toBe(1);
  });
  it("counts blocking audit misses and samples by class/tier while accept warnings are not misses", () => {
    const data = snapshot([task("a"), task("b"), task("c"), task("d")]);
    data.audits = [
      audit("a", 1, "completed"),
      audit("b", 2, "completed", "needs-repair"),
      audit("c", 3, "completed", "reject"),
      audit("d", 4, "pending"),
    ];
    const result = buildScorecard(data);
    expect(result.audits).toMatchObject({
      selected: 4,
      completed: 3,
      misses: 2,
      pending: 1,
      missRate: { numerator: 2, denominator: 3, percent: null },
    });
    expect(result.audits.byClassTier["small-fix/local"]?.misses).toBe(2);
  });
  it("separates owner-reported frontier usage from local worker/review totals and retains partial coverage", () => {
    const a = task("a");
    a.attempts = [
      attempt("a", 1, { usage: { inputTokens: 400 } }),
      attempt("a", 2, { kind: "frontier", usage: { inputTokens: 100 } }),
    ];
    const review = {
      id: 1,
      taskId: "a",
      attemptId: 1,
      tier: "local" as const,
      source: "service-local" as const,
      profileId: "private",
      model: null,
      resultSha: "b".repeat(40),
      outcome: "completed" as const,
      report: null,
      usage: { inputTokens: 900 },
      logPath: null,
      startedAt: time(5),
      endedAt: time(6),
      reason: null,
    };
    a.reviews = [
      review,
      {
        ...review,
        id: 2,
        tier: "frontier",
        source: "owner-session",
        usage: { inputTokens: 30 },
      },
      {
        ...review,
        id: 3,
        tier: "frontier",
        source: "owner-session",
        usage: null,
      },
    ];
    const result = buildScorecard(snapshot([a]));
    expect(result.usage.review.inputTokens.total).toBe(930);
    expect(result.frontierUsage.review.inputTokens).toEqual({
      total: 30,
      known: 1,
      missing: 1,
      perAcceptedReported: 30,
    });
    expect(result.frontierUsage.escalation.inputTokens.total).toBe(100);
    expect(Object.keys(result.frontierUsage)).not.toContain("worker");
    expect(formatReport(result)).toContain("local review usage is excluded");
  });
  it("summarizes observed phase timing without subtracting checks from unknown worker durations", () => {
    const a = task("a");
    a.attempts = [
      attempt("a", 1, {
        verification: {
          passed: true,
          resultSha: "b".repeat(40),
          changedPaths: [],
          flags: [],
          checks: [
            {
              command: "private",
              exitCode: 0,
              timedOut: false,
              durationMs: 100,
              logPath: "/private/log",
            },
          ],
        },
      }),
    ];
    a.events = [
      {
        id: 1,
        taskId: "a",
        type: "state_changed",
        payload: { to: "verifying" },
        createdAt: time(3),
      },
    ];
    const result = buildScorecard(snapshot([a]));
    expect(result.timing.queue.totalMs).toBe(1000);
    expect(result.timing.worker.totalMs).toBe(2000);
    expect(result.timing.verification.totalMs).toBe(2000);
    expect(result.timing.checks.totalMs).toBe(100);
    a.events = [];
    expect(buildScorecard(snapshot([a])).timing.worker).toMatchObject({
      known: 0,
      missing: 1,
    });
  });
  it("groups private report classes/profiles accurately and handles no accepted denominator", () => {
    const a = task("a", "held");
    a.attempts = [attempt("a", 1, { usage: { inputTokens: 10 } })];
    const result = buildScorecard(snapshot([a]));
    expect(result.tasks.byProfile["profile-private"]?.undecided).toBe(1);
    expect(result.tasks.byClass["small-fix"]?.total).toBe(1);
    expect(result.usage.worker.inputTokens.perAcceptedReported).toBeNull();
  });
});
