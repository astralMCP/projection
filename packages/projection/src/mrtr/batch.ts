/**
 * Batched approval prompts (opt-in, `WrapOptions.approvalPrompts:
 * 'batched'`; DECISIONS D25).
 *
 * When one suspension holds several gated calls (R15: a machine that
 * requests them in the same step), the per-call layout sends one
 * elicitation per call, and a host shows the person one prompt per call.
 * The batched layout sends ONE elicitation listing every call — each in
 * its full R16 copy under a `[k]` header — whose form has one boolean per
 * call (`approve_k`, unticked: the person ticks what they approve) and the
 * usual optional `reason`.
 *
 * Nothing about what is approved changes (S2): the sealed `pending` map is
 * still the only source of the calls that can run, one entry per call, and
 * a call runs only when ITS boolean comes back exactly `true` inside an
 * accepted response. The fields carry no `default`: a client that fills
 * defaults into an empty accept (the SDK's `elicitation.form.applyDefaults`)
 * must not approve anything the person did not tick.
 *
 * The layout is decided when the suspension is minted and SEALED in the
 * blob (`prompts: 'batched'`); the resume reads the sealed value, never the
 * resuming instance's option, so a blob minted batched and resumed by a
 * per-call instance (or the reverse) is still answered the way it was
 * asked. The batch key lives in a reserved namespace (`projection:`): a
 * machine call id with that prefix is a `validate` error, so no call can be
 * keyed where the batched answer lives. A batch is capped by call count
 * and message length; above either cap the suspension falls back to
 * per-call prompts.
 *
 * Copy (S6): the message is the R16 copy of each call, unchanged, under a
 * library-written header; the field titles repeat the R16 titles, which
 * are catalog-derived and neutralized. Model-authored values stay inside
 * the indented JSON blocks and quoted footers, so none can start a `[k]`
 * line and forge another call's section.
 */

import type { ElicitRequestFormParams } from '@modelcontextprotocol/server';
import type { ElicitationCopy } from '../policy/index.js';
import type { ApprovalVerdict, PendingToolCall } from '../types.js';
import {
  inputResponse,
  type InputRequests,
  inputRequired,
  type RetryEnvelope,
} from './protocol.js';

/** How a suspension with several gated calls is put to the person. */
export type ApprovalPrompts = 'per-call' | 'batched';

/**
 * Call ids with this prefix are reserved for Projection's own
 * inputRequests keys; a machine `toolCall` id using it is rejected.
 */
export const RESERVED_ID_PREFIX = 'projection:';

/** The single inputRequests key of a batched prompt (reserved namespace). */
export const BATCH_KEY = `${RESERVED_ID_PREFIX}approvals`;

/** Most calls one batched prompt lists; above it, per-call prompts. */
export const MAX_BATCH_CALLS = 10;
/** Longest batched message; above it, per-call prompts. */
export const MAX_BATCH_MESSAGE_CHARS = 20_000;

/** The boolean field that carries the verdict of the call at 0-based position `i`. */
export function batchField(i: number): string {
  return `approve_${i + 1}`;
}

/** Digit runs compared by value, so `call-2` sorts before `call-10`. */
function orderKey(key: string): string {
  return key.replace(/\d+/g, (digits) => digits.padStart(16, '0'));
}

/**
 * The pending keys in display order. Sorted, not insertion order, so the
 * mapping from field to call never depends on how the blob serializer
 * orders object keys.
 */
export function batchOrder(pending: Record<string, PendingToolCall>): string[] {
  return Object.keys(pending).toSorted((a, b) => {
    const x = orderKey(a);
    const y = orderKey(b);
    return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * The layout a new suspension gets: batched only when the facade asks for
 * it, the suspension holds 2..MAX_BATCH_CALLS calls, no pending key sits in
 * the reserved namespace, and the batched message fits
 * MAX_BATCH_MESSAGE_CHARS. The result is sealed in the blob.
 */
export function chooseLayout(
  mode: ApprovalPrompts | undefined,
  pending: Record<string, PendingToolCall>,
  copies: readonly ElicitationCopy[],
): ApprovalPrompts {
  const keys = Object.keys(pending);
  if (mode !== 'batched' || keys.length < 2 || keys.length > MAX_BATCH_CALLS) return 'per-call';
  if (keys.some((key) => key.startsWith(RESERVED_ID_PREFIX))) return 'per-call';
  return batchedMessage(copies).length <= MAX_BATCH_MESSAGE_CHARS ? 'batched' : 'per-call';
}

function batchedMessage(copies: readonly ElicitationCopy[]): string {
  const header = `Approve ${copies.length} actions? Each one is approved or declined on its own: tick the ones you approve, or decline to refuse them all.`;
  const sections = copies.map((copy, i) => `[${i + 1}] ${copy.title}\n\n${copy.message}`);
  return [header, ...sections].join('\n\n');
}

/** The one elicitation that lists every pending call (`copies` in {@link batchOrder}). */
export function batchedInputRequests(copies: readonly ElicitationCopy[]): InputRequests {
  const properties: Record<string, unknown> = {};
  copies.forEach((copy, i) => {
    // No `default`: see the module comment (applyDefaults).
    properties[batchField(i)] = { type: 'boolean', title: `[${i + 1}] ${copy.title}` };
  });
  properties['reason'] = {
    type: 'string',
    description: 'Optional note shown to the model for the actions you decline.',
  };
  const requestedSchema = {
    type: 'object',
    properties,
    additionalProperties: false,
  } as unknown as ElicitRequestFormParams['requestedSchema'];
  return {
    [BATCH_KEY]: inputRequired.elicit({
      message: batchedMessage(copies),
      requestedSchema,
    }),
  };
}

/**
 * The verdict for every pending call from a batched answer. Only an
 * accepted response approves anything, and then only the calls whose field
 * is exactly `true`; anything else — a declined, cancelled or missing
 * answer, a missing or non-boolean field — declines that call (R17). The
 * decline reason, if any, rides on every declined call.
 */
export function batchedVerdicts(
  responses: RetryEnvelope['inputResponses'],
  pending: Record<string, PendingToolCall>,
  readReason: (content: Record<string, unknown> | undefined) => string | undefined,
): Record<string, ApprovalVerdict> {
  const view = inputResponse(responses, BATCH_KEY);
  const content =
    view.kind === 'elicit' ? (view.content as Record<string, unknown> | undefined) : undefined;
  const reason = view.kind === 'elicit' ? readReason(content) : undefined;
  const accepted = view.kind === 'elicit' && view.action === 'accept';
  const declined: ApprovalVerdict =
    reason !== undefined ? { kind: 'declined', reason } : { kind: 'declined' };
  const verdicts: Record<string, ApprovalVerdict> = {};
  batchOrder(pending).forEach((key, i) => {
    const field =
      content !== undefined && Object.hasOwn(content, batchField(i))
        ? content[batchField(i)]
        : undefined;
    verdicts[key] = accepted && field === true ? { kind: 'approved' } : declined;
  });
  return verdicts;
}
