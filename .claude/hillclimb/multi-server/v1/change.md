# v1: shelf tool-name samples + look-before-asking rule

## Hypothesis

When a prompt doesn't say which box holds the data, the model has no cue
about what a box without a description holds, and nothing tells it to look
before asking. The baseline shelf showed `- fs (14 tools)` and
`- mongo (21 tools)` with nothing else, next to a `github` line in its
server's words, so "the project", "the version", "Grace" all read as GitHub
or as a question for the user.

## Evidence (baseline, gating `projection` cells)

- `global-who-is-grace`: haiku45 0/3 (called no tools and asked the user
  where to look).
- `global-version-branch`: haiku45 1/3, sonnet-low 2/3 (searched GitHub
  only, or asked; sonnet rep 0 assumed "widgets" meant acme/widgets).
- `global-csv-released`: haiku45 0/3, sonnet-low 2/3 (GitHub only; haiku
  rep 0 reached CHANGELOG.md just at the turn cap).
- The global `search_tools` was used in 3 of 102 gating episodes.

## Change (packages/projection, multi-server only)

1. **Tool-name sample** for a box with no host `description` and no
   server-instructions about-text (`boxAbout` undefined): the shelf line
   becomes `- <alias> (<n> tools, e.g. <t1>, <t2>, <t3>, <t4>, <t5>, …)` (the
   first 5 bare names in catalog order after the per-box dedupe; no `, …`
   at 5 or fewer), and the same parenthetical goes in that box's
   `search_<alias>` description. Names are S5 text: invisible characters
   stripped, neutralized, forged `(… tools)`/`(server's words)` removed,
   capped at 64. One helper, `boxToolSample` / `boxToolsLabel` in
   `src/catalog/box-guidance.ts`, used by `buildMultiInstructions` and
   `boxSearchCopy` (`src/multi/facade.ts`).
2. **Look-before-asking rule** appended after the steps in
   `defaultMultiPreamble`, catalog-on variants only:
   - global search on: "When the user doesn't say which box holds what they
     need, look before asking: search_tools searches every box at once, and
     a box's own search lists what it holds."
   - global search off: "… look before asking: a box's own search lists
     what it holds, so check every box that could hold it."
   - The code-mode-only variant is unchanged. Single-server output is
     byte-identical (goldens untouched).

In the eval world: `fs (14 tools, e.g. read_file, read_text_file,
read_media_file, read_multiple_files, write_file, …)` and `mongo (21 tools,
e.g. aggregate-db, aggregate, collection-indexes, collection-schema,
collection-storage-size, …)`. Full text: `instructions.txt`
(rendered by `../render-instructions.ts`, no model calls).

## Cases it should fix

`global-who-is-grace`, `global-version-branch`, `global-csv-released` in
both gating cells (and in the tracked `projection-boxes` cells via the
no-global-search wording). `global-last-log-entry` already passed; it
should hold.

## Expected effect

Haiku45 gating: +2 to +3 tasks fully passing (~+8 to +12 pts episode pass
rate, at or just above the ±10.9 noise floor). Sonnet-low: +1 to +2 tasks
(to 16-17/17). The haiku `execute_machine` result-shape failures
(`cross-shipped-to-comment`, `cross-email-to-todo`,
`cross-open-prs-to-notes`) are untouched and should stay as they were.
Guard: no effect expected (single-server copy is byte-identical); it moves
only by noise. Cost: ~+60 input tokens per request on multi episodes.
