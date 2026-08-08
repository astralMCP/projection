/**
 * MRTR wire types (MCP 2026-07-28, SEP-2322).
 *
 * These are defined here rather than imported from the MCP SDK because the
 * released SDK line does not yet carry the MRTR result shape — see
 * docs/DECISIONS.md D1. The MRTR adapter is the only component that touches
 * them (PRD §7), so adopting the official types later replaces one module.
 */

/** Discriminator on a `tools/call` result. */
export type ResultType = 'complete' | 'input_required';

/** An elicitation request presented to the user for one gated call. */
export interface ElicitationRequest {
  type: 'elicitation';
  /** Human-readable prompt built from server-side data only (S6). */
  message: string;
  /** Short title for the prompt. */
  title?: string;
  /** JSON Schema of the response the client should collect. */
  requestedSchema: Record<string, unknown>;
}

/** A `tools/call` result that needs more input before it can finish. */
export interface InputRequiredResult {
  resultType: 'input_required';
  /** Keyed requests the client must answer, all in one round trip (R15). */
  inputRequests: Record<string, ElicitationRequest>;
  /** Opaque sealed blob the client echoes back verbatim (R19). */
  requestState: string;
  /** Content shown alongside the prompts (logs, progress). */
  content?: ContentBlock[];
}

/** A finished `tools/call` result. */
export interface CompleteResult {
  resultType?: 'complete';
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type ToolCallResult = CompleteResult | InputRequiredResult;

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'resource_link'; uri: string; name?: string; description?: string; mimeType?: string };

/** One answer the client collected for an `inputRequests` entry. */
export interface ElicitationResponse {
  type: 'elicitation';
  /** `accept` approves, `decline`/`cancel` do not. */
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

/** The arguments of a retried `tools/call`, per MRTR. */
export interface RetryEnvelope {
  /** Answers keyed by the same keys as `inputRequests`. */
  inputResponses?: Record<string, ElicitationResponse>;
  /** The `requestState` echoed back unchanged. */
  requestState?: string;
}

/** The JSON Schema an approval elicitation asks the client to collect. */
export const APPROVAL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      description: 'Optional note shown to the model when declining.',
    },
  },
  additionalProperties: false,
};

/** Protocol revision that introduced MRTR. */
export const MRTR_PROTOCOL_REVISION = '2026-07-28';

/**
 * Whether a client's negotiated protocol revision can carry MRTR (R28).
 *
 * Revisions are date strings, so a lexicographic comparison orders them.
 */
export function supportsMrtr(protocolVersion: string | undefined): boolean {
  return protocolVersion !== undefined && protocolVersion >= MRTR_PROTOCOL_REVISION;
}
