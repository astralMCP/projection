# Metrics: Projection multi-server hill-climb

## pass (headline, binary)

One episode = one model working one task against a fresh world (the GitHub
fake, the real filesystem server and the real MongoDB server as boxes `github`,
`fs`, `mongo`). `pass = 1` when the harness's task predicate held: the task's
`expect` over the recorded upstream calls, its `verify` over the end state or
the final answer where it has one, and no call the task `forbid`s. It is the
harness's `success` field (packages/harness/src/eval/run.ts), unchanged.

`tool_ok = 1` when every required step group reached the right upstream tool,
whatever the arguments. Diagnostic only.

Harness errors (refusal, `max_tokens`, API error, an exception in the harness)
and served-model mismatches are not scored: they go to `errors.jsonl` and out
of the denominator, but their tokens still count toward spend. A turn-capped
episode is scored on the calls it made (`meta.turn_capped`).

## Cells

The multi tier (17 tasks) runs in two Projection modes on two models, 3 reps:

| cell    | mode                                                 | model                                 | role                 |
| ------- | ---------------------------------------------------- | ------------------------------------- | -------------------- |
| gating  | `projection` (global `search_tools` on, the default) | `haiku45` (Haiku 4.5, no thinking)    | target               |
| gating  | `projection`                                         | `sonnet-low` (Sonnet 5.5, effort low) | target               |
| tracked | `projection-boxes` (`catalog.globalSearch: false`)   | `haiku45`                             | reported, not gating |
| tracked | `projection-boxes`                                   | `sonnet-low`                          | reported, not gating |

`prompt_id` is `<task>.<model>.<mode>` (the `<task>|<model>|<mode>` key with
`|` made path-safe), so each cell's tasks are separate cases. `tags` is
`[mode, model, tier]`.

**Target:** every gating task passes in all 3 reps for both models - 17/17
tasks fully passing in each gating cell. The per-cell numbers reported each
round are (a) tasks passing all reps / 17 and (b) episode pass rate over 51.

**Train / test.** The train split is the 68 multi-tier ids (both modes, both
models); the analyzer reads their traces. Because the goal is the multi tier
itself, its score is the climb target but is _directional_: the analyzer has
read those transcripts.

## guard_pass (held out, must hold)

The test split is the 60 single-server tasks (tiers basic, hard, filesystem,
mongodb) through `projection` mode on both models, 1 rep (120 ids). The
analyzer never reads these traces. `guard_pass` = mean `pass` over the test
ids, reported per model. A round that drops it outside noise is reverted.

## Reference

`reference-direct/` is the multi tier in `direct` mode (every tool of every
box inlined as native tools), both models, 3 reps. Run once for context; not a
round and not compared for keep/revert.

## Noise

Per gating cell (17 tasks x 3 reps) the crude binary half-width is
`1/sqrt(51)` = +/-14 points. The paired-by-task floor for a round-over-round
difference is `1.96 * sqrt(2 * sum_t p_t(1-p_t) * R/(R-1) / (n^2 R))` with p_t
the baseline per-task pass mean; it is 0 for tasks that passed or failed every
rep. The baseline values are in `narrative.md`.

## Perf

`cost_usd` is derived per row from the served `model` x `usage` with
`_state.json.prices` (cache reads 0.1x input, cache writes 1.25x input),
each call on the rate card its prompt selects: Haiku 5.5 bills a call whose
prompt is over 100K tokens at $0.50/$2.50 (`long_context`); no other model
here has a long-context rate.
`latency_s` is the episode's wall clock (`wallMs`), including tool execution
and any SDK retries (the Anthropic SDK retries 429/5xx twice with jittered
backoff; retries are not counted per row). On a batch row (`batch: true`,
PROJ_EVAL_BATCH=1) it spans the episode's lockstep ticks, batch queueing and
polling included (minutes per turn), so batch latency is **not comparable**
with interactive latency, and a latency comparison must not mix the two.
