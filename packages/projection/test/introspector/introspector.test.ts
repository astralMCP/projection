import { Client, SdkError } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer, Server } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProjectionError } from '../../src/errors.js';
import { createIntrospector, type Introspector } from '../../src/introspector/index.js';
import { DEFAULT_SERVER_ALIAS, type ServerCatalog } from '../../src/types.js';

function buildFixtureServer(): McpServer {
  const server = new McpServer(
    { name: 'fixture-server', version: '1.2.3' },
    { instructions: 'Fixture server instructions. Be nice to it.' },
  );

  server.registerTool(
    'get_weather',
    {
      description: 'Get the current weather for a city.',
      inputSchema: z.object({
        city: z.string().describe('City name'),
        units: z.enum(['c', 'f']).optional().describe('Temperature units'),
      }),
      outputSchema: z.object({
        temperature: z.number(),
        conditions: z.string(),
      }),
      annotations: { readOnlyHint: true, title: 'Weather' },
    },
    async ({ city }) => {
      const structuredContent = { temperature: 21, conditions: `sunny in ${city}` };
      return {
        content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );

  server.registerTool(
    'delete_file',
    {
      description: 'Delete a file. Dangerous.',
      inputSchema: z.object({ path: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ path }) => ({ content: [{ type: 'text', text: `deleted ${path}` }] }),
  );

  server.registerTool(
    'always_fails',
    { description: 'Always returns an isError result.', inputSchema: z.object({}) },
    async () => ({ content: [{ type: 'text', text: 'boom: the thing broke' }], isError: true }),
  );

  server.registerTool(
    'always_throws',
    { description: 'Handler throws.', inputSchema: z.object({}) },
    async () => {
      throw new Error('kaput');
    },
  );

  return server;
}

describe('Introspector (in-process McpServer source)', () => {
  let introspector: Introspector;
  let serverCatalog: ServerCatalog | undefined;

  beforeAll(async () => {
    introspector = await createIntrospector({ [DEFAULT_SERVER_ALIAS]: buildFixtureServer() });
    serverCatalog = introspector.catalog.servers.get(DEFAULT_SERVER_ALIAS);
  });
  afterAll(() => introspector.close());

  it('builds a single-server catalog with a stable identity', () => {
    expect(introspector.catalog.servers.size).toBe(1);
    expect(serverCatalog?.alias).toBe(DEFAULT_SERVER_ALIAS);
    expect(serverCatalog?.identity).toBe('fixture-server@1.2.3');
  });

  it('forwards instructions verbatim (R29)', () => {
    expect(serverCatalog?.instructions).toBe('Fixture server instructions. Be nice to it.');
  });

  it('catalogues tool names, descriptions, and schemas', () => {
    const names = serverCatalog?.tools.map((tool) => tool.name);
    expect(names).toEqual(['get_weather', 'delete_file', 'always_fails', 'always_throws']);

    const weather = serverCatalog?.tools.find((tool) => tool.name === 'get_weather');
    expect(weather?.description).toBe('Get the current weather for a city.');
    expect(weather?.inputSchema['type']).toBe('object');
    const properties = weather?.inputSchema['properties'] as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual(['city', 'units']);
    expect(weather?.outputSchema?.['type']).toBe('object');
  });

  it('maps annotations (untrusted hints — S5)', () => {
    const weather = serverCatalog?.tools.find((tool) => tool.name === 'get_weather');
    expect(weather?.annotations).toEqual({ title: 'Weather', readOnlyHint: true });

    const deleteFile = serverCatalog?.tools.find((tool) => tool.name === 'delete_file');
    expect(deleteFile?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });

    const fails = serverCatalog?.tools.find((tool) => tool.name === 'always_fails');
    expect(fails?.annotations).toBeUndefined();
  });

  it('executes a tool call and returns structuredContent as the result', async () => {
    const outcome = await introspector.callTool(DEFAULT_SERVER_ALIAS, 'get_weather', {
      city: 'Oslo',
    });
    expect(outcome).toEqual({
      ok: true,
      result: { temperature: 21, conditions: 'sunny in Oslo' },
    });
  });

  it('returns a single text block as plain text', async () => {
    const outcome = await introspector.callTool(DEFAULT_SERVER_ALIAS, 'delete_file', {
      path: '/tmp/x',
    });
    expect(outcome).toEqual({ ok: true, result: 'deleted /tmp/x' });
  });

  it('maps isError results to ok: false with the error text', async () => {
    const outcome = await introspector.callTool(DEFAULT_SERVER_ALIAS, 'always_fails', {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.message).toContain('boom: the thing broke');
    }
  });

  it('maps handler exceptions to ok: false', async () => {
    const outcome = await introspector.callTool(DEFAULT_SERVER_ALIAS, 'always_throws', {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.message).toContain('kaput');
    }
  });

  it('maps invalid arguments to ok: false instead of throwing', async () => {
    const outcome = await introspector.callTool(DEFAULT_SERVER_ALIAS, 'get_weather', {
      city: 42,
    });
    expect(outcome.ok).toBe(false);
  });

  it('maps unknown tool names to ok: false', async () => {
    const outcome = await introspector.callTool(DEFAULT_SERVER_ALIAS, 'no_such_tool', {});
    expect(outcome.ok).toBe(false);
  });

  it('throws ProjectionError with a hint for an unknown alias', async () => {
    await expect(introspector.callTool('nope', 'get_weather', {})).rejects.toThrowError(
      ProjectionError,
    );
    await expect(introspector.callTool('nope', 'get_weather', {})).rejects.toMatchObject({
      phase: 'protocol',
      hint: expect.stringContaining('default'),
    });
  });

  it('refresh() rebuilds the catalog', async () => {
    const catalog = await introspector.refresh();
    expect(catalog.servers.get(DEFAULT_SERVER_ALIAS)?.identity).toBe('fixture-server@1.2.3');
    expect(introspector.catalog).toBe(catalog);
  });
});

describe('Introspector (remote Client source)', () => {
  async function connectRemote(): Promise<Client> {
    const server = buildFixtureServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'remote-test-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  it('reads tools/list and instructions from an already-connected client', async () => {
    const client = await connectRemote();
    const introspector = await createIntrospector({ remote: client });
    try {
      const serverCatalog = introspector.catalog.servers.get('remote');
      expect(serverCatalog?.identity).toBe('fixture-server@1.2.3');
      expect(serverCatalog?.instructions).toContain('Fixture server instructions');
      expect(serverCatalog?.tools).toHaveLength(4);

      const outcome = await introspector.callTool('remote', 'get_weather', { city: 'Bergen' });
      expect(outcome.ok).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('Introspector edge cases', () => {
  it('treats a server with no tools as an empty catalog', async () => {
    const server = new McpServer({ name: 'toolless', version: '0.0.1' });
    const introspector = await createIntrospector({ [DEFAULT_SERVER_ALIAS]: server });
    try {
      expect(introspector.catalog.servers.get(DEFAULT_SERVER_ALIAS)?.tools).toEqual([]);
    } finally {
      await introspector.close();
    }
  });

  it('rejects an empty source set with an actionable hint', async () => {
    await expect(createIntrospector({})).rejects.toMatchObject({
      phase: 'protocol',
      hint: expect.stringContaining('default'),
    });
  });

  it('rejects an McpServer that is already connected elsewhere', async () => {
    const server = buildFixtureServer();
    const first = await createIntrospector({ [DEFAULT_SERVER_ALIAS]: server });
    try {
      await expect(createIntrospector({ other: server })).rejects.toMatchObject({
        phase: 'protocol',
        message: expect.stringContaining('already connected'),
      });
    } finally {
      await first.close();
    }
  });

  it('accepts multiple aliased sources (R30 interface shape)', async () => {
    const introspector: Introspector = await createIntrospector({
      alpha: buildFixtureServer(),
      beta: buildFixtureServer(),
    });
    try {
      expect(introspector.catalog.servers.size).toBe(2);
      expect(introspector.catalog.servers.get('alpha')?.identity).toBe('fixture-server@1.2.3');
      const outcome = await introspector.callTool('beta', 'get_weather', { city: 'Tromsø' });
      expect(outcome.ok).toBe(true);
    } finally {
      await introspector.close();
    }
  });
});

describe('Introspector tools/list limits (D12)', () => {
  /**
   * A low-level server whose tools/list answers `pages` pages of `perPage`
   * tools each; `pages: Infinity` never stops returning `nextCursor`.
   */
  async function connectPaginating(pages: number, perPage: number): Promise<Client> {
    const server = new Server(
      { name: 'paginating', version: '0.0.1' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler('tools/list', (request) => {
      const page = request.params?.cursor !== undefined ? Number(request.params.cursor) : 0;
      const tools = Array.from({ length: perPage }, (_, i) => ({
        name: `tool_${page}_${i}`,
        inputSchema: { type: 'object' as const },
      }));
      return page + 1 < pages ? { tools, nextCursor: String(page + 1) } : { tools };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'paging-test-client', version: '0.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  it('introspects a normally paginated catalog across pages', async () => {
    const client = await connectPaginating(3, 2);
    try {
      const introspector = await createIntrospector({ remote: client });
      expect(introspector.catalog.servers.get('remote')?.tools.map((tool) => tool.name)).toEqual([
        'tool_0_0',
        'tool_0_1',
        'tool_1_0',
        'tool_1_1',
        'tool_2_0',
        'tool_2_1',
      ]);
    } finally {
      await client.close();
    }
  });

  it('rejects a server declaring more than 2000 tools across pages', async () => {
    const client = await connectPaginating(3, 700);
    try {
      const error = await createIntrospector({ remote: client }).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ProjectionError);
      expect(error).toMatchObject({
        phase: 'protocol',
        message: expect.stringContaining('declares 2100 tools, over the cap of 2000'),
        hint: expect.stringContaining('2000 tools'),
      });
    } finally {
      await client.close();
    }
  });

  it('surfaces an endless tools/list chain (SDK page cap) as a protocol error', async () => {
    const client = await connectPaginating(Infinity, 1);
    try {
      const error = await createIntrospector({ remote: client }).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ProjectionError);
      expect(error).toMatchObject({
        phase: 'protocol',
        message: expect.stringContaining('listMaxPages'),
        hint: expect.stringContaining('pagination terminates'),
      });
      expect((error as ProjectionError).cause).toBeInstanceOf(SdkError);
    } finally {
      await client.close();
    }
  });
});
