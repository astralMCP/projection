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

/**
 * Build a fresh, independent wrapped server + facade. Each instance is
 * labelled and its `read_file` returns an instance-specific string, so a
 * value observed after a resume proves it was carried in the snapshot from
 * the instance that ran the read — not recomputed by the resuming instance.
 */
async function makeInstance(
  label: string,
  config: { key: Uint8Array; previousKeys?: Uint8Array[] } = { key: KEY },
) {
  const writes: { path: string; content: string }[] = [];
  const server = new McpServer({ name: 'files', version: '1.0.0' });
  server.registerTool(
    'read_file',
    {
      description: 'Read a file.',
      inputSchema: z.object({ path: z.string() }),
      annotations: { readOnlyHint: true },
    },
    ({ path }) => ({ content: [{ type: 'text' as const, text: `${path} read by ${label}` }] }),
  );
  server.registerTool(
    'write_file',
    {
      description: 'Write a file.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
    },
    ({ path, content }) => {
      writes.push({ path, content });
      return { content: [{ type: 'text' as const, text: `written by ${label}` }] };
    },
  );
  const facade = await wrapMcpServer(server, {
    blob:
      config.previousKeys !== undefined
        ? { key: config.key, previousKeys: config.previousKeys }
        : { key: config.key },
  });
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

/** Two sequential gated writes, so a workflow needs two round trips. */
const TWO_WRITE_MACHINE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'copy2',
  context: { seen: null, first: null, second: null },
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('read_file', () => ({ path: '/src' })),
      on: { TOOL_RESULT: { target: 'first', actions: assign({ seen: ({ event }) => event.result }) } },
    },
    first: {
      entry: toolCall('write_file', ({ context }) => ({ path: '/dst1', content: context.seen }), { id: 'w1' }),
      on: { TOOL_RESULT: { target: 'second', actions: assign({ first: ({ event }) => event.result }) } },
    },
    second: {
      entry: toolCall('write_file', ({ context }) => ({ path: '/dst2', content: context.seen }), { id: 'w2' }),
      on: { TOOL_RESULT: { target: 'done', actions: assign({ second: ({ event }) => event.result }) } },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => context,
});
`;

interface Terminal {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

function outputOf(result: unknown): Record<string, unknown> {
  return ((result as Terminal).structuredContent?.['output'] ?? {}) as Record<string, unknown>;
}

function approvalsOf(result: unknown): { tool: string; decision: string }[] {
  return ((result as Terminal).structuredContent?.['approvals'] ?? []) as {
    tool: string;
    decision: string;
  }[];
}

describe('stateless resume across instances (R27)', () => {
  it('a workflow suspended on instance A resumes and completes on instance B', async () => {
    const a = await makeInstance('A');
    const b = await makeInstance('B');
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
      // `seen` was produced by A's read and carried in the snapshot to B;
      // its instance-specific value proves B did not re-run the read.
      expect(outputOf(completed)).toEqual({ status: 'written', seen: '/src read by A' });
      // The write landed on B (the resuming instance), not A.
      expect(b.writes).toEqual([{ path: '/dst', content: '/src read by A' }]);
      expect(a.writes).toEqual([]);
      // The audit trail spans both instances: the read (auto on A) and the
      // approved write survive the blob round-trip (PRD §8).
      expect(approvalsOf(completed).map((e) => `${e.tool}:${e.decision}`)).toEqual([
        'read_file:auto',
        'write_file:approved',
      ]);
    } finally {
      await a.facade.close();
      await b.facade.close();
    }
  });

  it('carries the workflow across three instances A→B→C (trip counter + audit survive)', async () => {
    const a = await makeInstance('A');
    const b = await makeInstance('B');
    const c = await makeInstance('C');
    try {
      // A: read (auto), suspend at write 1.
      const s1 = await a.facade.executeMachine({ code: TWO_WRITE_MACHINE }, 'modern');
      expect(isInputRequiredResult(s1)).toBe(true);

      // B: approve write 1 (executes on B), suspend at write 2.
      const s2 = await b.facade.executeMachine(
        {
          code: TWO_WRITE_MACHINE,
          requestState: (s1 as InputRequiredResult).requestState as string,
          inputResponses: { w1: { action: 'accept' } },
        },
        'modern',
      );
      expect(isInputRequiredResult(s2)).toBe(true);

      // C: approve write 2 (executes on C), complete.
      const done = await c.facade.executeMachine(
        {
          code: TWO_WRITE_MACHINE,
          requestState: (s2 as InputRequiredResult).requestState as string,
          inputResponses: { w2: { action: 'accept' } },
        },
        'modern',
      );
      expect(isInputRequiredResult(done)).toBe(false);

      // Each write landed on the instance that approved it.
      expect(a.writes).toEqual([]);
      expect(b.writes).toEqual([{ path: '/dst1', content: '/src read by A' }]);
      expect(c.writes).toEqual([{ path: '/dst2', content: '/src read by A' }]);
      // The full audit — read on A, both writes — survived two hops through
      // the blob, which also carries the R18 trip counter across instances.
      expect(approvalsOf(done).map((e) => `${e.tool}:${e.decision}`)).toEqual([
        'read_file:auto',
        'write_file:approved',
        'write_file:approved',
      ]);
    } finally {
      await a.facade.close();
      await b.facade.close();
      await c.facade.close();
    }
  });

  it('a third instance can decline the same suspension, and no write occurs anywhere', async () => {
    const a = await makeInstance('A');
    const c = await makeInstance('C');
    try {
      const suspended = await a.facade.executeMachine({ code: MACHINE }, 'modern');
      const requestState = (suspended as InputRequiredResult).requestState as string;

      const completed = await c.facade.executeMachine(
        { code: MACHINE, requestState, inputResponses: { w1: { action: 'decline' } } },
        'modern',
      );

      expect(outputOf(completed)).toEqual({ status: 'skipped', seen: '/src read by A' });
      expect(a.writes).toEqual([]);
      expect(c.writes).toEqual([]);
    } finally {
      await a.facade.close();
      await c.facade.close();
    }
  });

  it('resumes on an instance whose primary key has rotated (A key accepted via previousKeys, R22)', async () => {
    const oldKey = new Uint8Array(32).fill(23);
    const newKey = new Uint8Array(32).fill(24);
    const a = await makeInstance('A', { key: oldKey });
    // B has rotated to newKey but still accepts oldKey for decryption.
    const b = await makeInstance('B', { key: newKey, previousKeys: [oldKey] });
    try {
      const suspended = await a.facade.executeMachine({ code: MACHINE }, 'modern');
      const requestState = (suspended as InputRequiredResult).requestState as string;

      const completed = await b.facade.executeMachine(
        { code: MACHINE, requestState, inputResponses: { w1: { action: 'accept' } } },
        'modern',
      );

      expect(isInputRequiredResult(completed)).toBe(false);
      expect(outputOf(completed)).toEqual({ status: 'written', seen: '/src read by A' });
      expect(b.writes).toEqual([{ path: '/dst', content: '/src read by A' }]);
    } finally {
      await a.facade.close();
      await b.facade.close();
    }
  });

  it('an instance configured with a different key cannot resume the blob (R22/S3)', async () => {
    const a = await makeInstance('A');
    // Instance D shares the machine and server shape but NOT the key.
    const d = await makeInstance('D', { key: new Uint8Array(32).fill(99) });
    try {
      const suspended = await a.facade.executeMachine({ code: MACHINE }, 'modern');
      const requestState = (suspended as InputRequiredResult).requestState as string;

      const result = await d.facade.executeMachine(
        { code: MACHINE, requestState, inputResponses: { w1: { action: 'accept' } } },
        'modern',
      );

      const terminal = result as Terminal;
      expect(terminal.isError).toBe(true);
      expect(terminal.structuredContent?.['phase']).toBe('blob_verification');
      expect(d.writes).toEqual([]);
      expect(a.writes).toEqual([]);
    } finally {
      await a.facade.close();
      await d.facade.close();
    }
  });
});
