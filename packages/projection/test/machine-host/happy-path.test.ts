import { describe, expect, it } from 'vitest';
import { runSegment } from '../../src/machine-host/index.js';
import { baseOptions, FakeExecutor } from './fixtures.js';

const READ_MACHINE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'readNotes',
  context: ({ input }) => ({ path: (input && input.path) || '/notes.txt', text: null }),
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('read_file', ({ context }) => ({ path: context.path })),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ text: ({ event }) => event.result }) },
        TOOL_ERROR: 'failed',
      },
    },
    done: { type: 'final' },
    failed: { type: 'final' },
  },
  output: ({ context }) => ({ text: context.text }),
});
`;

describe('happy path — read-only calls run inline (PRD §8)', () => {
  it('completes without suspending and returns the machine output', async () => {
    const executor = new FakeExecutor({ read_file: { ok: true, result: 'file contents' } });
    const outcome = await runSegment({
      ...baseOptions,
      code: READ_MACHINE,
      input: { path: '/etc/hosts' },
      executor,
    });

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.output).toEqual({ text: 'file contents' });
    expect(executor.calls).toEqual([{ name: 'read_file', args: { path: '/etc/hosts' } }]);
    expect(outcome.audit).toEqual([
      {
        callId: expect.any(String),
        tool: 'read_file',
        args: { path: '/etc/hosts' },
        decision: 'auto',
      },
    ]);
  });

  it('delivers TOOL_ERROR when the wrapped server fails the call', async () => {
    const executor = new FakeExecutor({
      read_file: { ok: false, error: { message: 'ENOENT' } },
    });
    const outcome = await runSegment({ ...baseOptions, code: READ_MACHINE, executor });

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.output).toEqual({ text: null });
    expect(outcome.audit[0]?.decision).toBe('error');
    expect(outcome.audit[0]?.reason).toBe('ENOENT');
  });

  it('runs a chain of read-only calls in one segment', async () => {
    const code = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'chain',
  context: { seen: [] },
  initial: 'listing',
  states: {
    listing: {
      entry: toolCall('list_dir', () => ({ path: '/' })),
      on: { TOOL_RESULT: { target: 'reading', actions: assign({ seen: ({ context, event }) => [...context.seen, event.result] }) } },
    },
    reading: {
      entry: toolCall('read_file', () => ({ path: '/a' })),
      on: { TOOL_RESULT: { target: 'done', actions: assign({ seen: ({ context, event }) => [...context.seen, event.result] }) } },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => context.seen,
});
`;
    const executor = new FakeExecutor();
    const outcome = await runSegment({ ...baseOptions, code, executor });
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.output).toEqual(['list_dir-ok', 'read_file-ok']);
    expect(executor.calls.map((c) => c.name)).toEqual(['list_dir', 'read_file']);
  });

  it('captures console output in the result (R31)', async () => {
    const code = `
import { setup } from 'xstate';
console.log('authored machine says hello');
export default setup({}).createMachine({ id: 'x', initial: 'done', states: { done: { type: 'final' } } });
`;
    const outcome = await runSegment({ ...baseOptions, code, executor: new FakeExecutor() });
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.logs.map((l) => l.message)).toContain('authored machine says hello');
  });

  it('accepts TypeScript source', async () => {
    const code = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

interface Ctx { text: string | null }

export default setup({ types: {} as { context: Ctx } }).createMachine({
  id: 'ts',
  context: { text: null } as Ctx,
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('read_file', () => ({ path: '/x' })),
      on: { TOOL_RESULT: { target: 'done', actions: assign({ text: ({ event }) => event.result as string }) } },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ text: context.text }),
});
`;
    const outcome = await runSegment({
      ...baseOptions,
      code,
      lang: 'ts',
      executor: new FakeExecutor(),
    });
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.output).toEqual({ text: 'read_file-ok' });
  });
});
