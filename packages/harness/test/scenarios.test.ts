import { wrapMcpServer, type McCircuitFacade } from 'mccircuit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  approveAll,
  createFileServer,
  denyKeys,
  ignoreKeys,
  runScenario,
  tamperCiphertext,
  truncateState,
} from '../src/index.js';
import type { Scenario } from '../src/index.js';

const KEY = new Uint8Array(32).fill(11);

/** A machine that gates a single write and branches on the verdict. */
const WRITE_MACHINE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'write',
  context: { status: 'pending' },
  initial: 'writing',
  states: {
    writing: {
      entry: toolCall('write_file', () => ({ path: '/notes.txt', content: 'from-machine' }), { id: 'w1' }),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: 'written' }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'skipped' }) },
        TOOL_ERROR: { target: 'done', actions: assign({ status: 'failed' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status }),
});
`;

describe('scenario harness against a real wrapped server', () => {
  let file: ReturnType<typeof createFileServer>;
  let facade: McCircuitFacade;

  beforeEach(async () => {
    file = createFileServer({ '/notes.txt': 'original' });
    facade = await wrapMcpServer(file.server, { blob: { key: KEY } });
  });

  function scenario(overrides: Partial<Scenario>): Scenario {
    return { name: 'test', code: WRITE_MACHINE, ...overrides };
  }

  it('approve-all: the gated write executes and the workflow completes', async () => {
    const result = await runScenario(facade, file, scenario({ verdicts: approveAll }));

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ status: 'written' });
    expect(result.rounds).toBe(1);
    expect(result.sideEffects).toEqual([
      { tool: 'write_file', args: { path: '/notes.txt', content: 'from-machine' } },
    ]);
    expect(file.files['/notes.txt']).toBe('from-machine');
  });

  it('deny-one: the gated tool never runs and the machine takes its fallback (S2)', async () => {
    const result = await runScenario(facade, file, scenario({ verdicts: denyKeys('w1') }));

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ status: 'skipped' });
    expect(result.sideEffects).toEqual([]);
    expect(file.files['/notes.txt']).toBe('original');
  });

  it('ignore-one: an omitted response is treated as a decline (R17)', async () => {
    const result = await runScenario(facade, file, scenario({ verdicts: ignoreKeys('w1') }));

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ status: 'skipped' });
    expect(result.sideEffects).toEqual([]);
  });

  it('tamper: a modified blob fails verification and executes nothing (S3/S4)', async () => {
    const result = await runScenario(
      facade,
      file,
      scenario({ verdicts: approveAll, tamper: tamperCiphertext }),
    );

    expect(result.status).toBe('error');
    expect(result.error?.phase).toBe('blob_verification');
    expect(result.sideEffects).toEqual([]);
    expect(file.files['/notes.txt']).toBe('original');
  });

  it('truncated blob: fails verification, no side effect', async () => {
    const result = await runScenario(
      facade,
      file,
      scenario({ verdicts: approveAll, tamper: truncateState }),
    );

    expect(result.status).toBe('error');
    expect(result.error?.phase).toBe('blob_verification');
    expect(result.sideEffects).toEqual([]);
  });

  it('records the sealed blob size for the Section 10 budget', async () => {
    const result = await runScenario(facade, file, scenario({ verdicts: approveAll }));
    expect(result.maxBlobBytes).toBeGreaterThan(0);
    // A single-write suspension should be well under the 128 KB ceiling.
    expect(result.maxBlobBytes).toBeLessThan(32 * 1024);
  });
});

describe('multi-round and batched scenarios', () => {
  const KEY2 = new Uint8Array(32).fill(13);

  const TWO_WRITES = `
import { setup, assign } from 'xstate';
import { toolCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'two',
  context: { a: null, b: null },
  initial: 'first',
  states: {
    first: {
      entry: toolCall('write_file', () => ({ path: '/1', content: 'x' }), { id: 'one' }),
      on: {
        TOOL_RESULT: { target: 'second', actions: assign({ a: 'ok' }) },
        TOOL_DENIED: { target: 'second', actions: assign({ a: 'no' }) },
      },
    },
    second: {
      entry: toolCall('write_file', () => ({ path: '/2', content: 'y' }), { id: 'two' }),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ b: 'ok' }) },
        TOOL_DENIED: { target: 'done', actions: assign({ b: 'no' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => context,
});
`;

  it('drives two sequential approvals across two round trips', async () => {
    const file = createFileServer();
    const facade = await wrapMcpServer(file.server, { blob: { key: KEY2 } });

    const result = await runScenario(facade, file, {
      name: 'two-writes',
      code: TWO_WRITES,
      verdicts: approveAll,
    });

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ a: 'ok', b: 'ok' });
    expect(result.rounds).toBe(2);
    expect(result.sideEffects.map((e) => e.args['path'])).toEqual(['/1', '/2']);
  });

  it('denies only the second write, leaving the first applied', async () => {
    const file = createFileServer();
    const facade = await wrapMcpServer(file.server, { blob: { key: KEY2 } });

    const result = await runScenario(facade, file, {
      name: 'deny-second',
      code: TWO_WRITES,
      verdicts: denyKeys('two'),
    });

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ a: 'ok', b: 'no' });
    expect(result.sideEffects.map((e) => e.args['path'])).toEqual(['/1']);
    expect(file.files['/1']).toBe('x');
    expect(file.files['/2']).toBeUndefined();
  });
});
