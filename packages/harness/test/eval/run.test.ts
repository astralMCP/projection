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
    const names = new Set((params.tools ?? []).map((t) => t.name));
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
    const directRequest = seen.find((p) => (p.tools ?? []).some((t) => t.name === 'get_me'));
    const projectionRequest = seen.find((p) => (p.tools ?? []).some((t) => t.name === 'call_tool'));
    expect(directRequest?.tools).toHaveLength(95);
    expect(String(directRequest?.system)).toContain(
      'You operate GitHub through the tools provided.',
    );
    expect(String(directRequest?.system)).toContain('Tool selection guidance');

    const projectionNames = (projectionRequest?.tools ?? []).map((t) => t.name).toSorted();
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
        const names = new Set((params.tools ?? []).map((t) => t.name));
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
      const report = formatToolChoiceReport(records);
      expect(report).not.toContain('Harness errors');
      expect(report).toContain('1/1 100%');
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

  it('resolves model presets from a comma list and rejects unknown names', () => {
    expect(resolveModelPresets(undefined).map((p) => p.name)).toEqual([
      'haiku-low',
      'sonnet-medium',
    ]);
    expect(resolveModelPresets('sonnet-medium')).toEqual([MODEL_PRESETS['sonnet-medium']]);
    expect(() => resolveModelPresets('opus-max')).toThrow(/unknown model preset/);
    expect(MODEL_PRESETS['haiku-low']?.params).not.toHaveProperty('thinking');
    expect(() => resolveModes('stdio')).toThrow(/unknown mode/);
  });
});
