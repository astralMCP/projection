/**
 * `toolCalls` / `whenCallIn` (DECISIONS D30): one gated call per item,
 * requested in one step, costs ONE approval round trip (R15), and each call
 * is still approved on its own, bound to its sealed entry (S2).
 */

import { describe, expect, it } from 'vitest';
import { executeMachine } from '../../src/mrtr/index.js';
import type { ExecuteMachineDeps } from '../../src/mrtr/index.js';
import { BATCH_KEY, MAX_BATCH_CALLS } from '../../src/mrtr/batch.js';
import { authoringContract } from '../../src/machine-host/index.js';
import { openBlob } from '../../src/blob/index.js';
import type { AuditEntry, BlobSealerConfig, ServerCatalog } from '../../src/types.js';
import { generateToolTypes } from '../../src/typegen/index.js';
import { BRIDGE_SOURCE, CATALOG, FakeExecutor } from '../machine-host/fixtures.js';
import {
  ACCEPT,
  completed,
  decline,
  elicitation,
  isSuspended,
  requestKeys,
  sealedState,
  structured,
} from './helpers.js';

const BLOB: BlobSealerConfig = { key: new Uint8Array(32).fill(9) };

function deps(overrides: Partial<ExecuteMachineDeps> = {}): ExecuteMachineDeps {
  return {
    catalog: CATALOG,
    bridgeSource: BRIDGE_SOURCE,
    executor: new FakeExecutor(),
    blob: BLOB,
    protocolEra: 'modern',
    ...overrides,
  };
}

/** The contract's rule 5 example as a whole module, recording which items ran by event.args. */
const FAN_OUT = `
import { setup, assign } from 'xstate';
import { toolCalls, whenCallIn } from '@astral-mcp/tools';
export default setup({
  actions: { answered: assign({ answered: ({ context }) => context.answered + 1 }) },
}).createMachine({
  context: ({ input }) => ({ paths: input.paths, answered: 0, written: [], refused: [] }),
  initial: 'writing',
  states: {
    writing: {
      entry: toolCalls('write_file', ({ context }) => context.paths.map((path) => ({ path, content: 'hello' })), { id: 'w' }),
      always: { guard: ({ context }) => context.answered === context.paths.length, target: 'done' },
      on: {
        TOOL_RESULT: { guard: whenCallIn('w'), actions: ['answered', assign({ written: ({ context, event }) => [...context.written, event.args.path] })] },
        TOOL_DENIED: { guard: whenCallIn('w'), actions: ['answered', assign({ refused: ({ context, event }) => [...context.refused, event.args.path] })] },
        TOOL_ERROR: { guard: whenCallIn('w'), actions: 'answered' },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ answered: context.answered, written: context.written, refused: context.refused }),
});
`;

const paths = (n: number): string[] => Array.from({ length: n }, (_, i) => `/f${i}`);

async function resumeWith(
  code: string,
  first: Awaited<ReturnType<typeof executeMachine>>,
  inputResponses: Record<string, unknown>,
  d: ExecuteMachineDeps,
) {
  const executor = new FakeExecutor();
  const result = await executeMachine(
    { code, requestState: sealedState(first), inputResponses },
    { ...d, executor },
  );
  return { result, executor };
}

describe('toolCalls: many gated calls in one round trip', () => {
  it('puts 14 gated writes in ONE suspension, one elicitation each, nothing run yet', async () => {
    const executor = new FakeExecutor();
    const first = await executeMachine(
      { code: FAN_OUT, input: { paths: paths(14) } },
      deps({ executor }),
    );
    expect(isSuspended(first)).toBe(true);
    expect(requestKeys(first).toSorted()).toEqual(
      Array.from({ length: 14 }, (_, i) => `w*${i}`).toSorted(),
    );
    expect(executor.calls).toEqual([]);
    expect(elicitation(first, 'w*13').message).toContain('"path": "/f13"');
    const payload = openBlob(sealedState(first), {
      expectedKind: 'machine',
      code: FAN_OUT,
      serverIdentity: CATALOG.identity,
      config: BLOB,
      domain: 'single',
    });
    expect(payload.trip).toBe(1);
    expect(payload.pending['w*5']).toMatchObject({
      name: 'write_file',
      args: { path: '/f5', content: 'hello' },
    });
  });

  it('maps a mix of approvals and declines back per call, then finishes', async () => {
    const d = deps();
    const first = await executeMachine({ code: FAN_OUT, input: { paths: paths(14) } }, d);
    const responses: Record<string, unknown> = {};
    for (let i = 0; i < 14; i += 1) {
      // Approve the even items; decline the odd ones (w*13 is left unanswered).
      if (i === 13) continue;
      responses[`w*${i}`] = i % 2 === 0 ? ACCEPT : decline('not that one');
    }
    const { result, executor } = await resumeWith(FAN_OUT, first, responses, d);
    const out = structured(result)['output'] as Record<string, unknown>;
    const even = paths(14).filter((_, i) => i % 2 === 0);
    const odd = paths(14).filter((_, i) => i % 2 === 1);
    expect(out['answered']).toBe(14);
    expect(out['written']).toEqual(even);
    expect(out['refused']).toEqual(odd);
    // Exactly the approved calls ran, each once, with the sealed arguments (S2).
    expect(executor.calls).toEqual(
      even.map((path) => ({ name: 'write_file', args: { path, content: 'hello' } })),
    );
    const audit = structured(result)['approvals'] as AuditEntry[];
    expect(audit.filter((e) => e.decision === 'approved').map((e) => e.callId)).toEqual(
      even.map((_, k) => `w*${2 * k}`),
    );
    expect(audit.find((e) => e.callId === 'w*1')).toMatchObject({
      decision: 'declined',
      reason: 'not that one',
    });
    expect(audit.find((e) => e.callId === 'w*13')).toMatchObject({ decision: 'declined' });
  });

  it('with batched prompts, puts up to 10 calls in one prompt, approve_k in id order', async () => {
    const d = deps({ approvalPrompts: 'batched' });
    const first = await executeMachine({ code: FAN_OUT, input: { paths: paths(10) } }, d);
    expect(requestKeys(first)).toEqual([BATCH_KEY]);
    const { message } = elicitation(first, BATCH_KEY);
    expect(message.split('\n')[0]).toContain('Approve 10 actions?');
    // Natural order: w*0 … w*9, so approve_1 is /f0 and approve_10 is /f9.
    expect(message.indexOf('"path": "/f9"')).toBeGreaterThan(message.indexOf('"path": "/f1"'));
    const { result, executor } = await resumeWith(
      FAN_OUT,
      first,
      { [BATCH_KEY]: { action: 'accept', content: { approve_1: true, approve_10: true } } },
      d,
    );
    expect(executor.calls.map((c) => c.args['path'])).toEqual(['/f0', '/f9']);
    const out = structured(result)['output'] as Record<string, unknown>;
    expect(out['written']).toEqual(['/f0', '/f9']);
    expect(out['answered']).toBe(10);
  });

  it(`falls back to per-call prompts above ${MAX_BATCH_CALLS} calls, none dropped`, async () => {
    const d = deps({ approvalPrompts: 'batched' });
    const first = await executeMachine({ code: FAN_OUT, input: { paths: paths(12) } }, d);
    expect(requestKeys(first)).toHaveLength(12);
  });

  it('an empty list makes no calls, and the always transition finishes the machine', async () => {
    const executor = new FakeExecutor();
    const result = completed(
      await executeMachine({ code: FAN_OUT, input: { paths: [] } }, deps({ executor })),
    );
    expect(structured(result)['output']).toEqual({ answered: 0, written: [], refused: [] });
    expect(executor.calls).toEqual([]);
  });

  it('never re-executes an approved call on a later round trip', async () => {
    // The fan-out, then one more gated call: a second suspension.
    const code = `
import { setup, assign } from 'xstate';
import { toolCall, toolCalls, whenCallIn } from '@astral-mcp/tools';
export default setup({
  actions: { answered: assign({ answered: ({ context }) => context.answered + 1 }) },
}).createMachine({
  context: { answered: 0, cleaned: 'pending' },
  initial: 'writing',
  states: {
    writing: {
      entry: toolCalls('write_file', [{ path: '/a' }, { path: '/b' }, { path: '/c' }], { id: 'w' }),
      always: { guard: ({ context }) => context.answered === 3, target: 'cleaning' },
      on: {
        TOOL_RESULT: { guard: whenCallIn('w'), actions: 'answered' },
        TOOL_DENIED: { guard: whenCallIn('w'), actions: 'answered' },
      },
    },
    cleaning: {
      entry: toolCall('delete_file', { path: '/tmp' }, { id: 'clean' }),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ cleaned: 'yes' }) },
        TOOL_DENIED: { target: 'done', actions: assign({ cleaned: 'no' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => context,
});
`;
    const d = deps();
    const first = await executeMachine({ code }, d);
    const second = await resumeWith(code, first, { 'w*0': ACCEPT, 'w*2': ACCEPT }, d);
    expect(second.executor.calls.map((c) => c.args['path'])).toEqual(['/a', '/c']);
    expect(requestKeys(second.result)).toEqual(['clean']);
    const third = await resumeWith(code, second.result, { clean: ACCEPT }, d);
    // Only the new call ran on the last round trip.
    expect(third.executor.calls).toEqual([{ name: 'delete_file', args: { path: '/tmp' } }]);
    expect(structured(third.result)['output']).toEqual({ answered: 3, cleaned: 'yes' });
  });

  it('runs read-only items at once, each event carrying its index in the callId', async () => {
    const code = `
import { setup, assign } from 'xstate';
import { toolCalls, whenCallIn } from '@astral-mcp/tools';
export default setup({}).createMachine({
  context: { seen: [] },
  initial: 'reading',
  states: {
    reading: {
      entry: toolCalls('read_file', [{ path: '/x' }, { path: '/y' }]),
      always: { guard: ({ context }) => context.seen.length === 2, target: 'done' },
      on: { TOOL_RESULT: { guard: whenCallIn('read_file'), actions: assign({ seen: ({ context, event }) => [...context.seen, event.callId] }) } },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => context.seen,
});
`;
    const executor = new FakeExecutor();
    const result = completed(await executeMachine({ code }, deps({ executor })));
    expect(structured(result)['output']).toEqual(['read_file*0', 'read_file*1']);
    expect(executor.calls.map((c) => c.args['path'])).toEqual(['/x', '/y']);
  });
});

describe("every event carries its call's own args", () => {
  /** Records each event's type, callId and args; finishes once `n` have come. */
  const recorder = (entry: string, n: number): string => `
import { setup, assign } from 'xstate';
import { toolCall, toolCalls, whenCallIn } from '@astral-mcp/tools';
const record = assign({ seen: ({ context, event }) => [...context.seen, { type: event.type, callId: event.callId, args: event.args }] });
export default setup({}).createMachine({
  context: { seen: [] },
  initial: 'go',
  states: {
    go: {
      entry: ${entry},
      always: { guard: ({ context }) => context.seen.length === ${n}, target: 'done' },
      on: { TOOL_RESULT: { actions: record }, TOOL_ERROR: { actions: record }, TOOL_DENIED: { actions: record } },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => context.seen,
});
`;
  const seen = (result: Awaited<ReturnType<typeof executeMachine>>) =>
    structured(result)['output'] as { type: string; callId: string; args: unknown }[];

  it('on reads that run at once, and on a read that fails', async () => {
    const code = recorder(
      `[toolCalls('read_file', [{ path: '/x' }, { path: '/y' }], { id: 'r' }), toolCall('list_dir', { dir: '/' }, { id: 'l' })]`,
      3,
    );
    const executor = new FakeExecutor({
      list_dir: { ok: false, error: { message: 'no such dir' } },
    });
    const result = completed(await executeMachine({ code }, deps({ executor })));
    expect(seen(result)).toEqual([
      { type: 'TOOL_RESULT', callId: 'r*0', args: { path: '/x' } },
      { type: 'TOOL_RESULT', callId: 'r*1', args: { path: '/y' } },
      { type: 'TOOL_ERROR', callId: 'l', args: { dir: '/' } },
    ]);
  });

  it('on a policy-denied call', async () => {
    const code = recorder(`toolCall('delete_file', { path: '/z' }, { id: 'd' })`, 1);
    const result = completed(
      await executeMachine({ code }, deps({ policy: { delete_file: 'deny' } })),
    );
    expect(seen(result)).toEqual([{ type: 'TOOL_DENIED', callId: 'd', args: { path: '/z' } }]);
  });

  it('on resume: the sealed args of approved, declined and newly policy-denied calls', async () => {
    const code = recorder(
      `[toolCalls('write_file', [{ path: '/a' }, { path: '/b' }], { id: 'w' }), toolCall('delete_file', { path: '/c' }, { id: 'd' })]`,
      3,
    );
    const first = await executeMachine({ code }, deps());
    const { result } = await resumeWith(
      code,
      first,
      { 'w*0': ACCEPT, 'w*1': decline('no'), d: ACCEPT },
      deps({ policy: { delete_file: 'deny' } }),
    );
    expect(seen(result)).toEqual([
      { type: 'TOOL_RESULT', callId: 'w*0', args: { path: '/a' } },
      { type: 'TOOL_DENIED', callId: 'w*1', args: { path: '/b' } },
      { type: 'TOOL_DENIED', callId: 'd', args: { path: '/c' } },
    ]);
  });

  it('maps a fan-out by event.args when answers arrive out of list order', async () => {
    // write_file*1 fails the structural check (R15a), so its TOOL_ERROR comes
    // in the first segment; *0 and *2 answer only after the round trip.
    const catalog: ServerCatalog = {
      ...CATALOG,
      tools: CATALOG.tools.map((tool) =>
        tool.name === 'write_file'
          ? { ...tool, inputSchema: { type: 'object', required: ['path'] } }
          : tool,
      ),
    };
    const d = deps({ catalog, bridgeSource: generateToolTypes(catalog).bridgeSource });
    const code = `
import { setup, assign } from 'xstate';
import { toolCalls, whenCallIn } from '@astral-mcp/tools';
const items = [{ path: '/a', tag: 'A' }, { tag: 'B' }, { path: '/c', tag: 'C' }];
const record = assign({ by: ({ context, event }) => ({ ...context.by, [event.args.tag]: event.type }), order: ({ context, event }) => [...context.order, event.callId] });
export default setup({}).createMachine({
  context: { by: {}, order: [] },
  initial: 'writing',
  states: {
    writing: {
      entry: toolCalls('write_file', items, { id: 'w' }),
      always: { guard: ({ context }) => context.order.length === items.length, target: 'done' },
      on: {
        TOOL_RESULT: { guard: whenCallIn('w'), actions: record },
        TOOL_DENIED: { guard: whenCallIn('w'), actions: record },
        TOOL_ERROR: { guard: whenCallIn('w'), actions: record },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => context,
});
`;
    const first = await executeMachine({ code }, d);
    expect(requestKeys(first).toSorted()).toEqual(['w*0', 'w*2']);
    const { result } = await resumeWith(code, first, { 'w*0': ACCEPT, 'w*2': decline() }, d);
    expect(structured(result)['output']).toEqual({
      order: ['w*1', 'w*0', 'w*2'],
      by: { A: 'TOOL_RESULT', B: 'TOOL_ERROR', C: 'TOOL_DENIED' },
    });
  });
});

describe('toolCalls input checks', () => {
  const machine = (entry: string): string => `
import { setup } from 'xstate';
import { toolCall, toolCalls, whenCallIn } from '@astral-mcp/tools';
export default setup({}).createMachine({
  initial: 'go',
  states: {
    go: { type: 'parallel', entry: [${entry}], states: { a: {} }, on: { TOOL_RESULT: 'done' } },
    done: { type: 'final' },
  },
});
`;
  const errorOf = async (entry: string) => {
    const result = completed(await executeMachine({ code: machine(entry) }, deps()));
    expect(result.isError).toBe(true);
    return result.structuredContent as { phase: string; message: string; hint?: string };
  };

  it('rejects a list that is not an array', async () => {
    const error = await errorOf(`toolCalls('write_file', () => ({ path: '/a' }))`);
    expect(error.message).toContain(
      'toolCalls("write_file") argsList must resolve to an array of plain objects',
    );
  });

  it('rejects an item that is not a plain object, and queues none of the list', async () => {
    const executor = new FakeExecutor();
    const result = completed(
      await executeMachine(
        { code: machine(`toolCalls('read_file', [{ path: '/a' }, 'nope'])`) },
        deps({ executor }),
      ),
    );
    expect(JSON.stringify(result.structuredContent)).toContain(
      'toolCalls(\\"read_file\\") item 1 must be a plain object',
    );
    expect(executor.calls).toEqual([]);
  });

  it('refuses two gated calls in flight under one id rather than sealing one of them', async () => {
    const error = await errorOf(
      `toolCalls('write_file', [{ path: '/a' }, { path: '/b' }]), toolCall('write_file', { path: '/c' }, { id: 'write_file*1' })`,
    );
    expect(error.phase).toBe('validate');
    expect(error.message).toBe('two tool calls in flight share the id "write_file*1"');
    expect(error.hint).toContain("'<id>*0', '<id>*1'");
  });
});

describe("toolCalls ids stay apart from toolCall's defaults", () => {
  it("default toolCalls ids ('<name>*k') never collide with a plain toolCall's ('<name>#n')", async () => {
    // Before, the toolCall below took write_file#1, and so did the list's
    // second item: a validate error, or one sealed entry for two calls.
    const code = `
import { setup } from 'xstate';
import { toolCall, toolCalls } from '@astral-mcp/tools';
export default setup({}).createMachine({
  initial: 'go',
  states: {
    go: { entry: [toolCall('write_file', { path: '/c' }), toolCalls('write_file', [{ path: '/a' }, { path: '/b' }])], on: { TOOL_RESULT: 'done' } },
    done: { type: 'final' },
  },
});
`;
    const first = await executeMachine({ code }, deps());
    expect(isSuspended(first)).toBe(true);
    expect(requestKeys(first).toSorted()).toEqual(['write_file#1', 'write_file*0', 'write_file*1']);
  });

  it("whenCallIn(name) matches the list's events, not a plain toolCall's of the same tool", async () => {
    const code = `
import { setup, assign } from 'xstate';
import { toolCall, toolCalls, whenCallIn } from '@astral-mcp/tools';
export default setup({}).createMachine({
  context: { listed: [], other: [] },
  initial: 'reading',
  states: {
    reading: {
      entry: [toolCall('read_file', { path: '/p' }), toolCalls('read_file', [{ path: '/x' }, { path: '/y' }])],
      always: { guard: ({ context }) => context.listed.length + context.other.length === 3, target: 'done' },
      on: {
        TOOL_RESULT: [
          { guard: whenCallIn('read_file'), actions: assign({ listed: ({ context, event }) => [...context.listed, event.callId] }) },
          { actions: assign({ other: ({ context, event }) => [...context.other, event.callId] }) },
        ],
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => context,
});
`;
    const result = completed(await executeMachine({ code }, deps()));
    expect(structured(result)['output']).toEqual({
      listed: ['read_file*0', 'read_file*1'],
      other: ['read_file#1'],
    });
  });
});

describe('the contract teaches toolCalls under the round-trip cap', () => {
  it("quotes the facade's maxRoundTrips and the fan-out example", () => {
    const text = authoringContract(undefined, 3);
    expect(text).toContain('a workflow gets at most 3: one gated call per item');
    expect(text).toContain('stops unfinished past 3 items');
    expect(text).toContain(
      "entry: toolCalls('write_file', ({ context }) => context.paths.map((path) => ({ path, content: 'hello' })), { id: 'w' }),\n",
    );
    expect(authoringContract()).toContain('at most 8:');
  });
});
