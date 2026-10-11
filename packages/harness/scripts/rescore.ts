/**
 * Re-score a saved tool-choice eval results file with the current graders,
 * offline (no API calls, no worlds):
 *
 *   pnpm --filter @astral-mcp/harness run rescore packages/harness/eval-results/<timestamp>.json
 *
 * The path is resolved against the directory the command was typed in
 * (`INIT_CWD`), then against the package directory, so both the repo-root
 * path above and `eval-results/<timestamp>.json` work.
 *
 * Writes `<name>.rescored.json` next to the input (same metadata, records
 * re-scored, summary recomputed), then prints the report, every episode
 * whose verdict changed, every episode a grader threw on, and how many
 * world-verified failures could not be re-checked. See `rescoreRecords`
 * (and DECISIONS D13) for what can and cannot be re-scored offline.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatToolChoiceReport,
  rescoreRecords,
  summarizeToolChoice,
  type EpisodeRecord,
  type RescoreVerdict,
} from '../src/index.js';

function verdict(v: RescoreVerdict): string {
  return v.success ? 'success' : v.forbidden ? 'forbidden' : v.toolCorrect ? 'tool-ok' : 'miss';
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === undefined || arg === '--help' || arg === '-h') {
    console.error('usage: rescore <results.json>');
    process.exit(arg === undefined ? 1 : 0);
  }
  // `pnpm --filter … run` executes in the package directory; resolve
  // against the directory the command was typed in first.
  const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const candidates = [
    resolve(process.env['INIT_CWD'] ?? process.cwd(), arg),
    resolve(packageDir, arg),
  ];
  const input = candidates.find((path) => existsSync(path));
  if (input === undefined)
    throw new Error(`${arg}: not found (looked at ${candidates.join(', ')})`);
  const saved = JSON.parse(readFileSync(input, 'utf8')) as {
    records?: EpisodeRecord[];
  } & Record<string, unknown>;
  if (!Array.isArray(saved.records)) throw new Error(`${input}: no "records" array`);

  const { records, changed, errors, worldFailuresKept } = await rescoreRecords(saved.records);
  const output = input.replace(/\.json$/, '') + '.rescored.json';
  writeFileSync(
    output,
    JSON.stringify(
      {
        ...saved,
        rescoredAt: new Date().toISOString(),
        rescoredFrom: input,
        summary: summarizeToolChoice(records),
        records,
      },
      null,
      2,
    ) + '\n',
  );

  console.log(formatToolChoiceReport(records));
  console.log('');
  console.log(`Changed episodes (${changed.length}):`);
  for (const c of changed) {
    console.log(
      `  ${c.model}/${c.mode} ${c.task} #${c.run}: ${verdict(c.before)} -> ${verdict(c.after)}`,
    );
  }
  if (errors.length > 0) {
    console.log('');
    console.log(`Grader errors, left as recorded (${errors.length}):`);
    for (const e of errors) console.log(`  ${e.model}/${e.mode} ${e.task} #${e.run}: ${e.message}`);
  }
  console.log('');
  console.log(
    `World-verified failures kept as recorded: ${worldFailuresKept} ` +
      '(expect and forbid pass now; cannot tell offline; re-run to confirm)',
  );
  console.log('');
  console.log(`Wrote ${output}`);
}

await main();
