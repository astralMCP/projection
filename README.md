<p align="center">
  <img src="docs/assets/header.svg" alt="astralMCP / projection" width="800">
</p>

Wrap any MCP server in **code mode** (LLM-authored XState workflows) and a **tool catalog** (search, describe, call), with **human-approved side effects** over MCP MRTR (Multi Round-Trip Requests).

> **Agents:** this README is written to be followed top to bottom. Read
> [Why](#why) for what Projection does, then work through
> [Adopt and use](#adopt-and-use) in order. Every snippet typechecks against
> the API on `main`.

## Why

GitHub's MCP server has 95 tools. A host puts every definition in every
prompt, even when the task needs only a few. Tool annotations identify
writes, but the protocol does not require an agent to ask for approval
before sending an email or dropping a table.

Projection sits in front of your MCP server (or several) and gives the model
a smaller set of tools with approval controls:

- The tool catalog uses `search_tools`, `describe_tool` and `call_tool` to find
  and run one tool at a time. Search hits come with their call signature, so
  the model can usually call straight from the search page.
- In code mode, `discover_apis` returns generated TypeScript types for the
  server's tools; `execute_machine` runs a workflow the model writes as an
  XState v5 machine in a QuickJS WebAssembly sandbox. Use it for several
  steps, branching, or computing over a list.
- For small catalogs, when the wrapped tools' definitions
  fit about 8k estimated tokens (the default), each is also listed under its
  own name as a mediated alias of `call_tool`, and `search_tools` is dropped.
- Read-only calls run immediately. By default, any other call pauses for
  human approval over MRTR. Projection seals the workflow's state into an
  encrypted blob that travels with the request. The person sees the call,
  with any fields your `redact` hook masks, and approves or declines it.
  A decline is an ordinary result the model can act on.

Projection enforces these guarantees (invariants S1–S6 in
[docs/PRD.md §9](docs/PRD.md#9-security-invariants)):

- Every call, including a directly listed tool, goes through the same gate. Projection
  never passes through the wrapped server's tools.
- An approval binds the exact tool name and arguments. Projection seals
  them in the blob and executes that call regardless of what the resumed
  workflow asks for next.
- Clients carry the state in AES-256-GCM encrypted blobs they cannot read
  or alter. Each blob has a TTL and is bound to the code, the tool kind and
  the wrapped server that issued it. Projection itself keeps no state,
  so any instance can resume any workflow.
- Machine code has no `fetch`, no filesystem
  and no host globals; the tools bridge is its only way out, and every
  sandbox has hard caps on memory, time and calls.
- An unannotated tool asks for approval. Your `policy` overrides take
  precedence over annotations.

The full integration guide is [docs/server-authors.md](docs/server-authors.md).

## Adopt and use

Projection is a library: you write a small server that wraps the MCP server
you already have, and point your MCP host at that instead.

### 1. Install

Requires Node ≥ 22.12 and an ES module project (`"type": "module"`).

```bash
npm install @astral-mcp/projection @modelcontextprotocol/server@~2.4.0 @modelcontextprotocol/client@~2.4.0
```

Projection is built on the MCP TypeScript SDK v2, which is a peer
dependency: install both packages yourself, in the supported range
(`~2.4.0`: 2.4.x, not 2.5), and Projection uses your copy. Then check that
`npm ls @modelcontextprotocol/server @modelcontextprotocol/client` shows one
copy of each and no `invalid`.

### 2. Wrap a stdio server

The most common setup: your host (an IDE, a desktop app, an agent CLI) runs
MCP servers over stdio. Write a script that starts the real server as a
child process, wraps it, and serves the result over stdio:

```ts
// projection-server.ts
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { wrapMcpServer } from '@astral-mcp/projection';

// The server you already use, started as a child process.
const upstream = new Client({ name: 'projection', version: '1.0.0' }, { capabilities: {} });
await upstream.connect(
  new StdioClientTransport({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/dir'],
    stderr: 'inherit', // stdout carries the protocol; logs go to stderr
  }),
);

const facade = await wrapMcpServer(upstream, {
  // One process, so a fresh key per start is enough; see "Production" below.
  blob: { key: randomBytes(32) },
  // Approvals for hosts on MCP revisions before 2026-07-28 (held connections such as stdio).
  compat: { legacyElicitation: true },
});

serveStdio(facade.serverFactory);
```

Then replace the server's entry in your host's MCP configuration so it runs
this script with Node. Use absolute paths for both the script and a `node`
binary ≥ 22.18 (it runs TypeScript directly; on 22.12–22.17 compile the
script first, or run it with `tsx`). Hosts often start servers from another
working directory, with a different `PATH`. Many hosts use this shape; the
exact file and fields depend on the host:

```json
{
  "mcpServers": {
    "files": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/projection-server.ts"]
    }
  }
}
```

The host's model now sees the catalog tools, code mode, and, for a
server this size, its tools by name. A write it calls pauses and the host
shows an approval prompt. Approval support depends on the client:

- A client on the **2026-07-28** revision gets approvals over MRTR on any
  transport.
- An older client gets them only through `compat: { legacyElicitation: true }`
  over a held connection such as stdio, and only if it declares the `elicitation` capability. Without
  either, read-only calls and machines still run and a write fails with a
  structured error naming the revision it needs.
  See [Legacy clients](docs/server-authors.md#legacy-clients-pre-2026-07-28).

Projection reads the server's tools at wrap time. For servers it connects
to itself, it follows `tools/list_changed` by default and swaps in the new
tools, types and policy together. It does not trust that server's
annotations until the update is complete. For a `Client` you pass in, call `facade.refreshTools()` from its own handler. See
[When your tool list changes](docs/server-authors.md#when-your-tool-list-changes).

You can also wrap an in-process `McpServer` you built yourself (pass it
unconnected), and serve over HTTP with `createMcpHandler(facade.serverFactory)`:
see [Wrap and serve](docs/server-authors.md#wrap-and-serve).

### 3. Wrap a remote server by URL (preview)

Any source can be `{ url, oauth? }`. Projection opens the Streamable HTTP
connection itself and keeps tokens in a token store (the OS credential
store when the optional `@napi-rs/keyring` package is installed), never in
configuration:

```ts
import { randomBytes } from 'node:crypto';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { wrapMcpServer } from '@astral-mcp/projection';

const facade = await wrapMcpServer(
  { url: 'https://mcp.example.com/mcp' }, // add oauth: { clientId, scopes } if it needs sign-in
  { blob: { key: randomBytes(32) } },
);

serveStdio(facade.serverFactory);
```

Sign-in on first use is not supported yet: a public server works, and so
does one whose token is already in your `tokenStore`; otherwise the wrap
fails with an `auth` error. **Never put a token in an MCP configuration
file, an environment variable or the URL.** See
[Upstream authentication](docs/server-authors.md#upstream-authentication).

The snippets from here on reuse `upstream` from step 2, and a `blobKey`
(step 6 shows where it comes from in production).

### 4. Several servers behind one facade (preview)

`wrapMcpServers` fronts several servers as tool boxes under aliases you
choose. Tools are addressed as `<alias>.<name>` and policy keys are
qualified names. By default (`direct: 'auto'`), boxes that fit the token
budget are listed directly as `<alias>__<tool>`, smallest box first; every
other box keeps its own `search_<alias>` tool:

```ts
import { wrapMcpServers } from '@astral-mcp/projection';

const facade = await wrapMcpServers(
  {
    fs: filesClient, // a connected Client, or an unconnected McpServer
    github: { source: githubClient, description: 'Issues and pull requests.' },
  },
  {
    blob: { key: blobKey },
    policy: { 'github.delete_repository': 'deny' },
  },
);
```

Code mode works across boxes: machines call `toolCall('fs.read_file', args)`.
See [Several servers behind one facade](docs/server-authors.md#several-servers-behind-one-facade-preview).

### 5. Decide what asks for approval

By default every tool that is not `readOnlyHint: true` asks. Tighten or
loosen that per tool with `policy` (`'auto'`, `'ask'` or `'deny'`), or for
many tools at once with `policyRules`.

> **`policyRules` and `policyOf` are new since 0.9.0.** They need the next
> release, or a build from `main`. On 0.9.0 `policyRules` is ignored without an error, so the
> example below would run with no pins. On 0.9.0, pin those tools with exact
> `policy` entries instead, or don't use `'destructive-only'`.

```ts
const facade = await wrapMcpServer(upstream, {
  blob: { key: blobKey },
  policy: {
    query: 'ask', // don't trust readOnlyHint on opaque SQL
    drop_table: 'deny', // refused outright; no approval possible
  },
  // Run writes the server marks destructiveHint: false without asking.
  // Trusted servers only: a server can mislabel a damaging tool.
  approvals: 'destructive-only',
  // ...but "non-destructive" is not "harmless": pin what reaches other people.
  policyRules: [
    { match: '*send*', decision: 'ask' }, // whole name, case-insensitive, * = anything
    { match: '*share*', decision: 'ask' },
    { match: '*post*', decision: 'ask' },
    { match: '*invite*', decision: 'ask' },
  ],
  // Mask argument fields before they reach an approval prompt.
  redact: (tool, args) => ('token' in args ? { ...args, token: '[redacted]' } : args),
});
```

These patterns are examples. Comments, publishing and anything else that
reaches other people need the same treatment; see
[Policy rules](docs/server-authors.md#policy-rules).

Precedence, strongest first: an exact `policy` entry, then the first
matching `policyRules` rule, then `approvals`, then the tool's annotations.
Everything is resolved at wrap time, and again after each followed
`tools/list_changed`; every surface the model sees shows
the decision the gate will enforce. To confirm a pin took effect, ask the facade
for the decision the gate will make:

```ts
facade.policyOf('send_email')?.decision; // 'auto' | 'ask' | 'deny'; undefined for an unknown name
```

On a multi-server facade, pass the qualified name (`'gmail.send_email'`). See
[Annotations drive the policy](docs/server-authors.md#annotations-drive-the-policy).

### 6. Production: keys and the replay cache

The blob key is Projection's one piece of state. Every instance that
can resume a workflow must hold the same 32 bytes, from a secret manager
(generate one with `openssl rand -base64 32`):

```ts
const facade = await wrapMcpServer(upstream, {
  blob: {
    key: Buffer.from(process.env.PROJECTION_BLOB_KEY!, 'base64'),
    // Rotation: blobs sealed under an old key open until they expire.
    previousKeys: [Buffer.from(process.env.PROJECTION_BLOB_KEY_OLD!, 'base64')],
  },
});
```

Use one key per facade: two facades that share a key over the same servers
can resume each other's blobs. In-flight blobs fail after a deploy that
changes the Projection or XState version; the model re-runs.

Without a replay cache, an approved retry captured in transit can
be replayed until its blob expires (5 minutes for `call_tool`, 15 for
machines). To make every approval single-use, supply an atomic
test-and-set shared by all instances:

```ts
const facade = await wrapMcpServer(upstream, {
  blob: { key: blobKey },
  replayCache: {
    // Record the nonce until exp (Unix ms); resolve true if it was already recorded.
    seen: (nonce, exp) => store.setIfAbsent(nonce, exp).then((added) => !added),
  },
});
```

`store.setIfAbsent` stands for your shared store's atomic primitive (Redis
`SET NX PX`, a unique insert). It must be atomic across instances; a read
followed by a write lets two replays through.

A single-process server, like the stdio one in step 2, can pass the
in-memory cache instead:

> **`MemoryReplayCache` is new since 0.9.0.** It needs the next release, or
> a build from `main`.

```ts
import { MemoryReplayCache } from '@astral-mcp/projection';

const facade = await wrapMcpServer(upstream, {
  blob: { key: blobKey },
  replayCache: new MemoryReplayCache(), // stdio / single process only
});
```

It is correct only when one process serves every retry: behind a load
balancer each instance keeps its own set and a replay sent to another
instance executes, so supply a shared store there. A restart forgets every
nonce; with a persistent blob key, a blob sealed before the restart can be
replayed until it expires (a key generated at startup, as in step 2, makes
those blobs fail verification).

Call `facade.close()` on shutdown. See [Lifecycle and operations](docs/server-authors.md#lifecycle-and-operations)
and [Resource caps](docs/server-authors.md#resource-caps).

### Further reading

- [docs/server-authors.md](docs/server-authors.md): the integration guide, covering
  every option, the approval prompts, caps, errors, legacy clients.
- [`authoring-machines` skill](.claude/skills/authoring-machines/SKILL.md):
  how machines are written, for testing Projection against your server.
- [docs/PRD.md](docs/PRD.md): requirements (R-numbers) and the security
  invariants (S1–S6).
- [docs/DECISIONS.md](docs/DECISIONS.md): why things are the way they are.

<!-- Insights: maintained by hand. Every claim must link to the DECISIONS
entry or committed result that backs it; edit freely. -->

## Insights

We test Projection by giving models the same tasks with tools listed
directly and through Projection, then checking what they actually did.
Some of the useful lessons came from failures in how we presented those
tools and their results.

### Display formatting can change the user's data

We indented file contents in tool results to separate them from our own
text. Haiku copied that indentation when writing the files back. This
accounted for most of its failures on our multi-server eval tier.

We changed the rendering rather than adding an instruction to strip the
indent. When we extract long string fields from structured results, we
now fence them without adding indentation. We also fixed a cleanup step
that was replacing meaningful tabs. If an
agent needs to copy or edit text, check what survives a read-and-write
round trip through your tool's output format. Preserve the boundary around
untrusted content too: our fence grows longer than any backtick run in the
content, so the content cannot close it itself.
([D35](docs/DECISIONS.md#d35--a-text-field-is-printed-verbatim-in-a-fence-not-indented-2026-10-31))

### A successful call can hide an unfinished task

Our schema cleanup removed a search tool's default page size. The model
omitted the limit, received 10 of 40 documents, and treated them as the
whole set. In another run, a workflow stopped after 8 of 14 writes. Its
error was followed by a list of completed calls, and the model told the
user the task was finished.

The first call succeeded; the second returned an error. In both cases,
the model missed the unfinished work. We now preserve scalar defaults,
flag results that look partial, and say when a workflow stopped unfinished.
When testing
your own tools, check what the agent tells the user after a partial result
or interrupted batch. Returning an error or a page of valid data doesn't
establish that it understood what remains to be done.
([D29](docs/DECISIONS.md#d29--pass-on-the-signals-the-server-already-sent-defaults-partial-results-text-as-text-2026-10-30),
[D30](docs/DECISIONS.md#d30--many-gated-calls-in-one-round-trip-toolcalls-and-copy-that-says-what-it-means-2026-10-30))

### A shorter tool list can make a task more expensive

Hiding tools behind search saves prompt space, but adds discovery turns.
With prompt caching, those extra turns can cost more than listing the
tools up front. Direct listing roughly halved Haiku's cost on two eval
tiers while improving completion. Sonnet saw no benefit on one tier and
spent more on a harder one when the listed tools went unused.

Measure the cost of finishing a task with the models you use, including
discovery and retries. Projection's default is a budget of 8,000 estimated
tokens for directly listed definitions; multi-server setups fill it with
the smallest tool boxes first. That budget is our practical cutoff, not a
universal optimum. Tune yours against completed tasks rather than prompt
size alone.
([D28](docs/DECISIONS.md#d28--projectionsdirect-defaults-to-auto-2026-10-30),
[D32](docs/DECISIONS.md#d32--search-hits-show-how-to-call-them-argument-errors-carry-the-signature-2026-10-31))

### Removing a lookup can remove the information needed to act

Adding call signatures to search results helped cut tool-description
lookups by about 80%. But a signature like `connectionId: string` didn't
explain where the value came from. Sonnet guessed `"default"`, received an
error, and gave up. The description it had skipped explained how to obtain
a connection ID. The error repeated the signature, so a retry had nothing
new to go on.

Search hits now explain required arguments whose names and types don't
say enough, and error hints include relevant argument descriptions. Before
removing a step from your agent's workflow, check what it learned there.
For a failed call, check whether the error provides enough new information
to correct it.
([D32](docs/DECISIONS.md#d32--search-hits-show-how-to-call-them-argument-errors-carry-the-signature-2026-10-31),
[D33](docs/DECISIONS.md#d33--signed-hits-gloss-the-required-arguments-their-names-do-not-explain-2026-10-31))

## Contributing

Requires Node ≥ 22.12 (CI tests 22 and 26) and pnpm.

```bash
pnpm install
pnpm run check    # build + typecheck + lint + test, all packages: the gate for every change
pnpm run format   # oxfmt; run before every commit (CI fails on drift)
```

One PR per change, reviewed before it merges: the cycle, conventions and
repo gotchas are in
[.claude/skills/contributing](.claude/skills/contributing/SKILL.md).
Requirements live in [docs/PRD.md](docs/PRD.md); append durable decisions to
[docs/DECISIONS.md](docs/DECISIONS.md).
