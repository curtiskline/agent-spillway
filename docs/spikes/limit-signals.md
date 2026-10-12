# Frontier limit signals — initial inspection

Local clients inspected 2026-10-12: Claude Code 2.1.296, Codex CLI 0.162.0-alpha.17.2. No frontier model call, credential extraction, quota-exhaustion attempt or paid experiment was run. Therefore reliable limit/error/reset payloads have not been demonstrated.

The initial implementation does not infer frontier availability from generic nonzero exits, timeout, local model context exhaustion, or missing completion evidence. These signals can arise from unrelated failures. A future spike must capture each client's documented machine-readable result and real observed limit outcome with owner authorization, redact credentials/private prompts, and distinguish transport failures from coding errors and quota/reset signals.

Phase 2 will start with the specification's manual availability switch; automatic detection remains Phase 5. This gate stays open rather than inventing a message pattern or reset time from an untested assumption.
