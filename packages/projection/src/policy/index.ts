/**
 * Policy engine (PRD §7, R14–R16, S5, S6).
 *
 * Pure decision logic and elicitation copy for gated tool calls. No I/O.
 *
 * Exports:
 *
 * - `decidePolicy(entry, overrides?)` — R14/S5 decision for one catalog
 *   entry: developer override always wins; otherwise `readOnlyHint: true`
 *   → `auto`, absent/false → `ask`. Annotations never grant more than the
 *   override allows.
 * - `resolveCallPolicy(call, catalog, overrides?)` — resolves a machine's
 *   `PendingToolCall` against a `ServerCatalog`; returns the decision plus
 *   the catalog entry, or a `validate`-phase `ProjectionError` for a tool
 *   the server does not declare.
 * - `ResolvedCallPolicy` — result union of `resolveCallPolicy`.
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
  decidePolicy,
  policyDeniedReason,
  postureOf,
  POLICY_DENIED_REASON,
  resolveCallPolicy,
  type ResolvedCallPolicy,
  type ToolPosture,
} from './decision.js';
export {
  buildElicitationCopy,
  type ElicitationCopy,
  type ElicitationCopyOptions,
} from './elicitation.js';
export { purposeSentence } from '../text-safety.js';
