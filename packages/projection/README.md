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
five tools in all, never a pass-through to the wrapped server's own:

- **Code mode** — `execute_machine` runs an LLM-authored XState v5 state
  machine in a QuickJS WebAssembly sandbox (read-only calls, or, under
  `destructive-only`, a non-destructive write, run inline; any other write
  suspends the machine into a sealed, encrypted blob and asks the human to
  approve that exact call via MRTR elicitation); `discover_apis` returns
  the generated TypeScript definitions and the authoring contract.
- **Catalog** — `search_tools` lists the wrapped tools with their approval
  posture (a query's top three hits with their arguments), `describe_tool` returns one tool's schemas (and its generated
  types on request, `types: true`), and `call_tool` runs one tool by name
  under the same approval gate. The instructions route the model: one step
  → `call_tool`; a workflow → `execute_machine`. Either projection can be
  disabled (`projections: { codeMode: false }` or `{ catalog: false }`; not
  both).
- **Direct listing** (default `projections.direct: 'auto'`) — when the
  wrapped tools' estimated definitions fit `directBudgetTokens` (8 000),
  each is also listed by name (`<box>__<tool>` on a multi-server facade) as
  a mediated alias of `call_tool` under the same gate, and `search_tools`
  is dropped. `projections: { direct: false }` keeps the five tools.
  Under `'auto'` the surface depends on the catalog's size, so a server near
  the budget can switch surfaces as tools are added upstream. The facade
  reports what the wrap chose: `facade.projections.direct` is `true` when
  tools were listed directly and absent otherwise (on a multi-server facade,
  `true` when any box is listed, and `facade.projections.directBoxes` names
  the boxes listed). Projection logs nothing; to record it yourself on a
  single-server facade:
  `console.error('projection:', facade.projections.direct ? 'direct' : 'search_tools')`
  (multi-server:
  `console.error('projection direct boxes:', facade.projections.directBoxes ?? [])`).
  If your prompts or skills name the search tools, pin the surface with
  `projections: { direct: false }` (or `true` to always list directly).

The catalog, the generated types and the policy are fixed at wrap time.
Projection does not follow the wrapped server's
`notifications/tools/list_changed`: a tool the server adds later is not
listed or searchable, `call_tool` and `toolCall` refuse it as an unknown
tool, and it has no listed alias, until you wrap again and serve the new
facade; a removed tool stays listed, its calls failing upstream. Re-wrapping
an in-process `McpServer` needs a fresh instance or the old facade closed
first (a still-connected server cannot be wrapped). A per-tool `policy` key
applies only to a tool present at wrap; keep keys for tools you expect, and
they take effect on the next wrap. `policyRules` are resolved at wrap time
too, over the same tools: a later tool gets their decision on the next wrap.

Every tool surface uses one posture vocabulary: a tool `runs immediately`
(read-only, `auto` by policy, or, under `destructive-only`, a non-destructive
write), `asks for approval`, or is `blocked by policy`.

`approvals` sets the approvals mode: `'every-write'` (default) asks before
every tool that is not read-only; `'destructive-only'` also runs, without
approval, a tool whose annotations declare `destructiveHint: false` exactly
(a missing or any other hint still asks). A per-tool `policy` override wins
over the mode. The mode extends the trust Projection places in
`readOnlyHint` to `destructiveHint: false`, and a hostile server can
mislabel a damaging tool — enable it only for servers you trust.

Even an honest server's `destructiveHint: false` means _additive_, not
_harmless_: sending email, posting messages, sharing files and sending
invites are typically non-destructive yet reach other people. `policyRules`
pins tools by name pattern or by a function of the tool, resolved once at
wrap time; an exact `policy` entry still wins, and a rule beats the mode:

```ts
approvals: 'destructive-only',
policyRules: [
  { match: '*send*', decision: 'ask' }, // whole name, case-insensitive, * = anything
  (tool) => (tool.name.includes('share') ? 'ask' : undefined),
],
```

To check what the policy resolved to, call `facade.policyOf(name)`: it
returns `{ decision, posture }` (`'auto' | 'ask' | 'deny'` and the posture
string above) for a tool — a qualified `<alias>.<tool>` on a multi-server
facade — or `undefined` for a name the facade does not declare. It decides
from the same frozen wrap-time settings and catalog lookup as the approval
gate, so it cannot disagree with it, and it is integrator-only: nothing a
model sees changes.

`upstreamElicitation: 'forward'` lets a trusted wrapped server ask the user
questions mid-call (a form, or a link to open): each is relayed over MRTR as
`Question from <box> (not an approval)` with the server's words quoted and
its form allowlisted, after the call itself passed the approval gate. The
default, `'refuse'`, fails such a call with a result telling the model the
tool needs the user's input. Per box on `wrapMcpServers`.

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
  // upstreamElicitation: 'forward', // pass the server's own questions on to the user (trusted servers only)
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
`<alias>.<name>` (`fs.write_file`), policy keys are qualified names, each
box has its own `search_<alias>` tool (whose first page shows the server's
guidance), and `search_tools` searches every box (`catalog.globalSearch:
false` turns it off). Code mode works across boxes: the generated types have
one `tools.<alias>` property per box, and machines call
`toolCall('fs.read_file', args)`. Optional sources are not available yet.
See
[Several servers behind one facade](https://github.com/astralMCP/projection/blob/main/docs/server-authors.md#several-servers-behind-one-facade-preview).

### Remote servers by URL (preview)

Any source can be `{ url, oauth?: { clientId, scopes } }`: Projection builds
the Streamable HTTP connection itself, uses and refreshes tokens from a
token store (the OS credential store through the optional
`@napi-rs/keyring` dependency by default, or `WrapOptions.tokenStore`, a
plain string key-value store), and `facade.signOut()` clears them. The
default store is exported as `KeyringTokenStore`, so you can keep your own
credentials in the OS store too; without `@napi-rs/keyring` it falls back
to memory with one warning. Never put
a token in an MCP configuration file. Just-in-time sign-in (asking the user
on first use) is not supported in this version: a public server works, and
so does one whose token is already in your `tokenStore`; otherwise the wrap
fails with an `auth` error. See
[Upstream authentication](https://github.com/astralMCP/projection/blob/main/docs/server-authors.md#upstream-authentication).

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
A forwarded server question's blob keeps the expiry of the approval it
follows. With `upstreamElicitation: 'forward'` on, a `replayCache` is
recommended.
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
