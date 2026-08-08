/**
 * MRTR adapter and the exposed tool surface (PRD §7, R1–R3, R15–R18, R27–R29).
 *
 * This is the only component that touches MCP wire types. The MRTR shapes
 * are defined locally because the released SDK line does not carry them yet
 * (docs/DECISIONS.md D1).
 */

export { executeMachine, type ExecuteMachineArgs, type ExecuteMachineDeps } from './adapter.js';
export {
  buildInstructions,
  buildResources,
  discoverApis,
  DEFAULT_CODE_MODE_PREAMBLE,
  EXAMPLE_DENIAL_FALLBACK,
  EXAMPLE_HAPPY_PATH,
  RESOURCE_URIS,
  type McCircuitResource,
} from './discover.js';
export {
  APPROVAL_SCHEMA,
  MRTR_PROTOCOL_REVISION,
  supportsMrtr,
  type CompleteResult,
  type ContentBlock,
  type ElicitationRequest,
  type ElicitationResponse,
  type InputRequiredResult,
  type ResultType,
  type RetryEnvelope,
  type ToolCallResult,
} from './protocol.js';
