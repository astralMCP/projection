# Projection for server authors

You have an MCP server. `wrapMcpServer` turns it into a Projection server:
clients see five tools (fewer if you turn a projection off) — never your own —
plus `projection://` resources.
**Code mode** (`discover_apis`, `execute_machine`) lets models author XState v5
machines against generated types; the **catalog projection** (`search_tools`,
`describe_tool`, `call_tool`) lets them find and run one tool at a time. Both
run through one gate: read-only calls run inline; everything else pauses for
human approval over MRTR (MCP 2026-07-28). The advertised instructions route
the model — one step → `call_tool`; a workflow → `execute_machine`. With code
mode on, the server also offers two prompts (`/save-workflow`,
`/visualize-workflow`) and a `ui://projection/dashboard.html` MCP App that
app-capable hosts render for `execute_machine` results.

This guide cites requirement numbers from [`docs/PRD.md`](./PRD.md) (R-numbers,
S1–S6 invariants); the reasoning behind the design is in
[`docs/DECISIONS.md`](./DECISIONS.md) (D-numbers).

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
the required revision (legacy clients still run read-only machines and
calls). If you build the `McpServer` yourself, use
`facade.createServer({ era: 'modern' })`
or `facade.registerOn(server, { era })` — but only the factory gets era
negotiation for free, and a hand-built server defaults to `legacy`
(fail-safe). For hosts that are not the SDK at all, the facade's methods
(`executeMachine`, `discoverApis`, `searchTools`, `describeTool`, `callTool`)
are plain functions over plain data — call them from your own handler.

`wrapMcpServer` introspects once, at wrap time: it reads `tools/list`
(the MCP client follows `nextCursor` up to its `listMaxPages` cap, 64 pages
by default; Projection fails with a `protocol` error when pagination does not
end within that cap or the listed total exceeds 2,000 tools — wrap a server
with a bounded tool surface),
`instructions` and the server identity. Tools you add afterwards are not seen
until the next wrap, and duplicate names collapse to one tool.

You can also wrap a **connected SDK `Client`** instead of an in-process
instance — Projection in front of a server you don't own. The smoke tests in
`packages/harness/test/smoke/` wrap the official filesystem, GitHub, and a
community SQLite server exactly this way.

## Annotations drive the policy

Your tool annotations set the default decision per call:

| Annotation                | Decision                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `readOnlyHint: true`      | `auto` — executes inline, no approval                                                |
| anything else / none      | `ask` — the call pauses for human approval (machine step or `call_tool`)             |
| + `destructiveHint: true` | `ask`, with a ⚠ headline and a plain "can permanently change or delete data" warning |

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
  codeModePreamble: '...', // replaces the whole instructions preamble
  // Advertised identity; default { name: 'projection-default', version: '0.1.0' }.
  serverInfo: { name: 'acme-code-mode', version: '2.0.0' },
});
```

Policy is read once, at `wrapMcpServer`; later changes to your object are not
seen. Redeploying with a tool set to `deny` is a safe incident-response move: a
`deny` also wins over approvals already in flight, so a call the user approved
under an earlier policy comes back as `TOOL_DENIED` / `denied_by_policy`.

## What your metadata becomes

Everything the model and the approver see about a tool is derived from your
`tools/list` entry (S5: it is all treated as untrusted text — control and bidi
characters are neutralized and every field is capped wherever it appears):

- **`name`** — the `tools.<name>` member in the generated `.d.ts`, the `name`
  the model passes to `call_tool`, and the `Tool: <id>` footer of every
  approval prompt. When no title exists the id is humanized for the headline
  (namespace prefix dropped, separators to spaces).
- **`annotations.title`** — the approval headline, `Approve: <title>`; also
  matched by `search_tools`.
- **`description`** — its first sentence becomes the `purpose` in
  `search_tools`, the "What the server says it does:" line of the approval
  prompt and the per-tool line of the `discover_apis` overview; the full text
  goes into the `.d.ts` doc comment (after the posture line) and is returned by
  `describe_tool`. It is never rendered verbatim in an approval prompt (R16).
- **`inputSchema` / `outputSchema`** — the TypeScript types in `tools.d.ts`
  and the JSON Schema `describe_tool` returns, passed through a key allowlist
  (R34) and capped at 16 KB per tool; `schemaTruncated: true` tells the model
  when anything was cut. A top-level `method`/`action` property with an `enum`
  also suffixes the headline (`Create or update issue — create`).
- **`readOnlyHint` / `destructiveHint`** — the default posture (table above)
  and the `destructive` flag in `search_tools` / `describe_tool`.
- **`instructions`** — forwarded verbatim ahead of Projection's routing
  preamble (R29); `codeModePreamble` replaces the preamble, not your text.

## Two projections, one gate

Both projections are on by default. Turn one off when it does not fit your
deployment — a chat product may want only single calls, an automation
product only workflows:

```ts
const facade = await wrapMcpServer(myServer, {
  blob: { key: blobKey },
  projections: { codeMode: true, catalog: false }, // disabling both is an error
});
```

`call_tool` is not a pass-through. It validates the name and the shape of
`args` against your schema, applies the same policy as a machine step, and
for an `ask` tool suspends with the same approval prompt — the retry executes
the arguments the human saw, never the retry's own. A declined call is a
normal result (`{ status: "declined" }`), so the model does not retry it; a
`deny` policy comes back as `{ status: "denied_by_policy" }`; a failure from
your tool is an `isError` result with phase `upstream`.

For servers with many tools, `describe_tool` is how the model learns a
schema without paying for the whole catalog up front. With the catalog
projection on, above 40 tools (`catalogInlineThreshold`) `discover_apis`
stops listing tools inline and points at `search_tools` / `describe_tool`;
with it off the list is always inline, whatever the size. The `.d.ts`
resource stays complete either way.

Approval blobs for `call_tool` live 5 minutes by default (`blob.callTtlMs`),
shorter than machine blobs: once approved there is no further step, so a
captured approved retry is a standing capability until it expires (see
"Lifecycle" on replay).

If one of your tools raises its own elicitation mid-call, it is refused:
Projection's introspector client declares no `elicitation` capability, so the
upstream request fails with a named error and the machine receives an ordinary
`TOOL_ERROR` (through `call_tool`, an `upstream` error). Projection never
forwards upstream elicitations (D7). If you pass your own connected `Client`,
its elicitation handlers are yours to govern.

## Legacy clients (pre-2026-07-28)

By default a legacy client can run read-only machines and calls, and any
gated call fails fast naming the required revision (R28). If your deployment
serves a held connection — stdio, the way most local clients run servers —
you can opt in to the SDK's elicitation shim instead:

```ts
const facade = await wrapMcpServer(myServer, {
  blob: { key: blobKey },
  compat: { legacyElicitation: true },
});
```

Approvals then reach the legacy client as old-style server→client
`elicitation/create` requests, and every sealing/verification invariant
runs unchanged. The client must declare the `elicitation` capability;
otherwise gated calls get Projection's structured `protocol` error at
suspend time, while read-only machines and calls still run. This does
nothing for per-request legacy HTTP serving (no server→client
channel; the call fails cleanly), and while the shim round-trips, that one
call is pinned to the serving instance.

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
  TTL (`ttlMs`, 15 minutes for machine blobs; `callTtlMs`, 5 for `call_tool`)
  runs out.
- **Blobs are fenced to the exact library and XState versions** that sealed
  them. After a deploy that changes either, in-flight blobs fail verification
  (`blob_verification`) and the model re-runs; there is no migration (PRD Q3).
- Approval binds what the human saw: the blob carries the approved tool
  name and arguments, and execution happens from the blob — never from
  whatever the resumed machine asks for next (S2). Code is hash-bound (S4),
  so a snapshot cannot resume under different code.

## Resource caps

All optional. Values outside [floor, max] are clamped (`clampCaps`), so a
misconfiguration cannot disable the flow; non-finite values are ignored.

| Cap                      | Floor  | Default | Max    | What it bounds                                      |
| ------------------------ | ------ | ------- | ------ | --------------------------------------------------- |
| `segmentWallClockMs`     | 100 ms | 30 s    | 60 s   | wall clock per execution segment (per round trip)   |
| `wasmMemoryBytes`        | 1 MB   | 128 MB  | 256 MB | sandbox WASM memory                                 |
| `maxCodeBytes`           | 1 KB   | 128 KB  | 256 KB | submitted machine source                            |
| `maxInputBytes`          | 1 KB   | 128 KB  | 256 KB | machine `input` / `call_tool` args, JSON-encoded    |
| `maxReadCallsPerSegment` | 1      | 50      | 200    | auto-run (policy `auto`) tool calls per segment     |
| `maxRoundTrips`          | 1      | 8       | 16     | approval round trips per workflow                   |
| `maxEventsPerSegment`    | 1      | 10 000  | 50 000 | events the host delivers to the machine per segment |
| `maxResultBytes`         | 1 KB   | 256 KB  | 1 MB   | final machine output / `call_tool` output           |
| `maxStateNodes`          | 1      | 100     | 1 000  | state nodes in the machine                          |
| `maxConsoleBytes`        | 1 KB   | 64 KB   | 256 KB | captured console output per segment                 |

Separately, a sealed suspension blob over `blob.maxBlobBytes` (default 128 KB)
fails the suspension with a `terminal` error advising the model to slim its
machine context (R23).

Breaches return structured `cap_exceeded` errors with self-heal hints — the
model can read them and restructure. Exception: a `call_tool` result over
`maxResultBytes` comes back `ok` with `truncated: true`, `outputBytes` and a
1 000-char preview — the call already ran, so an error would read as
'retry'. The other exception is `maxRoundTrips`: a trip-cap breach is phase
`terminal`, by design — the workflow cannot self-heal within the same run,
only be restructured and resubmitted.

## Lifecycle and operations

- `facade.close()` on shutdown. It closes the connection Projection opened
  for an in-process server; a `Client` you passed in stays yours.
- Every failure is a normal `isError` result with a structured body
  (`phase`, `message`, `diagnostics`, `hint`, `logs`; PRD R25 lists the
  phases) — nothing throws across the wire.
- Known limitation (documented in `docs/DECISIONS.md` D4): within its TTL a
  captured approved retry can be replayed. Deployments that need hard replay
  prevention supply a shared replay cache (R38) — an atomic test-and-set on
  the blob nonce, consulted after verification and before any gated
  execution, for both `execute_machine` and `call_tool`:

  ```ts
  const facade = await wrapMcpServer(myServer, {
    blob: { key: blobKey, callTtlMs: 2 * 60_000 },
    replayCache: {
      // expire the entry at exp (Unix ms); resolves true when already
      // recorded — this approval is a replay
      seen: (nonce, exp) => store.setIfAbsent(nonce, { expiresAt: exp }).then((added) => !added),
    },
  });
  ```

  The nonce is recorded on first sight, whatever the verdict, so with a cache
  every approval blob is single-use. No default implementation ships: an
  in-memory one would silently break horizontal scaling.

- Blobs are bound to the wrapped server's identity (`name@version`). Two
  facades that share a blob key over same-identity servers can resume each
  other's blobs — use one key per wrapped server.

## Try it against your server

In a clone of this repository (the harness and TUI are not published), point
the harness at your server for scripted approval scenarios
(`runScenario` with approve/deny/tamper scripts — see
`packages/harness/README.md`), or the TUI for interactive testing:
`pnpm --filter @astral-mcp/tui start` wraps the demo server; swap in your own
via `wrapMcpServer` + the exported `App`/`driveTask` pieces.
