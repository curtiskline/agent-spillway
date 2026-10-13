# Phase 3 Linux service verification

Authorized 2026-10-13 after PR #6 merged at `8716481`. At the start of this wave the Linux lifecycle gate had renderer/executor fixtures only. Exercise the installed package with the real systemd user manager on an ephemeral Ubuntu CI host. This is operational service evidence with synthetic model responses, not real qualification, desktop onboarding, owner acceptance or release.

## Frozen boundaries

No application API, schema, policy, migration or dependency changes are planned. Add a CI-only smoke script requiring Linux, a non-root disposable account named `spillway-ci`, and explicit opt-in. Require an absent Spillway unit (including links) and accessible user manager before mutations. Use the installed npm package, actual CLI and real manager calls; no manager executor injection. All config, repositories, tokens, logs and evidence belong in the disposable home outside the checkout. Never alter another user's manager, account or configuration.

CI provisions the dedicated account with a new home outside Git, enables lingering and starts its manager, then invokes the script with a clean environment as that user. Lingering is an explicit CI host step, never an automatic application operation. Cleanup runs after failures and stops/removes only this dedicated account. Repository permissions remain read-only; no real provider credentials are passed.

The script builds no code and accepts an absolute installed package path. Create private config, a real Git pilot, a local synthetic catalog and fixture harness. Exercise install without start, start, authenticated queue operations, bounded fixture completion through independent checks/review, stop/start, reinstall changed pins while active, and uninstall. Verify actual status/PID changes, persisted task/result identity and evidence prefix, private modes, synthetic inherited-key sentinels absent from daemon environment, data/config/log preservation and unrelated-unit refusal. Never accept/merge tasks or promote a model. Bound all waits/requests/processes. Print only fixed stage failures or synthetic aggregate results; no tokens, environment dumps or raw artifacts. Cleanup only the unit installed by this invocation; preserve partial data until CI removes the disposable account.

## Tasks and ownership

| Task | Dependencies / owner | Deliverables and done criteria |
| --- | --- | --- |
| L30 | PR #6 / root | Freeze boundaries/ownership. Root owns docs, package script and workflow. |
| L31 | L30 / clients | Own scripts/systemd-smoke.mjs and tests/systemd-smoke.test.ts only. Real-manager packaged lifecycle smoke and meaningful fail-closed preflight tests on ordinary CI/Mac; component checks. No runtime edits. |
| L32 | L31 / root | Disposable-user Ubuntu job, clean package transfer/cleanup, actual green lifecycle run; full checks/package/wire verification. |
| L33 | L31/L32 / execution + independent security reviewer | Read-only operational/data-preservation/isolation review. Root fixes findings, records exact CI evidence and creates PR. |

Disjoint ownership; no agent commits or shared edits. Actual Linux verification requires a successful real-manager run; unavailable user-manager capability fails rather than skips. Other Phase 3 gates remain unchanged.

Sources: systemd's [loginctl documentation](https://github.com/systemd/systemd/blob/main/man/loginctl.xml) describes lingering; [user manager documentation](https://github.com/systemd/systemd/blob/main/man/user%40.service.xml) describes user@UID.service and its runtime directory.

## Verification checkpoint

Local full suite: 610 tests/45 files, typecheck/lint/build pass. The 45 new checks cover argument/account/opt-in refusals, preexisting/dangling definitions and enable links, no-write ordinary-host refusal, and the actual fixture subprocess's baseline failure/source-only commit/protected check/read-only review. Source/package onboarding and installed OpenCode wire checks pass. Independent operational review has verified the corrected enable-link guard. Actual systemd manager operations cannot run on the Mac host; they were subsequently verified in dedicated Ubuntu CI.

Final independent security review passed 45 checks after adding refusal for orphan systemd overrides across the actual manager UnitPath roots (specific, dash-prefix and type-wide). Installation without start also checks effective DropInPaths before first execution. No application implementation changes were needed.

L30–L33 complete: code head `ba8dee2` passed the [actual Ubuntu24.04/Node24 systemd lifecycle job](https://github.com/curtiskline/agent-spillway/actions/runs/38409471100/job/115337675500), including provisioning, packaged CLI operations and dedicated-account cleanup. Linux Node22/24 and macOS Node24 full checks/package onboarding, installed-harness wire checks on Linux Node24 and secret scanning also pass. [PR #7](https://github.com/curtiskline/agent-spillway/pull/7) records this wave. This verifies operations on the tested ephemeral Linux host; real model qualification, owner decisions, live desktop/Claude sessions and release remain separate evidence gates.
