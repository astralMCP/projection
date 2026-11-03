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
  type WrapOptions,
  type WrapServersOptions,
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
  /** Every elicitation request's params, as the human's client received them. */
  requests: Record<string, unknown>[];
  /** Every `notifications/message` the client received. */
  logs: unknown[];
  /** How the human answers a forwarded question (default: accept, answer "blue"). */
  human: {
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, string | number | boolean | string[]>;
  };
}

type SessionState = Omit<Session, 'client' | 'probe'>;

function newSessionState(): SessionState {
  return {
    prompts: [],
    requests: [],
    logs: [],
    human: { action: 'accept', content: { answer: 'blue' } },
  };
}

const FORWARD = { upstreamElicitation: 'forward' } as const;

let facades: (ProjectionFacade | MultiProjectionFacade)[] = [];
let clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(facades.map((f) => f.close()));
  clients = [];
  facades = [];
});

function newClient(modern: boolean, session: SessionState, url = true): Client {
  const client = new Client(
    { name: 'conformance', version: '1.0.0' },
    {
      capabilities: {
        elicitation: modern ? { form: {}, ...(url ? { url: {} } : {}) } : {},
        sampling: {},
        roots: {},
      },
      ...(modern ? { versionNegotiation: { mode: { pin: MRTR_PROTOCOL_REVISION } } } : {}),
    },
  );
  // The human: approves every approval, answers every forwarded question as
  // `session.human` says, and records what it was shown.
  client.setRequestHandler('elicitation/create', (request) => {
    const params = request.params as { message: string; mode?: string };
    session.prompts.push(params.message);
    session.requests.push(params as Record<string, unknown>);
    if (/^(Question|Link) from /.test(params.message)) {
      const { action, content } = session.human;
      return params.mode === 'url' || content === undefined || action !== 'accept'
        ? { action }
        : { action, content };
    }
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
  url = true,
): Promise<Session> {
  facades.push(facade);
  const handler = createMcpHandler(facade.serverFactory);
  const session = newSessionState();
  const client = newClient(true, session, url);
  await client.connect(
    new StreamableHTTPClientTransport(ENDPOINT, {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  return Object.assign(session, { client, probe });
}

async function modernSingle(
  options: Partial<WrapOptions> = {},
  clientUrl = true,
): Promise<Session> {
  const up = everythingServer();
  return overHttp(
    await wrapMcpServer(up.server, { blob: { key: KEY }, ...options }),
    up.probe,
    clientUrl,
  );
}

async function legacySingle(options: Partial<WrapOptions> = {}): Promise<Session> {
  const up = everythingServer();
  const facade = await wrapMcpServer(up.server, {
    blob: { key: KEY },
    compat: { legacyElicitation: true },
    ...options,
  });
  facades.push(facade);
  const session = newSessionState();
  const client = newClient(false, session);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await facade.createServer().connect(serverTransport);
  await client.connect(clientTransport);
  return Object.assign(session, { client, probe: up.probe });
}

async function modernMulti(
  forwardEvery = false,
  options: Partial<WrapServersOptions> = {},
): Promise<Session> {
  const up = everythingServer();
  const paged = paginatedServer();
  const pagedClient = new Client({ name: 'paged-client', version: '1.0.0' });
  clients.push(pagedClient);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await paged.connect(b);
  await pagedClient.connect(a);
  return overHttp(
    await wrapMcpServers(
      { every: forwardEvery ? { source: up.server, ...FORWARD } : up.server, paged: pagedClient },
      { blob: { key: KEY }, ...options },
    ),
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

/** The lines of a prompt that are NOT the server's quoted words. */
function ownLines(prompt: string): string[] {
  return prompt.split('\n').filter((line) => !line.startsWith('│ '));
}

async function runMachine(s: Session, tool: string): Promise<Record<string, unknown>> {
  const result = (await s.client.callTool({
    name: 'execute_machine',
    arguments: { code: oneCallMachine(tool) },
  })) as unknown as Result;
  expect(result.isError).toBeUndefined();
  return result.structuredContent?.['output'] as Record<string, unknown>;
}

/** The everything server's tools, in its listing order. */
const UPSTREAM_TOOLS = [
  'get_weather',
  'media',
  'image_only',
  'unannotated_write',
  'explicit_write',
  'nuke',
  'slow_count',
  'hostile',
  'noisy',
  'hang',
  'ask_user',
  'gated_ask',
  'ask_structured',
  'ask_twice',
  'hostile_ask',
  'call_again',
  'ask_bad_url',
  'ask_url',
  'push_elicit',
  'summarize',
  'list_roots',
  'add_tool',
  'doomed',
  'remove_tool',
];

// ---------------------------------------------------------------------------

describe('single facade, 2026-07-28 client', () => {
  it('tools: by default the upstream tools are also listed directly, each posture-tagged; direct: false lists only the five Projection tools (R1, D28)', async () => {
    const s = await modernSingle();
    const { tools } = await s.client.listTools();
    const projection = ['execute_machine', 'discover_apis', 'describe_tool', 'call_tool'];
    expect(tools.map((t) => t.name)).toEqual([...projection, ...UPSTREAM_TOOLS]);
    for (const tool of tools.filter((t) => !projection.includes(t.name))) {
      expect(tool.description).toMatch(
        /^\[(runs immediately|asks for approval|blocked by policy)[\];]/,
      );
    }
    const searched = await modernSingle({ projections: { direct: false } });
    expect((await searched.client.listTools()).tools.map((t) => t.name).sort()).toEqual(
      ['call_tool', 'describe_tool', 'discover_apis', 'execute_machine', 'search_tools'].sort(),
    );
  });

  it('instructions: forwarded verbatim, then the routing preamble (R29)', async () => {
    const s = await modernSingle();
    const instructions = s.client.getInstructions() ?? '';
    expect(instructions.startsWith('EVERYTHING-INSTRUCTIONS:')).toBe(true);
    expect(instructions).toContain("This server's tools are listed directly");
    const searched = await modernSingle({ projections: { direct: false } });
    const routed = searched.client.getInstructions() ?? '';
    expect(routed.startsWith('EVERYTHING-INSTRUCTIONS:')).toBe(true);
    expect(routed).toContain('call_tool');
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
    expect(text).toContain(
      '[embedded resource "everything://readme" ("text/plain"), text verbatim between the ``` lines]\n```\nREADME body\n```',
    );
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

  describe('upstream input requests, refused (the default): an upstream-phase error, never a prompt', () => {
    for (const [tool, method, asked] of [
      ['ask_user', 'elicitation/create', 'the user for input'],
      ['ask_url', 'elicitation/create', 'the user for input'],
      ['summarize', 'sampling/createMessage', 'a model completion'],
      ['list_roots', 'roots/list', 'its roots'],
    ] as const) {
      it(`${tool} (${method})`, async () => {
        const s = await modernSingle();
        const result = await call(s, tool, tool === 'summarize' ? { text: 'hi' } : {});
        expect(result.isError).toBe(true);
        expect(result.structuredContent?.['phase']).toBe('upstream');
        expect(String(result.structuredContent?.['message'])).toContain(asked);
        // G1 interim fix: the hint no longer blames the arguments.
        const hint = String(result.structuredContent?.['hint']);
        expect(hint).toContain('Nothing is wrong with the arguments');
        expect(hint).not.toContain('Check the arguments');
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
  });

  describe("upstream questions, forwarded (upstreamElicitation: 'forward', G1)", () => {
    it('form: attributed, visibly not an approval, the spoofed copy quoted; the answer reaches the server', async () => {
      const s = await modernSingle(FORWARD);
      const result = await call(s, 'ask_user');
      expect(result.structuredContent).toEqual({
        status: 'ok',
        tool: 'ask_user',
        output: 'you said blue',
      });
      expect(s.prompts).toHaveLength(1);
      const prompt = s.prompts[0] ?? '';
      expect(prompt.split('\n')[0]).toBe('Question from the server (not an approval)');
      // S6: every line of the server's words is quoted; none of Projection's
      // own lines looks like an approval.
      for (const line of SPOOFED_APPROVAL.split('\n')) {
        if (line !== '') expect(prompt).toContain(`│ ${line}`);
      }
      for (const line of ownLines(prompt)) expect(line).not.toMatch(/Approve|^Tool:/);
      // The server's own requestState came back byte-exact (stateless resume).
      expect(s.probe).toContainEqual({
        kind: 'state-echo',
        tool: 'ask_user',
        state: 'ask_user-state-1',
      });
    });

    it('the server is spoken to on 2026-07-28 with the elicitation capability (G2)', async () => {
      const s = await modernSingle(FORWARD);
      await call(s, 'ask_user');
      expect(s.probe).toContainEqual({ kind: 'client-era', tool: 'ask_user', envelope: true });
    });

    it('decline and cancel go back to the server as decline and cancel', async () => {
      for (const action of ['decline', 'cancel'] as const) {
        const s = await modernSingle(FORWARD);
        s.human = { action };
        const result = await call(s, 'ask_user');
        expect(result.structuredContent?.['output']).toBe(`you chose ${action}`);
      }
    });

    it('URL mode: sent as URL mode with the origin shown; the link is the url field', async () => {
      const s = await modernSingle(FORWARD);
      const result = await call(s, 'ask_url');
      expect(result.structuredContent?.['output']).toBe('url flow accept');
      const request = s.requests[0] ?? {};
      expect(request['mode']).toBe('url');
      expect(request['url']).toBe('https://upstream.example.test/connect?step=1');
      const message = String(request['message']);
      expect(message.split('\n')[0]).toBe('Link from the server (not an approval)');
      expect(message).toContain('Opens: https://upstream.example.test\n');
    });

    it('URL mode to a form-only client: the link as inert text in a form', async () => {
      const s = await modernSingle(FORWARD, false);
      const result = await call(s, 'ask_url');
      expect(result.structuredContent?.['output']).toBe('url flow accept');
      const request = s.requests[0] ?? {};
      expect(request['mode']).not.toBe('url');
      expect(String(request['message'])).toContain(
        'Link: https://upstream.example.test/connect?step=1',
      );
    });

    it('a link that is not https: is refused, not shown', async () => {
      const s = await modernSingle(FORWARD);
      const result = await call(s, 'ask_bad_url');
      expect(result.structuredContent?.['phase']).toBe('upstream');
      expect(String(result.structuredContent?.['hint'])).toContain(
        'Nothing is wrong with the arguments',
      );
      expect(s.prompts).toEqual([]);
    });

    it('sampling and roots are never forwarded, even when questions are', async () => {
      const s = await modernSingle(FORWARD);
      for (const tool of ['summarize', 'list_roots']) {
        const result = await call(s, tool, tool === 'summarize' ? { text: 'hi' } : {});
        expect(result.structuredContent?.['phase']).toBe('upstream');
      }
      expect(s.prompts).toEqual([]);
    });

    it('no pass-through: a gated tool is approved first, then its question is asked within the same call', async () => {
      const s = await modernSingle(FORWARD);
      const result = await call(s, 'gated_ask', { note: 'n' });
      expect(result.structuredContent?.['output']).toBe('wrote n to blue');
      expect(s.prompts).toHaveLength(2);
      expect(s.prompts[0]).toMatch(/^Approve: gated ask/);
      expect(s.prompts[1]).toMatch(/^Question from the server \(not an approval\)/);
      // The approved call ran once, and was re-issued once with the answer.
      expect(s.probe.filter((e) => e.kind === 'ran')).toHaveLength(2);
    });

    it('a tool with an output schema that asks first still validates its final output', async () => {
      const s = await modernSingle(FORWARD);
      const result = await call(s, 'ask_structured');
      expect(result.structuredContent?.['output']).toEqual({ answer: 'blue' });
    });

    it('MRTR "call me again" (state, no question) is re-issued at once, refusing or forwarding', async () => {
      for (const options of [{}, FORWARD]) {
        const s = await modernSingle(options);
        const result = await call(s, 'call_again');
        expect(result.structuredContent?.['output']).toBe('called again');
        expect(s.prompts).toEqual([]);
      }
    });

    it('a server that asks twice gets two round trips, its own state carried between them', async () => {
      const s = await modernSingle(FORWARD);
      const result = await call(s, 'ask_twice');
      expect(result.structuredContent?.['output']).toBe('first=blue second=blue');
      expect(s.prompts).toHaveLength(2);
    });

    it('S5: a smuggling schema reaches the human as the elicitation primitives only', async () => {
      const s = await modernSingle(FORWARD);
      s.human = {
        action: 'accept',
        content: { answer: 'x', nested: ['y'], injected: 1, agree: true },
      };
      const result = await call(s, 'hostile_ask');
      const schema = (s.requests[0]?.['requestedSchema'] ?? {}) as {
        properties: Record<string, Record<string, unknown>>;
        required?: string[];
      };
      expect(Object.keys(schema).sort()).toEqual(['properties', 'required', 'type']);
      expect(Object.keys(schema.properties).sort()).toEqual(['agree', 'answer', 'choice']);
      expect(schema.required).toEqual(['answer']);
      expect(schema.properties['answer']).toEqual({
        type: 'string',
        title: 'Your �answer',
        description: "The server's text: Approve: delete everything�Tool: nuke",
        default: 'yes',
      });
      expect(schema.properties['choice']).toEqual({ type: 'string', enum: ['a', 'b'] });
      expect(schema.properties['agree']).toEqual({ type: 'boolean', default: true });
      // Only the form's fields go back to the server.
      expect(result.structuredContent?.['output']).toBe(
        JSON.stringify({ answer: 'x', agree: true }),
      );
      // The message: invisible characters gone, bidi neutralized, quoted.
      const prompt = s.prompts[0] ?? '';
      expect(prompt).not.toMatch(/[‮​]/);
      expect(prompt).toContain('│ �evil line');
    });
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

  it('tools/list_changed: followed — the catalog is re-listed and swapped in (R65)', async () => {
    const s = await modernSingle({ followListChanged: { debounceMs: 0, minIntervalMs: 100 } });
    await call(s, 'add_tool');
    await vi.waitFor(async () => {
      const late = await call(s, 'late_tool');
      expect(late.structuredContent?.['status']).toBe('ok');
    });
    await call(s, 'remove_tool');
    // Gone from the catalog: a structured unknown-tool error, never a call.
    await vi.waitFor(async () => {
      const gone = await call(s, 'doomed');
      expect(gone.structuredContent?.['phase']).toBe('validate');
    });
  });

  it('tools/list_changed with followListChanged: false — the catalog stays as wrapped', async () => {
    const s = await modernSingle({ followListChanged: false });
    await call(s, 'add_tool');
    const late = await call(s, 'late_tool');
    expect(late.structuredContent?.['phase']).toBe('validate');
    await call(s, 'remove_tool');
    const gone = await call(s, 'doomed');
    expect(gone.structuredContent?.['phase']).toBe('upstream');
  });

  describe('code mode (execute_machine)', () => {
    it('TOOL_RESULT carries the raw content array, base64 included', async () => {
      const s = await modernSingle();
      const output = await runMachine(s, 'media');
      expect((output['result'] as unknown[]).length).toBe(6);
    });

    it('an upstream question on a box that refuses is a TOOL_ERROR that says so, never a prompt', async () => {
      const s = await modernSingle();
      const output = await runMachine(s, 'ask_user');
      expect(String(output['error'])).toContain('asked the user for input');
      expect(s.prompts).toEqual([]);
    });

    it('on a box that forwards, the machine suspends on the question and resumes with the answer (G1)', async () => {
      const s = await modernSingle(FORWARD);
      const output = await runMachine(s, 'ask_user');
      expect(output['result']).toBe('you said blue');
      expect(s.prompts).toHaveLength(1);
      expect(s.prompts[0]).toMatch(/^Question from the server \(not an approval\)/);
      expect(s.probe).toContainEqual({
        kind: 'state-echo',
        tool: 'ask_user',
        state: 'ask_user-state-1',
      });
    });

    it('a question that cannot be passed on is a TOOL_ERROR at once on a forwarding box too', async () => {
      const s = await modernSingle(FORWARD);
      const output = await runMachine(s, 'ask_bad_url');
      expect(String(output['error'])).toContain('cannot be passed on');
      expect(s.prompts).toEqual([]);
    });

    it('a declined question reaches the server as a decline; the machine gets its result', async () => {
      const s = await modernSingle(FORWARD);
      s.human = { action: 'decline' };
      const output = await runMachine(s, 'ask_user');
      expect(output['result']).toBe('you chose decline');
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
  it('speaks 2026-07-28 to an in-process upstream, declaring no elicitation capability by default (G2)', async () => {
    const s = await modernSingle();
    await call(s, 'ask_user');
    expect(s.probe).toContainEqual({ kind: 'client-era', tool: 'ask_user', envelope: true });
  });

  it('a legacy-era upstream (a caller Client on the 2025 handshake) keeps working (G2)', async () => {
    const up = everythingServer();
    const legacyClient = new Client({ name: 'legacy-upstream-client', version: '1.0.0' });
    clients.push(legacyClient);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await up.server.connect(b);
    await legacyClient.connect(a);
    expect(legacyClient.getProtocolEra()).toBe('legacy');
    const s = await overHttp(
      await wrapMcpServer(legacyClient, { blob: { key: KEY }, ...FORWARD }),
      up.probe,
    );
    const weather = await call(s, 'get_weather', { city: 'Oslo' });
    expect(weather.structuredContent?.['status']).toBe('ok');
    // Its question cannot be forwarded on the 2025 era (D7): refused, not prompted.
    const asked = await call(s, 'ask_user');
    expect(asked.structuredContent?.['phase']).toBe('upstream');
    expect(String(asked.structuredContent?.['hint'])).toContain(
      'Nothing is wrong with the arguments',
    );
    expect(s.prompts).toEqual([]);
  });
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

  it('a forwarded question reaches a legacy client through the opted-in shim, as the question copy', async () => {
    const s = await legacySingle(FORWARD);
    const result = await call(s, 'ask_user');
    expect(result.structuredContent?.['output']).toBe('you said blue');
    expect(s.prompts[0]).toMatch(/^Question from the server \(not an approval\)/);
  });

  it('without the shim opt-in a legacy client gets a protocol error naming the revision', async () => {
    const s = await legacySingle({ ...FORWARD, compat: {} });
    const result = await call(s, 'ask_user');
    expect(result.structuredContent?.['phase']).toBe('protocol');
    expect(String(result.structuredContent?.['message'])).toContain(MRTR_PROTOCOL_REVISION);
    expect(String(result.structuredContent?.['message'])).toContain('question');
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
  it('tools: by default both small boxes are listed directly as <box>__<tool>; direct: false lists N + 3 catalog tools plus code mode (R43, D28)', async () => {
    const s = await modernMulti();
    const names = (await s.client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'call_tool',
        'describe_tool',
        'discover_apis',
        'execute_machine',
        // every sends instructions, so its search tool stays to read them.
        'search_every',
        ...UPSTREAM_TOOLS.map((name) => `every__${name}`),
        ...['p0_a', 'p0_b', 'p1_a', 'p1_b', 'p2_a', 'p2_read'].map((name) => `paged__${name}`),
      ].sort(),
    );
    const searched = await modernMulti(false, { projections: { direct: false } });
    expect((await searched.client.listTools()).tools.map((t) => t.name).sort()).toEqual(
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

  it('a forwarding box: the question names the box by its host alias, never shaped like an approval (S6)', async () => {
    const s = await modernMulti(true);
    const result = await call(s, 'every.ask_user');
    expect(result.structuredContent?.['output']).toBe('you said blue');
    expect(s.prompts[0]?.split('\n')[0]).toBe('Question from every (not an approval)');
    expect(s.prompts[0]).toContain('while running the tool "every.ask_user"');
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

describe('direct listing (projections.direct): a mediated <alias>__<tool> is call_tool', () => {
  const DIRECT = { projections: { direct: true } } as const;

  /** Call the mediated alias over the wire, as a host offering it would. */
  async function viaDirect(
    s: Session,
    name: string,
    options: Parameters<Client['callTool']>[1] = {},
  ): Promise<Result> {
    return (await s.client.callTool({ name, arguments: {} }, options)) as unknown as Result;
  }

  it('lists the box tools as mediated aliases beside call_tool', async () => {
    const s = await modernMulti(true, DIRECT);
    const names = (await s.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('every__ask_user');
    expect(names).toContain('call_tool');
  });

  it('an upstream question on a forwarding box is forwarded exactly as call_tool forwards it (G1, S6)', async () => {
    const direct = await modernMulti(true, DIRECT);
    const catalog = await modernMulti(true, DIRECT);
    const viaAlias = await viaDirect(direct, 'every__ask_user');
    const viaCallTool = await call(catalog, 'every.ask_user');
    expect(viaAlias.structuredContent).toEqual(viaCallTool.structuredContent);
    expect(viaAlias.structuredContent?.['output']).toBe('you said blue');
    expect(viaAlias.isError).toBe(viaCallTool.isError);
    // The human sees the same prompt and the same request, byte for byte:
    // attributed to the box, the catalog name, never shaped like an approval.
    expect(direct.prompts).toEqual(catalog.prompts);
    expect(direct.requests).toEqual(catalog.requests);
    expect(direct.prompts[0]?.split('\n')[0]).toBe('Question from every (not an approval)');
    expect(direct.prompts[0]).toContain('while running the tool "every.ask_user"');
    // The upstream's own state came back to it on both paths.
    expect(direct.probe.filter((e) => e.kind === 'state-echo')).toEqual(
      catalog.probe.filter((e) => e.kind === 'state-echo'),
    );
  });

  it('a declined or cancelled question goes back to the server the same way on both paths', async () => {
    for (const action of ['decline', 'cancel'] as const) {
      const direct = await modernMulti(true, DIRECT);
      const catalog = await modernMulti(true, DIRECT);
      direct.human = { action };
      catalog.human = { action };
      const viaAlias = await viaDirect(direct, 'every__ask_user');
      const viaCallTool = await call(catalog, 'every.ask_user');
      expect(viaAlias.structuredContent?.['output']).toBe(`you chose ${action}`);
      expect(viaAlias.structuredContent).toEqual(viaCallTool.structuredContent);
    }
  });

  it('on a box that refuses, the question is the same upstream-phase error and never a prompt', async () => {
    const direct = await modernMulti(false, DIRECT);
    const catalog = await modernMulti(false, DIRECT);
    const viaAlias = await viaDirect(direct, 'every__ask_user');
    const viaCallTool = await call(catalog, 'every.ask_user');
    expect(viaAlias).toEqual(viaCallTool);
    expect(direct.prompts).toEqual([]);
  });

  it('progress is relayed under the client token with the catalog-name attribution', async () => {
    const s = await modernMulti(false, DIRECT);
    const reports: Progress[] = [];
    await viaDirect(s, 'every__slow_count', { onprogress: (p) => reports.push(p) });
    expect(reports.map((r) => r.message)).toEqual([
      'every.slow_count: step 1',
      'every.slow_count: step 2',
      'every.slow_count: step 3',
    ]);
  });
});
