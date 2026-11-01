# Basecamp: servers-mock — the `summit-saas` tier

Branch `basecamp-servers-mock`. A new opt-in, held-out eval tier, `summit-saas`:
high-fidelity in-process fakes of four SaaS MCP servers whose tool definitions
are public, plus the real filesystem server, and 24 tasks against them.
Calibrated in `direct` mode only. No facade source or hill-climb notes were
read.

## What was built

| File (packages/harness/…)                                     | What                                                                                                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/eval/summit-core.ts`                                     | Box builder on the low-level server: serves `tools/list` verbatim, dispatches `tools/call`, records calls; optional zod-style validation (`-32602`) for the servers that validate; PRNG/ID helpers; now = 2026-10-28 15:00 UTC |
| `src/eval/summit-notion.ts`                                   | Notion fake (24 tools)                                                                                                                                                                                                         |
| `src/eval/summit-sentry.ts`                                   | Sentry fake (9 direct tools + 47-tool catalog behind `search_sentry_tools` / `execute_sentry_tool`)                                                                                                                            |
| `src/eval/summit-slack.ts`                                    | Slack fake (8 tools)                                                                                                                                                                                                           |
| `src/eval/summit-stripe.ts`                                   | Stripe fake (22 tools)                                                                                                                                                                                                         |
| `src/eval/summit-people.ts`                                   | Fernhill's people across products (137 Slack members, near-duplicate names, deactivated accounts)                                                                                                                              |
| `src/eval/summit-files.ts`                                    | The `fs` box tree (api checkout with CODEOWNERS + CHANGELOG, a refund-requests CSV) for the real filesystem server                                                                                                             |
| `src/eval/summit-world.ts`                                    | The world: boxes `fs`, `notion`, `sentry`, `slack`, `stripe`; host framing; one-line box descriptions; `facts.summit` end state                                                                                                |
| `src/eval/summit-tasks.ts`                                    | 24 tasks, graders, `forbid`s, per-task turn budgets                                                                                                                                                                            |
| `test/fixtures/summit/notion-tools.json`, `sentry-tools.json` | Verbatim tool catalogs                                                                                                                                                                                                         |
| `test/eval/summit-world.test.ts`                              | 69 offline tests: world setup, each fake's paging/validation/error shapes, grader helpers, a reference and ≥1 wrong solution per task                                                                                          |

Wiring: `task-core.ts` (`TaskTier`, `TASK_TIERS`, `TIER_WORLDS`), `tasks.ts`,
`world.ts` (`WorldName`/`BoxAlias`/`openWorld`), `multi-tasks.ts`
(`isBoxWrite`), `filesystem-world.ts` (`baseFiles`, `dirPrefix`),
`index.ts`, the live test's knob docs, and the harness README.

Run: `env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN PROJ_LIVE_EVAL=1
PROJ_EVAL_MODES=direct PROJ_EVAL_TIERS=summit-saas pnpm --filter
@astral-mcp/harness exec vitest run test/tool-choice.live.test.ts` (no mongod).

## Servers and pinned sources

| Box      | Real server                                                                                  | Pin                                                                                                                                            | Definitions                                                                                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notion` | `@notionhq/notion-mcp-server` v2.5.2                                                         | makenotion/notion-mcp-server `730ae781ba28beeaf0865025a3f2ed4c25ea2387`                                                                        | Ported `openapi/parser.ts` + `mcp/proxy.ts` tools/list over `scripts/notion-openapi.json`; all 24 names, descriptions, properties and `required` match the server's own snapshot test                         |
| `sentry` | `@sentry/mcp-server` 0.42.0                                                                  | getsentry/sentry-mcp `54f66d8d77bdee0d036d4754806d782b58217ef7`                                                                                | `packages/mcp-core/src/toolDefinitions.json` verbatim; annotations read from each tool module; direct surface = `TOP_LEVEL_TOOL_NAMES` (`tools/surfaces.ts`); skills `inspect,seer,triage`, no embedded agent |
| `slack`  | MCP reference `server-slack` 0.6.2                                                           | modelcontextprotocol/servers-archived `src/slack` at `52db0d98994dd38e636a470a4c0b3f20781d6c4b`                                                | `index.ts` tool objects verbatim                                                                                                                                                                              |
| `stripe` | `@stripe/mcp` 0.2.5 / `@stripe/agent-toolkit` 0.8.1                                          | stripe/agent-toolkit `72d20b9aa5dc515ac79ebfb76784ff035d2f0929` (last release with local handlers; later ones proxy the closed mcp.stripe.com) | `tools/typescript/src/shared/*/*.ts` prompts, zod params (as SDK 1.17 lists them), annotations                                                                                                                |
| `fs`     | `@modelcontextprotocol/server-filesystem` (the repo's pinned devDependency, the real server) | —                                                                                                                                              | real                                                                                                                                                                                                          |

Not modelled: Linear (remote server, no published schemas), Slack's hosted
official server (closed), Atlassian/PagerDuty. The GitHub fake and MongoDB
were left out of this world on cost (see open problems).

## Fidelity notes (summary)

- **Notion**: no argument validation (low-level `Server`); JSON-looking
  string args parsed like `deserializeParams`; success = compact
  `JSON.stringify(data)`; API errors are ordinary text
  `{"status":400,"object":"error","code":…}` (never `isError`);
  `start_cursor`/`page_size` (≤100, default 100) with `has_more`/`next_cursor`;
  nested blocks need their own calls (a 128-block page needs page 2); rich-text
  arrays, user mentions, people properties with emails; API 2025-09-03 data
  sources (a database ID passed as a data source ID is refused); filter/sort
  JSON evaluated; property values must be type-keyed objects; markdown
  read/write supported (dialect approximated).
- **Sentry**: markdown results in the server's templates, structured JSON +
  text mirror for tools with output schemas; zod validation before handlers;
  `**Input Error**` / HTTP 4xx templates as `isError`; issue-search syntax
  passed through unchanged (no agent), natural language = free text over
  title/culprit; `limit` default 10, ≤100, no cursor; period default 30d;
  list counts are period counts, details are all-time; relative dates;
  numeric ID and short ID both resolve, events resolve via issue search;
  `update_issue` reads first and reports "Already Matches"; catalog search uses
  the ported `scoreTool`; unmodelled catalog tools answer empty
  schema-conformant structures or a 404 template, never `{ok:true}`.
- **Slack**: raw Web API JSON as text (`ok:false` errors, handler errors
  `{"error":"Missing required arguments: …"}`); `users.list` and
  `conversations.list` cursor paging (`response_metadata.next_cursor`; channel
  pages filter archived _after_ paging, so pages run short); history
  newest-first, default 10, `has_more` + a cursor the tool cannot send;
  `chat.postMessage` takes names or IDs (answers the ID), everything else IDs
  only; `not_in_channel`, `is_archived`, `thread_not_found`; reactions by user ID.
- **Stripe**: compact JSON of `.data` only — no `has_more`, no
  `starting_after`; `limit` 1–100 (zod), default 10; `list_customers` returns
  IDs only; acacia (2024-12-18) objects; integer cents; refunds bounded by the
  hidden refundable remainder; failures as the plain string `"Failed to …"`;
  discounts on subscriptions; unknown keys stripped.
- **Noise**: decoy threads, near-duplicate people (two Sams, two Priyas,
  accented Tomás, deactivated CSM), look-alike customers, payments seconds
  outside a window, issues at exactly the threshold, an outdated policy in a
  toggle, already-processed requests.

Known approximations: Sentry's issue-details and `search_events` formatters
are condensed re-implementations (2.5k lines of formatter not ported
line-by-line), `search_events` supports an errors-dataset subset; Notion
error message texts and the markdown dialect are best-effort; Stripe's
validation error text is zod-4 style rather than zod 3; the assumption that
Sentry list counts follow the stats period.

## Tasks (24; 10 single-server, 14 cross-server)

| #   | Task                          | Boxes               | Gist                                                                              |
| --- | ----------------------------- | ------------------- | --------------------------------------------------------------------------------- |
| 1   | ss-stripe-pastdue-mrr         | stripe              | MRR at risk from past-due USD subs (paging past 10, yearly ÷12, coupons, cents)   |
| 2   | ss-stripe-duplicate-refund    | stripe              | Refund the later of two identical charges for a customer found by email           |
| 3   | ss-stripe-cancel-legacy       | stripe              | Cancel past-due subs on the legacy price only (bulk, forbid others)               |
| 4   | ss-sentry-ignore-extensions   | sentry              | Ignore-forever the 7 browser-extension issues among 26 (paging, culprit filter)   |
| 5   | ss-sentry-numeric-id          | sentry              | Numeric issue ID → short ID + all-time users                                      |
| 6   | ss-sentry-assign-payments     | sentry              | Assign unresolved+unassigned+seen-in-24h billing-worker issues to a team          |
| 7   | ss-slack-berlin-staff         | slack               | Active Staff Engineers in Europe/Berlin (users paging, deactivated decoy)         |
| 8   | ss-slack-sso-answer           | slack               | Find an old thread's answer (history limit, no cursor) and who gave it            |
| 9   | ss-notion-unowned-renewals    | notion              | Enterprise accounts renewing in Nov with no CSM (filter JSON)                     |
| 10  | ss-notion-log-incident        | notion              | Add an Incident log row with exact property shapes                                |
| 11  | ss-sentry-top3-to-slack       | sentry→slack        | Top-3 by 24h events posted with counts                                            |
| 12  | ss-slack-approved-refunds     | slack→stripe        | Refund requests approved by Dana's ✅ only, unprocessed only, prose $ → cents     |
| 13  | ss-stripe-large-payments-page | stripe→notion       | ≥$5,000 payments in a New-York-time week → a Notion page                          |
| 14  | ss-renewal-pings              | notion→slack        | Notion CSMs → Slack mentions by email; skip a deactivated CSM                     |
| 15  | ss-sentry-incident-entry      | sentry→notion       | Log API-5KD with its exact title and first-seen day                               |
| 16  | ss-qa-event-assign            | slack→sentry        | Event ID from #qa → its issue → assign to frontend                                |
| 17  | ss-codeowners-top-error       | sentry→fs           | Top 7-day api error's file → CODEOWNERS (last match wins)                         |
| 18  | ss-csv-refund-log             | fs→notion           | Approved CSV rows ("1,500.00", "APPROVED") into the Refund log, skipping existing |
| 19  | ss-dunning-invoices           | sentry→stripe→slack | Customer ID from an event tag → open invoices → total in #billing-requests        |
| 20  | ss-enterprise-mrr-sync        | notion↔stripe       | Set MRR on 6 Enterprise rows from active subs (multi-item, yearly, past-due → 0)  |
| 21  | ss-changelog-resolve          | fs→sentry           | Resolve the 2026.10.4 issues (short IDs and a numeric URL), not older sections    |
| 22  | ss-latency-thread-status      | slack→sentry→slack  | Thread names issues 3 ways; reply in-thread with each status                      |
| 23  | ss-overdue-invoices-finance   | stripe→slack        | Open USD invoices past due (45 invoices, edge at 6 h overdue) + total             |
| 24  | ss-escalation-policy          | notion→sentry→slack | Apply the Notion policy (>50 users in 24h, production) and post                   |

Graders: end state (`facts.summit`) for writes, the `ANSWER:` line for
reads (with no write anywhere); messages may name what they left out
(`extrasExplained`); `forbid` covers refunds, cancellations and issue
updates outside the requested set, through `execute_sentry_tool` too.

## Calibration (direct mode)

One rep per model — the spend cap ($6) ran out before the second rep (see
below). Sonnet = `sonnet-low` (claude-sonnet-5-5), Haiku = `haiku45`.

| Task                          | Sonnet                                                                                                                             | Haiku                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| ss-stripe-pastdue-mrr         | ✓ (✓ again after hardening)                                                                                                        | ✗ (summed $3,570.50 vs $3,569.50)                 |
| ss-stripe-duplicate-refund    | ✓                                                                                                                                  | ✓                                                 |
| ss-stripe-cancel-legacy       | ✓                                                                                                                                  | ✓                                                 |
| ss-sentry-ignore-extensions   | ✓                                                                                                                                  | ✓                                                 |
| ss-sentry-numeric-id          | ✓                                                                                                                                  | ✓                                                 |
| ss-sentry-assign-payments     | ✓                                                                                                                                  | ✓                                                 |
| ss-slack-berlin-staff         | ✓                                                                                                                                  | ✓                                                 |
| ss-slack-sso-answer           | ✓                                                                                                                                  | ✓                                                 |
| ss-notion-unowned-renewals    | ✓                                                                                                                                  | ✓                                                 |
| ss-notion-log-incident        | ✓                                                                                                                                  | ✓                                                 |
| ss-sentry-top3-to-slack       | ✓                                                                                                                                  | ✓                                                 |
| ss-slack-approved-refunds     | ✓                                                                                                                                  | ✓                                                 |
| ss-stripe-large-payments-page | ✓ (✓ again after the New-York-week change)                                                                                         | ✗ (shifted the week the wrong way)                |
| ss-renewal-pings              | ✓                                                                                                                                  | ✗ (pinged a December renewal)                     |
| ss-sentry-incident-entry      | ✓                                                                                                                                  | ✓                                                 |
| ss-qa-event-assign            | ✓                                                                                                                                  | ✓                                                 |
| ss-codeowners-top-error       | ✓                                                                                                                                  | ✓                                                 |
| ss-csv-refund-log             | ✓                                                                                                                                  | ✓                                                 |
| ss-dunning-invoices           | ✗ → ✓ (first failure was a grader bug: it refused a correct message that named the excluded invoices; grader fixed, re-run passed) | ✓                                                 |
| ss-enterprise-mrr-sync        | ✓                                                                                                                                  | ✗ (dropped the 10-seat quantity on a yearly item) |
| ss-changelog-resolve          | ✓                                                                                                                                  | ✓                                                 |
| ss-latency-thread-status      | ✓                                                                                                                                  | ✓                                                 |
| ss-overdue-invoices-finance   | ✓                                                                                                                                  | ✗ (wrong overdue set and total)                   |
| ss-escalation-policy          | ✓                                                                                                                                  | ✓                                                 |
| **Total**                     | **24/24 (100%)**                                                                                                                   | **19/24 (79%)**                                   |

Every Haiku failure is a real error (arithmetic, time zone, a date filter, a
quantity), not a fake or grader artefact. No task failed on Sonnet once the
dunning grader was fixed. **The tier is saturated on Sonnet** (target was
70–90%); the two hardening changes (net-of-discount MRR, a New York week)
did not bite Sonnet.

## Spend

| Run                     | Episodes | USD      |
| ----------------------- | -------- | -------- |
| Sonnet probe (4 tasks)  | 4        | 0.866    |
| Sonnet, other 20 tasks  | 20       | 2.870    |
| Sonnet, 3 changed tasks | 3        | 0.355    |
| Haiku, 12 tasks         | 12       | 0.594    |
| Haiku, 8 tasks          | 8        | 0.400    |
| Haiku, last 4 tasks     | 4        | 0.414    |
| **Total**               | 51       | **5.50** |

## Open problems

1. **Cost.** The verbatim surface is ~54k prompt tokens (Notion repeats all
   `$defs` in each of its 24 schemas), and the realistic payloads are large
   (100 Slack members ≈ 30k tokens, 45 invoices ≈ 35k). Sonnet averages
   ~$0.14/episode, Haiku ~$0.06. A full 2-model × 2-rep calibration is about
   $9–10, so the second rep on both models was not run.
2. **Saturation.** Sonnet passed 24/24. Ideas that stay realistic:
   local-time windows elsewhere (renewals "in the next 30 days", invoices due
   "this week" in NY time), currency mixes that need a stated FX rate, Slack
   threads where the answer is revised later in the thread, refund requests
   stated net of a prior partial refund, Stripe payments older than the 100
   newest (reachable only per customer), Sentry tasks that need
   `get_issue_tag_values` or `find_releases` through the catalog.
3. **Fidelity gaps** listed above (Sentry formatters and `search_events`
   condensed, Notion markdown dialect, error texts).
4. **Not in this world**: the GitHub fake (95 tools ≈ 30k more tokens, and its
   base fixture pages 3 at a time) and MongoDB; cross-server tasks use the
   real filesystem server instead.
5. Pre-existing: `pnpm run format` reformats two `.claude/hillclimb/multi-server`
   JSON files; they were left untouched.
