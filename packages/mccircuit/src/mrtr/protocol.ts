/**
 * MRTR wire vocabulary (MCP 2026-07-28, SEP-2322).
 *
 * Everything on the wire comes from `@modelcontextprotocol/server@2.x`,
 * which ships MRTR as a stable surface: `InputRequiredResult`,
 * `InputRequest(s)`, `InputResponse(s)`, the `inputRequired()` builder and
 * the `inputResponse()` / `acceptedContent()` readers. Hand-rolling a
 * parallel definition of a stable wire format only invites silent drift, so
 * this module re-exports the SDK's types and keeps exactly three things the
 * SDK genuinely does not provide (see below) — docs/DECISIONS.md D1.
 */

import type {
  ElicitRequestFormParams,
  HandlerResultTypeMap,
  InputResponses,
  ProtocolEra,
} from '@modelcontextprotocol/server';

export {
  acceptedContent,
  inputRequired,
  inputResponse,
  isInputRequiredResult,
} from '@modelcontextprotocol/server';
export type {
  CallToolResult,
  ContentBlock,
  InputRequest,
  InputRequests,
  InputRequiredResult,
  InputResponse,
  InputResponses,
  InputResponseView,
  ProtocolEra,
} from '@modelcontextprotocol/server';

/**
 * What a `tools/call` handler may return on the 2026-07-28 era: a finished
 * result, or the input-required suspension. This is the SDK's own
 * handler-return type for the method, not a shape of ours.
 */
export type ToolCallResult = HandlerResultTypeMap['tools/call'];

/**
 * The MRTR retry fields the client re-sends alongside the original
 * arguments. The SDK lifts them off the params into `ctx.mcpReq`, so a
 * handler never reads them from `args`; McCircuit still names them because
 * `executeMachine` is callable outside an SDK handler (R27 — the facade is
 * plain functions).
 *
 * `inputResponses` is deliberately widened the same way the SDK's own
 * `inputResponse()` / `acceptedContent()` readers widen it: the values come
 * from the client and are never validated by the SDK, so a caller may hand
 * over whatever the wire carried.
 */
export interface RetryEnvelope {
  /** The `requestState` echoed back unchanged. */
  requestState?: string;
  /** Answers keyed by the same keys as `inputRequests`. */
  inputResponses?: InputResponses | Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The three things the SDK does not provide
// ---------------------------------------------------------------------------

/**
 * The JSON Schema an approval elicitation asks the client to collect, typed
 * as the SDK's restricted elicitation schema so `inputRequired.elicit()`
 * accepts it without a cast.
 *
 * McCircuit-specific: MRTR carries whatever schema the server asks for, and
 * an approval prompt whose only payload is an optional decline reason is our
 * product decision (R16/R17), not a protocol shape.
 */
export const APPROVAL_SCHEMA: ElicitRequestFormParams['requestedSchema'] = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      description: 'Optional note shown to the model when declining.',
    },
  },
  additionalProperties: false,
};

/**
 * Protocol revision that introduced MRTR.
 *
 * The SDK has no exported constant for it: `LATEST_PROTOCOL_VERSION` and
 * `SUPPORTED_PROTOCOL_VERSIONS` cover the *legacy* (`initialize`-negotiated)
 * family only — `2025-11-25` and earlier. The 2026-07-28 era is selected by
 * `server/discover`, and the SDK models it as the `ProtocolEra` value
 * `'modern'` rather than as a version string. We keep the literal purely so
 * error copy can name the revision a client must speak (R28).
 */
export const MRTR_PROTOCOL_REVISION = '2026-07-28';

/**
 * Whether the era a request is being served on can carry MRTR (R28).
 *
 * The SDK binds an era to the *serving instance*, not to a per-request
 * header: `createMcpHandler` / `serveStdio` hand the era to the server
 * factory as `McpRequestContext.era`, and a hand-connected `McpServer` is
 * always `'legacy'`. So this takes the era, not a version string — there is
 * no `extra.protocolVersion` to read, and reading one was the bug this
 * migration fixes (docs/DECISIONS.md D1).
 */
export function supportsMrtr(era: ProtocolEra | undefined): boolean {
  return era === 'modern';
}
