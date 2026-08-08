/**
 * Scenario runner — drives `execute_machine` through the whole MRTR
 * round-trip loop under a scripted answer policy (PRD §13).
 */

import {
  isInputRequiredResult,
  type ExecuteMachineArgs,
  type InputRequiredResult,
  type InputResponse,
  type McCircuitFacade,
  type ToolCallResult,
} from 'mccircuit';
import type { RecordingServer } from './recording-server.js';
import type { RoundRecord, Scenario, ScenarioResult, SideEffect } from './types.js';

/** Default: approve every prompt. */
const APPROVE_ALL: InputResponse = { action: 'accept' };

const DEFAULT_MAX_ROUNDS = 32;

interface ElicitationPrompt {
  key: string;
  message: string;
}

/**
 * Read the human-readable prompts out of a suspension. Only form-mode
 * elicitations carry a message; anything else is surfaced as an empty
 * string so a scenario can still answer by key.
 */
function readPrompts(suspension: InputRequiredResult): ElicitationPrompt[] {
  const requests = suspension.inputRequests ?? {};
  return Object.entries(requests).map(([key, request]) => {
    if (request.method === 'elicitation/create' && 'message' in request.params) {
      return { key, message: request.params.message };
    }
    return { key, message: '' };
  });
}

function sealedState(suspension: InputRequiredResult): string {
  const state = suspension.requestState;
  if (state === undefined) {
    throw new Error('harness: suspension carried no requestState');
  }
  return state;
}

interface TerminalResult {
  structuredContent?: Record<string, unknown> | undefined;
  isError?: boolean | undefined;
}

/**
 * Run one scenario end to end.
 *
 * The facade must already wrap `recording.server`. The harness reads
 * `recording.calls` to attribute side effects to each round, so the same
 * recording server instance must back both.
 */
export async function runScenario(
  facade: McCircuitFacade,
  recording: RecordingServer,
  scenario: Scenario,
): Promise<ScenarioResult> {
  const maxRounds = scenario.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const verdicts = scenario.verdicts ?? (() => APPROVE_ALL);
  const roundRecords: RoundRecord[] = [];
  let maxBlobBytes = 0;
  let firstState: string | undefined;
  let seen = 0; // index into recording.calls already attributed

  const takeSideEffects = (): SideEffect[] => {
    const fresh = recording.calls.slice(seen);
    seen = recording.calls.length;
    return fresh;
  };

  let args: ExecuteMachineArgs = {
    code: scenario.code,
    ...(scenario.lang !== undefined ? { lang: scenario.lang } : {}),
    ...(scenario.input !== undefined ? { input: scenario.input } : {}),
  };

  for (let round = 0; round < maxRounds; round += 1) {
    const result: ToolCallResult = await facade.executeMachine(args, 'modern');

    if (!isInputRequiredResult(result)) {
      const sideEffects = takeSideEffects();
      const terminal = result as TerminalResult;
      const isError = terminal.isError === true;
      roundRecords.push({
        round,
        outcome: isError ? 'error' : 'completed',
        promptKeys: [],
        sideEffects,
      });
      return finish(scenario, roundRecords, maxBlobBytes, recording, terminal, isError);
    }

    // Suspended: record what was prompted and what (if anything) ran.
    const suspension = result;
    const prompts = readPrompts(suspension);
    const state = sealedState(suspension);
    if (firstState === undefined) firstState = state;
    maxBlobBytes = Math.max(maxBlobBytes, Buffer.byteLength(state, 'utf8'));

    roundRecords.push({
      round,
      outcome: 'suspended',
      promptKeys: prompts.map((p) => p.key),
      sideEffects: takeSideEffects(),
    });

    // Build the retry: gather verdicts, then optionally tamper / replay.
    const inputResponses: Record<string, InputResponse> = {};
    for (const prompt of prompts) {
      const verdict = verdicts({ key: prompt.key, message: prompt.message, round });
      if (verdict !== undefined) inputResponses[prompt.key] = verdict;
    }

    let requestState = scenario.replayFirstState ? firstState : state;
    const tamperThisRound =
      scenario.tamper !== undefined &&
      (scenario.tamperRounds === undefined || scenario.tamperRounds.includes(round));
    if (tamperThisRound && scenario.tamper !== undefined) {
      requestState = scenario.tamper(requestState);
    }

    args = { code: scenario.code, requestState, inputResponses };
  }

  return {
    scenario: scenario.name,
    status: 'aborted_round_limit',
    rounds: roundRecords.filter((r) => r.outcome === 'suspended').length,
    sideEffects: recording.calls.slice(),
    roundRecords,
    maxBlobBytes,
  };
}

function finish(
  scenario: Scenario,
  roundRecords: RoundRecord[],
  maxBlobBytes: number,
  recording: RecordingServer,
  terminal: TerminalResult,
  isError: boolean,
): ScenarioResult {
  const rounds = roundRecords.filter((r) => r.outcome === 'suspended').length;
  const base = {
    scenario: scenario.name,
    status: (isError ? 'error' : 'completed') as ScenarioResult['status'],
    rounds,
    sideEffects: recording.calls.slice(),
    roundRecords,
    maxBlobBytes,
  };
  const structured = terminal.structuredContent ?? {};
  if (isError) {
    return {
      ...base,
      error: {
        phase: String(structured['phase'] ?? 'unknown'),
        message: String(structured['message'] ?? ''),
        hint: String(structured['hint'] ?? ''),
      },
    };
  }
  return { ...base, output: structured['output'] };
}
