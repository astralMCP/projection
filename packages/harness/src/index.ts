/**
 * @mccircuit/harness — a scenario-driven test harness for McCircuit.
 *
 * Drives `execute_machine` through the full MRTR round-trip loop under a
 * scripted answer policy, records the side effects that actually reached the
 * wrapped server, and reports enough to assert the approval invariants and
 * the Section 10 budgets (blob size, round-trip counts). The bundled tests
 * cover S1 (only two tools exposed), S2 (approval binds the sealed call),
 * S3/S4 (tampered blobs execute nothing), S5 (annotation-driven policy) and
 * S6 (server-derived prompt copy).
 *
 * The Anthropic-SDK-driven reasoning loop (a model authoring machines) is a
 * separate layer built on top of this; this package is deterministic and
 * CI-runnable on its own.
 */

export { runScenario } from './runner.js';
export {
  createRecordingServer,
  createFileServer,
  type RecordingServer,
  type RecordingTool,
} from './recording-server.js';
export {
  approveAll,
  declineAll,
  denyKeys,
  ignoreKeys,
  tamperCiphertext,
  truncateState,
} from './scenarios.js';
export type {
  PromptView,
  RoundRecord,
  RunStatus,
  Scenario,
  ScenarioResult,
  SideEffect,
  StateMutator,
  VerdictPolicy,
} from './types.js';
