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

The optional `scripts/harness-wire-smoke.mjs` checks the installed binary against synthetic completions only. Its worker and reviewer runs each observed exactly one primary request with temperature 0, correct tool permissions and completed output. This proves adapter wiring, not model capability. It also passed in Linux/Node 24 CI; no success is inferred from the context change.

Operator monitoring initially raced the corrected runner's empty-directory validation. That admission produced no cases/model calls and retained uncertainty; controller idle/no worker descendants were verified before reconciliation. The guard was preserved, monitoring moved outside runner-owned roots, and a separate corrected run was admitted.

The corrected single-inference run completed with stable 32,768-token metadata. All seven cases timed out at the unchanged three-minute case budget. Observed tools establish that the harness made progress; they do not substitute for completed work and independent verification.

| Capability | Outcome | Observed rounds | Observed tool calls |
| --- | --- | --- | --- |
| Discovery | Timeout | 4 | 6 |
| Read/search | Timeout | 4 | 7 |
| Structured edit | Timeout | 7 | 8 |
| Command | Timeout | 4 | 9 |
| Tool error recovery | Timeout | 4 | 9 |
| Test-driven repair | Timeout | 3 | 9 |
| Multi-round/context | Timeout | 3 | 4 |

The job completed without uncertainty and did not qualify the model. GPU weight placement is not exposed by the model catalog; decoding timings and GPU utilization alone cannot establish full offload. The owner offered Windows diagnostics, so a separate diagnostic repeat was admitted after upgrading the idle service to the final tested build. Loading settings and acceptance criteria were preserved. That repeat also completed with all seven cases timing out. Its receipt and operator telemetry remain outside runner-owned directories and Git. No profile promotion resulted.

Subsequent read-only inspection through the official LM Studio SDK retrieved the loaded instance's configuration without loading a model or starting inference. GPU offload was configured as a small fraction of the model rather than full offload; this is configuration evidence, not an observed layer-allocation count. The loaded prompt template also defaults omitted reasoning effort to `xhigh`. An independent actual OpenCode wire capture with the exact model identifier confirmed that the adapter sends neither a reasoning override nor that instruction. Hardware placement should be corrected before drawing capability conclusions; reasoning, workload and timeout settings should remain unchanged for the next comparison. Private configuration/template snapshots and resource estimates remain outside Git. No application changes or qualification claims follow from this diagnosis.

The owner then selectively unloaded and reloaded the same model with explicit full GPU offload and 32,768 context. Read-only SDK comparison found only the GPU setting changed; prediction settings were identical. Owner GPU readings corroborated substantially higher device-memory use and utilization. The separate v1 comparison finished without uncertainty in about six minutes; every case completed within its unchanged three-minute limit and passed independent protected code checks.

| Capability | Qualification outcome | Duration (seconds) |
| --- | --- | --- |
| Discovery | Failed tool evidence | 51.7 |
| Read/search | Passed | 63.8 |
| Structured edit | Passed | 26.5 |
| Command | Passed | 66.4 |
| Tool error recovery | Failed tool evidence | 50.4 |
| Test-driven repair | Passed | 55.4 |
| Multi-round/context | Failed tool evidence | 49.4 |

Independent review verified all seven result SHA pins, ancestry, clean worktrees, source-only changes, protected fixture integrity and code checks, and reparsed the recorded tool evidence. Recovery used command wrappers masking the deliberate exit 17; multi-round read the full context across eleven rounds but omitted required grep. Discovery used glob `**/*`, while the observer required `docs/**` without disclosing that pattern in the instruction. Report this narrow instruction/grader mismatch accurately, not as general inability to discover files.

The run remains unqualified and unchanged. ADR 0008 introduces a separate v2 workload that states the existing exact discovery predicate, retaining v1 assets/results and all verification requirements. A later v2 run will have its own suite version and hash. No community profile, coding-class promotion or release follows from the v1 comparison.
