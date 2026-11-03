/**
 * Policy rules (PRD R14 amendment, DECISIONS D36): decide many tools at
 * once — by name pattern or by a predicate over the catalog entry — where a
 * per-tool `policy` override names one.
 *
 * Rules are resolved ONCE, at wrap time, over the introspected catalog into
 * a concrete per-tool overrides map, merged under the exact-name overrides.
 * `decidePolicy` stays pure and unchanged, and the one frozen policy
 * snapshot every surface decides with (typegen, the catalog postures,
 * direct listing, the approval gate, resume) already carries every rule's
 * outcome — no surface ever calls a rule.
 */

import { ProjectionError } from '../errors.js';
import { capLength, neutralizeControlChars } from '../text-safety.js';
import { dedupeTools } from '../types.js';
import type {
  PolicyDecision,
  PolicyOverrides,
  PolicyRule,
  ServerCatalog,
  ToolCatalogEntry,
} from '../types.js';

const VALID_DECISIONS: ReadonlySet<string> = new Set(['auto', 'ask', 'deny']);
const MAX_TOOL_NAME_CHARS = 200;

/**
 * Validate a `policyRules` option at wrap time, before anything connects:
 * absent, or an array whose every rule is a function or a
 * `{ match: string, decision }` object. Anything else is a `validate`
 * {@link ProjectionError}. A pattern rule's `decision` is not checked here:
 * like an override value (R14), an unrecognized one fails safe to `ask` on
 * the tools it matches.
 */
export function assertPolicyRules(value: unknown): readonly PolicyRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ProjectionError('validate', 'policyRules must be an array of rules', {
      hint: 'Pass e.g. policyRules: [{ match: "*send*", decision: "ask" }, (tool) => undefined].',
    });
  }
  value.forEach((rule: unknown, index) => {
    if (typeof rule === 'function') return;
    if (
      typeof rule === 'object' &&
      rule !== null &&
      typeof (rule as { match?: unknown }).match === 'string'
    ) {
      return;
    }
    throw new ProjectionError(
      'validate',
      `policyRules[${index}] must be a function or { match, decision }`,
      {
        hint: 'A rule is a name pattern ({ match: "*send*", decision: "ask" }) or a function (tool) => "auto" | "ask" | "deny" | undefined.',
      },
    );
  });
  return value as readonly PolicyRule[];
}

/**
 * Resolve `rules` over `catalog` into per-tool overrides, then lay the
 * exact-name `policy` overrides over them: an exact override always wins
 * (R14), then the first rule with an opinion, then the approvals mode and
 * the annotations (left to `decidePolicy`).
 *
 * Each tool the catalog declares (deduplicated, first occurrence wins, as
 * every surface does — S5) is tried against the rules in order; the first
 * that returns a decision decides it. A pattern rule matches the whole tool
 * name — the qualified `<alias>.<tool>` on a multi-server view (R42) —
 * case-insensitively, with `*` standing for any run of characters. A
 * function rule gets a copy of the entry (so it cannot alter the catalog)
 * and returns `'auto'`, `'ask'`, `'deny'`, or `undefined` for no opinion.
 * Any other return fails safe to `ask`, never `auto`; a rule that throws or
 * returns a promise fails the wrap with a `validate` error.
 *
 * Returns `policy` itself when there are no rules, so a facade configured
 * without rules decides exactly as before; `undefined` when neither yields
 * an override.
 */
export function resolvePolicyRules(
  catalog: ServerCatalog,
  rules: readonly PolicyRule[] | undefined,
  policy: PolicyOverrides | undefined,
): PolicyOverrides | undefined {
  if (rules === undefined || rules.length === 0) return policy;
  const resolved: [string, PolicyDecision][] = [];
  for (const entry of dedupeTools(catalog.tools)) {
    if (policy !== undefined && Object.hasOwn(policy, entry.name)) continue;
    const decision = firstDecision(entry, rules);
    if (decision !== undefined) resolved.push([entry.name, decision]);
  }
  if (resolved.length === 0) return policy;
  // `Object.fromEntries` and spread define own data properties, so a tool
  // named `__proto__` is an override like any other, not a prototype swap.
  return { ...Object.fromEntries(resolved), ...policy };
}

function firstDecision(
  entry: ToolCatalogEntry,
  rules: readonly PolicyRule[],
): PolicyDecision | undefined {
  for (const rule of rules) {
    const outcome =
      typeof rule === 'function'
        ? callRule(rule, entry)
        : globMatches(rule.match, entry.name)
          ? (rule.decision as unknown)
          : undefined;
    if (outcome === undefined) continue;
    // Malformed: fail safe. A rule never grants `auto` on garbage.
    return typeof outcome === 'string' && VALID_DECISIONS.has(outcome)
      ? (outcome as PolicyDecision)
      : 'ask';
  }
  return undefined;
}

function callRule(
  rule: (tool: ToolCatalogEntry) => PolicyDecision | undefined,
  entry: ToolCatalogEntry,
): unknown {
  let outcome: unknown;
  try {
    outcome = rule(structuredClone(entry));
  } catch (err) {
    throw new ProjectionError('validate', `a policy rule threw on tool ${quotedName(entry)}`, {
      cause: err,
      hint: 'Policy rules run once per tool at wrap time; return undefined for tools a rule has no opinion on.',
    });
  }
  if (
    typeof outcome === 'object' &&
    outcome !== null &&
    typeof (outcome as { then?: unknown }).then === 'function'
  ) {
    throw new ProjectionError(
      'validate',
      `a policy rule returned a promise for tool ${quotedName(entry)}`,
      {
        hint: 'Policy rules are synchronous: return "auto", "ask", "deny" or undefined.',
      },
    );
  }
  return outcome;
}

/**
 * Whether `name` matches `pattern` in full, case-insensitively, where `*`
 * matches any run of characters (none included) and every other character
 * is literal. Linear-time segment search, no regular expression.
 */
export function globMatches(pattern: string, name: string): boolean {
  const parts = pattern.toLowerCase().split('*');
  const text = name.toLowerCase();
  const first = parts[0] ?? '';
  if (parts.length === 1) return text === first;
  const last = parts[parts.length - 1] ?? '';
  if (text.length < first.length + last.length) return false;
  if (!text.startsWith(first) || !text.endsWith(last)) return false;
  const end = text.length - last.length;
  let position = first.length;
  for (const part of parts.slice(1, -1)) {
    const index = text.indexOf(part, position);
    if (index === -1 || index + part.length > end) return false;
    position = index + part.length;
  }
  return true;
}

function quotedName(entry: ToolCatalogEntry): string {
  return JSON.stringify(neutralizeControlChars(capLength(entry.name, MAX_TOOL_NAME_CHARS)));
}
