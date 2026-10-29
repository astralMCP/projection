/**
 * Recording wrapped servers for the multi-server facade tests: each tool
 * records `<server>:<tool>` and its arguments into a shared log, so a test
 * can assert which box a qualified call actually reached.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { isInputRequiredResult, type ToolCallResult } from '../../src/mrtr/index.js';

export const KEY = new Uint8Array(32).fill(41);

export interface ToolSpec {
  name: string;
  description?: string;
  title?: string;
  readOnly?: boolean;
  destructive?: boolean;
}

export interface RecordedCall {
  server: string;
  tool: string;
  args: Record<string, unknown>;
}

/** An in-process server whose every tool records its call and echoes `<server>:<tool>`. */
export function recordingServer(
  info: { name: string; version: string; instructions?: string },
  tools: ToolSpec[],
  log: RecordedCall[],
): McpServer {
  const server = new McpServer(
    { name: info.name, version: info.version },
    info.instructions !== undefined ? { instructions: info.instructions } : {},
  );
  for (const tool of tools) {
    const annotations = {
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      ...(tool.readOnly !== undefined ? { readOnlyHint: tool.readOnly } : {}),
      ...(tool.destructive !== undefined ? { destructiveHint: tool.destructive } : {}),
    };
    server.registerTool(
      tool.name,
      {
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        inputSchema: z.object({ path: z.string().optional(), content: z.string().optional() }),
        ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
      },
      (args) => {
        log.push({ server: info.name, tool: tool.name, args: { ...args } });
        return { content: [{ type: 'text' as const, text: `${info.name}:${tool.name}` }] };
      },
    );
  }
  return server;
}

/** The standard `fs` box: files@1.0.0. */
export function fsServer(log: RecordedCall[], extra: ToolSpec[] = []): McpServer {
  return recordingServer(
    { name: 'files', version: '1.0.0', instructions: 'FS-SERVER-INSTRUCTIONS: read me first.' },
    [
      { name: 'read_file', description: 'Read a file from disk.', readOnly: true },
      { name: 'write_file', description: 'Write content to a file.' },
      { name: 'delete_file', description: 'Delete a file.', destructive: true },
      ...extra,
    ],
    log,
  );
}

/** The standard `github` box: gh-server@0.9.1. */
export function githubServer(log: RecordedCall[], extra: ToolSpec[] = []): McpServer {
  return recordingServer(
    { name: 'gh-server', version: '0.9.1', instructions: 'GH-SERVER-INSTRUCTIONS.' },
    [
      {
        name: 'issue_write',
        title: 'Create or update issue',
        description: 'Create a new issue or update an existing one.',
      },
      { name: 'get_issue', description: 'Get one issue.', readOnly: true },
      { name: 'write_file', description: 'Write a file to a repository.' },
      { name: 'delete_repo', description: 'Delete a repository.', destructive: true },
      ...extra,
    ],
    log,
  );
}

/** The text of a completed result's first content block. */
export function text(result: ToolCallResult): string {
  if (isInputRequiredResult(result)) throw new Error('expected a completed result');
  const block = result.content[0];
  return block !== undefined && block.type === 'text' ? block.text : '';
}
