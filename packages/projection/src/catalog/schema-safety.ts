/**
 * JSON Schema sanitizer for `describe_tool` (PRD R34, S5).
 *
 * The wrapped server's schemas are the injection surface of the catalog
 * projection: beyond `description`, a server controls free text in
 * `title`, nested descriptions, `examples`, `default`, `$comment`, `x-*`
 * vendor keys, `enum` members and `pattern`. Before a schema reaches the
 * model it passes through:
 *
 * 1. a key allowlist — only the keywords a model needs to build arguments
 *    survive; everything else (examples, comments, vendor keys) is dropped.
 *    `default` survives only as a scalar the model can act on (a number, a
 *    boolean, `null`, or a short plain string — {@link safeDefault}): an
 *    omitted argument silently takes it, and a model that cannot see a
 *    default page size reads a page as the whole set (D29);
 * 2. string neutralization — every string VALUE has control and bidi
 *    characters replaced and is length-capped. Property NAMES and
 *    `required` entries are kept verbatim: they are the keys the model must
 *    send back, and `JSON.stringify` already renders them inert. A name
 *    longer than the string cap is dropped outright (with its `required`
 *    entry) — unusable as a key, and otherwise a way around the size cap;
 * 3. a size cap — the rendered schema is bounded per tool, degrading in
 *    deterministic stages (drop prose → prune deep subtrees → keep the
 *    top-level shape → the marker alone) and flagging truncation explicitly
 *    so the model knows the wrapped server enforces more than it can see.
 *
 * Pure and total: never throws, never returns anything but plain JSON.
 */

import { capLength, neutralizeControlChars, stripInvisible } from '../text-safety.js';
import { isRecord } from '../types.js';

/** Keywords that survive sanitization (R34). */
export const SCHEMA_KEY_ALLOWLIST: ReadonlySet<string> = new Set([
  'type',
  'properties',
  'required',
  'items',
  'prefixItems',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  '$ref',
  '$defs',
  'additionalProperties',
  'description',
  'title',
  'format',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'default',
]);

/** Rendered-schema cap per tool, in characters of its JSON text (R34). */
export const MAX_SCHEMA_CHARS = 16 * 1024;

/** Cap on every string value, and on property / `required` names (longer ones are dropped). */
const MAX_STRING_CHARS = 2_000;
const MAX_DEPTH = 32;
/** Schema-node depth kept when pruning (stage 3): the top level and its properties. */
const PRUNE_DEPTH = 2;
const TRUNCATED_MARKER = '$truncated';

/** Keywords whose value is a map of arbitrary names → subschemas. */
const SCHEMA_MAPS: ReadonlySet<string> = new Set(['properties', '$defs']);
/** Keywords whose value is a single subschema (or a boolean). */
const SCHEMA_SINGLE: ReadonlySet<string> = new Set(['items', 'not', 'additionalProperties']);
/** Keywords whose value is an array of subschemas. */
const SCHEMA_LISTS: ReadonlySet<string> = new Set(['prefixItems', 'anyOf', 'oneOf', 'allOf']);
/** Keywords whose value is free text from the server. */
const PROSE_KEYS: ReadonlySet<string> = new Set(['description', 'title']);
/** Keywords whose string values are needed verbatim-ish but still neutralized. */
const STRING_KEYS: ReadonlySet<string> = new Set(['$ref', 'format', 'pattern']);
const NUMBER_KEYS: ReadonlySet<string> = new Set(['minimum', 'maximum', 'minLength', 'maxLength']);

export interface SanitizedSchema {
  /** The sanitized schema, always a plain JSON object. */
  schema: Record<string, unknown>;
  /** True when anything the server declared was cut: by the size cap, the depth cap or the name cap (R34). */
  truncated: boolean;
}

interface Stage {
  /** Drop `description` / `title` everywhere. */
  dropProse: boolean;
  /** Replace schema nodes deeper than {@link PRUNE_DEPTH} with a marker. */
  prune: boolean;
}

/** Threaded through one sanitization pass: did it cut anything the server declared? */
interface PassState {
  cut: boolean;
}

/**
 * Sanitize a tool schema for the model (R34).
 *
 * Non-object input (a server declaring `inputSchema: true`, or garbage)
 * sanitizes to `{}`.
 */
export function sanitizeSchema(schema: unknown, maxChars = MAX_SCHEMA_CHARS): SanitizedSchema {
  if (!isRecord(schema)) return { schema: {}, truncated: false };

  const stages: Stage[] = [
    { dropProse: false, prune: false },
    { dropProse: true, prune: false },
    { dropProse: true, prune: true },
  ];
  for (const [index, stage] of stages.entries()) {
    const state: PassState = { cut: false };
    const candidate = sanitizeNode(schema, stage, 0, state);
    if (JSON.stringify(candidate).length <= maxChars) {
      return { schema: candidate, truncated: index > 0 || state.cut };
    }
  }

  // Stage 4: the top-level shape only. `type` tells the model what kind of
  // value to send; `required` names are needed to call the tool at all.
  const minimal: Record<string, unknown> = { [TRUNCATED_MARKER]: true };
  if (typeof schema['type'] === 'string') minimal['type'] = neutralize(schema['type']);
  if (JSON.stringify(minimal).length > maxChars) {
    // Stage 5: not even the type fits — the marker alone.
    return { schema: { [TRUNCATED_MARKER]: true }, truncated: true };
  }
  // The names themselves can blow the cap (thousands of required
  // properties): keep the longest prefix of them that still fits.
  const required = fitNames(
    sanitizeNames(schema['required'], { cut: false }) ?? [],
    minimal,
    maxChars,
  );
  if (required.length > 0) minimal['required'] = required;
  return { schema: minimal, truncated: true };
}

function sanitizeNode(
  node: unknown,
  stage: Stage,
  depth: number,
  state: PassState,
): Record<string, unknown> {
  if (!isRecord(node)) return {};
  if (depth > MAX_DEPTH || (stage.prune && depth > PRUNE_DEPTH)) {
    state.cut = true;
    return { [TRUNCATED_MARKER]: true };
  }
  const out: Record<string, unknown> = {};
  // Own enumerable keys only, and the allowlist decides which are read, so
  // `out[key] = …` never meets a `__proto__` key. The maps below DO carry
  // arbitrary server-chosen names, hence `Object.fromEntries` there.
  for (const key of Object.keys(node)) {
    if (!SCHEMA_KEY_ALLOWLIST.has(key)) continue;
    if (stage.dropProse && PROSE_KEYS.has(key)) continue;
    const value = node[key];
    if (SCHEMA_MAPS.has(key)) {
      if (!isRecord(value)) continue;
      // Property names are server data (S5). `Object.fromEntries` defines
      // each as an own property, where `map[name] = …` on a plain object
      // would hit the `__proto__` setter and silently reparent the map.
      const entries: [string, unknown][] = [];
      for (const name of Object.keys(value)) {
        if (name.length > MAX_STRING_CHARS) {
          state.cut = true;
          continue;
        }
        entries.push([name, sanitizeNode(value[name], stage, depth + 1, state)]);
      }
      out[key] = Object.fromEntries(entries);
    } else if (SCHEMA_SINGLE.has(key)) {
      if (typeof value === 'boolean') out[key] = value;
      else if (isRecord(value)) out[key] = sanitizeNode(value, stage, depth + 1, state);
    } else if (SCHEMA_LISTS.has(key)) {
      if (!Array.isArray(value)) continue;
      out[key] = value.map((item) => sanitizeNode(item, stage, depth + 1, state));
    } else if (key === 'required') {
      const names = sanitizeNames(value, state);
      if (names !== undefined) out[key] = names;
    } else if (key === 'type') {
      if (typeof value === 'string') out[key] = neutralize(value);
      else if (Array.isArray(value)) {
        out[key] = value.filter((v): v is string => typeof v === 'string').map(neutralize);
      }
    } else if (key === 'enum') {
      if (Array.isArray(value)) out[key] = value.map((item) => sanitizeLiteral(item, 0, state));
    } else if (key === 'const') {
      out[key] = sanitizeLiteral(value, 0, state);
    } else if (PROSE_KEYS.has(key) || STRING_KEYS.has(key)) {
      if (typeof value === 'string') out[key] = neutralize(value);
    } else if (key === 'default') {
      const kept = safeDefault(value);
      if (kept !== undefined) out[key] = kept.value;
    } else if (NUMBER_KEYS.has(key)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    }
  }
  return out;
}

/** Longest string `default` kept; a longer one is dropped, never cut (a cut default is a wrong one). */
export const MAX_DEFAULT_CHARS = 64;

/**
 * A schema `default` the model may see (R34, D29), boxed so `null` is
 * distinguishable from "dropped": finite numbers, booleans and `null` as
 * they are; a string only when it is at most {@link MAX_DEFAULT_CHARS}
 * characters and carries no control, bidi or invisible character — such a
 * string is shown as it is or not at all, so what the model reads is the
 * value the server applies. Object and array defaults are dropped: they
 * are free-form server data, and the scalar case is the one that changes
 * what a call returns (a page size, a flag). Shared with typegen's
 * `@default` doc tag.
 */
export function safeDefault(
  value: unknown,
): { value: string | number | boolean | null } | undefined {
  if (value === null || typeof value === 'boolean') return { value };
  if (typeof value === 'number') return Number.isFinite(value) ? { value } : undefined;
  if (typeof value !== 'string' || value.length > MAX_DEFAULT_CHARS) return undefined;
  return neutralizeControlChars(stripInvisible(value)) === value ? { value } : undefined;
}

/**
 * `required` is a list of property names: kept verbatim, non-strings dropped
 * silently, over-long names dropped as a cut (they match no kept property).
 */
function sanitizeNames(value: unknown, state: PassState): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    if (item.length > MAX_STRING_CHARS) {
      state.cut = true;
      continue;
    }
    names.push(item);
  }
  return names;
}

/**
 * The longest prefix of `names` that keeps `{ ...minimal, required: names }`
 * within `maxChars` once rendered. Sized incrementally rather than by
 * re-rendering per name, so a hostile list of 100k names costs O(n).
 */
function fitNames(names: string[], minimal: Record<string, unknown>, maxChars: number): string[] {
  // Rendered: `{...minimal,"required":[` + names joined by `,` + `]}`.
  let size = JSON.stringify({ ...minimal, required: [] }).length;
  const kept: string[] = [];
  for (const name of names) {
    const cost = JSON.stringify(name).length + (kept.length > 0 ? 1 : 0);
    if (size + cost > maxChars) break;
    kept.push(name);
    size += cost;
  }
  return kept;
}

/**
 * `enum` / `const` members are literal data the model may echo back; strings
 * are neutralized, numbers/booleans/null pass, and nested structures recurse
 * as plain data (not as schemas). Object keys are server data too, so the
 * copy is built with `Object.fromEntries` (see `sanitizeNode`).
 */
function sanitizeLiteral(value: unknown, depth: number, state: PassState): unknown {
  if (typeof value === 'string') return neutralize(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (depth > MAX_DEPTH) {
    state.cut = true;
    return null;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeLiteral(item, depth + 1, state));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).map((key) => [key, sanitizeLiteral(value[key], depth + 1, state)]),
    );
  }
  return null;
}

function neutralize(text: string): string {
  return neutralizeControlChars(capLength(text, MAX_STRING_CHARS), { allowNewline: true });
}
