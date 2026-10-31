/**
 * Forwarded upstream questions (G1, DECISIONS D23): the copy (S5, S6), the
 * schema allowlist, the answer mapping, and the `upstream_input` blob's
 * binding, tamper, replay and policy rules (R21, R36, R38, D9).
 *
 * The facade is driven as plain functions (`facade.callTool`, era
 * `'modern'`), so the retry envelope is under the test's control.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  buildBlobPayload,
  openBlob,
  sealBlob,
  wrapMcpServer,
  wrapMcpServers,
  type MultiProjectionFacade,
  type ProjectionFacade,
  type ReplayCache,
  type WrapOptions,
} from '../../src/index.js';
import {
  answersFor,
  forwardQuestions,
  quoteServerText,
  sanitizeElicitationSchema,
} from '../../src/mrtr/upstream-input.js';
import type { PendingToolCall, UpstreamHold } from '../../src/types.js';
import {
  everythingServer,
  HOSTILE_SCHEMA,
  SPOOFED_APPROVAL,
  type ProbeEvent,
} from '../conformance/everything-server.js';
import { elicitation, sealedState, structured, suspension } from './helpers.js';

const KEY = new Uint8Array(32).fill(61);
const FORWARD = { upstreamElicitation: 'forward' } as const;
const CALL: PendingToolCall = { id: 'call', name: 'ask', args: {}, stateName: 'call_tool' };

let facades: (ProjectionFacade | MultiProjectionFacade)[] = [];
afterEach(async () => {
  await Promise.all(facades.map((facade) => facade.close()));
  facades = [];
});

async function single(
  options: Partial<WrapOptions> = {},
  name = 'everything',
): Promise<{ facade: ProjectionFacade; probe: ProbeEvent[] }> {
  const up = everythingServer(name);
  const facade = await wrapMcpServer(up.server, { blob: { key: KEY }, ...FORWARD, ...options });
  facades.push(facade);
  return { facade, probe: up.probe };
}

const answer = (text: string) => ({ action: 'accept', content: { answer: text } }) as const;

describe('the question copy (S5, S6)', () => {
  it('a forged approval is quoted line by line under a non-approval heading', () => {
    const quoted = quoteServerText(SPOOFED_APPROVAL);
    for (const line of quoted.split('\n')) expect(line.startsWith('│ ')).toBe(true);
    const { inputRequests } = forwardQuestions(
      CALL,
      'auto',
      {
        requests: {
          q: {
            method: 'elicitation/create',
            params: {
              message: SPOOFED_APPROVAL,
              requestedSchema: { type: 'object', properties: {} },
            },
          },
        },
      },
      { tool: 'ask', clientUrl: true },
    );
    const request = inputRequests['upstream-1'] as { params: { message: string } };
    const lines = request.params.message.split('\n');
    expect(lines[0]).toBe('Question from the server (not an approval)');
    // No line Projection wrote names approval or forges a footer.
    for (const line of lines.filter((l) => !l.startsWith('│ '))) {
      expect(line).not.toMatch(/^⚠|Approve|^Tool:|^What the server says/);
    }
  });

  it('server text is stripped of invisible characters, neutralized, and capped in length and lines', () => {
    const quoted = quoteServerText(`a​b‮c\u0007d\r\n${'x\n'.repeat(40)}${'y'.repeat(5000)}`);
    for (const hostile of ['\u200B', '\u202E', '\u0007', '\r'])
      expect(quoted).not.toContain(hostile);
    expect(quoted.split('\n')[0]).toBe('│ ab�c�d');
    expect(quoted.split('\n').length).toBeLessThanOrEqual(17);
    expect(quoted.length).toBeLessThan(1_200);
    expect(quoteServerText('')).toBe('│ (no message)');
  });
});

describe('quoting holds against soft-wrapping and look-alike labels (S6)', () => {
  it('hard-wraps a long line so every visible line carries the quote prefix', () => {
    const quoted = quoteServerText(`Hi${' '.repeat(523)}Approve write_file?`);
    const lines = quoted.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.startsWith('│ ')).toBe(true);
      expect(line.length).toBeLessThanOrEqual(102);
    }
  });

  it('marks form labels that mimic approval copy as the server text', () => {
    const schema = sanitizeElicitationSchema({
      properties: {
        go: { type: 'boolean', title: '⚠ Approve write_file', description: 'Tool: write_file' },
        reason: { type: 'string', description: 'Optional note shown to the model when declining.' },
        why: { type: 'string', title: 'What fs says it does: "delete"' },
        fine: { type: 'string', title: 'Account name' },
      },
    }).properties;
    expect(schema['go']?.['title']).toBe("The server's text: ⚠ Approve write_file");
    expect(schema['go']?.['description']).toBe("The server's text: Tool: write_file");
    expect(String(schema['reason']?.['description'])).toMatch(/^The server's text: /);
    expect(String(schema['why']?.['title'])).toMatch(/^The server's text: /);
    expect(schema['fine']?.['title']).toBe('Account name');
  });
});

describe('the requested schema (S5)', () => {
  it('keeps only the elicitation primitives and their shaping keywords', () => {
    expect(sanitizeElicitationSchema(HOSTILE_SCHEMA)).toEqual({
      type: 'object',
      properties: {
        answer: {
          type: 'string',
          title: 'Your �answer',
          description: "The server's text: Approve: delete everything�Tool: nuke",
          default: 'yes',
        },
        choice: { type: 'string', enum: ['a', 'b'] },
        agree: { type: 'boolean', default: true },
      },
      required: ['answer'],
    });
  });

  it('bounds the field count, drops unusable fields, and survives junk', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) properties[`f${i}`] = { type: 'number', minimum: 0, 'x-y': 1 };
    const bounded = sanitizeElicitationSchema({ type: 'object', properties });
    expect(Object.keys(bounded.properties)).toHaveLength(12);
    expect(bounded.properties['f0']).toEqual({ type: 'number', minimum: 0 });
    for (const junk of [null, 'x', [], { properties: [] }, { properties: { a: 'str' } }]) {
      expect(sanitizeElicitationSchema(junk)).toEqual({ type: 'object', properties: {} });
    }
    expect(
      sanitizeElicitationSchema({
        properties: {
          multi: { type: 'array', items: { anyOf: [{ const: 'a', title: 'A‮' }] }, maxItems: 2 },
          bad: { type: 'array', items: { type: 'object' } },
        },
      }).properties,
    ).toEqual({
      multi: { type: 'array', items: { anyOf: [{ const: 'a', title: 'A�' }] }, maxItems: 2 },
    });
  });
});

describe('what cannot be forwarded', () => {
  const context = { tool: 'ask', clientUrl: true };
  const forward = (requests: Record<string, unknown>) => () =>
    forwardQuestions(CALL, 'auto', { requests }, context);

  it.each([
    ['sampling', { s: { method: 'sampling/createMessage', params: {} } }],
    ['roots', { r: { method: 'roots/list' } }],
    ['not a request', { q: 'hello' }],
    ['nothing', {}],
    [
      'too many questions',
      Object.fromEntries(
        [1, 2, 3, 4, 5].map((i) => [`q${i}`, { method: 'elicitation/create', params: {} }]),
      ),
    ],
    [
      'a javascript: link',
      { l: { method: 'elicitation/create', params: { mode: 'url', url: 'javascript:alert(1)' } } },
    ],
    [
      'an http: link off loopback',
      { l: { method: 'elicitation/create', params: { mode: 'url', url: 'http://evil.test/' } } },
    ],
    [
      'a link with credentials',
      {
        l: { method: 'elicitation/create', params: { mode: 'url', url: 'https://u:p@evil.test/' } },
      },
    ],
  ])('%s fails the call in the upstream phase', (_label, requests) => {
    expect(forward(requests)).toThrow(expect.objectContaining({ phase: 'upstream' }));
  });

  it('an oversized server state is refused', () => {
    expect(() =>
      forwardQuestions(
        CALL,
        'auto',
        {
          requests: { q: { method: 'elicitation/create', params: {} } },
          requestState: 'x'.repeat(20_000),
        },
        context,
      ),
    ).toThrow(expect.objectContaining({ phase: 'upstream' }));
  });

  it('the facade keys never collide with a machine call id', () => {
    const { inputRequests } = forwardQuestions(
      CALL,
      'auto',
      { requests: { a: { method: 'elicitation/create', params: {} } } },
      context,
      { taken: new Set(['upstream-1']) },
    );
    expect(Object.keys(inputRequests)).toEqual(['upstream-2']);
  });
});

describe('answers going back to the server', () => {
  const hold: UpstreamHold = {
    ...CALL,
    decision: 'auto',
    questions: {
      'upstream-1': {
        key: 'q',
        mode: 'form',
        schema: sanitizeElicitationSchema({
          type: 'object',
          properties: { answer: { type: 'string' }, n: { type: 'integer' } },
        }),
      },
      'upstream-2': { key: 'link', mode: 'url' },
    },
  };

  it('maps keys back, strips fields the form did not have, and sends a link accept without content', () => {
    expect(
      answersFor(hold, {
        'upstream-1': { action: 'accept', content: { answer: 'a', n: 1.5, extra: 'x' } },
        'upstream-2': { action: 'accept', content: { smuggled: true } },
      }),
    ).toEqual({ q: { action: 'accept', content: { answer: 'a' } }, link: { action: 'accept' } });
  });

  it('a server key named __proto__ is an own answer, never a prototype', () => {
    const answers = answersFor(
      { ...hold, questions: { 'upstream-1': { key: '__proto__', mode: 'url' } } },
      { 'upstream-1': { action: 'accept' } },
    );
    expect(Object.getPrototypeOf(answers)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(answers, '__proto__')?.value).toEqual({
      action: 'accept',
    });
    expect(JSON.parse(JSON.stringify(answers))).toEqual(
      JSON.parse('{"__proto__":{"action":"accept"}}'),
    );
  });

  it('decline and cancel pass through; a missing or foreign answer is a cancel', () => {
    expect(answersFor(hold, { 'upstream-1': { action: 'decline' } })).toEqual({
      q: { action: 'decline' },
      link: { action: 'cancel' },
    });
    expect(
      answersFor(hold, { 'upstream-1': { roots: [] }, 'upstream-2': { action: 'cancel' } }),
    ).toEqual({
      q: { action: 'cancel' },
      link: { action: 'cancel' },
    });
  });
});

describe('the upstream_input blob (R21, R36, R38)', () => {
  it("the server's own requestState rides sealed: unreadable on the wire, returned byte-exact", async () => {
    const { facade, probe } = await single();
    const first = await facade.callTool({ name: 'ask_user' }, 'modern');
    const state = sealedState(first);
    expect(state).not.toContain('ask_user-state-1');
    expect(state).not.toContain(Buffer.from('ask_user-state-1').toString('base64url'));
    expect(elicitation(first, 'upstream-1').message).toMatch(/^Question from the server/);
    const done = await facade.callTool(
      { name: 'ask_user', requestState: state, inputResponses: { 'upstream-1': answer('red') } },
      'modern',
    );
    expect(structured(done)['output']).toBe('you said red');
    expect(probe).toContainEqual({
      kind: 'state-echo',
      tool: 'ask_user',
      state: 'ask_user-state-1',
    });
  });

  it('a tampered blob fails verification and the server is never re-invoked', async () => {
    const { facade, probe } = await single();
    const state = sealedState(await facade.callTool({ name: 'ask_user' }, 'modern'));
    const parts = state.split('.');
    const body = parts[3] ?? '';
    parts[3] = `${body.slice(0, 10)}${body[10] === 'A' ? 'B' : 'A'}${body.slice(11)}`;
    const result = await facade.callTool(
      {
        name: 'ask_user',
        requestState: parts.join('.'),
        inputResponses: { 'upstream-1': answer('x') },
      },
      'modern',
    );
    expect(structured(result)['phase']).toBe('blob_verification');
    expect(probe.some((e) => e.kind === 'state-echo')).toBe(false);
  });

  it('a blob replayed against a different call fails (R36 binding)', async () => {
    const { facade, probe } = await single();
    const state = sealedState(await facade.callTool({ name: 'ask_user' }, 'modern'));
    for (const retry of [
      { name: 'ask_url' },
      { name: 'ask_user', args: { extra: 1 } },
      { name: 'unannotated_write' },
    ]) {
      const result = await facade.callTool(
        { ...retry, requestState: state, inputResponses: { 'upstream-1': answer('x') } },
        'modern',
      );
      expect(structured(result)['phase']).toBe('blob_verification');
      expect(String(structured(result)['message'])).toContain('request mismatch');
    }
    // Opened by the other gated tool, it is the wrong kind.
    const machine = await facade.executeMachine(
      { code: 'export default 1', requestState: state },
      'modern',
    );
    expect(structured(machine)['message']).toContain('blob kind mismatch');
    expect(probe.some((e) => e.kind === 'state-echo')).toBe(false);
  });

  it('a blob replayed against another box, or another facade, fails', async () => {
    const one = everythingServer('one');
    const two = everythingServer('two');
    const multi = await wrapMcpServers(
      { one: { source: one.server, ...FORWARD }, two: { source: two.server, ...FORWARD } },
      { blob: { key: KEY } },
    );
    facades.push(multi);
    const state = sealedState(await multi.callTool({ name: 'one.ask_user' }, 'modern'));
    const crossBox = await multi.callTool(
      { name: 'two.ask_user', requestState: state, inputResponses: { 'upstream-1': answer('x') } },
      'modern',
    );
    expect(structured(crossBox)['phase']).toBe('blob_verification');
    // A single-server facade over another server, same key: never opens it.
    const { facade: other } = await single({}, 'other');
    const crossFacade = await other.callTool(
      { name: 'ask_user', requestState: state, inputResponses: { 'upstream-1': answer('x') } },
      'modern',
    );
    expect(structured(crossFacade)['phase']).toBe('blob_verification');
    expect([...one.probe, ...two.probe].some((e) => e.kind === 'state-echo')).toBe(false);
  });

  it('the replay cache makes a question blob single-use', async () => {
    const seen = new Set<string>();
    const replayCache: ReplayCache = {
      seen: async (nonce) => {
        const had = seen.has(nonce);
        seen.add(nonce);
        return await Promise.resolve(had);
      },
    };
    const { facade, probe } = await single({ replayCache });
    const state = sealedState(await facade.callTool({ name: 'ask_user' }, 'modern'));
    const retry = {
      name: 'ask_user',
      requestState: state,
      inputResponses: { 'upstream-1': answer('x') },
    };
    expect(structured(await facade.callTool(retry, 'modern'))['status']).toBe('ok');
    const replayed = await facade.callTool(retry, 'modern');
    expect(structured(replayed)['phase']).toBe('blob_verification');
    expect(String(structured(replayed)['message'])).toContain('already used');
    expect(probe.filter((e) => e.kind === 'state-echo')).toHaveLength(1);
  });

  it('policy outranks the earlier authorization: a tool now denied is not re-issued (D9)', async () => {
    const minted = await single();
    const state = sealedState(await minted.facade.callTool({ name: 'ask_user' }, 'modern'));
    // Same server identity and key, but this deployment denies the tool.
    const { facade, probe } = await single({ policy: { ask_user: 'deny' } });
    const result = await facade.callTool(
      { name: 'ask_user', requestState: state, inputResponses: { 'upstream-1': answer('x') } },
      'modern',
    );
    expect(structured(result)['status']).toBe('denied_by_policy');
    expect(probe.some((e) => e.kind === 'state-echo')).toBe(false);
  });

  it('a call that ran without approval and now needs one is not re-issued (D9)', async () => {
    const minted = await single();
    const state = sealedState(await minted.facade.callTool({ name: 'ask_user' }, 'modern'));
    const { facade, probe } = await single({ policy: { ask_user: 'ask' } });
    const result = await facade.callTool(
      { name: 'ask_user', requestState: state, inputResponses: { 'upstream-1': answer('x') } },
      'modern',
    );
    expect(structured(result)['phase']).toBe('blob_verification');
    expect(String(structured(result)['hint'])).toContain('asked to approve');
    expect(probe.some((e) => e.kind === 'state-echo')).toBe(false);
  });

  it('a question never approves: a gated call whose approval was declined never runs, question or not', async () => {
    const { facade, probe } = await single();
    const approval = await facade.callTool({ name: 'gated_ask', args: { note: 'n' } }, 'modern');
    expect(Object.keys(suspension(approval).inputRequests ?? {})).toEqual(['call']);
    // The approval blob answered with a question-shaped accept on the wrong key: a decline.
    const result = await facade.callTool(
      {
        name: 'gated_ask',
        args: { note: 'n' },
        requestState: sealedState(approval),
        inputResponses: { 'upstream-1': answer('x') },
      },
      'modern',
    );
    expect(structured(result)['status']).toBe('declined');
    expect(probe.some((e) => e.kind === 'ran')).toBe(false);
  });
});

describe('the sealer shape rules for upstream_input', () => {
  const hold: UpstreamHold = {
    ...CALL,
    decision: 'auto',
    questions: { 'upstream-1': { key: 'q', mode: 'url' } },
  };
  const base = {
    kind: 'upstream_input' as const,
    code: 'req',
    serverIdentity: 's@1',
    snapshot: null,
    pending: {},
    trip: 1,
    upstreamInput: { call: hold },
  };
  const open = (
    payload: ReturnType<typeof buildBlobPayload>,
    kind: 'call' | 'upstream_input' = 'upstream_input',
  ) =>
    openBlob(sealBlob(payload, { key: KEY }), {
      expectedKind: kind,
      code: 'req',
      serverIdentity: 's@1',
      config: { key: KEY },
    });

  it('opens when well formed, and only where an upstream_input blob is expected', () => {
    expect(open(buildBlobPayload(base)).upstreamInput?.['call']).toEqual(hold);
    expect(() => open(buildBlobPayload(base), 'call')).toThrow(/blob kind mismatch/);
  });

  it.each([
    ['a pending approval', { pending: { call: CALL } }],
    ['no hold', { upstreamInput: {} }],
    ['a hold under another key', { upstreamInput: { other: { ...hold, id: 'other' } } }],
    ['a hold with a bad decision', { upstreamInput: { call: { ...hold, decision: 'yes' } } }],
    [
      'a form question without a schema',
      {
        upstreamInput: {
          call: { ...hold, questions: { 'upstream-1': { key: 'q', mode: 'form' } } },
        },
      },
    ],
    ['a snapshot', { snapshot: {} }],
  ])('rejects %s as malformed', (_label, change) => {
    const payload = { ...buildBlobPayload(base), ...change } as ReturnType<typeof buildBlobPayload>;
    expect(() => open(payload)).toThrow(/malformed/);
  });

  it('a call blob may not carry a hold', () => {
    const payload = {
      ...buildBlobPayload({ ...base, kind: 'call', pending: { call: CALL } }),
      upstreamInput: { call: hold },
    };
    expect(() => open(payload, 'call')).toThrow(/malformed/);
  });
});

describe("machines holding calls on their server's question (G1)", () => {
  const machine = (body: string): string => `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';
${body}`;

  it('at most four questions reach the human in one round trip; the fifth call fails at once', async () => {
    const { facade } = await single();
    const code = machine(`export default setup({}).createMachine({
  context: { results: 0, errors: 0 }, initial: 'asking',
  states: {
    asking: {
      entry: ['a','b','c','d','e'].map((id) => toolCall('ask_user', () => ({}), { id })),
      on: {
        TOOL_RESULT: { actions: assign({ results: ({ context }) => context.results + 1 }) },
        TOOL_ERROR: { actions: assign({ errors: ({ context }) => context.errors + 1 }) },
      },
      always: { guard: ({ context }) => context.results + context.errors === 5, target: 'done' },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => context,
});`);
    const first = await facade.executeMachine({ code }, 'modern');
    const keys = Object.keys(suspension(first).inputRequests ?? {});
    expect(keys).toEqual(['upstream-1', 'upstream-2', 'upstream-3', 'upstream-4']);
    const done = await facade.executeMachine(
      {
        code,
        requestState: sealedState(first),
        inputResponses: Object.fromEntries(keys.map((key) => [key, answer('k')])),
      },
      'modern',
    );
    expect(structured(done)['output']).toEqual({ results: 4, errors: 1 });
  });

  it('two calls in flight with one id is an authoring error, not a lost answer', async () => {
    const { facade } = await single();
    const code = machine(`export default setup({}).createMachine({
  initial: 'asking',
  states: {
    asking: { entry: [toolCall('ask_user', () => ({}), { id: 'x' }), toolCall('ask_user', () => ({}), { id: 'x' })] },
  },
});`);
    const result = await facade.executeMachine({ code }, 'modern');
    expect(structured(result)['phase']).toBe('validate');
    expect(String(structured(result)['message'])).toContain('share the id');
  });

  it('a machine that finishes while a call is held completes without asking', async () => {
    const { facade } = await single();
    const code = machine(`export default setup({}).createMachine({
  initial: 'asking',
  states: {
    asking: { entry: toolCall('ask_user', () => ({}), { id: 'q' }), always: 'done' },
    done: { type: 'final' },
  },
  output: () => 'finished',
});`);
    const result = await facade.executeMachine({ code }, 'modern');
    expect(structured(result)['output']).toBe('finished');
    expect(structured(result)['approvals']).toEqual([
      expect.objectContaining({
        callId: 'q',
        decision: 'auto',
        reason: expect.stringContaining('finished'),
      }),
    ]);
  });
});
