/**
 * A recording proxy in front of a real MCP server: re-registers the
 * server's tools verbatim (title, description, input schema, annotations)
 * on an in-process `McpServer`, records every call, and forwards it to the
 * real server over the given client. The model — directly or through
 * Projection — faces exactly the real server's surface, the effects land
 * for real, and `calls` is what the tasks score.
 *
 * Results pass through whole: content blocks, `structuredContent` and
 * `isError`. Output schemas are not re-registered — the SDK validates
 * `structuredContent` only against a declared output schema, so without one
 * the real server's structured result is forwarded untouched (validating it
 * is the real server's job, not this proxy's). Projection then sees exactly
 * what it would in production: its `call_tool` renders the structured value
 * rather than an escaped copy of the content array.
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
  /** The real server's tools, as listed. */
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
        ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
      },
      // The mirrored schema validates the arguments before this handler
      // runs, so a call with wrong-typed arguments (`head: "5"`) is
      // rejected by the proxy and never recorded — exactly as the real
      // server would reject it, and as the GitHub fake behaves.
      async (args) => {
        const recorded = args ?? {};
        calls.push({ tool: tool.name, args: recorded });
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
