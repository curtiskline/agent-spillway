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
import { identifier } from "./task.js";
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
} from "./contracts.js";

const transitions: Record<TaskState, readonly TaskState[]> = {
  queued: ["dispatched", "held", "failed", "abandoned"],
  dispatched: ["verifying", "queued", "held", "failed", "abandoned"],
  verifying: [
    "reviewing",
    "ready",
    "needs-repair",
    "escalated",
    "held",
    "failed",
  ],
  reviewing: ["ready", "needs-repair", "escalated", "held", "failed"],
  ready: ["accepted", "rejected", "held"],
  "needs-repair": ["queued", "held", "escalated", "abandoned"],
  escalated: ["queued", "held", "abandoned"],
  held: ["queued", "verifying", "rejected", "abandoned"],
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
  })
  .strict();

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
  };
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
    if (version > 2) {
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
          "INSERT INTO tasks(id,spec,raw,profile_id,review_tier,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
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
      .prepare("SELECT * FROM tasks ORDER BY created_at,id")
      .all()
      .map(taskRecord);
  }
  getTask(id: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
    return row ? taskRecord(row) : undefined;
  }
  setTaskState(id: string, state: TaskState, reason?: string): void {
    z.enum(TASK_STATES).parse(state);
    this.transaction(() => {
      const task = this.requireTask(id);
      if (state !== task.state && !transitions[task.state].includes(state))
        throw new SpillwayError(
          "invalid_transition",
          `Cannot transition ${task.state} to ${state}`,
          409,
        );
      this.db
        .prepare("UPDATE tasks SET state=?,reason=?,updated_at=? WHERE id=?")
        .run(state, reason ?? null, now(), id);
      this.event(id, "state_changed", {
        from: task.state,
        to: state,
        reason: reason ?? null,
      });
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
  createAttempt(input: NewAttempt): AttemptRecord {
    attemptSchema.parse(input);
    return this.transaction(() => {
      const task = this.requireTask(input.taskId);
      if (task.state !== "queued")
        throw new SpillwayError(
          "invalid_transition",
          "Only queued tasks can dispatch",
          409,
        );
      if (
        this.db.prepare("SELECT id FROM attempts WHERE outcome='running'").get()
      )
        throw new SpillwayError("busy", "An attempt is already active", 409);
      if (
        this.db
          .prepare(
            "SELECT a.id FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE a.outcome='uncertain' AND t.state='held'",
          )
          .get()
      )
        throw new SpillwayError(
          "busy",
          "Interrupted execution requires owner reconciliation",
          409,
        );
      const timestamp = now();
      const result = this.db
        .prepare(
          `INSERT INTO attempts(task_id,endpoint,profile_id,model,model_artifact,harness,harness_version,base_sha,branch,worktree,started_at,outcome,log_path) VALUES(?,?,?,?,?,?,?,?,?,?,?,'running',?)`,
        )
        .run(
          input.taskId,
          input.endpoint,
          input.profileId,
          input.model,
          input.modelArtifact,
          input.harness,
          input.harnessVersion,
          input.baseSha,
          input.branch,
          input.worktree,
          timestamp,
          input.logPath,
        );
      const id = Number(result.lastInsertRowid);
      this.db
        .prepare(
          "UPDATE tasks SET state='dispatched',reason=NULL,updated_at=? WHERE id=?",
        )
        .run(timestamp, input.taskId);
      this.event(input.taskId, "attempt_started", { attemptId: id });
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
      if (attempt.outcome !== "running" && attempt.outcome !== "uncertain")
        throw new SpillwayError(
          "immutable_attempt",
          "Finalized attempts are immutable",
          409,
        );
      if (attempt.outcome === "uncertain" && value.outcome === "running")
        throw new SpillwayError(
          "invalid_transition",
          "Uncertain attempts cannot restart",
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
            "UPDATE tasks SET state='held',reason='Interrupted attempt requires inspection',updated_at=? WHERE id=?",
          )
          .run(timestamp, attempt.taskId);
        this.event(attempt.taskId, "attempt_uncertain", {
          attemptId: attempt.id,
        });
      }
      // Older interrupted versions may have finalized evidence before parent state.
      const stranded = this.db
        .prepare(
          "SELECT t.id FROM tasks t WHERE t.state IN ('dispatched','verifying','reviewing') AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.task_id=t.id AND a.outcome='running')",
        )
        .all();
      for (const task of stranded) {
        this.db
          .prepare(
            "UPDATE tasks SET state='held',reason='Interrupted finalization requires inspection',updated_at=? WHERE id=?",
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
      if (reviewTier) this.setTaskReview(attempt.taskId, reviewTier);
      this.setTaskState(attempt.taskId, state, reason);
    });
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
