# McCircuit

Turn any MCP server into a **code-mode** server with **human-approved side effects**, built on MCP MRTR (Multi Round-Trip Requests) and XState v5.

McCircuit wraps an existing MCP server and exposes two tools:

- **`execute_machine`** — runs an LLM-authored XState v5 state machine inside a QuickJS WebAssembly sandbox. Read-only tool calls execute immediately; any write suspends the machine into a sealed, encrypted blob and asks the human for approval via MRTR elicitation.
- **`discover_apis`** — returns generated TypeScript type definitions and the authoring contract for the wrapped server's tools.

Because all suspension state travels in the MRTR `requestState` payload, McCircuit is fully stateless: any server instance can resume any workflow.

See [docs/PRD.md](docs/PRD.md) for the full product requirements and [docs/DECISIONS.md](docs/DECISIONS.md) for engineering decisions.

## Usage

```ts
import { wrapMcpServer } from 'mccircuit';

const facade = await wrapMcpServer(myMcpServer, {
  blob: { key: myThirtyTwoByteKey }, // shared across instances
  policy: { query: 'ask' }, // override annotations per tool
  redact: (tool, args) => ({ ...args, token: '[redacted]' }),
});

facade.registerOn(codeModeServer); // exposes exactly the two tools
```

The wrapped server's tools are never exposed directly. A model calls `discover_apis`, authors a machine, and runs it:

```ts
import { setup, assign } from 'xstate';
import { toolCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'writeNotes',
  context: { status: 'pending' },
  initial: 'writing',
  states: {
    writing: {
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

| Invariant                                               | How it holds                                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| The tools bridge is the only way out of the sandbox     | No `fetch`, no filesystem, no host globals; only `xstate` and `@mccircuit/tools` resolve as imports |
| No gated call runs without a matching approval          | The approved name and arguments are sealed in the blob and executed from there                      |
| Clients are untrusted couriers                          | Blobs are AES-256-GCM encrypted under a per-blob HKDF-derived key and authenticated                 |
| A snapshot cannot resume under different code           | The blob binds a SHA-256 hash of the original `code`                                                |
| A wrapped server's annotations are hints, not authority | Unannotated tools default to asking; developer overrides always win                                 |
| Approval prompts cannot be forged                       | Prompt text comes from the catalog and redacted arguments, rendered inert                           |

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
