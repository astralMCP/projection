/**
 * Policy engine (PRD §7, R14–R16, S5, S6).
 *
 * Pure decision logic and elicitation copy for gated tool calls. No I/O.
 *
 * Exports:
 *
 * - `decidePolicy(entry, context?)` — R14/R49/S5 decision for one catalog
 *   entry, the single decision point every surface uses: developer override
 *   always wins; otherwise `readOnlyHint: true` → `auto`; under
 *   `approvals: 'destructive-only'` an explicit `destructiveHint: false`
 *   → `auto`; anything else → `ask`.
 * - `policyContext(options)` — builds the `PolicyContext` from options
 *   carrying `policy` (overrides) and `approvals`; absent mode →
 *   `'every-write'`.
 * - `assertApprovalsMode(value)` — R49 wrap-time validation of the
 *   `approvals` option (`validate`-phase error on a malformed value).
 * - `assertPolicyRules(value)` / `resolvePolicyRules(catalog, rules,
 *   policy)` — the `policyRules` option (R14 amendment, D36): validated
 *   before connecting, then resolved once over the catalog into per-tool
 *   overrides under the exact-name ones. `globMatches(pattern, name)` is
 *   the name-pattern matcher.
 * - `resolveCallPolicy(call, catalog, context?)` — resolves a machine's
 *   `PendingToolCall` against a `ServerCatalog`; returns the decision plus
 *   the catalog entry, or a `validate`-phase `ProjectionError` for a tool
 *   the server does not declare.
 * - `ResolvedCallPolicy` — result union of `resolveCallPolicy`.
 * - `toolPolicyOf(catalog, name, options)` / `ToolPolicy` — a tool's
 *   resolved decision and posture by name (backs the facades' `policyOf`).
 * - `POLICY_DENIED_REASON` / `policyDeniedReason(toolName?)` — canonical
 *   TOOL_DENIED reason for policy-denied calls (a `deny` decision never
 *   produces an elicitation; the machine host injects TOOL_DENIED with
 *   this reason).
 * - `buildElicitationCopy(call, entry, options?)` — R16/S6 approval
 *   summary: catalog-sourced tool name and description, redacted args
 *   rendered as an inert indented JSON block (fail-closed on redaction
 *   errors, size-capped with a truncation marker), requesting state name,
 *   and stronger warning language for `destructiveHint` tools.
 * - `ElicitationCopy` / `ElicitationCopyOptions` — the structured copy
 *   shape consumed by the MRTR adapter, and its options.
 * - `purposeSentence(description)` — the one-line purpose rule the copy
 *   shares with typegen and `search_tools`; defined in `text-safety.ts`,
 *   re-exported here so the public surface is unchanged.
 */

export {
  assertApprovalsMode,
  decidePolicy,
  policyContext,
  policyDeniedReason,
  postureOf,
  POLICY_DENIED_REASON,
  resolveCallPolicy,
  toolPolicyOf,
  type ResolvedCallPolicy,
  type ToolPolicy,
  type ToolPosture,
} from './decision.js';
export { assertPolicyRules, globMatches, resolvePolicyRules } from './rules.js';
export {
  buildElicitationCopy,
  type ElicitationCopy,
  type ElicitationCopyOptions,
} from './elicitation.js';
export { purposeSentence } from '../text-safety.js';
