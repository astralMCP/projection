/**
 * @astral-mcp/harness — a scenario-driven test harness for Projection.
 *
 * Drives `execute_machine` through the full MRTR round-trip loop under a
 * scripted answer policy, records the side effects that actually reached the
 * wrapped server, and reports enough to assert the approval invariants and
 * the Section 10 budgets (blob size, round-trip counts). The bundled tests
 * cover S1 (only two tools exposed), S2 (approval binds the sealed call),
 * S3/S4 (tampered blobs execute nothing), S5 (annotation-driven policy) and
 * S6 (server-derived prompt copy).
 *
 * The `reasoning/` layer builds the Anthropic-SDK-driven reasoning loop on
 * top (PRD §13): an author (a model, or a deterministic script in CI)
 * writes machines, executes them through the scenario runner, and self-heals
 * from structured errors; `summarizeSelfHeal` computes the §10 metrics.
 */

export { runScenario, type SideEffectLog } from './runner.js';
export { loadNearestDotEnv } from './env.js';
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

export {
  buildApiDocs,
  createScriptedAuthor,
  extractModuleSource,
  type AttemptErrorView,
  type AuthoringContext,
  type MachineAuthor,
} from './reasoning/author.js';
export { createAnthropicAuthor, type AnthropicAuthorOptions } from './reasoning/anthropic.js';
export {
  runReasoningTask,
  type AttemptRecord,
  type BenchmarkTask,
  type ReasoningOptions,
  type ReasoningResult,
} from './reasoning/loop.js';
export {
  formatSelfHealReport,
  summarizeSelfHeal,
  type SelfHealSummary,
} from './reasoning/metrics.js';
export { FILE_SERVER_TASKS, FILE_SERVER_FIXTURE } from './reasoning/tasks.js';
