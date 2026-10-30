# v5: look in the other boxes before answering not-found

## Hypothesis (from `v4/categorization.md`)

Under the host box descriptions (harness change 2), `global-csv-released`
failed 12/12 in v4. Every episode opened with `search_github` alone (the
GitHub description names the repo and "issues, PRs"), found nothing about a
CSV export, and concluded "no evidence either way" (sonnet) or hunted
GitHub until the turn cap (haiku). No episode read `CHANGELOG.md` in `fs`,
and sonnet often named the right next step ("a changelog … in the project
files might answer this") without taking it. The behaviour to change is
concluding "not found" after the one box the host's description points at.
The two `global-last-log-entry` sonnet-low misses have the same shape
inside a box (stopped after a failed lookup in `fs`).

## Change

`packages/projection/src/multi/facade.ts` `defaultMultiPreamble`: in both
catalog-on branches (code mode on and off), right after the steps sentence
and before the routing / approval sentences, insert:

> When the user does not say which box holds the answer and a lookup in one
> box finds nothing, look in the other boxes that could hold it before
> answering that it is not there.

Multi-server only. The code-mode-only multi preamble (no catalog) and every
single-server surface are unchanged. Tests: `test/multi/wire.test.ts` (the
code-mode + catalog preamble sequence) and `test/multi/config.test.ts`
(present in catalog-only, absent in code-mode-only). Docs: PRD R44 and the
multi-preamble note in `docs/server-authors.md`.

Not task-specific: it names no box, file or task word, and it does not touch
the host box descriptions (adding "changelog" to `fs` would teach to the
test).

## Byte-identity check (single-server)

A render script wrapped one in-process server (instructions, a read tool, a
read tool with an `outputSchema`, a write tool) with `wrapMcpServer` under
each projection selection (both, code mode only, catalog only) and dumped
`facade.instructions`, the client's `getInstructions()`, the full
`tools/list`, `prompts/list`, and the text of `discover_apis`,
`search_tools` (with and without a query) and `describe_tool` (with and
without `types: true`). Before (HEAD `facade.ts`) and after are
byte-identical: 37,795 bytes each, sha256 `eeb0827d…48ad451`. The multi
render (`render-instructions.ts`) carries the new sentence in both modes.

## Expected effect

- `global-csv-released` (gating 0/3 both models in v4) and
  `global-last-log-entry` (sonnet-low gating 2/3). Ceiling: about 6 gating
  episodes (csv 6 + last-log 1), about 6-7 pts pooled, at the noise floor,
  so the round is gated on a cheap probe first (csv + last-log only,
  gating mode, both models, 5 reps).
- Guard: single-server, unchanged library surface, so v4's distribution.
- Risk: more boxes searched on genuinely-absent lookups (cost/turns), and
  haiku already turn-caps on `global-*`; watch turn-capped counts.

`pnpm run check`: green except the known `budgets.test.ts` resume-leg p95
flake, which passed when rerun alone.
