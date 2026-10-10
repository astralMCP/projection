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
 *    survive; everything else (examples, defaults, comments, vendor keys)
 *    is dropped;
 * 2. string neutralization — every string VALUE has control and bidi
 *    characters replaced and is length-capped. Property NAMES and
 *    `required` entries are kept verbatim: they are the keys the model must
 *    send back, and `JSON.stringify` already renders them inert;
 * 3. a size cap — the rendered schema is bounded per tool, degrading in
 *    deterministic stages (drop prose → prune deep subtrees → keep the
 *    top-level shape) and flagging truncation explicitly so the model knows
 *    the wrapped server enforces more than it can see.
 *
 * Pure and total: never throws, never returns anything but plain JSON.
 */

import { capLength, neutralizeControlChars } from '../text-safety.js';
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
]);

/** Rendered-schema cap per tool, in characters of its JSON text (R34). */
export const MAX_SCHEMA_CHARS = 16 * 1024;

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
  /** True when the size cap forced the schema to be reduced (R34). */
  truncated: boolean;
}

interface Stage {
  /** Drop `description` / `title` everywhere. */
  dropProse: boolean;
  /** Replace schema nodes deeper than {@link PRUNE_DEPTH} with a marker. */
  prune: boolean;
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
    const candidate = sanitizeNode(schema, stage, 0);
    if (JSON.stringify(candidate).length <= maxChars) {
      return { schema: candidate, truncated: index > 0 };
    }
  }

  // Stage 4: the top-level shape only. `required` names are needed to call
  // the tool at all; `type` tells the model what kind of value to send.
  const minimal: Record<string, unknown> = { [TRUNCATED_MARKER]: true };
  if (typeof schema['type'] === 'string') minimal['type'] = neutralize(schema['type']);
  const required = sanitizeNames(schema['required']);
  if (required !== undefined) minimal['required'] = required;
  return { schema: minimal, truncated: true };
}

function sanitizeNode(node: unknown, stage: Stage, depth: number): Record<string, unknown> {
  if (!isRecord(node)) return {};
  if (depth > MAX_DEPTH || (stage.prune && depth > PRUNE_DEPTH)) {
    return { [TRUNCATED_MARKER]: true };
  }
  const out: Record<string, unknown> = {};
  // Own enumerable keys only: a `__proto__` key is ordinary data here.
  for (const key of Object.keys(node)) {
    if (!SCHEMA_KEY_ALLOWLIST.has(key)) continue;
    if (stage.dropProse && PROSE_KEYS.has(key)) continue;
    const value = node[key];
    if (SCHEMA_MAPS.has(key)) {
      if (!isRecord(value)) continue;
      const map: Record<string, unknown> = {};
      for (const name of Object.keys(value)) {
        map[name] = sanitizeNode(value[name], stage, depth + 1);
      }
      out[key] = map;
    } else if (SCHEMA_SINGLE.has(key)) {
      if (typeof value === 'boolean') out[key] = value;
      else if (isRecord(value)) out[key] = sanitizeNode(value, stage, depth + 1);
    } else if (SCHEMA_LISTS.has(key)) {
      if (!Array.isArray(value)) continue;
      out[key] = value.map((item) => sanitizeNode(item, stage, depth + 1));
    } else if (key === 'required') {
      const names = sanitizeNames(value);
      if (names !== undefined) out[key] = names;
    } else if (key === 'type') {
      if (typeof value === 'string') out[key] = neutralize(value);
      else if (Array.isArray(value)) {
        out[key] = value.filter((v): v is string => typeof v === 'string').map(neutralize);
      }
    } else if (key === 'enum') {
      if (Array.isArray(value)) out[key] = value.map((item) => sanitizeLiteral(item, 0));
    } else if (key === 'const') {
      out[key] = sanitizeLiteral(value, 0);
    } else if (PROSE_KEYS.has(key) || STRING_KEYS.has(key)) {
      if (typeof value === 'string') out[key] = neutralize(value);
    } else if (NUMBER_KEYS.has(key)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    }
  }
  return out;
}

/** `required` is a list of property names: kept verbatim, non-strings dropped. */
function sanitizeNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * `enum` / `const` members are literal data the model may echo back; strings
 * are neutralized, numbers/booleans/null pass, and nested structures recurse
 * as plain data (not as schemas).
 */
function sanitizeLiteral(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return neutralize(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (depth > MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.map((item) => sanitizeLiteral(item, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = sanitizeLiteral(value[key], depth + 1);
    return out;
  }
  return null;
}

function neutralize(text: string): string {
  return neutralizeControlChars(capLength(text, MAX_STRING_CHARS), { allowNewline: true });
}
