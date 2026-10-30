# Exploration wave 1: lean surface (L1, L2; L3 skipped)

Goal: maximize task completion and minimize cost. Evidence base: `../cost-anatomy.md`. Branch `explore-lean`, cut
from `hillclimb-multi` at 295d87b. Only `packages/projection` source and tests changed. Harness untouched.

| variant | commit  | what changed                                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1      | e62896e | Tool index in the instructions. Multi-server: every tool as `<alias>.<name>`, one line per box, after the shelf (up to 400 tools in total). Single-server: one flat line when the catalog has ≤ 60 tools (`TOOL_INDEX_MAX_TOOLS`), unchanged above. Copy says call any listed tool directly with `call_tool`, `describe_tool` only for arguments, search tools only when the index is not enough. |
| L2      | 52e9a42 | L1 + `call_tool` argument errors (missing/unknown/mistyped argument, args not an object) attach the tool's input schema as compact JSON; `describe_tool` schemas compact, not pretty-printed; query searches return at most 8 entries per page (listings keep 50; cursors unchanged).                                                                                                             |
| L3      | —       | Skipped: not possible without a harness change (see below).                                                                                                                                                                                                                                                                                                                                       |

Index names are listed only when they are plain identifiers (`[A-Za-z0-9_\-./]`, ≤ 64 characters, unchanged by
neutralization); anything else is counted (`+N tools with unusual names: search for them`) and left to search. A
shortened name would not be callable, so names are never truncated. The eval world loses no names.

Probe: multi tier, `projection` mode, 1 rep, haiku45 + sonnet-low, box descriptions on (17 tasks × 2 models per
variant). Records: `L1/2026-10-30T04-44-00.704Z.json`, `L2/2026-10-30T04-49-31.526Z.json`. Table script:
`compare.py` (`python3 compare.py <v4 multi.json> L1=<json> L2=<json>`).

## Prefix size per eval world

Characters are measured: system prompt + tool definitions as sent (dump approach of `dump-prefix.ts`). Haiku tokens
for the multi world are **measured** from the probe: when the first prompt is under the cache minimum, the episode's
uncached input tokens equal the turn-1 prompt (static prefix + task prompt). The other token figures are estimates
(cost-anatomy calibration, `489 + 0.2851 × chars` for Haiku), which overshoot the measured multi figure by about 150.

| world · mode             | tools in catalog    | v4 chars | L1/L2 chars | Haiku tokens, v4             | Haiku tokens, L1/L2                                |
| ------------------------ | ------------------- | -------- | ----------- | ---------------------------- | -------------------------------------------------- |
| multi · projection       | 130                 | 9,117    | 12,776      | 3,093 (fitted, cost-anatomy) | **3,935–4,048 measured** (turn-1 prompt, per task) |
| multi · projection-boxes | 130                 | 8,068    | 11,693      | 2,832 (fitted)               | ≈ 3,650–3,750 (est.)                               |
| github · projection      | 95 (> 60: no index) | 11,122   | 11,122      | ≈ 3,660 (est.)               | unchanged                                          |
| filesystem · projection  | 14                  | 4,399    | 4,900       | ≈ 1,740 (est.)               | ≈ 1,890 (est.)                                     |
| mongodb · projection     | 21                  | 4,412    | 4,990       | ≈ 1,750 (est.)               | ≈ 1,910 (est.)                                     |

The multi index adds 3,387 characters to the system prompt (the qualified-name list itself is 3,339; bare names
would be about 2,500) and the indexed tool copy adds about 270 characters to the tool definitions.

**Haiku's prefix does not clear the 4,096-token cache minimum.** The turn-1 prompt is 3,935–4,048 tokens, 50–160
short. Every Haiku episode in L1 and L2 paid turn 1 uncached, and 2 (L1) and 4 (L2) episodes also paid turn 2
uncached (about 8k uncached tokens). What did
change: turn 2 now crosses the minimum, where in v4 turns 1–2 (often 1–3) went uncached. No other world comes near the
minimum.

## Comparison with v4

v4 = `../v4/raw/multi.json`, `projection` mode, 3 reps, passes as a per-rep average. **v4's 3-rep Sonnet average is
deflated by cross-rep caching**: under this harness the breakpoint is the end of the conversation, Sonnet's
trajectories repeat almost byte for byte, and reps 1–2 read whole conversations that rep 0 wrote (e.g. `box-src-fs`:
rep 0 $0.0134, reps 1–2 $0.0041). A 1-rep probe gets none of that, so the like-for-like row is **v4 rep 0**. Haiku is
barely affected (its early turns sit under the cache minimum either way).

| variant     | model      | passes /17 | $/ep   | $/success | turns | tool calls | describes/ep | searches/ep | uncached in/ep | cache write/ep | cache read/ep | out/ep |
| ----------- | ---------- | ---------- | ------ | --------- | ----- | ---------- | ------------ | ----------- | -------------- | -------------- | ------------- | ------ |
| v4 (3 reps) | haiku45    | 16.00      | 0.0232 | 0.0246    | 7.06  | 6.69       | 1.24         | 1.94        | 10,046         | 5,780          | 21,723        | 749    |
| v4 rep 0    | haiku45    | 16         | 0.0232 | 0.0247    | 7.18  | 7.00       | 1.41         | 2.18        | 9,326          | 6,074          | 25,521        | 756    |
| L1          | haiku45    | 16         | 0.0164 | 0.0175    | 5.47  | 5.24       | 0.59         | 0.41        | 4,461          | 5,561          | 18,052        | 646    |
| L2          | haiku45    | 14         | 0.0156 | 0.0190    | 4.82  | 3.94       | 0.06         | 0.29        | 4,935          | 5,286          | 14,121        | 538    |
| v4 (3 reps) | sonnet-low | 15.67      | 0.0185 | 0.0200    | 4.86  | 4.94       | 0.69         | 1.55        | 12             | 3,709          | 21,070        | 496    |
| v4 rep 0    | sonnet-low | 15         | 0.0232 | 0.0262    | 4.76  | 4.88       | 0.65         | 1.47        | 12             | 5,850          | 18,056        | 489    |
| L1          | sonnet-low | 16         | 0.0238 | 0.0253    | 4.65  | 4.35       | 0.00         | 0.00        | 11             | 5,831          | 19,405        | 533    |
| L2          | sonnet-low | 16         | 0.0228 | 0.0243    | 4.29  | 3.82       | 0.00         | 0.00        | 11             | 5,753          | 17,333        | 497    |

Dollars per episode by token class (harness prices: Haiku $1/$5, Sonnet $2/$10; write 1.25×, read 0.1×):

| variant  | model      | uncached | cache write | cache read | output | $/ep   |
| -------- | ---------- | -------- | ----------- | ---------- | ------ | ------ |
| v4 rep 0 | haiku45    | 0.0093   | 0.0076      | 0.0026     | 0.0038 | 0.0232 |
| L1       | haiku45    | 0.0045   | 0.0070      | 0.0018     | 0.0032 | 0.0164 |
| L2       | haiku45    | 0.0049   | 0.0066      | 0.0014     | 0.0027 | 0.0156 |
| v4 rep 0 | sonnet-low | 0.0000   | 0.0146      | 0.0036     | 0.0049 | 0.0232 |
| L1       | sonnet-low | 0.0000   | 0.0146      | 0.0039     | 0.0053 | 0.0238 |
| L2       | sonnet-low | 0.0000   | 0.0144      | 0.0035     | 0.0050 | 0.0228 |

Where the cost changes come from:

- **Haiku, crossing the cache minimum one turn earlier.** Uncached input fell from $0.0093 to $0.0045–0.0049 per
  episode, about 70 % of L1's total saving ($0.0068). It falls because turn 2 now crosses 4,096 tokens (v4 left
  turns 1–2 or 1–3 uncached), and because there are about 1.7 fewer turns. Turn 1 is still uncached.
- **Haiku, fewer turns.** Searches fell from 2.18 to 0.41 per episode and describes from 1.41 to 0.59 (L1), then to
  0.29 and 0.06 (L2). Turns fell from 7.18 to 5.47 to 4.82. Cache reads and output fell with them.
- **Sonnet, a wash.** The model stopped searching and describing entirely (0 of each, from 1.47 and 0.65), and L2 cut
  turns from 4.76 to 4.29 and tool calls from 4.88 to 3.82. But the index adds about 1.3–1.4k tokens to every turn's
  prompt, written once at 1.25× and re-read every turn. The net is +2.6 % (L1) and −1.7 % (L2) per episode against v4
  rep 0. Against v4's deflated 3-rep average, L1/L2 read as +29 %/+23 %; that gap is the cross-rep caching artefact,
  not the variant.
- **Clearing Haiku's minimum fully** (about 160 more tokens in the static prefix) would turn the turn-1 uncached read
  ($0.0040) into a write ($0.0051) that turn 2 then reads at 0.1×, instead of turn 2 writing the whole prompt again.
  Estimated saving about $0.003 per multi-turn Haiku episode, under this harness's end-of-conversation breakpoint. A
  host with a breakpoint after the static prefix needs the prefix alone (without the task prompt) over 4,096.

## Regressions and gains per task (vs v4, all 3 reps)

| variant | model      | task                      | variant | v4  | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------- | ---------- | ------------------------- | ------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1, L2  | haiku45    | `global-who-is-grace`     | fail    | 3/3 | Both runs: 1 turn, **zero tool calls**; Haiku lists the three boxes and asks the user which database and collection hold the data. In all 3 v4 reps Haiku opened with `search_mongo` ("grace@example.com user", then an empty-query listing that leads with the mongo box's guidance), then `list-databases` → `list-collections` → `find`. The search-first step was doing the exploring; the index removed it. Same failure in both variants: likely real. |
| L2      | haiku45    | `cross-open-prs-to-notes` | fail    | 3/3 | `call_tool github.list_pull_requests` with `{repo: "acme/widgets"}` → validate error with the folded schema → retried with `owner`/`repo`, got 3 of 4 PRs (`per_page: 3`) and never fetched page 2; wrote 3 titles (tool-correct, wrong content). v4 (3/3) and L1 all ran `describe_tool github.list_pull_requests` and then called page 2. The folded error carries the input schema but not the tool's description. 1 rep: plausible, not established.     |
| L1      | haiku45    | `global-csv-released`     | pass    | 0/3 | 19 tool calls at the turn budget: four `search_github` queries, eight GitHub calls, then fs search/list and finally `CHANGELOG.md`. Persistence, not the index; L2 failed it again (14 turns). Not a robust gain.                                                                                                                                                                                                                                            |
| L1, L2  | sonnet-low | `global-last-log-entry`   | pass    | 2/3 | Both pass. v4 dropped one of three; within noise.                                                                                                                                                                                                                                                                                                                                                                                                            |

Unchanged failures: `global-csv-released` fails on Sonnet in L1 and L2 (v4 0/3) and on Haiku in L2 (v4 0/3).

## L3: skipped

L3 needs the model to be able to call `execute_machine` without it being in the default tool list. Neither route
works under the eval harness without changing the harness:

1. **Hidden but callable.** An MCP server can answer `tools/call` for a tool it leaves out of `tools/list`, but the
   model can only call tools in the Messages API `tools` array, and the harness builds that array from `tools/list`.
   A hidden `execute_machine` is unreachable by the model (and by any real host that lists tools the same way).
2. **Expose after `discover_apis` via `notifications/tools/list_changed`.** The harness lists tools once per episode
   (`packages/harness/src/eval/modes.ts`, `client.listTools()` in `connectFacade`) and `agent.ts` fixes the API
   `tools` array for the whole episode; the client registers no `list_changed` handler. The facade is also stateless
   per request (R27, `createMcpHandler` builds a server per serving unit), so "discover_apis has been called" is state
   it does not hold.

An option that needs no harness change, not built here: keep both code-mode tools listed with one-line descriptions
and move the authoring body (`EXECUTE_MACHINE_BODY`, about 1.9k characters with the system sentence) into the
`discover_apis` result. That keeps code mode reachable and removes most of its standing prefix cost, but on Haiku it
moves the prefix further below the cache minimum.

## Spend

| probe | Haiku   | Sonnet  | total       |
| ----- | ------- | ------- | ----------- |
| L1    | $0.2796 | $0.4048 | $0.6844     |
| L2    | $0.2660 | $0.3882 | $0.6542     |
| wave  |         |         | **$1.3386** |

## Read

Facts:

- L1 kept completion (Haiku 16/17 = v4's per-rep 16; Sonnet 16/17 vs v4 15.67) and cut Haiku cost 29 % per episode
  and 29 % per success. Sonnet cost is flat against v4 rep 0.
- L2 cut further (Haiku −33 %, Sonnet −1.7 % vs rep 0; fewest turns and tool calls of any row), but Haiku dropped to
  14/17, so $/success on Haiku is worse than L1's ($0.0190 vs $0.0175).
- One regression is systematic: with the index, Haiku stops exploring when the prompt names no tool or box
  (`global-who-is-grace`, both variants). The other (`cross-open-prs-to-notes`, L2) is one run.
- Haiku is still under its 4,096 cache minimum on turn 1, by 50–160 tokens.

My read: take **L2 forward as the base**, not L1. The fold and compact output cut Sonnet's turns and both models'
calls, and its one unique loss rests on a single run. Before a 3-rep confirmation, add two fixes:

1. A look-before-you-ask sentence in the indexed preamble (when the task names no tool, list or query the box that
   likely holds the data before asking the user). This targets `global-who-is-grace`.
2. Spend the roughly 160 tokens Haiku needs to clear the minimum on something useful, for example that sentence plus
   a short per-box hint, rather than padding.

Then re-run 3 reps on both models. `global-csv-released` remains the tier's open completion problem and is untouched
by this wave.
