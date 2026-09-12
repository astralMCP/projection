/**
 * Legacy-client compatibility (R28 amendment, DECISIONS D6): with
 * `compat.legacyElicitation` opted in, a pre-2026-07-28 client receives
 * approval suspensions through the SDK's server→client `elicitation/create`
 * shim — the old streaming-elicitation style clients like Cursor speak
 * today — and the shim's re-invocation carries the same `requestState` echo
 * and `inputResponses` as a real MRTR retry, so every sealing invariant
 * (S2–S4, audit, R17) runs unchanged.
 *
 * Nothing here is faked: the client is a real legacy-era SDK `Client` (no
 * `versionNegotiation`, so the pre-MRTR handshake) with a real
 * `elicitation/create` request handler standing in for the human. The shim
 * paths run over a HELD connection (InMemory pair — the stdio shape); the
 * per-request HTTP path is asserted to fail cleanly, since stateless legacy
 * serving has no channel for server→client requests.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  createMcpHandler,
  InMemoryTransport,
  McpServer,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { wrapMcpServer, type ProjectionFacade, type WrapOptions } from '../../src/index.js';

const KEY = new Uint8Array(32).fill(23);
const ENDPOINT = new URL('http://legacy.projection.test/mcp');

const GATED_MACHINE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'write',
  context: { status: 'pending' },
  initial: 'writing',
  states: {
    writing: {
      entry: toolCall('write_file', () => ({ path: '/notes.txt', content: 'via legacy shim' }), { id: 'w1' }),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: ({ event }) => event.result }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'skipped' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status }),
});
`;

let files: Record<string, string>;
let facade: ProjectionFacade | undefined;
let client: Client | undefined;

function buildWrappedServer(): McpServer {
  const server = new McpServer({ name: 'legacy-files', version: '1.0.0' });
  server.registerTool(
    'write_file',
    {
      description: 'Write content to a file.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
    },
    ({ path, content }) => {
      files[path] = content;
      return { content: [{ type: 'text' as const, text: `wrote ${content.length} bytes` }] };
    },
  );
  return server;
}

async function serve(options?: Partial<WrapOptions>): Promise<McpHttpHandler> {
  facade = await wrapMcpServer(buildWrappedServer(), { blob: { key: KEY }, ...options });
  return createMcpHandler(facade.serverFactory);
}

/** A LEGACY client: no versionNegotiation, so the pre-MRTR handshake. */
async function connectLegacy(
  handler: McpHttpHandler,
  onElicit?: (message: string) => { action: 'accept' | 'decline' },
): Promise<Client> {
  client = new Client(
    { name: 'legacy-client', version: '1.0.0' },
    { capabilities: onElicit !== undefined ? { elicitation: {} } : {} },
  );
  if (onElicit !== undefined) {
    client.setRequestHandler('elicitation/create', (request) => {
      const verdict = onElicit((request.params as { message: string }).message);
      return verdict.action === 'accept'
        ? { action: 'accept', content: {} }
        : { action: 'decline' };
    });
  }
  await client.connect(
    new StreamableHTTPClientTransport(ENDPOINT, {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  return client;
}

/**
 * A HELD legacy connection — the stdio shape (what Cursor uses): the
 * facade-built server (legacy by construction) over an in-memory linked
 * pair. The SDK's elicitation shim needs this: per-request HTTP legacy
 * serving has no channel for server→client requests.
 */
async function connectHeldLegacy(
  options: Partial<WrapOptions>,
  onElicit: (message: string) => { action: 'accept' | 'decline' },
): Promise<Client> {
  facade = await wrapMcpServer(buildWrappedServer(), { blob: { key: KEY }, ...options });
  const served = facade.createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client(
    { name: 'legacy-client', version: '1.0.0' },
    { capabilities: { elicitation: {} } },
  );
  client.setRequestHandler('elicitation/create', (request) => {
    const verdict = onElicit((request.params as { message: string }).message);
    return verdict.action === 'accept' ? { action: 'accept', content: {} } : { action: 'decline' };
  });
  await served.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function machineOutput(result: { structuredContent?: unknown }): unknown {
  return (result.structuredContent as Record<string, unknown> | undefined)?.['output'];
}

beforeEach(() => {
  files = { '/notes.txt': 'original notes' };
});

afterEach(async () => {
  await client?.close();
  await facade?.close();
  client = undefined;
  facade = undefined;
});

describe('legacy elicitation compat (R28 amendment, D6)', () => {
  it('default posture unchanged: without the opt-in, a legacy gated call fails fast', async () => {
    const handler = await serve();
    const legacy = await connectLegacy(handler, () => ({ action: 'accept' }));

    const result = (await legacy.callTool({
      name: 'execute_machine',
      arguments: { code: GATED_MACHINE },
    })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.['phase']).toBe('protocol');
    expect(String(result.structuredContent?.['message'])).toContain('2026-07-28');
    // Nothing executed (S2).
    expect(files['/notes.txt']).toBe('original notes');
  });

  it('opt-in over a HELD connection (the stdio shape): elicitation/create reaches the client and an accept executes the write', async () => {
    const prompts: string[] = [];
    const legacy = await connectHeldLegacy({ compat: { legacyElicitation: true } }, (message) => {
      prompts.push(message);
      // S2 asserted at the human moment: nothing has executed yet.
      expect(files['/notes.txt']).toBe('original notes');
      return { action: 'accept' };
    });

    // ONE callTool from the client's point of view: the SDK shim converts
    // the suspension into a server→client elicitation and retries with the
    // requestState echo + collected inputResponses internally.
    const result = (await legacy.callTool({
      name: 'execute_machine',
      arguments: { code: GATED_MACHINE },
    })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };

    expect(result.isError).toBeUndefined();
    expect(machineOutput(result)).toEqual({ status: 'wrote 15 bytes' });
    expect(files['/notes.txt']).toBe('via legacy shim');

    // The prompt is the same server-derived copy (S6) MRTR clients see.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('write_file');
    expect(prompts[0]).toContain('/notes.txt');

    // The audit trail survived the shim round trip exactly like MRTR.
    const approvals = result.structuredContent?.['approvals'] as {
      decision: string;
      tool: string;
    }[];
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ tool: 'write_file', decision: 'approved' });
  });

  it('opt-in over a held connection: a decline takes the TOOL_DENIED path and nothing executes', async () => {
    const legacy = await connectHeldLegacy({ compat: { legacyElicitation: true } }, () => ({
      action: 'decline',
    }));

    const result = (await legacy.callTool({
      name: 'execute_machine',
      arguments: { code: GATED_MACHINE },
    })) as {
      structuredContent?: Record<string, unknown>;
    };

    expect(machineOutput(result)).toEqual({ status: 'skipped' });
    expect(files['/notes.txt']).toBe('original notes');
  });

  it('opt-in over per-request HTTP legacy: the shim has no channel, fails cleanly, nothing executes', async () => {
    // createMcpHandler serves legacy connections PER-REQUEST: there is no
    // stream to push elicitation/create down, so the SDK refuses with a
    // named error. The compat option only helps held connections (stdio).
    const handler = await serve({ compat: { legacyElicitation: true } });
    const legacy = await connectLegacy(handler, () => ({ action: 'accept' }));

    const result = (await legacy.callTool({
      name: 'execute_machine',
      arguments: { code: GATED_MACHINE },
    })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain('per-request legacy serving');
    // The invariant that matters (S2): the gated write never ran.
    expect(files['/notes.txt']).toBe('original notes');
  });

  it('modern-era behavior is untouched by the opt-in', async () => {
    const handler = await serve({ compat: { legacyElicitation: true } });
    client = new Client(
      { name: 'modern-client', version: '1.0.0' },
      {
        capabilities: { elicitation: {} },
        versionNegotiation: { mode: { pin: '2026-07-28' } },
        inputRequired: { autoFulfill: false },
      },
    );
    await client.connect(
      new StreamableHTTPClientTransport(ENDPOINT, {
        fetch: (url, init) => handler.fetch(new Request(url, init)),
      }),
    );

    const suspended = (await client.request(
      {
        method: 'tools/call',
        params: { name: 'execute_machine', arguments: { code: GATED_MACHINE } },
      },
      { allowInputRequired: true },
    )) as { resultType?: string };
    expect(suspended.resultType).toBe('input_required');
    expect(files['/notes.txt']).toBe('original notes');
  });
});
