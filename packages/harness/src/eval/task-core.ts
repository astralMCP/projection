/**
 * The task contract shared by every tier of the tool-choice eval, plus the
 * argument-matching helpers the task files build their predicates from.
 *
 * A task says what to do, never how. Its expectations are predicates over
 * the upstream calls the world actually recorded — identical whether the
 * model reached the tool directly or through Projection — and, for worlds
 * with real effects, an optional `verify` that checks the end state (files
 * on disk, the model's answer) after the episode.
 */

import type { SideEffect } from '../types.js';
import type { ElicitationRecord, HitlChecks, TaskApprover } from './hitl.js';
import type { WorldFacts, WorldName, WorldOptions } from './world.js';

/**
 * `single` / `multi`: one tool call or several (the original tiers). The
 * `multi-hard` tier tags each task with its family instead: `bulk-read`
 * (one answer over N ≥ 25 items), `bulk-write` (8–20 approved writes),
 * `chain` (five or more dependent hops across boxes), `pagination` (the
 * answer hides past a default page or result cap), `branching` (a per-item
 * choice between two different writes). The `workplace` tier adds
 * `lookup` (one box, not named), `fan-out` (per-item gated writes),
 * `idempotency` (part or all of the work is already done), `conflict`
 * (two sources disagree; the prompt names the authority), `injection` (a
 * data field carries an instruction) and `degradation` (one tool fails).
 * The `hitl` tier tags every task `approval`: a write task whose approver
 * refuses, cancels or edits part of it.
 */
export type TaskKind =
  | 'single'
  | 'multi'
  | 'bulk-read'
  | 'bulk-write'
  | 'chain'
  | 'pagination'
  | 'branching'
  | 'lookup'
  | 'fan-out'
  | 'idempotency'
  | 'conflict'
  | 'injection'
  | 'degradation'
  | 'approval';

/**
 * Tiers: `basic` and `hard` run against the offline GitHub fake;
 * `filesystem` against the real filesystem reference server; `mongodb`
 * against the real MongoDB MCP server on a throwaway deployment; `multi`
 * against all three at once, each a box under an alias (multi-world.ts);
 * `multi-hard` against the same three boxes with much more data in them
 * (multi-hard-tasks.ts) — opt-in only, never part of the default matrix;
 * `workplace` against five in-process fakes of other popular servers
 * (workplace-world.ts, workplace-tasks.ts) — opt-in only, and held out:
 * a hill-climb sees its aggregate scores, never its tasks or traces;
 * `hitl` against the same workplace world, each task paired with an
 * approver persona that declines, cancels or edits part of the work
 * (hitl-tasks.ts) — opt-in only, and NOT held out: it is the target the
 * approval UX is tuned on;
 * `summit-local` against six real servers that run locally — filesystem,
 * git, memory, SQLite, fetch (on a loopback intranet) and time — seeded
 * with one company's data (summit-local-world.ts, summit-local-tasks.ts):
 * opt-in only, needs `pnpm run setup:servers-real`, and held out like
 * `workplace` (calibrated in `direct` mode only);
 * `summit-saas` against high-fidelity fakes of the Notion, Sentry, Slack and
 * Stripe MCP servers plus the real filesystem server (summit-world.ts,
 * summit-tasks.ts) — opt-in only, and held out like `workplace`.
 */
export type TaskTier =
  | 'basic'
  | 'hard'
  | 'filesystem'
  | 'mongodb'
  | 'multi'
  | 'multi-hard'
  | 'workplace'
  | 'hitl'
  | 'summit-local'
  | 'summit-saas';
export const TASK_TIERS: readonly TaskTier[] = [
  'basic',
  'hard',
  'filesystem',
  'mongodb',
  'multi',
  'multi-hard',
  'workplace',
  'hitl',
  'summit-local',
  'summit-saas',
];
/** The tiers an unset PROJ_EVAL_TIERS selects: every tier but the opt-in `multi-hard`, `workplace`, `hitl`, `summit-local` and `summit-saas`. */
export const DEFAULT_TIERS: readonly TaskTier[] = [
  'basic',
  'hard',
  'filesystem',
  'mongodb',
  'multi',
];

/** The world each tier's tasks run in. */
export const TIER_WORLDS: Readonly<Record<TaskTier, WorldName>> = {
  basic: 'github',
  hard: 'github',
  filesystem: 'filesystem',
  mongodb: 'mongodb',
  multi: 'multi',
  'multi-hard': 'multi',
  workplace: 'workplace',
  hitl: 'workplace',
  'summit-local': 'summit-local',
  'summit-saas': 'summit',
};

export function worldOf(tier: TaskTier): WorldName {
  return TIER_WORLDS[tier];
}

/** World options a tier needs beyond its world's name: `multi-hard` opens the hard variant. */
export function worldOptionsOf(tier: TaskTier): Pick<WorldOptions, 'variant'> {
  return tier === 'multi-hard' ? { variant: 'hard' } : {};
}

/** What `verify` sees once the episode is over and before the world is torn down. */
export interface VerifyContext {
  /** What reached the world, in order. */
  calls: SideEffect[];
  /** Text blocks of the model's final message, joined. */
  finalText: string;
  /** Per-episode facts (the filesystem root, the MongoDB connection string). */
  facts: WorldFacts;
  /** Every approval prompt the episode showed and its answer (hitl.ts); empty when none. */
  elicitations?: readonly ElicitationRecord[];
}

export interface EvalTask {
  /** Stable identifier (PROJ_EVAL_TASKS filter, report rows). */
  name: string;
  tier: TaskTier;
  kind: TaskKind;
  /**
   * The user's request. A function when the wording depends on per-episode
   * facts (a throwaway directory's path); resolve it with {@link promptFor}.
   */
  prompt: string | ((facts: WorldFacts) => string);
  /**
   * Upstream tools that solve each step; "tool-correct" means every step
   * saw a call to one of its tools, regardless of arguments.
   */
  steps: string[][];
  /** Full success: the right tool(s) with the right arguments. */
  expect(calls: SideEffect[]): boolean;
  /**
   * A call that must not appear: any recorded call matching this fails the
   * episode regardless of `expect`. Absent means nothing is forbidden.
   */
  forbid?(call: SideEffect): boolean;
  /**
   * End-state check, run after the episode and before the world is torn
   * down: the file really moved, the answer names the right file. Success
   * requires `expect` AND `verify` (when present). A check that throws is a
   * harness error — the episode is excluded from the success denominator,
   * not scored `false` — so a verify must catch what it means to tolerate
   * (a missing file is `false`, not a throw).
   */
  verify?(context: VerifyContext): boolean | Promise<boolean>;
  /**
   * `verify` reads the live world's end state (files on disk, documents in
   * the deployment), not just the calls and the answer, so it cannot be
   * re-run from a saved record. The offline re-scorer (rescore.ts) keeps
   * the recorded verdict for such tasks instead of re-running `verify`.
   */
  needsWorld?: boolean;
  /**
   * The task's own turn budget (action turns, as `maxTurns`), overriding
   * the run's; its absolute ceiling is then twice this. The `multi-hard`
   * tier sets 2N + 10, so a strategy that spends one turn per item can
   * finish.
   */
  maxTurns?: number;
  /**
   * `multi-hard`: the number of items the task iterates over (records to
   * total, writes to make, hops to follow, pages to read, checks to
   * branch on) — what its {@link maxTurns} is derived from.
   */
  n?: number;
  /**
   * `hitl` tier: who answers the episode's approval prompts (a persona and
   * its task-specific predicate). PROJ_EVAL_APPROVER overrides the persona.
   * Absent: approve-all.
   */
  approver?: TaskApprover;
  /** `hitl` tier: the task's ideal prompt count and its denial-handling checks. */
  hitl?: HitlChecks;
}

/** The prompt text for one episode. */
export function promptFor(task: EvalTask, facts: WorldFacts): string {
  return typeof task.prompt === 'string' ? task.prompt : task.prompt(facts);
}

export type Args = Record<string, unknown>;

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
}

export function sameText(value: unknown, expected: string): boolean {
  return str(value)?.trim().toLowerCase() === expected.toLowerCase();
}

export function containsText(value: unknown, expected: string): boolean {
  return (str(value)?.toLowerCase() ?? '').includes(expected.toLowerCase());
}

export function sameNumber(value: unknown, expected: number): boolean {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return n === expected;
}

/** The first of these keys that is present. */
export function firstOf(args: Args, keys: string[]): unknown {
  for (const key of keys) if (args[key] !== undefined) return args[key];
  return undefined;
}

/** Index of the first call to one of `tool` whose args satisfy `where`; -1 when none. */
export function find(
  calls: SideEffect[],
  tool: string | string[],
  where: (args: Args) => boolean,
): number {
  const names = Array.isArray(tool) ? tool : [tool];
  return calls.findIndex((call) => names.includes(call.tool) && where(call.args));
}

export function has(
  calls: SideEffect[],
  tool: string | string[],
  where: (args: Args) => boolean,
): boolean {
  return find(calls, tool, where) >= 0;
}

export function count(
  calls: SideEffect[],
  tool: string | string[],
  where: (args: Args) => boolean,
): number {
  const names = Array.isArray(tool) ? tool : [tool];
  return calls.filter((call) => names.includes(call.tool) && where(call.args)).length;
}
