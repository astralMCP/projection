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

import { capLength, neutralizeControlChars } from '../text-safety.js';
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
