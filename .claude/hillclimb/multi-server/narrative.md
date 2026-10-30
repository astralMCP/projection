# Projection multi-server hill-climb: status

| round | change                                                           | gating haiku45 (tasks all reps / episodes) | gating sonnet-low     | boxes haiku45         | boxes sonnet-low      | guard haiku45 | guard sonnet-low | haiku execute_machine eps (pass), gating · boxes | $/run | spend  |
| ----- | ---------------------------------------------------------------- | ------------------------------------------ | --------------------- | --------------------- | --------------------- | ------------- | ---------------- | ------------------------------------------------ | ----- | ------ |
| 0     | baseline (origin/main e05fd03)                                   | 10/17 · 37/51 (72.5%)                      | 15/17 · 49/51 (96.1%) | 9/17 · 34/51 (66.7%)  | 15/17 · 48/51 (94.1%) | 55/60 (91.7%) | 59/60 (98.3%)    | 8/51 (3) · 9/51 (2)                              | $6.51 | $7.66  |
| 1     | v1: shelf tool-name samples + look-before-asking rule (reverted) | 9/17 · 37/51 (72.5%)                       | 16/17 · 50/51 (98.0%) | 12/17 · 39/51 (76.5%) | 15/17 · 49/51 (96.1%) | 53/60 (88.3%) | 59/60 (98.3%)    | 5/51 (1) · 6/51 (3)                              | $6.36 | $14.02 |
| 2     | v2: truthful result-shape copy (describe_tool, contract rule 8)  | 11/17 · 38/51 (74.5%)                      | 15/17 · 49/51 (96.1%) | 12/17 · 42/51 (82.4%) | 15/17 · 48/51 (94.1%) | 59/60 (98.3%) | 59/60 (98.3%)    | 9/51 (3) · 10/51 (5)                             | $6.48 | $20.50 |

Gating pooled (task-cells passing every rep / episodes): baseline 25/34,
86/102 (84.3%); v1 25/34, 87/102 (85.3%); v2 26/34, 87/102 (85.3%).
Best: round 2 (v2), by one task-cell and one episode over baseline, inside
the ±6.1-pt pooled noise floor, with the guard up. "haiku execute_machine
eps" counts multi-tier episodes whose `meta.route` is `execute_machine` or
`both`; sonnet-low used no machine in any round (0/204 each). Spend
includes $1.15 of pre-baseline checks (`_preflight/`). Direct reference
not run (pending the ~$14 / ~$4.6 / ~$3.7 decision recorded at baseline).

**Noise floor** (paired-by-task 95% half-width, 17 tasks x 3 reps): haiku45
±9-11 pts, sonnet-low ±7.7, pooled gating ±6.1-6.7. One task going 0/3 to
3/3 in one cell is ~5.9 pts. Guard (60 x 1 rep): haiku45 ±9.9, sonnet-low
±4.6.

## Story so far

v2 is the current best, but on a tie-break, not on a measured gain. The
baseline failures split into two behaviors: haiku writing `execute_machine`
code against a tool result it had never seen (`cross-shipped-to-comment`
0/3, sporadic `cross-email-to-todo` and `cross-open-prs-to-notes`), and
prompts that don't name a box (`global-*`: haiku asks the user, or searches
GitHub only). v1 targeted the second behavior on the shelf (five tool-name
samples per undescribed box, plus a look-before-asking rule). It moved
nothing outside noise (pooled +1 episode, task-cells flat, guard haiku -3.3)
and was reverted. v2 targeted the first behavior. It replaced the false
"results arrive as text" / "usually a string" copy with a truthful line and
told the model to `call_tool` a read-only tool once before a machine parses
it. The gating target again rose by just one episode (87/102). Haiku
task-cells went 10→11/17, from `cross-email-to-todo` 2/3→3/3 and
`global-who-is-grace` 0/3→1/3, with `global-version-branch` 1/3→0/3 and
`cross-largest-log-to-audit` 3/3→2/3 going the other way. Sonnet-low was
unchanged. The task v2 was aimed at did not move: `cross-shipped-to-comment`
stayed 0/3 in both haiku cells (now 0/18 over three rounds), and the
mechanism never engaged. All six v2 episodes went straight to
`execute_machine` with a single `mongo.count` and no `call_tool` peek, so
haiku either does not read or does not act on the describe line at
authoring time. Haiku's machine use held steady (9 and 10 of 51 episodes)
and its machine pass rate rose (gating 3/9, boxes 5/10, against 3/8 and 2/9
at baseline). The tracked haiku `projection-boxes` cell rose
66.7%→82.4% (+15.7, just outside its ±10.9 floor), from
`cross-open-prs-to-notes` 1/3→3/3, `cross-email-to-todo`, the two
`box-*-github` tasks and `global-who-is-grace` 0/3→2/3. Guard haiku went
91.7%→98.3% (+6.7, within ±9.9), with eight tasks flipping up and one down
(`fs-which-debug`). The copy is now truthful, and nothing regressed outside
noise, so v2 is kept as the base. Fixing `cross-shipped-to-comment` will
need a lever haiku reads when it authors a machine: something in the
`execute_machine` path itself, such as the result shape echoed back in the
first `TOOL_RESULT` error, or a kind marker on results. More describe or
contract copy has not reached it.

Report: `report.html` (lite). Runner: `.claude/hillclimb/multi-server/run-round.sh <variant>`.
