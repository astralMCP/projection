# Audit: summit-local, summit-saas and summit-messy priority failures

Scope: eval bugs only (graders, task wording, fake-server fidelity). Sources were the results
files `2026-10-31T18-39-39.698Z` (summit-local), `2026-10-31T18-39-59.672Z` (summit-saas) and
`2026-10-31T18-40-20.072Z` (summit-messy), plus the task and grader code in
`packages/harness/src/eval/`. I read the transcripts for direct and native-search on both
models, and checked every failing record's final answer or end-state write against its grader.
I did no live runs, so the spend is $0.

## Verdicts

| task | verdict | cause | fixed? |
| --- | --- | --- | --- |
| sl-git-unmerged-branches | GENUINE MODEL FAILURE | The models call `git_branch` with `not_contains: "main"` (that is `git branch --no-contains main`, which lists branches *behind* main) and read the result as "branches with commits main lacks". This adds the two fast-forwarded branches, `fix/export-header` and `hotfix/late-fee`. The server is the real `mcp-server-git`, and its rejection of `main..x` in `git_diff` is real behaviour. A correct path exists: `contains: <branch tip>` per branch, as the passing runs do. One Sonnet native-search run gave the right answer but was marked forbidden because it tried `git_checkout` (it failed on a dirty tree) during a read-only question. That is a correct ruling, not a grader bug. | no |
| sl-sql-close-stale | GENUINE MODEL FAILURE | Haiku runs `updated_at < '2026-09-01'` as a string comparison and misses ticket 1027, whose timestamp is in the deliberate legacy format `2026/08/19 14:45` (`/` sorts after `-`). The task names the trap honestly (the row is visible to a `SELECT` on pending tickets). Sonnet catches it every time. | no |
| sl-fetch-q3-incidents | GENUINE MODEL FAILURE | Haiku pages all four incident pages correctly, then miscounts: it lists six billing IDs and writes 5, or gets auth wrong (2 instead of 3). In native-search, Haiku never finds the fetch tool. The index page's links lose their hrefs in the real `mcp-server-fetch` markdown conversion, but `/api/incidents` is guessable (Haiku and Sonnet both reach it), and that loss is real-server behaviour. | no |
| ss-dunning-invoices | GENUINE MODEL FAILURE | Haiku includes FERN-1305, which is `status: "draft"` in the `list_invoices` result, so its total is $3,048 instead of $2,748. One Sonnet native-search failure posted a stray "test" message first, which made two posts. | no |
| ss-overdue-invoices-finance | GENUINE MODEL FAILURE | Haiku filters wrongly: it includes not-yet-due, draft and EUR invoices, drops some due ones, and one run posts amounts in cents ("$800,000"). Sonnet passes 8/8 with the same data. | no |
| ss-stripe-large-payments-page | GENUINE MODEL FAILURE | Haiku cuts the week wrongly (it includes $4,999.99 and payments outside the America/New_York week, and drops in-week ones). The Notion fake's 400 on `{"title": "…"}` matches the real API's validation text. | no |
| ss-renewal-pings | GENUINE MODEL FAILURE | Haiku corrupts the Slack user ID it copies (`U04AK7CWV3` and `U04AK7CQF` for `U04AK7W2CQF`), so the mention check fails. The runs where it copies the ID correctly pass. | no |
| ss-enterprise-mrr-sync | GENUINE MODEL FAILURE | Sonnet's two failures are arithmetic slips on Orbital Freight's yearly Business item (10 × $290 / 12 written as $24,166.67, or as $4,666.67 in the other run) instead of $241.67, so it posts $26,416.67 instead of $2,491.67. The data, the task and the grader agree on $2,491.67. | no |
| messy-x-globex-reply | EVAL BUG (ambiguous data) | The prompt says "which charge is the duplicate" without saying which one. In the fixture, `INV-88213.charge` pointed at the *second* charge, which is the one the grader treats as the duplicate. That is backwards from a real double charge: the invoice records the payment that settled it, and the stray charge is the extra one. Sonnet direct r0 reasoned "the invoice is linked to ch_MANse…, so that one is valid, and ch_AJut… is the duplicate" and failed. The data actively pointed at the wrong answer. | **yes**: `messy-billing.ts` now links the invoice to the first charge, so the invoice link and the time order both mark the second charge as the duplicate. This is not easier: the duplicate's ID no longer appears on the invoice, so you must list the charges to find it. A new offline test pins it. |
| messy-tracker-bug | GENUINE MODEL FAILURE | Haiku sends `priority: 1`, which is Urgent on the tracker's 0–4 scale. The scale's parameter description is stripped by the deliberate `property-descriptions` defect, but the create result echoes `priority: Urgent`, Haiku even reports "Urgent (high priority)", and the BE validation error spells out the scale. Sonnet sends 2 every time. | no |
| messy-past-due | GENUINE MODEL FAILURE | Haiku's epoch arithmetic is wrong (it takes 2026-10-14 12:00 UTC as 1789209600), so it adds Acme Retail (due 18:00 today, not yet past due). In other runs it drops Oscorp or Bluth. Minor note: Bluth is due 06:00 *today*, so "past its due date" read at date granularity would exclude it. The system prompt gives the time and `due_date` is a timestamp, so the timestamp reading is the API-faithful one. I left it unchanged. | no |

## Fix

- Branch `basecamp-audit` (from `basecamp`), worktree `.claude/worktrees/bc-audit`.
- `packages/harness/src/eval/messy-billing.ts`: `INV-88213.charge` is now `DUPLICATE_CHARGES[0]`
  (the genuine first payment), instead of `[1]` (the duplicate).
- `packages/harness/test/eval/messy-tasks.test.ts`: a test that the invoice links its first charge
  and not the graded duplicate.
- Side effect on `messy-refund-duplicate`: its prompt already says "the second of the two
  charges", so the answer is unchanged. A model that blindly refunds `invoice.charge` now hits the
  forbidden first charge, where before it was right by accident.
- `pnpm run format` and `pnpm run check` are green: 16/16 turbo tasks, harness 660 passed and 136 skipped.

## Re-scoring note

The recorded `messy-x-globex-reply` verdicts predate the fix. Re-run that task (direct only) to
recalibrate. I made no other result changes.
