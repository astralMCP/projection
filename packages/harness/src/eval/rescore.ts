/**
 * Offline re-scoring: apply the current graders to a saved run without
 * re-running (or re-paying for) a single episode.
 *
 * Each record keeps what the episode did — the upstream calls and the
 * model's final text — so the task's `expect`, `forbid` and step groups can
 * be re-run as they are now. `verify` is re-run only when it can be
 * evaluated from the record alone (`facts` is empty); for a task whose
 * verify reads the live world (`needsWorld`: files on disk, documents in
 * the deployment) the recorded verdict stands while `expect` and `forbid`
 * still pass, and is downgraded when they no longer do. Such a task can
 * therefore never be upgraded offline: the end state is gone.
 */

import type { EpisodeRecord } from './run.js';
import { TOOL_CHOICE_TASKS, type EvalTask } from './tasks.js';

/** The three scored fields of a record. */
export interface RescoreVerdict {
  success: boolean;
  toolCorrect: boolean;
  forbidden: boolean;
}

/** One episode whose verdict the current graders changed. */
export interface RescoreChange {
  task: string;
  model: string;
  mode: EpisodeRecord['mode'];
  run: number;
  before: RescoreVerdict;
  after: RescoreVerdict;
}

export interface RescoreOptions {
  /** The graders to apply. Default: every built-in task. */
  tasks?: readonly EvalTask[];
}

export interface RescoreResult {
  /** The input records, in order, with `success`/`toolCorrect`/`forbidden` recomputed. */
  records: EpisodeRecord[];
  changed: RescoreChange[];
}

function verdictOf(record: EpisodeRecord): RescoreVerdict {
  return {
    success: record.success,
    toolCorrect: record.toolCorrect,
    forbidden: record.forbidden,
  };
}

async function rescoreOne(record: EpisodeRecord, task: EvalTask): Promise<RescoreVerdict> {
  const calls = record.upstreamCalls;
  const forbid = task.forbid;
  const forbidden = forbid !== undefined && calls.some((call) => forbid(call));
  const toolCorrect = task.steps.every((group) => calls.some((call) => group.includes(call.tool)));
  const expected = !forbidden && task.expect(calls);
  let success = expected;
  if (expected && task.verify !== undefined) {
    if (task.needsWorld === true) {
      success = record.success;
    } else {
      try {
        success = await task.verify({ calls, finalText: record.finalText, facts: {} });
      } catch {
        // A verify that cannot run offline after all: keep the recorded verdict.
        success = record.success;
      }
    }
  }
  return { success, toolCorrect, forbidden };
}

/**
 * Re-score saved episode records against the current task definitions.
 * Records with a harness error (excluded from the success denominators) and
 * records whose task no longer exists are returned unchanged.
 */
export async function rescoreRecords(
  records: EpisodeRecord[],
  options: RescoreOptions = {},
): Promise<RescoreResult> {
  const tasks = new Map((options.tasks ?? TOOL_CHOICE_TASKS).map((t) => [t.name, t]));
  const out: EpisodeRecord[] = [];
  const changed: RescoreChange[] = [];
  for (const record of records) {
    const task = tasks.get(record.task);
    if (task === undefined || record.harnessError !== undefined) {
      out.push(record);
      continue;
    }
    const before = verdictOf(record);
    const after = await rescoreOne(record, task);
    out.push({ ...record, ...after });
    if (
      before.success !== after.success ||
      before.toolCorrect !== after.toolCorrect ||
      before.forbidden !== after.forbidden
    ) {
      changed.push({
        task: record.task,
        model: record.model,
        mode: record.mode,
        run: record.run,
        before,
        after,
      });
    }
  }
  return { records: out, changed };
}
