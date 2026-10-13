# Decisions and assumptions

New runs use workload v3. V2 disclosed the existing discovery predicate; v3 corrects pagination being classified as lost transcript evidence. Result format version stays 1 and supported suite versions are 1, 2 and 3. Preserve v1/v2 assets, observers and outcomes without regrading. Explicit page delivery needs positive structured/rendered proof; full-ledger context, protected files, inference budgets and promotion/publication gates remain required.

| ADR | Decision | Rationale / status |
| --- | --- | --- |
| [0001](decisions/0001-runtime.md) | TypeScript ESM, Node >=22.13 and built-in SQLite | Small dependency surface, npm/MCP integration and one local queue; CI verifies supported runtimes. |
| [0002](decisions/0002-review-and-recovery.md) | Reviews and acceptance fail closed | Phase 1 held pending model reviews; checks-only remains explicit opt-in. Phase 2 review execution extends this gate through ADR 0006. |
| [0003](decisions/0003-provisional-harness.md) | OpenCode initial adapter | Real LM Studio toy comparison with OpenCode 1.19.0 and Aider 0.86.2; structured events favored OpenCode. Broader qualification pending. |
| [0004](decisions/0004-execution-uncertainty.md) | Atomic finalization, controller lease and interruption fence | Transactional PID/nonce ownership; uncertain workers fence dispatch until owner reconciliation. Phase 2 applies the same fence to reviewers. |
| [0005](decisions/0005-dashboard-and-scope.md) | Private dashboard prefix and positive scope globs | Prevent loopback cross-port cookie confusion, artifact substitution and unintentionally permissive negation patterns. |
| [0006](decisions/0006-phase2-review-and-sessions.md) | Local reviews, bounded repairs, owner-session frontier and per-user services | Explicit Phase 2 authorization after PR #1; no automatic paid calls. Strict pinned reviews, shared slot, immutable evidence, private service/credential references. |
| [0007](decisions/0007-phase3-evidence-and-evaluation.md) | Transactional evidence, sampled owner-session audits and reproducible evaluation | Explicit Phase 3 authorization after PR #2; crash-safe private delivery, truthful small-sample reports, publication opt-in, pinned tool qualification and durable job fences. |
| [0008](decisions/0008-versioned-workload-correction.md) | Version discovery instruction correction without regrading | Make the exact existing glob predicate explicit in v2, preserve v1 assets/results and strict historical parsing. |
| [0009](decisions/0009-read-pagination-evidence.md) | Version complete-page evidence correction | OpenCode marks normal pagination as truncated; prove complete explicit pages while preserving loss detection, full-context requirements and history. |
| [0010](decisions/0010-onboarding-and-pilot.md) | Service diagnostics and versioned disposable pilot before wider automation | Finish Phase 3 onboarding/evaluation without inference, implicit acceptance or release claims. |
| [0011](decisions/0011-saved-diagnostics-and-spec-measurements.md) | Saved-observation parity before checklists; declared-only task measurements | Explain failures without regrading; retain unknowns, public permissions and small-sample owner denominators. |
| [0012](decisions/0012-private-configuration-bootstrap.md) | Empty grants and exclusive private setup | Qualification before task permission; bounded read-only planning and local-only starter creation. |

## Scope and owner decisions

- Design §14 originally limited implementation to Phase 0/1. PR #1 merged at main `1ab2878`; on 2026-10-12 the owner explicitly authorized Phase 2. [PHASE2.md](PHASE2.md) preserves the handoff, now consolidated in [ARCHITECTURE.md](ARCHITECTURE.md) and [INTERFACES.md](INTERFACES.md). PR #2 subsequently merged at main `079478a`; the owner authorized Phase 3, preserved in [PHASE3.md](PHASE3.md) and consolidated here. Release and Phase 4/5 remain gated.
- Frontier work uses explicitly authorized Claude Code sessions only. No automatic paid model calls, account credential discovery, background frontier-provider integration or spending infrastructure.
- Policy remains deterministic. Defaults mirror design §6, including local review for straightforward classes. Risky review is always frontier, design work is rejected, and checks-only is experimental explicit opt-in rather than a promoted default.
- Local repair is bounded by both task attempt limit and policy maximum one repair; transport gets one free retry per task. One frontier-session worker attempt is allowed, then unresolved requests hold.
- Frontier availability starts off; manual ISO-offset reset scheduling represents an exact instant. This is not automatic vendor-limit detection.
- `frontier-ok` permits explicitly approved frontier sessions and hosted open-weight destinations; no destination is approved by default. Separate reviewer bindings must obey repository policy and qualification independently.

## Implementation assumptions and retained constraints

- The owner supplied a local LM Studio endpoint during Phase 1. Private address/config/raw logs stay outside the public checkout. Both real toy harness tasks passed independent checks after documented first-run failures; fixtures remain separate evidence.
- No-check tasks use `no_checks_justification`; lint cannot prove checks distinguish correct behavior. Review/protected acceptance fixtures remain necessary.
- Dependencies require the accepted result commit to be an ancestor of the resolved base, not merely an acceptance flag. Repairs keep their original base and committed parent; only transport outcomes can be skipped in lineage.
- `uncertain` is an execution outcome, not a task state. Interrupted workers/reviewers hold their parent and qualification jobs retain an uncertain outcome; both globally fence execution. Reconciliation requires owner-stopped attestation and abandons interrupted tasks or records one qualification-job attestation timestamp, without rewriting evidence/outcome or reusing results.
- Profiles pin exact harness/model bindings; no automatic fallback. Local reviews record immutable dispatched artifact/harness/version; legacy reviewer metadata remains unknown and cannot be certified from current profiles. Owner-session provenance/model usage is attested/reported rather than cryptographically verified or invented.
- Test weakening detection is conservative and heuristic. Flags force frontier review; reports cannot replace independent clean-checkout checks.
- SQLite is the durable source of truth, including transactional task and settings audit events. SQLite v4 now appends immutable outbox snapshots transactionally; JSONL verifies/replays ordered prefixes and fsyncs before acknowledgement. Delivery errors never undo committed decisions.
- Managed services clear inherited environment and pin absolute runtime/config paths. Explicit environment references remain available for foreground use; owner-only key-file references support private authenticated local endpoints without copying keys into config values, plist/unit files or logs.
- Dashboard stays loopback, authenticated and read-only. Harnesses/checks run as the owner's OS user; Spillway is not a sandbox. No automatic merge/push, deployment, telemetry or mandatory hosted dependency.
- Original code/docs use Apache-2.0 and contributions use DCO; no CLA introduced. Pre-alpha version remains 0.0.0 pending Phase 3 release gates.

## Phase 3 measurement and publication decisions

- Owner decisions and optional minutes commit atomically with state/evidence and sampled ordinary non-frontier audits. Audit rate defaults .30; policy/availability holds stay visibly pending and remain in selected denominators.
- Audits use immutable accepted commit objects, remain valid after normal merge/result branch removal, reject stale/replayed conclusions, and never rewrite acceptance. Owner sessions only; no service model invocation. Needs-repair/reject counts as a miss; accept with warnings does not.
- Reports exclude qualification from ordinary acceptance, preserve legacy unknown readiness/minutes/bindings, separate local and reported frontier usage, and show field coverage. Percentages require at least 20 observations; missing cost/tokens are not zero and no savings baseline is inferred.
- Publication is a separate absent-by-default repository grant, never inferred from inference policy or a repository path/name. Anonymous fixed GitHub verification fails closed on private/unavailable/rate-limited responses. Export is a closed anonymous outcome projection; reviewed manifests cannot expose arbitrary private text or certify unknown historical execution. No automatic publication.
- Actual OpenCode logs and a wire fixture exposed automatic concurrent title inference and ignored custom-model temperature. Disable auxiliary/subagent/automatic compaction work, explicitly select primaries, declare model temperature support and default sampling to zero. Preserve output bounds/acceptance criteria; actual wire checks must verify settings before real retests.
- Qualification pins the workload hash and requires observed tool/path/command/output/order evidence. Temperature 0/concurrency 1 is explicitly requested; server/hardware/license/artifact/settings metadata is operator-reported. Fixtures and missing metadata cannot qualify; tool-workload-only public profiles claim no coding classes and never auto-update qualified_classes.
- CLI qualification uses background durable admission and separate result inspection to avoid long HTTP headers timeouts. Service shutdown awaits background runners; a disconnected client does not imply a stopped worker.
- Persist qualification jobs before launch and fsync results/directories before finalization. Unknown/returned uncertain execution survives restart as a global fence until explicit owner-stopped reconciliation. Invalid metadata creates no job.

## External gates

Complete reproducible real model/artifact/license/server/settings metadata and broader coding-class qualification; real accepted ordinary pilot work; reliable frontier limit signals; live Claude session/marketplace loading; clean-OS onboarding; npm name reservation/publication (lookup returned 404 on 2026-10-12, no reservation performed). Live service/model results and Linux fixture validation must be reported separately, without claiming coverage that was not run. No production infrastructure or meaningful financial cost is authorized. Branch protection is deferred until outside contributors; secret scanning is required before public push.

ADR [0011](decisions/0011-saved-diagnostics-and-spec-measurements.md) records owner-authorized PR #4 continuation: saved transcript parity before explanations, declared-only task measurements, immutable historical grades and no additional inference.

ADR [0012](decisions/0012-private-configuration-bootstrap.md) records empty class grants for qualification-only setup and exclusive private initialization after PR #5 merge.


ADR [0013](decisions/0013-linux-service-verification.md) records real systemd lifecycle verification with a dedicated disposable CI account and synthetic responses; no runtime contract or release-gate changes.


ADR [0014](decisions/0014-marketplace-installation-verification.md) separates actual administrative marketplace lifecycle verification from model/session/owner evidence.
