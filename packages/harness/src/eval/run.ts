/**
 * Tool-choice eval runner and report: for each model × mode × task × run,
 * open a fresh world for the task's tier, drive one agent episode against
 * it, score the recorded upstream calls with the task's predicate (and the
 * end state with its `verify`, before the world is torn down), and
 * aggregate.
 *
 * "Success" is tool AND arguments correct (and `verify` held); "tool-correct"
 * is the right upstream tool(s) reached with any arguments. Episodes that ended on a
 * harness error (refusal, max_tokens, API error, or an exception thrown by
 * the harness itself) are excluded from both denominators and counted
 * separately — their tokens still count toward spend. Hitting the turn
 * budget is NOT a harness error: the upstream calls made before the cap are
 * fully observable, so such episodes are scored on them and flagged
 * `turnCapped`.
 *
 * The turn budget counts action turns, not discovery: a Projection turn
 * that only called `search_tools` / `describe_tool` / `discover_apis` (and,
 * on the multi world, the per-box `search_<alias>` tools) is
 * free (direct mode has that information inline, for free), up to an
 * absolute ceiling of twice the budget so a model looping on discovery
 * still stops. Both modes get the same budget; `apiTurns` still reports
 * every call made.
 *
 * `projection-boxes` is planned for the multi tier only (`modeApplies`):
 * single-server tiers run the same episodes whatever modes are selected.
 *
 * One planned episode never takes the matrix down with it: any exception
 * (opening the session, the agent loop, closing, scoring, the progress
 * callback) becomes a harness-error record and the other workers carry on.
 *
 * Episodes run interleaved — run 0 of every task in every model × mode
 * cell, then run 1, … — so a run cut short by a timeout has the same
 * episodes in every cell; records still come back (and are reported) in
 * model → mode → task → run order.
 *
 * Each record keeps the episode's full transcript (system prompt, every
 * assistant turn's blocks, every tool result as the model saw it) and the
 * model the API reported serving, for reading what happened without
 * re-running it. On the multi world it also records the box routing
 * ({@link BoxRouting}): which boxes the task needs, whether the global
 * search was used, whether the first upstream call went to a needed box,
 * and how many calls went elsewhere (detours — counted, never failed).
 *
 * With `batch` set (PROJ_EVAL_BATCH=1) the model calls go through the
 * Message Batches API instead, every live episode in lockstep (see
 * `batch.ts`): same requests, same records (plus `batch: true`), half the
 * price. `concurrency` is then replaced by the batch `width`.
 */

import { createHash } from 'node:crypto';
import type { ApprovalPrompts } from '@astral-mcp/projection';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SideEffect } from '../types.js';
import {
  agentTools,
  anthropicCaller,
  type Transcript,
  resolveModelPresets,
  runAgentEpisode,
  type AgentEpisode,
  type AgentRuntime,
  type EpisodeUsage,
  type ModelCaller,
  type ModelPreset,
  type PrefixCounter,
  type PrefixSource,
  type PtcCallers,
  type ServerToolUse,
  type ToolSearchVariant,
  type ToolUseRecord,
  type TurnUsage,
} from './agent.js';
import {
  EVAL_MODES,
  isProjectionMode,
  modeApplies,
  modeSupportsModel,
  openSession,
  type EvalMode,
  type ModeSession,
} from './modes.js';
import { LockstepBatcher, type BatchTick, type BatchesClient } from './batch.js';
import { estimateUsd, serverToolUsd, standardCost } from './cost.js';
import {
  episodeApprover,
  hitlMetrics,
  toolNameIndex,
  type ApproverPersona,
  type ElicitationRecord,
  type HitlEpisode,
} from './hitl.js';
import { boxOf, taskBoxes } from './multi-tasks.js';
import {
  DEFAULT_TIERS,
  promptFor,
  TASK_TIERS,
  TOOL_CHOICE_TASKS,
  worldOf,
  worldOptionsOf,
  type EvalTask,
  type TaskKind,
  type TaskTier,
} from './tasks.js';
import {
  isBoxedWorldName,
  openWorld,
  type BoxAlias,
  type EvalWorld,
  type WorldName,
} from './world.js';

export type ProjectionRoute = 'call_tool' | 'execute_machine' | 'both' | 'neither';

/** How an episode used Projection's surface (projection mode only). */
export interface ProjectionUse {
  route: ProjectionRoute;
  searchTools: number;
  describeTool: number;
  discoverApis: number;
  /**
   * Multi world only: calls to each box's own search tool, by alias
   * (`search_github` → `github`). `searchTools` counts the global search.
   */
  searchBoxes?: Record<string, number>;
  /** Calls to directly listed (mediated) tools, `projections.direct` modes only. */
  directCalls?: number;
  /** Approval prompts answered (one per elicitation; a batched one counts once). */
  approvals: number;
  /** MRTR retries sent: approval round trips, each carrying one or more approvals. */
  roundTrips?: number;
}

/** How a multi-world episode moved between boxes. */
export interface BoxRouting {
  /** The boxes the task needs: the aliases its steps name. */
  needed: BoxAlias[];
  /** A Projection mode called the global `search_tools` at least once (always false for direct). */
  usedGlobalSearch: boolean;
  /** The first upstream call went into a needed box (false when none was made). */
  firstCallRightBox: boolean;
  /** Upstream calls into a box the task does not need: detours, counted but not failed. */
  wrongBoxCalls: number;
}

/** The box routing of an episode of `task` (multi-world tiers only; undefined elsewhere). */
export function boxRouting(
  task: Pick<EvalTask, 'tier' | 'steps'>,
  upstreamCalls: readonly SideEffect[],
  toolUses: readonly ToolUseRecord[],
): BoxRouting | undefined {
  if (!isBoxedWorldName(worldOf(task.tier))) return undefined;
  const needed = taskBoxes(task);
  const isNeeded = (call: SideEffect): boolean => {
    const alias = boxOf(call.tool);
    return alias !== undefined && needed.includes(alias);
  };
  const first = upstreamCalls[0];
  return {
    needed,
    usedGlobalSearch: toolUses.some((use) => use.name === 'search_tools'),
    firstCallRightBox: first !== undefined && isNeeded(first),
    wrongBoxCalls: upstreamCalls.filter((call) => !isNeeded(call)).length,
  };
}

export interface EpisodeRecord {
  /** Preset name (e.g. haiku-low). */
  model: string;
  /** The model id requested. */
  modelId: string;
  /** The model id the API reported serving (absent when no call completed). */
  servedModel?: string;
  mode: EvalMode;
  task: string;
  tier: TaskTier;
  /** The world the tier runs in. */
  world: WorldName;
  kind: TaskKind;
  /** Zero-based run index. */
  run: number;
  /** The task's `expect` (and `verify`, if any) held and no forbidden call was made. */
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
  /** Turns that consumed the budget (every turn in direct mode; non-discovery turns in projection). */
  budgetTurns: number;
  toolUseCount: number;
  /** What the model emitted (in projection mode, Projection's tools). */
  toolUses: ToolUseRecord[];
  /** What reached the fake. */
  upstreamCalls: SideEffect[];
  projection?: ProjectionUse;
  /** Multi tier only: how the episode moved between boxes. */
  boxes?: BoxRouting;
  /** Native modes: the Anthropic server tools the episode used. */
  serverTools?: ServerToolUse;
  /**
   * Native modes: server tool fees at list price ({@link serverToolUsd}),
   * included in `estimatedUsd` and `standardUsd`. Absent when zero.
   */
  serverToolUsd?: number;
  /**
   * Every approval prompt and its answer (Projection's elicitations, or
   * direct mode's simulated host gate); absent when there were none.
   */
  elicitations?: ElicitationRecord[];
  /**
   * HITL metrics (hitl.ts): present when the episode ran with an approver
   * (a `hitl` task, or PROJ_EVAL_APPROVER) or showed any prompt.
   */
  hitl?: HitlEpisode;
  /** Totals over every turn. */
  usage: EpisodeUsage;
  /**
   * Per Messages API call: usage and the static prefix size. Absent in
   * results files from before it was recorded.
   */
  turns?: TurnUsage[];
  /** How `turns[].prefixTokens` was obtained (absent when no call completed). */
  prefixSource?: PrefixSource;
  /**
   * The episode's wall clock. On a batch episode (`batch`) it spans its
   * lockstep ticks, batch queueing and polling included, so it is not
   * comparable with an interactive episode's.
   */
  wallMs: number;
  stopReason?: string;
  finalText: string;
  /** The conversation as the model saw it (absent when the episode never started). */
  transcript?: Transcript;
  /** Present when the model calls went through the Message Batches API (billed at 50%). */
  batch?: true;
  /**
   * The eval's actual spend on this episode, batch discount included
   * (`estimateUsd`). Absent in results files from before it was recorded.
   */
  estimatedUsd?: number;
  /**
   * The standard host cost (`standardCost`): warm static prefix, conversation
   * cached incrementally, no batch discount. Comparable across modes and
   * runs. Absent when not measured (no per-turn usage).
   */
  standardUsd?: number;
  /**
   * Present (with `harnessError`) when the batch runner gave up on a turn
   * after its retries: an infrastructure failure, not the model's.
   */
  infraFailure?: true;
  /**
   * Present when the episode ran out of context window (a prompt-too-long
   * 400, or the `model_context_window_exceeded` stop reason), on either
   * path. Scored, and never a success: no `harnessError`.
   */
  contextOverflow?: true;
}

export interface ToolChoiceEvalOptions {
  /** Default: both built-in presets. */
  models?: ModelPreset[];
  /** Default: every mode (`projection-boxes` runs on the multi tier only). */
  modes?: EvalMode[];
  /** Default: every task of the default tiers (not the opt-in `multi-hard`). */
  tasks?: EvalTask[];
  /** Episodes per model × mode × task. Default 3. */
  runs?: number;
  /** Default: the live Anthropic API. Tests inject a script. */
  caller?: ModelCaller;
  /**
   * Turn budget per episode (turns that are not pure discovery). Default
   * 12. A task's own `maxTurns` overrides it (and its ceiling) for that
   * task's episodes.
   */
  maxTurns?: number;
  /** Absolute ceiling on Messages API calls per episode. Default: twice `maxTurns`. */
  maxTotalTurns?: number;
  /** Episodes in flight at once. Default 1. */
  concurrency?: number;
  /**
   * Whether the GitHub fake advertises the real server's `instructions`
   * (both modes see them). Default true.
   */
  serverInstructions?: boolean;
  /**
   * Multi world, Projection modes: pass the host's box descriptions to
   * `wrapMcpServers` (PROJ_EVAL_BOX_DESCRIPTIONS=1). Default false.
   */
  boxDescriptions?: boolean;
  /**
   * Projection modes: a line appended to the system prompt
   * (PROJ_EVAL_FORCE_CODE_MODE=1). Default none.
   */
  systemSuffix?: string;
  /**
   * Called as each episode finishes (in completion order) with its record
   * and its index in the returned, plan-ordered array.
   */
  onEpisode?: (record: EpisodeRecord, index: number) => void;
  /**
   * Run the model calls through the Message Batches API, in lockstep
   * (PROJ_EVAL_BATCH=1). `caller` and `concurrency` are then ignored.
   */
  batch?: BatchEvalOptions;
  /**
   * Counts each episode's static prefix (tools + system), once per distinct
   * prefix per run (the live test: `anthropicPrefixCounter`). Absent,
   * or when a count fails: estimated from turn 1 (`prefixSource: 'estimate'`).
   */
  countPrefix?: PrefixCounter;
  /**
   * The approver persona for every episode (PROJ_EVAL_APPROVER), over each
   * task's own. Absent: each task's own (`hitl` tasks), else approve-all.
   */
  approver?: ApproverPersona;
  /** Projection modes: `WrapOptions.approvalPrompts` (PROJ_EVAL_APPROVAL_PROMPTS). */
  approvalPrompts?: ApprovalPrompts;
  /** `native-search`: the tool search variant (PROJ_EVAL_TOOL_SEARCH). Default `bm25`. */
  toolSearch?: ToolSearchVariant;
  /** `native-ptc`: each tool's `allowed_callers` (PROJ_EVAL_PTC_CALLERS). Default `code`. */
  ptcCallers?: PtcCallers;
}

export interface BatchEvalOptions {
  /** `new Anthropic().messages.batches`, or a fake. */
  client: BatchesClient;
  /**
   * Episodes live (world open, in the lockstep) at once; a finished one's
   * slot goes to the next planned episode, which joins the next tick.
   * Default: every planned episode.
   */
  width?: number;
  /** First poll delay (default 10 s); doubles up to `pollMaxMs` (default 60 s). */
  pollInitialMs?: number;
  pollMaxMs?: number;
  /** Batch submissions per request before the episode is an infra failure. Default 3. */
  maxAttempts?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Called after every tick. */
  onTick?: (tick: BatchTick) => void;
}

export const DEFAULT_RUNS = 3;

const PROJECTION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'execute_machine',
  'discover_apis',
  'search_tools',
  'describe_tool',
  'call_tool',
]);

/**
 * How an episode used Projection. `world` names the boxes whose
 * `search_<alias>` calls are counted (multi world only).
 */
function summarizeProjectionUse(
  toolUses: ToolUseRecord[],
  approvals: number,
  world: EvalWorld,
  roundTrips?: number,
): ProjectionUse {
  const count = (name: string): number => toolUses.filter((t) => t.name === name).length;
  // Direct listing: any tool that is not one of Projection's own is a
  // mediated call_tool alias, and routes like call_tool.
  const own = new Set([
    ...PROJECTION_TOOL_NAMES,
    ...('boxes' in world ? world.boxes.map((box) => `search_${box.alias}`) : []),
  ]);
  const directCalls = toolUses.filter((t) => !own.has(t.name)).length;
  const callTool = count('call_tool') > 0 || directCalls > 0;
  const machine = count('execute_machine') > 0;
  const route: ProjectionRoute =
    callTool && machine ? 'both' : callTool ? 'call_tool' : machine ? 'execute_machine' : 'neither';
  return {
    route,
    searchTools: count('search_tools'),
    describeTool: count('describe_tool'),
    discoverApis: count('discover_apis'),
    ...('boxes' in world
      ? {
          searchBoxes: Object.fromEntries(
            world.boxes.map((box) => [box.alias, count(`search_${box.alias}`)]),
          ),
        }
      : {}),
    ...(directCalls > 0 ? { directCalls } : {}),
    approvals,
    ...(roundTrips !== undefined ? { roundTrips } : {}),
  };
}

interface PlannedEpisode {
  model: ModelPreset;
  mode: EvalMode;
  task: EvalTask;
  run: number;
}

/** A planned episode, its index in model → mode → task → run order, and its sort keys. */
interface Slot extends PlannedEpisode {
  index: number;
  modelAt: number;
  modeAt: number;
  taskAt: number;
}

/** A run's prefix counts, keyed by model, system and tools; `undefined` when a count failed. */
type PrefixCounts = Map<string, Promise<number | undefined>>;

/** The episode's static prefix, counted once per distinct prefix per run (undefined: not counted). */
function countedPrefix(
  counter: PrefixCounter | undefined,
  counts: PrefixCounts,
  model: ModelPreset,
  runtime: AgentRuntime,
): Promise<number | undefined> {
  if (counter === undefined) return Promise.resolve(undefined);
  const tools = agentTools(runtime);
  const key = createHash('sha256')
    .update(JSON.stringify([model.model, runtime.system, tools]))
    .digest('hex');
  let counted = counts.get(key);
  if (counted === undefined) {
    counted = counter(model.model, runtime.system, tools).catch(() => undefined);
    counts.set(key, counted);
  }
  return counted;
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
 * Score a finished episode against the task. Runs the task's `verify` (if
 * any) against the still-open world; a throwing predicate or verify is the
 * caller's problem (it surfaces as a harness error there).
 */
async function scoreEpisode(
  planned: PlannedEpisode,
  world: EvalWorld,
  session: Pick<ModeSession, 'approvals' | 'roundTrips' | 'elicitations' | 'approver'>,
  episode: AgentEpisode,
  withApprover: boolean,
): Promise<EpisodeRecord> {
  const { model, mode, task, run } = planned;
  const { approvals, roundTrips } = session;
  const elicitations = session.elicitations.slice();
  const upstreamCalls = world.calls.slice();
  const scored = episode.harnessError === undefined;
  const overflowed = episode.contextOverflow === true;
  const forbid = task.forbid;
  const forbidden = forbid !== undefined && upstreamCalls.some((call) => forbid(call));
  // An episode that ran out of context window is a scored failure.
  const expected = scored && !overflowed && !forbidden && task.expect(upstreamCalls);
  const success =
    expected && task.verify !== undefined
      ? await task.verify({
          calls: upstreamCalls,
          finalText: episode.finalText,
          facts: world.facts,
          elicitations,
        })
      : expected;
  const boxes = boxRouting(task, upstreamCalls, episode.toolUses);
  const hitl =
    withApprover || elicitations.length > 0 || task.hitl !== undefined
      ? hitlMetrics({
          approver: session.approver,
          records: elicitations,
          calls: upstreamCalls,
          index: toolNameIndex(world),
          ...(task.hitl !== undefined ? { checks: task.hitl } : {}),
          context: { calls: upstreamCalls, finalText: episode.finalText, facts: world.facts },
        })
      : undefined;
  return {
    model: model.name,
    modelId: model.model,
    ...(episode.servedModel !== undefined ? { servedModel: episode.servedModel } : {}),
    mode,
    task: task.name,
    tier: task.tier,
    world: worldOf(task.tier),
    kind: task.kind,
    run,
    success,
    toolCorrect:
      scored &&
      task.steps.every((group) => upstreamCalls.some((call) => group.includes(call.tool))),
    forbidden,
    turnCapped: episode.turnCapped,
    ...(episode.harnessError !== undefined ? { harnessError: episode.harnessError } : {}),
    apiTurns: episode.apiTurns,
    budgetTurns: episode.budgetTurns,
    toolUseCount: episode.toolUses.length,
    toolUses: episode.toolUses,
    upstreamCalls,
    ...(isProjectionMode(mode)
      ? { projection: summarizeProjectionUse(episode.toolUses, approvals, world, roundTrips) }
      : {}),
    ...(boxes !== undefined ? { boxes } : {}),
    ...(episode.serverTools !== undefined ? { serverTools: episode.serverTools } : {}),
    ...(elicitations.length > 0 ? { elicitations } : {}),
    ...(hitl !== undefined ? { hitl } : {}),
    usage: episode.usage,
    turns: episode.turns,
    ...(episode.prefixSource !== undefined ? { prefixSource: episode.prefixSource } : {}),
    wallMs: episode.wallMs,
    ...(episode.stopReason !== undefined ? { stopReason: episode.stopReason } : {}),
    finalText: episode.finalText,
    transcript: episode.transcript,
    ...(episode.infraFailure === true ? { infraFailure: true as const } : {}),
    ...(overflowed ? { contextOverflow: true as const } : {}),
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
  world: EvalWorld | undefined,
  session: ModeSession | undefined,
  episode: AgentEpisode | undefined,
  startedAt: number,
): EpisodeRecord {
  const { model, mode, task, run } = planned;
  const upstreamCalls = world?.calls.slice() ?? [];
  const toolUses = episode?.toolUses ?? [];
  const boxes = boxRouting(task, upstreamCalls, toolUses);
  return {
    model: model.name,
    modelId: model.model,
    ...(episode?.servedModel !== undefined ? { servedModel: episode.servedModel } : {}),
    mode,
    task: task.name,
    tier: task.tier,
    world: worldOf(task.tier),
    kind: task.kind,
    run,
    success: false,
    toolCorrect: false,
    forbidden: false,
    turnCapped: episode?.turnCapped ?? false,
    harnessError: `harness: ${errorMessage(err)}`,
    apiTurns: episode?.apiTurns ?? 0,
    budgetTurns: episode?.budgetTurns ?? 0,
    toolUseCount: toolUses.length,
    toolUses,
    upstreamCalls,
    ...(isProjectionMode(mode) && session !== undefined
      ? {
          projection: summarizeProjectionUse(
            toolUses,
            session.approvals,
            session.world,
            session.roundTrips,
          ),
        }
      : {}),
    ...(boxes !== undefined ? { boxes } : {}),
    ...(episode?.serverTools !== undefined ? { serverTools: episode.serverTools } : {}),
    ...(session !== undefined && session.elicitations.length > 0
      ? { elicitations: session.elicitations.slice() }
      : {}),
    usage: episode?.usage ?? { ...EMPTY_USAGE },
    turns: episode?.turns ?? [],
    ...(episode?.prefixSource !== undefined ? { prefixSource: episode.prefixSource } : {}),
    wallMs: episode?.wallMs ?? Math.round(performance.now() - startedAt),
    ...(episode?.stopReason !== undefined ? { stopReason: episode.stopReason } : {}),
    finalText: episode?.finalText ?? '',
    ...(episode !== undefined ? { transcript: episode.transcript } : {}),
  };
}

/**
 * An episode's turn budget: the task's own (`maxTurns`, ceiling twice
 * that) when it sets one, else the run's options.
 */
export function turnBudget(
  task: Pick<EvalTask, 'maxTurns'>,
  options: Pick<ToolChoiceEvalOptions, 'maxTurns' | 'maxTotalTurns'>,
): { maxTurns?: number; maxTotalTurns?: number } {
  if (task.maxTurns !== undefined) {
    return { maxTurns: task.maxTurns, maxTotalTurns: 2 * task.maxTurns };
  }
  return {
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.maxTotalTurns !== undefined ? { maxTotalTurns: options.maxTotalTurns } : {}),
  };
}

/**
 * Run one planned episode; never throws — failures become records.
 * `afterAgent` runs as soon as the agent loop is over (before the session
 * and world close and the episode is scored), however the loop ended.
 */
async function runPlanned(
  planned: PlannedEpisode,
  caller: ModelCaller,
  options: ToolChoiceEvalOptions,
  prefixCounts: PrefixCounts,
  afterAgent?: () => void,
): Promise<EpisodeRecord> {
  const { model, mode, task } = planned;
  const startedAt = performance.now();
  let world: EvalWorld | undefined;
  let session: ModeSession | undefined;
  let episode: AgentEpisode | undefined;
  try {
    world = await openWorld(worldOf(task.tier), {
      ...(options.serverInstructions === false ? { instructions: false } : {}),
      ...worldOptionsOf(task.tier),
    });
    try {
      // An approver only when the task or the run asks for one: every other
      // episode runs exactly as before (approve-all, direct ungated).
      const withApprover = task.approver !== undefined || options.approver !== undefined;
      session = await openSession(mode, world, {
        ...(options.boxDescriptions === true ? { boxDescriptions: true } : {}),
        ...(options.systemSuffix !== undefined ? { systemSuffix: options.systemSuffix } : {}),
        ...(withApprover ? { approver: episodeApprover(task, options.approver) } : {}),
        ...(options.approvalPrompts !== undefined
          ? { approvalPrompts: options.approvalPrompts }
          : {}),
        ...(options.toolSearch !== undefined ? { toolSearch: options.toolSearch } : {}),
        ...(options.ptcCallers !== undefined ? { ptcCallers: options.ptcCallers } : {}),
      });
      try {
        const prefixTokens = await countedPrefix(
          options.countPrefix,
          prefixCounts,
          model,
          session.runtime,
        );
        episode = await runAgentEpisode(
          caller,
          model,
          session.runtime,
          promptFor(task, world.facts),
          {
            ...turnBudget(task, options),
            budgetFreeTools: session.budgetFreeTools,
            ...(prefixTokens !== undefined ? { prefixTokens } : {}),
          },
        );
      } finally {
        afterAgent?.();
        // A close that fails must not discard an episode that ran, nor mask
        // the error that is already propagating.
        await session.close().catch(() => {});
      }
      // Score while the world is still up: `verify` reads its end state.
      return await scoreEpisode(
        planned,
        world,
        session,
        episode,
        task.approver !== undefined || options.approver !== undefined,
      );
    } finally {
      await world.close().catch(() => {});
    }
  } catch (err) {
    return harnessFailureRecord(planned, err, world, session, episode, startedAt);
  }
}

/**
 * Run the matrix; records come back in model → mode → task → run order, one
 * per planned episode. Episodes RUN interleaved (run 0 of every task in
 * every cell first, then run 1, …), so a run cut short has an even sample
 * in every cell. `onEpisode` is best-effort progress reporting: an
 * exception thrown from it is swallowed so one bad callback cannot cost the
 * rest of the run.
 */
export async function runToolChoiceEval(
  options: ToolChoiceEvalOptions = {},
): Promise<EpisodeRecord[]> {
  const models = options.models ?? resolveModelPresets(undefined);
  const modes = options.modes ?? [...EVAL_MODES];
  const tasks = options.tasks ?? TOOL_CHOICE_TASKS.filter((t) => DEFAULT_TIERS.includes(t.tier));
  const runs = options.runs ?? DEFAULT_RUNS;
  const batch = options.batch;
  if (batch !== undefined && modes.includes('native-ptc')) {
    // A paused programmatic call times out in ~4 minutes and an idle
    // container is reclaimed in ~5 (the PTC docs): a batch tick is longer.
    throw new Error('native-ptc cannot run through the Message Batches API (PROJ_EVAL_BATCH=1)');
  }
  const caller = batch === undefined ? (options.caller ?? anthropicCaller()) : undefined;

  // Slots in result order (model → mode → task → run) ...
  const slots: Slot[] = [];
  models.forEach((model, modelAt) => {
    modes.forEach((mode, modeAt) => {
      tasks.forEach((task, taskAt) => {
        if (!modeApplies(mode, worldOf(task.tier))) return;
        if (!modeSupportsModel(mode, model.model)) return;
        for (let run = 0; run < runs; run += 1) {
          slots.push({ model, mode, task, run, index: slots.length, modelAt, modeAt, taskAt });
        }
      });
    });
  });
  // ... run in run → task → model → mode order.
  const order = slots.toSorted(
    (a, b) => a.run - b.run || a.taskAt - b.taskAt || a.modelAt - b.modelAt || a.modeAt - b.modeAt,
  );

  // Batch mode: the lockstep width (default: every episode) replaces `concurrency`.
  const width = batch === undefined ? (options.concurrency ?? 1) : (batch.width ?? order.length);
  const concurrency = Math.max(1, Math.floor(width));
  const batcher =
    batch === undefined
      ? undefined
      : new LockstepBatcher({
          client: batch.client,
          ...(batch.pollInitialMs !== undefined ? { pollInitialMs: batch.pollInitialMs } : {}),
          ...(batch.pollMaxMs !== undefined ? { pollMaxMs: batch.pollMaxMs } : {}),
          ...(batch.maxAttempts !== undefined ? { maxAttempts: batch.maxAttempts } : {}),
          ...(batch.sleep !== undefined ? { sleep: batch.sleep } : {}),
          ...(batch.onTick !== undefined ? { onTick: batch.onTick } : {}),
        });

  const prefixCounts: PrefixCounts = new Map();
  const records: EpisodeRecord[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const slot = order[next];
      next += 1;
      if (slot === undefined) return;
      let record: EpisodeRecord;
      if (batcher === undefined) {
        record = await runPlanned(slot, caller as ModelCaller, options, prefixCounts);
      } else {
        // Enter the lockstep before the world opens, so no tick runs without
        // this episode's first request; leave it however the episode ends
        // (`done` is idempotent).
        const lane = batcher.register(`ep${String(slot.index).padStart(4, '0')}`);
        try {
          // Leave as soon as the loop is over: closing the world and scoring
          // must not hold up everyone else's next tick.
          record = {
            ...(await runPlanned(slot, lane.caller, options, prefixCounts, lane.done)),
            batch: true,
          };
        } finally {
          lane.done();
        }
      }
      record = withCosts(record);
      records[slot.index] = record;
      try {
        options.onEpisode?.(record, slot.index);
      } catch {
        // Progress reporting must not take the matrix down.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, order.length) }, worker));
  return records;
}

// ---------------------------------------------------------------------------
// Summary and report

/** The eval's actual spend on a record: list price, halved for a batch episode. */
function recordEstimatedUsd(record: EpisodeRecord): number {
  return (
    estimateUsd(record.modelId, record.usage, record.batch === true, record.turns) +
    serverToolUsd(record.serverTools)
  );
}

/**
 * The record's standard host cost ({@link standardCost}); undefined when it
 * made calls but has no per-turn usage (a results file from before it was
 * recorded): not measured, never $0.
 */
function recordStandardUsd(record: EpisodeRecord): number | undefined {
  if (record.turns === undefined) return record.apiTurns === 0 ? 0 : undefined;
  return standardCost(record.turns, record.modelId) + serverToolUsd(record.serverTools);
}

/** The sum, or undefined when any term is not measured. */
function sumMeasured(values: (number | undefined)[]): number | undefined {
  let total = 0;
  for (const value of values) {
    if (value === undefined) return undefined;
    total += value;
  }
  return total;
}

/** The record with its actual spend and standard host cost attached. */
function withCosts(record: EpisodeRecord): EpisodeRecord {
  const standard = recordStandardUsd(record);
  const fees = serverToolUsd(record.serverTools);
  return {
    ...record,
    ...(fees > 0 ? { serverToolUsd: fees } : {}),
    estimatedUsd: recordEstimatedUsd(record),
    ...(standard !== undefined ? { standardUsd: standard } : {}),
  };
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
  /** Scored episodes that ran out of context window (all failures). */
  contextOverflows: number;
  meanTurns: number;
  /** Mean turns that consumed the budget. */
  meanBudgetTurns: number;
  meanUpstreamCalls: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  /** cache-read / (uncached + cache-read + cache-write) input tokens. */
  cacheReadShare: number;
  /** Actual eval spend, batch discount included. */
  estimatedUsd: number;
  /** Standard host cost (`standardCost`); absent when any episode's was not measured. */
  standardUsd?: number;
  /** Projection mode only. */
  routes?: Record<ProjectionRoute, number>;
  meanSearchTools?: number;
  meanDescribeTool?: number;
  meanDiscoverApis?: number;
  /** Mean `search_<alias>` calls per multi-world episode, by alias (absent without one). */
  meanSearchBoxes?: Record<string, number>;
  meanApprovals?: number;
  /** Over the cell's episodes that carry HITL metrics; absent when none does. */
  hitl?: HitlSummary;
}

/** HITL metrics over a cell's episodes (those with an approver or a prompt). */
export interface HitlSummary {
  /** Scored episodes with HITL metrics. */
  episodes: number;
  /** Mean approval prompts per episode (per task run). */
  meanPrompts: number;
  /** Prompts / gated calls presented (1.0 unbatched; below 1 when prompts carry several calls). */
  promptsPerCall: number;
  /**
   * Prompts / the tasks' ideal gated writes, over episodes whose task names
   * that number (absent when none does): above 1 means extra asks (retries,
   * failed attempts, gated reads).
   */
  promptsPerGatedWrite?: number;
  /** Prompts checkable for clarity, and of those the clear ones. */
  clarityChecked: number;
  clarityOk: number;
  /** Episodes with a refused call, and how they handled it. */
  refusedEpisodes: number;
  handled: number;
  noRepeat: number;
  /** Episodes where a later call reached a refused call's effect another way. */
  workaround: number;
  /** Episodes whose final answer said what was not done (of those with the check). */
  reported: number;
  reportChecked: number;
  /** Episodes that still did the independent parts (of those with the check). */
  independentDone: number;
  independentChecked: number;
}

export function summarizeHitl(records: readonly EpisodeRecord[]): HitlSummary | undefined {
  const withHitl = records.filter((r) => r.harnessError === undefined && r.hitl !== undefined);
  if (withHitl.length === 0) return undefined;
  const h = (r: EpisodeRecord): HitlEpisode => r.hitl as HitlEpisode;
  const prompts = withHitl.reduce((a, r) => a + h(r).prompts, 0);
  const items = withHitl.reduce((a, r) => a + h(r).items, 0);
  const sized = withHitl.filter((r) => h(r).gatedWrites !== undefined);
  const ideal = sized.reduce((a, r) => a + (h(r).gatedWrites ?? 0), 0);
  const denials = withHitl.flatMap((r) => (h(r).denial !== undefined ? [h(r).denial] : []));
  const d = denials as NonNullable<HitlEpisode['denial']>[];
  return {
    episodes: withHitl.length,
    meanPrompts: mean(withHitl.map((r) => h(r).prompts)),
    promptsPerCall: items === 0 ? 0 : prompts / items,
    ...(ideal > 0
      ? { promptsPerGatedWrite: sized.reduce((a, r) => a + h(r).prompts, 0) / ideal }
      : {}),
    clarityChecked: withHitl.reduce((a, r) => a + h(r).clarityChecked, 0),
    clarityOk: withHitl.reduce((a, r) => a + h(r).clarityOk, 0),
    refusedEpisodes: d.length,
    handled: d.filter((x) => x.handled).length,
    noRepeat: d.filter((x) => x.noRepeat).length,
    workaround: d.filter((x) => x.workaround === true).length,
    reported: d.filter((x) => x.reported === true).length,
    reportChecked: d.filter((x) => x.reported !== null).length,
    independentDone: d.filter((x) => x.independentDone === true).length,
    independentChecked: d.filter((x) => x.independentDone !== null).length,
  };
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
  /** Scored episodes that ran out of context window (all failures). */
  contextOverflows: number;
}

/** Multi tier: how a cell's episodes moved between boxes ({@link BoxRouting}). */
export interface RoutingSummary {
  /** Scored episodes with a routing record. */
  scored: number;
  /** Scored episodes that called the global `search_tools`. */
  usedGlobalSearch: number;
  /** Of those, the successes. */
  successWithGlobalSearch: number;
  /** Scored episodes whose first upstream call went to a needed box. */
  firstCallRightBox: number;
  /** Scored episodes with at least one call into a box the task does not need. */
  withDetour: number;
  /** Mean calls into boxes the task does not need, per scored episode. */
  meanWrongBoxCalls: number;
}

/**
 * One tier in one cell: the success rate on that tier's tasks, and the
 * turns, tokens, cost and discovery of those episodes alone, so a tier
 * comparison never mixes tiers.
 */
export interface TierCellSummary {
  tier: TaskTier;
  model: string;
  mode: EvalMode;
  tasks: number;
  successes: number;
  toolCorrect: number;
  /** Scored episodes that made a forbidden call. */
  forbidden: number;
  /** Scored episodes that ran out of context window (all failures). */
  contextOverflows: number;
  scored: number;
  episodes: number;
  /** Mean Messages API calls per episode. */
  meanTurns: number;
  /** Mean turns that consumed the budget (counted). */
  meanBudgetTurns: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  /** Actual eval spend, batch discount included. */
  estimatedUsd: number;
  /** Standard host cost; absent when any episode's was not measured. */
  standardUsd?: number;
  /** Projection modes only: mean discovery calls per episode. */
  meanSearchTools?: number;
  meanSearchBoxes?: Record<string, number>;
  meanDescribeTool?: number;
  meanDiscoverApis?: number;
  /** Multi tier only. */
  routing?: RoutingSummary;
}

export interface ToolChoiceSummary {
  episodes: number;
  /** Actual eval spend over every episode, batch discount included. */
  estimatedUsd: number;
  /** Standard host cost over every episode; absent when any was not measured. */
  standardUsd?: number;
  cells: CellSummary[];
  /** Per tier × cell, in tier order (TASK_TIERS). */
  tiers: TierCellSummary[];
  tasks: TaskCellSummary[];
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function cellKey(record: { model: string; mode: EvalMode }): string {
  return `${record.model}/${record.mode}`;
}

/** Turn, token and cost means over `records` (harness errors included: their spend counts). */
function spendOf(records: EpisodeRecord[]): {
  meanTurns: number;
  meanBudgetTurns: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  estimatedUsd: number;
  standardUsd?: number;
} {
  const standard = sumMeasured(records.map(recordStandardUsd));
  return {
    meanTurns: mean(records.map((r) => r.apiTurns)),
    meanBudgetTurns: mean(records.map((r) => r.budgetTurns)),
    meanInputTokens: mean(
      records.map(
        (r) =>
          r.usage.inputTokens + r.usage.cacheReadInputTokens + r.usage.cacheCreationInputTokens,
      ),
    ),
    meanOutputTokens: mean(records.map((r) => r.usage.outputTokens)),
    estimatedUsd: records.reduce((a, r) => a + recordEstimatedUsd(r), 0),
    ...(standard !== undefined ? { standardUsd: standard } : {}),
  };
}

/** Projection discovery means over `records`' Projection use (empty object when none has one). */
function discoveryOf(records: EpisodeRecord[]): {
  meanSearchTools?: number;
  meanSearchBoxes?: Record<string, number>;
  meanDescribeTool?: number;
  meanDiscoverApis?: number;
} {
  const uses = records.flatMap((r) => (r.projection !== undefined ? [r.projection] : []));
  if (uses.length === 0) return {};
  // Over the multi-world episodes only: a single-server episode has no boxes.
  const boxed = uses.flatMap((u) => (u.searchBoxes !== undefined ? [u.searchBoxes] : []));
  const aliases = [...new Set(boxed.flatMap((b) => Object.keys(b)))].toSorted();
  return {
    meanSearchTools: mean(uses.map((u) => u.searchTools)),
    ...(aliases.length > 0
      ? {
          meanSearchBoxes: Object.fromEntries(
            aliases.map((alias) => [alias, mean(boxed.map((b) => b[alias] ?? 0))]),
          ),
        }
      : {}),
    meanDescribeTool: mean(uses.map((u) => u.describeTool)),
    meanDiscoverApis: mean(uses.map((u) => u.discoverApis)),
  };
}

/** Box routing over the scored records that carry one (undefined when none does). */
function routingOf(records: EpisodeRecord[]): RoutingSummary | undefined {
  const routed = records.filter((r) => r.harnessError === undefined && r.boxes !== undefined);
  if (routed.length === 0) return undefined;
  const boxes = (r: EpisodeRecord): BoxRouting => r.boxes as BoxRouting;
  const global = routed.filter((r) => boxes(r).usedGlobalSearch);
  return {
    scored: routed.length,
    usedGlobalSearch: global.length,
    successWithGlobalSearch: global.filter((r) => r.success).length,
    firstCallRightBox: routed.filter((r) => boxes(r).firstCallRightBox).length,
    withDetour: routed.filter((r) => boxes(r).wrongBoxCalls > 0).length,
    meanWrongBoxCalls: mean(routed.map((r) => boxes(r).wrongBoxCalls)),
  };
}

function summarizeCell(records: EpisodeRecord[]): CellSummary {
  const first = records[0];
  if (first === undefined) throw new Error('summarizeCell: no records');
  const scored = records.filter((r) => r.harnessError === undefined);
  const uncached = records.reduce((a, r) => a + r.usage.inputTokens, 0);
  const cacheRead = records.reduce((a, r) => a + r.usage.cacheReadInputTokens, 0);
  const cacheWrite = records.reduce((a, r) => a + r.usage.cacheCreationInputTokens, 0);
  const totalInput = uncached + cacheRead + cacheWrite;
  const spend = spendOf(records);
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
    contextOverflows: scored.filter((r) => r.contextOverflow === true).length,
    meanTurns: spend.meanTurns,
    meanBudgetTurns: spend.meanBudgetTurns,
    meanUpstreamCalls: mean(records.map((r) => r.upstreamCalls.length)),
    meanInputTokens: spend.meanInputTokens,
    meanOutputTokens: spend.meanOutputTokens,
    cacheReadShare: totalInput === 0 ? 0 : cacheRead / totalInput,
    estimatedUsd: spend.estimatedUsd,
    ...(spend.standardUsd !== undefined ? { standardUsd: spend.standardUsd } : {}),
  };
  if (isProjectionMode(first.mode)) {
    const uses = records.flatMap((r) => (r.projection !== undefined ? [r.projection] : []));
    const routes: Record<ProjectionRoute, number> = {
      call_tool: 0,
      execute_machine: 0,
      both: 0,
      neither: 0,
    };
    for (const use of uses) routes[use.route] += 1;
    summary.routes = routes;
    const discovery = discoveryOf(records);
    summary.meanSearchTools = discovery.meanSearchTools ?? 0;
    summary.meanDescribeTool = discovery.meanDescribeTool ?? 0;
    summary.meanDiscoverApis = discovery.meanDiscoverApis ?? 0;
    if (discovery.meanSearchBoxes !== undefined) {
      summary.meanSearchBoxes = discovery.meanSearchBoxes;
    }
    summary.meanApprovals = mean(uses.map((u) => u.approvals));
  }
  const hitl = summarizeHitl(records);
  if (hitl !== undefined) summary.hitl = hitl;
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
      contextOverflows: scored.filter((r) => r.contextOverflow === true).length,
    };
  });
  const tiers: TierCellSummary[] = [];
  for (const tier of TASK_TIERS) {
    for (const group of byCell.values()) {
      const inTier = group.filter((r) => r.tier === tier);
      const first = inTier[0];
      if (first === undefined) continue;
      const scored = inTier.filter((r) => r.harnessError === undefined);
      const routing = routingOf(inTier);
      tiers.push({
        tier,
        model: first.model,
        mode: first.mode,
        tasks: new Set(inTier.map((r) => r.task)).size,
        successes: scored.filter((r) => r.success).length,
        toolCorrect: scored.filter((r) => r.toolCorrect).length,
        forbidden: scored.filter((r) => r.forbidden).length,
        contextOverflows: scored.filter((r) => r.contextOverflow === true).length,
        scored: scored.length,
        episodes: inTier.length,
        ...spendOf(inTier),
        ...(isProjectionMode(first.mode) ? discoveryOf(inTier) : {}),
        ...(routing !== undefined ? { routing } : {}),
      });
    }
  }
  const total = spendOf(records);
  return {
    episodes: records.length,
    estimatedUsd: total.estimatedUsd,
    ...(total.standardUsd !== undefined ? { standardUsd: total.standardUsd } : {}),
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
      'budget',
      'upstream',
      'in-tok',
      'out-tok',
      'cache-read',
      'est $',
      'std $',
      'turn-capped',
      'ctx-overflow',
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
      cell.meanBudgetTurns.toFixed(1),
      cell.meanUpstreamCalls.toFixed(1),
      Math.round(cell.meanInputTokens).toString(),
      Math.round(cell.meanOutputTokens).toString(),
      pct(cell.cacheReadShare, 1),
      cell.estimatedUsd.toFixed(4),
      usdOrDash(cell.standardUsd),
      cell.turnCapped.toString(),
      cell.contextOverflows.toString(),
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

  // Per tier: the same columns over that tier's episodes alone, plus (multi)
  // the box routing — what a tier comparison or the globalSearch decision
  // reads, never mixed with the other tiers.
  for (const tier of tiersPresent) {
    const cells = summary.tiers.filter((t) => t.tier === tier);
    const routed = cells.some((c) => c.routing !== undefined);
    const header = [
      `${tier} tier`,
      'success',
      'tool-ok',
      'forbidden',
      'ctx-overflow',
      'turns',
      'counted',
      'in-tok',
      'out-tok',
      'est $',
      'std $',
      'discovery per episode',
      ...(routed ? ['global search (ok)', '1st call right box', 'detours (mean calls)'] : []),
    ];
    const rows: string[][] = [header];
    for (const cell of cells) {
      const routing = cell.routing;
      rows.push([
        `${cell.model}/${cell.mode}`,
        `${cell.successes}/${cell.scored} ${pct(cell.successes, cell.scored)}`,
        `${cell.toolCorrect}/${cell.scored}`,
        cell.forbidden.toString(),
        cell.contextOverflows.toString(),
        cell.meanTurns.toFixed(1),
        cell.meanBudgetTurns.toFixed(1),
        Math.round(cell.meanInputTokens).toString(),
        Math.round(cell.meanOutputTokens).toString(),
        cell.estimatedUsd.toFixed(4),
        usdOrDash(cell.standardUsd),
        formatDiscovery(cell),
        ...(routed
          ? routing === undefined
            ? ['-', '-', '-']
            : [
                !isProjectionMode(cell.mode)
                  ? '-'
                  : `${routing.usedGlobalSearch}/${routing.scored} (${routing.successWithGlobalSearch} ok)`,
                `${routing.firstCallRightBox}/${routing.scored}`,
                `${routing.withDetour}/${routing.scored} (${routing.meanWrongBoxCalls.toFixed(1)})`,
              ]
          : []),
      ]);
    }
    lines.push(table(rows), '');
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
    // One Projection mode: label by model, as before the multi tier; more
    // than one (projection and projection-boxes): label by model/mode.
    const byMode = new Set(projectionCells.map((c) => c.mode)).size > 1;
    for (const cell of projectionCells) {
      const routes = cell.routes as Record<ProjectionRoute, number>;
      const boxSearches = Object.entries(cell.meanSearchBoxes ?? {})
        .map(([alias, n]) => `search_${alias} ${n.toFixed(1)}, `)
        .join('');
      lines.push(
        `  ${byMode ? `${cell.model}/${cell.mode}` : cell.model}: ` +
          `call_tool ${routes.call_tool}, execute_machine ${routes.execute_machine}, ` +
          `both ${routes.both}, neither ${routes.neither}; per episode: ` +
          `search_tools ${(cell.meanSearchTools ?? 0).toFixed(1)}, ` +
          boxSearches +
          `describe_tool ${(cell.meanDescribeTool ?? 0).toFixed(1)}, ` +
          `discover_apis ${(cell.meanDiscoverApis ?? 0).toFixed(1)}, ` +
          `approvals ${(cell.meanApprovals ?? 0).toFixed(1)}`,
      );
    }
    lines.push('');
  }

  const hitlCells = summary.cells.filter((c) => c.hitl !== undefined);
  if (hitlCells.length > 0) {
    lines.push(formatHitlTable(hitlCells), '');
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
    'Cost model: Haiku 4.5 $1/$5, Haiku 5.5 $0.10/$0.50 ($0.50/$2.50 for a call whose prompt is over 100K tokens), Sonnet 5.5 $2/$10 per MTok; cache reads 10%, cache writes 125% of input. ' +
      (records.some((r) => r.batch === true)
        ? 'Episodes run through the Message Batches API are billed at 50% of that. '
        : '') +
      'est $ is that actual spend; std $ is the standard host cost (static prefix warm and read every turn ' +
      "when at or above the model's minimum cacheable size, conversation cached incrementally, no batch " +
      'discount), comparable across modes and runs; - where not measured. ' +
      'The turn budget counts action turns (Projection discovery turns are free, up to an absolute ceiling of twice the budget); ' +
      'turn-capped episodes are scored on the upstream calls made before the cap; harness errors are not scored; ' +
      'an episode that runs out of context window (ctx-overflow) is scored as a failure; ' +
      "an episode that makes a call its task forbids, or whose end state fails the task's verify, is not a success.",
  );
  return lines.join('\n');
}

/** The HITL table: one row per cell with HITL metrics. */
export function formatHitlTable(cells: readonly CellSummary[]): string {
  const rows: string[][] = [
    [
      'HITL (cell)',
      'episodes',
      'prompts/ep',
      'prompts/call',
      'prompts/write',
      'clarity',
      'refused eps',
      'handled',
      'no-repeat',
      'workaround',
      'reported',
      'independent done',
    ],
  ];
  for (const cell of cells) {
    const h = cell.hitl as HitlSummary;
    rows.push([
      `${cell.model}/${cell.mode}`,
      h.episodes.toString(),
      h.meanPrompts.toFixed(1),
      h.promptsPerCall.toFixed(2),
      h.promptsPerGatedWrite === undefined ? '-' : h.promptsPerGatedWrite.toFixed(2),
      `${h.clarityOk}/${h.clarityChecked} ${pct(h.clarityOk, h.clarityChecked).trim()}`,
      h.refusedEpisodes.toString(),
      `${h.handled}/${h.refusedEpisodes}`,
      `${h.noRepeat}/${h.refusedEpisodes}`,
      h.workaround.toString(),
      `${h.reported}/${h.reportChecked}`,
      `${h.independentDone}/${h.independentChecked}`,
    ]);
  }
  return [
    table(rows),
    'prompts/call: prompts per gated call presented (below 1 = batched); prompts/write: prompts per gated write the task ideally needs; ' +
      'clarity: prompts naming the box, the tool, every argument value and the destructive flag (of those whose real call is known); ' +
      'handled: after a refusal, no repeat beyond one retry, no workaround, the final answer says what was not done, independent parts done.',
  ].join('\n');
}

/** USD to 4 places, or `-` when not measured. */
function usdOrDash(usd: number | undefined): string {
  return usd === undefined ? '-' : usd.toFixed(4);
}

/** A tier cell's discovery means, or `-` outside the Projection modes. */
function formatDiscovery(cell: TierCellSummary): string {
  if (cell.meanSearchTools === undefined) return '-';
  const boxes = Object.entries(cell.meanSearchBoxes ?? {}).map(
    ([alias, n]) => `search_${alias} ${n.toFixed(1)}`,
  );
  return [
    `search_tools ${cell.meanSearchTools.toFixed(1)}`,
    ...boxes,
    `describe ${(cell.meanDescribeTool ?? 0).toFixed(1)}`,
    `discover ${(cell.meanDiscoverApis ?? 0).toFixed(1)}`,
  ].join(', ');
}

/** One line per episode, for progress output while a live run is going. */
export function formatEpisodeLine(record: EpisodeRecord): string {
  const verdict =
    record.harnessError !== undefined
      ? `ERR ${record.harnessError}`
      : record.contextOverflow === true
        ? 'context-overflow'
        : record.success
          ? 'ok'
          : record.forbidden
            ? 'forbidden-call'
            : record.toolCorrect
              ? 'tool-ok/args-wrong'
              : 'miss';
  const route = record.projection !== undefined ? ` via ${record.projection.route}` : '';
  const hitl =
    record.hitl !== undefined
      ? `; prompts ${record.hitl.prompts}` +
        (record.hitl.denial !== undefined
          ? ` (refused ${record.hitl.denial.refused}, ${record.hitl.denial.handled ? 'handled' : 'mishandled'})`
          : '')
      : '';
  const capped = record.turnCapped ? ' (turn-capped)' : '';
  const budget = record.budgetTurns !== record.apiTurns ? ` (${record.budgetTurns} counted)` : '';
  const upstream = record.upstreamCalls.map((c) => c.tool).join(',') || '-';
  return (
    `${record.model}/${record.mode} ${record.task} #${record.run}: ${verdict}${route}${capped}${hitl}; ` +
    `turns ${record.apiTurns}${budget}, upstream [${upstream}], ${record.wallMs}ms`
  );
}

export interface ResultsMeta {
  models?: string[];
  /**
   * Whether the Projection modes' boxes carried the host's descriptions
   * (PROJ_EVAL_BOX_DESCRIPTIONS=1).
   */
  boxDescriptions?: boolean;
  /**
   * Whether the recording proxy mirrors the real servers' output schemas
   * (true since it does; absent in older files, whose filesystem and MongoDB
   * tools reached Projection with no output schema).
   */
  outputSchemas?: boolean;
  /**
   * Whether every mode's system prompt starts with the world's host framing
   * (true since the framing was added to the Projection modes; absent in
   * older files, whose Projection prompts had none).
   */
  hostFraming?: boolean;
  /**
   * The line appended to the Projection modes' system prompts
   * (PROJ_EVAL_FORCE_CODE_MODE=1); absent when none was.
   */
  systemSuffix?: string;
  /** `native-search` runs: the tool search variant (PROJ_EVAL_TOOL_SEARCH). */
  toolSearch?: ToolSearchVariant;
  /** `native-ptc` runs: the tools' `allowed_callers` (PROJ_EVAL_PTC_CALLERS). */
  ptcCallers?: PtcCallers;
  modes?: EvalMode[];
  tiers?: TaskTier[];
  tasks?: string[];
  runs?: number;
  /** The turn budget the episodes ran under (action turns). */
  maxTurns?: number;
  /** The absolute ceiling on Messages API calls per episode. */
  maxTotalTurns?: number;
  /** Tasks with their own turn budget (ceiling twice it), which overrides `maxTurns`. */
  taskMaxTurns?: Record<string, number>;
  /** The model calls went through the Message Batches API (PROJ_EVAL_BATCH=1). */
  batch?: boolean;
  /** Batch mode: episodes live in the lockstep at once. */
  batchWidth?: number;
  /** Batch mode: every lockstep tick so far, with its wall-clock time. */
  batchTicks?: BatchTick[];
  /** The PROJ_EVAL_APPROVER persona, when one overrode the tasks' own. */
  approver?: ApproverPersona;
  /** PROJ_EVAL_APPROVAL_PROMPTS, when set. */
  approvalPrompts?: ApprovalPrompts;
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
