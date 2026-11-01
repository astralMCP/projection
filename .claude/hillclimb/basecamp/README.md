# Basecamp

The harness the next hill-climb runs on: five independent work branches,
merged in this order into `basecamp`. Code in `packages/harness`; the
harness README there is the reference for every tier, mode and knob.

## Packages

| Branch                  | What it adds                                                                                                                                                                                   | Write-up                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `basecamp-mocks`        | Fidelity fixes to the GitHub, workplace and MongoDB fakes, so that each answers like the real server it imitates (graders and goldens updated to match).                                       | [mocks.md](mocks.md) (calibration data in [mocks-calibration/](mocks-calibration/)) |
| `basecamp-servers-real` | The `summit-local` tier: six real MCP servers that run locally (filesystem, git, memory, SQLite, fetch, time) on one seeded company.                                                           | [servers-real.md](servers-real.md)                                                  |
| `basecamp-servers-mock` | The `summit-saas` tier: high-fidelity in-process fakes of the Notion, Sentry, Slack and Stripe MCP servers, plus the real filesystem server.                                                   | [servers-mock.md](servers-mock.md)                                                  |
| `basecamp-messy`        | The `summit-messy` tier: `messify`, a proxy that serves a degraded surface over any in-process world, the messy world and a 315-tool generated billing API. Also mail search `-term` negation. | [messy.md](messy.md)                                                                |
| `basecamp-baselines`    | The `native-search` and `native-ptc` baselines, the Projection ablations, `PROJ_EVAL_HOST_PROMPT=realistic`, an OpenAI-compatible provider (Muse Spark, Kimi K2.5), `PROJ_EVAL_TIMEOUT_MIN`.   | [baselines.md](baselines.md)                                                        |

## Tiers

Select with `PROJ_EVAL_TIERS` (comma list). Setup commands run in
`packages/harness`.

| Tier           | World          | Tasks | Default | Setup                                                      |
| -------------- | -------------- | ----: | ------- | ---------------------------------------------------------- |
| `basic`        | `github`       |    15 | yes     | none (offline GitHub fake)                                 |
| `hard`         | `github`       |    15 | yes     | none                                                       |
| `filesystem`   | `filesystem`   |    15 | yes     | none (real filesystem server, a devDependency)             |
| `mongodb`      | `mongodb`      |    15 | yes     | `pnpm run setup:mongodb`                                   |
| `multi`        | `multi`        |    17 | yes     | `pnpm run setup:mongodb`                                   |
| `multi-hard`   | `multi`        |    12 | opt-in  | `pnpm run setup:mongodb`                                   |
| `workplace`    | `workplace`    |    14 | opt-in  | none (in-process fakes)                                    |
| `hitl`         | `workplace`    |     5 | opt-in  | none                                                       |
| `summit-local` | `summit-local` |    24 | opt-in  | `pnpm run setup:servers-real` (needs npm and uv)           |
| `summit-saas`  | `summit`       |    24 | opt-in  | none (in-process fakes plus the filesystem server)         |
| `summit-messy` | `messy`        |    21 | opt-in  | none (in-process; each task opens only the boxes it names) |

Every world but `github`, `filesystem` and `mongodb` is boxed (several
servers, one alias each).

## Modes

Select with `PROJ_EVAL_MODES` (comma list). The default is `direct`,
`projection` and `projection-boxes`. Every mode runs on every tier, except
`projection-boxes`, which runs on boxed worlds only. `native-ptc` is skipped
on models without programmatic tool calling (Haiku 4.5), and both native
modes are skipped on OpenAI-compatible presets.

| Mode                    | What the model sees                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `direct`                | The raw tools inline (boxed worlds: every box's tools as `<alias>__<name>`).                        |
| `projection`            | The Projection facade with default options.                                                         |
| `projection-boxes`      | The multi-server facade with `catalog.globalSearch: false` (per-box search only).                   |
| `projection-direct`     | `projections.direct: true`: every wrapped tool also listed as a mediated alias.                     |
| `projection-auto`       | `projections.direct: 'auto'`: listed when the definitions fit the default budget.                   |
| `native-search`         | Direct's tools, all `defer_loading`, behind Anthropic's tool search tool (`PROJ_EVAL_TOOL_SEARCH`). |
| `native-ptc`            | Direct's tools callable from Anthropic's code execution tool (`PROJ_EVAL_PTC_CALLERS`).             |
| `projection-search`     | Ablation: `projections.direct: false` (never list tools directly).                                  |
| `projection-nocode`     | Ablation: `projections.codeMode: false` (catalog only).                                             |
| `projection-codeonly`   | Ablation: `projections.catalog: false` (code mode only).                                            |
| `projection-nopreamble` | Ablation: `codeModePreamble: ''` (no routing preamble).                                             |

## Env flags

Run: `PROJ_LIVE_EVAL=1 pnpm --filter @astral-mcp/harness exec vitest run test/tool-choice.live.test.ts`.

| Flag                              | Meaning                                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `PROJ_LIVE_EVAL=1`                | Opt in to the live eval (with `ANTHROPIC_API_KEY`, or `OPENROUTER_API_KEY` for the OpenAI-compatible presets).                   |
| `PROJ_EVAL_MODELS`                | Presets: `haiku45`, `sonnet-low`, `haiku-low`, `sonnet-medium`, `muse-spark`, `kimi-k25` (default `haiku45,sonnet-low`).         |
| `PROJ_EVAL_MODES`                 | Modes, above.                                                                                                                    |
| `PROJ_EVAL_TIERS`                 | Tiers, above.                                                                                                                    |
| `PROJ_EVAL_TASKS`                 | Task names, within the selected tiers.                                                                                           |
| `PROJ_EVAL_RUNS`                  | Episodes per cell (default 3).                                                                                                   |
| `PROJ_EVAL_CONCURRENCY`           | Episodes in flight (default 4).                                                                                                  |
| `PROJ_EVAL_TIMEOUT_MIN`           | Interactive runs: the test's timeout in minutes (default 30).                                                                    |
| `PROJ_EVAL_HOST_PROMPT=realistic` | Every mode: a ~12k-token generic agent-host system prompt before the session's own (default: the one-line framing only).         |
| `PROJ_EVAL_TOOL_SEARCH`           | `native-search`: `bm25` or `regex` (default `bm25`).                                                                             |
| `PROJ_EVAL_PTC_CALLERS`           | `native-ptc`: `code` or `both` (default `code`).                                                                                 |
| `PROJ_EVAL_BOX_DESCRIPTIONS=1`    | Boxed tiers, Projection modes: pass the host's box descriptions (default off).                                                   |
| `PROJ_EVAL_FORCE_CODE_MODE=1`     | Projection modes: append `FORCE_CODE_MODE_LINE` to the system prompt.                                                            |
| `PROJ_EVAL_APPROVER`              | Approver persona over every task's own: `approve-all`, `deny-destructive`, `deny-matching`, `cancel`, `edit`.                    |
| `PROJ_EVAL_APPROVAL_PROMPTS`      | Projection modes: `WrapOptions.approvalPrompts`, per-call or batched.                                                            |
| `PROJ_EVAL_BATCH=1`               | Send model calls through the Message Batches API, all episodes in lockstep (not with `native-ptc` or OpenAI-compatible presets). |
| `PROJ_EVAL_BATCH_WIDTH`           | Batch mode: episodes live at once (default 24).                                                                                  |

## Protocol

- **Dev tiers** (climbed on): `basic`, `hard`, `filesystem`, `mongodb`,
  `multi`, `multi-hard`, `workplace`, `hitl`.
- **Summit tiers** (held out, frozen at this commit): `summit-local`,
  `summit-saas`, `summit-messy`. They are run only at milestones. Their
  failure transcripts may be read only by a separate audit pass that reports
  "eval bug or not", never as input to facade design.
- The harness hash must be re-approved by the user before official rounds.
