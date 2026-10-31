---
name: authoring-machines
description: Cheat sheet for writing XState machine modules that run under Projection's execute_machine — the authoring contract, the toolCall event protocol, banned patterns, and how to test machines with the harness. Use when writing test fixtures, scenarios, or benchmark tasks.
---

# Authoring machines for execute_machine

The canonical contract is generated at runtime (`discover_apis` /
`projection://docs/authoring-contract.md`, built from
`packages/projection/src/machine-host/contract.ts`); PRD §6.2 (R5–R9) is the
normative source. This is the working cheat sheet.

## Shape

```ts
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

// run with input: { path }
export default setup({}).createMachine({
  id: 'writeOne',
  context: ({ input }) => ({ path: input.path, status: 'pending' }), // JSON-serializable, always (R6)
  initial: 'writing',
  states: {
    writing: {
      entry: toolCall('write_file', ({ context }) => ({ path: context.path, content: 'hi' }), {
        id: 'w1',
      }),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: 'written' }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'skipped' }) }, // denial ≠ abort
        TOOL_ERROR: { target: 'done', actions: assign({ status: 'failed' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status }),
});
```

## Rules

- Default-export one machine from `setup(...).createMachine(...)`. Nothing
  else at module top level — the module re-evaluates on every resume (R5).
  XState v4 `Machine(...)` is rejected (`validate` phase). XState is pinned
  at 5.32.5.
- Context must survive `JSON.parse(JSON.stringify(...))` — no Map, Set, Date,
  class instances, functions, `undefined`, bigint or symbols (R6). Validation
  rejects violations with named paths.
- **Never** `invoke` / `fromPromise` (R7): restored snapshots restart
  invoked actors, which would re-execute approved writes. Use `toolCall` +
  the three events; the host does all I/O.
- Only `xstate` and `@astral-mcp/tools` resolve as imports (R8). No fs, no
  fetch, no other modules.
- On a multi-server facade (`wrapMcpServers`, R45) every tool name is
  qualified, `<alias>.<name>`: `toolCall('fs.read_file', …)`,
  `toolCall('github.issue_write', …)`. An unqualified name fails `validate`
  with a did-you-mean hint. A server's dotted tool name stays in its box
  (`fs.github.delete_repo` is the `fs` box's `github.delete_repo`). The
  `.d.ts` nests each box under `tools.<alias>`, with type names like
  `fs_ReadFileInput`; the contract text gains rule 10 and its samples call
  tools of the first alias in sorted order (real ones when that box has a
  read-only and a gated tool, else marked "sample names"). Default ids are
  `<qualified name>#N`; as on one server, calls outstanding at once
  (parallel regions) need explicit ids and `whenCall` guards. One machine
  may span boxes; each gated call is approved separately (parallel ones
  share one round trip). Test with
  `wrapMcpServers({ fs: …, github: … }, { blob: { key } })` — see
  `packages/projection/test/multi/code-mode.test.ts` and the recording
  servers in `test/multi/helpers.ts`.
- After a `toolCall`, wait in a state for one of these events, each carrying
  the `callId` of the call it answers:
  - `TOOL_RESULT { callId, result, notes? }` — the call succeeded; `notes`
    (D29), when present, are one-line remarks such as "Partial result: …"
    or "Page full: …", also restated after a completed run's output
  - `TOOL_ERROR { callId, error }` — the call failed
  - `TOOL_DENIED { callId, reason }` — the user declined, or policy denies it

  `toolCall(name, args, { id })` sets the id; the default is `name#N`. If
  more than one call is outstanding at once (parallel regions), give each
  `toolCall` an explicit id and guard every waiting state with
  `whenCall(id)` — events reach every region that can handle them, so an
  unguarded region consumes another call's result.

  For one gated call per item, use `toolCalls(name, argsList, { id })`:
  one action queues a call per item (ids `<id>#0`, `<id>#1`, …), so all
  of them share one approval round trip, where a call per state costs one
  each and stops unfinished at `caps.maxRoundTrips` (8). Guard with
  `whenCallIn(id)` and count answers until every call has one (contract
  rule 5, D30).

- `event.result` on `TOOL_RESULT` is the tool's `structuredContent` when the
  server returns one (see its Output type in `tools.d.ts`); otherwise the
  text of its single text block — parsed when it is JSON for an object or
  an array, with the raw text on `event.text` (D29) — `null` for an empty
  result, or the raw content array for anything else. Tools without an Output type are typed
  `unknown` — not necessarily a string: many servers return
  `structuredContent` without declaring a schema (the MongoDB server's
  `count` returns `{ count: 4 }`). A
  tool returning `isError` arrives as `TOOL_ERROR`.
- Contract item 5: tools marked "asks for approval" suspend the machine for
  approval; tools marked "runs immediately" (read-only, `auto` by policy, or,
  under `approvals: 'destructive-only'`, a declared non-destructive write)
  run inline. Read the posture from the `.d.ts` doc comment or
  `search_tools`, not the annotations. Handle all three events: a waiting
  state with no handler for the incoming event fails with a `runtime` error ("the
  machine is stuck in state … with no pending tool call and no final
  state"). A `deny` policy arrives as `TOOL_DENIED` with the policy reason
  (`policyDeniedReason` in `packages/projection/src/policy/decision.ts`:
  `… tool "<name>" is configured as deny`).
- Caps (R12, overridable per facade; see R12 in `docs/PRD.md` for all ten):
  structured `cap_exceeded` errors name the limit.

## Errors come back structured (R25)

Every failure is `isError: true` with `structuredContent` carrying
`phase` (`transpile | validate | runtime | cap_exceeded | blob_verification |
protocol | upstream | terminal`), `message`, `hint`, and `logs`. `upstream`
is returned only by `call_tool`; inside a machine a failing tool is a
`TOOL_ERROR` event, not a phase. `transpile`/`validate` mean the machine
never ran — that's the §10 "invalid machine" definition the benchmark
counts.

## Testing machines

Deterministic, no model, no network — this is how the harness scenarios work:

```ts
import { randomBytes } from 'node:crypto';
import { wrapMcpServer } from '@astral-mcp/projection';
import { createFileServer, runScenario, denyKeys } from '@astral-mcp/harness';

const file = createFileServer({ '/notes.txt': 'seed' });
const facade = await wrapMcpServer(file.server, { blob: { key: randomBytes(32) } });
const result = await runScenario(facade, file, {
  name: 'x',
  code: MACHINE_SOURCE,
  input: { path: '/notes.txt' },
  verdicts: denyKeys('w1'), // 'w1' is the toolCall id in the Shape above
});
// result.status / .output / .sideEffects / .rounds / .maxBlobBytes
await facade.close();
```

- `denyKeys` / `ignoreKeys` match the `toolCall` id — give gated calls an
  explicit id (the Shape's `w1`); without one the default `write_file#1`
  would not match and the scenario approves everything.
- The Scenario's `input` field is the machine input (`context: ({ input })
=> …`); `lang` is `'ts'` or `'js'`.
- `runScenario` drives only `execute_machine`. For the catalog tools call
  `facade.searchTools` / `describeTool` / `callTool` directly, or go over the
  wire with an SDK `Client` the way
  `packages/projection/test/integration/call-tool.test.ts` does.
- `createFileServer` — the standard fixture: `read_file`/`list_files`
  (read-only), `write_file` (gated), `delete_file` (destructive).
- Verdict scripts: `approveAll`, `declineAll`, `denyKeys`, `ignoreKeys`
  (omission = decline, R17). For hostile blobs, import the mutators
  `tamperCiphertext` / `truncateState` and pass one via the scenario's
  `tamper` field (scope to specific rounds with `tamperRounds`).
- For model-in-the-loop shapes use `createScriptedAuthor` (deterministic
  attempt sequence) with `runReasoningTask` — see
  `packages/harness/test/reasoning.test.ts`.
- Interactive/manual: `pnpm --filter @astral-mcp/tui start`.

Reference machines: `EXAMPLE_HAPPY_PATH` / `EXAMPLE_DENIAL_FALLBACK` in
`packages/projection/src/mrtr/discover.ts`, and the fixtures in
`packages/harness/test/` and `packages/tui/test/`. `EXAMPLE_HAPPY_PATH` runs
against `createFileServer` with `input: { path }`; `EXAMPLE_DENIAL_FALLBACK`
calls `list_dir` (the fixture has `list_files`) and needs
`input: { path, dir }`.
