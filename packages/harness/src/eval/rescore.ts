/**
 * Offline re-scoring: apply the current graders to a saved run without
 * re-running (or re-paying for) a single episode.
 *
 * Each record keeps what the episode did — the upstream calls and the
 * model's final text — so the task's `expect`, `forbid` and step groups can
 * be re-run as they are now. `verify` is re-run only when it can be
 * evaluated from the record alone (its `facts` throw on any read); for a
 * task whose verify reads the live world (`needsWorld`: files on disk,
 * documents in the deployment) the recorded verdict stands while `expect`
 * and `forbid` still pass, and is downgraded when they no longer do. Such a
 * task can therefore never be upgraded offline: the end state is gone
 * (DECISIONS D13). A multi-tier record's box routing (`boxes`) is
 * recomputed too, from the recorded calls and the task's current steps.
 */

import { boxRouting, type EpisodeRecord } from './run.js';
import type { WorldFacts } from './world.js';
import { TOOL_CHOICE_TASKS, type EvalTask } from './tasks.js';

/**
 * The `facts` an offline verify gets: any read throws, so a verify that
 * touches the world's facts (and so belongs under `needsWorld`) is caught
 * rather than quietly graded against nothing.
 */
export const OFFLINE_FACTS: WorldFacts = new Proxy({} as WorldFacts, {
  get(_target, key) {
    throw new Error(`offline re-score: verify read facts.${String(key)}`);
  },
  has(_target, key) {
    throw new Error(`offline re-score: verify probed facts.${String(key)}`);
  },
  ownKeys() {
    throw new Error('offline re-score: verify enumerated facts');
  },
  getOwnPropertyDescriptor(_target, key) {
    throw new Error(`offline re-score: verify read facts.${String(key)}`);
  },
});

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

/** One episode the current graders threw on; its record is left as recorded. */
export interface RescoreError {
  task: string;
  model: string;
  mode: EpisodeRecord['mode'];
  run: number;
  message: string;
}

export interface RescoreOptions {
  /** The graders to apply. Default: every built-in task. */
  tasks?: readonly EvalTask[];
}

export interface RescoreResult {
  /** The input records, in order, with `success`/`toolCorrect`/`forbidden` recomputed. */
  records: EpisodeRecord[];
  changed: RescoreChange[];
  /** Episodes whose `expect`, `forbid` or `verify` threw: left as recorded. */
  errors: RescoreError[];
  /**
   * `needsWorld` episodes recorded as failures whose `expect` and `forbid`
   * now pass: the failure stands, but only a re-run can tell whether the
   * current verify would agree.
   */
  worldFailuresKept: number;
}

function verdictOf(record: EpisodeRecord): RescoreVerdict {
  return {
    success: record.success,
    toolCorrect: record.toolCorrect,
    forbidden: record.forbidden,
  };
}

/**
 * The re-scored verdict, and whether it is a recorded world-verify failure
 * kept without re-checking (expect and forbid pass, verify not re-run).
 */
async function rescoreOne(
  record: EpisodeRecord,
  task: EvalTask,
): Promise<{ verdict: RescoreVerdict; worldFailureKept: boolean }> {
  const calls = record.upstreamCalls;
  const forbid = task.forbid;
  const forbidden = forbid !== undefined && calls.some((call) => forbid(call));
  const toolCorrect = task.steps.every((group) => calls.some((call) => group.includes(call.tool)));
  // An episode that ran out of context window stays a failure.
  const expected = record.contextOverflow !== true && !forbidden && task.expect(calls);
  let success = expected;
  let worldFailureKept = false;
  if (expected && task.verify !== undefined) {
    if (task.needsWorld === true) {
      success = record.success;
      worldFailureKept = !record.success;
    } else {
      success = await task.verify({ calls, finalText: record.finalText, facts: OFFLINE_FACTS });
    }
  }
  return { verdict: { success, toolCorrect, forbidden }, worldFailureKept };
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
  const errors: RescoreError[] = [];
  let worldFailuresKept = 0;
  for (const record of records) {
    const task = tasks.get(record.task);
    if (task === undefined || record.harnessError !== undefined) {
      out.push(record);
      continue;
    }
    const before = verdictOf(record);
    let rescored: Awaited<ReturnType<typeof rescoreOne>>;
    try {
      rescored = await rescoreOne(record, task);
    } catch (error) {
      errors.push({
        task: record.task,
        model: record.model,
        mode: record.mode,
        run: record.run,
        message: error instanceof Error ? error.message : String(error),
      });
      out.push(record);
      continue;
    }
    const after = rescored.verdict;
    if (rescored.worldFailureKept) worldFailuresKept += 1;
    const boxes = boxRouting(task, record.upstreamCalls, record.toolUses);
    out.push({ ...record, ...after, ...(boxes !== undefined ? { boxes } : {}) });
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
  return { records: out, changed, errors, worldFailuresKept };
}
