/**
 * The Ink surface, end to end with a scripted author: type a task, see the
 * authored code, approve the gated write with a single key, see the output
 * — plus the blob/trip numbers on the approval panel (PRD §13).
 */

import { randomBytes } from 'node:crypto';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wrapMcpServer, type McCircuitFacade } from 'mccircuit';
import { buildApiDocs, createFileServer, createScriptedAuthor } from '@mccircuit/harness';
import { App } from '../src/app.js';

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

async function waitForFrame(
  lastFrame: () => string | undefined,
  needle: string,
  timeoutMs = 15_000,
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(lastFrame() ?? '').toContain(needle);
    },
    { timeout: timeoutMs, interval: 25 },
  );
}

async function tick(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function submitTask(stdin: { write: (data: string) => void }, text: string): Promise<void> {
  // Let Ink attach its stdin listeners before typing (testing-library quirk).
  await tick();
  stdin.write(text);
  await tick();
  stdin.write('\r');
}

describe('App', () => {
  it(
    'runs a gated task: type, approve with "y", see output and numbers',
    { timeout: 30_000 },
    async () => {
      const { facade, recording, apiDocs } = await setup();
      const author = createScriptedAuthor('scripted-model', [WRITE_OUT]);
      const { lastFrame, stdin } = render(
        <App facade={facade} author={author} apiDocs={apiDocs} serverLabel="demo-files" />,
      );

      expect(lastFrame()).toContain('McCircuit TUI');
      expect(lastFrame()).toContain('demo-files');
      expect(lastFrame()).toContain('scripted-model');

      await submitTask(stdin, 'write hi to /out.txt');

      // Suspension: approval panel with trip count + blob size (PRD §13).
      await waitForFrame(lastFrame, '[y] approve');
      const frame = lastFrame() ?? '';
      expect(frame).toContain('round trip 1');
      expect(frame).toMatch(/blob \d+ bytes/);
      expect(frame).toContain('write_file');
      // Nothing executed before the verdict (S2).
      expect(recording.files['/out.txt']).toBeUndefined();

      stdin.write('y');

      await waitForFrame(lastFrame, '"status": "written"');
      expect(recording.files['/out.txt']).toBe('hi');
      expect(lastFrame()).toContain('completed');
    },
  );

  it('denies with "n" and the machine reports the fallback', { timeout: 30_000 }, async () => {
    const { facade, recording, apiDocs } = await setup();
    const author = createScriptedAuthor('scripted-model', [WRITE_OUT]);
    const { lastFrame, stdin } = render(
      <App facade={facade} author={author} apiDocs={apiDocs} serverLabel="demo-files" />,
    );

    await submitTask(stdin, 'write hi to /out.txt');
    await waitForFrame(lastFrame, '[y] approve');
    stdin.write('n');

    await waitForFrame(lastFrame, '"status": "declined"');
    expect(recording.files['/out.txt']).toBeUndefined();
  });

  it('ignores with "i": the omitted key is a decline (R17)', { timeout: 30_000 }, async () => {
    const { facade, recording, apiDocs } = await setup();
    const author = createScriptedAuthor('scripted-model', [WRITE_OUT]);
    const { lastFrame, stdin } = render(
      <App facade={facade} author={author} apiDocs={apiDocs} serverLabel="demo-files" />,
    );

    await submitTask(stdin, 'write hi to /out.txt');
    await waitForFrame(lastFrame, '[y] approve');
    stdin.write('i');

    await waitForFrame(lastFrame, '"status": "declined"');
    expect(recording.files['/out.txt']).toBeUndefined();
  });
});
