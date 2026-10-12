import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import {
  mkdirSync,
  chmodSync,
  realpathSync,
  existsSync,
  statSync,
  lstatSync,
} from "node:fs";
import { dirname, resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { identifier, relativePath } from "./task.js";
import {
  TASK_STATES,
  SpillwayError,
  type TaskSpec,
  type TaskState,
  type ReviewTier,
  type TaskRecord,
  type AttemptRecord,
  type NewAttempt,
  type AttemptPatch,
  type EventRecord,
  type NextAction, type NewReview, type ReviewPatch, type ReviewRecord, type FrontierState,
} from "./contracts.js";

const transitions: Record<TaskState, readonly TaskState[]> = {
  queued: ["dispatched", "held", "failed", "abandoned", "escalated"],
  dispatched: ["verifying", "queued", "held", "failed", "abandoned", "escalated"],
  verifying: [
    "reviewing",
    "ready",
    "needs-repair",
    "escalated",
    "held",
    "failed",
  ],
  reviewing: ["ready", "needs-repair", "escalated", "held", "failed", "queued", "rejected"],
  ready: ["accepted", "rejected", "held"],
  "needs-repair": ["queued", "held", "escalated", "abandoned"],
  escalated: ["queued", "held", "dispatched", "abandoned"],
  held: ["queued", "verifying", "reviewing", "dispatched", "escalated", "rejected", "abandoned"],
  failed: ["rejected", "abandoned"],
  abandoned: [],
  accepted: [],
  rejected: [],
};
const tiers = z.enum(["checks-only", "local", "frontier"]);
const outcomes = z.enum([
  "running",
  "completed",
  "failed",
  "timeout",
  "transport_error",
  "uncertain",
]);
const verification = z
  .object({
    passed: z.boolean(),
    reason: z.string().optional(),
    resultSha: z.string().optional(),
    changedPaths: z.array(z.string()),
    flags: z.array(z.string()),
    checks: z.array(
      z
        .object({
          command: z.string(),
          exitCode: z.number().int().nullable(),
          timedOut: z.boolean(),
          durationMs: z.number().nonnegative(),
          logPath: z.string(),
        })
        .strict(),
    ),
    diffPath: z.string().optional(),
  })
  .strict();
const patchSchema = z
  .object({
    worktree: z.string().optional(),
    outcome: outcomes.optional(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        costUsd: z.number().nonnegative().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    summary: z.string().nullable().optional(),
    endedAt: z.string().datetime().nullable().optional(),
    resultSha: z.string().nullable().optional(),
    verification: verification.nullable().optional(),
    reportPath: z.string().nullable().optional(),
    logPath: z.string().optional(),
  })
  .strict();
const attemptSchema = z
  .object({
    taskId: identifier,
    endpoint: identifier,
    profileId: identifier,
    model: z.string().min(1),
    modelArtifact: z.string().min(1),
    harness: z.string().min(1),
    harnessVersion: z.string().min(1),
    baseSha: z.string().regex(/^[0-9a-f]{40,64}$/),
    branch: z.string().min(1),
    worktree: z.string(),
    logPath: z.string(),
    kind: z.enum(['worker', 'repair', 'frontier']).optional(),
    parentAttemptId: z.number().int().positive().optional(),
  })
  .strict();

const nextActions = z.enum(['worker', 'repair', 'review', 'frontier-worker']);
const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const reportSchema = z.object({ resultSha: sha, verdict: z.enum(['accept', 'needs-repair', 'reject']),
  findings: z.array(z.object({ severity: z.enum(['blocking','warning']), message: z.string().trim().min(1).max(4000), path: relativePath.optional() }).strict()).max(50),
}).strict().refine(report => report.verdict !== 'accept' || !report.findings.some(finding => finding.severity === 'blocking'), 'An accepting review cannot contain blocking findings');
const newReviewSchema = z.object({ taskId: identifier, attemptId: z.number().int().positive(), tier: z.enum(['local','frontier']),
  source: z.enum(['service-local','owner-session']), profileId: identifier.optional(), model: z.string().min(1).max(4096).optional(), resultSha: sha, logPath: z.string().optional(),
}).strict().refine(input => (input.source === 'owner-session') === (input.tier === 'frontier'), 'Owner sessions must provide frontier reviews; service reviews must be local');
const reviewPatchSchema = z.object({ outcome: z.enum(['completed','failed','uncertain']).optional(), report: reportSchema.nullable().optional(),
  usage: patchSchema.shape.usage, endedAt: z.string().datetime({ offset: true }).optional(), reason: z.string().nullable().optional(),
}).strict();
const frontierSchema = z.object({ available: z.boolean(), resetAt: z.string().datetime({ offset: true }).nullable(), updatedAt: z.string().datetime({ offset: true }) }).strict();

type Row = Record<string, SQLOutputValue>;
const now = (): string => new Date().toISOString();
function json<T>(value: SQLOutputValue | undefined): T {
  return JSON.parse(String(value)) as T;
}
function taskRecord(row: Row): TaskRecord {
  return {
    id: String(row.id),
    spec: json<TaskSpec>(row.spec),
    raw: String(row.raw),
    profileId: String(row.profile_id),
    reviewTier: tiers.parse(row.review_tier),
    state: z.enum(TASK_STATES).parse(row.state),
    reason: row.reason === null ? null : String(row.reason),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    nextAction: row.next_action == null ? null : nextActions.parse(row.next_action),
  };
}
function attemptRecord(row: Row): AttemptRecord {
  return {
    id: Number(row.id),
    taskId: String(row.task_id),
    endpoint: String(row.endpoint),
    profileId: String(row.profile_id),
    model: String(row.model),
    modelArtifact: String(row.model_artifact),
    harness: String(row.harness),
    harnessVersion: String(row.harness_version),
    baseSha: String(row.base_sha),
    branch: String(row.branch),
    worktree: String(row.worktree),
    startedAt: String(row.started_at),
    endedAt: row.ended_at === null ? null : String(row.ended_at),
    outcome: outcomes.parse(row.outcome),
    usage:
      row.usage === null
        ? null
        : (patchSchema.shape.usage.parse(json<unknown>(row.usage)) ?? null),
    summary: row.summary === null ? null : String(row.summary),
    logPath: String(row.log_path),
    resultSha: row.result_sha === null ? null : String(row.result_sha),
    verification:
      row.verification === null
        ? null
        : verification.parse(json<unknown>(row.verification)),
    reportPath: row.report_path === null ? null : String(row.report_path),
    kind: z.enum(['worker', 'repair', 'frontier']).parse(row.kind ?? 'worker'),
    parentAttemptId: row.parent_attempt_id == null ? null : Number(row.parent_attempt_id),
  };
}
function reviewRecord(row: Row): ReviewRecord {
  return { id: Number(row.id), taskId: String(row.task_id), attemptId: Number(row.attempt_id),
    tier: z.enum(['local','frontier']).parse(row.tier), source: z.enum(['service-local','owner-session']).parse(row.source),
    profileId: row.profile_id === null ? null : String(row.profile_id), model: row.model === null ? null : String(row.model),
    resultSha: sha.parse(row.result_sha), outcome: z.enum(['running','completed','failed','uncertain']).parse(row.outcome),
    report: row.report === null ? null : reportSchema.parse(json<unknown>(row.report)),
    usage: row.usage === null ? null : patchSchema.shape.usage.parse(json<unknown>(row.usage)) ?? null,
    logPath: row.log_path === null ? null : String(row.log_path), startedAt: String(row.started_at),
    endedAt: row.ended_at === null ? null : String(row.ended_at), reason: row.reason === null ? null : String(row.reason) };
}
function contained(path: string, root: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel))
  );
}
function canonicalFuture(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path)
    throw new SpillwayError("unsafe_data_path", "Cannot resolve data path");
  return join(canonicalFuture(parent), relative(parent, path));
}
function privateDirectory(input: string): string {
  const path = canonicalFuture(resolve(input));
  const checkout = realpathSync(
    resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  );
  if (contained(path, checkout))
    throw new SpillwayError(
      "unsafe_data_path",
      "Data must be outside the Spillway repository",
    );
  let parent = path;
  while (!existsSync(parent)) parent = dirname(parent);
  if (!statSync(parent).isDirectory())
    throw new SpillwayError(
      "unsafe_data_path",
      "Data path parent must be a directory",
    );
  let gitRoot: string | undefined;
  try {
    gitRoot = execFileSync(
      "git",
      ["-C", parent, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { PATH: process.env.PATH },
        timeout: 5000,
      },
    ).trim();
  } catch {
    /* Outside Git. */
  }
  if (gitRoot)
    throw new SpillwayError(
      "unsafe_data_path",
      "Data must be outside Git repositories",
    );
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

/** Only the controller opens the store. Each mutation and corresponding event commit together. */
export class Store {
  private readonly db: DatabaseSync;
  private inTransaction = false;
  constructor(dataDir: string) {
    const path = join(privateDirectory(dataDir), "queue.sqlite");
    if (
      existsSync(path) &&
      (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    )
      throw new SpillwayError(
        "unsafe_data_path",
        "Queue database must be a regular file",
      );
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;",
    );
    const version = Number(
      this.db.prepare("PRAGMA user_version").get()?.user_version,
    );
    if (version > 3) {
      this.db.close();
      throw new SpillwayError(
        "database_version",
        "Database schema is newer than this service",
      );
    }
    if (version === 0)
      this.transaction(() => {
        this.db.exec(`CREATE TABLE tasks (
        id TEXT PRIMARY KEY, spec TEXT NOT NULL, raw TEXT NOT NULL, profile_id TEXT NOT NULL, review_tier TEXT NOT NULL CHECK(review_tier IN ('checks-only','local','frontier')),
        state TEXT NOT NULL CHECK(state IN ('queued','dispatched','verifying','reviewing','ready','needs-repair','escalated','held','failed','abandoned','accepted','rejected')),
        reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE dependencies (task_id TEXT NOT NULL REFERENCES tasks(id), dependency_id TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY(task_id,dependency_id), CHECK(task_id <> dependency_id));
      CREATE TABLE attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), endpoint TEXT NOT NULL, profile_id TEXT NOT NULL,
        model TEXT NOT NULL, model_artifact TEXT NOT NULL, harness TEXT NOT NULL, harness_version TEXT NOT NULL, base_sha TEXT NOT NULL, branch TEXT NOT NULL,
        worktree TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, outcome TEXT NOT NULL CHECK(outcome IN ('running','completed','failed','timeout','transport_error','uncertain')),
        usage TEXT, summary TEXT, log_path TEXT NOT NULL, result_sha TEXT, verification TEXT, report_path TEXT);
      CREATE UNIQUE INDEX one_active_attempt ON attempts((1)) WHERE outcome='running';
      CREATE INDEX task_attempts ON attempts(task_id,id);
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX task_events ON events(task_id,id);
      PRAGMA user_version=1;`);
      });
    if (version < 2)
      this.transaction(() => {
        this.db.exec(
          "CREATE TABLE controller_lease (slot INTEGER PRIMARY KEY CHECK(slot=1), pid INTEGER NOT NULL, nonce TEXT NOT NULL); PRAGMA user_version=2;",
        );
      });
    if (version < 3) this.transaction(() => {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN next_action TEXT CHECK(next_action IN ('worker','repair','review','frontier-worker'));
        ALTER TABLE attempts ADD COLUMN kind TEXT NOT NULL DEFAULT 'worker' CHECK(kind IN ('worker','repair','frontier'));
        ALTER TABLE attempts ADD COLUMN parent_attempt_id INTEGER REFERENCES attempts(id);
        CREATE TABLE reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_id INTEGER NOT NULL REFERENCES attempts(id),
          tier TEXT NOT NULL CHECK(tier IN ('local','frontier')), source TEXT NOT NULL CHECK(source IN ('service-local','owner-session')),
          profile_id TEXT, model TEXT, result_sha TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('running','completed','failed','uncertain')),
          report TEXT, usage TEXT, log_path TEXT, started_at TEXT NOT NULL, ended_at TEXT, reason TEXT,
          UNIQUE(attempt_id,tier), CHECK((tier='frontier' AND source='owner-session') OR (tier='local' AND source='service-local')));
        CREATE UNIQUE INDEX one_active_review ON reviews((1)) WHERE outcome='running';
        CREATE INDEX task_reviews ON reviews(task_id,id);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE setting_events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
        UPDATE tasks SET next_action='worker' WHERE state='queued';
        UPDATE tasks SET next_action='review' WHERE state='held' AND NOT EXISTS(SELECT 1 FROM attempts u WHERE u.task_id=tasks.id AND u.outcome='uncertain')
          AND EXISTS(SELECT 1 FROM attempts a WHERE a.task_id=tasks.id AND a.id=(SELECT MAX(b.id) FROM attempts b WHERE b.task_id=tasks.id)
            AND a.outcome='completed' AND a.result_sha IS NOT NULL AND json_extract(a.verification,'$.passed')=1);
        PRAGMA user_version=3;`);
      this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('frontier', JSON.stringify({ available: false, resetAt: null, updatedAt: now() }));
    });
  }
  close(): void {
    this.db.close();
  }
  private transaction<T>(action: () => T): T {
    // Internal compound mutations share the outer transaction and its rollback.
    if (this.inTransaction) return action();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const value = action();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }
  acquireControllerLease(pid: number, nonce: string): void {
    this.transaction(() => {
      const existing = this.db
        .prepare("SELECT pid FROM controller_lease WHERE slot=1")
        .get();
      if (existing) {
        try {
          process.kill(Number(existing.pid), 0);
          throw new SpillwayError(
            "SERVICE_RUNNING",
            "A controller is already running.",
            409,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      this.db
        .prepare(
          "INSERT INTO controller_lease(slot,pid,nonce) VALUES(1,?,?) ON CONFLICT(slot) DO UPDATE SET pid=excluded.pid,nonce=excluded.nonce",
        )
        .run(pid, nonce);
    });
  }
  releaseControllerLease(nonce: string): void {
    this.db
      .prepare("DELETE FROM controller_lease WHERE slot=1 AND nonce=?")
      .run(nonce);
  }
  private requireTask(id: string): TaskRecord {
    const task = this.getTask(id);
    if (!task) throw new SpillwayError("not_found", "Task does not exist", 404);
    return task;
  }
  private event(taskId: string, type: string, payload: unknown): void {
    const value = JSON.stringify(payload);
    if (value === undefined)
      throw new SpillwayError("invalid_event", "Event payload must be JSON");
    this.db
      .prepare(
        "INSERT INTO events(task_id,type,payload,created_at) VALUES(?,?,?,?)",
      )
      .run(taskId, type, value, now());
  }
  addTask(
    spec: TaskSpec,
    raw: string,
    profileId: string,
    reviewTier: ReviewTier,
  ): TaskRecord {
    identifier.parse(spec.id);
    identifier.parse(profileId);
    tiers.parse(reviewTier);
    return this.transaction(() => {
      if (this.getTask(spec.id))
        throw new SpillwayError(
          "duplicate_task",
          "Task ID already exists",
          409,
        );
      if (
        new Set(spec.after).size !== spec.after.length ||
        spec.after.includes(spec.id)
      )
        throw new SpillwayError(
          "invalid_dependency",
          "Dependencies must be unique and acyclic",
        );
      for (const id of spec.after) {
        identifier.parse(id);
        this.requireTask(id);
      }
      // Existing-only references make cycles impossible: every edge points to an older immutable spec.
      const timestamp = now();
      this.db
        .prepare(
          "INSERT INTO tasks(id,spec,raw,profile_id,review_tier,state,created_at,updated_at,next_action) VALUES(?,?,?,?,?,?,?,?,'worker')",
        )
        .run(
          spec.id,
          JSON.stringify(spec),
          raw,
          profileId,
          reviewTier,
          "queued",
          timestamp,
          timestamp,
        );
      for (const id of spec.after)
        this.db
          .prepare(
            "INSERT INTO dependencies(task_id,dependency_id) VALUES(?,?)",
          )
          .run(spec.id, id);
      this.event(spec.id, "task_added", { profileId, reviewTier });
      return this.requireTask(spec.id);
    });
  }
  listTasks(): TaskRecord[] {
    return this.db
      .prepare("SELECT * FROM tasks ORDER BY rowid")
      .all()
      .map(taskRecord);
  }
  getTask(id: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
    return row ? taskRecord(row) : undefined;
  }
  setTaskState(id: string, state: TaskState, reason?: string): void {
    const task = this.requireTask(id);
    const action = state === 'queued' ? 'worker' : ['ready','accepted','rejected','abandoned','failed','dispatched'].includes(state) ? null : task.nextAction ?? null;
    this.setTaskAction(id,state,action,reason);
  }
  setTaskAction(id: string, state: TaskState, nextAction: NextAction | null, reason?: string, reviewTier?: ReviewTier): void {
    z.enum(TASK_STATES).parse(state); nextActions.nullable().parse(nextAction);
    this.transaction(() => {
      const task = this.requireTask(id);
      if (state !== task.state && !transitions[task.state].includes(state)) throw new SpillwayError('invalid_transition', `Cannot transition ${task.state} to ${state}`, 409);
      if (['ready','accepted','rejected','abandoned','failed','dispatched','verifying'].includes(state) && nextAction !== null) throw new SpillwayError('invalid_action', 'This task state cannot have pending execution');
      if (state === 'queued' && !['worker','repair'].includes(nextAction ?? '')) throw new SpillwayError('invalid_action', 'Queued tasks require a worker or repair action');
      if (nextAction === 'review' && !['held','reviewing'].includes(state)) throw new SpillwayError('invalid_action', 'Review action requires held or reviewing state');
      if (nextAction === 'frontier-worker' && !['held','escalated'].includes(state)) throw new SpillwayError('invalid_action', 'Frontier work requires held or escalated state');
      if (['accepted','rejected','abandoned'].includes(task.state) && (state !== task.state || nextAction !== null)) throw new SpillwayError('invalid_transition','Decided tasks are immutable',409);
      if (reviewTier) this.setTaskReview(id,reviewTier);
      this.db.prepare('UPDATE tasks SET state=?,next_action=?,reason=?,updated_at=? WHERE id=?').run(state,nextAction,reason ?? null,now(),id);
      this.event(id,'state_changed',{ from: task.state,to: state,nextAction,reason: reason ?? null });
    });
  }
  setTaskReview(id: string, tier: ReviewTier): void {
    tiers.parse(tier);
    this.transaction(() => {
      const task = this.requireTask(id);
      const rank = { "checks-only": 0, local: 1, frontier: 2 };
      if (
        rank[tier] < rank[task.reviewTier] ||
        ["accepted", "rejected", "abandoned"].includes(task.state)
      )
        throw new SpillwayError(
          "invalid_review",
          "Review requirements cannot be weakened or changed after a decision",
          409,
        );
      this.db
        .prepare("UPDATE tasks SET review_tier=?,updated_at=? WHERE id=?")
        .run(tier, now(), id);
      this.event(id, "review_changed", { tier });
    });
  }
  private assertExecutionSlot(): void {
    if (this.db.prepare("SELECT id FROM attempts WHERE outcome='running' UNION ALL SELECT id FROM reviews WHERE outcome='running'").get()) throw new SpillwayError('busy','An attempt or review is already active',409);
    if (this.hasUnresolvedExecution()) throw new SpillwayError('busy','Interrupted execution requires owner reconciliation',409);
  }
  hasUnresolvedExecution(): boolean {
    return Boolean(this.db.prepare("SELECT a.id FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE a.outcome='uncertain' AND t.state NOT IN ('abandoned','rejected','accepted') UNION ALL SELECT r.id FROM reviews r JOIN tasks t ON t.id=r.task_id WHERE r.outcome='uncertain' AND t.state NOT IN ('abandoned','rejected','accepted')").get());
  }
  createAttempt(input: NewAttempt): AttemptRecord {
    const value = attemptSchema.parse(input);
    return this.transaction(() => {
      const task = this.requireTask(value.taskId);
      const kind = value.kind ?? 'worker';
      const expectedAction = kind === 'frontier' ? 'frontier-worker' : kind === 'repair' ? 'repair' : 'worker';
      if ((kind === 'frontier' ? !['held','escalated'].includes(task.state) : task.state !== 'queued') || task.nextAction !== expectedAction) throw new SpillwayError('invalid_transition','Task is not awaiting this execution kind',409);
      this.assertExecutionSlot();
      const parent = value.parentAttemptId === undefined ? undefined : this.getAttempt(value.parentAttemptId);
      // A transport-only retry resumes the same committed source. A coding attempt
      // in between invalidates that lineage even if it produced no usable result.
      const latestCodingAttempt = this.listAttempts(task.id).findLast(attempt => attempt.outcome !== 'transport_error');
      if (kind === 'repair' && (!parent || parent.taskId !== task.id || parent.id !== latestCodingAttempt?.id || !['completed','failed'].includes(parent.outcome) || !parent.resultSha || !parent.verification || parent.baseSha !== value.baseSha)) throw new SpillwayError('invalid_attempt','Repair requires the latest committed parent attempt and original base; only intervening transport failures may be skipped');
      if (value.parentAttemptId !== undefined && (!parent || parent.taskId !== task.id || parent.outcome === 'running' || parent.outcome === 'uncertain')) throw new SpillwayError('invalid_attempt','Attempt parent must be finalized evidence from the same task');
      if (kind === 'worker' && value.parentAttemptId !== undefined) throw new SpillwayError('invalid_attempt','Initial worker cannot have a repair parent');
      const timestamp = now();
      const result = this.db.prepare(`INSERT INTO attempts(task_id,endpoint,profile_id,model,model_artifact,harness,harness_version,base_sha,branch,worktree,started_at,outcome,log_path,kind,parent_attempt_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,'running',?,?,?)`).run(value.taskId,value.endpoint,value.profileId,value.model,value.modelArtifact,value.harness,value.harnessVersion,value.baseSha,value.branch,value.worktree,timestamp,value.logPath,kind,value.parentAttemptId ?? null);
      const id = Number(result.lastInsertRowid);
      this.db.prepare("UPDATE tasks SET state='dispatched',next_action=NULL,reason=NULL,updated_at=? WHERE id=?").run(timestamp,value.taskId);
      this.event(value.taskId,'attempt_started',{ attemptId: id, kind, parentAttemptId: value.parentAttemptId ?? null });
      return this.getAttempt(id)!;
    });
  }
  getAttempt(id: number): AttemptRecord | undefined {
    const row = this.db.prepare("SELECT * FROM attempts WHERE id=?").get(id);
    return row ? attemptRecord(row) : undefined;
  }
  listAttempts(taskId: string): AttemptRecord[] {
    return this.db
      .prepare("SELECT * FROM attempts WHERE task_id=? ORDER BY id")
      .all(taskId)
      .map(attemptRecord);
  }
  updateAttempt(id: number, patch: AttemptPatch): void {
    const value = patchSchema.parse(patch);
    this.transaction(() => {
      const attempt = this.getAttempt(id);
      if (!attempt)
        throw new SpillwayError("not_found", "Attempt does not exist", 404);
      if (attempt.outcome === 'uncertain') throw new SpillwayError('immutable_attempt','Uncertain attempts cannot restart or be rewritten; reconcile after stopping execution',409);
      if (attempt.outcome !== "running")
        throw new SpillwayError(
          "immutable_attempt",
          "Finalized attempts are immutable",
          409,
        );
      const merged = { ...attempt, ...value };
      if (merged.outcome !== "running" && merged.endedAt === null)
        merged.endedAt = now();
      if (merged.outcome === "running" && merged.endedAt !== null)
        throw new SpillwayError(
          "invalid_attempt",
          "Running attempts cannot have an end time",
        );
      this.db
        .prepare(
          "UPDATE attempts SET worktree=?,outcome=?,usage=?,summary=?,ended_at=?,result_sha=?,verification=?,report_path=?,log_path=? WHERE id=?",
        )
        .run(
          merged.worktree,
          merged.outcome,
          merged.usage === null ? null : JSON.stringify(merged.usage),
          merged.summary,
          merged.endedAt,
          merged.resultSha,
          merged.verification === null
            ? null
            : JSON.stringify(merged.verification),
          merged.reportPath,
          merged.logPath,
          id,
        );
      this.event(attempt.taskId, "attempt_updated", {
        attemptId: id,
        fields: Object.keys(value),
        outcome: merged.outcome,
      });
    });
  }
  recoverInflight(): AttemptRecord[] {
    return this.transaction(() => {
      const active = this.db
        .prepare("SELECT * FROM attempts WHERE outcome='running' ORDER BY id")
        .all()
        .map(attemptRecord);
      for (const attempt of active) {
        const timestamp = now();
        this.db
          .prepare(
            "UPDATE attempts SET outcome='uncertain',ended_at=? WHERE id=?",
          )
          .run(timestamp, attempt.id);
        this.db
          .prepare(
            "UPDATE tasks SET state='held',next_action=NULL,reason='Interrupted attempt requires inspection',updated_at=? WHERE id=?",
          )
          .run(timestamp, attempt.taskId);
        this.event(attempt.taskId, "attempt_uncertain", {
          attemptId: attempt.id,
        });
      }
      const interruptedReviews = this.db.prepare("SELECT * FROM reviews WHERE outcome='running' ORDER BY id").all().map(reviewRecord);
      for (const review of interruptedReviews) {
        const timestamp = now();
        this.db.prepare("UPDATE reviews SET outcome='uncertain',ended_at=?,reason='Interrupted review requires inspection' WHERE id=?").run(timestamp,review.id);
        this.db.prepare("UPDATE tasks SET state='held',next_action=NULL,reason='Interrupted review requires inspection',updated_at=? WHERE id=?").run(timestamp,review.taskId);
        this.event(review.taskId,'review_uncertain',{ reviewId: review.id });
      }
      // Older interrupted versions may have finalized evidence before parent state.
      const stranded = this.db
        .prepare(
          "SELECT t.id FROM tasks t WHERE t.state IN ('dispatched','verifying','reviewing') AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.task_id=t.id AND a.outcome='running') AND NOT EXISTS(SELECT 1 FROM reviews r WHERE r.task_id=t.id AND r.outcome='running')",
        )
        .all();
      for (const task of stranded) {
        this.db
          .prepare(
            "UPDATE tasks SET state='held',next_action=NULL,reason='Interrupted finalization requires inspection',updated_at=? WHERE id=?",
          )
          .run(now(), String(task.id));
        this.event(String(task.id), "finalization_interrupted", {});
      }
      return this.db
        .prepare(
          "SELECT a.* FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE a.outcome='uncertain' AND t.state='held' AND a.id=(SELECT MAX(b.id) FROM attempts b WHERE b.task_id=a.task_id) ORDER BY a.id",
        )
        .all()
        .map(attemptRecord);
    });
  }
  finalizeAttempt(
    id: number,
    patch: AttemptPatch,
    state: TaskState,
    reason?: string,
    reviewTier?: ReviewTier,
    nextAction?: NextAction | null,
  ): void {
    if (!patch.outcome || patch.outcome === "running")
      throw new SpillwayError(
        "invalid_attempt",
        "Finalization requires a terminal attempt outcome",
      );
    this.transaction(() => {
      const attempt = this.getAttempt(id);
      if (!attempt)
        throw new SpillwayError("not_found", "Attempt does not exist", 404);
      this.updateAttempt(id, patch);
      const finalized = this.getAttempt(id)!;
      const action = nextAction === undefined ? state === 'queued' ? 'worker' : state === 'held' && finalized.outcome === 'completed' && finalized.verification?.passed && finalized.resultSha ? 'review' : null : nextAction;
      this.setTaskAction(attempt.taskId,state,action,reason,reviewTier);
    });
  }
  private latestVerified(taskId: string, attemptId: number, resultSha: string): AttemptRecord {
    const latest = this.listAttempts(taskId).at(-1);
    if (!latest || latest.id !== attemptId || latest.outcome !== 'completed' || !latest.verification?.passed || latest.resultSha !== resultSha || (latest.verification.resultSha !== undefined && latest.verification.resultSha !== resultSha)) {
      throw new SpillwayError('stale_review','Review must refer to the latest completed, independently verified result',409);
    }
    return latest;
  }
  createReview(input: NewReview): ReviewRecord {
    const value = newReviewSchema.parse(input);
    return this.transaction(() => {
      const task = this.requireTask(value.taskId);
      if (!['held','reviewing'].includes(task.state) || task.nextAction !== 'review') throw new SpillwayError('invalid_transition','Task is not awaiting review',409);
      if (task.reviewTier !== value.tier) throw new SpillwayError('invalid_review','Review tier must satisfy the current task requirement',409);
      this.latestVerified(task.id,value.attemptId,value.resultSha);
      this.assertExecutionSlot();
      if (this.db.prepare('SELECT id FROM reviews WHERE attempt_id=? AND tier=?').get(value.attemptId,value.tier)) throw new SpillwayError('duplicate_review','This attempt already has a review at this tier',409);
      const timestamp = now();
      const result = this.db.prepare("INSERT INTO reviews(task_id,attempt_id,tier,source,profile_id,model,result_sha,outcome,log_path,started_at) VALUES(?,?,?,?,?,?,?,'running',?,?)").run(task.id,value.attemptId,value.tier,value.source,value.profileId ?? null,value.model ?? null,value.resultSha,value.logPath ?? null,timestamp);
      const id = Number(result.lastInsertRowid);
      this.setTaskAction(task.id,'reviewing','review');
      this.event(task.id,'review_started',{ reviewId: id, attemptId: value.attemptId, tier: value.tier, source: value.source });
      return this.getReview(id)!;
    });
  }
  getReview(id: number): ReviewRecord | undefined {
    const row = this.db.prepare('SELECT * FROM reviews WHERE id=?').get(id); return row ? reviewRecord(row) : undefined;
  }
  listReviews(taskId: string): ReviewRecord[] {
    return this.db.prepare('SELECT * FROM reviews WHERE task_id=? ORDER BY id').all(taskId).map(reviewRecord);
  }
  finishReview(id: number, patch: ReviewPatch, state: TaskState, nextAction: NextAction | null, reason?: string): void {
    const value = reviewPatchSchema.parse(patch);
    if (!value.outcome) throw new SpillwayError('invalid_review','Review finalization requires an outcome');
    this.transaction(() => {
      const review = this.getReview(id);
      if (!review) throw new SpillwayError('not_found','Review does not exist',404);
      if (review.outcome !== 'running') throw new SpillwayError('immutable_review','Finalized or uncertain reviews cannot be rewritten',409);
      const task = this.requireTask(review.taskId);
      if (task.state !== 'reviewing' || task.nextAction !== 'review') throw new SpillwayError('invalid_transition','Task no longer has this active review',409);
      this.latestVerified(task.id,review.attemptId,review.resultSha);
      if (value.outcome === 'completed') {
        if (!value.report || value.report.resultSha !== review.resultSha) throw new SpillwayError('stale_review','Completed review must report the exact verified SHA',409);
        if (state === 'ready' && task.reviewTier !== review.tier) throw new SpillwayError('invalid_review','Completed review no longer satisfies the required tier',409);
        const tierEscalated = review.tier === 'local' && task.reviewTier === 'frontier';
        if (value.report.verdict === 'accept' && !(state === 'ready' && nextAction === null) && !(tierEscalated && state === 'held' && nextAction === 'review')) throw new SpillwayError('invalid_review','Accepting reviews must lead to ready or a stronger pending review');
        if (value.report.verdict === 'needs-repair' && !['needs-repair','queued','held','escalated'].includes(state)) throw new SpillwayError('invalid_review','Needs-repair reviews cannot authorize readiness');
        if (value.report.verdict === 'reject' && (!['failed','held','rejected'].includes(state) || nextAction !== null)) throw new SpillwayError('invalid_review','Rejected reviews cannot authorize execution or readiness');
      } else if (state !== 'held' || nextAction !== null) {
        throw new SpillwayError('invalid_review','Failed or uncertain reviews must hold without pending execution');
      }
      if (value.outcome === 'uncertain' && value.report) throw new SpillwayError('invalid_review','Uncertain reviews cannot publish conclusions');
      this.db.prepare('UPDATE reviews SET outcome=?,report=?,usage=?,ended_at=?,reason=? WHERE id=?').run(value.outcome!,value.report ? JSON.stringify(value.report) : null,value.usage ? JSON.stringify(value.usage) : null,value.endedAt ?? now(),value.reason ?? reason ?? null,id);
      this.setTaskAction(task.id,state,nextAction,reason);
      this.event(task.id,'review_finished',{ reviewId: id,outcome: value.outcome, verdict: value.report?.verdict ?? null });
    });
  }
  resolveUncertainty(taskId: string): void {
    this.transaction(() => {
      const task = this.requireTask(taskId);
      const uncertain = this.db.prepare("SELECT id FROM attempts WHERE task_id=? AND outcome='uncertain' UNION ALL SELECT id FROM reviews WHERE task_id=? AND outcome='uncertain'").get(taskId,taskId);
      if (task.state !== 'held' || !uncertain) throw new SpillwayError('invalid_transition','Only held interrupted execution can be reconciled',409);
      this.setTaskAction(taskId,'abandoned',null,'Owner attested interrupted execution was stopped; evidence preserved');
      this.event(taskId,'uncertainty_resolved',{ workerStopped: true });
    });
  }
  getFrontierState(): FrontierState {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT value FROM settings WHERE key='frontier'").get();
      if (!row) throw new SpillwayError('database_state','Frontier settings are missing',500);
      const state = frontierSchema.parse(json<unknown>(row.value));
      if (!state.available && state.resetAt && Date.parse(state.resetAt) <= Date.now()) return this.writeFrontierState(true,null,'frontier_scheduled_reset');
      return state;
    });
  }
  private writeFrontierState(available: boolean, resetAt: string | null, type: string): FrontierState {
    const state = { available, resetAt, updatedAt: now() };
    this.db.prepare("UPDATE settings SET value=? WHERE key='frontier'").run(JSON.stringify(state));
    this.db.prepare('INSERT INTO setting_events(type,payload,created_at) VALUES(?,?,?)').run(type,JSON.stringify(state),state.updatedAt);
    return state;
  }
  setFrontierState(available: boolean, resetAt: string | null = null): FrontierState {
    z.boolean().parse(available); z.string().datetime({ offset: true }).nullable().parse(resetAt);
    if (available && resetAt !== null) throw new SpillwayError('invalid_frontier','Reset schedule applies only while frontier is unavailable');
    return this.transaction(() => this.writeFrontierState(available,resetAt,'frontier_changed'));
  }

  addEvent(taskId: string, type: string, payload: unknown): void {
    if (!type || type.length > 100)
      throw new SpillwayError("invalid_event", "Event type is invalid");
    this.transaction(() => {
      this.requireTask(taskId);
      this.event(taskId, type, payload);
    });
  }
  listEvents(taskId: string): EventRecord[] {
    return this.db
      .prepare("SELECT * FROM events WHERE task_id=? ORDER BY id")
      .all(taskId)
      .map((row) => ({
        id: Number(row.id),
        taskId: String(row.task_id),
        type: String(row.type),
        payload: json<unknown>(row.payload),
        createdAt: String(row.created_at),
      }));
  }
}
