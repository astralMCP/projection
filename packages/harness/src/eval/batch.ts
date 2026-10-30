/**
 * The Message Batches path for the live tool-choice eval (PROJ_EVAL_BATCH=1):
 * the same agent loop, at the batch tier's 50% price.
 *
 * Episodes are multi-turn loops, and a batch request is single-shot, so the
 * episodes run in **lockstep**. Each episode gets its own {@link ModelCaller}
 * from a {@link LockstepBatcher}; the loop itself ({@link runAgentEpisode})
 * is unchanged and builds every request with the same `buildTurnRequest` the
 * interactive caller streams. A call parks the episode's request instead of
 * sending it. Once every live episode is parked (or finished), one tick runs:
 * the parked requests go out as ONE batch (`custom_id` =
 * `<episode>-t<turn>-a<attempt>`), the batch is polled to `ended` with
 * backoff (10 s, doubling, capped at 60 s), and each result is handed back to
 * its episode, which runs its tool calls locally and parks its next request.
 * Episodes that finish leave the lockstep; the runner may start new ones in
 * their place (they join the next tick).
 *
 * A request whose result is `errored`, `expired` or `canceled` (or missing)
 * stays parked and is resubmitted in the next tick, up to `maxAttempts`
 * submissions in all; after that its caller throws {@link InfraError} and the
 * episode ends as an infrastructure failure, recorded apart from a model
 * failure. A tick whose batch could not be created, polled or read counts as
 * a failed attempt for every request in it; a batch that was created but
 * could not be polled or read is canceled (best effort) and its id logged,
 * so its results can be reconciled by hand.
 *
 * An `errored` result of type `invalid_request_error` is never retried (the
 * same request fails the same way) and is not infra: a prompt too long for
 * the context window rejects the call with {@link ContextOverflowError} (the
 * episode is a scored failure, as on the interactive path), and any other
 * invalid request with a plain error (an `api error:` harness error).
 *
 * Each tick records the cache tokens its succeeded responses read and
 * wrote, so a run shows whether the 5-minute cache TTL expires between
 * ticks (a hit rate that drops as ticks slow down).
 *
 * Offline tests inject a fake {@link BatchesClient}; the live test passes
 * `new Anthropic().messages.batches`.
 */

import type Anthropic from '@anthropic-ai/sdk';
import {
  ContextOverflowError,
  InfraError,
  isContextOverflowMessage,
  type ModelCaller,
} from './agent.js';

/** The slice of `client.messages.batches` the runner uses. */
export interface BatchesClient {
  create(params: Anthropic.Messages.BatchCreateParams): PromiseLike<{ id: string }>;
  /** Cancel a batch: used when a tick gives up on one it created. */
  cancel(id: string): PromiseLike<unknown>;
  retrieve(
    id: string,
  ): PromiseLike<
    Pick<Anthropic.Messages.MessageBatch, 'id' | 'processing_status' | 'request_counts'>
  >;
  results(
    id: string,
  ): PromiseLike<AsyncIterable<Anthropic.Messages.MessageBatchIndividualResponse>>;
}

/** One lockstep tick, as the results file records it. */
export interface BatchTick {
  /** 1-based. */
  tick: number;
  /** Absent when the batch could not be created. */
  batchId?: string;
  /** Requests submitted in this tick. */
  requests: number;
  /** Of those, resubmissions of a request that failed in an earlier tick. */
  retries: number;
  succeeded: number;
  errored: number;
  expired: number;
  canceled: number;
  /** Requests with no result line at all (treated like `errored`). */
  missing: number;
  /**
   * Of the `errored`, those rejected as `invalid_request_error`: not
   * retried, not infra (a context overflow among them is a scored failure).
   */
  invalid: number;
  /** Of `invalid`, the prompts too long for the context window. */
  contextOverflows: number;
  /** Over the succeeded responses: uncached input tokens. */
  inputTokens: number;
  /** Over the succeeded responses: input tokens read from the cache. */
  cacheReadInputTokens: number;
  /** Over the succeeded responses: input tokens written to the cache. */
  cacheCreationInputTokens: number;
  /**
   * cache read / (cache read + cache write) over the succeeded responses;
   * null when neither happened. A drop between ticks is the 5-minute TTL
   * expiring while the previous tick was in flight.
   */
  cacheHitRate: number | null;
  /** Status polls made before the batch ended. */
  polls: number;
  /** ISO time the batch was submitted. */
  startedAt: string;
  /** Wall-clock time from submission to the last result read. */
  wallMs: number;
  /** Set when creating, polling or reading the batch threw. */
  error?: string;
  /**
   * Set when the batch was created but the tick failed: the runner asked
   * the API to cancel it (`requested`) or the cancel itself threw (`failed:
   * <message>`). Either way its results are never read: reconcile it by id.
   */
  cancel?: 'requested' | `failed: ${string}`;
}

export interface LockstepOptions {
  client: BatchesClient;
  /** First poll delay. Default 10 s. */
  pollInitialMs?: number;
  /** Poll delay cap (the delay doubles up to it). Default 60 s. */
  pollMaxMs?: number;
  /** Submissions per request before the episode is an infra failure. Default 3. */
  maxAttempts?: number;
  /** Consecutive failed status polls tolerated before the tick fails. Default 5. */
  maxPollErrors?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Called after every tick (best-effort: a throw is swallowed). */
  onTick?: (tick: BatchTick) => void;
  /**
   * Where a canceled batch's id is logged for reconciliation. Default:
   * `console.error`.
   */
  log?: (line: string) => void;
}

export const BATCH_POLL_INITIAL_MS = 10_000;
export const BATCH_POLL_MAX_MS = 60_000;
export const BATCH_MAX_ATTEMPTS = 3;

/** One episode's place in the lockstep. */
export interface LockstepLane {
  /** The episode's model caller: parks the request until the next tick. */
  caller: ModelCaller;
  /** The episode is over (call exactly once, after its last call settled). */
  done(): void;
}

interface Parked {
  params: Anthropic.MessageCreateParamsNonStreaming;
  turn: number;
  attempt: number;
  lastFailure?: string;
  resolve(message: Anthropic.Message): void;
  reject(err: unknown): void;
}

interface Lane {
  key: string;
  turns: number;
  parked?: Parked | undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** An `errored` result the API rejected as an invalid request (never worth a retry). */
function invalidRequest(
  result: Anthropic.Messages.MessageBatchResult | undefined,
): string | undefined {
  if (result?.type !== 'errored') return undefined;
  const error = result.error.error as { type: string; message: string };
  return error.type === 'invalid_request_error' || error.type === 'invalid_request'
    ? error.message
    : undefined;
}

function describeFailure(result: Anthropic.Messages.MessageBatchResult | undefined): string {
  if (result === undefined) return 'missing';
  if (result.type === 'errored') {
    const error = result.error.error;
    return `errored (${error.type}: ${error.message})`;
  }
  return result.type;
}

export class LockstepBatcher {
  readonly ticks: BatchTick[] = [];
  private readonly lanes = new Map<string, Lane>();
  private flushing = false;
  private checkScheduled = false;
  private readonly opts: Required<Omit<LockstepOptions, 'onTick'>> &
    Pick<LockstepOptions, 'onTick'>;

  constructor(options: LockstepOptions) {
    this.opts = {
      client: options.client,
      pollInitialMs: options.pollInitialMs ?? BATCH_POLL_INITIAL_MS,
      pollMaxMs: options.pollMaxMs ?? BATCH_POLL_MAX_MS,
      maxAttempts: Math.max(1, options.maxAttempts ?? BATCH_MAX_ATTEMPTS),
      maxPollErrors: options.maxPollErrors ?? 5,
      sleep: options.sleep ?? defaultSleep,
      log: options.log ?? ((line) => console.error(line)),
      ...(options.onTick !== undefined ? { onTick: options.onTick } : {}),
    };
  }

  /**
   * Enter an episode into the lockstep. From now until `done()`, no tick
   * runs without this episode's next request (so register it before any
   * slow setup, and call `done()` even when the episode throws).
   * `key` must be unique and match `[A-Za-z0-9_-]{1,48}`.
   */
  register(key: string): LockstepLane {
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(key)) throw new Error(`bad lockstep key "${key}"`);
    if (this.lanes.has(key)) throw new Error(`lockstep key "${key}" already registered`);
    const lane: Lane = { key, turns: 0 };
    this.lanes.set(key, lane);
    return {
      caller: (params) =>
        new Promise<Anthropic.Message>((resolve, reject) => {
          if (lane.parked !== undefined) {
            reject(new Error(`lockstep: ${key} called again before its turn returned`));
            return;
          }
          lane.turns += 1;
          lane.parked = {
            // The loop builds a non-streaming-shaped request (no `stream`).
            params: params as Anthropic.MessageCreateParamsNonStreaming,
            turn: lane.turns,
            attempt: 1,
            resolve,
            reject,
          };
          this.scheduleCheck();
        }),
      done: () => {
        if (this.lanes.get(key) !== lane) return;
        this.lanes.delete(key);
        // A lane closed while parked (it should not be): fail its call.
        lane.parked?.reject(new Error(`lockstep: ${key} closed with a request parked`));
        this.scheduleCheck();
      },
    };
  }

  /** Live episodes (registered, not done). */
  get live(): number {
    return this.lanes.size;
  }

  /**
   * Check on a later macrotask, so an episode that finishes and the one a
   * worker starts in its place (synchronously after it) are both seen.
   */
  private scheduleCheck(): void {
    if (this.checkScheduled) return;
    this.checkScheduled = true;
    setImmediate(() => {
      this.checkScheduled = false;
      if (this.flushing || this.lanes.size === 0) return;
      for (const lane of this.lanes.values()) if (lane.parked === undefined) return;
      this.flushing = true;
      void this.tick().finally(() => {
        this.flushing = false;
        this.scheduleCheck();
      });
    });
  }

  private async tick(): Promise<void> {
    const parked = [...this.lanes.values()].flatMap((lane) =>
      lane.parked !== undefined ? [{ lane, req: lane.parked }] : [],
    );
    const byId = new Map(
      parked.map(({ lane, req }) => [
        `${lane.key}-t${String(req.turn).padStart(2, '0')}-a${req.attempt}`,
        { lane, req },
      ]),
    );
    const record: BatchTick = {
      tick: this.ticks.length + 1,
      requests: byId.size,
      retries: parked.filter(({ req }) => req.attempt > 1).length,
      succeeded: 0,
      errored: 0,
      expired: 0,
      canceled: 0,
      missing: 0,
      invalid: 0,
      contextOverflows: 0,
      inputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheHitRate: null,
      polls: 0,
      startedAt: new Date().toISOString(),
      wallMs: 0,
    };
    const started = performance.now();
    const results = new Map<string, Anthropic.Messages.MessageBatchResult>();
    try {
      const batch = await this.opts.client.create({
        requests: [...byId].map(([custom_id, { req }]) => ({ custom_id, params: req.params })),
      });
      record.batchId = batch.id;
      let delay = this.opts.pollInitialMs;
      let pollErrors = 0;
      for (;;) {
        await this.opts.sleep(delay);
        delay = Math.min(delay * 2, this.opts.pollMaxMs);
        record.polls += 1;
        let status: Anthropic.Messages.MessageBatch['processing_status'];
        try {
          status = (await this.opts.client.retrieve(batch.id)).processing_status;
          pollErrors = 0;
        } catch (err) {
          pollErrors += 1;
          if (pollErrors >= this.opts.maxPollErrors) throw err;
          continue;
        }
        if (status === 'ended') break;
      }
      for await (const line of await this.opts.client.results(batch.id)) {
        if (byId.has(line.custom_id)) results.set(line.custom_id, line.result);
      }
    } catch (err) {
      record.error = errorMessage(err);
      // Created, then lost: stop it spending and leave its id for
      // reconciliation. Results already read still count; the rest retry.
      if (record.batchId !== undefined) {
        try {
          await this.opts.client.cancel(record.batchId);
          record.cancel = 'requested';
        } catch (cancelErr) {
          record.cancel = `failed: ${errorMessage(cancelErr)}`;
        }
        this.safeLog(
          `batch tick ${record.tick}: ${record.error}; batch ${record.batchId} cancel ${record.cancel} - reconcile its results by id`,
        );
      }
    }
    record.wallMs = Math.round(performance.now() - started);

    for (const [id, { lane, req }] of byId) {
      const result = results.get(id);
      if (result?.type === 'succeeded') {
        record.succeeded += 1;
        const usage = result.message.usage;
        record.inputTokens += usage.input_tokens;
        record.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
        record.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
        lane.parked = undefined;
        req.resolve(result.message);
        continue;
      }
      if (result === undefined) record.missing += 1;
      else record[result.type] += 1;
      const invalid = invalidRequest(result);
      if (invalid !== undefined) {
        // The same request fails the same way: no retry, and not infra.
        record.invalid += 1;
        lane.parked = undefined;
        if (isContextOverflowMessage(invalid)) {
          record.contextOverflows += 1;
          req.reject(new ContextOverflowError(`turn ${req.turn}: ${invalid}`));
        } else {
          req.reject(
            new Error(`turn ${req.turn} rejected by the batch API: ${describeFailure(result)}`),
          );
        }
        continue;
      }
      req.lastFailure =
        record.error !== undefined && result === undefined
          ? `batch failed (${record.error})`
          : describeFailure(result);
      if (req.attempt >= this.opts.maxAttempts) {
        lane.parked = undefined;
        req.reject(
          new InfraError(
            `turn ${req.turn} not served after ${req.attempt} batch attempts; last: ${req.lastFailure}`,
          ),
        );
      } else {
        req.attempt += 1; // stays parked: resubmitted next tick
      }
    }
    const cached = record.cacheReadInputTokens + record.cacheCreationInputTokens;
    record.cacheHitRate = cached === 0 ? null : record.cacheReadInputTokens / cached;
    this.ticks.push(record);
    try {
      this.opts.onTick?.(record);
    } catch {
      // Progress reporting must not stall the lockstep.
    }
  }

  private safeLog(line: string): void {
    try {
      this.opts.log(line);
    } catch {
      // Logging must not stall the lockstep.
    }
  }
}
