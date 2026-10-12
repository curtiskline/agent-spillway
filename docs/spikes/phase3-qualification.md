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

A fresh run was admitted after the first completed and the idle service was upgraded. The loaded instance was independently observed at 32,768 before admission, with separate private metadata. Admission returned in under 100 ms. Its final capability outcomes remain pending; no success is inferred from the context change.
