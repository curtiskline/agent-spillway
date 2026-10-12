# Phase 3 qualification observations

Observed 2026-10-12 through the packaged macOS background service and existing OpenCode 1.19.0 harness. Seven fixed Apache-2.0 cases use disposable private Git repositories, protected checks, observed tools and independent verification. All inference used the owner's configured local endpoint; frontier availability remained off. No paid provider calls, owner task acceptance or release occurred.

The first run started with 8,192 loaded context tokens. Early step usage reached that ceiling and reported length finishes. The owner reloaded at 32,768 during the run, so its private provenance records the settings change; this run is observational and cannot establish reproducible qualification.

| Capability | Outcome |
| --- | --- |
| Discovery | Failed |
| Read/search | Failed |
| Structured edit | Failed |
| Command | Failed |
| Tool error recovery | Timeout |
| Test-driven repair | Timeout |
| Multi-round/context | Timeout |

All seven outcomes were preserved. The durable job completed without uncertainty; no qualifying community profile or task-class promotion resulted. Raw prompts/transcripts, endpoint bindings, private paths, owner metadata and runtime records remain outside Git.

The long synchronous HTTP request lost its client connection while the service continued execution. That exposed a usability defect, not a stopped worker. Qualification CLI now returns a durable background-job receipt after persistence; separate authenticated result inspection handles progress/completion. Tests cover early admission, concurrent inference fences, pre-admission rejection, consumed background failures, private result corruption/substitution and graceful shutdown of a TERM-resistant fixture child.

A fresh run was admitted after the first completed and the idle service was upgraded. The loaded instance was independently observed at 32,768 before admission, with separate private metadata. Admission returned in under 100 ms. The owner then supplied server observations showing concurrent worker and automatic title-generation requests, both decoding at approximately 2–3 tokens/second. The run was stopped because the declared inference concurrency was not established. All tracked local daemon/harness processes exited; the durable job retained uncertainty and private partial evidence. It is not a qualifying result.

A real OpenCode 1.19.0 subprocess against a loopback HTTP fixture reproduced two completions (title and worker) and omitted temperature, despite the serialized build configuration requesting zero. Custom-model temperature support defaults false in that harness, and title generation forks automatically. The adapter now disables auxiliary agents, subagents and automatic compaction, selects its primary explicitly, declares temperature support and sends zero by default. Task/skill/delegation tools are denied; output-token limits and protected acceptance criteria are preserved. Overflow remains failure rather than a hidden compaction call.

The optional `scripts/harness-wire-smoke.mjs` checks the installed binary against synthetic completions only. Its worker and reviewer runs each observed exactly one primary request with temperature 0, correct tool permissions and completed output. This proves adapter wiring, not model capability. A subsequent real run requires the corrected packaged adapter and separate private metadata; no success is inferred from the context change.

Operator monitoring initially raced the corrected runner's empty-directory validation. That admission produced no cases/model calls and retained uncertainty; controller idle/no worker descendants were verified before reconciliation. The guard was preserved, monitoring moved outside runner-owned roots, and a separate corrected run was admitted. Outcomes remain pending.
