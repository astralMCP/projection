/**
 * Just-in-time hints on empty results (catalog projection; DECISIONS draft
 * in the v7 hill-climb record).
 *
 * A model that gets an empty answer tends to read it as "the thing is not
 * there" and stop, even when a different lookup would find it. Guidance in
 * the system prompt is not in view at that moment, so the hint rides on the
 * empty result itself:
 *
 * - a search tool (`search_tools`, `search_<alias>`) that matches no tools
 *   says it searched tool names and descriptions, not the server's data,
 *   and names the read tools that do look at data ({@link searchMissHint});
 * - a read-only `call_tool` whose result is empty, or whose upstream error
 *   reads as not-found, gets one appended line naming other read tools of
 *   the same server (and, on a multi-server facade, the other boxes)
 *   ({@link emptyResultHint}).
 *
 * Everything here is derived from the catalog and the policy engine: no
 * server-, tool- or task-specific text. "Read tools" are the tools whose
 * resolved posture is "runs immediately". Tool names are S5-untrusted: a
 * plain identifier prints as is, anything else is neutralized, capped and
 * JSON-quoted. Aliases are grammar-checked (R39) and print raw.
 *
 * Emptiness detection is a heuristic. A false positive only appends a
 * harmless pointer to other read tools; it never alters `structuredContent`.
 */

import { decidePolicy } from '../policy/index.js';
import { capLength, neutralizeControlChars } from '../text-safety.js';
import { dedupeTools, isRecord, type PolicyContext, type ServerCatalog } from '../types.js';
import { boxedTool, isBoxedCatalog, type BoxedCatalog } from './boxes.js';

/** Read tools a search miss names. */
export const SEARCH_MISS_TOOL_LIMIT = 5;
/** Read tools per box a global (every-box) search miss names. */
export const SEARCH_MISS_PER_BOX_LIMIT = 2;
/** Other read tools an empty-result hint names. */
export const EMPTY_RESULT_TOOL_LIMIT = 3;

/** Longest tool name printed in a hint before it is cut. */
const MAX_HINT_NAME_CHARS = 64;
/** A tool name that prints unquoted: a plain identifier. */
const PLAIN_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

// ---------------------------------------------------------------------------
// Read tools, browsing first
// ---------------------------------------------------------------------------

const BROWSE_WORDS = new Set(['list', 'tree', 'browse', 'ls', 'dir']);
const SEARCH_WORDS = new Set(['search', 'find', 'query', 'count']);
const FETCH_WORDS = new Set(['get', 'read', 'show']);

/** Lowercased words of a tool name: split on non-alphanumerics and camelCase humps. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/**
 * The rank of a tool name among read tools: 0 browses (list, tree, browse,
 * ls, dir), 1 searches (search, find, query, count), 2 fetches (get, read,
 * show), 3 anything else. Browsing comes first because enumerating finds
 * what a guessed name or query misses.
 */
export function readToolRank(name: string): number {
  const words = nameWords(name);
  if (words.some((w) => BROWSE_WORDS.has(w))) return 0;
  if (words.some((w) => SEARCH_WORDS.has(w))) return 1;
  if (words.some((w) => FETCH_WORDS.has(w))) return 2;
  return 3;
}

/** One read tool: the name the model calls, and the bare name it is ranked by. */
interface ReadTool {
  /** Qualified on a multi-server view, bare otherwise. */
  name: string;
  /** The box, on a multi-server view. */
  box?: string;
  rank: number;
}

/**
 * The catalog's read tools (posture "runs immediately" under `context`),
 * browsing first, catalog order within a rank (a stable sort). On a
 * multi-server view the names are qualified, ranked on their bare names,
 * and `box` keeps only that box's tools.
 */
export function readTools(
  catalog: ServerCatalog,
  context: PolicyContext,
  box?: string,
): ReadTool[] {
  const tools: ReadTool[] = [];
  if (isBoxedCatalog(catalog)) {
    for (const member of catalog.members.values()) {
      if (box !== undefined && member.alias !== box) continue;
      if (decidePolicy(member.qualified, context) !== 'auto') continue;
      tools.push({
        name: member.qualified.name,
        box: member.alias,
        rank: readToolRank(member.entry.name),
      });
    }
  } else {
    for (const entry of dedupeTools(catalog.tools)) {
      if (decidePolicy(entry, context) !== 'auto') continue;
      tools.push({ name: entry.name, rank: readToolRank(entry.name) });
    }
  }
  return tools.sort((a, b) => a.rank - b.rank);
}

/** A tool name for a hint (S5): plain identifiers raw, anything else inert and quoted. */
export function hintName(name: string): string {
  if (PLAIN_NAME.test(name)) return name;
  return JSON.stringify(capLength(neutralizeControlChars(name), MAX_HINT_NAME_CHARS));
}

function nameList(tools: readonly ReadTool[]): string {
  return tools.map((tool) => hintName(tool.name)).join(', ');
}

// ---------------------------------------------------------------------------
// Search misses
// ---------------------------------------------------------------------------

/**
 * The sentence a search tool appends when its page is empty: it searched
 * tool names and descriptions, not data, and these read tools look at data.
 * `box` is the `search_<alias>` scope; on a multi-server view without one
 * it is the every-box `search_tools` and names up to
 * {@link SEARCH_MISS_PER_BOX_LIMIT} read tools per box.
 */
export function searchMissHint(
  catalog: ServerCatalog,
  context: PolicyContext,
  box?: string,
): string {
  let whose: string;
  let tools: ReadTool[];
  if (isBoxedCatalog(catalog) && box === undefined) {
    whose = "the boxes' data";
    tools = perBox(readTools(catalog, context), SEARCH_MISS_PER_BOX_LIMIT);
  } else {
    whose = box !== undefined ? `the ${box} box's data` : "the server's data";
    tools = readTools(catalog, context, box).slice(0, SEARCH_MISS_TOOL_LIMIT);
  }
  const lead = `This searches tool names and descriptions, not ${whose}`;
  if (tools.length === 0) return `${lead}.`;
  const their = isBoxedCatalog(catalog) && box === undefined ? 'their' : 'its';
  return `${lead} — to look for data, call one of ${their} read tools: ${nameList(tools)}.`;
}

/** At most `limit` tools of each box, boxes in the order they first appear. */
function perBox(tools: readonly ReadTool[], limit: number): ReadTool[] {
  const byBox = new Map<string, ReadTool[]>();
  for (const tool of tools) {
    const key = tool.box ?? '';
    const list = byBox.get(key) ?? [];
    if (list.length < limit) list.push(tool);
    byBox.set(key, list);
  }
  return [...byBox.values()].flat();
}

// ---------------------------------------------------------------------------
// Empty results
// ---------------------------------------------------------------------------

/** Longest text checked against the "nothing found" phrasings (file contents are not). */
const MAX_EMPTY_TEXT_CHARS = 300;
const EMPTY_TEXT_PREFIXES = [
  'no matches',
  'no results',
  'nothing found',
  'not found',
  '0 results',
  'no such',
];
const NO_X_FOUND = /\bno \w+( \w+)? found\b/i;
const NOT_FOUND_ERROR =
  /\bnot found\b|\bno such\b|\bdoes ?n[o']t exist\b|\b404\b|\bENOENT\b|\bno \w+( \w+)? found\b/i;
/** A field that counts results: `count`, `total`, `total_count`, `resultsCount`, … */
const COUNT_KEY = /(count|total)$/i;
/** How deep nested objects are inspected. */
const MAX_DEPTH = 3;

/** Whether a text result says it found nothing. */
export function isEmptyText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed === '[]' || trimmed === '{}') return true;
  if (trimmed.length > MAX_EMPTY_TEXT_CHARS) return false;
  const lowered = trimmed.toLowerCase();
  if (EMPTY_TEXT_PREFIXES.some((prefix) => lowered.startsWith(prefix))) return true;
  if (NO_X_FOUND.test(trimmed)) return true;
  // A JSON text result: judge the value it encodes.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return isEmptyValue(JSON.parse(trimmed) as unknown);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Whether an upstream error message reads as not-found (404, ENOENT, "no
 * such …", "… does not exist").
 */
export function isNotFoundError(message: string): boolean {
  return NOT_FOUND_ERROR.test(message.slice(0, 2_000));
}

/**
 * Whether a successful result value is empty: `null`, an empty array, an
 * empty-text string ({@link isEmptyText}), or an object that carries no
 * data — every array field empty, every string field empty text, every
 * nested object empty, numbers other than a positive count and booleans
 * ignored — and says so: it has an empty array, an empty-text string, a
 * count/total field equal to 0, or no fields at all.
 */
export function isEmptyValue(value: unknown): boolean {
  return emptiness(value, 0) === 'empty';
}

type Emptiness = 'empty' | 'data' | 'neutral';

function emptiness(value: unknown, depth: number): Emptiness {
  if (value === null || value === undefined) return 'empty';
  if (typeof value === 'string') return isEmptyText(value) ? 'empty' : 'data';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'empty';
    // A content array (text-only blocks): empty when every block's text is.
    const texts = value.map((block) =>
      isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string'
        ? block['text']
        : undefined,
    );
    if (texts.every((t) => t !== undefined) && texts.every((t) => isEmptyText(t))) return 'empty';
    return 'data';
  }
  if (!isRecord(value)) return 'data';
  if (depth >= MAX_DEPTH) return 'data';
  const entries = Object.entries(value);
  if (entries.length === 0) return 'empty';
  let signal = false;
  for (const [key, field] of entries) {
    if (typeof field === 'number') {
      if (COUNT_KEY.test(key)) {
        if (field > 0) return 'data';
        signal = true;
      }
      continue;
    }
    if (typeof field === 'boolean' || field === null || field === undefined) continue;
    const verdict = emptiness(field, depth + 1);
    if (verdict === 'data') return 'data';
    if (verdict === 'empty') signal = true;
  }
  return signal ? 'empty' : 'neutral';
}

/**
 * The line appended to a read-only `call_tool` result that came back empty
 * (`tool` is the name the catalog resolved, qualified on a multi-server
 * view): other read tools of the same server, browsing first, and on a
 * multi-server view the other boxes. `undefined` when there is nowhere else
 * to point.
 */
export function emptyResultHint(
  catalog: ServerCatalog,
  context: PolicyContext,
  tool: string,
): string | undefined {
  const shown = hintName(tool);
  if (isBoxedCatalog(catalog)) return boxedEmptyResultHint(catalog, context, tool, shown);
  const others = readTools(catalog, context)
    .filter((t) => t.name !== tool)
    .slice(0, EMPTY_RESULT_TOOL_LIMIT);
  if (others.length === 0) return undefined;
  return `Nothing found with ${shown}. Other ways to look: ${nameList(others)}.`;
}

function boxedEmptyResultHint(
  catalog: BoxedCatalog,
  context: PolicyContext,
  tool: string,
  shown: string,
): string | undefined {
  const box = boxedTool(catalog, tool)?.alias;
  if (box === undefined) return undefined;
  const others = readTools(catalog, context, box)
    .filter((t) => t.name !== tool)
    .slice(0, EMPTY_RESULT_TOOL_LIMIT);
  const otherBoxes = [...catalog.boxes.keys()].filter((alias) => alias !== box);
  const parts: string[] = [];
  if (others.length > 0) parts.push(`Other ways to look in ${box}: ${nameList(others)}`);
  if (otherBoxes.length > 0) {
    parts.push(`look in another box that could hold it: ${otherBoxes.join(', ')}`);
  }
  if (parts.length === 0) return undefined;
  const tail = parts.length === 2 ? `${parts[0]}; or ${parts[1]}` : capitalize(parts[0] ?? '');
  return `Nothing found with ${shown}. ${tail}.`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
