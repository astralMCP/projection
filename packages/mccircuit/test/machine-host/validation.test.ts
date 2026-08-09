import { describe, expect, it } from 'vitest';
import { runSegment } from '../../src/machine-host/index.js';
import type { StructuredError } from '../../src/types.js';
import { baseOptions, FakeExecutor } from './fixtures.js';

async function failWith(code: string, caps = {}): Promise<StructuredError> {
  const outcome = await runSegment({
    ...baseOptions,
    code,
    executor: new FakeExecutor(),
    caps,
  });
  if (outcome.status !== 'error') {
    throw new Error(`expected an error outcome, got ${outcome.status}`);
  }
  return outcome.error;
}

describe('validation (R24) rejects contract violations with self-heal hints (R25)', () => {
  it('rejects a module with no default export', async () => {
    const error = await failWith(`
import { setup } from 'xstate';
export const machine = setup({}).createMachine({ id: 'x', initial: 'a', states: { a: {} } });
`);
    expect(error.phase).toBe('validate');
    expect(error.message).toContain('no default export');
    expect(error.hint).toContain('export default');
  });

  it('rejects a default export that is not a machine', async () => {
    const error = await failWith(`export default { not: 'a machine' };`);
    expect(error.phase).toBe('validate');
    expect(error.message).toContain('not an XState v5 machine');
  });

  it('rejects XState v4 Machine() syntax with a v5 hint (PRD §8 self-heal)', async () => {
    // v4's Machine() does not exist in the pinned v5 build, so authoring v4
    // syntax throws at module evaluation; either way the model gets a
    // structured error naming the problem.
    const error = await failWith(`
import { Machine } from 'xstate';
export default Machine({ id: 'legacy', initial: 'a', states: { a: {} } });
`);
    expect(['validate', 'runtime']).toContain(error.phase);
    expect(error.hint.length).toBeGreaterThan(0);
  });

  it('rejects invoke / fromPromise (R7 banned pattern)', async () => {
    const error = await failWith(`
import { setup, fromPromise } from 'xstate';
import { tools } from '@mccircuit/tools';

export default setup({
  actors: { readIt: fromPromise(async () => tools.read_file({ path: '/x' })) },
}).createMachine({
  id: 'banned',
  initial: 'reading',
  states: {
    reading: { invoke: { src: 'readIt', onDone: 'done' } },
    done: { type: 'final' },
  },
});
`);
    expect(error.phase).toBe('validate');
    expect(error.message).toContain('invoke');
    expect(error.hint).toContain('toolCall');
    expect(error.hint).toContain('re-execute approved writes');
  });

  it('rejects non-serializable machine context (R6)', async () => {
    const error = await failWith(`
import { setup } from 'xstate';
export default setup({}).createMachine({
  id: 'bad',
  context: () => ({ lookup: new Map([['a', 1]]) }),
  initial: 'a',
  states: { a: { type: 'final' } },
});
`);
    expect(error.phase).toBe('validate');
    expect(error.message).toContain('not JSON-serializable');
    expect(error.message).toContain('context.lookup');
    expect(error.hint).toContain('plain JSON values');
  });

  it('rejects a Date in context (silently lossy through JSON)', async () => {
    const error = await failWith(`
import { setup } from 'xstate';
export default setup({}).createMachine({
  id: 'bad',
  context: () => ({ when: new Date(0) }),
  initial: 'a',
  states: { a: { type: 'final' } },
});
`);
    expect(error.message).toContain('context.when');
    expect(error.message).toContain('Date');
  });

  it('enforces the state-node cap (R12)', async () => {
    const states = Array.from({ length: 30 }, (_, i) => `s${i}: {}`).join(',\n    ');
    const error = await failWith(
      `
import { setup } from 'xstate';
export default setup({}).createMachine({
  id: 'big',
  initial: 's0',
  states: { ${states} },
});
`,
      { maxStateNodes: 10 },
    );
    expect(error.phase).toBe('cap_exceeded');
    expect(error.message).toContain('state nodes');
    expect(error.hint).toContain('10');
  });

  it('rejects a tool call at module top level (R5)', async () => {
    const error = await failWith(`
import { setup } from 'xstate';
import { tools } from '@mccircuit/tools';

tools.read_file({ path: '/leaked' });

export default setup({}).createMachine({ id: 'x', initial: 'a', states: { a: { type: 'final' } } });
`);
    expect(error.phase).toBe('validate');
    expect(error.message).toContain('top level');
    expect(error.hint).toContain('re-evaluated');
  });

  it('rejects a call to an unknown tool', async () => {
    const error = await failWith(`
import { setup } from 'xstate';
import { toolCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'x',
  initial: 'a',
  states: { a: { entry: toolCall('no_such_tool', () => ({})), on: { TOOL_RESULT: 'b' } }, b: { type: 'final' } },
});
`);
    expect(error.phase).toBe('validate');
    expect(error.message).toContain('Unknown tool "no_such_tool"');
    expect(error.hint).toContain('discover_apis');
  });

  it('reports a machine stuck with no pending call and no final state', async () => {
    const error = await failWith(`
import { setup } from 'xstate';
export default setup({}).createMachine({
  id: 'stuck',
  initial: 'waiting',
  states: { waiting: { on: { NEVER: 'done' } }, done: { type: 'final' } },
});
`);
    expect(error.phase).toBe('runtime');
    expect(error.message).toContain('stuck');
  });

  it('surfaces a syntax error as a structured transpile/validate failure', async () => {
    const error = await failWith(`export default {{{ broken`);
    expect(['transpile', 'validate']).toContain(error.phase);
    expect(error.hint.length).toBeGreaterThan(0);
  });

  it('includes captured logs alongside a validation error (R31)', async () => {
    const error = await failWith(`
import { setup } from 'xstate';
console.warn('about to fail');
export default 42;
`);
    expect(error.logs.map((l) => l.message)).toContain('about to fail');
  });
});

describe('runtime caps enforced by the host (R12)', () => {
  it('enforces the read-only call cap per segment', async () => {
    const error = await failWith(
      `
import { setup, assign } from 'xstate';
import { toolCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'loop',
  context: { n: 0 },
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('read_file', ({ context }) => ({ path: '/f' + context.n })),
      on: {
        TOOL_RESULT: { target: 'reading', reenter: true, actions: assign({ n: ({ context }) => context.n + 1 }) },
      },
    },
  },
});
`,
      { maxReadCallsPerSegment: 5 },
    );
    expect(error.phase).toBe('cap_exceeded');
    expect(error.message).toContain('read-only tool calls');
  });

  it('enforces the final result size cap', async () => {
    const error = await failWith(
      `
import { setup } from 'xstate';
export default setup({}).createMachine({
  id: 'big',
  initial: 'done',
  states: { done: { type: 'final' } },
  output: () => ({ blob: 'x'.repeat(5000) }),
});
`,
      { maxResultBytes: 1000 },
    );
    expect(error.phase).toBe('cap_exceeded');
    expect(error.message).toContain('final result');
  });
});
