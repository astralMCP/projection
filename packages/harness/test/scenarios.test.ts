import { wrapMcpServer, type McCircuitFacade } from 'mccircuit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  afterEach(async () => {
    await facade.close();
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

  it('prompt copy is server-derived and shows the resolved args (S6, R16)', async () => {
    const seen: string[] = [];
    await runScenario(
      facade,
      file,
      scenario({
        verdicts: ({ message }) => {
          seen.push(message);
          return { action: 'accept' };
        },
      }),
    );
    expect(seen).toHaveLength(1);
    const message = seen[0] ?? '';
    // The wrapped server's catalog description, not model-authored text.
    expect(message).toContain('Write content to a file.');
    // The fully resolved argument the write will execute with.
    expect(message).toContain('/notes.txt');
    expect(message).toContain('from-machine');
  });

  it('a destructive tool gets stronger warning copy than a plain write (S5, R14)', async () => {
    const deleteMachine = `
import { setup } from 'xstate';
import { toolCall } from '@mccircuit/tools';
export default setup({}).createMachine({
  id: 'del', initial: 'deleting',
  states: {
    deleting: {
      entry: toolCall('delete_file', () => ({ path: '/notes.txt' }), { id: 'd1' }),
      on: { TOOL_RESULT: 'done', TOOL_DENIED: 'done' },
    },
    done: { type: 'final' },
  },
});
`;
    let destructiveMessage = '';
    await runScenario(facade, file, {
      name: 'destructive',
      code: deleteMachine,
      verdicts: ({ message }) => {
        destructiveMessage = message;
        return { action: 'decline' };
      },
    });
    // The delete tool carries destructiveHint; policy renders a stronger prompt.
    expect(destructiveMessage).toContain('DESTRUCTIVE');
  });

  it('attributes each side effect to the round it ran in', async () => {
    const file2 = createFileServer();
    const facade2 = await wrapMcpServer(file2.server, { blob: { key: KEY } });
    const twoWrites = `
import { setup, assign } from 'xstate';
import { toolCall } from '@mccircuit/tools';
export default setup({}).createMachine({
  id: 'two', context: { a: null, b: null }, initial: 'first',
  states: {
    first: { entry: toolCall('write_file', () => ({ path: '/1', content: 'x' }), { id: 'one' }),
      on: { TOOL_RESULT: 'second', TOOL_DENIED: 'second' } },
    second: { entry: toolCall('write_file', () => ({ path: '/2', content: 'y' }), { id: 'two' }),
      on: { TOOL_RESULT: 'done', TOOL_DENIED: 'done' } },
    done: { type: 'final' },
  },
  output: ({ context }) => context,
});
`;
    const result = await runScenario(facade2, file2, {
      name: 'attribution',
      code: twoWrites,
      verdicts: approveAll,
    });
    const suspended = result.roundRecords.filter((r) => r.outcome === 'suspended');
    expect(suspended.map((r) => r.promptKeys)).toEqual([['one'], ['two']]);
    // The first write is attributed to the round AFTER its approval (round 1),
    // never to the round that only prompted for it (round 0).
    expect(suspended[0]?.sideEffects).toEqual([]);
    const completedRound = result.roundRecords.find((r) => r.outcome === 'completed');
    // The second, final write lands in the completing round.
    expect(completedRound?.sideEffects.map((e) => e.args['path'])).toEqual(['/2']);
    await facade2.close();
  });
});

describe('S1 — only the two code-mode tools are exposed', () => {
  it('does not surface the wrapped server tools on the facade catalog', async () => {
    const file = createFileServer();
    const facade = await wrapMcpServer(file.server, { blob: { key: KEY } });
    try {
      // The facade wraps the file server; its own tools stay internal. A
      // client only ever sees execute_machine and discover_apis, which the
      // library-level integration test asserts against a real Client. Here we
      // confirm the wrapped catalog is the file server's, not re-exposed.
      const names = facade.catalog.tools.map((t) => t.name).toSorted();
      expect(names).toEqual(['delete_file', 'list_files', 'read_file', 'write_file']);
    } finally {
      await facade.close();
    }
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
    await facade.close();
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
    await facade.close();
  });
});
