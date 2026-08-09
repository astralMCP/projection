# @mccircuit/harness

A scenario-driven test harness for [McCircuit](../mccircuit). It drives
`execute_machine` through the full MRTR round-trip loop under a scripted
answer policy, records the side effects that actually reached the wrapped
server, and reports enough to assert the approval invariants and the PRD
Section 10 budgets (blob size, round-trip counts). The bundled tests cover
S1 (only the two code-mode tools exposed), S2 (approval binds the sealed
call), S3/S4 (tampered and truncated blobs execute nothing), S5
(annotation-driven policy), and S6 (server-derived prompt copy).

This layer is deterministic and CI-runnable on its own. The
Anthropic-SDK-driven reasoning loop — a model authoring machines against task
prompts and self-healing from structured errors — builds on top of this and
lands separately.

## Usage

```ts
import { wrapMcpServer } from 'mccircuit';
import { createFileServer, runScenario, denyKeys } from '@mccircuit/harness';

const file = createFileServer({ '/notes.txt': 'original' });
const facade = await wrapMcpServer(file.server, { blob: { key } });

const result = await runScenario(facade, file, {
  name: 'deny-the-write',
  code: machineSource,
  verdicts: denyKeys('w1'), // approve everything except call "w1"
});

result.status; // 'completed' | 'error' | 'aborted_round_limit'
result.sideEffects; // every tool the wrapped server actually executed
result.maxBlobBytes; // largest sealed requestState seen
```

## Scenario scripts (PRD §13)

| Helper                | Models                                            |
| --------------------- | ------------------------------------------------- |
| `approveAll`          | user approves every prompt                        |
| `declineAll(reason?)` | user declines everything                          |
| `denyKeys(...keys)`   | decline specific calls, approve the rest          |
| `ignoreKeys(...keys)` | omit responses entirely (R17: treated as decline) |
| `tamperCiphertext`    | flip a byte of the sealed blob (S3)               |
| `truncateState`       | corrupt the blob in transit                       |

A scenario may also set `tamper` (with optional `tamperRounds`) to mutate
the `requestState` before a retry.

The `test/` suite asserts, against a real wrapped `McpServer`: approved
writes execute; declined and ignored calls never reach the server; tampered
and truncated blobs fail verification with no side effect; and — in
`replay.test.ts` — the documented D4 in-TTL replay behaviour, so a future
replay-cache fix has a regression to flip.
