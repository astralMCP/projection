/**
 * Result notes — the facade's short, bounded remarks on a wrapped tool's
 * successful result (PRD R35.5, R35.6; DECISIONS D29).
 *
 * Servers often say that a result is partial, and the model misses it: a
 * `total` beside a shorter array, a page exactly as long as the page size,
 * or a warning in a text block the facade dropped because the result also
 * had `structuredContent`. Three conservative detectors turn those signals
 * into notes that `call_tool` prints under its head line and a machine
 * receives on `TOOL_RESULT.notes` (and the model reads again after a
 * completed `execute_machine`):
 *
 * 1. **Count.** The result is an object with exactly one top-level array
 *    and a numeric total-like sibling (`total`, `count`, `total_count`,
 *    `<array>Count`, …, or the same inside a `meta`/`pagination` object)
 *    that is larger than the array.
 * 2. **Full page.** The tool takes a page-size argument (`limit`,
 *    `perPage`, `pageSize`, `max_results`, `first`, …), and the result's
 *    main array is exactly as long as the effective page size — the
 *    argument sent, else the schema's default. Skipped when a total-like
 *    field says the array is complete.
 * 3. **Server note.** Short text (≤ {@link MAX_SERVER_NOTE_CHARS}) the
 *    server sent beside its `structuredContent` that is not a JSON mirror
 *    of it, quoted and attributed (`introspector` picks it,
 *    {@link serverNoteText}).
 *
 * False positives cost tokens and trust, so every detector declines when
 * the shape is ambiguous (several arrays, a non-integer count, no known
 * page size). Every server-controlled string in a note — a key name, the
 * server's own text — is stripped of invisible characters, neutralized,
 * capped and JSON-quoted (S5): a note is one line that can never carry a
 * newline or forge a line of facade copy.
 */

import { capLength, neutralizeControlChars, stripInvisible } from '../text-safety.js';
import { isRecord } from '../types.js';

/** Longest server text passed on as a note; longer text is data, not a note. */
export const MAX_SERVER_NOTE_CHARS = 500;
/** Most notes attached to one result. */
export const MAX_NOTES_PER_RESULT = 3;
/** Longest server key name quoted in a note. */
const MAX_KEY_CHARS = 64;
/** Longest JSON text parsed to look for a partial result. */
const MAX_PARSE_CHARS = 1_000_000;

/** Page-size argument names, compared lowercased with `_` and `-` removed. */
const PAGE_SIZE_PARAMS: ReadonlySet<string> = new Set([
  'limit',
  'perpage',
  'pagesize',
  'maxresults',
  'first',
]);

/** Arguments that ask for a later page, compared like {@link PAGE_SIZE_PARAMS}. */
const NEXT_PAGE_PARAMS: ReadonlySet<string> = new Set([
  'page',
  'pagenumber',
  'cursor',
  'after',
  'offset',
  'skip',
  'start',
  'startindex',
  'startcursor',
  'startingafter',
  'pagetoken',
  'nexttoken',
  'nextcursor',
  'nextpagetoken',
]);

/** Total-like keys that hold the size of the whole set. */
const TOTAL_KEYS: ReadonlySet<string> = new Set([
  'total',
  'count',
  'totalcount',
  'totalresults',
  'totalitems',
  'totalhits',
  'totalmatches',
  'totalrecords',
  'totalentries',
  'totalsize',
  'resultcount',
  'resultscount',
  'itemcount',
  'itemscount',
  'hitcount',
  'matchcount',
  'matchescount',
  'recordcount',
  'entrycount',
]);

/** Sibling objects whose total-like keys also count (one level deep). */
const META_KEYS: ReadonlySet<string> = new Set([
  'meta',
  'metadata',
  'pagination',
  'paging',
  'pageinfo',
]);

export interface ResultNotesInput {
  /** The result value: `structuredContent`, a text block's text (JSON is parsed here), or content. */
  value: unknown;
  /** The arguments the call was made with. */
  args: Record<string, unknown>;
  /** The tool's input schema as the server declared it. */
  inputSchema: Record<string, unknown>;
  /** Server text beside `structuredContent` ({@link serverNoteText}), already redacted. */
  serverNote?: string;
}

/**
 * The notes for one successful result, at most {@link MAX_NOTES_PER_RESULT},
 * each a single neutralized line. Empty when nothing says the result is
 * partial and the server sent no side text. Total: never throws.
 */
export function resultNotes(input: ResultNotesInput): string[] {
  const notes: string[] = [];
  const value = parsedValue(input.value);
  const count = countSignal(value);
  if (count !== undefined && count.total > count.shown) {
    notes.push(
      `Partial result: ${quote(count.arrayKey)} holds ${count.shown} of ${count.total} (per ${quote(count.totalKey)}). Narrow the query, raise the limit or fetch the next page before treating these as all of them.`,
    );
  } else if (count === undefined || count.total !== count.shown) {
    const page = fullPage(value, input.args, input.inputSchema);
    if (page !== undefined) notes.push(page);
  }
  if (input.serverNote !== undefined) {
    const text = oneLine(input.serverNote);
    if (text.length > 0) {
      notes.push(`Note from the server, beside its structured result: ${JSON.stringify(text)}`);
    }
  }
  return notes.slice(0, MAX_NOTES_PER_RESULT);
}

/**
 * The text a server sent beside its `structuredContent`, when it is a note
 * and not a mirror of the data: of the first {@link MAX_NOTE_BLOCKS} text
 * blocks, those of at most
 * {@link MAX_SERVER_NOTE_CHARS} characters that do not parse as JSON, do
 * not contain the structured value's JSON and do not merely restate it in
 * prose ({@link restates}), joined, and at most that long
 * together (longer side text is a rendering of the data and stays dropped). Raw: the caller redacts it
 * (S1) and {@link resultNotes} neutralizes it (S5).
 */
export function serverNoteText(content: unknown, structured: unknown): string | undefined {
  if (!Array.isArray(content) || structured === undefined) return undefined;
  let mirror: string | undefined;
  try {
    mirror = JSON.stringify(structured);
  } catch {
    mirror = undefined;
  }
  const parts: string[] = [];
  // Read once, on the first block that needs them: walking the value per
  // block made many blocks beside a large value quadratic.
  let leaves: Leaves | undefined;
  let blocks = 0;
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'text' || typeof block['text'] !== 'string') continue;
    // A note is a remark or two; past the first few text blocks the side
    // text is a rendering, and reading on would let a server spend our CPU.
    if (++blocks > MAX_NOTE_BLOCKS) break;
    const text = block['text'].trim();
    // Long text is a rendering of the data, not a remark about it.
    if (text.length === 0 || text.length > MAX_SERVER_NOTE_CHARS) continue;
    if (isJsonText(text)) continue;
    if (mirror !== undefined && mirror.length > 2 && text.includes(mirror)) continue;
    leaves ??= collectLeaves(structured);
    if (restates(text, leaves)) continue;
    parts.push(text);
  }
  const joined = parts.join(' ').trim();
  return joined.length > 0 && joined.length <= MAX_SERVER_NOTE_CHARS ? joined : undefined;
}

const NUMBER_TOKEN = /\d+(?:\.\d+)?/g;
/** Text blocks read for a server note; the rest are ignored. */
const MAX_NOTE_BLOCKS = 8;
/** Nodes of a structured value visited when deciding whether text restates it. */
const MAX_LEAVES = 500;
/** String leaves checked for in the text (the first ones found). */
const MAX_STRING_LEAVES_CHECKED = 50;

/** What {@link restates} compares text with: the value's numbers and short strings. */
interface Leaves {
  numbers: Set<string>;
  strings: string[];
}

/**
 * The numbers (leaves, numbers inside string leaves, array lengths) and the
 * short string leaves of a structured value, from at most
 * {@link MAX_LEAVES} nodes of it. Every node visited counts — containers
 * too, so a value of many empty arrays is as cheap as one of many leaves —
 * and the walk is iterative, so depth costs no stack.
 */
function collectLeaves(structured: unknown): Leaves {
  const numbers = new Set<string>();
  const strings: string[] = [];
  const stack: unknown[] = [structured];
  let budget = MAX_LEAVES;
  while (stack.length > 0 && budget > 0) {
    const node = stack.pop();
    budget -= 1;
    if (typeof node === 'number') {
      numbers.add(String(Math.abs(node)));
    } else if (typeof node === 'string') {
      for (const n of node.match(NUMBER_TOKEN) ?? []) numbers.add(n);
      const trimmed = node.trim();
      if (trimmed.length > 0 && trimmed.length <= 200) strings.push(trimmed.toLowerCase());
    } else if (Array.isArray(node)) {
      numbers.add(String(node.length));
      // Pushed in reverse, so items are read in order; no more than the budget.
      for (let i = Math.min(node.length, budget) - 1; i >= 0; i--) stack.push(node[i]);
    } else if (isRecord(node)) {
      const keys = Object.keys(node);
      for (let i = Math.min(keys.length, budget) - 1; i >= 0; i--)
        stack.push(node[keys[i] as string]);
    }
  }
  return { numbers, strings };
}

/**
 * Whether short text only restates the structured value in prose ("Oslo:
 * 21C, clear" beside `{ city, tempC, sky }`), and so is not a note: every
 * number in the text is a number of the value (a leaf, a number inside a
 * string leaf, or an array's length), and at least half of the value's
 * string leaves appear in the text when it has any. A remark that adds
 * something — "resulted in 40 documents, returning 10" beside ten
 * documents, or a warning that quotes none of the data — is kept.
 */
function restates(text: string, { numbers, strings }: Leaves): boolean {
  for (const n of text.match(NUMBER_TOKEN) ?? []) {
    if (!numbers.has(n)) return false;
  }
  if (strings.length === 0) return true;
  const lower = text.toLowerCase();
  const checked = strings.slice(0, MAX_STRING_LEAVES_CHECKED);
  const found = checked.filter((leaf) => lower.includes(leaf)).length;
  return found * 2 >= checked.length;
}

/**
 * The value parsed when it is JSON text for an object or array — how a
 * text-only server returns a list — and the value itself otherwise.
 */
export function parsedValue(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > MAX_PARSE_CHARS) return value;
  const parsed = parseJsonContainer(value);
  return parsed === undefined ? value : parsed.value;
}

/** Deepest JSON text parsed for a machine or a note; deeper text stays text. */
export const MAX_PARSE_DEPTH = 64;

/**
 * `{ value }` when `text` is JSON for an object or an array, else
 * `undefined` (scalars, invalid JSON, and JSON nested deeper than
 * {@link MAX_PARSE_DEPTH}, which no data needs and whose parsed value
 * overflowed the stack wherever it went next: 1,000 `[` crashed a
 * machine's segment). Shared with the machine host, which hands such a
 * value to the machine parsed (D29).
 */
export function parseJsonContainer(text: string): { value: unknown } | undefined {
  const trimmed = text.trim();
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return undefined;
  if (jsonDepthExceeds(trimmed, MAX_PARSE_DEPTH)) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === 'object' && value !== null ? { value } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether JSON text nests brackets deeper than `max`, scanning it once and
 * skipping string contents. Invalid JSON may answer either way; the parse
 * that follows rejects it.
 */
function jsonDepthExceeds(text: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (inString) {
      if (code === 0x5c) i += 1;
      else if (code === 0x22) inString = false;
    } else if (code === 0x22) {
      inString = true;
    } else if (code === 0x5b || code === 0x7b) {
      depth += 1;
      if (depth > max) return true;
    } else if (code === 0x5d || code === 0x7d) {
      depth -= 1;
    }
  }
  return false;
}

function isJsonText(text: string): boolean {
  const first = text[0];
  if (first !== '{' && first !== '[' && first !== '"') return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

interface CountSignal {
  arrayKey: string;
  shown: number;
  totalKey: string;
  total: number;
}

/**
 * The single top-level array and a total-like integer about it, if the
 * result has exactly that shape. Of several total-like keys, the largest
 * value wins (a page count is never total-like, so the largest is the set).
 */
function countSignal(value: unknown): CountSignal | undefined {
  const main = mainArray(value);
  if (main === undefined || main.key === undefined || !isRecord(value)) return undefined;
  const arrayKey = main.key;
  let best: { key: string; total: number } | undefined;
  const consider = (record: Record<string, unknown>, prefix: string): void => {
    for (const key of Object.keys(record)) {
      const total = record[key];
      if (!isTotalKey(key, arrayKey)) continue;
      if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) continue;
      if (best === undefined || total > best.total) best = { key: `${prefix}${key}`, total };
    }
  };
  consider(value, '');
  for (const key of Object.keys(value)) {
    const nested = value[key];
    if (META_KEYS.has(normalize(key)) && isRecord(nested)) consider(nested, `${key}.`);
  }
  if (best === undefined) return undefined;
  return { arrayKey, shown: main.items.length, totalKey: best.key, total: best.total };
}

function isTotalKey(key: string, arrayKey: string): boolean {
  const n = normalize(key);
  if (TOTAL_KEYS.has(n)) return true;
  const a = normalize(arrayKey);
  const singular = a.endsWith('s') ? a.slice(0, -1) : a;
  return [a, singular].some((name) => n === `total${name}` || n === `${name}count`);
}

/**
 * The note for a page exactly as long as the page size, or undefined. The
 * page size is the page-size argument sent, else that argument's schema
 * default; with neither, nothing is known and nothing is said.
 */
function fullPage(
  value: unknown,
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): string | undefined {
  const properties = isRecord(schema['properties']) ? schema['properties'] : undefined;
  if (properties === undefined) return undefined;
  const names = Object.keys(properties);
  const sizeParam = names.find((name) => PAGE_SIZE_PARAMS.has(normalize(name)));
  if (sizeParam === undefined) return undefined;
  const sent = Object.hasOwn(args, sizeParam) ? args[sizeParam] : undefined;
  const property = properties[sizeParam];
  const fallback = isRecord(property) ? property['default'] : undefined;
  const size = isPageSize(sent) ? sent : sent === undefined && isPageSize(fallback) ? fallback : 0;
  if (size === 0) return undefined;
  const main = mainArray(value);
  if (main === undefined || main.items.length !== size) return undefined;
  const nextParam = names.find((name) => NEXT_PAGE_PARAMS.has(normalize(name)));
  const how =
    sent === undefined ? `the default of ${quote(sizeParam)}` : `the ${quote(sizeParam)} sent`;
  const next =
    nextParam !== undefined
      ? `raise ${quote(sizeParam)} or fetch the next page with ${quote(nextParam)}`
      : `raise ${quote(sizeParam)}`;
  return `Page full: ${size} items, exactly ${how}, so more may exist. To see them all, ${next} before treating these as all of them.`;
}

function isPageSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** The result's main array: the value itself, or its one top-level array field. */
function mainArray(value: unknown): { key?: string; items: unknown[] } | undefined {
  if (Array.isArray(value)) return { items: value };
  if (!isRecord(value)) return undefined;
  let found: { key: string; items: unknown[] } | undefined;
  for (const key of Object.keys(value)) {
    const field = value[key];
    if (!Array.isArray(field)) continue;
    if (found !== undefined) return undefined;
    found = { key, items: field };
  }
  return found;
}

function normalize(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

/** A server key name as inert, bounded, quoted data (S5). */
function quote(key: string): string {
  return JSON.stringify(oneLine(capLength(key, MAX_KEY_CHARS)));
}

/** Server text on one inert line: invisible characters gone, whitespace runs collapsed, the rest neutralized. */
function oneLine(text: string): string {
  return neutralizeControlChars(stripInvisible(text).replace(/\s+/g, ' ').trim())
    .replace(/�{2,}/g, '�')
    .trim();
}
