/**
 * Score agent-host episodes served by serve-eval-world.ts:
 *
 *   unrun scripts/score-thread-eval.ts <episodes.json> <log-dir>...
 *
 * `episodes.json` maps an episode code (the worktree directory's prefix,
 * e.g. `ep-p07`) to `{ task, runtime, finalText? }`. Each log is matched to
 * its episode by that prefix; several logs for one episode (a host that
 * restarted the server) are merged in start order. Prints one row per
 * episode and a summary per runtime: success (the task's own grader over
 * what reached the world), whether execute_machine was used, how many of
 * its calls failed, round trips and approvals.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveTasks, type SideEffect } from '../src/index.js';

interface Log {
  episode: string;
  startedAt: string;
  calls: SideEffect[];
  toolCalls: { name: string; isError: boolean }[];
  approvals: number;
  roundTrips: number;
}

interface Episode {
  task: string;
  runtime: string;
  finalText?: string;
}

async function main(): Promise<void> {
  const [mapPath, ...logDirs] = process.argv.slice(2);
  if (mapPath === undefined || logDirs.length === 0) {
    throw new Error('usage: score-thread-eval <episodes.json> <log-dir>...');
  }
  const episodes = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, Episode>;
  const logs: Log[] = logDirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as Log),
  );
  const tasks = new Map(resolveTasks(undefined).map((task) => [task.name, task]));

  const rows: {
    code: string;
    task: string;
    runtime: string;
    ran: boolean;
    success: boolean;
    usedCode: boolean;
    codeCalls: number;
    codeErrors: number;
    roundTrips: number;
  }[] = [];
  for (const [code, episode] of Object.entries(episodes)) {
    const mine = logs
      .filter((log) => log.episode === code || log.episode.startsWith(`${code}-`))
      .toSorted((a, b) => a.startedAt.localeCompare(b.startedAt));
    const task = tasks.get(episode.task);
    if (task === undefined) throw new Error(`unknown task ${episode.task}`);
    const calls = mine.flatMap((log) => log.calls);
    const toolCalls = mine.flatMap((log) => log.toolCalls);
    const machineCalls = toolCalls.filter((call) => call.name === 'execute_machine');
    const forbidden = task.forbid !== undefined && calls.some((call) => task.forbid?.(call));
    let verified = true;
    if (task.verify !== undefined) {
      // eslint-disable-next-line no-await-in-loop -- episodes are scored one at a time, in order
      verified = await task.verify({
        calls,
        finalText: episode.finalText ?? '',
        facts: {},
      });
    }
    rows.push({
      code,
      task: episode.task,
      runtime: episode.runtime,
      ran: toolCalls.length > 0,
      success: task.expect(calls) && !forbidden && verified,
      usedCode: machineCalls.length > 0,
      codeCalls: machineCalls.length,
      codeErrors: machineCalls.filter((call) => call.isError).length,
      roundTrips: mine.reduce((sum, log) => sum + log.roundTrips, 0),
    });
  }

  for (const row of rows.toSorted(
    (a, b) => a.task.localeCompare(b.task) || a.runtime.localeCompare(b.runtime),
  )) {
    console.log(
      [
        row.code.padEnd(8),
        row.task.padEnd(36),
        row.runtime.padEnd(13),
        row.ran ? (row.success ? 'success' : 'FAIL   ') : 'no-run ',
        `code ${row.usedCode ? 'yes' : 'no '}`,
        `execute_machine ${row.codeCalls} (errors ${row.codeErrors})`,
        `trips ${row.roundTrips}`,
      ].join('  '),
    );
  }
  console.log('');
  for (const runtime of new Set(rows.map((row) => row.runtime))) {
    const mine = rows.filter((row) => row.runtime === runtime && row.ran);
    const sum = (f: (row: (typeof rows)[number]) => number): number =>
      mine.reduce((total, row) => total + f(row), 0);
    console.log(
      `${runtime}: ${sum((r) => (r.success ? 1 : 0))}/${mine.length} succeeded; ` +
        `code mode used in ${sum((r) => (r.usedCode ? 1 : 0))}; ` +
        `execute_machine calls ${sum((r) => r.codeCalls)}, failed ${sum((r) => r.codeErrors)}; ` +
        `round trips ${sum((r) => r.roundTrips)}; ` +
        `not run ${rows.filter((row) => row.runtime === runtime && !row.ran).length}`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
