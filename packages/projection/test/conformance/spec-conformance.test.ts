/**
 * MCP spec conformance of a Projection facade wrapping an upstream that uses
 * the whole 2026-07-28 surface (`everything-server.ts`).
 *
 * For every upstream feature this records what a client of the facade
 * observes — passed through, transformed, dropped, or an error — over a
 * 2026-07-28 client (createMcpHandler; a hand-connected McpServer is always
 * legacy-era), a held legacy-era client, and a two-box `wrapMcpServers`
 * facade. Intended behaviour is asserted; gaps are `it.todo` with the reason,
 * and `.claude/hillclimb/multi-server/explore/spec-conformance.md` carries
 * the matrix and the proposals.
 *
 * Security focus: upstream text that reaches the model or the human stays
 * S5-neutralized and attributed, and nothing an upstream asks the human can
 * pass for a Projection approval prompt (S6).
 */

import { Client, StreamableHTTPClientTransport, type Progress } from '@modelcontextprotocol/client';
import { createMcpHandler, InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  wrapMcpServer,
  wrapMcpServers,
  type MultiProjectionFacade,
  type ProjectionFacade,
} from '../../src/index.js';
import { MRTR_PROTOCOL_REVISION } from '../../src/mrtr/index.js';
import {
  everythingServer,
  paginatedServer,
  PNG_BASE64,
  SPOOFED_APPROVAL,
  WAV_BASE64,
  type ProbeEvent,
} from './everything-server.js';

const KEY = new Uint8Array(32).fill(57);
const ENDPOINT = new URL('http://conformance.projection.test/mcp');

interface Result {
  content: { type: string; text?: string; data?: string; mimeType?: string; resource?: unknown }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface Session {
  client: Client;
  probe: ProbeEvent[];
  /** Every elicitation message that reached the human (the client's handler). */
  prompts: string[];
  /** Every `notifications/message` the client received. */
  logs: unknown[];
}

let facades: (ProjectionFacade | MultiProjectionFacade)[] = [];
let clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(facades.map((f) => f.close()));
  clients = [];
  facades = [];
});

function newClient(modern: boolean, session: Omit<Session, 'client' | 'probe'>): Client {
  const client = new Client(
    { name: 'conformance', version: '1.0.0' },
    {
      capabilities: {
        elicitation: modern ? { form: {}, url: {} } : {},
        sampling: {},
        roots: {},
      },
      ...(modern ? { versionNegotiation: { mode: { pin: MRTR_PROTOCOL_REVISION } } } : {}),
    },
  );
  // The human: approves everything, and records what it was shown.
  client.setRequestHandler('elicitation/create', (request) => {
    session.prompts.push((request.params as { message: string }).message);
    return { action: 'accept', content: {} };
  });
  client.setRequestHandler('roots/list', () => ({ roots: [{ uri: 'file:///work' }] }));
  client.setNotificationHandler('notifications/message', (n) => {
    session.logs.push(n.params);
  });
  clients.push(client);
  return client;
}

async function overHttp(
  facade: ProjectionFacade | MultiProjectionFacade,
  probe: ProbeEvent[],
): Promise<Session> {
  facades.push(facade);
  const handler = createMcpHandler(facade.serverFactory);
  const session = { prompts: [] as string[], logs: [] as unknown[] };
  const client = newClient(true, session);
  await client.connect(
    new StreamableHTTPClientTransport(ENDPOINT, {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  return { client, probe, ...session };
}

async function modernSingle(): Promise<Session> {
  const up = everythingServer();
  return overHttp(await wrapMcpServer(up.server, { blob: { key: KEY } }), up.probe);
}

async function legacySingle(): Promise<Session> {
  const up = everythingServer();
  const facade = await wrapMcpServer(up.server, {
    blob: { key: KEY },
    compat: { legacyElicitation: true },
  });
  facades.push(facade);
  const session = { prompts: [] as string[], logs: [] as unknown[] };
  const client = newClient(false, session);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await facade.createServer().connect(serverTransport);
  await client.connect(clientTransport);
  return { client, probe: up.probe, ...session };
}

async function modernMulti(): Promise<Session> {
  const up = everythingServer();
  const paged = paginatedServer();
  const pagedClient = new Client({ name: 'paged-client', version: '1.0.0' });
  clients.push(pagedClient);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await paged.connect(b);
  await pagedClient.connect(a);
  return overHttp(
    await wrapMcpServers({ every: up.server, paged: pagedClient }, { blob: { key: KEY } }),
    up.probe,
  );
}

async function call(
  s: Session,
  name: string,
  args: Record<string, unknown> = {},
  options: Parameters<Client['callTool']>[1] = {},
): Promise<Result> {
  return (await s.client.callTool(
    { name: 'call_tool', arguments: { name, args } },
    options,
  )) as unknown as Result;
}

function allText(result: Result): string {
  return result.content.map((block) => block.text ?? '').join('\n');
}

/** A machine that calls `tool` once and outputs the result or error event payload. */
function oneCallMachine(tool: string): string {
  return `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';
export default setup({}).createMachine({
  id: 'one', context: { result: null, error: null }, initial: 'calling',
  states: {
    calling: {
      entry: toolCall(${JSON.stringify(tool)}, () => ({})),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ result: ({ event }) => event.result }) },
        TOOL_ERROR: { target: 'done', actions: assign({ error: ({ event }) => event.error.message }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => context,
});`;
}

async function runMachine(s: Session, tool: string): Promise<Record<string, unknown>> {
  const result = (await s.client.callTool({
    name: 'execute_machine',
    arguments: { code: oneCallMachine(tool) },
  })) as unknown as Result;
  expect(result.isError).toBeUndefined();
  return result.structuredContent?.['output'] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe('single facade, 2026-07-28 client', () => {
  it('tools: only the five Projection tools are listed; upstream tools are never direct (R1)', async () => {
    const s = await modernSingle();
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['call_tool', 'describe_tool', 'discover_apis', 'execute_machine', 'search_tools'].sort(),
    );
  });

  it('instructions: forwarded verbatim, then the routing preamble (R29)', async () => {
    const s = await modernSingle();
    const instructions = s.client.getInstructions() ?? '';
    expect(instructions.startsWith('EVERYTHING-INSTRUCTIONS:')).toBe(true);
    expect(instructions).toContain('call_tool');
  });

  it('server identity: the facade names itself; upstream title and icons are dropped', async () => {
    const s = await modernSingle();
    const info = s.client.getServerVersion();
    expect(info?.name).toBe('projection-default');
    expect(JSON.stringify(info)).not.toContain('everything.png');
  });

  it('structuredContent: transformed — becomes call_tool output; outputSchema reaches describe_tool', async () => {
    const s = await modernSingle();
    const result = await call(s, 'get_weather', { city: 'Oslo' });
    expect(result.structuredContent).toEqual({
      status: 'ok',
      tool: 'get_weather',
      output: { city: 'Oslo', tempC: 21, sky: 'clear' },
    });
    const described = (await s.client.callTool({
      name: 'describe_tool',
      arguments: { name: 'get_weather' },
    })) as unknown as Result;
    expect(described.structuredContent?.['outputSchema']).toMatchObject({
      properties: { tempC: { type: 'number' } },
    });
  });

  it('content blocks: image, audio and embedded blob resources pass through natively; no base64 in text', async () => {
    const s = await modernSingle();
    const result = await call(s, 'media');
    const [head, ...native] = result.content;
    expect(native).toEqual([
      { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
      { type: 'audio', data: WAV_BASE64, mimeType: 'audio/wav' },
      {
        type: 'resource',
        resource: { uri: 'everything://logo.png', mimeType: 'image/png', blob: PNG_BASE64 },
      },
    ]);
    const text = head?.text ?? '';
    expect(text).not.toContain(PNG_BASE64);
    // Text and embedded text resources read as text, under their URI.
    expect(text).toContain('caption');
    expect(text).toContain('[embedded resource "everything://readme" ("text/plain")]\nREADME body');
    // A resource_link is described, not passed on: the facade cannot serve it.
    expect(text).toContain('not readable through this facade');
    expect(native.some((block) => block.type === 'resource_link')).toBe(false);
    // structuredContent keeps the upstream array verbatim (R35.5).
    expect(result.structuredContent?.['output']).toHaveLength(6);
  });

  it('content blocks: a lone image block is attached, not dumped', async () => {
    const s = await modernSingle();
    const result = await call(s, 'image_only');
    expect(result.content[1]).toEqual({ type: 'image', data: PNG_BASE64, mimeType: 'image/png' });
    expect(allText(result)).not.toContain(PNG_BASE64);
  });

  it('annotations: readOnly/destructive/idempotent/title kept; openWorldHint dropped; missing => asks', async () => {
    const s = await modernSingle();
    const describe = async (name: string): Promise<Record<string, unknown> | undefined> =>
      (
        (await s.client.callTool({
          name: 'describe_tool',
          arguments: { name },
        })) as unknown as Result
      ).structuredContent;
    expect((await describe('explicit_write'))?.['annotations']).toEqual({
      title: 'Annotated write',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect((await describe('get_weather'))?.['annotations']).toEqual({ readOnlyHint: true });
    expect((await describe('unannotated_write'))?.['posture']).toBe('asks for approval');
    expect((await describe('nuke'))?.['destructive']).toBe(true);
  });

  it('approval prompts are Projection copy, built from catalog data (S6)', async () => {
    const s = await modernSingle();
    const result = await call(s, 'nuke');
    expect(result.structuredContent?.['status']).toBe('ok');
    expect(s.prompts).toHaveLength(1);
    expect(s.prompts[0]).toMatch(/^⚠ Approve: nuke/);
    expect(s.prompts[0]).toContain('What the server says it does: "Delete everything."');
  });

  it('progress: an upstream progress report reaches the client under its own token, attributed', async () => {
    const s = await modernSingle();
    const reports: Progress[] = [];
    const result = await call(s, 'slow_count', {}, { onprogress: (p) => reports.push(p) });
    expect(result.structuredContent?.['output']).toBe('counted to 3');
    expect(reports).toEqual([
      { progress: 1, total: 3, message: 'slow_count: step 1' },
      { progress: 2, total: 3, message: 'slow_count: step 2' },
      { progress: 3, total: 3, message: 'slow_count: step 3' },
    ]);
  });

  it('S5: relayed progress messages and content-block text are neutralized and capped', async () => {
    const s = await modernSingle();
    const reports: Progress[] = [];
    const result = await call(s, 'hostile', {}, { onprogress: (p) => reports.push(p) });
    const message = reports[0]?.message ?? '';
    expect(message.startsWith('hostile: evil')).toBe(true);
    expect(message).not.toContain('\u202E');
    expect(message.length).toBeLessThanOrEqual(201);
    expect(result.content[0]?.text).not.toContain('\u202E');
    expect(result.content[1]?.type).toBe('image');
  });

  it('progress: without a client token the upstream is not asked for progress', async () => {
    const s = await modernSingle();
    await call(s, 'slow_count');
    expect(s.probe).toContainEqual({
      kind: 'progress-token',
      tool: 'slow_count',
      token: undefined,
    });
  });

  it('cancellation: cancelling call_tool cancels the upstream call', async () => {
    const s = await modernSingle();
    const controller = new AbortController();
    const pending = call(s, 'hang', {}, { signal: controller.signal }).catch((err: unknown) => err);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort('user cancelled');
    await pending;
    await vi.waitFor(() =>
      expect(s.probe.some((e) => e.kind === 'cancelled' && e.tool === 'hang')).toBe(true),
    );
  });

  it('logging: dropped — the facade declares no logging capability and relays no upstream log', async () => {
    const s = await modernSingle();
    expect(s.client.getServerCapabilities()?.logging).toBeUndefined();
    await call(s, 'noisy');
    expect(s.probe.filter((e) => e.kind === 'log-sent')).toHaveLength(4);
    expect(s.logs).toEqual([]);
  });

  describe('upstream input requests (dropped: an upstream-phase error, never a prompt)', () => {
    for (const [tool, method] of [
      ['ask_user', 'elicitation/create'],
      ['ask_url', 'elicitation/create'],
      ['summarize', 'sampling/createMessage'],
      ['list_roots', 'roots/list'],
    ] as const) {
      it(`${tool} (${method})`, async () => {
        const s = await modernSingle();
        const result = await call(s, tool, tool === 'summarize' ? { text: 'hi' } : {});
        expect(result.isError).toBe(true);
        expect(result.structuredContent?.['phase']).toBe('upstream');
        expect(String(result.structuredContent?.['message'])).toContain(method);
        // The introspector's upstream connection declares no client capability.
        expect(String(result.structuredContent?.['message'])).toContain('2025-era');
        expect(s.prompts).toEqual([]);
      });
    }

    it('push-style elicitInput fails upstream; its error text is attributed, inert data', async () => {
      const s = await modernSingle();
      const result = await call(s, 'push_elicit');
      expect(result.structuredContent?.['phase']).toBe('upstream');
      expect(String(result.structuredContent?.['message'])).toMatch(/^push failed:/);
      expect(s.prompts).toEqual([]);
    });

    it('S6: an upstream question shaped like an approval never reaches the human', async () => {
      const s = await modernSingle();
      await call(s, 'ask_user');
      await call(s, 'push_elicit');
      await call(s, 'unannotated_write'); // a real Projection approval, for contrast
      expect(s.prompts).toHaveLength(1);
      expect(s.prompts[0]).toMatch(/^Approve: unannotated write/);
      for (const prompt of s.prompts) expect(prompt).not.toContain(SPOOFED_APPROVAL);
    });

    it.todo(
      'forward an upstream form elicitation to the human through MRTR, attributed to the box and visibly not an approval (proposal G1)',
    );
    it.todo('forward upstream URL-mode elicitation (proposal G1)');
    it.todo('forward upstream sampling and roots requests (proposal G6)');
  });

  it('resources: dropped — only projection:// and ui:// are listed; an upstream URI is not found', async () => {
    const s = await modernSingle();
    const { resources } = await s.client.listResources();
    expect(resources.every((r) => /^(projection|ui):\/\//.test(r.uri))).toBe(true);
    expect((await s.client.listResourceTemplates()).resourceTemplates).toEqual([]);
    await expect(s.client.readResource({ uri: 'everything://readme' })).rejects.toThrow(
      /not found/i,
    );
  });

  it('prompts and completions: dropped — only the workflow prompts; completion/complete is unknown', async () => {
    const s = await modernSingle();
    const { prompts } = await s.client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['save-workflow', 'visualize-workflow']);
    await expect(
      s.client.complete({
        ref: { type: 'ref/prompt', name: 'review_code' },
        argument: { name: 'language', value: 'ty' },
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('tools/list_changed: ignored — the catalog stays as wrapped (R47)', async () => {
    const s = await modernSingle();
    await call(s, 'add_tool');
    const late = await call(s, 'late_tool');
    expect(late.structuredContent?.['phase']).toBe('validate');
    await call(s, 'remove_tool');
    const gone = await call(s, 'doomed');
    expect(gone.structuredContent?.['phase']).toBe('upstream');
  });

  it.todo('refresh the catalog on tools/list_changed without breaking blob identity (proposal G4)');

  describe('code mode (execute_machine)', () => {
    it('TOOL_RESULT carries the raw content array, base64 included', async () => {
      const s = await modernSingle();
      const output = await runMachine(s, 'media');
      expect((output['result'] as unknown[]).length).toBe(6);
    });

    it('an upstream input request is a TOOL_ERROR, never a prompt', async () => {
      const s = await modernSingle();
      const output = await runMachine(s, 'ask_user');
      expect(String(output['error'])).toContain('elicitation/create');
      expect(s.prompts).toEqual([]);
    });

    it('progress from a machine step is not relayed', async () => {
      const s = await modernSingle();
      const reports: unknown[] = [];
      await s.client.callTool(
        { name: 'execute_machine', arguments: { code: oneCallMachine('slow_count') } },
        { onprogress: (p) => reports.push(p) },
      );
      expect(reports).toEqual([]);
    });

    it.todo('relay upstream progress (and step progress) from execute_machine (proposal G3)');
    it.todo('cancel in-flight upstream calls when execute_machine is cancelled (proposal G3)');
  });

  it.todo(
    'expose upstream openWorldHint, tool title and icons on describe_tool / search (proposal G8)',
  );
  it.todo(
    'speak 2026-07-28 to the upstream (the introspector negotiates legacy today; proposal G2)',
  );
});

describe('single facade, held legacy-era client', () => {
  it('read-only call_tool works, with native content blocks', async () => {
    const s = await legacySingle();
    const result = await call(s, 'media');
    expect(result.structuredContent?.['status']).toBe('ok');
    expect(result.content[1]).toEqual({ type: 'image', data: PNG_BASE64, mimeType: 'image/png' });
  });

  it('gated call_tool approves through the elicitation shim with Projection copy', async () => {
    const s = await legacySingle();
    const result = await call(s, 'unannotated_write');
    expect(result.structuredContent?.['status']).toBe('ok');
    expect(s.prompts[0]).toMatch(/^Approve: unannotated write/);
  });

  it('upstream input requests stay upstream-phase errors', async () => {
    const s = await legacySingle();
    const result = await call(s, 'ask_user');
    expect(result.structuredContent?.['phase']).toBe('upstream');
    expect(s.prompts).toEqual([]);
  });

  it('progress and cancellation are relayed on the held connection too', async () => {
    const s = await legacySingle();
    const reports: unknown[] = [];
    await call(s, 'slow_count', {}, { onprogress: (p) => reports.push(p) });
    expect(reports).toHaveLength(3);
    const controller = new AbortController();
    const pending = call(s, 'hang', {}, { signal: controller.signal }).catch((err: unknown) => err);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort('stop');
    await pending;
    await vi.waitFor(() => expect(s.probe.some((e) => e.kind === 'cancelled')).toBe(true));
  });
});

describe('multi-server facade (two boxes), 2026-07-28 client', () => {
  it('tools: N + 3 catalog tools plus code mode; upstream tools never direct (R43)', async () => {
    const s = await modernMulti();
    const names = (await s.client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'call_tool',
        'describe_tool',
        'discover_apis',
        'execute_machine',
        'search_every',
        'search_paged',
        'search_tools',
      ].sort(),
    );
  });

  it('instructions: not forwarded; the shelf quotes and attributes the first sentence (R44)', async () => {
    const s = await modernMulti();
    const instructions = s.client.getInstructions() ?? '';
    expect(instructions).toContain('every — "EVERYTHING-INSTRUCTIONS:');
    expect(instructions).toContain("(server's words)");
  });

  it('pagination: a tool on the last tools/list page is callable by qualified name', async () => {
    const s = await modernMulti();
    const result = await call(s, 'paged.p2_read');
    expect(result.structuredContent).toMatchObject({ status: 'ok', tool: 'paged.p2_read' });
  });

  it('content blocks and progress pass through with the box-qualified attribution', async () => {
    const s = await modernMulti();
    const media = await call(s, 'every.media');
    expect(media.content[1]).toEqual({ type: 'image', data: PNG_BASE64, mimeType: 'image/png' });
    const reports: Progress[] = [];
    await call(s, 'every.slow_count', {}, { onprogress: (p) => reports.push(p) });
    expect(reports.map((r) => r.message)).toEqual([
      'every.slow_count: step 1',
      'every.slow_count: step 2',
      'every.slow_count: step 3',
    ]);
  });

  it('approval copy names the box by its host alias; upstream questions never reach the human (S6)', async () => {
    const s = await modernMulti();
    await call(s, 'every.ask_user');
    await call(s, 'every.nuke');
    expect(s.prompts).toHaveLength(1);
    expect(s.prompts[0]).toMatch(/^⚠ Approve \(every\): nuke/);
    expect(s.prompts[0]).not.toContain(SPOOFED_APPROVAL);
  });

  it('resources and prompts of the boxes are dropped (only box overviews are served)', async () => {
    const s = await modernMulti();
    const uris = (await s.client.listResources()).resources.map((r) => r.uri);
    expect(uris).toContain('projection://boxes/every/overview.md');
    expect(uris.some((u) => u.startsWith('everything://'))).toBe(false);
  });

  it.todo('project box resources and prompts under the box alias (proposal G5)');
});
