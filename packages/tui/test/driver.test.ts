/**
 * Interactive driver mechanics, headless: pause-on-suspension, verdict
 * plumbing, self-heal, and the R18/R23 numbers surfaced per suspension.
 */

import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { wrapMcpServer, type InputResponse, type McCircuitFacade } from 'mccircuit';
import {
  buildApiDocs,
  createFileServer,
  createScriptedAuthor,
  type MachineAuthor,
} from '@mccircuit/harness';
import { driveTask, type DriveState, type SuspensionInfo } from '../src/driver.js';

const INVALID_MODULE = `export default { not: 'a machine' };`;

const WRITE_OUT = `
import { setup, assign } from 'xstate';
import { toolCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'writeOut',
  context: { status: 'pending' },
  initial: 'writing',
  states: {
    writing: {
      entry: toolCall('write_file', () => ({ path: '/out.txt', content: 'hi' })),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: 'written' }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'declined' }) },
        TOOL_ERROR: { target: 'done', actions: assign({ status: 'error' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status }),
});
`;

/**
 * Two sequential gated writes → two suspensions (one round trip each).
 * Exercises the maxRounds cap.
 */
const TWO_WRITES = `
import { setup } from 'xstate';
import { toolCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'twoWrites',
  context: {},
  initial: 'first',
  states: {
    first: {
      entry: toolCall('write_file', () => ({ path: '/one.txt', content: '1' })),
      on: { TOOL_RESULT: 'second', TOOL_DENIED: 'second', TOOL_ERROR: 'second' },
    },
    second: {
      entry: toolCall('write_file', () => ({ path: '/two.txt', content: '2' })),
      on: { TOOL_RESULT: 'done', TOOL_DENIED: 'done', TOOL_ERROR: 'done' },
    },
    done: { type: 'final' },
  },
  output: () => ({ ok: true }),
});
`;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

async function setup(): Promise<{
  facade: McCircuitFacade;
  recording: ReturnType<typeof createFileServer>;
  apiDocs: string;
}> {
  const recording = createFileServer({ '/notes.txt': 'demo' });
  const facade = await wrapMcpServer(recording.server, { blob: { key: randomBytes(32) } });
  closers.push(() => facade.close());
  return { facade, recording, apiDocs: buildApiDocs(facade) };
}

function approveAll(info: SuspensionInfo): Promise<Record<string, InputResponse>> {
  return Promise.resolve(
    Object.fromEntries(info.prompts.map((p) => [p.key, { action: 'accept' as const }])),
  );
}

describe('driveTask', () => {
  it('pauses on a gated write, surfaces trip/blob numbers, and resumes on approval', async () => {
    const { facade, recording, apiDocs } = await setup();
    const author = createScriptedAuthor('scripted', [WRITE_OUT]);
    const suspensions: SuspensionInfo[] = [];
    const phases: DriveState['phase'][] = [];

    const final = await driveTask(facade, author, 'write /out.txt', apiDocs, {
      onUpdate: (state) => phases.push(state.phase),
      approve: (info) => {
        suspensions.push(info);
        // The side effect must not have run before approval (S2).
        expect(recording.files['/out.txt']).toBeUndefined();
        return approveAll(info);
      },
    });

    expect(final.phase).toBe('completed');
    expect(final.output).toEqual({ status: 'written' });
    expect(recording.files['/out.txt']).toBe('hi');

    expect(suspensions).toHaveLength(1);
    expect(suspensions[0]?.trip).toBe(1);
    expect(suspensions[0]?.blobBytes).toBeGreaterThan(0);
    expect(suspensions[0]?.prompts[0]?.message).toContain('write_file');
    expect(phases).toContain('awaiting_approval');
  });

  it('declined verdicts flow through and the machine takes its fallback path', async () => {
    const { facade, recording, apiDocs } = await setup();
    const author = createScriptedAuthor('scripted', [WRITE_OUT]);

    const final = await driveTask(facade, author, 'write /out.txt', apiDocs, {
      onUpdate: () => undefined,
      approve: (info) =>
        Promise.resolve(
          Object.fromEntries(info.prompts.map((p) => [p.key, { action: 'decline' as const }])),
        ),
    });

    expect(final.phase).toBe('completed');
    expect(final.output).toEqual({ status: 'declined' });
    expect(recording.files['/out.txt']).toBeUndefined();
  });

  it('self-heals: a validate error is fed back and attempt 2 completes', async () => {
    const { facade, apiDocs } = await setup();
    const author = createScriptedAuthor('scripted', [INVALID_MODULE, WRITE_OUT]);
    const phases: DriveState['phase'][] = [];

    const final = await driveTask(facade, author, 'write /out.txt', apiDocs, {
      onUpdate: (state) => phases.push(state.phase),
      approve: approveAll,
    });

    expect(phases).toContain('healing');
    expect(final.phase).toBe('completed');
    expect(final.attempt).toBe(2);
  });

  it('fails with the last structured error when the author never heals', async () => {
    const { facade, apiDocs } = await setup();
    const author = createScriptedAuthor('scripted', [INVALID_MODULE]);

    const final = await driveTask(
      facade,
      author,
      'anything',
      apiDocs,
      { onUpdate: () => undefined, approve: approveAll },
      { maxAttempts: 2 },
    );

    expect(final.phase).toBe('failed');
    expect(final.attempt).toBe(2);
    expect(final.error?.phase).toBe('validate');
    expect(final.error?.hint.length).toBeGreaterThan(0);
  });

  it('an author throw resolves to a failed state instead of rejecting (no self-heal)', async () => {
    const { facade, apiDocs } = await setup();
    let calls = 0;
    const author: MachineAuthor = {
      name: 'throwing',
      author: () => {
        calls += 1;
        return Promise.reject(new Error('401 invalid x-api-key'));
      },
    };

    // Must RESOLVE — an SDK failure surfaces as state, never as an
    // unhandled rejection that crashes the CLI mid-render.
    const final = await driveTask(facade, author, 'anything', apiDocs, {
      onUpdate: () => undefined,
      approve: approveAll,
    });

    expect(final.phase).toBe('failed');
    expect(final.error?.phase).toBe('author');
    expect(final.error?.message).toContain('401 invalid x-api-key');
    expect(final.error?.hint).toContain('ANTHROPIC_API_KEY');
    // Not retried through the self-heal loop: one call, one failure.
    expect(calls).toBe(1);
  });

  it('an omitted verdict key is a decline (R17): the machine takes TOOL_DENIED', async () => {
    const { facade, recording, apiDocs } = await setup();
    const author = createScriptedAuthor('scripted', [WRITE_OUT]);

    const final = await driveTask(facade, author, 'write /out.txt', apiDocs, {
      onUpdate: () => undefined,
      // The "i" (ignore) key omits the key entirely — the server must treat
      // absence as a decline.
      approve: () => Promise.resolve({}),
    });

    expect(final.phase).toBe('completed');
    expect(final.output).toEqual({ status: 'declined' });
    expect(recording.files['/out.txt']).toBeUndefined();
  });

  it('aborts at maxRounds WITHOUT prompting for the over-cap round', async () => {
    const { facade, apiDocs } = await setup();
    const author = createScriptedAuthor('scripted', [TWO_WRITES]);
    let approvals = 0;

    const final = await driveTask(
      facade,
      author,
      'write both files',
      apiDocs,
      {
        onUpdate: () => undefined,
        approve: (info) => {
          approvals += 1;
          return approveAll(info);
        },
      },
      { maxRounds: 1 },
    );

    // The second suspension would exceed the cap — the user is never asked
    // for a verdict that could not be resumed.
    expect(approvals).toBe(1);
    expect(final.phase).toBe('failed');
    expect(final.error?.message).toBe('aborted after 1 round trips');
  });
});
