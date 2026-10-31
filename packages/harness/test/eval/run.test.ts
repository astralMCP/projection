/**
 * The eval plumbing, offline: a scripted "model" drives both modes end to
 * end for a read-only task and a gated one, proving that direct calls reach
 * the fake, that Projection's call_tool path auto-fulfils the approval round
 * trip under the approve-all client, that upstream calls are recorded and
 * scored, and that the report and JSON come out.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { APIError } from '@anthropic-ai/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createResultsWriter,
  formatEpisodeLine,
  formatToolChoiceReport,
  hostToolName,
  modeApplies,
  GITHUB_CATALOG,
  GITHUB_DIRECT_SYSTEM_PROMPT,
  HOST_TOOL_NAME_MAX,
  HOST_TOOL_NAME_PATTERN,
  MODEL_PRESETS,
  resolveModelPresets,
  resolveModes,
  resolveTasks,
  runToolChoiceEval,
  summarizeToolChoice,
  writeToolChoiceResults,
  type EpisodeRecord,
  type EvalTask,
  type ModelCaller,
  type ModelPreset,
} from '../../src/index.js';
import { GITHUB_FAKE_ANSWERS } from '../../src/eval/github-fake.js';
import { toolNames } from './tool-names.js';

function message(content: unknown[], stop: Anthropic.StopReason): Anthropic.Message {
  return {
    id: 'msg_scripted',
    type: 'message',
    role: 'assistant',
    model: 'scripted',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 0,
    },
  } as unknown as Anthropic.Message;
}

function toolUse(id: string, name: string, input: Record<string, unknown>): unknown {
  return { type: 'tool_use', id, name, input };
}

/**
 * A model that knows the answer: one upstream call per task, routed through
 * call_tool when Projection's tools are on offer, then end_turn once the
 * result is back. Records every request so the test can inspect the shape.
 */
function scriptedCaller(seen: Anthropic.MessageStreamParams[]): ModelCaller {
  return async (params) => {
    seen.push(params);
    const last = params.messages.at(-1);
    if (last === undefined) throw new Error('no messages');
    if (Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')) {
      return message([{ type: 'text', text: 'Done.' }], 'end_turn');
    }
    const prompt = typeof last.content === 'string' ? last.content : '';
    const upstream = prompt.includes('username')
      ? { name: 'get_me', args: {} }
      : {
          name: 'issue_write',
          args: {
            method: 'create',
            owner: 'modelcontextprotocol',
            repo: 'servers',
            title: 'Crash on startup',
            body: 'The server crashes on startup when the config file is missing.',
          },
        };
    const names = new Set(toolNames(params.tools));
    if (names.has('call_tool')) {
      return message(
        [toolUse('tu_1', 'call_tool', { name: upstream.name, args: upstream.args })],
        'tool_use',
      );
    }
    return message([toolUse('tu_1', upstream.name, upstream.args)], 'tool_use');
  };
}

const preset: ModelPreset = { name: 'scripted', model: 'scripted-model', params: {} };
const tmp = mkdtempSync(join(tmpdir(), 'tool-choice-eval-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The system prompt's text, whether the request sent a string or text blocks. */
function systemText(system: string | readonly { text: string }[] | undefined): string {
  if (system === undefined) return '';
  return typeof system === 'string' ? system : system.map((block) => block.text).join('');
}

describe('tool-choice eval plumbing (offline)', () => {
  let records: EpisodeRecord[];
  const seen: Anthropic.MessageStreamParams[] = [];

  it('drives both modes end to end with a scripted model', { timeout: 60_000 }, async () => {
    records = await runToolChoiceEval({
      models: [preset],
      modes: resolveModes(undefined),
      tasks: resolveTasks('who-am-i,create-issue'),
      runs: 1,
      caller: scriptedCaller(seen),
    });
    expect(records).toHaveLength(4);
    for (const record of records) {
      expect(record.harnessError).toBeUndefined();
      expect(record.turnCapped).toBe(false);
      expect(record.success).toBe(true);
      expect(record.toolCorrect).toBe(true);
      expect(record.apiTurns).toBe(2);
      expect(record.toolUseCount).toBe(1);
    }

    const direct = records.filter((r) => r.mode === 'direct');
    expect(direct.map((r) => r.toolUses[0]?.name)).toEqual(['get_me', 'issue_write']);
    expect(direct.map((r) => r.upstreamCalls.map((c) => c.tool))).toEqual([
      ['get_me'],
      ['issue_write'],
    ]);
    expect(direct.every((r) => r.projection === undefined)).toBe(true);

    const projection = records.filter((r) => r.mode === 'projection');
    expect(projection.map((r) => r.toolUses[0]?.name)).toEqual(['call_tool', 'call_tool']);
    expect(projection.map((r) => r.upstreamCalls.map((c) => c.tool))).toEqual([
      ['get_me'],
      ['issue_write'],
    ]);
    expect(projection.map((r) => r.projection?.route)).toEqual(['call_tool', 'call_tool']);
    // get_me is read-only (no prompt); issue_write asked once and was approved.
    expect(projection.map((r) => r.projection?.approvals)).toEqual([0, 1]);
    expect(projection[1]?.upstreamCalls[0]?.args).toMatchObject({
      method: 'create',
      title: 'Crash on startup',
    });
  });

  it('records the transcript as the model saw it, and the served model', () => {
    for (const record of records) {
      expect(record.servedModel).toBe('scripted');
      const transcript = record.transcript;
      expect(transcript?.system).toBe(
        systemText(
          seen.find((p) => toolNames(p.tools).includes('call_tool') === (record.mode !== 'direct'))
            ?.system,
        ),
      );
      const messages = transcript?.messages ?? [];
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(typeof messages[0]?.content).toBe('string');
      const blocks = (at: number): { type: string; name?: string; content?: string }[] => {
        const content = messages[at]?.content;
        return Array.isArray(content) ? content : [];
      };
      const call = blocks(1)[0];
      expect(call?.type).toBe('tool_use');
      expect(call?.name).toBe(record.toolUses[0]?.name);
      const result = blocks(2)[0];
      expect(result?.type).toBe('tool_result');
      expect(typeof result?.content).toBe('string');
      expect(messages[3]?.content).toEqual([{ type: 'text', text: 'Done.' }]);
    }
    // The result text in the transcript is exactly what the model was sent.
    const sent = seen.flatMap((p) => {
      const last = p.messages.at(-1);
      return Array.isArray(last?.content)
        ? last.content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : []))
        : [];
    });
    const recorded = records.flatMap((r) =>
      (r.transcript?.messages ?? []).flatMap((m) =>
        Array.isArray(m.content)
          ? m.content.flatMap((b) =>
              b.type === 'tool_result' ? [(b as { content: string }).content] : [],
            )
          : [],
      ),
    );
    // (Each request's params share the episode's growing messages array, so
    // the same result shows up once per request: compare the distinct texts.)
    expect(recorded.toSorted()).toEqual([...new Set(sent.map(String))].toSorted());
  });

  it('offers the model the right tool surface and system prompt per mode', () => {
    const directRequest = seen.find((p) => toolNames(p.tools).includes('get_me'));
    const projectionRequest = seen.find((p) => toolNames(p.tools).includes('call_tool'));
    expect(directRequest?.tools).toHaveLength(95);
    expect(systemText(directRequest?.system)).toContain(
      'You operate GitHub through the tools provided.',
    );
    expect(systemText(directRequest?.system)).toContain('Tool selection guidance');

    const projectionNames = toolNames(projectionRequest?.tools).toSorted();
    expect(projectionNames).toEqual([
      'call_tool',
      'describe_tool',
      'discover_apis',
      'execute_machine',
      'search_tools',
    ]);
    expect(systemText(projectionRequest?.system)).toContain('Tool selection guidance');
    // The host's framing comes first in every mode; then the facade's instructions.
    expect(systemText(projectionRequest?.system).startsWith(GITHUB_DIRECT_SYSTEM_PROMPT)).toBe(
      true,
    );

    // The request shape: streaming params with the cache marker and no forced tool_choice.
    expect(directRequest?.cache_control).toEqual({ type: 'ephemeral' });
    // A second breakpoint on the system prompt caches the static prefix (tools + system).
    expect(
      Array.isArray(directRequest?.system) && directRequest.system.at(-1)?.cache_control,
    ).toEqual({
      type: 'ephemeral',
    });
    expect(directRequest?.tool_choice).toBeUndefined();
    expect(directRequest?.max_tokens).toBe(16000);
  });

  it('gives the model the tool result text, including the gated call outcome', () => {
    const resultTurns = seen.filter((p) => {
      const last = p.messages.at(-1);
      return Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_result');
    });
    const texts = resultTurns.map((p) => {
      const last = p.messages.at(-1);
      const block = Array.isArray(last?.content) ? last.content[0] : undefined;
      return block !== undefined && block.type === 'tool_result' ? String(block.content) : '';
    });
    const me = JSON.stringify(GITHUB_FAKE_ANSWERS['get_me']);
    expect(texts.some((t) => t === me)).toBe(true); // direct
    expect(texts.some((t) => t.includes('vibdev') && t !== me)).toBe(true); // via call_tool
  });

  it('summarizes, formats and writes the results', () => {
    const summary = summarizeToolChoice(records);
    expect(summary.cells).toHaveLength(2);
    expect(summary.cells.map((c) => [c.mode, c.successes, c.scored])).toEqual([
      ['direct', 2, 2],
      ['projection', 2, 2],
    ]);
    expect(summary.cells[1]?.routes).toEqual({
      call_tool: 2,
      execute_machine: 0,
      both: 0,
      neither: 0,
    });
    expect(summary.cells[0]?.cacheReadShare).toBeCloseTo(0.8);

    const report = formatToolChoiceReport(records);
    expect(report).toContain('scripted');
    expect(report).toContain('who-am-i');
    expect(report).toContain('Projection routes');
    expect(report).toContain('2/2');
    expect(report).toContain('turn-capped');
    expect(formatEpisodeLine(records[0] as EpisodeRecord)).toContain('who-am-i #0: ok');
    expect(formatEpisodeLine(records[0] as EpisodeRecord)).not.toContain('turn-capped');

    const path = writeToolChoiceResults(records, join(tmp, 'eval-results'), { runs: 1 });
    const written = JSON.parse(readFileSync(path, 'utf8')) as { records: unknown[]; runs: number };
    expect(written.records).toHaveLength(4);
    expect(written.runs).toBe(1);
  });

  it('reports a harness error separately when the model refuses', { timeout: 60_000 }, async () => {
    const refusing: ModelCaller = async () => message([], 'refusal');
    const [record] = await runToolChoiceEval({
      models: [preset],
      modes: ['direct'],
      tasks: resolveTasks('who-am-i'),
      runs: 1,
      caller: refusing,
    });
    expect(record?.harnessError).toBe('stop_reason refusal');
    expect(record?.success).toBe(false);
    expect(record?.turnCapped).toBe(false);
    const summary = summarizeToolChoice([record as EpisodeRecord]);
    expect(summary.cells[0]).toMatchObject({ scored: 0, successes: 0, harnessErrors: 1 });
    expect(formatToolChoiceReport([record as EpisodeRecord])).toContain('Harness errors');
  });

  describe('context overflow is a scored failure', () => {
    /** Makes the right call on turn 1; turn 2 overflows as `overflow` says. */
    const overflowingCaller =
      (overflow: () => Anthropic.Message): ModelCaller =>
      async (params) => {
        const last = params.messages.at(-1);
        if (Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_result')) {
          return overflow();
        }
        return message([toolUse('tu_me', 'get_me', {})], 'tool_use');
      };
    const run = (caller: ModelCaller) =>
      runToolChoiceEval({
        models: [preset],
        modes: ['direct'],
        tasks: resolveTasks('who-am-i'),
        runs: 1,
        caller,
      });

    it(
      'a 400 prompt-too-long ends the episode scored, as a failure',
      { timeout: 60_000 },
      async () => {
        const [record] = await run(
          overflowingCaller(() => {
            throw APIError.generate(
              400,
              {
                type: 'error',
                error: {
                  type: 'invalid_request_error',
                  message: 'prompt is too long: 215000 tokens > 200000 maximum',
                },
              },
              undefined,
              new Headers(),
            );
          }),
        );
        expect(record?.contextOverflow).toBe(true);
        expect(record?.harnessError).toBeUndefined();
        expect(record?.infraFailure).toBeUndefined();
        // The right call was made, and it is still a failure.
        expect(record?.toolCorrect).toBe(true);
        expect(record?.success).toBe(false);
        expect(record?.stopReason).toBe('model_context_window_exceeded');
        const summary = summarizeToolChoice([record as EpisodeRecord]);
        expect(summary.cells[0]).toMatchObject({
          scored: 1,
          successes: 0,
          harnessErrors: 0,
          contextOverflows: 1,
        });
        expect(summary.tiers[0]).toMatchObject({ scored: 1, contextOverflows: 1 });
        expect(summary.tasks[0]).toMatchObject({ scored: 1, contextOverflows: 1 });
        const report = formatToolChoiceReport([record as EpisodeRecord]);
        expect(report).toContain('ctx-overflow');
        expect(report).not.toContain('Harness errors');
        expect(formatEpisodeLine(record as EpisodeRecord)).toContain('context-overflow');
      },
    );

    it('so does the model_context_window_exceeded stop reason', { timeout: 60_000 }, async () => {
      const [record] = await run(
        overflowingCaller(() =>
          message(
            [{ type: 'text', text: 'partial' }],
            'model_context_window_exceeded' as Anthropic.StopReason,
          ),
        ),
      );
      expect(record?.contextOverflow).toBe(true);
      expect(record?.harnessError).toBeUndefined();
      expect(record?.success).toBe(false);
      expect(summarizeToolChoice([record as EpisodeRecord]).cells[0]?.contextOverflows).toBe(1);
    });

    it('any other 400 is still an excluded API error', { timeout: 60_000 }, async () => {
      const [record] = await run(
        overflowingCaller(() => {
          throw APIError.generate(
            400,
            { type: 'error', error: { type: 'invalid_request_error', message: 'tools.0: bad' } },
            undefined,
            new Headers(),
          );
        }),
      );
      expect(record?.contextOverflow).toBeUndefined();
      expect(record?.harnessError).toMatch(/^api error: /);
      expect(summarizeToolChoice([record as EpisodeRecord]).cells[0]).toMatchObject({
        scored: 0,
        contextOverflows: 0,
      });
    });
  });

  it(
    'scores a turn-capped episode on its upstream calls instead of dropping it',
    { timeout: 60_000 },
    async () => {
      // A model that never stops: get_me on every turn, forever.
      const looping: ModelCaller = async (params) => {
        const names = new Set(toolNames(params.tools));
        return names.has('call_tool')
          ? message([toolUse('tu_loop', 'call_tool', { name: 'get_me', args: {} })], 'tool_use')
          : message([toolUse('tu_loop', 'get_me', {})], 'tool_use');
      };
      const records = await runToolChoiceEval({
        models: [preset],
        modes: resolveModes(undefined),
        tasks: resolveTasks('who-am-i'),
        runs: 1,
        maxTurns: 3,
        caller: looping,
      });
      expect(records).toHaveLength(2);
      for (const record of records) {
        expect(record.turnCapped).toBe(true);
        expect(record.harnessError).toBeUndefined();
        expect(record.apiTurns).toBe(3);
        expect(record.upstreamCalls.map((c) => c.tool)).toEqual(['get_me', 'get_me', 'get_me']);
        expect(record.success).toBe(true);
        expect(record.toolCorrect).toBe(true);
        expect(formatEpisodeLine(record)).toContain('ok');
        expect(formatEpisodeLine(record)).toContain('(turn-capped)');
      }
      const summary = summarizeToolChoice(records);
      for (const cell of summary.cells) {
        expect(cell).toMatchObject({
          episodes: 1,
          scored: 1,
          successes: 1,
          toolCorrect: 1,
          turnCapped: 1,
          harnessErrors: 0,
        });
      }
      expect(summary.tasks.map((t) => [t.successes, t.scored])).toEqual([
        [1, 1],
        [1, 1],
      ]);
      // Every looping turn called an upstream tool, so all of them counted.
      expect(records.map((r) => r.budgetTurns)).toEqual([3, 3]);
    },
  );

  it(
    'does not charge Projection discovery turns to the budget, up to the absolute ceiling',
    { timeout: 60_000 },
    async () => {
      // Projection: four search_tools turns, then call_tool, then the answer.
      // Direct: get_me on the first turn, then the answer.
      const discoverThenAct: ModelCaller = async (params) => {
        const names = new Set(toolNames(params.tools));
        const assistantTurns = params.messages.filter((m) => m.role === 'assistant').length;
        const last = params.messages.at(-1);
        const sawResult =
          Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_result');
        if (!names.has('call_tool')) {
          return sawResult
            ? message([{ type: 'text', text: 'vibdev' }], 'end_turn')
            : message([toolUse('tu_direct', 'get_me', {})], 'tool_use');
        }
        if (assistantTurns < 4) {
          return message(
            [toolUse(`tu_s${assistantTurns}`, 'search_tools', { query: 'me' })],
            'tool_use',
          );
        }
        if (assistantTurns === 4) {
          return message(
            [toolUse('tu_call', 'call_tool', { name: 'get_me', args: {} })],
            'tool_use',
          );
        }
        return message([{ type: 'text', text: 'vibdev' }], 'end_turn');
      };
      const discovered = await runToolChoiceEval({
        models: [preset],
        modes: resolveModes(undefined),
        tasks: resolveTasks('who-am-i'),
        runs: 1,
        maxTurns: 3,
        caller: discoverThenAct,
      });
      const direct = discovered.find((r) => r.mode === 'direct');
      const projection = discovered.find((r) => r.mode === 'projection');
      expect(direct).toMatchObject({
        success: true,
        turnCapped: false,
        apiTurns: 2,
        budgetTurns: 2,
      });
      // Six API calls, but only the call_tool turn and the answer counted.
      expect(projection).toMatchObject({
        success: true,
        turnCapped: false,
        apiTurns: 6,
        budgetTurns: 2,
      });
      expect(projection?.projection?.searchTools).toBe(4);
      expect(formatEpisodeLine(projection as EpisodeRecord)).toContain('turns 6 (2 counted)');

      // A model that only ever discovers hits the absolute ceiling, not the budget.
      const onlyDiscover: ModelCaller = async () =>
        message([toolUse('tu_s', 'search_tools', { query: 'me' })], 'tool_use');
      const [capped] = await runToolChoiceEval({
        models: [preset],
        modes: ['projection'],
        tasks: resolveTasks('who-am-i'),
        runs: 1,
        maxTurns: 3,
        maxTotalTurns: 5,
        caller: onlyDiscover,
      });
      expect(capped).toMatchObject({
        turnCapped: true,
        apiTurns: 5,
        budgetTurns: 0,
        success: false,
      });
      const report = formatToolChoiceReport(discovered);
      expect(report).not.toContain('Harness errors');
      expect(report).toContain('1/1 100%');
    },
  );

  it(
    'charges a turn that mixes discovery with any other tool, and an empty tool_use turn',
    { timeout: 60_000 },
    async () => {
      // Turn 1: search_tools AND call_tool in one message (counts). Turn 2: answer.
      const mixed: ModelCaller = async (params) => {
        const assistantTurns = params.messages.filter((m) => m.role === 'assistant').length;
        if (assistantTurns === 0) {
          return message(
            [
              toolUse('tu_s', 'search_tools', { query: 'me' }),
              toolUse('tu_c', 'call_tool', { name: 'get_me', args: {} }),
            ],
            'tool_use',
          );
        }
        return message([{ type: 'text', text: 'vibdev' }], 'end_turn');
      };
      const [mixedRecord] = await runToolChoiceEval({
        models: [preset],
        modes: ['projection'],
        tasks: resolveTasks('who-am-i'),
        runs: 1,
        caller: mixed,
      });
      expect(mixedRecord).toMatchObject({
        success: true,
        apiTurns: 2,
        budgetTurns: 2,
      });
      expect(mixedRecord?.projection?.searchTools).toBe(1);

      // A tool_use stop with no tool_use block is not discovery: it counts.
      // The loop answers it with an empty tool_result list; the script then
      // discovers once (free), acts (counts) and answers (counts).
      const emptyThenAct: ModelCaller = async (params) => {
        const assistantTurns = params.messages.filter((m) => m.role === 'assistant').length;
        const last = params.messages.at(-1);
        if (assistantTurns === 1) {
          expect(last).toEqual({ role: 'user', content: [] });
        }
        switch (assistantTurns) {
          case 0:
            return message([{ type: 'text', text: 'thinking about it' }], 'tool_use');
          case 1:
            return message([toolUse('tu_s', 'search_tools', { query: 'me' })], 'tool_use');
          case 2:
            return message(
              [toolUse('tu_c', 'call_tool', { name: 'get_me', args: {} })],
              'tool_use',
            );
          default:
            return message([{ type: 'text', text: 'vibdev' }], 'end_turn');
        }
      };
      const [emptyRecord] = await runToolChoiceEval({
        models: [preset],
        modes: ['projection'],
        tasks: resolveTasks('who-am-i'),
        runs: 1,
        caller: emptyThenAct,
      });
      expect(emptyRecord).toMatchObject({
        success: true,
        turnCapped: false,
        apiTurns: 4,
        budgetTurns: 3,
      });
    },
  );

  it('clamps a ceiling below the budget up to the budget', { timeout: 60_000 }, async () => {
    // Pure discovery never spends the budget; the (clamped) ceiling stops it.
    const onlyDiscover: ModelCaller = async () =>
      message([toolUse('tu_s', 'search_tools', { query: 'me' })], 'tool_use');
    const [clamped] = await runToolChoiceEval({
      models: [preset],
      modes: ['projection'],
      tasks: resolveTasks('who-am-i'),
      runs: 1,
      maxTurns: 3,
      maxTotalTurns: 1,
      caller: onlyDiscover,
    });
    expect(clamped).toMatchObject({ turnCapped: true, apiTurns: 3, budgetTurns: 0 });
  });

  it(
    'counts every turn in direct mode, harness-error episodes included',
    { timeout: 60_000 },
    async () => {
      // Two upstream calls, then a refusal: three API calls, three counted.
      const refuseLater: ModelCaller = async (params) => {
        const assistantTurns = params.messages.filter((m) => m.role === 'assistant').length;
        return assistantTurns < 2
          ? message([toolUse(`tu_${assistantTurns}`, 'get_me', {})], 'tool_use')
          : message([], 'refusal');
      };
      const [refused] = await runToolChoiceEval({
        models: [preset],
        modes: ['direct'],
        tasks: resolveTasks('who-am-i'),
        runs: 1,
        caller: refuseLater,
      });
      expect(refused).toMatchObject({
        harnessError: 'stop_reason refusal',
        apiTurns: 3,
        budgetTurns: 3,
      });
      expect(refused?.upstreamCalls.map((c) => c.tool)).toEqual(['get_me', 'get_me']);
      expect(formatEpisodeLine(refused as EpisodeRecord)).not.toContain('counted');
    },
  );

  it(
    'turns a throw inside one episode into a harness-error record and finishes the rest',
    { timeout: 60_000 },
    async () => {
      // The caller explodes on the create-issue prompt only; who-am-i is unaffected.
      const seenHere: Anthropic.MessageStreamParams[] = [];
      const inner = scriptedCaller(seenHere);
      const exploding: ModelCaller = async (params) => {
        const first = params.messages[0];
        const prompt = typeof first?.content === 'string' ? first.content : '';
        if (prompt.includes('Crash on startup') && params.messages.length > 1) {
          throw new TypeError('fake session wiring broke');
        }
        return inner(params);
      };
      const records = await runToolChoiceEval({
        models: [preset],
        modes: ['direct'],
        tasks: resolveTasks('who-am-i,create-issue'),
        runs: 2,
        concurrency: 2,
        caller: exploding,
        // A broken progress callback must not take the matrix down either.
        onEpisode: () => {
          throw new Error('progress sink is down');
        },
      });
      expect(records).toHaveLength(4);
      expect(records.map((r) => r.task)).toEqual([
        'who-am-i',
        'who-am-i',
        'create-issue',
        'create-issue',
      ]);
      const [me1, me2, issue1, issue2] = records as [
        EpisodeRecord,
        EpisodeRecord,
        EpisodeRecord,
        EpisodeRecord,
      ];
      for (const record of [me1, me2]) {
        expect(record.harnessError).toBeUndefined();
        expect(record.success).toBe(true);
      }
      // A thrown API call is the agent loop's own harness error (not ours)...
      for (const record of [issue1, issue2]) {
        expect(record.harnessError).toBe('api error: TypeError: fake session wiring broke');
        expect(record.success).toBe(false);
        expect(record.toolCorrect).toBe(false);
        // ...and the upstream call made before the throw is still on record.
        expect(record.upstreamCalls.map((c) => c.tool)).toEqual(['issue_write']);
      }

      // ...whereas a throw in the harness around the loop (here: the task
      // predicate) becomes a `harness:` record with the observed calls kept.
      const who = resolveTasks('who-am-i')[0] as EvalTask;
      const brokenTask: EvalTask = {
        ...who,
        name: 'who-am-i-broken',
        expect: () => {
          throw new RangeError('predicate exploded');
        },
      };
      const [broken, fine] = await runToolChoiceEval({
        models: [preset],
        modes: ['direct'],
        tasks: [brokenTask, who],
        runs: 1,
        caller: scriptedCaller([]),
      });
      expect(broken?.harnessError).toBe('harness: RangeError: predicate exploded');
      expect(broken?.success).toBe(false);
      expect(broken?.toolCorrect).toBe(false);
      expect(broken?.upstreamCalls.map((c) => c.tool)).toEqual(['get_me']);
      expect(broken?.apiTurns).toBe(2);
      expect(fine?.success).toBe(true);
      const summary = summarizeToolChoice([broken as EpisodeRecord, fine as EpisodeRecord]);
      expect(summary.cells[0]).toMatchObject({
        episodes: 2,
        scored: 1,
        successes: 1,
        harnessErrors: 1,
      });
    },
  );

  it('rewrites one results file in place so partial runs survive', () => {
    const writer = createResultsWriter(join(tmp, 'partial'), { runs: 1 });
    expect(existsSync(writer.path)).toBe(false);
    writer.write([records[0] as EpisodeRecord]);
    const first = JSON.parse(readFileSync(writer.path, 'utf8')) as {
      records: unknown[];
      summary: { episodes: number };
      updatedAt: string;
    };
    expect(first.records).toHaveLength(1);
    expect(first.summary.episodes).toBe(1);
    writer.write(records);
    const second = JSON.parse(readFileSync(writer.path, 'utf8')) as { records: unknown[] };
    expect(second.records).toHaveLength(4);
  });

  it(
    'drives a hard task through both modes: the fake rejects the first attempt, the corrected call scores',
    { timeout: 60_000 },
    async () => {
      // A model that reads README.md, is told 404, lists the root, then reads
      // readme.md — the recovery the read-lowercase-readme task scores. In
      // projection mode every step goes through call_tool and the upstream
      // error arrives as call_tool's `upstream` error result.
      const ACME = { owner: 'acme', repo: 'widgets' };
      const plan = [
        { name: 'get_file_contents', args: { ...ACME, path: 'README.md' } },
        { name: 'get_file_contents', args: { ...ACME, path: '' } },
        { name: 'get_file_contents', args: { ...ACME, path: 'readme.md' } },
      ];
      const seenHere: Anthropic.MessageStreamParams[] = [];
      const recovering: ModelCaller = async (params) => {
        seenHere.push(params);
        const resultsSoFar = params.messages.filter(
          (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
        ).length;
        const step = plan[resultsSoFar];
        if (step === undefined) return message([{ type: 'text', text: 'Here it is.' }], 'end_turn');
        const names = new Set(toolNames(params.tools));
        return names.has('call_tool')
          ? message(
              [toolUse(`tu_${resultsSoFar}`, 'call_tool', { name: step.name, args: step.args })],
              'tool_use',
            )
          : message([toolUse(`tu_${resultsSoFar}`, step.name, step.args)], 'tool_use');
      };
      const hard = await runToolChoiceEval({
        models: [preset],
        modes: resolveModes(undefined),
        tasks: resolveTasks('read-lowercase-readme', ['hard']),
        runs: 1,
        caller: recovering,
      });
      expect(hard).toHaveLength(2);
      for (const record of hard) {
        expect(record.tier).toBe('hard');
        expect(record.harnessError).toBeUndefined();
        expect(record.success).toBe(true);
        expect(record.forbidden).toBe(false);
        expect(record.upstreamCalls.map((c) => c.args['path'])).toEqual([
          'README.md',
          '',
          'readme.md',
        ]);
        expect(record.toolUses.map((t) => t.isError)).toEqual([true, false, false]);
      }
      // The error text reached the model in both modes. (Each episode's
      // requests share one growing `messages` array, so collect the distinct
      // error blocks rather than looking at the last message per request.)
      const errorBlocks = new Set<Anthropic.ToolResultBlockParam>();
      for (const p of seenHere) {
        for (const m of p.messages) {
          if (!Array.isArray(m.content)) continue;
          for (const b of m.content) {
            if (b.type === 'tool_result' && b.is_error === true) errorBlocks.add(b);
          }
        }
      }
      expect(errorBlocks.size).toBe(2);
      for (const block of errorBlocks) {
        expect(String(block.content)).toContain('Failed to get file contents.');
      }
      const summary = summarizeToolChoice(hard);
      expect(
        summary.tiers.map((t) => [t.tier, t.mode, t.successes, t.scored, t.forbidden]),
      ).toEqual([
        ['hard', 'direct', 1, 1, 0],
        ['hard', 'projection', 1, 1, 0],
      ]);
      const report = formatToolChoiceReport(hard);
      expect(report).toContain('hard task (successes/scored)');
      expect(report).not.toContain('basic task');
      expect(report).toContain('tier (success; tool-ok; forbidden)');
    },
  );

  it(
    'marks an episode that makes a forbidden call, and the tier summary counts it',
    { timeout: 60_000 },
    async () => {
      // star-unless-starred: the user already starred acme/widgets. This model
      // looks, then stars anyway.
      const plan = [
        { name: 'list_starred_repositories', args: {} },
        { name: 'star_repository', args: { owner: 'acme', repo: 'widgets' } },
      ];
      const eager: ModelCaller = async (params) => {
        const resultsSoFar = params.messages.filter(
          (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
        ).length;
        const step = plan[resultsSoFar];
        if (step === undefined) return message([{ type: 'text', text: 'Starred.' }], 'end_turn');
        return message([toolUse(`tu_${resultsSoFar}`, step.name, step.args)], 'tool_use');
      };
      const [record] = await runToolChoiceEval({
        models: [preset],
        modes: ['direct'],
        tasks: resolveTasks('star-unless-starred'),
        runs: 1,
        caller: eager,
      });
      expect(record?.upstreamCalls.map((c) => c.tool)).toEqual([
        'list_starred_repositories',
        'star_repository',
      ]);
      expect(record?.forbidden).toBe(true);
      expect(record?.success).toBe(false);
      expect(record?.toolCorrect).toBe(true);
      expect(formatEpisodeLine(record as EpisodeRecord)).toContain('forbidden-call');
      const summary = summarizeToolChoice([record as EpisodeRecord]);
      expect(summary.tiers[0]).toMatchObject({
        tier: 'hard',
        successes: 0,
        scored: 1,
        forbidden: 1,
        toolCorrect: 1,
      });
      expect(summary.tasks[0]).toMatchObject({
        task: 'star-unless-starred',
        tier: 'hard',
        successes: 0,
      });
    },
  );

  it('groups the per-task table by tier when both tiers ran', () => {
    const basic = records[0] as EpisodeRecord;
    const hard: EpisodeRecord = {
      ...basic,
      task: 'rerun-failed-jobs',
      tier: 'hard',
      success: false,
      forbidden: true,
    };
    const report = formatToolChoiceReport([basic, hard]);
    const basicAt = report.indexOf('basic task (successes/scored)');
    const hardAt = report.indexOf('hard task (successes/scored)');
    expect(basicAt).toBeGreaterThan(0);
    expect(hardAt).toBeGreaterThan(basicAt);
    expect(report.indexOf('who-am-i')).toBeGreaterThan(basicAt);
    expect(report.indexOf('who-am-i')).toBeLessThan(hardAt);
    expect(report.indexOf('rerun-failed-jobs')).toBeGreaterThan(hardAt);
    const tierTable = report.slice(report.indexOf('tier (success'), basicAt);
    expect(tierTable).toMatch(/basic\s+1\/1 100%; 1\/1; 0/);
    expect(tierTable).toMatch(/hard\s+0\/1 0%; 1\/1; 1/);
    const summary = summarizeToolChoice([basic, hard]);
    expect(summary.tiers.map((t) => t.tier)).toEqual(['basic', 'hard']);
  });

  it('resolves model presets from a comma list and rejects unknown names', () => {
    expect(resolveModelPresets(undefined).map((p) => p.name)).toEqual(['haiku45', 'sonnet-low']);
    expect(resolveModelPresets('sonnet-medium')).toEqual([MODEL_PRESETS['sonnet-medium']]);
    expect(() => resolveModelPresets('opus-max')).toThrow(/unknown model preset/);
    // Haiku 4.5 predates adaptive thinking and `effort`: no params at all.
    expect(MODEL_PRESETS['haiku45']?.params).toEqual({});
    expect(MODEL_PRESETS['haiku-low']?.params).not.toHaveProperty('thinking');
    expect(MODEL_PRESETS['sonnet-low']?.params.output_config).toEqual({ effort: 'low' });
    expect(() => resolveModes('stdio')).toThrow(/unknown mode/);
  });

  it('resolves the multi-tier modes; projection-boxes applies to the multi world only', () => {
    expect(resolveModes(undefined)).toEqual(['direct', 'projection', 'projection-boxes']);
    expect(resolveModes('projection-boxes, direct')).toEqual(['projection-boxes', 'direct']);
    for (const world of ['github', 'filesystem', 'mongodb'] as const) {
      expect(modeApplies('direct', world)).toBe(true);
      expect(modeApplies('projection', world)).toBe(true);
      expect(modeApplies('projection-boxes', world)).toBe(false);
    }
    expect(modeApplies('projection-boxes', 'multi')).toBe(true);
    // The single-server episodes above ran in two modes, never projection-boxes.
    expect(records.map((r) => r.mode)).not.toContain('projection-boxes');
  });

  it('names host-style tools within the Messages API rule, truncating long names deterministically', () => {
    expect(hostToolName('github', 'get_me')).toBe('github__get_me');
    expect(hostToolName('mongo', 'insert-many')).toBe('mongo__insert-many');
    expect(hostToolName('fs', 'odd.name with space')).toBe('fs__odd_name_with_space');
    const long = 'x'.repeat(70);
    const a = hostToolName('github', `${long}_a`);
    const b = hostToolName('github', `${long}_b`);
    for (const name of [a, b]) {
      expect(name).toHaveLength(HOST_TOOL_NAME_MAX);
      expect(name).toMatch(HOST_TOOL_NAME_PATTERN);
      expect(name.startsWith('github__xxx')).toBe(true);
    }
    expect(a).not.toBe(b);
    expect(hostToolName('github', `${long}_a`)).toBe(a);
    // The longest real name across the boxes fits untruncated.
    const longest = GITHUB_CATALOG.tools
      .map((t) => t.name)
      .toSorted((x, y) => y.length - x.length)[0];
    expect(hostToolName('github', longest ?? '')).toBe(`github__${longest ?? ''}`);
  });

  it('breaks Projection discovery out by search tool on the multi world', () => {
    const base = records.find((r) => r.mode === 'projection') as EpisodeRecord;
    const multi = (
      mode: 'projection' | 'projection-boxes',
      searchTools: number,
      searchBoxes: Record<string, number>,
    ): EpisodeRecord => ({
      ...base,
      mode,
      task: 'box-src-github',
      tier: 'multi',
      world: 'multi',
      projection: {
        route: 'call_tool',
        searchTools,
        describeTool: 1,
        discoverApis: 0,
        searchBoxes,
        approvals: 0,
      },
    });
    const withSearch = [
      multi('projection', 2, { fs: 0, github: 1, mongo: 0 }),
      multi('projection', 0, { fs: 0, github: 3, mongo: 0 }),
      multi('projection-boxes', 0, { fs: 1, github: 2, mongo: 0 }),
    ];
    const summary = summarizeToolChoice([base, ...withSearch]);
    const projection = summary.cells.find((c) => c.mode === 'projection');
    // Box searches average over the multi episodes only; search_tools over all.
    expect(projection?.meanSearchBoxes).toEqual({ fs: 0, github: 2, mongo: 0 });
    expect(projection?.meanSearchTools).toBeCloseTo(
      (2 + 0 + (base.projection?.searchTools ?? 0)) / 3,
    );
    const boxes = summary.cells.find((c) => c.mode === 'projection-boxes');
    expect(boxes?.meanSearchBoxes).toEqual({ fs: 1, github: 2, mongo: 0 });
    expect(boxes?.routes).toEqual({ call_tool: 1, execute_machine: 0, both: 0, neither: 0 });

    const report = formatToolChoiceReport([base, ...withSearch]);
    expect(report).toMatch(
      /scripted\/projection: call_tool 3, .*search_fs 0\.0, search_github 2\.0, search_mongo 0\.0, describe_tool/,
    );
    expect(report).toMatch(
      /scripted\/projection-boxes: call_tool 1, .*search_tools 0\.0, search_fs 1\.0/,
    );
    // One Projection mode only: labelled by model, as before.
    expect(formatToolChoiceReport(records)).toMatch(/^  scripted: call_tool 2, /m);
    expect(formatToolChoiceReport(records)).not.toContain('search_github');
    // Single-server records carry no box breakdown.
    expect(records.every((r) => r.projection?.searchBoxes === undefined)).toBe(true);
  });

  it('summarizes each tier on its own episodes: turns, tokens, cost, discovery, box routing', () => {
    const base = records.find((r) => r.mode === 'projection') as EpisodeRecord;
    const multi = (
      success: boolean,
      boxes: NonNullable<EpisodeRecord['boxes']>,
      apiTurns: number,
    ): EpisodeRecord => ({
      ...base,
      mode: 'projection',
      task: 'global-who-is-grace',
      tier: 'multi',
      world: 'multi',
      success,
      apiTurns,
      budgetTurns: apiTurns - 1,
      boxes,
      projection: {
        route: 'call_tool',
        searchTools: boxes.usedGlobalSearch ? 1 : 0,
        describeTool: 2,
        discoverApis: 0,
        searchBoxes: { fs: 0, github: 0, mongo: 1 },
        approvals: 0,
      },
    });
    const routed = [
      multi(
        true,
        { needed: ['mongo'], usedGlobalSearch: true, firstCallRightBox: true, wrongBoxCalls: 0 },
        6,
      ),
      multi(
        false,
        { needed: ['mongo'], usedGlobalSearch: true, firstCallRightBox: false, wrongBoxCalls: 2 },
        10,
      ),
      multi(
        true,
        { needed: ['mongo'], usedGlobalSearch: false, firstCallRightBox: true, wrongBoxCalls: 1 },
        8,
      ),
    ];
    const summary = summarizeToolChoice([base, ...routed]);
    const tier = summary.tiers.find((t) => t.tier === 'multi' && t.mode === 'projection');
    // Only the multi episodes: the basic-tier record's 2 turns do not mix in.
    expect(tier).toMatchObject({
      scored: 3,
      successes: 2,
      meanTurns: 8,
      meanBudgetTurns: 7,
      meanSearchTools: 2 / 3,
      meanDescribeTool: 2,
      meanSearchBoxes: { fs: 0, github: 0, mongo: 1 },
      routing: {
        scored: 3,
        usedGlobalSearch: 2,
        successWithGlobalSearch: 1,
        firstCallRightBox: 2,
        withDetour: 2,
        meanWrongBoxCalls: 1,
      },
    });
    expect(tier?.meanInputTokens).toBe(base.usage.inputTokens + base.usage.cacheReadInputTokens);
    expect(tier?.estimatedUsd).toBe(0);
    const basicTier = summary.tiers.find((t) => t.tier === 'basic' && t.mode === 'projection');
    expect(basicTier?.meanTurns).toBe(2);
    expect(basicTier?.routing).toBeUndefined();

    const report = formatToolChoiceReport([base, ...routed]);
    const block = report.slice(report.indexOf('multi tier'));
    expect(block).toMatch(/global search \(ok\)\s+1st call right box\s+detours \(mean calls\)/);
    expect(block).toMatch(
      /scripted\/projection\s+2\/3\s+67%.*search_tools 0\.7, search_fs 0\.0, search_github 0\.0, search_mongo 1\.0, describe 2\.0, discover 0\.0\s+2\/3 \(1 ok\)\s+2\/3\s+2\/3 \(1\.0\)/,
    );
    expect(report).toMatch(/^basic tier\s+success/m);
  });

  it('runs episodes interleaved by run and task, and returns them in plan order', async () => {
    const started: string[] = [];
    const quick: ModelCaller = async (params) => {
      const prompt = String(params.messages[0]?.content);
      const mode = toolNames(params.tools).includes('call_tool') ? 'projection' : 'direct';
      started.push(`${prompt.includes('username') ? 'who' : 'search'}/${mode}`);
      return message([{ type: 'text', text: 'Done.' }], 'end_turn');
    };
    const indices: number[] = [];
    const plan = await runToolChoiceEval({
      models: [preset],
      modes: ['direct', 'projection'],
      tasks: resolveTasks('who-am-i,search-repos'),
      runs: 2,
      caller: quick,
      onEpisode: (_record, index) => indices.push(index),
    });
    // Ran: run 0 of each task in each mode, then run 1.
    expect(started).toEqual([
      'who/direct',
      'who/projection',
      'search/direct',
      'search/projection',
      'who/direct',
      'who/projection',
      'search/direct',
      'search/projection',
    ]);
    // Returned in model -> mode -> task -> run order, each at its index.
    expect(plan.map((r) => `${r.mode} ${r.task} ${r.run}`)).toEqual([
      'direct who-am-i 0',
      'direct who-am-i 1',
      'direct search-repos 0',
      'direct search-repos 1',
      'projection who-am-i 0',
      'projection who-am-i 1',
      'projection search-repos 0',
      'projection search-repos 1',
    ]);
    expect(indices).toEqual([0, 4, 2, 6, 1, 5, 3, 7]);
  });
});
