/**
 * Batched approval prompts (WrapOptions.approvalPrompts: 'batched';
 * DECISIONS D22): one elicitation for every call a suspension holds, one
 * boolean per call, and each call still bound to its own sealed entry (S2).
 */

import { describe, expect, it } from 'vitest';
import { executeMachine, APPROVAL_SCHEMA } from '../../src/mrtr/index.js';
import type { ExecuteMachineDeps } from '../../src/mrtr/index.js';
import {
  batchOrder,
  BATCH_KEY,
  MAX_BATCH_CALLS,
  MAX_BATCH_MESSAGE_CHARS,
} from '../../src/mrtr/batch.js';
import type { BlobSealerConfig, PendingToolCall } from '../../src/types.js';
import { assertApprovalPrompts } from '../../src/facade/options.js';
import { buildBlobPayload, openBlob, sealBlob } from '../../src/blob/index.js';
import { BRIDGE_SOURCE, CATALOG, FakeExecutor } from '../machine-host/fixtures.js';
import {
  ACCEPT,
  completed,
  decline,
  elicitation,
  requestKeys,
  sealedState,
  structured,
} from './helpers.js';

const BLOB: BlobSealerConfig = { key: new Uint8Array(32).fill(7) };

function deps(overrides: Partial<ExecuteMachineDeps> = {}): ExecuteMachineDeps {
  return {
    catalog: CATALOG,
    bridgeSource: BRIDGE_SOURCE,
    executor: new FakeExecutor(),
    blob: BLOB,
    protocolEra: 'modern',
    approvalPrompts: 'batched',
    ...overrides,
  };
}

/** Two gated writes requested in one step (parallel), plus a destructive delete. */
const FANOUT = `
import { setup, assign } from 'xstate';
import { toolCall, whenCall } from '@astral-mcp/tools';
const region = (id, path, tool) => ({
  initial: 'go',
  states: {
    go: {
      entry: toolCall(tool, () => ({ path }), { id }),
      on: {
        TOOL_RESULT: { guard: whenCall(id), target: 'done', actions: assign({ [id]: 'ran' }) },
        TOOL_DENIED: { guard: whenCall(id), target: 'done', actions: assign({ [id]: ({ event }) => 'refused:' + (event.reason ?? '') }) },
      },
    },
    done: { type: 'final' },
  },
});
export default setup({}).createMachine({
  context: { w2: 'pending', w10: 'pending', d1: 'pending' },
  type: 'parallel',
  states: {
    a: region('w2', '/two', 'write_file'),
    b: region('w10', '/ten', 'write_file'),
    c: region('d1', '/gone', 'delete_file'),
  },
  output: ({ context }) => context,
});
`;

const SINGLE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';
export default setup({}).createMachine({
  context: { s: 'pending' },
  initial: 'w',
  states: {
    w: {
      entry: toolCall('write_file', () => ({ path: '/one' }), { id: 'only' }),
      on: { TOOL_RESULT: { target: 'done', actions: assign({ s: 'ran' }) }, TOOL_DENIED: { target: 'done', actions: assign({ s: 'refused' }) } },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => context,
});
`;

async function suspend(d = deps()) {
  const first = await executeMachine({ code: FANOUT }, d);
  return { first, state: sealedState(first) };
}

async function resume(inputResponses: Record<string, unknown> | undefined, d = deps()) {
  const { state } = await suspend(d);
  const executor = new FakeExecutor();
  const result = await executeMachine(
    {
      code: FANOUT,
      requestState: state,
      ...(inputResponses !== undefined ? { inputResponses } : {}),
    },
    { ...d, executor },
  );
  return { result, executor, out: structured(result)['output'] as Record<string, string> };
}

describe('batched approval prompts', () => {
  it('puts every pending call in one elicitation: a [k] section and an unticked boolean each', async () => {
    const { first } = await suspend();
    expect(requestKeys(first)).toEqual([BATCH_KEY]);
    expect(BATCH_KEY).toBe('projection:approvals');
    const { message, requestedSchema } = elicitation(first, BATCH_KEY);
    const lines = message.split('\n');
    expect(lines[0]).toBe(
      'Approve 3 actions? Each one is approved or declined on its own: tick the ones you approve, or decline to refuse them all.',
    );
    // Display order is the pending keys in natural order: d1, w2, w10.
    expect(lines.filter((l) => /^\[\d+\] /.test(l))).toEqual([
      '[1] ⚠ Approve: delete file',
      '[2] Approve: write file',
      '[3] Approve: write file',
    ]);
    const at = (k: number): number => lines.findIndex((l) => l.startsWith(`[${k}] `));
    expect(lines.slice(at(2), at(3)).join('\n')).toContain('"path": "/two"');
    expect(lines.slice(at(3)).join('\n')).toContain('"path": "/ten"');
    // Each section is the full R16 copy, the destructive warning included.
    expect(lines.slice(at(1), at(2)).join('\n')).toContain(
      'This can permanently change or delete data.',
    );
    // No `default` (a client applying defaults must not approve anything)
    // and no `required` (an empty accept declines, it does not error).
    expect(requestedSchema).toEqual({
      type: 'object',
      properties: {
        approve_1: { type: 'boolean', title: '[1] ⚠ Approve: delete file' },
        approve_2: { type: 'boolean', title: '[2] Approve: write file' },
        approve_3: { type: 'boolean', title: '[3] Approve: write file' },
        reason: {
          type: 'string',
          description: 'Optional note shown to the model for the actions you decline.',
        },
      },
      additionalProperties: false,
    });
  });

  it('runs exactly the ticked calls, each on its own sealed arguments; the rest get TOOL_DENIED with the note (S2)', async () => {
    const { executor, out, result } = await resume({
      [BATCH_KEY]: {
        action: 'accept',
        content: { approve_1: false, approve_2: true, approve_3: true, reason: 'keep it' },
      },
    });
    expect(executor.calls).toEqual([
      { name: 'write_file', args: { path: '/two' } },
      { name: 'write_file', args: { path: '/ten' } },
    ]);
    expect(out).toEqual({ w2: 'ran', w10: 'ran', d1: 'refused:keep it' });
    // The audit follows the machine's request order, not the display order.
    const audit = structured(result)['approvals'] as unknown[];
    expect(audit).toHaveLength(3);
    expect(audit).toEqual(
      expect.arrayContaining([
        {
          callId: 'd1',
          tool: 'delete_file',
          args: { path: '/gone' },
          decision: 'declined',
          reason: 'keep it',
        },
        { callId: 'w2', tool: 'write_file', args: { path: '/two' }, decision: 'approved' },
        { callId: 'w10', tool: 'write_file', args: { path: '/ten' }, decision: 'approved' },
      ]),
    );
  });

  it('declines every call on a decline, a cancel, a missing answer, an accept without the booleans, or a non-boolean tick', async () => {
    for (const responses of [
      { [BATCH_KEY]: decline('no') },
      { [BATCH_KEY]: { action: 'cancel' } },
      undefined,
      {},
      { [BATCH_KEY]: ACCEPT },
      { [BATCH_KEY]: { action: 'accept', content: {} } },
      {
        [BATCH_KEY]: {
          action: 'accept',
          content: { approve_1: 'true', approve_2: 1, approve_3: null },
        },
      },
    ]) {
      const { executor, out } = await resume(responses);
      expect(executor.calls).toEqual([]);
      expect(Object.values(out).every((v) => v.startsWith('refused'))).toBe(true);
    }
  });

  it("a blob is answered by the layout sealed in it, not the resuming instance's option", async () => {
    const ticked = {
      [BATCH_KEY]: {
        action: 'accept',
        content: { approve_1: false, approve_2: true, approve_3: true },
      },
    };
    // Minted batched, resumed by a per-call instance: still read as batched,
    // so the unticked delete stays refused.
    const batchedState = (await suspend()).state;
    const executor = new FakeExecutor();
    await executeMachine(
      { code: FANOUT, requestState: batchedState, inputResponses: ticked },
      deps({ executor, approvalPrompts: 'per-call' }),
    );
    expect(executor.calls).toEqual([
      { name: 'write_file', args: { path: '/two' } },
      { name: 'write_file', args: { path: '/ten' } },
    ]);
    // Per-call answers to a batched blob are not its answer: nothing runs.
    const perCallAnswers = { d1: ACCEPT, w2: ACCEPT, w10: ACCEPT };
    expect((await resume(perCallAnswers)).executor.calls).toEqual([]);
    // Minted per-call, resumed by a batched instance: still read per call.
    const perCall = deps({ approvalPrompts: 'per-call' });
    const { state } = await suspend(perCall);
    const executor2 = new FakeExecutor();
    await executeMachine(
      { code: FANOUT, requestState: state, inputResponses: { w2: ACCEPT } },
      deps({ executor: executor2 }),
    );
    expect(executor2.calls).toEqual([{ name: 'write_file', args: { path: '/two' } }]);
    // ... and a batched answer to it approves nothing.
    const executor3 = new FakeExecutor();
    await executeMachine(
      { code: FANOUT, requestState: state, inputResponses: ticked },
      deps({ executor: executor3 }),
    );
    expect(executor3.calls).toEqual([]);
  });

  it('a call id cannot reach the batch key: the reserved prefix is refused, and the old colliding id stays bound', async () => {
    // The review's repro: a machine names its destructive call "approvals",
    // the old batch key. Minted batched, resumed per-call, the human's
    // unticked [1] must not run.
    const code = (id: string): string => `
import { setup, assign } from 'xstate';
import { toolCall, whenCall } from '@astral-mcp/tools';
const region = (id, path, tool) => ({
  initial: 'go',
  states: {
    go: {
      entry: toolCall(tool, () => ({ path }), { id }),
      on: {
        TOOL_RESULT: { guard: whenCall(id), target: 'done', actions: assign({ [id]: 'ran' }) },
        TOOL_DENIED: { guard: whenCall(id), target: 'done', actions: assign({ [id]: 'refused' }) },
      },
    },
    done: { type: 'final' },
  },
});
export default setup({}).createMachine({
  context: { ['${id}']: 'pending', w2: 'pending' },
  type: 'parallel',
  states: { a: region('${id}', '/prod', 'delete_file'), b: region('w2', '/two', 'write_file') },
  output: ({ context }) => context,
});
`;
    const old = code('approvals');
    const first = await executeMachine({ code: old }, deps());
    expect(requestKeys(first)).toEqual([BATCH_KEY]);
    const answer = {
      [BATCH_KEY]: { action: 'accept', content: { approve_1: false, approve_2: true } },
      approvals: ACCEPT,
    };
    for (const approvalPrompts of ['batched', 'per-call'] as const) {
      const executor = new FakeExecutor();
      const r = await executeMachine(
        { code: old, requestState: sealedState(first), inputResponses: answer },
        deps({ executor, approvalPrompts }),
      );
      expect(executor.calls).toEqual([{ name: 'write_file', args: { path: '/two' } }]);
      expect(structured(r)['output']).toEqual({ approvals: 'refused', w2: 'ran' });
    }
    // An id in the reserved namespace is a validate error before any prompt.
    const reserved = await executeMachine({ code: code(BATCH_KEY) }, deps());
    expect(completed(reserved).isError).toBe(true);
    expect(structured(reserved)['phase']).toBe('validate');
    expect(structured(reserved)['message']).toContain('reserved prefix "projection:"');
  });

  it('caps a batch by call count and message length, falling back to per-call prompts', async () => {
    const many = (n: number, args: string): string => `
import { setup, enqueueActions } from 'xstate';
import { toolCall } from '@astral-mcp/tools';
export default setup({}).createMachine({
  initial: 'go',
  states: {
    go: {
      entry: enqueueActions(({ enqueue }) => {
        for (let i = 0; i < ${n}; i++) enqueue(toolCall('write_file', () => (${args}), { id: 'c' + i }));
      }),
    },
  },
});
`;
    const small = "{ path: '/f' }";
    expect(
      requestKeys(await executeMachine({ code: many(MAX_BATCH_CALLS, small) }, deps())),
    ).toEqual([BATCH_KEY]);
    expect(
      requestKeys(await executeMachine({ code: many(MAX_BATCH_CALLS + 1, small) }, deps())),
    ).toHaveLength(MAX_BATCH_CALLS + 1);
    // Five calls whose copies (about 4 KB each) together pass the message cap.
    const long = JSON.stringify('y'.repeat(500));
    const wideArgs = `{ ${['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((k) => `${k}: ${long}`).join(', ')} }`;
    const wide = await executeMachine({ code: many(5, wideArgs) }, deps());
    expect(requestKeys(wide)).toHaveLength(5);
    const perCallChars = elicitation(wide, 'c0').message.length;
    expect(5 * perCallChars).toBeGreaterThan(MAX_BATCH_MESSAGE_CHARS);
    // Sealed per-call, so its per-call answers are the ones read.
    const executor = new FakeExecutor();
    await executeMachine(
      { code: many(5, wideArgs), requestState: sealedState(wide), inputResponses: { c0: ACCEPT } },
      deps({ executor }),
    );
    expect(executor.calls).toHaveLength(1);
  });

  it('a suspension with one call keeps the per-call layout', async () => {
    const first = await executeMachine({ code: SINGLE }, deps());
    expect(requestKeys(first)).toEqual(['only']);
    expect(elicitation(first, 'only').requestedSchema).toEqual(APPROVAL_SCHEMA);
    const done = await executeMachine(
      { code: SINGLE, requestState: sealedState(first), inputResponses: { only: ACCEPT } },
      deps(),
    );
    expect(completed(done).isError).toBeUndefined();
    expect(structured(done)['output']).toEqual({ s: 'ran' });
  });

  it('the per-call default is unchanged: one elicitation per call', async () => {
    const { approvalPrompts: _unset, ...defaults } = deps();
    const first = await executeMachine({ code: FANOUT }, defaults);
    expect(requestKeys(first).toSorted()).toEqual(['d1', 'w10', 'w2']);
  });

  it('orders keys naturally and independently of insertion order', () => {
    const call = (id: string): PendingToolCall => ({
      id,
      name: 'write_file',
      args: {},
      stateName: 's',
    });
    const a = { w10: call('w10'), w2: call('w2'), d1: call('d1') };
    const b = { d1: call('d1'), w2: call('w2'), w10: call('w10') };
    expect(batchOrder(a)).toEqual(['d1', 'w2', 'w10']);
    expect(batchOrder(b)).toEqual(batchOrder(a));
  });

  it('seals the layout: only an absent or batched prompts field opens, and never on a call blob', () => {
    const open = (extra: Record<string, unknown>, kind: 'machine' | 'call' = 'machine') => {
      const payload = buildBlobPayload({
        kind,
        code: 'c',
        serverIdentity: 'files@1.0.0',
        snapshot: kind === 'call' ? null : {},
        pending: { call: { id: 'call', name: 'write_file', args: {}, stateName: 's' } },
        trip: 1,
      });
      return () =>
        openBlob(sealBlob({ ...payload, ...extra } as typeof payload, BLOB), {
          expectedKind: kind,
          code: 'c',
          serverIdentity: 'files@1.0.0',
          config: BLOB,
        });
    };
    expect(open({})().prompts).toBeUndefined();
    expect(open({ prompts: 'batched' })().prompts).toBe('batched');
    expect(open({ prompts: 'per-call' })).toThrow(/prompts/);
    expect(open({ prompts: 'batched' }, 'call')).toThrow(/prompts \(call blob\)/);
  });

  it('validates the option at wrap time', () => {
    expect(assertApprovalPrompts(undefined)).toBeUndefined();
    expect(assertApprovalPrompts('batched')).toBe('batched');
    expect(() => assertApprovalPrompts('all-at-once')).toThrow(/approvalPrompts must be/);
  });
});
