#!/usr/bin/env node
// Hill-climb exporter for the Projection multi-server flow. Node builtins only.
//
//   node export.mjs export <variant-dir>
//       Read every raw harness results file in <variant-dir>/raw/*.json
//       (copied there by run-round.sh) and write the hill-climb layout:
//       results.jsonl (one row per scored episode), errors.jsonl (harness
//       errors and served-model mismatches: never scored, still billed),
//       traces/<prompt_id>_rep<k>.json, summary.json.
//       cost_usd is the actual eval spend: list price, times 0.5 for an
//       episode run through the Message Batches API (record batch: true).
//       Each call is priced on the rate card its prompt selects (Haiku 5.5:
//       $0.50/$2.50 for a prompt over 100K tokens; _state.json.prices
//       long_context). latency_s is the episode's wall clock; on a batch
//       row (batch: true) it spans lockstep ticks, batch queueing and
//       polling included, so it is NOT comparable with interactive rows.
//       standard_cost_usd is the harness's standardUsd (warm static prefix,
//       conversation cached incrementally, no batch discount: comparable
//       across modes and runs); null where not measured (records from
//       before per-turn usage). summary.json adds per-cell totals,
//       context_overflows (scored episodes that ran out of context window:
//       failures, never errors) and standard_cost_per_success.
//
//   node export.mjs scope <flow-dir> <phase> <scope-json-file>
//       Print a phase's resolved scope (cells x tiers x tasks x reps, est.
//       cost) and the spend so far. Each cell x tier is estimated from the
//       observed per-episode cost of the same preset, mode, phase and tier
//       (the tier is the task's, from prompt_id); else a pilot (that preset,
//       mode and tier in any phase); else the phase's prior, only for the
//       tiers it was measured on; else, for multi-hard, $1/episode at list
//       price. Exit 5 when a cell x tier has none of these (run a pilot),
//       4 when the episode count differs from
//       _state.json.phases[<phase>].episodes, 3 when spend so far plus this
//       estimate would pass _state.json.budget_usd. Observed costs are
//       taken back to list price; with PROJ_EVAL_BATCH=1 (as run-round.sh
//       is called) the estimate is at the batch price.
//
//   node export.mjs spend <flow-dir>
//       Print cumulative spend: sum(cost_usd) over every variant's
//       results.jsonl plus the billed usage on errors.jsonl rows (actual
//       spend, batch discount included).
//
// prompt_id is `<task>.<model>.<mode>` - the user-facing `<task>|<model>|<mode>`
// with `|` sanitized to `.` so the same id keys rows, trace files and the
// report's trace links (the report builder only links path-safe ids).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const readJSON = (p, fallback) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
};
const readJSONL = (p) =>
  existsSync(p)
    ? readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];

export const promptId = (task, model, mode) => `${task}.${model}.${mode}`;

/** Phase a raw file belongs to, from its file name (multi.json, guard.json, multi-hard.json, direct.json). */
const phaseOf = (file) => basename(file, '.json');

/** The Message Batches API bills every token at this share (the harness's BATCH_PRICE_FACTOR). */
export const BATCH_PRICE_FACTOR = 0.5;

/**
 * The rate card one request is billed on: `long_context` (Haiku 5.5:
 * `{ above_tokens: 100000, in: 0.5, out: 2.5 }` in _state.json.prices) when
 * its prompt (uncached + cache read + cache write) is over `above_tokens`,
 * else the model's base `in`/`out`.
 */
export function rateFor(price, promptTokens) {
  const long = price.long_context;
  return long !== undefined && promptTokens > long.above_tokens ? long : price;
}

const usdAt = (rate, usage) =>
  (((usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) * 0.1 +
    (usage.cache_creation_input_tokens ?? 0) * 1.25) *
    rate.in +
    (usage.output_tokens ?? 0) * rate.out) /
  1e6;

/**
 * USD for one row at list price: cache reads at 0.1x input, cache writes at
 * 1.25x input. `turns` (the harness record's per-call usage, camelCase):
 * each call priced on the rate card its own prompt selects (`rateFor`);
 * without them, `usage` at the base card.
 */
export function costUsd(prices, model, usage, turns) {
  const key = Object.keys(prices).find((k) => model === k || model?.startsWith(`${k}-`));
  const p = key === undefined ? undefined : prices[key];
  if (p === undefined || usage === undefined) return null;
  if (Array.isArray(turns) && turns.length > 0) {
    return turns.reduce((sum, t) => {
      const u = mapUsage(t);
      const prompt = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
      return sum + usdAt(rateFor(p, prompt), u);
    }, 0);
  }
  return usdAt(p, usage);
}

const mapUsage = (u) => ({
  input_tokens: u?.inputTokens ?? 0,
  output_tokens: u?.outputTokens ?? 0,
  cache_read_input_tokens: u?.cacheReadInputTokens ?? 0,
  cache_creation_input_tokens: u?.cacheCreationInputTokens ?? 0,
});

/** The served model matches the request: equal, or the request's dated snapshot. */
const servedMatches = (requested, served) =>
  typeof served === 'string' && (served === requested || served.startsWith(`${requested}-`));

/** A harness transcript as hill-climb trace turns. */
function traceTurns(transcript) {
  if (transcript === undefined) return [];
  const turns = [{ role: 'system', content: transcript.system ?? '' }];
  const toolNames = new Map();
  for (const message of transcript.messages ?? []) {
    if (typeof message.content === 'string') {
      turns.push({ role: message.role, content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      const text = [];
      const thinking = [];
      const calls = [];
      for (const block of message.content) {
        if (block.type === 'text') text.push(block.text);
        else if (block.type === 'thinking') thinking.push(block.thinking);
        else if (block.type === 'redacted_thinking') thinking.push('[redacted thinking]');
        else if (block.type === 'tool_use') {
          toolNames.set(block.id, block.name);
          calls.push({
            role: 'tool_call',
            name: block.name,
            content: JSON.stringify(block.input, null, 2),
          });
        } else text.push(`[${block.type} block]`);
      }
      if (text.length > 0 || thinking.length > 0) {
        turns.push({
          role: 'assistant',
          content: text.join('\n'),
          ...(thinking.length > 0 ? { thinking: thinking.join('\n\n') } : {}),
        });
      }
      turns.push(...calls);
    } else {
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          turns.push({
            role: 'tool_result',
            name: toolNames.get(block.tool_use_id) ?? 'unknown',
            content: (block.is_error === true ? '[is_error] ' : '') + String(block.content ?? ''),
          });
        } else if (block.type === 'text') turns.push({ role: 'user', content: block.text });
      }
    }
  }
  return turns;
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

export function exportVariant(variantDir) {
  const vdir = resolve(variantDir);
  const flow = dirname(vdir);
  const state = readJSON(join(flow, '_state.json'), {});
  const prices = state.prices ?? {};
  const rawDir = join(vdir, 'raw');
  const rawFiles = existsSync(rawDir)
    ? readdirSync(rawDir)
        .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
        .sort()
        .map((f) => join(rawDir, f))
    : [];
  if (rawFiles.length === 0) throw new Error(`no raw harness files in ${rawDir}`);

  rmSync(join(vdir, 'traces'), { recursive: true, force: true });
  mkdirSync(join(vdir, 'traces'), { recursive: true });
  const rows = [];
  const errors = [];
  const phases = {};
  const served = {};
  const cells = {};
  for (const file of rawFiles) {
    const raw = readJSON(file);
    const phase = phaseOf(file);
    phases[phase] = {
      file: `raw/${basename(file)}`,
      sha256: sha256File(file),
      generatedAt: raw.generatedAt,
      updatedAt: raw.updatedAt,
      models: raw.models,
      modes: raw.modes,
      tiers: raw.tiers,
      runs: raw.runs,
      tasks: raw.tasks?.length,
      records: raw.records.length,
      maxTurns: raw.maxTurns,
      maxTotalTurns: raw.maxTotalTurns,
      taskMaxTurns: raw.taskMaxTurns,
      boxDescriptions: raw.boxDescriptions === true,
      outputSchemas: raw.outputSchemas === true,
      batch: raw.batch === true,
    };
    for (const r of raw.records) {
      const id = promptId(r.task, r.model, r.mode);
      const usage = mapUsage(r.usage);
      const model = r.servedModel ?? r.modelId;
      const listCost = costUsd(prices, model, usage, r.turns);
      // Actual spend: the batch tier bills at half price.
      const cost =
        listCost === null ? null : listCost * (r.batch === true ? BATCH_PRICE_FACTOR : 1);
      const standard = typeof r.standardUsd === 'number' ? r.standardUsd : null;
      const cellKey = `${phase}|${r.model}|${r.mode}`;
      const c = (cells[cellKey] ??= {
        episodes: 0,
        scored: 0,
        passes: 0,
        context_overflows: 0,
        cost_usd: 0,
        standard_cost_usd: 0,
      });
      c.episodes += 1;
      c.cost_usd += cost ?? 0;
      c.standard_cost_usd =
        c.standard_cost_usd === null || standard === null ? null : c.standard_cost_usd + standard;
      const key = `${r.modelId} -> ${r.servedModel ?? '(none)'}`;
      served[key] = (served[key] ?? 0) + 1;
      const prompt =
        typeof r.transcript?.messages?.[0]?.content === 'string'
          ? r.transcript.messages[0].content
          : '';
      const base = {
        prompt_id: id,
        rep: r.run,
        phase,
        tier: r.tier,
        model,
        usage,
        cost_usd: cost,
        standard_cost_usd: standard,
        ...(r.batch === true ? { batch: true } : {}),
      };
      if (r.harnessError !== undefined) {
        errors.push({
          ...base,
          class: 'harness_error',
          error: r.harnessError,
          stop_reason: r.stopReason,
        });
        continue;
      }
      if (!servedMatches(r.modelId, r.servedModel)) {
        errors.push({
          ...base,
          class: 'served_model_mismatch',
          error: `requested ${r.modelId}, served ${r.servedModel ?? '(none)'}`,
        });
        continue;
      }
      c.scored += 1;
      c.passes += r.success ? 1 : 0;
      // Ran out of context window: scored, and a failure.
      c.context_overflows += r.contextOverflow === true ? 1 : 0;
      rows.push({
        prompt_id: id,
        rep: r.run,
        prompt,
        tags: [r.mode, r.model, r.tier],
        grade: { pass: r.success ? 1 : 0, tool_ok: r.toolCorrect ? 1 : 0 },
        status: 'ok',
        model,
        usage,
        cost_usd: cost,
        standard_cost_usd: standard,
        // Batch rows: wall clock across lockstep ticks (queueing and
        // polling included), not comparable with interactive latency.
        latency_s: Math.round(r.wallMs) / 1000,
        tool_calls: r.toolUseCount,
        api_turns: r.apiTurns,
        upstream_calls: r.upstreamCalls?.length ?? 0,
        meta: {
          phase,
          task: r.task,
          tier: r.tier,
          kind: r.kind,
          mode: r.mode,
          preset: r.model,
          requested_model: r.modelId,
          served_model: r.servedModel,
          forbidden: r.forbidden,
          turn_capped: r.turnCapped,
          ...(r.contextOverflow === true ? { context_overflow: true } : {}),
          budget_turns: r.budgetTurns,
          stop_reason: r.stopReason,
          ...(r.batch === true ? { batch: true } : {}),
          ...(r.prefixSource !== undefined ? { prefix_source: r.prefixSource } : {}),
          ...(r.projection !== undefined
            ? {
                route: r.projection.route,
                search_tools: r.projection.searchTools,
                search_boxes: r.projection.searchBoxes,
                describe_tool: r.projection.describeTool,
                discover_apis: r.projection.discoverApis,
                approvals: r.projection.approvals,
              }
            : {}),
          ...(r.boxes !== undefined ? { boxes: r.boxes } : {}),
          upstream: (r.upstreamCalls ?? []).map((c) => c.tool),
        },
      });
      writeFileSync(
        join(vdir, 'traces', `${id}_rep${r.run}.json`),
        JSON.stringify(traceTurns(r.transcript), null, 2) + '\n',
      );
    }
  }
  writeFileSync(join(vdir, 'results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (errors.length > 0) {
    writeFileSync(
      join(vdir, 'errors.jsonl'),
      errors.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
  } else rmSync(join(vdir, 'errors.jsonl'), { force: true });

  const prior = readJSON(join(vdir, 'summary.json'), {});
  const spend =
    rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0) +
    errors.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const billed = [...rows, ...errors];
  const standardTotal = billed.some((r) => r.standard_cost_usd === null)
    ? null
    : billed.reduce((s, r) => s + r.standard_cost_usd, 0);
  const round4 = (x) => (x === null ? null : Math.round(x * 10000) / 10000);
  for (const c of Object.values(cells)) {
    // Every billed episode's standard cost (errors included) over the passes.
    c.standard_cost_per_success =
      c.standard_cost_usd === null || c.passes === 0
        ? null
        : round4(c.standard_cost_usd / c.passes);
    c.cost_usd = round4(c.cost_usd);
    c.standard_cost_usd = round4(c.standard_cost_usd);
  }
  const summary = {
    ...prior,
    description: prior.description ?? basename(vdir),
    target: prior.target ?? 'system_prompt',
    phases,
    rows: rows.length,
    errors: errors.length,
    served_models: served,
    cost_usd: Math.round(spend * 10000) / 10000,
    standard_cost_usd: round4(standardTotal),
    cells,
  };
  writeFileSync(join(vdir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(
    `exported ${basename(vdir)}: ${rows.length} rows, ${errors.length} errors, $${spend.toFixed(2)} spent ` +
      `(standard ${standardTotal === null ? 'not measured' : `$${standardTotal.toFixed(2)}`}); served ${JSON.stringify(served)}\n`,
  );
  if (Object.keys(served).some((k) => !servedMatches(...k.split(' -> ')))) {
    process.stdout.write('WARNING: served-model mismatch - see errors.jsonl\n');
  }
}

/** Every variant dir under the flow (anything holding a results.jsonl or errors.jsonl). */
function variantDirs(flow) {
  return readdirSync(flow, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.isSymbolicLink())
    .map((d) => join(flow, d.name))
    .filter((d) => existsSync(join(d, 'results.jsonl')) || existsSync(join(d, 'errors.jsonl')));
}

export function spendSoFar(flow) {
  let total = 0;
  const per = {};
  for (const v of variantDirs(flow)) {
    const s = [
      ...readJSONL(join(v, 'results.jsonl')),
      ...readJSONL(join(v, 'errors.jsonl')),
    ].reduce((acc, r) => acc + (r.cost_usd ?? 0), 0);
    per[basename(v)] = Math.round(s * 100) / 100;
    total += s;
  }
  return { total, per };
}

/**
 * Per-episode cost priors at list price, by (model preset, mode, phase),
 * from the pre-loop sanity pass (haiku45 multi: projection $0.023, boxes
 * $0.031, direct $0.075 per episode; sonnet-low scaled from the hard tier's
 * ratios). A prior stands in only for the tiers it was measured on
 * (PRIOR_TIERS); observed rows always win.
 */
export const PRIORS = {
  'haiku45|projection|multi': 0.023,
  'haiku45|projection-boxes|multi': 0.031,
  'haiku45|direct|direct': 0.075,
  'sonnet-low|projection|multi': 0.025,
  'sonnet-low|projection-boxes|multi': 0.032,
  'sonnet-low|direct|direct': 0.22,
  'haiku45|projection|guard': 0.022,
  'sonnet-low|projection|guard': 0.02,
};
/** The tiers each phase's prior was measured on. */
export const PRIOR_TIERS = {
  multi: ['multi'],
  direct: ['multi'],
  guard: ['basic', 'hard', 'filesystem', 'mongodb'],
};
/**
 * The conservative list-price prior for a multi-hard episode with no
 * observation and no pilot: its episodes run 2N + 10 turns over large
 * results, an order of magnitude past the multi tier's.
 */
export const MULTI_HARD_PRIOR_USD = 1;

/**
 * Observed list-price cost per episode, keyed `preset|mode|phase|tier`.
 * The tier is the task's (from prompt_id), looked up in `tierOf` (the
 * scope's tasks, then any row's meta.tier, then an error row's tier); a
 * row whose task has no known tier is not used.
 */
export function observedCosts(rows, tierOf) {
  const known = new Map(tierOf);
  for (const r of rows) {
    const task = r.prompt_id.split('.')[0];
    const tier = r.meta?.tier ?? r.tier;
    if (!known.has(task) && typeof tier === 'string') known.set(task, tier);
  }
  const observed = {};
  for (const r of rows) {
    if (r.cost_usd == null) continue;
    const [task, preset, mode] = r.prompt_id.split('.');
    const tier = known.get(task);
    if (tier === undefined) continue;
    const k = `${preset}|${mode}|${r.phase ?? r.meta?.phase}|${tier}`;
    // Back to list price, so batch and interactive rows estimate alike.
    const batched = r.batch === true || r.meta?.batch === true;
    (observed[k] ??= []).push(batched ? r.cost_usd / BATCH_PRICE_FACTOR : r.cost_usd);
  }
  return observed;
}

const meanOf = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * The list-price cost basis for one cell x tier, or undefined when there is
 * none: observed in this phase; else a pilot (the same preset, mode and
 * tier observed in any other phase); else the phase's prior when it was
 * measured on this tier; else, for multi-hard, MULTI_HARD_PRIOR_USD.
 */
export function costBasis(observed, preset, mode, phase, tier) {
  const exact = observed[`${preset}|${mode}|${phase}|${tier}`];
  if (exact?.length) return { usd: meanOf(exact), source: 'observed' };
  const pilot = Object.entries(observed)
    .filter(([k]) => {
      const [p, m, , t] = k.split('|');
      return p === preset && m === mode && t === tier;
    })
    .flatMap(([, xs]) => xs);
  if (pilot.length) return { usd: meanOf(pilot), source: 'pilot' };
  const prior = PRIORS[`${preset}|${mode}|${phase}`];
  if (prior !== undefined && (PRIOR_TIERS[phase] ?? []).includes(tier)) {
    return { usd: prior, source: 'prior' };
  }
  if (tier === 'multi-hard') return { usd: MULTI_HARD_PRIOR_USD, source: 'multi-hard prior' };
  return undefined;
}

/**
 * The scope gate as data: `{ code, out, err }`. code 0 passes; 5 when a
 * cell x tier has no cost basis (run a pilot first); 4 when the episode
 * count differs from the approved plan; 3 when spend so far plus the
 * estimate passes the budget.
 */
export function scopeReport(flow, phase, sc, { batch = false } = {}) {
  const state = readJSON(join(flow, '_state.json'), {});
  const rows = variantDirs(flow).flatMap((v) => [
    ...readJSONL(join(v, 'results.jsonl')),
    ...readJSONL(join(v, 'errors.jsonl')),
  ]);
  const tierOf = new Map((sc.tasks ?? []).map((t) => [t.name, t.tier]));
  const observed = observedCosts(rows, tierOf);
  const priceFactor = batch ? BATCH_PRICE_FACTOR : 1;
  let est = 0;
  const lines = [];
  const missing = [];
  for (const c of sc.cells) {
    // Per tier when the scope says how the cell's tasks split (scope.ts
    // does); a scope without the split is one tier per cell at most.
    const split = c.tiers ?? (sc.tiers?.length === 1 ? { [sc.tiers[0]]: c.tasks } : undefined);
    if (split === undefined) {
      missing.push(`${c.model}/${c.mode}: no per-tier task split in the scope`);
      continue;
    }
    for (const [tier, tasks] of Object.entries(split)) {
      const basis = costBasis(observed, c.model, c.mode, phase, tier);
      const n = tasks * sc.runs;
      if (basis === undefined) {
        missing.push(`${c.model}/${c.mode} ${tier}`);
        continue;
      }
      const per = priceFactor * basis.usd;
      est += n * per;
      lines.push(
        `  ${c.model.padEnd(11)} ${c.mode.padEnd(17)} ${tier.padEnd(11)} ${String(tasks).padStart(3)} tasks x ${sc.runs} reps = ${String(n).padStart(4)} episodes @ $${per.toFixed(4)} (${basis.source}) = $${(n * per).toFixed(2)}`,
      );
    }
  }
  const { total, per } = spendSoFar(flow);
  const out =
    `scope ${phase}: tiers ${sc.tiers.join(',')}; ${sc.episodes} episodes; est. $${est.toFixed(2)}` +
    `${priceFactor !== 1 ? ' (batch price)' : ''}\n${lines.join('\n')}\n` +
    `spend so far $${total.toFixed(2)} ${JSON.stringify(per)}; budget $${state.budget_usd ?? '?'}\n`;
  if (missing.length > 0) {
    return {
      code: 5,
      out,
      err: `STOP: no observed cost, pilot or prior for ${missing.join('; ')} - run a pilot of that cell and tier first\n`,
    };
  }
  const expected = state.phases?.[phase]?.episodes;
  if (expected !== undefined && expected !== sc.episodes) {
    return {
      code: 4,
      out,
      err: `STOP: phase ${phase} resolved ${sc.episodes} episodes, the approved plan has ${expected}\n`,
    };
  }
  if (state.budget_usd !== undefined && total + est > state.budget_usd) {
    return {
      code: 3,
      out,
      err: `STOP: spend so far $${total.toFixed(2)} + this phase est. $${est.toFixed(2)} passes the $${state.budget_usd} budget\n`,
    };
  }
  return { code: 0, out, err: '' };
}

function scope(flow, phase, scopeFile) {
  // run-round.sh is called with PROJ_EVAL_BATCH=1 for a batch phase.
  const report = scopeReport(flow, phase, readJSON(scopeFile), {
    batch: process.env.PROJ_EVAL_BATCH === '1',
  });
  process.stdout.write(report.out);
  if (report.err !== '') process.stderr.write(report.err);
  if (report.code !== 0) process.exit(report.code);
}

// The CLI runs only when this file is the entry point (tests import it).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'export') exportVariant(args[0]);
  else if (cmd === 'scope') scope(resolve(args[0]), args[1], args[2]);
  else if (cmd === 'spend') {
    const { total, per } = spendSoFar(resolve(args[0]));
    process.stdout.write(`spend $${total.toFixed(2)} ${JSON.stringify(per)}\n`);
  } else {
    process.stderr.write(
      'usage: export.mjs export <variant-dir> | scope <flow> <phase> <scope.json> | spend <flow>\n',
    );
    process.exit(1);
  }
}
