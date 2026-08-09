/**
 * Scenario-harness types (PRD §13 "Automated harness").
 *
 * A scenario is a scripted answer policy applied to whatever approval
 * prompts a machine raises, plus assertions about the outcome. The harness
 * drives `execute_machine` through the full MRTR round-trip loop and records
 * exactly what happened so the S1–S6 invariants can be checked.
 */

import type { InputResponse } from 'mccircuit';

/**
 * How a scenario answers one approval prompt, keyed by the inputRequest key.
 *
 * The verdict function sees the request key and the human-readable prompt
 * message (server-derived, S6) and returns how the "user" responds — or
 * `undefined` to omit the answer entirely (R17: an omitted response is a
 * decline). Returning a raw {@link InputResponse} allows decline reasons and
 * malformed answers for adversarial scripts.
 */
export type VerdictPolicy = (prompt: PromptView) => InputResponse | undefined;

export interface PromptView {
  /** The inputRequest key (also the pending tool call's id). */
  key: string;
  /** The full human-readable elicitation message (S6: server-derived). */
  message: string;
  /** Zero-based round-trip index this prompt appeared on. */
  round: number;
}

/**
 * A mutation applied to a suspension before the retry is issued, modelling a
 * hostile or faulty client (S3/S4). Receives the sealed `requestState` and
 * returns what the client actually echoes back.
 */
export type StateMutator = (requestState: string) => string;

export interface Scenario {
  /** Stable identifier used in reports. */
  name: string;
  /** The machine module source to run. */
  code: string;
  lang?: 'ts' | 'js';
  /** Machine input. */
  input?: unknown;
  /** How approval prompts are answered. Default: approve everything. */
  verdicts?: VerdictPolicy;
  /**
   * Optional tampering applied to the sealed blob before each retry
   * (S3/S4). Applied on every round unless {@link tamperRounds} narrows it.
   */
  tamper?: StateMutator;
  /** Restrict tampering to these zero-based rounds. Default: all rounds. */
  tamperRounds?: number[];
  /** Hard ceiling on round trips the harness itself will drive. */
  maxRounds?: number;
}

/** One round trip the harness drove. */
export interface RoundRecord {
  round: number;
  outcome: 'suspended' | 'completed' | 'error';
  /** inputRequest keys prompted this round (suspensions only). */
  promptKeys: string[];
  /** Whether a tool side effect was observed on the wrapped server this round. */
  sideEffects: SideEffect[];
}

export interface SideEffect {
  tool: string;
  args: Record<string, unknown>;
}

export type RunStatus = 'completed' | 'error' | 'aborted_round_limit';

export interface ScenarioResult {
  scenario: string;
  status: RunStatus;
  /** Number of MRTR round trips (suspensions) before terminating. */
  rounds: number;
  /** Every tool call the wrapped server actually executed, in order. */
  sideEffects: SideEffect[];
  /** Final machine output, when completed without error. */
  output?: unknown;
  /** Structured error, when the terminal result was `isError`. */
  error?: { phase: string; message: string; hint: string };
  /** Per-round detail. */
  roundRecords: RoundRecord[];
  /** Largest sealed blob observed, in bytes (Section 10 budget). */
  maxBlobBytes: number;
}
