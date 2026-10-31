/**
 * Batched approval prompts (opt-in, `WrapOptions.approvalPrompts:
 * 'batched'`; DECISIONS D22).
 *
 * When one suspension holds several gated calls (R15: a machine that
 * requests them in the same step), the per-call layout sends one
 * elicitation per call, and a host shows the person one prompt per call.
 * The batched layout sends ONE elicitation listing every call — each in
 * its full R16 copy under a `[k]` header — whose form has one boolean per
 * call (`approve_k`, pre-ticked) and the usual optional `reason`.
 *
 * Nothing about what is approved changes (S2): the sealed `pending` map is
 * still the only source of the calls that can run, one entry per call, and
 * a call runs only when ITS boolean comes back exactly `true` inside an
 * accepted response. The presentation is not recorded in the blob: it is a
 * pure function of the facade's option and the sealed `pending` keys, so
 * the resume re-derives it. A blob minted under one layout and resumed
 * under the other finds no answer under the keys it reads, and R17 turns a
 * missing answer into a decline: every call declined, nothing executed.
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

/** The single inputRequests key of a batched prompt. */
export const BATCH_KEY = 'approvals';

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

/** Whether this suspension is put as one batched prompt. */
export function isBatched(
  mode: ApprovalPrompts | undefined,
  pending: Record<string, PendingToolCall>,
): boolean {
  return mode === 'batched' && Object.keys(pending).length >= 2;
}

/** The one elicitation that lists every pending call (`copies` in {@link batchOrder}). */
export function batchedInputRequests(copies: readonly ElicitationCopy[]): InputRequests {
  const n = copies.length;
  const header = `Approve ${n} actions? Each one is approved or declined on its own: untick any you do not want, or decline to refuse them all.`;
  const sections = copies.map((copy, i) => `[${i + 1}] ${copy.title}\n\n${copy.message}`);
  const properties: Record<string, unknown> = {};
  copies.forEach((copy, i) => {
    properties[batchField(i)] = {
      type: 'boolean',
      title: `[${i + 1}] ${copy.title}`,
      default: true,
    };
  });
  properties['reason'] = {
    type: 'string',
    description: 'Optional note shown to the model for the actions you decline.',
  };
  const requestedSchema = {
    type: 'object',
    properties,
    required: copies.map((_, i) => batchField(i)),
    additionalProperties: false,
  } as unknown as ElicitRequestFormParams['requestedSchema'];
  return {
    [BATCH_KEY]: inputRequired.elicit({
      message: [header, ...sections].join('\n\n'),
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
