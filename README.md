# Projection

Turn any MCP server into a **code-mode** server with **human-approved side effects**, built on MCP MRTR (Multi Round-Trip Requests) and XState v5.

Projection wraps an existing MCP server and exposes two projections of it over one facade — five tools, never the wrapped server's own:

**Code mode** — for workflows:

- **`execute_machine`** — runs an LLM-authored XState v5 state machine inside a QuickJS WebAssembly sandbox. Read-only tool calls execute immediately; any write suspends the machine into a sealed, encrypted blob and asks the human for approval via MRTR elicitation.
- **`discover_apis`** — returns generated TypeScript type definitions and the authoring contract for the wrapped server's tools.

**Catalog** — for single actions and large tool surfaces:

- **`search_tools`** — a paged, filterable list of the wrapped tools with their approval posture.
- **`describe_tool`** — one tool's description, JSON Schemas, annotations and generated types.
- **`call_tool`** — runs one tool by name, under exactly the same gate: read-only runs immediately, anything else asks the human first, or is refused outright under a `deny` policy.

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

`serverFactory` is the shape the SDK asks for, and it is the shape Projection
needs: `createMcpHandler` (and `serveStdio`) call it once per served request
or connection with the negotiated **protocol era**. That is the only place the
era is available, and it decides two things — whether a gated call may suspend
over MRTR or must fail fast (R28), and the `instructions` the server
advertises, which an SDK `Server` accepts only at construction (R29).

Building the `McpServer` yourself works too, as long as you say which era it
serves:

```ts
const server = facade.createServer({ era: 'modern' }); // instructions included
facade.registerOn(myOwnServer, { era: 'modern' }); // or register onto your own
```

A client reaches the MRTR path by opting into the modern era:

```ts
const client = new Client(info, {
  capabilities: { elicitation: {} },
  versionNegotiation: { mode: 'auto' }, // or { pin: '2026-07-28' }
});
```

A client that stays on the 2025 era still runs read-only machines and calls; the
moment a call needs approval it gets a structured error naming the revision it
needs.

The wrapped server's tools are never exposed directly. For a single action a model calls `search_tools`, `describe_tool`, then `call_tool({ name, args })` — a write pauses for approval exactly like a machine step, and a declined call comes back as a normal `{ status: "declined" }` result, not an error. For a workflow it calls `discover_apis`, authors a machine, and runs it:

```ts
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'writeNotes',
  context: { status: 'pending' },
  initial: 'writing',
  states: {
    writing: {
      // '/notes.txt' is the test fixture's path; real machines take paths from `input` (contract rule 9).
      entry: toolCall('write_file', () => ({ path: '/notes.txt', content: 'hello' })),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: 'written' }) },
        // Denial is an ordinary transition, not an abort.
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'skipped' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status }),
});
```

The `write_file` call suspends the machine, seals its state into an encrypted blob, and asks the user to approve that exact call. The approval authorizes the arguments the user saw — not whatever the resumed machine asks for next.

## Security model

| Invariant                                               | How it holds                                                                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| The tools bridge is the only way out of the sandbox     | No `fetch`, no filesystem, no host globals; only `xstate` and `@astral-mcp/tools` resolve as imports                    |
| No gated call runs without a matching approval          | The approved name and arguments are sealed in the blob and executed from there                                          |
| Clients are untrusted couriers                          | Blobs are AES-256-GCM encrypted under a per-blob HKDF-derived key and authenticated                                     |
| A snapshot cannot resume under different code           | The blob binds a SHA-256 hash of the original `code` — for `call_tool`, of the canonical `{ kind, name, args }` request |
| A blob answers only the tool that issued it             | Blobs carry their kind; a `call_tool` blob cannot resume `execute_machine` or vice versa                                |
| A wrapped server's annotations are hints, not authority | Unannotated tools default to asking; developer overrides always win                                                     |
| Approval prompts cannot be forged                       | Prompt text comes from the catalog and redacted arguments, rendered inert                                               |

## Repository layout

| Path                     | What                                                                       |
| ------------------------ | -------------------------------------------------------------------------- |
| `packages/projection`    | The library (npm: `@astral-mcp/projection`)                                |
| `packages/harness`       | Scenario test harness + Anthropic-SDK reasoning loop / self-heal benchmark |
| `packages/tui`           | `projection-tui` — interactive Ink demo client (approve/deny with y/n/i)   |
| `docs/server-authors.md` | Integration guide for wrapping your server                                 |
| `docs/PRD.md`            | Product requirements document                                              |
| `docs/DECISIONS.md`      | Engineering decisions and their rationale                                  |

## Try it

The demo TUI wraps an in-memory file server and lets a live model author
machines while you approve each write with a single key. It needs
`ANTHROPIC_API_KEY` — exported, or in a `.env` at the repo root (loaded
automatically):

```bash
pnpm --filter @astral-mcp/tui start
```

The §10 self-heal benchmark (a model authors machines for scripted tasks and
heals from structured errors) is explicit opt-in so plain test runs never
spend tokens:

```bash
PROJ_LIVE_BENCH=1 pnpm --filter @astral-mcp/harness exec vitest run test/reasoning.live.test.ts
```

## Development

Requires Node ≥ 22 and pnpm (via corepack).

```bash
pnpm install
pnpm run check   # build + typecheck + lint + test, via turbo
```

Individual tasks: `pnpm run build`, `pnpm run test`, `pnpm run lint`, `pnpm run typecheck`, `pnpm run format`.

Toolchain: [Turborepo](https://turborepo.com) task runner · [tsdown](https://tsdown.dev) build · [oxlint](https://oxc.rs) lint · [vitest](https://vitest.dev) tests · strict TypeScript · prettier.

Contributing conventions (small PRs, adversarial review, commit style) live in
[.claude/skills/contributing](.claude/skills/contributing/SKILL.md); the
machine-authoring cheat sheet for writing tests is in
[.claude/skills/authoring-machines](.claude/skills/authoring-machines/SKILL.md).
