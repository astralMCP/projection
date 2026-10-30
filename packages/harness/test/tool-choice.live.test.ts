/**
 * Live tool-choice eval: for each model × mode × task × run, a real model
 * tries to complete a task against its tier's world — the offline 95-tool
 * GitHub fake (basic, hard), the real filesystem reference server on a
 * throwaway tree (filesystem), or the real MongoDB MCP server on a seeded
 * throwaway mongod (mongodb; needs `pnpm run setup:mongodb` once), or all
 * three at once as boxes (multi) — either with the tools exposed directly or
 * through Projection (on the multi tier, with the global search on and, as
 * `projection-boxes`, off). Reports
 * success (tool AND arguments correct), tool-correct, turns, tokens, cost
 * and — for Projection — which route the model took.
 *
 * Explicit opt-in only: PROJ_LIVE_EVAL=1 AND a non-empty ANTHROPIC_API_KEY
 * (which may live in the repo-root env file). Knobs:
 *
 *   PROJ_EVAL_MODELS       comma list of presets (haiku45, sonnet-low, haiku-low, sonnet-medium; default haiku45,sonnet-low)
 *   PROJ_EVAL_MODES        direct,projection,projection-boxes (default all; projection-boxes runs on the multi tier only)
 *   PROJ_EVAL_TIERS        basic,hard,filesystem,mongodb,multi (default all)
 *   PROJ_EVAL_TASKS        comma list of task names (within the selected tiers)
 *   PROJ_EVAL_RUNS         episodes per cell (default 3)
 *   PROJ_EVAL_CONCURRENCY  episodes in flight (default 4)
 *   PROJ_EVAL_BOX_DESCRIPTIONS=1  multi tier, Projection modes: give the boxes host descriptions (default off)
 *   PROJ_EVAL_BATCH=1      send the model calls through the Message Batches API (50% price), every live
 *                          episode in lockstep (src/eval/batch.ts); PROJ_EVAL_CONCURRENCY is then ignored
 *   PROJ_EVAL_BATCH_WIDTH  batch mode: episodes live (world open) at once (default 24: a multi world
 *                          holds ~400 MB of mongod + server processes)
 *
 * Decision runs (the globalSearch default, prompt changes) use
 * PROJ_EVAL_TIERS=multi, so no other tier's episodes mix into the numbers.
 *
 *   PROJ_LIVE_EVAL=1 pnpm --filter @astral-mcp/harness exec vitest run test/tool-choice.live.test.ts
 *
 * The report is printed and the records are written to
 * packages/harness/eval-results/<timestamp>.json (gitignored). The file is
 * rewritten after every episode, so a vitest timeout or a crash still leaves
 * the partial results (and their summary) on disk.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  createResultsWriter,
  DEFAULT_MAX_TOTAL_TURNS,
  DEFAULT_MAX_TURNS,
  formatEpisodeLine,
  formatToolChoiceReport,
  loadNearestDotEnv,
  modeApplies,
  mongodbServerInstalled,
  resolveModelPresets,
  resolveModes,
  resolveTasks,
  resolveTiers,
  runToolChoiceEval,
  worldOf,
  type BatchTick,
  type EpisodeRecord,
} from '../src/index.js';

loadNearestDotEnv();

const hasKey = (process.env['ANTHROPIC_API_KEY'] ?? '') !== '';
const optedIn = process.env['PROJ_LIVE_EVAL'] === '1';

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const batchMode = process.env['PROJ_EVAL_BATCH'] === '1';
/** Batch mode: each tick waits on a batch (minutes, not seconds), so a phase runs for hours. */
const BATCH_TIMEOUT_MS = 12 * 3_600_000;
const DEFAULT_BATCH_WIDTH = 24;

describe.skipIf(!optedIn || !hasKey)('live tool-choice eval (direct vs Projection)', () => {
  it(
    'runs the matrix and reports',
    { timeout: batchMode ? BATCH_TIMEOUT_MS : 1_800_000 },
    async () => {
      const models = resolveModelPresets(process.env['PROJ_EVAL_MODELS']);
      const modes = resolveModes(process.env['PROJ_EVAL_MODES']);
      const tiers = resolveTiers(process.env['PROJ_EVAL_TIERS']);
      // Fail before spending anything: without the vendored server every
      // mongodb (and multi) episode would be a harness error, not a measurement.
      if ((tiers.includes('mongodb') || tiers.includes('multi')) && !mongodbServerInstalled()) {
        throw new Error(
          'the mongodb or multi tier is selected but the MongoDB MCP server is not installed; run `pnpm run setup:mongodb` in packages/harness, or set PROJ_EVAL_TIERS to exclude mongodb and multi',
        );
      }
      const tasks = resolveTasks(process.env['PROJ_EVAL_TASKS'], tiers);
      const runs = positiveInt(process.env['PROJ_EVAL_RUNS'], 3);
      const concurrency = positiveInt(process.env['PROJ_EVAL_CONCURRENCY'], 4);
      const boxDescriptions = process.env['PROJ_EVAL_BOX_DESCRIPTIONS'] === '1';
      const batchWidth = positiveInt(process.env['PROJ_EVAL_BATCH_WIDTH'], DEFAULT_BATCH_WIDTH);
      const batchTicks: BatchTick[] = [];
      // No knob yet: the defaults, recorded in the results file so a run from
      // before the action-turn budget is distinguishable from one after it.
      const maxTurns = DEFAULT_MAX_TURNS;
      const maxTotalTurns = DEFAULT_MAX_TOTAL_TURNS;

      const results = createResultsWriter(
        join(dirname(fileURLToPath(import.meta.url)), '../eval-results'),
        {
          models: models.map((m) => m.name),
          modes,
          tiers,
          tasks: tasks.map((t) => t.name),
          runs,
          maxTurns,
          maxTotalTurns,
          boxDescriptions,
          outputSchemas: true,
          hostFraming: true,
          ...(batchMode ? { batch: true, batchWidth, batchTicks } : {}),
        },
      );
      // eslint-disable-next-line no-console
      console.info(`results file: ${results.path} (rewritten after every episode)`);

      // Each record in its plan slot: the partial file is in plan order too
      // (the writer skips the slots still running).
      const slots: EpisodeRecord[] = [];
      const records = await runToolChoiceEval({
        models,
        modes,
        tasks,
        runs,
        maxTurns,
        maxTotalTurns,
        concurrency,
        boxDescriptions,
        ...(batchMode
          ? {
              batch: {
                client: new Anthropic().messages.batches,
                width: batchWidth,
                onTick: (tick: BatchTick) => {
                  batchTicks.push(tick);
                  // eslint-disable-next-line no-console -- progress while a long run goes
                  console.info(
                    `batch tick ${tick.tick}: ${tick.requests} requests (${tick.retries} retries), ` +
                      `${tick.succeeded} ok, ${tick.errored} errored, ${tick.expired} expired, ` +
                      `${tick.canceled + tick.missing} other; ${tick.polls} polls, ${tick.wallMs}ms` +
                      (tick.error !== undefined ? `; ${tick.error}` : ''),
                  );
                  results.write(slots);
                },
              },
            }
          : {}),
        onEpisode: (record, index) => {
          // eslint-disable-next-line no-console -- progress while a long run goes
          console.info(formatEpisodeLine(record));
          slots[index] = record;
          results.write(slots);
        },
      });

      // eslint-disable-next-line no-console -- the report IS the deliverable
      console.info(`\n${formatToolChoiceReport(records)}\n`);
      results.write(records);
      // eslint-disable-next-line no-console
      console.info(`results written to ${results.path}`);

      const planned = modes.reduce(
        (n, mode) => n + tasks.filter((t) => modeApplies(mode, worldOf(t.tier))).length,
        0,
      );
      expect(records).toHaveLength(models.length * planned * runs);
    },
  );
});
