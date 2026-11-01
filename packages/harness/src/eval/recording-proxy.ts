/**
 * A recording proxy in front of a real MCP server: re-registers the
 * server's tools verbatim (title, description, input schema, output schema,
 * annotations) on an in-process `McpServer`, records every call, and
 * forwards it to the real server over the given client. The model —
 * directly or through Projection — faces exactly the real server's surface,
 * the effects land for real, and `calls` is what the tasks score.
 *
 * Output schemas are mirrored when the real server declares one, so
 * Projection's introspection (`describe_tool`, the generated types, the
 * authoring contract's "has an Output type" rule) sees what it would see
 * wrapping the server directly. Results pass through whole: content blocks,
 * `structuredContent` and `isError`. Mirroring an output schema makes the
 * SDK validate the forwarded `structuredContent` against it (and turn a
 * non-error result without one into a tool error), so the proxy is only as
 * faithful as the real server is to its own schema. Every tool of both
 * proxied worlds declares one (filesystem 14/14, MongoDB 21/21), and their
 * results conform: the worlds' golden-fidelity tests replay every golden
 * through the proxy and fail on any error result, an output validation
 * failure included.
 */

import type { Client } from '@modelcontextprotocol/client';
import { fromJsonSchema, McpServer, type JsonSchemaType } from '@modelcontextprotocol/server';
import type { SideEffect } from '../types.js';
import type { WorldTool } from './world.js';

export interface RecordingProxy {
  /** The proxy, not yet connected: hand it to `wrapMcpServer` or a transport. */
  server: McpServer;
  /** Every call forwarded, in order. */
  readonly calls: SideEffect[];
  /** The real server's tools, as listed (and as mirrored: output schemas included). */
  readonly tools: readonly WorldTool[];
  /** The real server's `instructions`, if it advertises any. */
  readonly instructions: string | undefined;
}

/** The SDK types optional fields as `T | undefined`; drop the undefined ones. */
function pruneUndefined(value: object): NonNullable<WorldTool['annotations']> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

/** Every page of tools/list. */
async function listAllTools(client: Client): Promise<WorldTool[]> {
  const tools: WorldTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor !== undefined ? { cursor } : {});
    for (const tool of page.tools) {
      tools.push({
        name: tool.name,
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        description: tool.description ?? '',
        inputSchema: tool.inputSchema as Record<string, unknown>,
        ...(tool.outputSchema !== undefined
          ? { outputSchema: tool.outputSchema as Record<string, unknown> }
          : {}),
        ...(tool.annotations !== undefined
          ? { annotations: pruneUndefined(tool.annotations) }
          : {}),
      });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return tools;
}

/** Mirror the connected server's tools onto a recording `McpServer`. */
export async function createRecordingProxy(
  client: Client,
  info: { name: string; version: string },
  options: { onCall?: (call: SideEffect) => void } = {},
): Promise<RecordingProxy> {
  const tools = await listAllTools(client);
  const instructions = client.getInstructions();
  const calls: SideEffect[] = [];
  const server = new McpServer(info, ...(instructions !== undefined ? [{ instructions }] : []));

  for (const tool of tools) {
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
      // The mirrored schema validates the arguments before this handler
      // runs, so a call with wrong-typed arguments (`head: "5"`) is
      // rejected by the proxy and never recorded — exactly as the real
      // server would reject it, and as the GitHub fake behaves.
      async (args) => {
        const recorded = args ?? {};
        calls.push({ tool: tool.name, args: recorded });
        options.onCall?.({ tool: tool.name, args: recorded });
        const result = await client.callTool({ name: tool.name, arguments: recorded });
        return {
          content: Array.isArray(result.content) ? result.content : [],
          ...(result.structuredContent !== undefined
            ? { structuredContent: result.structuredContent }
            : {}),
          ...(result.isError === true ? { isError: true } : {}),
        };
      },
    );
  }

  return { server, calls, tools, instructions };
}
