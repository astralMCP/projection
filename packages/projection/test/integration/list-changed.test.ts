/**
 * Following `notifications/tools/list_changed` (R65, DECISIONS D43) end to
 * end, over REAL in-process McpServers that add, remove and re-annotate
 * tools after the wrap: the catalog, types, policy (rules included) and
 * direct listing follow; a dirty box is decided with its annotations
 * distrusted; an in-flight request never auto-runs off a stale snapshot; a
 * resume across a removal fails closed; a notification storm costs a
 * bounded number of re-listings; one box's change never touches another.
 */

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer, type RegisteredTool } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  wrapMcpServer,
  wrapMcpServers,
  type MultiProjectionFacade,
  type ProjectionFacade,
  type WrapOptions,
} from '../../src/index.js';
import { ListChangeTracker } from '../../src/facade/follow.js';
import { Introspector } from '../../src/introspector/index.js';
import { MRTR_PROTOCOL_REVISION } from '../../src/mrtr/index.js';
import { ACCEPT, isSuspended, requestKeys, sealedState, structured } from '../mrtr/helpers.js';
import { KEY } from '../multi/helpers.js';

/** Fast timing for tests: the defaults are 250 ms / 2 s. */
const FAST: NonNullable<WrapOptions['followListChanged']> = { debounceMs: 0, minIntervalMs: 100 };

let open: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const item of open.reverse()) await item.close();
  open = [];
  vi.restoreAllMocks();
});

type Annotations = { readOnlyHint?: boolean; destructiveHint?: boolean };

/** A server whose tools change after the wrap, like a Pipedream app being enabled. */
function mutableServer(name = 'apps') {
  const server = new McpServer({ name, version: '1.0.0' });
  const calls: string[] = [];
  const handles = new Map<string, RegisteredTool>();
  const add = (tool: string, annotations: Annotations, description = `The ${tool} tool.`) => {
    handles.set(
      tool,
      server.registerTool(
        tool,
        { description, inputSchema: z.object({ to: z.string().optional() }), annotations },
        () => {
          calls.push(tool);
          return { content: [{ type: 'text' as const, text: `${tool} ran` }] };
        },
      ),
    );
  };
  add('list_labels', { readOnlyHint: true });
  add('send_email', { readOnlyHint: false });
  return {
    server,
    calls,
    add,
    remove: (tool: string) => {
      handles.get(tool)?.remove();
      handles.delete(tool);
    },
    reannotate: (tool: string, annotations: Annotations) =>
      handles.get(tool)?.update({ annotations }),
    /** A bare notification, no change (a spammy server). */
    spam: () => server.sendToolListChanged(),
  };
}

async function wrap(
  up: ReturnType<typeof mutableServer>,
  options: Partial<WrapOptions> = {},
): Promise<ProjectionFacade> {
  const facade = await wrapMcpServer(up.server, {
    blob: { key: KEY },
    followListChanged: FAST,
    ...options,
  });
  open.push(facade);
  return facade;
}

/** Resolves once a facade has heard `count` tools/list_changed notifications in this test. */
function heard(count = 1): Promise<void> {
  const spy = vi.spyOn(ListChangeTracker.prototype, 'notify');
  return vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThanOrEqual(count));
}

function searchNames(f: { searchTools(args: object): unknown }, query?: string): string[] {
  const result = structured(
    f.searchTools(query !== undefined ? { query } : {}) as Parameters<typeof structured>[0],
  );
  return (result['tools'] as { name: string }[]).map((tool) => tool.name);
}

function posture(f: ProjectionFacade, name: string): unknown {
  return structured(f.describeTool({ name }))['posture'];
}

/** A held (stdio-style) connection to the facade, recording list_changed. */
async function heldClient(facade: { serverFactory: ProjectionFacade['serverFactory'] }) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const served = serveStdio(facade.serverFactory, { transport: serverTransport });
  let notified = 0;
  const client = new Client(
    { name: 'held', version: '1.0.0' },
    {
      versionNegotiation: { mode: { pin: MRTR_PROTOCOL_REVISION } },
      listChanged: {
        tools: {
          autoRefresh: false,
          onChanged: () => {
            notified += 1;
          },
        },
      },
    },
  );
  await client.connect(clientTransport);
  open.push({ close: () => client.close().then(() => served.close()) });
  return { client, notified: () => notified };
}

function machine(tools: string[]): string {
  const states = tools
    .map(
      (tool, index) => `
    s${index}: {
      entry: toolCall('${tool}', () => ({}), { id: 'c${index}' }),
      on: {
        TOOL_RESULT: { target: '${index + 1 < tools.length ? `s${index + 1}` : 'done'}', actions: assign({ log: ({ context }) => [...context.log, '${tool}:ran'] }) },
        TOOL_ERROR: { target: '${index + 1 < tools.length ? `s${index + 1}` : 'done'}', actions: assign({ log: ({ context, event }) => [...context.log, '${tool}:error:' + event.error.message] }) },
        TOOL_DENIED: { target: 'done', actions: assign({ log: ({ context }) => [...context.log, '${tool}:denied'] }) },
      },
    },`,
    )
    .join('');
  return `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'm',
  context: { log: [] },
  initial: 's0',
  states: {${states}
    done: { type: 'final' },
  },
  output: ({ context }) => ({ log: context.log }),
});
`;
}

describe('catalog projection follows the server (R65)', () => {
  it('a new tool is searchable, typed, described and callable under its policy', async () => {
    const up = mutableServer();
    const f = await wrap(up, { projections: { direct: false } });
    expect(searchNames(f, 'archive')).toEqual([]);

    up.add('archive_thread', { readOnlyHint: true }, 'Archive a thread.');
    await vi.waitFor(() => expect(searchNames(f, 'archive')).toEqual(['archive_thread']));
    expect(f.dts).toContain('archive_thread');
    expect(f.catalog.tools.map((tool) => tool.name)).toContain('archive_thread');
    expect(posture(f, 'archive_thread')).toBe('runs immediately');
    const ran = await f.callTool({ name: 'archive_thread', args: {} }, 'modern');
    expect(structured(ran)['status']).toBe('ok');

    // A new write tool asks, as it would have at wrap time.
    up.add('delete_thread', { destructiveHint: true });
    await vi.waitFor(() => expect(searchNames(f, 'delete_thread')[0]).toBe('delete_thread'));
    const del = await f.callTool({ name: 'delete_thread', args: {} }, 'modern');
    expect(requestKeys(del)).toEqual(['call']);
    expect(up.calls).toEqual(['archive_thread']);
  });

  it('policyRules are re-run on new tools', async () => {
    const up = mutableServer();
    const f = await wrap(up, {
      projections: { direct: false },
      policyRules: [
        { match: '*-send-*', decision: 'deny' },
        (tool) => (tool.name.startsWith('pinned-') ? 'ask' : undefined),
      ],
    });
    up.add('gmail-send-email', { readOnlyHint: false, destructiveHint: false });
    up.add('pinned-lookup', { readOnlyHint: true });
    await vi.waitFor(() => expect(searchNames(f, 'pinned')).toEqual(['pinned-lookup']));
    expect(posture(f, 'gmail-send-email')).toBe('blocked by policy');
    expect(posture(f, 'pinned-lookup')).toBe('asks for approval');
    const sent = await f.callTool({ name: 'gmail-send-email', args: {} }, 'modern');
    expect(structured(sent)['status']).toBe('denied_by_policy');
    expect(isSuspended(await f.callTool({ name: 'pinned-lookup', args: {} }, 'modern'))).toBe(true);
    expect(up.calls).toEqual([]);
  });

  it('a tool re-annotated from read-only to write is never run unapproved', async () => {
    const up = mutableServer();
    up.add('flip', { readOnlyHint: true });
    const f = await wrap(up, { projections: { direct: false } });
    expect(structured(await f.callTool({ name: 'flip', args: {} }, 'modern'))['status']).toBe('ok');

    up.reannotate('flip', { readOnlyHint: false });
    await vi.waitFor(() => expect(posture(f, 'flip')).toBe('asks for approval'));
    const after = await f.callTool({ name: 'flip', args: {} }, 'modern');
    expect(requestKeys(after)).toEqual(['call']);
    expect(up.calls).toEqual(['flip']);
  });

  it('while a re-listing is outstanding, the box is decided with its annotations distrusted', async () => {
    const up = mutableServer();
    up.add('flip', { readOnlyHint: true });
    // A re-listing that will not land during the test: the box stays dirty.
    const f = await wrap(up, {
      projections: { direct: false },
      policy: { list_labels: 'auto' },
      followListChanged: { debounceMs: 60_000 },
    });
    const notified = heard();
    up.reannotate('flip', { readOnlyHint: false });
    await notified;
    expect(isSuspended(await f.callTool({ name: 'flip', args: {} }, 'modern'))).toBe(true);
    // An exact-name override is the integrator's word, not the server's: kept.
    const labels = await f.callTool({ name: 'list_labels', args: {} }, 'modern');
    expect(structured(labels)['status']).toBe('ok');
    expect(up.calls).toEqual(['list_labels']);
  });

  it('an in-flight request does not auto-run a call off the snapshot it started with', async () => {
    const up = mutableServer();
    up.add('flip', { readOnlyHint: true });
    const holder: { facade?: ProjectionFacade } = {};
    // `step` re-annotates flip mid-request and returns once the facade has
    // heard of it (a fresh request is then asked to approve flip). The
    // machine decided flip from the snapshot it started with: `auto`.
    up.server.registerTool(
      'step',
      { description: 'Step.', inputSchema: z.object({}), annotations: { readOnlyHint: true } },
      async () => {
        const notified = heard();
        up.reannotate('flip', { readOnlyHint: false });
        await notified;
        const facade = holder.facade as ProjectionFacade;
        expect(isSuspended(await facade.callTool({ name: 'flip', args: {} }, 'modern'))).toBe(true);
        return { content: [{ type: 'text' as const, text: 'stepped' }] };
      },
    );
    holder.facade = await wrap(up, {
      projections: { direct: false },
      followListChanged: { debounceMs: 60_000 },
    });
    const result = await holder.facade.executeMachine(
      { code: machine(['step', 'flip']) },
      'modern',
    );
    const log = (structured(result)['output'] as { log: string[] }).log;
    expect(log[0]).toBe('step:ran');
    expect(log[1]).toMatch(/^flip:error:.*tool list changed/);
    expect(up.calls).toEqual([]);
  });

  it('a resume across a removal fails closed', async () => {
    const up = mutableServer();
    const f = await wrap(up, { projections: { direct: false } });
    const first = await f.callTool({ name: 'send_email', args: { to: 'a' } }, 'modern');
    expect(requestKeys(first)).toEqual(['call']);

    up.remove('send_email');
    await vi.waitFor(() => expect(searchNames(f, 'send_email')).toEqual([]));
    const retry = await f.callTool(
      {
        name: 'send_email',
        args: { to: 'a' },
        requestState: sealedState(first),
        inputResponses: { call: ACCEPT },
      },
      'modern',
    );
    expect(structured(retry)['phase']).toBe('validate');
    expect(up.calls).toEqual([]);
  });

  it('a blob minted against a newer catalog fails safely on an instance with an older one', async () => {
    // Two instances behind a load balancer: same key, same server identity.
    const newer = mutableServer();
    const older = mutableServer();
    const a = await wrap(newer, { projections: { direct: false } });
    const b = await wrap(older, { projections: { direct: false }, followListChanged: false });
    newer.add('post_note', { readOnlyHint: false });
    await vi.waitFor(() => expect(searchNames(a, 'post_note')).toEqual(['post_note']));
    const first = await a.callTool({ name: 'post_note', args: {} }, 'modern');
    expect(requestKeys(first)).toEqual(['call']);

    const elsewhere = await b.callTool(
      {
        name: 'post_note',
        args: {},
        requestState: sealedState(first),
        inputResponses: { call: ACCEPT },
      },
      'modern',
    );
    expect(elsewhere.isError).toBe(true);
    expect(structured(elsewhere)['phase']).toBe('validate');
    expect(newer.calls).toEqual([]);
    expect(older.calls).toEqual([]);
  });

  it('a re-listing that cannot be applied keeps the box distrusted, and refreshTools reports it', async () => {
    const up = mutableServer();
    const f = await wrap(up, {
      projections: { direct: false },
      followListChanged: { debounceMs: 0, minIntervalMs: 100 },
      policyRules: [
        (tool) => {
          if (tool.name === 'bad') throw new Error('rule cannot decide');
          return undefined;
        },
      ],
    });
    const relist = vi.spyOn(Introspector.prototype, 'relist');
    up.add('bad', { readOnlyHint: true });
    await vi.waitFor(() => expect(relist).toHaveBeenCalled());
    await relist.mock.results[0]?.value;
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The new catalog could not be applied: the old one stays, distrusted.
    expect(searchNames(f, 'bad')).toEqual([]);
    expect(isSuspended(await f.callTool({ name: 'list_labels', args: {} }, 'modern'))).toBe(true);
    expect(up.calls).toEqual([]);
    await expect(f.refreshTools()).rejects.toThrow(/rule/);
  });

  it('refreshTools re-lists on demand, e.g. for a Client the facade does not subscribe', async () => {
    const up = mutableServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await up.server.connect(serverTransport);
    const client = new Client({ name: 'mine', version: '1.0.0' });
    await client.connect(clientTransport);
    open.push(client);
    const f = await wrapMcpServer(client, { blob: { key: KEY }, followListChanged: FAST });
    open.push(f);
    up.add('late', { readOnlyHint: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(searchNames(f, 'late')).toEqual([]);
    await f.refreshTools();
    expect(searchNames(f, 'late')).toEqual(['late']);
    await expect(f.refreshTools('x')).rejects.toMatchObject({ phase: 'validate' });
  });
});

describe('direct listing follows the server (R65)', () => {
  it('a held connection is sent tools/list_changed and lists the new tool', async () => {
    const up = mutableServer();
    const f = await wrap(up, { projections: { direct: true } });
    let heard = 0;
    f.onToolsChanged(() => {
      heard += 1;
    });
    const held = await heldClient(f);
    const before = (await held.client.listTools()).tools.map((tool) => tool.name);
    expect(before).toContain('send_email');
    expect(before).not.toContain('fresh_tool');

    up.add('fresh_tool', { readOnlyHint: true });
    await vi.waitFor(() => expect(held.notified()).toBeGreaterThan(0));
    const after = (await held.client.listTools()).tools;
    const fresh = after.find((tool) => tool.name === 'fresh_tool');
    expect(fresh?.description).toMatch(/^\[runs immediately\]/);
    expect(fresh?.annotations).toEqual({ readOnlyHint: true });
    expect(heard).toBe(1);
    const ran = await held.client.callTool({ name: 'fresh_tool', arguments: {} });
    expect(ran.isError).not.toBe(true);
    expect(up.calls).toEqual(['fresh_tool']);

    up.remove('fresh_tool');
    await vi.waitFor(async () =>
      expect((await held.client.listTools()).tools.map((tool) => tool.name)).not.toContain(
        'fresh_tool',
      ),
    );
    expect(heard).toBe(2);
    // A new server (one request behind createMcpHandler) lists the current set.
    const fresh2 = await heldClient(f);
    expect((await fresh2.client.listTools()).tools.map((tool) => tool.name)).not.toContain(
      'fresh_tool',
    );
  });

  it('a re-annotation updates the listed posture and annotations', async () => {
    const up = mutableServer();
    up.add('flip', { readOnlyHint: true });
    const f = await wrap(up, { projections: { direct: true } });
    const held = await heldClient(f);
    up.reannotate('flip', { readOnlyHint: false });
    await vi.waitFor(async () => {
      const flip = (await held.client.listTools()).tools.find((tool) => tool.name === 'flip');
      expect(flip?.description).toMatch(/^\[asks for approval\]/);
      expect(flip?.annotations).toEqual({});
    });
  });

  it('the surface is pinned: a catalog that outgrows the auto budget stays listed', async () => {
    const up = mutableServer();
    const f = await wrap(up, { projections: { direct: 'auto', directBudgetTokens: 400 } });
    expect(f.projections.direct).toBe(true);
    for (let i = 0; i < 20; i += 1) up.add(`bulk_${i}`, { readOnlyHint: true }, 'x'.repeat(200));
    await vi.waitFor(() => expect(f.catalog.tools.length).toBe(22));
    const held = await heldClient(f);
    const names = (await held.client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('bulk_19');
    expect(names).not.toContain('search_tools');
    expect(f.projections.direct).toBe(true);
  });

  it('no notification and no listener call when nothing listed changed', async () => {
    const up = mutableServer();
    const f = await wrap(up, { projections: { direct: true } });
    let heard = 0;
    f.onToolsChanged(() => {
      heard += 1;
    });
    const held = await heldClient(f);
    up.spam();
    await f.refreshTools();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(held.notified()).toBe(0);
    expect(heard).toBe(0);
  });
});

describe('notification storms are bounded (R65)', () => {
  it('debounces, coalesces and rate-caps the re-listings', async () => {
    const up = mutableServer();
    const f = await wrap(up, {
      projections: { direct: false },
      followListChanged: { debounceMs: 20, minIntervalMs: 200 },
    });
    const relist = vi.spyOn(Introspector.prototype, 'relist');
    const started = Date.now();
    for (let i = 0; i < 300; i += 1) {
      up.spam();
      if (i % 30 === 0) await new Promise((resolve) => setTimeout(resolve, 60));
    }
    up.add('last_one', { readOnlyHint: true });
    await vi.waitFor(() => expect(searchNames(f, 'last_one')).toEqual(['last_one']), {
      timeout: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const elapsed = Date.now() - started;
    // At most one cycle per 200 ms, plus the first and the trailing one.
    expect(relist.mock.calls.length).toBeLessThanOrEqual(Math.ceil(elapsed / 200) + 2);
    expect(relist.mock.calls.length).toBeLessThan(20);
  });
});

describe('a multi-server facade follows each box on its own (R65)', () => {
  async function boxes(): Promise<{
    f: MultiProjectionFacade;
    mail: ReturnType<typeof mutableServer>;
    docs: ReturnType<typeof mutableServer>;
  }> {
    const mail = mutableServer('mail');
    const docs = mutableServer('docs');
    const f = await wrapMcpServers(
      { mail: mail.server, docs: docs.server },
      {
        blob: { key: KEY },
        projections: { direct: false },
        followListChanged: { debounceMs: 60_000 },
      },
    );
    open.push(f);
    return { f, mail, docs };
  }

  it("one box's dirty window leaves the other box decided exactly as before", async () => {
    const { f, mail, docs } = await boxes();
    const notified = heard();
    docs.reannotate('list_labels', { readOnlyHint: false });
    await notified;
    // While docs is dirty, its read-only tool asks and mail's still runs.
    expect(isSuspended(await f.callTool({ name: 'docs.list_labels', args: {} }, 'modern'))).toBe(
      true,
    );
    const mailRun = await f.callTool({ name: 'mail.list_labels', args: {} }, 'modern');
    expect(structured(mailRun)['status']).toBe('ok');
    expect(mail.calls).toEqual(['list_labels']);
    expect(docs.calls).toEqual([]);
  });

  it('a refreshed box changes under its own alias only', async () => {
    const mail = mutableServer('mail');
    const docs = mutableServer('docs');
    const f = await wrapMcpServers(
      { mail: mail.server, docs: docs.server },
      { blob: { key: KEY }, projections: { direct: false }, followListChanged: FAST },
    );
    open.push(f);
    const mailBefore = f.catalog.servers.get('mail');
    // docs relaxes its own send_email and adds a tool: neither reaches mail.
    docs.reannotate('send_email', { readOnlyHint: true });
    docs.add('fresh', { readOnlyHint: true });
    await vi.waitFor(() => expect(searchNames(f, 'fresh')).toEqual(['docs.fresh']));
    expect(f.catalog.servers.get('mail')).toBe(mailBefore);
    const sent = await f.callTool({ name: 'mail.send_email', args: {} }, 'modern');
    expect(requestKeys(sent)).toEqual(['call']);
    const docsSent = await f.callTool({ name: 'docs.send_email', args: {} }, 'modern');
    expect(structured(docsSent)['status']).toBe('ok');
    expect(f.dts).toContain('fresh');
    expect(mail.calls).toEqual([]);
    expect(docs.calls).toEqual(['send_email']);
  });
});

describe('followListChanged option', () => {
  it.each([
    [{ debounceMs: -1 }],
    [{ minIntervalMs: 10 }],
    [{ debounceMs: 1.5 }],
    [{ other: 1 }],
    ['yes'],
    [null],
  ])('rejects %j before connecting', async (value) => {
    const up = mutableServer();
    await expect(
      wrapMcpServer(up.server, {
        blob: { key: KEY },
        followListChanged: value as NonNullable<WrapOptions['followListChanged']>,
      }),
    ).rejects.toMatchObject({ phase: 'validate' });
    expect(up.server.isConnected()).toBe(false);
  });
});
