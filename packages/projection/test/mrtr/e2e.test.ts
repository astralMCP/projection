import { describe, expect, it } from 'vitest';
import { APPROVAL_SCHEMA, executeMachine, MRTR_PROTOCOL_REVISION } from '../../src/mrtr/index.js';
import type { ExecuteMachineDeps, ToolCallResult } from '../../src/mrtr/index.js';
import type { BlobSealerConfig, StructuredError } from '../../src/types.js';
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
  suspension,
} from './helpers.js';

const BLOB: BlobSealerConfig = { key: new Uint8Array(32).fill(3) };

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

function structuredError(result: ToolCallResult): StructuredError {
  expect(completed(result).isError).toBe(true);
  return structured(result) as unknown as StructuredError;
}

const WRITE_MACHINE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

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
import { toolCall } from '@astral-mcp/tools';

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
    const complete = structured(result);
    expect(completed(result).isError).toBeUndefined();
    expect(complete['output']).toEqual({ text: 'read_file-ok' });
  });

  it('suspends with an elicitation and a sealed requestState', async () => {
    const executor = new FakeExecutor();
    const result = await executeMachine({ code: WRITE_MACHINE }, deps({ executor }));

    expect(isSuspended(result)).toBe(true);
    expect(requestKeys(result)).toEqual(['w1']);
    const request = elicitation(result, 'w1');
    expect(request.message).toContain('write_file');
    expect(request.message).toContain('/notes.txt');
    expect(request.requestedSchema).toEqual(APPROVAL_SCHEMA);
    // Nothing executed while waiting for approval.
    expect(executor.calls).toEqual([]);
    // The blob is opaque: machine context does not travel in the clear.
    expect(sealedState(result)).not.toContain('notes.txt');
    expect(sealedState(result).startsWith('proj1.')).toBe(true);
  });

  it('emits a suspension carrying only the three fields the wire allows (R31 caveat)', async () => {
    const noisy = WRITE_MACHINE.replace(
      "import { toolCall } from '@astral-mcp/tools';",
      "import { toolCall } from '@astral-mcp/tools';\nconsole.log('about to ask');",
    );
    const result = await executeMachine({ code: noisy }, deps());
    const suspended = suspension(result);

    // The 2026-07-28 `InputRequiredResult` has no slot for content or _meta,
    // and the SDK's encode seam drops both, so the suspending segment's
    // console output has nowhere to ride. Asserted so the day the spec grows
    // a vehicle for it, this test says where to put it back.
    expect(Object.keys(suspended).toSorted()).toEqual([
      'inputRequests',
      'requestState',
      'resultType',
    ]);
  });

  it('executes the write and completes on an accepted retry', async () => {
    const first = await executeMachine({ code: WRITE_MACHINE }, deps());
    if (!isSuspended(first)) throw new Error('expected suspension');

    const executor = new FakeExecutor();
    const retry = await executeMachine(
      {
        code: WRITE_MACHINE,
        requestState: sealedState(first),
        inputResponses: { w1: ACCEPT },
      },
      deps({ executor }),
    );

    const complete = structured(retry);
    expect(completed(retry).isError).toBeUndefined();
    expect(complete['output']).toEqual({ status: 'written' });
    expect(executor.calls).toEqual([
      { name: 'write_file', args: { path: '/notes.txt', content: 'hello' } },
    ]);
    expect(complete['approvals']).toEqual([
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
        requestState: sealedState(first),
        inputResponses: {
          w1: decline('not today'),
        },
      },
      deps({ executor }),
    );

    const complete = structured(retry);
    expect(complete['output']).toEqual({ status: 'skipped' });
    expect(executor.calls).toEqual([]);
  });

  it('treats a missing response as declined (R17)', async () => {
    const first = await executeMachine({ code: WRITE_MACHINE }, deps());
    if (!isSuspended(first)) throw new Error('expected suspension');

    const executor = new FakeExecutor();
    const retry = await executeMachine(
      { code: WRITE_MACHINE, requestState: sealedState(first), inputResponses: {} },
      deps({ executor }),
    );
    expect(structured(retry)['output']).toEqual({ status: 'skipped' });
    expect(executor.calls).toEqual([]);
  });
});

describe('blob verification on retry (R21, S3, S4)', () => {
  it('rejects a tampered blob without executing anything', async () => {
    const first = await executeMachine({ code: WRITE_MACHINE }, deps());
    if (!isSuspended(first)) throw new Error('expected suspension');

    const parts = sealedState(first).split('.');
    // Flip a character in the ciphertext.
    const ciphertext = parts[3] as string;
    parts[3] = (ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.slice(1);
    const executor = new FakeExecutor();

    const retry = await executeMachine(
      {
        code: WRITE_MACHINE,
        requestState: parts.join('.'),
        inputResponses: { w1: ACCEPT },
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
        requestState: sealedState(first),
        inputResponses: { w1: ACCEPT },
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
        requestState: sealedState(first),
        inputResponses: { w1: ACCEPT },
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
        requestState: sealedState(first),
        inputResponses: { w1: ACCEPT },
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
        requestState: sealedState(first),
        inputResponses: { w1: ACCEPT },
      },
      deps({ executor, blob: { key: newKey, previousKeys: [oldKey] } }),
    );

    expect(structured(retry)['output']).toEqual({ status: 'written' });
    expect(executor.calls).toHaveLength(1);
  });
});

describe('down-negotiation (R28)', () => {
  it('runs read-only machines on a pre-MRTR client', async () => {
    const result = await executeMachine({ code: READ_MACHINE }, deps({ protocolEra: 'legacy' }));
    expect(structured(result)['output']).toEqual({
      text: 'read_file-ok',
    });
  });

  it('fails fast naming the required revision when a gated call would suspend', async () => {
    const executor = new FakeExecutor();
    const result = await executeMachine(
      { code: WRITE_MACHINE },
      deps({ executor, protocolEra: 'legacy' }),
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

  it('rejects oversized input before executing anything', async () => {
    const executor = new FakeExecutor();
    const input = { padding: 'x'.repeat(2000) };
    const result = await executeMachine(
      { code: READ_MACHINE, input },
      deps({ executor, caps: { maxInputBytes: 1024 } }),
    );
    const error = structuredError(result);
    expect(error.phase).toBe('cap_exceeded');
    expect(error.message).toContain('submitted input');
    expect(error.message).toContain('1024');
    expect(error.hint.length).toBeGreaterThan(0);
    expect(executor.calls).toEqual([]);
  });

  it('rejects circular input with a structured validate error', async () => {
    const executor = new FakeExecutor();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const result = await executeMachine(
      { code: READ_MACHINE, input: circular },
      deps({ executor }),
    );
    const error = structuredError(result);
    expect(error.phase).toBe('validate');
    expect(error.message).toContain('not JSON-serializable');
    expect(error.hint.length).toBeGreaterThan(0);
    expect(executor.calls).toEqual([]);
  });

  it('accepts input under the cap', async () => {
    const result = await executeMachine(
      { code: READ_MACHINE, input: { padding: 'x'.repeat(100) } },
      deps({ caps: { maxInputBytes: 1024 } }),
    );
    expect(structured(result)['output']).toEqual({ text: 'read_file-ok' });
  });

  it('terminates a workflow that exceeds the round-trip cap (R18)', async () => {
    // A machine that needs two approvals, with the cap set to one.
    const twoWrites = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

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
        requestState: sealedState(first),
        inputResponses: { one: ACCEPT },
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
import { toolCall } from '@astral-mcp/tools';

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
    const message = elicitation(result, 'w1').message;
    expect(message).toContain('Write a file.');
    expect(message).toContain('"path": "/n"');
    expect(message).toContain('[redacted]');
    expect(message).not.toContain('sk-super-secret');
  });

  it('warns more strongly for a destructive tool (R14)', async () => {
    const code = `
import { setup } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

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
    // The 2026-07-28 elicitation has no `title` field, so the summary line
    // opens the message and the destructive warning follows it.
    const request = elicitation(result, 'd1');
    expect(request.message.split('\n')[0]).toContain('DESTRUCTIVE');
    expect(request.message).toContain('WARNING:');
  });
});
