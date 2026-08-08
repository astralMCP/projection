# Engineering decisions

## D1 — Use the SDK's MRTR types; keep our own AEAD requestState sealer (2026-08-08, corrected)

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
