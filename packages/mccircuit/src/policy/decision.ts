/**
 * Policy decisions for tool calls (PRD R14, S5).
 *
 * Pure functions: annotation-derived defaults plus developer overrides.
 * Annotations come from a possibly third-party wrapped server and are
 * untrusted hints — they can only ever make the default *stricter* than an
 * explicit developer override, never looser. A developer override always
 * wins, in every combination.
 */

import { McCircuitError } from '../errors.js';
import { findTool } from '../types.js';
import type {
  PendingToolCall,
  PolicyDecision,
  PolicyOverrides,
  ServerCatalog,
  ToolCatalogEntry,
} from '../types.js';

const VALID_DECISIONS: ReadonlySet<string> = new Set(['auto', 'ask', 'deny']);

/**
 * Decide the policy for a catalog tool (R14).
 *
 * - A developer override (`auto` | `ask` | `deny`) always wins.
 * - With no override, `annotations.readOnlyHint === true` yields `auto`;
 *   an absent or `false` hint yields `ask` (S5: unannotated defaults to ask).
 * - An override entry with an unrecognized value (possible when the config
 *   arrives untyped) fails safe to `ask` — it never grants `auto`.
 *
 * Only own properties of `overrides` are consulted, so tools named like
 * `Object.prototype` members (`toString`, `constructor`, ...) cannot pick up
 * inherited junk as a decision.
 */
export function decidePolicy(entry: ToolCatalogEntry, overrides?: PolicyOverrides): PolicyDecision {
  if (overrides !== undefined && Object.hasOwn(overrides, entry.name)) {
    const override: unknown = overrides[entry.name];
    if (typeof override === 'string' && VALID_DECISIONS.has(override)) {
      return override as PolicyDecision;
    }
    // Malformed override value: fail safe. Never auto-execute on garbage.
    return 'ask';
  }
  return entry.annotations?.readOnlyHint === true ? 'auto' : 'ask';
}

/** Result of resolving a pending call against a server catalog. */
export type ResolvedCallPolicy =
  | { ok: true; decision: PolicyDecision; entry: ToolCatalogEntry }
  | { ok: false; error: McCircuitError };

/**
 * Resolve a machine-requested tool call against the server catalog and
 * decide its policy.
 *
 * Returns the decision together with the matching catalog entry (the entry
 * is what elicitation copy must be built from — S6), or a structured
 * `validate`-phase {@link McCircuitError} when the machine names a tool the
 * wrapped server does not declare.
 */
export function resolveCallPolicy(
  call: PendingToolCall,
  catalog: ServerCatalog,
  overrides?: PolicyOverrides,
): ResolvedCallPolicy {
  const entry = findTool(catalog, call.name);
  if (entry === undefined) {
    return {
      ok: false,
      error: new McCircuitError(
        'validate',
        `Unknown tool "${call.name}": the wrapped server does not declare it`,
        {
          diagnostics: [
            { message: `Requested from machine state "${call.stateName}" (call id ${call.id})` },
          ],
          hint: 'Call discover_apis and use only the tool names listed in @mccircuit/tools.',
        },
      ),
    };
  }
  return { ok: true, decision: decidePolicy(entry, overrides), entry };
}

/**
 * Canonical TOOL_DENIED reason for calls blocked by a `deny` policy
 * decision. A `deny` decision never produces an elicitation — the machine
 * host injects `TOOL_DENIED` with this reason instead.
 */
export const POLICY_DENIED_REASON = 'denied by server policy';

/**
 * Build the TOOL_DENIED reason string for a policy-denied call. With a tool
 * name it names the denied tool so the machine (and audit trail) can tell
 * which call was blocked.
 */
export function policyDeniedReason(toolName?: string): string {
  return toolName === undefined
    ? POLICY_DENIED_REASON
    : `${POLICY_DENIED_REASON}: tool "${toolName}" is configured as deny`;
}
