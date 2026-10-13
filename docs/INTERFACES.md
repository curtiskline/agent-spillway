# Shared interfaces (protocol v1)

Qualification workload revisions: result format `version: 1` remains unchanged; `suiteVersion: 1 | 2 | 3` distinguishes preserved historical v1/v2 results from new default v3 runs. Strict runtime and JSON validators accept these supported versions and reject others. V2 states the existing discovery `docs/**` glob predicate explicitly. V3 distinguishes a complete requested read page from missing/truncated evidence, with positive page/path/count/footer validation; actual caps/timeouts/stream loss remain invalid and capability/check/budget gates stay fixed. `observeToolEvidence` accepts an optional suite version (default 3); v1/v2 preserve original behavior. The workload hash binds the revision, and historical results are never regraded. See docs/PHASE3.md for ownership and integration requirements.

`src/contracts.ts` is the authoritative typed contract. Phase 2 is explicitly owner-authorized after PR #1; [PHASE2.md](PHASE2.md) preserves the implementation handoff. Changes to shared contracts go through the orchestrator. This document consolidates the implemented Phase 1 and Phase 2 boundaries; Phase 3 was explicitly authorized after PR #2 (main `079478a`); release and Phase 4/5 remain gated.

## Task and configuration

Task Markdown begins with YAML frontmatter. Fields: `id?`, `repo`, `base`, `class`, `after` (default []), nonempty `scope`, `protected` (default []), nonempty `context`, `checks`, `review` (default `default`), `no_checks_justification?`, and `limits` (default `max_minutes: 30`, `max_attempts: 2`). Body requires nonempty `## Objective` and `## Acceptance criteria`. IDs use lowercase letters/digits/hyphens, at most 64 characters; generated IDs are `task-<UUID>`. Reject unknown fields, duplicate YAML keys, aliases/anchors and input above 256 KiB. Dependencies must be unique, not self-references, and refer to already admitted tasks; immutable specs make cycles impossible.

Scope/protected use positive repository-relative POSIX globs; context lists files to read. Reject absolute paths, parent traversal, backslashes, controls and leading negation. No checks requires an explicit justification and forces frontier review. Parser exports:

- `parseTask(markdown: string): TaskSpec`.
- `lintTask(markdown: string): {spec?: TaskSpec; errors: string[]; warnings: string[]}`.

Config v1 fields: `version: 1`, optional `data_dir`, `port` (default 7433), `poll_interval_ms` (default 5000), nonempty repositories/endpoints/profiles, `default_profile`, `allow_checks_only` (default false), optional `policy`, `review_profile` and `audit_rate` (0..1, default .30). Reject unknown fields and duplicate IDs. Repository `{path,data_policy,publication?}` uses canonical Git root and defaults to `local-only`; separate optional publication `{public_url}` grants a canonical public GitHub repository export destination and is denied when absent. Profile `{id,endpoint,model,model_artifact,harness:'opencode',harness_version,qualified_classes}` binds an exact catalog model and installed harness version. Bindings must exist.

Endpoint `{id,kind,url,api_key_env?,api_key_file?}` has explicit kind `local`, `open-weight-hosted` or `frontier`. URL is HTTP(S), ends at OpenAI-compatible `/v1`, and has no embedded credentials/query/fragment. Health probes GET `<url>/models` and require the exact model. Environment/file credential references are mutually exclusive. Key files must be owner-only regular files with private parent directories, bounded to 16 KiB, outside Git repositories and with no file symlink. Resolved credential values never enter returned config or service definitions. Automatic frontier calls are prohibited regardless of configured endpoint kind.

`review_profile` defaults to the task's profile; an explicit binding must exist and use a local or hosted open-weight endpoint. Repository data policy and class qualification apply independently at review dispatch. All config/data/credential paths remain outside Spillway and target Git repositories. Config exports:

- `defaultConfigPath(): string`.
- `loadConfig(path?, overrides?: {dataDir?: string}): Promise<SpillwayConfig>`.
- `validateConfig(input: unknown, overrides?: {dataDir?: string}): Promise<SpillwayConfig>`.

Apply CLI data-directory overrides through validation, not by mutating the returned object. Effective default policy is included in validated config. `credentials.ts` exports `validateCredentialFile(path): Promise<string>` (canonical path, metadata validation) and `getEndpointCredential(endpoint): Promise<string | undefined>` (bounded credential resolution).

Policy v1 requires all six class entries `{local_eligible:boolean,review:ReviewTier}`, `max_repairs` 0/1 and integer `review_timeout_minutes` 1..30. Defaults: tests/small-fix/mechanical/small-feature are local eligible with local review; risky is not local eligible with frontier review; design is not local eligible and is rejected at admission. Default max repairs is 1 and review timeout 10 minutes. Hard invariants forbid local design and non-frontier risky review. `policy.ts` exports `defaultPolicy(): PolicyConfig`, `getPolicy(policy?): PolicyConfig` (deep validated copy), and `policySchema`. Public validation schemas are under `schemas/`.

## Durable records and queue

Task states: queued, dispatched, verifying, reviewing, ready, needs-repair, escalated, held, failed, abandoned, accepted, rejected. `TaskRecord` retains original Markdown, normalized spec, profile, required review tier, reason/timestamps and `nextAction`: worker, repair, review, frontier-worker, or null. Reasons never drive routing. Persisted attempts include `kind` worker/repair/frontier and nullable `parentAttemptId`; these additive fields remain optional in existing typed fixtures.

`Store` is concrete and synchronous in `store.ts`; only the service/controller opens it. Constructor `(dataDir)` migrates v1/v2/v3 to v4 without rewriting historical attempt evidence; `close()` releases the connection. WAL, foreign keys, explicit transactions and the controller lease are required.

| Method | Behavior |
| --- | --- |
| `addTask(spec,raw,profileId,reviewTier,admission?)` | Returns queued `TaskRecord`; transactional uniqueness/dependencies/events. |
| `listTasks()`, `getTask(id)` | Return fresh records; missing single task returns undefined. |
| `setTaskState(id,state,reason?)` | Legacy transition helper; derives/preserves appropriate action. |
| `setTaskAction(id,state,nextAction,reason?,reviewTier?)` | Atomically validates transition/action, strengthens review and appends events. |
| `setTaskReview(id,tier)` | Strengthening only; no changes after a terminal owner decision; repeated identical tier is a no-op. |
| `createAttempt(input: NewAttempt)` | Allocates attempt ID with placeholder worktree/log paths, then moves task dispatched with null action; shared global attempt/review/qualification slot enforced. |
| `updateAttempt(id,patch)` | Fills paths/metadata while running; finalized and uncertain records are immutable. |
| `finalizeAttempt(id,patch,state,reason?,reviewTier?,nextAction?)` | Atomic outcome/evidence/task/action/review/events; a terminal outcome is required. |
| `getAttempt(id)`, `listAttempts(taskId)` | Fresh records in attempt order; missing single attempt returns undefined. |
| `recoverInflight()` | Marks running workers and reviews uncertain and parents held/null; returns unresolved latest attempts, including prior interrupted recovery. |
| `hasUnresolvedExecution()` | Detects unresolved uncertain attempt or review fences. |
| `resolveUncertainty(taskId)` | Abandons held interrupted task after owner-stopped attestation; preserves uncertain evidence and releases its fence. |
| `acquireControllerLease(pid,nonce)`, `releaseControllerLease(nonce)` | Transactional singleton ownership; live PID cannot be stolen and release is nonce-specific. |
| `addEvent(taskId,type,payload)`, `listEvents(taskId)` | Transactional JSON event append and ordered fresh records. |

`finalizeAttempt` without its sixth argument derives worker for queued tasks, review for held completed verified results, and null for ready/terminal/other held work. Explicit action is preferred for Phase 2 continuation. Queued tasks require worker/repair; held/reviewing can await review; held/escalated can await frontier-worker. Running attempts remain active through independent verification. Repair parent must be the latest non-transport finalized committed attempt in the same task, have verification evidence and share the original base; only intervening transport failures can be skipped. The controller enforces task/policy repair and transport budgets.

JSON fields use JSON TEXT; readers return copies. Task listing and dispatch preserve durable admission order using SQLite rowid, including identical timestamps. Migration v3 adds reviews/settings and settings audit events. Infer pending review from held completed verified attempts, never terminal or uncertain work. Legacy stranded finalizations hold without rewriting evidence. One slot serializes running attempts, reviews and qualification jobs; unresolved interruption fences every inference/claim kind.

## Review contracts

`ReviewReport` is `{resultSha,verdict,findings}`: exact lowercase 40/64 hex SHA, verdict accept/needs-repair/reject, and at most 50 findings `{severity:'blocking' or 'warning',message,path?}`. Messages must be nonempty and at most 4000 characters; paths must be repository relative. Reject unknown/duplicate fields and accepting reports with blocking findings. `parseReviewReport(text)` accepts strict JSON or one complete `json` fence, no surrounding prose, with a 256 KiB report bound.

`ReviewRecord` stores task/attempt IDs, tier local/frontier, source service-local/owner-session, optional profile/model and immutable nullable modelArtifact/harness/harnessVersion dispatch snapshots, exact result SHA, outcome running/completed/failed/uncertain, immutable report/usage/log path, timestamps and reason. Owner-session is valid only for frontier; service-local only for local. This provenance is owner-attested, not verified vendor identity.

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

`Controller(config,store,adapter?,signal?)` exports `addTask(raw)`, `runOnce()`, `recover()`, `getDetail(id)`, `decide(id,decision,ownerMinutes?)`, `inspect(id)`, `reconcile(id)`, `waitForIdle()`, `getReviewPacket(id)`, `submitFrontierReview(id,report,meta?)`, `claimFrontier(id)` and `completeFrontier(id,attemptId)`. `runOnce()` executes at most one local worker/repair/review and returns task ID or null; pending frontier work can be skipped so local tasks continue. The controller owns admission, current policy/readiness, budgets and data permission. Tests may inject a fixture adapter; production configuration cannot select one.

HTTP binds to loopback. Ordinary API paths require `Authorization: Bearer TOKEN`; mutations never use dashboard cookies. JSON responses are `{data:...}`, failures `{error:{code,message}}` with safe messages/status. Reject foreign Host/Origin, unsupported content type, excessive body size, duplicate JSON keys, nonfinite numbers and unknown request fields.

| Method/path | Request | Response |
| --- | --- | --- |
| GET `/api/v1/status` | — | `{version,protocol:1,running,counts,frontier,evidence,audits}` |
| POST `/api/v1/tasks` | `{markdown:string}` | TaskRecord, 201 |
| GET `/api/v1/tasks` | — | TaskRecord[] |
| GET `/api/v1/tasks/:id` | — | `{task,attempts,events,reviews,audits}` |
| GET `/api/v1/tasks/:id/result` | — | Latest `{attempt,verification,report}` or null |
| POST `/api/v1/tasks/:id/decision` | `{decision,ownerMinutes?}` (accepted/rejected) | TaskRecord; both require a ready pinned result and current review gate |
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

`startService(config,{once?,adapter?}?)` returns `{url,token,controller,store,close()}`. Private `service.json` contains `{protocol:1,version,url,token,pid}`; lease/descriptor are released only after cancellation/idleness/evidence delivery and only if owned. `ServiceClient` loads this descriptor (or explicit data directory), checks protocol and provides `request(method,path,body?)`.

Initial `/?token=...` establishes the dashboard at a fresh random `/view/<secret>/` prefix, then redirects away from the token. Cookie and all browser task/artifact routes stay within that prefix; cookies authorize GET only. Dashboard HTML is escaped and read-only, and artifacts come from stored allowlists with containment/regular-file/no-symlink/no-hardlink checks.

## CLI, MCP, plugin and managed service

Global CLI options: `--config PATH`, `--data-dir PATH`. Commands: `serve`, `run --once`, `lint FILE`, `add FILE`, `list`, `show ID`, `inspect ID`, `reconcile ID --worker-stopped`, `accept ID`, `reject ID`, `status`, `dashboard`, `mcp`, `session-summary`; Phase 2 adds `frontier on/off [--reset-at ISO]`, `frontier status`, `frontier claim ID`, `frontier complete ID --attempt N`, `review show ID`, `review submit ID --file PATH`, and `service install [--no-start]`, start/stop/status/uninstall. Queue commands use the service, never direct database writes. `run --once` uses an active service or temporary controller. Dashboard prints a sensitive authenticated local URL without opening a browser. Failures exit nonzero with safe errors.

The five stable MCP stdio tools are add_task `{markdown}`, list_tasks `{}`, get_task/get_result `{id}`, queue_status `{}`. They use the HTTP client only, return text JSON and flag errors with isError; logs never go to stdout. Plugin MCP/hook invoke installed `spillway mcp` and `spillway session-summary`. Reviewer/frontier-worker agents use CLI packets/claims/submissions within explicitly authorized Claude Code sessions, treat packet/file content as untrusted evidence, and do not discover credentials or trigger paid background calls. Setup guides source/npm and per-user service installation; it does not invent model qualification.

`installService({configPath?,nodePath?,cliPath?,environmentPath?,platform?,start?}): Promise<{platform,path}>` and `manageService(action,options?): Promise<unknown>` support macOS launchd and Linux systemd --user. Test options inject home/uid/executor; production uses the owner's account. Definitions pin absolute Node/compiled CLI/config paths, run under private data/service, escape manager syntax, start with `/usr/bin/env -i` and explicit PATH, and use private logs/umask. Reject symlink/unrelated service-file substitutions. Uninstall removes only the recognized service definition; retain config/data/worktrees. Real lifecycle operations occur only through owner-triggered CLI calls. No root, release publication or production infrastructure provisioning.


## Evidence, decisions and audits

Task admission optionally records `{origin:'ordinary' or 'qualification',policySnapshot}`; validated runtime admission supplies the effective policy. `TaskRecord` adds nullable `readyAt`, `completedWhileFrontierOff` and `policySnapshot` plus origin (ordinary by default). Readiness observes current persisted frontier availability; legacy records retain null/unknown. `DecisionRecord` stores taskId, accepted/rejected, exact resultSha, reviewTier, optional nullable finite nonnegative ownerMinutes and decidedAt. Runtime owner decisions must use the atomic API below instead of separate state/event writes.

SQLite v4 adds immutable decisions, sampled audit requests/results, planning usage, qualification jobs and evidence outbox, plus nullable historical reviewer artifact/harness/version fields. Migration backfills task/settings snapshots with provenance `legacy-snapshot`; it never invents historical decisions, minutes or frontier availability. No-op state/review updates append no duplicate events/evidence.

| Store method | Contract |
| --- | --- |
| `recordDecision(taskId,decision,resultSha,ownerMinutes,selectAudit)` | Returns DecisionRecord; validates undecided ready/latest independently verified exact SHA and required accepting review, then atomically commits state/decision/audit/events/evidence. |
| `getDecision(taskId)`, `listDecisions()` | Fresh immutable owner decisions; missing single record returns undefined. |
| `listAudits(taskId?)`, `getAudit(id)` | Selected pending/completed audits; missing single record returns undefined. |
| `finishAudit(id,report,meta?)` | Returns immutable AuditRecord; strict exact accepted SHA, passed original verification, accepted recorded decision and pending-only finalization. Meta optionally reports model/Usage. Never changes acceptance/task state. |
| `addPlanningUsage(taskId,usage)`, `listPlanningUsage()` | Explicit nonempty finite nonnegative Usage records with owner-session planning provenance; missing fields stay absent. |
| `reportSnapshot()` | Consistent transactional fresh `{tasks,decisions,audits,planning,generatedAt}`; each task detail includes attempts/reviews/events/audits. |
| `listEvidence(afterId?,limit?)` | Ordered immutable EvidenceRecord copies; defaults 0/100, maximum page 1000. Includes delivered records for prefix verification. |
| `acknowledgeEvidence(throughId)` | Acknowledges only an existing ordered prefix; payloads are never deleted/rewritten. |
| `evidenceCounts()` | `{pending,delivered}`; projection delivery does not authorize any task mutation. |

`AuditRecord` is `{id,taskId,attemptId,resultSha,reviewTier,status,report,model,usage,createdAt,completedAt}`; tier is checks-only/local, status pending/completed, conclusions use strict ReviewReport. `audit_rate` defaults .30; selection occurs once at ordinary non-frontier owner acceptance. Rate 0/1 is deterministic for tests. Selected audits held by frontier availability or current data policy remain pending/selected, not dropped.

`EvidenceRecord` is `{version:1,id,kind,taskId,createdAt,provenance,data}`; nullable taskId covers settings/jobs, provenance is service/legacy-snapshot and data is a private snapshot. `EvidenceStatus` is `{pending,delivered,lastError}` with safe nullable delivery error. Snapshots may contain private specs/paths/evidence metadata and must never be published directly, even for public repositories.

`flushEvidence(store,dataDir): Promise<EvidenceStatus>` serializes writers per canonical directory, which must match `Store.dataDir`. `evidence.jsonl` uses ordered exact JSON envelopes, 64 KiB streamed reads and a 16 MiB line bound. Verify every complete prefix line against SQLite, recover only incomplete unacknowledged tail bytes, fsync file and directory, recheck file identity/ownership/links, then acknowledge. Complete-write-before-ack replay does not duplicate rows. Missing acknowledged evidence, complete tampering, unsafe file/parent, symlink/hardlink or wrong queue directory fails closed; preserve SQLite and complete file contents, expose health and retry. The production controller lease supplies cross-process singleton ownership. Shutdown awaits writer delivery before Store.close.

## Reports and public export

`report.ts` owns `Scorecard` and exports `buildScorecard(snapshot): Scorecard`, `formatReport(scorecard): string`. Scorecard v1 includes generatedAt, qualificationExcluded, task state/class/profile and owner outcome counts, recorded versus legacy decisions, accepted-while-off yes/no/unknown, attempts/repairs/transport/escalation counters, phase timing summaries, owner minutes, selected/completed/miss/pending audit counts, usage and frontierUsage. Legacy accepted/rejected states are known historical outcomes; missing original decision/readiness/minutes metadata stays unknown. Standalone qualification jobs are separate execution records; the qualificationExcluded count applies to banked qualification-origin tasks.

Ratios include numerator/denominator and nullable percent; denominator below 20 yields null. Usage fields include reported total, known/missing counts and nullable reported partial per-accepted value. Planning/worker/review/escalation/audit roles remain distinct; frontierUsage excludes local reviews. Missing observations are not zero. Checks overlap verification timing; audit timing is request-to-submission turnaround. No savings baseline is inferred.

`exportSanitized({snapshot,config,publicUrl,manifest?,verifyPublic?}): Promise<SanitizedExport>` returns a closed projection; verifyPublic is a test seam only. Production `verifyPublicGitHub(url)` anonymously checks the fixed `api.github.com/repos/OWNER/REPO` endpoint with bounded response/deadline, no redirects/credentials, and exact public URL/name/visibility. Require one matching explicit publication grant, then recheck it after the await. Export only that registered repository's ordinary tasks, including failed/held/abandoned outcomes; exclude qualification data.

Public output contains synthetic task/profile labels stable within this export, reviewed public repository URL, allowed class/tier/state/outcome enums and finite numeric timing/check/usage/owner decision/audit data. No original IDs, timestamps, private paths/names/endpoints, raw specs/prompts/commands/logs/errors/findings/notes. Export does not write or publish automatically.

Optional manifest is `{version:1,profiles:[{profileId,metadata}]}`; private profileId binds input only and never appears in output. Metadata requires model, exact 64-hex artifact SHA256, harnessVersion/serverVersion semver, SPDX-like license, contextTokens and structured numeric hardware. Reject unknown keys, duplicate profile bindings, suspicious secrets/URLs/IPs/private paths/network identifiers and historical/current binding mismatches. Missing/unpinned metadata, including old reviewer snapshots, remains unknown and sets reproducible false. No later current profile can certify an unknown historical reviewer. Reproducibility metadata remains explicitly owner-reviewed/reported.

## Qualification jobs and fixed workload

`qualification.ts` exports `runQualification(input): Promise<QualificationResult>`, `qualificationWorkloadHash()`, `observeToolEvidence(...)`, `qualificationMetadataSchema`, `validateCommunityProfile(value)` and `communityProjection(result,id)`. Input binds profile/endpoint/adapter, new private root, optional metadata/signal and real/fixture provenance. Controller-injected adapters always use fixture provenance. Exact catalog/model/harness version and an explicitly local endpoint are required; root must be an empty private directory outside Git.

The versioned Apache-2.0 workload has discovery/read-search/structured-edit/command/tool-error-recovery/test-driven-repair/multi-round cases in independent private Git repositories. SHA256 covers manifest/source/checks/tool fixtures. Existing harnesses perform bounded cases with protected checks/docs/expected fixtures/tools and source-only scope. Observed tool evidence requires correct paths, exact direct commands, actual outputs/exit status and failure/edit/pass ordering; multi-round requires three rounds and a full ledger read >=32,000 bytes. Its target value exists only in the ledger with protected hash acceptance. Final claims/malformed/truncated events never qualify.

HarnessInput gains optional finite temperature 0..2; the adapter defaults worker/reviewer sampling to zero and records primary/temperature privately. Explicit primary selection, custom-model temperature capability and disabled auxiliary/subagent/compaction inference establish one inference budget; task/skill/batch tools are denied. Installed-binary wire smoke checks actual requests, permissions and output. Qualification explicitly requests temperature 0 and concurrency 1 and records `requestedSettings` separately from operator-reported server/quantization/seed settings. Complete metadata requires artifact/hash/license/version/context/hardware/serverEngine/settings, matching runtime model/artifact/harness binding and requested temperature; unknown required metadata remains null; seed may be null when not configured. Missing required metadata, held/failed/timeout/uncertain cases or fixture provenance yields qualified false. A successful tool workload is scoped tool-workload-only and never automatically changes configured qualified_classes. Public community profiles require real, complete, passed observations and empty qualified_classes; broader class qualification remains separate.

`QualificationJobRecord` stores id, profileId, private root, running/completed/failed/uncertain status, start/end, nullable resultPath/reason/reconciledAt. All inference must persist a running job before any qualification subprocess:

- `createQualificationJob({id,profileId,root})`: same global active/uncertain slot as task attempts/reviews; root inside private data directory; returns durable running job.
- `getQualificationJob(id)`, `listQualificationJobs()`: fresh records.
- `finishQualificationJob(id,status,resultPath?,reason?)`: only running jobs finalize, result stays within private root; finalized/uncertain outcome immutable.
- `reconcileQualificationJob(id)`: only unreconciled uncertain job; records one owner-stopped timestamp, preserves outcome/evidence and releases fence.

Each job mutation appends taskId-null evidence. Recovery marks running jobs uncertain. Invalid metadata is rejected before creating a job. Root fsyncs result file/directories before finalization; returned uncertain execution or unexpected exceptions fence every worker/reviewer/claim/qualification until explicit owner-stop reconciliation. Returned known workload failures are completed observational results, not a qualified claim.

## Phase 3 authenticated HTTP and CLI

Existing protocol v1 and five MCP tools remain stable. Task detail adds audits; status adds evidence delivery and pending audit counts. Review logs remain stored allowlisted GET resources. Owner decision accepts optional ownerMinutes and returns TaskRecord via atomic decision recording.

| Method/path | Request | Response |
| --- | --- | --- |
| GET `/api/v1/report` | — | Scorecard |
| GET `/api/v1/evidence` | — | EvidenceStatus after draining the prefix committed at request entry (or visible delivery error) |
| POST `/api/v1/evidence/sync` | — | EvidenceStatus after draining the prefix committed at request entry (or visible delivery error) |
| GET `/api/v1/audits` | — | AuditRecord[] with derived held flag |
| GET `/api/v1/audits/:id/packet` | — | `{auditId,taskId,attemptId,resultSha,baseSha,rubric,task,verification,diff,source}` |
| POST `/api/v1/audits/:id/report` | `{report:ReviewReport,model?:string,usage?:Usage}` | Immutable completed AuditRecord |
| POST `/api/v1/tasks/:id/planning-usage` | `{usage:Usage}` | PlanningUsageRecord |
| POST `/api/v1/export` | `{publicUrl,manifest?}` | SanitizedExport, no publication |
| POST `/api/v1/qualify` | `{profileId,metadata?,background?:boolean}` | With background:true, 202 `{job}` after durable admission; otherwise synchronous `{jobId,result:QualificationResult}` |
| GET `/api/v1/qualifications/:id` | — | `{job,result:QualificationResult|null}` from private bounded managed result file |
| GET `/api/v1/qualifications` | — | QualificationJobRecord[] |
| POST `/api/v1/qualifications/:id/reconcile` | `{worker_stopped:true}` | Job retaining uncertain outcome and attestation timestamp |
| GET `/api/v1/endpoints` | — | Profile health `{profileId,healthy,reason?}` without URLs/secrets; no frontier probe |

Audit packet/submission requires frontier available plus current repository frontier-ok after awaited object/diff preparation. Use accepted immutable commit objects independent of current result branch/worktree; never edited residue. Audit submissions reject nonfinite usage, invalid/stale/replayed reports before completion and never rewrite task/decision history. All mutation routes remain bearer-only; dashboard cookies permit GET within the private prefix. Dashboard shows read-only scorecards, audit holds, endpoint health, qualification runs/results and safe evidence-delivery errors; no CDN/build chain or owner action buttons.

CLI adds `report [--json]`, `audit list`, `audit show ID`, `audit submit ID --file PATH`, `usage ID --file PATH`, `export --sanitized --repo URL [--profile-file PATH]` (sanitized JSON stdout), `qualify --profile ID [--metadata PATH]`, `qualify list`, `qualify show JOB-ID`, `qualify reconcile JOB-ID --worker-stopped`, and `accept/reject ID [--owner-minutes N]`. Qualification CLI requests background admission and returns immediately; service-owned execution retains the slot after client disconnect. Post-admission exceptions become durable uncertain jobs; pre-admission errors create no job. Shutdown rejects late admissions and awaits all HTTP route promises, including disconnected handlers, plus controller/background completion before the final evidence drain and SQLite closure. Clients never open SQLite or run a harness. Raw JSON files/requests reject duplicate keys and nonfinite numbers before mutation. Package/community validation and isolated-home smoke validate structure/fixtures; live Claude sessions, clean-OS onboarding, real accepted pilot evidence and complete real qualification metadata remain release gates. No 0.1.0 tag/publication is authorized by fixture success alone.
