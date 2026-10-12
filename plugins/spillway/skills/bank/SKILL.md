---
name: bank
description: Bank small, fully specified coding tasks for asynchronous execution by the running Spillway service.
---

Use the Spillway MCP add_task tool to bank work while frontier capacity is available, then continue independent work. Never wait for the worker as part of banking. If the service is unavailable, explain how to start it; do not write queue state directly.

Choose tests, small fixes, mechanical changes, or a narrowly specified feature. Resolve design decisions first. Ask the owner to register the repository and endpoint in private config; never infer permission to send private code to a hosted provider. The service decides eligibility and review tier.

Write Markdown with YAML frontmatter: repo (registered path), base, class, after (accepted and merged dependencies), scope (explicit repository-relative globs), protected (acceptance fixtures), context (files to read), checks (owner-authorized shell commands), review (default), limits (max_minutes, max_attempts). Optional id uses lowercase letters, digits and hyphens. Include nonempty `## Objective` and `## Acceptance criteria` sections. No unknown fields. Keep one objective, a handful of files, and checks that would fail if the objective were unmet. Without checks, supply no_checks_justification and review: frontier; this milestone holds pending review.

Readiness: scope is explicit; context is useful; no open design choices remain; checks are meaningful; acceptance fixtures are protected. Checks run with the owner's OS privileges. Obtain authorization before introducing destructive or costly checks. Run `spillway lint FILE` before admission when a private task file is available. Submit the full Markdown through add_task. Report the returned task ID and any hold or admission error accurately. Worker claims do not authorize acceptance. Never merge, push or deploy through Spillway.
