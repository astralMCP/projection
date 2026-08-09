# Projection for server authors

You have an MCP server. `wrapMcpServer` turns it into a code-mode server:
clients see exactly two tools — `discover_apis` and `execute_machine` — plus
`projection://` resources. Models author XState v5 machines against generated
types; read-only calls run inline; everything else pauses for human approval
over MRTR (MCP 2026-07-28).

## Wrap and serve

```ts
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { wrapMcpServer } from '@astral-mcp/projection';

// Your existing server, built normally with registerTool(...).
// Pass it UNCONNECTED — Projection owns its transport from here on.
const myServer = new McpServer({ name: 'acme-files', version: '1.0.0' });

const facade = await wrapMcpServer(myServer, {
  blob: { key: blobKey }, // 32 bytes, shared across instances — see below
});

export default createMcpHandler(facade.serverFactory); // HTTP
// or: serveStdio(facade.serverFactory) — from '@modelcontextprotocol/server/stdio'
```

`serverFactory` is the load-bearing line: the SDK calls it per serving unit
(per request over HTTP, per connection over stdio) with the negotiated
**protocol era**, which decides whether a gated call may
suspend over MRTR (modern clients) or must fail fast with an error naming
the required revision (legacy clients still run read-only machines). If you
build the `McpServer` yourself, use `facade.createServer({ era: 'modern' })`
or `facade.registerOn(server, { era })` — but only the factory gets era
negotiation for free, and a hand-built server defaults to `legacy`
(fail-safe).

You can also wrap a **connected SDK `Client`** instead of an in-process
instance — Projection in front of a server you don't own. The smoke tests in
`packages/harness/test/smoke/` wrap the official filesystem, GitHub, and a
community SQLite server exactly this way.

## Annotations drive the policy

Your tool annotations set the default decision per call:

| Annotation                | Decision                                    |
| ------------------------- | ------------------------------------------- |
| `readOnlyHint: true`      | `auto` — executes inline, no approval       |
| anything else / none      | `ask` — machine suspends for human approval |
| + `destructiveHint: true` | `ask`, with strong DESTRUCTIVE warning copy |

Annotate honestly and the defaults do the right thing. Unannotated tools
always ask — annotations are hints, never authority (S5).

Overrides beat annotations in every combination:

```ts
const facade = await wrapMcpServer(myServer, {
  blob: { key: blobKey, previousKeys: [oldKey], ttlMs: 15 * 60_000 },

  policy: {
    query: 'ask', // never trust readOnlyHint on opaque SQL
    drop_table: 'deny', // blocked outright, no prompt, no approval possible
    get_status: 'auto', // you vouch for this one despite missing annotations
  },

  // Mask sensitive argument fields before they reach an approval prompt.
  // Fails closed: if this throws, the prompt shows a placeholder, never args.
  redact: (tool, args) => (tool === 'send_email' ? { ...args, body: '[hidden]' } : args),

  caps: { maxRoundTrips: 4 }, // see "Resource caps" below
  codeModePreamble: '...', // replaces the code-mode instructions text
  serverInfo: { name: 'acme-code-mode', version: '2.0.0' }, // advertised identity
});
```

## The blob key — your one piece of state

Every suspension seals the machine snapshot, the pending approvals, the
audit trail, and the round-trip counter into an AES-256-GCM encrypted blob
that travels to the client and back (`requestState`). The server keeps
nothing between round trips, so:

- **Any instance resumes any workflow.** Run behind any load balancer, no
  session affinity, no shared store.
- **The key must be the same 32 bytes on every instance** (env var / secret
  manager). Rotate by issuing a new `key` and listing the old one in
  `previousKeys`; blobs sealed under the old key keep opening until their
  TTL (`ttlMs`, default 15 minutes) runs out.
- Approval binds what the human saw: the blob carries the approved tool
  name and arguments, and execution happens from the blob — never from
  whatever the resumed machine asks for next (S2). Code is hash-bound (S4),
  so a snapshot cannot resume under different code.

## Resource caps

All optional, clamped to sane floors/ceilings (`clampCaps`):

| Cap                      | Default | What it bounds                    |
| ------------------------ | ------- | --------------------------------- |
| `maxCodeBytes`           | 128 KB  | submitted machine source          |
| `maxInputBytes`          | 128 KB  | machine `input`, JSON-encoded     |
| `maxReadCallsPerSegment` | 50      | inline read calls per segment     |
| `maxRoundTrips`          | 8       | approval round trips per workflow |
| `maxResultBytes`         | 256 KB  | final machine output              |
| `maxStateNodes`          | 100     | state nodes in the machine        |

Breaches return structured `cap_exceeded` errors with self-heal hints — the
model can read them and restructure. The exception is `maxRoundTrips`: a
trip-cap breach is phase `terminal`, by design — the workflow cannot
self-heal within the same run, only be restructured and resubmitted.

## Lifecycle and operations

- `facade.close()` on shutdown. It closes the connection Projection opened
  for an in-process server; a `Client` you passed in stays yours.
- Every failure is a normal `isError` result with a structured body
  (`phase`, `message`, `hint`, `logs`) — nothing throws across the wire.
- Known limitation (documented in `docs/DECISIONS.md` D4): within its TTL a
  captured approved retry can be replayed; deployments needing hard replay
  prevention across instances can key a replay cache on the blob nonce.

## Try it against your server

Point the harness at your server for scripted approval scenarios
(`runScenario` with approve/deny/tamper scripts — see
`packages/harness/README.md`), or the TUI for interactive testing:
`pnpm --filter @astral-mcp/tui start` wraps the demo server; swap in your own
via `wrapMcpServer` + the exported `App`/`driveTask` pieces.
