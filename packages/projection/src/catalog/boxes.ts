/**
 * Tool boxes: the merged, qualified-name view of a multi-server facade's
 * catalog (PRD §6.9, R40, R41; DECISIONS D16).
 *
 * A multi-server facade wraps each server as a **box** under an alias the
 * integrator chose, and every tool is addressed as `<alias>.<name>`, split
 * at the first dot (aliases are dot-free, R39), so a server's own dotted
 * tool name stays inside its box: `fs.github.delete_repo` is the `fs` box's
 * tool `github.delete_repo`, never the `github` box's `delete_repo`.
 *
 * The view is an ordinary {@link ServerCatalog} whose entries carry their
 * qualified names, so every consumer that resolves a name against a catalog
 * — `findTool`, the policy engine, `describe_tool`, `call_tool`, the blob's
 * `pending` entries and the R36 binding hash — becomes box-aware without a
 * second code path: policy overrides are keyed by qualified names (R42), and
 * an approval for `fs.write_file` can never be replayed as
 * `github.write_file`. Its `identity` is the R41 server-set string, and
 * blobs minted against it are sealed in the `multi` key domain.
 *
 * The few places that must know they are serving boxes — routing a call to
 * its server, the did-you-mean hint, the approval footer, the describe
 * header — ask {@link isBoxedCatalog}, which only recognizes views built
 * here.
 */

import type { BlobKeyDomain } from '../blob/index.js';
import { ProjectionError } from '../errors.js';
import {
  dedupeTools,
  type ApprovalsMode,
  type ServerCatalog,
  type ToolCatalogEntry,
} from '../types.js';

/** One wrapped server under its alias (R39). */
export interface ToolBox {
  /** Integrator-chosen alias, `^[a-z][a-z0-9]{0,23}$` (R39). */
  readonly alias: string;
  /** The server's catalog as introspected: bare tool names. */
  readonly catalog: ServerCatalog;
  /** Host-trusted purpose of the box, neutralized and capped (R39). */
  readonly description?: string;
}

/** One tool of the merged view: the box it lives in, and both of its names. */
export interface BoxedTool {
  readonly alias: string;
  /**
   * The box's own catalog entry, bare name. Copy-only: approval copy (S6)
   * and the scoring of search and the did-you-mean hint read it. It must
   * never be passed to `decidePolicy` or `findTool` — its bare name can
   * spell another box's qualified name (the `fs` box's `github.delete_repo`
   * is not the `github` box's), so policy is always decided on `qualified`.
   */
  readonly entry: ToolCatalogEntry;
  /** The same entry under its qualified name: what every model-facing surface uses. */
  readonly qualified: ToolCatalogEntry;
}

/** The merged catalog of a multi-server facade (R40). */
export interface BoxedCatalog extends ServerCatalog {
  /** Boxes by alias, in sorted alias order. */
  readonly boxes: ReadonlyMap<string, ToolBox>;
  /**
   * Every tool by qualified name, in sorted alias order and then each box's
   * catalog order, deduplicated per box (S5: first occurrence wins). This
   * order is also the R43 tie-break order.
   */
  readonly members: ReadonlyMap<string, BoxedTool>;
  /** Tools per box after the per-box dedupe, by alias in sorted order (R43, R44). */
  readonly counts: ReadonlyMap<string, number>;
  /**
   * Whether the facade serves the global `search_tools` next to the per-box
   * `search_<alias>` tools (R43 `catalog.globalSearch`). Every piece of copy
   * that names a search tool reads it, so none names a tool that is not
   * served.
   */
  readonly globalSearch: boolean;
}

/**
 * Alias grammar (R39): dot-free and underscore-free, short enough for
 * `search_<alias>`. `wrapMcpServers` validates every alias against it at wrap
 * time (`multi/config.ts`), and {@link buildBoxedCatalog} re-checks it, since
 * typegen and the copy print aliases raw (R45).
 */
export const ALIAS_PATTERN = /^[a-z][a-z0-9]{0,23}$/;

/** Options of {@link buildBoxedCatalog}. */
export interface BoxedCatalogOptions {
  /** Serve the global `search_tools` (R43). Default `true`. */
  globalSearch?: boolean;
}

/**
 * Placeholder `alias` of the merged view. No call is routed by it — a boxed
 * catalog routes each call by its qualified name ({@link routeCall}) — and
 * it is outside the alias grammar, so it can never name a real box.
 */
export const BOXED_VIEW_ALIAS = '*';

/** Views built by {@link buildBoxedCatalog}; nothing else is treated as one. */
const boxedViews = new WeakSet<ServerCatalog>();

/** True when `catalog` is a multi-server view built by {@link buildBoxedCatalog}. */
export function isBoxedCatalog(catalog: ServerCatalog): catalog is BoxedCatalog {
  return boxedViews.has(catalog);
}

/**
 * The R41 server-set identity: `multi:` followed by the JSON of the
 * `[alias, identity]` pairs sorted by alias. JSON keeps it injective
 * whatever a server reports as its name or version.
 */
export function multiServerIdentity(boxes: Iterable<ToolBox>): string {
  const pairs = [...boxes]
    .map((box) => [box.alias, box.catalog.identity] as const)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `multi:${JSON.stringify(pairs)}`;
}

/**
 * Build the merged view over the wrapped boxes (R40, R41). Every alias must
 * match {@link ALIAS_PATTERN}: the generated `.d.ts`, the evaluated bridge
 * header and the model-facing copy print aliases raw, so a view over any
 * other alias is refused with a `terminal` {@link ProjectionError} (defense
 * in depth: `wrapMcpServers` already rejects it at wrap time).
 */
export function buildBoxedCatalog(
  boxes: Iterable<ToolBox>,
  options: BoxedCatalogOptions = {},
): BoxedCatalog {
  const sorted = [...boxes].toSorted((a, b) =>
    a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0,
  );
  for (const box of sorted) {
    if (!ALIAS_PATTERN.test(box.alias)) {
      throw new ProjectionError('terminal', 'a multi-server view needs grammar-checked aliases', {
        hint: `Every box alias must match ${String(ALIAS_PATTERN)} (R39); wrapMcpServers validates aliases before it builds the view.`,
      });
    }
  }
  const members = new Map<string, BoxedTool>();
  const counts = new Map<string, number>();
  for (const box of sorted) {
    counts.set(box.alias, 0);
    // Per-box dedupe (S5): the same rule `findTool` and typegen apply, so a
    // repeated name in one box is one tool; across boxes the alias prefix
    // keeps same-named tools distinct.
    for (const entry of dedupeTools(box.catalog.tools)) {
      const name = `${box.alias}.${entry.name}`;
      members.set(name, { alias: box.alias, entry, qualified: { ...entry, name } });
      counts.set(box.alias, (counts.get(box.alias) ?? 0) + 1);
    }
  }
  const view: BoxedCatalog = {
    alias: BOXED_VIEW_ALIAS,
    identity: multiServerIdentity(sorted),
    tools: [...members.values()].map((member) => member.qualified),
    boxes: new Map(sorted.map((box) => [box.alias, box])),
    members,
    counts,
    globalSearch: options.globalSearch ?? true,
  };
  boxedViews.add(view);
  return view;
}

/**
 * How a surface spanning the whole facade names it (R39): the sorted alias
 * list — `the toolbox fs`, `the toolboxes fs, github` — never the
 * server-reported identity. Aliases are host-chosen and grammar-checked, so
 * they print raw.
 */
export function boxesLabel(catalog: BoxedCatalog): string {
  const aliases = [...catalog.boxes.keys()];
  return `the ${aliases.length === 1 ? 'toolbox' : 'toolboxes'} ${aliases.join(', ')}`;
}

/** The facade's first alias in sorted order: the box the R45 samples are written against. */
export function firstAlias(catalog: BoxedCatalog): string {
  return catalog.boxes.keys().next().value ?? '';
}

/**
 * The view's tools grouped by box, in sorted alias order and each box's
 * catalog order; a box without tools maps to an empty list.
 */
export function membersByBox(catalog: BoxedCatalog): Map<string, BoxedTool[]> {
  const grouped = new Map<string, BoxedTool[]>();
  for (const alias of catalog.boxes.keys()) grouped.set(alias, []);
  for (const member of catalog.members.values()) grouped.get(member.alias)?.push(member);
  return grouped;
}

/** The per-box search tool of `alias` (R43): `search_<alias>`. */
export function boxSearchTool(alias: string): string {
  return `search_${alias}`;
}

/** The boxed tool a qualified name denotes, O(1); `undefined` when there is none. */
export function boxedTool(catalog: BoxedCatalog, name: string): BoxedTool | undefined {
  return catalog.members.get(name);
}

/**
 * Split a name at its first dot (R40): `{ alias, rest }`, or `undefined`
 * for an unqualified name (no dot, or nothing before it).
 */
export function splitQualified(name: string): { alias: string; rest: string } | undefined {
  const dot = name.indexOf('.');
  if (dot <= 0) return undefined;
  return { alias: name.slice(0, dot), rest: name.slice(dot + 1) };
}

/**
 * The per-tool approvals modes (R49) of a multi-server facade: one entry per
 * qualified tool whose box has its own mode, taken from the view's members
 * so the policy engine never re-derives a box by splitting a name.
 */
export function toolApprovalsFor(
  catalog: BoxedCatalog,
  sourceModes: ReadonlyMap<string, ApprovalsMode>,
): ReadonlyMap<string, ApprovalsMode> {
  const modes = new Map<string, ApprovalsMode>();
  for (const [name, member] of catalog.members) {
    const mode = sourceModes.get(member.alias);
    if (mode !== undefined) modes.set(name, mode);
  }
  return modes;
}

/**
 * Fail closed on a catalog that looks like a boxed view but is not one
 * {@link buildBoxedCatalog} built — a spread copy loses the brand, and
 * would otherwise route, gate and seal as a single-server catalog.
 */
function assertNotUnbrandedView(catalog: ServerCatalog): void {
  if (catalog.alias === BOXED_VIEW_ALIAS && !isBoxedCatalog(catalog)) {
    throw unbrandedViewError();
  }
}

function unbrandedViewError(): ProjectionError {
  return new ProjectionError(
    'terminal',
    'the catalog is a copy of a multi-server view, not the view itself',
    {
      hint: 'Pass the catalog built by buildBoxedCatalog (the facade does): a copied view loses its box routing and key domain.',
    },
  );
}

/**
 * Where a call to the catalog tool `name` goes: the wrapped-server alias and
 * the server's own tool name. A single-server catalog sends every name to
 * its one alias unchanged; a boxed view routes by the qualified name.
 */
export function routeCall(catalog: ServerCatalog, name: string): { alias: string; name: string } {
  assertNotUnbrandedView(catalog);
  if (!isBoxedCatalog(catalog)) return { alias: catalog.alias, name };
  const member = boxedTool(catalog, name);
  if (member !== undefined) return { alias: member.alias, name: member.entry.name };
  // Only reachable for a name the catalog does not declare, which every
  // caller validates first; the split keeps the call inside the named box.
  const split = splitQualified(name);
  return split !== undefined ? { alias: split.alias, name: split.rest } : { alias: '', name };
}

/**
 * What approval copy is built from for the catalog entry `entry` (R16, R46,
 * S6): on a multi-server view, the box's own entry (bare name) and the box
 * alias; otherwise the entry itself.
 */
export function approvalSubject(
  catalog: ServerCatalog,
  entry: ToolCatalogEntry,
): { entry: ToolCatalogEntry; box?: string } {
  assertNotUnbrandedView(catalog);
  if (!isBoxedCatalog(catalog)) return { entry };
  const member = boxedTool(catalog, entry.name);
  return member !== undefined ? { entry: member.entry, box: member.alias } : { entry };
}

/**
 * The key domain a catalog's blobs are sealed in (R41), checked against the
 * domain the facade declared (`declared`, from the gate deps). Fails closed
 * with a `terminal` {@link ProjectionError} rather than ever falling back to
 * `single` for a multi-server catalog:
 *
 * - the declared domain disagrees with the catalog's brand (a copied view
 *   handed to a multi-server gate, or a boxed view to a single-server one);
 * - no domain is declared and the catalog carries the boxed-view alias or a
 *   `multi:` identity without the brand. (A single-server facade always
 *   declares `single`, so a server that reports a `multi:` name still works
 *   there — the key domain is what keeps the two kinds apart, R41.)
 */
export function blobKeyDomain(catalog: ServerCatalog, declared?: BlobKeyDomain): BlobKeyDomain {
  const branded = isBoxedCatalog(catalog);
  const domain: BlobKeyDomain = branded ? 'multi' : 'single';
  if (declared !== undefined) {
    if (declared !== domain) throw unbrandedViewError();
    return domain;
  }
  if (!branded && (catalog.alias === BOXED_VIEW_ALIAS || catalog.identity.startsWith('multi:'))) {
    throw unbrandedViewError();
  }
  return domain;
}
