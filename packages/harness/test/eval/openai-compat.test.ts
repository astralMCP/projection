/**
 * The OpenAI-compatible provider, offline: request translation from the
 * loop's own Anthropic-shaped request, response translation from fixtures
 * in OpenRouter's documented shapes (test/fixtures/openai-compat/README.md),
 * the caller's retries and errors over an injected fetch, and a whole eval
 * run on a non-Anthropic preset.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  agentTools,
  buildTurnRequest,
  estimateUsd,
  fromOpenAiResponse,
  modeSupportsModel,
  openAiCompatCaller,
  resolveModelPresets,
  resolveTasks,
  runAgentEpisode,
  runToolChoiceEval,
  toOpenAiRequest,
  ContextOverflowError,
  MODEL_PRESETS,
  OpenAiCompatError,
  OPENROUTER,
  type AgentRuntime,
  type ModelPreset,
  type OpenAiResponse,
} from '../../src/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/openai-compat');
const fixture = (name: string): OpenAiResponse =>
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as OpenAiResponse;

const kimi = MODEL_PRESETS['kimi-k25'] as ModelPreset;
const muse = MODEL_PRESETS['muse-spark'] as ModelPreset;

const runtime: AgentRuntime = {
  system: 'You are a test host.',
  tools: [
    {
      name: 'github__list_issues',
      description: 'List issues.',
      inputSchema: {
        type: 'object',
        properties: { owner: { type: 'string' }, repo: { type: 'string' } },
        required: ['owner', 'repo'],
      },
    },
  ],
  call: async () => ({ text: '[]' }),
};

describe('presets', () => {
  it('serves Muse Spark 1.3 and Kimi K2.5 from OpenRouter, without native modes', () => {
    expect(resolveModelPresets('muse-spark,kimi-k25').map((p) => p.model)).toEqual([
      'meta/muse-spark-1.3',
      'moonshotai/kimi-k2.5',
    ]);
    expect(kimi.provider).toBe(OPENROUTER);
    expect(modeSupportsModel('native-search', kimi.model, false)).toBe(false);
    expect(modeSupportsModel('projection', kimi.model, false)).toBe(true);
  });

  it('prices them at OpenRouter list prices, cache reads at their own rate', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
    };
    expect(estimateUsd('moonshotai/kimi-k2.5', usage)).toBeCloseTo(0.5 + 2.5 + 0.15, 10);
    expect(estimateUsd('meta/muse-spark-1.3', usage)).toBeCloseTo(1.25 + 4.25 + 0.15, 10);
  });
});

describe('request translation', () => {
  it('turns the loop request into Chat Completions, tool turns included', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Count the open issues.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'List both.',
            signature:
              'openai-compat:reasoning_details:[{"type":"reasoning.text","text":"List both.","index":0}]',
          },
          { type: 'text', text: 'Looking.' },
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'github__list_issues',
            input: { owner: 'a', repo: 'b' },
          },
          {
            type: 'tool_use',
            id: 'call_2',
            name: 'github__list_issues',
            input: { owner: 'a', repo: 'c' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: '[1,2]' },
          { type: 'tool_result', tool_use_id: 'call_2', content: 'Not found', is_error: true },
        ],
      },
    ];
    const params = buildTurnRequest(kimi, runtime.system, agentTools(runtime), messages, 4000);
    const request = toOpenAiRequest(params);
    expect(request).toEqual({
      model: 'moonshotai/kimi-k2.5',
      max_tokens: 4000,
      messages: [
        { role: 'system', content: 'You are a test host.' },
        { role: 'user', content: 'Count the open issues.' },
        {
          role: 'assistant',
          content: 'Looking.',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'github__list_issues', arguments: '{"owner":"a","repo":"b"}' },
            },
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'github__list_issues', arguments: '{"owner":"a","repo":"c"}' },
            },
          ],
          reasoning: 'List both.',
          reasoning_details: [{ type: 'reasoning.text', text: 'List both.', index: 0 }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '[1,2]' },
        { role: 'tool', tool_call_id: 'call_2', content: 'Not found' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'github__list_issues',
            description: 'List issues.',
            parameters: runtime.tools[0]?.inputSchema,
          },
        },
      ],
    });
    // Anthropic-only request fields never reach the other provider.
    expect(JSON.stringify(request)).not.toContain('cache_control');
  });

  it('rejects Anthropic server tools', () => {
    for (const native of [
      { kind: 'tool-search', variant: 'bm25' },
      { kind: 'ptc', callers: 'code' },
    ] as const) {
      const params = buildTurnRequest(kimi, 's', agentTools({ ...runtime, native }), [
        { role: 'user', content: 'x' },
      ]);
      expect(() => toOpenAiRequest(params)).toThrow(/Anthropic-only/);
    }
  });

  it('merges the provider extra body', () => {
    const params = buildTurnRequest(muse, 's', [], [{ role: 'user', content: 'x' }]);
    expect(toOpenAiRequest(params, { reasoning: { effort: 'low' } })).toMatchObject({
      reasoning: { effort: 'low' },
    });
  });
});

describe('response translation (fixtures)', () => {
  it('parallel tool calls with reasoning and cached usage (Kimi)', () => {
    const message = fromOpenAiResponse(fixture('kimi-tool-calls.json'), kimi.model);
    expect(message.stop_reason).toBe('tool_use');
    expect(message.model).toBe('moonshotai/kimi-k2.5');
    expect(message.content.map((b) => b.type)).toEqual([
      'thinking',
      'text',
      'tool_use',
      'tool_use',
    ]);
    const uses = message.content.filter((b) => b.type === 'tool_use');
    expect(uses.map((u) => [u.id, u.name, u.input])).toEqual([
      [
        'functions.github__list_issues:0',
        'github__list_issues',
        { owner: 'acme', repo: 'widgets', state: 'OPEN' },
      ],
      [
        'functions.github__list_issues:1',
        'github__list_issues',
        { owner: 'acme', repo: 'gadgets', state: 'OPEN' },
      ],
    ]);
    expect(message.usage).toMatchObject({
      input_tokens: 51234 - 49152,
      cache_read_input_tokens: 49152,
      cache_creation_input_tokens: 0,
      output_tokens: 96,
      provider_cost_usd: 0.0102435,
    });
  });

  it('a final answer (Muse Spark)', () => {
    const message = fromOpenAiResponse(fixture('muse-final.json'), muse.model);
    expect(message.stop_reason).toBe('end_turn');
    expect(message.content).toEqual([
      {
        type: 'text',
        text: 'acme/widgets has 3 open issues and acme/gadgets has 1.',
        citations: null,
      },
    ]);
    expect(message.usage).toMatchObject({ input_tokens: 2048, output_tokens: 21 });
  });

  it('tool calls under finish_reason "stop", with truncated arguments kept visible', () => {
    const message = fromOpenAiResponse(fixture('muse-tool-calls-stop.json'), muse.model);
    expect(message.stop_reason).toBe('tool_use');
    const use = message.content.find((b) => b.type === 'tool_use');
    expect(use?.input).toEqual({ _unparseable_arguments: '{"path": "/tmp/x/CHANGELOG.md"' });
  });

  it('round-trips: the echoed assistant turn becomes the same tool calls and reasoning', () => {
    const body = fixture('kimi-tool-calls.json');
    const message = fromOpenAiResponse(body, kimi.model);
    const request = toOpenAiRequest(
      buildTurnRequest(kimi, 's', agentTools(runtime), [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: message.content as unknown as Anthropic.ContentBlockParam[] },
      ]),
    );
    const assistant = request.messages[2] as Extract<
      (typeof request.messages)[number],
      { role: 'assistant' }
    >;
    const original = body.choices?.[0]?.message;
    expect(assistant.content).toBe(original?.content);
    expect(assistant.reasoning).toBe(original?.reasoning);
    expect(assistant.reasoning_details).toEqual(original?.reasoning_details);
    expect(
      assistant.tool_calls?.map((c) => [c.id, c.function.name, JSON.parse(c.function.arguments)]),
    ).toEqual(
      original?.tool_calls?.map((c) => [c.id, c.function.name, JSON.parse(c.function.arguments)]),
    );
  });
});

/** A fake fetch answering from a queue of [status, fixture body, headers]. */
function fakeFetch(queue: [number, unknown, Record<string, string>?][]): {
  fetch: typeof fetch;
  requests: { url: string; init: RequestInit }[];
} {
  const requests: { url: string; init: RequestInit }[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (next === undefined) throw new Error('no more scripted responses');
    const [status, body, headers] = next;
    return new Response(JSON.stringify(body), { status, headers: headers ?? {} });
  };
  return { fetch: impl as typeof fetch, requests };
}

const noSleep = async (): Promise<void> => {};
const params = buildTurnRequest(kimi, 'sys', agentTools(runtime), [
  { role: 'user', content: 'hi' },
]);

describe('the caller', () => {
  it('posts to the provider with the key, and returns the translated message', async () => {
    const { fetch, requests } = fakeFetch([[200, fixture('muse-final.json')]]);
    const caller = openAiCompatCaller(OPENROUTER, { fetch, apiKey: 'sk-test', sleep: noSleep });
    const message = await caller(params);
    expect(message.stop_reason).toBe('end_turn');
    expect(requests[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = requests[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-test');
    expect(JSON.parse(String(requests[0]?.init.body)).model).toBe('moonshotai/kimi-k2.5');
  });

  it('retries a 429 (after retry-after) and a 200 carrying an error', async () => {
    const waits: number[] = [];
    const { fetch, requests } = fakeFetch([
      [429, { error: { code: 429, message: 'Rate limited' } }, { 'retry-after': '2' }],
      [200, fixture('error-in-200.json')],
      [200, fixture('kimi-tool-calls.json')],
    ]);
    const caller = openAiCompatCaller(OPENROUTER, {
      fetch,
      apiKey: 'k',
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const message = await caller(params);
    expect(message.stop_reason).toBe('tool_use');
    expect(requests).toHaveLength(3);
    expect(waits[0]).toBe(2000);
  });

  it('a context-length 400 is a context overflow; a 401 is not retried', async () => {
    const overflow = openAiCompatCaller(OPENROUTER, {
      fetch: fakeFetch([[400, fixture('error-context-400.json')]]).fetch,
      apiKey: 'k',
      sleep: noSleep,
    });
    await expect(overflow(params)).rejects.toBeInstanceOf(ContextOverflowError);
    const auth = fakeFetch([[401, fixture('error-auth-401.json')]]);
    const unauthorised = openAiCompatCaller(OPENROUTER, {
      fetch: auth.fetch,
      apiKey: 'k',
      sleep: noSleep,
    });
    await expect(unauthorised(params)).rejects.toBeInstanceOf(OpenAiCompatError);
    expect(auth.requests).toHaveLength(1);
  });

  it('refuses to call without a key, before any request', async () => {
    const saved = process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_API_KEY'];
    try {
      const { fetch, requests } = fakeFetch([]);
      await expect(openAiCompatCaller(OPENROUTER, { fetch })(params)).rejects.toThrow(
        /OPENROUTER_API_KEY is not set/,
      );
      expect(requests).toHaveLength(0);
    } finally {
      if (saved !== undefined) process.env['OPENROUTER_API_KEY'] = saved;
    }
  });
});

describe('a whole episode and eval run on a non-Anthropic preset', () => {
  it('runs the loop: tool calls, results back as tool messages, final answer', async () => {
    const { fetch, requests } = fakeFetch([
      [200, fixture('kimi-tool-calls.json')],
      [200, fixture('muse-final.json')],
    ]);
    const caller = openAiCompatCaller(OPENROUTER, { fetch, apiKey: 'k', sleep: noSleep });
    const episode = await runAgentEpisode(caller, kimi, runtime, 'Count open issues.');
    expect(episode.harnessError).toBeUndefined();
    expect(episode.toolUses.map((u) => u.input['repo'])).toEqual(['widgets', 'gadgets']);
    expect(episode.turns.map((t) => t.providerCostUsd)).toEqual([0.0102435, 0.00267]);
    const second = JSON.parse(String(requests[1]?.init.body)) as { messages: { role: string }[] };
    expect(second.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'tool',
    ]);
  });

  it('records list-price and provider-reported cost, and skips native modes', async () => {
    const queue: [number, unknown][] = [];
    for (let i = 0; i < 4; i += 1) queue.push([200, fixture('muse-final.json')]);
    const { fetch } = fakeFetch(queue);
    const records = await runToolChoiceEval({
      models: [kimi],
      modes: ['direct', 'native-search', 'projection'],
      tasks: resolveTasks(undefined, ['basic']).slice(0, 1),
      runs: 1,
      caller: openAiCompatCaller(OPENROUTER, { fetch, apiKey: 'k', sleep: noSleep }),
    });
    expect(records.map((r) => r.mode)).toEqual(['direct', 'projection']);
    for (const record of records) {
      expect(record.providerUsd).toBeCloseTo(0.00267, 10);
      expect(record.estimatedUsd).toBeCloseTo((2048 * 0.5 + 21 * 2.5) / 1e6, 10);
      expect(record.standardUsd).toBe(record.estimatedUsd);
      expect(record.prefixSource).toBe('estimate');
    }
  });

  it('refuses the batch path', async () => {
    await expect(
      runToolChoiceEval({
        models: [kimi],
        modes: ['direct'],
        tasks: resolveTasks(undefined, ['basic']).slice(0, 1),
        runs: 1,
        batch: { client: {} as never },
      }),
    ).rejects.toThrow(/Message Batches/);
  });
});
