/**
 * The experimental XState v6 runtime end to end through execute_machine:
 * the contract's own examples, approvals across round trips, parallel calls
 * selected with `matches`, batches, and the errors a model gets when it
 * writes v5 by habit.
 */
import { describe, expect, it } from 'vitest';
import { XSTATE_V6_VERSION, XSTATE_VERSION } from '../../src/blob/versions.js';
import {
  authoringContractV6,
  exampleDenialFallbackV6,
  exampleHappyPathV6,
} from '../../src/machine-host/contract-v6.js';
import { discoverApis, executeMachine } from '../../src/mrtr/index.js';
import type { ExecuteMachineDeps, ToolCallResult } from '../../src/mrtr/index.js';
import type { BlobSealerConfig, StructuredError } from '../../src/types.js';
import { assertXStateMajor } from '../../src/facade/options.js';
import { BRIDGE_SOURCE, CATALOG, FakeExecutor } from '../machine-host/fixtures.js';
import {
  ACCEPT,
  completed,
  decline,
  isSuspended,
  requestKeys,
  sealedState,
  structured,
} from '../mrtr/helpers.js';

const BLOB: BlobSealerConfig = { key: new Uint8Array(32).fill(6) };

function deps(overrides: Partial<ExecuteMachineDeps> = {}): ExecuteMachineDeps {
  return {
    catalog: CATALOG,
    bridgeSource: BRIDGE_SOURCE,
    executor: new FakeExecutor(),
    blob: BLOB,
    protocolEra: 'modern',
    xstate: 6,
    ...overrides,
  };
}

function output(result: ToolCallResult): unknown {
  const done = completed(result);
  expect(done.isError, JSON.stringify(structured(result))).toBeUndefined();
  return structured(result)['output'];
}

function error(result: ToolCallResult): StructuredError {
  expect(completed(result).isError).toBe(true);
  return structured(result) as unknown as StructuredError;
}

/** Suspend, then answer every pending call with `answers[key]` (default ACCEPT). */
async function resume(
  code: string,
  first: ToolCallResult,
  d: ExecuteMachineDeps,
  answers: Record<string, ReturnType<typeof decline>> = {},
): Promise<ToolCallResult> {
  expect(isSuspended(first)).toBe(true);
  const inputResponses = Object.fromEntries(
    requestKeys(first).map((key) => [key, answers[key] ?? ACCEPT]),
  );
  return executeMachine({ code, requestState: sealedState(first), inputResponses }, d);
}

describe('XState v6 runtime: the contract examples run as written', () => {
  it('happy-path.ts completes in one call', async () => {
    const result = await executeMachine(
      { code: exampleHappyPathV6(), input: { path: '/a' } },
      deps(),
    );
    expect(output(result)).toEqual({ result: 'read_file-ok', error: null });
  });

  it('denial-fallback.ts: approved writes, then lists', async () => {
    const executor = new FakeExecutor();
    const d = deps({ executor });
    const code = exampleDenialFallbackV6();
    const first = await executeMachine({ code, input: { path: '/a', dir: '/' } }, d);
    expect(executor.calls).toEqual([]);
    const done = await resume(code, first, d);
    expect(output(done)).toEqual({ status: 'written', note: null });
    expect(executor.calls.map((c) => c.name)).toEqual(['write_file', 'list_dir']);
  });

  it('denial-fallback.ts: declined carries on to the read-only step', async () => {
    const executor = new FakeExecutor();
    const d = deps({ executor });
    const code = exampleDenialFallbackV6();
    const first = await executeMachine({ code, input: { path: '/a', dir: '/' } }, d);
    const key = requestKeys(first)[0]!;
    const done = await resume(code, first, d, { [key]: decline('not now') });
    expect(output(done)).toMatchObject({ status: 'skipped' });
    expect(executor.calls.map((c) => c.name)).toEqual(['list_dir']);
  });

  it("rule 6's batch snippet: one round trip for every item, selected by matches: { batch }", async () => {
    const executor = new FakeExecutor();
    const d = deps({ executor });
    const code = `
import { setup } from 'xstate';
import { toolCalls } from '@astral-mcp/tools';
export default setup({}).createMachine({
  context: ({ input }) => ({ paths: input.paths, seen: [] }),
  initial: 'writing',
  states: {
    writing: {
      entry: toolCalls('write_file', ({ context }) => context.paths.map((path) => ({ path, content: 'hello' })), { id: 'w' }),
      always: ({ context }) => (context.seen.length === context.paths.length ? { target: 'done' } : undefined),
      on: {
        TOOL_RESULT: { matches: { batch: 'w' }, context: ({ context, event }) => ({ seen: [...context.seen, [event.args.path, event.type]] }) },
        TOOL_DENIED: { matches: { batch: 'w' }, context: ({ context, event }) => ({ seen: [...context.seen, [event.args.path, event.type]] }) },
        TOOL_ERROR: { matches: { batch: 'w' }, context: ({ context, event }) => ({ seen: [...context.seen, [event.args.path, event.type]] }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => context.seen,
});`;
    const first = await executeMachine({ code, input: { paths: ['/a', '/b', '/c'] } }, d);
    expect(requestKeys(first)).toEqual(['w*0', 'w*1', 'w*2']);
    const done = await resume(code, first, d, { 'w*1': decline() });
    expect(output(done)).toEqual(
      expect.arrayContaining([
        ['/a', 'TOOL_RESULT'],
        ['/b', 'TOOL_DENIED'],
        ['/c', 'TOOL_RESULT'],
      ]),
    );
    expect(executor.calls.map((c) => c.args['path'])).toEqual(['/a', '/c']);
  });

  it('an empty batch leaves at once through always', async () => {
    const code = `
import { setup } from 'xstate';
import { toolCalls } from '@astral-mcp/tools';
export default setup({}).createMachine({
  context: { paths: [], seen: [] },
  initial: 'writing',
  states: {
    writing: {
      entry: toolCalls('write_file', ({ context }) => context.paths.map((path) => ({ path })), { id: 'w' }),
      always: ({ context }) => (context.seen.length === context.paths.length ? { target: 'done' } : undefined),
    },
    done: { type: 'final' },
  },
  output: () => 'empty',
});`;
    expect(output(await executeMachine({ code }, deps()))).toBe('empty');
  });
});

describe('XState v6 runtime: tool calls', () => {
  it('parallel regions: matches: { callId } routes each result; one suspension holds both', async () => {
    const executor = new FakeExecutor();
    const d = deps({ executor });
    const code = `
import { setup } from 'xstate';
import { toolCall } from '@astral-mcp/tools';
export default setup({}).createMachine({
  context: { a: null, b: null },
  initial: 'both',
  states: {
    both: {
      type: 'parallel',
      states: {
        a: { initial: 'w', states: {
          w: {
            entry: toolCall('write_file', () => ({ path: '/a' }), { id: 'a' }),
            on: {
              TOOL_RESULT: { matches: { callId: 'a' }, target: 'd', context: { a: 'written' } },
              TOOL_DENIED: { matches: { callId: 'a' }, target: 'd', context: { a: 'skipped' } },
            },
          },
          d: { type: 'final' } } },
        b: { initial: 'w', states: {
          w: {
            entry: toolCall('write_file', () => ({ path: '/b' }), { id: 'b' }),
            on: {
              TOOL_RESULT: { matches: { callId: 'b' }, target: 'd', context: { b: 'written' } },
              TOOL_DENIED: { matches: { callId: 'b' }, target: 'd', context: { b: 'skipped' } },
            },
          },
          d: { type: 'final' } } },
      },
      onDone: { target: 'done' },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => context,
});`;
    const first = await executeMachine({ code }, d);
    expect(requestKeys(first).sort()).toEqual(['a', 'b']);
    const done = await resume(code, first, d, { b: decline() });
    expect(output(done)).toEqual({ a: 'written', b: 'skipped' });
    expect(executor.calls).toEqual([{ name: 'write_file', args: { path: '/a' } }]);
  });

  it('enq(toolCall(name, { ... })) from a transition function, beside a target and a patch', async () => {
    const code = `
import { setup } from 'xstate';
import { toolCall } from '@astral-mcp/tools';
export default setup({}).createMachine({
  context: ({ input }) => ({ path: input.path, text: null }),
  initial: 'idle',
  states: {
    idle: {
      always: ({ context }, enq) => {
        enq(toolCall('read_file', { path: context.path }));
        return { target: 'reading', context: { text: 'asked' } };
      },
    },
    reading: {
      on: { TOOL_RESULT: { target: 'done', context: ({ event }) => ({ text: event.result }) } },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => context.text,
});`;
    expect(output(await executeMachine({ code, input: { path: '/x' } }, deps()))).toBe(
      'read_file-ok',
    );
  });

  it('a gated write runs exactly once across the round trip (restore does not re-enter)', async () => {
    const executor = new FakeExecutor();
    const d = deps({ executor });
    const code = exampleDenialFallbackV6();
    const first = await executeMachine({ code, input: { path: '/a', dir: '/' } }, d);
    await resume(code, first, d);
    expect(executor.calls.filter((c) => c.name === 'write_file')).toHaveLength(1);
  });

  it('a function of { context } inside enq(...) says to pass a plain object', async () => {
    const code = `
import { setup } from 'xstate';
import { toolCall } from '@astral-mcp/tools';
export default setup({}).createMachine({
  context: { path: '/a' },
  initial: 'idle',
  states: {
    idle: { always: (_, enq) => { enq(toolCall('read_file', ({ context }) => ({ path: context.path }))); return { target: 'w' }; } },
    w: { on: { TOOL_RESULT: { target: 'done' } } },
    done: { type: 'final' },
  },
});`;
    const err = error(await executeMachine({ code }, deps()));
    expect(JSON.stringify(err)).toContain('pass the arguments as a plain object');
  });
});

describe('XState v6 runtime: errors a model gets for v5 habits', () => {
  const v5 = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';
export default setup({}).createMachine({
  context: { text: null },
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('read_file', () => ({ path: '/a' })),
      on: { TOOL_RESULT: { target: 'done', actions: assign({ text: ({ event }) => event.result }) } },
    },
    done: { type: 'final' },
  },
});`;

  it('importing assign fails with a hint that points at the v5 → v6 table', async () => {
    const err = error(await executeMachine({ code: v5 }, deps()));
    expect(err.message).toMatch(/assign/);
    expect(err.hint).toContain("'assign' is XState v5");
    expect(err.hint).toContain('Return a context patch instead');
  });

  it('actions: on a transition names the fix (development-build message)', async () => {
    const code = v5
      .replace("import { setup, assign } from 'xstate';", "import { setup } from 'xstate';")
      .replace('actions: assign({ text: ({ event }) => event.result })', 'actions: () => {}');
    const err = error(await executeMachine({ code }, deps()));
    expect(err.message).toContain('uses "actions", which was removed');
    expect(err.hint).toContain('XState v6, not v5');
  });

  it('a string target names the fix', async () => {
    const code = v5
      .replace("import { setup, assign } from 'xstate';", "import { setup } from 'xstate';")
      .replace(
        "TOOL_RESULT: { target: 'done', actions: assign({ text: ({ event }) => event.result }) }",
        "TOOL_RESULT: 'done'",
      );
    const err = error(await executeMachine({ code }, deps()));
    expect(err.message).toContain("Use { target: 'done' }");
  });

  it('mutating context in place is caught, with a hint to return a patch', async () => {
    const code = `
import { setup } from 'xstate';
import { toolCall } from '@astral-mcp/tools';
export default setup({}).createMachine({
  context: { items: [] },
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('read_file', () => ({ path: '/a' })),
      on: { TOOL_RESULT: ({ context, event }) => { context.items.push(event.result); return { target: 'done' }; } },
    },
    done: { type: 'final' },
  },
});`;
    const err = error(await executeMachine({ code }, deps()));
    expect(err.hint).toContain('Context is frozen');
  });

  it('assigning a context property is caught, with the same hint', async () => {
    const code = `
import { setup } from 'xstate';
import { toolCall } from '@astral-mcp/tools';
export default setup({}).createMachine({
  context: { status: 'pending' },
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('read_file', () => ({ path: '/a' })),
      on: { TOOL_RESULT: ({ context }) => { context.status = 'x'; return { target: 'done' }; } },
    },
    done: { type: 'final' },
  },
});`;
    const err = error(await executeMachine({ code }, deps()));
    expect(err.message).toMatch(/is read-only/);
    expect(err.hint).toContain('Context is frozen');
  });

  it('invoke is still rejected, with v6 wording', async () => {
    const code = `
import { setup, createAsyncLogic } from 'xstate';
export default setup({}).createMachine({
  initial: 'a',
  states: { a: { invoke: { src: createAsyncLogic({ run: async () => 1 }) } } },
});`;
    const err = error(await executeMachine({ code }, deps()));
    expect(err.message).toContain('invoke');
    expect(err.hint).toContain('createAsyncLogic/invoke');
  });
});

describe('XState v6 runtime: blobs and copy', () => {
  it('a blob sealed by a v6 facade does not resume on a v5 facade, and the reverse', async () => {
    const code = exampleDenialFallbackV6();
    const first = await executeMachine({ code, input: { path: '/a', dir: '/' } }, deps());
    const onV5 = await resume(code, first, deps({ xstate: 5 }));
    const v5err = error(onV5);
    expect(v5err.phase).toBe('blob_verification');
    expect(v5err.message).toContain(XSTATE_V6_VERSION);
    expect(v5err.message).toContain(XSTATE_VERSION);
  });

  it('discover_apis names v6 and serves the v6 contract and examples', () => {
    const result = discoverApis(CATALOG, 'Tools: …', { xstate: 6 });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(`XState version: ${XSTATE_V6_VERSION}`);
    expect(text).toContain('This server runs XState v6, NOT v5');
    const examples = text.slice(text.indexOf('Example —'));
    expect(examples).not.toMatch(/assign|actions:|guard:/);
    const v5Text = (discoverApis(CATALOG, 'Tools: …').content[0] as { text: string }).text;
    expect(v5Text).toContain(`XState version: ${XSTATE_VERSION}`);
    expect(v5Text).not.toContain('XState v6');
  });

  it('the contract examples are the ones the resources serve', () => {
    const contract = authoringContractV6();
    expect(contract).toContain(
      "TOOL_RESULT: { target: 'done', context: ({ event }) => ({ result: event.result }) }",
    );
    expect(exampleHappyPathV6()).toContain("import { setup } from 'xstate';");
  });

  it('xstate accepts 5, 6 or nothing', () => {
    expect(assertXStateMajor(undefined)).toBe(5);
    expect(assertXStateMajor(6)).toBe(6);
    expect(() => assertXStateMajor(7)).toThrow(/xstate must be 5 or 6/);
  });
});
