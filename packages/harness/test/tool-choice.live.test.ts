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
 *   PROJ_EVAL_MODELS       comma list of presets (haiku-low, sonnet-medium)
 *   PROJ_EVAL_MODES        direct,projection
 *   PROJ_EVAL_TASKS        comma list of task names
 *   PROJ_EVAL_RUNS         episodes per cell (default 3)
 *   PROJ_EVAL_CONCURRENCY  episodes in flight (default 4)
 *
 *   PROJ_LIVE_EVAL=1 pnpm --filter @astral-mcp/harness exec vitest run test/tool-choice.live.test.ts
 *
 * The report is printed and the records are written to
 * packages/harness/eval-results/<timestamp>.json (gitignored).
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  formatEpisodeLine,
  formatToolChoiceReport,
  loadNearestDotEnv,
  resolveModelPresets,
  resolveModes,
  resolveTasks,
  runToolChoiceEval,
  writeToolChoiceResults,
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
    const tasks = resolveTasks(process.env['PROJ_EVAL_TASKS']);
    const runs = positiveInt(process.env['PROJ_EVAL_RUNS'], 3);
    const concurrency = positiveInt(process.env['PROJ_EVAL_CONCURRENCY'], 4);

    const records = await runToolChoiceEval({
      models,
      modes,
      tasks,
      runs,
      concurrency,
      // eslint-disable-next-line no-console -- progress while a long run goes
      onEpisode: (record) => console.info(formatEpisodeLine(record)),
    });

    // eslint-disable-next-line no-console -- the report IS the deliverable
    console.info(`\n${formatToolChoiceReport(records)}\n`);
    const path = writeToolChoiceResults(
      records,
      join(dirname(fileURLToPath(import.meta.url)), '../eval-results'),
      {
        models: models.map((m) => m.name),
        modes,
        tasks: tasks.map((t) => t.name),
        runs,
      },
    );
    // eslint-disable-next-line no-console
    console.info(`results written to ${path}`);

    expect(records).toHaveLength(models.length * modes.length * tasks.length * runs);
  });
});
