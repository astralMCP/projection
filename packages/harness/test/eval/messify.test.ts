/**
 * `messify` and its defect profiles, offline (no network, no model, no
 * clock): each defect's transform of the surface and of the results, the
 * mapping of a degraded call back to the wrapped server's canonical one,
 * and the generated 315-tool billing catalog. Every profile is exercised
 * through a real in-memory MCP connection as well as on the pure
 * functions, over the workplace fakes and over the GitHub fake.
 */

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  billingOperations,
  createBillingBox,
  driftOutputSchema,
  extractNextPage,
  githubWorld,
  hostToolName,
  inflate,
  messify,
  messySurface,
  oneWord,
  openWorld,
  openSession,
  pydanticSchema,
  pythonRepr,
  seedBilling,
  stripPropertyDescriptions,
  untypeProperties,
  MESSY_BOX_DESCRIPTIONS,
  MESSY_PROFILES,
  type MessyProfile,
  type MultiWorld,
  type ServerWorld,
  type WorldTool,
} from '../../src/index.js';
import { createTrackerBox, seedTracker } from '../../src/eval/workplace-tracker.js';
import { createChatBox, seedChat, CHANNELS } from '../../src/eval/workplace-chat.js';

// ---------------------------------------------------------------------------
// Harness

function trackerWorld(): ServerWorld {
  const box = createTrackerBox(seedTracker());
  return {
    name: 'tracker',
    server: box.server,
    tools: box.tools,
    instructions: box.instructions,
    calls: box.calls,
    facts: {},
    hostSystemPrompt: 'host',
    close: async () => {},
  };
}

function chatWorld(): ServerWorld {
  const box = createChatBox(seedChat());
  return {
    name: 'chat',
    server: box.server,
    tools: box.tools,
    instructions: box.instructions,
    calls: box.calls,
    facts: {},
    hostSystemPrompt: 'host',
    close: async () => {},
  };
}

interface Connected {
  world: ServerWorld;
  client: Client;
  call(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{
    text: string;
    isError: boolean;
    structuredContent?: unknown;
  }>;
  close(): Promise<void>;
}

/** Messify `inner` with `profile` and connect a client to the messy server, as a host would. */
async function connect(inner: ServerWorld, profile: MessyProfile): Promise<Connected> {
  const world = await messify(inner, profile);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await world.server.connect(st);
  await client.connect(ct);
  await client.listTools();
  return {
    world,
    client,
    call: async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      const blocks = (r.content ?? []) as { type: string; text?: string }[];
      return {
        text: blocks.map((b) => b.text ?? '').join('\n'),
        isError: r.isError === true,
        ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}),
      };
    },
    close: async () => {
      await client.close();
      await world.close();
    },
  };
}

const open: Connected[] = [];
async function connected(inner: ServerWorld, profile: MessyProfile): Promise<Connected> {
  const c = await connect(inner, profile);
  open.push(c);
  return c;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
  vi.restoreAllMocks();
});

function served(world: ServerWorld, name: string): WorldTool {
  const tool = world.tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool;
}

const ISSUE_SCHEMA = {
  type: 'object',
  properties: {
    issue_id: { type: 'string', description: 'The issue' },
    priority: { type: 'string', enum: ['low', 'high'], description: 'How urgent' },
    filter: {
      type: 'object',
      description: 'A filter',
      properties: { state: { type: 'string' } },
    },
    tags: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
  },
  required: ['issue_id'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Pure transforms

describe('schema transforms', () => {
  it('strips every property description and title, nested ones included', () => {
    const out = stripPropertyDescriptions(ISSUE_SCHEMA);
    expect(JSON.stringify(out)).not.toContain('description');
    expect(out['required']).toEqual(['issue_id']);
  });

  it('untyped: properties lose `type`, the top level keeps `type: object`', () => {
    const out = untypeProperties(ISSUE_SCHEMA);
    const props = out['properties'] as Record<string, Record<string, unknown>>;
    expect(out['type']).toBe('object');
    expect(Object.values(props).every((p) => !('type' in p))).toBe(true);
    expect(props['issue_id']?.['description']).toBe('The issue');
  });

  it('pydantic: anyOf-null optionals with default and title, $defs behind $ref, oneOf const enums', () => {
    const out = pydanticSchema(ISSUE_SCHEMA, 'get_issue');
    const props = out['properties'] as Record<string, Record<string, unknown>>;
    const defs = out['$defs'] as Record<string, Record<string, unknown>>;
    expect(out['title']).toBe('GetIssueArguments');
    expect(out['additionalProperties']).toBeUndefined();
    // Required: plain, titled.
    expect(props['issue_id']).toEqual({
      type: 'string',
      description: 'The issue',
      title: 'Issue Id',
    });
    // Optional enum: anyOf [$ref, null], description kept outside.
    expect(props['priority']).toEqual({
      anyOf: [{ $ref: '#/$defs/Priority' }, { type: 'null' }],
      default: null,
      description: 'How urgent',
      title: 'Priority',
    });
    expect(defs['Priority']?.['oneOf']).toEqual([
      { const: 'low', title: 'low' },
      { const: 'high', title: 'high' },
    ]);
    // Nested object hoisted.
    expect((props['filter']?.['anyOf'] as unknown[] | undefined)?.[0]).toEqual({
      $ref: '#/$defs/Filter',
    });
    expect(defs['Filter']?.['properties']).toEqual({ state: { type: 'string' } });
    // Array of objects: items hoisted.
    expect(
      (props['tags']?.['anyOf'] as Record<string, unknown>[] | undefined)?.[0]?.['items'],
    ).toEqual({
      $ref: '#/$defs/TagsItem',
    });
  });

  it('output drift: property names case-flipped, nothing required', () => {
    const out = driftOutputSchema({
      type: 'object',
      properties: {
        updatedAt: { type: 'string' },
        page_info: {
          type: 'object',
          properties: { endCursor: { type: 'string' } },
          required: ['endCursor'],
        },
        id: { type: 'string' },
      },
      required: ['id', 'updatedAt'],
    });
    expect(out).toEqual({
      type: 'object',
      properties: {
        updated_at: { type: 'string' },
        pageInfo: { type: 'object', properties: { end_cursor: { type: 'string' } } },
        id: { type: 'string' },
      },
    });
  });

  it('one-word descriptions are the last word of the name', () => {
    expect(oneWord('list_issues')).toBe('Issues');
    expect(oneWord('getChannelHistory')).toBe('History');
    expect(oneWord('get')).toBe('Get');
  });
});

describe('result transforms', () => {
  it('repr renders a dict the way Python prints one', () => {
    expect(pythonRepr({ id: 'a', ok: true, n: 2, none: null, l: ["it's"] })).toBe(
      `{'id': 'a', 'ok': True, 'n': 2, 'none': None, 'l': ["it's"]}`,
    );
  });

  it('inflate pads the first array of objects past the target size, keeping the data', () => {
    const value = { ok: true, messages: [{ text: 'a' }, { text: 'b' }], meta: { x: 1 } };
    const out = inflate(structuredClone(value), 100_000) as typeof value;
    expect(JSON.stringify(out).length).toBeGreaterThanOrEqual(100_000);
    expect(out.messages.map((m) => m.text)).toEqual(['a', 'b']);
    expect(out.meta).toEqual({ x: 1 });
    // Deterministic.
    expect(JSON.stringify(inflate(structuredClone(value), 100_000))).toBe(JSON.stringify(out));
  });

  it('extractNextPage takes every common next-page shape out of the JSON', () => {
    expect(
      extractNextPage({ issues: [], pageInfo: { hasNextPage: true, endCursor: 'c1' } }),
    ).toEqual({ value: { issues: [] }, token: 'c1' });
    expect(
      extractNextPage({ ok: true, has_more: false, response_metadata: { next_cursor: '' } }),
    ).toEqual({ value: { ok: true }, token: '' });
    expect(extractNextPage({ items: [] })).toEqual({ value: { items: [] }, token: undefined });
  });
});

// ---------------------------------------------------------------------------
// Each defect through a real connection

describe('each defect, over a wrapped workplace fake', () => {
  it('descriptions: none, one-word and verbose (several KB of usage docs)', () => {
    const tools = trackerWorld().tools;
    const none = messySurface(tools, {
      name: 'x',
      defects: [{ kind: 'descriptions', style: 'none' }],
    });
    const one = messySurface(tools, {
      name: 'x',
      defects: [{ kind: 'descriptions', style: 'one-word' }],
    });
    const verbose = messySurface(tools, {
      name: 'x',
      defects: [{ kind: 'descriptions', style: 'verbose', tools: ['list_issues'] }],
    });
    expect(none.every((t) => t.served.description === '')).toBe(true);
    expect(one.find((t) => t.canonical === 'list_issues')?.served.description).toBe('Issues');
    const long = verbose.find((t) => t.canonical === 'list_issues')?.served.description ?? '';
    expect(long.length).toBeGreaterThan(4_000);
    expect(long).toContain('### `after`');
    // Only the named tool.
    expect(verbose.find((t) => t.canonical === 'get_issue')?.served.description).toBe(
      'Retrieve an issue by identifier or ID, with its description',
    );
  });

  it('annotations: none drops them all (and the title); no-read-only keeps the other hints', () => {
    const tools = trackerWorld().tools;
    const none = messySurface(tools, {
      name: 'x',
      defects: [{ kind: 'annotations', style: 'none' }],
    });
    expect(none.every((t) => t.served.annotations === undefined)).toBe(true);
    const partial = messySurface(tools, {
      name: 'x',
      defects: [{ kind: 'annotations', style: 'no-read-only' }],
    });
    const create = partial.find((t) => t.canonical === 'create_issue')?.served.annotations;
    expect(create).toEqual({
      title: 'Create issue',
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(partial.every((t) => t.served.annotations?.readOnlyHint === undefined)).toBe(true);
  });

  it('rename and arg-case: the call maps back to the canonical tool and arguments', async () => {
    const c = await connected(trackerWorld(), {
      name: 'x',
      defects: [
        { kind: 'rename', names: { list_comments: 'list', create_comment: 'create' } },
        { kind: 'arg-case', style: 'snake', tools: ['list_comments'] },
      ],
    });
    const list = served(c.world, 'list');
    expect(Object.keys(list.inputSchema['properties'] as object)).toEqual(['issue_id']);
    expect(list.inputSchema['required']).toEqual(['issue_id']);
    // The other tool keeps camelCase: inconsistent, as servers are.
    expect(Object.keys(served(c.world, 'create').inputSchema['properties'] as object)).toContain(
      'issueId',
    );
    const r = await c.call('list', { issue_id: 'BE-152' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Globex reported this one too');
    expect(c.world.calls).toEqual([{ tool: 'list_comments', args: { issueId: 'BE-152' } }]);
  });

  it('strict by default: an argument under the other casing is refused, not forwarded', async () => {
    const c = await connected(trackerWorld(), {
      name: 'x',
      defects: [{ kind: 'arg-case', style: 'snake', tools: ['list_comments'] }],
    });
    const r = await c.call('list_comments', { issue_id: 'BE-152', issueId: 'BE-152' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Unrecognized key: "issueId"/);
    expect(c.world.calls).toEqual([]);
  });

  it('loose-args: no additionalProperties false, and an unknown argument is dropped silently', async () => {
    const c = await connected(trackerWorld(), { name: 'x', defects: [{ kind: 'loose-args' }] });
    expect(served(c.world, 'list_issues').inputSchema['additionalProperties']).toBeUndefined();
    const r = await c.call('list_issues', { team: 'BE', status: 'Done' });
    expect(r.isError).toBe(false);
    // `status` is not a filter: the server ignored it and answered unfiltered.
    expect(c.world.calls).toEqual([{ tool: 'list_issues', args: { team: 'BE' } }]);
    expect(r.text).toContain('"state": "Todo"');
  });

  it('pydantic schemas: an explicit null is "not given"', async () => {
    const c = await connected(trackerWorld(), {
      name: 'x',
      defects: [{ kind: 'schema', style: 'pydantic', tools: ['list_issues'] }],
    });
    const schema = served(c.world, 'list_issues').inputSchema;
    expect(schema['title']).toBe('ListIssuesArguments');
    const r = await c.call('list_issues', { team: 'BE', label: null, first: 2 });
    expect(r.isError).toBe(false);
    expect(c.world.calls).toEqual([{ tool: 'list_issues', args: { team: 'BE', first: 2 } }]);
  });

  it('errors-as-text: a refusal arrives as an ordinary result starting "Error:", names renamed', async () => {
    const c = await connected(trackerWorld(), {
      name: 'x',
      defects: [
        { kind: 'errors-as-text' },
        { kind: 'rename', names: { get_transitions: 'transitions' } },
      ],
    });
    const r = await c.call('transition_issue', { id: 'BE-127', transitionId: '41' });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^Error: Transition 41 is not valid for BE-127 in state "Todo"\./);
    const u = await c
      .call('update_issue', { id: 'BE-127', state: 'Done', title: 'x' })
      .catch((e: unknown) => e);
    // On a tool that declares a strict output schema, a validating client
    // rejects the error body: the real error never reaches the model.
    expect(String(u)).toMatch(/Structured content does not match the tool's output schema/);
    const v = await connected(trackerWorld(), {
      name: 'y',
      defects: [
        { kind: 'errors-as-text' },
        { kind: 'rename', names: { transition_issue: 'move' } },
        { kind: 'output-drift' },
      ],
    });
    // With a drifted (nothing-required) schema the error body passes, renamed names and all.
    const w = await v.call('update_issue', { id: 'BE-127', state: 'Done' });
    expect(w.isError).toBe(false);
    expect(w.text).toMatch(/^Error: Workflow state cannot be set directly\. .* and then move\.$/);
  });

  it('results text-json and repr: no output schema, no structuredContent, one text block', async () => {
    const json = await connected(trackerWorld(), {
      name: 'x',
      defects: [{ kind: 'results', style: 'text-json' }],
    });
    expect(served(json.world, 'get_issue').outputSchema).toBeUndefined();
    const a = await json.call('get_issue', { id: 'BE-127' });
    expect(a.structuredContent).toBeUndefined();
    expect(a.text.startsWith('{"id":')).toBe(true);
    expect(a.text).not.toContain('\n');

    const repr = await connected(trackerWorld(), {
      name: 'x',
      defects: [{ kind: 'results', style: 'repr' }],
    });
    const b = await repr.call('get_issue', { id: 'BE-127' });
    expect(b.structuredContent).toBeUndefined();
    expect(b.text).toMatch(/^\{'id': 'iss_[0-9a-f]+', 'identifier': 'BE-127'/);
    expect(b.text).toContain("'assignee': {'id': ");
  });

  it('output-drift: the declared schema no longer matches, yet a validating client accepts the result', async () => {
    const c = await connected(trackerWorld(), { name: 'x', defects: [{ kind: 'output-drift' }] });
    const schema = served(c.world, 'get_issue').outputSchema as Record<string, unknown>;
    const props = Object.keys(schema['properties'] as object);
    expect(props).toContain('updated_at');
    expect(props).not.toContain('updatedAt');
    expect(schema['required']).toBeUndefined();
    const r = await c.call('get_issue', { id: 'BE-127' });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({
      identifier: 'BE-127',
      updatedAt: expect.any(String),
    });
    expect(r.structuredContent).not.toHaveProperty('updated_at');
  });

  it('huge-results: 100 KB+ of compact JSON, the data intact', async () => {
    const c = await connected(chatWorld(), {
      name: 'x',
      defects: [{ kind: 'huge-results', bytes: 100_000, tools: ['get_channel_history'] }],
    });
    const r = await c.call('get_channel_history', { channel_id: CHANNELS.engBackend.id });
    expect(r.text.length).toBeGreaterThanOrEqual(100_000);
    const parsed = JSON.parse(r.text) as { messages: { text: string }[] };
    expect(parsed.messages[0]?.text).toBe('notify-svc dashboards are back.');
    // Other tools stay small.
    const users = await c.call('get_users', {});
    expect(users.text.length).toBeLessThan(10_000);
  });

  it('pagination-trailer: the token leaves the JSON for a prose line, and still works', async () => {
    const c = await connected(trackerWorld(), {
      name: 'x',
      defects: [{ kind: 'pagination-trailer', tools: ['list_issues'] }],
    });
    const first = await c.call('list_issues', { team: 'BE' });
    expect(first.text).not.toContain('pageInfo');
    const token = /Next page token: (\S+)$/.exec(first.text)?.[1];
    expect(token).toBeDefined();
    const second = await c.call('list_issues', { team: 'BE', after: token });
    expect(second.isError).toBe(false);
    expect(second.text).toContain('Next page token');
    // The last page has no trailer.
    const last = await c.call('list_issues', { team: 'OPS' });
    expect(last.text).not.toContain('Next page token');
  });

  it('instructions: none removes them, rambling buries the tip in several KB', async () => {
    const withInstr: ServerWorld = { ...trackerWorld(), instructions: 'Use transition_issue.' };
    const none = await connected(withInstr, {
      name: 'x',
      defects: [{ kind: 'instructions', style: 'none' }],
    });
    expect(none.world.instructions).toBeUndefined();
    expect(none.client.getInstructions()).toBeUndefined();
    const rambling = await connected(trackerWorld(), {
      name: 'x',
      defects: [
        { kind: 'instructions', style: 'rambling', product: 'Tracker', tip: 'IDs look like BE-1.' },
      ],
    });
    const text = rambling.client.getInstructions() ?? '';
    expect(text.length).toBeGreaterThan(2_500);
    expect(text).toContain('IDs look like BE-1.');
    expect(text.indexOf('IDs look like BE-1.')).toBeGreaterThan(text.length / 4);
  });

  it('latency: the call waits the configured time before it is answered', async () => {
    const c = await connected(trackerWorld(), {
      name: 'x',
      defects: [{ kind: 'latency', ms: 5, tools: ['list_teams'] }],
    });
    const spy = vi.spyOn(globalThis, 'setTimeout');
    await c.call('list_teams', {});
    expect(spy.mock.calls.some((args) => args[1] === 5)).toBe(true);
    spy.mockClear();
    await c.call('list_users', {});
    expect(spy.mock.calls.some((args) => args[1] === 5)).toBe(false);
  });

  it('applies to the GitHub fake too: renamed, terse, errors as text', async () => {
    const c = await connected(githubWorld(), {
      name: 'gh',
      defects: [
        { kind: 'rename', names: { search_issues: 'search' } },
        { kind: 'descriptions', style: 'one-word' },
        { kind: 'errors-as-text' },
        { kind: 'annotations', style: 'none' },
      ],
    });
    expect(c.world.tools.length).toBe(95);
    expect(served(c.world, 'search').description).toBe('Issues');
    const r = await c.call('search', { query: 'repo:acme/widgets is:issue is:open' });
    expect(r.isError).toBe(false);
    expect(c.world.calls[0]?.tool).toBe('search_issues');
  });
});

// ---------------------------------------------------------------------------
// The billing catalog and the messy world

describe('the generated billing catalog', () => {
  const ops = billingOperations();

  it('has 300+ unique operationId tools that fit a host name, and no annotations', () => {
    expect(ops.length).toBeGreaterThanOrEqual(300);
    expect(new Set(ops.map((o) => o.name)).size).toBe(ops.length);
    for (const op of ops) expect(hostToolName('billing', op.name)).toBe(`billing__${op.name}`);
    const box = createBillingBox(seedBilling());
    expect(box.tools.every((t) => t.annotations === undefined)).toBe(true);
    expect(box.tools.filter((t) => t.description === '').length).toBeGreaterThan(20);
  });

  it('pages three ways: cursor, page-numbered, offset', async () => {
    const world: ServerWorld = (() => {
      const box = createBillingBox(seedBilling());
      return {
        name: 'billing',
        server: box.server,
        tools: box.tools,
        instructions: undefined,
        calls: box.calls,
        facts: {},
        hostSystemPrompt: '',
        close: async () => {},
      };
    })();
    const c = await connected(world, { name: 'none', defects: [] });
    const cursor = JSON.parse((await c.call('GetInvoices', { limit: 3 })).text) as Record<
      string,
      unknown
    >;
    expect(Object.keys(cursor).toSorted()).toEqual(['data', 'has_more', 'object', 'url']);
    const page = JSON.parse((await c.call('GetSubscriptions', {})).text) as Record<string, unknown>;
    expect(Object.keys(page).toSorted()).toEqual(['data', 'object', 'page', 'per_page', 'url']);
    const offset = JSON.parse((await c.call('GetFeatureFlags', {})).text) as Record<
      string,
      unknown
    >;
    expect(Object.keys(offset).toSorted()).toEqual(['items', 'limit', 'offset', 'total']);
    // An unmodelled read is a realistic empty list or 404, never `{ok: true}`.
    const empty = JSON.parse((await c.call('GetPayouts', {})).text) as Record<string, unknown>;
    expect(empty).toMatchObject({ object: 'list', data: [], has_more: false });
    const missing = await c.call('GetPayoutsPayout', { payout: 'po_1' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("No such payout: 'po_1'");
  });
});

describe('the messy world', () => {
  it('collides generic names across boxes and stays within host name limits', async () => {
    const world = (await openWorld('messy')) as MultiWorld;
    try {
      const names = (alias: string): string[] =>
        world.boxes.find((b) => b.alias === alias)?.world.tools.map((t) => t.name) ?? [];
      for (const generic of ['search', 'get', 'create']) {
        expect(names('tracker')).toContain(generic);
        expect(names('mail')).toContain(generic);
      }
      expect(names('tracker')).toContain('list');
      expect(names('chat')).toContain('list');
      expect(world.tools.length).toBeGreaterThan(330);
      const session = await openSession('direct', world);
      expect(session.runtime.tools.length).toBe(world.tools.length);
      await session.close();
    } finally {
      await world.close();
    }
  });

  it('opens only the boxes a task names, with a framing that names exactly them', async () => {
    const world = (await openWorld('messy', { boxes: ['mail', 'tracker'] })) as MultiWorld;
    try {
      expect(world.boxes.map((b) => b.alias)).toEqual(['mail', 'tracker']);
      expect(world.hostSystemPrompt).toContain('the assistant mailbox');
      expect(world.hostSystemPrompt).not.toContain('billing');
    } finally {
      await world.close();
    }
  });

  it('box descriptions are balanced (none favoured by length)', () => {
    const lengths = Object.values(MESSY_BOX_DESCRIPTIONS).map((d) => d.length);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(6);
  });

  it('every profile changes something on its box', () => {
    for (const profile of Object.values(MESSY_PROFILES)) {
      expect(profile.defects.length).toBeGreaterThan(0);
    }
  });
});
