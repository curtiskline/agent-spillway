# Phase 2 contracts and execution plan

Authorized 2026-10-12 after the owner asked to merge PR #1 and continue. PR #1 merged at main 1ab2878; work branch phase-2-review-and-service. This advances past design §14's initial stopping scope. The owner chose Claude Code sessions for frontier work, with no automatic paid calls. No background frontier provider/credentials/spending integration will be added.

## Architecture decisions

The service still owns policy, queue, worktrees, independent checks and acceptance. Default local review now executes using the local OpenCode adapter in an independent detached checkout with an explicit read-only agent. One local worker/reviewer slot serializes all model inference. Required frontier work holds while unavailable or forbidden by repo data policy. An authenticated owner session can claim an escalated worker or submit a frontier review; session provenance is owner-attested, never represented as cryptographically verified vendor identity. Do not obtain account credentials or make automatic frontier calls.

Review JSON: `{resultSha,verdict:'accept'|'needs-repair'|'reject',findings:[{severity:'blocking'|'warning',message,path?}]}`. Exact 40/64 hex SHA, known keys only, max 50 findings, messages <=4000 chars, paths repository relative. No accept with blocking findings. Invalid, missing, truncated, timed-out or mutating review holds with a visible reason. Rubric: requirement met, scope respected, tests meaningful/not weakened, obvious bugs, security-sensitive changes. Review never substitutes for clean-checkout verification. Model review is advice within the deterministic acceptance gate, never eligibility authority.

Repair is bounded by BOTH task max_attempts and policy max_repairs (hard maximum one local repair). Committed check failures or needs-repair reviews receive the failing logs, findings and cumulative diff in a fresh worker checkout started from the previous result commit. Archive the previous result branch without deleting its checkout/evidence. Preserve the original base SHA for all cumulative scope/protected checks. Transport failures get one free retry per task; repeated transport failures hold. Unsafe/dirty results hold or escalate rather than trusting worker residue. After local repair budget exhaustion, schedule frontier-session work or hold. No retry loops and no reruns of uncertain execution.

## Shared types and config

Types in src/contracts.ts. Config v1 gains optional `policy` and `review_profile`. Policy is version 1, classes for all six TaskClass values `{local_eligible,review}`, max_repairs 0/1, review_timeout_minutes 1..30. Defaults mirror design §6: tests/small-fix/mechanical/small-feature local + local review; risky not local + frontier review; design not local/rejected. Profile qualification is still required for local classes. Hard invariants reject local design and non-frontier risky review regardless of config. Checks-only requires global opt-in at admission/dispatch/readiness. review_profile defaults to task profile and must reference a configured local or approved open-weight endpoint; repository data policy checked independently for reviews.

TaskRecord gains nextAction: worker/repair/review/frontier-worker/null. Store controls transitions/action atomically, not prose reason parsing. Attempt kind worker/repair/frontier and parentAttemptId preserve repair lineage. Existing fixtures may omit these additive fields; persisted records provide them.

Managed services use a clean environment. For authenticated local servers, EndpointProfile may use `api_key_file` instead of `api_key_env` (mutually exclusive): explicit owner-only regular file and parent directory, outside any Git repository, bounded token content, no symlinks. `credentials.ts` validates/read-resolves the reference; values never enter config, plist/unit or logs. Tests use synthetic keys; no account credential discovery or automatic frontier calls.

## Store extensions (agent queue)

Migration v3 adds task next_action, attempt kind/parent_attempt_id, reviews table, settings table. Keep v1/v2 data immutable. Infer pending reviews from held completed verified attempts when migrating; do not revive terminal/uncertain work.

* `setTaskAction(id,state,nextAction,reason?,reviewTier?)` transactionally sets state/action/review/events.
* `finalizeAttempt(id,patch,state,reason?,reviewTier?,nextAction?)` gains sixth arg; omitted preserves legacy behavior with null for terminal/ready, review for held verified work, worker for queued.
* `createReview(input:NewReview):ReviewRecord`, `getReview(id)`, `listReviews(taskId)`; requires latest completed verified attempt and exact SHA, no concurrent review/attempt, task held/reviewing and nextAction review. Moves task reviewing.
* `finishReview(id,patch,state,nextAction,reason?)` atomically finalizes immutable review + task/action/events. Validate report SHA and verdict/finding integrity. Completed external source must tier frontier.
* `getFrontierState():FrontierState`, `setFrontierState(available,resetAt?:string|null)`: persisted initial off; ISO offset reset timestamp schedules off->on when read at/past reset. No automatic limit detection. Settings transitions remain auditable in private SQLite. Schedule interpretation UTC exact instant.
* Recovery: interrupted local reviews become uncertain, parent held/nextAction null and globally fence execution exactly as orphan worker recovery. `resolveUncertainty(taskId)` atomically abandons interrupted attempt OR review after owner worker-stopped attestation. Persisted uncertain evidence remains immutable. `createAttempt` respects uncertain-review fences too.

## Execution/review modules (agent execution)

* HarnessInput purpose optional worker/review. OpenCode review mode selects `spillway-review` primary agent: deny all mutating tools/bash/network/subagents, permit read/glob/grep within checkout only, same isolated provider/model. Always bounded, final stop required.
* `review.ts` exports `REVIEW_RUBRIC:string`, `parseReviewReport(text:string):ReviewReport`, `runLocalReview(input:LocalReviewInput):Promise<LocalReviewResult>`. JSON optionally in one complete json fence, no prose. Prompt includes task, pinned diff, checks/results and rubric; impose 128 KiB prompt bound. Use detached checkout with collision-safe review paths (createVerification with negative numeric IDs? NO; choose unique positive ID allocated from review ID namespace by caller, see below). Check HEAD/ref/tracked/untracked cleanliness before+after; no mutation; cleanup only exact managed checkout. Never persist artifacts within checkout. logPath artifactDir/reviewer.log.
* WorkspaceContract/GitWorkspace `createReviewVerification(commit,reviewId)` creates detached `worktrees/review-<reviewId>`, separate from worker/verification names. LocalReviewInput gains reviewId. Cleanup uses existing exact-managed removeVerification and post-review HEAD/status comparisons. Original attempt identity remains unchanged.
* GitWorkspace `archiveWorker(path,taskId,attemptId):Promise<string>` renames exact managed branch to spillway/<id>-attempt-<attemptId>, preserves dirty checkout; refuses unexpected branch/path. Repair starts via existing createWorker from result SHA; original base SHA remains in attempt verification. Existing transport archive unchanged.

## Owner-session frontier and HTTP (orchestrator)

Bearer-only mutation paths; browser remains read-only.

* GET/POST `/api/v1/frontier`: read FrontierState / body `{available:boolean,resetAt?:ISO|null}`. Off->on resumes only policy-permitted pending work.
* GET `/api/v1/tasks/:id/review`: owner frontier packet `{taskId,attemptId,resultSha,rubric,task,verification,diff}`; requires frontier available, repo frontier-ok, pending frontier review and unchanged verified branch. Packet is untrusted task data.
* POST `/api/v1/tasks/:id/review`: `{report:ReviewReport,model?:string,usage?:Usage}`; service rechecks availability, data policy, latest verified attempt SHA, unchanged branch and verdict. Owner-session provenance, immutable review, no direct acceptance of worker claims.
* POST `/api/v1/tasks/:id/frontier-claim`: owner claims nextAction frontier-worker while frontier available and repo frontier-ok; creates managed attempt/worktree, returns prompt + paths + immutable base. Dependencies must be accepted and merged into the pinned base. At most one active global slot; no subprocess/provider invoked by service.
* POST `/api/v1/tasks/:id/frontier-complete`: `{attemptId:number}`; validate claimed latest active frontier attempt, independent verification, then pending frontier review. Completion runs local verification even while frontier is off; new packet/claim/review work remains gated. No owner result/done assertion bypasses checks.

## Thin clients/plugin/service management (agent clients)

CLI `frontier on|off [--reset-at ISO]`, `frontier status`, `frontier claim ID`, `frontier complete ID --attempt N`; `review show ID`, `review submit ID --file PATH`. Existing five MCP tools stay stable; plugin reviewer/frontier worker use CLI packet/submit in authorized sessions. ServiceClient public error code allowlist extended as needed without exposing arbitrary messages.

`service-manager.ts`: export `installService({configPath?,nodePath?,cliPath?,environmentPath?,platform?,start?:boolean}):Promise<{platform,path}>`, `manageService(action:'start'|'stop'|'status'|'uninstall',options?:{platform?}):Promise<unknown>`. macOS launchd user agent first, Linux systemd --user implementation/fixture validation. No root, no shell interpolation, escape plist/unit values, private logs/env/path locations, PATH only credential-free environment. Don't copy provider credentials into manager files. node/cli/config paths explicit absolute pinned; config stays private; service runs outside repos. install updates only its known service file, fail on unrelated content, no deletes of data/config/worktrees. Systemd/launchctl real calls only owner-triggered CLI actions; tests render/use fixture command injection not actual user services. CLI `service install [--no-start]`, start/stop/status/uninstall. Per-user install is reversible and authorized by this Phase 2 request; don't provision infrastructure or publish a release.

Plugin adds concise reviewer and frontier-worker agents with rubric/owner-session provenance/injection boundaries. Setup skill guides npm/source install and service install, honors already-given authorization, never configures credentials/paid providers or invents qualification. Measure raw context text size before release; manifests/hook/live local read-only session smoke where possible without paid calls.

## Ordered tasks, ownership and acceptance

| Task | Dependencies | Ownership | Done |
|---|---|---|---|
| P20 architecture/contracts | merged Phase 1 | orchestrator docs/types | frozen before agents |
| P21 policy/config/store | P20 | queue: src/policy.ts, config.ts, store.ts, schemas; related tests | migration, atomic transitions, review stale/replay/fences, availability/reset tests + type/lint |
| P22 read-only review + continuation | P20 | execution: src/review.ts, harness.ts, git.ts; related tests | exact JSON/SHA/verdict, mutations/truncation, read-only config, preservation + type/lint |
| P23 clients/plugin/service | P20 | clients: src/service-manager.ts, cli.ts, client.ts, mcp.ts, plugins; tests; README | manager escaping/privacy/lifecycle, CLI routing, manifests/hook + type/lint |
| P24 controller/API/integration | P21/P22 frozen contracts | orchestrator src/controller.ts/server.ts; tests; examples/docs | local review->ready, repair->review, frontier off/local continues, owner-session stale denied, actual background service + real local sample |
| P25 independent review | P21–P24 | read-only reviewer, orchestrator fixes | integrity/auth/process/budgets/data policy independently reviewed, full suite + CI + secret scans |

P21/P22/P23 disjoint concurrently. No architectural authority delegated. Phase 3 scorecard/audits/export/qualification/release and Phase 4/5 remain later work; don't claim them complete.
