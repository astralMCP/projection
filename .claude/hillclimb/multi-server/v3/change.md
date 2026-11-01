# v3: route short lookup-then-act chains to call_tool; machines for loops, branching, many steps

## Applied

Applied on `hillclimb-multi` on top of v2 (kept). `change.patch` is the diff
as applied (`git diff` against real paths); `copy.txt` has the full new copy.
`pnpm run check` is green except for the known `budgets.test.ts` resume-leg
p95 flake. That file passed when rerun alone, and the harness and tui tests,
plus typecheck and lint across the workspace, passed when run separately.
No goldens embed the changed strings (`grep -rn "For a single action"
packages/projection/test` finds nothing), so none were regenerated.

## Hypothesis

Haiku 4.5 sends short sequential chains (2–3 calls: count orders, then comment
the number; read a file, then write a todo) to `execute_machine`. In a machine
it handles tool results blind, writing code against a result it has never
seen. The current routing copy invites this: "For several steps, branching on
results, or a workflow worth saving, author an XState v5 state machine". A
two-step lookup-then-write chain counts as "several steps". v2 told the truth
about result shapes at describe time and in contract rule 8, but haiku never
acted on it (all six `cross-shipped-to-comment` episodes went straight to a
machine with no peek). So the fix moves upstream to the routing decision:
short chains go to `call_tool`, where each result is read before the next step
by construction.

## Evidence (train/tracked rows, multi phase; recomputed from results.jsonl)

| round    | haiku gating machine eps (pass) | haiku boxes machine eps (pass) | haiku cross-box `call_tool`-only eps (pass), gating · boxes | haiku cross-box machine eps (pass), gating · boxes | sonnet machine eps (both cells) |
| -------- | ------------------------------- | ------------------------------ | ----------------------------------------------------------- | -------------------------------------------------- | ------------------------------- |
| baseline | 8/51 (3)                        | 9/51 (2)                       | 10 (10) · 10 (10)                                           | 8 (3) · 8 (2)                                      | 0/102                           |
| v1       | 5/51 (1)                        | 6/51 (3)                       | 13 (13) · 12 (12)                                           | 5 (1) · 6 (3)                                      | 0/102                           |
| v2       | 9/51 (3)                        | 10/51 (5)                      | 10 (10) · 12 (12)                                           | 8 (3) · 6 (3)                                      | 0/102                           |

- Every haiku cross-box episode that used only `call_tool` passed: 67/67
  over three rounds and both modes. Sonnet-low's cross-box episodes are
  all `call_tool` and all passed (18/18 per cell per round).
- Haiku cross-box machine episodes passed 15 of 41 (37%).
- `cross-shipped-to-comment` haiku: 0/18 over three rounds and both modes,
  every one routed `execute_machine` or `both` (machine first). See
  `v2/change.md` for the verbatim `parseInt(event.result)` against
  `{ count: 4 }`.
- Sonnet-low never wrote a machine (0/306 of its multi episodes over three rounds).
  It follows the "single action → call_tool" reading on its own.

## Change

One behaviour (routing), on the four surfaces the model reads when it picks
a route. The rule is the same for single- and multi-server.

1. **Routing preamble**, single-server (`DEFAULT_ROUTING_PREAMBLE`,
   src/mrtr/discover.ts) and multi-server with both projections
   (`defaultMultiPreamble`, src/multi/facade.ts): "For a single action or a
   short chain where you look something up and then act on it, call … and
   call_tool for each step, reading each result before the next. Author an
   XState v5 state machine and run it with execute_machine only when the work
   loops or branches over results, takes many steps, or is a workflow worth
   saving (call discover_apis first …)." The approval sentence tail and the
   search-tool naming (global vs per-box) are unchanged. The code-mode-only
   and catalog-only preambles are unchanged.
2. **`execute_machine` description** (src/wrap.ts, src/multi/facade.ts) now
   leads with when to use it: "Run a multi-step workflow — loops, branching
   over results, many steps, or one worth saving — as an LLM-authored XState
   v5 state machine … For a short lookup-then-act chain, use call_tool for
   each step instead." The rest of the description is unchanged. This
   wording applies **only when the catalog is also served**. A code-mode-only
   facade has no `call_tool`, so it keeps the old first line (new
   `ROUTED_CODE_MODE_COPY` / `codeModeCopy(projections)`).
3. **`call_tool` description** (single and multi) adds "Chains of a few calls
   are best done as successive call_tool calls, reading each result before
   the next." The existing execute_machine pointer used "several steps", which
   contradicts this sentence, so it now reads "For loops or branching over
   results, many steps, or a workflow worth saving, author a machine and use
   execute_machine instead." (The multi pointer is still served only with code
   mode. The single-server text was already unconditional and stays so.)
4. Docs: PRD R29's routing-rule sentence and the server-authors.md preamble
   excerpt now carry the same rule.
5. Tests: routing-preamble content (test/mrtr/discover.test.ts), the
   execute_machine/call_tool copy on both-projection facades
   (test/integration/catalog-projection.test.ts, test/multi/wire.test.ts),
   and no `call_tool` in execute_machine's description on code-mode-only
   facades (single and multi).

## Expected gain

- **haiku45 gating:** the 9 machine episodes in v2 contain 6 failures
  (`cross-shipped-to-comment` ×3 and three others). If routing moves the
  shipped task to `call_tool`, expect 0/3→2–3/3 there (+4 to +6 pts) and
  0 to +2 episodes from the sporadic machine failures. The expected cell gain
  is +4 to +8 pts, inside the ±9–11 pt cell floor. The clean signal is the
  task flip and a drop in haiku machine episodes. This is the first round
  aimed at the route rather than the authoring step.
- **sonnet-low gating:** 0 expected. It already never uses a machine.
- **Tracked haiku `projection-boxes`:** similar mechanism, similar size.

## Risks

- **Single-server output changes on purpose.** The guard measures it. In v2
  the guard's haiku machine use was basic 1, hard 0, filesystem 5 (4 pass),
  mongodb 1, and sonnet's was 0/60. The guard's filesystem tier is where haiku
  writes machines, and passes them, most often. If the new copy suppresses a
  machine where one was genuinely the better route (looping over directory
  entries), haiku-filesystem could drop. The copy keeps "loops or branches
  over results" as a machine case to limit this.
- Over-correction: haiku could now hand-unroll a real loop as many
  `call_tool` calls and hit the turn cap. That would show as `turn_capped`
  rows.
- A route change does not fix the paging miss in `cross-open-prs-to-notes`.
- S5: no server-sourced text is added. All of the copy is library-supplied.
  Integrators who override `codeModePreamble` still get the new tool
  descriptions.
