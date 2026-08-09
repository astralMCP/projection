/**
 * §10 self-heal metrics over a batch of reasoning-loop results:
 * first-attempt valid-machine rate (target ≥ 60%) and ≤ 2 attempts to
 * valid (target ≥ 90%).
 */

import type { ReasoningResult } from './loop.js';

export interface SelfHealSummary {
  tasks: number;
  /** Fraction of tasks whose FIRST attempt was a valid machine. */
  firstAttemptValidRate: number;
  /** Fraction of tasks reaching a valid machine within 2 attempts. */
  withinTwoAttemptsValidRate: number;
  /** Fraction of tasks whose final run completed and passed `expect`. */
  successRate: number;
  /** Mean attempts spent per task (all attempts, valid or not). */
  meanAttempts: number;
}

export function summarizeSelfHeal(results: readonly ReasoningResult[]): SelfHealSummary {
  if (results.length === 0) {
    return {
      tasks: 0,
      firstAttemptValidRate: 0,
      withinTwoAttemptsValidRate: 0,
      successRate: 0,
      meanAttempts: 0,
    };
  }
  const n = results.length;
  const count = (predicate: (r: ReasoningResult) => boolean): number =>
    results.filter(predicate).length;
  return {
    tasks: n,
    firstAttemptValidRate: count((r) => r.attemptsToValid === 1) / n,
    withinTwoAttemptsValidRate:
      count((r) => r.attemptsToValid !== undefined && r.attemptsToValid <= 2) / n,
    successRate: count((r) => r.succeeded) / n,
    meanAttempts: results.reduce((sum, r) => sum + r.attempts.length, 0) / n,
  };
}

/** One-line-per-task human-readable report (used by the live benchmark). */
export function formatSelfHealReport(results: readonly ReasoningResult[]): string {
  const summary = summarizeSelfHeal(results);
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
  const lines = results.map((r) => {
    const valid = r.attemptsToValid === undefined ? 'never valid' : `valid@${r.attemptsToValid}`;
    return `  ${r.task}: ${valid}, ${r.attempts.length} attempt(s), ${r.succeeded ? 'succeeded' : 'FAILED'}`;
  });
  return [
    `self-heal over ${summary.tasks} task(s) [${results[0]?.author ?? 'unknown'}]:`,
    ...lines,
    `  first-attempt valid ${pct(summary.firstAttemptValidRate)} (target >=60%), ` +
      `<=2 attempts ${pct(summary.withinTwoAttemptsValidRate)} (target >=90%), ` +
      `success ${pct(summary.successRate)}`,
  ].join('\n');
}
