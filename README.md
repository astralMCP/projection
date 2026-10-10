# Projection

Wrap any MCP server in **code mode** (LLM-authored XState workflows) and a **tool catalog** (search, describe, call), with **human-approved side effects** over MCP MRTR (Multi Round-Trip Requests).

Projection wraps an existing MCP server and exposes two projections of it — five tools in all, never the wrapped server's own:

**Code mode** — for workflows:

- **`execute_machine`** — runs an LLM-authored XState v5 state machine inside a QuickJS WebAssembly sandbox. Read-only tool calls execute immediately; any write suspends the machine into a sealed, encrypted blob and asks the human for approval via MRTR elicitation.
- **`discover_apis`** — returns generated TypeScript type definitions and the authoring contract for the wrapped server's tools.

**Catalog** — for single actions and large tool surfaces:

- **`search_tools`** — a paged list of the wrapped tools with their approval posture (`runs immediately`, `asks for approval`, `blocked by policy`), optionally matched against a query: any word matches; name hits weigh more.
- **`describe_tool`** — one tool's description, JSON Schemas and annotations, plus its generated types on request (`types: true`).
- **`call_tool`** — runs one tool by name, under exactly the same gate: read-only runs immediately, anything else asks the human first, or is refused outright under a `deny` policy.

Alongside the tools it serves `projection://` resources (generated types, the authoring contract, example machines), a `ui://projection/dashboard.html` MCP App that app-capable hosts render for `execute_machine` results, and, with code mode on, the `/save-workflow` and `/visualize-workflow` prompts.

The server's instructions tell the model which to use: one step → `call_tool`; several steps, branching, or a workflow worth saving → `execute_machine`. Either projection can be turned off (`projections: { catalog: false }`).

Because all suspension state travels in the MRTR `requestState` payload, Projection is fully stateless: any server instance can resume any workflow.

See [docs/server-authors.md](docs/server-authors.md) for the integration guide, [docs/PRD.md](docs/PRD.md) for the full product requirements, and [docs/DECISIONS.md](docs/DECISIONS.md) for engineering decisions.

## Usage

Projection is built on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`)
and serves the 2026-07-28 protocol revision, where MRTR lives.

```ts
import { createMcpHandler } from '@modelcontextprotocol/server';
import { wrapMcpServer } from '@astral-mcp/projection';

const facade = await wrapMcpServer(myMcpServer, {
  blob: { key: myThirtyTwoByteKey }, // shared across instances
  policy: { query: 'ask' }, // override annotations per tool
  redact: (tool, args) => ({ ...args, token: '[redacted]' }),
});

// Serves the five Projection tools, with the routing instructions attached.
export default createMcpHandler(facade.serverFactory);
```

`serverFactory` is the shape the SDK asks for: `createMcpHandler` and
`serveStdio` call it once per request or connection with the negotiated
protocol era, which decides whether a gated call can suspend over MRTR and
carries the routing `instructions`. To build the `McpServer` yourself
(`facade.createServer({ era: 'modern' })`, `facade.registerOn(server, { era })`)
see [docs/server-authors.md](docs/server-authors.md#wrap-and-serve).

A client reaches the MRTR path by opting into the modern era:

```ts
const client = new Client(info, {
  capabilities: { elicitation: {} },
  versionNegotiation: { mode: 'auto' }, // or { pin: '2026-07-28' }
});
```

A legacy (pre-2026-07-28) client still runs read-only machines and calls; the
moment a call needs approval it gets a structured error naming the revision it
needs. Over stdio you can opt in to approvals for those clients with
`compat: { legacyElicitation: true }`
([Legacy clients](docs/server-authors.md#legacy-clients-pre-2026-07-28)).

The wrapped server's tools are never exposed directly. For a single action a model calls `search_tools`, `describe_tool`, then `call_tool({ name, args })` — a write pauses for approval exactly like a machine step, and a declined call comes back as a normal `{ status: "declined" }` result, not an error. For a workflow it calls `discover_apis`, authors a machine, and runs it:

```ts
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

// run with input: { path }
export default setup({}).createMachine({
  id: 'writeOne',
  context: ({ input }) => ({ path: input.path, status: 'pending' }),
  initial: 'writing',
  states: {
    writing: {
      entry: toolCall('write_file', ({ context }) => ({ path: context.path, content: 'hello' })),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: 'written' }) },
        // Denial is an ordinary transition, not an abort.
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'skipped' }) },
        TOOL_ERROR: { target: 'done', actions: assign({ status: 'failed' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status }),
});
```

The `write_file` call suspends the machine, seals its state into an encrypted blob, and asks the user to approve that exact call. The approval authorizes the arguments the user saw — not whatever the resumed machine asks for next.

## Security model

The sandbox has one way out (the tools bridge); no gated call runs without an
approval sealed to its exact name and arguments; blobs are encrypted,
authenticated and bound to the code, kind and tool that issued them, so
clients carry state but can neither read nor alter it. The invariants are
S1–S6 in [docs/PRD.md §9](docs/PRD.md#9-security-invariants); the full
table of how each holds is in the
[package README](packages/projection/README.md#security-model), along with
the known replay-window limitation and the `replayCache` option that closes
it.

## Repository layout

| Path                     | What                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/projection`    | The library (npm: `@astral-mcp/projection`)                                                                                                                                    |
| `packages/harness`       | Scenario test harness + Anthropic-SDK reasoning loop / self-heal benchmark (private)                                                                                           |
| `packages/tui`           | `projection-tui` — interactive Ink demo client (approve/deny with y/n/i) (private)                                                                                             |
| `apps/demo-host`         | MCP Apps demo: a browser host rendering the workflow dashboard over a wrapped filesystem server — `pnpm --filter @astral-mcp/demo-host start`, http://localhost:8787 (private) |
| `docs/server-authors.md` | Integration guide for wrapping your server                                                                                                                                     |
| `docs/PRD.md`            | Product requirements document                                                                                                                                                  |
| `docs/DECISIONS.md`      | Engineering decisions and their rationale                                                                                                                                      |
| `.claude/skills`         | Agent skills: the contribution workflow and the machine-authoring cheat sheet                                                                                                  |

## Try it

The demo TUI wraps an in-memory file server and lets a live model author
machines while you approve each write with a single key. It needs
`ANTHROPIC_API_KEY` (exported, or in a repo-root env file — see
[packages/tui/README.md](packages/tui/README.md)):

```bash
pnpm --filter @astral-mcp/tui start
```

The MCP Apps demo wraps the filesystem reference server and renders the
workflow dashboard in a browser host with approve/deny buttons:

```bash
pnpm --filter @astral-mcp/demo-host start   # then open http://localhost:8787
```

The §10 self-heal benchmark (a model authors machines for scripted tasks and
heals from structured errors) is explicit opt-in so plain test runs never
spend tokens:

```bash
pnpm run build && PROJ_LIVE_BENCH=1 pnpm --filter @astral-mcp/harness exec vitest run test/reasoning.live.test.ts
```

## Development

Requires Node ≥ 22 and pnpm (via corepack).

```bash
pnpm install
pnpm run check   # build + typecheck + lint + test, via turbo
```

Individual tasks: `pnpm run build`, `pnpm run test`, `pnpm run lint`, `pnpm run typecheck`, `pnpm run format`, `pnpm run format:check`.

Toolchain: [Turborepo](https://turborepo.com) task runner · [tsdown](https://tsdown.dev) build · [oxlint](https://oxc.rs) lint · [vitest](https://vitest.dev) tests · strict TypeScript · prettier.

Contributing conventions (small PRs, adversarial review, commit style) live in
[.claude/skills/contributing](.claude/skills/contributing/SKILL.md); the
machine-authoring cheat sheet for writing tests is in
[.claude/skills/authoring-machines](.claude/skills/authoring-machines/SKILL.md).
