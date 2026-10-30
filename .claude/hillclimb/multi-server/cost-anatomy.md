# Cost anatomy: direct vs Projection on the multi-server tier

Offline analysis of transcripts that were already recorded. It makes no API calls and changes no source. Inputs:

- direct mode: `direct-ref/2026-10-30T04-17-38.155Z.json` (17 tasks × 3 reps × 2 models = 102 episodes)
- Projection v4: `v4/raw/multi.json` (`projection` and `projection-boxes`, 204 episodes)
- static prefixes dumped from the harness (`openMultiWorld` + `openSession(mode, world, { boxDescriptions: true })`, the
  configuration the runs used)

Only multi-tier records were read. Guard and single-server traces were not opened.

Scripts (scratchpad, not committed): `dump-prefix.ts`, `anatomy.py`, `levers.py`, `errturns.py`, `codemode.py`,
`codetools.py` under `/private/tmp/claude-501/-Users-Vibdev-code-mccircut/b28e850a-06c4-4edc-9a9f-df73fce4481b/scratchpad/`.

## How the harness records usage, and the method used here

- `agent.ts` sums `input_tokens`, `output_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens` over the
  episode. **Per-turn usage is not recorded.** Each record does keep the full transcript: the system prompt, every
  assistant block and every tool result exactly as the model saw it. Tool definitions are not in the record.
- `run.ts` `estimateUsd`: list price per MTok (Haiku 4.5 $1/$5, Sonnet 5.5 $2/$10). Cache reads cost 0.1× input and
  cache writes 1.25×. These prices match the current Anthropic price list.
- **Caching is on.** Each call sends a top-level `cache_control: {type: 'ephemeral'}` (agent.ts:309). This is automatic
  caching with a 5-minute TTL and the breakpoint on the last block, so every turn writes the whole prompt and the next
  turn reads it. There is **no breakpoint at the end of the static prefix** (tools + system). As a result, one episode
  reuses another's prefix only when its first prompt is byte-identical, i.e. the same task with no per-episode temp path.
- **Per-turn reconstruction.** Turn _t_'s prompt is modelled as P_t = S + Σ_{k<t}(O_k + R_k): S is the static prefix
  (tools, system, the API's tool-use preamble and the user prompt), O_k is the output of turn _k_ (the recorded
  `output_tokens` split over turns in proportion to each turn's visible characters), and R_k is turn _k_'s tool results
  (characters × a fitted tokens/char). For each mode × model, S and tokens/char are fitted by least squares on the
  recorded totals (input + cache read + cache write = Σ P_t). The median absolute error per episode is **0.07–0.09 %
  (direct) and 1.4–2.8 % (Projection)**. Caching is then simulated turn by turn: a prompt is written when it reaches the
  model's minimum cacheable length (Haiku 4.5: 4096 tokens, Sonnet 5.5: 512), and turn 1 counts as a cross-episode hit
  when the recorded writes fall about P_1 short of the simulated writes. The simulated $ matches the recorded $ to 0.2 %
  for direct and to 3–8 % for Projection (it overestimates Sonnet slightly). Every attribution and lever figure below
  comes from this simulation.

## 1. Per-episode cost

Mean values, with medians in parentheses. Token counts are per episode. "Input" is uncached + cache read + cache write.

| mode × model            | success | $/ep            | $/success | turns   | tool calls | input             | uncached        | cache read        | cache write     | output    |
| ----------------------- | ------- | --------------- | --------- | ------- | ---------- | ----------------- | --------------- | ----------------- | --------------- | --------- |
| direct · haiku45        | 43/51   | 0.0544 (0.0666) | 0.0645    | 3.8 (3) | 3.0 (2)    | 188,181 (146,453) | 19 (15)         | 159,083 (145,749) | 29,078 (48,782) | 426 (379) |
| direct · sonnet-low     | 48/51   | 0.1361 (0.1761) | 0.1446    | 3.5 (3) | 3.0 (2)    | 226,855 (194,668) | 9 (8)           | 189,330 (193,499) | 37,516 (64,717) | 442 (387) |
| projection · haiku45    | 48/51   | 0.0232 (0.0202) | 0.0246    | 7.1 (6) | 6.7 (5)    | 37,548 (26,882)   | 10,046 (9,999)  | 21,723 (11,563)   | 5,780 (5,476)   | 749 (665) |
| projection · sonnet-low | 47/51   | 0.0185 (0.0180) | 0.0200    | 4.9 (5) | 4.9 (5)    | 24,791 (24,067)   | 12 (12)         | 21,070 (17,340)   | 3,709 (4,458)   | 496 (520) |
| proj-boxes · haiku45    | 48/51   | 0.0241 (0.0218) | 0.0256    | 7.5 (7) | 7.1 (6)    | 37,457 (29,711)   | 11,435 (11,950) | 20,764 (10,717)   | 5,259 (5,575)   | 796 (732) |
| proj-boxes · sonnet-low | 47/51   | 0.0179 (0.0178) | 0.0195    | 4.9 (5) | 4.8 (5)    | 23,301 (21,666)   | 12 (12)         | 19,677 (15,892)   | 3,612 (4,140)   | 494 (502) |

Totals: direct $2.77 (haiku) and $6.94 (sonnet). Projection $1.18, $0.94, $1.23 and $0.91.

**Direct-mode costs are lowered by cross-episode cache hits.** In 22 of 51 direct episodes per model, turn 1 read the
48–65k-token prefix that an earlier episode with the same first prompt had written. Example, `cross-shipped-to-comment`
on direct sonnet: rep 0 cost $0.206 and reps 1–2 cost $0.058 each. In a real host, the tool list is cached across
conversations, because the host places a breakpoint after the tools and system prompt. With that **warm** prefix
(estimated by turning every turn-1 write of S into a read), direct would cost about **$0.023/ep on Haiku**, the same as
Projection today, and **$0.052/ep on Sonnet**, still 2.8× Projection. Projection's cost advantage on Haiku is therefore
mostly an artefact of how the harness places its cache breakpoint.

## 2. Where the input goes

### Static prefix, measured

| mode             | system chars | tool-def chars (JSON, as sent) | tools | fitted S, haiku45 (tokens) | fitted S, sonnet-low (tokens) |
| ---------------- | ------------ | ------------------------------ | ----- | -------------------------- | ----------------------------- |
| direct           | 7,006        | 161,703                        | 130   | **48,596**                 | **64,568**                    |
| projection       | 1,398        | 7,734                          | 8     | **3,093**                  | **3,632**                     |
| projection-boxes | 1,351        | 6,732                          | 7     | **2,832**                  | **3,301**                     |

On the same characters, Sonnet 5.5's tokenizer produces about 1.17–1.33× as many tokens as Haiku 4.5's. Projection's
code-mode surface (`execute_machine`, `discover_apis` and the system sentence about machines) is 1,941 characters, about
660–790 tokens, or 21–24 % of S.

### Input tokens and $ by source (per episode)

| mode × model            | static tok (share) | tool-result tok (share) | own prior output tok (share) | $ static | $ results | $ prior output re-read | $ output | no-cache $/ep |
| ----------------------- | ------------------ | ----------------------- | ---------------------------- | -------- | --------- | ---------------------- | -------- | ------------- |
| direct · haiku45        | 185,809 (98.7 %)   | 1,666 (0.9 %)           | 718 (0.4 %)                  | 92.7 %   | 2.6 %     | 0.7 %                  | 3.9 %    | 0.190         |
| direct · sonnet-low     | 225,354 (99.3 %)   | 1,049 (0.5 %)           | 484 (0.2 %)                  | 95.3 %   | 1.0 %     | 0.5 %                  | 3.3 %    | 0.458         |
| projection · haiku45    | 21,836 (58.1 %)    | 13,196 (35.1 %)         | 2,576 (6.9 %)                | 57.3 %   | 20.9 %    | 5.2 %                  | 16.7 %   | 0.041         |
| projection · sonnet-low | 17,662 (71.1 %)    | 6,427 (25.9 %)          | 746 (3.0 %)                  | 41.7 %   | 28.7 %    | 4.7 %                  | 25.0 %   | 0.055         |
| proj-boxes · haiku45    | 21,320 (56.8 %)    | 13,175 (35.1 %)         | 3,025 (8.1 %)                | 56.4 %   | 21.0 %    | 5.8 %                  | 16.9 %   | 0.041         |
| proj-boxes · sonnet-low | 16,119 (69.0 %)    | 6,478 (27.7 %)          | 772 (3.3 %)                  | 39.7 %   | 29.4 %    | 4.9 %                  | 26.1 %   | 0.052         |

- Direct mode is almost entirely static prefix: about 95 % of its dollars are the 49–65k-token tool list re-read on
  every turn. Caching already cuts that by 3.4× (no-cache column).
- **Projection on Haiku 4.5 sits below the cache floor.** S is about 3.1k tokens, and Haiku 4.5 caches nothing under 4096. The first 1–3 turns of each episode therefore go uncached at the full $1/MTok: 10.0–11.4k uncached tokens per
  episode, which is **43–47 % of Haiku Projection's dollars**. The simulation reproduces this (500k simulated vs 512k
  recorded uncached tokens). Sonnet 5.5's floor is 512, so it caches from turn 1.
- In Projection, tool results account for 26–35 % of input tokens. Most of that is Projection's own discovery output
  (§4), not upstream data.

## 3. Hop overhead

| mode × model            | turns before first real call (median / mean) | tokens in those turns (mean) | $ before first real call (mean) | pure-discovery turns / ep | $ share in pure-discovery turns |
| ----------------------- | -------------------------------------------- | ---------------------------- | ------------------------------- | ------------------------- | ------------------------------- |
| direct · haiku45        | 0 / 0.06                                     | 2,870                        | 0.0014                          | 0                         | 0 %                             |
| direct · sonnet-low     | 0 / 0                                        | 0                            | 0                               | 0                         | 0 %                             |
| projection · haiku45    | 2 / 1.90                                     | 7,392                        | 0.0045                          | 2.88                      | **32.2 %**                      |
| projection · sonnet-low | 1 / 1.39                                     | 5,580                        | 0.0038                          | 1.39                      | **20.6 %**                      |
| proj-boxes · haiku45    | 2 / 1.75                                     | 6,074                        | 0.0040                          | 3.06                      | **32.5 %**                      |
| proj-boxes · sonnet-low | 1 / 1.22                                     | 4,449                        | 0.0031                          | 1.31                      | **19.4 %**                      |

A "real call" is any tool call in direct mode, and `call_tool` or `execute_machine` in Projection. A "pure-discovery
turn" is a turn whose calls are all `search_*`, `describe_tool` or `discover_apis`. Projection takes +3.2 turns (Haiku)
and +1.4 turns (Sonnet) per episode compared with direct.

Describe → call folding (`describe_tool(X)` followed in the next turn by `call_tool(X)`):

| mode × model            | describe calls | next turn calls X | calls another tool | no call next | `call_tool` total | `call_tool` never described |
| ----------------------- | -------------- | ----------------- | ------------------ | ------------ | ----------------- | --------------------------- |
| projection · haiku45    | 63             | **51 (81 %)**     | 6                  | 6            | 171               | 85 (50 %)                   |
| projection · sonnet-low | 35             | **28 (80 %)**     | 5                  | 2            | 132               | 98 (74 %)                   |
| proj-boxes · haiku45    | 63             | **51 (81 %)**     | 4                  | 8            | 187               | 110 (59 %)                  |
| proj-boxes · sonnet-low | 25             | **17 (68 %)**     | 6                  | 2            | 139               | 113 (81 %)                  |

Most `call_tool` calls skip `describe_tool`, and the guesses mostly work. Undescribed calls succeeded 131/195 times on
Haiku (35 failed validation, 21 named an unknown tool) and 190/211 on Sonnet. Described calls succeeded 151/163 times
on Haiku. Turns where every call errored cost 8.3–10.2 % of Haiku Projection's dollars and 4.1–4.2 % of Sonnet's (direct:
1–2 %). Haiku also sometimes passed `args` as a JSON string (5 times), and Sonnet called qualified names such as
`fs.list_allowed_directories` as if they were top-level tools (10 times).

## 4. Result bloat

Ranked by input tokens re-read in later turns (characters × fitted tokens/char × the number of later prompts that carry
the result). Shares are of all input tokens.

**Projection** (both modes pooled, about the same in each):

| result                   | n (proj / boxes) | mean chars | max chars | share of input  |
| ------------------------ | ---------------- | ---------- | --------- | --------------- |
| `search_github`          | 73 / 68          | 3,017      | 13,189    | **12.8–13.1 %** |
| `describe_tool`          | 98 / 88          | 2,374      | 5,566     | **8.7 %**       |
| `search_fs`              | 61 / 68          | 1,300      | 1,700     | 2.9–3.4 %       |
| `search_mongo`           | 41 / 47          | 1,160      | 2,338     | 2.3–2.8 %       |
| `discover_apis`          | 5 / 3            | 5,700      | 5,728     | 0.7–1.3 %       |
| `call_tool fs.read_file` | 29 / 24          | 3,758      | 34,825    | 0.9–1.0 %       |
| `search_tools`           | 3 / 0            | 6,100      | 6,100     | 0.7 %           |
| each other upstream tool | —                | < 1,100    | —         | ≤ 0.3 %         |

**Direct:** every result is under 0.3 % of input. The largest is `fs__read_text_file` (one 34k-character log).

Discovery output makes up about **28 % of Projection's input tokens**. Upstream data makes up about 3 %. Whether those
characters get used:

- **Search listings:** 5,361 entries were listed (median 14 per search, pages up to 25). Only **463 (8.6 %)** were
  ever named again in a later call or text. Of those 463, 211 were at rank 1, 282 (61 %) in the top 5 and 340 (73 %) in
  the top 10. The other 124 came from bare listings that the model browsed. A bare `search_github` opens with the box's
  guidance, which is 6.9 % of all search characters and about 3k characters per bare github search.
- **`describe_tool`:** it prints the JSON Schema pretty-printed with a 4-space base indent. Re-serializing it compactly
  shrinks the describe output by **30 %** (441k → 311k characters) without losing any content.
- **Upstream results:** large fields were mostly not used. Of `list_pull_requests`' characters, 19 % sat in fields the
  model ever referred to again (`title`, `state`). `html_url`, `created_at`, `head.ref` and `user.login` were never
  used. The same holds for `list_issues` (27 %), `list_branches` (27 %, `protected` never used) and `list-databases`
  (26 %, `size` never used). These results are a small share of input, so trimming them saves little money.

## 5. Code mode

- `execute_machine`: **7 calls in 6 of 204 episodes**, all on Haiku and all on `cross-shipped-to-comment` (3/3 reps in
  each Projection mode). Sonnet-low never used code mode. 6 of the 7 calls succeeded. The failure was a
  `SyntaxError: Unexpected identifier 'as'` (a TypeScript cast); the model fixed it on the next call. **All 6 episodes
  passed.**
- Machine source: 1,294–1,833 characters (about 400–600 output tokens). `discover_apis` returns 5,700–5,728 characters
  (about 1.4–1.9k tokens) and is re-read on every later turn: 65k tokens in total over the 8 calls.
- Cost: code-mode episodes ran $0.018–0.024. Haiku Projection's mean is $0.023, and Sonnet's `call_tool` episodes on
  the same task ran $0.012–0.029. They took 5–7 turns, because `discover_apis` plus a describe come before the machine.
  So code mode neither saves nor costs anything noticeable per episode on this tier.
- Its standing cost: the code-mode tool definitions and system sentence take 21–24 % of Projection's static prefix on
  every turn of every episode. Removing them would save about $0.0018/ep on Sonnet (about 10 %) and about $0.0002/ep on
  Haiku, where the prefix is uncached anyway (see lever A).

## 6. Cost levers, ranked

Every saving below is simulated against the same per-turn model with the model's behaviour held fixed: the model is
assumed to make exactly the calls that remain. These are first-order estimates and say nothing about completion. Each
figure is $ saved per Projection episode, as the mean of the four Projection cells, with per-model ranges.

| #   | lever                                                                                                                                                                                                                                                                                | mean $/ep | haiku45 $/ep                          | sonnet-low $/ep | evidence                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **B. Put a static index of every qualified tool name, grouped by box, in the prefix and skip the search hop.** About 2.5k characters, or 850–1,020 tokens; the pure-search turns are dropped                                                                                         | 0.0040    | 0.0048–0.0058                         | 0.0025–0.0028   | 1.1–1.9 pure-search turns per episode. Search output is 18–19 % of input tokens, and only 8.6 % of the entries listed are ever used. Adding one-line purposes too (11k characters) costs more than it saves on Sonnet (−$0.0046)          |
| 2   | **A. Bring Haiku 4.5's prefix to the 4096-token cache floor or above.** Lever B's names index (about 850 tokens) brings S to about 3.9k. About 200 more tokens of useful content clears the floor. A full purposes index (about 3.8k tokens) overshoots and costs more than it saves | 0.0031    | **0.0058–0.0066 (25–28 %)**           | 0               | 10–11.4k uncached tokens per episode, which is 43–47 % of Haiku's dollars. S is 2.8–3.1k, below the 4096 floor                                                                                                                            |
| 3   | **E. Put a cache breakpoint at the end of the static prefix** (host or harness side, so the prefix stays warm across conversations)                                                                                                                                                  | 0.0023    | 0 today; about 0.0048 once A lands    | 0.0043–0.0048   | Today turn 1 writes S at 1.25×; with the breakpoint it would read S at 0.1×. In 29/51 Sonnet episodes turn 1 paid the write. The same change saves $0.032 (Haiku) and $0.084 (Sonnet) per direct episode, which changes the baseline (§1) |
| 4   | **C. Fold describe into call.** `call_tool` returns the schema (or the specific argument error) when validation fails, so the model calls directly                                                                                                                                   | 0.0015    | 0.0010–0.0022 (0.0020 after A)        | 0.0010–0.0015   | 68–81 % of describes are followed at once by a call to the same tool, about 1 per Haiku episode. Sonnet already skips describe on 74–81 % of calls                                                                                        |
| 5   | **D. Shrink the discovery output.** Compact the describe JSON (−30 %, measured) and cap query search pages at 8 entries                                                                                                                                                              | 0.0008    | −0.0006 alone; +0.0007–0.0009 after A | 0.0023          | describe output is 8.7 % of input and search output 18–19 %. 61 % of used entries are in the top 5. On Haiku, smaller prompts fall further below the cache floor, so D only pays after A                                                  |

Runners-up:

- **Prevent all-error turns** (upper bound): Haiku $0.0019–0.0025 and Sonnet $0.0008. Fixes would be accepting
  stringified `args`, resolving a near-miss or unknown name to a single match, and auto-qualifying names.
- **Drop code-mode tools from the default surface**: $0.0010 mean. This puts at risk the 6 episodes that passed via
  `execute_machine`.
- **Terser final answer** (half of the last turn's output): $0.0004–0.0008. The last turn is 20–31 % of output tokens.
- **Model choice, outside the ranking:** under Projection, Sonnet 5.5-low costs less per success than Haiku 4.5 ($0.020
  vs $0.025, with 47 vs 48 successes). Haiku pays for uncached prefixes and about 2.2–2.6 more turns.
- **Failed episodes:** these account for 7–13 % of Projection spend ($0.15 per cell on Haiku, mostly
  `global-csv-released` turn-capped). This is a task-completion problem, not a cost lever.

**All levers together** (A+B+C+D with the names-only index): Haiku −$0.0112 to −$0.0121/ep (48–50 %) and Sonnet
−$0.0039 to −$0.0043/ep (22–23 %). Adding E takes roughly another $0.0045–0.0048 off each, leaving about $0.007/ep on
Haiku and $0.010/ep on Sonnet, down from $0.023 and $0.018.

## Caveats

- Per-turn usage is reconstructed, not recorded. To measure this directly, the harness should keep `message.usage` per
  turn in `transcript.messages`; that is cheap to add.
- The lever estimates hold the model's behaviour fixed. B and C in particular assume the model goes straight to the
  call once it has the name or the error schema. A probe has to confirm that completion holds.
- The fitted tokens/char for Projection tool results on Haiku (0.25) is lower than for direct (0.41). Projection's
  results are mostly English text lines, while direct's are JSON. The fitted S values are not affected (fit error
  ≤ 2.8 %).
