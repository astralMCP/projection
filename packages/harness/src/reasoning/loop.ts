/**
 * The reasoning loop — drives an author through authoring, execution, and
 * structured-error self-healing for one benchmark task (PRD §13, G5).
 *
 * Each attempt runs the authored module through the full MRTR scenario
 * runner; an `isError` terminal feeds the structured error (phase, message,
 * hint — R25) back to the author for the next attempt. The per-attempt
 * record is what the §10 self-heal metrics are computed from.
 */

import type { McCircuitFacade } from 'mccircuit';
import type { RecordingServer } from '../recording-server.js';
import { runScenario } from '../runner.js';
import type { ScenarioResult, VerdictPolicy } from '../types.js';
import type { AttemptErrorView, AuthoringContext, MachineAuthor } from './author.js';

/** One benchmark task: a natural-language prompt plus the run script. */
export interface BenchmarkTask {
  name: string;
  /** The task prompt handed to the author. */
  prompt: string;
  /** Machine input passed to execute_machine. */
  input?: unknown;
  /** How approval prompts are answered. Default: approve everything. */
  verdicts?: VerdictPolicy;
  maxRounds?: number;
  /**
   * Task-level success check on a completed run (e.g. the expected side
   * effect reached the wrapped server). Default: completing is succeeding.
   */
  expect?: (result: ScenarioResult) => boolean;
}

export interface AttemptRecord {
  /** 1-based. */
  attempt: number;
  /** The authored module source. */
  code: string;
  result: ScenarioResult;
  /**
   * Whether the module passed the authoring contract — i.e. was a valid
   * machine (§10 "valid-machine rate"). Transpile and validate failures are
   * invalid machines; anything that started executing (completed, suspended,
   * runtime/cap/tool errors) was valid but may still have failed.
   */
  machineValid: boolean;
}

export interface ReasoningResult {
  task: string;
  author: string;
  attempts: AttemptRecord[];
  /** 1-based attempt on which the machine was first valid; undefined if never. */
  attemptsToValid: number | undefined;
  /** Final attempt completed and passed the task's `expect` check. */
  succeeded: boolean;
}

export interface ReasoningOptions {
  /** Self-heal ceiling per task, counting the first attempt. Default 3. */
  maxAttempts?: number;
}

/** Phases that mean the module never became a running machine (R24). */
const INVALID_MACHINE_PHASES = new Set(['transpile', 'validate']);

function isValidMachine(result: ScenarioResult): boolean {
  return !(result.status === 'error' && INVALID_MACHINE_PHASES.has(result.error?.phase ?? ''));
}

function errorView(result: ScenarioResult): AttemptErrorView | undefined {
  if (result.status !== 'error' || result.error === undefined) return undefined;
  return result.error;
}

/**
 * Run one task: author → execute → feed structured errors back → retry,
 * up to `maxAttempts`. The scenario runner attributes side effects against
 * `recording`, which must back the facade's wrapped server.
 */
export async function runReasoningTask(
  facade: McCircuitFacade,
  recording: RecordingServer,
  author: MachineAuthor,
  task: BenchmarkTask,
  apiDocs: string,
  options: ReasoningOptions = {},
): Promise<ReasoningResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`maxAttempts must be a positive integer, got ${maxAttempts}`);
  }
  const attempts: AttemptRecord[] = [];
  let previous: AuthoringContext['previous'];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const code = await author.author({
      task: task.prompt,
      apiDocs,
      attempt,
      ...(previous !== undefined ? { previous } : {}),
    });

    const result = await runScenario(facade, recording, {
      name: `${task.name}#${attempt}`,
      code,
      ...(task.input !== undefined ? { input: task.input } : {}),
      ...(task.verdicts !== undefined ? { verdicts: task.verdicts } : {}),
      ...(task.maxRounds !== undefined ? { maxRounds: task.maxRounds } : {}),
    });

    attempts.push({ attempt, code, result, machineValid: isValidMachine(result) });

    if (result.status !== 'error') break;
    const error = errorView(result);
    if (error === undefined) break;
    previous = { code, error };
  }

  // Safe: maxAttempts >= 1 is enforced above, so the loop ran at least once.
  const last = attempts[attempts.length - 1] as AttemptRecord;
  const firstValid = attempts.find((a) => a.machineValid);
  return {
    task: task.name,
    author: author.name,
    attempts,
    attemptsToValid: firstValid?.attempt,
    succeeded:
      last.result.status === 'completed' && (task.expect === undefined || task.expect(last.result)),
  };
}
