# Agent Spillway

Bank precise coding tasks while frontier capacity is available, then drain them through an existing agent harness using a local or explicitly permitted hosted endpoint. Spillway independently verifies committed work and leaves a result branch for owner review.

**Pre-alpha, Phase 0/1.** The walking skeleton provides a foreground service, private SQLite queue, parser/lint, CLI, stdio MCP, provisional OpenCode adapter, Git worktrees, clean-checkout verification and a read-only local dashboard. Tests use disposable repositories, a fixture harness and mock model catalogs. They prove pipeline behavior, not model capability. A real endpoint harness comparison and clean-machine onboarding remain open gates. There is no published release or qualified model profile yet. Maintenance is the owner's spare-time project.

Local/frontier model review, bounded repair/escalation, service installation, frontier availability controls, audits, scorecards, exports and qualification commands are later milestones. The default review gate holds verified results pending review. Only explicit checks-only tasks, permitted by private config and free of policy flags, can become ready in this milestone. Spillway never auto-merges, pushes or deploys.

## Development setup

Use macOS or Linux, Git, and Node **22.13 or later** (CI tests Node 22 and 24). Node's SQLite API may print an experimental warning on Node 22. Clone this repository, then:

```sh
npm ci
npm run check
git config core.hooksPath .githooks
```

Install [gitleaks](https://github.com/gitleaks/gitleaks#installing) before committing; the required hook refuses commits without it. CI scans history for secrets. Enable GitHub secret scanning and push protection in repository settings before public publication. Optional `npm link` exposes the development `spillway` command locally; otherwise use `node dist/cli.js` in the commands below.

## Private configuration and provisional endpoint setup

Copy [the example config](examples/config.example.yaml) to `~/.config/spillway/config.yaml`, outside this and target repositories. Protect config directories with mode 0700 and files with mode 0600. Register the absolute path of a **disposable repository** and its data policy; the default is local-only. Keep runtime data outside source checkouts (default `~/.spillway`).

Install OpenCode separately and record the exact `opencode --version` in the private profile. Replace the example endpoint, exact model catalog ID and artifact identity with your own values. The endpoint must expose an OpenAI-compatible `/v1/models` catalog containing that model. Provider keys use an `api_key_env` reference; never put a literal key in config. Profile `qualified_classes` is an explicit private operator assertion: do not populate it from fixture results. OpenCode remains provisional until real tool-calling behavior is tested against two candidate harnesses. No configured real endpoint is required to run the test suite.

Create the purpose-built disposable sample with `node scripts/create-sample.mjs ~/spillway-sample`. It prints the repository and task paths, and refuses to replace an existing repository. Its protected acceptance check fails on the baseline. Register the printed repository path in private config. For this narrow experiment, explicitly enable `allow_checks_only: true`; the example defaults to false. After a real endpoint is configured, bank the generated `~/spillway-sample/hello.md` using the workflow below.

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

All commands accept `--config PATH` and `--data-dir PATH`. Queue commands require the service. `spillway inspect TASK-ID` reads worktree state without executing it. `spillway session-summary` degrades gracefully when the service is absent. The dashboard command prints a local authentication URL: keep it private. The server exchanges the token for an HttpOnly cookie restricted to an unguessable dashboard path, then redirects away from the initial token query. Dashboard URLs remain private.

After a crash, interrupted work becomes held/uncertain and the queue pauses because detached workers may survive. Inspect the worktree, stop any surviving worker processes, then explicitly run `spillway reconcile TASK-ID --worker-stopped`. This abandons that interrupted task and preserves its evidence; bank a new task ID if you want to retry. Never reconcile while an old worker is still running.

## Claude Code plugin scaffold and MCP

For local development, make the built `spillway` CLI available in PATH and launch Claude Code with `claude --plugin-dir ./plugins/spillway`. The scaffold includes `/spillway:bank`, `/spillway:status`, `/spillway:setup`, five MCP tools and a SessionStart summary hook. It follows the [official plugin manifest](https://code.claude.com/docs/en/plugins-reference) and [hook reference](https://code.claude.com/docs/en/hooks). The installed CLI must match the service version; incompatible descriptors are rejected. The setup skill explains development steps; it does not install a background service.

The repository also has a marketplace skeleton. The intended release path is `/plugin marketplace add curtiskline/agent-spillway`, then `/plugin install spillway@agent-spillway`. End-to-end marketplace installation and live session banking are later acceptance gates, not a tested onboarding promise in this pre-alpha.

Other MCP clients can configure `{ "command": "spillway", "args": ["mcp"] }`. Tools are `add_task`, `list_tasks`, `get_task`, `get_result` and `queue_status`; all communicate with the authenticated running service. CLI and MCP never open the queue database directly.

## Trust and privacy

Spillway is **not a sandbox**. Harnesses and trusted owner-authored task checks run with your OS privileges. Use a dedicated OS account or container when stronger isolation is needed. The service contacts only configured model endpoints; the plugin uses the local service. No telemetry. Config, provider references, task text, prompts, logs, tokens, queue state and reports stay in private directories outside repositories. The dashboard is authenticated, loopback-only and read-only, and can display private code. See [SECURITY.md](SECURITY.md).

See [the specification](docs/design.md), [architecture](docs/ARCHITECTURE.md), [interfaces](docs/INTERFACES.md) and [implementation status](docs/IMPLEMENTATION_PLAN.md). [Horde](https://github.com/gethamster/horde) informed the design; Spillway implements a narrower single-machine queue and reuses existing harnesses. No Horde code is adapted in this implementation.

Contributions use Apache-2.0 and DCO sign-off; see [CONTRIBUTING.md](CONTRIBUTING.md). Third-party harnesses, model weights and providers retain their own terms.
