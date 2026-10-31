# @astral-mcp/harness

A scenario-driven test harness for [Projection](../projection). It drives
`execute_machine` through the full MRTR round-trip loop under a scripted
answer policy, records the side effects that actually reached the wrapped
server, and reports enough to assert the approval invariants and the PRD
Section 10 budgets (blob size, round-trip counts). The bundled tests cover
S1 (the wrapped server's own tools are never exposed), S2 (approval binds
the sealed call), S3/S4 (tampered and truncated blobs execute nothing), S5
(annotation-driven policy), and S6 (server-derived prompt copy).

The scenario layer is deterministic and CI-runnable on its own. On top of it,
`src/reasoning/` implements the Anthropic-SDK reasoning loop (PRD §13): a
`MachineAuthor` — a live model, or a deterministic scripted author in CI —
writes machines for benchmark tasks, structured `isError` results feed back
for self-healing, and `summarizeSelfHeal` computes the §10 metrics
(first-attempt valid rate ≥ 60%, ≤ 2 attempts to valid ≥ 90%).

Run the live benchmark (explicit opt-in; needs `ANTHROPIC_API_KEY`, model
overridable via `PROJ_BENCH_MODEL`):

```bash
PROJ_LIVE_BENCH=1 pnpm --filter @astral-mcp/harness exec vitest run test/reasoning.live.test.ts
```

## Usage

```ts
import { wrapMcpServer } from '@astral-mcp/projection';
import { createFileServer, runScenario, denyKeys } from '@astral-mcp/harness';

const file = createFileServer({ '/notes.txt': 'original' });
const facade = await wrapMcpServer(file.server, { blob: { key } });

const result = await runScenario(facade, file, {
  name: 'deny-the-write',
  code: machineSource,
  verdicts: denyKeys('w1'), // approve everything except call "w1"
});

result.status; // 'completed' | 'error' | 'aborted_round_limit'
result.sideEffects; // every tool the wrapped server actually executed
result.maxBlobBytes; // largest sealed requestState seen
```

## Scenario scripts (PRD §13)

| Helper                | Models                                            |
| --------------------- | ------------------------------------------------- |
| `approveAll`          | user approves every prompt                        |
| `declineAll(reason?)` | user declines everything                          |
| `denyKeys(...keys)`   | decline specific calls, approve the rest          |
| `ignoreKeys(...keys)` | omit responses entirely (R17: treated as decline) |
| `tamperCiphertext`    | flip a byte of the sealed blob (S3)               |
| `truncateState`       | corrupt the blob in transit                       |

A scenario may also set `tamper` (with optional `tamperRounds`) to mutate
the `requestState` before a retry.

The `test/` suite asserts, against a real wrapped `McpServer`: approved
writes execute; declined and ignored calls never reach the server; tampered
and truncated blobs fail verification with no side effect; and — in
`replay.test.ts` — the documented D4 in-TTL replay behaviour, so a future
replay-cache fix has a regression to flip.

## Tool-choice eval: direct tools vs Projection

`src/eval/` measures how often a model picks the **correct wrapped tool with
correct arguments** for a task when the wrapped server (or, on the multi
tier, servers) is exposed (A) directly as native tools or (B) through
Projection's five tools
(`search_tools`, `describe_tool`, `call_tool`, `discover_apis`,
`execute_machine`). The `projection` and `projection-boxes` modes wrap with
`projections.direct: false`, so they measure the search surface even though
the library default is `'auto'` (D28); the opt-in `projection-auto` and
`projection-direct` modes measure direct listing. Each episode gets a fresh **world** (`openWorld`): an
MCP server whose tool executions are recorded, so the same task scores
identically in both modes. Two kinds exist. The GitHub world is an offline
fake of the remote GitHub MCP server (`createGithubFake`): the real 95-tool
catalog — names, descriptions, JSON Schemas, annotations and the server's
own `instructions`, dumped once into `test/fixtures/github-catalog.json` —
answering from a small canned world. The filesystem world is the _real_
filesystem reference server (`@modelcontextprotocol/server-filesystem`, a
pinned devDependency) spawned over stdio on a throwaway fixture tree, behind
a recording proxy (`createRecordingProxy`) that re-registers its tools
verbatim, output schemas included, and forwards every call. The GitHub fake
registers no output schemas: its canned answers are JSON text that does not
conform to GitHub's real output schemas, so its tools show "none declared"
through Projection while the filesystem and MongoDB tools show theirs.
Tasks (`TOOL_CHOICE_TASKS`) say what to do, never how, and score the
recorded upstream calls — plus, where effects are real, a `verify` of the
end state (the file really moved; the answer names the right file). In
projection mode a scripted approve-all client
auto-fulfils every approval round trip, so the model only sees results.
Every mode's system prompt starts with the same one-line host framing
("You operate the user's … through the tools provided. Complete the user's
task, then stop."), as a real host has its own system prompt whatever it
connects to; direct mode follows it with the server's `instructions`, the
Projection modes with the facade's.

Tasks come in five tiers. The **basic** tier (15 tasks against
`modelcontextprotocol/servers`) is one or two obvious calls each; current
models saturate it. The **hard** tier (15 tasks against `acme/widgets` and
the user's own repositories) discriminates: write tools whose `method` enum
the prompt's verb must pick (close as not planned, re-run only failed jobs,
reply in a review thread), candidate lists the prompt narrows to one (the
PR by alice that touches CHANGELOG.md; the newest _open_ bug), a paged
branch listing with the target on page 2, first attempts the fake rejects
with `isError` (no `main` branch — the default is `master`; `README.md` is
a 404 — the file is `readme.md`), conditional writes that must _not_ happen
(the issue already exists; the repo is already starred), a get_me → repos →
Dependabot alerts → issue chain, and PR URLs to parse. Hard tasks may
`forbid` calls (a wrong write fails the episode even when the right one also
happened) and assert that a write follows the lookup that justified it. The
fake's hard-tier behaviours are pure functions of the call's arguments, and
every episode gets a fresh fake, so the world is identical for every run.
The **filesystem** tier (15 tasks on the real reference server) targets its
near-duplicate tools and argument choices: a move into a directory that does
not exist yet (`move_file` after the server rejects the first attempt, never
read-then-write), edits that need a read first (bump a patch version the
prompt does not state; retitle a changelog heading to the version in
`package.json`), a size question a plain listing cannot answer, a recursive
search where a flat listing misses `src/legacy/debug.log`, an image
(`read_media_file` as the _first_ choice — a text read of the PNG fails the
episode), `head: 5` on a 36 KB log (a string `"5"` is rejected by the
schema), a conditional create that must _not_ happen because the file
exists, a `dryRun` edit that must leave the file alone, and a two-file move
into a directory that has to be created first. Question tasks ask for "just
the file name" and fail an answer that hedges across candidates. Prompts
carry the episode's temp directory, so they are functions of the world's
facts (`promptFor`). Two inherent Projection costs show up on a server this
small: `search_tools` returns only the first sentence of each description,
so a parameter like `head` is visible only after `describe_tool`, and those
discovery turns are many. The turn budget therefore counts _action_ turns:
a Projection turn that only called `search_tools`, `describe_tool` or
`discover_apis` is free (direct mode has that information inline), up to an
absolute ceiling of twice the budget so a model that loops on discovery
still stops; both modes get the same budget. Free is by tool name, not
outcome: a failed `call_tool` counts like a direct call with bad arguments,
while a failed `describe_tool` or endless `search_tools` paging is bounded
only by the ceiling. The ceiling bounds calls, not tokens: each extra turn
resends the growing context (softened by cache reads), so the discovery
cost stays visible in the turns, tokens and cost columns.

The **mongodb** tier (15 tasks on the real MongoDB MCP server,
`mongodb-mcp-server` 3.2.1, against a seeded throwaway `mongod` from
`mongodb-memory-server`) targets JSON-shaped arguments and near-duplicate
tools: a filtered count, a top-3 by price (`sort` + `limit` or a
`$sort`/`$limit` pipeline — the fixture has 120 products, so an unsorted
read capped at the server's 100 cannot see the most expensive one), a
group-by, a status update whose scope is checked on the deployment (exactly
the two stale orders flipped), a delete that must carry a filter, dropping
one collection but not the database, a rename, a conditional insert that
must _not_ happen, a which-database question with a decoy `reports` database
to rule out, and a query-plan question — and every tool needs the opaque
`connectionId: "preconfigured"` the schema describes. Reads also count
through the database-level `aggregate-db`, which models reach a collection
from with a `$documents` seed and a `$lookup` (or a `$unionWith`). The server's
dependency tree needs a newer MCP SDK than the workspace pins, so it is
installed in isolation once with `pnpm run setup:mongodb` (in
`packages/harness`; CI does this); the `mongod` binary (~80 MB) is
downloaded once into `~/.cache/mongodb-binaries` (`MONGOMS_DOWNLOAD_DIR`).
The server is spawned with a minimal environment (never the inherited
`MDB_MCP_*` variables, which could silently make it read-only or enable
Atlas tools), tools that reach outside the deployment (`connect`, `export`,
the knowledge-base search, the Atlas categories) are disabled, and the world
asserts the listed tools are exactly the expected 21. The recording proxy
mirrors each tool's declared output schema (all 21 declare one, as do all
14 filesystem tools) and forwards each result's `structuredContent` along
with its content blocks, so Projection sees what it would in production:
`describe_tool` shows the output schema, and `call_tool` renders the
structured result rather than an escaped content array. The proxy's SDK
validates each forwarded result against the mirrored schema; both servers'
results conform, and the worlds' golden-fidelity tests fail on any error
result.

The **multi** tier (17 tasks) runs against all three at once: the **multi
world** (`openMultiWorld`) opens the GitHub fake, the filesystem world and
the MongoDB world together as boxes under the aliases `github`, `fs` and
`mongo`, records every call once in the order it ran as
`{ tool: '<alias>.<name>', args }` (so a grader can tell `github.get_file_contents`
from `fs.read_text_file`, and order a write in one box after the read in
another), merges the facts (`root`, `mongoUri`) and closes all three on
teardown. It has three modes:

- **direct** — the **flat list baseline**: every tool of every box inlined
  as a native tool named `<alias>__<name>` (Claude Code's
  `mcp__<server>__<tool>` naming), with the framing and then every box's own
  `instructions` under a heading naming its alias in the system prompt. Real
  hosts may defer a tool set this large behind their own tool search rather
  than inline it; this baseline does not (`hostToolName` keeps names within the
  Messages API's `^[a-zA-Z0-9_-]{1,64}$`, replacing other characters and
  truncating with a hash suffix; no current name needs either — the longest,
  `github__manage_repository_notification_subscription`, is 51 characters);
- **projection** — `wrapMcpServers({ github, fs, mongo })` with default
  options: both projections and the global `search_tools` next to
  `search_github`, `search_fs` and `search_mongo`;
- **projection-boxes** — the same with `catalog: { globalSearch: false }`, so
  only the per-box search tools remain.

The boxes carry no host `description` by default; `PROJ_EVAL_BOX_DESCRIPTIONS=1`
passes one per box to `wrapMcpServers` (`MULTI_BOX_DESCRIPTIONS`: "GitHub:
issues, PRs and repos for acme/widgets", "The user's project files", "The
shop MongoDB deployment"), and the results file records which was used
(`boxDescriptions`).

`projection-boxes` runs on the multi tier only: a single-server facade has no
boxes, so the runner never plans it for the other tiers (`modeApplies`), and
their episodes are the same whichever modes are selected. Discovery turns are
free on the multi facade as on a single-server one, the `search_<alias>`
tools included. The tasks are six **cross-box** chains where one box's
output feeds another (the changelog's Unreleased entry becomes an issue body
in `acme/widgets`; the shipped-order count becomes a comment on #23; the
largest log file's name becomes an `audit_log` document; the package
version becomes a `release/1.2.0` branch; the four open PR titles — paged
three at a time — become `notes/prs.txt`; Grace Lin's email becomes a todo
line), each scored on the write following the read that justified it and
carrying the value read (a release issue with the wrong body, or a comment
on #23 with any number next to "shipped" other than 4 — "4" or "four" — is
forbidden even when a corrected one follows); four **box-choice** tasks
where two boxes have a similarly named tool (the project's README vs
`acme/widgets`' readme; the project's `src` folder vs the repository's —
a listing of `src`, the project's whole `directory_tree`, or the
repository's recursive `get_repository_tree` all count), scored the same in
both directions: the right box read, an answer with the right box's content
and none of the other's, and no write into the wrong box — a read of the
wrong box is a detour, not a failure; four **global** tasks whose prompts do
not say which box holds the answer (the project's version and whether
`acme/widgets` has a release branch for it — 1.2.0 and `release/1.2`; who
grace@example.com is and her order's status — Grace Lin, pending; whether
CSV export is released — no, it is under Unreleased in the changelog; the
last request id in `app.log` — 1399), graded on the answer and on having
consulted the boxes that hold it, with any write forbidden; and three
**single-box controls** copied verbatim from the GitHub, filesystem and
MongoDB tiers (`ctl-*`), so a drop on the multi tier can be split between
routing across boxes and the task itself. The boxes a task needs are the
aliases its steps name; every multi-tier record carries its box routing
(`boxes`: whether the global `search_tools` was used, whether the first
upstream call went to a needed box, and how many calls went to a box the
task does not need). What it decides: how much a flat tool list costs
against Projection's boxes, and — `projection` against `projection-boxes` —
whether the global search earns its place, which settles the
`catalog.globalSearch` default (PRD R43, §13). **Decision runs use
`PROJ_EVAL_TIERS=multi`**, so no other tier's episodes mix into the cell
totals; the report's per-tier blocks break each tier out on its own anyway.
The approvals-mode comparison §13 also asks for is not run yet.

The opt-in, held-out **summit-messy** tier (20 tasks, `messy-tasks.ts`)
measures robustness to other people's badly built servers, for comparing
the facade against raw servers. Its **messy world** (`messy-world.ts`)
opens up to four boxes, each a working server behind
`messify(world, profile)` (`messify.ts`): a reusable proxy that serves a
degraded surface over any in-process single-server world (a workplace
fake, the GitHub fake, a recording proxy) and maps each call back, so the
wrapped server still records canonical names and arguments. Its defects
are ones real servers ship: missing, one-word or multi-KB descriptions;
parameters with no description; schemas with no `type` or Pydantic-style
`anyOf`/`$ref`/`oneOf`; unknown arguments dropped silently; no
annotations or no `readOnlyHint`; generic names (`search`, `get`,
`create`, `list`) that collide across boxes; camelCase on some tools and
snake_case on others; errors sent as ordinary results; JSON as one text
block (compact or Python `repr`) with no `structuredContent`; output
schemas that drifted from the payload; 100 KB+ results; the next page
mentioned only in prose; no or rambling `instructions`; slow tools. The
boxes are `tracker` (terse, generic names), `chat` (verbose, camelCase
mix, 100 KB history), `mail` (Pydantic schemas, `repr` results) and
`billing`, a 315-tool catalog generated from a payments-style OpenAPI
document (`messy-billing.ts`: operationId names, HTML or empty
descriptions, a nested `requestBody`, cursor, page-number and offset
pagination). A task opens only the boxes it names (`EvalTask.boxes`), so
the catalog is in the ten tasks that need it. The prompts are ordinary
requests; graders read the end state or a final `ANSWER:` line, accept
every correct path, and each task has a `forbid` and its own turn budget.
Calibrate it in `direct` mode only (`PROJ_EVAL_TIERS=summit-messy
PROJ_EVAL_MODES=direct`).

Run it (explicit opt-in; needs `ANTHROPIC_API_KEY`):

```bash
PROJ_LIVE_EVAL=1 pnpm --filter @astral-mcp/harness exec vitest run test/tool-choice.live.test.ts
```

Knobs: `PROJ_EVAL_MODELS` (comma list of presets: `haiku45`, `sonnet-low`, `haiku-low`,
`sonnet-medium`; default `haiku45,sonnet-low`), `PROJ_EVAL_MODES` (`direct,projection,projection-boxes`,
the default), `PROJ_EVAL_TIERS`
(`basic,hard,filesystem,mongodb,multi`, the default; opt-in `multi-hard`,
`workplace`, `hitl`, `summit-messy`; `mongodb` and `multi` need
`pnpm run setup:mongodb`), `PROJ_EVAL_TASKS` (comma list of task names
within the selected tiers), `PROJ_EVAL_RUNS` (default 3),
`PROJ_EVAL_CONCURRENCY` (default 4), `PROJ_EVAL_BOX_DESCRIPTIONS=1` (multi
tier: host box descriptions; default off), `PROJ_EVAL_FORCE_CODE_MODE=1`
(Projection modes: append "Use code mode (discover_apis, execute_machine)
for this task." to the system prompt, recorded as `systemSuffix`; default
off). Projection records also count `roundTrips`, the approval round trips
(MRTR retries) next to `approvals`, one per gated call. The report (success %,
tool-correct %, turns, upstream calls, tokens, cache-read share, estimated
cost, turn-capped and harness-error counts, a per-tier summary, a block per
tier with that tier's own success, turns — total and counted — tokens, cost
and discovery calls, plus on the multi tier the global-search use and
success, first-call-to-the-right-box and detour counts, a per-task table
grouped by tier, and Projection's route split with its discovery calls per
search tool) is printed, and the records are written to
`eval-results/<timestamp>.json` (gitignored), rewritten after every episode
so a timeout or crash keeps the partial results. Episodes run interleaved —
run 0 of every task in every model × mode cell, then run 1 — so a run cut
short has the same sample in every cell; records stay in model → mode →
task → run order. Each record keeps the episode's full `transcript` (the
system prompt, every assistant turn's text, tool-use and thinking blocks —
thinking signatures dropped — and every tool result's text exactly as the
model saw it; images were already one-line placeholders) and the
`servedModel` the API reported, for reading episodes without re-running
them. An episode that spends its turn budget (12 by default) or
reaches the absolute ceiling (twice the budget) is scored on the upstream
calls it made (and flagged `turnCapped`); refusals, `max_tokens`, API errors
and harness exceptions are harness errors, excluded from the success
denominators but still counted toward spend. The results file records the
budget and ceiling it ran under (`maxTurns`, `maxTotalTurns`).

A grader fix does not need a new (paid) run: from the repo root,
`pnpm --filter @astral-mcp/harness run rescore packages/harness/eval-results/<timestamp>.json`
re-scores a saved results file offline with the current tasks
(`rescoreRecords`), writes `<timestamp>.rescored.json` next to it with the
summary recomputed, and prints the report plus every episode whose verdict
changed. `expect`, `forbid` and the step groups are re-run on the recorded
upstream calls, and `verify` on the recorded final text — except for tasks
marked `needsWorld` (their verify reads files on disk or the deployment,
which are gone), whose recorded verdict stands unless `expect` or `forbid`
now fail (DECISIONS D13). It also prints any episode a grader threw on
(left as recorded) and how many recorded `needsWorld` failures it could not
re-check offline — re-run those tasks to confirm.

The plumbing is proven offline in `test/eval/`: a scripted model drives the
modes end to end without an API key — against the fake, against the real
filesystem server, whose effects land on disk and whose `verify` is checked
both ways, and against the multi world in all three modes, where every
multi-tier golden also runs clean through each mode's tool surface — every task's predicate is checked against a golden call
sequence and a plausible wrong one, and each scripted fake behaviour is
checked call by call.
