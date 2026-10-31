Chat Completions responses for `test/eval/openai-compat.test.ts`.

These are documented-shape fixtures, not live recordings: no
`OPENROUTER_API_KEY` was available when they were written (2026-10-31).
Each follows the response shapes in OpenRouter's docs, read that day:

- tool calls: https://openrouter.ai/docs/guides/features/tool-calling.md
- usage and cost: https://openrouter.ai/docs/use-cases/usage-accounting.md
- reasoning and `reasoning_details`: https://openrouter.ai/docs/use-cases/reasoning-tokens.md
- errors (an `error` object, sometimes inside a 200): https://openrouter.ai/docs/api-reference/overview.md

Model ids are the ones OpenRouter lists (`moonshotai/kimi-k2.5`,
`meta/muse-spark-1.3`). Replace them with real recordings once a key is
available: run one episode per model and save the raw response bodies.
