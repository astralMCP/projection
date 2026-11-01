/**
 * The in-process server every box of the `summit-saas` world is built on
 * (summit-world.ts), and the helpers its fakes share.
 *
 * Unlike the workplace boxes (workplace-fake.ts, which register every tool
 * on an `McpServer` with a strict input schema), a summit box answers
 * `tools/list` and `tools/call` itself, on the low-level server, so that each
 * fake can reproduce how ITS real server treats arguments:
 *
 * - the Notion and Slack servers are built on the SDK's low-level `Server`
 *   and validate nothing: an unknown argument reaches the upstream API, a
 *   missing one is the API's (or the handler's own) error;
 * - the Stripe and Sentry servers register zod schemas on `McpServer`:
 *   arguments are validated before the handler runs, unknown keys are
 *   stripped, defaults are applied, and a bad argument is a JSON-RPC
 *   `-32602` error that never reaches the handler ({@link validateArgs}).
 *
 * Every tool's definition (name, description, input and output schema,
 * annotations) is served exactly as the real server lists it; the handler
 * is ours. A call is recorded once it reaches the handler — after
 * validation for the validating servers, always for the others — as
 * `{ tool, args }`, before the result is computed.
 *
 * Nothing here reads the clock or does I/O: the world's "now" is
 * {@link SUMMIT_NOW} and every fixture is seeded deterministically.
 */

import { McpServer, ProtocolError } from '@modelcontextprotocol/server';
import type { SideEffect } from '../types.js';
import type { WorldTool } from './world.js';

/** The summit world's fixed "now": Wednesday 2026-10-28, 15:00 UTC. */
export const SUMMIT_NOW = '2026-10-28T15:00:00Z';
export const SUMMIT_NOW_MS = Date.parse(SUMMIT_NOW);
export const SUMMIT_TODAY = '2026-10-28';

export type Args = Record<string, unknown>;

/** A tool result exactly as the box sends it. */
export interface BoxResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** One tool of a summit box: its listed definition plus our handler. */
export interface SummitTool extends WorldTool {
  handler(args: Args): BoxResult;
}

export interface SummitBox {
  server: McpServer;
  readonly calls: SideEffect[];
  readonly tools: readonly WorldTool[];
  readonly instructions: string | undefined;
}

/** A JSON-RPC error a handler (or the validation step) raises; the client sees `MCP error <code>: <message>`. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface BoxOptions {
  /**
   * Validate arguments against the listed input schema before the handler
   * runs, as an `McpServer` with zod schemas does (Stripe, Sentry). Absent:
   * no validation (Notion, Slack).
   */
  validate?: boolean;
  /**
   * The result for a call with no `arguments` object at all (the Slack
   * server refuses those before dispatching); absent: treated as `{}`.
   */
  missingArguments?: () => BoxResult;
  /** Message for an unknown tool name (thrown as a JSON-RPC error). */
  unknownTool?: (name: string) => string;
}

/** Build one box: `tools/list` serves the definitions verbatim, `tools/call` records and dispatches. */
export function createSummitBox(
  info: { name: string; version: string; instructions?: string },
  tools: readonly SummitTool[],
  onCall: ((call: SideEffect) => void) | undefined,
  options: BoxOptions = {},
): SummitBox {
  const calls: SideEffect[] = [];
  const server = new McpServer(
    { name: info.name, version: info.version },
    {
      capabilities: { tools: {} },
      ...(info.instructions !== undefined ? { instructions: info.instructions } : {}),
    },
  );
  const surface: WorldTool[] = tools.map(({ handler: _handler, ...rest }) => rest);
  const byName = new Map(tools.map((t) => [t.name, t]));
  server.server.setRequestHandler('tools/list', () => ({
    tools: surface.map((t) => ({ ...t })) as never,
  }));
  server.server.setRequestHandler('tools/call', (request) => {
    const { name } = request.params;
    const tool = byName.get(name);
    if (tool === undefined) {
      throw new ProtocolError(-32602, options.unknownTool?.(name) ?? `Tool ${name} not found`);
    }
    if (request.params.arguments === undefined && options.missingArguments !== undefined) {
      calls.push({ tool: name, args: {} });
      onCall?.({ tool: name, args: {} });
      return options.missingArguments() as never;
    }
    const raw = (request.params.arguments ?? {}) as Args;
    let args = raw;
    if (options.validate === true) {
      const issues = validateArgs(tool.inputSchema, raw);
      if (issues.length > 0) {
        throw new ProtocolError(
          -32602,
          `Invalid arguments for tool ${name}: ${JSON.stringify(issues, null, 2)}`,
        );
      }
      args = stripUnknown(tool.inputSchema, raw);
    }
    calls.push({ tool: name, args });
    onCall?.({ tool: name, args });
    try {
      return tool.handler(args) as never;
    } catch (err) {
      if (err instanceof RpcError) throw new ProtocolError(err.code, err.message);
      throw err;
    }
  });
  return { server, calls, tools: surface, instructions: info.instructions };
}

// ---------------------------------------------------------------------------
// Results

export function textResult(text: string, isError = false): BoxResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/** Compact JSON text (`JSON.stringify(value)`), as the Notion, Slack and Stripe servers send. */
export function compactJson(value: unknown): BoxResult {
  return textResult(JSON.stringify(value));
}

/** structuredContent plus a two-space JSON text mirror (Sentry's structured tools). */
export function structuredResult(value: Record<string, unknown>): BoxResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

// ---------------------------------------------------------------------------
// Argument validation (the subset of JSON Schema the zod-built schemas use)

export interface ValidationIssue {
  code: string;
  path: (string | number)[];
  message: string;
  expected?: string;
}

type Schema = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(expected: string, value: unknown): boolean {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return expected === actual;
}

/** Zod-style issues for `value` against `schema` (empty when it validates). */
export function validateValue(
  schema: Schema,
  value: unknown,
  path: (string | number)[] = [],
): ValidationIssue[] {
  if (schema['anyOf'] !== undefined) {
    const options = schema['anyOf'] as Schema[];
    const ok = options.some((s) => validateValue(s, value, path).length === 0);
    return ok ? [] : [{ code: 'invalid_union', path, message: 'Invalid input' }];
  }
  const type = schema['type'];
  if (typeof type === 'string' && !typeMatches(type, value)) {
    return [
      {
        code: 'invalid_type',
        expected: type,
        path,
        message: `Invalid input: expected ${type}, received ${typeOf(value) === 'integer' ? 'number' : typeOf(value)}`,
      },
    ];
  }
  if (Array.isArray(type) && !type.some((t) => typeMatches(String(t), value))) {
    return [{ code: 'invalid_type', path, message: `Invalid input: expected ${type.join(' | ')}` }];
  }
  const issues: ValidationIssue[] = [];
  const enumValues = schema['enum'] as unknown[] | undefined;
  if (enumValues !== undefined && !enumValues.includes(value)) {
    issues.push({
      code: 'invalid_value',
      path,
      message: `Invalid option: expected one of ${enumValues.map((v) => JSON.stringify(v)).join('|')}`,
    });
  }
  if (typeof value === 'number') {
    const min = schema['minimum'];
    const max = schema['maximum'];
    const exMin = schema['exclusiveMinimum'];
    if (typeof min === 'number' && value < min)
      issues.push({
        code: 'too_small',
        path,
        message: `Too small: expected number to be >=${min}`,
      });
    if (typeof max === 'number' && value > max)
      issues.push({ code: 'too_big', path, message: `Too big: expected number to be <=${max}` });
    if (typeof exMin === 'number' && value <= exMin)
      issues.push({
        code: 'too_small',
        path,
        message: `Too small: expected number to be >${exMin}`,
      });
  }
  if (typeof value === 'string') {
    const minLength = schema['minLength'];
    const maxLength = schema['maxLength'];
    if (typeof minLength === 'number' && value.length < minLength)
      issues.push({
        code: 'too_small',
        path,
        message: `Too small: expected string to have >=${minLength} characters`,
      });
    if (typeof maxLength === 'number' && value.length > maxLength)
      issues.push({
        code: 'too_big',
        path,
        message: `Too big: expected string to have <=${maxLength} characters`,
      });
    const pattern = schema['pattern'];
    if (typeof pattern === 'string' && !new RegExp(pattern).test(value))
      issues.push({ code: 'invalid_format', path, message: 'Invalid string: must match pattern' });
    if (schema['format'] === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      issues.push({ code: 'invalid_format', path, message: 'Invalid email address' });
    if (schema['format'] === 'uri' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value))
      issues.push({ code: 'invalid_format', path, message: 'Invalid URL' });
  }
  if (typeOf(value) === 'object' && schema['properties'] !== undefined) {
    const props = schema['properties'] as Record<string, Schema>;
    const obj = value as Args;
    for (const key of (schema['required'] as string[] | undefined) ?? []) {
      if (obj[key] === undefined) {
        issues.push({
          code: 'invalid_type',
          expected: String((props[key] ?? {})['type'] ?? 'value'),
          path: [...path, key],
          message: `Invalid input: expected ${String((props[key] ?? {})['type'] ?? 'value')}, received undefined`,
        });
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (obj[key] !== undefined) issues.push(...validateValue(sub, obj[key], [...path, key]));
    }
  }
  if (Array.isArray(value) && schema['items'] !== undefined) {
    value.forEach((item, i) =>
      issues.push(...validateValue(schema['items'] as Schema, item, [...path, i])),
    );
  }
  return issues;
}

/** Issues for a tool's whole arguments object. */
export function validateArgs(schema: Schema, args: Args): ValidationIssue[] {
  return validateValue(schema, args);
}

/** The arguments without the top-level keys the schema does not declare (zod's default strip). */
export function stripUnknown(schema: Schema, args: Args): Args {
  const props = schema['properties'] as Record<string, unknown> | undefined;
  if (props === undefined) return args;
  return Object.fromEntries(Object.entries(args).filter(([key]) => key in props));
}

// ---------------------------------------------------------------------------
// Argument readers

export function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

export function num(args: Args, key: string): number | undefined {
  const v = args[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

// ---------------------------------------------------------------------------
// Deterministic data helpers

/** A seeded PRNG (mulberry32): the same seed, the same world. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deterministic id of `length` characters from `alphabet`. */
export function idFrom(rand: () => number, length: number, alphabet: string): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}

export const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const HEX = '0123456789abcdef';

/** Epoch seconds of an ISO instant (fixture data only). */
export function epoch(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/** The ISO instant `hours` before {@link SUMMIT_NOW}. */
export function hoursAgo(hours: number): string {
  return new Date(SUMMIT_NOW_MS - hours * 3_600_000).toISOString().replace('.000Z', 'Z');
}

/** A Notion/Sentry-style UUID from a seed string (stable, not random). */
export function uuidFrom(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let out = '';
  for (let round = 0; out.length < 32; round++) {
    for (const ch of `${seed}:${round}`) {
      h1 = Math.imul(h1 ^ ch.charCodeAt(0), 16777619) >>> 0;
      h2 = Math.imul(h2 ^ ch.charCodeAt(0), 2246822519) >>> 0;
    }
    out += ((h1 ^ h2) >>> 0).toString(16).padStart(8, '0');
  }
  const hex = out.slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
