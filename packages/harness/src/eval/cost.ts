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

import type { EpisodeUsage, TurnUsage } from './agent.js';

/** USD per million tokens, Anthropic list prices. */
export const MODEL_PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
};

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

/**
 * The eval's actual spend. Cache reads at 10% of input, cache writes at
 * 125%; unknown models cost 0. `batch`: the episode ran through the Message
 * Batches API (the whole sum at {@link BATCH_PRICE_FACTOR}).
 */
export function estimateUsd(modelId: string, usage: EpisodeUsage, batch = false): number {
  const price = MODEL_PRICES[modelId];
  if (price === undefined) return 0;
  const input =
    usage.inputTokens +
    usage.cacheReadInputTokens * CACHE_READ_FACTOR +
    usage.cacheCreationInputTokens * CACHE_WRITE_FACTOR;
  const usd = (input * price.input + usage.outputTokens * price.output) / 1_000_000;
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
 *
 * So when S < M (Haiku 4.5 under 4096 tokens) the prefix is uncached until
 * the conversation's span reaches M, then written with it and read after.
 */
export function standardCost(turns: readonly TurnUsage[], model: string): number {
  const price = MODEL_PRICES[model];
  const minimum = MIN_CACHEABLE_TOKENS[model];
  if (price === undefined || minimum === undefined) return 0;
  let cached = 0;
  let input = 0;
  let output = 0;
  for (const turn of turns) {
    const prompt = turn.inputTokens + turn.cacheReadInputTokens + turn.cacheCreationInputTokens;
    const prefix = Math.min(Math.max(0, turn.prefixTokens), prompt);
    const warm = prefix >= minimum ? prefix : 0;
    const read = Math.min(prompt, Math.max(warm, cached));
    let write = 0;
    if (prompt >= minimum) {
      write = prompt - read;
      cached = prompt;
    }
    const uncached = prompt - read - write;
    input += read * CACHE_READ_FACTOR + write * CACHE_WRITE_FACTOR + uncached;
    output += turn.outputTokens;
  }
  return (input * price.input + output * price.output) / 1_000_000;
}
