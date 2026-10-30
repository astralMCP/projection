# Exploration wave 2: code mode fan-out on the multi-hard tier

Question: once models use code mode and fan gated writes out in parallel, can code mode beat call_tool per item on
completion and cost on bulk tasks?

Branch `explore-fanout`, cut from `eval-hard-tier` (0ef1128).

| commit  | what                                                                                                                                                                                                                                                                                                                                                                                            |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 40bcc97 | `harness:` `PROJ_EVAL_FORCE_CODE_MODE=1` appends "Use code mode (discover_apis, execute_machine) for this task." to the Projection modes' system prompt (task prompt unchanged; recorded as `systemSuffix`). Records gain `projection.roundTrips` (MRTR retries, counted at the in-memory fetch). The harness had no system-prompt override. Every path touched was already in `harness_paths`. |
| 926adb0 | Projection, model-facing copy only (D21): the round-trip budget and the fan-out rule in contract rule 5 and in `execute_machine`; a fan-out worked example; errors after approved calls ran list those calls; a completed result counts approvals; the `lang` copy is corrected.                                                                                                                |

Approval semantics, caps, and elicitation copy are unchanged. There is no library helper: R15 already batches every
gated call queued before the machine goes quiet, so `enqueueActions` + `toolCall` is the whole pattern, and a helper
would only rename it.

Setup: tasks `hard-label-stale-issues`, `hard-comment-export-prs`, `hard-audit-shipped-orders` (bulk write),
`hard-branch-failing-checks`, `hard-branch-vip-tiers` (branching), `hard-gold-order-totals`, `hard-log-error-lines`
(bulk read). `projection` mode, box descriptions on, 1 rep, haiku45 + sonnet-low, through
`vitest run test/tool-choice.live.test.ts`. Code mode does run under that test: `execute_machine` transpiles and runs,
and with `lang: 'ts'` TypeScript works. The "TypeScript" failures below are a copy bug, not a loader problem.

Records are in `wave2/` (`B-*` before the change, `A*` after it). Tables: `python3 agg.py` and
`python3 analyze.py <file> [--detail]`, both run from `wave2/`.

## Runs

| run              | code                    | forced | models | tasks             | $        |
| ---------------- | ----------------------- | ------ | ------ | ----------------- | -------- |
| smoke            | 40bcc97                 | yes    | haiku  | log-error-lines   | 0.0511   |
| B-forced         | 40bcc97                 | yes    | both   | all 7             | 1.1619   |
| B-unforced       | 40bcc97 (`fanout-base`) | no     | both   | all 7             | 1.1287   |
| A-forced         | 926adb0 minus 2 fixes¹  | yes    | both   | all 7             | 1.0024   |
| A-unforced       | 926adb0 minus 1 fix²    | no     | both   | all 7             | 1.0196   |
| A2-forced-haiku  | 926adb0 minus 1 fix²    | yes    | haiku  | 5 write/branch    | 0.4502   |
| A3-forced-sonnet | 926adb0                 | yes    | sonnet | 5 write/branch    | 0.3384   |
| A3-unforced-spot | 926adb0                 | no     | both   | comment, fail-chk | 0.2541   |
| **total**        |                         |        |        |                   | **5.41** |

¹ A-forced had the contract, example, budget, cap-error and `lang` changes, but neither the completed-result approval
line nor the "already ran" note on non-cap errors. Its failures led to both. ² A-unforced and A2 had the approval line
but not the non-cap error note.

## Before vs after: per task × model

Before, forced (B-forced). `execute_machine` outcomes in order; "terminal" = the R18 cap (9th round trip).

| task               | model  | pass       | execute_machine attempts            | call_tool | approvals | round trips | turns | $      |
| ------------------ | ------ | ---------- | ----------------------------------- | --------- | --------- | ----------- | ----- | ------ |
| label-stale-issues | haiku  | PASS       | terminal, validate, ok, ok, ok      | 45        | 53        | 53          | 29    | 0.2082 |
| label-stale-issues | sonnet | PASS       | validate (`as`), terminal           | 14        | 20        | 20          | 10    | 0.1053 |
| comment-export-prs | haiku  | PASS       | runtime, read-cap, read-cap, ok, ok | 30        | 9         | 9           | 19    | 0.1219 |
| comment-export-prs | sonnet | fail (dup) | validate, terminal, ok, ok          | 7         | 17        | 17          | 12    | 0.1063 |
| audit-shipped      | haiku  | fail       | ok                                  | 0         | 1         | 1           | 5     | 0.0246 |
| audit-shipped      | sonnet | PASS       | — (call_tool)                       | 5         | 1         | 1           | 8     | 0.0588 |
| branch-failing-chk | haiku  | fail (dup) | terminal, ok                        | 11        | 18        | 18          | 23    | 0.0841 |
| branch-failing-chk | sonnet | FORBID dup | runtime, terminal, ok, ok           | 10        | 24        | 22          | 14    | 0.1331 |
| branch-vip-tiers   | haiku  | fail       | validate (`as`), terminal, ok       | 5         | 10        | 10          | 13    | 0.0596 |
| branch-vip-tiers   | sonnet | PASS       | — (call_tool)                       | 9         | 2         | 2           | 10    | 0.0700 |
| gold-order-totals  | haiku  | PASS       | ok, ok, ok                          | 0         | 0         | 0           | 7     | 0.0422 |
| gold-order-totals  | sonnet | PASS       | — (call_tool)                       | 7         | 0         | 0           | 8     | 0.0523 |
| log-error-lines    | haiku  | fail       | validate (`as`), runtime ×2, ok     | 1         | 0         | 0           | 9     | 0.0433 |
| log-error-lines    | sonnet | PASS       | validate (`as`), ok                 | 2         | 0         | 0           | 7     | 0.0521 |

After, forced (A-forced; write/branch rows replaced where A2/A3 re-ran them with the final copy):

| task               | model  | run | pass       | execute_machine attempts         | call_tool | approvals | round trips | turns | $      |
| ------------------ | ------ | --- | ---------- | -------------------------------- | --------- | --------- | ----------- | ----- | ------ |
| label-stale-issues | haiku  | A   | PASS       | ok ×9                            | 2         | 12        | **1**       | 16    | 0.1512 |
|                    | haiku  | A2  | PASS       | ok ×8                            | 1         | 12        | **1**       | 14    | 0.1019 |
|                    | sonnet | A   | PASS       | ok                               | 1         | 12        | **1**       | 6     | 0.0587 |
|                    | sonnet | A3  | PASS       | ok                               | 1         | 12        | **1**       | 6     | 0.0594 |
| comment-export-prs | haiku  | A   | PASS       | runtime, ok                      | 4         | 9         | **1**       | 11    | 0.0566 |
|                    | haiku  | A2  | PASS       | ok ×5                            | 2         | 9         | **1**       | 11    | 0.0699 |
|                    | sonnet | A   | PASS       | ok                               | 2         | 9         | **1**       | 7     | 0.0611 |
|                    | sonnet | A3  | PASS       | ok                               | 2         | 9         | **1**       | 7     | 0.0603 |
| audit-shipped      | haiku  | A   | fail       | transpile, ok                    | 0         | 1         | 1           | 6     | 0.0326 |
|                    | haiku  | A2  | PASS       | ok ×4                            | 15        | 6         | 6           | 22    | 0.1318 |
|                    | sonnet | A   | PASS       | — (call_tool)                    | 5         | 1         | 1           | 8     | 0.0656 |
|                    | sonnet | A3  | PASS       | — (call_tool)                    | 5         | 1         | 1           | 8     | 0.0657 |
| branch-failing-chk | haiku  | A   | fail (dup) | ok ×5 (output null, reran)       | 19        | 20        | 2           | 24    | 0.1493 |
|                    | haiku  | A2  | PASS       | ok ×6                            | 2         | 10        | **1**       | 16    | 0.1112 |
|                    | sonnet | A   | PASS       | ok                               | 3         | 10        | **1**       | 7     | 0.0669 |
|                    | sonnet | A3  | PASS       | ok                               | 3         | 10        | **1**       | 7     | 0.0766 |
| branch-vip-tiers   | haiku  | A   | PASS       | ok, ok                           | 3         | 24        | 4           | 9     | 0.0482 |
|                    | haiku  | A2  | PASS       | ok                               | 0         | 12        | **2**       | 7     | 0.0353 |
|                    | sonnet | A   | PASS       | ok, stuck, ok                    | 9         | 4         | 2           | 14    | 0.1011 |
|                    | sonnet | A3  | PASS       | stuck (note: 2 ran → not redone) | 8         | 2         | 1           | 10    | 0.0765 |
| gold-order-totals  | haiku  | A   | fail       | ok, ok                           | 5         | 0         | 0           | 11    | 0.0427 |
|                    | sonnet | A   | PASS       | — (call_tool)                    | 9         | 0         | 0           | 9     | 0.0587 |
| log-error-lines    | haiku  | A   | fail       | "not a function" ×6, ok          | 1         | 0         | 0           | 12    | 0.0657 |
|                    | sonnet | A   | PASS       | ok                               | 2         | 0         | 0           | 6     | 0.0439 |

Approvals (one per gated call) are the same before and after: the human approves the same writes. What changed is how
they arrive. Before, a sequential loop sent one round trip per write. After, a fan-out machine sends every write in one
round trip.

## Aggregates

| run              | model  | pass | $/ep   | $/success  | turns/ep | round trips/ep |
| ---------------- | ------ | ---- | ------ | ---------- | -------- | -------------- |
| B-forced         | haiku  | 3/7  | 0.0834 | 0.1946     | 15.0     | 13.0           |
| B-forced         | sonnet | 5/7  | 0.0826 | 0.1156     | 9.9      | 8.9            |
| B-unforced       | haiku  | 4/7  | 0.0925 | 0.1619     | 14.1     | 12.0           |
| B-unforced       | sonnet | 6/7  | 0.0687 | 0.0802     | 8.3      | 6.0            |
| A-forced         | haiku  | 3/7  | 0.0781 | 0.1821     | 12.7     | 1.3            |
| A-forced         | sonnet | 7/7  | 0.0651 | **0.0651** | 8.1      | 0.9            |
| A-unforced       | haiku  | 5/7  | 0.0842 | 0.1179     | 14.3     | 3.4            |
| A-unforced       | sonnet | 6/7  | 0.0614 | 0.0717     | 7.7      | 2.7            |
| A2-forced-haiku  | haiku  | 5/5  | 0.0900 | 0.0900     | 14.0     | 2.2            |
| A3-forced-sonnet | sonnet | 5/5  | 0.0677 | 0.0677     | 7.6      | 1.0            |
| A3-unforced-spot | both   | 4/4  | 0.0635 | 0.0635     | 9.3      | 4.8            |

Write and branching tasks only (the 5 where round trips matter):

| run          | model  | pass | $/success | round trips/ep |
| ------------ | ------ | ---- | --------- | -------------- |
| B-forced     | haiku  | 2/5  | 0.2492    | 18.2           |
| B-forced     | sonnet | 3/5  | 0.1578    | 12.4           |
| B-unforced   | haiku  | 4/5  | 0.1329    | 16.8           |
| B-unforced   | sonnet | 4/5  | 0.0951    | 8.4            |
| A-forced     | haiku  | 3/5  | 0.1460    | 1.8            |
| A-forced     | sonnet | 5/5  | 0.0707    | 1.2            |
| A2/A3 forced | haiku  | 5/5  | 0.0900    | 2.2            |
| A2/A3 forced | sonnet | 5/5  | 0.0677    | 1.0            |

Over the forced write and branching tasks, the final copy took code mode from 5/10 to 10/10, cut round trips per
episode from about 15 to 1–2, and cut $/success by 2.8× for Haiku and 2.3× for Sonnet.

## Cost per successful episode: code mode vs call_tool per item

Write and branching tasks, all after runs. An episode counts as "fan-out" when it made fewer round trips than approvals, which
means writes were batched in a machine.

| model  | strategy                                     | pass  | $/ep   | $/success | turns/ep |
| ------ | -------------------------------------------- | ----- | ------ | --------- | -------- |
| haiku  | code mode, fan-out (after)                   | 10/12 | 0.0966 | 0.1159    | 15.3     |
| haiku  | call_tool per item (after, not batched)      | 4/5   | 0.0603 | 0.0754    | 11.2     |
| haiku  | call_tool per item only (B-unforced)         | 2/2   | 0.0489 | 0.0489    | 10.0     |
| sonnet | code mode, fan-out (after)                   | 11/12 | 0.0699 | 0.0762    | 7.6      |
| sonnet | call_tool per item (after, not batched)      | 5/5   | 0.0658 | 0.0658    | 8.8      |
| sonnet | call_tool per item only (B-unforced)         | 4/4   | 0.0645 | 0.0645    | 7.5      |
| haiku  | calibration (eval-hard-tier, comment-export) | 0/1   | 0.2117 | —         | 42       |

By route across all after runs: Sonnet "both" (it reads with call_tool, then writes with one machine) passed 13/14 at
$0.0713 per success, against call_tool alone at 7/7 and $0.0635. Haiku "both" passed 11/15 at $0.1289, against
call_tool alone at 3/4 and $0.0694.

The calibration's one call_tool-per-item record (Haiku, comment-export, 42 turns, $0.21, failed) is not
representative. In these runs, unforced call_tool per item on the same task cost $0.05–0.12 and mostly passed.

## Code-mode failure modes (with transcript evidence)

1. **Sequential write loops hit the R18 cap.** This was the dominant failure before the change, with 6 of 14 forced
   episodes ending `terminal` (`"this workflow reached the limit of 8 approval round trips"`). Every one was an index
   loop: `readNextFile → readingFile → nextFile`-style states, one `toolCall` per state. In the forced after-runs there
   were 0 terminals across 24 episodes. One appeared in unforced Haiku vip-tiers, whose machine was still a loop.
2. **The terminal error read as a no-op, so writes were redone.** All 8 writes before the cap had run. Sonnet,
   comment-export: "My first attempt hit the tool's limit of 8 approvals per run **before any comment landed**", then it
   posted all 9 again, giving 17 comments on 9 PRs. Sonnet, failing-checks: 15 `issue_write` for 7 titles, flagged
   forbidden. Haiku, failing-checks: 12 for 6. The error now lists what ran. In A3, Sonnet vip-tiers got
   `stuck … The 2 calls approved earlier in this workflow already ran: - mongo.update-many {…}` and did not redo them
   (2 approvals in total, PASS).
3. **A null machine output read as a no-op.** A-forced Haiku failing-checks fanned out correctly (10 writes in 1
   round trip), but its output was `null`, and the model concluded: "The machine seems to have executed but the writes
   didn't go through … approval was [not] granted". It ran the machine 3 more times, creating 20 issues and comments.
   The audit was only in `structuredContent.approvals`, which the host never shows the model. The completed result
   now adds `Approvals in this workflow: approved and ran: github.issue_write ×6, …`, and A2 passed the same task with
   one machine run of 10 approvals in 1 round trip.
4. **A fan-out that then got stuck read as a no-op.** A-unforced Sonnet failing-checks: the fan-out ran its 10 writes,
   then waited in state `"a"` with no handler. The bare "stuck" error led to a second machine and 20 writes, so the
   episode failed. Fixed by note 2 (above), which now covers any error after approved calls ran.
5. **TypeScript syntax without `lang: 'ts'`.** `SyntaxError: Unexpected identifier 'as'` appeared on 5 of 14 forced
   episodes before, for both models. The schema said the default was "TypeScript-compatible parsing", but it is `js`.
   After the copy fix it appeared in 1 of 42 episodes. Making `ts` the default would remove it entirely.
6. **Opaque runtime errors from parsing unseen result shapes.** Haiku log-error-lines had 6× `TypeError: not a
function`, from `event.result.split(...)` / `.match(...)` on an object (`fs.read_file` returns structuredContent
   `{content}`). In unforced Haiku comment-export, `list_pull_requests` came back as a JSON **string** inside the
   machine, so `.filter` silently gave 0 PRs over 4 attempts until a `console.log` revealed `Result type: string`. Rule
   8 already says to look at the shape first. The QuickJS error names neither the line nor the expression.
7. **XState authoring slips.** These were `target` at the state level instead of `always`, `on: { '': … }`, a target
   to a missing child state, `invoke` (rejected), a circular context (`context.currentBatch[0]` held an event), and
   "stuck in state X" from target-less states. Each costs a retry turn; Haiku averages about 1.5 per episode.
8. **The read cap of 50 per segment.** B-forced Haiku comment-export read the files of 26 PRs plus pages
   (`more than 50 tool calls that run without approval in one segment`) ×2. This did not recur after the change.
9. **Model errors that are not about code mode.** Haiku audit-shipped (A and B) used `mongo.find` with the default
   limit of 10 and saw "10 shipped orders" of 14. Haiku log-error-lines counted `includes('ERROR')` or `' ERROR'`
   substrings, overcounting 10–13 files, in every run whether by machine or call_tool. Haiku gold-totals (A forced)
   got wrong totals.

### Harness and fake artefacts (per the coordinator's list)

- **The GitHub fake does not reflect writes in reads.** After posting, `pull_request_read get_comments` returns `[]`,
  and `list_issues` / `search_issues` never show created issues. Models that verify their writes conclude nothing
  happened. This amplified failure 3 (Haiku searched for its new "Fix …" issues and found none) and caused the
  A-unforced Haiku comment-export failure: it posted a probe "Test verification comment" to #140, an extra write the
  grader forbids. Count both as **fake-amplified**. Not fixed here.
- The log grader's path-keyed answers: no failing log episode keyed by path. All were real miscounts.
- The `updated:` qualifier on stale issues: no stale-issues episode failed, so no flip.
- Context overflow (400): no harness errors in any run.
- Lenient `postsCommentOn` and the VIP grader: no review-tool calls were seen, so no pass here relied on the leniency.

## Context cost

Measured on the multi world. The inline text of `discover_apis` grew from 5,729 to 8,045 characters (+2,316, about
+650 Haiku tokens, about 2.3k in all), counting rule 5's budget text, the fan-out example and the `lang` line.
`execute_machine`'s description grew from 850 to 1,160 characters (+310, about 90 tokens). That description is in
every Projection episode's tool list, used or not, so its sentence is the only cost that call_tool-only episodes pay. A
code-mode episode also pays output tokens for each machine (2–4k characters, at $5 or $10 per M) and for each authoring
retry.

## Read

**Fan-out fixed code mode's completion problem; it did not make code mode cheaper than call_tool per item.**

- Completion: on bulk and branching writes, final-copy code mode passed 10/10 forced, up from 5/10, and
  Sonnet passed 12/12 forced after the change. This now matches call_tool per item (Sonnet 4/4 and 5/5, Haiku 2/2 and
  4/5 unforced) at n=1 per cell, so too few runs to separate them. The remaining code-mode failures are Haiku authoring
  slips and result-shape parsing, plus one fake artefact.
- Cost: no. Per success, code mode with fan-out is $0.076 against $0.065 for call_tool on Sonnet, and $0.116 against
  $0.049–0.075 on Haiku. The reason is structural: the harness host, like Claude, runs **parallel tool calls**, so call_tool
  per item does not cost a turn per item (Sonnet labelled 12 issues in 5 turns, 13 call_tools). Code mode adds
  `discover_apis` (about 2.3k tokens), the machine's output tokens and authoring retries, and the models still do their
  reads with call_tool first to see the shapes (rule 8). Turns per episode were the same for Sonnet (7.6 against 7.5–8.8).
- What code mode does win: **round trips**. A fan-out machine asks one batch of approvals (1–2 round trips) where
  call_tool per item asks 7–17, and the approvals are the same. That is a human-facing benefit (one approval screen
  instead of a dozen), not a token one, and this eval does not price it.

**What would make code mode earn its context cost on bulk work:**

1. **Price the human.** If the product values one approval batch over N prompts, code mode wins every write task
   here. Report round trips per success next to $/success in the eval.
2. **Hosts without parallel tool calls**, or N well above what one turn of parallel calls carries (say 50–200 items).
   There call_tool per item really does cost a turn per item, and a single machine is O(1) turns. This tier's N
   (9–12 writes) is too small to show it.
3. **Cut the authoring tax.** Make `lang` default to `ts`, which removes failure 5. Make runtime errors name the
   failing expression or line, which shortens failure 6. Have `discover_apis` (or the `.d.ts`) say, per tool, whether
   `event.result` is an object or a JSON string, so models stop parsing blind. Haiku's code-mode retries are most of
   its cost gap.
4. **Fix the fake** so writes are visible to reads (issues, comments). Otherwise "verify after write" reads as
   failure, and every approach that verifies is penalised, call_tool included.
5. **Keep the "say what ran" copy whatever is decided.** Both new notes (the approval line on completion and the
   already-ran list on errors) stopped duplicate writes, the most damaging failure, at no token cost on the happy path
   beyond one line.

Spend: **$5.41** of $6 (smoke 0.05, B-forced 1.16, B-unforced 1.13, A-forced 1.00, A-unforced 1.02, A2 0.45,
A3 0.59), by `estimatedUsd` pricing.
