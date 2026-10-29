# @astral-mcp/projection

Wrap any MCP server in **code mode** (LLM-authored XState workflows) and a
**tool catalog** (search, describe, call), with **human-approved side
effects** over MCP MRTR (Multi Round-Trip Requests).

```bash
npm install @astral-mcp/projection @modelcontextprotocol/server@2.0.0
```

Add `@modelcontextprotocol/client@2.0.0` when wrapping a connected `Client`.
Both SDK packages are pinned at `2.0.0` in Projection's own dependencies, so
install the same version to match the pin.

Projection wraps an existing MCP server and exposes two projections of it —
five tools in all, never the wrapped server's own:

- **Code mode** — `execute_machine` runs an LLM-authored XState v5 state
  machine in a QuickJS WebAssembly sandbox (read-only calls run inline; any
  write suspends the machine into a sealed, encrypted blob and asks the human
  to approve that exact call via MRTR elicitation); `discover_apis` returns
  the generated TypeScript definitions and the authoring contract.
- **Catalog** — `search_tools` lists the wrapped tools with their approval
  posture, `describe_tool` returns one tool's schemas (and its generated
  types on request, `types: true`), and `call_tool` runs one tool by name
  under the same approval gate. The instructions route the model: one step
  → `call_tool`; a workflow → `execute_machine`. Either projection can be
  disabled (`projections: { codeMode: false }` or `{ catalog: false }`; not
  both).

Every tool surface uses one posture vocabulary: a tool `runs immediately`
(read-only, or `auto` by policy), `asks for approval`, or is `blocked by
policy`.

`approvals` sets the approvals mode: `'every-write'` (default) asks before
every tool that is not read-only; `'destructive-only'` also runs, without
approval, a tool whose annotations declare `destructiveHint: false` exactly
(a missing or any other hint still asks). A per-tool `policy` override wins
over the mode. The mode extends the trust Projection places in
`readOnlyHint` to `destructiveHint: false`, and a hostile server can
mislabel a damaging tool — enable it only for servers you trust.

All suspension state rides the MRTR `requestState` payload, so Projection is
fully stateless: any server instance can resume any workflow.

## Usage

```ts
import { createMcpHandler } from '@modelcontextprotocol/server';
import { wrapMcpServer } from '@astral-mcp/projection';

const facade = await wrapMcpServer(myMcpServer, {
  blob: { key: myThirtyTwoByteKey }, // shared across instances
  policy: { query: 'ask' }, // override annotations per tool
  // approvals: 'destructive-only', // skip approval for destructiveHint: false writes (trusted servers only)
  redact: (tool, args) => ({ ...args, token: '[redacted]' }),
});

export default createMcpHandler(facade.serverFactory);
```

`serverFactory` carries the negotiated protocol era into each serving unit:
modern (2026-07-28) clients get MRTR approval round trips; legacy clients
still run read-only machines and calls, and get a structured error the
moment a call needs approval. You can also wrap a connected SDK `Client` to put
Projection in front of a server you don't own.

### Several servers (preview)

`wrapMcpServers({ fs: filesServer, github: { source: githubClient } }, options)`
fronts several servers as tool boxes: tools are addressed as
`<alias>.<name>` (`fs.write_file`), policy keys are qualified names, and
`search_tools` searches every box. This preview serves the catalog
projection only; code mode, per-box search tools and optional sources are
not available yet. See `docs/server-authors.md`.

## Security model

| Invariant                                               | How it holds                                                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| The tools bridge is the only way out of the sandbox     | No `fetch`, no filesystem, no host globals; only `xstate` and `@astral-mcp/tools` are meant for authored code; nothing that performs I/O resolves |
| No gated call runs without a matching approval          | The approved name and arguments are sealed in the blob and executed from there                                                                    |
| Clients carry state but can neither read nor alter it   | Blobs are AES-256-GCM encrypted under a per-blob HKDF-derived key and authenticated                                                               |
| A snapshot cannot resume under different code           | The blob binds a SHA-256 hash of the original `code` — for `call_tool`, of the canonical `{ kind, name, args }` request                           |
| A blob answers only the tool that issued it             | Blobs carry their kind; a `call_tool` blob cannot resume `execute_machine` or vice versa                                                          |
| A wrapped server's annotations are hints, not authority | Unannotated tools default to asking; developer overrides always win                                                                               |
| Approval prompts cannot be forged                       | Prompt text comes from the catalog and redacted arguments, rendered inert                                                                         |

Known limitation: unless you supply a shared `replayCache` (R38), an approved
retry can be replayed until its blob expires (by default 5 min for
`call_tool`, 15 for machines; `blob.callTtlMs` and `blob.ttlMs` override).
See
[Lifecycle](https://github.com/astralMCP/projection/blob/main/docs/server-authors.md#lifecycle-and-operations).

## Documentation

- [Server-author integration guide](https://github.com/astralMCP/projection/blob/main/docs/server-authors.md)
  — policy, blob-key operations, resource caps, lifecycle
- [Product requirements](https://github.com/astralMCP/projection/blob/main/docs/PRD.md)
  and [engineering decisions](https://github.com/astralMCP/projection/blob/main/docs/DECISIONS.md)
- [Repository](https://github.com/astralMCP/projection) — scenario test
  harness, self-heal benchmark, an interactive demo TUI, and an MCP Apps
  demo host live alongside the library

Requires Node ≥ 22. MIT licensed.
