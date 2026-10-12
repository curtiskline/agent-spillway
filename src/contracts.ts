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
  "tests" | "small-fix" | "mechanical" | "small-feature" | "risky" | "design";
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
  api_key_file?: string;
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
  publication?: { public_url: string };
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
  policy?: PolicyConfig;
  review_profile?: string;
  audit_rate?: number;
}
export interface ClassPolicy {
  local_eligible: boolean;
  review: ReviewTier;
}
export interface PolicyConfig {
  version: 1;
  classes: Record<TaskClass, ClassPolicy>;
  max_repairs: 0 | 1;
  review_timeout_minutes: number;
}
export type NextAction = "worker" | "repair" | "review" | "frontier-worker";
export interface FrontierState {
  available: boolean;
  resetAt: string | null;
  updatedAt: string;
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
  nextAction?: NextAction | null;
  origin?: "ordinary" | "qualification";
  readyAt?: string | null;
  completedWhileFrontierOff?: boolean | null;
  policySnapshot?: PolicyConfig | null;
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
  kind?: "worker" | "repair" | "frontier";
  parentAttemptId?: number | null;
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
  kind?: "worker" | "repair" | "frontier";
  parentAttemptId?: number;
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
  purpose?: "worker" | "review";
  temperature?: number;
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
  createReviewVerification(commit: string, reviewId: number): Promise<string>;
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
  reviews?: ReviewRecord[];
  audits?: AuditRecord[];
}
export interface ReviewFinding {
  severity: "blocking" | "warning";
  message: string;
  path?: string;
}
export interface ReviewReport {
  resultSha: string;
  verdict: "accept" | "needs-repair" | "reject";
  findings: ReviewFinding[];
}
export interface ReviewRecord {
  modelArtifact?: string | null;
  harness?: string | null;
  harnessVersion?: string | null;
  id: number;
  taskId: string;
  attemptId: number;
  tier: "local" | "frontier";
  source: "service-local" | "owner-session";
  profileId: string | null;
  model: string | null;
  resultSha: string;
  outcome: "running" | "completed" | "failed" | "uncertain";
  report: ReviewReport | null;
  usage: Usage | null;
  logPath: string | null;
  startedAt: string;
  endedAt: string | null;
  reason: string | null;
}
export interface NewReview {
  modelArtifact?: string;
  harness?: string;
  harnessVersion?: string;
  taskId: string;
  attemptId: number;
  tier: "local" | "frontier";
  source: "service-local" | "owner-session";
  profileId?: string;
  model?: string;
  resultSha: string;
  logPath?: string;
}
export interface ReviewPatch {
  outcome?: "completed" | "failed" | "uncertain";
  report?: ReviewReport | null;
  usage?: Usage | null;
  endedAt?: string;
  reason?: string | null;
}
export interface LocalReviewInput {
  reviewId: number;
  task: TaskRecord;
  attempt: AttemptRecord;
  workspace: WorkspaceContract;
  adapter: HarnessAdapter;
  endpoint: EndpointProfile;
  profile: ModelProfile;
  artifactDir: string;
  timeoutSec: number;
  signal?: AbortSignal;
}
export interface LocalReviewResult {
  outcome: "completed" | "failed" | "uncertain";
  report?: ReviewReport;
  usage?: Usage;
  reason?: string;
  logPath: string;
}
export interface TaskAdmission {
  origin?: "ordinary" | "qualification";
  policySnapshot?: PolicyConfig;
}
export interface DecisionRecord {
  taskId: string;
  decision: "accepted" | "rejected";
  resultSha: string;
  reviewTier: ReviewTier;
  ownerMinutes: number | null;
  decidedAt: string;
}
export interface AuditRecord {
  id: number;
  taskId: string;
  attemptId: number;
  resultSha: string;
  reviewTier: "checks-only" | "local";
  status: "pending" | "completed";
  report: ReviewReport | null;
  model: string | null;
  usage: Usage | null;
  createdAt: string;
  completedAt: string | null;
}
export interface PlanningUsageRecord {
  id: number;
  taskId: string;
  usage: Usage;
  createdAt: string;
}
export interface EvidenceRecord {
  version: 1;
  id: number;
  kind: string;
  taskId: string | null;
  createdAt: string;
  provenance: "service" | "legacy-snapshot";
  data: unknown;
}
export interface EvidenceStatus {
  pending: number;
  delivered: number;
  lastError: string | null;
}
export interface ReportSnapshot {
  tasks: TaskDetail[];
  decisions: DecisionRecord[];
  audits: AuditRecord[];
  planning: PlanningUsageRecord[];
  generatedAt: string;
}
export interface QualificationJobRecord {
  id: string;
  profileId: string;
  root: string;
  status: "running" | "completed" | "failed" | "uncertain";
  startedAt: string;
  endedAt: string | null;
  resultPath: string | null;
  reason: string | null;
  reconciledAt: string | null;
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
