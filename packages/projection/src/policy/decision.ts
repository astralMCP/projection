/**
 * Policy decisions for tool calls (PRD R14, R49, S5).
 *
 * Pure functions: annotation-derived defaults, the approvals mode and
 * developer overrides. Annotations come from a possibly third-party wrapped
 * server and are untrusted hints — only an explicit `readOnlyHint: true`,
 * or under the `'destructive-only'` mode an explicit `destructiveHint:
 * false`, ever relaxes the default. A developer override always wins, in
 * every combination.
 */

import { ProjectionError } from '../errors.js';
import { capLength, neutralizeControlChars } from '../text-safety.js';
import { isBoxedCatalog, splitQualified } from '../catalog/boxes.js';
import { findTool } from '../types.js';
import type {
  ApprovalsMode,
  PendingToolCall,
  PolicyContext,
  PolicyDecision,
  PolicyOptions,
  ServerCatalog,
  ToolCatalogEntry,
} from '../types.js';

const VALID_DECISIONS: ReadonlySet<string> = new Set(['auto', 'ask', 'deny']);
const APPROVALS_MODES: ReadonlySet<string> = new Set<ApprovalsMode>([
  'every-write',
  'destructive-only',
]);
const MAX_TOOL_NAME_CHARS = 200;
/** The context of a facade configured with neither overrides nor a mode. */
const DEFAULT_POLICY_CONTEXT: PolicyContext = Object.freeze({ approvals: 'every-write' });

/**
 * Decide the policy for a catalog tool (R14, R49). Precedence, strongest
 * first:
 *
 * 1. A developer override (`auto` | `ask` | `deny`) always wins. An override
 *    entry with an unrecognized value (possible when the config arrives
 *    untyped) fails safe to `ask` — it never grants `auto`.
 * 2. `annotations.readOnlyHint === true` yields `auto` in every mode.
 * 3. Under `approvals: 'destructive-only'`, a tool whose annotations declare
 *    `destructiveHint === false` exactly yields `auto`; a missing hint or any
 *    other value still asks (the MCP default reads a non-read-only tool as
 *    destructive).
 * 4. Otherwise `ask` (S5: unannotated defaults to ask).
 *
 * A context whose `approvals` is not one of the two modes throws a
 * `TypeError` — fail closed, never decide on a malformed context (the wrap
 * rejects malformed modes up front with a `validate` error — see
 * {@link assertApprovalsMode}).
 *
 * Only own properties of `context.overrides` and of `entry.annotations` are
 * consulted, so tools named like `Object.prototype` members (`toString`,
 * `constructor`, ...) cannot pick up inherited junk as a decision, and an
 * annotations object cannot inherit a relaxing hint from its prototype.
 */
export function decidePolicy(
  entry: ToolCatalogEntry,
  context: PolicyContext = DEFAULT_POLICY_CONTEXT,
): PolicyDecision {
  // A pre-R49 caller passing a bare overrides object (untyped, or cast)
  // would otherwise have its overrides — a `deny` included — silently
  // ignored; one whose map names a tool `approvals` would otherwise pass a
  // string check. Refuse anything that is not a known mode: fail closed.
  if (typeof context.approvals !== 'string' || !APPROVALS_MODES.has(context.approvals)) {
    throw new TypeError('decidePolicy expects a PolicyContext; build one with policyContext()');
  }
  const { overrides } = context;
  if (overrides !== undefined && Object.hasOwn(overrides, entry.name)) {
    const override: unknown = overrides[entry.name];
    if (typeof override === 'string' && VALID_DECISIONS.has(override)) {
      return override as PolicyDecision;
    }
    // Malformed override value: fail safe. Never auto-execute on garbage.
    return 'ask';
  }
  if (ownHint(entry, 'readOnlyHint') === true) return 'auto';
  if (
    approvalsFor(entry, context) === 'destructive-only' &&
    ownHint(entry, 'destructiveHint') === false
  ) {
    return 'auto';
  }
  return 'ask';
}

/** An annotation hint, read with own-property semantics like overrides. */
function ownHint(entry: ToolCatalogEntry, key: 'readOnlyHint' | 'destructiveHint'): unknown {
  const annotations: unknown = entry.annotations;
  if (typeof annotations !== 'object' || annotations === null) return undefined;
  return Object.hasOwn(annotations, key)
    ? (annotations as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The approvals mode that applies to `entry` (R49): its box's per-source
 * mode on a multi-server facade, else the facade's. `toolApprovals` is keyed
 * by qualified name and built from the boxed view's members at wrap time,
 * so a server's own dotted tool name (`fs.github.delete_repo`) can only ever
 * select its own box's mode. `entry` must be the qualified entry the gate
 * resolved, never a box's bare entry (see `BoxedTool.entry`).
 */
function approvalsFor(entry: ToolCatalogEntry, context: PolicyContext): ApprovalsMode {
  return context.toolApprovals?.get(entry.name) ?? context.approvals;
}

/**
 * Build the {@link PolicyContext} for a set of {@link PolicyOptions} — the
 * per-tool `policy` overrides (R14), the `approvals` mode and a multi-server
 * facade's per-tool `toolApprovals` (R49), the shape the gate deps, the
 * catalog tools, the machine host and typegen all take. An absent mode
 * resolves to `'every-write'`.
 */
export function policyContext(options: PolicyOptions = {}): PolicyContext {
  return {
    ...(options.policy !== undefined ? { overrides: options.policy } : {}),
    approvals: options.approvals ?? 'every-write',
    ...(options.toolApprovals !== undefined ? { toolApprovals: options.toolApprovals } : {}),
  };
}

/**
 * Validate an `approvals` option (R49): absent, or one of the two modes. A
 * malformed value is a `validate`-phase {@link ProjectionError} — the mode
 * is one deploy-time switch, so a typo fails the wrap instead of silently
 * changing who gets asked (DECISIONS D17). `wrapMcpServer` calls it; call
 * it yourself when passing `approvals` to `executeMachine` or
 * `generateToolTypes` directly.
 */
export function assertApprovalsMode(value: unknown): ApprovalsMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && APPROVALS_MODES.has(value)) return value as ApprovalsMode;
  throw new ProjectionError('validate', 'approvals must be "every-write" or "destructive-only"', {
    hint: 'Omit approvals for the default ("every-write"), or set it to "destructive-only" to skip approval for tools that declare destructiveHint: false.',
  });
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
  context: PolicyContext = DEFAULT_POLICY_CONTEXT,
): ResolvedCallPolicy {
  const entry = findTool(catalog, call.name);
  if (entry === undefined) {
    return {
      ok: false,
      error: new ProjectionError('validate', unknownCallMessage(catalog, call.name), {
        diagnostics: [
          { message: `Requested from machine state "${call.stateName}" (call id ${call.id})` },
        ],
        hint: isBoxedCatalog(catalog)
          ? 'Call discover_apis and use only the qualified tool names (<box>.<tool>) listed in @astral-mcp/tools.'
          : 'Call discover_apis and use only the tool names listed in @astral-mcp/tools.',
      }),
    };
  }
  return { ok: true, decision: decidePolicy(entry, context), entry };
}

/**
 * The unknown-tool message for a machine's `toolCall`. On a multi-server
 * view (R40) it says which part of the qualified name failed; aliases are
 * host-chosen and grammar-checked (R39), so they print raw. The single-server
 * message is unchanged.
 */
function unknownCallMessage(catalog: ServerCatalog, name: string): string {
  if (!isBoxedCatalog(catalog)) {
    return `Unknown tool "${name}": the wrapped server does not declare it`;
  }
  const quoted = JSON.stringify(capLength(neutralizeControlChars(name), MAX_TOOL_NAME_CHARS));
  const boxes = [...catalog.boxes.keys()].join(', ');
  const split = splitQualified(name);
  if (split === undefined) {
    return `Unknown tool ${quoted}: tool names here are qualified as <box>.<tool> (boxes: ${boxes})`;
  }
  if (catalog.boxes.has(split.alias)) {
    return `Unknown tool ${quoted}: the ${split.alias} box does not declare it`;
  }
  return `Unknown tool ${quoted}: there is no box ${JSON.stringify(capLength(neutralizeControlChars(split.alias), MAX_TOOL_NAME_CHARS))} (boxes: ${boxes})`;
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
