# Projection for server authors

You have an MCP server. `wrapMcpServer` turns it into a Projection server:
clients see Projection's tools — plus, when your catalog is small, each of
your tools listed by name as a mediated alias of `call_tool` (never a
pass-through; see below) — and `projection://` resources.
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

Projection does not handle `notifications/tools/list_changed` from the
wrapped server, on single- and multi-server facades alike. The catalog, the
generated types and resources, the instructions, the direct-listing choice
(below) and the frozen policy snapshot are all built once, at wrap time,
from what introspection read, and the notification refreshes none of them.
Projection does not send `tools/list_changed` to its own clients either. So:

- A tool the server adds or enables later (an app switched on
  mid-conversation, say) is not listed or searchable and is absent from the
  types. `call_tool` and a machine's `toolCall` refuse it as an unknown tool;
  it has no listed alias (calling its name on the facade is a protocol
  not-found error). None of these reach your server.
- A tool the server removes stays listed; calling it reaches your server,
  which fails the call (an `upstream` error).
- `policy` keys are exact tool names, matched against the wrap-time
  catalog. A key for a tool that is not there yet is accepted and does
  nothing; it takes effect on the next wrap, once the tool exists. Keep
  such keys in your options rather than adding them later. `policyRules`
  (see "Policy rules" below) are resolved at wrap time too, over the same
  catalog: a tool that appears later is unknown to the facade (above), so
  no rule reaches it until the next wrap, when the rules apply to it like
  any other tool.

To pick up a changed tool list, wrap again (`wrapMcpServer` /
`wrapMcpServers`) and serve the new facade's `serverFactory`. For a
connected `Client` or a source given by URL, wrap first and close the old
facade once its in-flight requests finish. An in-process `McpServer` can
back only one facade at a time — the old facade holds its transport until
`facade.close()`, and wrapping a still-connected instance throws — so
either wrap a fresh instance, or close the old facade first (its in-flight
requests then fail).

Blobs bind the blob key (or one of its `previousKeys`) and the server
identity, not the tool list. The identity is the server's reported
`name@version`; for a source given by URL, its canonical `url:`; on a
multi-server facade, every box's alias and identity (so adding, removing or
skipping a box, or any box's version change, also stops a pending approval
resuming). A pending `call_tool` approval resumes on the new facade when key
and identity are unchanged, and is checked against the new facade's catalog
and policy (a tool now gone or denied is refused). To void outstanding
approvals across a re-wrap, rotate the blob key (without the old one in
`previousKeys`). If you use a `replayCache`, pass the same instance (or
shared store) to the new wrap, so a retry already spent on the old facade
stays spent.

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

  // Put a machine step's several gated calls to the person as ONE prompt
  // (see "Batched approval prompts" below). Default 'per-call'.
  // approvalPrompts: 'batched',

  caps: { maxRoundTrips: 4 }, // see "Resource caps" below
  codeModePreamble: '...', // replaces the whole instructions preamble
  // Bound on connecting to the server and reading its tools at wrap time;
  // past it the wrap fails with a 'protocol' error. Default 30 000 ms.
  introspectTimeoutMs: 30_000,
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
2. your `policyRules` (see "Policy rules" below), first match wins;
3. the approvals mode;
4. the annotation default above.

Every surface shows the resolved decision: `search_tools` and
`describe_tool` postures, the `.d.ts` doc comments and the `discover_apis`
overview flags. The mode is read once, at `wrapMcpServer`, like `policy`;
any value other than the two strings fails the wrap with a `validate`
`ProjectionError` before the wrapped server is connected.

To verify what the mode and your overrides resolved to without parsing
`search_tools` text, ask the facade:

```ts
for (const tool of facade.catalog.tools) {
  const { decision, posture } = facade.policyOf(tool.name)!;
  // decision: 'auto' | 'ask' | 'deny'; posture: 'runs immediately' | …
}
facade.policyOf('no_such_tool'); // undefined

// wrapMcpServers: catalog.servers maps each alias to its box's catalog.
for (const [alias, box] of multi.catalog.servers) {
  for (const tool of box.tools) multi.policyOf(`${alias}.${tool.name}`);
}
```

`policyOf(name)` reflects your `policyRules` too: they are resolved into the
same snapshot at wrap time and never re-run. It decides from the same frozen
wrap-time settings, through the same catalog lookup, as the approval gate behind `call_tool` and
`execute_machine`, so its answer is what the gate does and the posture
`search_tools` and `describe_tool` show. A name the facade does not declare
returns `undefined` rather than throwing, so it is safe in a loop over your
own list of names. On `wrapMcpServers` it takes the qualified name
(`facade.policyOf('fs.write_file')`), and per-source modes apply; bare names
and direct-listing aliases (`fs__write_file`) are `undefined`. `name` is
always the server's catalog name, never a name read from `tools/list`: under
direct listing a tool whose name is not a legal tool name is listed under a
cleaned-up or hash-suffixed name, which can equal another tool's catalog name
(`drop db` listed as `drop_db`), so take names from `facade.catalog`. It is
for you, the integrator: no tool result, description or generated type
carries it.

**Trust note.** `'destructive-only'` extends the trust Projection already
places in `readOnlyHint: true` to `destructiveHint: false`. Annotations come
from the wrapped server, and a hostile or careless server can label a
damaging tool non-destructive — enable the mode only for servers you trust,
and pin anything you doubt with a per-tool `ask` or `deny`.

Trusting a server is not the same as it being safe to skip approvals.
`destructiveHint: false` means _additive_ — the tool creates or appends
rather than overwrites or deletes — not _harmless_. Sending an email,
posting or replying in a chat, sharing a file and creating a calendar
event that sends invites are all typically annotated non-destructive, yet
each reaches other people and cannot be taken back. MCP has no annotation
for "notifies or reaches other people" (`openWorldHint` is true on almost
every tool of a SaaS server), so an honest server cannot tell you. Under
`'destructive-only'`, pin those tools to `ask` yourself, by name pattern:

```ts
const facade = await wrapMcpServer(pipedream, {
  blob: { key: blobKey },
  approvals: 'destructive-only',
  policyRules: [
    { match: '*send*', decision: 'ask' },
    { match: '*post*', decision: 'ask' },
    { match: '*reply*', decision: 'ask' },
    { match: '*share*', decision: 'ask' },
    { match: '*invite*', decision: 'ask' },
    { match: 'google_calendar-*', decision: 'ask' },
  ],
});
```

### Policy rules

`policyRules` decides many tools at once where `policy` names one. Each rule
is either a name pattern or a function of the tool's catalog entry:

```ts
policyRules: [
  { match: '*send*', decision: 'ask' },
  { match: '*delete*', decision: 'deny' },
  (tool) => (tool.description?.includes('notif') ? 'ask' : undefined),
],
```

- A **pattern** matches the whole tool name, case-insensitively; `*` stands
  for any run of characters (none included) and every other character is
  literal. There is no escape: a `*` in a pattern also matches a `*` in a
  name, so to pin one tool whose name contains `*`, use its exact `policy`
  entry.
- A **function** gets a copy of the tool's catalog entry (name,
  description, input schema, annotations) and returns `'auto'`, `'ask'`,
  `'deny'`, or `undefined` for no opinion. It must be synchronous and
  deterministic — every instance of a horizontally scaled deployment must
  decide alike (R27). The entry comes from the wrapped server and may be
  hostile: base `'auto'` only on facts you trust, such as a tool name you
  vouch for; basing `'ask'` or `'deny'` on the description, annotations or
  schema is fine.
- Rules are tried in order and the **first with an opinion** decides the
  tool. An exact `policy` entry beats every rule; a rule beats the approvals
  mode and the annotations.
- Rules are resolved **once, at wrap time**, over the server's tools, into
  per-tool decisions frozen with the rest of the policy (the rules
  themselves are copied when the wrap starts, so later edits are not seen): every surface shows
  the decision the gate enforces, and no rule runs per request.
- **Fail-safe.** A decision other than the three strings — from a function
  or a pattern — means `ask`, never `auto`. A pattern that matches always
  has an opinion, so one with a missing `decision` (a typo such as
  `decison`) also means `ask` on the tools it matches. A function that throws, or
  returns a promise, fails the wrap with a `validate` `ProjectionError`; so
  does a `policyRules` value that is not an array of rules.
- On `wrapMcpServers` a rule sees qualified names (`gmail.send_email`), so
  `'*send*'` spans every box and `'gmail.*'` targets one.

### What the person and the model see around an approval

- **Before asking.** A gated call whose arguments cannot fit the tool's
  input schema (a required argument missing, a top-level value of the wrong
  type, an argument the schema forbids) is never put to the person:
  `call_tool` returns a `validate` error, and a machine step gets a
  `TOOL_ERROR` naming the argument, without a prompt.
- **After a decline.** `call_tool` tells the model the refusal covers only
  that call; not to make it again or reach its result another way (unless
  the person's note asks for a change, which it then makes as a new call
  that asks again); to carry on with the parts of the task that do not
  depend on it; and to say in its answer what was not done. A machine's
  completed result restates every refused call after its output, with the
  same guidance, so a machine that ignores `TOOL_DENIED` cannot hide a
  refusal; a failed one also lists the approved calls that already ran.

### Batched approval prompts

When one machine step requests several gated calls at once (parallel
regions, or several `toolCall`s in one action), the default
`approvalPrompts: 'per-call'` sends one elicitation per call in a single
round trip, and most hosts show one prompt per call.
`approvalPrompts: 'batched'` sends one elicitation instead: a header, then
each call's usual approval copy under `[1]`, `[2]`, … and a form with one
unticked boolean per call (`approve_1`, …) plus the optional `reason`.
The fields have no default, so a client that applies form defaults to an
empty accept approves nothing.

What runs does not change. Each call is still sealed on its own in the
blob, and runs only if its own boolean comes back exactly `true` in an
accepted answer; a declined, cancelled or missing answer, or one without
the booleans, declines every call in it. The layout is sealed in the blob
when the prompt is minted, so a resume is always read the way the prompt
was asked, whichever setting the resuming instance has. A batch holds at
most 10 calls and 20 000 characters; past either, the step falls back to
per-call prompts. `call_tool` and a step with one gated call keep the
per-call prompt. Machine `toolCall` ids may not start with `projection:`
(that namespace holds the batched answer's key). Enable it when your
clients render boolean form fields; any other value fails the wrap.

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

What your tool returns reaches the client through `call_tool` as follows.
`structuredContent` becomes `output`; a single text block becomes `output` as
a string (a machine receives it parsed when it is JSON for an object or an
array, with the text on `event.text`). In the text the model reads, a
top-level string field of three or more lines (a file's contents, say) is
printed as its own indented lines below the JSON rather than as an escaped
one-liner; `output` keeps it as it is. Any other content array is rendered block by block in the text —
text as text, an embedded text resource under its URI — and image, audio and
embedded binary resources are attached as native content blocks after it, so
base64 never lands in the model's text. A `resource_link` is described, not
attached: the facade does not serve your resources. `structuredContent.output`
always carries the array verbatim. When the client asks for progress on a
`call_tool`, your `notifications/progress` reports are relayed under the
client's token, the message prefixed with the tool name (`<alias>.<tool>` on a
multi-server facade), neutralized and capped at 200 characters; cancelling the
`call_tool` cancels your call. Machine steps relay neither yet, and log
messages, resources, prompts and completions of the wrapped server are not
projected.

A successful result can also carry short notes from the facade (PRD R35.6):
when your result has one array and a `total`/`count`-style field larger than
it, when the array is exactly as long as the page-size argument (`limit`,
`per_page`, … — sent, or your schema's `default`), and when you put a short
remark beside `structuredContent` in a text block ("40 matches, returning
10"). The model reads them above the result, and a machine gets them on
`TOOL_RESULT.notes`. To be read right, report totals as numbers next to the
array, declare page-size defaults in the schema (scalar defaults are shown,
R34), and keep the JSON mirror of `structuredContent` and any remark in
separate text blocks.

For servers with many tools, `describe_tool` is how the model learns a
schema without paying for the whole catalog up front. With the catalog
projection on, above 40 tools (`catalogInlineThreshold`) `discover_apis`
stops listing tools inline and points at `search_tools` / `describe_tool`;
with it off the list is always inline, whatever the size. The `.d.ts`
resource stays complete either way.

Small catalogs are also listed directly (the default, `projections.direct:
'auto'`; D28): Projection registers one tool per wrapped tool —
`<box>__<tool>` on a multi-server facade, the tool's own name otherwise —
when their estimated definitions fit `directBudgetTokens` (default 8 000),
and falls back to the search tools when they do not. Each listed tool is a
thin alias of `call_tool({ name, args })`: same validation, policy, approval
prompt and sealed blob, forwarded server questions (below), decline copy,
progress and cancellation, its description led by its posture
(`[asks for approval]`) and the server's own text indented beneath. In this
mode the search tools are dropped, except a box's `search_<box>` when its
server sends guidance; `describe_tool`, `call_tool` and code mode stay.
On a multi-server facade the budget is filled box by box, smallest box
first; the boxes that do not fit keep their `search_<box>`. Direct listing
is part of the catalog projection: with `catalog: false` it stays off.
`direct: true` lists them whatever the size; `direct: false` never does,
leaving the five tools (`search_tools`, `describe_tool`, `call_tool`,
`discover_apis`, `execute_machine`).

Under `'auto'` the tool surface depends on the catalog's size: a server near
`directBudgetTokens` switches between listing its tools and serving
`search_tools` as tools are added upstream (on the next wrap; see above).
The choice is made once, at wrap time, and the facade reports it on its
frozen `facade.projections`: `direct` is `true` when tools are listed
directly and absent otherwise, and on a multi-server facade `directBoxes`
names the boxes listed (in sorted alias order; any other box keeps its
`search_<box>`, and `search_tools` stays under `catalog.globalSearch`
while any box is unlisted). There `direct` is `true` when any box is
listed. Projection writes nothing to stdout or stderr about it, so log it
yourself if you want it on record — on a single-server facade:

```ts
console.error('projection surface:', facade.projections.direct ? 'direct' : 'search_tools');
```

and on a multi-server facade:

```ts
console.error('projection direct boxes:', facade.projections.directBoxes ?? []);
```

If your system prompt or skills name `search_tools` (or a listed tool's
name), pin the surface rather than relying on the budget:
`projections: { direct: false }` always serves the search tools
(`search_tools` on a single-server facade; on a multi-server one, each
`search_<box>`, plus `search_tools` unless `catalog.globalSearch` is
`false`), `projections: { direct: true }` always lists directly.

A listed tool advertises Projection's own annotations, never your server's:
`readOnlyHint: true` only when Projection runs the call without asking and
your tool is read-only (never under an `ask` or `deny` override), and
`destructiveHint: true` when your tool says so. A host that auto-runs
read-only tools therefore skips its prompt only where Projection would too.

Approval blobs for `call_tool` live 5 minutes by default (`blob.callTtlMs`),
shorter than machine blobs: once approved there is no further step, so a
captured approved retry is a standing capability until it expires (see
"Lifecycle" on replay). A forwarded question's blob keeps the expiry of the
approval it follows; it is never given a fresh 5 minutes.

### Your tools asking the user something

Projection speaks MCP 2026-07-28 to the servers it wraps: an in-process
`McpServer` always, a server given by URL when it supports that revision
(otherwise the 2025 handshake, as before). A tool can then ask its user a
question mid-call by returning `inputRequired(...)`: a form, or a link to
open (URL mode).

By default (`upstreamElicitation: 'refuse'`) Projection declares no
`elicitation` capability to your server, so a tool that asks fails: the
machine gets a `TOOL_ERROR`, and `call_tool` an `upstream` error whose hint
tells the model the arguments were fine and the tool needs the user's input.
Sampling and roots requests are refused the same way, always.

Opt in per server with `upstreamElicitation: 'forward'` (on `wrapMcpServer`'s
options, or per box in a `wrapMcpServers` source configuration). The question
is then relayed to the human over MRTR, after the call itself passed the
approval gate:

- The prompt reads `Question from <alias> (not an approval)` (`Link from …`
  for a URL; `the server` on a single-server facade), names the tool, and
  quotes your message line by line (`│ …`), neutralized and capped at 1,000
  characters and 12 lines. Write a short, plain question; formatting does
  not survive.
- Your `requestedSchema` is reduced to the elicitation primitives (string,
  number, integer, boolean, single- and multi-select of string options), at
  most 12 fields whose names are identifiers; titles are capped at 100
  characters and descriptions at 300. The answer you get back carries only
  those fields. Fields named `approve_<n>` or `reason` (Projection's own
  approval fields) are dropped. Anything that reads like an approval (an
  `approv…` word or `Tool:` at the start, a `⚠` anywhere) is shown as
  `The server's text: …`, in titles, descriptions, option values and
  untitled field names alike; such a string default is dropped. Avoid
  approval wording in your questions.
- A URL must be `https:` without credentials (`http:` only on loopback). The
  prompt shows its origin; a client without URL-mode support gets the link as
  text in a form with a "done" checkbox, and accepting sends no content.
- `decline` and `cancel` reach you as such; an unanswered question arrives as
  `cancel`. Your `requestState` comes back byte-exact on the retry: it rides
  sealed inside Projection's own blob (keep it under 16 KB). That blob keeps
  the expiry of the call's first blob, whatever the number of rounds; with
  forwarding on, configure a `replayCache` so each round's blob is
  single-use. Ask at most 4
  questions per round; each round counts against the round-trip cap.
- In a machine, the step waits on your question like an approval: the
  workflow suspends, and the step's `TOOL_RESULT` is your final result.
  With `approvalPrompts: 'batched'`, your question is never folded into the
  batch: it stays its own prompt beside it, and answering it approves
  nothing.

Only push-free MRTR questions can be forwarded: a server that speaks only the
2025 era would have to hold its call open across the human's answer, which a
stateless facade cannot do (D7). If you pass your own connected `Client`, its
era and handlers are yours to govern; forwarding then works only when that
client negotiated 2026-07-28.

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
This server fronts several toolboxes, each wrapping another server, and offers two ways to use their tools. For a single action or a short chain where you look something up and then act on it, call search_tools to find a tool in any box, … Author an XState v5 state machine and run it with execute_machine only when the work loops or branches over results, computes over a list (counting, filtering, summing, comparing or checking every item), takes many steps, or is a workflow worth saving … each tool's listing says whether it runs immediately or asks for approval.

Toolboxes — tools are named <box>.<tool>; search a box with its search_<box> tool, then pass the full name to describe_tool, call_tool and toolCall:
- fs — "Read and write files under /srv." (server's words) (3 tools)
- github — Issues and pull requests. (4 tools)
- notes (1 tool)
```

A box whose tools mostly require the same argument has shared arguments
(DECISIONS D34): a required argument at least half of the box's tools (and
at least three) take with the same type. Its search pages lead with those
arguments and the gloss of any whose description
says what the name does not, so give a shared argument such as a
connection id one description, the same in every tool.

The routing sentence is the multi-server one: a short chain that looks
something up and then acts on it goes through `call_tool` one step at a
time, and a single-server facade keeps the plain R29 rule.
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

Not yet available: `optional: true` sources. Wrapping is fail-closed: if
any source cannot be connected and introspected within
`introspectTimeoutMs` (default 30 000 ms per source), the wrap fails with a
`protocol` error naming the alias, and every connection Projection opened is
closed — a `Client` you passed in stays open.

## Upstream authentication

> **Status.** This is the foundation of just-in-time upstream sign-in (PRD
> §6.10, phase 1, part A): wrapping a remote server by URL, the token store,
> stored-token use and refresh, and `signOut`. **Just-in-time sign-in** — a
> box that comes up locked and asks the user to sign in (device flow) the
> first time a request needs it — is part B and is not supported in this
> version. Nothing in part A writes an initial token: with the default
> store, a server wrapped by URL works if it is public (needs no token), or
> if you supply a `tokenStore` already holding a token for it (see "The
> token store"). A server that needs a token Projection does not have fails
> the wrap with an `auth` error.

**Never put a token in an MCP configuration file** (or an environment
variable, argv, or the source URL). Those files sit in plaintext, get
copied between machines and are never rotated. If a token was ever in one,
rotate it. Projection reads no upstream credential from configuration for
the sources it connects to by URL: the only tokens it holds are ones a user
granted through sign-in, and they live in the token store.

### Wrap a remote server by URL

Pass `{ url, oauth? }` wherever a source goes — as `wrapMcpServer`'s
source, as a `wrapMcpServers` source value, or as a
`ServerSourceConfig.source`:

```ts
const facade = await wrapMcpServers(
  {
    fs: fsServer,
    github: {
      source: {
        url: 'https://api.githubcopilot.com/mcp/',
        oauth: { clientId: process.env.GITHUB_OAUTH_CLIENT_ID!, scopes: ['repo'] },
      },
      description: 'Issues and pull requests',
    },
  },
  { blob: { key: blobKey } },
);
```

Projection builds the Streamable HTTP transport itself, installs its own
OAuth client provider on it, owns the connection and closes it in
`close()`.

- **URL rules.** `https:`, except `http:` on `127.0.0.1`, `[::1]` and
  `localhost`. No credentials before the host, no `#fragment`, and at most
  2048 characters (all `validate` errors). The URL is canonicalized — scheme and host lowercased,
  default port dropped, an empty path written as `/` (`/mcp` and `/mcp/`
  stay different), the query kept, every `@` in the path and query written
  `%40` — and two sources with the same canonical URL are a `validate`
  error. Don't put a credential in the query string: Projection treats the
  URL as configuration, not as a secret, and does not try to detect one.
- **`oauth`.** `clientId` is a client _you_ register with the server's
  authorization server — Projection ships no OAuth app (for GitHub: an OAuth
  app with "Enable Device Flow" ticked; no secret needed). `clientSecret` is
  accepted but discouraged. `scopes` replaces the scope selection from
  metadata — set it explicitly. `signInHosts` (hostnames only — no scheme,
  port, wildcard or IP address), `tokenEndpoint` and
  `deviceAuthorizationEndpoint` are validated now and used by the sign-in
  flow of part B; a refresh today uses the token endpoint the server's
  metadata names, not `tokenEndpoint`. Unknown keys, and `clientMetadataUrl` /
  `authorizationEndpoint` (later phase), are `validate` errors. A server that
  needs no authorization works without `oauth`.
- **Identity.** A URL source's blob identity is `url:<canonical url>` — on
  a multi-server facade, its entry in the `multi:` pairs — instead of the
  server's `name@version`. It is host-chosen and stable, so an upgrade of
  the server behind the URL does not invalidate in-flight blobs; a resumed
  call is validated against the catalog the instance holds.
- **Stored tokens.** When the store holds a token for the source, every
  request carries it (the store is re-read per request, so a token another
  process stored or refreshed is picked up). A token past its `expires_at`
  is refreshed before it is sent; on a 401 with a refresh token, the SDK
  refreshes — once, however many requests failed at the same moment — and
  the rotated set is stored. A definitive refresh failure (`invalid_grant`)
  deletes the stored record only if it is still the one that failed
  (compare-and-delete), so two processes sharing an entry don't clobber
  each other.
- **Where the token goes.** Only to the configured URL: a redirect to any
  other path or origin is refused (a `protocol` error), never followed with
  the token. Every authorization-server request of an `https:` source is
  `https:` too.
- **Failures at wrap time.** A 401 with no usable token, a missing
  `oauth.clientId`, an `insufficient_scope` answer, a refresh that failed
  (temporarily — the stored sign-in is kept), a rejected OAuth client
  (`invalid_client`: check `oauth.clientId` / `oauth.clientSecret`), or an
  authorization-server refusal fails the wrap with an `auth` error. It
  carries library copy and at most the OAuth `error` code — never SDK text,
  server text or token-store errors. Any other connection failure fails the
  wrap with a `protocol` error, whose text has every token the connection
  presented replaced with `[redacted]`.
- **Failures at call time.** The same auth failures after the wrap — a
  token revoked mid-session that cannot refresh, for example — surface in
  the `auth` phase (`call_tool`'s `isError` result with `phase: "auth"`, a
  machine's `TOOL_ERROR`), not as an `upstream` error. Other failures are
  `upstream` errors as for any server, again with tokens redacted from
  anything the server echoes — its error text, tool results and tool
  descriptions.
- **Code mode only.** A facade over a URL with the catalog projection off
  (`projections.catalog: false`) works today; once locked boxes land it
  becomes a `validate` error (PRD R54), because nothing in code mode would
  reach a locked box. Keep the catalog projection on for URL sources.

### The token store

Tokens live only in a `TokenStore`; access tokens, refresh tokens and
client secrets never enter the sandbox, a blob, a log, stderr, an error or
anything the model sees.

```ts
interface TokenStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  // With `expected`: delete only if the stored value is still exactly it.
  delete(key: string, expected?: string): Promise<boolean>;
}
```

Keys and values are opaque strings: store them and hand them back byte for
byte. A key is `<kind>:<JSON array>` — today `tokens:["<canonical URL>",
"<client id>","local"]`; `registration:` is reserved for a later phase — so
a store can route or label entries by the kind before the first `:`. A
`tokens:` value is Projection's ASCII-JSON serialization of the token set;
treat it as a secret and never parse, log or display it.

- **Default: the OS credential store** — macOS Keychain, Linux Secret
  Service, Windows Credential Manager — through `@napi-rs/keyring`, an
  optional dependency loaded on first use (prebuilt binaries, no install
  script, no subprocess). Entries are filed under the service
  `@astral-mcp/projection` with the SHA-256 of the key as the account, so no
  URL appears in the store's metadata. Every write is read back, and every
  operation times out after 5 s. On Linux the entry is pinned to the Secret
  Service (never the session-only kernel keyring).
- **Fallback.** If the module is missing or fails to load, or the store is
  unavailable, locked or hung, Projection keeps tokens in memory for the
  rest of the process and prints one warning to stderr: users sign in again
  after a restart. `signOut` still removes the OS entry (or fails with an
  `auth` error), and a refreshed token is still written to an entry the
  process has seen, so the OS store never keeps a dead refresh token.
- **Threat model.** The OS store protects tokens against other OS users and
  disk theft. It does not protect them from code running as the same user:
  any process of that user (an npm `postinstall` script, another MCP server)
  can read the item. That is true of every OS-store approach.
- **Your own store.** `WrapOptions.tokenStore` replaces the default — for a
  hosted single-user deployment, or a shared store behind a load balancer.
  `MemoryTokenStore` (exported) keeps values in memory. Compare-and-delete
  compares the exact strings; it need not be atomic across processes (the
  default store's is read, compare, delete). Never log a value.
- **Reusing the keyring store.** `KeyringTokenStore` (exported) is the
  default store, so you can keep your own credentials in the OS store with
  the same guarantees: verified writes, 5 s timeouts and per-key ordering.
  Entries go under the service `@astral-mcp/projection`, with the SHA-256
  of your key as the account. Give your keys their own kind prefix (not
  `tokens:` or `registration:`) so they never meet Projection's. The
  prefix keeps keys apart; it is not access control. Any code running as
  the same user, this class included, can read any entry under the
  service. Its options are `warn`, `timeoutMs` and `load`. `warn` receives
  the one fallback warning (default stderr). The default text speaks of
  Projection's upstream sign-in, so pass your own `warn` for your own
  credentials. `timeoutMs` must be from 1 to 2147483647. `load` supplies
  the module. The default import of `@napi-rs/keyring` is left to
  runtime, so a bundled app works when the package is installed beside it
  (mark it external); pass `load` to supply it another way, such as a
  CommonJS `require`. `@napi-rs/keyring` is an optional dependency. When
  it is missing or fails to load, or the OS store fails, `get` and `set`
  do not throw: the instance falls back to memory for the rest of its
  life, prints the warning once, and `fallenBack` turns true. Values set
  after that may not survive a restart (keys already seen in the keyring
  still get a best-effort write), so check `fallenBack` if persistence
  matters. The only `TokenStoreError` you see comes from `delete`, when it
  cannot reach an OS store that may hold the entry, or from `set` given a
  non-string value. It never carries a value or the library's text.
  Ordering, late-write reconciliation and the delete guarantee hold within
  one instance, so use one instance per set of keys. If you also pass a
  `KeyringTokenStore` as `WrapOptions.tokenStore`, pass that same instance
  everywhere. Each instance warns on its own; Projection's default store
  is a separate instance.

### Signing out

`await facade.signOut()` deletes the stored tokens of a single-server
facade's URL source; on a multi-server facade `signOut('github')` clears one
box and `signOut()` every box given by URL. A box built from a pre-built
`McpServer` or `Client`, or an unknown alias, is a `validate` error; a store
that cannot delete is an `auth` error, so a sign-out never silently leaves a
token behind. Tokens are not revoked at the authorization server yet.

### Bringing your own `Client`

A pre-built `Client` keeps its own transport and auth: Projection installs
nothing on it, it keeps `name@version` as its identity, and a 401 from it
surfaces as it always has. Use it for per-user (multi-tenant) auth, hosted
redirect URIs, static tokens from a secret manager, or any scheme
Projection's sign-in does not cover.

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

- `facade.close()` on shutdown. It closes the connections Projection opened
  for in-process servers and servers given by URL; a `Client` you passed in
  stays yours.
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

- Blobs are bound to the wrapped server's identity (`name@version`, or
  `url:<canonical url>` for a server given by URL), or on a
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
