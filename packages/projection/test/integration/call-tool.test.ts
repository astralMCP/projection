/**
 * `call_tool` as a REAL MCP client sees it (PRD R35, R28, S2): the 2026-07-28
 * manual MRTR legs over HTTP, the SDK-driven auto-fulfilled round trip, and
 * the held legacy connection through the elicitation shim.
 */

import {
  Client,
  isInputRequiredResult,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
  createMcpHandler,
  InMemoryTransport,
  McpServer,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { wrapMcpServer, type ProjectionFacade, type WrapOptions } from '../../src/index.js';
import { MRTR_PROTOCOL_REVISION } from '../../src/mrtr/index.js';

const KEY = new Uint8Array(32).fill(13);
const ENDPOINT = new URL('http://call-tool.projection.test/mcp');

let files: Record<string, string>;
let facade: ProjectionFacade | undefined;
let client: Client | undefined;

function buildWrappedServer(): McpServer {
  const server = new McpServer({ name: 'call-files', version: '1.0.0' });
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

async function serve(options: Partial<WrapOptions> = {}): Promise<McpHttpHandler> {
  facade = await wrapMcpServer(buildWrappedServer(), { blob: { key: KEY }, ...options });
  return createMcpHandler(facade.serverFactory);
}

interface ConnectOptions {
  manual?: boolean;
  onElicit?: (message: string) => {
    action: 'accept' | 'decline';
    content?: Record<string, string>;
  };
}

/** A 2026-07-28 client over the handler (no network: fetch is the handler). */
async function connectModern(
  handler: McpHttpHandler,
  options: ConnectOptions = {},
): Promise<Client> {
  client = new Client(
    { name: 'call-tool-test', version: '1.0.0' },
    {
      capabilities: { elicitation: {} },
      versionNegotiation: { mode: { pin: MRTR_PROTOCOL_REVISION } },
      ...(options.manual === true ? { inputRequired: { autoFulfill: false } } : {}),
    },
  );
  if (options.onElicit !== undefined) {
    const onElicit = options.onElicit;
    client.setRequestHandler('elicitation/create', (request) => {
      const verdict = onElicit((request.params as { message: string }).message);
      return verdict.action === 'accept'
        ? { action: 'accept', content: verdict.content ?? {} }
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

/** A HELD legacy connection (the stdio shape) with the elicitation shim. */
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

type Structured = Record<string, unknown> | undefined;

beforeEach(() => {
  files = { '/notes.txt': 'original notes' };
});

afterEach(async () => {
  await client?.close();
  await facade?.close();
  client = undefined;
  facade = undefined;
});

describe('call_tool over the 2026-07-28 wire', () => {
  it('a read-only call completes in one leg', async () => {
    const c = await connectModern(await serve());
    const result = (await c.callTool({
      name: 'call_tool',
      arguments: { name: 'read_file', args: { path: '/notes.txt' } },
    })) as { isError?: boolean; structuredContent?: Structured };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      status: 'ok',
      tool: 'read_file',
      output: 'original notes',
    });
  });

  it('a gated call suspends with one elicitation, then the approved retry executes the recorded args (S2)', async () => {
    const c = await connectModern(await serve(), { manual: true });
    const args = { name: 'write_file', args: { path: '/notes.txt', content: 'via call_tool' } };

    const suspended = await c.request(
      { method: 'tools/call', params: { name: 'call_tool', arguments: args } },
      { allowInputRequired: true },
    );
    if (!isInputRequiredResult(suspended)) {
      throw new Error(`expected a suspension, got ${JSON.stringify(suspended)}`);
    }
    const requests = suspended.inputRequests ?? {};
    expect(Object.keys(requests)).toEqual(['call']);
    const params = requests['call']?.params as { message: string };
    expect(params.message).toContain('Approve: write file');
    expect(params.message).toContain('requested directly by the model');
    expect(params.message).toContain('via call_tool');
    expect(files['/notes.txt']).toBe('original notes');

    // A retry carrying different args is refused before anything runs (R36).
    const tampered = await c.request(
      {
        method: 'tools/call',
        params: {
          name: 'call_tool',
          arguments: { name: 'write_file', args: { path: '/other.txt', content: 'x' } },
          requestState: suspended.requestState,
          inputResponses: { call: { action: 'accept' } },
        },
      },
      { allowInputRequired: true },
    );
    expect((tampered as { isError?: boolean }).isError).toBe(true);
    expect(
      ((tampered as { structuredContent?: Structured }).structuredContent ?? {})['phase'],
    ).toBe('blob_verification');
    expect(files['/other.txt']).toBeUndefined();

    const completed = await c.request(
      {
        method: 'tools/call',
        params: {
          name: 'call_tool',
          arguments: args,
          requestState: suspended.requestState,
          inputResponses: { call: { action: 'accept' } },
        },
      },
      { allowInputRequired: true },
    );
    expect(isInputRequiredResult(completed)).toBe(false);
    expect((completed as { isError?: boolean }).isError).toBeUndefined();
    expect((completed as { structuredContent?: Structured }).structuredContent).toEqual({
      status: 'ok',
      tool: 'write_file',
      output: 'wrote 13 bytes',
    });
    expect(files['/notes.txt']).toBe('via call_tool');
  });

  it('the SDK drives the whole round trip through an elicitation handler; a decline is a normal result', async () => {
    const prompts: string[] = [];
    const handler = await serve();
    const c = await connectModern(handler, {
      onElicit: (message) => {
        prompts.push(message);
        return { action: 'decline' };
      },
    });
    const result = (await c.callTool({
      name: 'call_tool',
      arguments: { name: 'write_file', args: { path: '/notes.txt', content: 'nope' } },
    })) as { isError?: boolean; structuredContent?: Structured };
    expect(prompts).toHaveLength(1);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ status: 'declined', tool: 'write_file' });
    expect(files['/notes.txt']).toBe('original notes');
  });

  it('bad arguments are a structured validate error naming the property; nothing is asked or run', async () => {
    const c = await connectModern(await serve());
    const result = (await c.callTool({
      name: 'call_tool',
      arguments: { name: 'write_file', args: { path: '/notes.txt' } },
    })) as { isError?: boolean; structuredContent?: Structured };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.['phase']).toBe('validate');
    expect(String(result.structuredContent?.['message'])).toContain('"content"');
    expect(files['/notes.txt']).toBe('original notes');
  });
});

describe('call_tool on legacy connections (R28)', () => {
  it('over a held connection with the opt-in, the shim carries the approval and the write lands', async () => {
    const prompts: string[] = [];
    const c = await connectHeldLegacy({ compat: { legacyElicitation: true } }, (message) => {
      prompts.push(message);
      expect(files['/notes.txt']).toBe('original notes');
      return { action: 'accept' };
    });
    const result = (await c.callTool({
      name: 'call_tool',
      arguments: { name: 'write_file', args: { path: '/notes.txt', content: 'legacy shim' } },
    })) as { isError?: boolean; structuredContent?: Structured };
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('requested directly by the model');
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ status: 'ok', tool: 'write_file' });
    expect(files['/notes.txt']).toBe('legacy shim');
  });

  it('without the opt-in a gated call fails fast with the R28 protocol error', async () => {
    const c = await connectHeldLegacy({}, () => ({ action: 'accept' }));
    const result = (await c.callTool({
      name: 'call_tool',
      arguments: { name: 'write_file', args: { path: '/notes.txt', content: 'x' } },
    })) as { isError?: boolean; structuredContent?: Structured };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.['phase']).toBe('protocol');
    expect(String(result.structuredContent?.['message'])).toContain('this call');
    expect(files['/notes.txt']).toBe('original notes');
  });
});
