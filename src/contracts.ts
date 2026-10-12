export const VERSION = "0.0.0";
export const PROTOCOL = 1;
export const TASK_STATES = [
  "queued",
  "dispatched",
  "verifying",
  "reviewing",
  "ready",
  "needs-repair",
  "escalated",
  "held",
  "failed",
  "abandoned",
  "accepted",
  "rejected",
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export type TaskClass =
  | "tests"
  | "small-fix"
  | "mechanical"
  | "small-feature"
  | "risky"
  | "design";
export type ReviewTier = "checks-only" | "local" | "frontier";
export type DataPolicy = "local-only" | "open-weight-hosted-ok" | "frontier-ok";
export interface TaskSpec {
  id: string;
  repo: string;
  base: string;
  class: TaskClass;
  after: string[];
  scope: string[];
  protected: string[];
  context: string[];
  checks: string[];
  review: "default" | ReviewTier;
  no_checks_justification?: string;
  limits: { max_minutes: number; max_attempts: number };
  body: string;
}
export interface EndpointProfile {
  id: string;
  kind: "local" | "open-weight-hosted" | "frontier";
  url: string;
  api_key_env?: string;
}
export interface ModelProfile {
  id: string;
  endpoint: string;
  model: string;
  model_artifact: string;
  harness: "opencode";
  harness_version: string;
  qualified_classes: TaskClass[];
}
export interface RepositoryConfig {
  path: string;
  data_policy: DataPolicy;
}
export interface SpillwayConfig {
  version: 1;
  data_dir: string;
  port: number;
  poll_interval_ms: number;
  repositories: RepositoryConfig[];
  endpoints: EndpointProfile[];
  profiles: ModelProfile[];
  default_profile: string;
  allow_checks_only: boolean;
}
export interface TaskRecord {
  id: string;
  spec: TaskSpec;
  raw: string;
  profileId: string;
  reviewTier: ReviewTier;
  state: TaskState;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}
export type AttemptOutcome =
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "transport_error"
  | "uncertain";
export interface CheckResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  logPath: string;
}
export interface VerificationResult {
  passed: boolean;
  reason?: string;
  resultSha?: string;
  changedPaths: string[];
  flags: string[];
  checks: CheckResult[];
  diffPath?: string;
}
export interface AttemptRecord {
  id: number;
  taskId: string;
  endpoint: string;
  profileId: string;
  model: string;
  modelArtifact: string;
  harness: string;
  harnessVersion: string;
  baseSha: string;
  branch: string;
  worktree: string;
  startedAt: string;
  endedAt: string | null;
  outcome: AttemptOutcome;
  usage: Usage | null;
  summary: string | null;
  logPath: string;
  resultSha: string | null;
  verification: VerificationResult | null;
  reportPath: string | null;
}
export interface NewAttempt {
  taskId: string;
  endpoint: string;
  profileId: string;
  model: string;
  modelArtifact: string;
  harness: string;
  harnessVersion: string;
  baseSha: string;
  branch: string;
  worktree: string;
  logPath: string;
}
export type AttemptPatch = Partial<
  Pick<
    AttemptRecord,
    | "worktree"
    | "outcome"
    | "usage"
    | "summary"
    | "endedAt"
    | "resultSha"
    | "verification"
    | "reportPath"
    | "logPath"
  >
>;
export interface EventRecord {
  id: number;
  taskId: string;
  type: string;
  payload: unknown;
  createdAt: string;
}
export interface HarnessInput {
  worktree: string;
  prompt: string;
  endpoint: EndpointProfile;
  profile: ModelProfile;
  timeoutSec: number;
  logPath: string;
  signal?: AbortSignal;
}
export interface HarnessResult {
  exit: "completed" | "failed" | "timeout" | "transport_error";
  usage?: Usage;
  summary?: string;
}
export interface HarnessAdapter {
  id: string;
  version(): Promise<string>;
  run(input: HarnessInput): Promise<HarnessResult>;
}
export interface ProcessInput {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  logPath?: string;
  stdin?: string;
  signal?: AbortSignal;
}
export interface ProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}
export interface WorktreeInspection {
  clean: boolean;
  branch: string;
  head: string;
  descendant: boolean;
  hasChanges: boolean;
  dirtyPaths: string[];
}
export interface WorkspaceContract {
  resolveBase(ref: string): Promise<string>;
  createWorker(
    taskId: string,
    baseSha: string,
    attemptId: number,
  ): Promise<string>;
  inspect(
    path: string,
    baseSha: string,
    branch: string,
  ): Promise<WorktreeInspection>;
  createVerification(commit: string, attemptId: number): Promise<string>;
  removeVerification(path: string): Promise<void>;
  isAncestor(older: string, newer: string): Promise<boolean>;
  diff(base: string, result: string): Promise<string>;
}
export interface VerifyInput {
  spec: TaskSpec;
  attempt: AttemptRecord;
  workspace: WorkspaceContract;
  artifactDir: string;
  signal?: AbortSignal;
}
export interface TaskDetail {
  task: TaskRecord;
  attempts: AttemptRecord[];
  events: EventRecord[];
}
export interface ServiceDescriptor {
  protocol: number;
  version: string;
  url: string;
  token: string;
  pid: number;
}
export class SpillwayError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "SpillwayError";
  }
}
