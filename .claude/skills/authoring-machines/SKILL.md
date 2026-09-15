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

export default setup({}).createMachine({
  id: 'writeNotes',
  context: { status: 'pending' }, // JSON-serializable, always (R6)
  initial: 'writing',
  states: {
    writing: {
      // '/notes.txt' is the test fixture's path; real machines take paths from input (rule 9)
      entry: toolCall('write_file', ({ context }) => ({ path: '/notes.txt', content: 'hi' })),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: 'written' }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'declined' }) }, // denial ≠ abort
        TOOL_ERROR: { target: 'done', actions: assign({ status: 'error' }) },
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
- Context must survive `JSON.parse(JSON.stringify(...))` — no `Map`, `Date`,
  functions, bigints (R6). Validation rejects violations with named paths.
- **Never** `invoke` / `fromPromise` (R7): restored snapshots restart
  invoked actors, which would re-execute approved writes. Use `toolCall` +
  the three events; the host does all I/O.
- Only `xstate` and `@astral-mcp/tools` resolve as imports (R8). No fs, no
  fetch, no other modules.
- Read-only tools (annotation `readOnlyHint: true`) run inline; everything
  else suspends for approval. Handle `TOOL_DENIED` as an ordinary
  transition — machines that treat denial as unreachable get stuck.
- Caps (R12, overridable per facade): state nodes, read calls per segment,
  code bytes, result bytes, round trips. Structured `cap_exceeded` errors
  name the limit.

## Errors come back structured (R25)

Every failure is `isError: true` with `structuredContent` carrying
`phase` (`transpile | validate | runtime | cap_exceeded | blob_verification |
protocol | terminal`), `message`, `hint`, and `logs` (tool failures are not a
phase — they surface to the machine as `TOOL_ERROR` events).
`transpile`/`validate` mean the machine never ran — that's the §10 "invalid machine" definition the
benchmark counts.

## Testing machines

Deterministic, no model, no network — this is how all CI tests work:

```ts
import { wrapMcpServer } from '@astral-mcp/projection';
import { createFileServer, runScenario, denyKeys } from '@astral-mcp/harness';

const file = createFileServer({ '/notes.txt': 'seed' });
const facade = await wrapMcpServer(file.server, { blob: { key: randomBytes(32) } });
const result = await runScenario(facade, file, {
  name: 'x',
  code: MACHINE_SOURCE,
  verdicts: denyKeys('w1'),
});
// result.status / .output / .sideEffects / .rounds / .maxBlobBytes
await facade.close();
```

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
`packages/harness/test/` and `packages/tui/test/`.
