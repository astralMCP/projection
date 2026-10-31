# Offline search hill-climb (search.ts)

Zero-cost, deterministic: every number below comes from the real facade (`wrapMcpServer` / `wrapMcpServers`) over
fixture catalogs, with no model and no network. Reproduce with
`pnpm --filter @astral-mcp/harness run eval:offline <search|invariance|surface> [--split train|test|all]` after
`pnpm --filter @astral-mcp/projection build`.

## The eval

- **Corpus** (`packages/harness/test/fixtures/search-corpus.json`, built by `offline-search/build-corpus.ts` from
  1,953 recorded episodes across the hill-climb worktrees): 1,173 cases.
  - 467 `recorded`: distinct queries models sent to `search_tools` / `search_<alias>`, gold = the in-scope tools the
    model went on to describe or call without error before its next search, intersected with an intent rule
    (390 cases); when the model used none of them, the intent rule alone (77 cases).
  - 436 `recorded-lifted`: the same queries against the 130-tool global `search_tools` (fs + github + mongo).
  - 120 `handwritten`: user-style queries for github, fs, mongo and the global search, written before any ranking was
    measured.
  - 150 `generated`: seeded queries over a 1,003-tool synthetic gateway catalog (three naming styles), half
    paraphrases.
  - Kept apart, never scored: 73 distinct **content** queries (310 issued), where the model searched the catalog for
    data ("CSV export", "widgets", "README", "grace@example.com order").
- **Split**: cases grouped by sorted token set (so a query and its lifted twin, or a reordering, share a side), 60/40
  under seed 20261030: 704 train, 469 test. Stored in the fixture. While editing, only train cases were read
  (`--failures` refuses the test split); test was read as one aggregate line per round.
- **Metrics**: recall@k = share of cases with any gold tool in the top k (gold is a set of acceptable tools); MRR of
  the first gold tool, rankings followed to depth 100; page tokens = mean characters of the first result page / 4
  (an approximation, not a tokenizer).

## Rounds

Rule: keep a round only if train AND test improve; revert when train rises and test is flat; at most one root
cause per round; result pages may not grow more than 10 %.

| round | change (one root cause)                                                            | train R@5 / MRR | test R@5 / MRR | page tok train / test | kept?                                 |
| ----- | ---------------------------------------------------------------------------------- | --------------- | -------------- | --------------------- | ------------------------------------- |
| 0     | baseline (D10: any word, +2 name, +1 title/description, catalog-order ties)        | 89.1 / 0.779    | 89.6 / 0.810   | 741 / 767             | —                                     |
| 1     | split camelCase query words (`createIssue` → create, issue)                        | 89.6 / 0.784    | 89.6 / 0.810   | 744 / 770             | reverted (test flat)                  |
| 2     | IDF token weights, `1 + ln(N / df)`                                                | 91.6 / 0.807    | 92.3 / 0.817   | 741 / 766             | **kept**                              |
| 3     | coordination factor (score × share of query tokens matched)                        | 91.1 / 0.803    | 92.3 / 0.812   | 741 / 767             | reverted (train down)                 |
| 4     | BM25 length normalization of description hits (k1 1.2, b 0.75)                     | 90.8 / 0.803    | 90.6 / 0.781   | 733 / 761             | reverted (both down)                  |
| 5     | ties broken by name coverage, then catalog order                                   | 91.8 / 0.821    | 94.2 / 0.846   | 738 / 764             | **kept**                              |
| 6     | index input-schema words (property names, enum values, descriptions) at weight 0.5 | 93.5 / 0.833    | 94.0 / 0.853   | 892 / 918             | reverted (pages +21 %, test R@5 down) |
| 6b    | same, but schema words only re-rank tools the name or description already matched  | 92.3 / 0.825    | 93.2 / 0.849   | 738 / 764             | reverted (test R@5 down)              |

Final (rounds 2 + 5) against baseline:

| split | R@1 %       | R@5 %       | MRR           | page tok  |
| ----- | ----------- | ----------- | ------------- | --------- |
| train | 69.5 → 74.4 | 89.1 → 91.8 | 0.779 → 0.821 | 741 → 738 |
| test  | 74.2 → 77.2 | 89.6 → 94.2 | 0.810 → 0.846 | 767 → 764 |

## Invariance (metamorphic)

Search score = 1 − mean |ΔRR| of the gold tool under the transform; describe score = byte-identical `describe_tool`
(shuffle, decoys) or a did-you-mean naming the right tool when a tool is described in the other naming convention
(renames, both directions).

| transform | search train, before → after | search test, before → after | describe (unchanged by the climb) |
| --------- | ---------------------------- | --------------------------- | --------------------------------- |
| camel     | 0.994 → 0.993                | 0.998 → 0.997               | 0.51                              |
| snake     | 1.000 → 1.000                | 1.000 → 1.000               | 1.00                              |
| prefix    | 0.999 → 0.999                | 0.999 → 0.998               | 1.00                              |
| shuffle   | 0.929 → 0.989                | 0.940 → 0.994               | 1.00                              |
| synonyms  | 0.960 → 0.980                | 0.967 → 0.986               | n/a                               |
| decoys    | 0.941 → 0.969                | 0.990 → 0.973               | 1.00                              |
| **mean**  | **0.971 → 0.988**            | **0.982 → 0.991**           | **0.90**                          |

The describe score's one weak spot is camelCase guesses on a snake_case catalog (`listIssues` gets no did-you-mean
for `list_issues`): round 1's tokenizer fixes it (0.51 → 1.00) but was reverted under the retrieval rule. Decoys on the
test split got slightly worse: IDF lets 50 unrelated tools shift word weights.

## Surface size (chars, ~tokens = chars / 4; fixture catalogs, no box descriptions)

| world      | mode             | tools | system         | tool defs         | system + defs     | describe_tool  | search page    |
| ---------- | ---------------- | ----- | -------------- | ----------------- | ----------------- | -------------- | -------------- |
| github     | direct           | 95    | 6,816 (~1,704) | 106,464 (~26,616) | 113,280 (~28,320) | —              | —              |
| github     | projection       | 5     | 7,399 (~1,850) | 3,723 (~931)      | 11,122 (~2,781)   | 4,056 (~1,014) | 3,822 (~956)   |
| filesystem | direct           | 14    | 93 (~23)       | 8,071 (~2,018)    | 8,164 (~2,041)    | —              | —              |
| filesystem | projection       | 5     | 676 (~169)     | 3,723 (~931)      | 4,399 (~1,100)    | 1,398 (~350)   | 1,650 (~413)   |
| mongodb    | direct           | 21    | 106 (~27)      | 46,137 (~11,534)  | 46,243 (~11,561)  | —              | —              |
| mongodb    | projection       | 5     | 689 (~172)     | 3,723 (~931)      | 4,412 (~1,103)    | 3,384 (~846)   | 833 (~208)     |
| multi      | direct           | 130   | 7,007 (~1,752) | 161,633 (~40,408) | 168,640 (~42,160) | —              | —              |
| multi      | projection       | 8     | 1,384 (~346)   | 7,711 (~1,928)    | 9,095 (~2,274)    | 3,977 (~994)   | 4,900 (~1,225) |
| multi      | projection-boxes | 7     | 1,337 (~334)   | 6,709 (~1,677)    | 8,046 (~2,012)    | 3,977 (~994)   | 4,005 (~1,001) |

Sanity against prior art: github / filesystem / mongodb projection system + defs equal wave1.md's v4 figures exactly
(11,122 / 4,399 / 4,412); multi projection 9,095 and projection-boxes 8,046 are 22 characters under wave1's 9,117 and
8,068, which ran with box descriptions on; cost-anatomy.md's direct multi row (7,006 system, 161,703 tool-def chars)
is within 0.05 %.

## Findings beyond ranking

- **One in six real search calls asks for data, not tools.** 310 of the 1,924 recorded non-empty facade searches
  (16 %, 73 distinct) are content queries — "CSV export" (59× on `search_github` alone), "widgets", "README", "app.log", a customer's email.
  No ranking answers them; every such call returns either nothing or a page of irrelevant tools. That is a facade
  question: say in the `search_<alias>` description that it searches tool names and descriptions, not the box's
  data, or answer an all-miss query with a pointer to the box's own search/list tools.
- **Missing capability shows up as search.** "get repository", "repository info" have no GitHub tool at all; models
  then guess.
- **Consolidated tools hide in their schemas.** `pull_request_read` serves "PR files diff", "check run status",
  "review comments" through its `method` enum; `find` serves "sort and limit". Round 6 found real signal there, but as
  a matching field it costs 21 % more page; a better lever may be surfacing the enum values in the one-line purpose.
- **Vocabulary gaps** ("PR" → pull request, "mkdir", "unarchive" → restore, "sign off" → approve) remain, as D10
  predicted; no thesaurus was tried.
