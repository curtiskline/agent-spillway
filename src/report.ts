import {
  TASK_STATES,
  type ReportSnapshot,
  type TaskDetail,
  type TaskState,
  type Usage,
} from "./contracts.js";

export interface Ratio {
  numerator: number;
  denominator: number;
  percent: number | null;
}
export interface OutcomeCounts {
  total: number;
  accepted: number;
  rejected: number;
  undecided: number;
}
export interface DurationSummary {
  known: number;
  missing: number;
  totalMs: number;
  meanMs: number | null;
}
export interface UsageField {
  total: number;
  known: number;
  missing: number;
  perAcceptedReported: number | null;
}
export interface RoleUsage {
  records: number;
  tasksWithReportedUsage: number;
  tasksMissingUsage: number;
  inputTokens: UsageField;
  outputTokens: UsageField;
  costUsd: UsageField;
}
export interface AuditCounts {
  selected: number;
  completed: number;
  misses: number;
  pending: number;
  unknownReports: number;
  missRate: Ratio;
}
/** Private service scorecard. Field totals are reported observations, never estimates.
 * Acceptance denominator is owner-decided tasks; repair denominator is tasks with
 * a non-transport local attempt. Phase timing overlaps: checks are included within
 * verification. Audit timing is request-to-submission turnaround, not model time.
 * Unknown legacy phase/readiness data is counted as missing.
 */
export interface Scorecard {
  version: 1;
  generatedAt: string;
  qualificationExcluded: number;
  tasks: OutcomeCounts & {
    states: Record<TaskState, number>;
    byClass: Record<string, OutcomeCounts>;
    byProfile: Record<string, OutcomeCounts>;
    acceptance: Ratio;
    recordedDecisions: number;
    legacyDecisions: number;
    acceptedWhileFrontierOff: { yes: number; no: number; unknown: number };
  };
  attempts: {
    total: number;
    coding: number;
    transportFailures: number;
    transportRetries: number;
    repairExecutions: number;
    tasksRepaired: number;
    escalationExecutions: number;
    tasksEscalated: number;
    awaitingFrontierWorker: number;
    repairRate: Ratio;
  };
  timing: Record<
    | "queue"
    | "worker"
    | "verification"
    | "checks"
    | "review"
    | "audit"
    | "readiness",
    DurationSummary
  >;
  ownerMinutes: { known: number; missing: number; total: number };
  audits: AuditCounts & { byClassTier: Record<string, AuditCounts> };
  usage: Record<
    "planning" | "worker" | "review" | "escalation" | "audit",
    RoleUsage
  >;
  frontierUsage: Record<
    "planning" | "review" | "escalation" | "audit",
    RoleUsage
  >;
}
const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const ratio = (numerator: number, denominator: number): Ratio => ({
  numerator,
  denominator,
  percent: denominator >= 20 ? (100 * numerator) / denominator : null,
});
function outcomes(tasks: TaskDetail[]): OutcomeCounts {
  const accepted = tasks.filter((t) => t.task.state === "accepted").length;
  const rejected = tasks.filter((t) => t.task.state === "rejected").length;
  return {
    total: tasks.length,
    accepted,
    rejected,
    undecided: tasks.length - accepted - rejected,
  };
}
function groups(
  tasks: TaskDetail[],
  key: (task: TaskDetail) => string,
): Record<string, OutcomeCounts> {
  const grouped = new Map<string, TaskDetail[]>();
  for (const task of tasks) {
    const id = key(task);
    const list = grouped.get(id) ?? [];
    list.push(task);
    grouped.set(id, list);
  }
  return Object.fromEntries(
    [...grouped].map(([id, list]) => [id, outcomes(list)]),
  );
}
function elapsed(
  start: string | undefined | null,
  end: string | undefined | null,
): number | null {
  if (!start || !end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return number(ms) ? ms : null;
}
function durations(values: (number | null)[]): DurationSummary {
  const known = values.filter(number);
  const totalMs = known.reduce((a, b) => a + b, 0);
  return {
    known: known.length,
    missing: values.length - known.length,
    totalMs,
    meanMs: known.length ? totalMs / known.length : null,
  };
}
function usage(
  rows: { taskId: string; usage: Usage | null }[],
  accepted: number,
): RoleUsage {
  const tasks = new Map<string, boolean>();
  for (const row of rows)
    tasks.set(
      row.taskId,
      (tasks.get(row.taskId) ?? false) ||
        (!!row.usage && Object.values(row.usage).some(number)),
    );
  const field = (key: keyof Usage): UsageField => {
    const known = rows.map((row) => row.usage?.[key]).filter(number);
    const total = known.reduce((a, b) => a + b, 0);
    return {
      total,
      known: known.length,
      missing: rows.length - known.length,
      perAcceptedReported: accepted && known.length ? total / accepted : null,
    };
  };
  return {
    records: rows.length,
    tasksWithReportedUsage: [...tasks.values()].filter(Boolean).length,
    tasksMissingUsage: [...tasks.values()].filter((v) => !v).length,
    inputTokens: field("inputTokens"),
    outputTokens: field("outputTokens"),
    costUsd: field("costUsd"),
  };
}
function auditCounts(audits: ReportSnapshot["audits"]): AuditCounts {
  const completed = audits.filter(
    (a) =>
      a.status === "completed" &&
      a.report?.resultSha === a.resultSha &&
      ["accept", "needs-repair", "reject"].includes(a.report.verdict),
  );
  const misses = completed.filter((a) => a.report?.verdict !== "accept").length;
  return {
    selected: audits.length,
    completed: completed.length,
    misses,
    pending: audits.filter((a) => a.status === "pending").length,
    unknownReports:
      audits.filter((a) => a.status === "completed").length - completed.length,
    missRate: ratio(misses, completed.length),
  };
}
export function buildScorecard(snapshot: ReportSnapshot): Scorecard {
  const tasks = snapshot.tasks.filter((t) => t.task.origin !== "qualification");
  const ids = new Set(tasks.map((t) => t.task.id));
  const totals = outcomes(tasks);
  const decisions = snapshot.decisions.filter((d) => ids.has(d.taskId));
  const decidedIds = new Set(decisions.map((d) => d.taskId));
  const audits = snapshot.audits.filter((a) => ids.has(a.taskId));
  const planning = snapshot.planning.filter((p) => ids.has(p.taskId));
  const all = tasks.flatMap((t) => t.attempts);
  const reviews = tasks.flatMap((t) => t.reviews ?? []);
  const local = all.filter(
    (a) => a.kind !== "frontier" && a.outcome !== "transport_error",
  );
  const repaired = new Set(
    local.filter((a) => a.kind === "repair").map((a) => a.taskId),
  );
  const localTasks = new Set(local.map((a) => a.taskId));
  const queue: (number | null)[] = [];
  const worker: (number | null)[] = [];
  const verification: (number | null)[] = [];
  for (const detail of tasks) {
    queue.push(elapsed(detail.task.createdAt, detail.attempts[0]?.startedAt));
    for (const attempt of detail.attempts) {
      const start = Date.parse(attempt.startedAt);
      const end = attempt.endedAt ? Date.parse(attempt.endedAt) : Infinity;
      const events = detail.events.filter(
        (e) =>
          e.type === "state_changed" &&
          e.payload !== null &&
          typeof e.payload === "object" &&
          "to" in e.payload &&
          e.payload.to === "verifying",
      );
      const matching = events.filter(
        (e) =>
          e.type === "state_changed" &&
          e.payload !== null &&
          typeof e.payload === "object" &&
          "to" in e.payload &&
          e.payload.to === "verifying" &&
          Date.parse(e.createdAt) >= start &&
          Date.parse(e.createdAt) <= end,
      );
      // Equal timestamp boundaries can overlap two attempts; do not reuse one
      // transition as evidence for both phases when legacy order is ambiguous.
      const transition =
        matching.length === 1 &&
        detail.attempts.filter(
          (other) =>
            Date.parse(other.startedAt) <= Date.parse(matching[0]!.createdAt) &&
            (!other.endedAt ||
              Date.parse(other.endedAt) >= Date.parse(matching[0]!.createdAt)),
        ).length === 1
          ? matching[0]
          : undefined;
      worker.push(
        transition
          ? elapsed(attempt.startedAt, transition.createdAt)
          : attempt.verification
            ? null
            : elapsed(attempt.startedAt, attempt.endedAt),
      );
      if (attempt.verification)
        verification.push(elapsed(transition?.createdAt, attempt.endedAt));
    }
  }
  const auditGroups = new Map<string, ReportSnapshot["audits"]>();
  const taskById = new Map(tasks.map((t) => [t.task.id, t.task]));
  for (const audit of audits) {
    const key = `${taskById.get(audit.taskId)!.spec.class}/${audit.reviewTier}`;
    const rows = auditGroups.get(key) ?? [];
    rows.push(audit);
    auditGroups.set(key, rows);
  }
  const planningRows = planning.map((p) => ({
    taskId: p.taskId,
    usage: p.usage as Usage | null,
  }));
  for (const task of tasks)
    if (!planning.some((p) => p.taskId === task.task.id))
      planningRows.push({ taskId: task.task.id, usage: null });
  const acceptedOff = { yes: 0, no: 0, unknown: 0 };
  for (const t of tasks.filter((t) => t.task.state === "accepted")) {
    const off = t.task.completedWhileFrontierOff;
    acceptedOff[off === true ? "yes" : off === false ? "no" : "unknown"]++;
  }
  const owner = decisions.map((d) => d.ownerMinutes).filter(number);
  const states = Object.fromEntries(
    TASK_STATES.map((state) => [
      state,
      tasks.filter((t) => t.task.state === state).length,
    ]),
  ) as Record<TaskState, number>;
  return {
    version: 1,
    generatedAt: snapshot.generatedAt,
    qualificationExcluded: snapshot.tasks.length - tasks.length,
    tasks: {
      ...totals,
      states,
      byClass: groups(tasks, (t) => t.task.spec.class),
      byProfile: groups(tasks, (t) => t.task.profileId),
      acceptance: ratio(totals.accepted, totals.accepted + totals.rejected),
      recordedDecisions: decidedIds.size,
      legacyDecisions: tasks.filter(
        (t) =>
          ["accepted", "rejected"].includes(t.task.state) &&
          !decidedIds.has(t.task.id),
      ).length,
      acceptedWhileFrontierOff: acceptedOff,
    },
    attempts: {
      total: all.length,
      coding: all.filter((a) => a.outcome !== "transport_error").length,
      transportFailures: all.filter((a) => a.outcome === "transport_error")
        .length,
      transportRetries: tasks.reduce(
        (n, t) =>
          n +
          t.attempts.filter(
            (a, i) =>
              i > 0 &&
              a.kind !== "frontier" &&
              t.attempts[i - 1]?.outcome === "transport_error",
          ).length,
        0,
      ),
      repairExecutions: local.filter((a) => a.kind === "repair").length,
      tasksRepaired: repaired.size,
      escalationExecutions: all.filter((a) => a.kind === "frontier").length,
      tasksEscalated: new Set(
        all.filter((a) => a.kind === "frontier").map((a) => a.taskId),
      ).size,
      awaitingFrontierWorker: tasks.filter(
        (t) => t.task.nextAction === "frontier-worker",
      ).length,
      repairRate: ratio(repaired.size, localTasks.size),
    },
    timing: {
      queue: durations(queue),
      worker: durations(worker),
      verification: durations(verification),
      checks: durations(
        all.flatMap(
          (a) =>
            a.verification?.checks.map((c) =>
              number(c.durationMs) ? c.durationMs : null,
            ) ?? [],
        ),
      ),
      review: durations(reviews.map((r) => elapsed(r.startedAt, r.endedAt))),
      audit: durations(
        audits
          .filter((a) => a.status === "completed")
          .map((a) => elapsed(a.createdAt, a.completedAt)),
      ),
      readiness: durations(
        tasks
          .filter(
            (t) =>
              t.task.readyAt ||
              ["ready", "accepted", "rejected"].includes(t.task.state),
          )
          .map((t) => elapsed(t.task.createdAt, t.task.readyAt)),
      ),
    },
    ownerMinutes: {
      known: owner.length,
      missing: totals.accepted + totals.rejected - owner.length,
      total: owner.reduce((a, b) => a + b, 0),
    },
    audits: {
      ...auditCounts(audits),
      byClassTier: Object.fromEntries(
        [...auditGroups].map(([key, rows]) => [key, auditCounts(rows)]),
      ),
    },
    frontierUsage: {
      planning: usage(planningRows, totals.accepted),
      review: usage(
        reviews
          .filter((r) => r.tier === "frontier")
          .map((r) => ({ taskId: r.taskId, usage: r.usage })),
        totals.accepted,
      ),
      escalation: usage(
        all
          .filter((a) => a.kind === "frontier")
          .map((a) => ({ taskId: a.taskId, usage: a.usage })),
        totals.accepted,
      ),
      audit: usage(
        audits
          .filter((a) => a.status === "completed")
          .map((a) => ({ taskId: a.taskId, usage: a.usage })),
        totals.accepted,
      ),
    },
    usage: {
      planning: usage(planningRows, totals.accepted),
      worker: usage(
        all
          .filter((a) => a.kind !== "frontier")
          .map((a) => ({ taskId: a.taskId, usage: a.usage })),
        totals.accepted,
      ),
      review: usage(
        reviews.map((r) => ({ taskId: r.taskId, usage: r.usage })),
        totals.accepted,
      ),
      escalation: usage(
        all
          .filter((a) => a.kind === "frontier")
          .map((a) => ({ taskId: a.taskId, usage: a.usage })),
        totals.accepted,
      ),
      audit: usage(
        audits
          .filter((a) => a.status === "completed")
          .map((a) => ({ taskId: a.taskId, usage: a.usage })),
        totals.accepted,
      ),
    },
  };
}
export function formatReport(scorecard: Scorecard): string {
  const fraction = (value: Ratio) =>
    `${value.numerator}/${value.denominator}${value.percent === null ? "" : ` (${value.percent.toFixed(1)}%)`}`;
  const lines = [
    `Ordinary tasks: ${scorecard.tasks.total}; accepted ${scorecard.tasks.accepted}, rejected ${scorecard.tasks.rejected}, undecided ${scorecard.tasks.undecided}.`,
    `Owner acceptance: ${fraction(scorecard.tasks.acceptance)} decided tasks. Qualification excluded: ${scorecard.qualificationExcluded}.`,
    `Accepted while frontier off: ${scorecard.tasks.acceptedWhileFrontierOff.yes}; on ${scorecard.tasks.acceptedWhileFrontierOff.no}; unknown ${scorecard.tasks.acceptedWhileFrontierOff.unknown}.`,
    `Repairs: ${fraction(scorecard.attempts.repairRate)} tasks with local coding attempts; transport failures ${scorecard.attempts.transportFailures}.`,
    `Audits: ${scorecard.audits.completed}/${scorecard.audits.selected} completed, ${scorecard.audits.pending} pending; misses ${fraction(scorecard.audits.missRate)}.`,
    `Owner minutes: ${scorecard.ownerMinutes.total} reported; ${scorecard.ownerMinutes.missing} missing.`,
  ];
  for (const [kind, groups] of [
    ["Class", scorecard.tasks.byClass],
    ["Profile", scorecard.tasks.byProfile],
  ] as const)
    for (const [name, counts] of Object.entries(groups))
      lines.push(
        `${kind} ${name}: ${counts.accepted} accepted, ${counts.rejected} rejected, ${counts.undecided} undecided (${counts.total} total).`,
      );
  for (const [phase, timing] of Object.entries(scorecard.timing))
    lines.push(
      `${phase} timing: ${timing.totalMs} ms observed; ${timing.known} known/${timing.missing} missing.`,
    );
  for (const [role, data] of Object.entries(scorecard.usage)) {
    lines.push(
      `${role}: ${data.inputTokens.total} reported input tokens (${data.inputTokens.known} known/${data.inputTokens.missing} missing), ${data.outputTokens.total} reported output tokens (${data.outputTokens.known} known/${data.outputTokens.missing} missing), $${data.costUsd.total} reported (${data.costUsd.known} known/${data.costUsd.missing} missing).`,
    );
    lines.push(
      `${role} per accepted task, reported partial: input ${data.inputTokens.perAcceptedReported ?? "unknown"}, output ${data.outputTokens.perAcceptedReported ?? "unknown"}, cost ${data.costUsd.perAcceptedReported ?? "unknown"}.`,
    );
  }
  lines.push(
    "Frontier role usage is owner-reported; local review usage is excluded.",
  );
  for (const [role, data] of Object.entries(scorecard.frontierUsage))
    lines.push(
      `frontier ${role}: reported partial per accepted task input ${data.inputTokens.perAcceptedReported ?? "unknown"} (${data.inputTokens.known} known/${data.inputTokens.missing} missing), output ${data.outputTokens.perAcceptedReported ?? "unknown"} (${data.outputTokens.known} known/${data.outputTokens.missing} missing), cost ${data.costUsd.perAcceptedReported ?? "unknown"} (${data.costUsd.known} known/${data.costUsd.missing} missing).`,
    );
  lines.push(
    "Per-accepted values use reported partial totals only. Missing values are not zero; no quota-savings baseline is available.",
  );
  return lines.join("\n") + "\n";
}
