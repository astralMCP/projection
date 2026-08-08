/**
 * A wrapped MCP server whose tool executions are observable, so a scenario
 * can assert exactly which side effects reached the server (S1, S2).
 */

import { McpServer } from '@modelcontextprotocol/server';
import { z, type ZodType } from 'zod';
import type { SideEffect } from './types.js';

export interface RecordingTool {
  name: string;
  description: string;
  /** Zod object schema for the tool's arguments. */
  inputSchema: Record<string, ZodType>;
  /** Annotation posture the policy engine reads (untrusted hint, S5). */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  /** Executed when the tool is actually called; its return is the result text. */
  run?: (args: Record<string, unknown>) => string;
}

export interface RecordingServer {
  server: McpServer;
  /** Every tool call the server actually executed, in order. */
  readonly calls: SideEffect[];
}

/**
 * Build a wrapped server from tool specs, recording every invocation.
 *
 * The recorder captures calls at the server's own handlers, so it sees a
 * side effect only when McCircuit actually executes a tool — never for a
 * gated call that was declined or awaiting approval.
 */
export function createRecordingServer(
  tools: RecordingTool[],
  info: { name?: string; version?: string; instructions?: string } = {},
): RecordingServer {
  const calls: SideEffect[] = [];
  const server = new McpServer(
    { name: info.name ?? 'recording-server', version: info.version ?? '1.0.0' },
    ...(info.instructions !== undefined ? [{ instructions: info.instructions }] : []),
  );

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: z.object(tool.inputSchema),
        ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
      },
      (args: Record<string, unknown>) => {
        calls.push({ tool: tool.name, args });
        const text = tool.run?.(args) ?? `${tool.name}-ok`;
        return { content: [{ type: 'text' as const, text }] };
      },
    );
  }

  return { server, calls };
}

/** A small file-server fixture: read-only reads/lists plus gated write/delete. */
export function createFileServer(initial: Record<string, string> = {}): RecordingServer & {
  files: Record<string, string>;
} {
  const files: Record<string, string> = { ...initial };
  const recording = createRecordingServer(
    [
      {
        name: 'read_file',
        description: 'Read a file from disk.',
        inputSchema: { path: z.string() },
        annotations: { readOnlyHint: true },
        run: (args) => files[args['path'] as string] ?? '',
      },
      {
        name: 'list_files',
        description: 'List known file paths.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
        run: () => Object.keys(files).sort().join(','),
      },
      {
        name: 'write_file',
        description: 'Write content to a file.',
        inputSchema: { path: z.string(), content: z.string() },
        run: (args) => {
          files[args['path'] as string] = args['content'] as string;
          return `wrote ${(args['content'] as string).length} bytes`;
        },
      },
      {
        name: 'delete_file',
        description: 'Delete a file permanently.',
        inputSchema: { path: z.string() },
        annotations: { destructiveHint: true },
        run: (args) => {
          delete files[args['path'] as string];
          return `deleted ${args['path'] as string}`;
        },
      },
    ],
    { name: 'demo-files', version: '2.1.0', instructions: 'A tiny file server.' },
  );

  return { ...recording, files };
}
