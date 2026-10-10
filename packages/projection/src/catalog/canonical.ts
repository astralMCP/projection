/**
 * Canonical JSON for the `call_tool` binding hash (PRD R36).
 *
 * A `call` blob is bound to the request that produced it by hashing the
 * canonical text of `{ kind: "call", name, args }`: object keys sorted by
 * UTF-16 code unit order (JavaScript's default sort), array order kept,
 * no whitespace. Both sides canonicalize the *parsed* request, so `1` and
 * `1.0`, `-0` and `0`, escaped and literal characters, and duplicate keys
 * (last wins at parse time) all canonicalize identically. No Unicode
 * normalization is applied — NFC and NFD differ, deliberately failing
 * closed. Values JSON cannot represent (`undefined`, functions, symbols,
 * bigint, non-finite numbers) throw a `validate` error rather than being
 * dropped: the facade is callable outside the SDK (R27), so they can occur.
 *
 * The hash is a coherence check, not the approval binding — S2 is carried
 * by the blob's `pending` entry alone (R36, D9).
 */

import { ProjectionError } from '../errors.js';

const MAX_DEPTH = 64;

/** Canonical JSON text of a plain JSON value. Throws `validate` on non-JSON. */
export function canonicalJson(value: unknown): string {
  return render(value, '$', 0);
}

/** The text a `call` blob is bound to (R36): `{ kind: "call", name, args }`. */
export function canonicalRequest(name: string, args: Record<string, unknown>): string {
  return canonicalJson({ kind: 'call', name, args });
}

function render(value: unknown, path: string, depth: number): string {
  if (depth > MAX_DEPTH) throw invalid(path, 'is nested too deeply');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw invalid(path, 'is not a finite number');
      // JSON.stringify renders -0 as "0", so both zeros canonicalize alike.
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      if (Array.isArray(value)) {
        return `[${value.map((item, index) => render(item, `${path}[${index}]`, depth + 1)).join(',')}]`;
      }
      return renderObject(value as Record<string, unknown>, path, depth);
    default:
      throw invalid(path, `is a ${typeof value}, which JSON cannot carry`);
  }
}

function renderObject(value: Record<string, unknown>, path: string, depth: number): string {
  // Own enumerable keys, default sort = UTF-16 code unit order. A key like
  // `__proto__` is ordinary data here (Object.keys, not property access on
  // a prototype chain).
  const keys = Object.keys(value).sort();
  const members = keys.map((key) => {
    const member: unknown = value[key];
    if (member === undefined)
      throw invalid(`${path}.${key}`, 'is undefined, which JSON cannot carry');
    return `${JSON.stringify(key)}:${render(member, `${path}.${key}`, depth + 1)}`;
  });
  return `{${members.join(',')}}`;
}

function invalid(path: string, why: string): ProjectionError {
  return new ProjectionError('validate', `call_tool args: ${path} ${why}`, {
    hint: 'Pass args as plain JSON: objects, arrays, strings, finite numbers, booleans and null only.',
  });
}
