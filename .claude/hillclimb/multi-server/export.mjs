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
//       standard_cost_usd is the harness's standardUsd (warm static prefix,
//       conversation cached incrementally, no batch discount: comparable
//       across modes and runs); null where not measured (records from
//       before per-turn usage). summary.json adds per-cell totals and
//       standard_cost_per_success.
//
//   node export.mjs scope <flow-dir> <phase> <scope-json-file>
//       Print a phase's resolved scope (cells x tasks x reps, est. cost) and
//       the spend so far; exit 4 when the episode count differs from
//       _state.json.phases[<phase>].episodes, exit 3 when spend so far plus
//       this estimate would pass _state.json.budget_usd. Observed per-episode
//       costs are taken back to list price; with PROJ_EVAL_BATCH=1 (as
//       run-round.sh is called) the estimate is at the batch price.
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

/** Phase a raw file belongs to, from its file name (multi.json, guard.json, direct.json). */
const phaseOf = (file) => basename(file, '.json');

/** The Message Batches API bills every token at this share (the harness's BATCH_PRICE_FACTOR). */
export const BATCH_PRICE_FACTOR = 0.5;

/** USD for one row at list price: cache reads at 0.1x input, cache writes at 1.25x input. */
export function costUsd(prices, model, usage) {
  const key = Object.keys(prices).find((k) => model === k || model?.startsWith(`${k}-`));
  const p = key === undefined ? undefined : prices[key];
  if (p === undefined || usage === undefined) return null;
  const input =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) * 0.1 +
    (usage.cache_creation_input_tokens ?? 0) * 1.25;
  return (input * p.in + (usage.output_tokens ?? 0) * p.out) / 1e6;
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

function exportVariant(variantDir) {
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
      boxDescriptions: raw.boxDescriptions === true,
      outputSchemas: raw.outputSchemas === true,
      batch: raw.batch === true,
    };
    for (const r of raw.records) {
      const id = promptId(r.task, r.model, r.mode);
      const usage = mapUsage(r.usage);
      const model = r.servedModel ?? r.modelId;
      const listCost = costUsd(prices, model, usage);
      // Actual spend: the batch tier bills at half price.
      const cost =
        listCost === null ? null : listCost * (r.batch === true ? BATCH_PRICE_FACTOR : 1);
      const standard = typeof r.standardUsd === 'number' ? r.standardUsd : null;
      const cellKey = `${phase}|${r.model}|${r.mode}`;
      const c = (cells[cellKey] ??= {
        episodes: 0,
        scored: 0,
        passes: 0,
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

function spendSoFar(flow) {
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
 * Per-episode cost priors by (model preset, mode, phase): the mean cost of
 * matching rows already on disk, else a fixed prior from the pre-loop sanity
 * pass (haiku45 multi: projection $0.023, boxes $0.031, direct $0.075 per
 * episode; sonnet-low scaled from the hard tier's ratios).
 */
const PRIORS = {
  'haiku45|projection|multi': 0.023,
  'haiku45|projection-boxes|multi': 0.031,
  'haiku45|direct|direct': 0.075,
  'sonnet-low|projection|multi': 0.025,
  'sonnet-low|projection-boxes|multi': 0.032,
  'sonnet-low|direct|direct': 0.22,
  'haiku45|projection|guard': 0.022,
  'sonnet-low|projection|guard': 0.02,
};

function scope(flow, phase, scopeFile) {
  const state = readJSON(join(flow, '_state.json'), {});
  const sc = readJSON(scopeFile);
  const observed = {};
  for (const v of variantDirs(flow)) {
    for (const r of [
      ...readJSONL(join(v, 'results.jsonl')),
      ...readJSONL(join(v, 'errors.jsonl')),
    ]) {
      if (r.cost_usd == null) continue;
      const [task, preset, mode] = r.prompt_id.split('.');
      void task;
      const k = `${preset}|${mode}|${r.phase ?? r.meta?.phase}`;
      // Back to list price, so batch and interactive rows estimate alike.
      const batched = r.batch === true || r.meta?.batch === true;
      (observed[k] ??= []).push(batched ? r.cost_usd / BATCH_PRICE_FACTOR : r.cost_usd);
    }
  }
  // run-round.sh is called with PROJ_EVAL_BATCH=1 for a batch phase.
  const priceFactor = process.env.PROJ_EVAL_BATCH === '1' ? BATCH_PRICE_FACTOR : 1;
  let est = 0;
  const lines = [];
  for (const c of sc.cells) {
    const k = `${c.model}|${c.mode}|${phase}`;
    const obs = observed[k];
    const per =
      priceFactor *
      (obs?.length ? obs.reduce((a, b) => a + b, 0) / obs.length : (PRIORS[k] ?? 0.05));
    const n = c.tasks * sc.runs;
    est += n * per;
    lines.push(
      `  ${c.model.padEnd(11)} ${c.mode.padEnd(17)} ${String(c.tasks).padStart(3)} tasks x ${sc.runs} reps = ${String(n).padStart(4)} episodes @ $${per.toFixed(4)}${obs?.length ? ' (observed)' : ' (prior)'} = $${(n * per).toFixed(2)}`,
    );
  }
  const { total, per } = spendSoFar(flow);
  process.stdout.write(
    `scope ${phase}: tiers ${sc.tiers.join(',')}; ${sc.episodes} episodes; est. $${est.toFixed(2)}` +
      `${priceFactor !== 1 ? ' (batch price)' : ''}\n${lines.join('\n')}\n` +
      `spend so far $${total.toFixed(2)} ${JSON.stringify(per)}; budget $${state.budget_usd ?? '?'}\n`,
  );
  const expected = state.phases?.[phase]?.episodes;
  if (expected !== undefined && expected !== sc.episodes) {
    process.stderr.write(
      `STOP: phase ${phase} resolved ${sc.episodes} episodes, the approved plan has ${expected}\n`,
    );
    process.exit(4);
  }
  if (state.budget_usd !== undefined && total + est > state.budget_usd) {
    process.stderr.write(
      `STOP: spend so far $${total.toFixed(2)} + this phase est. $${est.toFixed(2)} passes the $${state.budget_usd} budget\n`,
    );
    process.exit(3);
  }
}

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
