/**
 * The catalog projection (PRD §6.8, R32–R34) over a REAL McpServer: the
 * facade's `projections` switch, the tool surface each selection exposes,
 * the routing preamble, and `search_tools` / `describe_tool` driven through
 * an MCP client.
 */

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_CATALOG_PREAMBLE,
  DEFAULT_CODE_MODE_PREAMBLE,
  DEFAULT_ROUTING_PREAMBLE,
  ProjectionError,
  wrapMcpServer,
  type ProjectionFacade,
  type WrapOptions,
} from '../../src/index.js';

const KEY = new Uint8Array(32).fill(9);

function buildWrappedServer(): McpServer {
  const server = new McpServer(
    { name: 'catalog-files', version: '1.0.0' },
    { instructions: 'A tiny file server.' },
  );
  server.registerTool(
    'read_file',
    {
      description: 'Read a file from disk. Returns its text.',
      inputSchema: z.object({ path: z.string().describe('Absolute path.') }),
      annotations: { readOnlyHint: true },
    },
    ({ path }) => ({ content: [{ type: 'text' as const, text: `contents of ${path}` }] }),
  );
  server.registerTool(
    'write_file',
    {
      description: 'Write content to a file.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
    },
    () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  );
  server.registerTool(
    'delete_file',
    {
      description: 'Delete a file permanently.',
      inputSchema: z.object({ path: z.string() }),
      annotations: { destructiveHint: true },
    },
    () => ({ content: [{ type: 'text' as const, text: 'gone' }] }),
  );
  return server;
}

let facade: ProjectionFacade | undefined;
let client: Client | undefined;

async function connect(options: Partial<WrapOptions> = {}): Promise<Client> {
  facade = await wrapMcpServer(buildWrappedServer(), { blob: { key: KEY }, ...options });
  const served = facade.createServer({ era: 'modern' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'catalog-test', version: '1.0.0' }, { capabilities: {} });
  await served.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function toolNames(c: Client): Promise<string[]> {
  const { tools } = await c.listTools();
  return tools.map((tool) => tool.name).toSorted();
}

afterEach(async () => {
  await client?.close();
  await facade?.close();
  client = undefined;
  facade = undefined;
});

describe('projections switch (R1, R32)', () => {
  it('defaults to both projections: five tools, routing preamble', async () => {
    const c = await connect();
    expect(await toolNames(c)).toEqual([
      'call_tool',
      'describe_tool',
      'discover_apis',
      'execute_machine',
      'search_tools',
    ]);
    expect(facade?.projections).toEqual({ codeMode: true, catalog: true });
    expect(Object.isFrozen(facade?.projections)).toBe(true);
    expect(facade?.instructions).toBe(`A tiny file server.\n\n${DEFAULT_ROUTING_PREAMBLE}`);
  });

  it('code mode only: two tools and the code-mode preamble', async () => {
    const c = await connect({ projections: { catalog: false } });
    expect(await toolNames(c)).toEqual(['discover_apis', 'execute_machine']);
    expect(facade?.instructions).toBe(`A tiny file server.\n\n${DEFAULT_CODE_MODE_PREAMBLE}`);
    // No call_tool to route to: execute_machine keeps its plain description.
    const { tools } = await c.listTools();
    expect(tools.find((t) => t.name === 'execute_machine')?.description).not.toContain('call_tool');
  });

  it('with both projections on, both surfaces are served and the routing preamble applies (R29)', async () => {
    const c = await connect({ projections: { catalog: true } });
    expect(await toolNames(c)).toEqual([
      'call_tool',
      'describe_tool',
      'discover_apis',
      'execute_machine',
      'search_tools',
    ]);
    expect(facade?.instructions).toContain(DEFAULT_ROUTING_PREAMBLE);
    expect(facade?.instructions).toContain('call_tool');
    expect(facade?.instructions).toContain('execute_machine');
    // The catalog tools are reads: annotated so hosts never prompt for them.
    const { tools } = await c.listTools();
    // Short lookup-then-act chains route to call_tool; machines are for loops,
    // branching over results, many steps or a saved workflow.
    expect(tools.find((t) => t.name === 'execute_machine')?.description).toContain(
      'For a short lookup-then-act chain, use call_tool for each step instead.',
    );
    expect(tools.find((t) => t.name === 'call_tool')?.description).toContain(
      'successive call_tool calls, reading each result before the next',
    );
    for (const name of ['search_tools', 'describe_tool']) {
      expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('catalog only: no code-mode tools or prompts, catalog preamble', async () => {
    const c = await connect({ projections: { codeMode: false, catalog: true } });
    expect(await toolNames(c)).toEqual(['call_tool', 'describe_tool', 'search_tools']);
    // call_tool deliberately carries no annotations (R35).
    const { tools } = await c.listTools();
    expect(tools.find((t) => t.name === 'call_tool')?.annotations).toBeUndefined();
    expect(facade?.instructions).toContain(DEFAULT_CATALOG_PREAMBLE);
    expect(facade?.instructions).not.toContain('execute_machine');
    const { prompts } = await c.listPrompts();
    expect(prompts).toEqual([]);
    // Resources back both projections.
    const { resources } = await c.listResources();
    expect(resources.map((r) => r.uri)).toContain('projection://types/tools.d.ts');
  });

  it('a developer preamble replaces the whole R29 copy whichever projections are on', async () => {
    await connect({ projections: { catalog: true }, codeModePreamble: 'Custom copy.' });
    expect(facade?.instructions).toBe('A tiny file server.\n\nCustom copy.');
  });

  it('disabling both projections is refused at wrap time as a terminal error', async () => {
    try {
      await wrapMcpServer(buildWrappedServer(), {
        blob: { key: KEY },
        projections: { codeMode: false, catalog: false },
      });
      expect.unreachable('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectionError);
      expect(err).toMatchObject({ phase: 'terminal' });
    }
  });
});

describe('search_tools and describe_tool over the wire (R33, R34)', () => {
  it('search_tools lists the wrapped tools with their postures', async () => {
    const c = await connect({ projections: { catalog: true }, policy: { delete_file: 'deny' } });
    const result = (await c.callTool({ name: 'search_tools', arguments: {} })) as {
      isError?: boolean;
      structuredContent?: {
        tools: { name: string; posture: string; destructive: boolean }[];
        total: number;
      };
    };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.total).toBe(3);
    expect(result.structuredContent?.tools).toEqual([
      {
        name: 'read_file',
        purpose: 'Read a file from disk.',
        posture: 'runs immediately',
        destructive: false,
      },
      {
        name: 'write_file',
        purpose: 'Write content to a file.',
        posture: 'asks for approval',
        destructive: false,
      },
      {
        name: 'delete_file',
        purpose: 'Delete a file permanently.',
        posture: 'blocked by policy',
        destructive: true,
      },
    ]);
  });

  it('search_tools filters and pages; a cursor for another query is a structured validate error', async () => {
    const c = await connect({ projections: { catalog: true } });
    const filtered = (await c.callTool({
      name: 'search_tools',
      arguments: { query: 'delete' },
    })) as {
      structuredContent?: { tools: { name: string }[] };
    };
    expect(filtered.structuredContent?.tools.map((t) => t.name)).toEqual(['delete_file']);

    const bad = (await c.callTool({
      name: 'search_tools',
      arguments: { cursor: 'definitely-not-a-cursor' },
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent?.['phase']).toBe('validate');
  });

  it('describe_tool returns the schema, posture and types for one tool', async () => {
    const c = await connect({ projections: { catalog: true } });
    const result = (await c.callTool({
      name: 'describe_tool',
      arguments: { name: 'write_file', types: true },
    })) as {
      isError?: boolean;
      structuredContent?: {
        name: string;
        posture: string;
        inputSchema: { properties?: Record<string, unknown>; required?: string[] };
        types?: string;
      };
      content: { type: string; text?: string }[];
    };
    expect(result.isError).toBeUndefined();
    const tool = result.structuredContent;
    expect(tool?.name).toBe('write_file');
    expect(tool?.posture).toBe('asks for approval');
    expect(Object.keys(tool?.inputSchema.properties ?? {}).toSorted()).toEqual(['content', 'path']);
    expect(tool?.inputSchema.required?.toSorted()).toEqual(['content', 'path']);
    expect(tool?.types).toContain('WriteFileInput');
    expect(result.content[0]?.text).toContain('Input schema (JSON Schema):');
    // The per-tool types are a verbatim slice of the served .d.ts resource.
    const dts = await c.readResource({ uri: 'projection://types/tools.d.ts' });
    const dtsText = (dts.contents[0] as { text?: string }).text ?? '';
    for (const line of (tool?.types ?? '').split('\n')) {
      if (line.startsWith('export type')) expect(dtsText).toContain(line);
    }
  });

  it('describe_tool on an unknown name is a structured validate error pointing at search_tools', async () => {
    const c = await connect({ projections: { catalog: true } });
    const result = (await c.callTool({ name: 'describe_tool', arguments: { name: 'nope' } })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.['phase']).toBe('validate');
    expect(String(result.structuredContent?.['hint'])).toContain('search_tools');
  });
});
