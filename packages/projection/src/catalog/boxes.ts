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
import { dedupeTools, type ServerCatalog, type ToolCatalogEntry } from '../types.js';

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
  /** The box's own catalog entry, bare name. Approval copy is built from it (S6). */
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
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `multi:${JSON.stringify(pairs)}`;
}

/** Build the merged view over the wrapped boxes (R40, R41). */
export function buildBoxedCatalog(boxes: Iterable<ToolBox>): BoxedCatalog {
  const sorted = [...boxes].sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));
  const members = new Map<string, BoxedTool>();
  for (const box of sorted) {
    // Per-box dedupe (S5): the same rule `findTool` and typegen apply, so a
    // repeated name in one box is one tool; across boxes the alias prefix
    // keeps same-named tools distinct.
    for (const entry of dedupeTools(box.catalog.tools)) {
      const name = `${box.alias}.${entry.name}`;
      members.set(name, { alias: box.alias, entry, qualified: { ...entry, name } });
    }
  }
  const view: BoxedCatalog = {
    alias: BOXED_VIEW_ALIAS,
    identity: multiServerIdentity(sorted),
    tools: [...members.values()].map((member) => member.qualified),
    boxes: new Map(sorted.map((box) => [box.alias, box])),
    members,
  };
  boxedViews.add(view);
  return view;
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
 * Where a call to the catalog tool `name` goes: the wrapped-server alias and
 * the server's own tool name. A single-server catalog sends every name to
 * its one alias unchanged; a boxed view routes by the qualified name.
 */
export function routeCall(catalog: ServerCatalog, name: string): { alias: string; name: string } {
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
  if (!isBoxedCatalog(catalog)) return { entry };
  const member = boxedTool(catalog, entry.name);
  return member !== undefined ? { entry: member.entry, box: member.alias } : { entry };
}

/** The key domain a catalog's blobs are sealed in (R41). */
export function blobKeyDomain(catalog: ServerCatalog): BlobKeyDomain {
  return isBoxedCatalog(catalog) ? 'multi' : 'single';
}
