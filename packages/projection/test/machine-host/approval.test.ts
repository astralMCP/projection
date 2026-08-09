import { describe, expect, it } from 'vitest';
import { runSegment } from '../../src/machine-host/index.js';
import type { ApprovalVerdict, PendingToolCall } from '../../src/types.js';
import { baseOptions, FakeExecutor } from './fixtures.js';

const WRITE_MACHINE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'writeNotes',
  context: { status: 'pending', result: null },
  initial: 'writing',
  states: {
    writing: {
      entry: toolCall('write_file', () => ({ path: '/notes.txt', content: 'hello' }), { id: 'w1' }),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: 'written', result: ({ event }) => event.result }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'skipped' }) },
        TOOL_ERROR: { target: 'done', actions: assign({ status: 'failed' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status, result: context.result }),
});
`;

async function suspendOnce(code = WRITE_MACHINE) {
  const executor = new FakeExecutor();
  const outcome = await runSegment({ ...baseOptions, code, executor });
  if (outcome.status !== 'suspended') {
    throw new Error(`expected suspension, got ${outcome.status}`);
  }
  return { outcome, executor };
}

describe('single approval (PRD §8)', () => {
  it('suspends on a gated call without executing it', async () => {
    const { outcome, executor } = await suspendOnce();
    expect(executor.calls).toEqual([]);
    expect(outcome.trip).toBe(1);
    expect(Object.keys(outcome.pending)).toEqual(['w1']);
    expect(outcome.pending['w1']).toEqual({
      id: 'w1',
      name: 'write_file',
      args: { path: '/notes.txt', content: 'hello' },
      stateName: 'writing',
    });
    expect(outcome.snapshot).toBeDefined();
  });

  it('executes the write and completes when approved', async () => {
    const { outcome } = await suspendOnce();
    const executor = new FakeExecutor({ write_file: { ok: true, result: 'written!' } });
    const resumed = await runSegment({
      ...baseOptions,
      code: WRITE_MACHINE,
      executor,
      segment: 1,
      resume: {
        snapshot: outcome.snapshot,
        pending: outcome.pending,
        verdicts: { w1: { kind: 'approved' } },
        audit: outcome.audit,
        trip: outcome.trip,
      },
    });

    expect(resumed.status).toBe('completed');
    if (resumed.status !== 'completed') return;
    expect(resumed.output).toEqual({ status: 'written', result: 'written!' });
    expect(executor.calls).toEqual([
      { name: 'write_file', args: { path: '/notes.txt', content: 'hello' } },
    ]);
    expect(resumed.audit).toEqual([
      {
        callId: 'w1',
        tool: 'write_file',
        args: { path: '/notes.txt', content: 'hello' },
        decision: 'approved',
      },
    ]);
  });

  it('takes the authored fallback branch when declined (denial is not an abort)', async () => {
    const { outcome } = await suspendOnce();
    const executor = new FakeExecutor();
    const resumed = await runSegment({
      ...baseOptions,
      code: WRITE_MACHINE,
      executor,
      segment: 1,
      resume: {
        snapshot: outcome.snapshot,
        pending: outcome.pending,
        verdicts: { w1: { kind: 'declined', reason: 'not now' } },
        trip: outcome.trip,
      },
    });

    expect(resumed.status).toBe('completed');
    if (resumed.status !== 'completed') return;
    expect(resumed.output).toEqual({ status: 'skipped', result: null });
    expect(executor.calls).toEqual([]);
    expect(resumed.audit).toEqual([
      {
        callId: 'w1',
        tool: 'write_file',
        args: { path: '/notes.txt', content: 'hello' },
        decision: 'declined',
        reason: 'not now',
      },
    ]);
  });

  it('treats a verdict missing from inputResponses as declined (R17)', async () => {
    const { outcome } = await suspendOnce();
    const executor = new FakeExecutor();
    const resumed = await runSegment({
      ...baseOptions,
      code: WRITE_MACHINE,
      executor,
      segment: 1,
      resume: {
        snapshot: outcome.snapshot,
        pending: outcome.pending,
        verdicts: {},
        trip: outcome.trip,
      },
    });

    expect(resumed.status).toBe('completed');
    if (resumed.status !== 'completed') return;
    expect(resumed.output).toEqual({ status: 'skipped', result: null });
    expect(executor.calls).toEqual([]);
  });
});

describe('S2 — the approval authorizes the sealed arguments', () => {
  it('executes the sealed args even when the resumed machine asks for different ones', async () => {
    // The machine writes to /notes.txt on the first pass. On resume the
    // module is re-evaluated from re-sent code — here, code that would ask
    // to write somewhere else entirely. The approved call must still be the
    // one the human saw.
    const { outcome } = await suspendOnce();

    const tamperedCode = WRITE_MACHINE.replace(
      "{ path: '/notes.txt', content: 'hello' }",
      "{ path: '/etc/passwd', content: 'pwned' }",
    );
    const executor = new FakeExecutor();
    const resumed = await runSegment({
      ...baseOptions,
      code: tamperedCode,
      executor,
      segment: 1,
      resume: {
        snapshot: outcome.snapshot,
        // The sealed pending map — what the blob carries and what the human
        // approved. The host must use these args, not the machine's.
        pending: outcome.pending,
        verdicts: { w1: { kind: 'approved' } },
        trip: outcome.trip,
      },
    });

    expect(resumed.status).toBe('completed');
    expect(executor.calls).toEqual([
      { name: 'write_file', args: { path: '/notes.txt', content: 'hello' } },
    ]);
    expect(executor.calls[0]?.args['path']).not.toBe('/etc/passwd');
  });
});

describe('batched approvals (R15)', () => {
  const PARALLEL_MACHINE = `
import { setup, assign } from 'xstate';
import { toolCall, whenCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'batch',
  type: 'parallel',
  context: { a: null, b: null, c: null },
  states: {
    one: {
      initial: 'w',
      states: {
        w: {
          entry: toolCall('write_file', () => ({ path: '/a' }), { id: 'a' }),
          on: { TOOL_RESULT: { guard: whenCall('a'), target: 'done', actions: assign({ a: 'ok' }) }, TOOL_DENIED: { guard: whenCall('a'), target: 'done', actions: assign({ a: 'denied' }) } },
        },
        done: { type: 'final' },
      },
    },
    two: {
      initial: 'w',
      states: {
        w: {
          entry: toolCall('write_file', () => ({ path: '/b' }), { id: 'b' }),
          on: { TOOL_RESULT: { guard: whenCall('b'), target: 'done', actions: assign({ b: 'ok' }) }, TOOL_DENIED: { guard: whenCall('b'), target: 'done', actions: assign({ b: 'denied' }) } },
        },
        done: { type: 'final' },
      },
    },
    three: {
      initial: 'w',
      states: {
        w: {
          entry: toolCall('delete_file', () => ({ path: '/c' }), { id: 'c' }),
          on: { TOOL_RESULT: { guard: whenCall('c'), target: 'done', actions: assign({ c: 'ok' }) }, TOOL_DENIED: { guard: whenCall('c'), target: 'done', actions: assign({ c: 'denied' }) } },
        },
        done: { type: 'final' },
      },
    },
  },
  output: ({ context }) => context,
});
`;

  it('batches every gated call from parallel regions into ONE suspension', async () => {
    const executor = new FakeExecutor();
    const outcome = await runSegment({
      ...baseOptions,
      code: PARALLEL_MACHINE,
      executor,
    });

    expect(outcome.status).toBe('suspended');
    if (outcome.status !== 'suspended') return;
    expect(Object.keys(outcome.pending).sort()).toEqual(['a', 'b', 'c']);
    expect(outcome.pending['c']?.name).toBe('delete_file');
    expect(executor.calls).toEqual([]);
    // The state name records every requesting region.
    expect(outcome.pending['a']?.stateName).toContain('one');
  });

  it('maps each verdict to its own call on resume', async () => {
    const first = await runSegment({
      ...baseOptions,
      code: PARALLEL_MACHINE,
      executor: new FakeExecutor(),
    });
    if (first.status !== 'suspended') throw new Error('expected suspension');

    const executor = new FakeExecutor();
    const verdicts: Record<string, ApprovalVerdict> = {
      a: { kind: 'approved' },
      b: { kind: 'declined', reason: 'no' },
      c: { kind: 'approved' },
    };
    const resumed = await runSegment({
      ...baseOptions,
      code: PARALLEL_MACHINE,
      executor,
      segment: 1,
      resume: {
        snapshot: first.snapshot,
        pending: first.pending as Record<string, PendingToolCall>,
        verdicts,
        trip: first.trip,
      },
    });

    expect(resumed.status).toBe('completed');
    if (resumed.status !== 'completed') return;
    expect(resumed.output).toEqual({ a: 'ok', b: 'denied', c: 'ok' });
    expect(executor.calls.map((c) => c.args['path']).sort()).toEqual(['/a', '/c']);
  });
});

describe('policy deny', () => {
  it('delivers TOOL_DENIED without suspending', async () => {
    const executor = new FakeExecutor();
    const outcome = await runSegment({
      ...baseOptions,
      code: WRITE_MACHINE,
      executor,
      policy: { write_file: 'deny' },
    });

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.output).toEqual({ status: 'skipped', result: null });
    expect(executor.calls).toEqual([]);
    expect(outcome.audit[0]?.decision).toBe('denied_by_policy');
  });

  it('runs a gated call inline when the developer overrides it to auto', async () => {
    const executor = new FakeExecutor({ write_file: { ok: true, result: 'forced' } });
    const outcome = await runSegment({
      ...baseOptions,
      code: WRITE_MACHINE,
      executor,
      policy: { write_file: 'auto' },
    });

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.output).toEqual({ status: 'written', result: 'forced' });
    expect(executor.calls).toHaveLength(1);
  });
});
