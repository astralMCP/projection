/**
 * The standard host cost model (`standardCost`) and its place on records and
 * summaries, offline.
 */

import { describe, expect, it } from 'vitest';
import {
  estimateUsd,
  formatToolChoiceReport,
  rateFor,
  MIN_CACHEABLE_TOKENS,
  MODEL_PRICES,
  standardCost,
  summarizeToolChoice,
  type EpisodeRecord,
  type ModelPrice,
  type TurnUsage,
} from '../../src/index.js';

/** A turn whose whole prompt is reported as uncached input (the split does not matter). */
function turn(prompt: number, output: number, prefixTokens: number): TurnUsage {
  return {
    inputTokens: prompt,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: output,
    prefixTokens,
  };
}

const usd = (tokens: number, perMTok: number): number => (tokens * perMTok) / 1_000_000;

describe('standardCost', () => {
  it('takes the minimum cacheable sizes from the claude-api skill', () => {
    expect(MIN_CACHEABLE_TOKENS).toEqual({
      'claude-haiku-5-5': 512,
      'claude-haiku-4-5': 4096,
      'claude-sonnet-5-5': 512,
    });
  });

  it('reads a prefix at or over the minimum on every turn, turn 1 included', () => {
    // Haiku 4.5, prefix 5000 >= 4096; turn 1 adds a 200-token task prompt.
    const turns = [turn(5200, 100, 5000), turn(5700, 50, 5000)];
    const expected =
      // turn 1: read the warm prefix, write the task prompt.
      usd(5000 * 0.1 + 200 * 1.25, 1) +
      // turn 2: read turn 1's span, write the 500 new tokens.
      usd(5200 * 0.1 + 500 * 1.25, 1) +
      usd(150, 5);
    expect(standardCost(turns, 'claude-haiku-4-5')).toBeCloseTo(expected, 15);
  });

  it('bills a prefix under the minimum as uncached until the span reaches it', () => {
    // Haiku 4.5, prefix 3000 < 4096: turns 1-2 uncached; turn 3 crosses 4096
    // and writes everything; turn 4 reads it.
    const turns = [
      turn(3100, 100, 3000),
      turn(3800, 100, 3000),
      turn(4400, 100, 3000),
      turn(4600, 100, 3000),
    ];
    const expected =
      usd(3100 + 3800, 1) + usd(4400 * 1.25, 1) + usd(4400 * 0.1 + 200 * 1.25, 1) + usd(400, 5);
    expect(standardCost(turns, 'claude-haiku-4-5')).toBeCloseTo(expected, 15);
    // The same prefix on Sonnet 5.5 (minimum 512) is warm from turn 1.
    const sonnet =
      usd(3000 * 0.1 + 100 * 1.25, 2) +
      usd(3100 * 0.1 + 700 * 1.25, 2) +
      usd(3800 * 0.1 + 600 * 1.25, 2) +
      usd(4400 * 0.1 + 200 * 1.25, 2) +
      usd(400, 10);
    expect(standardCost(turns, 'claude-sonnet-5-5')).toBeCloseTo(sonnet, 15);
  });

  it('caches a multi-turn conversation incrementally: each new token written once', () => {
    const prompts = [4000, 6500, 7000, 9800, 10000, 15000];
    const turns = prompts.map((p) => turn(p, 300, 3500));
    let expected = usd(3500 * 0.1 + 500 * 1.25, 2);
    for (let i = 1; i < prompts.length; i += 1) {
      const prev = prompts[i - 1] as number;
      expected += usd(prev * 0.1 + ((prompts[i] as number) - prev) * 1.25, 2);
    }
    expected += usd(6 * 300, 10);
    expect(standardCost(turns, 'claude-sonnet-5-5')).toBeCloseTo(expected, 15);
  });

  it('ignores how the eval run happened to split the prompt between cache and input', () => {
    const cold: TurnUsage[] = [
      {
        inputTokens: 3,
        cacheCreationInputTokens: 6000,
        cacheReadInputTokens: 0,
        outputTokens: 80,
        prefixTokens: 5800,
      },
      {
        inputTokens: 3,
        cacheCreationInputTokens: 900,
        cacheReadInputTokens: 6000,
        outputTokens: 40,
        prefixTokens: 5800,
      },
    ];
    const warm: TurnUsage[] = [
      { ...(cold[0] as TurnUsage), cacheCreationInputTokens: 200, cacheReadInputTokens: 5800 },
      { ...(cold[1] as TurnUsage) },
    ];
    expect(standardCost(warm, 'claude-haiku-4-5')).toBeCloseTo(
      standardCost(cold, 'claude-haiku-4-5'),
      15,
    );
  });

  it('costs nothing for an unknown model or no turns', () => {
    expect(standardCost([turn(9000, 10, 8000)], 'scripted-model')).toBe(0);
    expect(standardCost([], 'claude-haiku-4-5')).toBe(0);
  });

  // Hand-built episodes run through the cost-anatomy simulation itself:
  // `simulate(e, hit1=True)` from the hill-climb's anatomy.py, extracted
  // verbatim and evaluated with S = turn 1's prompt and results at 1 token
  // per character, so per-turn prompts are S + sum of earlier outputs and
  // results. hit1 = turn 1's prompt already cached when it reaches the
  // minimum: the warm static prefix (anatomy's S includes the task prompt,
  // so prefixTokens = S here). The usd values are anatomy.py's output.
  const ANATOMY_CASES: {
    name: string;
    model: string;
    prompts: number[];
    outputs: number[];
    prefix: number;
    usd: number;
  }[] = [
    {
      name: 'haiku45, prefix under 4096, span crosses it on turn 3',
      model: 'claude-haiku-4-5',
      prompts: [3100, 3620, 4520, 4660],
      outputs: [120, 200, 90, 300],
      prefix: 3100,
      usd: 0.016547,
    },
    {
      name: 'haiku45, prefix over 4096',
      model: 'claude-haiku-4-5',
      prompts: [4300, 5350, 6630],
      outputs: [150, 80, 260],
      prefix: 4300,
      usd: 0.0067575,
    },
    {
      name: 'haiku45, span never reaches 4096',
      model: 'claude-haiku-4-5',
      prompts: [2000, 2600],
      outputs: [100, 100],
      prefix: 2000,
      usd: 0.0056,
    },
    {
      name: 'sonnet55, prefix over 512, five turns',
      model: 'claude-sonnet-5-5',
      prompts: [3600, 6600, 8820, 12300, 13810],
      outputs: [500, 420, 380, 610, 700],
      prefix: 3600,
      usd: 0.058609,
    },
    {
      name: 'sonnet55, prefix under 512',
      model: 'claude-sonnet-5-5',
      prompts: [300, 490, 1450],
      outputs: [40, 60, 80],
      prefix: 300,
      usd: 0.007005,
    },
  ];
  for (const c of ANATOMY_CASES) {
    it(`matches anatomy.py's simulation: ${c.name}`, () => {
      const turns = c.prompts.map((p, i) => turn(p, c.outputs[i] as number, c.prefix));
      expect(standardCost(turns, c.model)).toBeCloseTo(c.usd, 12);
    });
  }
});

function record(over: Partial<EpisodeRecord>): EpisodeRecord {
  return {
    model: 'haiku45',
    modelId: 'claude-haiku-4-5',
    mode: 'direct',
    task: 'who-am-i',
    tier: 'basic',
    world: 'github',
    kind: 'single',
    run: 0,
    success: true,
    toolCorrect: true,
    forbidden: false,
    turnCapped: false,
    apiTurns: 1,
    budgetTurns: 1,
    toolUseCount: 0,
    toolUses: [],
    upstreamCalls: [],
    usage: {
      inputTokens: 5000,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    turns: [turn(5000, 100, 4500)],
    wallMs: 1,
    finalText: '',
    ...over,
  };
}

describe('Haiku 5.5 long-context pricing', () => {
  // A turn with a real cache split: 2,000 uncached, `read` read, 0 written.
  const split = (read: number, output: number): TurnUsage => ({
    inputTokens: 2_000,
    cacheReadInputTokens: read,
    cacheCreationInputTokens: 0,
    outputTokens: output,
    prefixTokens: 1_000,
  });

  it('has a long-context card only for Haiku 5.5, above 100K prompt tokens', () => {
    expect(MODEL_PRICES['claude-haiku-5-5']?.longContext).toEqual({
      aboveTokens: 100_000,
      input: 0.5,
      output: 2.5,
    });
    expect(MODEL_PRICES['claude-haiku-4-5']?.longContext).toBeUndefined();
    expect(MODEL_PRICES['claude-sonnet-5-5']?.longContext).toBeUndefined();
    const haiku = MODEL_PRICES['claude-haiku-5-5'] as ModelPrice;
    // 100K exactly is still the base card; one token more is not.
    expect(rateFor(haiku, 100_000)).toMatchObject({ input: 0.1, output: 0.5 });
    expect(rateFor(haiku, 100_001)).toMatchObject({ input: 0.5, output: 2.5 });
  });

  it('estimateUsd prices each turn on the card its own prompt selects', () => {
    // Turn 1: 52K prompt (base card); turn 2: 150K prompt (long card).
    const turns = [split(50_000, 200), split(148_000, 300)];
    const usage = {
      inputTokens: 4_000,
      cacheReadInputTokens: 198_000,
      cacheCreationInputTokens: 0,
      outputTokens: 500,
    };
    const expected =
      usd(2_000 + 50_000 * 0.1, 0.1) +
      usd(200, 0.5) +
      usd(2_000 + 148_000 * 0.1, 0.5) +
      usd(300, 2.5);
    expect(estimateUsd('claude-haiku-5-5', usage, false, turns)).toBeCloseTo(expected, 15);
    expect(estimateUsd('claude-haiku-5-5', usage, true, turns)).toBeCloseTo(expected / 2, 15);
    // Without per-turn usage there is no prompt size to choose by: base card.
    expect(estimateUsd('claude-haiku-5-5', usage)).toBeCloseTo(
      usd(4_000 + 198_000 * 0.1, 0.1) + usd(500, 0.5),
      15,
    );
    // Other models: one card whatever the size.
    expect(estimateUsd('claude-sonnet-5-5', usage, false, turns)).toBeCloseTo(
      estimateUsd('claude-sonnet-5-5', usage),
      15,
    );
  });

  it('standardCost bills a turn over 100K at the long card', () => {
    // Prefix 1,000 warm; turn 1 writes to 60K; turn 2 grows to 160K.
    const turns = [turn(60_000, 100, 1_000), turn(160_000, 100, 1_000)];
    const expected =
      usd(1_000 * 0.1 + 59_000 * 1.25, 0.1) +
      usd(100, 0.5) +
      usd(60_000 * 0.1 + 100_000 * 1.25, 0.5) +
      usd(100, 2.5);
    expect(standardCost(turns, 'claude-haiku-5-5')).toBeCloseTo(expected, 15);
  });
});

describe('standard cost in summaries', () => {
  it('sums standard and actual cost per cell, tier and run', () => {
    const records = [record({}), record({ run: 1, batch: true })];
    const summary = summarizeToolChoice(records);
    const one = standardCost([turn(5000, 100, 4500)], 'claude-haiku-4-5');
    const actual = estimateUsd('claude-haiku-4-5', (records[0] as EpisodeRecord).usage);
    expect(summary.standardUsd).toBeCloseTo(2 * one, 15);
    expect(summary.estimatedUsd).toBeCloseTo(actual * 1.5, 15);
    expect(summary.cells[0]?.standardUsd).toBeCloseTo(2 * one, 15);
    expect(summary.tiers[0]?.standardUsd).toBeCloseTo(2 * one, 15);
    expect(formatToolChoiceReport(records)).toContain('std $');
  });

  it('says not measured, never $0, for records without per-turn usage', () => {
    const old = record({});
    delete old.turns;
    const summary = summarizeToolChoice([old, record({ run: 1 })]);
    expect(summary.standardUsd).toBeUndefined();
    expect(summary.cells[0]?.standardUsd).toBeUndefined();
    expect(summary.estimatedUsd).toBeGreaterThan(0);
    // A record that made no call costs 0 either way.
    const none = record({ apiTurns: 0, budgetTurns: 0 });
    delete none.turns;
    expect(summarizeToolChoice([none]).standardUsd).toBe(0);
  });
});
