# 0004: Atomic finalization, service lease and interruption fence

Accepted 2026-10-12 after independent security/data-integrity review.

Attempt finalization, task state, review strengthening and transition events commit in one SQLite transaction. Migration v2 adds a controller lease; claiming a stale PID and replacing its nonce occur under `BEGIN IMMEDIATE`, eliminating filesystem stale-lock deletion races. The lease release is nonce-specific. PID reuse fails safely by refusing to steal a live process's lease.

A SIGKILL may leave a detached harness alive. Restart inspects all uncertain attempts but holds them rather than resuming verification, as permitted by design §5.2. Unresolved execution also fences the whole dispatch slot. The authenticated owner must inspect work, stop surviving worker processes, and explicitly use `spillway reconcile ID --worker-stopped`; this abandons the interrupted task and preserves its branch, checkout, logs and evidence. A newly banked task uses a different ID. Never silently rerun or reuse uncertain results. Future process-identity supervision can make recovery less conservative after a separate design review.

Regression evidence: real controller SIGKILL/restart with an orphan worker and two banked tasks; queued work receives no attempt until reconciliation. Independent reviewer also raced two actual processes against the SQLite lease: exactly one acquired ownership.
