# Engineering decisions

## D1 — MRTR wire types are defined locally (2026-08-08)

The PRD targets MCP 2026-07-28 MRTR (SEP-2322): `tools/call` may return
`resultType: "input_required"` with an `inputRequests` map and an opaque
`requestState` blob, and the client retries the original call with
`inputResponses` + the echoed state.

The currently installed `@modelcontextprotocol/sdk` (1.30.0) tops out at
protocol `2025-11-25`. It ships an _experimental tasks_ feature that uses an
`input_required` task status, but not the MRTR result shape the PRD specifies.

Decision: `src/mrtr/protocol.ts` defines the MRTR wire types exactly as the
PRD describes them. The MRTR adapter is the only component that touches these
types (PRD §7), so when the SDK ships official MRTR support we replace one
module. Down-negotiation (R28) already requires us to detect a client that
can't speak MRTR and fail gated flows fast; until the SDK stable line catches
up, that path is also what real clients exercise.

## D2 — Toolchain (2026-08-08)

pnpm workspaces + Turborepo; tsdown (rolldown) build, ESM-only, `.d.mts`
declarations; oxlint (correctness=error) + prettier; vitest; strict TS with
`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. XState pinned
exactly at 5.32.5 and `@sebastianwessel/quickjs` pinned at 3.1.0 per PRD §7
dependency notes.

## D3 — Parallel-agent conventions (2026-08-08)

Component code lives under `src/<component>/` with a local `index.ts`.
`src/types.ts` is the shared contract; component agents do not edit it or
`src/index.ts` concurrently — top-level exports are wired after each wave.
