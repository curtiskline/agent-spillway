# Decisions and assumptions

| ADR  | Decision                                                 | Rationale / status                                                                                                                              |
| ---- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 | TypeScript ESM, Node >=22.13, built-in SQLite            | Follows design recommendation, npm distribution, small dependency surface. Runtime feature supported by CI.                                     |
| 0002 | One loopback service with authenticated clients          | Durable execution independent of agent sessions; single writer/slot; no frontend framework.                                                     |
| 0003 | OpenCode provisional adapter                             | Documented JSON noninteractive runs and custom providers. No endpoint available, so real qualification/second harness spike pending.            |
| 0004 | Review gates fail closed                                 | Defaults remain local review; Phase 1 holds pending reviews. Checks-only requires explicit config opt-in; weakening/risky diffs force frontier. |
| 0005 | Explicit local-only registration and no remote dashboard | Avoid unsolicited hosted code transmission/cost. Remote access is later owner choice.                                                           |
| 0006 | SQLite transaction events, JSONL deferred                | Phase 3 will use outbox to avoid inconsistent dual writes.                                                                                      |
| 0007 | Apache-2.0 and DCO                                       | Explicit §7.2; no CLA introduced. Pre-alpha 0.0.0, no premature 0.1.0 release.                                                                  |

## Requirements clarified

- Spec §14 says start Phase 0/1 only. Architecture and plans cover later phases, implementation does not jump scope.
- No credentials/endpoint exist yet (owner confirmed 2026-10-12); fixture success is not a model capability result. Real harness spike blocks formal Phase 0 sign-off only, not authorized implementation.
- No-check task field wasn't named: use `no_checks_justification`. Readiness warnings cannot prove that a check distinguishes correct work; planner/reviewer and protected eval fixtures remain necessary.
- Base movement: dependencies require ancestry of the accepted result commit, not an owner's acceptance flag alone.
- `uncertain` is an attempt outcome, not an additional task state. Parent task holds; possible orphan workers fence the whole queue until the owner explicitly confirms termination and abandons interrupted execution through reconciliation. No automatic verification resumption in this milestone.
- Profile version pinned exactly; do not select another model or provider automatically.
- `frontier-ok` includes explicitly approved hosted open-weight destinations; no destination approved by default.
- Test weakening detection is conservative and heuristic, not a semantic guarantee; findings force later frontier review.
- Phase 1 checks-only is experimental explicit opt-in for the sample, not a promoted default class policy.

## External gates

Two-candidate real harness comparison; reliable frontier limit signal spike; live Claude plugin loading; real model qualification; package name reservation; full clean-machine release onboarding. No production infrastructure or meaningful financial cost authorized. Branch protection deferred until external contributors; secret scanning enabled before pushing implementation.
