# Basecamp: messy (`summit-messy`)

A held-out tier that measures robustness to other people's badly built MCP
servers. The plan is to compare the facade against raw servers (direct mode)
on it. Branch `basecamp-messy`.

## What was built

- `packages/harness/src/eval/messify.ts`: `messify(world, profile)` wraps any
  in-process `ServerWorld` (a workplace fake, the GitHub fake, the billing
  catalog, or a recording proxy over a real server). It serves a degraded
  surface and maps each call back to the canonical tool and arguments, so the
  wrapped server still records the canonical calls that graders score.
  Defects (`Defect` union):
  - `descriptions`: none, one-word, or verbose (more than 4 KB of usage docs)
  - `property-descriptions`: stripped
  - `schema`: `untyped` (properties have no `type`) or `pydantic` (`anyOf`
    with null, `default: null`, titles, `$defs`/`$ref`, `oneOf` const enums;
    an explicit null is treated as "not given")
  - `loose-args`: no `additionalProperties: false`, and unknown arguments
    are silently dropped
  - `annotations`: none, or no `readOnlyHint`
  - `rename`: generic names
  - `arg-case`: camel or snake case, applied to some tools only
  - `errors-as-text`: `isError: false` with an `Error:` prefix
  - `results`: compact JSON text or a Python `repr`, with no
    `structuredContent`
  - `output-drift`: declared property names are case-flipped and nothing is
    required, so validators pass but nothing matches
  - `huge-results`: realistic padding past 100 KB
  - `pagination-trailer`: the next-page token appears only in prose
  - `instructions`: none, or several KB of rambling with one tip buried in it
  - `latency`
- `messy-billing.ts`: a 315-tool billing and admin API, laid out the way an
  OpenAPI-to-MCP generator serves a payments-style spec:
  - operationId names (`PostCustomersCustomer` is an update)
  - HTML descriptions, empty for about 30 tools; path parameters have no
    descriptions
  - a nested `requestBody`; `created` and `metadata` as `anyOf`
  - no annotations
  - three pagination styles: cursor/`has_more`, `page`/`per_page` with no
    `has_more`, and `offset` with `total`
  - search endpoints with a query language
  - epoch seconds and minor currency units
  - JSON error objects
  - Seven resources hold data. Every other operation returns a realistic
    empty list, a 404, or the created object; it never returns `{ok:true}`.
- `messy-world.ts`: the boxes and their profiles.
  - `tracker`: terse and generic. Tools are renamed `search`, `get`,
    `create` and `list`; descriptions are one word; property descriptions
    are stripped; results are compact JSON text; errors come back as text;
    there is no `readOnlyHint`; pagination uses the prose trailer.
  - `chat`: verbose, with rambling instructions and no annotations.
    `list_channels` becomes `list`. Two tools use camelCase arguments and
    the rest use snake_case. Unknown arguments are dropped. History pages
    are about 100 KB, and reads are slow.
  - `mail`: Pydantic-style schemas, and one tool with untyped properties.
    Unknown arguments are dropped. Tools are named `search`, `get` and
    `create`. There is no `readOnlyHint`. Results come back as `repr`, and
    errors come back as text.
  - `billing`: the generated catalog, plus output drift, errors as text and
    slow list endpoints.
  - Names that collide across boxes: `search`, `get` and `create` (tracker
    and mail), and `list` (tracker and chat). Box descriptions are within
    six characters of each other in length. Each task opens only the boxes
    it names (`EvalTask.boxes`). The host framing names exactly those boxes.
- `messy-tasks.ts`: 21 tasks. Registered as tier `summit-messy` (world
  `messy`) and opt-in. Also touched: `task-core.ts`, `world.ts`, `run.ts`
  (`taskWorldOptions`), `multi-tasks.ts` (`isBoxWrite` covers billing),
  `index.ts` and the README.
- Fidelity fix in a shared fake: the `workplace-mail.ts` search now honours
  a leading `-term` negation, as webmail syntax does. Before the fix,
  `is:unread -from:northwind.dev` returned "No messages found", which wrongly
  failed a correct path. Workplace and hitl tests are still green.
- Tests:
  - `test/eval/messify.test.ts` (28): every defect's transform, run over a
    real MCP connection, over the workplace fakes and the GitHub fake; the
    catalog's size, names and paging; collisions in the messy world.
  - `test/eval/messy-tasks.test.ts` (31): registration; a scripted reference
    solution through direct mode that passes for every task; a wrong
    solution (the slip each server invites) that fails every task; graders
    checked against alternative phrasings.

## How to run

```bash
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN PROJ_LIVE_EVAL=1 PROJ_EVAL_TIERS=summit-messy \
  PROJ_EVAL_MODES=direct PROJ_EVAL_MODELS=haiku45,sonnet-low PROJ_EVAL_RUNS=2 PROJ_EVAL_CONCURRENCY=4 \
  pnpm --filter @astral-mcp/harness exec vitest run test/tool-choice.live.test.ts
```

Do not use `PROJ_EVAL_BATCH=1` here. In batch ticks the cache never hit, so
every turn rewrote the 37–55K-token prefix at 1.25×, which cost more than
running interactively.

## Defect catalog (sources)

1. **Missing or one-word descriptions**: 97% of 856 tools had a smell, and
   56% did not state their purpose. "MCP Tool Descriptions Are Smelly!"
   arXiv:2602.14878; arXiv:2602.18914.
2. **Bloated descriptions or definitions**: github-mcp-server's 101 tools
   cost 64.6K tokens (github/github-mcp-server discussion #1182). Notion's
   24 tools cost about 21K tokens, with unused `$defs`
   (makenotion/notion-mcp-server #330).
3. **No parameter descriptions**: 12 Notion tools
   (notion-mcp-server #330). "Opaque parameters" in arXiv:2602.14878.
4. **`$ref`, `anyOf`, missing `type`**: gemini-cli #13326 (`$defs` not
   resolved); google/adk-python #3424 (`anyOf` with no type);
   taylorwilsdon/google_workspace_mcp #1099 (Pydantic `str | None`, and
   `const` rejected).
5. **`additionalProperties`**: github/github-mcp-server #376 (strict
   clients). Silent dropping is closest to grafana/mcp-grafana #641.
6. **Missing annotations**: thecyprince/career-ops-mcp #1. A plain
   `@mcp.tool()` emits none.
7. **Name collisions and limits**: IBM/chuk-tool-processor PR #53 (`search`
   and `query` collide, and the last one registered wins);
   home-assistant/core #163873 (names over 64 characters).
8. **camelCase vs snake_case**: grafana/mcp-grafana #641 (`datasourceUid`
   was sent as `datasource_uid`, silently dropped, and the call failed with
   a 400).
9. **Errors as successes**: kubeflow/mcp-server #263, fixed in PR #282.
10. **JSON only as text**: cogniumhq/cognium-mcp #38.
11. **`structuredContent` vs `outputSchema`**: anipotts/imessage-mcp #79 and
    k2b-dev/cloud #2017 ("Structured content does not match the tool's
    output schema" hides the real error). `messify` reproduces this exactly
    when `errors-as-text` meets a strict output schema.
12. **Huge results**: runpod/runpod-mcp #3 (386K tokens, over Claude Code's
    25K limit).
13. **Inconsistent pagination**: saidsef/mcp-github-pr-issue-analyser #405.
14. **Instructions**: anthropics/claude-ai-mcp #93 (some clients drop them,
    and Claude Code truncates descriptions at 2,048 characters). I found no
    evidence for rambling instructions; that case is modelled, not sourced.
15. **Huge generated catalogs**: the cloudflare/mcp README (2,594
    operations with code mode off); a Cursor forum post on its 40-tool
    limit.
16. **Slow tools**: anthropics/claude-code #63379 (a 60 s timeout, -32001).

## Fidelity notes

- The tracker, chat and mail boxes are the existing workplace fakes, with
  their sources as cited there. `messify` adds degradation on top; the data
  and semantics are unchanged.
- The billing API is invented: Northwind's own platform API. Its conventions
  follow a payments OpenAPI spec as an OpenAPI-to-MCP generator would serve
  it: operationIds, HTML descriptions, `expand`, `anyOf` `created` and
  `metadata`, error objects, search query syntax, and default `limit` 10
  with a maximum of 100. It cites no real server version because none
  exists to copy. The point is that it is generated.

## Tasks (one line each)

| task                    | boxes                  | what the server makes hard                                                                                                                                    |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| messy-refund-duplicate  | billing                | find `PostRefunds` among 315 tools; the charges list is newest first, so "the second charge" is the first one listed; refunding the first charge is forbidden |
| messy-active-pro        | billing                | page-numbered list with no `has_more`; the price ID is needed to filter                                                                                       |
| messy-past-due          | billing                | `due_date` is in epoch seconds; decoys are open but not yet due, or past the date but draft, void or uncollectible                                            |
| messy-coupon            | billing                | repeating plus `duration_in_months` under a nested `requestBody`                                                                                              |
| messy-flag-override     | billing                | a per-customer override, not the global flag; Initrode is a decoy                                                                                             |
| messy-tracker-done      | tracker                | three workflow transitions; an invalid one comes back as text                                                                                                 |
| messy-tracker-label     | tracker                | `labels` replaces the whole set; descriptions are one word                                                                                                    |
| messy-tracker-jonas     | tracker                | the assignee filter needs an email; "High" is not "Urgent"; there are no parameter docs                                                                       |
| messy-tracker-high      | tracker                | four pages, and the next-page token appears only in prose                                                                                                     |
| messy-tracker-bug       | tracker                | the priority number has no documentation (2 = High); the server's error explains it only when priority is missing                                             |
| messy-chat-migration    | chat                   | needs the channel ID; a channel name gets `ok:false` as success                                                                                               |
| messy-chat-action-items | chat                   | camelCase args on history and threads, snake_case elsewhere; 100 KB history; reply chatter mixed in                                                           |
| messy-chat-freeze       | chat                   | 100 KB history page; the 2.8 and 2.7.2 freezes are decoys                                                                                                     |
| messy-mail-draft        | mail                   | `create` drafts and `send_email` sends; Pydantic schemas; sending is forbidden                                                                                |
| messy-mail-unread       | mail                   | only external senders; `repr`-style results                                                                                                                   |
| messy-x-invoice-total   | mail, billing          | `mail.search` vs the billing search ops; amounts in minor units                                                                                               |
| messy-x-initech-address | mail, billing          | nested address in `requestBody`; Initrode is a decoy (writing to it is forbidden)                                                                             |
| messy-x-charge-comment  | billing, tracker       | both charge IDs; tracker `search` finds the account ID in the title                                                                                           |
| messy-x-must-ship       | all four               | `search`/`get` in two boxes plus 315 billing tools; the nice-to-have item is a decoy                                                                          |
| messy-x-review-state    | chat, tracker          | `list` in two boxes; yesterday's thread, not the one from the day before                                                                                      |
| messy-x-globex-reply    | billing, mail, tracker | draft only; name the duplicate charge and BE-152; refunding is forbidden                                                                                      |

## Calibration (direct mode only; successes/scored)

| task                    | haiku45         | sonnet-low                |
| ----------------------- | --------------- | ------------------------- |
| messy-refund-duplicate  | 1/1             | 3/3                       |
| messy-active-pro        | 1/1             | 2/2                       |
| messy-past-due          | 0/1             | 2/2                       |
| messy-coupon            | 1/1             | 2/2                       |
| messy-flag-override     | 1/1             | 2/2                       |
| messy-tracker-done      | 2/2             | 2/2                       |
| messy-tracker-label     | 2/2             | 2/2                       |
| messy-tracker-jonas     | 0/2             | 3/3                       |
| messy-tracker-high      | 1/1             | 2/2                       |
| messy-tracker-bug       | 0/2             | 2/2                       |
| messy-chat-migration    | 2/2             | 2/2                       |
| messy-chat-action-items | 1/1             | 2/2                       |
| messy-chat-freeze       | 1/1             | 2/2                       |
| messy-mail-draft        | 2/2             | 2/2                       |
| messy-mail-unread       | 2/3             | 3/3                       |
| messy-x-invoice-total   | 1/1             | 1/1                       |
| messy-x-initech-address | 1/1             | 1/1                       |
| messy-x-charge-comment  | 1/1             | 1/1                       |
| messy-x-must-ship       | 1/1             | 1/1                       |
| messy-x-review-state    | 1/1             | 1/1                       |
| messy-x-globex-reply    | 0/1             | 1/1 (regraded, see below) |
| **total**               | **22/29 (76%)** | **39/39 (100%)**          |

How to read the table:

- **Mixed runs.** The first rep of the first 10 tasks went through batch
  mode; everything else ran interactively.
- **Regraded episode.** Sonnet's `messy-x-globex-reply` was a correct draft,
  but the first grader refused any mention of the genuine charge ID. The
  grader is now fixed and unit-tested (`namesDuplicate`). The original
  recorded verdict was a failure.
- **Excluded episode.** One smoke episode of `messy-tracker-done` ran under
  the earlier wording ("move it to Done"). Sonnet stopped to ask whether it
  should go through the intermediate states, so the prompt now says to take
  whatever workflow steps are needed.
- **Haiku's failures are real:**
  - It got the epoch arithmetic wrong (past-due).
  - It guessed priority 4 or 5 for "high", because the parameter has no
    documentation (bug).
  - It passed `state:"open"` and a user ID to the one-word `search` tool
    (jonas).
  - It gave up and asked the user for the charge ID (globex-reply).

## Open problems

- **Saturated on Sonnet.** No task fails every rep on Sonnet (39/39), and
  Sonnet saturates the tier in direct mode. Haiku discriminates at 76%. I
  ran out of budget before I could make tasks harder and re-calibrate. As
  it stands, the tier can show the facade losing robustness, but not gaining
  it, on Sonnet. Candidates to harden:
  - drop the `ANSWER:` hints to tool-shaped values
  - put the catalog in every billing task alongside all four boxes, which
    also makes prefix caching shared and cheaper
  - make the pagination trailer the only signal on more lists
  - use a strict output schema with errors as text on a needed tool
- **Not every task got 2 reps.** The six cross-server tasks, and Haiku's
  billing and chat-history tasks, have one rep each. A second full pass
  would have cost about $3 on top of what was spent.
- **Cost.** Episodes with billing cost about $0.15–0.25 on Sonnet, because
  the catalog prefix is about 50K tokens. Most cross-server tasks each have
  a different box set, so each writes its own cache prefix.
- **Output drift is invisible in direct mode.** The Messages API has no
  output schema, so `output-drift` only shows up through a facade.

## Spend (live, direct mode only)

| run                                                  | episodes | USD       |
| ---------------------------------------------------- | -------- | --------- |
| smoke, Sonnet, 4 tasks                               | 4        | 0.370     |
| pass 1, batch, both models (stopped early)           | 22       | 1.275     |
| pass 1, remaining 11 tasks, interactive, both models | 22       | 1.797     |
| rep 2, cheap tasks, both models                      | 16       | 0.196     |
| rep 2, Sonnet, billing and chat-history tasks        | 8        | 0.479     |
| **total**                                            | **72**   | **4.117** |

Under the $5 cap.
