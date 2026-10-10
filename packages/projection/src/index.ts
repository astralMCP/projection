/**
 * Projection — turn any MCP server into a code-mode server with
 * human-approved side effects.
 *
 * The library exposes only its own tools, never the wrapped server's (R1):
 * code mode's `execute_machine`, which runs an LLM-authored XState v5
 * machine in a QuickJS sandbox, and `discover_apis`, which describes the
 * wrapped server's tool API; and the catalog projection's `search_tools`,
 * `describe_tool` and `call_tool`, which run one tool at a time (R32–R38).
 * Read-only calls execute immediately; every other call suspends into a
 * sealed, encrypted blob and asks the user to approve that exact action.
 *
 * Because all suspension state travels in the MRTR `requestState` payload,
 * the library holds no cross-request state: any instance can resume any
 * workflow (R27).
 *
 * ```ts
 * import { createIntrospector, generateToolTypes, executeMachine } from '@astral-mcp/projection';
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
 *   protocolEra: 'modern',
 * });
 * ```
 */

// Entry point
export {
  wrapMcpServer,
  type ProjectionFacade,
  type ProjectionsOptions,
  type RegisterOptions,
  type WrapOptions,
} from './wrap.js';

// Catalog projection — search_tools / describe_tool / call_tool (PRD §6.8, R32–R38)
export {
  callTool,
  canonicalJson,
  canonicalRequest,
  describeTool,
  postureOf,
  sanitizeSchema,
  searchTools,
  summarizeTool,
  validateArgsShape,
  CALL_KEY,
  DEFAULT_CALL_TTL_MS,
  DEFAULT_SEARCH_PAGE_SIZE,
  MAX_QUERY_CHARS,
  MAX_SCHEMA_CHARS,
  SCHEMA_KEY_ALLOWLIST,
  type CallToolArgs,
  type CallToolDeps,
  type CallToolOutcome,
  type DescribeToolArgs,
  type DescribeToolOptions,
  type SanitizedSchema,
  type SearchToolsArgs,
  type SearchToolsOptions,
  type SearchToolsPage,
  type ToolDescription,
  type ToolPosture,
  type ToolSummary,
} from './catalog/index.js';

// Shared contract
export * from './types.js';
export { DASHBOARD_HTML, DASHBOARD_RESOURCE_URI, MCP_APP_MIME_TYPE } from './apps/dashboard.js';
export {
  SAVE_WORKFLOW_PROMPT,
  VISUALIZE_WORKFLOW_PROMPT,
  WORKFLOW_PROMPTS,
  type WorkflowPromptDefinition,
} from './prompts/workflow-prompts.js';
export { ProjectionError, toStructuredError } from './errors.js';

// Introspector — wrapped-server catalog and tool execution
export { createIntrospector, Introspector } from './introspector/index.js';

// Typegen — `@astral-mcp/tools` artifacts
export {
  generateToolTypes,
  schemaToTsType,
  schemaRequiresArgs,
  TOOLS_MODULE_SPECIFIER,
  TOOL_CALL_HOST_GLOBAL,
  type GeneratedToolTypes,
  type ToolTypeText,
} from './typegen/index.js';

// Text safety — inert rendering of untrusted strings (S5, S6)
export { capLength, neutralizeControlChars } from './text-safety.js';

// Policy engine — approval decisions and elicitation copy
export {
  buildElicitationCopy,
  decidePolicy,
  policyDeniedReason,
  purposeSentence,
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
  acceptedContent,
  buildInstructions,
  buildResources,
  defaultPreamble,
  discoverApis,
  errorResult,
  executeMachine,
  inputRequired,
  inputResponse,
  isInputRequiredResult,
  supportsMrtr,
  APPROVAL_SCHEMA,
  DEFAULT_CATALOG_PREAMBLE,
  DEFAULT_CODE_MODE_PREAMBLE,
  DEFAULT_INLINE_TOOL_THRESHOLD,
  DEFAULT_ROUTING_PREAMBLE,
  EXAMPLE_DENIAL_FALLBACK,
  EXAMPLE_HAPPY_PATH,
  MRTR_PROTOCOL_REVISION,
  RESOURCE_URIS,
  type ApprovalGateDeps,
  type CallToolResult,
  type ContentBlock,
  type DiscoverApisOptions,
  type ExecuteMachineArgs,
  type ExecuteMachineDeps,
  type InputRequest,
  type InputRequests,
  type InputRequiredResult,
  type InputResponse,
  type InputResponses,
  type InputResponseView,
  type ProjectionResource,
  type ProjectionSelection,
  type ProtocolEra,
  type RetryEnvelope,
  type ToolCallResult,
} from './mrtr/index.js';
