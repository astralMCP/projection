# Projection multi-server hill-climb: status

| round | change                         | gating haiku45 (tasks all reps / episodes) | gating sonnet-low     | boxes haiku45        | boxes sonnet-low      | guard haiku45 | guard sonnet-low | $/run | spend |
| ----- | ------------------------------ | ------------------------------------------ | --------------------- | -------------------- | --------------------- | ------------- | ---------------- | ----- | ----- |
| 0     | baseline (origin/main e05fd03) | 10/17 · 37/51 (72.5%)                      | 15/17 · 49/51 (96.1%) | 9/17 · 34/51 (66.7%) | 15/17 · 48/51 (94.1%) | 55/60 (91.7%) | 59/60 (98.3%)    | $6.51 | $7.66 |

Gating pooled: 25/34 task-cells pass every rep, 86/102 episodes (84.3%).
Spend includes $1.15 of pre-baseline checks (`_preflight/`: a 4-episode
canary and an 8-episode direct-mode cost probe).

**Noise floor** (paired-by-task 95% half-width on a round-over-round change
in episode pass rate, at 17 tasks x 3 reps): haiku45 ±10.9 pts, sonnet-low
±7.7 pts, the two gating cells pooled ±6.7 pts. That is roughly one task
flipping from 0/3 to 3/3 in one cell (~5.9 pts), so a single-task fix shows
only when it fixes it in every rep. Guard (60 tasks x 1 rep, unpaired): haiku45
±9.9 pts, sonnet-low ±4.6, pooled ±5.5. **Headroom**: haiku45 27.5 pts,
sonnet-low 3.9 pts.

**Direct reference: not run.** Measured direct-mode cost is ~$0.072/episode
for haiku45 and ~$0.20 for sonnet-low (8-episode probe), so the planned 102
episodes would cost ~$14, taking the session past the $15 stop threshold. It
waits on a decision: run it as planned (~$14), run one rep (~$4.6), or run
haiku45 only (~$3.7). In the probe, direct passed 7/8 (it failed
`global-who-is-grace` on haiku45, the same way projection does).

## Story so far

Baseline only. Every failing gating episode was read (16 of them); all 16 are
model errors, none grader or harness errors, and no harness errors occurred
(0 of 324 episodes). They fall into two behaviors:

1. **Haiku 4.5 mishandles tool results inside `execute_machine`** (5
   episodes, 3 tasks): it posts `String(event.result)` / `parseInt` of the
   `{count: 4}` object, so the comment says "[object Object]" or "NaN" in
   public before a corrected one (`cross-shipped-to-comment`, 3/3 reps);
   it treats `fs.read_file`'s `{content}` object as a string
   (`cross-email-to-todo` rep 1, which then loops to the turn cap); and it
   parses the `list_pull_requests` result blind, without paging, writing one
   of four titles (`cross-open-prs-to-notes` rep 2). The machine uses a
   result shape it has never seen.
2. **Prompts that don't name a box** (10 episodes, 3 tasks, both models):
   Haiku asks the user where the data lives after at most one search (6:
   `global-who-is-grace` 3/3, `global-version-branch` 2/3,
   `global-csv-released` rep 2), or searches GitHub only and never (or too
   late) looks in the project (`global-csv-released` reps 0-1, rep 0 reading
   CHANGELOG.md just as it hit the turn cap); sonnet-low's two failures
   assume "widgets" means acme/widgets (`global-version-branch` rep 0) or
   search GitHub for the CSV feature (`global-csv-released` rep 0) and never
   open the project. The global `search_tools` was used in only 3 of 102
   gating episodes (1 failing). The shelf in the system prompt describes
   `github` in its server's words and says nothing about what `fs` and
   `mongo` hold.

One more haiku failure (`box-readme-github` rep 2) stopped after `README.md`
and `README` 404'd without trying `readme.md`.

Report: `report.html` (lite). Runner: `.claude/hillclimb/multi-server/run-round.sh <variant>`.
