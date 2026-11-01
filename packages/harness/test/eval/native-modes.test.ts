/**
 * The Anthropic-native baselines and the Projection ablations, offline:
 *
 * - `native-search` / `native-ptc` offer the same raw tools as `direct`,
 *   behind tool search (`defer_loading`) or programmatic tool calling
 *   (`allowed_callers` + code execution), request shapes as the docs give
 *   them;
 * - the agent loop handles the server-tool blocks (search results, code runs,
 *   programmatic `tool_use` with a `caller`), keeps the container, charges
 *   the budget only for turns the model wrote, and records it all;
 * - the host approval gate is the same in every non-Projection mode,
 *   programmatic calls included.
 *
 * The scripted responses follow the response shapes in the tool search and
 * programmatic tool calling docs (platform.claude.com, read 2026-10-31).
 */

import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  agentTools,
  buildTurnRequest,
  hostToolName,
  modeSupportsModel,
  openSession,
  openWorld,
  resolveModes,
  resolveTasks,
  runAgentEpisode,
  runToolChoiceEval,
  serverToolUsd,
  CODE_EXECUTION_USD_PER_HOUR,
  MODEL_PRESETS,
  PTC_CALLER,
  type AgentRuntime,
  type EvalMode,
  type ModelCaller,
  type ModelPreset,
  type MultiWorld,
} from '../../src/index.js';
import { toolNames } from './tool-names.js';

const preset: ModelPreset = { name: 'scripted', model: 'claude-sonnet-5-5', params: {} };

function message(
  content: unknown[],
  stop: Anthropic.StopReason,
  extra: Record<string, unknown> = {},
): Anthropic.Message {
  return {
    id: 'msg_scripted',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content,
    stop_reason: stop,
    stop_sequence: null,
    container: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    ...extra,
  } as unknown as Anthropic.Message;
}

function runtimeWith(native: AgentRuntime['native'], calls: string[] = []): AgentRuntime {
  return {
    system: 'You are a test.',
    tools: [
      { name: 'list_items', description: 'List items.', inputSchema: { type: 'object' } },
      { name: 'get_item', description: 'Get one item.', inputSchema: { type: 'object' } },
    ],
    call: async (name, input) => {
      calls.push(`${name}:${JSON.stringify(input)}`);
      return { text: name === 'list_items' ? '["a","b"]' : `{"id":"${String(input['id'])}"}` };
    },
    ...(native !== undefined ? { native } : {}),
  };
}

describe('native request shapes', () => {
  it('tool search: the search tool first, every raw tool deferred, nothing else changed', () => {
    for (const variant of ['bm25', 'regex'] as const) {
      const tools = agentTools(runtimeWith({ kind: 'tool-search', variant }));
      expect(tools[0]).toEqual({
        type: `tool_search_tool_${variant}_20251119`,
        name: `tool_search_tool_${variant}`,
      });
      expect(tools.slice(1)).toEqual([
        {
          name: 'list_items',
          description: 'List items.',
          input_schema: { type: 'object' },
          defer_loading: true,
        },
        {
          name: 'get_item',
          description: 'Get one item.',
          input_schema: { type: 'object' },
          defer_loading: true,
        },
      ]);
      // The API rejects cache_control on a deferred tool: none anywhere on tools.
      expect(JSON.stringify(tools)).not.toContain('cache_control');
    }
  });

  it('programmatic calling: the code execution tool, every raw tool callable from code', () => {
    const code = agentTools(runtimeWith({ kind: 'ptc', callers: 'code' }));
    expect(code[0]).toEqual({ type: 'code_execution_20260120', name: 'code_execution' });
    expect(code.slice(1).map((t) => (t as Anthropic.Tool).allowed_callers)).toEqual([
      [PTC_CALLER],
      [PTC_CALLER],
    ]);
    const both = agentTools(runtimeWith({ kind: 'ptc', callers: 'both' }));
    expect((both[1] as Anthropic.Tool).allowed_callers).toEqual(['direct', PTC_CALLER]);
    // No strict tools: programmatic calling rejects them.
    expect(JSON.stringify(both)).not.toContain('strict');
  });

  it('plain runtimes keep their exact request bytes; a container goes last', () => {
    const tools = agentTools(runtimeWith(undefined));
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'hi' }];
    const plain = buildTurnRequest(preset, 'sys', tools, messages);
    expect(Object.keys(plain)).toEqual([
      'model',
      'max_tokens',
      'cache_control',
      'system',
      'tools',
      'messages',
    ]);
    const withContainer = buildTurnRequest(preset, 'sys', tools, messages, 100, 'container_1');
    expect(Object.keys(withContainer).at(-1)).toBe('container');
    expect(withContainer.container).toBe('container_1');
  });
});

describe('native episodes', () => {
  it('tool search: server blocks are echoed, recorded, and the found tool runs', async () => {
    const seen: Anthropic.MessageStreamParams[] = [];
    const calls: string[] = [];
    const caller: ModelCaller = async (params) => {
      seen.push(params);
      const turn = params.messages.filter((m) => m.role === 'assistant').length;
      if (turn === 0) {
        return message(
          [
            {
              type: 'server_tool_use',
              id: 'srvtoolu_1',
              name: 'tool_search_tool_bm25',
              input: { query: 'list items' },
              caller: { type: 'direct' },
            },
            {
              type: 'tool_search_tool_result',
              tool_use_id: 'srvtoolu_1',
              content: {
                type: 'tool_search_tool_search_result',
                tool_references: [{ type: 'tool_reference', tool_name: 'list_items' }],
              },
            },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'list_items',
              input: {},
              caller: { type: 'direct' },
            },
          ],
          'tool_use',
        );
      }
      return message([{ type: 'text', text: 'a and b' }], 'end_turn');
    };
    const episode = await runAgentEpisode(
      caller,
      preset,
      runtimeWith({ kind: 'tool-search', variant: 'bm25' }, calls),
      'List the items.',
    );
    expect(episode.harnessError).toBeUndefined();
    expect(calls).toEqual(['list_items:{}']);
    expect(episode.budgetTurns).toBe(2);
    expect(episode.serverTools).toEqual({
      calls: { tool_search_tool_bm25: 1 },
      searchHits: ['list_items'],
      programmaticCalls: 0,
      containers: [],
      codeResumeTurns: 0,
    });
    // The second request echoes the server blocks unchanged and answers only toolu_1.
    const second = seen[1] as Anthropic.MessageStreamParams;
    const echoed = second.messages[1]?.content as { type: string }[];
    expect(echoed.map((b) => b.type)).toEqual([
      'server_tool_use',
      'tool_search_tool_result',
      'tool_use',
    ]);
    expect(second.messages[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '["a","b"]' },
    ]);
    expect(episode.transcript.messages[1]?.content).toEqual([
      {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'tool_search_tool_bm25',
        input: { query: 'list items' },
      },
      { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', tools: ['list_items'] },
      { type: 'tool_use', id: 'toolu_1', name: 'list_items', input: {} },
    ]);
  });

  it('programmatic calling: code resumes are free, the container is sent back, results are tool_result only', async () => {
    const seen: Anthropic.MessageStreamParams[] = [];
    const calls: string[] = [];
    const container = { id: 'container_1', expires_at: '2026-10-31T12:00:00Z' };
    const fromCode = { type: 'code_execution_20260120', tool_id: 'srvtoolu_code' };
    const caller: ModelCaller = async (params) => {
      seen.push(params);
      const turn = params.messages.filter((m) => m.role === 'assistant').length;
      if (turn === 0) {
        return message(
          [
            { type: 'text', text: 'Let me script it.' },
            {
              type: 'server_tool_use',
              id: 'srvtoolu_code',
              name: 'code_execution',
              input: { code: 'items = json.loads(await list_items({}))' },
              caller: { type: 'direct' },
            },
            { type: 'tool_use', id: 'toolu_a', name: 'list_items', input: {}, caller: fromCode },
          ],
          'tool_use',
          { container },
        );
      }
      if (turn === 1) {
        // The paused code resumes and calls twice more in parallel.
        return message(
          [
            {
              type: 'tool_use',
              id: 'toolu_b',
              name: 'get_item',
              input: { id: 'a' },
              caller: fromCode,
            },
            {
              type: 'tool_use',
              id: 'toolu_c',
              name: 'get_item',
              input: { id: 'b' },
              caller: fromCode,
            },
          ],
          'tool_use',
          { container },
        );
      }
      return message(
        [
          {
            type: 'code_execution_tool_result',
            tool_use_id: 'srvtoolu_code',
            content: {
              type: 'code_execution_result',
              stdout: 'a b',
              stderr: '',
              return_code: 0,
              content: [],
            },
          },
          { type: 'text', text: 'Items a and b.' },
        ],
        'end_turn',
        { container },
      );
    };
    const episode = await runAgentEpisode(
      caller,
      preset,
      runtimeWith({ kind: 'ptc', callers: 'code' }, calls),
      'Look up every item.',
      { maxTurns: 2 },
    );
    expect(episode.harnessError).toBeUndefined();
    expect(episode.turnCapped).toBe(false);
    expect(calls).toEqual(['list_items:{}', 'get_item:{"id":"a"}', 'get_item:{"id":"b"}']);
    expect(episode.apiTurns).toBe(3);
    // Turn 1 (the model wrote code) and turn 3 (its answer) count; the resume does not.
    expect(episode.budgetTurns).toBe(2);
    expect(episode.serverTools?.codeResumeTurns).toBe(1);
    expect(episode.serverTools?.programmaticCalls).toBe(3);
    expect(episode.serverTools?.calls).toEqual({ code_execution: 1 });
    expect(episode.serverTools?.containers.map((c) => c.id)).toEqual(['container_1']);
    expect(episode.toolUses.map((u) => u.fromCode)).toEqual([
      'srvtoolu_code',
      'srvtoolu_code',
      'srvtoolu_code',
    ]);
    expect(seen[0]?.container).toBeUndefined();
    expect(seen[1]?.container).toBe('container_1');
    expect(seen[2]?.container).toBe('container_1');
    // A user message answering programmatic calls carries tool_result blocks only.
    for (const params of seen.slice(1)) {
      const last = params.messages.at(-1);
      expect(last?.role).toBe('user');
      const blocks = (last?.content ?? []) as { type: string }[];
      expect(blocks.every((b) => b.type === 'tool_result')).toBe(true);
    }
    expect(episode.finalText).toBe('Items a and b.');
    const lastBlocks = (episode.transcript.messages.at(-1)?.content ?? []) as { type: string }[];
    const result = lastBlocks[0];
    expect(result).toEqual({
      type: 'code_execution_result',
      tool_use_id: 'srvtoolu_code',
      stdout: 'a b',
      stderr: '',
      return_code: 0,
    });
  });

  it('a script that never stops resuming is cut off by its own ceiling', async () => {
    const fromCode = { type: 'code_execution_20260120', tool_id: 'srvtoolu_loop' };
    let n = 0;
    const caller: ModelCaller = async () => {
      n += 1;
      return message(
        [
          ...(n === 1
            ? [
                {
                  type: 'server_tool_use',
                  id: 'srvtoolu_loop',
                  name: 'code_execution',
                  input: { code: 'while True: ...' },
                },
              ]
            : []),
          { type: 'tool_use', id: `toolu_${n}`, name: 'list_items', input: {}, caller: fromCode },
        ],
        'tool_use',
        { container: { id: 'container_loop', expires_at: '' } },
      );
    };
    const episode = await runAgentEpisode(
      caller,
      preset,
      runtimeWith({ kind: 'ptc', callers: 'code' }),
      'Loop.',
    );
    expect(episode.turnCapped).toBe(true);
    expect(episode.budgetTurns).toBe(1);
    expect(episode.serverTools?.codeResumeTurns).toBe(100);
  });
});

describe('native costs', () => {
  it('code execution containers bill at least five minutes; tool search is free', () => {
    expect(serverToolUsd(undefined)).toBe(0);
    expect(serverToolUsd({ containers: [] })).toBe(0);
    expect(serverToolUsd({ containers: [{ id: 'c', spanMs: 1_000 }] })).toBeCloseTo(
      (5 / 60) * CODE_EXECUTION_USD_PER_HOUR,
      10,
    );
    expect(serverToolUsd({ containers: [{ id: 'c', spanMs: 3_600_000 }] })).toBeCloseTo(
      CODE_EXECUTION_USD_PER_HOUR,
      10,
    );
  });
});

describe('mode support', () => {
  it('programmatic calling is skipped on Haiku 4.5; tool search runs everywhere', () => {
    const haiku = MODEL_PRESETS['haiku45'] as ModelPreset;
    const sonnet = MODEL_PRESETS['sonnet-low'] as ModelPreset;
    expect(modeSupportsModel('native-ptc', haiku.model)).toBe(false);
    expect(modeSupportsModel('native-ptc', sonnet.model)).toBe(true);
    expect(modeSupportsModel('native-search', haiku.model)).toBe(true);
    expect(modeSupportsModel('native-search', 'kimi', false)).toBe(false);
    expect(modeSupportsModel('direct', 'kimi', false)).toBe(true);
  });

  it('resolves every new mode name', () => {
    expect(resolveModes('native-search,native-ptc')).toEqual(['native-search', 'native-ptc']);
  });

  it('the planner drops unsupported cells and refuses PTC through batches', async () => {
    const tasks = resolveTasks('cross-changelog-to-issue', ['multi']).slice(0, 1);
    const records = await runToolChoiceEval({
      models: [MODEL_PRESETS['haiku45'] as ModelPreset],
      modes: ['native-ptc'],
      tasks,
      runs: 1,
      caller: async () => {
        throw new Error('never called');
      },
    });
    expect(records).toEqual([]);
    await expect(
      runToolChoiceEval({
        modes: ['native-ptc'],
        tasks,
        runs: 1,
        batch: { client: { create: () => Promise.reject(new Error('x')) } as never },
      }),
    ).rejects.toThrow(/Message Batches/);
  });
});

async function workplace(): Promise<MultiWorld> {
  const world = await openWorld('workplace');
  if (!('boxes' in world)) throw new Error('expected the workplace world');
  return world;
}

describe('the host gate is the same in every non-Projection mode', () => {
  it('a write is shown to the approver with the same prompt, and refused with the same text', async () => {
    const outcomes: unknown[] = [];
    for (const mode of ['direct', 'native-search', 'native-ptc'] as EvalMode[]) {
      const world = await workplace();
      const session = await openSession(mode, world, {
        approver: { persona: 'cancel', cancelAfter: 0 },
      });
      try {
        const listed = JSON.parse(
          (await session.runtime.call(hostToolName('chat', 'list_channels'), { limit: 100 })).text,
        ) as { channels: { id: string }[] };
        const result = await session.runtime.call(hostToolName('chat', 'post_message'), {
          channel_id: listed.channels[0]?.id,
          text: 'hello',
        });
        outcomes.push({
          tools: toolNames(agentTools(session.runtime)).filter(
            (name) => !name.startsWith('tool_search') && name !== 'code_execution',
          ),
          system: session.runtime.system,
          result,
          prompts: session.elicitations.map((e) => e.message),
          writes: world.calls.filter((c) => c.tool === 'chat.post_message').length,
        });
        expect(session.mode).toBe(mode);
      } finally {
        await session.close();
        await world.close();
      }
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[2]).toEqual(outcomes[0]);
    expect((outcomes[0] as { writes: number }).writes).toBe(0);
    expect((outcomes[0] as { prompts: string[] }).prompts).toHaveLength(1);
  });

  it('a programmatic call in a live episode passes the gate like a direct one', async () => {
    const world = await workplace();
    const session = await openSession('native-ptc', world, {
      approver: { persona: 'cancel', cancelAfter: 0 },
    });
    try {
      const post = hostToolName('chat', 'post_message');
      const fromCode = { type: 'code_execution_20260120', tool_id: 'srvtoolu_x' };
      const caller: ModelCaller = async (params) => {
        const turn = params.messages.filter((m) => m.role === 'assistant').length;
        return turn === 0
          ? message(
              [
                {
                  type: 'server_tool_use',
                  id: 'srvtoolu_x',
                  name: 'code_execution',
                  input: { code: '...' },
                },
                {
                  type: 'tool_use',
                  id: 'toolu_p',
                  name: post,
                  input: { channel_id: 'C1', text: 'hi' },
                  caller: fromCode,
                },
              ],
              'tool_use',
              { container: { id: 'container_x', expires_at: '' } },
            )
          : message([{ type: 'text', text: 'The user dismissed it.' }], 'end_turn');
      };
      const episode = await runAgentEpisode(caller, preset, session.runtime, 'Post hi.');
      expect(session.elicitations).toHaveLength(1);
      expect(session.elicitations[0]?.toolCall).toEqual({ index: 0, name: post });
      expect(world.calls.some((c) => c.tool === 'chat.post_message')).toBe(false);
      expect(episode.toolUses[0]).toMatchObject({ name: post, fromCode: 'srvtoolu_x' });
    } finally {
      await session.close();
      await world.close();
    }
  });
});
