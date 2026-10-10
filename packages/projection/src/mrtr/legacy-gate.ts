/**
 * The R28 down-negotiation gate, shared by `execute_machine` and `call_tool`.
 *
 * A client that cannot carry MRTR must fail at the moment a gated call would
 * suspend — never silently execute an unapproved write, never hang.
 *
 * The SDK would otherwise fulfil an `input_required` return on a legacy
 * connection through its server→client elicitation shim. By default
 * Projection refuses that path: R28 mandates a fail-fast error naming the
 * required revision, and the shim's push-style round trips hold a
 * connection open, which is exactly the statelessness (R27) the MRTR design
 * buys us. `legacyElicitation` opts in per facade (DECISIONS D6): the shim's
 * re-invocation carries the same requestState echo and inputResponses as a
 * real retry, so S2–S4 verification runs unchanged — only the transport of
 * the question differs. Even with the opt-in, the shim has no channel to a
 * client that never declared `elicitation`, and its own failure is an
 * unstructured SDK error; Projection fails first, in its own shape (R28
 * amendment). S2 holds on every branch — nothing has executed.
 */

import { ProjectionError } from '../errors.js';
import { MRTR_PROTOCOL_REVISION, supportsMrtr, type ProtocolEra } from './protocol.js';

export interface LegacyGateInput {
  protocolEra?: ProtocolEra | undefined;
  legacyElicitation?: boolean | undefined;
  clientCanElicit?: boolean | undefined;
}

export interface LegacyGateCopy {
  /** Who needs the approval, e.g. `this machine` / `this call`. */
  subject: string;
  /** The read-only alternative the hint leads with, e.g. `Author a machine that only calls read-only tools`. */
  readOnlyAdvice: string;
}

/**
 * The structured `protocol` error a suspension must return on this
 * connection, or `undefined` when suspending is allowed.
 */
export function legacySuspendError(
  input: LegacyGateInput,
  copy: LegacyGateCopy,
): ProjectionError | undefined {
  if (supportsMrtr(input.protocolEra)) return undefined;
  if (input.legacyElicitation !== true) {
    return new ProjectionError(
      'protocol',
      `${copy.subject} needs approval for a non-read-only tool call, which requires MCP protocol revision ${MRTR_PROTOCOL_REVISION} or later (this request is being served on the ${input.protocolEra ?? 'legacy'} protocol era)`,
      {
        hint: `${copy.readOnlyAdvice}, or connect with a client that negotiates the ${MRTR_PROTOCOL_REVISION} revision (SDK v2: \`versionNegotiation: { mode: "auto" }\`).`,
      },
    );
  }
  if (input.clientCanElicit === false) {
    return new ProjectionError(
      'protocol',
      `${copy.subject} needs approval for a non-read-only tool call, but the connected client cannot receive approval prompts (it did not declare the MCP elicitation capability on this pre-${MRTR_PROTOCOL_REVISION} connection)`,
      {
        hint: `${copy.readOnlyAdvice}, or connect with a client that supports elicitation or negotiates the ${MRTR_PROTOCOL_REVISION} revision.`,
      },
    );
  }
  return undefined;
}
