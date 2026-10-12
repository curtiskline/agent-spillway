# Contributing to Agent Spillway

Pre-alpha scope: one user, one machine, one queue and one inference slot. Useful contributions include documentation, reproducible fixture tests and narrowly scoped adapters. Start an issue for architectural changes. Distributed runtime, hosted coordination and a general-purpose agent framework are outside v0.x scope. Real model qualification requires actual reproducible endpoint evidence; fixtures are not capability results.

Read AGENTS.md, docs/ARCHITECTURE.md and docs/INTERFACES.md. Use TypeScript ESM with strict types and explicit .js import suffixes. Keep dependencies small and never put private config, provider keys or runtime data in the repository. Tests use temporary directories outside the checkout, real Git fixtures, mock catalogs and a fixture subprocess harness. No credentials in CI.

```sh
npm ci
npm run check
git config core.hooksPath .githooks
```

Install gitleaks before committing; the pre-commit hook scans staged changes and CI scans history. Run `gitleaks git --redact --no-banner` before public push. Changes need meaningful tests and documentation of behavior and limits. Do not weaken checks to make tests pass. Plugin structure can be checked with `claude plugin validate ./plugins/spillway` when Claude Code is installed; live session behavior remains a separate gate.

All contributions are Apache-2.0, inbound equals outbound. Certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/) with `git commit -s` using your real name and email. Each commit needs a `Signed-off-by: Name <email>` trailer. No CLA is currently required. Use concise conventional commit messages. Preserve third-party notices and add any adapted code to NOTICE.

Before outside contributions become routine, maintainers should protect main with required fixture checks and secret scanning, enable push protection, and require review. Do not include private logs or endpoint details in issues. See SECURITY.md for vulnerabilities.
