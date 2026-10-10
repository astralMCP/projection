/**
 * Policy decisions for tool calls (PRD R14, S5).
 *
 * Pure functions: annotation-derived defaults plus developer overrides.
 * Annotations come from a possibly third-party wrapped server and are
 * untrusted hints — they can only ever make the default *stricter* than an
 * explicit developer override, never looser. A developer override always
 * wins, in every combination.
 */

import { ProjectionError } from '../errors.js';
import { capLength, neutralizeControlChars } from '../text-safety.js';
import { findTool } from '../types.js';
import type {
  PendingToolCall,
  PolicyDecision,
  PolicyOverrides,
  ServerCatalog,
  ToolCatalogEntry,
} from '../types.js';

const VALID_DECISIONS: ReadonlySet<string> = new Set(['auto', 'ask', 'deny']);
const MAX_TOOL_NAME_CHARS = 200;

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

/** The three normative posture strings (R33) — models match on these. */
export type ToolPosture = 'runs immediately' | 'asks for approval' | 'blocked by policy';

/** Map a policy decision to its plain-words posture (R33). Shared by every surface that names one. */
export function postureOf(decision: PolicyDecision): ToolPosture {
  switch (decision) {
    case 'auto':
      return 'runs immediately';
    case 'ask':
      return 'asks for approval';
    case 'deny':
      return 'blocked by policy';
  }
}

/** Result of resolving a pending call against a server catalog. */
export type ResolvedCallPolicy =
  | { ok: true; decision: PolicyDecision; entry: ToolCatalogEntry }
  | { ok: false; error: ProjectionError };

/**
 * Resolve a machine-requested tool call against the server catalog and
 * decide its policy.
 *
 * Returns the decision together with the matching catalog entry (the entry
 * is what elicitation copy must be built from — S6), or a structured
 * `validate`-phase {@link ProjectionError} when the machine names a tool the
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
      error: new ProjectionError(
        'validate',
        `Unknown tool "${call.name}": the wrapped server does not declare it`,
        {
          diagnostics: [
            { message: `Requested from machine state "${call.stateName}" (call id ${call.id})` },
          ],
          hint: 'Call discover_apis and use only the tool names listed in @astral-mcp/tools.',
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
  if (toolName === undefined) return POLICY_DENIED_REASON;
  // The name comes from the wrapped server's catalog (S5) and is shown to
  // the model and recorded in the audit trail: inert and bounded.
  const safeName = neutralizeControlChars(capLength(toolName, MAX_TOOL_NAME_CHARS));
  return `${POLICY_DENIED_REASON}: tool "${safeName}" is configured as deny`;
}
