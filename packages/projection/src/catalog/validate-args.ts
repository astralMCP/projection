/**
 * Structural argument validation for `call_tool` (PRD R35.1).
 *
 * Deliberately shallow: required properties present, top-level property
 * types match, enum membership for top-level primitives, and no unknown
 * top-level properties when the schema forbids them. It exists so a human
 * is never asked to approve a call the wrapped server would reject on
 * shape, and so the model gets a `validate` hint naming the property and
 * showing the tool's call signature (D32). Full
 * JSON Schema validation would run twice — the wrapped server is the
 * authority — for nothing but a nicer error message (D9).
 *
 * Own-property semantics throughout: `__proto__` or `constructor` as an
 * argument name is ordinary data (S5/S6).
 */

import { ProjectionError } from '../errors.js';
import { capLength, neutralizeControlChars } from '../text-safety.js';
import { isRecord } from '../types.js';
import { callSignature, signatureLine } from './signature.js';

const MAX_NAME_CHARS = 200;

/** Throws a `validate`-phase {@link ProjectionError} naming the offending property. */
export function validateArgsShape(
  toolName: string,
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
  caller: 'call_tool' | 'toolCall' = 'call_tool',
): void {
  const safeTool = inert(toolName);
  // The hint carries the tool's call signature (D32), so a call made
  // straight from a search hit, or from a guess, is fixed in one retry
  // instead of a describe_tool turn and a retry. Built only on failure.
  const fail = (property: string, why: string): ProjectionError =>
    new ProjectionError('validate', `${caller} ${safeTool}: argument ${inert(property)} ${why}`, {
      hint: `${safeTool} takes ${signatureLine(callSignature(schema))}. Fix argument ${inert(property)} and try again.`,
    });

  const properties = isRecord(schema['properties']) ? schema['properties'] : {};

  if (Array.isArray(schema['required'])) {
    for (const name of schema['required']) {
      if (typeof name === 'string' && !Object.hasOwn(args, name)) {
        throw fail(name, 'is required but missing');
      }
    }
  }

  for (const name of Object.keys(args)) {
    if (!Object.hasOwn(properties, name)) {
      if (schema['additionalProperties'] === false) {
        throw fail(name, 'is not an argument this tool accepts');
      }
      continue;
    }
    const property = properties[name];
    if (!isRecord(property)) continue;
    const value = args[name];
    const expected = expectedTypes(property['type']);
    if (expected.length > 0 && !expected.some((type) => matchesType(value, type))) {
      throw fail(name, `must be of type ${expected.join(' | ')}, got ${describe(value)}`);
    }
    if (
      Array.isArray(property['enum']) &&
      isPrimitive(value) &&
      !property['enum'].includes(value)
    ) {
      throw fail(name, `must be one of the values listed in the schema's enum`);
    }
  }
}

function expectedTypes(type: unknown): string[] {
  if (typeof type === 'string') return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === 'string');
  return [];
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    default:
      // An unknown type keyword is not ours to enforce.
      return true;
  }
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function inert(text: string): string {
  return JSON.stringify(neutralizeControlChars(capLength(text, MAX_NAME_CHARS)));
}
