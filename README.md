# McCircuit

Turn any MCP server into a **code-mode** server with **human-approved side effects**, built on MCP MRTR (Multi Round-Trip Requests) and XState v5.

McCircuit wraps an existing MCP server and exposes two tools:

- **`execute_machine`** — runs an LLM-authored XState v5 state machine inside a QuickJS WebAssembly sandbox. Read-only tool calls execute immediately; any write suspends the machine into a sealed, encrypted blob and asks the human for approval via MRTR elicitation.
- **`discover_apis`** — returns generated TypeScript type definitions and the authoring contract for the wrapped server's tools.

Because all suspension state travels in the MRTR `requestState` payload, McCircuit is fully stateless: any server instance can resume any workflow.

See [docs/PRD.md](docs/PRD.md) for the full product requirements.

## Repository layout

| Path                 | What                           |
| -------------------- | ------------------------------ |
| `packages/mccircuit` | The library (npm: `mccircuit`) |
| `docs/PRD.md`        | Product requirements document  |

## Development

Requires Node ≥ 22 and pnpm (via corepack).

```bash
pnpm install
pnpm run check   # build + typecheck + lint + test, via turbo
```

Individual tasks: `pnpm run build`, `pnpm run test`, `pnpm run lint`, `pnpm run typecheck`, `pnpm run format`.

Toolchain: [Turborepo](https://turborepo.com) task runner · [tsdown](https://tsdown.dev) build · [oxlint](https://oxc.rs) lint · [vitest](https://vitest.dev) tests · strict TypeScript · prettier.
