/**
 * Re-score a saved tool-choice eval results file with the current graders,
 * offline (no API calls, no worlds):
 *
 *   pnpm --filter @astral-mcp/harness run rescore eval-results/<timestamp>.json
 *
 * Writes `<name>.rescored.json` next to the input (same metadata, records
 * re-scored, summary recomputed), then prints the report and every episode
 * whose verdict changed. See `rescoreRecords` for what can and cannot be
 * re-scored offline.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  // against the directory the command was typed in.
  const input = resolve(process.env['INIT_CWD'] ?? process.cwd(), arg);
  const saved = JSON.parse(readFileSync(input, 'utf8')) as {
    records?: EpisodeRecord[];
  } & Record<string, unknown>;
  if (!Array.isArray(saved.records)) throw new Error(`${input}: no "records" array`);

  const { records, changed } = await rescoreRecords(saved.records);
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
  console.log('');
  console.log(`Wrote ${output}`);
}

await main();
