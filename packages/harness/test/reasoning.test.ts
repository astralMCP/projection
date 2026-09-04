/**
 * Reasoning-loop mechanics under a deterministic scripted author (CI-safe):
 * self-heal feedback, attempt accounting, §10 metric math, and code
 * extraction. The live Anthropic-driven benchmark is in
 * `reasoning.live.test.ts` and skips without ANTHROPIC_API_KEY.
 */

import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { wrapMcpServer, type ProjectionFacade } from '@astral-mcp/projection';
import {
  buildApiDocs,
  createFileServer,
  createScriptedAuthor,
  extractModuleSource,
  runReasoningTask,
  summarizeSelfHeal,
  type AuthoringContext,
  type MachineAuthor,
  type ReasoningResult,
} from '../src/index.js';

const INVALID_MODULE = `export default { not: 'a machine' };`;

const READ_NOTES = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'readNotes',
  context: { text: null },
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('read_file', () => ({ path: '/notes.txt' })),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ text: ({ event }) => event.result }) },
        TOOL_ERROR: 'done',
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ text: context.text }),
});
`;

const WRITE_OUT = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

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
  facade: ProjectionFacade;
  recording: ReturnType<typeof createFileServer>;
  apiDocs: string;
}> {
  const recording = createFileServer({ '/notes.txt': 'benchmark notes' });
  const facade = await wrapMcpServer(recording.server, { blob: { key: randomBytes(32) } });
  closers.push(() => facade.close());
  return { facade, recording, apiDocs: buildApiDocs(facade) };
}

describe('runReasoningTask (PRD §13 reasoning loop)', () => {
  it('a first-attempt valid machine records attemptsToValid = 1 and succeeds', async () => {
    const { facade, recording, apiDocs } = await setup();
    const author = createScriptedAuthor('scripted', [READ_NOTES]);
    const result = await runReasoningTask(
      facade,
      recording,
      author,
      {
        name: 'read',
        prompt: 'Read /notes.txt.',
        expect: (r) => r.sideEffects.some((e) => e.tool === 'read_file'),
      },
      apiDocs,
    );
    expect(result.attempts).toHaveLength(1);
    expect(result.attemptsToValid).toBe(1);
    expect(result.succeeded).toBe(true);
    expect(result.attempts[0]?.machineValid).toBe(true);
  });

  it('feeds the structured error back and self-heals on attempt 2 (G5)', async () => {
    const { facade, recording, apiDocs } = await setup();
    const contexts: AuthoringContext[] = [];
    const scripted = createScriptedAuthor('scripted', [INVALID_MODULE, READ_NOTES]);
    const probe: MachineAuthor = {
      name: scripted.name,
      author: (ctx) => {
        contexts.push(ctx);
        return scripted.author(ctx);
      },
    };
    const result = await runReasoningTask(
      facade,
      recording,
      probe,
      { name: 'heal', prompt: 'Read /notes.txt.' },
      apiDocs,
    );

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.machineValid).toBe(false);
    expect(result.attemptsToValid).toBe(2);
    expect(result.succeeded).toBe(true);

    // Attempt 2 saw the previous code and the structured error (R25).
    expect(contexts[0]?.previous).toBeUndefined();
    expect(contexts[1]?.previous?.code).toBe(INVALID_MODULE);
    expect(contexts[1]?.previous?.error.phase).toBe('validate');
    expect(contexts[1]?.previous?.error.hint.length).toBeGreaterThan(0);
    // Every attempt gets the same API docs a real client would read.
    expect(contexts[0]?.apiDocs).toContain('read_file');
    expect(contexts[0]?.apiDocs).toContain('authoring');
  });

  it('stops at maxAttempts when the author never heals', async () => {
    const { facade, recording, apiDocs } = await setup();
    const author = createScriptedAuthor('scripted', [INVALID_MODULE]);
    const result = await runReasoningTask(
      facade,
      recording,
      author,
      { name: 'stuck', prompt: 'Read /notes.txt.' },
      apiDocs,
      { maxAttempts: 2 },
    );
    expect(result.attempts).toHaveLength(2);
    expect(result.attemptsToValid).toBeUndefined();
    expect(result.succeeded).toBe(false);
  });

  it('drives an approval round trip inside an attempt', async () => {
    const { facade, recording, apiDocs } = await setup();
    const author = createScriptedAuthor('scripted', [WRITE_OUT]);
    const result = await runReasoningTask(
      facade,
      recording,
      author,
      {
        name: 'write',
        prompt: 'Write to /out.txt.',
        expect: (r) => r.rounds === 1 && r.sideEffects.some((e) => e.tool === 'write_file'),
      },
      apiDocs,
    );
    expect(result.succeeded).toBe(true);
    expect(recording.files['/out.txt']).toBe('hi');
  });
});

describe('buildApiDocs', () => {
  it('includes the authoring contract but filters ui:// app resources (D5)', async () => {
    const { apiDocs } = await setup();
    // The authoring docs a model reads must still be complete...
    expect(apiDocs).toContain('authoring');
    expect(apiDocs).toContain('read_file');
    // ...but the MCP Apps dashboard is a host-render surface, not API docs:
    // its URI and its script must never land in an authoring prompt.
    expect(apiDocs).not.toContain('ui://projection/dashboard.html');
    expect(apiDocs).not.toContain('ui/initialize');
  });
});

describe('summarizeSelfHeal (§10 metrics)', () => {
  function fake(
    attemptsToValid: number | undefined,
    attempts: number,
    ok: boolean,
  ): ReasoningResult {
    return {
      task: 't',
      author: 'a',
      attempts: Array.from({ length: attempts }, (_, i) => ({
        attempt: i + 1,
        code: '',
        result: {
          scenario: 't',
          status: 'error',
          rounds: 0,
          sideEffects: [],
          roundRecords: [],
          maxBlobBytes: 0,
        },
        machineValid: attemptsToValid !== undefined && i + 1 >= attemptsToValid,
      })),
      attemptsToValid,
      succeeded: ok,
    };
  }

  it('computes the first-attempt and <=2-attempt rates', () => {
    const summary = summarizeSelfHeal([
      fake(1, 1, true), // valid immediately
      fake(2, 2, true), // healed on 2nd
      fake(3, 3, false), // healed on 3rd
      fake(undefined, 3, false), // never valid
    ]);
    expect(summary.tasks).toBe(4);
    expect(summary.firstAttemptValidRate).toBeCloseTo(0.25);
    expect(summary.withinTwoAttemptsValidRate).toBeCloseTo(0.5);
    expect(summary.successRate).toBeCloseTo(0.5);
    expect(summary.meanAttempts).toBeCloseTo(2.25);
  });

  it('is all zeros on an empty batch', () => {
    expect(summarizeSelfHeal([]).tasks).toBe(0);
  });
});

describe('extractModuleSource', () => {
  it('takes the last fenced code block', () => {
    const reply =
      'Here is an example:\n```ts\nconst a = 1;\n```\nAnd my answer:\n```ts\nexport default 2;\n```\nDone.';
    expect(extractModuleSource(reply)).toBe('export default 2;');
  });

  it('accepts unfenced replies verbatim', () => {
    expect(extractModuleSource('  export default 3;\n')).toBe('export default 3;');
  });

  it('ignores inline ``` in prose (fences must start a line)', () => {
    const reply = 'Use ``` to fence.\nLike ```\nso:\n```ts\nexport default 1;\n```\n';
    expect(extractModuleSource(reply)).toBe('export default 1;');
  });

  it('accepts any info-string tag, not just ts/js', () => {
    const reply = '```tsx\nexport default 4;\n```';
    expect(extractModuleSource(reply)).toBe('export default 4;');
  });
});

describe('runReasoningTask input validation', () => {
  it('rejects a non-positive maxAttempts up front', async () => {
    const { facade, recording, apiDocs } = await setup();
    const author = createScriptedAuthor('scripted', [READ_NOTES]);
    await expect(
      runReasoningTask(facade, recording, author, { name: 'x', prompt: 'x' }, apiDocs, {
        maxAttempts: 0,
      }),
    ).rejects.toThrow(/positive integer/);
  });
});
