# Security

This pre-alpha has no supported production release. Report vulnerabilities privately using [GitHub's vulnerability reporting page](https://github.com/curtiskline/agent-spillway/security/advisories/new). Maintainers must enable private vulnerability reporting before inviting public use. If that path is unavailable, open an issue asking the owner to enable private reporting, without vulnerability details or secrets. No security response SLA is promised.

Spillway is not a sandbox. Existing agent harnesses and owner-authorized shell checks run with the owner's OS privileges and can read accessible files or use the network. Restrict repository data policy, protect credentials, and use a dedicated account or container for stronger isolation. Scope and clean-checkout verification are acceptance controls, not operating-system isolation. Workers cannot authorize readiness. Spillway does not automatically merge, push or deploy.

Only explicitly configured model endpoints receive task code. The default repository data policy is local-only. Private configuration stores environment references for keys, never literal credentials. Inherited provider keys are excluded from verification checks. No telemetry or hosted dependency is required.

Private config, queue databases, prompts, logs, evidence and service tokens live outside source repositories in owner-only directories/files (0700/0600). Do not share dashboard URLs, which contain an initial token or a private session path. The authenticated read-only dashboard binds to 127.0.0.1; remote exposure is unsupported. Cookies share loopback across ports, so the browser cookie is restricted to a random dashboard path and ordinary API routes require bearer authentication. Protect your browser session and do not proxy the dashboard to the internet.

SIGKILL can leave detached workers alive. Recovery holds uncertain execution and pauses the queue. Reconciliation requires the owner's explicit confirmation that surviving workers are stopped; it abandons interrupted work without discarding evidence. This is an owner trust boundary, not an automated liveness guarantee.

Enable GitHub secret scanning, push protection and private reporting before public distribution. The required gitleaks hook and CI are additional controls; they cannot prove the absence of every secret. If a credential leaks, revoke it immediately and coordinate history cleanup privately. Do not run untrusted task checks or install plugin/harness code without understanding its privileges.
