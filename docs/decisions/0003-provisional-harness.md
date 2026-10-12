# 0003: Provisional OpenCode adapter

Accepted provisionally 2026-10-12. Implement one OpenCode adapter based on its documented noninteractive JSON runs and OpenAI-compatible provider configuration. Keep a narrow adapter contract so a two-candidate real spike can change the choice cheaply. The owner confirmed no model endpoint is available and authorized fixture tests. This does not satisfy Phase 0 real qualification; all capability/throughput conclusions remain pending.

Sources: [CLI](https://opencode.ai/docs/cli/), [providers](https://opencode.ai/docs/providers/), [configuration](https://opencode.ai/docs/config/). Alternative Aider supports [OpenAI-compatible APIs](https://aider.chat/docs/llms/openai-compat.html); both require a real endpoint comparison.
