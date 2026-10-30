/**
 * The in-process MCP server every box of the workplace world is built on
 * (workplace-world.ts): a list of tool specs — real-looking name,
 * description, input schema, optional output schema, optional annotations —
 * each with a handler over the box's own mutable state, registered on an
 * `McpServer` that records every call before it answers, as the GitHub fake
 * does (github-fake.ts).
 *
 * A handler returns one of three replies, mirroring how real servers
 * answer:
 *
 * - {@link json}: a JSON value as the text block (and as
 *   `structuredContent` when the tool declares an output schema, which the
 *   SDK then validates);
 * - {@link text}: a plain or markdown text block — including the errors some
 *   real servers phrase as ordinary results (`Error: 502 …`, `{"ok":false}`),
 *   which are NOT flagged `isError`;
 * - {@link toolError}: an `isError: true` result.
 *
 * Input schemas are JSON Schema served verbatim (via `fromJsonSchema`), made
 * strict ({@link strict}), so arguments that do not validate — unknown ones
 * included — are rejected before the handler runs and never recorded.
 */

import { fromJsonSchema, McpServer, type JsonSchemaType } from '@modelcontextprotocol/server';
import type { SideEffect } from '../types.js';
import type { WorldTool } from './world.js';

export type FakeReply =
  | { kind: 'json'; value: unknown }
  | { kind: 'text'; text: string }
  | { kind: 'error'; text: string };

export function json(value: unknown): FakeReply {
  return { kind: 'json', value };
}

export function text(value: string): FakeReply {
  return { kind: 'text', text: value };
}

export function toolError(message: string): FakeReply {
  return { kind: 'error', text: message };
}

export type FakeArgs = Record<string, unknown>;

/** One tool of a fake box: its surface, plus the handler that answers it. */
export interface FakeTool extends WorldTool {
  handler(args: FakeArgs): FakeReply;
}

export interface FakeBox {
  server: McpServer;
  readonly calls: SideEffect[];
  readonly tools: readonly WorldTool[];
  readonly instructions: string | undefined;
}

/** Build one box: register `tools` on a fresh server that records every call. */
export function createFakeBox(
  info: { name: string; version: string; instructions?: string },
  tools: readonly FakeTool[],
  onCall?: (call: SideEffect) => void,
): FakeBox {
  const calls: SideEffect[] = [];
  const server = new McpServer(
    { name: info.name, version: info.version },
    ...(info.instructions !== undefined ? [{ instructions: info.instructions }] : []),
  );
  for (const spec of tools) {
    const tool = strict(spec);
    server.registerTool(
      tool.name,
      {
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema as JsonSchemaType),
        ...(tool.outputSchema !== undefined
          ? {
              outputSchema: fromJsonSchema<Record<string, unknown>>(
                tool.outputSchema as JsonSchemaType,
              ),
            }
          : {}),
        ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
      },
      (args) => {
        const recorded = args ?? {};
        calls.push({ tool: tool.name, args: recorded });
        onCall?.({ tool: tool.name, args: recorded });
        const reply = tool.handler(recorded);
        switch (reply.kind) {
          case 'error':
            return { isError: true, content: [{ type: 'text' as const, text: reply.text }] };
          case 'text':
            return { content: [{ type: 'text' as const, text: reply.text }] };
          case 'json':
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(reply.value, null, 2) }],
              ...(tool.outputSchema !== undefined
                ? { structuredContent: reply.value as Record<string, unknown> }
                : {}),
            };
        }
      },
    );
  }
  const surface: WorldTool[] = tools.map((spec) => {
    const { handler: _handler, ...rest } = strict(spec);
    return rest;
  });
  return { server, calls, tools: surface, instructions: info.instructions };
}

/**
 * The tool with `additionalProperties: false` on its top-level input schema
 * (unless it says otherwise), as strict-schema servers declare: a misnamed
 * argument (`cursor` for `after`, `status` for `state`) is refused with a
 * validation error instead of being silently ignored, which would make a
 * wrong call indistinguishable from a working one.
 */
function strict(tool: FakeTool): FakeTool {
  if (tool.inputSchema['additionalProperties'] !== undefined) return tool;
  return { ...tool, inputSchema: { ...tool.inputSchema, additionalProperties: false } };
}

// ---------------------------------------------------------------------------
// Argument helpers shared by the boxes

export function argString(args: FakeArgs, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
}

export function argNumber(args: FakeArgs, key: string): number | undefined {
  const v = args[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/**
 * An opaque cursor for offset `n` within listing `scope`: base64 of
 * `scope:n`, so a cursor from one listing is refused by another.
 */
export function encodeCursor(scope: string, offset: number): string {
  return Buffer.from(`${scope}:${offset}`).toString('base64');
}

/** The offset a cursor encodes for `scope`; undefined when it is not one of its cursors. */
export function decodeCursor(scope: string, cursor: string): number | undefined {
  const raw = Buffer.from(cursor, 'base64').toString('utf8');
  const prefix = `${scope}:`;
  if (!raw.startsWith(prefix)) return undefined;
  const n = Number(raw.slice(prefix.length));
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Epoch seconds for an ISO instant (fixture data only; never the clock). */
export function epochSeconds(iso: string): number {
  return Date.parse(iso) / 1000;
}
