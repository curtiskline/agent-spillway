# Real LM Studio harness spike — 2026-10-12

The owner supplied a reachable local LM Studio endpoint during implementation. Its address, private config and raw transcripts are stored outside the repository. All tasks were purpose-built disposable samples generated from `scripts/create-sample.mjs`; no private application code or frontier credentials were used. Runs were sequential, with no hosted inference.

Server-reported model: `qwen/qwen3.8-27b`, GGUF Q4_K_M, loaded context 8,192 tokens. Controller macOS; owner-reported endpoint hardware RTX 3090, 24 GB VRAM. Exact GGUF hash/revision, model license, server version, peak memory and broader qualification remain unverified. The catalog's model identity/quantization are observations, not a reproducible artifact pin or a qualification certificate.

## All observed outcomes

| Candidate / run | Execution and independent verification | Result |
|---|---|---|
| OpenCode 1.19.0 / 1 | Read, edited, checked and committed the source; final JSON `step_finish` reason `length`, truncated response at loaded context ceiling | Failed completion gate. Original adapter misclassified it as transport and lost reported usage; immutable historical evidence preserved. |
| OpenCode 1.19.0 / 2 | Fresh worker through actual Spillway CLI/service; final `stop`, committed source-only change; protected check passed in detached clean checkout | Ready result branch and private report. Original retry was triggered by the now-fixed classification above. |
| Aider 0.86.2 / 1 | Noninteractive whole-file edit; auto-commit, exit 0; independent verifier found an untracked `.gitignore` inserted by harness | Verification failed; no cleanup or weakening to make it pass. |
| Aider 0.86.2 / 2 | Fresh worker with `--no-gitignore`, map disabled, all history redirected outside checkout; auto-commit, exit 0; same protected check passed in clean checkout | Verified source-only result. No production Aider adapter added. |

Neither result was owner-accepted or merged. Two successful toy results, two failed first runs; no percentages, class acceptance claims, throughput comparison, or quota-savings claims. Reported costs exclude hardware/electricity. This is a walking-skeleton gate, not the Phase 3 qualification suite.

## Configuration and adapter decision

OpenCode: `run --pure --format json --model spillway/<catalog-id>`, prompt on stdin, explicit OpenAI-compatible custom provider, isolated HOME/XDG state, only configured provider, sharing/update/default plugins disabled. Structured tool events, final stop reason, reported per-step usage, process exit and clean-checkout checks were observed. Final stop remains required; worker claims never authorize acceptance.

Aider: `--model openai/<catalog-id>`, same explicit weak model, custom API base, noninteractive `--message-file`, `--yes-always`, `--edit-format whole`, `--map-tokens 0`, `--no-gitignore`, external history paths, analytics and update checks disabled. Plain-text usage and exit status are available, but structured event evidence is less direct. Its editing loop is the existing harness's; Spillway did not implement a tool loop.

Select OpenCode for Phase 1 because the queue's existing adapter has structured events and usage. Keep Aider as a future adapter candidate. This choice is based on integration fit, not a claim that one model/harness is more capable or faster.

## Follow-up implementation fix and remaining gates

Known final reasons `length` and `content-filter` are coding/completion failures, not transport failures, and do not receive a free transport retry. Preserve usage when completion evidence is missing or a later timeout interrupts an already reported step. Fixture regressions cover these semantics independently of real inference. The historical first attempt remains unchanged and its misclassification is disclosed here.

Requalify before expanding task classes or context sizes. Obtain exact artifact/license/server identity, test realistic multi-round tasks, and measure memory. Limit detection signals, live Claude plugin sessions and clean-machine installation remain separate gates. Current private registration permits only the disposable sample and local inference.

Sources for command/API shape: [OpenCode CLI](https://opencode.ai/docs/cli/), [pinned run implementation](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/cli/cmd/run.ts), [Aider options](https://aider.chat/docs/config/options.html), [LM Studio catalog](https://lmstudio.ai/docs/developer/rest/list). Observed outcomes above come from local private run artifacts, not documentation claims.
