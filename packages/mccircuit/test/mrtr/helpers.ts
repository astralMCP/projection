/**
 * Shared narrowing helpers for the SDK's MRTR result shapes.
 *
 * The suspension result and the embedded input requests are the SDK's own
 * types now, so `inputRequests` is optional, its values are a union across
 * elicitation / sampling / roots, and an elicitation's params are themselves
 * a form/URL union. These helpers do the narrowing once so assertions read
 * as assertions.
 */

import {
  isInputRequiredResult,
  type CallToolResult,
  type InputRequiredResult,
  type InputResponse,
  type ToolCallResult,
} from '../../src/mrtr/index.js';

export function isSuspended(result: ToolCallResult): result is InputRequiredResult {
  return isInputRequiredResult(result);
}

/** The suspension, or a loud failure naming what came back instead. */
export function suspension(result: ToolCallResult): InputRequiredResult {
  if (!isInputRequiredResult(result)) {
    throw new Error(`expected an input_required suspension, got ${JSON.stringify(result)}`);
  }
  return result;
}

/** The completed `tools/call` result (an `isError` result still counts). */
export function completed(result: ToolCallResult): CallToolResult {
  if (isInputRequiredResult(result)) {
    throw new Error('expected a completed result, got an input_required suspension');
  }
  return result;
}

/**
 * A completed result's `structuredContent`, indexable.
 *
 * The SDK types the field as the open `{}` (any object is legal structured
 * content), so tests that read known keys go through this.
 */
export function structured(result: ToolCallResult): Record<string, unknown> {
  return (completed(result).structuredContent ?? {}) as Record<string, unknown>;
}

/** The sealed blob a suspension carries. */
export function sealedState(result: ToolCallResult): string {
  const state = suspension(result).requestState;
  if (state === undefined) throw new Error('suspension carried no requestState');
  return state;
}

/** The keys of a suspension's `inputRequests` map. */
export function requestKeys(result: ToolCallResult): string[] {
  return Object.keys(suspension(result).inputRequests ?? {});
}

/** The form-mode elicitation params a suspension carries under `key`. */
export function elicitation(
  result: ToolCallResult,
  key: string,
): { message: string; requestedSchema: Record<string, unknown> } {
  const request = suspension(result).inputRequests?.[key];
  if (request === undefined) throw new Error(`no input request under key "${key}"`);
  if (request.method !== 'elicitation/create') {
    throw new Error(`input request "${key}" is a ${request.method}, not an elicitation`);
  }
  const params = request.params;
  if (!('message' in params) || !('requestedSchema' in params)) {
    throw new Error(`elicitation "${key}" is URL-mode, not form-mode`);
  }
  return {
    message: params.message,
    requestedSchema: params.requestedSchema as unknown as Record<string, unknown>,
  };
}

/** A bare accepted elicitation result, as the client echoes it back. */
export const ACCEPT: InputResponse = { action: 'accept' };

/** A bare declined elicitation result, optionally carrying a reason. */
export function decline(reason?: string): InputResponse {
  return reason === undefined ? { action: 'decline' } : { action: 'decline', content: { reason } };
}
