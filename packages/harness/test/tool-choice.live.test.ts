/**
 * Live tool-choice eval: for each model × mode × task × run, a real model
 * tries to complete a GitHub task against the offline 95-tool fake, either
 * with the fake's tools exposed directly or through Projection. Reports
 * success (tool AND arguments correct), tool-correct, turns, tokens, cost
 * and — for Projection — which route the model took.
 *
 * Explicit opt-in only: PROJ_LIVE_EVAL=1 AND a non-empty ANTHROPIC_API_KEY
 * (which may live in the repo-root env file). Knobs:
 *
 *   PROJ_EVAL_MODELS       comma list of presets (haiku45, sonnet-low, haiku-low, sonnet-medium; default haiku45,sonnet-low)
 *   PROJ_EVAL_MODES        direct,projection
 *   PROJ_EVAL_TIERS        basic,hard (default both)
 *   PROJ_EVAL_TASKS        comma list of task names (within the selected tiers)
 *   PROJ_EVAL_RUNS         episodes per cell (default 3)
 *   PROJ_EVAL_CONCURRENCY  episodes in flight (default 4)
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
import { describe, expect, it } from 'vitest';
import {
  createResultsWriter,
  formatEpisodeLine,
  formatToolChoiceReport,
  loadNearestDotEnv,
  resolveModelPresets,
  resolveModes,
  resolveTasks,
  resolveTiers,
  runToolChoiceEval,
  type EpisodeRecord,
} from '../src/index.js';

loadNearestDotEnv();

const hasKey = (process.env['ANTHROPIC_API_KEY'] ?? '') !== '';
const optedIn = process.env['PROJ_LIVE_EVAL'] === '1';

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

describe.skipIf(!optedIn || !hasKey)('live tool-choice eval (direct vs Projection)', () => {
  it('runs the matrix and reports', { timeout: 1_800_000 }, async () => {
    const models = resolveModelPresets(process.env['PROJ_EVAL_MODELS']);
    const modes = resolveModes(process.env['PROJ_EVAL_MODES']);
    const tiers = resolveTiers(process.env['PROJ_EVAL_TIERS']);
    const tasks = resolveTasks(process.env['PROJ_EVAL_TASKS'], tiers);
    const runs = positiveInt(process.env['PROJ_EVAL_RUNS'], 3);
    const concurrency = positiveInt(process.env['PROJ_EVAL_CONCURRENCY'], 4);

    const results = createResultsWriter(
      join(dirname(fileURLToPath(import.meta.url)), '../eval-results'),
      {
        models: models.map((m) => m.name),
        modes,
        tiers,
        tasks: tasks.map((t) => t.name),
        runs,
      },
    );
    // eslint-disable-next-line no-console
    console.info(`results file: ${results.path} (rewritten after every episode)`);

    // Completion order, not plan order: a durable partial file matters more
    // than ordering, and the final write below is in plan order anyway.
    const completed: EpisodeRecord[] = [];
    const records = await runToolChoiceEval({
      models,
      modes,
      tasks,
      runs,
      concurrency,
      onEpisode: (record) => {
        // eslint-disable-next-line no-console -- progress while a long run goes
        console.info(formatEpisodeLine(record));
        completed.push(record);
        results.write(completed);
      },
    });

    // eslint-disable-next-line no-console -- the report IS the deliverable
    console.info(`\n${formatToolChoiceReport(records)}\n`);
    results.write(records);
    // eslint-disable-next-line no-console
    console.info(`results written to ${results.path}`);

    expect(records).toHaveLength(models.length * modes.length * tasks.length * runs);
  });
});
