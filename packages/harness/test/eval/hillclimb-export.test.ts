/**
 * The multi-server hill-climb exporter (`.claude/hillclimb/multi-server/
 * export.mjs`), offline against temp flow directories: per-call long-context
 * pricing that agrees with the harness's own cost model, observed costs
 * keyed by tier, the scope gate's cost basis (observed, pilot, prior, the
 * multi-hard prior, else refuse), and context overflows counted per cell.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { estimateUsd, MODEL_PRICES, type TurnUsage } from '../../src/index.js';

const FLOW_URL = new URL('../../../../.claude/hillclimb/multi-server/', import.meta.url);

// export.mjs is plain JS with no declarations: typed loosely here.
// oxlint-disable-next-line typescript/no-explicit-any
let ex: any;
const tmp = mkdtempSync(join(tmpdir(), 'hillclimb-export-'));

beforeAll(async () => {
  ex = await import(new URL('export.mjs', FLOW_URL).href);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const STATE = JSON.parse(readFileSync(new URL('_state.json', FLOW_URL), 'utf8')) as {
  prices: Record<string, { in: number; out: number }>;
};

const turn = (uncached: number, read: number, write: number, output: number): TurnUsage => ({
  inputTokens: uncached,
  cacheReadInputTokens: read,
  cacheCreationInputTokens: write,
  outputTokens: output,
  prefixTokens: 1_000,
});

function sumUsage(turns: TurnUsage[]) {
  return {
    inputTokens: turns.reduce((a, t) => a + t.inputTokens, 0),
    outputTokens: turns.reduce((a, t) => a + t.outputTokens, 0),
    cacheReadInputTokens: turns.reduce((a, t) => a + t.cacheReadInputTokens, 0),
    cacheCreationInputTokens: turns.reduce((a, t) => a + t.cacheCreationInputTokens, 0),
  };
}

const snake = (u: ReturnType<typeof sumUsage>) => ({
  input_tokens: u.inputTokens,
  output_tokens: u.outputTokens,
  cache_read_input_tokens: u.cacheReadInputTokens,
  cache_creation_input_tokens: u.cacheCreationInputTokens,
});

describe('export.mjs pricing', () => {
  it('prices Haiku 5.5 like the harness: the long card per call over 100K, from _state.json', () => {
    const haiku = MODEL_PRICES['claude-haiku-5-5'];
    expect(STATE.prices['claude-haiku-5-5']).toEqual({
      in: haiku?.input,
      out: haiku?.output,
      long_context: {
        above_tokens: haiku?.longContext?.aboveTokens,
        in: haiku?.longContext?.input,
        out: haiku?.longContext?.output,
      },
    });
    const turns = [turn(2_000, 40_000, 8_000, 300), turn(3_000, 98_000, 4_000, 500)];
    const usage = sumUsage(turns);
    for (const model of ['claude-haiku-5-5', 'claude-haiku-4-5', 'claude-sonnet-5-5']) {
      const fromExport = ex.costUsd(STATE.prices, model, snake(usage), turns);
      expect(fromExport, model).toBeCloseTo(estimateUsd(model, usage, false, turns), 15);
    }
    // Turn 2's 105K prompt is on the long card, so per-call pricing costs more.
    expect(ex.costUsd(STATE.prices, 'claude-haiku-5-5', snake(usage), turns)).toBeGreaterThan(
      ex.costUsd(STATE.prices, 'claude-haiku-5-5', snake(usage)),
    );
    expect(ex.rateFor(STATE.prices['claude-haiku-5-5'], 100_000)).toMatchObject({ in: 0.1 });
    expect(ex.rateFor(STATE.prices['claude-haiku-5-5'], 100_001)).toMatchObject({ in: 0.5 });
  });
});

/** A results.jsonl row for `task` in `tier`. */
function row(task: string, tier: string, phase: string, cost: number, batch = false) {
  return {
    prompt_id: `${task}.haiku45.projection`,
    rep: 0,
    phase,
    cost_usd: cost,
    ...(batch ? { batch: true } : {}),
    meta: { phase, task, tier, ...(batch ? { batch: true } : {}) },
  };
}

function flowWith(name: string, variants: Record<string, object[]>, errors: object[] = []): string {
  const flow = join(tmp, name);
  mkdirSync(flow, { recursive: true });
  writeFileSync(
    join(flow, '_state.json'),
    JSON.stringify({ budget_usd: 100, prices: STATE.prices, phases: {} }),
  );
  for (const [variant, rows] of Object.entries(variants)) {
    mkdirSync(join(flow, variant), { recursive: true });
    writeFileSync(
      join(flow, variant, 'results.jsonl'),
      rows.map((r) => JSON.stringify(r)).join('\n'),
    );
    if (errors.length > 0) {
      writeFileSync(
        join(flow, variant, 'errors.jsonl'),
        errors.map((r) => JSON.stringify(r)).join('\n'),
      );
    }
  }
  return flow;
}

const scopeOf = (tiers: Record<string, number>, runs = 1) => ({
  tiers: Object.keys(tiers),
  runs,
  tasks: [],
  cells: [{ model: 'haiku45', mode: 'projection', tasks: 0, tiers }],
  episodes: Object.values(tiers).reduce((a, b) => a + b, 0) * runs,
});

describe('export.mjs scope gate', () => {
  it('keys observed costs by tier as well, from the task in prompt_id', () => {
    const rows = [
      row('cross-a', 'multi', 'p', 0.02),
      row('cross-b', 'multi', 'p', 0.04),
      row('hard-gold', 'multi-hard', 'p', 0.5),
      // Batch rows go back to list price.
      row('hard-gold', 'multi-hard', 'p', 0.5, true),
      // An error row carries no meta: its task's tier comes from another row.
      { prompt_id: 'cross-a.haiku45.projection', phase: 'p', cost_usd: 0.03 },
      // Unknown task, no tier anywhere: not used.
      { prompt_id: 'mystery.haiku45.projection', phase: 'p', cost_usd: 9 },
    ];
    const observed = ex.observedCosts(rows, new Map());
    expect(observed['haiku45|projection|p|multi']).toEqual([0.02, 0.04, 0.03]);
    expect(observed['haiku45|projection|p|multi-hard']).toEqual([0.5, 1]);
    expect(Object.keys(observed)).toHaveLength(2);
  });

  it('estimates each tier on its own basis; multi-hard with none takes $1/episode', () => {
    const flow = flowWith('mixed', { v1: [row('cross-a', 'multi', 'multi', 0.02)] });
    const report = ex.scopeReport(flow, 'multi', scopeOf({ multi: 17, 'multi-hard': 12 }, 3));
    expect(report.code).toBe(0);
    expect(report.out).toMatch(/ multi +17 tasks x 3 reps = +51 episodes @ \$0\.0200 \(observed\)/);
    expect(report.out).toMatch(
      / multi-hard +12 tasks x 3 reps = +36 episodes @ \$1\.0000 \(multi-hard prior\)/,
    );
    // 51 x $0.02 + 36 x $1, not 87 x the multi tier's $0.02.
    expect(report.out).toContain('est. $37.02');
    const batch = ex.scopeReport(flow, 'multi', scopeOf({ 'multi-hard': 12 }), { batch: true });
    expect(batch.out).toContain('@ $0.5000 (multi-hard prior)');
  });

  it('refuses a tier with no observation, pilot or prior; a pilot unblocks it', () => {
    const flow = flowWith('bare', { v1: [row('cross-a', 'multi', 'multi', 0.02)] });
    const refused = ex.scopeReport(flow, 'newphase', scopeOf({ basic: 15 }));
    expect(refused.code).toBe(5);
    expect(refused.err).toMatch(/no observed cost, pilot or prior for haiku45\/projection basic/);
    // The old default would have priced it at $0.05 and passed.
    expect(refused.out).not.toMatch(/basic +15 tasks/);

    const piloted = flowWith('piloted', {
      v1: [row('cross-a', 'multi', 'multi', 0.02)],
      pilot: [row('basic-a', 'basic', 'pilot', 0.04), row('basic-b', 'basic', 'pilot', 0.06)],
    });
    const ok = ex.scopeReport(piloted, 'newphase', scopeOf({ basic: 15 }));
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('@ $0.0500 (pilot)');

    // A phase prior covers only the tiers it was measured on.
    const prior = ex.scopeReport(flowWith('empty', {}), 'guard', scopeOf({ basic: 15 }));
    expect(prior.code).toBe(0);
    expect(prior.out).toContain('(prior)');
    const notCovered = ex.scopeReport(flowWith('empty2', {}), 'multi', scopeOf({ basic: 15 }));
    expect(notCovered.code).toBe(5);
  });
});

describe('export.mjs export', () => {
  it('counts context overflows per cell, and prices rows per call', () => {
    const vdir = join(flowWith('exp', {}), 'v1');
    mkdirSync(join(vdir, 'raw'), { recursive: true });
    const turns = [turn(2_000, 0, 50_000, 300), turn(2_000, 50_000, 60_000, 400)];
    const record = (run: number, extra: object) => ({
      model: 'haiku-low',
      modelId: 'claude-haiku-5-5',
      servedModel: 'claude-haiku-5-5',
      mode: 'projection',
      task: 'hard-gold-order-totals',
      tier: 'multi-hard',
      kind: 'bulk-read',
      run,
      success: false,
      toolCorrect: true,
      forbidden: false,
      turnCapped: false,
      apiTurns: 2,
      budgetTurns: 2,
      toolUseCount: 1,
      upstreamCalls: [],
      usage: sumUsage(turns),
      turns,
      wallMs: 1000,
      finalText: '',
      ...extra,
    });
    writeFileSync(
      join(vdir, 'raw', 'hard.json'),
      JSON.stringify({
        generatedAt: 'x',
        records: [
          record(0, { contextOverflow: true, stopReason: 'model_context_window_exceeded' }),
          record(1, { success: true }),
          record(2, { harnessError: 'api error: boom' }),
        ],
      }),
    );
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      ex.exportVariant(vdir);
    } finally {
      write.mockRestore();
    }
    const summary = JSON.parse(readFileSync(join(vdir, 'summary.json'), 'utf8'));
    expect(summary.cells['hard|haiku-low|projection']).toMatchObject({
      episodes: 3,
      scored: 2,
      passes: 1,
      context_overflows: 1,
    });
    const rows = readFileSync(join(vdir, 'results.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows[0].meta.context_overflow).toBe(true);
    expect(rows[1].meta.context_overflow).toBeUndefined();
    // Turn 2 (112K prompt) on the long card, as the harness prices it.
    expect(rows[0].cost_usd).toBeCloseTo(
      estimateUsd('claude-haiku-5-5', sumUsage(turns), false, turns),
      15,
    );
    const errors = readFileSync(join(vdir, 'errors.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(errors[0].tier).toBe('multi-hard');
  });
});
