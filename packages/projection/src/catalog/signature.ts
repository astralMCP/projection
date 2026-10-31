/**
 * Compact call signatures (DECISIONS D32): a tool's top-level arguments on
 * one line, so a model can `call_tool` straight from a search hit or a
 * `validate` error instead of spending a turn on `describe_tool`.
 *
 *   {owner: string, repo: string, state?: "open"|"closed", perPage?: number = 30}
 *
 * Required arguments first (in declaration order), then optional ones
 * (`?`), each with its type: JSON Schema types, `T[]` for arrays, the
 * literal members of an `enum` or `const`, and a scalar default (`= 30`)
 * when the sanitizer kept one (D29). Only the top level is rendered: an
 * object or array-of-objects argument shows as `object` / `object[]` and
 * the signature says `describe_tool` has the full schema; so does one cut
 * to fit {@link MAX_SIGNATURE_CHARS}.
 *
 * S5: built from the SANITIZED schema only ({@link sanitizeSchema}), so
 * every enum string and default already passed the allowlist and the
 * default rule. Property names stay server data: a name that is a plain
 * identifier prints bare, any other is JSON-quoted after neutralization,
 * and a name too long to print whole is left out (and the signature marked
 * incomplete) rather than shown cut — a cut name is a wrong key. Type words
 * outside the JSON Schema vocabulary print as `any`. The result is one
 * line: nothing a server writes can open a line of its own.
 */

import { capLength, neutralizeControlChars, stripInvisible } from '../text-safety.js';
import { isRecord } from '../types.js';
import { safeDefault, sanitizeSchema } from './schema-safety.js';

/** A tool's compact call signature. */
export interface CallSignature {
  /** One line: `{a: string, b?: number = 1}`; `{}` for a tool that takes no arguments. */
  text: string;
  /**
   * True when the line shows the whole input schema's top level: no
   * nested object fields, no argument cut for length, no enum cut short,
   * no schema the sanitizer truncated. Copy otherwise says `describe_tool`
   * has the full schema.
   */
  complete: boolean;
  /**
   * True when a call can be built from the line alone: the top level is a
   * plain object of properties and every required argument is shown with
   * a flat type. What is missing, if anything, is optional. Copy otherwise
   * says to call `describe_tool` first.
   */
  callable: boolean;
}

/**
 * Where optional arguments stop, in characters (required ones go on to
 * twice this). Sized on the eval
 * fixtures (D32): it keeps every argument of 93 of the 95 GitHub tools,
 * all 21 MongoDB and all 14 filesystem tools; the cut ones say so.
 */
export const MAX_SIGNATURE_CHARS = 480;
/** Required arguments are listed past {@link MAX_SIGNATURE_CHARS}, up to this. */
const MAX_REQUIRED_CHARS = 2 * MAX_SIGNATURE_CHARS;
/** Longest property name printed; a longer one is left out, never cut. */
const MAX_NAME_CHARS = 64;
/**
 * Enum members listed before `|…`. Twelve covers every `method`-style
 * selector in the eval fixtures (the largest has 10) and leaves the long
 * field-name lists (22–25 members) cut.
 */
const MAX_ENUM_MEMBERS = 12;
/** Longest enum or const string member printed whole; longer ones are cut with `…`. */
const MAX_LITERAL_CHARS = 40;
/** Members of an `anyOf` / `oneOf` rendered as a union before it reads `any`. */
const MAX_UNION_MEMBERS = 4;
/** Nesting followed for array item and union types (`string[][]`). */
const MAX_TYPE_DEPTH = 3;

const TYPE_WORDS: ReadonlySet<string> = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'null',
  'object',
  'array',
]);
/** What rendering one argument's type left out. */
interface Partiality {
  /** A nested shape or an unrendered type: a value cannot be built from the line. */
  nested: boolean;
  /** An enum cut short: the shown members are valid, the full schema has more. */
  cut: boolean;
}

const PROSE_KEYS: ReadonlySet<string> = new Set(['description', 'title']);
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The compact signature of a tool's input schema; never throws. */
export function callSignature(inputSchema: unknown): CallSignature {
  const sanitized = sanitizeSchema(inputSchema);
  const schema = sanitized.schema;
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};
  const required = Array.isArray(schema['required'])
    ? schema['required'].filter((name): name is string => typeof name === 'string')
    : [];
  // A top level that is not a plain object of properties (a union, a $ref,
  // or a schema the sanitizer cut to its marker) cannot be shown flat.
  const flat =
    !sanitized.truncated &&
    !['anyOf', 'oneOf', 'allOf', '$ref', 'not'].some((key) => Object.hasOwn(schema, key));
  const requiredSet = new Set(required);
  const order = [
    ...new Set([...required, ...Object.keys(properties).filter((n) => !requiredSet.has(n))]),
  ];
  const parts: string[] = [];
  let length = 2; // the braces
  let omitted = 0;
  let partial = !flat;
  let callable = flat;
  for (const name of order) {
    const optional = !requiredSet.has(name);
    const key = renderName(name);
    const state: Partiality = { nested: false, cut: false };
    let part = '';
    if (key !== undefined) {
      const property = properties[name];
      part = `${key}${optional ? '?' : ''}: ${renderType(property, 0, state)}`;
      const kept = isRecord(property) ? safeDefault(property['default']) : undefined;
      if (kept !== undefined) part += ` = ${JSON.stringify(kept.value)}`;
    }
    const cost = part.length + (parts.length > 0 ? 2 : 0);
    // Required arguments are listed past the cap (a call without them
    // fails), up to a hard bound a hostile schema cannot stretch; optional
    // ones only while the line fits.
    const limit = optional ? MAX_SIGNATURE_CHARS : MAX_REQUIRED_CHARS;
    if (key === undefined || length + cost > limit) {
      omitted += 1;
      partial = true;
      if (!optional) callable = false;
      continue;
    }
    if (state.nested || state.cut) partial = true;
    if (state.nested && !optional) callable = false;
    parts.push(part);
    length += cost;
  }
  const more = omitted > 0 ? `${parts.length > 0 ? ', ' : ''}…${omitted} more` : '';
  return {
    text: neutralizeControlChars(`{${parts.join(', ')}${more}}`),
    complete: !partial,
    callable,
  };
}

/** A property name as the signature prints it, or undefined when too long to print whole. */
function renderName(name: string): string | undefined {
  if (name.length > MAX_NAME_CHARS) return undefined;
  if (IDENTIFIER.test(name)) return name;
  return neutralizeControlChars(JSON.stringify(name));
}

/** One (sanitized) property schema's type, compactly. */
function renderType(node: unknown, depth: number, state: Partiality): string {
  if (!isRecord(node)) return 'any';
  if (Array.isArray(node['enum'])) return renderLiterals(node['enum'], state);
  if (Object.hasOwn(node, 'const')) return renderLiterals([node['const']], state);
  const type = node['type'];
  if (typeof type === 'string') return renderTypeWord(type, node, depth, state);
  if (Array.isArray(type)) {
    const words = type.filter((t): t is string => typeof t === 'string');
    if (words.length > 0) {
      return [...new Set(words.map((t) => renderTypeWord(t, node, depth, state)))].join('|');
    }
  }
  const union = Array.isArray(node['anyOf'])
    ? node['anyOf']
    : Array.isArray(node['oneOf'])
      ? node['oneOf']
      : undefined;
  if (union !== undefined && union.length <= MAX_UNION_MEMBERS && depth < MAX_TYPE_DEPTH) {
    const members = [...new Set(union.map((member) => renderType(member, depth + 1, state)))];
    if (members.length > 0 && !members.includes('any')) return members.join('|');
  }
  // `$ref`, `allOf`, a big union or no type at all: the shape is somewhere
  // the flat line does not reach.
  if (Object.keys(node).some((key) => !PROSE_KEYS.has(key))) {
    state.nested = true;
  }
  return 'any';
}

function renderTypeWord(
  word: string,
  node: Record<string, unknown>,
  depth: number,
  state: Partiality,
): string {
  if (!TYPE_WORDS.has(word)) return 'any';
  if (word === 'array') {
    const items = node['items'];
    if (!isRecord(items) || depth >= MAX_TYPE_DEPTH) return 'any[]';
    const inner = renderType(items, depth + 1, state);
    return inner.includes('|') ? `(${inner})[]` : `${inner}[]`;
  }
  if (word === 'object') {
    const properties = node['properties'];
    const open = node['additionalProperties'];
    // An object whose fields are declared, or whose values are constrained,
    // has a shape the line does not show; a free-form map does not.
    if (
      (isRecord(properties) && Object.keys(properties).length > 0) ||
      (isRecord(open) && Object.keys(open).some((key) => !PROSE_KEYS.has(key)))
    ) {
      state.nested = true;
    }
  }
  return word;
}

/** Enum / const members: `"a"|"b"|1|null`, at most {@link MAX_ENUM_MEMBERS}. */
function renderLiterals(values: unknown[], state: Partiality): string {
  const shown: string[] = [];
  for (const value of values.slice(0, MAX_ENUM_MEMBERS)) {
    if (typeof value === 'string') {
      // A cut member is not a value the server accepts: say so.
      if (value.length > MAX_LITERAL_CHARS) state.cut = true;
      shown.push(JSON.stringify(capLength(value, MAX_LITERAL_CHARS)));
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      shown.push(JSON.stringify(value));
    } else {
      state.nested = true;
      shown.push('object');
    }
  }
  if (values.length > MAX_ENUM_MEMBERS) {
    shown.push('…');
    state.cut = true;
  }
  return shown.length > 0 ? [...new Set(shown)].join('|') : 'never';
}

/**
 * A signature as copy shows it: `args: {…}`, with a pointer to
 * `describe_tool` when it leaves part of the schema out. Search hits and
 * argument errors share it, so the model reads one format everywhere.
 */
export function signatureLine(signature: CallSignature): string {
  if (signature.complete) return `args: ${signature.text}`;
  if (signature.callable) return `args: ${signature.text} (describe_tool has the full schema)`;
  return `args: ${signature.text} (call describe_tool first: a required argument is nested or not shown)`;
}

/**
 * One argument's meaning, from its description (D33): what a signature's
 * `name: type` cannot say, such as where a `connectionId` comes from or
 * that a `sha` may also be a branch name.
 */
export interface ArgGloss {
  /** The argument's name, as the schema declares it. */
  name: string;
  /** Its description on one line: whitespace collapsed, invisible characters gone, neutralized, capped. */
  text: string;
}

/**
 * Longest gloss on a search page, in characters, before `…`. Sized on the
 * eval fixtures (D33): it holds the median informative GitHub description
 * whole (48 characters) and keeps the instruction in the first sentences
 * of a longer one (Sentry's median is 124, MongoDB's `connectionId` 173);
 * past it are option lists and examples that `describe_tool` serves.
 */
export const MAX_GLOSS_CHARS = 120;
/**
 * Longest gloss in an error hint (D33). A rejected call is rare and is
 * where the meaning is missed, so the hint may show twice a search page's.
 */
export const MAX_HINT_GLOSS_CHARS = 2 * MAX_GLOSS_CHARS;
/** Raw description read for a gloss: bounds the work a hostile description can cause. */
const MAX_RAW_GLOSS_CHARS = 2_000;
/**
 * Words that carry no meaning of their own in an argument description:
 * articles, prepositions and the nouns every identifier is ("name",
 * "number", "id"). A description made only of these and of words from the
 * tool's or its arguments' names ("Repository name", "The number of the
 * issue") restates the signature, and gets no gloss.
 */
const FILLER_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'be',
  'by',
  'for',
  'from',
  'id',
  'identifier',
  'in',
  'is',
  'it',
  'its',
  'name',
  'new',
  'number',
  'of',
  'on',
  'or',
  'required',
  'the',
  'this',
  'that',
  'to',
  'value',
  'with',
]);
const WORD = /[\p{L}\p{N}]+/gu;

/**
 * The glosses of a tool's arguments (D33): by default its required ones (a
 * call cannot go without them, and a model that cannot tell what one means
 * invents a value), or the `names` given (the arguments a rejected call
 * sent). An argument gets a gloss when the SANITIZED schema (S5) gives it a
 * description that says something its name does not: one made only of
 * filler words and words of the tool's or its arguments' names is skipped,
 * and so is an `enum` or `const` argument, whose values the signature
 * already lists (on the GitHub fixture its descriptions were a third of
 * the gloss text and said "The method to execute" or listed the options
 * again). Each gloss is one line cut at a word to `maxChars` (default
 * {@link MAX_GLOSS_CHARS}), and a tool's glosses stop at twice that.
 * Never throws.
 */
export function argGlosses(
  toolName: string,
  inputSchema: unknown,
  options: { names?: readonly string[]; maxChars?: number } = {},
): ArgGloss[] {
  const { names, maxChars = MAX_GLOSS_CHARS } = options;
  const schema = sanitizeSchema(inputSchema).schema;
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};
  const wanted =
    names ??
    (Array.isArray(schema['required'])
      ? schema['required'].filter((name): name is string => typeof name === 'string')
      : []);
  const known = [...nameWords(toolName), ...Object.keys(properties).flatMap(nameWords)];
  const glosses: ArgGloss[] = [];
  let length = 0;
  for (const name of new Set(wanted)) {
    if (!Object.hasOwn(properties, name) || renderName(name) === undefined) continue;
    const property = properties[name];
    if (!isRecord(property) || listsItsValues(property)) continue;
    const description = property['description'];
    if (typeof description !== 'string') continue;
    const line = oneLine(capLength(description, MAX_RAW_GLOSS_CHARS));
    if (line.length === 0 || restatesName(line, known)) continue;
    const text = capAtWord(line, maxChars);
    if (length + text.length > 2 * maxChars) break;
    glosses.push({ name, text });
    length += text.length;
  }
  return glosses;
}

/**
 * Glosses as copy shows them, on one line: `where connectionId: "…"; sha:
 * "…"`. Each gloss is JSON-quoted (S5): server text cannot end its own
 * quote and pass for another argument's gloss, or open a line.
 */
export function glossLine(glosses: readonly ArgGloss[]): string {
  return `where ${glosses.map((g) => `${renderName(g.name) ?? ''}: ${JSON.stringify(g.text)}`).join('; ')}`;
}

/** An `enum` or `const` argument: the signature shows its values. */
function listsItsValues(property: Record<string, unknown>): boolean {
  return Array.isArray(property['enum']) || Object.hasOwn(property, 'const');
}

/** Cut to `max` characters at a word boundary when one is near, then `…`. */
function capAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Server text on one inert line: invisible characters gone, whitespace collapsed, neutralized. */
function oneLine(text: string): string {
  return neutralizeControlChars(stripInvisible(text).replace(/\s+/g, ' ').trim())
    .replace(/�{2,}/g, '�')
    .trim();
}

/** The lowercase words of an identifier: `issue_number`, `pullNumber`, `get-file`. */
function nameWords(name: string): string[] {
  return (
    name
      .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
      .toLowerCase()
      .match(WORD) ?? []
  ).filter((word) => word.length >= 2);
}

/**
 * Whether every word of `description` is filler or one of `known` (the
 * tool's and its arguments' name words, matched as prefixes either way so
 * `repo` covers "repository" and `newName` covers "new").
 */
function restatesName(description: string, known: readonly string[]): boolean {
  const words = description.toLowerCase().match(WORD) ?? [];
  return words.every(
    (word) =>
      word.length < 2 ||
      FILLER_WORDS.has(word) ||
      known.some(
        (k) =>
          word === k ||
          (k.length >= 3 && word.startsWith(k)) ||
          (word.length >= 3 && k.startsWith(word)),
      ),
  );
}
