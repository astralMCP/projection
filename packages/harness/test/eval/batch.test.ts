/**
 * The Message Batches path (PROJ_EVAL_BATCH=1), offline: a fake batches
 * client stands in for `client.messages.batches`. Covers the lockstep (one
 * batch per tick, episodes of different lengths dropping out), the
 * errored / expired / retry handling and the infra-failure record, polling
 * backoff, usage and the 50% cost, and that a batch request is byte for
 * byte the request the interactive path sends.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createResultsWriter,
  estimateUsd,
  formatEpisodeLine,
  formatToolChoiceReport,
  LockstepBatcher,
  resolveModes,
  resolveTasks,
  runAgentEpisode,
  runToolChoiceEval,
  summarizeToolChoice,
  type AgentRuntime,
  type BatchesClient,
  type BatchTick,
  type EpisodeRecord,
  type ModelCaller,
  type ModelPreset,
} from '../../src/index.js';
import { toolNames } from './tool-names.js';

type Params = Anthropic.MessageCreateParamsNonStreaming;
type BatchResult = Anthropic.Messages.MessageBatchResult;

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

const ok = (msg: Anthropic.Message): BatchResult => ({ type: 'succeeded', message: msg });
const errored = (type: 'overloaded_error' | 'api_error' = 'overloaded_error'): BatchResult =>
  ({
    type: 'errored',
    error: { type: 'error', request_id: null, error: { type, message: 'Overloaded' } },
  }) as BatchResult;

interface FakeBatch {
  id: string;
  /** Each request as it would go on the wire (serialized at create time). */
  requests: { custom_id: string; json: string }[];
  results: { custom_id: string; result: BatchResult }[];
  polls: number;
}

/**
 * A fake `messages.batches`: `respond` answers each request at create time;
 * a batch reports `in_progress` for `pollsUntilEnded` polls, then `ended`.
 */
class FakeBatches implements BatchesClient {
  readonly batches: FakeBatch[] = [];
  failCreates = 0;
  constructor(
    private readonly respond: (
      customId: string,
      params: Params,
    ) => Promise<BatchResult | undefined>,
    private readonly pollsUntilEnded = 0,
  ) {}

  async create(params: Anthropic.Messages.BatchCreateParams): Promise<{ id: string }> {
    if (this.failCreates > 0) {
      this.failCreates -= 1;
      throw new Error('connection reset');
    }
    const id = `msgbatch_${this.batches.length + 1}`;
    const batch: FakeBatch = {
      id,
      requests: params.requests.map((r) => ({
        custom_id: r.custom_id,
        json: JSON.stringify(r.params),
      })),
      results: [],
      polls: 0,
    };
    for (const r of params.requests) {
      const result = await this.respond(r.custom_id, r.params);
      if (result !== undefined) batch.results.push({ custom_id: r.custom_id, result });
    }
    this.batches.push(batch);
    return { id };
  }

  async retrieve(id: string) {
    const batch = this.batches.find((b) => b.id === id);
    if (batch === undefined) throw new Error(`no batch ${id}`);
    batch.polls += 1;
    const ended = batch.polls > this.pollsUntilEnded;
    return {
      id,
      processing_status: ended ? ('ended' as const) : ('in_progress' as const),
      request_counts: { processing: 0, succeeded: 0, errored: 0, expired: 0, canceled: 0 },
    };
  }

  async results(
    id: string,
  ): Promise<AsyncIterable<Anthropic.Messages.MessageBatchIndividualResponse>> {
    const batch = this.batches.find((b) => b.id === id);
    const lines = batch?.results ?? [];
    return (async function* () {
      // Out of order, as the API does not promise order.
      yield* lines.toReversed();
    })();
  }
}

/** A recorded sleep that never waits. */
function fakeSleep(log: number[] = []): (ms: number) => Promise<void> {
  return async (ms) => {
    log.push(ms);
  };
}

/** A tiny runtime: one `step` tool, optionally slow, counting its calls. */
function stepRuntime(delayMs = 0): AgentRuntime {
  return {
    system: 'Call step until told to stop.',
    tools: [{ name: 'step', description: 'One step.', inputSchema: { type: 'object' } }],
    call: async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return { text: 'stepped' };
    },
  };
}

/**
 * The model for {@link stepRuntime}: the prompt `turns:N` asks for N turns —
 * N-1 `step` calls, then end_turn.
 */
function stepModel(params: Params): Anthropic.Message {
  const prompt = params.messages[0]?.content;
  const want = Number(String(prompt).split(':')[1]);
  const turn = (params.messages.length + 1) / 2;
  return turn < want
    ? message([{ type: 'tool_use', id: `tu_${turn}`, name: 'step', input: {} }], 'tool_use')
    : message([{ type: 'text', text: 'Done.' }], 'end_turn');
}

const stepPreset: ModelPreset = { name: 'step', model: 'step-model', params: {} };

/** Run step episodes `prompts` (by key) through one batcher; resolves with their episodes. */
async function runSteps(
  batcher: LockstepBatcher,
  prompts: Record<string, string>,
  runtimes: Record<string, AgentRuntime> = {},
) {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(prompts).map(async ([key, prompt]) => {
        const lane = batcher.register(key);
        try {
          const episode = await runAgentEpisode(
            lane.caller,
            stepPreset,
            runtimes[key] ?? stepRuntime(),
            prompt,
          );
          return [key, episode] as const;
        } finally {
          lane.done();
        }
      }),
    ),
  );
}

describe('LockstepBatcher', () => {
  it('runs every live episode in lockstep, one batch per tick', async () => {
    const fake = new FakeBatches(async (_id, params) => ok(stepModel(params)));
    const ticks: BatchTick[] = [];
    const batcher = new LockstepBatcher({
      client: fake,
      sleep: fakeSleep(),
      onTick: (t) => ticks.push(t),
    });
    // b's tool is slow: the tick must wait for it, not leave b behind.
    const episodes = await runSteps(
      batcher,
      { a: 'turns:1', b: 'turns:3', c: 'turns:2' },
      { b: stepRuntime(30) },
    );

    expect(fake.batches.map((b) => b.requests.map((r) => r.custom_id))).toEqual([
      ['a-t01-a1', 'b-t01-a1', 'c-t01-a1'],
      ['b-t02-a1', 'c-t02-a1'],
      ['b-t03-a1'],
    ]);
    expect(episodes['a']?.apiTurns).toBe(1);
    expect(episodes['b']?.apiTurns).toBe(3);
    expect(episodes['c']?.apiTurns).toBe(2);
    for (const episode of Object.values(episodes)) {
      expect(episode.harnessError).toBeUndefined();
      expect(episode.stopReason).toBe('end_turn');
    }
    expect(ticks.map((t) => [t.tick, t.requests, t.succeeded, t.retries])).toEqual([
      [1, 3, 3, 0],
      [2, 2, 2, 0],
      [3, 1, 1, 0],
    ]);
    expect(ticks.map((t) => t.batchId)).toEqual(['msgbatch_1', 'msgbatch_2', 'msgbatch_3']);
    for (const t of ticks) {
      expect(t.wallMs).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(Date.parse(t.startedAt))).toBe(false);
    }
    expect(batcher.live).toBe(0);
  });

  it('polls with backoff from 10 s, capped at 60 s', async () => {
    const sleeps: number[] = [];
    const fake = new FakeBatches(async (_id, params) => ok(stepModel(params)), 6);
    const batcher = new LockstepBatcher({ client: fake, sleep: fakeSleep(sleeps) });
    await runSteps(batcher, { a: 'turns:1' });
    expect(sleeps).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000]);
    expect(batcher.ticks[0]?.polls).toBe(7);
  });

  it('retries errored and expired requests in the next tick, then gives up as infra', async () => {
    // a: errored, then expired, then served. b: never served. c: served at once.
    const fake = new FakeBatches(async (id, params) => {
      if (id === 'a-t01-a1') return errored();
      if (id === 'a-t01-a2') return { type: 'expired' };
      if (id.startsWith('b-')) return errored('api_error');
      return ok(stepModel(params));
    });
    const ticks: BatchTick[] = [];
    const batcher = new LockstepBatcher({
      client: fake,
      sleep: fakeSleep(),
      onTick: (t) => ticks.push(t),
    });
    const episodes = await runSteps(batcher, { a: 'turns:2', b: 'turns:2', c: 'turns:1' });

    expect(fake.batches.map((b) => b.requests.map((r) => r.custom_id))).toEqual([
      ['a-t01-a1', 'b-t01-a1', 'c-t01-a1'],
      ['a-t01-a2', 'b-t01-a2'],
      ['a-t01-a3', 'b-t01-a3'],
      ['a-t02-a1'],
    ]);
    // The retried request is the same request.
    const aFirst = fake.batches[0]?.requests[0]?.json;
    expect(fake.batches[1]?.requests[0]?.json).toBe(aFirst);
    expect(fake.batches[2]?.requests[0]?.json).toBe(aFirst);

    expect(episodes['a']?.harnessError).toBeUndefined();
    expect(episodes['a']?.apiTurns).toBe(2);
    expect(episodes['c']?.harnessError).toBeUndefined();

    const b = episodes['b'];
    expect(b?.infraFailure).toBe(true);
    expect(b?.apiTurns).toBe(0);
    expect(b?.harnessError).toMatch(/^batch infra: turn 1 not served after 3 batch attempts/);
    expect(b?.harnessError).toContain('errored (api_error: Overloaded)');

    expect(
      ticks.map((t) => [t.requests, t.retries, t.succeeded, t.errored, t.expired, t.missing]),
    ).toEqual([
      [3, 0, 1, 2, 0, 0],
      [2, 2, 0, 1, 1, 0],
      [2, 2, 1, 1, 0, 0],
      [1, 0, 1, 0, 0, 0],
    ]);
  });

  it('treats a missing result line and a failed batch as a failed attempt', async () => {
    const fake = new FakeBatches(async (id, params) =>
      id === 'a-t01-a2' ? undefined : ok(stepModel(params)),
    );
    fake.failCreates = 1;
    const batcher = new LockstepBatcher({ client: fake, sleep: fakeSleep() });
    const episodes = await runSteps(batcher, { a: 'turns:1' });
    // Tick 1: create threw; tick 2: no result line; tick 3: served.
    expect(batcher.ticks.map((t) => [t.batchId, t.missing, t.succeeded])).toEqual([
      [undefined, 1, 0],
      ['msgbatch_1', 1, 0],
      ['msgbatch_2', 0, 1],
    ]);
    expect(batcher.ticks[0]?.error).toBe('Error: connection reset');
    expect(episodes['a']?.harnessError).toBeUndefined();
    expect(episodes['a']?.apiTurns).toBe(1);
  });

  it('rejects bad and duplicate keys', () => {
    const batcher = new LockstepBatcher({ client: new FakeBatches(async () => undefined) });
    expect(() => batcher.register('has.dot')).toThrow(/bad lockstep key/);
    batcher.register('a');
    expect(() => batcher.register('a')).toThrow(/already registered/);
  });
});

// ---------------------------------------------------------------------------
// The eval runner, interactive vs batch

/**
 * A model that knows the answer (as in run.test.ts): one upstream call per
 * task, through call_tool when Projection's tools are on offer, then end_turn.
 */
async function answer(params: Anthropic.MessageStreamParams): Promise<Anthropic.Message> {
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
  const use = names.has('call_tool')
    ? { name: 'call_tool', input: { name: upstream.name, args: upstream.args } }
    : { name: upstream.name, input: upstream.args };
  return message([{ type: 'tool_use', id: 'tu_1', ...use }], 'tool_use');
}

const haiku: ModelPreset = { name: 'haiku45', model: 'claude-haiku-4-5', params: {} };
const sonnet: ModelPreset = {
  name: 'sonnet-low',
  model: 'claude-sonnet-5-5',
  params: { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } },
};
const tmp = mkdtempSync(join(tmpdir(), 'tool-choice-batch-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Strip what legitimately differs between two runs of the same episode. */
function comparable(record: EpisodeRecord): Record<string, unknown> {
  // estimatedUsd is the actual spend, which the batch discount halves.
  const { wallMs: _wall, batch: _batch, estimatedUsd: _spend, ...rest } = record;
  return rest;
}

describe('runToolChoiceEval with batch (offline)', () => {
  const evalOptions = {
    models: [haiku, sonnet],
    modes: resolveModes('direct,projection'),
    tasks: resolveTasks('who-am-i,create-issue'),
    runs: 1,
  };
  /** Every interactive request, serialized at call time, with the episode's prompt. */
  const interactiveSent: string[] = [];
  const batchTicks: BatchTick[] = [];
  let interactive: EpisodeRecord[];
  let batched: EpisodeRecord[];
  let fake: FakeBatches;

  it('runs the same episodes through batches, in lockstep', { timeout: 60_000 }, async () => {
    const caller: ModelCaller = async (params) => {
      interactiveSent.push(JSON.stringify(params));
      return answer(params);
    };
    interactive = await runToolChoiceEval({ ...evalOptions, caller, concurrency: 3 });
    fake = new FakeBatches(async (_id, params) => ok(await answer(params)));
    batched = await runToolChoiceEval({
      ...evalOptions,
      // Would be used if batch mode fell back to the interactive path.
      caller: () => Promise.reject(new Error('interactive caller used in batch mode')),
      batch: { client: fake, sleep: fakeSleep(), onTick: (t) => batchTicks.push(t) },
    });

    expect(batched).toHaveLength(8);
    // Two turns per episode, every episode in both ticks.
    expect(fake.batches.map((b) => b.requests.length)).toEqual([8, 8]);
    expect(fake.batches[0]?.requests.map((r) => r.custom_id).toSorted()).toEqual(
      Array.from({ length: 8 }, (_, i) => `ep${String(i).padStart(4, '0')}-t01-a1`).toSorted(),
    );
    expect(batchTicks.map((t) => t.tick)).toEqual([1, 2]);
    for (const record of batched) {
      expect(record.batch).toBe(true);
      expect(record.harnessError).toBeUndefined();
      expect(record.success).toBe(true);
      expect(record.apiTurns).toBe(2);
    }
    expect(interactive.every((r) => r.batch === undefined)).toBe(true);
  });

  it('sends byte-identical requests on both paths', () => {
    const batchSent = fake.batches.flatMap((b) => b.requests.map((r) => r.json));
    expect(batchSent).toHaveLength(16);
    expect(batchSent.toSorted()).toEqual(interactiveSent.toSorted());
    // Thinking config and effort ride along unchanged (the sonnet preset).
    expect(batchSent.some((json) => json.includes('"thinking":{"type":"adaptive"}'))).toBe(true);
    expect(batchSent.every((json) => !json.includes('"stream"'))).toBe(true);
  });

  it('keeps the record shape, usage and transcript of the interactive path', () => {
    expect(batched.map(comparable)).toEqual(interactive.map(comparable));
    for (const [i, record] of batched.entries()) {
      expect(Object.keys(record).filter((k) => k !== 'batch')).toEqual(
        Object.keys(interactive[i] as EpisodeRecord),
      );
      expect(record.usage).toEqual({
        inputTokens: 200,
        outputTokens: 20,
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 0,
      });
    }
  });

  it('costs half the interactive estimate', () => {
    for (const [i, record] of batched.entries()) {
      const twin = interactive[i] as EpisodeRecord;
      expect(record.estimatedUsd).toBeCloseTo((twin.estimatedUsd ?? NaN) / 2, 12);
      // The standard host cost does not depend on how the run was billed.
      expect(record.standardUsd).toBe(twin.standardUsd);
    }
    expect(batched.some((r) => (r.standardUsd ?? 0) > 0)).toBe(true);
    const usage = (batched[0] as EpisodeRecord).usage;
    expect(estimateUsd('claude-haiku-4-5', usage, true)).toBeCloseTo(
      estimateUsd('claude-haiku-4-5', usage) / 2,
      12,
    );
    const full = summarizeToolChoice(interactive);
    const half = summarizeToolChoice(batched);
    expect(full.cells.map((c) => c.estimatedUsd).every((usd) => usd > 0)).toBe(true);
    for (const [i, cell] of half.cells.entries()) {
      expect(cell.estimatedUsd).toBeCloseTo((full.cells[i]?.estimatedUsd ?? NaN) / 2, 12);
      expect(cell.successes).toBe(full.cells[i]?.successes);
      expect(cell.meanTurns).toBe(full.cells[i]?.meanTurns);
    }
    for (const [i, tier] of half.tiers.entries()) {
      expect(tier.estimatedUsd).toBeCloseTo((full.tiers[i]?.estimatedUsd ?? NaN) / 2, 12);
    }
    expect(formatToolChoiceReport(batched)).toContain('billed at 50%');
    expect(formatToolChoiceReport(interactive)).not.toContain('billed at 50%');
  });

  it('writes batch: true and the ticks into the results file', () => {
    const writer = createResultsWriter(join(tmp, 'eval-results'), {
      runs: 1,
      batch: true,
      batchWidth: 8,
      batchTicks,
    });
    writer.write(batched);
    const written = JSON.parse(readFileSync(writer.path, 'utf8')) as {
      batch: boolean;
      batchTicks: BatchTick[];
      records: EpisodeRecord[];
    };
    expect(written.batch).toBe(true);
    expect(written.batchTicks.map((t) => t.requests)).toEqual([8, 8]);
    expect(written.records.every((r) => r.batch === true)).toBe(true);
  });

  it('records an episode the batches never served as an infra failure', async () => {
    const failing = new FakeBatches(async (id, params) =>
      id.startsWith('ep0000-') ? { type: 'expired' } : ok(await answer(params)),
    );
    const records = await runToolChoiceEval({
      models: [haiku],
      modes: resolveModes('direct'),
      tasks: resolveTasks('who-am-i,create-issue'),
      runs: 1,
      batch: { client: failing, sleep: fakeSleep(), width: 1 },
    });
    const [lost, served] = records;
    expect(lost?.infraFailure).toBe(true);
    expect(lost?.batch).toBe(true);
    expect(lost?.success).toBe(false);
    expect(lost?.harnessError).toMatch(
      /^batch infra: turn 1 not served after 3 batch attempts; last: expired$/,
    );
    expect(formatEpisodeLine(lost as EpisodeRecord)).toContain('ERR batch infra');
    expect(served?.infraFailure).toBeUndefined();
    expect(served?.success).toBe(true);
    // Width 1: the episodes ran one after the other (3 failed ticks, then 2).
    expect(failing.batches.map((b) => b.requests.map((r) => r.custom_id))).toEqual([
      ['ep0000-t01-a1'],
      ['ep0000-t01-a2'],
      ['ep0000-t01-a3'],
      ['ep0001-t01-a1'],
      ['ep0001-t02-a1'],
    ]);
    const summary = summarizeToolChoice(records);
    expect(summary.cells[0]?.harnessErrors).toBe(1);
    expect(summary.cells[0]?.scored).toBe(1);
  });
});
