# Decisions and assumptions

| ADR | Decision | Rationale / status |
| --- | --- | --- |
| [0001](decisions/0001-runtime.md) | TypeScript ESM, Node >=22.13 and built-in SQLite | Small dependency surface, npm/MCP integration and one local queue; CI verifies supported runtimes. |
| [0002](decisions/0002-review-and-recovery.md) | Reviews and acceptance fail closed | Phase 1 held pending model reviews; checks-only remains explicit opt-in. Phase 2 review execution extends this gate through ADR 0006. |
| [0003](decisions/0003-provisional-harness.md) | OpenCode initial adapter | Real LM Studio toy comparison with OpenCode 1.19.0 and Aider 0.86.2; structured events favored OpenCode. Broader qualification pending. |
| [0004](decisions/0004-execution-uncertainty.md) | Atomic finalization, controller lease and interruption fence | Transactional PID/nonce ownership; uncertain workers fence dispatch until owner reconciliation. Phase 2 applies the same fence to reviewers. |
| [0005](decisions/0005-dashboard-and-scope.md) | Private dashboard prefix and positive scope globs | Prevent loopback cross-port cookie confusion, artifact substitution and unintentionally permissive negation patterns. |
| [0006](decisions/0006-phase2-review-and-sessions.md) | Local reviews, bounded repairs, owner-session frontier and per-user services | Explicit Phase 2 authorization after PR #1; no automatic paid calls. Strict pinned reviews, shared slot, immutable evidence, private service/credential references. |

## Scope and owner decisions

- Design §14 originally limited implementation to Phase 0/1. PR #1 merged at main `1ab2878`; on 2026-10-12 the owner explicitly authorized Phase 2. [PHASE2.md](PHASE2.md) preserves the handoff, now consolidated in [ARCHITECTURE.md](ARCHITECTURE.md) and [INTERFACES.md](INTERFACES.md). Phase 3+ remains later work.
- Frontier work uses explicitly authorized Claude Code sessions only. No automatic paid model calls, account credential discovery, background frontier-provider integration or spending infrastructure.
- Policy remains deterministic. Defaults mirror design §6, including local review for straightforward classes. Risky review is always frontier, design work is rejected, and checks-only is experimental explicit opt-in rather than a promoted default.
- Local repair is bounded by both task attempt limit and policy maximum one repair; transport gets one free retry per task. One frontier-session worker attempt is allowed, then unresolved requests hold.
- Frontier availability starts off; manual ISO-offset reset scheduling represents an exact instant. This is not automatic vendor-limit detection.
- `frontier-ok` permits explicitly approved frontier sessions and hosted open-weight destinations; no destination is approved by default. Separate reviewer bindings must obey repository policy and qualification independently.

## Implementation assumptions and retained constraints

- The owner supplied a local LM Studio endpoint during Phase 1. Private address/config/raw logs stay outside the public checkout. Both real toy harness tasks passed independent checks after documented first-run failures; fixtures remain separate evidence.
- No-check tasks use `no_checks_justification`; lint cannot prove checks distinguish correct behavior. Review/protected acceptance fixtures remain necessary.
- Dependencies require the accepted result commit to be an ancestor of the resolved base, not merely an acceptance flag. Repairs keep their original base and committed parent; only transport outcomes can be skipped in lineage.
- `uncertain` is an execution outcome, not a task state. Interrupted workers/reviewers hold their parent and globally fence execution. Reconciliation requires owner-stopped attestation and abandons the task without rewriting evidence or reusing results.
- Profiles pin exact harness/model bindings; no automatic fallback. Owner-session provenance/model usage is attested/reported rather than cryptographically verified or invented.
- Test weakening detection is conservative and heuristic. Flags force frontier review; reports cannot replace independent clean-checkout checks.
- SQLite is the durable source of truth, including transactional task and settings audit events. Phase 3 JSONL will use an outbox to avoid inconsistent dual writes.
- Managed services clear inherited environment and pin absolute runtime/config paths. Explicit environment references remain available for foreground use; owner-only key-file references support private authenticated local endpoints without copying keys into config values, plist/unit files or logs.
- Dashboard stays loopback, authenticated and read-only. Harnesses/checks run as the owner's OS user; Spillway is not a sandbox. No automatic merge/push, deployment, telemetry or mandatory hosted dependency.
- Original code/docs use Apache-2.0 and contributions use DCO; no CLA introduced. Pre-alpha version remains 0.0.0 pending Phase 3 release gates.

## External gates

Broader real model qualification with exact artifact/license; reliable frontier limit signals; live Claude plugin loading; clean-machine onboarding; npm name reservation/publication (lookup returned 404 on 2026-10-12, no reservation performed). Live service/model results and Linux fixture validation must be reported separately, without claiming coverage that was not run. No production infrastructure or meaningful financial cost is authorized. Branch protection is deferred until outside contributors; secret scanning is required before public push.
