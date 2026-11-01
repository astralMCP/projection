/**
 * The Message Batches path (PROJ_EVAL_BATCH=1), offline: a fake batches
 * client stands in for `client.messages.batches`. Covers the lockstep (one
 * batch per tick, episodes of different lengths dropping out), the
 * errored / expired / retry handling and the infra-failure record, polling
 * backoff, usage and the 50% cost, that a batch request is byte for
 * byte the request the interactive path sends, and that a task's own turn
 * budget (multi-hard's `maxTurns`) holds in the lockstep.
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
  type EvalTask,
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
const errored = (
  type: 'overloaded_error' | 'api_error' | 'invalid_request_error' = 'overloaded_error',
  text = 'Overloaded',
): BatchResult =>
  ({
    type: 'errored',
    error: { type: 'error', request_id: null, error: { type, message: text } },
  }) as BatchResult;
const tooLong = (): BatchResult =>
  errored('invalid_request_error', 'prompt is too long: 215000 tokens > 200000 maximum');

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
  readonly canceled: string[] = [];
  failCreates = 0;
  /** Status polls that throw (each poll decrements). */
  failPolls = 0;
  /** Results reads that throw after yielding this many lines (undefined: never). */
  failResultsAfter: number | undefined;
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

  async cancel(id: string): Promise<{ id: string }> {
    this.canceled.push(id);
    return { id };
  }

  async retrieve(id: string) {
    if (this.failPolls > 0) {
      this.failPolls -= 1;
      throw new Error('503 Service Unavailable');
    }
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
    const failAfter = this.failResultsAfter;
    this.failResultsAfter = undefined;
    return (async function* () {
      // Out of order, as the API does not promise order.
      let n = 0;
      for (const line of lines.toReversed()) {
        if (failAfter !== undefined && n >= failAfter) throw new Error('stream reset');
        n += 1;
        yield line;
      }
      if (failAfter !== undefined && n >= failAfter) throw new Error('stream reset');
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

  it('never retries an invalid request; a prompt too long is a context overflow, not infra', async () => {
    // a overflows on turn 2; b's turn 1 is malformed; c is served.
    const fake = new FakeBatches(async (id, params) => {
      if (id.startsWith('a-t02')) return tooLong();
      if (id.startsWith('b-')) return errored('invalid_request_error', 'tools.0: bad schema');
      return ok(stepModel(params));
    });
    const batcher = new LockstepBatcher({ client: fake, sleep: fakeSleep() });
    const episodes = await runSteps(batcher, { a: 'turns:3', b: 'turns:2', c: 'turns:2' });

    // One submission each: nothing resubmitted.
    expect(fake.batches.map((b) => b.requests.map((r) => r.custom_id))).toEqual([
      ['a-t01-a1', 'b-t01-a1', 'c-t01-a1'],
      ['a-t02-a1', 'c-t02-a1'],
    ]);
    const a = episodes['a'];
    expect(a?.contextOverflow).toBe(true);
    expect(a?.harnessError).toBeUndefined();
    expect(a?.infraFailure).toBeUndefined();
    expect(a?.apiTurns).toBe(1);
    expect(a?.stopReason).toBe('model_context_window_exceeded');
    const b = episodes['b'];
    expect(b?.harnessError).toMatch(
      /^api error: Error: turn 1 rejected by the batch API: errored \(invalid_request_error: tools.0: bad schema\)/,
    );
    expect(b?.infraFailure).toBeUndefined();
    expect(b?.contextOverflow).toBeUndefined();
    expect(episodes['c']?.harnessError).toBeUndefined();
    expect(batcher.ticks.map((t) => [t.errored, t.invalid, t.contextOverflows, t.retries])).toEqual(
      [
        [1, 1, 0, 0],
        [1, 1, 1, 0],
      ],
    );
  });

  it('cancels a batch it gave up polling and logs its id for reconciliation', async () => {
    const fake = new FakeBatches(async (_id, params) => ok(stepModel(params)));
    fake.failPolls = 2;
    const log: string[] = [];
    const batcher = new LockstepBatcher({
      client: fake,
      sleep: fakeSleep(),
      maxPollErrors: 2,
      log: (line) => log.push(line),
    });
    const episodes = await runSteps(batcher, { a: 'turns:1' });
    expect(fake.canceled).toEqual(['msgbatch_1']);
    expect(batcher.ticks[0]?.cancel).toBe('requested');
    expect(batcher.ticks[0]?.error).toBe('Error: 503 Service Unavailable');
    expect(log).toHaveLength(1);
    expect(log[0]).toContain('msgbatch_1');
    expect(log[0]).toMatch(/reconcile/);
    // The request was resubmitted in a new batch and served.
    expect(batcher.ticks[1]?.cancel).toBeUndefined();
    expect(episodes['a']?.harnessError).toBeUndefined();
    expect(episodes['a']?.apiTurns).toBe(1);
  });

  it('cancels a batch whose results read threw, keeping the results it did read', async () => {
    const fake = new FakeBatches(async (_id, params) => ok(stepModel(params)));
    fake.failResultsAfter = 1;
    const log: string[] = [];
    const batcher = new LockstepBatcher({
      client: fake,
      sleep: fakeSleep(),
      log: (line) => log.push(line),
    });
    const episodes = await runSteps(batcher, { a: 'turns:1', b: 'turns:1' });
    expect(fake.canceled).toEqual(['msgbatch_1']);
    expect(batcher.ticks[0]?.error).toBe('Error: stream reset');
    expect(batcher.ticks[0]?.succeeded).toBe(1);
    expect(batcher.ticks[0]?.missing).toBe(1);
    expect(log[0]).toContain('msgbatch_1');
    // Only the unread one went out again.
    expect(fake.batches[1]?.requests).toHaveLength(1);
    expect(episodes['a']?.harnessError).toBeUndefined();
    expect(episodes['b']?.harnessError).toBeUndefined();
  });

  it('still records a tick when the cancel itself throws', async () => {
    const fake = new FakeBatches(async (_id, params) => ok(stepModel(params)));
    fake.failPolls = 1;
    fake.cancel = async () => {
      throw new Error('404 Not Found');
    };
    const log: string[] = [];
    const batcher = new LockstepBatcher({
      client: fake,
      sleep: fakeSleep(),
      maxPollErrors: 1,
      log: (line) => log.push(line),
    });
    await runSteps(batcher, { a: 'turns:1' });
    expect(batcher.ticks[0]?.cancel).toBe('failed: Error: 404 Not Found');
    expect(log[0]).toContain('msgbatch_1');
  });

  it("records each tick's cache reads and writes, and the hit rate between them", async () => {
    const fake = new FakeBatches(async (id, params) => {
      const msg = stepModel(params);
      // Turn 1 writes the cache; turn 2 reads most of it back.
      const turn = Number(/-t(\d+)-/.exec(id)?.[1]);
      msg.usage = {
        ...msg.usage,
        input_tokens: 50,
        cache_read_input_tokens: turn === 1 ? 0 : 900,
        cache_creation_input_tokens: turn === 1 ? 1_000 : 100,
      };
      return ok(msg);
    });
    const batcher = new LockstepBatcher({ client: fake, sleep: fakeSleep() });
    await runSteps(batcher, { a: 'turns:2', b: 'turns:2' });
    expect(
      batcher.ticks.map((t) => [
        t.inputTokens,
        t.cacheReadInputTokens,
        t.cacheCreationInputTokens,
        t.cacheHitRate,
      ]),
    ).toEqual([
      [100, 0, 2_000, 0],
      [100, 1_800, 200, 0.9],
    ]);
    // A tick that served nothing has no rate.
    const idle = new FakeBatches(async () => undefined);
    const none = new LockstepBatcher({ client: idle, sleep: fakeSleep(), maxAttempts: 1 });
    await runSteps(none, { a: 'turns:1' });
    expect(none.ticks[0]?.cacheHitRate).toBeNull();
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

/** A model that never stops: get_me (direct) or search_tools (Projection). */
function looping(params: Params): Anthropic.Message {
  return toolNames(params.tools).includes('call_tool')
    ? message(
        [{ type: 'tool_use', id: 'tu_s', name: 'search_tools', input: { query: 'me' } }],
        'tool_use',
      )
    : message([{ type: 'tool_use', id: 'tu_me', name: 'get_me', input: {} }], 'tool_use');
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

  it('records a batch context overflow as a scored failure, not infra', async () => {
    // Turn 1 is served (the right call); turn 2 is too long for the window.
    const fake = new FakeBatches(async (id, params) =>
      /-t01-/.test(id) ? ok(await answer(params)) : tooLong(),
    );
    const [record] = await runToolChoiceEval({
      models: [haiku],
      modes: ['direct'],
      tasks: resolveTasks('who-am-i'),
      runs: 1,
      batch: { client: fake, sleep: fakeSleep() },
    });
    expect(fake.batches).toHaveLength(2);
    expect(record?.contextOverflow).toBe(true);
    expect(record?.harnessError).toBeUndefined();
    expect(record?.infraFailure).toBeUndefined();
    expect(record?.toolCorrect).toBe(true);
    expect(record?.success).toBe(false);
    expect(summarizeToolChoice([record as EpisodeRecord]).cells[0]).toMatchObject({
      scored: 1,
      contextOverflows: 1,
      harnessErrors: 0,
    });
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

  it(
    "holds a task's own turn budget in the lockstep, retries not charged",
    { timeout: 60_000 },
    async () => {
      const [whoAmI, createIssue] = resolveTasks('who-am-i,create-issue') as [EvalTask, EvalTask];
      // Its own budget of 2 (ceiling 4) against the run's 3 (ceiling 5).
      const own: EvalTask = { ...whoAmI, maxTurns: 2 };
      const budgeted = new FakeBatches(async (id, params) =>
        // The capped direct episode's first turn fails once: a retry is not a turn.
        id === 'ep0000-t01-a1' ? errored() : ok(looping(params)),
      );
      const records = await runToolChoiceEval({
        models: [haiku],
        modes: resolveModes('direct,projection'),
        tasks: [own, createIssue],
        runs: 1,
        maxTurns: 3,
        maxTotalTurns: 5,
        batch: { client: budgeted, sleep: fakeSleep() },
      });

      // Plan order: direct own, direct create-issue, projection own, projection create-issue.
      expect(records.map((r) => [r.mode, r.task, r.apiTurns, r.budgetTurns])).toEqual([
        ['direct', 'who-am-i', 2, 2],
        ['direct', 'create-issue', 3, 3],
        // Discovery is free, so the ceiling (twice the budget) stops these.
        ['projection', 'who-am-i', 4, 0],
        ['projection', 'create-issue', 5, 0],
      ]);
      for (const record of records) {
        expect(record.batch).toBe(true);
        expect(record.turnCapped).toBe(true);
        expect(record.harnessError).toBeUndefined();
        expect(record.turns).toHaveLength(record.apiTurns);
        expect(record.standardUsd).toBeGreaterThan(0);
      }
      // Each lane leaves the lockstep when its own budget is spent.
      expect(budgeted.batches.map((b) => b.requests.length)).toEqual([4, 4, 4, 2, 1]);
      const byLane = (lane: string): string[] =>
        budgeted.batches.flatMap((b) =>
          b.requests.flatMap((r) => (r.custom_id.startsWith(`${lane}-`) ? [r.custom_id] : [])),
        );
      expect(byLane('ep0000')).toEqual(['ep0000-t01-a1', 'ep0000-t01-a2', 'ep0000-t02-a1']);
      expect(byLane('ep0002')).toHaveLength(4);
      expect(byLane('ep0003')).toHaveLength(5);
    },
  );
});
