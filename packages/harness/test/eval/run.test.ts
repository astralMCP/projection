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
import { afterAll, describe, expect, it } from 'vitest';
import {
  createResultsWriter,
  formatEpisodeLine,
  formatToolChoiceReport,
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

  it('offers the model the right tool surface and system prompt per mode', () => {
    const directRequest = seen.find((p) => toolNames(p.tools).includes('get_me'));
    const projectionRequest = seen.find((p) => toolNames(p.tools).includes('call_tool'));
    expect(directRequest?.tools).toHaveLength(95);
    expect(String(directRequest?.system)).toContain(
      'You operate GitHub through the tools provided.',
    );
    expect(String(directRequest?.system)).toContain('Tool selection guidance');

    const projectionNames = toolNames(projectionRequest?.tools).toSorted();
    expect(projectionNames).toEqual([
      'call_tool',
      'describe_tool',
      'discover_apis',
      'execute_machine',
      'search_tools',
    ]);
    expect(String(projectionRequest?.system)).toContain('Tool selection guidance');
    expect(String(projectionRequest?.system)).not.toContain(
      'You operate GitHub through the tools provided.',
    );

    // The request shape: streaming params with the cache marker and no forced tool_choice.
    expect(directRequest?.cache_control).toEqual({ type: 'ephemeral' });
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
    expect(texts.some((t) => t === '{"login":"vibdev"}')).toBe(true); // direct
    expect(texts.some((t) => t.includes('vibdev') && t !== '{"login":"vibdev"}')).toBe(true); // via call_tool
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
      for (const block of errorBlocks) expect(String(block.content)).toMatch(/404/);
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
});
