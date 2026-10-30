# v6: empty lookups are weak evidence, so vary the strategy before concluding absence

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
