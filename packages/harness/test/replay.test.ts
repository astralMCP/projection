/**
 * Demonstrates the D4 known limitation: because the design is stateless, a
 * captured approved retry replayed within the blob TTL re-executes the
 * gated call. The harness makes this observable so a future replay-cache
 * fix has a regression to flip.
 */

import {
  isInputRequiredResult,
  wrapMcpServer,
  type InputRequiredResult,
} from '@astral-mcp/projection';
import { describe, expect, it } from 'vitest';
import { createFileServer } from '../src/index.js';

const KEY = new Uint8Array(32).fill(17);

const WRITE_ONCE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'w',
  context: { n: 0 },
  initial: 'writing',
  states: {
    writing: {
      entry: toolCall('write_file', () => ({ path: '/counter', content: 'tick' }), { id: 'w1' }),
      on: { TOOL_RESULT: { target: 'done', actions: assign({ n: 1 }) }, TOOL_DENIED: 'done' },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ n: context.n }),
});
`;

describe('D4: in-TTL replay re-executes the gated call', () => {
  it('the same approved requestState, replayed, writes twice', async () => {
    const file = createFileServer();
    const facade = await wrapMcpServer(file.server, { blob: { key: KEY } });

    // First run to a suspension, capturing the sealed state.
    const first = await facade.executeMachine({ code: WRITE_ONCE }, 'modern');
    if (!isInputRequiredResult(first)) throw new Error('expected suspension');
    const state = (first as InputRequiredResult).requestState;
    if (state === undefined) throw new Error('no requestState');

    const accept = {
      code: WRITE_ONCE,
      requestState: state,
      inputResponses: { w1: { action: 'accept' as const } },
    };

    await facade.executeMachine(accept, 'modern');
    await facade.executeMachine(accept, 'modern');

    // Two executions of the same approved blob → two side effects. This is
    // the documented stateless-replay limitation, not a regression: if a
    // replay cache is added, this expectation flips to 1.
    expect(file.calls.filter((c) => c.tool === 'write_file')).toHaveLength(2);
  });
});
