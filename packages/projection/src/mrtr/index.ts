/**
 * MRTR adapter and the exposed tool surface (PRD §7, R1–R3, R15–R18, R27–R29).
 *
 * This is the only component that touches MCP wire types, and it takes them
 * from `@modelcontextprotocol/server@2.x` rather than defining its own
 * (docs/DECISIONS.md D1).
 */

export {
  assertNotReplayed,
  errorResult,
  executeMachine,
  type ApprovalGateDeps,
  type ExecuteMachineArgs,
  type ExecuteMachineDeps,
} from './adapter.js';
export {
  DEFAULT_REPLAY_CACHE_MAX_ENTRIES,
  MemoryReplayCache,
  type MemoryReplayCacheOptions,
} from './replay-cache.js';
export { legacySuspendError, type LegacyGateCopy, type LegacyGateInput } from './legacy-gate.js';
export {
  APPROVAL_SENTENCE_TAIL,
  buildInstructions,
  buildResources,
  defaultPreamble,
  discoverApis,
  DEFAULT_CATALOG_PREAMBLE,
  DEFAULT_INLINE_TOOL_THRESHOLD,
  DEFAULT_CODE_MODE_PREAMBLE,
  DEFAULT_ROUTING_PREAMBLE,
  DIRECT_LISTING_SENTENCE,
  EXAMPLE_DENIAL_FALLBACK,
  EXAMPLE_HAPPY_PATH,
  RESOURCE_URIS,
  type DiscoverApisOptions,
  type ProjectionResource,
  type ProjectionSelection,
} from './discover.js';
export {
  acceptedContent,
  inputRequired,
  inputResponse,
  isInputRequiredResult,
  APPROVAL_SCHEMA,
  MRTR_PROTOCOL_REVISION,
  supportsMrtr,
  type CallToolResult,
  type ContentBlock,
  type InputRequest,
  type InputRequests,
  type InputRequiredResult,
  type InputResponse,
  type InputResponses,
  type InputResponseView,
  type ProtocolEra,
  type RetryEnvelope,
  type ToolCallResult,
} from './protocol.js';
