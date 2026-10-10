# Engineering decisions

## D1 — Use the SDK's MRTR types; keep our own AEAD requestState sealer (2026-08-08, corrected, then done)

The PRD targets MCP 2026-07-28 MRTR (SEP-2322): `tools/call` may return
`resultType: "input_required"` with an `inputRequests` map and an opaque
`requestState` blob, and the client retries the original call with
`inputResponses` + the echoed state.

**Superseded first attempt.** This entry originally concluded that no
released SDK carried MRTR, and `src/mrtr/protocol.ts` hand-rolled the wire
types. That conclusion was wrong: it was reached by checking only the
legacy monolithic `@modelcontextprotocol/sdk` (1.30.0, protocol
`2025-11-25`) and `@modelcontextprotocol/core@2.0.0`. The SDK v2 release
split the monolith into scoped packages, and MRTR lives in
**`@modelcontextprotocol/server@2.x`**, which was never checked.

**What v2 actually provides.** `@modelcontextprotocol/server@2.0.0` exports
the full MRTR surface as stable (not experimental): `InputRequiredResult`,
`InputRequest(s)`, `InputResponse(s)`, `InputResponseView`, the
`inputRequired()` result helper with `inputRequired.elicit()`, the
`inputResponse()` / `acceptedContent()` readers, `isInputRequiredResult()`,
and `ProtocolEra`. The 2026-07-28 era is served alongside the legacy era
from one entry point; clients opt in via `versionNegotiation`.

Decision: adopt the SDK's types and helpers. Hand-rolling a parallel
definition of a stable wire format is duplication that will silently drift.

**But keep our blob sealer.** The SDK also ships
`createRequestStateCodec`, which is deliberately **signed, not encrypted** —
its own docs say the client "can base64url-decode it and read the payload
in clear. Do not put secrets in the payload; use an AEAD construction if
confidentiality is required", and note that HKDF sub-key derivation and an
encrypted mode are out of scope for the initial release.

PRD R19 requires encryption specifically because machine context may hold
data returned by read-only tool calls that would otherwise never transit to
the client in code mode. So `src/blob/` stays: AES-256-GCM under a per-blob
HKDF-derived key is exactly the AEAD construction the SDK tells integrators
to bring. Our sealer additionally carries the fields MRTR does not model —
`codeHash` (S4), `serverIdentity` (R30), the `pending` map (S2) and `trip`
(R18) — and supports key rotation (R22). The SDK's `bind` concept is worth
adopting later for principal binding.

**Done (2026-08-08).** The migration landed. Shape it took:

_Dependencies._ `@modelcontextprotocol/sdk@^1.30.0` is gone; the package
depends on `@modelcontextprotocol/server@2.0.0` and
`@modelcontextprotocol/client@2.0.0` (exact pins). `@modelcontextprotocol/core`
and `/node` are not imported directly. `zod` moved to `^4.2.0` — the v2
packages require it, and `registerTool` now takes a Standard Schema
(`z.object({…})`) rather than a raw shape.

_Types._ `src/mrtr/protocol.ts` no longer defines wire types. It re-exports
the SDK's `InputRequiredResult`, `InputRequest(s)`, `InputResponse(s)`,
`InputResponseView`, `ContentBlock`, `CallToolResult` and `ProtocolEra`, plus
the `inputRequired()` / `inputResponse()` / `acceptedContent()` /
`isInputRequiredResult()` helpers; `ToolCallResult` is now literally the
SDK's `HandlerResultTypeMap['tools/call']`. Three things stay local because
the SDK does not provide them: `APPROVAL_SCHEMA` (a product decision, typed
as the SDK's restricted elicitation schema so no cast is needed),
`MRTR_PROTOCOL_REVISION` (the SDK's `LATEST_PROTOCOL_VERSION` /
`SUPPORTED_PROTOCOL_VERSIONS` cover the legacy family only — 2026-07-28 is
modelled as an era, not a version constant), and `supportsMrtr`. The
locally-invented `CompleteResult`, `ElicitationRequest`, `ElicitationResponse`
and `ResultType` are deleted; suspensions are built with `inputRequired()` and
verdicts read with `inputResponse()`.

_The blocker._ `registerOn` registered `execute_machine` through an `as never`
cast and read `extra.protocolVersion`, a field `RequestHandlerExtra` never
had. `deps.protocolVersion` was therefore always `undefined`, `supportsMrtr()`
always false, and every gated call answered `phase: "protocol"` instead of
suspending — the headline feature was dead through its own documented entry
point. The fix follows how v2 actually models era: it is **instance state, not
a per-request field**. `createMcpHandler` / `serveStdio` call a server factory
with `McpRequestContext.era`, so the facade's primary shape is now
`facade.serverFactory`, and `createServer(ctx)` closes over the era before
registering the handler. `supportsMrtr` takes a `ProtocolEra` and returns
`era === 'modern'`. A hand-built `McpServer` is legacy by construction, which
is why `registerOn(server, { era })` defaults to legacy — fail-safe.

_R28 both ways._ A modern client (`versionNegotiation: { mode: { pin:
'2026-07-28' } }`) suspends; a legacy client gets the fail-fast `protocol`
error. Note that v2 would otherwise fulfil an `input_required` return on a
legacy connection through its own server→client elicitation shim. Projection
refuses that on purpose: R28 mandates the fail-fast, and the shim's push-style
round trips hold a connection open, which is the statelessness (R27) MRTR
exists to buy.

_R29._ `Server` accepts `instructions` only in its constructor, so `registerOn`
could never deliver the code-mode preamble and the model never saw it.
`createServer` constructs the `McpServer` with `instructions` and registers
everything; `serverFactory` is that function bound for `createMcpHandler`. An
integration test asserts a real `Client.getInstructions()` equals
`facade.instructions` on both eras.

_Forced behavioural changes._ Two, both verified against the SDK's wire codec
rather than assumed:

1. The 2026-07-28 elicitation params have no `title` (only `message`,
   `requestedSchema`, `mode`). `ElicitationCopy.title` is now the first line
   of the message rather than a dropped field.
2. An `InputRequiredResult` carries `resultType`, `inputRequests` and
   `requestState` and nothing else — the encode seam strips `content` **and**
   `_meta`. So R31's "logs ship alongside `input_required` suspensions" clause
   is not deliverable on this wire. Logs still ship with every completion,
   every `isError` result and every resumed segment; only the suspending
   segment's console output is lost. It is deliberately not smuggled into the
   elicitation prompt, because S6 requires that copy to be server-derived and
   logs are model-authored. Locked by a test so the day the spec grows a
   vehicle, the fix has an address.

_Testing._ The SDK has no in-memory serving entry for the modern era
(`InMemoryTransport.createLinkedPair()` connects legacy instances only), which
is exactly why the wired path went untested and the blocker survived review.
`test/integration/code-mode-server.test.ts` drives a real `Client` against
`createMcpHandler(facade.serverFactory)` over a `StreamableHTTPClientTransport`
whose `fetch` is the handler itself — real JSON-RPC, no network. Three of its
seven tests fail if the era stops reaching the handler.

## D2 — Toolchain (2026-08-08)

pnpm workspaces + Turborepo; tsdown (rolldown) build, ESM-only, `.d.mts`
declarations; oxlint (correctness=error) + prettier; vitest; strict TS with
`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. XState pinned
exactly at 5.32.5 and `@sebastianwessel/quickjs` pinned at 3.1.0 per PRD §7
dependency notes.

## D4 — In-TTL replay is an MRTR-adapter obligation (2026-08-08)

The blob sealer is stateless by design (R27/N4): the same sealed blob opens
successfully any number of times within its TTL, and the authenticated
`trip` counter cannot advance under replay. Security review conclusion: a
malicious client replaying a captured approved retry would re-execute the
gated call once per replay unless the layer above prevents it. Normative
obligation on the MRTR adapter: after executing the gated calls of a resume,
the workflow must move forward (fresh blob, fresh nonce, incremented trip)
and the adapter must never execute gated calls from a blob whose `pending`
verdicts it has already consumed in the same process without producing a new
suspension; deployments needing hard cross-instance replay prevention can
plug a replay cache keyed on the blob `nonce` (hook reserved; the `nonce`
field exists for exactly this). Documented as a known limitation of the
stateless target rather than silently ignored.

## D3 — Parallel-agent conventions (2026-08-08)

Component code lives under `src/<component>/` with a local `index.ts`.
`src/types.ts` is the shared contract; component agents do not edit it or
`src/index.ts` concurrently — top-level exports are wired after each wave.

## D5 — MCP Apps attach to completed results, not suspensions (2026-09-04)

PRD §12.1 fences two Apps use cases: approval previews (priority) and
result dashboards. The wire decides for us, for now: the 2026-07-28
`InputRequiredResult` encode seam strips `content` AND `_meta` (verified in
D1), so a suspension cannot carry an app reference, and the elicitation
params have no vehicle for one either. Approval previews therefore need a
spec extension before they are implementable. What ships: a static,
library-authored workflow dashboard (`ui://projection/dashboard.html`,
`text/html;profile=mcp-app`, declared via `execute_machine`'s
`_meta.ui.resourceUri` per SEP-1865) rendering output, audit trail, logs
and structured errors. The §12.1 security constraint is satisfied by
construction: the app is a compile-time constant with zero model-authored
code (no VM at all), requests no host capabilities, and renders all
model-controlled data via `textContent` only — locked by tests. The
`discover_apis` resource links exclude `ui://` so models never see the app
surface (the harness's `buildApiDocs` authoring docs filter `ui://`
resources too).

## D6 — Opt-in legacy elicitation via the SDK shim (2026-09-12)

R28's fail-fast on legacy connections was chosen because the SDK's
server→client elicitation shim holds the `tools/call` open, suspending the
statelessness (R27) MRTR buys. But popular clients (Cursor among them) have
not adopted 2026-07-28, and the cost analysis is transport-dependent: over
stdio — how those clients actually run servers — the connection is held by
nature and there is no statelessness to lose.

Decision: `compat.legacyElicitation` opts in per facade; default stays
fail-fast. Verified empirically before building: on a held legacy
connection the SDK converts a returned `input_required` into old-style
`elicitation/create` pushes and re-invokes the handler with a byte-exact
`requestState` echo plus the collected `inputResponses` — the same retry
envelope as a real MRTR retry — so blob sealing/verification (S2–S4), the
audit trail, trip counting, and R17's missing-answer-is-decline all run
unchanged. Only the transport of the question differs.

Limitation, locked by test: per-request legacy HTTP serving
(`createMcpHandler`'s stateless legacy mode) has no server→client channel;
the SDK refuses with a named error and nothing executes (S2 holds). The
opt-in is therefore effective for stdio/held-connection deployments only.
The client must also declare the `elicitation` capability (form mode);
otherwise gated calls get Projection's structured `protocol` error at
suspend time, while read-only machines still run.

## D7 — Wrapped-tool elicitations fail closed; forwarding is MRTR-only if ever (2026-09-12)

What happens when a WRAPPED tool raises its own elicitation mid-call?
Verified empirically: the introspector's client declares no `elicitation`
capability, so the upstream's request is refused with a named error and the
machine receives an ordinary `TOOL_ERROR` event it can handle — fail
closed, no hang, no silent approval surface. Caveat: this guarantee covers
introspector-OWNED clients (in-process wraps); a caller-provided connected
`Client` answers upstream elicitations with whatever handlers the
integrator registered on it — that is the integrator's choice.

Decision: keep fail-closed as the posture. If forwarding is ever built, it
is MRTR-upstreams-only: a modern upstream's `input_required` carries an
opaque `requestState` that can NEST inside Projection's own sealed blob,
preserving stateless resume across both hops. Legacy-push upstream
elicitations cannot be forwarded without holding the upstream's in-flight
call across our own suspension — cross-instance-impossible state that R27
forbids. Forwarded upstream copy would be third-party text and MUST get the
S6 inert-rendering treatment; it must never be conflated with Projection's
own approval prompts.

## D8 — Two views of a run: the dashboard is for hosts, /visualize-workflow is for the person (2026-09-14)

The MCP App dashboard (`src/apps/dashboard.ts`, D5) and the
`/visualize-workflow` prompt both render an `execute_machine` result, and
they deliberately disagree about what to show. The dashboard is the
machinery view: output, the approval audit trail, logs, structured errors —
the human-approval story a host or integrator inspects to trust what ran.
The prompt is the outcome view: what the person who asked for the
automation actually got, in their words, with the audit trail, logs, trip
counts, tool ids and phases read by the model as sources of fact but kept
off the page (declines, policy denials and errors still surface, as plain
statements of what did not happen).

Decision: keep them split. Do not "harmonize" the two by adding the audit
table to the prompt or stripping it from the dashboard; each has a
different reader. Both share the S6 posture — every result value is inert
data and a fact, never an instruction; only the result's `hint` is advice.

## D9 — Two projections, one gate: the catalog projection coexists with code mode (2026-10-09)

Code mode (`execute_machine`) is the product: N steps in one round trip,
branching on `TOOL_DENIED`, a sealed snapshot that any instance can resume,
and a result worth saving as a skill. It has two costs that showed up in use.
A single action ("read notes.txt") costs a 25-line machine and a round of
self-healing, and `discover_apis` describes the whole catalog inline, which
does not survive a server with hundreds of tools.

Decision: add the lazy-catalog shape — `search_tools`, `describe_tool`,
`call_tool` — as a second projection on the same facade (PRD §6.8), on by
default, and route between them in the instructions preamble (R29): one step
→ `call_tool`; several steps, branching, or anything worth saving →
`execute_machine`. Not a mode switch; both are live unless the integrator
turns one off. Staged default: the projection lands in parts, and until
`call_tool` ships it defaults off (`projections.catalog` is opt-in), flipping
to the R32 default of on in the part that adds `call_tool` (flipped in part
2, #36).

Why one gate rather than a proxy. `call_tool` is the degenerate one-call
machine, so it reuses the machine's approval path end to end: the R16 copy
builder, the redaction hook, the blob sealer and the MRTR adapter. The
approved args execute from the blob's `pending` entry, never from the retry
(S2), and the blob is bound to the canonical `{ kind: "call", name, args }`
request through the existing `codeHash` field plus a `kind` discriminator
(R36) — a coherence check that keeps a stale approved blob from being
attached to an unrelated request, not the approval binding itself. A separate,
simpler "approval token" for direct calls was rejected: it would be a second
S2–S4 implementation to fuzz, tamper-test and keep in step for a saving of
one `null` snapshot.

Decline is an outcome, not an error. `call_tool` returns a normal result
`{ status: "declined" }` (mirroring `TOOL_DENIED`), because an `isError`
result reads to a model as "retry", and the one thing a declined write must
not do is come straight back. The tool description says so explicitly. The
same holds for `denied_by_policy`: the model cannot change the integrator's
policy, so an error would only invite retries.

Argument validation is structural only (required keys, top-level types,
unknown keys when forbidden). It exists so a human is never asked to approve
a call that the upstream will reject on shape, and so the model gets a
`validate` hint naming the property; full JSON Schema validation would run
twice — the wrapped server is the authority — for nothing but a nicer error
message.

`describe_tool` is the injection surface of this projection — it hands the
wrapped server's own words to the model, and not only in the description:
`inputSchema` and `outputSchema` carry server-controlled free text in
`title`, nested `description`, `examples`, `default`, `$comment`, `x-*`,
`enum` and `pattern`. Both get the S5 treatment `discover_apis` gets:
description neutralized and capped, schemas rendered through a key allowlist
with every string neutralized and the rendering capped per tool (R34),
annotations presented as hints, identity inert. Typegen's `docComment`
originally escaped only `*/`; it now applies the same neutralization, so the
`.d.ts` resource and the `describe_tool` slice of it are clean too.

`call_tool` also changes the S5 effort calculus. A mislabelled
`readOnlyHint: true` tool used to be a machine away; now it is one model call
away. The mitigation is unchanged — the R14 override forces such tools to
`ask`, and the §13 Postgres case exercises exactly this — but the catalog
projection turns it from a setting an integrator could defer into one they
should set before enabling the projection on a server they do not control.

Policy outranks a stale approval. A `deny` configured after a `call` blob was
minted wins on the retry: `call_tool` decides policy on the retried name
before it opens the blob, so nothing executes and no replay nonce is spent.
The machine host's `applyVerdicts` applies the same rule: a pending call
whose tool is `deny` at resume time is `TOOL_DENIED` with the policy reason,
whatever the verdict says (here the blob is opened first — the machine has to
continue with `TOOL_DENIED` — so the replay nonce is spent; the conservative
side).

`call_tool` makes the D4 window more consequential. After an approved machine
step the workflow moves forward (fresh blob, fresh nonce, incremented trip),
and `packages/harness/test/replay.test.ts` documents the residual: a captured
approved retry still re-executes until `exp`. After an approved `call_tool`
there is no forward step at all — no fresh blob, no trip increment — so a
captured approved retry is a standing write capability until `exp`, with
nothing in the flow that even nominally supersedes it. Hence R38: `call`
blobs default to a 5-minute TTL (`blob.callTtlMs`) instead of 15, and the
replay-cache hook D4 reserved is now specified as
`WrapOptions.replayCache.seen(nonce, exp)`, consulted for both blob kinds
after R21 verification and before any gated call executes. No default
implementation ships: an in-memory cache would pass every single-instance
test and silently fail the moment a second instance resumes the blob.

## D10 — `search_tools` matches tokens and ranks; no regex, no fuzzy, no synonyms (2026-10-10)

The first `search_tools` was `grep -iF`: the whole query as a case-insensitive
substring of the name or description, catalog order, no ranking. Measured
on the 95-tool remote GitHub MCP catalog with 45 hand-labelled queries of
the kind a model types before it has seen the catalog (snake_case guesses
such as `create_issue`, intents such as `comment on a pull request`, single
keywords), it returned nothing for 29 of them: hit@1 31%, hit@5 33%. Each
miss costs the model a round trip and usually a two-page browse of the
whole catalog.

Decision: split the query into tokens (anything that is not a letter,
combining mark, or digit separates, after NFC normalization; tokens under
two characters are dropped, falling back to the whole trimmed query when
nothing survives — so `a b` means the literal `a b`, a whitespace-only
query matches nothing, and only an empty query lists everything),
deduplicate the tokens, match a tool when ANY token is a substring of its
name, annotation title, or description, and rank by the additive score
`2 × (tokens hitting the name) + (tokens hitting the title or description)`
— a token in both the name and the description scores 3 — with a stable
sort so ties keep catalog order. The title counts like the description
rather than like the name: it catches words the description lacks
(`issue_write`'s title says "Create"), but a tool whose title merely
mentions "pull request" must not tie the `*pull_request*` tools for that
query — which it did when titles were weighted like names. Same eval,
final algorithm: hit@1 76% (34 of 45), hit@5 89%, on the first page 98%,
one miss (`who am I`), and no regression — every match set is a superset
of the substring matcher's and ranking never pushed a target off the page.
Filesystem catalog: misses 5 of 10 → 1 (`mkdir`). The title term's one
measured cost: `get_user` drops from #1 to #2 — `get_copilot_space`'s title
supplies the `get` its description lacks, it ties `get_me` at 4, and catalog
order breaks the tie. Sixty-seven lines added and fourteen removed in
`search.ts`, twenty-five of them code; the matcher itself (`tokenize` plus
`rankTools`) is twenty-four lines.

S5: a hostile title stuffed with query words scores +1 per token, exactly
what a stuffed description already scored, and per token can never outweigh
a name hit (+2); the posture column is computed from policy, not from
catalog text. The title term adds no exposure beyond what description
stuffing already had.

Rejected, with the numbers: requiring ALL tokens (hit@1 67%, 12 misses —
filler words and inflection kill it); ALL-then-ANY fallback (shorter pages,
median 4 vs 22, but two confidently wrong short lists, a worse failure than
a long page); name-first ranking (identical ordering on every query — the
2× weight already does it); trailing-`s` stemming (net negative on ties);
regex from the query (a hostile description plus a model-authored pattern
is a ReDoS surface, and models predict a word better than a pattern).

Known cost: filler words match most descriptions, so a natural-language
query can return a full page with the answer at #1, and an unanswerable
query (`who am I`) returns wrong rows instead of none. Still missed: queries
that need synonyms (`mkdir` → `create_directory`); that is a vocabulary
problem, not a matching one, and not worth a thesaurus. CJK runs are one
token (no segmentation): a query of several ideographs matches only as that
exact run.
