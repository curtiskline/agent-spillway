# Shared interfaces (protocol v1)

`src/contracts.ts` is the authoritative typed contract. This document fixes boundaries before delegation; agents must ask the orchestrator to change them.

## Task and configuration

Frontmatter fields: `id?`, `repo`, `base`, `class`, `after` (default []), nonempty `scope`, `protected` (default []), nonempty `context`, `checks`, `review` (default `default`), `no_checks_justification?`, `limits` (default max_minutes=30, max_attempts=2). Markdown must have nonempty `## Objective` and `## Acceptance criteria`. IDs: lowercase letters/digits/hyphens, max 64; no path traversal. Scope/context/protected use repository-relative POSIX paths, never absolute or `..`, controls, or leading `!`. Scope/protected use positive globs only; context names concrete files. Reject unknown fields. YAML duplicate keys/aliases and oversized input rejected. Missing IDs use a UUID-derived `task-...`.

Config v1: `version: 1`, `data_dir?`, `port` (default 7433), `poll_interval_ms` (default 5000), repositories array `{path,data_policy}`, endpoints array `{id,kind,url,api_key_env?}`, profiles array `{id,endpoint,model,model_artifact,harness:'opencode',harness_version,qualified_classes}`, `default_profile`, `allow_checks_only` (default false). Repository data policy defaults local-only. Endpoint URL ends at OpenAI-compatible `/v1`; GET `${url}/models` must contain exact profile model. No URL credentials/query/fragment. API key is a named environment reference; not a config literal. Profiles are private bindings; published richer profiles will arrive with Phase 3 qualification schemas.

## Persistence

`Store` is concrete and synchronous, exported from `store.ts`:

- constructor(dataDir), `close()`; migration/open defaults safely.
- `addTask(spec,raw,profileId,reviewTier): TaskRecord`; uniqueness/dependencies enforced transactionally.
- `listTasks(): TaskRecord[]`, `getTask(id): TaskRecord | undefined`, `setTaskState(id,state,reason?): void`, `setTaskReview(id,tier): void` (transition whitelist).
- `createAttempt(input: NewAttempt): AttemptRecord`; transaction moves queued to dispatched; at most one active attempt globally.
- `updateAttempt(id,patch: AttemptPatch): void`, `listAttempts(taskId): AttemptRecord[]`, `getAttempt(id)`.
- `finalizeAttempt(id,patch,state,reason?,reviewTier?): void`; terminal attempt outcome, task state, review strengthening and events atomically commit or roll back together.
- `recoverInflight(): AttemptRecord[]`; active attempts become uncertain, parent task held; returns all unresolved latest uncertain attempts, including those from interrupted previous recovery. Legacy stranded finalizations hold without rewriting evidence. No worker rerun.
- `acquireControllerLease(pid,nonce)`, `releaseControllerLease(nonce)`: transactional singleton ownership; stale PID reclaim serializes, nonce-safe release. Migration v2.
- `addEvent(taskId,type,payload): void`, `listEvents(taskId)`.

JSON fields stored as JSON TEXT, immutable records read as copies. Final results `VerificationResult` stored on attempt along with result commit and report path. Use foreign keys and no string-interpolated SQL.

## Execution modules

- `runProcess(input): Promise<ProcessResult>` in process.ts. Args separated; shell only for trusted task checks. Output to private file, bounded memory; minimal env; AbortSignal and deadline; process group cleanup.
- `GitWorkspace(repo,dataDir)` in git.ts: `resolveBase(ref)`, `createWorker(taskId,baseSha,attemptId)`, `inspect(path,baseSha,branch)`, `createVerification(commit,attemptId)`, `removeVerification(path)`, `isAncestor(older,newer)`, `diff(base,result)`.
- `GitWorkspace.preserveTransportWorker(path,taskId,attemptId)` renames the exact managed checkout's branch to `spillway/<id>-transport-<attemptId>` without discarding changes, freeing the result branch for the one transport retry.
- `OpenCodeAdapter(executable='opencode')` implements HarnessAdapter; `version()`, `run(input)`. Prompt via stdin/private file, never shell interpolation; `--format json`, endpoint-specific provider config, restricted provider list, isolated harness config/data to prevent credential fallback. Profile version checked by controller.
- `probeEndpoint(endpoint,model): Promise<{healthy:boolean,reason?:string}>` in harness.ts. Bounded timeout, no redirect credentials.
- `verifyAttempt(input: VerifyInput): Promise<VerificationResult>` in verify.ts. Input includes spec, attempt, workspace, artifactDir, optional signal. Returns pass/check outputs, changed paths, immutable result SHA, diff artifact, flags, reason. Flags force frontier; pass alone doesn't authorize ready.

## Controller and clients

`Controller(config, store, adapter?, signal?)`: `addTask(raw)`, `runOnce()` (returns task id or null), `recover()`, `getDetail(id)`, `decide(id,'accepted'|'rejected')`, `inspect(id)`, `reconcile(id)`, `waitForIdle()`. Owns dispatch slot, admission, policy and state. Uncertain execution fences the slot until owner reconciliation; reconcile requires held/uncertain and abandons it without evidence changes. Tests may inject HarnessAdapter but production config cannot select a fake harness.

HTTP on loopback, `Authorization: Bearer TOKEN` required, responses `{data:...}`:

| Method/path                            | Request                 | Response                                            |
| -------------------------------------- | ----------------------- | --------------------------------------------------- | ------------------- |
| GET /api/v1/status                     | —                       | `{version,protocol:1,running,counts}`               |
| POST /api/v1/tasks                     | `{markdown:string}`     | TaskRecord, 201                                     |
| GET /api/v1/tasks                      | —                       | TaskRecord[]                                        |
| GET /api/v1/tasks/:id                  | —                       | `{task,attempts,events}`                            |
| GET /api/v1/tasks/:id/result           | —                       | latest `{attempt,verification,report}` or null      |
| POST /api/v1/tasks/:id/decision        | `{decision:'accepted'   | 'rejected'}`                                        | TaskRecord          |
| POST /api/v1/run                       | —                       | `{taskId:string                                     | null}`; 409 if busy |
| GET /api/v1/tasks/:id/inspect          | —                       | inspection or null                                  |
| POST /api/v1/tasks/:id/reconcile       | `{worker_stopped:true}` | abandoned TaskRecord; owner attests workers stopped |
| GET /api/v1/artifacts/:attemptId/:name | —                       | stored allowlisted text artifact                    |

`server.ts`: `startService(config, options?: {once?:boolean,adapter?:HarnessAdapter}): Promise<ServiceHandle>`. Handle `{url,token,controller,store,close():Promise<void>}`. Private `service.json`: `{protocol:1,version,url,token,pid}`. Lease/descriptor released on orderly shutdown if owned, after cancellation and controller idleness. `client.ts` `ServiceClient` reads descriptor or given dataDir, checks protocol and exports `request(method,path,body?)`. Initial `/?token=...` redirect establishes browser session at a random `/view/<secret>/` prefix; cookie and all browser artifact/task routes stay within that prefix. Bearer API routes remain unchanged.

CLI: global `--config PATH`, `--data-dir PATH`; `serve`, `run --once`, `lint FILE`, `add FILE`, `list`, `show ID`, `inspect ID`, `reconcile ID --worker-stopped`, `accept ID`, `reject ID`, `status`, `dashboard`, `mcp`, `session-summary`. Default all queue commands require running service. `run --once` calls active service if present, otherwise starts controller temporarily. No direct client database writes. Output JSON except lint/session-summary/dashboard; failures exit nonzero with safe errors. `dashboard` prints authenticated local URL; no implicit browser launch.

MCP stdio tools use HTTP client only: add_task `{markdown}`, list_tasks `{}`, get_task/get_result `{id}`, queue_status `{}`. Text JSON result; errors flagged `isError`. Logs never stdout. Plugin scaffold references installed `spillway mcp` and session hook `spillway session-summary`; full install/setup is not claimed before Phase 2.
