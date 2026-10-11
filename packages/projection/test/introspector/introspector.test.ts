import { Client, SdkError } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer, Server } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MCP_SDK_VERSION } from '../../src/blob/versions.js';
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

  it('names a second copy of @modelcontextprotocol/server instead of treating it as a Client', async () => {
    // What an McpServer from a different SDK copy looks like here: the right
    // shape, but not an instance of the McpServer class Projection imports.
    const foreign = {
      server: {},
      connect: async () => undefined,
      registerTool: () => undefined,
      isConnected: () => false,
    };
    const error = await createIntrospector({
      [DEFAULT_SERVER_ALIAS]: foreign as unknown as McpServer,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProjectionError);
    expect(error).toMatchObject({
      phase: 'protocol',
      message: expect.stringContaining('second copy of @modelcontextprotocol/server'),
      hint: expect.stringContaining(`@modelcontextprotocol/server ${MCP_SDK_VERSION} exactly`),
    });
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

interface PaginatingOptions {
  /** Every page answers this same nextCursor (a pagination loop). */
  repeatCursor?: string;
  /** Passed to the test's Client: proves the bound does not come from the SDK. */
  listMaxPages?: number;
}

/**
 * A low-level server whose tools/list answers `pages` pages of `perPage`
 * tools each; `pages: Infinity` never stops returning `nextCursor`.
 */
async function connectPaginating(
  pages: number,
  perPage: number,
  options: PaginatingOptions = {},
): Promise<Client> {
  const server = new Server(
    { name: 'paginating', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );
  let served = 0;
  server.setRequestHandler('tools/list', (request) => {
    served += 1;
    const page =
      options.repeatCursor !== undefined
        ? served - 1
        : request.params?.cursor !== undefined
          ? Number(request.params.cursor)
          : 0;
    const tools = Array.from({ length: perPage }, (_, i) => ({
      name: `tool_${page}_${i}`,
      inputSchema: { type: 'object' as const },
    }));
    if (options.repeatCursor !== undefined) return { tools, nextCursor: options.repeatCursor };
    return page + 1 < pages ? { tools, nextCursor: String(page + 1) } : { tools };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'paging-test-client', version: '0.0.0' },
    options.listMaxPages !== undefined ? { listMaxPages: options.listMaxPages } : undefined,
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function introspectionError(client: Client): Promise<unknown> {
  return createIntrospector({ remote: client }).then(
    async (introspector) => {
      await introspector.close();
      return undefined;
    },
    (err: unknown) => err,
  );
}

describe('Introspector tools/list limits (D12)', () => {
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

  it('introspects exactly 2000 tools across pages', async () => {
    const client = await connectPaginating(4, 500);
    try {
      const introspector = await createIntrospector({ remote: client });
      expect(introspector.catalog.servers.get('remote')?.tools).toHaveLength(2000);
    } finally {
      await client.close();
    }
  });

  it('rejects a server declaring more than 2000 tools across pages', async () => {
    const client = await connectPaginating(3, 700);
    try {
      const error = await introspectionError(client);
      expect(error).toBeInstanceOf(ProjectionError);
      expect(error).toMatchObject({
        phase: 'protocol',
        message: expect.stringContaining('declares at least 2100 tools, over the cap of 2000'),
        hint: expect.stringContaining('2000 tools'),
      });
    } finally {
      await client.close();
    }
  });

  it('rejects a single tools/list page of 2001 tools', async () => {
    const client = await connectPaginating(1, 2001);
    try {
      const error = await introspectionError(client);
      expect(error).toBeInstanceOf(ProjectionError);
      expect(error).toMatchObject({
        phase: 'protocol',
        message: expect.stringContaining('declares at least 2001 tools, over the cap of 2000'),
      });
    } finally {
      await client.close();
    }
  });

  it('stops at the tool cap without fetching the rest of a long chain', async () => {
    // The running total crosses 2000 on page 3; the endless chain behind it is never walked.
    const client = await connectPaginating(Infinity, 1000);
    try {
      const error = await introspectionError(client);
      expect(error).toMatchObject({
        phase: 'protocol',
        message: expect.stringContaining('declares at least 3000 tools'),
      });
    } finally {
      await client.close();
    }
  });

  it("rejects an endless tools/list chain at Projection's 100-page cap", async () => {
    const client = await connectPaginating(Infinity, 1);
    try {
      const error = await introspectionError(client);
      expect(error).toBeInstanceOf(ProjectionError);
      expect(error).toMatchObject({
        phase: 'protocol',
        message: expect.stringContaining('after 100 pages, over the cap of 100'),
        hint: expect.stringContaining('pagination terminates'),
      });
    } finally {
      await client.close();
    }
  });

  it('accepts exactly 100 pages', async () => {
    const client = await connectPaginating(100, 1);
    try {
      const introspector = await createIntrospector({ remote: client });
      expect(introspector.catalog.servers.get('remote')?.tools).toHaveLength(100);
    } finally {
      await client.close();
    }
  });

  it('rejects a repeated cursor as a protocol error instead of looping', async () => {
    const client = await connectPaginating(Infinity, 1, { repeatCursor: 'again' });
    try {
      const error = await introspectionError(client);
      expect(error).toBeInstanceOf(ProjectionError);
      expect(error).toMatchObject({
        phase: 'protocol',
        message: expect.stringContaining('pagination loops: page 2 returned cursor "again"'),
      });
    } finally {
      await client.close();
    }
  }, 2_000);

  it('enforces its own page cap even when the Client is unbounded (listMaxPages: 0)', async () => {
    const client = await connectPaginating(Infinity, 1, { listMaxPages: 0 });
    try {
      const error = await introspectionError(client);
      expect(error).toBeInstanceOf(ProjectionError);
      expect(error).toMatchObject({
        phase: 'protocol',
        message: expect.stringContaining('over the cap of 100'),
      });
      expect((error as ProjectionError).cause).not.toBeInstanceOf(SdkError);
    } finally {
      await client.close();
    }
  }, 5_000);

  it('is not limited by a smaller Client listMaxPages either', async () => {
    const client = await connectPaginating(10, 1, { listMaxPages: 2 });
    try {
      const introspector = await createIntrospector({ remote: client });
      expect(introspector.catalog.servers.get('remote')?.tools).toHaveLength(10);
    } finally {
      await client.close();
    }
  });
});

/** A server whose `report` tool declares an outputSchema and breaks it. */
async function connectNonConforming(): Promise<{ client: Client; server: Server }> {
  const server = new Server(
    { name: 'non-conforming', version: '0.0.1' },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler('tools/list', () => ({
    tools: [
      {
        name: 'report',
        inputSchema: { type: 'object' as const },
        outputSchema: {
          type: 'object' as const,
          properties: { count: { type: 'number' } },
          required: ['count'],
        },
      },
    ],
  }));
  server.setRequestHandler('tools/call', () => ({
    content: [{ type: 'text' as const, text: 'not a count' }],
    structuredContent: { count: 'many' },
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'schema-test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe('Introspector output-schema validation', () => {
  it('rejects non-conforming structuredContent before and after tools/list_changed', async () => {
    const { client, server } = await connectNonConforming();
    try {
      // Fill the SDK's own tools/list cache, so the list_changed below has
      // something to clear: validation must not depend on it either way.
      await client.listTools();
      const introspector = await createIntrospector({ remote: client });
      const before = await introspector.callTool('remote', 'report', {});
      expect(before.ok).toBe(false);
      if (!before.ok) expect(before.error.message).toContain('output schema');

      const notified = new Promise<void>((resolve) => {
        client.setNotificationHandler('notifications/tools/list_changed', () => resolve());
      });
      await server.notification({ method: 'notifications/tools/list_changed' });
      await notified;

      const after = await introspector.callTool('remote', 'report', {});
      expect(after).toEqual(before);
    } finally {
      await client.close();
    }
  });
});
