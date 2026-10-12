# Decisions and assumptions

| ADR  | Decision                                                 | Rationale / status                                                                                                                                                                                          |
| ---- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 | TypeScript ESM, Node >=22.13, built-in SQLite            | Follows design recommendation, npm distribution, small dependency surface. Runtime feature supported by CI.                                                                                                 |
| 0002 | One loopback service with authenticated clients          | Durable execution independent of agent sessions; single writer/slot; no frontend framework.                                                                                                                 |
| 0003 | OpenCode initial adapter                                 | Documented JSON noninteractive runs and custom providers. Real LM Studio toy spike completed with OpenCode 1.19.0 and Aider 0.86.2. OpenCode selected for structured events; broader qualification pending. |
| 0004 | Review gates fail closed                                 | Defaults remain local review; Phase 1 holds pending reviews. Checks-only requires explicit config opt-in; weakening/risky diffs force frontier.                                                             |
| 0005 | Explicit local-only registration and no remote dashboard | Avoid unsolicited hosted code transmission/cost. Remote access is later owner choice.                                                                                                                       |
| 0006 | SQLite transaction events, JSONL deferred                | Phase 3 will use outbox to avoid inconsistent dual writes.                                                                                                                                                  |
| 0007 | Apache-2.0 and DCO                                       | Explicit §7.2; no CLA introduced. Pre-alpha 0.0.0, no premature 0.1.0 release.                                                                                                                              |

## Requirements clarified

- Spec §14 says start Phase 0/1 only. Architecture and plans cover later phases, implementation does not jump scope.
- Owner supplied a local LM Studio endpoint during implementation (2026-10-12). Its address, private configuration and raw spike logs remain outside the public checkout. Both real harness toy tasks passed independent verification after documented failed first runs; fixture success remains separate.
- No-check task field wasn't named: use `no_checks_justification`. Readiness warnings cannot prove that a check distinguishes correct work; planner/reviewer and protected eval fixtures remain necessary.
- Base movement: dependencies require ancestry of the accepted result commit, not an owner's acceptance flag alone.
- `uncertain` is an attempt outcome, not an additional task state. Parent task holds; possible orphan workers fence the whole queue until the owner explicitly confirms termination and abandons interrupted execution through reconciliation. No automatic verification resumption in this milestone.
- Profile version pinned exactly; do not select another model or provider automatically.
- `frontier-ok` includes explicitly approved hosted open-weight destinations; no destination approved by default.
- Test weakening detection is conservative and heuristic, not a semantic guarantee; findings force later frontier review.
- Phase 1 checks-only is experimental explicit opt-in for the sample, not a promoted default class policy.

## External gates

Broader model qualification with exact artifact/license; reliable frontier limit signal spike; live Claude plugin loading; real model qualification; package name reservation (npm lookup returned 404 on 2026-10-12; no reservation/publication performed); full clean-machine release onboarding. No production infrastructure or meaningful financial cost authorized. Branch protection deferred until external contributors; secret scanning enabled before pushing implementation.
