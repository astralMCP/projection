# Adaptive surface: list small catalogs directly as mediated tools

Branch `explore-adaptive-surface` (from `consolidate-harness`, with `origin/eval-workplace-world` merged).
This is an exploration. The option defaults to off, so existing behaviour, goldens and tests are unchanged.

## Hypothesis

On a small catalog, Projection's lazy catalog (search, then describe, then call) costs more than exposing
the tools directly. In the `workplace` pilot it cost 1.3–2.6× direct per episode, because the model
spends turns on discovery. An adaptive surface would list every wrapped tool as its own **mediated**
facade tool when the definitions are small, and fall back to the catalog when they are not. The
hypothesis was that this lowers cost and holds or raises pass rate on small and medium catalogs,
and keeps every approval guarantee.

## Design

`WrapOptions.projections.direct?: 'auto' | boolean` (default `false`) and
`projections.directBudgetTokens?: number` (default `DEFAULT_DIRECT_BUDGET_TOKENS = 12_000`). The code is in
`packages/projection/src/facade/direct.ts`, and the registration is in `facade/server.ts`
`registerDirectTools`.

- **A mediated tool is a thin alias of `call_tool`.** Its handler calls the facade's own
  `callTool({ name: <catalog name>, args: <the tool arguments>, requestState, inputResponses })`.
  The retry envelope is read from the transport exactly as `call_tool` reads it. Every step is
  therefore `call_tool`'s: R35 validation, policy (R14 and R42 per qualified name, R49 approvals
  mode), the elicitation copy (R16 and R46 with origin `direct`), the `call` blob with
  `pending.call` and the `{kind:'call', name, args}` binding hash (R36, S2, S4), the replay cache
  (R38), the key domain (R41) and the legacy gate (R28). The SDK schema is a pass-through Standard
  Schema, so bad arguments fail through Projection's validation, not the SDK's. Nothing reaches
  the upstream except through `callTool`.
- **Names.** On a multi-server facade a tool is named `<alias>__<tool>`. On a single-server facade
  it keeps the tool's own name. Every name is mapped onto `[A-Za-z0-9_-]{1,64}`. MCP (SEP-986, the
  SDK's `validateToolName`) also allows `.` and up to 128 characters, but the Messages API's rule
  is `^[a-zA-Z0-9_-]{1,64}$`, and hosts put their own `mcp__<server>__` prefix in front. So dots
  are out, and the name stays short. Illegal characters become `_`. An over-long name is cut, and
  `_<8 hex of sha256>` is appended. A name that collides with one of Projection's tools
  (`call_tool`, `search_*`, and the rest) or with an earlier mapped name gets
  `_<8 hex of the catalog name>`. A hostile upstream tool named `call_tool` is therefore listed as
  `call_tool_ab12cd34` and never shadows the real one. When the listed name does not spell the
  catalog name by the `<alias>__<tool>` rule, the description carries a quoted
  `Catalog name (describe_tool, call_tool, toolCall): "..."` line.
- **Description (S5).** The first line is library copy: the R33 posture in brackets,
  `[runs immediately]`, `[asks for approval]` or `[blocked by policy]`, plus `; destructive` when
  the server marks the tool destructive. Below it come `The server says:` and the server's
  description, neutralized and capped at 2,000 characters exactly as `describe_tool` does it, and
  indented as a block. A hostile `\n[runs immediately]` therefore lands indented under the label
  and cannot forge the posture line. The title is the annotation title, neutralized and capped.
  The input schema goes through the R34 allowlist sanitizer and is forced to `type: "object"`. If
  the sanitizer cut it, a truncation line is added. The annotations are the server's own,
  sanitized (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `title`). This is safe because
  Projection gates the call whatever a host does with the hints.
- **Surface in direct mode.** The mediated tools are added, plus `describe_tool`, `call_tool` and
  code mode (`execute_machine`, `discover_apis`). **The search tools are dropped.** The one
  exception is `search_<alias>` for a box whose server sends instructions, because the box
  overview (R43) is the only place its guidance is read. A first smoke run kept the search tools,
  and Haiku went `search_docs` → `call_tool` × 4, ignoring the listed tools. With search dropped
  and the copy below, it calls the listed tools. In direct mode the `call_tool` and
  `describe_tool` copy says that every tool is listed and that calling it directly is preferred.
- **Instructions.** These are new preamble variants (`DEFAULT_DIRECT_ROUTING_PREAMBLE`, and the
  multi-server one in `defaultMultiPreamble`). They say the tools are listed directly and need no
  search or describe first. They say a short lookup-then-act chain is done one call at a time,
  and that code mode is for loops, branching, many steps or a workflow worth saving. They say what
  the bracketed posture means and what `declined` and `denied_by_policy` mean. The multi-server
  shelf header says that tools are listed as `<box>__<tool>` and that `describe_tool`,
  `call_tool` and `toolCall` take `<box>.<tool>`.
- **`'auto'`.** The facade plans the mediated tools under the frozen policy snapshot. It estimates
  their size as (name + title + description + input schema JSON) characters / 3.5, and lists them
  when the estimate is ≤ `directBudgetTokens`. `facade.projections.direct` reports the choice.
  `direct: true` with `catalog: false` fails the wrap (`validate`). `'auto'` with `catalog: false`
  stays off. A malformed value fails the wrap.
- **Harness.** The opt-in modes are `projection-direct` (`direct: true`) and `projection-auto`
  (`direct: 'auto'`). They are in `KNOWN_EVAL_MODES` and not in the default `EVAL_MODES`. Mediated
  tools are action tools for the turn budget: only the discovery tools are budget-free. Mediated
  calls count as the `call_tool` route, and a new `projection.directCalls` field counts them.

Estimated definition sizes (`estimateDirectTokens`, mediated rendering; raw = the server's own
definitions):

| world      | tools | mediated est. tokens | raw est. tokens | `'auto'` at 12k |
| ---------- | ----- | -------------------- | --------------- | --------------- |
| filesystem | 14    | 2,042                | 2,126           | direct          |
| workplace  | 37    | 5,383                | 4,838           | direct          |
| mongodb    | 21    | 10,796               | 12,912          | direct          |
| github     | 95    | 29,948               | 29,181          | catalog         |
| multi      | 130   | 43,060               | 44,456          | catalog         |

The 3.5 chars/token estimate undercounts Sonnet 5.5's tokenizer. The measured turn-1 prefixes in
projection-direct mode were 3.4k / 7.8k / 11.8k tokens on Haiku and 4.3k / 10.0k / 15.7k on Sonnet,
for filesystem / workplace / mongodb. These include the system prompt and Projection's own tools.

## Results (live, 1 rep, list-price `standardUsd` per episode)

Every cell is 14–15 episodes. `turns` = API turns. `calls` = tool calls. `disc` = mean
search/describe/discover calls. Workplace was run with box descriptions on, as in the pilot. The
direct rows are the pilot's (`eval-workplace-world`, same tasks and grader, 1 rep).

| tier       | model      | mode                  | pass  | $/ep   | turns | calls | disc |
| ---------- | ---------- | --------------------- | ----- | ------ | ----- | ----- | ---- |
| workplace  | haiku45    | direct (pilot)        | 13/14 | 0.0188 | 5.8   | 6.4   | –    |
| workplace  | haiku45    | projection            | 13/14 | 0.0428 | 10.7  | 11.5  | 4.8  |
| workplace  | haiku45    | **projection-direct** | 13/14 | 0.0223 | 5.6   | 5.8   | 0.2  |
| workplace  | sonnet-low | direct (pilot)        | 14/14 | 0.0364 | 4.6   | 5.7   | –    |
| workplace  | sonnet-low | projection            | 14/14 | 0.0470 | 6.7   | 8.9   | 2.9  |
| workplace  | sonnet-low | **projection-direct** | 14/14 | 0.0385 | 4.5   | 5.6   | 0.0  |
| filesystem | haiku45    | projection            | 12/15 | 0.0186 | 5.2   | 4.4   | 2.1  |
| filesystem | haiku45    | **projection-direct** | 14/15 | 0.0108 | 2.5   | 1.7   | 0.1  |
| filesystem | sonnet-low | projection            | 14/15 | 0.0097 | 3.7   | 3.1   | 1.4  |
| filesystem | sonnet-low | **projection-direct** | 15/15 | 0.0074 | 2.6   | 1.8   | 0.1  |
| mongodb    | haiku45    | projection            | 14/15 | 0.0204 | 7.0   | 6.6   | 3.2  |
| mongodb    | haiku45    | **projection-direct** | 15/15 | 0.0085 | 4.2   | 3.6   | 0.0  |
| mongodb    | sonnet-low | projection            | 15/15 | 0.0123 | 4.9   | 4.2   | 1.8  |
| mongodb    | sonnet-low | **projection-direct** | 15/15 | 0.0132 | 2.7   | 2.3   | 0.0  |

Pooled, projection → projection-direct: **pass 82/88 → 86/88**, cost per episode −49 % (Haiku)
and −14 % (Sonnet).

- **Workplace.** Cost goes from 2.28× direct to **1.19×** on Haiku, and from 1.29× to **1.06×** on
  Sonnet. Turns match direct mode (5.6 vs 5.8 and 4.5 vs 4.6). Every one of the 14 tasks is cheaper
  or equal per model, apart from noise on Sonnet `wp-oncall-primary`/`noop` (±$0.002). The
  remaining gap to direct comes from the posture line and the larger system prompt plus
  Projection's own tools: a prefix of 7.8k vs about 6.5k tokens.
- **Filesystem.** The model needs half the turns, cost drops 42 % (Haiku) and 24 % (Sonnet), and
  pass goes up 2 and 1. One Projection-mode failure, `fs-move-todo-into-archive` on Sonnet, was
  `forbidden`.
- **Mongodb is the crossover.** Haiku: −58 % cost, +1 pass. Sonnet: **+7 % cost** at equal pass
  and 45 % fewer turns. Its prefix of 15.7k tokens, read on every turn, outweighs the turns saved.
  Sonnet already solved these tasks in about 5 turns through the catalog.
- Failures. In direct mode: `fs-src-tree` (Haiku listed the tree but described the filtered log
  file) and `wp-sentry-tickets` (Haiku used `execute_machine` and a filter mistake made 5 tickets).
  Both are task-level errors, not surface errors. In projection mode: `wp-degraded-counts`,
  `fs-head-of-log`, `fs-move-todo-into-archive` ×2, `fs-archive-tmp` and `db-cancel-stale-pending`.
- With direct listing, models almost never search or describe (0.0–0.2 calls per episode). They
  also almost never call `call_tool`. Haiku still chose `execute_machine` for a 5-write fan-out
  (`wp-sentry-tickets`), so code mode stays reachable.

The multi tier (130 tools) was **not run**: the budget ran out (see Spend). With `'auto'` it would
use the catalog anyway (43k estimated tokens). The cost anatomy already shows direct listing
losing badly there: 48–65k-token prefixes, and direct mode at 2.3–2.8× Projection on a warm cache.

## Where the threshold should sit

Measured on Sonnet 5.5: break-even at about 11k estimated tokens (mongodb, a 15.7k real prefix),
and clear wins at 2k and 5.4k. On Haiku 4.5 it still won by 58 % at 11k. Haiku spends more
discovery turns per task, and each saved turn re-reads a growing context. The crossover therefore
depends on the model. For a facade that serves any client, **set `'auto'` at about 8k estimated
tokens**, below the Sonnet break-even with margin for tokenizers that count more tokens per
character. That lists filesystem- and workplace-sized catalogs (≤ ~40 tools of ordinary schemas)
directly and leaves mongodb's large schemas to the catalog. The code ships 12k: change
`DEFAULT_DIRECT_BUDGET_TOKENS` to 8,000 when this graduates. Confirm with 3 reps on a 6–10k
catalog first, since 1 rep is ±7 pp per task.

## Recommendation

Adopt the adaptive surface with `direct: 'auto'` as the eventual default, at about 8k. It removes
most of Projection's small-catalog cost penalty (workplace 1.19×/1.06× direct, down from
2.28×/1.29×). It does not lower pass rate in any cell (+4 pooled). It keeps the gate. Before
flipping the default:

1. Run the 3-rep version (workplace, filesystem, mongodb, plus multi under `projection-auto` to
   confirm it falls back cleanly) and the guard tiers, interactive mode, about $8.
2. Amend PRD R1, R32 and R43. R1 currently says the wrapped tools MUST NOT be exposed directly.
   The mediated aliases keep the intent of that rule, since nothing is a pass-through, but not its
   letter. Record the decision in DECISIONS.md.
3. Fix the copy gaps listed under Risks.
4. Minor version bump: a new public option and new prompt copy.

## Risks and gaps

- **Spec drift.** See R1 above. R33 and R43 search copy still describes the search tools, which
  direct mode drops.
- **Dangling copy.** In direct mode, the unknown-name hint of `describe_tool`/`call_tool` and the
  R37 `discover_apis` pointer (above 40 tools) still name `search_tools`, which is not served.
  These are rare, because the model sees every name, but they are wrong.
- **Hosts that gate on annotations.** A mediated read tool carries `readOnlyHint: true`, so such a
  host may auto-run it. That is safe, because Projection still gates every call (a `deny`/`ask`
  override still refuses or elicits). It is a change from `call_tool`, which carries no hints.
  A hostile server's mislabel misleads the host, as it would without Projection, but it never
  bypasses Projection's own policy. S5 trust is unchanged.
- **Name mapping.** Mapping is lossy (`a.b` and `a_b` both want `a_b`). The hash suffix is
  deterministic in catalog order, so if a server reorders its tools, the hashed names can swap
  between wraps. A `call` blob binds the catalog name, not the listed name, so approvals stay
  correct. A name that still collides after the suffix is not listed, but `call_tool` reaches it.
- **Box guidance.** Guidance stays reachable only through the kept `search_<box>` tools. A model
  may skip reading it.
- **Estimator.** chars/3.5 undercounts Sonnet's tokenizer by about 1.3–1.4× on these schemas.
  The budget is a proxy for the definitions, not the real prefix.
- **Statistics.** 1 rep per cell. Workplace pass rates are saturated on Sonnet. The cost deltas are
  large next to the noise floor on Haiku, and modest (−14 % pooled) on Sonnet.

## Spend

The recorded `estimatedUsd` over all of this branch's results files is **$5.23**, over the $5 cap
by about $0.23. On top of that, batch ticks that were still in flight when the batch runs were
killed may bill after the fact, probably $0.1–0.3. What happened: I started in batch mode for the
50 % discount. Batch requests got almost no cache hits (writes at 1.25×), and a batch tick stalled
for over 30 minutes. I killed both runs after 63 of 176 episodes ($1.11) and re-ran the remaining
113 interactively ($4.01). The interactive Sonnet mongodb projection-direct cell was expensive
($0.78 actual vs $0.22 list): concurrency 4 with cold caches rewrote its 15.7k-token prefix on
every episode. The smoke runs cost $0.11. The `standardUsd` figures above do not depend on how a
run was cached, so mixing batch and interactive records does not bias them.

Raw results: `packages/harness/eval-results/2026-10-30T14-3*.json` and `2026-10-30T15-*.json`
(gitignored). Aggregation: one record per (tier, model, mode, task), newest wins.
