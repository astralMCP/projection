/**
 * Regression tests for defects found in review of PR #1. Each test failed
 * before its fix.
 */

import { describe, expect, it } from 'vitest';
import { executeMachine, MRTR_PROTOCOL_REVISION } from '../../src/mrtr/index.js';
import type {
  CompleteResult,
  ExecuteMachineDeps,
  InputRequiredResult,
  ToolCallResult,
} from '../../src/mrtr/index.js';
import { clampCaps, type AuditEntry, type BlobSealerConfig } from '../../src/types.js';
import { BRIDGE_SOURCE, CATALOG, FakeExecutor } from '../machine-host/fixtures.js';

const BLOB: BlobSealerConfig = { key: new Uint8Array(32).fill(7) };

function deps(overrides: Partial<ExecuteMachineDeps> = {}): ExecuteMachineDeps {
  return {
    catalog: CATALOG,
    bridgeSource: BRIDGE_SOURCE,
    executor: new FakeExecutor(),
    blob: BLOB,
    protocolVersion: MRTR_PROTOCOL_REVISION,
    ...overrides,
  };
}

function isSuspended(result: ToolCallResult): result is InputRequiredResult {
  return 'resultType' in result && result.resultType === 'input_required';
}

function completed(result: ToolCallResult): CompleteResult {
  const complete = result as CompleteResult;
  if (complete.isError === true) {
    throw new Error(`unexpected error: ${JSON.stringify(complete.structuredContent)}`);
  }
  return complete;
}

/** Two sequential gated writes, so a workflow needs two round trips. */
const TWO_WRITES = `
import { setup, assign } from 'xstate';
import { toolCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'two',
  context: { a: null, b: null },
  initial: 'first',
  states: {
    first: {
      entry: toolCall('write_file', () => ({ path: '/1' }), { id: 'one' }),
      on: {
        TOOL_RESULT: { target: 'second', actions: assign({ a: 'ok' }) },
        TOOL_DENIED: { target: 'second', actions: assign({ a: 'no' }) },
      },
    },
    second: {
      entry: toolCall('write_file', () => ({ path: '/2' }), { id: 'two' }),
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

/** Approve every pending request of a suspension and run the retry. */
async function approveAll(
  code: string,
  suspension: InputRequiredResult,
  d: ExecuteMachineDeps,
): Promise<ToolCallResult> {
  const inputResponses = Object.fromEntries(
    Object.keys(suspension.inputRequests).map((key) => [
      key,
      { type: 'elicitation' as const, action: 'accept' as const },
    ]),
  );
  return await executeMachine({ code, requestState: suspension.requestState, inputResponses }, d);
}

describe('the approval audit trail survives every round trip (PRD §8)', () => {
  it('reports both approvals of a two-round-trip workflow, not just the last', async () => {
    const executor = new FakeExecutor();
    const d = deps({ executor });

    const first = await executeMachine({ code: TWO_WRITES }, d);
    if (!isSuspended(first)) throw new Error('expected first suspension');
    const second = await approveAll(TWO_WRITES, first, d);
    if (!isSuspended(second)) throw new Error('expected second suspension');
    const final = completed(await approveAll(TWO_WRITES, second, d));

    expect(final.structuredContent?.['output']).toEqual({ a: 'ok', b: 'ok' });
    const approvals = final.structuredContent?.['approvals'] as AuditEntry[];
    expect(approvals.map((entry) => entry.callId)).toEqual(['one', 'two']);
    expect(approvals.every((entry) => entry.decision === 'approved')).toBe(true);
    expect(executor.calls.map((call) => call.args['path'])).toEqual(['/1', '/2']);
  });
});

describe('round-trip cap counts round trips exactly (R18)', () => {
  it('lets a workflow use its full allowance of N round trips', async () => {
    const caps = { maxRoundTrips: 2 };
    const d = deps({ caps });

    const first = await executeMachine({ code: TWO_WRITES }, d);
    if (!isSuspended(first)) throw new Error('expected first suspension');
    const second = await approveAll(TWO_WRITES, first, d);
    if (!isSuspended(second)) throw new Error('expected second suspension');

    // Previously the second approval — already shown to and accepted by the
    // user — was rejected as over the cap.
    const final = completed(await approveAll(TWO_WRITES, second, d));
    expect(final.structuredContent?.['output']).toEqual({ a: 'ok', b: 'ok' });
  });

  it('refuses the N+1th suspension before prompting the user', async () => {
    const caps = { maxRoundTrips: 1 };
    const d = deps({ caps });

    const first = await executeMachine({ code: TWO_WRITES }, d);
    if (!isSuspended(first)) throw new Error('expected first suspension');

    const retry = (await approveAll(TWO_WRITES, first, d)) as CompleteResult;
    expect(retry.isError).toBe(true);
    const error = retry.structuredContent as unknown as { phase: string; message: string };
    expect(error.phase).toBe('terminal');
    expect(error.message).toContain('round trips');
  });
});

describe('a settle step that mixes an auto call with a gated one (R15)', () => {
  // Region A reads (auto) then reads again; region B writes (gated). The
  // second read is queued in response to the first read's result, which is
  // delivered while the workflow is on its way to suspending.
  const MIXED = `
import { setup, assign } from 'xstate';
import { toolCall, whenCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'mixed',
  type: 'parallel',
  context: { r1: null, r2: null, w: null },
  states: {
    A: {
      initial: 'r1',
      states: {
        r1: {
          entry: toolCall('read_file', () => ({ path: '/r1' }), { id: 'r1' }),
          on: { TOOL_RESULT: { guard: whenCall('r1'), target: 'r2', actions: assign({ r1: 'ok' }) } },
        },
        r2: {
          entry: toolCall('read_file', () => ({ path: '/r2' }), { id: 'r2' }),
          on: { TOOL_RESULT: { guard: whenCall('r2'), target: 'adone', actions: assign({ r2: 'ok' }) } },
        },
        adone: { type: 'final' },
      },
    },
    B: {
      initial: 'w',
      states: {
        w: {
          entry: toolCall('write_file', () => ({ path: '/w' }), { id: 'w' }),
          on: {
            TOOL_RESULT: { guard: whenCall('w'), target: 'bdone', actions: assign({ w: 'ok' }) },
            TOOL_DENIED: { guard: whenCall('w'), target: 'bdone', actions: assign({ w: 'no' }) },
          },
        },
        bdone: { type: 'final' },
      },
    },
  },
  output: ({ context }) => context,
});
`;

  it('does not drop calls queued while the workflow is suspending', async () => {
    const executor = new FakeExecutor();
    const d = deps({ executor });

    const first = await executeMachine({ code: MIXED }, d);
    if (!isSuspended(first)) throw new Error('expected suspension');
    // Both reads ran inline; only the write is gated.
    expect(executor.calls.map((call) => call.args['path'])).toEqual(['/r1', '/r2']);
    expect(Object.keys(first.inputRequests)).toEqual(['w']);

    // Previously the second read was spliced out of the in-VM queue and
    // lost, so the approved write executed and the workflow then died as
    // "stuck", blaming the model for a host bug.
    const final = completed(await approveAll(MIXED, first, d));
    expect(final.structuredContent?.['output']).toEqual({ r1: 'ok', r2: 'ok', w: 'ok' });
  });
});

describe('an approved call that fails at the wrapped server (R17)', () => {
  it('delivers TOOL_ERROR rather than TOOL_RESULT', async () => {
    const code = `
import { setup, assign } from 'xstate';
import { toolCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'e',
  context: { status: 'pending' },
  initial: 'writing',
  states: {
    writing: {
      entry: toolCall('write_file', () => ({ path: '/x' }), { id: 'w1' }),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: 'written' }) },
        TOOL_ERROR: { target: 'done', actions: assign({ status: ({ event }) => 'failed: ' + event.error.message }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'skipped' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status }),
});
`;
    const first = await executeMachine({ code }, deps());
    if (!isSuspended(first)) throw new Error('expected suspension');

    const executor = new FakeExecutor({
      write_file: { ok: false, error: { message: 'disk full' } },
    });
    const final = completed(await approveAll(code, first, deps({ executor })));

    expect(final.structuredContent?.['output']).toEqual({ status: 'failed: disk full' });
    const approvals = final.structuredContent?.['approvals'] as AuditEntry[];
    expect(approvals[0]?.decision).toBe('error');
  });
});

describe('cap clamping has a floor as well as a ceiling (R12)', () => {
  it('refuses zero and negative values instead of bricking the flow', () => {
    const caps = clampCaps({
      maxRoundTrips: 0,
      segmentWallClockMs: 0,
      maxEventsPerSegment: -5,
    });
    expect(caps.maxRoundTrips).toBeGreaterThanOrEqual(1);
    expect(caps.segmentWallClockMs).toBeGreaterThan(0);
    expect(caps.maxEventsPerSegment).toBeGreaterThanOrEqual(1);
  });

  it('ignores non-finite values', () => {
    const caps = clampCaps({ maxRoundTrips: Number.NaN });
    expect(Number.isFinite(caps.maxRoundTrips)).toBe(true);
    expect(caps.maxRoundTrips).toBeGreaterThanOrEqual(1);
  });
});
