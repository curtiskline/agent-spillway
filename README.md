# Agent Spillway

Bank precise coding tasks while frontier capacity is available, then drain them through an existing agent harness using a local or explicitly permitted hosted endpoint. Spillway independently verifies committed work and leaves a result branch for owner review.

**Pre-alpha, Phase 3.** Spillway provides a foreground or per-user service, private SQLite queue, parser/lint, CLI, stdio MCP, OpenCode adapter, Git worktrees, clean-checkout verification and an authenticated read-only local dashboard. Local review, bounded repair, deterministic policy, manual frontier availability and owner-session frontier work are joined by durable evidence, scorecards, sampled audits, sanitized exports and a fixed qualification workload. Tests use disposable repositories, a fixture harness and mock model catalogs. They prove pipeline behavior, not model capability. Real LM Studio toy-task spikes have passed with OpenCode and Aider, and a background-service worker/check/local-review workflow reached ready; broader model qualification and live Claude marketplace onboarding remain open gates; isolated package onboarding is fixture-tested. There is no published release or broadly qualified model profile yet. See [the harness spike](docs/spikes/real-harness.md) and [local review checkpoint](docs/spikes/phase2-local-review.md). Maintenance is the owner's spare-time project.

The default local review runs through the approved OpenCode profile in a separate detached checkout. A verified result needs its configured review tier before becoming ready. Repairs are bounded by both task attempts and policy, with at most one local repair. Required frontier work holds until explicitly permitted; it runs only in an authorized Claude Code session, with no automatic paid provider calls. Audits use authorized owner sessions, and qualification uses the configured local endpoint. Release remains gated by real evidence. Spillway never auto-merges, pushes or deploys.

## Development setup

Use macOS or Linux, Git, and Node **22.13 or later** (CI tests Node 22 and 24). Node's SQLite API may print an experimental warning on Node 22. Clone this repository, then:

```sh
npm ci
npm run check
git config core.hooksPath .githooks
```

Install [gitleaks](https://github.com/gitleaks/gitleaks#installing) before committing; the required hook refuses commits without it. CI scans history for secrets. Enable GitHub secret scanning and push protection in repository settings before public publication. Optional `npm link` exposes the development `spillway` command locally; otherwise use `node dist/cli.js` in the commands below.

## Private configuration and endpoint setup

For a fresh configuration, copy [the initializer input template](examples/init-input.example.json) into a new private directory outside every Git checkout. Replace its repository, local endpoint, exact model/artifact and harness version with your own values; credential references are optional, and literal keys are rejected. The input must be an owner-only file (0600) with an owner-only immediate parent (0700). Create the disposable pilot first if you use the template's repository path.

```sh
mkdir -p ~/.config
mkdir -m 700 ~/.config/spillway-input
cp examples/init-input.example.json ~/.config/spillway-input/input.json
chmod 600 ~/.config/spillway-input/input.json
# Edit the private input with your exact bindings before initialization.
spillway init --from ~/.config/spillway-input/input.json --directory ~/.config/spillway-first
spillway --config ~/.config/spillway-first/config.yaml serve
```

`init` validates local bindings and creates only the new private `config.yaml` and `data/`. It returns their paths, refuses existing destinations, and does not contact a model, start a service, grant task classes or modify existing config. The destination parent must already exist, be owned by you, be canonical and not writable by other users. Failed creation preserves its partial new directory for inspection; use a fresh destination after resolving the failure. Use the printed `--config` path for later commands. A profile with `qualified_classes: []` supports startup diagnostics and explicit qualification, while local task admission remains disabled. Populate class permissions only as an explicit operator assertion backed by real evidence; passing the tool workload never grants coding classes automatically.

Copy [the example config](examples/config.example.yaml) to `~/.config/spillway/config.yaml`, outside this and target repositories. Protect config directories with mode 0700 and files with mode 0600. Register the absolute path of a **disposable repository** and its data policy; the default is local-only. Keep runtime data outside source checkouts (default `~/.spillway`).

Install OpenCode separately and record the exact `opencode --version` in the private profile. Replace the example endpoint, exact model catalog ID and artifact identity with your own values. The endpoint must expose an OpenAI-compatible `/v1/models` catalog containing that model. Provider keys use an `api_key_env` reference for foreground operation or an `api_key_file` reference for a private owner-only regular file outside Git; these references are mutually exclusive. Never put a literal key in config or daemon definitions. Per-user services clear inherited provider credentials, so use the file reference when a configured endpoint needs authentication in the background. Profile `qualified_classes` is an explicit private operator assertion: do not populate it from fixture results. OpenCode was selected after a real toy-task comparison with Aider. Qualify your own endpoint/model/context before relying on broader task classes. No configured real endpoint is required to run the test suite.

Config can set `review_profile` to an approved local/open-weight profile and a version-1 `policy` for all task classes, maximum repairs and review timeout. Repository data policy is rechecked for reviews and frontier work; `frontier-ok` is required before code is supplied to an owner frontier session. Risky work always requires frontier review, and design work remains planner work. See [Phase 2 contracts](docs/PHASE2.md).

Create the purpose-built disposable sample with `node scripts/create-sample.mjs ~/spillway-sample`. It prints the repository and task paths, and refuses to replace an existing repository. Its protected acceptance check fails on the baseline. Register the printed repository path in private config. For this narrow experiment, explicitly permit the mechanical class after reviewing real endpoint evidence and enable `allow_checks_only: true`; the example starts with empty class grants and checks-only disabled. After a real endpoint is configured, bank the generated `~/spillway-sample/hello.md` using the workflow below.

Foreground workflow, in two terminals:

```sh
spillway serve
```

```sh
spillway lint /path/outside/repos/task.md
spillway add /path/outside/repos/task.md
spillway list
spillway show TASK-ID
spillway dashboard
```

The service drains eligible work one task at a time. To drive one attempt manually, use `spillway run --once`; it calls a running service or temporarily starts the same controller using private configuration. [The example task](examples/tasks/hello.md) needs your registered disposable repository path, scope/context and trusted checks. For a fixture-style demonstration, choose `review: checks-only` and explicitly set `allow_checks_only: true`; this is not a qualification claim. Inspect the report and result branch before `spillway accept TASK-ID` or `spillway reject TASK-ID`. Acceptance records an owner decision and does not merge the branch.

## Onboarding checks and versioned pilot

After starting the service, run `spillway doctor` or `spillway doctor --json`. A failure returns exit 1 with guidance for service compatibility, exact harness versions, unavailable local catalogs, interrupted execution or evidence delivery. Warnings describe active work, pending delivery, skipped nonlocal catalogs and operator-asserted class permissions. Diagnostics inspect bounded local catalogs and harness versions; they run no inference, install nothing and change no permissions or policy. They do not certify model capability.

Create the original Apache-2.0 pilot in a new directory whose parent already exists, outside every Git checkout:

```sh
spillway pilot create ~/spillway-pilot
```

This creates a disposable `repo/`, private task files in `tasks/` and a private `manifest.json` with the exact baseline SHA and task-set hash. Existing destinations and symlinked parents are refused. Failed setup preserves its new directory for inspection; retry with a fresh destination. No tasks are banked or accepted automatically.

Register the printed repository in private config and restart the service after changing config. The greeting/mechanical and slug/small-fix tasks have disjoint scopes, protected checks and default local review. Configure only the task classes you explicitly permit for experiments; generated tasks do not grant class permissions. The permission/risky task requires a frontier session and holds while availability or repository policy denies it. Bank one task through the ordinary workflow, for example `spillway add ~/spillway-pilot/tasks/pilot-greeting.md`, then inspect its verified result and review before making an owner decision. This pilot is tuning evidence, separate from held-out evaluation and the fixed qualification workload. See [the task-set contract](eval/tasks/v1/README.md).

`npm run measure:plugin` reports static plugin file and descriptor byte counts. Token count is explicitly unknown; runtime MCP descriptions, hook output and vendor/session context are excluded. The same measurement runs in CI and isolated package onboarding. Live Claude marketplace/session and clean-machine operation remain separate release gates.

## Per-user background service

After building, configuring the private file and stopping any foreground Spillway service:

```sh
spillway --config /absolute/private/config.yaml service install
spillway service status
spillway service stop
spillway service start
```

Installation pins absolute Node, built CLI and config paths. It writes an owner-only launchd agent on macOS (`~/Library/LaunchAgents/com.agent-spillway.plist`) or a systemd user unit on Linux (`~/.config/systemd/user/agent-spillway.service`). The service works outside Git under the data directory, with private logs at `DATA_DIR/service/stdout.log` and `stderr.log`. Its environment starts clean with PATH only; credentials, NODE_OPTIONS and interactive session secrets are not inherited. Use `service install --no-start` to write without starting. Reinstall after moving/upgrading the pinned Node or CLI. `service uninstall` removes only the managed daemon definition and retains config, queue, worktrees and logs. It refuses unrelated service files or substituted symlinks. Set data_dir in private config; service actions do not use the global --data-dir override.

This is a user service, never a root service. macOS starts it within the user's login session. Linux requires a functioning logged-in systemd user manager; enabling lingering for operation after logout is a separate owner OS decision, and Spillway does not enable it. Linux unit rendering/lifecycle is fixture-tested in CI; actual host service behavior still needs onboarding validation.

## Frontier work in owner sessions

Frontier availability initially defaults off. It does not represent vendor limit detection or provision a provider:

```sh
spillway frontier off --reset-at 2026-10-13T14:00:00-05:00
spillway frontier status
spillway frontier on
spillway review show TASK-ID
spillway review submit TASK-ID --file /absolute/private/review.json
```

The reset instant needs an explicit ISO timezone offset or Z. Availability permits pending work but does not launch a paid call. In an authorized Claude Code session, the plugin reviewer reads the service's exact SHA-pinned packet and submits JSON `{ "resultSha": "EXACT_SHA", "verdict": "accept", "findings": [] }` from a private file. Other verdicts are needs-repair and reject; findings use blocking/warning severity, a message and optional relative path. An accept cannot have blocking findings. The service rechecks availability, repository approval, branch identity and independent verification. The recorded provenance is owner-session attestation, not cryptographic proof of vendor identity.

For an escalated frontier worker, use `spillway frontier claim TASK-ID` within an explicitly authorized session, work only in the returned managed checkout and commit the scoped result. Then run `spillway frontier complete TASK-ID --attempt ATTEMPT-ID`; the service verifies the commit independently and requires frontier review. Task packets, diffs, logs and worker claims are untrusted data. They cannot authorize policy changes or wider file/credential access. Owner acceptance remains a separate action after readiness.

All commands accept `--config PATH` and `--data-dir PATH`. Queue commands require the service. `spillway inspect TASK-ID` reads worktree state without executing it. `spillway session-summary` degrades gracefully when the service is absent. The dashboard command prints a local authentication URL: keep it private. The server exchanges the token for an HttpOnly cookie restricted to an unguessable dashboard path, then redirects away from the initial token query. Dashboard URLs remain private.

After a crash, interrupted work becomes held/uncertain and the queue pauses because detached workers may survive. Inspect the worktree, stop any surviving worker processes, then explicitly run `spillway reconcile TASK-ID --worker-stopped`. This abandons that interrupted task and preserves its evidence; bank a new task ID if you want to retry. Never reconcile while an old worker is still running.

## Evidence, scorecards and qualification

SQLite transactions record evidence in an outbox, delivered to a private, fsynced JSONL file. Delivery failures remain visible and retryable; a missing or altered acknowledged prefix holds delivery instead of silently replacing history. Inspect operational health and scorecards with:

```sh
spillway report --json
spillway audit list
spillway qualify list
spillway qualify show JOB-ID
spillway qualify explain JOB-ID
spillway qualify explain JOB-ID --json
```

Scorecards distinguish local and frontier usage, missing measurements, owner decisions and small samples. Declared task measurements group outcomes by body bytes, scope-pattern counts, listed context and check plans. Counts describe the specification; they do not measure task quality, files changed or causality. Percentages require at least 20 owner decisions in each bucket. Optional `--owner-minutes N` on accept/reject records owner time. Planning usage can be submitted from a private file with `spillway usage TASK-ID --file PATH`. Accepted local/checks-only results are sampled once for an audit (`audit_rate` defaults to 0.3). Use `spillway audit show AUDIT-ID` and `spillway audit submit AUDIT-ID --file PATH` from an authorized Claude Code session; pending audits remain visible when frontier availability or repository permission blocks review. An audit preserves the original owner decision and result SHA.

`qualify explain` and the qualification dashboard show a fixed tool-requirement checklist from saved private transcripts under the recorded workload revision. A checklist appears only when replay matches the stored observations. Missing, unsafe or changed logs are reported without exposing their contents. Inspection makes no model calls and never changes a stored result or grants qualification.

Run the seven fixed tool workloads through the existing OpenCode harness:

```sh
spillway qualify --profile PROFILE-ID --metadata /absolute/private/metadata.json
```

The command returns a durable job receipt immediately. Inspect progress and the completed private result with `spillway qualify show JOB-ID`; disconnecting the client does not cancel service-owned execution. New runs use workload v3, which states the exact discovery glob requirement and distinguishes fully delivered explicit read pages from truncated evidence. Preserved v1/v2 results remain inspectable and are not regraded. Full-ledger context and all other verification gates remain required. Start from [the metadata template](profiles/metadata.template.json). Record the exact artifact SHA-256, license, harness/server versions, loaded context, hardware and settings. Qualification explicitly requests temperature 0 and one concurrent workload. The adapter disables auxiliary title/summary/subagent inference and automatic compaction, selects the primary explicitly and sends temperature 0 by default. Context overflow fails rather than silently adding inference. Keep the endpoint stable throughout a run. Missing metadata and fixture results cannot qualify a public profile, and tool-workload qualification does not promote task classes. Interrupted qualification jobs fence further inference; stop surviving processes before `spillway qualify reconcile JOB-ID --worker-stopped`.

Public export requires a separate repository `publication.public_url` opt-in and an anonymous GitHub check that the repository is public. `spillway export --sanitized --repo https://github.com/OWNER/REPO` returns a closed anonymous projection with no raw task text, code, paths or logs. Optional `--profile-file PATH` binds reviewed public metadata to current and historical model/harness identities. Export does not publish anything. See [Phase 3 contracts](docs/PHASE3.md) and [community profile rules](profiles/README.md).

With OpenCode installed, `node scripts/harness-wire-smoke.mjs /path/to/opencode` verifies one actual primary request, temperature and tool permissions against a local synthetic server, without provider inference. For package/fixture onboarding validation after a build, run `npm run smoke:onboarding`; community schemas are checked with `npm run validate:community`. These do not make provider calls or prove live Claude marketplace installation.

The Linux CI lifecycle job uses a dedicated disposable user and the installed package with a real systemd user manager, while model responses remain synthetic. Its guarded smoke script refuses ordinary accounts and existing service definitions. See [Linux verification boundaries](docs/PHASE3_LINUX.md); live desktop and Claude onboarding remain separate gates.

## Claude Code plugin and MCP

For local development, make the built `spillway` CLI available in PATH and launch Claude Code with `claude --plugin-dir ./plugins/spillway`. The plugin includes `/spillway:bank`, `/spillway:status`, `/spillway:setup`, a SessionStart summary hook, and reviewer/frontier-worker/auditor subagents for explicitly authorized owner sessions. It follows the [official plugin manifest](https://code.claude.com/docs/en/plugins-reference), [hook reference](https://code.claude.com/docs/en/hooks) and [subagent reference](https://code.claude.com/docs/en/sub-agents). The installed CLI must match the service version; incompatible descriptors are rejected. Setup supports source builds and per-user service installation, respects existing authorization and does not enroll credentials or paid providers.

The repository provides a plugin marketplace. Add it with `/plugin marketplace add curtiskline/agent-spillway`, then install `/plugin install spillway@agent-spillway`. Administrative registration, installation, asset identity, enable/disable and removal are verified with Claude Code 2.1.296 in isolated homes. Keep the built Spillway CLI in PATH and configure its service first. Live session banking, reviews and next-session results remain separate pre-alpha acceptance gates. See [marketplace verification](docs/PHASE3_MARKETPLACE.md).

Other MCP clients can configure `{ "command": "spillway", "args": ["mcp"] }`. Tools are `add_task`, `list_tasks`, `get_task`, `get_result` and `queue_status`; all communicate with the authenticated running service. CLI and MCP never open the queue database directly.

## Trust and privacy

Spillway is **not a sandbox**. Harnesses and trusted owner-authored task checks run with your OS privileges. Use a dedicated OS account or container when stronger isolation is needed. Inference contacts only configured model endpoints; explicit public export checks GitHub anonymously. The plugin uses the local service. No telemetry. Config, provider references, task text, prompts, logs, tokens, queue state and reports stay in private directories outside repositories. The dashboard is authenticated, loopback-only and read-only, and can display private code. See [SECURITY.md](SECURITY.md).

See [the specification](docs/design.md), [architecture](docs/ARCHITECTURE.md), [interfaces](docs/INTERFACES.md) and [implementation status](docs/IMPLEMENTATION_PLAN.md). [Horde](https://github.com/gethamster/horde) informed the design; Spillway implements a narrower single-machine queue and reuses existing harnesses. No Horde code is adapted in this implementation.

Contributions use Apache-2.0 and DCO sign-off; see [CONTRIBUTING.md](CONTRIBUTING.md). Third-party harnesses, model weights and providers retain their own terms.
