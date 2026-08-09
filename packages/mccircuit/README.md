# mccircuit

Turn any MCP server into a **code-mode** server with **human-approved side
effects**, built on MCP MRTR (Multi Round-Trip Requests, revision
2026-07-28) and XState v5.

McCircuit wraps an existing MCP server and exposes exactly two tools:

- **`execute_machine`** — runs an LLM-authored XState v5 state machine in a
  QuickJS WebAssembly sandbox. Read-only tool calls execute immediately;
  any write suspends the machine into a sealed, encrypted blob and asks the
  human to approve that exact call via MRTR elicitation.
- **`discover_apis`** — returns generated TypeScript definitions and the
  authoring contract for the wrapped server's tools.

All suspension state rides the MRTR `requestState` payload, so McCircuit is
fully stateless: any server instance can resume any workflow.

## Usage

```ts
import { createMcpHandler } from '@modelcontextprotocol/server';
import { wrapMcpServer } from 'mccircuit';

const facade = await wrapMcpServer(myMcpServer, {
  blob: { key: myThirtyTwoByteKey }, // shared across instances
  policy: { query: 'ask' }, // override annotations per tool
  redact: (tool, args) => ({ ...args, token: '[redacted]' }),
});

export default createMcpHandler(facade.serverFactory);
```

`serverFactory` carries the negotiated protocol era into each serving unit:
modern (2026-07-28) clients get MRTR approval round trips; legacy clients
still run read-only machines and get a structured error the moment a
machine needs approval. You can also wrap a connected SDK `Client` to put
McCircuit in front of a server you don't own.

## Security model

| Invariant                                               | How it holds                                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| The tools bridge is the only way out of the sandbox     | No `fetch`, no filesystem, no host globals; only `xstate` and `@mccircuit/tools` resolve as imports |
| No gated call runs without a matching approval          | The approved name and arguments are sealed in the blob and executed from there                      |
| Clients are untrusted couriers                          | Blobs are AES-256-GCM encrypted under a per-blob HKDF-derived key and authenticated                 |
| A snapshot cannot resume under different code           | The blob binds a SHA-256 hash of the original `code`                                                |
| A wrapped server's annotations are hints, not authority | Unannotated tools default to asking; developer overrides always win                                 |
| Approval prompts cannot be forged                       | Prompt text comes from the catalog and redacted arguments, rendered inert                           |

## Documentation

- [Server-author integration guide](https://github.com/mccircuit/McCircuit/blob/main/docs/server-authors.md)
  — policy, blob-key operations, resource caps, lifecycle
- [Product requirements](https://github.com/mccircuit/McCircuit/blob/main/docs/PRD.md)
  and [engineering decisions](https://github.com/mccircuit/McCircuit/blob/main/docs/DECISIONS.md)
- [Repository](https://github.com/mccircuit/McCircuit) — scenario test
  harness, self-heal benchmark, and an interactive demo TUI live alongside
  the library

Requires Node ≥ 22. MIT licensed.
