/**
 * Per-turn usage, offline: every Messages API call's usage is recorded on
 * the episode, its record and its transcript message, with the static prefix
 * size either counted (once per distinct prefix per run) or estimated from
 * turn 1 when no count is available.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  estimatePrefixTokens,
  resolveTasks,
  runAgentEpisode,
  runToolChoiceEval,
  type AgentRuntime,
  type ModelCaller,
  type ModelPreset,
  type PrefixCounter,
} from '../../src/index.js';
import { toolNames } from './tool-names.js';

const preset: ModelPreset = { name: 'scripted', model: 'scripted-model', params: {} };

function message(
  content: unknown[],
  stop: Anthropic.StopReason,
  usage: Partial<Anthropic.Usage>,
): Anthropic.Message {
  return {
    id: 'msg_scripted',
    type: 'message',
    role: 'assistant',
    model: 'scripted',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...usage,
    },
  } as unknown as Anthropic.Message;
}

const runtime: AgentRuntime = {
  system: 'You are a test.',
  tools: [{ name: 'ping', description: 'Ping.', inputSchema: { type: 'object' } }],
  call: async () => ({ text: 'pong' }),
};

/** Three turns: two tool calls, then end_turn; usage grows like a cached conversation. */
const threeTurns: ModelCaller = async (params) => {
  const turn = params.messages.filter((m) => m.role === 'assistant').length;
  const usages: Partial<Anthropic.Usage>[] = [
    { input_tokens: 3, cache_creation_input_tokens: 5000, output_tokens: 40 },
    {
      input_tokens: 3,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 300,
      output_tokens: 50,
    },
    {
      input_tokens: 3,
      cache_read_input_tokens: 5300,
      cache_creation_input_tokens: 200,
      output_tokens: 60,
    },
  ];
  const usage = usages[turn] ?? {};
  return turn < 2
    ? message([{ type: 'tool_use', id: `tu_${turn}`, name: 'ping', input: {} }], 'tool_use', usage)
    : message([{ type: 'text', text: 'Done.' }], 'end_turn', usage);
};

const failing: ModelCaller = async () => {
  throw new Error('boom');
};

describe('per-turn usage', () => {
  it('records every call, keeps the totals, and estimates the prefix from turn 1', async () => {
    const prompt = 'x'.repeat(400);
    const episode = await runAgentEpisode(threeTurns, preset, runtime, prompt);
    expect(episode.apiTurns).toBe(3);
    // 5003 tokens in turn 1's prompt, less 400 chars / 4 for the task prompt.
    const prefix = estimatePrefixTokens(5003, prompt);
    expect(prefix).toBe(4903);
    expect(episode.prefixSource).toBe('estimate');
    expect(episode.turns).toEqual([
      {
        inputTokens: 3,
        cacheCreationInputTokens: 5000,
        cacheReadInputTokens: 0,
        outputTokens: 40,
        prefixTokens: prefix,
      },
      {
        inputTokens: 3,
        cacheCreationInputTokens: 300,
        cacheReadInputTokens: 5000,
        outputTokens: 50,
        prefixTokens: prefix,
      },
      {
        inputTokens: 3,
        cacheCreationInputTokens: 200,
        cacheReadInputTokens: 5300,
        outputTokens: 60,
        prefixTokens: prefix,
      },
    ]);
    expect(episode.usage).toEqual({
      inputTokens: 9,
      outputTokens: 150,
      cacheReadInputTokens: 10300,
      cacheCreationInputTokens: 5500,
    });
    // Each assistant message carries its own call's usage; user messages none.
    const assistant = episode.transcript.messages.filter((m) => m.role === 'assistant');
    expect(assistant.map((m) => m.usage)).toEqual(episode.turns);
    expect(episode.transcript.messages.filter((m) => m.role === 'user' && 'usage' in m)).toEqual(
      [],
    );
  });

  it('uses a counted prefix when one is given', async () => {
    const episode = await runAgentEpisode(threeTurns, preset, runtime, 'hi', {
      prefixTokens: 4321,
    });
    expect(episode.prefixSource).toBe('count_tokens');
    expect(episode.turns.map((t) => t.prefixTokens)).toEqual([4321, 4321, 4321]);
  });

  it('records no turns and no prefix source when no call completed', async () => {
    const episode = await runAgentEpisode(failing, preset, runtime, 'hi');
    expect(episode.turns).toEqual([]);
    expect(episode.prefixSource).toBeUndefined();
  });

  it(
    'counts each distinct prefix once per run and falls back to an estimate on failure',
    { timeout: 60_000 },
    async () => {
      const prefixes = new Set<string>();
      const caller: ModelCaller = async (params) => {
        prefixes.add(JSON.stringify([params.system, params.tools]));
        const last = params.messages.at(-1);
        const done =
          Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_result');
        if (done) return message([{ type: 'text', text: 'ok' }], 'end_turn', { input_tokens: 900 });
        const names = new Set(toolNames(params.tools));
        return message(
          [
            names.has('call_tool')
              ? {
                  type: 'tool_use',
                  id: 't',
                  name: 'call_tool',
                  input: { name: 'get_me', args: {} },
                }
              : { type: 'tool_use', id: 't', name: 'get_me', input: {} },
          ],
          'tool_use',
          { input_tokens: 800 },
        );
      };
      const counted: string[] = [];
      const counter: PrefixCounter = async (model, system, tools) => {
        counted.push(JSON.stringify([model, system, tools]));
        return 777;
      };
      const options = {
        models: [preset],
        modes: ['direct' as const, 'projection' as const],
        tasks: resolveTasks('who-am-i'),
        runs: 2,
        caller,
      };
      const records = await runToolChoiceEval({ ...options, countPrefix: counter });
      expect(records).toHaveLength(4);
      expect(counted).toHaveLength(prefixes.size);
      expect(new Set(counted).size).toBe(counted.length);
      for (const record of records) {
        expect(record.prefixSource).toBe('count_tokens');
        expect(record.turns?.map((t) => t.prefixTokens)).toEqual([777, 777]);
        expect(record.turns?.map((t) => t.inputTokens)).toEqual([800, 900]);
      }

      const failed = await runToolChoiceEval({
        ...options,
        runs: 1,
        countPrefix: async () => {
          throw new Error('no network');
        },
      });
      for (const record of failed) {
        expect(record.harnessError).toBeUndefined();
        expect(record.prefixSource).toBe('estimate');
        expect(record.turns?.[0]?.prefixTokens).toBeLessThan(800);
      }
    },
  );
});
