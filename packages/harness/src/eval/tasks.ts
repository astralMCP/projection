/**
 * Tool-choice tasks, every tier: the GitHub tiers (`basic`, `hard` —
 * github-tasks.ts), `filesystem` (filesystem-tasks.ts), `mongodb`
 * (mongodb-tasks.ts), `multi` (multi-tasks.ts) and the opt-in
 * `multi-hard` (multi-hard-tasks.ts) and the opt-in, held-out
 * `workplace` (workplace-tasks.ts) and `summit-saas` (summit-tasks.ts), plus the
 * PROJ_EVAL_TIERS / PROJ_EVAL_TASKS resolvers.
 */

import { FILESYSTEM_TASKS } from './filesystem-tasks.js';
import { HITL_TASKS } from './hitl-tasks.js';
import { BASIC_TASKS, HARD_TASKS } from './github-tasks.js';
import { MONGODB_TASKS } from './mongodb-tasks.js';
import { MULTI_HARD_TASKS } from './multi-hard-tasks.js';
import { MULTI_TASKS } from './multi-tasks.js';
import { SUMMIT_TASKS } from './summit-tasks.js';
import { WORKPLACE_TASKS } from './workplace-tasks.js';
import { DEFAULT_TIERS, TASK_TIERS, type EvalTask, type TaskTier } from './task-core.js';

export {
  promptFor,
  DEFAULT_TIERS,
  TASK_TIERS,
  TIER_WORLDS,
  worldOf,
  worldOptionsOf,
  type EvalTask,
  type TaskKind,
  type TaskTier,
  type VerifyContext,
} from './task-core.js';
export { BASIC_TASKS, HARD_TASKS } from './github-tasks.js';

export const TOOL_CHOICE_TASKS: readonly EvalTask[] = [
  ...BASIC_TASKS,
  ...HARD_TASKS,
  ...FILESYSTEM_TASKS,
  ...MONGODB_TASKS,
  ...MULTI_TASKS,
  ...MULTI_HARD_TASKS,
  ...WORKPLACE_TASKS,
  ...HITL_TASKS,
  ...SUMMIT_TASKS,
];

/**
 * Resolve a comma list of tier names (PROJ_EVAL_TIERS); unknown names
 * throw. Unset selects {@link DEFAULT_TIERS} (`multi-hard`, `workplace`, `hitl` and `summit-saas` are opt-in).
 */
export function resolveTiers(spec: string | undefined): TaskTier[] {
  if (spec === undefined || spec.trim() === '') return [...DEFAULT_TIERS];
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((name) => {
      if (!TASK_TIERS.includes(name as TaskTier)) {
        throw new Error(`unknown tier "${name}"; known: ${TASK_TIERS.join(', ')}`);
      }
      return name as TaskTier;
    });
}

/**
 * Resolve a comma list of task names (PROJ_EVAL_TASKS) within `tiers`
 * (default: all). Unknown names throw, and so does naming a task outside
 * the selected tiers — the matrix never silently shrinks.
 */
export function resolveTasks(
  spec: string | undefined,
  tiers: readonly TaskTier[] = TASK_TIERS,
): EvalTask[] {
  const inTiers = TOOL_CHOICE_TASKS.filter((t) => tiers.includes(t.tier));
  if (spec === undefined || spec.trim() === '') return inTiers;
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((name) => {
      const task = TOOL_CHOICE_TASKS.find((t) => t.name === name);
      if (task === undefined) {
        throw new Error(
          `unknown task "${name}"; known: ${TOOL_CHOICE_TASKS.map((t) => t.name).join(', ')}`,
        );
      }
      if (!tiers.includes(task.tier)) {
        throw new Error(
          `task "${name}" is in tier ${task.tier}, which the selected tiers (${tiers.join(', ')}) exclude`,
        );
      }
      return task;
    });
}
