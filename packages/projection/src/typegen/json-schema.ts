/**
 * Hand-rolled JSON Schema → TypeScript type-text converter (R4).
 *
 * Deliberately a subset: it covers the constructs MCP tool schemas actually
 * use (objects/properties/required, primitive types, enum/const, arrays and
 * tuples, anyOf/oneOf unions, allOf intersections, in-document $ref,
 * additionalProperties, nested objects, property descriptions as doc
 * comments). Anything it does not understand degrades to `unknown` — never
 * an exception — because generated types are model guidance, not a
 * correctness gate (G5: no host-side type checking in the hot path).
 */

import { isRecord } from '../types.js';

const MAX_DEPTH = 24;

interface RenderContext {
  /** Root schema document, for resolving in-document $refs. */
  root: unknown;
  /** Recursion depth guard. */
  depth: number;
  /** $ref pointers currently being expanded (cycle guard). */
  refStack: string[];
  /** Indentation prefix of the line the type appears on. */
  indent: string;
}

/** Render a JSON literal as a TS literal type; non-primitives become `unknown`. */
function literalType(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }
  return 'unknown';
}

/** Resolve an in-document JSON pointer like `#/$defs/Foo`. */
function resolvePointer(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith('#')) return undefined;
  const path = pointer.slice(1);
  if (path === '') return root;
  if (!path.startsWith('/')) return undefined;
  let current: unknown = root;
  for (const rawSegment of path.slice(1).split('/')) {
    const segment = rawSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/** Wrap a type in parentheses when it is a top-level union/intersection. */
function parenthesize(type: string): string {
  return /[|&]/.test(type) ? `(${type})` : type;
}

const BARE_KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Quote an object key unless it is a valid bare property name. */
export function propertyKey(name: string): string {
  return BARE_KEY_RE.test(name) ? name : JSON.stringify(name);
}

/** Format a description as a doc comment block at the given indent. */
export function docComment(description: string, indent: string): string {
  const safe = description.replaceAll('*/', '*\\/').trimEnd();
  const lines = safe.split('\n');
  if (lines.length === 1) return `${indent}/** ${lines[0]} */`;
  return [
    `${indent}/**`,
    ...lines.map((line) => `${indent} * ${line}`.trimEnd()),
    `${indent} */`,
  ].join('\n');
}

function renderEnum(values: unknown[]): string {
  if (values.length === 0) return 'never';
  return values.map(literalType).join(' | ');
}

function renderArray(schema: Record<string, unknown>, ctx: RenderContext): string {
  // Draft 2020-12 tuples use prefixItems; older drafts use an items array.
  const prefixItems = Array.isArray(schema['prefixItems'])
    ? schema['prefixItems']
    : Array.isArray(schema['items'])
      ? schema['items']
      : undefined;
  if (prefixItems !== undefined) {
    const members = prefixItems.map((item) => render(item, deeper(ctx)));
    return `[${members.join(', ')}]`;
  }
  const items = schema['items'];
  if (items === undefined) return 'unknown[]';
  const itemType = render(items, deeper(ctx));
  return /[|&]/.test(itemType) || itemType.includes('\n') ? `Array<${itemType}>` : `${itemType}[]`;
}

function renderObject(schema: Record<string, unknown>, ctx: RenderContext): string {
  const properties = isRecord(schema['properties']) ? schema['properties'] : undefined;
  const additional = schema['additionalProperties'];
  const additionalType = isRecord(additional)
    ? render(additional, deeper(ctx))
    : additional === false
      ? undefined
      : 'unknown';

  if (properties === undefined || Object.keys(properties).length === 0) {
    if (additional === false) return 'Record<string, never>';
    return `Record<string, ${additionalType ?? 'unknown'}>`;
  }

  const required = new Set(
    Array.isArray(schema['required'])
      ? schema['required'].filter((name): name is string => typeof name === 'string')
      : [],
  );
  const childIndent = `${ctx.indent}  `;
  const lines: string[] = ['{'];
  for (const [name, propSchema] of Object.entries(properties)) {
    const description = isRecord(propSchema) ? propSchema['description'] : undefined;
    if (typeof description === 'string' && description.length > 0) {
      lines.push(docComment(description, childIndent));
    }
    const optional = required.has(name) ? '' : '?';
    const type = render(propSchema, { ...deeper(ctx), indent: childIndent });
    lines.push(`${childIndent}${propertyKey(name)}${optional}: ${type};`);
  }
  lines.push(`${ctx.indent}}`);
  const objectType = lines.join('\n');
  // An explicit additionalProperties schema alongside named properties is
  // expressed as an intersection, which stays valid strict TS.
  return isRecord(additional)
    ? `${objectType} & Record<string, ${additionalType ?? 'unknown'}>`
    : objectType;
}

function renderByType(type: string, schema: Record<string, unknown>, ctx: RenderContext): string {
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return renderArray(schema, ctx);
    case 'object':
      return renderObject(schema, ctx);
    default:
      return 'unknown';
  }
}

function deeper(ctx: RenderContext): RenderContext {
  return { ...ctx, depth: ctx.depth + 1 };
}

function render(schema: unknown, ctx: RenderContext): string {
  if (schema === true) return 'unknown';
  if (schema === false) return 'never';
  if (!isRecord(schema)) return 'unknown';
  if (ctx.depth > MAX_DEPTH) return 'unknown';

  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    if (ctx.refStack.includes(ref)) return 'unknown'; // circular $ref
    const resolved = resolvePointer(ctx.root, ref);
    if (resolved === undefined) return 'unknown';
    return render(resolved, { ...deeper(ctx), refStack: [...ctx.refStack, ref] });
  }

  const enumValues = schema['enum'];
  if (Array.isArray(enumValues)) return renderEnum(enumValues);
  if ('const' in schema) return literalType(schema['const']);

  const parts: string[] = [];

  const allOf = schema['allOf'];
  if (Array.isArray(allOf) && allOf.length > 0) {
    parts.push(...allOf.map((member) => render(member, deeper(ctx))));
  }

  const unionMembers = Array.isArray(schema['anyOf'])
    ? schema['anyOf']
    : Array.isArray(schema['oneOf'])
      ? schema['oneOf']
      : undefined;
  if (unionMembers !== undefined && unionMembers.length > 0) {
    parts.push(unionMembers.map((member) => render(member, deeper(ctx))).join(' | '));
  }

  const type = schema['type'];
  if (Array.isArray(type)) {
    const members = type
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => renderByType(entry, schema, ctx));
    if (members.length > 0) parts.push(members.join(' | '));
  } else if (typeof type === 'string') {
    parts.push(renderByType(type, schema, ctx));
  } else if (
    schema['properties'] !== undefined ||
    schema['additionalProperties'] !== undefined ||
    schema['required'] !== undefined
  ) {
    parts.push(renderObject(schema, ctx));
  } else if (schema['items'] !== undefined || schema['prefixItems'] !== undefined) {
    parts.push(renderArray(schema, ctx));
  }

  if (parts.length === 0) return 'unknown';
  if (parts.length === 1) {
    const only = parts[0];
    return only ?? 'unknown';
  }
  return parts.map(parenthesize).join(' & ');
}

/**
 * Convert a JSON Schema into TypeScript type text.
 *
 * @param schema - The schema (also used as the $ref resolution root).
 * @param indent - Indentation prefix of the line the type is emitted on;
 *   nested object literals indent relative to it.
 */
export function schemaToTsType(schema: unknown, indent = ''): string {
  return render(schema, { root: schema, depth: 0, refStack: [], indent });
}

/**
 * True when the schema requires at least one argument property — used to
 * decide whether the generated tool function's `args` parameter is optional.
 */
export function schemaRequiresArgs(schema: unknown): boolean {
  return isRecord(schema) && Array.isArray(schema['required']) && schema['required'].length > 0;
}
