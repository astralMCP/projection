/**
 * G2: which protocol era Projection speaks to a wrapped server given by URL,
 * and what it declares there (DECISIONS D23). A 2026-07-28 server is spoken
 * to on 2026-07-28; a server that only speaks the 2025 era still works,
 * declaring no capability — also when the box forwards questions, which a
 * 2025-era server could only push (D7).
 */

import {
  createMcpHandler,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryTokenStore, wrapMcpServer, type ProjectionFacade } from '../../src/index.js';
import { startFakeHttpServer, type FakeHttpServer } from '../auth/fakes/http.js';
import { everythingServer, type ProbeEvent } from './everything-server.js';

const KEY = new Uint8Array(32).fill(58);

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

async function serve(handle: (request: Request) => Promise<Response>): Promise<FakeHttpServer> {
  const fake = await startFakeHttpServer(handle);
  closers.push(() => fake.close());
  return fake;
}

/** An everything server behind createMcpHandler: both eras, a fresh instance per request. */
async function modernServer(probe: ProbeEvent[]): Promise<FakeHttpServer> {
  const handler = createMcpHandler(() => everythingServer('everything', probe).server);
  return serve((request) => handler.fetch(request));
}

/** An everything server that speaks only the 2025 era (stateless Streamable HTTP). */
async function legacyOnlyServer(
  probe: ProbeEvent[],
  initialize: unknown[],
): Promise<FakeHttpServer> {
  return serve(async (request) => {
    const body: unknown = request.method === 'POST' ? await request.clone().json() : undefined;
    if (
      typeof body === 'object' &&
      body !== null &&
      (body as { method?: unknown }).method === 'initialize'
    ) {
      initialize.push((body as { params?: { capabilities?: unknown } }).params?.capabilities);
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await everythingServer('everything', probe).server.connect(transport);
    return transport.handleRequest(request);
  });
}

async function wrapUrl(fake: FakeHttpServer, forward: boolean): Promise<ProjectionFacade> {
  const facade = await wrapMcpServer(
    { url: `${fake.origin}/mcp` },
    {
      blob: { key: KEY },
      tokenStore: new MemoryTokenStore(),
      ...(forward ? { upstreamElicitation: 'forward' as const } : {}),
    },
  );
  closers.push(() => facade.close());
  return facade;
}

describe('the era Projection speaks to a server given by URL (G2)', () => {
  it('a 2026-07-28 server is spoken to on 2026-07-28', async () => {
    const probe: ProbeEvent[] = [];
    const facade = await wrapUrl(await modernServer(probe), false);
    const result = await facade.callTool({ name: 'ask_user' }, 'modern');
    expect(probe).toContainEqual({ kind: 'client-era', tool: 'ask_user', envelope: true });
    // Refused by default, with the corrected hint.
    expect(result).toMatchObject({ isError: true, structuredContent: { phase: 'upstream' } });
  });

  it('a forwarding box gets the question from a 2026-07-28 server', async () => {
    const probe: ProbeEvent[] = [];
    const facade = await wrapUrl(await modernServer(probe), true);
    const result = await facade.callTool({ name: 'ask_user' }, 'modern', true, true);
    expect(result).toMatchObject({ resultType: 'input_required' });
  });

  for (const forward of [false, true]) {
    it(`a 2025-era-only server keeps working, and is declared no capability (forward: ${forward})`, async () => {
      const probe: ProbeEvent[] = [];
      const initialize: unknown[] = [];
      const facade = await wrapUrl(await legacyOnlyServer(probe, initialize), forward);
      const weather = await facade.callTool(
        { name: 'get_weather', args: { city: 'Oslo' } },
        'modern',
      );
      expect(weather).toMatchObject({ structuredContent: { status: 'ok' } });
      // The handshake that stuck declared nothing (D7: a 2025 server would push).
      expect(initialize.at(-1)).toEqual({});
      // A forwarding box first offered the capability, then reconnected without it.
      expect(initialize).toHaveLength(forward ? 2 : 1);
      const asked = await facade.callTool({ name: 'ask_user' }, 'modern', true, true);
      expect(asked).toMatchObject({ isError: true, structuredContent: { phase: 'upstream' } });
      expect(JSON.stringify(asked)).toContain('Nothing is wrong with the arguments');
    });
  }
});
