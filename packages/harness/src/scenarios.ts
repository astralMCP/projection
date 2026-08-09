/**
 * Reusable verdict policies and blob mutators for scenario scripts
 * (PRD §13: approve all / deny one / ignore one / tamper / replay).
 */

import type { InputResponse } from 'mccircuit';
import type { StateMutator, VerdictPolicy } from './types.js';

/** Approve every prompt. */
export const approveAll: VerdictPolicy = () => ({ action: 'accept' });

/** Decline every prompt, optionally with a reason. */
export function declineAll(reason?: string): VerdictPolicy {
  return () =>
    reason === undefined ? { action: 'decline' } : { action: 'decline', content: { reason } };
}

/** Approve everything except the named keys, which are declined. */
export function denyKeys(...keys: string[]): VerdictPolicy {
  const denied = new Set(keys);
  return ({ key }): InputResponse =>
    denied.has(key) ? { action: 'decline' } : { action: 'accept' };
}

/** Approve everything except the named keys, which are omitted entirely (R17). */
export function ignoreKeys(...keys: string[]): VerdictPolicy {
  const ignored = new Set(keys);
  return ({ key }): InputResponse | undefined =>
    ignored.has(key) ? undefined : { action: 'accept' };
}

/**
 * Flip one character of the sealed blob's ciphertext field, modelling an
 * on-the-wire tamper (S3). The envelope is `mcc1.salt.iv.ciphertext.tag`.
 */
export const tamperCiphertext: StateMutator = (state) => {
  const parts = state.split('.');
  if (parts.length < 5) return `${state}X`;
  const ciphertext = parts[3] as string;
  const first = ciphertext[0] === 'A' ? 'B' : 'A';
  parts[3] = first + ciphertext.slice(1);
  return parts.join('.');
};

/** Truncate the blob, modelling corruption in transit. */
export const truncateState: StateMutator = (state) => state.slice(0, Math.floor(state.length / 2));
