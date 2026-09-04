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
surface.
