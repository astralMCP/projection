/**
 * McCircuit — turn any MCP server into a code-mode server with
 * human-approved side effects.
 *
 * The library exposes exactly two tools (R1): `execute_machine`, which runs
 * an LLM-authored XState v5 machine in a QuickJS sandbox, and
 * `discover_apis`, which describes the wrapped server's tool API. Read-only
 * calls execute immediately; every other call suspends the machine into a
 * sealed, encrypted blob and asks the user to approve that exact action.
 *
 * Because all suspension state travels in the MRTR `requestState` payload,
 * the library holds no cross-request state: any instance can resume any
 * workflow (R27).
 *
 * ```ts
 * import { createIntrospector, generateToolTypes, executeMachine } from 'mccircuit';
 *
 * const introspector = await createIntrospector({ default: myMcpServer });
 * const catalog = introspector.catalog.servers.get('default')!;
 * const { bridgeSource, dts, overview } = generateToolTypes(catalog);
 *
 * const result = await executeMachine(toolArgs, {
 *   catalog,
 *   bridgeSource,
 *   executor: introspector,
 *   blob: { key: myThirtyTwoByteKey },
 *   protocolVersion: negotiatedRevision,
 * });
 * ```
 */

// Shared contract
export * from './types.js';
export { McCircuitError, toStructuredError } from './errors.js';

// Introspector — wrapped-server catalog and tool execution
export { createIntrospector, Introspector } from './introspector/index.js';

// Typegen — `@mccircuit/tools` artifacts
export {
  generateToolTypes,
  schemaToTsType,
  schemaRequiresArgs,
  TOOLS_MODULE_SPECIFIER,
  TOOL_CALL_HOST_GLOBAL,
  type GeneratedToolTypes,
} from './typegen/index.js';

// Policy engine — approval decisions and elicitation copy
export {
  buildElicitationCopy,
  decidePolicy,
  policyDeniedReason,
  resolveCallPolicy,
  POLICY_DENIED_REASON,
  type ElicitationCopy,
  type ElicitationCopyOptions,
  type ResolvedCallPolicy,
} from './policy/index.js';

// Blob sealer — the sealed `requestState` payload
export {
  buildBlobPayload,
  hashCode,
  openBlob,
  sealBlob,
  DEFAULT_MAX_BLOB_BYTES,
  DEFAULT_TTL_MS,
  ENVELOPE_PREFIX,
  LIB_VERSION,
  XSTATE_VERSION,
  type OpenBlobOptions,
} from './blob/index.js';

// Sandbox runtime — QuickJS execution with hard caps
export {
  createSandboxSession,
  type SandboxSession,
  type SandboxSessionOptions,
  type SandboxToolCall,
  type SandboxToolCallHandler,
} from './sandbox/index.js';

// Machine host — the authoring contract and segment execution
export { runSegment, AUTHORING_CONTRACT, type RunSegmentOptions } from './machine-host/index.js';

// MRTR adapter — the exposed tool surface
export {
  buildInstructions,
  buildResources,
  discoverApis,
  executeMachine,
  supportsMrtr,
  APPROVAL_SCHEMA,
  DEFAULT_CODE_MODE_PREAMBLE,
  EXAMPLE_DENIAL_FALLBACK,
  EXAMPLE_HAPPY_PATH,
  MRTR_PROTOCOL_REVISION,
  RESOURCE_URIS,
  type CompleteResult,
  type ContentBlock,
  type ElicitationRequest,
  type ElicitationResponse,
  type ExecuteMachineArgs,
  type ExecuteMachineDeps,
  type InputRequiredResult,
  type McCircuitResource,
  type RetryEnvelope,
  type ToolCallResult,
} from './mrtr/index.js';
