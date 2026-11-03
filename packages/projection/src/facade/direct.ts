/**
 * Direct listing (`projections.direct`, default `'auto'`, D28): one **mediated** facade
 * tool per wrapped tool, so on a small catalog the model sees every tool's
 * name, description and input schema without `search_tools` /
 * `describe_tool` turns.
 *
 * A mediated tool is a thin alias of `call_tool({ name, args })`, never a
 * pass-through to the upstream (R1): its handler calls the facade's own
 * `callTool` with the tool's catalog name (qualified on a multi-server
 * facade, R40) and the MRTR retry envelope, so validation, the policy
 * decision (R14, R42, R49), the elicitation copy (R16, R46), the sealed
 * `call` blob and its binding hash (R36, S2, S4), the replay cache (R38),
 * the key domain (R41) and the legacy gate (R28) are exactly `call_tool`'s.
 * An approval minted through `fs__write_file` binds `fs.write_file` and can
 * never resume `github__write_file` — the binding hash differs.
 *
 * Everything the listing shows is server text (S5) and goes through the
 * `describe_tool` helpers: the description is neutralized, capped and
 * rendered as an indented block under a library-written posture line, the
 * input schema passes the R34 allowlist sanitizer, and the annotation title
 * is neutralized. The advertised annotations are Projection's own, derived
 * from its decided posture (R35): `readOnlyHint: true` only for a call it
 * runs without asking that the server also marks read-only, and
 * `destructiveHint: true` only as a warning. A server's claims never reach a
 * host that auto-runs read-only tools on their own. Tool names are mapped onto `[A-Za-z0-9_-]{1,64}` — the
 * strictest common host rule (the Messages API's; MCP itself also allows
 * dots, up to 128) — so a hostile name cannot carry anything but those
 * characters, and a collision with a Projection tool or another mapped name
 * gets a hash suffix rather than shadowing it.
 */

import { createHash } from 'node:crypto';
import { MAX_DESCRIPTION_CHARS, sanitizeAnnotations } from '../catalog/describe.js';
import { boxedTool, isBoxedCatalog } from '../catalog/boxes.js';
import { sanitizeSchema } from '../catalog/schema-safety.js';
import { decidePolicy, policyContext, postureOf, type ToolPosture } from '../policy/index.js';
import { capLength, indentBlock, neutralizeControlChars } from '../text-safety.js';
import type { PolicyDecision, PolicyOptions, ServerCatalog, ToolAnnotations } from '../types.js';
import type { DirectSetting } from './options.js';

/** Host tool-name rule the mapped names satisfy (the Messages API's). */
export const DIRECT_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DIRECT_TOOL_NAME_MAX = 64;

/** Separator between a box alias and its tool in a mapped name (`fs__read_file`). */
export const DIRECT_BOX_SEPARATOR = '__';

/** Average characters per token assumed by the `'auto'` size estimate. */
export const CHARS_PER_TOKEN = 3.5;

/** One mediated tool, as listed. */
export interface DirectTool {
  /** The facade tool name, `[A-Za-z0-9_-]{1,64}`. */
  name: string;
  /** The catalog name `call_tool` is called with (qualified on a multi-server facade). */
  target: string;
  /** The box the tool lives in (multi-server facade only). */
  alias?: string;
  title?: string;
  description: string;
  /** The R34-sanitized input schema, always `type: "object"` at the root. */
  inputSchema: Record<string, unknown>;
  /** What the listing advertises: Projection's own, see {@link advertisedAnnotations}. */
  annotations: ToolAnnotations;
  posture: ToolPosture;
}

/** What {@link planDirectTools} needs besides the catalog. */
export interface DirectPlanOptions extends PolicyOptions {
  /** Names the facade already serves (Projection's own tools): never shadowed. */
  reserved: ReadonlySet<string>;
  /**
   * The plan this one replaces, after a `tools/list_changed` refresh (R65):
   * a tool still declared keeps the name it was listed under, and no other
   * tool takes that name, so a listed name never starts routing to a
   * different tool while a model may still hold it. Absent at wrap time.
   */
  previous?: readonly DirectTool[];
}

/**
 * The mediated tools of a catalog, in catalog order. On a multi-server view
 * each is named `<alias>__<tool>`; on a single-server facade, the tool's own
 * name when it is legal and free. A name that is not legal is mapped
 * (illegal characters become `_`, an over-long name is cut and hashed); a
 * name that collides with a reserved one or an earlier mapped one gets
 * `_<8 hex of the catalog name>`. A tool whose name still collides is not
 * listed — it stays reachable through `call_tool`.
 */
export function planDirectTools(catalog: ServerCatalog, options: DirectPlanOptions): DirectTool[] {
  const policy = policyContext(options);
  const taken = new Set(options.reserved);
  const declared = new Set(catalog.tools.map((entry) => entry.name));
  const kept = new Map<string, string>();
  for (const tool of options.previous ?? []) {
    if (declared.has(tool.target)) kept.set(tool.target, tool.name);
  }
  const held = new Set(kept.values());
  const isTaken = (name: string): boolean => taken.has(name) || held.has(name);
  const tools: DirectTool[] = [];
  for (const entry of catalog.tools) {
    // On a boxed view `entry` is the qualified entry: policy is decided on it
    // (R42), the name is built from the alias and the box's own name.
    const member = isBoxedCatalog(catalog) ? boxedTool(catalog, entry.name) : undefined;
    if (isBoxedCatalog(catalog) && member === undefined) continue;
    const raw =
      member !== undefined
        ? `${member.alias}${DIRECT_BOX_SEPARATOR}${member.entry.name}`
        : entry.name;
    const keep = kept.get(entry.name);
    const name =
      keep !== undefined && !taken.has(keep) ? keep : uniqueName(raw, entry.name, isTaken);
    if (name === undefined) continue;
    taken.add(name);

    const decision = decidePolicy(entry, policy);
    const posture = postureOf(decision);
    const annotations = sanitizeAnnotations(entry.annotations);
    const input = sanitizeSchema(entry.inputSchema);
    const schema: Record<string, unknown> = { ...input.schema, type: 'object' };
    delete schema['$truncated'];
    tools.push({
      name,
      target: entry.name,
      ...(member !== undefined ? { alias: member.alias } : {}),
      ...(annotations.title !== undefined ? { title: annotations.title } : {}),
      description: directDescription(entry.description, posture, {
        destructive: entry.annotations?.destructiveHint === true,
        // Named only when the listed name does not spell it by the
        // <alias>__<tool> rule (a mapped or hash-suffixed name).
        qualified: name !== raw ? entry.name : undefined,
        schemaTruncated: input.truncated,
      }),
      inputSchema: schema,
      annotations: advertisedAnnotations(decision, annotations),
      posture,
    });
  }
  return tools;
}

/**
 * The annotations a mediated tool advertises, decided by Projection (R35,
 * S5), never copied from the server: a host that auto-runs tools marked
 * read-only would otherwise skip its own prompt on the server's word, under
 * an `ask` or `deny` override too. `readOnlyHint: true` only when Projection
 * runs the call without asking (`auto`) AND the server marks it read-only
 * and not destructive; otherwise absent. `destructiveHint: true` when the
 * server says so, as a warning; `false` is never advertised (it would
 * reassure). No `title` (the listed tool's own title is the neutralized
 * one), no `idempotentHint` or `openWorldHint`.
 */
export function advertisedAnnotations(
  decision: PolicyDecision,
  server: ToolAnnotations,
): ToolAnnotations {
  const out: ToolAnnotations = {};
  if (decision === 'auto' && server.readOnlyHint === true && server.destructiveHint !== true) {
    out.readOnlyHint = true;
  }
  if (server.destructiveHint === true) out.destructiveHint = true;
  return out;
}

/**
 * The posture line every mediated description leads with (library copy,
 * S5): the R33 posture words in brackets, as `search_tools` shows them,
 * then `destructive` when the server marks the tool so. What a posture
 * means is said once, in the preamble.
 */
function postureLine(posture: ToolPosture, destructive: boolean): string {
  return `[${posture}${destructive ? '; destructive' : ''}]`;
}

/**
 * A mediated tool's description: the posture line, the qualified name a
 * machine uses (multi-server), then the server's own words as an indented
 * block — neutralized and capped exactly as `describe_tool` renders them,
 * so a hostile description cannot forge the posture line.
 */
function directDescription(
  raw: string | undefined,
  posture: ToolPosture,
  extra: { destructive: boolean; qualified: string | undefined; schemaTruncated: boolean },
): string {
  const lines = [postureLine(posture, extra.destructive)];
  if (extra.qualified !== undefined) {
    // Server-controlled: neutralized, capped and quoted like describe_tool's header.
    const shown = JSON.stringify(capLength(neutralizeControlChars(extra.qualified), 200));
    lines.push(`Catalog name (describe_tool, call_tool, toolCall): ${shown}`);
  }
  const text =
    raw !== undefined && raw.trim().length > 0
      ? neutralizeControlChars(capLength(raw.trim(), MAX_DESCRIPTION_CHARS), {
          allowNewline: true,
        })
      : '(no description)';
  lines.push('The server says:', indentBlock(text, '  '));
  if (extra.schemaTruncated) {
    lines.push('[input schema truncated to fit the size cap — the server enforces the full one]');
  }
  return lines.join('\n');
}

/** Map `raw` onto the host name rule, deterministically. */
export function directToolName(raw: string): string {
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  if (safe.length > 0 && safe.length <= DIRECT_TOOL_NAME_MAX) return safe;
  return `${safe.slice(0, DIRECT_TOOL_NAME_MAX - 9)}_${hash8(raw)}`;
}

function uniqueName(
  raw: string,
  target: string,
  isTaken: (name: string) => boolean,
): string | undefined {
  const first = directToolName(raw);
  if (!isTaken(first)) return first;
  const suffix = `_${hash8(target)}`;
  const second = `${first.slice(0, DIRECT_TOOL_NAME_MAX - suffix.length)}${suffix}`;
  return isTaken(second) ? undefined : second;
}

function hash8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

/**
 * Estimated tokens of the listed definitions: name + title + description +
 * input schema JSON, at {@link CHARS_PER_TOKEN} characters per token.
 */
export function estimateDirectTokens(tools: readonly DirectTool[]): number {
  let chars = 0;
  for (const tool of tools) {
    chars +=
      tool.name.length +
      (tool.title?.length ?? 0) +
      tool.description.length +
      JSON.stringify(tool.inputSchema).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Which boxes of a multi-server facade are listed directly. `'on'`: every
 * box. `'auto'`: the budget is filled box by box, smallest estimated size
 * first (ties by alias), skipping a box that does not fit and trying the
 * next — which lists the most boxes the budget allows (sorting by size is
 * optimal for maximising the count), and a box is listed whole or not at
 * all, so the model never meets half a box. `'off'`: none.
 */
export function selectDirectBoxes(
  setting: DirectSetting,
  tools: readonly DirectTool[],
): Set<string> {
  const byBox = new Map<string, DirectTool[]>();
  for (const tool of tools) {
    if (tool.alias === undefined) continue;
    byBox.set(tool.alias, [...(byBox.get(tool.alias) ?? []), tool]);
  }
  if (setting.mode === 'off') return new Set();
  if (setting.mode === 'on') return new Set(byBox.keys());
  const sized = [...byBox].map(([alias, boxTools]) => ({
    alias,
    tokens: estimateDirectTokens(boxTools),
  }));
  sized.sort((a, b) => a.tokens - b.tokens || (a.alias < b.alias ? -1 : 1));
  const listed = new Set<string>();
  let used = 0;
  for (const box of sized) {
    if (used + box.tokens > setting.budgetTokens) continue;
    used += box.tokens;
    listed.add(box.alias);
  }
  return listed;
}

/** Whether a facade lists its tools directly, given its setting and plan. */
export function decideDirect(setting: DirectSetting, tools: readonly DirectTool[]): boolean {
  if (setting.mode === 'off') return false;
  if (setting.mode === 'on') return true;
  return estimateDirectTokens(tools) <= setting.budgetTokens;
}

/** Projection's own tool names on a facade, which a mediated name never takes. */
export function reservedToolNames(searchTools: Iterable<string>): Set<string> {
  return new Set([
    'execute_machine',
    'discover_apis',
    'describe_tool',
    'call_tool',
    'search_tools',
    ...searchTools,
  ]);
}
