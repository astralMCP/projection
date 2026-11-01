/**
 * Batched approval prompts through a real SDK `Client` (D25): a client that
 * applies form defaults (`elicitation.form.applyDefaults`) to an empty
 * accept must not approve anything, and ticked boxes run exactly those
 * calls. Uses the legacy-elicitation shim so the in-memory client answers
 * the prompts the same way a host would.
 */

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { wrapMcpServer } from '../../src/index.js';

const MACHINE = `
import { setup, assign } from 'xstate';
import { toolCall, whenCall } from '@astral-mcp/tools';
const region = (id, path) => ({
  initial: 'go',
  states: {
    go: {
      entry: toolCall('write_file', () => ({ path, content: id }), { id }),
      on: {
        TOOL_RESULT: { guard: whenCall(id), target: 'done', actions: assign({ [id]: 'ran' }) },
        TOOL_DENIED: { guard: whenCall(id), target: 'done', actions: assign({ [id]: 'refused' }) },
      },
    },
    done: { type: 'final' },
  },
});
export default setup({}).createMachine({
  context: { a: 'pending', b: 'pending' },
  type: 'parallel',
  states: { ra: region('a', '/a'), rb: region('b', '/b') },
  output: ({ context }) => context,
});
`;

async function run(
  applyDefaults: boolean,
  answer: (params: { requestedSchema?: unknown }) => {
    action: 'accept';
    content: Record<string, boolean>;
  },
): Promise<{ output: unknown; files: Record<string, string>; prompts: number }> {
  const files: Record<string, string> = {};
  const upstream = new McpServer({ name: 'up', version: '1' });
  upstream.registerTool(
    'write_file',
    {
      description: 'Write.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
    },
    ({ path, content }) => {
      files[path] = content;
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    },
  );
  const facade = await wrapMcpServer(upstream, {
    blob: { key: new Uint8Array(32).fill(3) },
    compat: { legacyElicitation: true },
    approvalPrompts: 'batched',
  });
  const served = facade.createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'c', version: '1' },
    { capabilities: { elicitation: { form: { applyDefaults } } } },
  );
  let prompts = 0;
  client.setRequestHandler('elicitation/create', (request) => {
    prompts += 1;
    return answer(request.params as { requestedSchema?: unknown });
  });
  try {
    await served.connect(serverTransport);
    await client.connect(clientTransport);
    const result = (await client.callTool({
      name: 'execute_machine',
      arguments: { code: MACHINE },
    })) as { structuredContent?: { output?: unknown } };
    return { output: result.structuredContent?.output, files, prompts };
  } finally {
    await client.close();
    await facade.close();
  }
}

describe('batched prompts over a real client', () => {
  for (const applyDefaults of [false, true]) {
    it(`an empty accept approves nothing (applyDefaults ${applyDefaults})`, async () => {
      const r = await run(applyDefaults, () => ({ action: 'accept', content: {} }));
      expect(r.prompts).toBe(1);
      expect(r.files).toEqual({});
      expect(r.output).toEqual({ a: 'refused', b: 'refused' });
    });
  }

  it('runs exactly the ticked call', async () => {
    const r = await run(true, () => ({ action: 'accept', content: { approve_2: true } }));
    expect(r.files).toEqual({ '/b': 'b' });
    expect(r.output).toEqual({ a: 'refused', b: 'ran' });
  });
});
