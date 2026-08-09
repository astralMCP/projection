/**
 * The code-mode surface driven by a REAL MCP `Client` over a real transport.
 *
 * This is the test whose absence hid a blocker: `registerOn` used to cast the
 * `execute_machine` handler through `as never` and read a
 * `extra.protocolVersion` field that does not exist, so `supportsMrtr()` was
 * always false and every gated call came back as a `protocol` error instead
 * of suspending. Every existing test called `facade.executeMachine` directly
 * and therefore never touched the registration path at all.
 *
 * Nothing here is faked: `createMcpHandler` serves the 2026-07-28 era, the
 * client negotiates it, and the transport's `fetch` is the handler itself, so
 * the whole exchange is real JSON-RPC over real HTTP semantics with no
 * network. (The SDK has no in-memory serving entry for the modern era —
 * `InMemoryTransport.createLinkedPair()` connects legacy instances only —
 * which is exactly why the wired path went untested before.)
 */

import {
  Client,
  isInputRequiredResult,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer, type McpHttpHandler } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { wrapMcpServer, type ProjectionFacade } from '../../src/index.js';
import { MRTR_PROTOCOL_REVISION } from '../../src/mrtr/index.js';

const KEY = new Uint8Array(32).fill(11);

/** The endpoint is never dialled — `handler.fetch` serves it in process. */
const ENDPOINT = new URL('http://@astral-mcp/projection.test/mcp');

const GATED_MACHINE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'write',
  context: { status: 'pending' },
  initial: 'writing',
  states: {
    writing: {
      entry: toolCall('write_file', () => ({ path: '/notes.txt', content: 'from the client' }), { id: 'w1' }),
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

const READ_ONLY_MACHINE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'read',
  context: { notes: null },
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('read_file', () => ({ path: '/notes.txt' })),
      on: { TOOL_RESULT: { target: 'done', actions: assign({ notes: ({ event }) => event.result }) } },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ notes: context.notes }),
});
`;

let files: Record<string, string>;

function buildWrappedServer(): McpServer {
  const server = new McpServer(
    { name: 'demo-files', version: '2.1.0' },
    { instructions: 'A tiny file server. Paths are absolute.' },
  );
  server.registerTool(
    'read_file',
    {
      description: 'Read a file from disk.',
      inputSchema: z.object({ path: z.string() }),
      annotations: { readOnlyHint: true },
    },
    ({ path }) => ({ content: [{ type: 'text' as const, text: files[path] ?? '' }] }),
  );
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

interface ConnectOptions {
  /** Omitted (the SDK default) means the legacy `initialize` handshake. */
  modern?: boolean;
  /** Register an `elicitation/create` handler so the SDK auto-fulfils. */
  onElicit?: (message: string) => {
    action: 'accept' | 'decline';
    content?: Record<string, string>;
  };
  /** Surface `input_required` to the caller instead of auto-fulfilling. */
  manual?: boolean;
}

async function connect(handler: McpHttpHandler, options: ConnectOptions = {}): Promise<Client> {
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    {
      capabilities: { elicitation: {} },
      ...(options.modern === true
        ? { versionNegotiation: { mode: { pin: MRTR_PROTOCOL_REVISION } } }
        : {}),
      ...(options.manual === true ? { inputRequired: { autoFulfill: false } } : {}),
    },
  );
  if (options.onElicit !== undefined) {
    const onElicit = options.onElicit;
    client.setRequestHandler('elicitation/create', (request) =>
      onElicit((request.params as { message: string }).message),
    );
  }
  await client.connect(
    new StreamableHTTPClientTransport(ENDPOINT, {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  return client;
}

/** The `output` a completed `execute_machine` reports. */
function machineOutput(result: { structuredContent?: unknown; content?: unknown }): unknown {
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  if (structured === undefined) {
    throw new Error(`no structuredContent on result: ${JSON.stringify(result)}`);
  }
  return structured['output'];
}

describe('the code-mode server as a real client sees it', () => {
  let facade: ProjectionFacade;
  let handler: McpHttpHandler;

  beforeEach(async () => {
    files = { '/notes.txt': 'original notes' };
    facade = await wrapMcpServer(buildWrappedServer(), { blob: { key: KEY } });
    handler = createMcpHandler(facade.serverFactory);
  });

  afterEach(async () => {
    await handler.close();
    await facade.close();
  });

  it('advertises the wrapped instructions plus the code-mode preamble (R29)', async () => {
    const client = await connect(handler, { modern: true });
    const instructions = client.getInstructions();
    expect(instructions).toContain('A tiny file server.');
    expect(instructions).toContain('execute_machine');
    expect(instructions).toBe(facade.instructions);
    await client.close();
  });

  it('exposes exactly the two code-mode tools, never the wrapped ones (R1)', async () => {
    const client = await connect(handler, { modern: true });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(['discover_apis', 'execute_machine']);
    await client.close();
  });

  it('really suspends a gated call, then completes it on the approved retry', async () => {
    // Manual multi-round-trip mode: the client hands the `input_required`
    // result back instead of fulfilling it, so the suspension itself is
    // observable. Against the pre-migration handler this call came back as a
    // completed `isError` result with phase `protocol`.
    const client = await connect(handler, { modern: true, manual: true });

    // `callTool`'s typed params have no slot for the MRTR retry fields (they
    // are siblings of `arguments`, and the SDK's typed sugar only models the
    // auto-fulfilled path), so the manual legs go through `request`.
    const suspended = await client.request(
      {
        method: 'tools/call',
        params: { name: 'execute_machine', arguments: { code: GATED_MACHINE } },
      },
      { allowInputRequired: true },
    );

    if (!isInputRequiredResult(suspended)) {
      throw new Error(`expected a suspension, got ${JSON.stringify(suspended)}`);
    }
    const requests = suspended.inputRequests ?? {};
    expect(Object.keys(requests)).toEqual(['w1']);
    const request = requests['w1'];
    expect(request?.method).toBe('elicitation/create');
    const params = request?.params as { message: string };
    expect(params.message).toContain('Write content to a file.');
    expect(params.message).toContain('/notes.txt');
    expect(typeof suspended.requestState).toBe('string');
    // Nothing ran while the human was being asked (S2).
    expect(files['/notes.txt']).toBe('original notes');

    const completed = await client.request(
      {
        method: 'tools/call',
        params: {
          name: 'execute_machine',
          arguments: { code: GATED_MACHINE },
          requestState: suspended.requestState,
          inputResponses: { w1: { action: 'accept' } },
        },
      },
      { allowInputRequired: true },
    );

    expect(isInputRequiredResult(completed)).toBe(false);
    expect(completed.isError).toBeUndefined();
    expect(machineOutput(completed)).toEqual({ status: 'wrote 15 bytes' });
    expect(files['/notes.txt']).toBe('from the client');
    await client.close();
  });

  it('lets the SDK drive the whole approval round trip through an elicitation handler', async () => {
    const prompts: string[] = [];
    const client = await connect(handler, {
      modern: true,
      onElicit: (message) => {
        prompts.push(message);
        return { action: 'accept', content: {} };
      },
    });

    // One `callTool` from the caller's point of view; two `tools/call` legs
    // on the wire, with the elicitation answered in between.
    const result = await client.callTool({
      name: 'execute_machine',
      arguments: { code: GATED_MACHINE },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('write_file');
    expect(machineOutput(result)).toEqual({ status: 'wrote 15 bytes' });
    expect(files['/notes.txt']).toBe('from the client');
    await client.close();
  });

  it('carries a decline through to the machine fallback branch (R17)', async () => {
    const client = await connect(handler, {
      modern: true,
      onElicit: () => ({ action: 'decline', content: { reason: 'not today' } }),
    });

    const result = await client.callTool({
      name: 'execute_machine',
      arguments: { code: GATED_MACHINE },
    });

    expect(machineOutput(result)).toEqual({ status: 'skipped' });
    expect(files['/notes.txt']).toBe('original notes');
    await client.close();
  });

  describe('down-negotiation (R28)', () => {
    it('still runs read-only machines for a legacy client', async () => {
      const client = await connect(handler);
      expect(client.getProtocolEra()).toBe('legacy');

      const result = await client.callTool({
        name: 'execute_machine',
        arguments: { code: READ_ONLY_MACHINE },
      });

      expect(result.isError).toBeUndefined();
      expect(machineOutput(result)).toEqual({ notes: 'original notes' });
      await client.close();
    });

    it('fails fast, naming the required revision, when a gated call would suspend', async () => {
      const client = await connect(handler);
      expect(client.getProtocolEra()).toBe('legacy');

      const result = await client.callTool({
        name: 'execute_machine',
        arguments: { code: GATED_MACHINE },
      });

      expect(result.isError).toBe(true);
      const error = result.structuredContent as unknown as { phase: string; message: string };
      expect(error.phase).toBe('protocol');
      expect(error.message).toContain(MRTR_PROTOCOL_REVISION);
      // The fail-fast happens before any write and before the SDK's legacy
      // elicitation shim could push a prompt down the connection.
      expect(files['/notes.txt']).toBe('original notes');
      await client.close();
    });
  });
});
