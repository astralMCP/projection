/**
 * What a machine and the model learn about a tool's result beyond its value
 * (D29): result notes on TOOL_RESULT and after a completed run.
 */

import { describe, expect, it } from 'vitest';
import { runSegment } from '../../src/machine-host/index.js';
import { executeMachine } from '../../src/mrtr/index.js';
import { generateToolTypes } from '../../src/typegen/index.js';
import type { ServerCatalog } from '../../src/types.js';
import { completed, structured } from '../mrtr/helpers.js';
import { entry, FakeExecutor } from './fixtures.js';

const ESC = String.fromCharCode(0x1b);
const KEY = new Uint8Array(32).fill(7);

const CATALOG: ServerCatalog = {
  alias: 'default',
  identity: 'docs@1.0.0',
  tools: [
    entry({
      name: 'find',
      description: 'Find documents.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'integer', default: 3 } },
      },
    }),
  ],
};
const OPTIONS = { catalog: CATALOG, bridgeSource: generateToolTypes(CATALOG).bridgeSource };

/** Counts what `find` returned and keeps the notes the event carried. */
const COUNT_MACHINE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'count',
  context: { n: null, notes: null },
  initial: 'finding',
  states: {
    finding: {
      entry: toolCall('find', () => ({ query: 'q' })),
      on: {
        TOOL_RESULT: {
          target: 'done',
          actions: assign({
            n: ({ event }) => event.result.docs.length,
            notes: ({ event }) => event.notes ?? null,
          }),
        },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ n: context.n }),
});
`;

const PARTIAL = {
  ok: true as const,
  result: { total: 9, docs: [{ id: 1 }, { id: 2 }, { id: 3 }] },
  serverNote: `Returning 3 of 9.${ESC}`,
};

describe('result notes reach the machine and the model (R35.6, D29)', () => {
  it('TOOL_RESULT carries notes, and the completed segment lists them by tool', async () => {
    const machine = COUNT_MACHINE.replace(
      'output: ({ context }) => ({ n: context.n })',
      'output: ({ context }) => ({ n: context.n, notes: context.notes })',
    );
    const outcome = await runSegment({
      ...OPTIONS,
      code: machine,
      executor: new FakeExecutor({ find: PARTIAL }),
    });
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    const partial =
      'Partial result: "docs" holds 3 of 9 (per "total"). Narrow the query, raise the limit or fetch the next page before treating these as all of them.';
    const server = 'Note from the server, beside its structured result: "Returning 3 of 9.�"';
    expect(outcome.output).toEqual({ n: 3, notes: [partial, server] });
    expect(outcome.notes).toEqual([`"find": ${partial}`, `"find": ${server}`]);
  });

  it('execute_machine restates the notes after the output, even when the machine drops them', async () => {
    const result = completed(
      await executeMachine(
        { code: COUNT_MACHINE },
        {
          ...OPTIONS,
          executor: new FakeExecutor({ find: PARTIAL }),
          blob: { key: KEY },
          protocolEra: 'modern',
        },
      ),
    );
    expect(result.isError).toBeUndefined();
    const texts = result.content.map((block) => (block as { text?: string }).text ?? '');
    expect(texts[0]).toBe(JSON.stringify({ n: 3 }, null, 2));
    expect(texts[1]?.split('\n')).toEqual([
      'Notes on the tool results this run read (added by this server, not by the machine; check that the output above accounts for them):',
      '- "find": Partial result: "docs" holds 3 of 9 (per "total"). Narrow the query, raise the limit or fetch the next page before treating these as all of them.',
      '- "find": Note from the server, beside its structured result: "Returning 3 of 9.�"',
    ]);
    expect(structured(result)['notes']).toHaveLength(2);
  });

  it('a result with nothing to note adds no notes anywhere', async () => {
    const result = completed(
      await executeMachine(
        { code: COUNT_MACHINE },
        {
          ...OPTIONS,
          executor: new FakeExecutor({
            find: { ok: true, result: { total: 2, docs: [{ id: 1 }, { id: 2 }] } },
          }),
          blob: { key: KEY },
          protocolEra: 'modern',
        },
      ),
    );
    expect(result.content).toHaveLength(1);
    expect(structured(result)).not.toHaveProperty('notes');
  });
});

/** Returns what the machine saw: the result's type, a loop over it, and event.text. */
const SHAPE_MACHINE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'shape',
  context: { seen: null },
  initial: 'finding',
  states: {
    finding: {
      entry: toolCall('find', () => ({ query: 'q' })),
      on: {
        TOOL_RESULT: {
          target: 'done',
          actions: assign({
            seen: ({ event }) => ({
              type: Array.isArray(event.result) ? 'array' : typeof event.result,
              ids: Array.isArray(event.result) ? event.result.map((d) => d.id) : null,
              text: event.text ?? null,
            }),
          }),
        },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => context.seen,
});
`;

async function seen(result: unknown, rawContent?: true): Promise<unknown> {
  const outcome = await runSegment({
    ...OPTIONS,
    code: SHAPE_MACHINE,
    executor: new FakeExecutor({
      find: { ok: true, result, ...(rawContent !== undefined ? { rawContent } : {}) },
    }),
  });
  expect(outcome.status).toBe('completed');
  return outcome.status === 'completed' ? outcome.output : undefined;
}

describe('JSON text results reach a machine parsed (D29)', () => {
  it('parses a single text block holding a JSON array, keeping the text on event.text', async () => {
    const text = '[{"id":1},{"id":2}]';
    expect(await seen(text)).toEqual({ type: 'array', ids: [1, 2], text });
    expect(await seen(' {"id":1} ')).toEqual({ type: 'object', ids: null, text: ' {"id":1} ' });
  });

  it('leaves plain text, JSON scalars, invalid JSON and raw content arrays as they are', async () => {
    expect(await seen('hello')).toEqual({ type: 'string', ids: null, text: null });
    expect(await seen('42')).toEqual({ type: 'string', ids: null, text: null });
    expect(await seen('[not json')).toEqual({ type: 'string', ids: null, text: null });
    expect(await seen({ id: 1 })).toEqual({ type: 'object', ids: null, text: null });
    const blocks = [{ type: 'text', text: '[{"id":9}]' }];
    expect(await seen(blocks, true)).toEqual({ type: 'array', ids: [undefined], text: null });
  });
});

describe('server data reaches a machine as data (S5)', () => {
  /** Reports what the machine sees of `find`'s result. */
  const PROTO_MACHINE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';
export default setup({}).createMachine({
  context: { o: null },
  initial: 'a',
  states: {
    a: { entry: toolCall('find', () => ({ query: 'q' })), on: { TOOL_RESULT: { target: 'done', actions: assign({ o: ({ event }) => ({
      approved: event.result.approved === true,
      ownKeys: Object.keys(event.result),
      type: typeof event.result,
    }) }) } } },
    done: { type: 'final' },
  },
  output: ({ context }) => context.o,
});
`;
  const run = async (result: unknown): Promise<unknown> => {
    const outcome = await runSegment({
      ...OPTIONS,
      code: PROTO_MACHINE,
      executor: new FakeExecutor({ find: { ok: true, result } }),
    });
    expect(outcome.status).toBe('completed');
    return outcome.status === 'completed' ? outcome.output : outcome;
  };

  it('keeps a __proto__ key an own key, not the prototype, in JSON text and in structured results', async () => {
    const expected = { approved: false, ownKeys: ['__proto__', 'items'], type: 'object' };
    expect(await run('{"__proto__": {"approved": true}, "items": []}')).toEqual(expected);
    expect(await run(JSON.parse('{"__proto__": {"approved": true}, "items": []}'))).toEqual(
      expected,
    );
  });

  it('hands JSON text nested past the parse depth on as the string it is', async () => {
    const deep = '['.repeat(1_000) + ']'.repeat(1_000);
    expect(await run(deep)).toEqual({
      approved: false,
      ownKeys: expect.any(Array),
      type: 'string',
    });
  });
});

describe('the call cap says what the calls did (D29)', () => {
  const LOOP = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'loop',
  context: { n: 0 },
  initial: 'finding',
  states: {
    finding: {
      entry: toolCall('find', ({ context }) => ({ query: 'q' + context.n })),
      on: {
        TOOL_RESULT: { target: 'finding', reenter: true, actions: assign({ n: ({ context }) => context.n + 1 }) },
        TOOL_ERROR: { target: 'finding', reenter: true, actions: assign({ n: ({ context }) => context.n + 1 }) },
      },
    },
  },
});
`;

  it('breaks the calls down by tool, with the first error inert and capped', async () => {
    const outcome = await runSegment({
      ...OPTIONS,
      code: LOOP,
      caps: { maxReadCallsPerSegment: 4 },
      executor: new FakeExecutor({
        find: { ok: false, error: { message: `limit must be <= 5${ESC}[31m\n${'x'.repeat(400)}` } },
      }),
    });
    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') return;
    expect(outcome.error.phase).toBe('cap_exceeded');
    const message = outcome.error.message;
    expect(message).toMatch(
      /^the machine made more than 4 tool calls that run without approval in one segment — so far: 4 calls to "find" \(all failed, first error: "limit must be <= 5�\[31m�x+…"\)$/,
    );
    expect(message).not.toContain(ESC);
    expect(message.length).toBeLessThan(400);
    expect(outcome.error.hint).toContain(
      'Every call to "find" failed, so repeating it will not get further',
    );
  });

  it('reports succeeding calls without blaming them', async () => {
    const outcome = await runSegment({
      ...OPTIONS,
      code: LOOP,
      caps: { maxReadCallsPerSegment: 3 },
      executor: new FakeExecutor({ find: { ok: true, result: { docs: [] } } }),
    });
    expect(outcome.status).toBe('error');
    if (outcome.status !== 'error') return;
    expect(outcome.error.message).toContain('— so far: 3 calls to "find" (all succeeded)');
    expect(outcome.error.hint).not.toContain('Every call');
  });
});
