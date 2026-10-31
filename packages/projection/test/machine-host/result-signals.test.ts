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
