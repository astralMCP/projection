/**
 * Offline evals for the facade's discovery surface — no model, no network,
 * no spend:
 *
 *   pnpm --filter @astral-mcp/harness run eval:offline search [--split train|test|all] [--failures]
 *   pnpm --filter @astral-mcp/harness run eval:offline invariance [--split train|test|all]
 *   pnpm --filter @astral-mcp/harness run eval:offline surface
 *   pnpm --filter @astral-mcp/harness run eval:offline all
 *
 * `search` prints recall@1, recall@5, MRR and the result-page size per
 * split, surface and source; `--failures` lists the cases whose gold missed
 * the top 5 (refused for the test split: while hill-climbing, the test
 * split is read only as an aggregate). `invariance` prints the metamorphic
 * scores (metamorphic.ts). `surface` prints the surface-size table
 * (surface.ts). The split defaults to train. Uses the built
 * `@astral-mcp/projection`: rebuild it after changing the library.
 */

import {
  casesOf,
  loadSearchCorpus,
  runSearchCases,
  summarize,
  summarizeBy,
  type CaseResult,
  type SearchMetrics,
  type Split,
} from '../src/eval/offline/search-eval.js';
import { describeInvariance, searchInvariance } from '../src/eval/offline/metamorphic.js';
import { charsAndTokens, measureSurfaces } from '../src/eval/offline/surface.js';

const args = process.argv.slice(2);
const command = args[0] ?? 'search';
const splitArg = args.includes('--split') ? args[args.indexOf('--split') + 1] : 'train';
if (splitArg !== 'train' && splitArg !== 'test' && splitArg !== 'all') {
  throw new Error(`--split must be train, test or all (got ${String(splitArg)})`);
}
const split: Split | 'all' = splitArg;

function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    `| ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ')} |`;
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

const pct = (x: number): string => `${(100 * x).toFixed(1)}`;
const metricRow = (label: string, m: SearchMetrics): string[] => [
  label,
  String(m.cases),
  pct(m.recallAt1),
  pct(m.recallAt5),
  m.mrr.toFixed(3),
  Math.round(m.pageTokens).toString(),
];
const METRIC_HEADER = ['', 'cases', 'R@1 %', 'R@5 %', 'MRR', 'page tok (chars/4)'];

async function search(): Promise<CaseResult[]> {
  const corpus = loadSearchCorpus();
  const results = await runSearchCases(casesOf(corpus, split));
  console.log(`## Search retrieval — split ${split}\n`);
  console.log(table(METRIC_HEADER, [metricRow('all', summarize(results))]));
  console.log('\nBy surface:\n');
  console.log(
    table(
      METRIC_HEADER,
      [...summarizeBy(results, (r) => r.case.surface)].map(([k, m]) => metricRow(k, m)),
    ),
  );
  console.log('\nBy source:\n');
  console.log(
    table(
      METRIC_HEADER,
      [...summarizeBy(results, (r) => r.case.source)].map(([k, m]) => metricRow(k, m)),
    ),
  );
  const contentIssued = corpus.content.reduce((sum, c) => sum + c.seen, 0);
  console.log(
    `\nContent queries (searching the catalog for data; unscorable): ${corpus.content.length} distinct, ${contentIssued} issued.`,
  );
  if (args.includes('--failures')) {
    if (split !== 'train') throw new Error('--failures lists train cases only');
    console.log('\nMisses (gold outside the top 5):\n');
    for (const r of results.filter((x) => x.rank === undefined || x.rank > 5)) {
      console.log(
        `- [${r.case.surface}] ${JSON.stringify(r.case.query)} gold=${r.case.gold.join(',')} rank=${r.rank ?? '-'} top=${r.top.join(', ')}`,
      );
    }
  }
  return results;
}

async function invariance(): Promise<void> {
  const cases = casesOf(loadSearchCorpus(), split);
  const baseline = await runSearchCases(cases);
  const scores = await searchInvariance(cases, baseline);
  const describe = await describeInvariance(cases);
  console.log(`## Invariance — split ${split}\n`);
  console.log(
    table(
      ['transform', 'search score', 'hit@5 flips %', 'mean |Δrank|', 'MRR after', 'describe score'],
      scores.map((s) => {
        const d = describe.find((x) => x.transform === s.transform)?.score;
        return [
          s.transform,
          s.score.toFixed(3),
          pct(s.flips),
          s.meanRankShift.toFixed(2),
          s.mrr.toFixed(3),
          d === undefined ? 'n/a' : d.toFixed(3),
        ];
      }),
    ),
  );
  const mean = scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
  const ds = describe.flatMap((d) => (d.score === undefined ? [] : [d.score]));
  console.log(
    `\nInvariance score (mean over transforms): search ${mean.toFixed(3)}, describe ${(ds.reduce((a, b) => a + b, 0) / ds.length).toFixed(3)} (baseline MRR ${summarize(baseline).mrr.toFixed(3)})`,
  );
}

async function surface(): Promise<void> {
  const rows = await measureSurfaces();
  console.log('## Surface size (chars, ~tokens = chars/4)\n');
  console.log(
    table(
      [
        'world',
        'mode',
        'tools',
        'system',
        'tool defs',
        'system + defs',
        'describe_tool',
        'search page',
      ],
      rows.map((r) => [
        r.world,
        r.mode,
        String(r.tools),
        charsAndTokens(r.systemChars),
        charsAndTokens(r.toolDefChars),
        charsAndTokens(r.systemChars + r.toolDefChars),
        charsAndTokens(r.describeChars),
        charsAndTokens(r.searchChars),
      ]),
    ),
  );
}

if (command === 'search') await search();
else if (command === 'invariance') await invariance();
else if (command === 'surface') await surface();
else if (command === 'all') {
  await search();
  console.log('');
  await invariance();
  console.log('');
  await surface();
} else throw new Error(`unknown command ${command}; known: search, invariance, surface, all`);
