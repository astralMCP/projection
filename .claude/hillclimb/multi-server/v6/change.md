# v6: empty lookups are weak evidence, so vary the strategy before concluding absence

**Status: probe only — superseded by v7 (just-in-time empty-result hints).**
The full round was not run (coordinator decision, made before the probe
result was known), and the source was reverted to v4. `change.patch` keeps
the diff.

## The abstraction

Every remaining multi-tier train failure has one shape. The model guesses
where the answer lives, makes one lookup there, and gets an empty or
no-match result. It then treats that absence of evidence as evidence of
absence. It stops and says "can't confirm", says the file does not exist,
or repeats the same kind of query until the turn cap.

- **v4 categorization** (`v4/categorization.md`). In `global-csv-released`
  (12/12 fail), the one box the description points at (GitHub) came up
  empty. Sonnet answered "no evidence either way" and named the changelog
  without reading it. Haiku re-ran content queries against tool-name search
  until the cap. In `global-last-log-entry` (sonnet 2 misses), a direct read
  of `app.log` and a name search failed, and the model answered "there's no
  `app.log`" without listing the directory.
- **v5 probe** (`v5/change.md`). A box-level sentence ("look in the other
  boxes") moved 9/10 csv episodes into `fs`. They then failed the same way
  inside that box. Sonnet made one non-recursive `fs.search_files`
  (`"CHANGELOG"` from `.`), got "No matches found", and stopped. Haiku spent
  its turns repeating GitHub queries.

v5 coached one recovery move: switch box. The failure is more general than
that. One empty result is not grounds to conclude anything, and the same
query shape repeated gives the same answer. The general remedy is to treat
an empty lookup as weak evidence and change strategy before concluding
absence. A strategy here is a way of searching: enumerate (browse/list)
instead of name-matching, widen the query, or try a different container.
These three moves cover every observed miss: a name-glob that misses a file
a directory listing would show, a narrow query, and the wrong box. None of
them names a server, tool, file or task word, so this is not coaching
toward one tool. A model reading it on any multi-server facade (a ticket
tracker, a wiki, a drive) gets the same advice, and the advice is right
there too.

## Change

`packages/projection/src/multi/facade.ts` `defaultMultiPreamble`: in both
catalog-on branches (code mode on and off), right after the steps sentence
and before the routing / approval sentences, insert:

> A lookup that finds nothing is weak evidence: before concluding that
> something is not there, try a different way to find it — browse or list
> instead of matching a name, broaden the query, or check another box that
> could hold it — and only then say it was not found.

Multi-server only. The code-mode-only multi preamble (no catalog) and every
single-server surface are unchanged. Tests: `test/multi/wire.test.ts` (the
code-mode + catalog preamble sequence) and `test/multi/config.test.ts`
(present in catalog-only, absent in code-mode-only). Docs: PRD R44 and the
multi-preamble note in `docs/server-authors.md`.

## Byte-identity check (single-server)

The v5 render script (one in-process server with a read tool, a read tool
with an `outputSchema` and a write tool, wrapped by `wrapMcpServer` under each
projection selection; dumps `facade.instructions`, `getInstructions()`,
`tools/list`, `prompts/list`, and the `discover_apis` / `search_tools` /
`describe_tool` text) produced identical output before (v4 tree) and after:
37,795 bytes each, sha256 `eeb0827d…48ad451`. That is the same hash v4 and
v5 recorded. The multi render (`render-instructions.ts`) carries the
sentence in both Projection modes.

`pnpm run check`: green (16/16 tasks) on a rerun. The first run hit the
known `budgets.test.ts` resume-leg p95 flake, which passed when rerun alone.

## Expected effect

Same ceiling as v5: about 6 gating episodes (csv 6, last-log 1). The plan
was to gate on a probe (csv + last-log, `projection` mode, both models, 5
reps) and run the full round only if csv reached at least 3/5 for either
model and last-log did not drop below v4. Risk: more lookups on genuinely
absent items, which costs turns; haiku already turn-caps on `global-*`.

## Probe

Probe (`v6/probe/2026-10-30T03-39-58.533Z.json`): `global-csv-released` and
`global-last-log-entry`, `projection` mode, box descriptions on, both
models, 5 reps, 20 episodes, $0.85 (export.mjs `costUsd` pricing).

| task                    | model      | v6 probe | v5 probe | v4 round | turn-capped (v6) |
| ----------------------- | ---------- | -------- | -------- | -------- | ---------------- |
| `global-csv-released`   | haiku45    | 0/5      | 1/5      | 0/3      | 5/5              |
| `global-csv-released`   | sonnet-low | 2/5      | 1/5      | 0/3      | 0/5              |
| `global-last-log-entry` | haiku45    | 5/5      | 5/5      | 3/3      | 0/5              |
| `global-last-log-entry` | sonnet-low | 5/5      | 5/5      | 2/3      | 0/5              |

csv clears the pre-set 3/5 bar for neither model. Pooled csv is 2/10, the
same as v5's 2/10. last-log holds at 10/10.

### What happened after an empty result (train transcripts)

Each episode is classified at its decisive empty lookup, the last one
before it answered or hit the cap:

| outcome after the decisive empty lookup                        | csv haiku | csv sonnet | last-log haiku | last-log sonnet | total |
| -------------------------------------------------------------- | --------- | ---------- | -------------- | --------------- | ----- |
| varied strategy (browse/list, broader, other box) and found it | 0         | 2          | 5              | 5               | 12    |
| stopped and concluded absence or "can't tell"                  | 0         | 3          | 0              | 0               | 3     |
| kept repeating the same kind of query to the cap               | 5         | 0          | 0              | 0               | 5     |

- **last-log (10/10 varied).** Sonnet: read `app.log` fails, then a
  non-recursive `search_files app.log` comes back empty, then
  `directory_tree` (browse), then the read (5/5). Haiku: the read fails, then
  `list_directory` `.` then `logs` (4/5), or a recursive `**/*app.log*` glob
  (1/5). v5's probe already showed the same recovery (sonnet 5/5
  `directory_tree`), so this is not new behaviour attributable to v6.
- **csv sonnet.** Every episode browsed GitHub after its searches came up
  empty (`list_pull_requests` with paging, `list_issues`): it varied inside
  the box. The two passes then did it in `fs`: `list_allowed_directories`
  followed by `*csv*` (empty), broadened to `*CHANGELOG*`, then read (rep3),
  or a `*` listing and read (rep4). The three misses each stopped at a
  different empty signal. rep0 never left GitHub ("I didn't check the
  project files … if … in a changelog file, I can look there"). rep1 ran
  one non-recursive `search_files "CHANGELOG"`, got "No matches found", and
  answered "I found no CHANGELOG file". rep2 sent a content query to
  `search_fs` (a tool-name search), got "No tools matching", and stopped
  ("I didn't try browsing for a changelog").
- **csv haiku.** All 5 were capped (22-24 turns). Each sent 3-4 content
  queries to `search_<box>` tool-name search ("No tools matching …"), then
  ran ~10 GitHub issue/PR/release/commit lookups. It did vary (search, then
  list, then other boxes), but the variation stayed inside GitHub, the wrong
  box. Only 3/5 reached another box, 2/5 reached an `fs` tool, and both of
  those ran one csv-name glob (`**/*csv*`, `*csv*`), got "No matches found", and went back to
  GitHub or hit the cap.

### Read

The sentence did not change outcomes beyond v5. Where models already
recover (last-log), they recover the same way. Where they do not (csv), the
misses happen at three different empty signals: a box never visited, a
non-recursive glob miss, and a tool-name search miss mistaken for a data
miss. A static preamble sentence read once at the top of the context is not
in view at the moment the empty result arrives. That points to v7: put the
hint on the empty result itself (just-in-time), including telling the model
that a `search_<box>` "No tools matching" is about tool names, not data.
Tool-name search misses per csv episode: v6 haiku 4,4,4,4,3 and sonnet
1,1,2,1,1; v5 haiku 3,5,5,4,3 and sonnet 1×5.
