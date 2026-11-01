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

## Probe: no effect, not run

Probe (`v5/probe/2026-10-30T03-29-01.764Z.json`): `global-csv-released` and
`global-last-log-entry`, `projection` mode, box descriptions on, both
models, 5 reps, 20 episodes, $0.67.

| task                    | model      | v5 probe | v4 round | turn-capped (probe) |
| ----------------------- | ---------- | -------- | -------- | ------------------- |
| `global-csv-released`   | haiku45    | 1/5      | 0/3      | 3/5                 |
| `global-csv-released`   | sonnet-low | 1/5      | 0/3      | 0/5                 |
| `global-last-log-entry` | haiku45    | 5/5      | 3/3      | 0/5                 |
| `global-last-log-entry` | sonnet-low | 5/5      | 2/3      | 0/5                 |

csv is at or below 1/5 for both models, the pre-set "no effect" bar, so the
full round was not run and the source change was reverted (packages/ and
docs/ are byte-identical to v4; `change.patch` keeps the diff). last-log did
not get worse.

What the probe shows: the sentence moved behaviour but not outcomes. Every
episode still opened on GitHub, but 9/10 csv episodes then reached `fs`
(v4: 2/12). Sonnet's misses (4/5) each made one `fs.search_files` call with
a non-recursive pattern (`"CHANGELOG"`, `"CSV"`) from `.`, got "No matches
found", and stopped, the same shape as the v4 `global-last-log-entry`
misses. Haiku's misses: one never left GitHub, three were turn-capped after
long GitHub hunts (one had already read `CHANGELOG.md` and was re-checking
releases at the cap). The binding constraint is now a single failed glob
search in the second box, plus haiku's GitHub turn budget, not the decision
to look elsewhere.
