/**
 * Statelessness across instances (PRD R27, G4, milestone M5).
 *
 * The library holds zero cross-request state: everything needed to resume a
 * suspended workflow rides in the sealed `requestState`. This test proves it
 * by suspending on one facade and resuming on a SEPARATE facade — a distinct
 * introspector, a distinct wrapped-server instance, a distinct blob sealer —
 * that shares only the encryption key, as horizontally scaled instances
 * behind a round-robin load balancer would.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isInputRequiredResult, wrapMcpServer, type InputRequiredResult } from '../../src/index.js';

const KEY = new Uint8Array(32).fill(23);

/** Build a fresh, independent wrapped server + facade. */
async function makeInstance() {
  const writes: { path: string; content: string }[] = [];
  const server = new McpServer({ name: 'files', version: '1.0.0' });
  server.registerTool(
    'read_file',
    {
      description: 'Read a file.',
      inputSchema: z.object({ path: z.string() }),
      annotations: { readOnlyHint: true },
    },
    ({ path }) => ({ content: [{ type: 'text' as const, text: `contents of ${path}` }] }),
  );
  server.registerTool(
    'write_file',
    {
      description: 'Write a file.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
    },
    ({ path, content }) => {
      writes.push({ path, content });
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    },
  );
  const facade = await wrapMcpServer(server, { blob: { key: KEY } });
  return { facade, writes };
}

const MACHINE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'copy',
  context: { seen: null, status: 'pending' },
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('read_file', () => ({ path: '/src' })),
      on: { TOOL_RESULT: { target: 'writing', actions: assign({ seen: ({ event }) => event.result }) } },
    },
    writing: {
      entry: toolCall('write_file', ({ context }) => ({ path: '/dst', content: context.seen }), { id: 'w1' }),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: 'written' }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'skipped' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status, seen: context.seen }),
});
`;

describe('stateless resume across instances (R27)', () => {
  it('a workflow suspended on instance A resumes and completes on instance B', async () => {
    const a = await makeInstance();
    const b = await makeInstance();
    try {
      // Instance A: run to the write approval. The read already ran on A.
      const suspended = await a.facade.executeMachine({ code: MACHINE }, 'modern');
      expect(isInputRequiredResult(suspended)).toBe(true);
      const requestState = (suspended as InputRequiredResult).requestState;
      expect(requestState).toBeDefined();
      expect(a.writes).toEqual([]); // nothing written yet

      // Instance B: has never seen this workflow. It resumes purely from the
      // echoed blob and executes the approved write against ITS server.
      const completed = await b.facade.executeMachine(
        {
          code: MACHINE,
          requestState: requestState as string,
          inputResponses: { w1: { action: 'accept' } },
        },
        'modern',
      );

      expect(isInputRequiredResult(completed)).toBe(false);
      const structured = (completed as { structuredContent?: Record<string, unknown> })
        .structuredContent;
      expect(structured?.['output']).toEqual({
        status: 'written',
        seen: 'contents of /src',
      });
      // The write landed on B (the resuming instance), not A.
      expect(b.writes).toEqual([{ path: '/dst', content: 'contents of /src' }]);
      expect(a.writes).toEqual([]);
    } finally {
      await a.facade.close();
      await b.facade.close();
    }
  });

  it('a third instance can decline the same suspension, and no write occurs anywhere', async () => {
    const a = await makeInstance();
    const c = await makeInstance();
    try {
      const suspended = await a.facade.executeMachine({ code: MACHINE }, 'modern');
      const requestState = (suspended as InputRequiredResult).requestState as string;

      const completed = await c.facade.executeMachine(
        { code: MACHINE, requestState, inputResponses: { w1: { action: 'decline' } } },
        'modern',
      );

      const structured = (completed as { structuredContent?: Record<string, unknown> })
        .structuredContent;
      expect(structured?.['output']).toEqual({ status: 'skipped', seen: 'contents of /src' });
      expect(a.writes).toEqual([]);
      expect(c.writes).toEqual([]);
    } finally {
      await a.facade.close();
      await c.facade.close();
    }
  });

  it('an instance configured with a different key cannot resume the blob (R22/S3)', async () => {
    const a = await makeInstance();
    // Instance D shares the machine and server shape but NOT the key.
    const server = new McpServer({ name: 'files', version: '1.0.0' });
    server.registerTool(
      'read_file',
      {
        description: 'Read a file.',
        inputSchema: z.object({ path: z.string() }),
        annotations: { readOnlyHint: true },
      },
      ({ path }) => ({ content: [{ type: 'text' as const, text: `contents of ${path}` }] }),
    );
    const writes: unknown[] = [];
    server.registerTool(
      'write_file',
      {
        description: 'Write a file.',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
      },
      (args) => {
        writes.push(args);
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
    );
    const d = await wrapMcpServer(server, { blob: { key: new Uint8Array(32).fill(99) } });
    try {
      const suspended = await a.facade.executeMachine({ code: MACHINE }, 'modern');
      const requestState = (suspended as InputRequiredResult).requestState as string;

      const result = await d.executeMachine(
        { code: MACHINE, requestState, inputResponses: { w1: { action: 'accept' } } },
        'modern',
      );

      const structured = (
        result as { isError?: boolean; structuredContent?: Record<string, unknown> }
      ).structuredContent;
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(structured?.['phase']).toBe('blob_verification');
      expect(writes).toEqual([]);
      expect(a.writes).toEqual([]);
    } finally {
      await a.facade.close();
      await d.close();
    }
  });
});
