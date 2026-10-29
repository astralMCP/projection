/**
 * A multi-server facade as a REAL MCP client sees it (PRD R1, R28, R35,
 * R40, R43, R46; S2, S6): the served tool list, and the approve / decline
 * round trips of a qualified `call_tool` over the 2026-07-28 wire and over a
 * held legacy connection through the elicitation shim.
 */

import {
  Client,
  isInputRequiredResult,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { createMcpHandler, InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { wrapMcpServers, type MultiProjectionFacade } from '../../src/index.js';
import { MRTR_PROTOCOL_REVISION } from '../../src/mrtr/index.js';
import { fsServer, githubServer, KEY, type RecordedCall } from './helpers.js';

const ENDPOINT = new URL('http://multi.projection.test/mcp');
const WRITE = { name: 'fs.write_file', args: { path: '/notes.txt', content: 'via the fs box' } };

type Structured = Record<string, unknown> | undefined;

let facade: MultiProjectionFacade | undefined;
let client: Client | undefined;
let log: RecordedCall[];

afterEach(async () => {
  await client?.close();
  await facade?.close();
  client = undefined;
  facade = undefined;
});

async function wrap(legacyElicitation = false): Promise<MultiProjectionFacade> {
  log = [];
  facade = await wrapMcpServers(
    { fs: fsServer(log), github: githubServer(log) },
    { blob: { key: KEY }, ...(legacyElicitation ? { compat: { legacyElicitation: true } } : {}) },
  );
  return facade;
}

/** A 2026-07-28 client over the handler, driving the MRTR legs by hand. */
async function connectModern(f: MultiProjectionFacade): Promise<Client> {
  const handler = createMcpHandler(f.serverFactory);
  client = new Client(
    { name: 'multi-wire-test', version: '1.0.0' },
    {
      capabilities: { elicitation: {} },
      versionNegotiation: { mode: { pin: MRTR_PROTOCOL_REVISION } },
      inputRequired: { autoFulfill: false },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(ENDPOINT, {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  return client;
}

async function suspendWrite(c: Client): Promise<{ requestState: string; message: string }> {
  const suspended = await c.request(
    { method: 'tools/call', params: { name: 'call_tool', arguments: WRITE } },
    { allowInputRequired: true },
  );
  if (!isInputRequiredResult(suspended) || suspended.requestState === undefined) {
    throw new Error(`expected a suspension, got ${JSON.stringify(suspended)}`);
  }
  expect(Object.keys(suspended.inputRequests ?? {})).toEqual(['call']);
  const params = suspended.inputRequests?.['call']?.params as { message: string };
  return { requestState: suspended.requestState, message: params.message };
}

async function retryWrite(
  c: Client,
  requestState: string,
  action: 'accept' | 'decline',
): Promise<{ isError?: boolean; structuredContent?: Structured }> {
  const result = await c.request(
    {
      method: 'tools/call',
      params: {
        name: 'call_tool',
        arguments: WRITE,
        requestState,
        inputResponses: { call: { action } },
      },
    },
    { allowInputRequired: true },
  );
  expect(isInputRequiredResult(result)).toBe(false);
  return result as { isError?: boolean; structuredContent?: Structured };
}

describe('a multi-server facade over the 2026-07-28 wire', () => {
  it('serves both projections: code mode, then one search per box, search_tools, describe_tool, call_tool (R1, R43, R45)', async () => {
    const c = await connectModern(await wrap());
    const { tools } = await c.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'execute_machine',
      'discover_apis',
      'search_fs',
      'search_github',
      'search_tools',
      'describe_tool',
      'call_tool',
    ]);
    expect(c.getInstructions()).toContain(`- fs — "FS-SERVER-INSTRUCTIONS: read me first."`);
    const properties = tools.find((tool) => tool.name === 'describe_tool')?.inputSchema
      .properties as Record<string, { description?: string }> | undefined;
    expect(properties?.['types']?.description).toContain('its member of tools.<box>');
    expect(tools.find((tool) => tool.name === 'execute_machine')?.description).toContain(
      "toolCall('<box>.<tool>', args)",
    );
    const prompts = await c.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name).toSorted()).toEqual([
      'save-workflow',
      'visualize-workflow',
    ]);
  });

  it('searches every box and describes a tool by its qualified name', async () => {
    const c = await connectModern(await wrap());
    const search = (await c.callTool({ name: 'search_tools', arguments: { query: 'issue' } })) as {
      structuredContent?: Structured;
    };
    const tools = (search.structuredContent?.['tools'] ?? []) as { name: string; box: string }[];
    const names = tools.map((tool) => `${tool.box}|${tool.name}`);
    expect(names).toContain('github|github.issue_write');
    const described = (await c.callTool({
      name: 'describe_tool',
      arguments: { name: 'github.get_issue' },
    })) as { structuredContent?: Structured };
    expect(described.structuredContent?.['posture']).toBe('runs immediately');
  });

  it('approves a qualified call: one elicitation naming the box, then the recorded args run in that box', async () => {
    const c = await connectModern(await wrap());
    const { requestState, message } = await suspendWrite(c);
    // R46: the title and the purpose line name the box by its host alias.
    expect(message.split('\n')[0]).toBe('Approve (fs): write file');
    expect(message).toContain('What fs says it does: "Write content to a file."');
    expect(message).not.toContain('What the server says it does');
    expect(message).toContain('Tool: fs.write_file');
    expect(message).toContain('via the fs box');
    expect(log).toEqual([]);

    const completed = await retryWrite(c, requestState, 'accept');
    expect(completed.isError).toBeUndefined();
    expect(completed.structuredContent).toEqual({
      status: 'ok',
      tool: 'fs.write_file',
      output: 'files:write_file',
    });
    expect(log).toEqual([
      {
        server: 'files',
        tool: 'write_file',
        args: { path: '/notes.txt', content: 'via the fs box' },
      },
    ]);
  });

  it('declines a qualified call: nothing runs in any box', async () => {
    const c = await connectModern(await wrap());
    const { requestState } = await suspendWrite(c);
    const declined = await retryWrite(c, requestState, 'decline');
    expect(declined.structuredContent).toEqual({ status: 'declined', tool: 'fs.write_file' });
    expect(log).toEqual([]);
  });
});

describe('a multi-server facade over a held legacy connection', () => {
  it('approves through the elicitation shim with legacyElicitation on (R28)', async () => {
    const f = await wrap(true);
    const served = f.createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const messages: string[] = [];
    client = new Client(
      { name: 'legacy-client', version: '1.0.0' },
      { capabilities: { elicitation: {} } },
    );
    client.setRequestHandler('elicitation/create', (request) => {
      messages.push((request.params as { message: string }).message);
      return { action: 'accept', content: {} };
    });
    await served.connect(serverTransport);
    await client.connect(clientTransport);

    const result = (await client.callTool({ name: 'call_tool', arguments: WRITE })) as {
      structuredContent?: Structured;
    };
    expect(result.structuredContent).toEqual({
      status: 'ok',
      tool: 'fs.write_file',
      output: 'files:write_file',
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Tool: fs.write_file');
    expect(log.map((call) => `${call.server}:${call.tool}`)).toEqual(['files:write_file']);
  });

  it('fails fast without legacyElicitation, running nothing (R28)', async () => {
    const f = await wrap();
    const served = f.createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'legacy-client', version: '1.0.0' });
    await served.connect(serverTransport);
    await client.connect(clientTransport);
    const result = (await client.callTool({ name: 'call_tool', arguments: WRITE })) as {
      isError?: boolean;
      structuredContent?: Structured;
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.['phase']).toBe('protocol');
    expect(log).toEqual([]);
  });
});
