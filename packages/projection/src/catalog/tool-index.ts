/**
 * The tool index: every tool name, listed in the facade's `instructions`, so
 * the model can call a tool directly with `call_tool` instead of searching
 * for it first.
 *
 * A single-server facade lists its tools when it has at most
 * {@link TOOL_INDEX_MAX_TOOLS}; above that the instructions stay as they
 * were (search first). A multi-server facade lists every tool, one line per
 * box, by qualified name, up to {@link MULTI_TOOL_INDEX_MAX_TOOLS} in total.
 *
 * Names are S5-untrusted and this is the system prompt, so a name is listed
 * only when it is a plain identifier ({@link INDEX_NAME}, at most
 * {@link MAX_INDEX_NAME_CHARS} characters): it cannot carry a sentence,
 * markup or a line break. It is neutralized and length-checked as well, like
 * every other server-sourced name. A name that fails is left out — it stays
 * reachable through search — and the line says how many were left out. A
 * name is never shortened: a shortened name would not be callable.
 */

import { neutralizeControlChars } from '../text-safety.js';
import { dedupeTools, type ServerCatalog } from '../types.js';
import type { BoxedCatalog } from './boxes.js';

/** A single-server facade lists its tools in the instructions at or under this many. */
export const TOOL_INDEX_MAX_TOOLS = 60;

/** A multi-server facade lists its tools in the instructions at or under this many in total. */
export const MULTI_TOOL_INDEX_MAX_TOOLS = 400;

/** Longest name the index lists. */
export const MAX_INDEX_NAME_CHARS = 64;

/** What an index name may be made of: an identifier, no spaces or punctuation beyond `_ - . /`. */
const INDEX_NAME = /^[A-Za-z0-9_\-./]+$/;

/** The name as the index lists it, or `undefined` when it cannot be listed safely. */
function indexName(name: string): string | undefined {
  const inert = neutralizeControlChars(name);
  if (inert !== name || name.length > MAX_INDEX_NAME_CHARS || !INDEX_NAME.test(name)) {
    return undefined;
  }
  return name;
}

/**
 * One index line: `- a, b, c`, then how many names were left out. Each
 * name is checked bare; `prefix` (a grammar-checked alias and a dot, R39)
 * qualifies the names listed.
 */
function indexLine(names: readonly string[], prefix = ''): string {
  const listed = names
    .map(indexName)
    .filter((name) => name !== undefined)
    .map((name) => `${prefix}${name}`);
  const left = names.length - listed.length;
  const tail =
    left > 0
      ? ` (+${left} ${left === 1 ? 'tool' : 'tools'} with unusual names: search for them)`
      : '';
  return `- ${listed.join(', ')}${tail}`;
}

/** Whether a single-server facade over `catalog` lists its tools. */
export function hasToolIndex(catalog: ServerCatalog): boolean {
  const count = dedupeTools(catalog.tools).length;
  return count > 0 && count <= TOOL_INDEX_MAX_TOOLS;
}

/** Whether a multi-server facade over `view` lists its tools. */
export function hasBoxedToolIndex(view: BoxedCatalog): boolean {
  return view.members.size > 0 && view.members.size <= MULTI_TOOL_INDEX_MAX_TOOLS;
}

/** The single-server index header. */
export const TOOL_INDEX_HEADER =
  "Tools — call any of them directly with call_tool; call describe_tool only when you need a tool's arguments, and search_tools only when this list is not enough:";

/** The single-server index: the header, then one line of names in catalog order. */
export function renderToolIndex(catalog: ServerCatalog): string {
  const names = dedupeTools(catalog.tools).map((tool) => tool.name);
  return `${TOOL_INDEX_HEADER}\n${indexLine(names)}`;
}

/**
 * The multi-server index header. `searchPhrase` names the search tools the
 * facade serves (`searchToolsPhrase`), so a facade without the global
 * `search_tools` never names it.
 */
export function boxedToolIndexHeader(searchPhrase: string): string {
  return `Tool index — every tool by its full name, one line per box. Call any of them directly with call_tool; call describe_tool only when you need a tool's arguments, and ${searchPhrase} only when this index is not enough:`;
}

/** The multi-server index: the header, then one line per box (sorted alias order) of qualified names. */
export function renderBoxedToolIndex(view: BoxedCatalog, searchPhrase: string): string {
  const byBox = new Map<string, string[]>();
  for (const alias of view.boxes.keys()) byBox.set(alias, []);
  // Bare names, checked as the server sent them; the line qualifies them.
  for (const member of view.members.values()) byBox.get(member.alias)?.push(member.entry.name);
  const lines = [...byBox]
    .filter(([, names]) => names.length > 0)
    .map(([alias, names]) => indexLine(names, `${alias}.`));
  return `${boxedToolIndexHeader(searchPhrase)}\n${lines.join('\n')}`;
}
