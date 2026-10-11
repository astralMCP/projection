/**
 * Tool-choice eval runner and report: for each model × mode × task × run,
 * drive one agent episode against a fresh fake, score the recorded upstream
 * calls with the task's predicate, and aggregate.
 *
 * "Success" is tool AND arguments correct; "tool-correct" is the right
 * upstream tool(s) reached with any arguments. Episodes that ended on a
 * harness error (refusal, max_tokens, API error, or an exception thrown by
 * the harness itself) are excluded from both denominators and counted
 * separately — their tokens still count toward spend. Hitting the turn cap
 * is NOT a harness error: the upstream calls made before the cap are fully
 * observable, so such episodes are scored on them and flagged `turnCapped`.
 *
 * One planned episode never takes the matrix down with it: any exception
 * (opening the session, the agent loop, closing, scoring, the progress
 * callback) becomes a harness-error record and the other workers carry on.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SideEffect } from '../types.js';
import {
  anthropicCaller,
  resolveModelPresets,
  runAgentEpisode,
  type AgentEpisode,
  type EpisodeUsage,
  type ModelCaller,
  type ModelPreset,
  type ToolUseRecord,
} from './agent.js';
import { EVAL_MODES, openSession, type EvalMode, type ModeSession } from './modes.js';
import {
  TASK_TIERS,
  TOOL_CHOICE_TASKS,
  type EvalTask,
  type TaskKind,
  type TaskTier,
} from './tasks.js';

export type ProjectionRoute = 'call_tool' | 'execute_machine' | 'both' | 'neither';

/** How an episode used Projection's surface (projection mode only). */
export interface ProjectionUse {
  route: ProjectionRoute;
  searchTools: number;
  describeTool: number;
  discoverApis: number;
  /** Approval prompts auto-accepted (MRTR round trips). */
  approvals: number;
}

export interface EpisodeRecord {
  /** Preset name (e.g. haiku-low). */
  model: string;
  modelId: string;
  mode: EvalMode;
  task: string;
  tier: TaskTier;
  kind: TaskKind;
  /** Zero-based run index. */
  run: number;
  /** The task's `expect` held and no forbidden call was made. */
  success: boolean;
  toolCorrect: boolean;
  /** A call the task forbids was made (always false for tasks without `forbid`). */
  forbidden: boolean;
  /**
   * The episode stopped at the turn cap while the model was still calling
   * tools. Scored normally on the calls made up to the cap.
   */
  turnCapped: boolean;
  /**
   * Present when the episode is excluded from the success denominators: a
   * model stop reason the eval cannot score (refusal, max_tokens, …), a
   * thrown API error, or `harness: <name>: <message>` when the harness
   * itself threw while running the episode.
   */
  harnessError?: string;
  apiTurns: number;
  toolUseCount: number;
  /** What the model emitted (in projection mode, Projection's tools). */
  toolUses: ToolUseRecord[];
  /** What reached the fake. */
  upstreamCalls: SideEffect[];
  projection?: ProjectionUse;
  usage: EpisodeUsage;
  wallMs: number;
  stopReason?: string;
  finalText: string;
}

export interface ToolChoiceEvalOptions {
  /** Default: both built-in presets. */
  models?: ModelPreset[];
  /** Default: both modes. */
  modes?: EvalMode[];
  /** Default: every task. */
  tasks?: EvalTask[];
  /** Episodes per model × mode × task. Default 3. */
  runs?: number;
  /** Default: the live Anthropic API. Tests inject a script. */
  caller?: ModelCaller;
  /** Messages API calls per episode. Default 12. */
  maxTurns?: number;
  /** Episodes in flight at once. Default 1. */
  concurrency?: number;
  /**
   * Whether the fake advertises the real server's `instructions` (both modes
   * see them). Default true.
   */
  serverInstructions?: boolean;
  onEpisode?: (record: EpisodeRecord) => void;
}

export const DEFAULT_RUNS = 3;

function summarizeProjectionUse(toolUses: ToolUseRecord[], approvals: number): ProjectionUse {
  const count = (name: string): number => toolUses.filter((t) => t.name === name).length;
  const callTool = count('call_tool') > 0;
  const machine = count('execute_machine') > 0;
  const route: ProjectionRoute =
    callTool && machine ? 'both' : callTool ? 'call_tool' : machine ? 'execute_machine' : 'neither';
  return {
    route,
    searchTools: count('search_tools'),
    describeTool: count('describe_tool'),
    discoverApis: count('discover_apis'),
    approvals,
  };
}

interface PlannedEpisode {
  model: ModelPreset;
  mode: EvalMode;
  task: EvalTask;
  run: number;
}

const EMPTY_USAGE: Readonly<EpisodeUsage> = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Score a finished episode against the task. A thrown predicate is the
 * caller's problem (it surfaces as a harness error there).
 */
function scoreEpisode(
  planned: PlannedEpisode,
  session: ModeSession,
  episode: AgentEpisode,
): EpisodeRecord {
  const { model, mode, task, run } = planned;
  const upstreamCalls = session.fake.calls.slice();
  const scored = episode.harnessError === undefined;
  const forbid = task.forbid;
  const forbidden = forbid !== undefined && upstreamCalls.some((call) => forbid(call));
  return {
    model: model.name,
    modelId: model.model,
    mode,
    task: task.name,
    tier: task.tier,
    kind: task.kind,
    run,
    success: scored && !forbidden && task.expect(upstreamCalls),
    toolCorrect:
      scored &&
      task.steps.every((group) => upstreamCalls.some((call) => group.includes(call.tool))),
    forbidden,
    turnCapped: episode.turnCapped,
    ...(episode.harnessError !== undefined ? { harnessError: episode.harnessError } : {}),
    apiTurns: episode.apiTurns,
    toolUseCount: episode.toolUses.length,
    toolUses: episode.toolUses,
    upstreamCalls,
    ...(mode === 'projection'
      ? { projection: summarizeProjectionUse(episode.toolUses, session.approvals) }
      : {}),
    usage: episode.usage,
    wallMs: episode.wallMs,
    ...(episode.stopReason !== undefined ? { stopReason: episode.stopReason } : {}),
    finalText: episode.finalText,
  };
}

/**
 * The record for an episode the harness itself failed on. Keeps whatever
 * was observed before the throw (upstream calls, tool uses, usage) so the
 * spend still counts and the failure can be diagnosed from the JSON.
 */
function harnessFailureRecord(
  planned: PlannedEpisode,
  err: unknown,
  session: ModeSession | undefined,
  episode: AgentEpisode | undefined,
  startedAt: number,
): EpisodeRecord {
  const { model, mode, task, run } = planned;
  const upstreamCalls = session?.fake.calls.slice() ?? [];
  const toolUses = episode?.toolUses ?? [];
  return {
    model: model.name,
    modelId: model.model,
    mode,
    task: task.name,
    tier: task.tier,
    kind: task.kind,
    run,
    success: false,
    toolCorrect: false,
    forbidden: false,
    turnCapped: episode?.turnCapped ?? false,
    harnessError: `harness: ${errorMessage(err)}`,
    apiTurns: episode?.apiTurns ?? 0,
    toolUseCount: toolUses.length,
    toolUses,
    upstreamCalls,
    ...(mode === 'projection' && session !== undefined
      ? { projection: summarizeProjectionUse(toolUses, session.approvals) }
      : {}),
    usage: episode?.usage ?? { ...EMPTY_USAGE },
    wallMs: episode?.wallMs ?? Math.round(performance.now() - startedAt),
    ...(episode?.stopReason !== undefined ? { stopReason: episode.stopReason } : {}),
    finalText: episode?.finalText ?? '',
  };
}

/** Run one planned episode; never throws — failures become records. */
async function runPlanned(
  planned: PlannedEpisode,
  caller: ModelCaller,
  options: ToolChoiceEvalOptions,
): Promise<EpisodeRecord> {
  const { model, mode, task } = planned;
  const startedAt = performance.now();
  let session: ModeSession | undefined;
  let episode: AgentEpisode | undefined;
  try {
    session = await openSession(
      mode,
      options.serverInstructions === false ? { instructions: false } : {},
    );
    try {
      episode = await runAgentEpisode(
        caller,
        model,
        session.runtime,
        task.prompt,
        options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {},
      );
    } finally {
      await session.close();
    }
    return scoreEpisode(planned, session, episode);
  } catch (err) {
    return harnessFailureRecord(planned, err, session, episode, startedAt);
  }
}

/**
 * Run the matrix; records come back in model → mode → task → run order, one
 * per planned episode. `onEpisode` is best-effort progress reporting: an
 * exception thrown from it is swallowed so one bad callback cannot cost the
 * rest of the run.
 */
export async function runToolChoiceEval(
  options: ToolChoiceEvalOptions = {},
): Promise<EpisodeRecord[]> {
  const models = options.models ?? resolveModelPresets(undefined);
  const modes = options.modes ?? [...EVAL_MODES];
  const tasks = options.tasks ?? [...TOOL_CHOICE_TASKS];
  const runs = options.runs ?? DEFAULT_RUNS;
  const caller = options.caller ?? anthropicCaller();
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));

  const plan: PlannedEpisode[] = [];
  for (const model of models) {
    for (const mode of modes) {
      for (const task of tasks) {
        for (let run = 0; run < runs; run += 1) plan.push({ model, mode, task, run });
      }
    }
  }

  const records: EpisodeRecord[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const planned = plan[index];
      if (planned === undefined) return;
      const record = await runPlanned(planned, caller, options);
      records[index] = record;
      try {
        options.onEpisode?.(record);
      } catch {
        // Progress reporting must not take the matrix down.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, plan.length) }, worker));
  return records;
}

// ---------------------------------------------------------------------------
// Summary and report

/** USD per million tokens, Anthropic list prices. */
export const MODEL_PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
};

/** Cache reads at 10% of input, cache writes at 125%; unknown models cost 0. */
export function estimateUsd(modelId: string, usage: EpisodeUsage): number {
  const price = MODEL_PRICES[modelId];
  if (price === undefined) return 0;
  const input =
    usage.inputTokens + usage.cacheReadInputTokens * 0.1 + usage.cacheCreationInputTokens * 1.25;
  return (input * price.input + usage.outputTokens * price.output) / 1_000_000;
}

export interface CellSummary {
  model: string;
  modelId: string;
  mode: EvalMode;
  episodes: number;
  /** Episodes without a harness error (the success denominator). */
  scored: number;
  successes: number;
  toolCorrect: number;
  harnessErrors: number;
  /** Scored episodes that stopped at the turn cap. */
  turnCapped: number;
  meanTurns: number;
  meanUpstreamCalls: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  /** cache-read / (uncached + cache-read + cache-write) input tokens. */
  cacheReadShare: number;
  estimatedUsd: number;
  /** Projection mode only. */
  routes?: Record<ProjectionRoute, number>;
  meanSearchTools?: number;
  meanDescribeTool?: number;
  meanDiscoverApis?: number;
  meanApprovals?: number;
}

export interface TaskCellSummary {
  task: string;
  tier: TaskTier;
  kind: TaskKind;
  model: string;
  mode: EvalMode;
  successes: number;
  scored: number;
  episodes: number;
}

/** One tier in one cell: the success rate on that tier's tasks. */
export interface TierCellSummary {
  tier: TaskTier;
  model: string;
  mode: EvalMode;
  tasks: number;
  successes: number;
  toolCorrect: number;
  /** Scored episodes that made a forbidden call. */
  forbidden: number;
  scored: number;
  episodes: number;
}

export interface ToolChoiceSummary {
  episodes: number;
  cells: CellSummary[];
  /** Per tier × cell, in tier order (basic, then hard). */
  tiers: TierCellSummary[];
  tasks: TaskCellSummary[];
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function cellKey(record: { model: string; mode: EvalMode }): string {
  return `${record.model}/${record.mode}`;
}

function summarizeCell(records: EpisodeRecord[]): CellSummary {
  const first = records[0];
  if (first === undefined) throw new Error('summarizeCell: no records');
  const scored = records.filter((r) => r.harnessError === undefined);
  const uncached = records.reduce((a, r) => a + r.usage.inputTokens, 0);
  const cacheRead = records.reduce((a, r) => a + r.usage.cacheReadInputTokens, 0);
  const cacheWrite = records.reduce((a, r) => a + r.usage.cacheCreationInputTokens, 0);
  const totalInput = uncached + cacheRead + cacheWrite;
  const summary: CellSummary = {
    model: first.model,
    modelId: first.modelId,
    mode: first.mode,
    episodes: records.length,
    scored: scored.length,
    successes: scored.filter((r) => r.success).length,
    toolCorrect: scored.filter((r) => r.toolCorrect).length,
    harnessErrors: records.length - scored.length,
    turnCapped: scored.filter((r) => r.turnCapped).length,
    meanTurns: mean(records.map((r) => r.apiTurns)),
    meanUpstreamCalls: mean(records.map((r) => r.upstreamCalls.length)),
    meanInputTokens: mean(
      records.map(
        (r) =>
          r.usage.inputTokens + r.usage.cacheReadInputTokens + r.usage.cacheCreationInputTokens,
      ),
    ),
    meanOutputTokens: mean(records.map((r) => r.usage.outputTokens)),
    cacheReadShare: totalInput === 0 ? 0 : cacheRead / totalInput,
    estimatedUsd: records.reduce((a, r) => a + estimateUsd(r.modelId, r.usage), 0),
  };
  if (first.mode === 'projection') {
    const uses = records.flatMap((r) => (r.projection !== undefined ? [r.projection] : []));
    const routes: Record<ProjectionRoute, number> = {
      call_tool: 0,
      execute_machine: 0,
      both: 0,
      neither: 0,
    };
    for (const use of uses) routes[use.route] += 1;
    summary.routes = routes;
    summary.meanSearchTools = mean(uses.map((u) => u.searchTools));
    summary.meanDescribeTool = mean(uses.map((u) => u.describeTool));
    summary.meanDiscoverApis = mean(uses.map((u) => u.discoverApis));
    summary.meanApprovals = mean(uses.map((u) => u.approvals));
  }
  return summary;
}

export function summarizeToolChoice(records: EpisodeRecord[]): ToolChoiceSummary {
  const byCell = new Map<string, EpisodeRecord[]>();
  const byTaskCell = new Map<string, EpisodeRecord[]>();
  for (const record of records) {
    const key = cellKey(record);
    byCell.set(key, [...(byCell.get(key) ?? []), record]);
    const taskKey = `${record.task}|${key}`;
    byTaskCell.set(taskKey, [...(byTaskCell.get(taskKey) ?? []), record]);
  }
  const tasks: TaskCellSummary[] = [...byTaskCell.values()].map((group) => {
    const first = group[0] as EpisodeRecord;
    const scored = group.filter((r) => r.harnessError === undefined);
    return {
      task: first.task,
      tier: first.tier,
      kind: first.kind,
      model: first.model,
      mode: first.mode,
      successes: scored.filter((r) => r.success).length,
      scored: scored.length,
      episodes: group.length,
    };
  });
  const tiers: TierCellSummary[] = [];
  for (const tier of TASK_TIERS) {
    for (const group of byCell.values()) {
      const inTier = group.filter((r) => r.tier === tier);
      const first = inTier[0];
      if (first === undefined) continue;
      const scored = inTier.filter((r) => r.harnessError === undefined);
      tiers.push({
        tier,
        model: first.model,
        mode: first.mode,
        tasks: new Set(inTier.map((r) => r.task)).size,
        successes: scored.filter((r) => r.success).length,
        toolCorrect: scored.filter((r) => r.toolCorrect).length,
        forbidden: scored.filter((r) => r.forbidden).length,
        scored: scored.length,
        episodes: inTier.length,
      });
    }
  }
  return {
    episodes: records.length,
    cells: [...byCell.values()].map(summarizeCell),
    tiers,
    tasks,
  };
}

function pct(numerator: number, denominator: number): string {
  return denominator === 0
    ? '  n/a'
    : `${Math.round((100 * numerator) / denominator)}%`.padStart(4);
}

function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/** The human-readable report: per cell, per task, and Projection's route split. */
export function formatToolChoiceReport(records: EpisodeRecord[]): string {
  const summary = summarizeToolChoice(records);
  const models = [...new Set(records.map((r) => r.model))];
  const modes = [...new Set(records.map((r) => r.mode))];
  const taskNames = [...new Set(records.map((r) => r.task))];
  const runs = Math.max(0, ...summary.tasks.map((t) => t.episodes));
  const lines: string[] = [];

  lines.push(
    `Tool-choice eval: ${summary.episodes} episodes ` +
      `(${taskNames.length} tasks x ${modes.length} modes x ${models.length} models x ${runs} runs)`,
    '',
  );

  const cellRows: string[][] = [
    [
      'model',
      'mode',
      'success',
      'tool-ok',
      'turns',
      'upstream',
      'in-tok',
      'out-tok',
      'cache-read',
      'est $',
      'turn-capped',
      'harness-err',
    ],
  ];
  for (const cell of summary.cells) {
    cellRows.push([
      cell.model,
      cell.mode,
      `${cell.successes}/${cell.scored} ${pct(cell.successes, cell.scored)}`,
      `${cell.toolCorrect}/${cell.scored} ${pct(cell.toolCorrect, cell.scored)}`,
      cell.meanTurns.toFixed(1),
      cell.meanUpstreamCalls.toFixed(1),
      Math.round(cell.meanInputTokens).toString(),
      Math.round(cell.meanOutputTokens).toString(),
      pct(cell.cacheReadShare, 1),
      cell.estimatedUsd.toFixed(4),
      cell.turnCapped.toString(),
      cell.harnessErrors.toString(),
    ]);
  }
  lines.push(table(cellRows), '');

  const cellKeys = summary.cells.map((c) => `${c.model}/${c.mode}`);
  const tiersPresent = TASK_TIERS.filter((tier) => summary.tiers.some((t) => t.tier === tier));

  if (tiersPresent.length > 0) {
    const tierRows: string[][] = [['tier (success; tool-ok; forbidden)', ...cellKeys]];
    for (const tier of tiersPresent) {
      const row: string[] = [tier];
      for (const key of cellKeys) {
        const cell = summary.tiers.find((t) => t.tier === tier && `${t.model}/${t.mode}` === key);
        row.push(
          cell === undefined
            ? '-'
            : `${cell.successes}/${cell.scored} ${pct(cell.successes, cell.scored).trim()}; ` +
                `${cell.toolCorrect}/${cell.scored}; ${cell.forbidden}`,
        );
      }
      tierRows.push(row);
    }
    lines.push(table(tierRows), '');
  }

  for (const tier of tiersPresent) {
    const taskRows: string[][] = [[`${tier} task (successes/scored)`, ...cellKeys]];
    for (const name of taskNames) {
      const cells = summary.tasks.filter((t) => t.task === name && t.tier === tier);
      if (cells.length === 0) continue;
      const row = [name];
      for (const key of cellKeys) {
        const cell = cells.find((t) => `${t.model}/${t.mode}` === key);
        row.push(
          cell === undefined
            ? '-'
            : `${cell.successes}/${cell.scored}` +
                (cell.episodes > cell.scored ? ` (${cell.episodes - cell.scored} err)` : ''),
        );
      }
      taskRows.push(row);
    }
    lines.push(table(taskRows), '');
  }

  const projectionCells = summary.cells.filter((c) => c.routes !== undefined);
  if (projectionCells.length > 0) {
    lines.push('Projection routes (episodes using call_tool / execute_machine / both / neither):');
    for (const cell of projectionCells) {
      const routes = cell.routes as Record<ProjectionRoute, number>;
      lines.push(
        `  ${cell.model}: call_tool ${routes.call_tool}, execute_machine ${routes.execute_machine}, ` +
          `both ${routes.both}, neither ${routes.neither}; per episode: ` +
          `search_tools ${(cell.meanSearchTools ?? 0).toFixed(1)}, ` +
          `describe_tool ${(cell.meanDescribeTool ?? 0).toFixed(1)}, ` +
          `discover_apis ${(cell.meanDiscoverApis ?? 0).toFixed(1)}, ` +
          `approvals ${(cell.meanApprovals ?? 0).toFixed(1)}`,
      );
    }
    lines.push('');
  }

  const errors = records.filter((r) => r.harnessError !== undefined);
  if (errors.length > 0) {
    lines.push('Harness errors (excluded from success rates):');
    for (const r of errors) {
      lines.push(`  ${r.model}/${r.mode} ${r.task} run ${r.run}: ${r.harnessError ?? ''}`);
    }
    lines.push('');
  }

  lines.push(
    'Cost model: Haiku 5.5 $0.10/$0.50, Sonnet 5.5 $2/$10 per MTok; cache reads 10%, cache writes 125% of input. ' +
      'Turn-capped episodes are scored on the upstream calls made before the cap; harness errors are not scored; ' +
      'an episode that makes a call its task forbids is not a success.',
  );
  return lines.join('\n');
}

/** One line per episode, for progress output while a live run is going. */
export function formatEpisodeLine(record: EpisodeRecord): string {
  const verdict =
    record.harnessError !== undefined
      ? `ERR ${record.harnessError}`
      : record.success
        ? 'ok'
        : record.forbidden
          ? 'forbidden-call'
          : record.toolCorrect
            ? 'tool-ok/args-wrong'
            : 'miss';
  const route = record.projection !== undefined ? ` via ${record.projection.route}` : '';
  const capped = record.turnCapped ? ' (turn-capped)' : '';
  const upstream = record.upstreamCalls.map((c) => c.tool).join(',') || '-';
  return (
    `${record.model}/${record.mode} ${record.task} #${record.run}: ${verdict}${route}${capped}; ` +
    `turns ${record.apiTurns}, upstream [${upstream}], ${record.wallMs}ms`
  );
}

export interface ResultsMeta {
  models?: string[];
  modes?: EvalMode[];
  tiers?: TaskTier[];
  tasks?: string[];
  runs?: number;
}

export interface ResultsWriter {
  /** The file every `write` rewrites. */
  path: string;
  /** Rewrite the file with these records and their summary. */
  write(records: EpisodeRecord[]): void;
}

/**
 * Choose the results file up front (named by ISO timestamp, colons replaced
 * for portable filenames) so a long run can rewrite it after every episode:
 * a vitest timeout or a crash then leaves the partial results on disk
 * instead of nothing. `updatedAt` tells a reader how fresh the file is.
 */
export function createResultsWriter(dir: string, meta: ResultsMeta = {}): ResultsWriter {
  mkdirSync(dir, { recursive: true });
  const generatedAt = new Date().toISOString();
  const path = join(dir, `${generatedAt.replace(/:/g, '-')}.json`);
  return {
    path,
    write(records) {
      const present = records.filter((r) => r !== undefined);
      writeFileSync(
        path,
        JSON.stringify(
          {
            generatedAt,
            updatedAt: new Date().toISOString(),
            ...meta,
            summary: summarizeToolChoice(present),
            records: present,
          },
          null,
          2,
        ) + '\n',
      );
    },
  };
}

/** Write the records (plus their summary) once; returns the path. */
export function writeToolChoiceResults(
  records: EpisodeRecord[],
  dir: string,
  meta: ResultsMeta = {},
): string {
  const writer = createResultsWriter(dir, meta);
  writer.write(records);
  return writer.path;
}
