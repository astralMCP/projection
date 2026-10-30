#!/usr/bin/env node
// Status numbers for the multi-server hill-climb, recomputed from the
// per-episode rows (results.jsonl / errors.jsonl) - never from an aggregate.
// Node builtins only. Reporting only: not a harness path.
//
//   node stats.mjs <flow-dir> <variant> [--failures] [--crosscheck]
//
// Prints, for the variant: each multi-tier cell (mode x model) as tasks
// passing every rep / tasks and episode passes / scored episodes, the guard
// per model, the direct reference when the variant is reference-direct, the
// paired-by-task noise floor for the gating cells, served models, spend, and
// with --failures every failing gating episode. --crosscheck compares the
// recomputed cell counts with the harness's own summary in raw/*.json.
//
// Money: `$/episode` and `spend` are the actual eval spend (cost_usd, batch
// discount included), `$/episode` over scored episodes and `spend` over
// every billed one. `standard_cost_usd` is the mean standard host cost per
// scored episode and `standard_cost_per_success` every billed episode's
// standard cost (harness errors included) over the passes: warm static
// prefix, conversation cached incrementally, no batch discount, so they
// compare across modes and runs. "not measured" when a row has none.
// Latency is the median latency_s: on batch rows (PROJ_EVAL_BATCH=1) that
// spans lockstep ticks, queueing and polling included, so it is not
// comparable with an interactive variant's.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [flowArg, variant, ...flags] = process.argv.slice(2);
const flow = resolve(flowArg);
const vdir = join(flow, variant);
const jsonl = (p) =>
  existsSync(p)
    ? readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];
const state = JSON.parse(readFileSync(join(flow, '_state.json'), 'utf8'));
const rows = jsonl(join(vdir, 'results.jsonl'));
const errors = jsonl(join(vdir, 'errors.jsonl'));
const pct = (k, n) => (n === 0 ? 'n/a' : `${((100 * k) / n).toFixed(1)}%`);

function cell(phase, mode, model) {
  const rs = rows.filter(
    (r) => r.meta.phase === phase && r.meta.mode === mode && r.meta.preset === model,
  );
  const es = errors.filter((e) => e.phase === phase && e.prompt_id.endsWith(`.${model}.${mode}`));
  const byTask = new Map();
  for (const r of rs) {
    const t = byTask.get(r.meta.task) ?? [];
    t.push(r.grade.pass);
    byTask.set(r.meta.task, t);
  }
  const tasks = [...byTask.entries()];
  const full = tasks.filter(([, v]) => v.every((x) => x === 1)).length;
  const passes = rs.reduce((s, r) => s + r.grade.pass, 0);
  // Paired-by-task noise floor for a round-over-round difference of the
  // episode pass rate: sum over tasks of the unbiased per-task Bernoulli
  // variance, doubled (two independent rounds), over n^2 R.
  let varSum = 0;
  let R = 0;
  for (const [, v] of tasks) {
    const r = v.length;
    R = Math.max(R, r);
    const p = v.reduce((a, b) => a + b, 0) / r;
    varSum += r > 1 ? (p * (1 - p) * r) / (r - 1) / r : 0;
  }
  const n = tasks.length;
  // With one rep there is no within-task variance to pair on: fall back to
  // the unpaired binomial difference at the cell's pass rate.
  const pAll = rs.length ? rs.reduce((s, r) => s + r.grade.pass, 0) / rs.length : 0;
  const pairedHalf =
    n === 0
      ? 0
      : R > 1
        ? 1.96 * Math.sqrt((2 * varSum) / (n * n))
        : 1.96 * Math.sqrt((2 * pAll * (1 - pAll)) / rs.length);
  const spend = [...rs, ...es].reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const cost = rs.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const measured = [...rs, ...es].every((r) => typeof r.standard_cost_usd === 'number');
  const std = (xs) => xs.reduce((s, r) => s + r.standard_cost_usd, 0);
  const stdPerEp = measured && rs.length ? std(rs) / rs.length : null;
  const stdPerSuccess = measured && passes > 0 ? std([...rs, ...es]) / passes : null;
  const lat = rs.map((r) => r.latency_s).sort((a, b) => a - b);
  return {
    mode,
    model,
    n,
    R,
    full,
    passes,
    scored: rs.length,
    errors: es.length,
    pairedHalf,
    crude: rs.length ? 1 / Math.sqrt(rs.length) : 0,
    spend,
    perEp: rs.length ? cost / rs.length : 0,
    stdPerEp,
    stdPerSuccess,
    medLat: lat.length ? lat[lat.length >> 1] : 0,
    toolCalls: rs.length ? rs.reduce((s, r) => s + r.tool_calls, 0) / rs.length : 0,
    capped: rs.filter((r) => r.meta.turn_capped).length,
    tasks,
  };
}

const phases = new Set([...rows.map((r) => r.meta.phase), ...errors.map((e) => e.phase)]);
const out = [];
const usd = (x, places) => (x === null ? 'not measured' : `$${x.toFixed(places)}`);
const line = (c, label) =>
  `| ${label} | ${c.mode} | ${c.model} | ${c.full}/${c.n} | ${c.passes}/${c.scored} (${pct(c.passes, c.scored)}) | ${c.errors} | ${c.capped} | ±${(100 * c.pairedHalf).toFixed(1)} (crude ±${(100 * c.crude).toFixed(1)}) | $${c.perEp.toFixed(4)} | ${usd(c.stdPerEp, 4)} | ${usd(c.stdPerSuccess, 4)} | ${c.medLat.toFixed(1)}s | ${c.toolCalls.toFixed(1)} | $${c.spend.toFixed(2)} |`;
out.push(`## ${variant}`);
out.push('');
out.push(
  '| role | mode | model | tasks all reps | episodes | harness err | turn-capped | noise floor (paired, 95%) | $/episode | standard_cost_usd | standard_cost_per_success | median s | tool calls | spend |',
);
out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
const gating = [];
for (const phase of ['multi', 'direct']) {
  if (!phases.has(phase)) continue;
  for (const mode of phase === 'multi' ? ['projection', 'projection-boxes'] : ['direct']) {
    for (const model of ['haiku45', 'sonnet-low']) {
      const c = cell(phase, mode, model);
      if (c.scored + c.errors === 0) continue;
      const role = phase === 'direct' ? 'reference' : mode === 'projection' ? 'gating' : 'tracked';
      if (role === 'gating') gating.push(c);
      out.push(line(c, role));
    }
  }
}
if (phases.has('guard')) {
  for (const model of ['haiku45', 'sonnet-low']) {
    const c = cell('guard', 'projection', model);
    out.push(line(c, 'guard'));
  }
}
if (gating.length === 2) {
  const n = gating.reduce((s, c) => s + c.n, 0);
  const vs = gating.reduce((s, c) => s + (c.pairedHalf / 1.96) ** 2 * c.n * c.n, 0);
  const passes = gating.reduce((s, c) => s + c.passes, 0);
  const scored = gating.reduce((s, c) => s + c.scored, 0);
  const full = gating.reduce((s, c) => s + c.full, 0);
  out.push('');
  out.push(
    `Gating pooled: ${full}/${n} task-cells pass every rep; ${passes}/${scored} episodes (${pct(passes, scored)}); paired noise floor ±${(100 * 1.96 * Math.sqrt(vs / (n * n))).toFixed(1)} pts (crude 1/sqrt(n·R) ±${(100 / Math.sqrt(scored)).toFixed(1)}); headroom ${(100 - (100 * passes) / scored).toFixed(1)} pts.`,
  );
}
const served = {};
for (const r of [...rows, ...errors])
  served[`${r.meta?.requested_model ?? '?'} -> ${r.model}`] =
    (served[`${r.meta?.requested_model ?? '?'} -> ${r.model}`] ?? 0) + 1;
const spend = [...rows, ...errors].reduce((s, r) => s + (r.cost_usd ?? 0), 0);
out.push('');
out.push(
  `Served models: ${JSON.stringify(served)}. Rows ${rows.length}, errors ${errors.length}. Variant spend $${spend.toFixed(2)}.`,
);
if (errors.length) {
  out.push('');
  out.push('Errors (excluded from denominators):');
  for (const e of errors) out.push(`- ${e.prompt_id} rep${e.rep} [${e.class}] ${e.error}`);
}

if (flags.includes('--failures')) {
  out.push('');
  out.push('Failing gating episodes:');
  for (const r of rows) {
    if (r.meta.phase !== 'multi' || r.meta.mode !== 'projection' || r.grade.pass === 1) continue;
    out.push(
      `- ${r.prompt_id} rep${r.rep}: tool_ok=${r.grade.tool_ok} forbidden=${r.meta.forbidden} capped=${r.meta.turn_capped} route=${r.meta.route} upstream=[${r.meta.upstream.join(', ')}] -> traces/${r.prompt_id}_rep${r.rep}.json`,
    );
  }
}

if (flags.includes('--crosscheck')) {
  out.push('');
  out.push('Cross-check vs harness summary (successes/scored):');
  const rawDir = join(vdir, 'raw');
  for (const f of readdirSync(rawDir).filter((f) => f.endsWith('.json') && !f.startsWith('.'))) {
    const raw = JSON.parse(readFileSync(join(rawDir, f), 'utf8'));
    const phase = f.replace(/\.json$/, '');
    for (const c of raw.summary.cells) {
      const mine = rows.filter(
        (r) => r.meta.phase === phase && r.meta.mode === c.mode && r.meta.preset === c.model,
      );
      const ok = mine.reduce((s, r) => s + r.grade.pass, 0);
      const flag = ok === c.successes && mine.length === c.scored ? 'ok' : 'MISMATCH';
      out.push(
        `- ${phase} ${c.model}/${c.mode}: harness ${c.successes}/${c.scored} (est $${c.estimatedUsd.toFixed(2)}, std ${typeof c.standardUsd === 'number' ? `$${c.standardUsd.toFixed(2)}` : 'not measured'}), rows ${ok}/${mine.length} -> ${flag}`,
      );
    }
  }
}
void state;
process.stdout.write(out.join('\n') + '\n');
