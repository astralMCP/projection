/**
 * Live self-heal benchmark (PRD §13, §10) — a real model authors machines
 * for the FILE_SERVER_TASKS suite and heals from structured errors.
 *
 * Explicit opt-in only: needs MCC_LIVE_BENCH=1 AND a non-empty
 * ANTHROPIC_API_KEY, so a developer with the key exported never triggers
 * real model spend from a plain `pnpm test`. Run it with:
 *
 *   MCC_LIVE_BENCH=1 pnpm --filter @mccircuit/harness exec vitest run test/reasoning.live.test.ts
 *
 * Set MCC_BENCH_MODEL to benchmark another model (default claude-opus-5);
 * §10 asks for the metric across 3 frontier models, so run once per model.
 */

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { wrapMcpServer } from 'mccircuit';
import {
  buildApiDocs,
  createAnthropicAuthor,
  createFileServer,
  formatSelfHealReport,
  runReasoningTask,
  summarizeSelfHeal,
  FILE_SERVER_FIXTURE,
  FILE_SERVER_TASKS,
  type ReasoningResult,
} from '../src/index.js';

// Both gates: key presence alone must never trigger live spend, and an
// empty-string key is absent, not present.
const hasKey = (process.env['ANTHROPIC_API_KEY'] ?? '') !== '';
const optedIn = process.env['MCC_LIVE_BENCH'] === '1';

describe.skipIf(!optedIn || !hasKey)('live self-heal benchmark (§10)', () => {
  it('runs the task suite and reports the self-heal metrics', { timeout: 600_000 }, async () => {
    const model = process.env['MCC_BENCH_MODEL'];
    const author = createAnthropicAuthor(model !== undefined ? { model } : {});
    const results: ReasoningResult[] = [];

    // Fresh fixture per task: tasks mutate files, and each should start
    // from the documented initial state.
    for (const task of FILE_SERVER_TASKS) {
      const recording = createFileServer({ ...FILE_SERVER_FIXTURE });
      const facade = await wrapMcpServer(recording.server, { blob: { key: randomBytes(32) } });
      try {
        results.push(await runReasoningTask(facade, recording, author, task, buildApiDocs(facade)));
      } finally {
        await facade.close();
      }
    }

    const summary = summarizeSelfHeal(results);
    // eslint-disable-next-line no-console -- the report IS the deliverable
    console.info(formatSelfHealReport(results));

    // §10 targets. The suite is small, so these are the coarse gates the
    // targets imply at n=4 rather than exact percentages.
    expect(summary.withinTwoAttemptsValidRate).toBeGreaterThanOrEqual(0.75);
    expect(summary.firstAttemptValidRate).toBeGreaterThanOrEqual(0.5);
    // Blob budget (§10): median < 8 KB — check every observed blob here.
    for (const result of results) {
      for (const attempt of result.attempts) {
        expect(attempt.result.maxBlobBytes).toBeLessThan(8 * 1024);
      }
    }
  });
});
