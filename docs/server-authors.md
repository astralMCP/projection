# Projection for server authors

You have an MCP server. `wrapMcpServer` turns it into a Projection server:
clients see five tools (fewer if you turn a projection off) — never your own —
plus `projection://` resources.
**Code mode** (`discover_apis`, `execute_machine`) lets models author XState v5
machines against generated types; the **catalog projection** (`search_tools`,
`describe_tool`, `call_tool`) lets them find and run one tool at a time. Both
run through one gate: read-only calls (or, under `destructive-only`, a
non-destructive write) run inline; everything else pauses for human approval
over MRTR (MCP 2026-07-28). The advertised instructions route
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
are plain functions over plain data — call them from your own handler. Over
HTTP, `createMcpHandler` answers a request body larger than 4 MiB with `413`
before parsing it; pass `createMcpHandler(factory, { maxRequestBodySize })`
if your clients send larger machine sources or tool arguments.

`wrapMcpServer` introspects once, at wrap time: it reads `tools/list`
(Projection follows `nextCursor` page by page itself, whatever the `Client`'s
`listMaxPages` says, and fails with a `protocol` error as soon as the server
has returned more than 2,000 tools, when a 100th page still carries
`nextCursor`, or when a cursor repeats — wrap a server with a bounded tool
surface whose pagination terminates),
`instructions` and the server identity. Tools you add afterwards are not seen
until the next wrap, and duplicate names collapse to one tool.

You can also wrap a **connected SDK `Client`** instead of an in-process
instance — Projection in front of a server you don't own. The smoke tests in
`packages/harness/test/smoke/` wrap the official filesystem, GitHub, and a
community SQLite server exactly this way. If your `Client` connects over
`StreamableHTTPClientTransport`, note that the transport's `redirectPolicy`
now defaults to `'same-origin'`: a remote server that answers with a
cross-origin redirect fails until you pass `redirectPolicy: 'follow'` (or
point the transport at the final URL).

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

  // Skip approval for writes the server declares non-destructive (see
  // "Approvals mode" below; trusted servers only). Default 'every-write'.
  // approvals: 'destructive-only',

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

### Approvals mode

`approvals` (R49) decides what happens to a tool that is not read-only and
has no per-tool override:

| `approvals`               | Non-read-only tool with `destructiveHint: false` | Any other non-read-only tool |
| ------------------------- | ------------------------------------------------ | ---------------------------- |
| `'every-write'` (default) | `ask`                                            | `ask`                        |
| `'destructive-only'`      | `auto` — runs without approval                   | `ask`                        |

Only an explicit `destructiveHint: false` counts: a missing hint, `true`, or
any non-boolean value still asks, matching the MCP default that a
non-read-only tool is destructive. Read-only tools run immediately in either
mode. Precedence, strongest first:

1. your per-tool `policy` override — a per-tool `ask` or `deny` holds under
   `'destructive-only'`, and a per-tool `auto` still runs (a malformed
   override value still fails safe to `ask`);
2. the approvals mode;
3. the annotation default above.

Every surface shows the resolved decision: `search_tools` and
`describe_tool` postures, the `.d.ts` doc comments and the `discover_apis`
overview flags. The mode is read once, at `wrapMcpServer`, like `policy`;
any value other than the two strings fails the wrap with a `validate`
`ProjectionError` before the wrapped server is connected.

**Trust note.** `'destructive-only'` extends the trust Projection already
places in `readOnlyHint: true` to `destructiveHint: false`. Annotations come
from the wrapped server, and a hostile or careless server can label a
damaging tool non-destructive — enable the mode only for servers you trust,
and pin anything you doubt with a per-tool `ask` or `deny`.

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

## Several servers behind one facade (preview)

`wrapMcpServers` fronts several servers at once, each as a **tool box**
under an alias you choose:

```ts
import { wrapMcpServers } from '@astral-mcp/projection';

const facade = await wrapMcpServers(
  {
    fs: filesServer, // an McpServer or a connected Client
    github: { source: githubClient, description: 'Issues and pull requests.' },
  },
  {
    blob: { key: blobKey },
    policy: { 'github.delete_repository': 'deny' }, // keys are qualified names
  },
);
export default createMcpHandler(facade.serverFactory);
```

Every tool is addressed as `<alias>.<name>` — `fs.write_file`,
`github.issue_write` — in search results, `describe_tool`, `call_tool`
results and approval prompts. A server's own dotted tool name stays in its
box: if `fs` declares `github.delete_repo`, it is `fs.github.delete_repo`,
gated by `fs.` policy keys. Aliases match `^[a-z][a-z0-9]{0,23}$` (`default`
and `tools` are reserved); a facade takes 1–16 sources and at most 4,000
tools in total. The total counts every tool each server declares, before
duplicate names inside a box are dropped, so a server that repeats names
cannot slip past the cap: over it, the wrap fails (`protocol`).

The options are required: `blob.key` seals approvals, and
`wrapMcpServers(sources)` without it fails the wrap. Policy keys must be
qualified with a configured alias, and a source configuration accepts only
`source`, `description`, `approvals` (a per-box approvals mode that
overrides the global one) and `optional: false` (`true` is not supported
yet) — any other key, an unknown alias in a policy key, the same server under
two aliases, or an `McpServer` that is already connected to a transport fails
the wrap with a `validate` error before anything connects. A `source` must be
an `McpServer` or a connected `Client`; any other object fails the wrap with
a `validate` error naming the alias. If any source fails to connect or
introspect, the wrap fails and every connection Projection opened is closed;
a `Client` you passed in is yours, and stays open both after a failed wrap
and after `facade.close()`.

Approval prompts name the box by your alias, never by what the server calls
itself: the title reads `Approve (fs): write file` (`⚠ Approve (fs): …` for a
destructive tool), the purpose line `What fs says it does: "…"` — or
`What fs says it does: (no description)` — and the footer
`Tool: fs.write_file`, or `Tool: fs › "github.delete_repo"` for a dotted tool
name, so it never reads as the `github` box's. Your `redact` hook receives
the qualified name (`fs.write_file`), so it can tell two boxes' same-named
tools apart.

Each box is a search tool of its own. The catalog projection lists one
`search_<alias>` per box, in sorted alias order, then `search_tools`,
`describe_tool` and `call_tool` — N + 3 tools for N boxes:

```text
search_fs       Search the fs toolbox. "Read and write files under /srv." (server's words) (3 tools)
search_github   Search the github toolbox. Issues and pull requests. (4 tools)
search_notes    Search the notes toolbox. (1 tool)
search_tools    Search the tools of every toolbox at once, …
describe_tool   …
call_tool       …
```

A `search_<alias>` tool's description is your `description` when you give
one, else the first sentence of the server's `instructions` (its first
line that is neither blank nor a Markdown heading) — neutralized, capped
and quoted, so it reads as the server's words, not yours — else nothing;
then the box's tool count. It searches that box only, with the same query
rules, entries and paging as `search_tools`; its cursors work only with
it. The first page of an empty-query `search_<alias>` leads with the **box
overview**: the server's full `instructions`, neutralized, capped at 8 KB
(with a truncation marker), and indented under
`Guidance from the fs box (the server's own words; it applies to fs tools only):`
and a blank line, so nothing in it can pass for a tool line and, in
Markdown, it is a code block. The same block is served as the resource
`projection://boxes/<alias>/overview.md` for each box whose server sends
readable instructions. Invisible characters (zero-width, tag and other
format characters) are stripped from server text on every box surface.

`search_tools` searches every box: each entry carries its `box`, the header
names the boxes searched, an empty query's first page leads with the
per-box tool counts, and a query word equal to an alias boosts that box's
tools without matching any tool's text, so one server cannot outrank
another for its name. `catalog: { globalSearch: false }` drops it, leaving
the per-box tools; every piece of Projection's copy that names a search
tool — the system prompt, the `describe_tool` / `call_tool` argument
descriptions, the unknown-tool hint — then names the `search_<alias>` tools
instead. The default is on until the multi-server eval settles it.

The facade's instructions — the system prompt — are a short preamble plus
the **shelf**, one line per box in sorted alias order. The servers' own
instructions are not forwarded; each is its box's overview:

```text
This server fronts several toolboxes, each wrapping another server, and offers two ways to use their tools. For a single action, call search_tools to find a tool in any box, … author an XState v5 state machine and run it with execute_machine … each tool's listing says whether it runs immediately or asks for approval.

Toolboxes — tools are named <box>.<tool>; search a box with its search_<box> tool, then pass the full name to describe_tool, call_tool and toolCall:
- fs — "Read and write files under /srv." (server's words) (3 tools)
- github — Issues and pull requests. (4 tools)
- notes (1 tool)
```

`codeModePreamble` replaces the preamble; the shelf, header included, is
always kept, so the qualified-name rule cannot be dropped. Approval blobs
bind the whole alias → server mapping and are keyed separately from
single-server blobs: a blob never resumes on a facade with a different
server set, alias mapping or server version, nor across facade kinds.

Both projections are served, as on a single-server facade, and either can be
turned off (`projections`; both off fails the wrap). In code mode the
generated `tools.d.ts` has one property per box — `tools.fs.read_file`,
`tools.github["create-ticket!"]` — as object types rather than TypeScript
namespaces, so an alias that is a reserved word (`delete`, `class`) still
type-checks. Type names carry the alias (`fs_ReadFileInput`,
`github_WriteFileOutput`), so two boxes' same-named tools never collide.
Machines call tools by qualified name, `toolCall('fs.read_file', args)`, and
Projection routes each call to its box; an unqualified or unknown name fails
validation with a did-you-mean hint listing qualified names (from the named
box only, when the alias is one you configured). One machine may use several
boxes: each gated call is approved on its own, and parallel gated calls to
different boxes share one round trip with one approval prompt each. Audit
entries, sealed `pending` calls and machine blobs carry the qualified names
and use the multi-server key domain, like `call_tool` blobs.

`discover_apis` names the boxes (`Projection code mode over the toolboxes
fs, github.`), lists the tools grouped per box under alias headings, and
links the box overview resources, so a box's guidance is reachable with the
catalog projection off. Above `catalogInlineThreshold`, counted across all
boxes, it prints the per-box counts and points at the search tools the
facade serves instead. The authoring contract adds one rule — tool names are
qualified — and its samples, like the `happy-path` and `denial-fallback`
examples, call tools of the first box in sorted alias order: its first tool
that runs immediately and its first that asks for approval under the
facade's policy (`fs.read_file`, `fs.write_file`), or a generic name marked
"(sample names; use the names in tools.d.ts)" when the box has none.
`describe_tool({ name: 'fs.read_file', types: true })`
returns that tool's slice of the `.d.ts` under `// Member of tools.fs:`, and
the workflow prompts name the boxes, never what the servers call themselves.
The instructions' preamble has a variant per projection selection (routing,
catalog only, code mode only), and the shelf header always states the
qualified-name rule.

Not yet available: `optional: true` sources, and
`introspectTimeoutMs`.

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
| `wasmMemoryBytes`        | 16 MB  | 128 MB  | 256 MB | the sandbox's WebAssembly linear memory             |
| `maxCodeBytes`           | 1 KB   | 128 KB  | 256 KB | submitted machine source                            |
| `maxInputBytes`          | 1 KB   | 128 KB  | 256 KB | machine `input` / `call_tool` args, JSON-encoded    |
| `maxReadCallsPerSegment` | 1      | 50      | 200    | auto-run (policy `auto`) tool calls per segment     |
| `maxRoundTrips`          | 1      | 8       | 16     | approval round trips per workflow                   |
| `maxEventsPerSegment`    | 1      | 10 000  | 50 000 | events the host delivers to the machine per segment |
| `maxResultBytes`         | 1 KB   | 256 KB  | 1 MB   | final machine output / `call_tool` output           |
| `maxStateNodes`          | 1      | 100     | 1 000  | state nodes in the machine                          |
| `maxConsoleBytes`        | 1 KB   | 64 KB   | 256 KB | captured console output per segment                 |

`wasmMemoryBytes` bounds real bytes: every session instantiates its own
QuickJS WASM module with a `WebAssembly.Memory` whose `maximum` is the cap,
so the engine refuses to grow the heap past it and the machine gets an
ordinary `cap_exceeded` error (QuickJS's own memory limit cannot do this
under emscripten, where it counts allocation bookkeeping rather than
payload — DECISIONS D15). The floor is 16 MB because that is the module's
initial heap, which cannot be lowered. The cap is per session, so `N`
segments running at once may hold up to `N × wasmMemoryBytes`; size the cap
for your host with that in mind. Instances whose heap never grew are
pooled and reused by later segments with the same cap, so steady-state
segment start-up costs what it did with one shared runtime; an instance
whose heap grew is discarded when its segment ends, which is how a hoarding
machine's memory is given back.

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

- Blobs are bound to the wrapped server's identity (`name@version`), or on a
  `wrapMcpServers` facade to its alias-to-identity set. Two facades that
  share a blob key over the same identities can resume each other's blobs —
  use one key per facade (per distinct server set).

## Try it against your server

In a clone of this repository (the harness and TUI are not published), point
the harness at your server for scripted approval scenarios
(`runScenario` with approve/deny/tamper scripts — see
`packages/harness/README.md`), or the TUI for interactive testing:
`pnpm --filter @astral-mcp/tui start` wraps the demo server; swap in your own
via `wrapMcpServer` + the exported `App`/`driveTask` pieces.
