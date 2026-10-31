# Basecamp: baselines

Branch `basecamp-baselines`. Goal: make the direct-vs-Projection comparison
honest by adding the baselines a real host would use, a host-sized system
prompt, ablations of the facade, and non-Anthropic models.

## What was built (one commit each)

1. **`native-search` and `native-ptc` modes** (`src/eval/agent.ts`, `modes.ts`, `cost.ts`, `run.ts`).
   Both are direct mode with the same tools, the same system prompt and the same host approval gate,
   offered through Anthropic's own server tools:
   - `native-search`: every tool `defer_loading: true`, plus `tool_search_tool_bm25_20251119`
     (default) or `tool_search_tool_regex_20251119` (`PROJ_EVAL_TOOL_SEARCH=regex`).
   - `native-ptc`: `code_execution_20260120`, every tool with
     `allowed_callers: ["code_execution_20260120"]` (`PROJ_EVAL_PTC_CALLERS=both` adds `"direct"`).
   - The loop echoes server blocks unchanged, records `server_tool_use`, `tool_search_tool_result`
     (the tools found) and code execution results in the transcript, keeps the container id and
     sends it on every later request, tags programmatic `tool_use`s with `fromCode`, and records
     per-episode `serverTools` (calls by name, search hits, programmatic calls, containers,
     code-resume turns).
   - Budget: a turn that only resumes earlier code with tool results (no new code, no text) is
     a **code-resume turn**: free under the turn budget, like the calls a Projection machine makes
     inside one `execute_machine`, and capped separately at 100 per episode.
   - Cost: tool search is not metered (its docs). Code execution is billed at list price beyond
     the 1,550 free hours: $0.05 per container-hour, 5-minute minimum per container, added to
     `estimatedUsd` and `standardUsd` and recorded as `serverToolUsd` (an upper bound; the API
     does not report container time per response).
   - HITL: equivalent. Calls found by search are ordinary `tool_use`s. Calls made from code reach
     the client as `tool_use` blocks with a `caller`, so they pass the same `hostGate` (same prompt
     text, same refusal text, same elicitation record). The one difference: a refusal goes back to
     the running code as the tool's result, and the model sees it only if the code prints it.
     **Limitation:** anything the code does inside the sandbox itself (its own files, bash) never
     reaches the host, so no gate applies, and it has no effect on the user's world either (see
     failure modes).
   - `native-ptc` is skipped on models without PTC (Haiku 4.5) and refused in batch mode (paused
     calls time out after ~4 min; batch ticks are longer).
2. **`PROJ_EVAL_HOST_PROMPT=realistic`** (`src/eval/host-prompt.ts`). A generic agent-host system
   prompt written fresh for this harness (behaviour, planning, tool-use etiquette, tool results as
   data, consequential actions and approvals, code, data and services, safety, tone, formatting,
   examples, edge cases, a static environment section). 40,132 characters: **12,109 tokens on
   Sonnet 5.5, 9,063 on Haiku 4.5** (counted with `count_tokens`). It names no eval tool, server or
   facade feature and has no clock. Every mode's session prepends it to its own system prompt, in
   the one system block that already carries the system cache breakpoint, so it caches exactly as
   before. Recorded as `hostPrompt` in the results file.
3. **Ablation modes** through public `WrapOptions` only (`projectionWrapOptions`):
   `projection-search` (`projections.direct: false`), `projection-nocode` (`codeMode: false`),
   `projection-codeonly` (`catalog: false`), `projection-nopreamble` (`codeModePreamble: ''`, the one
   public option that removes a single feature). No public option turns off result notes or
   default rendering, so there are no modes for those. (`projection` itself runs the library default
   `direct: 'auto'`: on multi the small `fs` box is listed directly and `github` / `mongo` go through
   search, so `projection-search` differs from it only in the `fs` box.)
4. **OpenAI-compatible provider** (`src/eval/openai-compat.ts`, `providers.ts`). A preset may name a
   provider; its caller translates the loop's Anthropic request to Chat Completions and the answer
   back (system, function tools, `tool_calls`, `role: tool` results, reasoning and
   `reasoning_details` preserved across tool calls, stop reasons, usage with cached tokens, the
   provider's reported `usage.cost`). Retries 429/5xx/200-with-error, maps a context-length 400 to a
   context overflow, refuses to run without its key. Presets: `muse-spark` (`meta/muse-spark-1.3`,
   the newest Muse Spark 1.x on OpenRouter) and `kimi-k25` (`moonshotai/kimi-k2.5`), via OpenRouter on
   `OPENROUTER_API_KEY`. Native modes and batch are Anthropic-only. Also `PROJ_EVAL_TIMEOUT_MIN`.

## How to run

```
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN PROJ_LIVE_EVAL=1 \
  PROJ_EVAL_MODELS=haiku45,sonnet-low \
  PROJ_EVAL_MODES=direct,native-search,native-ptc,projection,projection-search \
  PROJ_EVAL_TIERS=multi PROJ_EVAL_RUNS=1 PROJ_EVAL_CONCURRENCY=4 PROJ_EVAL_BOX_DESCRIPTIONS=1 \
  [PROJ_EVAL_TOOL_SEARCH=regex] [PROJ_EVAL_PTC_CALLERS=both] [PROJ_EVAL_HOST_PROMPT=realistic] \
  [PROJ_EVAL_TIMEOUT_MIN=150] \
  pnpm --filter @astral-mcp/harness exec vitest run test/tool-choice.live.test.ts
```

Non-Anthropic models: `PROJ_EVAL_MODELS=muse-spark,kimi-k25` with `OPENROUTER_API_KEY` in the env or
the repo `.env`. Without it each is skipped with `skipping <preset>: OPENROUTER_API_KEY is not set`
(verified; no request is made).

Offline tests: `test/eval/native-modes.test.ts`, `host-prompt.test.ts`, `ablation-modes.test.ts`,
`openai-compat.test.ts`.

## Fidelity sources (read 2026-10-31)

- Tool search: platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool (both
  variants on every current model incl. **Haiku 4.5** and Sonnet 5.5; `defer_loading` tools may not
  carry `cache_control`; not metered; `server_tool_use` / `tool_search_tool_result` shapes).
- Programmatic tool calling: …/tool-use/programmatic-tool-calling (`allowed_callers`, `caller` on
  `tool_use`, container required while calls are pending, tool-result-only user messages, no
  `strict`). **Haiku 4.5 does not support PTC** ("accepts the code_execution_20260120 and later tool
  versions but doesn't support programmatic tool calling"); Sonnet 5.5 does.
- Code execution pricing: …/tool-use/code-execution-tool#usage-and-pricing.
- SDK: `@anthropic-ai/sdk` 1.3.0 types (`defer_loading`, `allowed_callers`, `ToolUseBlock.caller`,
  `Message.container`), all on the non-beta endpoint.
- OpenRouter: tool calling, usage accounting, prompt caching, reasoning tokens docs; prices from
  `GET openrouter.ai/api/v1/models`: Muse Spark 1.3 $1.25 / $4.25, cache read $0.15; Kimi K2.5
  $0.50 / $2.50, cache read $0.15 (per MTok). Moonshot caches automatically with no write fee;
  OpenRouter documents no Meta-specific caching, so Muse Spark gets whatever its provider does.
  No `cache_control` is sent to either.
- The provider fixtures (`test/fixtures/openai-compat/`) are **documented-shape fixtures, not live
  recordings**: no OpenRouter key was available. Replace them with recordings when one is.

## Calibration

`PROJ_EVAL_BOX_DESCRIPTIONS=1`, BM25 search, PTC code-only, interactive. Pass = scored successes
(harness errors excluded). $/ep (eval) is actual spend at list price; std host is `standardUsd`.

### multi (1 run, 17 tasks)

| model      | mode              | pass         | $/ep (eval) | $/ep (std host) | turns/ep |
| ---------- | ----------------- | ------------ | ----------- | --------------- | -------- |
| haiku45    | direct            | 14/17 (82%)  | 0.0242      | 0.0206          | 3.5      |
| haiku45    | native-search     | 10/17 (59%)  | 0.0157      | 0.0134          | 2.1      |
| haiku45    | projection        | 17/17 (100%) | 0.0117      | 0.0110          | 6.5      |
| haiku45    | projection-search | 17/17 (100%) | 0.0224      | 0.0224          | 6.8      |
| sonnet-low | direct            | 16/17 (94%)  | 0.0624      | 0.0535          | 3.6      |
| sonnet-low | native-search     | 14/17 (82%)  | 0.0390      | 0.0427          | 3.2      |
| sonnet-low | native-ptc        | 15/17 (88%)  | 0.0641      | 0.1245          | 4.5      |
| sonnet-low | projection        | 17/17 (100%) | 0.0173      | 0.0162          | 4.6      |
| sonnet-low | projection-search | 17/17 (100%) | 0.0174      | 0.0168          | 5.2      |

### multi-hard (1 run, 12 tasks — the planned 2nd run did not fit the budget)

| model      | mode              | pass                          | $/ep (eval) | $/ep (std host) | turns/ep |
| ---------- | ----------------- | ----------------------------- | ----------- | --------------- | -------- |
| haiku45    | direct            | 9/12 (75%)                    | 0.0617      | 0.0567          | 7.1      |
| haiku45    | native-search     | 9/12 (75%)                    | 0.0583      | 0.0520          | 5.8      |
| haiku45    | projection        | 10/12 (83%)                   | 0.0500      | 0.0491          | 11.0     |
| haiku45    | projection-search | 7/12 (58%)                    | 0.0558      | 0.0557          | 11.1     |
| sonnet-low | direct            | 12/12 (100%)                  | 0.1129      | 0.1004          | 4.4      |
| sonnet-low | native-search     | 12/12 (100%)                  | 0.0941      | 0.0994          | 4.8      |
| sonnet-low | native-ptc        | 11/11 (100%), 1 harness error | 0.0842      | 0.1432          | 13.0     |
| sonnet-low | projection        | 11/12 (92%)                   | 0.0501      | 0.0487          | 6.7      |
| sonnet-low | projection-search | 12/12 (100%)                  | 0.0518      | 0.0509          | 6.8      |

### multi with `PROJ_EVAL_HOST_PROMPT=realistic` (10 of the 17 tasks, to fit the budget)

Baseline column = the same 10 tasks from the multi run above.

| model      | mode          | pass (host) | $/ep (host) | pass (baseline) | $/ep (baseline) |
| ---------- | ------------- | ----------- | ----------- | --------------- | --------------- |
| haiku45    | direct        | 9/10        | 0.0318      | 9/10            | 0.0197          |
| haiku45    | native-search | 6/10        | 0.0107      | 5/10            | 0.0121          |
| haiku45    | projection    | 10/10       | 0.0165      | 10/10           | 0.0094          |
| sonnet-low | direct        | 10/10       | 0.0799      | 10/10           | 0.0501          |
| sonnet-low | native-search | 9/10        | 0.0447      | 9/10            | 0.0290          |
| sonnet-low | projection    | 10/10       | 0.0308      | 10/10           | 0.0153          |

One run per cell: differences of one or two episodes are noise. The realistic prefix adds roughly
the same absolute cost per turn to every mode, so it narrows Projection's relative cost advantage
(sonnet: projection/direct 0.31 → 0.39) without changing pass rates.

### Surprising failure modes of the native modes

- **Haiku 4.5 often does not search at all.** In 5 of its 7 multi failures under `native-search`
  it made no search call and answered "I don't have access to tools that can …" (it sees only the
  search tool). The other two searched once, got near-miss hits and asked the user instead of
  searching again. The realistic host prompt did not fix it (6/10).
- **Search is not as cheap as the prefix suggests.** The native-search prefix is ~3.2k tokens vs
  ~64k for direct (multi, Sonnet), but the schemas a search loads arrive as input tokens in that
  same turn and are written to cache on the next (e.g. turn 1: 25k uncached input on a 3.2k prefix).
- **PTC: the sandbox is mistaken for the user's machine.** 9 of 17 Sonnet multi episodes ran
  `bash_code_execution` against the user's paths (`cd /private/var/…`), which do not exist in the
  container. In one (`cross-open-prs-to-notes`) the model wrote `notes/prs.txt` **inside the
  sandbox** with Python instead of calling the filesystem server's write tool, and reported success.
  This is also the one place the HITL gate cannot see: sandbox writes never reach the host.
- **PTC: direct calls to code-only tools are malformed.** When the model calls a
  code-only tool directly (`allowed_callers` is guidance, not a block), it often wraps the arguments
  as `{"params": {...}}` (5 of 9 direct calls on multi), which fails validation; it then retries
  from code.
- **PTC: one API 400** on multi-hard (`hard-branch-vip-tiers`): after a turn that mixed a
  `bash_code_execution` result with a pending programmatic call, the continuation (assistant turn +
  a tool-result-only user message, as documented) was rejected with "This model does not support
  assistant message prefill". Recorded as a harness error; not reproduced or fixed.
- **PTC is turn-heavy.** 13 API turns per multi-hard episode (99 code-resume turns, 144
  programmatic calls in 11 episodes). Resume turns are free under the budget but not free in tokens.
  Its counted prefix (49.7k on multi) is smaller than direct's (64.4k) — code-only tools are rendered
  more compactly — but its standard host cost is the highest of any cell.

## Open problems

- The regex search variant and `PROJ_EVAL_PTC_CALLERS=both` are implemented and unit-tested but
  were not calibrated live (budget).
- multi-hard has one run per cell, not two.
- No live calls to Muse Spark or Kimi K2.5 (no `OPENROUTER_API_KEY`); fixtures are documented
  shapes, not recordings. Kimi's and Muse's default reasoning settings are untested.
- The code-execution fee is an upper bound (container span, 5-minute minimum, free hours ignored).
- The PTC prefill 400 above.
- `standardUsd` for native-ptc is about twice its eval spend on multi; the standard model assumes a
  warm prefix and incremental caching, which PTC's many short continuation turns do not match well.
  Worth a closer look before quoting PTC host costs.

## Spend

| run                                                          | episodes | spend      |
| ------------------------------------------------------------ | -------- | ---------- |
| smoke: native-search + native-ptc, 1 multi task, both models | 3        | $0.27      |
| multi, 9 cells, 1 run                                        | 153      | $4.66      |
| multi-hard, 9 cells, 1 run                                   | 108      | $7.43      |
| multi, realistic host prompt, 6 cells, 10 tasks              | 60       | $2.14      |
| **total**                                                    | 324      | **$14.50** |

Token counting for the host-prompt size used the free counting endpoint.
