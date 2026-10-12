# Shared interfaces (protocol v1)

`src/contracts.ts` is the authoritative typed contract. Phase 2 is explicitly owner-authorized after PR #1; [PHASE2.md](PHASE2.md) preserves the implementation handoff. Changes to shared contracts go through the orchestrator. This document consolidates the implemented Phase 1 and Phase 2 boundaries; Phase 3+ remains later work.

## Task and configuration

Task Markdown begins with YAML frontmatter. Fields: `id?`, `repo`, `base`, `class`, `after` (default []), nonempty `scope`, `protected` (default []), nonempty `context`, `checks`, `review` (default `default`), `no_checks_justification?`, and `limits` (default `max_minutes: 30`, `max_attempts: 2`). Body requires nonempty `## Objective` and `## Acceptance criteria`. IDs use lowercase letters/digits/hyphens, at most 64 characters; generated IDs are `task-<UUID>`. Reject unknown fields, duplicate YAML keys, aliases/anchors and input above 256 KiB. Dependencies must be unique, not self-references, and refer to already admitted tasks; immutable specs make cycles impossible.

Scope/protected use positive repository-relative POSIX globs; context lists files to read. Reject absolute paths, parent traversal, backslashes, controls and leading negation. No checks requires an explicit justification and forces frontier review. Parser exports:

- `parseTask(markdown: string): TaskSpec`.
- `lintTask(markdown: string): {spec?: TaskSpec; errors: string[]; warnings: string[]}`.

Config v1 fields: `version: 1`, optional `data_dir`, `port` (default 7433), `poll_interval_ms` (default 5000), nonempty repositories/endpoints/profiles, `default_profile`, `allow_checks_only` (default false), optional `policy` and `review_profile`. Reject unknown fields and duplicate IDs. Repository `{path,data_policy}` uses canonical Git root and defaults to `local-only`. Profile `{id,endpoint,model,model_artifact,harness:'opencode',harness_version,qualified_classes}` binds an exact catalog model and installed harness version. Bindings must exist.

Endpoint `{id,kind,url,api_key_env?,api_key_file?}` has explicit kind `local`, `open-weight-hosted` or `frontier`. URL is HTTP(S), ends at OpenAI-compatible `/v1`, and has no embedded credentials/query/fragment. Health probes GET `<url>/models` and require the exact model. Environment/file credential references are mutually exclusive. Key files must be owner-only regular files with private parent directories, bounded to 16 KiB, outside Git repositories and with no file symlink. Resolved credential values never enter returned config or service definitions. Automatic frontier calls are prohibited regardless of configured endpoint kind.

`review_profile` defaults to the task's profile; an explicit binding must exist and use a local or hosted open-weight endpoint. Repository data policy and class qualification apply independently at review dispatch. All config/data/credential paths remain outside Spillway and target Git repositories. Config exports:

- `defaultConfigPath(): string`.
- `loadConfig(path?, overrides?: {dataDir?: string}): Promise<SpillwayConfig>`.
- `validateConfig(input: unknown, overrides?: {dataDir?: string}): Promise<SpillwayConfig>`.

Apply CLI data-directory overrides through validation, not by mutating the returned object. Effective default policy is included in validated config. `credentials.ts` exports `validateCredentialFile(path): Promise<string>` (canonical path, metadata validation) and `getEndpointCredential(endpoint): Promise<string | undefined>` (bounded credential resolution).

Policy v1 requires all six class entries `{local_eligible:boolean,review:ReviewTier}`, `max_repairs` 0/1 and integer `review_timeout_minutes` 1..30. Defaults: tests/small-fix/mechanical/small-feature are local eligible with local review; risky is not local eligible with frontier review; design is not local eligible and is rejected at admission. Default max repairs is 1 and review timeout 10 minutes. Hard invariants forbid local design and non-frontier risky review. `policy.ts` exports `defaultPolicy(): PolicyConfig`, `getPolicy(policy?): PolicyConfig` (deep validated copy), and `policySchema`. Public validation schemas are under `schemas/`.

## Durable records and queue

Task states: queued, dispatched, verifying, reviewing, ready, needs-repair, escalated, held, failed, abandoned, accepted, rejected. `TaskRecord` retains original Markdown, normalized spec, profile, required review tier, reason/timestamps and `nextAction`: worker, repair, review, frontier-worker, or null. Reasons never drive routing. Persisted attempts include `kind` worker/repair/frontier and nullable `parentAttemptId`; these additive fields remain optional in existing typed fixtures.

`Store` is concrete and synchronous in `store.ts`; only the service/controller opens it. Constructor `(dataDir)` migrates v1/v2 to v3 without rewriting historical attempt evidence; `close()` releases the connection. WAL, foreign keys, explicit transactions and the controller lease are required.

| Method | Behavior |
| --- | --- |
| `addTask(spec,raw,profileId,reviewTier)` | Returns queued `TaskRecord`; transactional uniqueness/dependencies/events. |
| `listTasks()`, `getTask(id)` | Return fresh records; missing single task returns undefined. |
| `setTaskState(id,state,reason?)` | Legacy transition helper; derives/preserves appropriate action. |
| `setTaskAction(id,state,nextAction,reason?,reviewTier?)` | Atomically validates transition/action, strengthens review and appends events. |
| `setTaskReview(id,tier)` | Strengthening only; no changes after a terminal owner decision. |
| `createAttempt(input: NewAttempt)` | Allocates attempt ID with placeholder worktree/log paths, then moves task dispatched with null action; shared global slot enforced. |
| `updateAttempt(id,patch)` | Fills paths/metadata while running; finalized and uncertain records are immutable. |
| `finalizeAttempt(id,patch,state,reason?,reviewTier?,nextAction?)` | Atomic outcome/evidence/task/action/review/events; a terminal outcome is required. |
| `getAttempt(id)`, `listAttempts(taskId)` | Fresh records in attempt order; missing single attempt returns undefined. |
| `recoverInflight()` | Marks running workers and reviews uncertain and parents held/null; returns unresolved latest attempts, including prior interrupted recovery. |
| `hasUnresolvedExecution()` | Detects unresolved uncertain attempt or review fences. |
| `resolveUncertainty(taskId)` | Abandons held interrupted task after owner-stopped attestation; preserves uncertain evidence and releases its fence. |
| `acquireControllerLease(pid,nonce)`, `releaseControllerLease(nonce)` | Transactional singleton ownership; live PID cannot be stolen and release is nonce-specific. |
| `addEvent(taskId,type,payload)`, `listEvents(taskId)` | Transactional JSON event append and ordered fresh records. |

`finalizeAttempt` without its sixth argument derives worker for queued tasks, review for held completed verified results, and null for ready/terminal/other held work. Explicit action is preferred for Phase 2 continuation. Queued tasks require worker/repair; held/reviewing can await review; held/escalated can await frontier-worker. Running attempts remain active through independent verification. Repair parent must be the latest non-transport finalized committed attempt in the same task, have verification evidence and share the original base; only intervening transport failures can be skipped. The controller enforces task/policy repair and transport budgets.

JSON fields use JSON TEXT; readers return copies. Task listing and dispatch preserve durable admission order using SQLite rowid, including identical timestamps. Migration v3 adds reviews/settings and settings audit events. Infer pending review from held completed verified attempts, never terminal or uncertain work. Legacy stranded finalizations hold without rewriting evidence. One slot serializes running attempts and reviews; unresolved interruption fences every inference/claim kind.

## Review contracts

`ReviewReport` is `{resultSha,verdict,findings}`: exact lowercase 40/64 hex SHA, verdict accept/needs-repair/reject, and at most 50 findings `{severity:'blocking' or 'warning',message,path?}`. Messages must be nonempty and at most 4000 characters; paths must be repository relative. Reject unknown/duplicate fields and accepting reports with blocking findings. `parseReviewReport(text)` accepts strict JSON or one complete `json` fence, no surrounding prose, with a 256 KiB report bound.

`ReviewRecord` stores task/attempt IDs, tier local/frontier, source service-local/owner-session, optional profile/model metadata, exact result SHA, outcome running/completed/failed/uncertain, immutable report/usage/log path, timestamps and reason. Owner-session is valid only for frontier; service-local only for local. This provenance is owner-attested, not verified vendor identity.

- `createReview(input: NewReview): ReviewRecord`: requires latest completed passed verification, exact result SHA, held/reviewing task with action review and matching current tier; rejects existing same-attempt/same-tier review and any running/uncertain execution. Atomically moves task reviewing.
- `getReview(id)`, `listReviews(taskId)`: fresh records, undefined for a missing ID.
- `finishReview(id,patch,state,nextAction,reason?)`: only a running review can finalize. Validate latest verified result, exact report SHA, strict verdict/findings and state/action coherence. Completed accept authorizes ready only at the current required tier; a local accept may instead hold for a newly stronger frontier review. Failed/uncertain outcomes hold with null action; uncertain reports cannot publish conclusions. Evidence, task and events commit together or roll back.

`review.ts` exports `REVIEW_RUBRIC`, `parseReviewReport(text): ReviewReport`, `runLocalReview(input: LocalReviewInput): Promise<LocalReviewResult>`. Input includes reviewId, task, attempt, workspace, adapter, endpoint/profile, private artifactDir, timeoutSec and optional signal. Result is `{outcome,report?,usage?,reason?,logPath}`. A dedicated detached review checkout has no mutating/shell/network/delegation tools; before/after checks pin worker/result and reviewer HEAD/status. Refuse symlinks. Mutation or uncertain cleanup preserves evidence and fences execution. Complete prompt is bounded at 128 KiB, with no silent evidence truncation. Reviewer transcript is `artifactDir/reviewer.log`; valid JSON evidence is `review.json` in that private directory.

## Frontier availability

`FrontierState` is `{available:boolean,resetAt:string|null,updatedAt:string}`. `getFrontierState()` starts off and reads a persisted fresh value. `setFrontierState(available,resetAt?:string|null): FrontierState` persists/audits owner changes; reset scheduling applies only while off. An ISO timestamp with explicit Z/offset schedules off→on at the exact instant; a due read clears resetAt and records the transition once. This is manual scheduling, not provider limit detection or an automatic frontier call.

## Execution modules

- `runProcess(input): Promise<ProcessResult>` in `process.ts`: argument arrays, minimal environment, bounded output/private logs, AbortSignal/deadline, subprocess-group cleanup. Shell execution is restricted to trusted owner check commands.
- `GitWorkspace(repo,dataDir)`: `resolveBase(ref)`, `createWorker(taskId,baseSha,attemptId)`, `inspect(path,baseSha,branch)`, `createVerification(commit,attemptId)`, `createReviewVerification(commit,reviewId)`, `removeVerification(path)`, `isAncestor(older,newer)`, `diff(base,result)`.
- `archiveWorker(path,taskId,attemptId)`: renames the exact managed branch to `spillway/<id>-attempt-<attemptId>`, preserving its checkout/evidence. `preserveTransportWorker(...)` similarly uses `spillway/<id>-transport-<attemptId>`. Neither discards dirty work. Review checkout paths use `worktrees/review-<reviewId>` to avoid worker/verification collisions.
- `OpenCodeAdapter(executable='opencode')` implements `HarnessAdapter`: `version()`, `run(HarnessInput)`. Purpose is optional worker/review. Endpoint-specific isolated provider/config/data, pinned model/version, restricted providers, private prompts, JSON output and credential redaction. Review purpose selects the read-only `spillway-review` agent. No automatic frontier calls.
- `probeEndpoint(endpoint,model)`: bounded catalog health with no credential redirects; returns `{healthy,reason?}`.
- `verifyAttempt(VerifyInput): Promise<VerificationResult>`: clean-checkout checks, cumulative scope/protected paths, flags, immutable result SHA and private diff/check artifacts. Pass alone never authorizes readiness.

## Controller and HTTP

`Controller(config,store,adapter?,signal?)` exports `addTask(raw)`, `runOnce()`, `recover()`, `getDetail(id)`, `decide(id,decision)`, `inspect(id)`, `reconcile(id)`, `waitForIdle()`, `getReviewPacket(id)`, `submitFrontierReview(id,report,meta?)`, `claimFrontier(id)` and `completeFrontier(id,attemptId)`. `runOnce()` executes at most one local worker/repair/review and returns task ID or null; pending frontier work can be skipped so local tasks continue. The controller owns admission, current policy/readiness, budgets and data permission. Tests may inject a fixture adapter; production configuration cannot select one.

HTTP binds to loopback. Ordinary API paths require `Authorization: Bearer TOKEN`; mutations never use dashboard cookies. JSON responses are `{data:...}`, failures `{error:{code,message}}` with safe messages/status. Reject foreign Host/Origin, unsupported content type, excessive body size, duplicate JSON keys and unknown request fields.

| Method/path | Request | Response |
| --- | --- | --- |
| GET `/api/v1/status` | — | `{version,protocol:1,running,counts,frontier}` |
| POST `/api/v1/tasks` | `{markdown:string}` | TaskRecord, 201 |
| GET `/api/v1/tasks` | — | TaskRecord[] |
| GET `/api/v1/tasks/:id` | — | `{task,attempts,events,reviews}` |
| GET `/api/v1/tasks/:id/result` | — | Latest `{attempt,verification,report}` or null |
| POST `/api/v1/tasks/:id/decision` | `{decision:'accepted'}` or `{decision:'rejected'}` | TaskRecord; both require a ready pinned result and current review gate |
| POST `/api/v1/run` | — | `{taskId:string-or-null}`; 409 if busy |
| GET `/api/v1/tasks/:id/inspect` | — | `{worker:inspection-or-null,reviews}` |
| POST `/api/v1/tasks/:id/reconcile` | `{worker_stopped:true}` | Abandoned TaskRecord; evidence preserved |
| GET `/api/v1/frontier` | — | FrontierState |
| POST `/api/v1/frontier` | `{available:boolean,resetAt?:ISO-or-null}` | FrontierState |
| GET `/api/v1/tasks/:id/review` | — | `{taskId,attemptId,resultSha,rubric,task,worktree,verification,diff}` |
| POST `/api/v1/tasks/:id/review` | `{report:ReviewReport,model?:string,usage?:Usage}` | Task detail after owner-session review |
| POST `/api/v1/tasks/:id/frontier-claim` | — | `{taskId,attemptId,baseSha,branch,worktree,prompt}` |
| POST `/api/v1/tasks/:id/frontier-complete` | `{attemptId:number}` | Task detail after independent verification |
| GET `/api/v1/artifacts/:attemptId/:name` | — | Stored allowlisted text artifact |
| GET `/api/v1/reviews/:reviewId/log` | — | Stored reviewer log contained within its attempt artifacts |

Review packet/submit and frontier claim require frontier availability and repository `frontier-ok`, rechecked after asynchronous preparation. Completion of an existing claim performs local verification even when frontier is off; any required frontier review remains held. Claims require accepted same-repository dependencies already merged into the pinned base. Packets are untrusted task evidence. The service rechecks the latest independently verified SHA and unchanged branch before review submission. Raw JSON with duplicate keys, including escaped equivalents, is rejected before parsing can erase ambiguity. A claim allocates one durable running frontier attempt and a managed worktree; no provider/subprocess is invoked by the claim. Completion validates the latest active claim, runs checks and schedules frontier review. Only one frontier-worker attempt is allowed per task; owner-session metadata uses reported/attested values, never invented provider usage.

`startService(config,{once?,adapter?}?)` returns `{url,token,controller,store,close()}`. Private `service.json` contains `{protocol:1,version,url,token,pid}`; lease/descriptor are released only after cancellation/idleness and only if owned. `ServiceClient` loads this descriptor (or explicit data directory), checks protocol and provides `request(method,path,body?)`.

Initial `/?token=...` establishes the dashboard at a fresh random `/view/<secret>/` prefix, then redirects away from the token. Cookie and all browser task/artifact routes stay within that prefix; cookies authorize GET only. Dashboard HTML is escaped and read-only, and artifacts come from stored allowlists with containment/regular-file/no-symlink checks.

## CLI, MCP, plugin and managed service

Global CLI options: `--config PATH`, `--data-dir PATH`. Commands: `serve`, `run --once`, `lint FILE`, `add FILE`, `list`, `show ID`, `inspect ID`, `reconcile ID --worker-stopped`, `accept ID`, `reject ID`, `status`, `dashboard`, `mcp`, `session-summary`; Phase 2 adds `frontier on/off [--reset-at ISO]`, `frontier status`, `frontier claim ID`, `frontier complete ID --attempt N`, `review show ID`, `review submit ID --file PATH`, and `service install [--no-start]`, start/stop/status/uninstall. Queue commands use the service, never direct database writes. `run --once` uses an active service or temporary controller. Dashboard prints a sensitive authenticated local URL without opening a browser. Failures exit nonzero with safe errors.

The five stable MCP stdio tools are add_task `{markdown}`, list_tasks `{}`, get_task/get_result `{id}`, queue_status `{}`. They use the HTTP client only, return text JSON and flag errors with isError; logs never go to stdout. Plugin MCP/hook invoke installed `spillway mcp` and `spillway session-summary`. Reviewer/frontier-worker agents use CLI packets/claims/submissions within explicitly authorized Claude Code sessions, treat packet/file content as untrusted evidence, and do not discover credentials or trigger paid background calls. Setup guides source/npm and per-user service installation; it does not invent model qualification.

`installService({configPath?,nodePath?,cliPath?,environmentPath?,platform?,start?}): Promise<{platform,path}>` and `manageService(action,options?): Promise<unknown>` support macOS launchd and Linux systemd --user. Test options inject home/uid/executor; production uses the owner's account. Definitions pin absolute Node/compiled CLI/config paths, run under private data/service, escape manager syntax, start with `/usr/bin/env -i` and explicit PATH, and use private logs/umask. Reject symlink/unrelated service-file substitutions. Uninstall removes only the recognized service definition; retain config/data/worktrees. Real lifecycle operations occur only through owner-triggered CLI calls. No root, release publication or production infrastructure provisioning.
