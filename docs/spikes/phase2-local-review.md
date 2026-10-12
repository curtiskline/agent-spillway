# Real local review and background service — 2026-10-12

Phase 2 ran a new purpose-built disposable sample through the installed macOS per-user launchd service. Private config, endpoint address, queue, raw transcripts and installed package are outside this repository. The installed CLI, actual stdio MCP tool listing/result retrieval and session-summary hook also passed without inference. Live Claude session/marketplace loading remains a separate gate. The earlier Phase 1 daemon was stopped while idle and its private config/database backed up before migration. The original sample and records were preserved.

The service was installed from a locally built package with absolute Node/CLI/config pins and a clean PATH-only environment. Actual install, status, stop and restart passed; the queue persisted and the service remains running. Linux user-service rendering/lifecycle has fixture tests, including restart after changed pins; actual Linux host operation remains unverified.

## Observed model workflow

Same private LM Studio endpoint and observed model as the initial spike: OpenCode 1.19.0, `qwen/qwen3.8-27b`, GGUF Q4_K_M, loaded context 8,192 tokens, owner-reported RTX 3090 / 24 GB VRAM. Artifact hash/revision/license, server version, peak memory and broad class qualification remain unverified.

The sample changes one CommonJS helper from returning goodbye to returning hello. A protected acceptance check fails at the baseline. The task uses default local review and the existing narrow operator-qualified mechanical profile; there was no qualification expansion.

| Stage | Observation |
|---|---|
| Worker | Scoped source commit, final harness stop, clean checkout; 46.369 seconds including independent verification |
| Independent check | Protected acceptance check passed in a separate detached checkout; only the declared source changed |
| Local reviewer | Separate detached result checkout, read-only agent; three glob and three read tool events, no shell/edit/network tools; final stop |
| Review gate | Exact verified SHA, strict report `accept`, no findings; 34.979 seconds |
| Final state | Ready, original main unchanged, worker clean, review checkout removed, private report/log accessible through authenticated service |

Worker usage reported 74,113 input and 776 output tokens; reviewer reported 13,360 input and 365 output tokens, cumulative over harness rounds. Reported inference cost was zero; this excludes hardware and electricity. Frontier availability remained off throughout. No frontier provider was configured or invoked by this workflow.

One worker plus one reviewer succeeded on this toy task. The sample was not owner-accepted or merged. This proves the connected service path on the supplied endpoint, not a class success rate, security guarantee, throughput benchmark, net quota savings or production qualification. Clean-machine onboarding, live owner Claude sessions/marketplace installation, broader qualification and actual Linux host lifecycle remain separate gates.
