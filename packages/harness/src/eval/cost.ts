/**
 * What an eval episode costs, two ways.
 *
 * - {@link estimateUsd}: the eval's actual spend, from the usage the API
 *   reported (however this run happened to cache), with the Message Batches
 *   discount when the episode ran there.
 * - {@link standardCost}: what a realistic host would pay for the same
 *   turns. It does not depend on how the eval's run cached (interactive vs
 *   batch, the breakpoint at the end of the conversation, whether reps
 *   shared an entry), so it compares across modes and runs. No batch
 *   discount: it is a host-cost metric, not an eval-spend one.
 */

import type { EpisodeUsage, ServerToolUse, TurnUsage } from './agent.js';

/** A rate card: USD per million input and output tokens. */
export interface RateCard {
  input: number;
  output: number;
}

/**
 * A model's list price. `longContext`: the rate card a request is billed on
 * when its prompt (uncached + cache read + cache write) is over
 * `aboveTokens` — the whole request, input and output, at that card.
 */
export interface ModelPrice extends RateCard {
  longContext?: RateCard & { aboveTokens: number };
  /**
   * USD per million cache-read tokens, when not {@link CACHE_READ_FACTOR}
   * of `input` (the non-Anthropic models' own cache-read prices).
   */
  cacheRead?: number;
  /** USD per million cache-write tokens, when not {@link CACHE_WRITE_FACTOR} of `input`. */
  cacheWrite?: number;
}

/**
 * USD per million tokens, Anthropic list prices (the claude-api skill's
 * models reference). Haiku 5.5 has two rate cards chosen per request by
 * prompt length: $0.10 / $0.50 for a prompt of 100K tokens or fewer, $0.50
 * / $2.50 above that. Haiku 4.5 and Sonnet 5.5 bill one card at any length.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    longContext: { aboveTokens: 100_000, input: 0.5, output: 2.5 },
  },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  // OpenRouter list prices (openrouter.ai/api/v1/models, fetched
  // 2026-10-31: `pricing.prompt`, `.completion`, `.input_cache_read`, USD
  // per token × 1e6). Automatic caching, no write fee: a reported cache
  // write is billed as plain input.
  'meta/muse-spark-1.3': { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 1.25 },
  'moonshotai/kimi-k2.5': { input: 0.5, output: 2.5, cacheRead: 0.15, cacheWrite: 0.5 },
};

/** The rate card one request with `promptTokens` of prompt is billed on. */
export function rateFor(price: ModelPrice, promptTokens: number): RateCard {
  const long = price.longContext;
  return long !== undefined && promptTokens > long.aboveTokens ? long : price;
}

/** A turn's whole prompt: uncached + cache read + cache write. */
function promptOf(turn: TurnUsage): number {
  return turn.inputTokens + turn.cacheReadInputTokens + turn.cacheCreationInputTokens;
}

/** A cache read costs this share of the input price (every model in {@link MODEL_PRICES}). */
export const CACHE_READ_FACTOR = 0.1;
/** A cache write (5-minute TTL) costs this share of the input price. */
export const CACHE_WRITE_FACTOR = 1.25;

/** The Message Batches API bills every token (cache reads and writes included) at this share. */
export const BATCH_PRICE_FACTOR = 0.5;

/**
 * The shortest prompt prefix each model caches, in tokens: a breakpoint
 * before this many tokens silently caches nothing. From the claude-api
 * skill's prompt-caching reference (`shared/prompt-caching.md`, API
 * reference): 512 for Sonnet 5.5 and Haiku 5.5, 4096 for Haiku 4.5.
 */
export const MIN_CACHEABLE_TOKENS: Readonly<Record<string, number>> = {
  'claude-haiku-5-5': 512,
  'claude-haiku-4-5': 4096,
  'claude-sonnet-5-5': 512,
};

/** USD for usage billed at one rate card (`price` supplies any own cache prices). */
function usdAt(rate: RateCard, usage: EpisodeUsage, price?: ModelPrice): number {
  const read = price?.cacheRead ?? rate.input * CACHE_READ_FACTOR;
  const write = price?.cacheWrite ?? rate.input * CACHE_WRITE_FACTOR;
  return (
    (usage.inputTokens * rate.input +
      usage.cacheReadInputTokens * read +
      usage.cacheCreationInputTokens * write +
      usage.outputTokens * rate.output) /
    1_000_000
  );
}

/**
 * The eval's actual spend. Cache reads at 10% of input, cache writes at
 * 125%; unknown models cost 0. `turns` (the episode's per-call usage, which
 * sums to `usage`): each call is priced on the rate card its own prompt
 * selects ({@link rateFor}), so a Haiku 5.5 call over 100K tokens costs
 * the long-context rate; without them, `usage` at the base card. `batch`:
 * the episode ran through the Message Batches API (the whole sum at
 * {@link BATCH_PRICE_FACTOR}).
 */
export function estimateUsd(
  modelId: string,
  usage: EpisodeUsage,
  batch = false,
  turns?: readonly TurnUsage[],
): number {
  const price = MODEL_PRICES[modelId];
  if (price === undefined) return 0;
  const usd =
    turns !== undefined && turns.length > 0
      ? turns.reduce((sum, turn) => sum + usdAt(rateFor(price, promptOf(turn)), turn, price), 0)
      : usdAt(price, usage, price);
  return batch ? usd * BATCH_PRICE_FACTOR : usd;
}

/**
 * The standard host cost of an episode, in USD, from its per-turn usage.
 * Unknown models cost 0. Turn _t_'s prompt is P_t = uncached + cache read +
 * cache write as reported (how the eval's run split it does not matter);
 * S = `prefixTokens` (clamped to P_t); M = the model's
 * {@link MIN_CACHEABLE_TOKENS}.
 *
 * - The static prefix is warm: a host keeps a breakpoint after the tools and
 *   system prompt, shared across conversations. If S >= M, every turn,
 *   turn 1 included, reads S at the cache-read price. If S < M it cannot be
 *   cached on its own and is billed like the rest of the prompt below.
 * - The conversation is cached incrementally with a breakpoint on the last
 *   message. The minimum applies to the cumulative span up to that
 *   breakpoint, P_t, which includes the prefix. Each turn reads the longest
 *   span already cached (the previous turn's P, or the warm S) and, if
 *   P_t >= M, writes the rest once at the cache-write price; if P_t < M
 *   nothing is written and the rest is uncached input.
 * - Output tokens at the output price. No batch discount.
 * - Each turn at the rate card P_t selects ({@link rateFor}): a Haiku 5.5
 *   turn whose prompt is over 100K tokens is billed at $0.50 / $2.50.
 *
 * So when S < M (Haiku 4.5 under 4096 tokens) the prefix is uncached until
 * the conversation's span reaches M, then written with it and read after.
 */
export function standardCost(turns: readonly TurnUsage[], model: string): number {
  const price = MODEL_PRICES[model];
  const minimum = MIN_CACHEABLE_TOKENS[model];
  if (price === undefined || minimum === undefined) return 0;
  let cached = 0;
  let usd = 0;
  for (const turn of turns) {
    const prompt = promptOf(turn);
    const rate = rateFor(price, prompt);
    const prefix = Math.min(Math.max(0, turn.prefixTokens), prompt);
    const warm = prefix >= minimum ? prefix : 0;
    const read = Math.min(prompt, Math.max(warm, cached));
    let write = 0;
    if (prompt >= minimum) {
      write = prompt - read;
      cached = prompt;
    }
    const uncached = prompt - read - write;
    const input = read * CACHE_READ_FACTOR + write * CACHE_WRITE_FACTOR + uncached;
    usd += (input * rate.input + turn.outputTokens * rate.output) / 1_000_000;
  }
  return usd;
}

/**
 * Code execution's list price beyond the organisation's free hours: USD per
 * container-hour, with a 5-minute minimum per container (the code execution
 * tool docs, "Usage and pricing", read 2026-10-31: 1,550 free hours a month
 * per organisation, then $0.05 per hour per container; free when the request
 * also carries web search or web fetch, which the eval never sends).
 * Programmatic tool calling bills the same. Tool search is not metered (its
 * docs: no `server_tool_use` usage field; the definitions it loads are
 * ordinary input tokens).
 */
export const CODE_EXECUTION_USD_PER_HOUR = 0.05;
/** The minimum billed execution time per container. */
export const CODE_EXECUTION_MIN_MS = 5 * 60_000;

/**
 * Server tool fees for one episode, at list price as if the free hours were
 * spent: each container billed for the longer of its observed span and the
 * 5-minute minimum. An upper bound on the real fee (the container time the
 * API meters is not reported per response), and $0 without containers.
 */
export function serverToolUsd(use: Pick<ServerToolUse, 'containers'> | undefined): number {
  if (use === undefined) return 0;
  return use.containers.reduce(
    (sum, container) =>
      sum +
      (Math.max(CODE_EXECUTION_MIN_MS, container.spanMs) / 3_600_000) * CODE_EXECUTION_USD_PER_HOUR,
    0,
  );
}

/**
 * Whether {@link standardCost} models `model`: the Anthropic models with a
 * known minimum cacheable prefix. The OpenAI-compatible models cache
 * automatically on the provider's terms, so their host cost is the
 * reported usage at list price (`estimateUsd`), not this model.
 */
export function hasStandardCost(model: string): boolean {
  return MODEL_PRICES[model] !== undefined && MIN_CACHEABLE_TOKENS[model] !== undefined;
}
