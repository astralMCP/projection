# Projection multi-server hill-climb: status

| round | change                                                                 | gating haiku45 (tasks all reps / episodes) | gating sonnet-low     | boxes haiku45         | boxes sonnet-low      | guard haiku45 | guard sonnet-low | haiku execute_machine eps (pass), gating · boxes | $/run | spend  |
| ----- | ---------------------------------------------------------------------- | ------------------------------------------ | --------------------- | --------------------- | --------------------- | ------------- | ---------------- | ------------------------------------------------ | ----- | ------ |
| 0     | baseline (origin/main e05fd03)                                         | 10/17 · 37/51 (72.5%)                      | 15/17 · 49/51 (96.1%) | 9/17 · 34/51 (66.7%)  | 15/17 · 48/51 (94.1%) | 55/60 (91.7%) | 59/60 (98.3%)    | 8/51 (3) · 9/51 (2)                              | $6.51 | $7.66  |
| 1     | v1: shelf tool-name samples + look-before-asking rule (reverted)       | 9/17 · 37/51 (72.5%)                       | 16/17 · 50/51 (98.0%) | 12/17 · 39/51 (76.5%) | 15/17 · 49/51 (96.1%) | 53/60 (88.3%) | 59/60 (98.3%)    | 5/51 (1) · 6/51 (3)                              | $6.36 | $14.02 |
| 2     | v2: truthful result-shape copy (describe_tool, contract rule 8)        | 11/17 · 38/51 (74.5%)                      | 15/17 · 49/51 (96.1%) | 12/17 · 42/51 (82.4%) | 15/17 · 48/51 (94.1%) | 59/60 (98.3%) | 59/60 (98.3%)    | 9/51 (3) · 10/51 (5)                             | $6.48 | $20.50 |
| 3     | v3: short chains to call_tool; machines for loops/branching (not best) | 12/17 · 42/51 (82.4%)                      | 14/17 · 48/51 (94.1%) | 11/17 · 38/51 (74.5%) | 16/17 · 50/51 (98.0%) | 53/60 (88.3%) | 59/60 (98.3%)    | 3/51 (1) · 4/51 (1)                              | $6.56 | $27.06 |

Gating pooled (task-cells passing every rep / episodes): baseline 25/34,
86/102 (84.3%); v1 25/34, 87/102 (85.3%); v2 26/34, 87/102 (85.3%); v3 26/34, 90/102 (88.2%).
Best: round 2 (v2), by one task-cell and one episode over baseline, inside
the ±6.1-pt pooled noise floor, with the guard up. v3 is not best: its
gating gain is inside noise and its guard haiku drop against v2 is outside
the paired floor. "haiku execute_machine
eps" counts multi-tier episodes whose `meta.route` is `execute_machine` or
`both`; sonnet-low used no machine in any round (0/102 of its episodes each). Spend
includes $1.15 of pre-baseline checks (`_preflight/`). Direct reference
not run (pending the ~$14 / ~$4.6 / ~$3.7 decision recorded at baseline).

**Noise floor** (paired-by-task 95% half-width, 17 tasks x 3 reps): haiku45
±9-11 pts, sonnet-low ±7.7, pooled gating ±6.1-6.7. One task going 0/3 to
3/3 in one cell is ~5.9 pts. Guard (60 x 1 rep): haiku45 ±9.9, sonnet-low
±4.6.

## Story so far

v2 remains best. v3 is the first round whose mechanism visibly engaged, but
it fails the guard hold against v2. The earlier failures split into haiku
writing `execute_machine` code against results it had never seen
(`cross-shipped-to-comment` 0/18 over three rounds, all machines) and
unnamed-box prompts (`global-*`). v1 (shelf samples) and v2 (truthful
result-shape copy at describe time) each moved the gating target by one
episode, and v2 never reached the machine author. v3 moved the routing
decision instead: the preamble, `execute_machine` and `call_tool` copy now
send a short lookup-then-act chain to successive `call_tool` calls and
keep machines for loops, branching over results, many steps or a saved
workflow. This rested on 67/67 haiku cross-box `call_tool`-only episodes
passing over three rounds, against 15/41 for machine episodes. Haiku's
machine use fell by two-thirds (gating 9→3, boxes 10→4, guard 7→2), and
`cross-shipped-to-comment` got its first pass ever (gating rep 0, via
`call_tool`). The other five shipped episodes still went straight to a
machine and failed, so haiku follows the new routing only some of the time.
Gating haiku rose 38→42/51 (+7.8, inside ±10.9), with `global-csv-released`
0/3→2/3, `cross-largest-log-to-audit` 2/3→3/3 and shipped 0/3→1/3. Sonnet-low
went 49→48 (`global-last-log-entry` 3/3→2/3). Pooled gating is 90/102
(+2.9 over v2, inside ±7.2), task-cells tied at 26/34. Tracked haiku boxes
fell 42→38 (−7.8, inside ±9.4). Four of its failures were turn-capped
`global-*` episodes hunting through GitHub with `call_tool`, and two were
`ctl-fs-largest-log` answers that listed the sizes after "Answer with just
the file name". The guard is the problem: haiku 59→53/60, 0 up / 6 down
against v2 (−10.0, paired ±7.7; sign test p≈0.03). Three of those six tasks
had failed in earlier rounds; `read-lowercase-readme`,
`upsert-issue-exists` and `db-orders-per-status` failed for the first time
in four rounds. Against baseline (55/60) and v1 (53/60) the guard is within
noise, so v2's 59/60 may have been a high draw. One rep cannot separate
that from a real single-server cost of the new routing copy. Sonnet's guard
was flat at 59/60. The v3 code stays on the branch (commit 911d64d) pending
a decision. A guard-only re-rep of v2 and v3 (two more reps each, about
$9) would settle whether the haiku guard drop is real. If it is, the copy
could be scoped to multi-server facades only.

Report: `report.html` (lite). Runner: `.claude/hillclimb/multi-server/run-round.sh <variant>`.
