import { describe, expect, it } from 'vitest';
import { executeMachine, MRTR_PROTOCOL_REVISION } from '../../src/mrtr/index.js';
import type {
  CompleteResult,
  ExecuteMachineDeps,
  InputRequiredResult,
  ToolCallResult,
} from '../../src/mrtr/index.js';
import type { BlobSealerConfig, StructuredError } from '../../src/types.js';
import { BRIDGE_SOURCE, CATALOG, FakeExecutor } from '../machine-host/fixtures.js';

const BLOB: BlobSealerConfig = { key: new Uint8Array(32).fill(3) };

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

function structuredError(result: ToolCallResult): StructuredError {
  const complete = result as CompleteResult;
  expect(complete.isError).toBe(true);
  return complete.structuredContent as unknown as StructuredError;
}

const WRITE_MACHINE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'w',
  context: { status: 'pending' },
  initial: 'writing',
  states: {
    writing: {
      entry: toolCall('write_file', () => ({ path: '/notes.txt', content: 'hello' }), { id: 'w1' }),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: 'written' }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'skipped' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status }),
});
`;

const READ_MACHINE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'r',
  context: { text: null },
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('read_file', () => ({ path: '/a' })),
      on: { TOOL_RESULT: { target: 'done', actions: assign({ text: ({ event }) => event.result }) } },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ text: context.text }),
});
`;

describe('execute_machine over MRTR', () => {
  it('completes read-only work in one call (PRD §8 happy path)', async () => {
    const result = await executeMachine({ code: READ_MACHINE }, deps());
    expect(isSuspended(result)).toBe(false);
    const complete = result as CompleteResult;
    expect(complete.isError).toBeUndefined();
    expect(complete.structuredContent?.['output']).toEqual({ text: 'read_file-ok' });
  });

  it('suspends with an elicitation and a sealed requestState', async () => {
    const executor = new FakeExecutor();
    const result = await executeMachine({ code: WRITE_MACHINE }, deps({ executor }));

    expect(isSuspended(result)).toBe(true);
    if (!isSuspended(result)) return;
    expect(Object.keys(result.inputRequests)).toEqual(['w1']);
    const request = result.inputRequests['w1'];
    expect(request?.type).toBe('elicitation');
    expect(request?.message).toContain('write_file');
    expect(request?.message).toContain('/notes.txt');
    // Nothing executed while waiting for approval.
    expect(executor.calls).toEqual([]);
    // The blob is opaque: machine context does not travel in the clear.
    expect(result.requestState).not.toContain('notes.txt');
    expect(result.requestState.startsWith('mcc1.')).toBe(true);
  });

  it('executes the write and completes on an accepted retry', async () => {
    const first = await executeMachine({ code: WRITE_MACHINE }, deps());
    if (!isSuspended(first)) throw new Error('expected suspension');

    const executor = new FakeExecutor();
    const retry = await executeMachine(
      {
        code: WRITE_MACHINE,
        requestState: first.requestState,
        inputResponses: { w1: { type: 'elicitation', action: 'accept' } },
      },
      deps({ executor }),
    );

    const complete = retry as CompleteResult;
    expect(complete.isError).toBeUndefined();
    expect(complete.structuredContent?.['output']).toEqual({ status: 'written' });
    expect(executor.calls).toEqual([
      { name: 'write_file', args: { path: '/notes.txt', content: 'hello' } },
    ]);
    expect(complete.structuredContent?.['approvals']).toEqual([
      {
        callId: 'w1',
        tool: 'write_file',
        args: { path: '/notes.txt', content: 'hello' },
        decision: 'approved',
      },
    ]);
  });

  it('takes the fallback branch when the user declines', async () => {
    const first = await executeMachine({ code: WRITE_MACHINE }, deps());
    if (!isSuspended(first)) throw new Error('expected suspension');

    const executor = new FakeExecutor();
    const retry = await executeMachine(
      {
        code: WRITE_MACHINE,
        requestState: first.requestState,
        inputResponses: {
          w1: { type: 'elicitation', action: 'decline', content: { reason: 'not today' } },
        },
      },
      deps({ executor }),
    );

    const complete = retry as CompleteResult;
    expect(complete.structuredContent?.['output']).toEqual({ status: 'skipped' });
    expect(executor.calls).toEqual([]);
  });

  it('treats a missing response as declined (R17)', async () => {
    const first = await executeMachine({ code: WRITE_MACHINE }, deps());
    if (!isSuspended(first)) throw new Error('expected suspension');

    const executor = new FakeExecutor();
    const retry = await executeMachine(
      { code: WRITE_MACHINE, requestState: first.requestState, inputResponses: {} },
      deps({ executor }),
    );
    expect((retry as CompleteResult).structuredContent?.['output']).toEqual({ status: 'skipped' });
    expect(executor.calls).toEqual([]);
  });
});

describe('blob verification on retry (R21, S3, S4)', () => {
  it('rejects a tampered blob without executing anything', async () => {
    const first = await executeMachine({ code: WRITE_MACHINE }, deps());
    if (!isSuspended(first)) throw new Error('expected suspension');

    const parts = first.requestState.split('.');
    // Flip a character in the ciphertext.
    const ciphertext = parts[3] as string;
    parts[3] = (ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.slice(1);
    const executor = new FakeExecutor();

    const retry = await executeMachine(
      {
        code: WRITE_MACHINE,
        requestState: parts.join('.'),
        inputResponses: { w1: { type: 'elicitation', action: 'accept' } },
      },
      deps({ executor }),
    );

    const error = structuredError(retry);
    expect(error.phase).toBe('blob_verification');
    expect(executor.calls).toEqual([]);
  });

  it('rejects a retry whose code does not match the blob (S4)', async () => {
    const first = await executeMachine({ code: WRITE_MACHINE }, deps());
    if (!isSuspended(first)) throw new Error('expected suspension');

    const executor = new FakeExecutor();
    const retry = await executeMachine(
      {
        code: WRITE_MACHINE.replace('/notes.txt', '/etc/passwd'),
        requestState: first.requestState,
        inputResponses: { w1: { type: 'elicitation', action: 'accept' } },
      },
      deps({ executor }),
    );

    const error = structuredError(retry);
    expect(error.phase).toBe('blob_verification');
    expect(error.message).toContain('code hash');
    expect(executor.calls).toEqual([]);
  });

  it('rejects a blob minted against a different wrapped server', async () => {
    const first = await executeMachine({ code: WRITE_MACHINE }, deps());
    if (!isSuspended(first)) throw new Error('expected suspension');

    const executor = new FakeExecutor();
    const retry = await executeMachine(
      {
        code: WRITE_MACHINE,
        requestState: first.requestState,
        inputResponses: { w1: { type: 'elicitation', action: 'accept' } },
      },
      deps({ executor, catalog: { ...CATALOG, identity: 'someone-else@2.0.0' } }),
    );

    expect(structuredError(retry).phase).toBe('blob_verification');
    expect(executor.calls).toEqual([]);
  });

  it('rejects a blob sealed under a key this deployment does not accept', async () => {
    const first = await executeMachine({ code: WRITE_MACHINE }, deps());
    if (!isSuspended(first)) throw new Error('expected suspension');

    const executor = new FakeExecutor();
    const retry = await executeMachine(
      {
        code: WRITE_MACHINE,
        requestState: first.requestState,
        inputResponses: { w1: { type: 'elicitation', action: 'accept' } },
      },
      deps({ executor, blob: { key: new Uint8Array(32).fill(9) } }),
    );

    expect(structuredError(retry).phase).toBe('blob_verification');
    expect(executor.calls).toEqual([]);
  });

  it('resumes a blob sealed under a rotated-out key (R22)', async () => {
    const oldKey = new Uint8Array(32).fill(1);
    const newKey = new Uint8Array(32).fill(2);
    const first = await executeMachine({ code: WRITE_MACHINE }, deps({ blob: { key: oldKey } }));
    if (!isSuspended(first)) throw new Error('expected suspension');

    const executor = new FakeExecutor();
    const retry = await executeMachine(
      {
        code: WRITE_MACHINE,
        requestState: first.requestState,
        inputResponses: { w1: { type: 'elicitation', action: 'accept' } },
      },
      deps({ executor, blob: { key: newKey, previousKeys: [oldKey] } }),
    );

    expect((retry as CompleteResult).structuredContent?.['output']).toEqual({ status: 'written' });
    expect(executor.calls).toHaveLength(1);
  });
});

describe('down-negotiation (R28)', () => {
  it('runs read-only machines on a pre-MRTR client', async () => {
    const result = await executeMachine(
      { code: READ_MACHINE },
      deps({ protocolVersion: '2025-06-18' }),
    );
    expect((result as CompleteResult).structuredContent?.['output']).toEqual({
      text: 'read_file-ok',
    });
  });

  it('fails fast naming the required revision when a gated call would suspend', async () => {
    const executor = new FakeExecutor();
    const result = await executeMachine(
      { code: WRITE_MACHINE },
      deps({ executor, protocolVersion: '2025-06-18' }),
    );

    const error = structuredError(result);
    expect(error.phase).toBe('protocol');
    expect(error.message).toContain(MRTR_PROTOCOL_REVISION);
    expect(executor.calls).toEqual([]);
  });
});

describe('caps at the tool boundary', () => {
  it('rejects oversized code before executing it', async () => {
    const code = `${READ_MACHINE}\n// ${'x'.repeat(2000)}`;
    const result = await executeMachine({ code }, deps({ caps: { maxCodeBytes: 500 } }));
    const error = structuredError(result);
    expect(error.phase).toBe('cap_exceeded');
    expect(error.message).toContain('submitted code');
  });

  it('terminates a workflow that exceeds the round-trip cap (R18)', async () => {
    // A machine that needs two approvals, with the cap set to one.
    const twoWrites = `
import { setup, assign } from 'xstate';
import { toolCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'two',
  context: { n: 0 },
  initial: 'first',
  states: {
    first: {
      entry: toolCall('write_file', () => ({ path: '/1' }), { id: 'one' }),
      on: { TOOL_RESULT: 'second', TOOL_DENIED: 'second' },
    },
    second: {
      entry: toolCall('write_file', () => ({ path: '/2' }), { id: 'two' }),
      on: { TOOL_RESULT: 'done', TOOL_DENIED: 'done' },
    },
    done: { type: 'final' },
  },
  output: () => ({ ok: true }),
});
`;
    const caps = { maxRoundTrips: 1 };
    const first = await executeMachine({ code: twoWrites }, deps({ caps }));
    if (!isSuspended(first)) throw new Error('expected suspension');

    const retry = await executeMachine(
      {
        code: twoWrites,
        requestState: first.requestState,
        inputResponses: { one: { type: 'elicitation', action: 'accept' } },
      },
      deps({ caps }),
    );

    const error = structuredError(retry);
    expect(error.phase).toBe('terminal');
    expect(error.message).toContain('round trips');
  });
});

describe('elicitation content (R16, S6)', () => {
  it('shows the catalog description and resolved arguments, redacted', async () => {
    const code = `
import { setup } from 'xstate';
import { toolCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'secretish',
  initial: 'writing',
  states: {
    writing: {
      entry: toolCall('write_file', () => ({ path: '/n', token: 'sk-super-secret' }), { id: 'w1' }),
      on: { TOOL_RESULT: 'done', TOOL_DENIED: 'done' },
    },
    done: { type: 'final' },
  },
});
`;
    const result = await executeMachine(
      { code },
      deps({
        redact: (_tool, args) => ({ ...args, token: '[redacted]' }),
      }),
    );

    if (!isSuspended(result)) throw new Error('expected suspension');
    const message = result.inputRequests['w1']?.message ?? '';
    expect(message).toContain('Write a file.');
    expect(message).toContain('"path": "/n"');
    expect(message).toContain('[redacted]');
    expect(message).not.toContain('sk-super-secret');
  });

  it('warns more strongly for a destructive tool (R14)', async () => {
    const code = `
import { setup } from 'xstate';
import { toolCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'd',
  initial: 'deleting',
  states: {
    deleting: {
      entry: toolCall('delete_file', () => ({ path: '/important' }), { id: 'd1' }),
      on: { TOOL_RESULT: 'done', TOOL_DENIED: 'done' },
    },
    done: { type: 'final' },
  },
});
`;
    const result = await executeMachine({ code }, deps());
    if (!isSuspended(result)) throw new Error('expected suspension');
    const request = result.inputRequests['d1'];
    expect(request?.title).toContain('DESTRUCTIVE');
    expect(request?.message.startsWith('WARNING:')).toBe(true);
  });
});
