# @astral-mcp/tui

The manual TUI from PRD §13 — an [Ink](https://github.com/vadimdemedes/ink)
terminal client for exploratory Projection testing, and the team demo surface.
Type a task, watch the model's authored machine, validation results, and
captured console logs stream by, and answer each approval prompt with a
single key. Every suspension shows its sealed-blob size and round-trip count.

## Run

Needs `ANTHROPIC_API_KEY` — exported, or in a `.env` at the repo root (the
CLI loads the nearest `.env` itself, never looking above the repo root; an
exported variable always wins). `PROJ_BENCH_MODEL` overrides the model
(default `claude-opus-5`).

```bash
pnpm --filter @astral-mcp/tui start
```

The start script builds the TUI and its workspace dependencies through turbo
first, so it works on a fresh checkout.

## Controls

| Key     | When              | Does                                        |
| ------- | ----------------- | ------------------------------------------- |
| `enter` | at the task input | submit the task to the model                |
| `y`     | on an approval    | approve the shown call                      |
| `n`     | on an approval    | decline it (the machine gets `TOOL_DENIED`) |
| `i`     | on an approval    | ignore — omit the response (R17: a decline) |
| `q`     | when idle         | quit                                        |

## Embedding

The package exports the pieces separately: `App` (the Ink component) and
`driveTask` (the UI-agnostic interactive loop — author → execute → pause on
suspensions for verdicts → self-heal from structured errors). Pair them with
any `ProjectionFacade` and `MachineAuthor` (see `@astral-mcp/harness`), which
is exactly what the tests do with a deterministic scripted author.
