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
correct arguments** for a task when the wrapped server is exposed (A)
directly as native tools or (B) through Projection's five tools
(`search_tools`, `describe_tool`, `call_tool`, `discover_apis`,
`execute_machine`). Each episode gets a fresh **world** (`openWorld`): an
MCP server whose tool executions are recorded, so the same task scores
identically in both modes. Two kinds exist. The GitHub world is an offline
fake of the remote GitHub MCP server (`createGithubFake`): the real 95-tool
catalog — names, descriptions, JSON Schemas, annotations and the server's
own `instructions`, dumped once into `test/fixtures/github-catalog.json` —
answering from a small canned world. The filesystem world is the _real_
filesystem reference server (`@modelcontextprotocol/server-filesystem`, a
pinned devDependency) spawned over stdio on a throwaway fixture tree, behind
a recording proxy (`createRecordingProxy`) that re-registers its tools
verbatim and forwards every call. Tasks (`TOOL_CHOICE_TASKS`) say what to
do, never how, and score the recorded upstream calls — plus, where effects
are real, a `verify` of the end state (the file really moved; the answer
names the right file). In projection mode a scripted approve-all client
auto-fulfils every approval round trip, so the model only sees results.

Tasks come in three tiers. The **basic** tier (15 tasks against
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
near-duplicate tools and argument choices: a rename (`move_file`, never
read-then-write), a one-line change that must keep every other byte, a size
question a plain listing cannot answer, a recursive search where a flat
listing misses `src/legacy/debug.log`, an image (`read_media_file`, not a
text read), `head: 5` on a 36 KB log, a conditional create that must _not_
happen because the file exists, a `dryRun` edit that must leave the file
alone, and a move into a directory that has to be created first. Prompts
carry the episode's temp directory, so they are functions of the world's
facts (`promptFor`).

Run it (explicit opt-in; needs `ANTHROPIC_API_KEY`):

```bash
PROJ_LIVE_EVAL=1 pnpm --filter @astral-mcp/harness exec vitest run test/tool-choice.live.test.ts
```

Knobs: `PROJ_EVAL_MODELS` (comma list of presets: `haiku45`, `sonnet-low`, `haiku-low`,
`sonnet-medium`; default `haiku45,sonnet-low`), `PROJ_EVAL_MODES` (`direct,projection`), `PROJ_EVAL_TIERS`
(`basic,hard,filesystem`, the default), `PROJ_EVAL_TASKS` (comma list of task names
within the selected tiers), `PROJ_EVAL_RUNS` (default 3),
`PROJ_EVAL_CONCURRENCY` (default 4). The report (success %, tool-correct %,
turns, upstream calls, tokens, cache-read share, estimated cost, turn-capped
and harness-error counts, a per-tier summary, a per-task table grouped by
tier, and Projection's route split) is printed, and the records are written
to `eval-results/<timestamp>.json`
(gitignored), rewritten after every episode so a timeout or crash keeps the
partial results. An episode that hits the 12-turn cap is scored on the
upstream calls it made (and flagged `turnCapped`); refusals, `max_tokens`,
API errors and harness exceptions are harness errors, excluded from the
success denominators but still counted toward spend.

The plumbing is proven offline in `test/eval/`: a scripted model drives both
modes end to end without an API key — against the fake and against the real
filesystem server, whose effects land on disk and whose `verify` is checked
both ways — every task's predicate is checked against a golden call
sequence and a plausible wrong one, and each scripted fake behaviour is
checked call by call.
