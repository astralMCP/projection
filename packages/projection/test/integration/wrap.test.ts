/**
 * End-to-end integration: a REAL McpServer with Zod-typed tools, wrapped
 * into a code-mode facade and driven through a full approval round trip.
 *
 * Everything downstream of `wrapMcpServer` is exercised for real —
 * introspection over an in-memory transport, JSON-Schema typegen from the
 * Zod schemas, the QuickJS sandbox, the machine host, blob sealing, and the
 * MRTR adapter.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { wrapMcpServer, type ProjectionFacade } from '../../src/index.js';
import type { CallToolResult, ToolCallResult } from '../../src/mrtr/index.js';
import {
  ACCEPT,
  completed,
  decline,
  elicitation,
  isSuspended,
  sealedState,
  structured,
} from '../mrtr/helpers.js';

const KEY = new Uint8Array(32).fill(5);

/** Files the wrapped server manages, so writes are observable. */
let files: Record<string, string>;
let deleted: string[];

function buildWrappedServer(): McpServer {
  const server = new McpServer(
    { name: 'demo-files', version: '2.1.0' },
    { instructions: 'A tiny file server. Paths are absolute.' },
  );

  server.registerTool(
    'read_file',
    {
      description: 'Read a file from disk.',
      inputSchema: z.object({ path: z.string().describe('Absolute path to read.') }),
      annotations: { readOnlyHint: true },
    },
    ({ path }) => ({
      content: [{ type: 'text' as const, text: files[path] ?? '' }],
    }),
  );

  server.registerTool(
    'list_files',
    {
      description: 'List known file paths.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () => ({ content: [{ type: 'text' as const, text: Object.keys(files).sort().join(',') }] }),
  );

  server.registerTool(
    'write_file',
    {
      description: 'Write content to a file.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
    },
    ({ path, content }) => {
      files[path] = content;
      return { content: [{ type: 'text' as const, text: `wrote ${content.length} bytes` }] };
    },
  );

  server.registerTool(
    'delete_file',
    {
      description: 'Delete a file permanently.',
      inputSchema: z.object({ path: z.string() }),
      annotations: { destructiveHint: true },
    },
    ({ path }) => {
      deleted.push(path);
      delete files[path];
      return { content: [{ type: 'text' as const, text: `deleted ${path}` }] };
    },
  );

  return server;
}

function output(result: ToolCallResult): unknown {
  const complete = completed(result);
  if (complete.isError === true) {
    throw new Error(`unexpected error result: ${JSON.stringify(complete.structuredContent)}`);
  }
  return structured(result)['output'];
}

describe('wrapMcpServer against a real MCP server', () => {
  let facade: ProjectionFacade;

  beforeEach(async () => {
    files = { '/notes.txt': 'original notes', '/readme.md': '# demo' };
    deleted = [];
    facade = await wrapMcpServer(buildWrappedServer(), { blob: { key: KEY } });
  });

  it('introspects the wrapped server into a catalog with annotations', () => {
    expect(facade.catalog.identity).toBe('demo-files@2.1.0');
    expect(facade.catalog.tools.map((t) => t.name).toSorted()).toEqual([
      'delete_file',
      'list_files',
      'read_file',
      'write_file',
    ]);
    const read = facade.catalog.tools.find((t) => t.name === 'read_file');
    expect(read?.annotations?.readOnlyHint).toBe(true);
    const del = facade.catalog.tools.find((t) => t.name === 'delete_file');
    expect(del?.annotations?.destructiveHint).toBe(true);
  });

  it('generates types from the Zod schemas and forwards instructions (R4, R29)', () => {
    expect(facade.dts).toContain('export declare const tools');
    expect(facade.dts).toContain('read_file');
    expect(facade.dts).toContain('path: string');
    expect(facade.instructions).toContain('A tiny file server.');
    expect(facade.instructions).toContain('execute_machine');
  });

  it('runs a read-only machine end to end without approval', async () => {
    const code = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'read',
  context: { listing: null, notes: null },
  initial: 'listing',
  states: {
    listing: {
      entry: toolCall('list_files', () => ({})),
      on: { TOOL_RESULT: { target: 'reading', actions: assign({ listing: ({ event }) => event.result }) } },
    },
    reading: {
      entry: toolCall('read_file', () => ({ path: '/notes.txt' })),
      on: { TOOL_RESULT: { target: 'done', actions: assign({ notes: ({ event }) => event.result }) } },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => context,
});
`;
    const result = await facade.executeMachine({ code }, 'modern');
    expect(output(result)).toEqual({
      listing: '/notes.txt,/readme.md',
      notes: 'original notes',
    });
  });

  it('gates a write, then really writes it once approved', async () => {
    const code = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'write',
  context: { status: 'pending' },
  initial: 'writing',
  states: {
    writing: {
      entry: toolCall('write_file', () => ({ path: '/notes.txt', content: 'updated by machine' }), { id: 'w1' }),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: ({ event }) => event.result }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'skipped' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status }),
});
`;
    const first = await facade.executeMachine({ code }, 'modern');
    expect(isSuspended(first)).toBe(true);
    if (!isSuspended(first)) return;
    // Nothing was written while waiting for the human.
    expect(files['/notes.txt']).toBe('original notes');
    expect(elicitation(first, 'w1').message).toContain('Write content to a file.');

    const retry = await facade.executeMachine(
      {
        code,
        requestState: sealedState(first),
        inputResponses: { w1: ACCEPT },
      },
      'modern',
    );

    expect(output(retry)).toEqual({ status: 'wrote 18 bytes' });
    expect(files['/notes.txt']).toBe('updated by machine');
  });

  it('never touches the wrapped server when the user declines', async () => {
    const code = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'del',
  context: { status: 'pending' },
  initial: 'deleting',
  states: {
    deleting: {
      entry: toolCall('delete_file', () => ({ path: '/readme.md' }), { id: 'd1' }),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: 'deleted' }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'kept' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status }),
});
`;
    const first = await facade.executeMachine({ code }, 'modern');
    if (!isSuspended(first)) throw new Error('expected suspension');
    expect(elicitation(first, 'd1').message.split('\n')[0]).toContain('⚠');

    const retry = await facade.executeMachine(
      {
        code,
        requestState: sealedState(first),
        inputResponses: { d1: decline() },
      },
      'modern',
    );

    expect(output(retry)).toEqual({ status: 'kept' });
    expect(deleted).toEqual([]);
    expect(files['/readme.md']).toBe('# demo');
  });

  it('mixes an auto read with a gated write in one workflow', async () => {
    const code = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'copy',
  context: { source: null, status: 'pending' },
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('read_file', () => ({ path: '/readme.md' })),
      on: { TOOL_RESULT: { target: 'writing', actions: assign({ source: ({ event }) => event.result }) } },
    },
    writing: {
      entry: toolCall('write_file', ({ context }) => ({ path: '/copy.md', content: context.source }), { id: 'w1' }),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: 'copied' }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'skipped' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status, source: context.source }),
});
`;
    const first = await facade.executeMachine({ code }, 'modern');
    if (!isSuspended(first)) throw new Error('expected suspension');
    // The read already ran; the prompt shows the resolved content it read.
    expect(elicitation(first, 'w1').message).toContain('# demo');
    expect(files['/copy.md']).toBeUndefined();

    const retry = await facade.executeMachine(
      {
        code,
        requestState: sealedState(first),
        inputResponses: { w1: ACCEPT },
      },
      'modern',
    );

    expect(output(retry)).toEqual({ status: 'copied', source: '# demo' });
    expect(files['/copy.md']).toBe('# demo');
  });

  it('self-heals: an invalid machine returns a hint, the corrected one succeeds (PRD §8)', async () => {
    const broken = `
import { setup, fromPromise } from 'xstate';
import { tools } from '@astral-mcp/tools';

export default setup({
  actors: { read: fromPromise(async () => tools.read_file({ path: '/notes.txt' })) },
}).createMachine({
  id: 'broken',
  initial: 'reading',
  states: { reading: { invoke: { src: 'read', onDone: 'done' } }, done: { type: 'final' } },
});
`;
    const failure = (await facade.executeMachine({ code: broken }, 'modern')) as CallToolResult;
    expect(failure.isError).toBe(true);
    const error = failure.structuredContent as unknown as { phase: string; hint: string };
    expect(error.phase).toBe('validate');
    expect(error.hint).toContain('toolCall');

    // The model follows the hint.
    const fixed = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'fixed',
  context: { text: null },
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('read_file', () => ({ path: '/notes.txt' })),
      on: { TOOL_RESULT: { target: 'done', actions: assign({ text: ({ event }) => event.result }) } },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ text: context.text }),
});
`;
    const success = await facade.executeMachine({ code: fixed }, 'modern');
    expect(output(success)).toEqual({ text: 'original notes' });
  });

  it('serves discovery resources at stable URIs (R3)', () => {
    const uris = facade.resources.map((r) => r.uri);
    expect(uris).toContain('projection://types/tools.d.ts');
    expect(uris).toContain('projection://examples/denial-fallback.ts');
    const types = facade.resources.find((r) => r.uri === 'projection://types/tools.d.ts');
    expect(types?.text).toContain('write_file');
  });

  it('registers exactly the five projection tools on a facade server (R1)', async () => {
    const codeModeServer = new McpServer({ name: 'projection-demo', version: '0.1.0' });
    facade.registerOn(codeModeServer);

    // Introspecting the facade server shows only Projection's own tools —
    // the wrapped server's tools are not exposed.
    const facadeIntrospector = await wrapMcpServer(codeModeServer, { blob: { key: KEY } });
    expect(facadeIntrospector.catalog.tools.map((t) => t.name).toSorted()).toEqual([
      'call_tool',
      'describe_tool',
      'discover_apis',
      'execute_machine',
      'search_tools',
    ]);
    await facadeIntrospector.close();
  });
});
