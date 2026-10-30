# Projection multi-server hill-climb: status

Rounds 0–3 (baseline, v1–v3) ran under the old harness: the recording proxy
dropped output schemas and the multi tier had no host box descriptions.
Harness change 2 (`harness-change-2.md`) landed before v4, so v4 is the
re-baseline and the earlier rounds are not directly comparable to it. Their
numbers stay in `_state.json.rounds`. Under the old harness the best was v2
(gating pooled 87/102, guard 118/120).

| round | change                                                                    | gating haiku45 (tasks all reps · episodes) | gating sonnet-low | boxes haiku45 | boxes sonnet-low | guard haiku45 | guard sonnet-low | round $ | cumulative $ |
| ----- | ------------------------------------------------------------------------- | ------------------------------------------ | ----------------- | ------------- | ---------------- | ------------- | ---------------- | ------- | ------------ |
| 4     | v4: v3 routing copy on multi facades only (re-baseline, harness change 2) | 16/17 · 48/51                              | 15/17 · 47/51     | 16/17 · 48/51 | 15/17 · 47/51    | 58/60         | 59/60            | $6.59   | $33.65       |
| 5     | v5: look in the other boxes before answering not-found (probe only)       | not run                                    | not run           | not run       | not run          | not run       | not run          | $0.67   | $34.32       |
| 6     | v6: empty lookups are weak evidence; vary the strategy (probe only)       | not run                                    | not run           | not run       | not run          | not run       | not run          | $0.85   | $35.17       |

Probes (`global-csv-released` + `global-last-log-entry`, gating mode, box
descriptions on, 5 reps):

| task     | model      | v4 round | v5 probe | v6 probe |
| -------- | ---------- | -------- | -------- | -------- |
| csv      | haiku45    | 0/3      | 1/5      | 0/5      |
| csv      | sonnet-low | 0/3      | 1/5      | 2/5      |
| last-log | haiku45    | 3/3      | 5/5      | 5/5      |
| last-log | sonnet-low | 2/3      | 5/5      | 5/5      |

Gating pooled at v4: 31/34 task-cells, 95/102 (93.1%). Noise floors
(stats.mjs, v4): sonnet-low ±5.4 paired, haiku ±0.0 paired (crude ±14.0),
pooled ±2.7; guard haiku ±6.4, sonnet-low ±4.6. One task 0/3→3/3 in one
cell is about 5.9 pts. **Best: v4.**

## Story so far

v4 re-baselined the flow under harness change 2. Gating went to 31/34
task-cells, and the remaining failures are `global-csv-released` (0/3 in all
four cells) and one `global-last-log-entry` miss per sonnet cell. The v4
categorization found no grader error. The host box descriptions send the
first turn to GitHub (its description names the repo and "issues, PRs"),
and no episode looked in `fs`, where `CHANGELOG.md` holds the answer. The
last-log misses are variance at v3's rate. v5 tested one multi-server-only
preamble sentence: when the user doesn't name the box and a lookup finds
nothing, look in the other boxes that could hold the answer before saying
it isn't there. The single-server surface stayed byte-identical. A 20-episode
probe ($0.67) showed a behaviour change without an outcome change. csv
episodes reaching `fs` rose from 2/12 to 9/10, but csv passed only 1/5 for
each model, under the pre-set bar of 3/5. The full round was therefore not
run and the source was reverted to v4. Sonnet now goes to `fs` but makes a
single non-recursive `fs.search_files` (`"CHANGELOG"` from `.`), gets "No
matches found" and stops, the same shape as the v4 last-log misses. Haiku
spends its turns hunting GitHub first and was turn-capped in 3/5. The
binding constraint is now how the model recovers from one failed glob search
in the second box, not whether it looks there.

v6 generalized that into one rule, with no server or tool named: a lookup
that finds nothing is weak evidence, so before concluding absence, browse or
list instead of matching a name, broaden the query, or check another box.
The single-server surface stayed byte-identical. The coordinator decided
before the probe that v6 would be probe-only, superseded by v7. The probe
($0.85) would not have cleared the bar anyway: csv haiku 0/5 (5/5
turn-capped), sonnet 2/5, pooled 2/10 as in v5. last-log held at 10/10. At
each episode's decisive empty lookup, 12 of 20 varied strategy and found
the answer (all 10 last-log, recovering exactly as in v5, plus 2 csv
sonnet). 3 stopped and concluded absence (csv sonnet), and 5 repeated
GitHub lookups to the turn cap (csv haiku). The three sonnet misses stopped
at three different empty signals: one never left GitHub, one ran a
non-recursive `search_files "CHANGELOG"`, and one read a `search_fs` "No
tools matching" (a tool-name search) as a data miss. Haiku spends 3-4 turns
per episode on that same tool-name-search misreading. A preamble rule read
once is not in view when the empty result arrives, so v7 moves the hint onto
the empty result itself (just-in-time empty-result hints). The source is
reverted to v4.

## Failing train cases (best = v4)

- `global-csv-released.haiku45.projection` 0/3
- `global-csv-released.sonnet-low.projection` 0/3
- `global-csv-released.haiku45.projection-boxes` 0/3
- `global-csv-released.sonnet-low.projection-boxes` 0/3
- `global-last-log-entry.sonnet-low.projection` 2/3
- `global-last-log-entry.sonnet-low.projection-boxes` 2/3

Report: `report.html` (lite). Runner: `.claude/hillclimb/multi-server/run-round.sh <variant>`.
