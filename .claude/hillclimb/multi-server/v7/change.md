# v7: just-in-time hints on empty results and tool-search misses

**Status: probe only.** csv cleared the 3/5 bar for neither model (haiku
2/5, sonnet 0/5), so the full round was not run. The source is reverted to
v4, and `change.patch` keeps the diff (commit `e09cb80`).

A behaviour change, not a copy change: Projection now annotates empty results
where the model reads them. This applies to single-server and multi-server
facades alike, so the guard (single-server tiers) measures its single-server
effect.

## Hypothesis

Models give up when they read an empty result. Guidance in the system prompt
was read once at the top of the context and is not in view at that moment.
Make every empty result actionable where it lands, with hints derived
generically from the catalog: no server-, tool- or task-specific text.

## Evidence

- **v4 categorization** (`v4/categorization.md`): `global-csv-released` 12/12
  fail. GitHub (the box the host description points at) came up empty, sonnet
  answered "no evidence either way", and haiku re-ran content queries against
  tool-name search until the turn cap. The two `global-last-log-entry` sonnet
  misses failed a direct read of `app.log` and one name search, then answered
  "there's no `app.log`" without listing the directory.
- **v5 probe** (`v5/change.md`): a preamble sentence moved 9/10 csv episodes
  into `fs`, but they failed there. Sonnet ran one non-recursive
  `fs.search_files "CHANGELOG"`, got `{ "content": "No matches found" }`, and
  stopped. Haiku spent its turns on GitHub. csv was 1/5 for each model.
- **v6 probe** (`v6/change.md`): a general "empty lookups are weak evidence"
  sentence gave csv 0/5 haiku (5/5 turn-capped) and 2/5 sonnet. The misses
  stopped at three different empty signals: a box never visited, a
  non-recursive glob miss, and `search_fs` returning "No tools matching …",
  which the model read as a data miss. Tool-name-search misses per csv
  episode were 3-5 for haiku and 1-2 for sonnet: models send data queries
  (`"CSV export feature"`) to `search_<box>`.
- v6 probe raw shapes of the empty results: `{"total_count":0,"items":[]}`
  (29×, GitHub search), `{ "content": "No matches found" }` (9×, fs
  `search_files`), `{ "documents": [], "queryResultsCount": 0, … }` (mongo
  `find`), upstream `ENOENT: no such file or directory …` and
  `404 Not Found: …`.

## Mechanism

One new module, `packages/projection/src/catalog/empty-hint.ts`, with the
detection and the hint builders. Two call sites use it.

1. **Search misses** (`search_tools` single-server, `search_tools` across
   boxes, `search_<alias>`). When the page is empty, the no-match line now
   says what was searched and where to look instead. The wording changed from
   "No tools matching" to "No tools match":
   - single: `No tools match "<q>" on server "<id>". This searches tool names
and descriptions, not the server's data — to look for data, call one of
its read tools: <up to 5>.`
   - box: `… in the <alias> box. This searches tool names and descriptions,
not the <alias> box's data — … its read tools: <up to 5, qualified>.`
   - global: `… in any box. … not the boxes' data — … their read tools: <up
to 2 per box>.`
2. **Empty read-only `call_tool` results** (catalog projection only).
   `call_tool` checks the result only when policy decided `auto`, i.e. the
   tool ran without approval. The resume path (approved writes) never
   checks. `execute_machine` and `TOOL_RESULT` are untouched. When the result
   is empty, Projection appends one line to the text. `structuredContent` is
   never altered:
   - single: `Nothing found with <tool>. Other ways to look: <up to 3 other
read tools>.`
   - multi: `Nothing found with <box>.<tool>. Other ways to look in <box>:
<up to 3>; or look in another box that could hold it: <other
aliases>.`
   - An upstream `isError` whose message reads as not-found (`not found`,
     `no such`, `does(n't| not) exist`, `404`, `ENOENT`, `no X found`) gets
     the same line as a second text block. The structured error's JSON text
     stays parseable.

"Read tools" are the tools whose resolved posture is "runs immediately"
under the facade's policy. They are ordered browsing first (name words
`list|tree|browse|ls|dir`), then `search|find|query|count`, then
`get|read|show`, then the rest, with catalog order kept within a group.
Names are split on non-alphanumerics and camelCase. A plain-identifier name
(`[A-Za-z0-9_.-]{1,64}`) prints raw. Any other name is neutralized, capped at
64 characters and JSON-quoted (S5). Aliases are grammar-checked (R39) and
print raw.

**Emptiness** counts as any of:

- `null`
- `[]`
- a text-only content array whose texts are all empty
- empty or whitespace text, `[]`, or `{}`
- a text of at most 300 characters starting with `no matches`, `no
results`, `nothing found`, `not found`, `0 results` or `no such`, or
  matching `/\bno \w+( \w+)? found\b/i`
- JSON text whose decoded value is empty
- an object carrying no data and signalling emptiness, checked up to 3
  levels deep. "Carrying no data" means every array is empty, every string
  is empty text, every nested object is empty, numbers other than
  `*count`/`*total` are ignored, and booleans/null are ignored.
  "Signalling emptiness" means it has an empty array, an empty-text string,
  a `*count`/`*total` equal to 0, or no keys at all.

`{ ok: true }` is not empty. A non-empty scalar next to an empty array
(`{ database: "shop", documents: [] }`) is not empty.

Tests: `test/catalog/empty-hint.test.ts` (65 cases) covers:

- a detection table with true and false cases, including the MongoDB
  `{count: 0}` and `{documents: []}` shapes, the fs "No matches found" text
  and structured forms, and the GitHub-fake `total_count`/`items` pages
- not-found error patterns
- ranking
- policy deciding what a read tool is
- single, box and global miss text
- `call_tool` hints for single and multi, MongoDB shapes, and the
  not-found error block with its JSON intact
- no hint for non-empty results, other errors, writes, or a lone read tool
- hostile names neutralized
- machines unaffected

The no-match assertions changed in `test/catalog/search.test.ts` and
`test/multi/toolboxes.test.ts`. No golden embeds the text.
`pnpm run check`: green (16/16 tasks) on the first run.

## DECISIONS draft (D-entry)

> **Dnn. Just-in-time hints on empty results.** The catalog projection
> annotates empty answers where the model reads them, rather than relying on
> system-prompt guidance read once at the top. A search tool that matches no
> tools says that it searched tool names and descriptions, not the server's
> data, and names up to five read tools (posture "runs immediately",
> browsing names first). A read-only `call_tool` whose result is empty, or
> whose upstream error reads as not-found, gets one appended text line
> naming up to three other read tools of the same server, plus the other
> boxes on a multi-server facade. The hints are built from the catalog and
> the policy engine alone, with no server- or tool-specific text. Names are
> S5-inert, and `structuredContent` and machine `TOOL_RESULT` events are
> never altered. Rationale: live evals showed models treating a tool-name
> search miss as a data miss, and stopping or looping after one empty
> lookup. A preamble rule had no effect because it is not in view when the
> empty result arrives. Risk: emptiness detection is heuristic, and a false
> positive appends a harmless pointer to other read tools. A false negative
> is today's behaviour.

## Expected effect

- **csv:** search misses on `search_github` / `search_fs` now name read
  tools, so haiku's 3-4 wasted tool-name searches per episode should turn
  into data lookups. Every empty GitHub search
  (`{"total_count":0,"items":[]}`) now ends with "or look in another box that
  could hold it: fs, mongo", which targets haiku's GitHub-only loops to the
  turn cap. In `fs`, a `search_files` "No matches found" now points at
  `list_directory` / `directory_tree` (browsing first), which is the move
  that rescued every last-log episode in v5/v6.
- **last-log:** the `ENOENT` on `read_file app.log` gets "Other ways to look
  in fs: list_directory, …", which is the recovery models already make, now
  prompted.
- **Haiku turn-cap loops:** this should shorten them, because each empty
  result names a different strategy. Risk: haiku follows the hint into
  low-value browsing (`list_allowed_directories`) and spends turns anyway.
- **Guard (single-server):** search misses and empty reads in the
  github/fs/mongodb tiers now carry hints. Expected neutral to slightly
  positive (e.g. `read-lowercase-readme`, `db-which-db-has-daily`). The risk
  is a false-positive hint distracting a model after a legitimately empty
  answer (`db-count-shipped` with a real count of 0 is not in the guard).

## Probe

Probe file: `v7/probe/2026-10-30T03-52-38.741Z.json`. Tasks
`global-csv-released` and `global-last-log-entry`, `projection` mode, box
descriptions on, both models, 5 reps: 20 episodes, $0.63 (export.mjs
`costUsd` pricing).

| task                    | model      | v7 probe | v6 probe | v5 probe | v4 round | turn-capped (v7 / v6) |
| ----------------------- | ---------- | -------- | -------- | -------- | -------- | --------------------- |
| `global-csv-released`   | haiku45    | 2/5      | 0/5      | 1/5      | 0/3      | 3/5 / 5/5             |
| `global-csv-released`   | sonnet-low | 0/5      | 2/5      | 1/5      | 0/3      | 0/5 / 0/5             |
| `global-last-log-entry` | haiku45    | 5/5      | 5/5      | 5/5      | 3/3      | 0/5 / 0/5             |
| `global-last-log-entry` | sonnet-low | 5/5      | 5/5      | 5/5      | 2/3      | 0/5 / 0/5             |

csv pooled is 2/10, the same as v5 and v6. The bar (csv ≥3/5 for either
model, last-log not regressing) is not met. last-log holds at 10/10. v7 has
no preamble sentence: it sits on the v4 source, while v5 and v6 each added
one.

### Hints: how often they appeared and were followed

"Followed" means the model's next call (`call_tool` / `describe_tool` target,
or a `search_<box>`) was one of the tools the hint named. For the
other-box clause, it means the next call went to one of the named boxes.

| cell            | search-miss hints (episodes) | followed | empty-result hints (episodes) | next call: named tool, same box | next call: named other box |
| --------------- | ---------------------------- | -------- | ----------------------------- | ------------------------------- | -------------------------- |
| csv haiku45     | 10 (5/5)                     | 3        | 12 (5/5)                      | 1                               | 1                          |
| csv sonnet-low  | 5 (5/5)                      | 0        | 10 (5/5)                      | 0                               | 0                          |
| last-log haiku  | 1 (1/5)                      | 1        | 5 (4/5)                       | 4                               | 0                          |
| last-log sonnet | 0                            | 0        | 10 (5/5)                      | 5                               | 0                          |

Every episode saw at least one hint (20/20). The probe produced 37
empty-result hints and 16 search-miss hints. No hint fired on a non-empty
result, and none fired on the 10 validation errors.

| result                              | count | source                                                          |
| ----------------------------------- | ----- | --------------------------------------------------------------- |
| `{"total_count":0,"items":[]}`      | 14    | GitHub `search_issues` / `search_pull_requests`                 |
| `{ "content": "No matches found" }` | 9     | fs `search_files`                                               |
| `{ "content": "" }`                 | 1     | fs `read_file` returning no content                             |
| upstream `ENOENT`                   | 9     | `app.log` read at the wrong path                                |
| upstream `404 Not Found`            | 4     | GitHub `issue_read` / `pull_request_read` / `get_file_contents` |

Two of the 404s (`issue #42`, `pull request #9`) concern items that exist
and were called with arguments the fake rejected. Those hints were
technically right by the rule but not helpful.

`{"ok":true}` (the GitHub fake's reply for `list_releases` /
`list_commits` / `search_code`) stayed unhinted, which is correct: it is
neutral, not empty.

### What happened

- **csv sonnet (0/5): the hints were read and ignored.** All 5 episodes ran
  the same 5-6 turn path:
  1. `search_github "CSV export"` returned a miss with the hint.
  2. The model re-searched tool names
     (`"search issues pull requests releases"`). It treated the hint as
     "search for tools that look at data", not "call these tools".
  3. It ran `search_pull_requests` and `search_issues` in parallel, both
     empty, and both hints ended "or look in another box that could hold
     it: fs, mongo".
  4. In 10/10 of those hints sonnet answered instead ("I found no evidence
     either way … I searched the acme/widgets GitHub repo"), without
     visiting `fs` and without mentioning the other boxes.

  v5/v6 reached `fs` more often, from a preamble sentence that v7 lacks. For
  sonnet, a pointer in a tool result carries less weight than a rule in the
  system prompt.

- **csv haiku (2/5, 3 capped).**
  - _Search misses:_ the miss hint cut haiku's tool-name-search misses from
    about 3.8 per episode (v6: 4,4,4,4,3) to 2.0 (2,2,1,3,2). Haiku still
    spent most of its turns in GitHub: list/search/read issues and PRs,
    `pull_request_read` 404s, and `get_repository_tree`.
  - _The two passes_ reached `fs` via `search_fs` → `fs.search_files`. One
    used a `**/*` glob, then read CHANGELOG. The other got two empty globs
    with hints, then broadened to `**/*.md`, then read.
  - _Capped runs:_ run3 followed the `search_files` empty hint to
    `fs.list_directory`, saw `CHANGELOG.md`, and hit the cap on the very next
    turn. That was the turn cap, not a give-up. run0 and run2 never left
    GitHub.
  - _GitHub hint lists:_ for the real GitHub catalog, the browsing-first
    order produced `actions_list, get_repository_tree, list_branches,
list_code_scanning_alerts, list_commits`. Those are generic, low-value
    names (catalog order inside the "list" group), and haiku did not pick
    them up.
- **last-log (10/10).** Recovery after `ENOENT` matches v5/v6:
  - Haiku went straight to `list_directory .` → `logs` (4/4 hinted
    episodes), which the hint names first.
  - Sonnet's next call was `search_files` (not named in the hint). The
    `search_files` empty hint then led to `directory_tree` (named, 5/5),
    the same path as v6.

  The hint agrees with the recovery the models already make, so it neither
  helps nor hurts here.

### Read

Just-in-time hints change _what the model reads_. They do not change _where
sonnet decides to stop_. Sonnet gets the "another box" pointer on the
decisive empty result in every episode and still answers from the one box
the host description pointed at. Haiku benefits from the miss hint (fewer
wasted tool-name searches, 2/5 vs 0/5 in v6), but the turn budget still runs
out in GitHub. The useful pieces are:

- the miss hint, which halves haiku's tool-name-search misses;
- the detection, which was exact on every shape seen.

These could be kept as a library improvement on their own merits, but this
probe does not show them moving the gating target. The guard (single-server)
was not measured.
