/**
 * Interactive drive loop (PRD §13 "Manual TUI").
 *
 * The harness's `runScenario` answers approval prompts from a scripted
 * policy; this driver instead PAUSES on every suspension and asks the UI
 * for verdicts, while keeping the same self-heal shape as the reasoning
 * loop: structured errors are fed back to the author for another attempt.
 *
 * The driver is UI-agnostic — it talks to the surface through two
 * callbacks (`onUpdate` for state, `approve` for verdicts) so the Ink app
 * stays a thin renderer and the loop is testable without a terminal.
 */

import {
  isInputRequiredResult,
  type ExecuteMachineArgs,
  type InputRequiredResult,
  type InputResponse,
  type LogEntry,
  type ProjectionFacade,
} from '@astral-mcp/projection';
import type { AttemptErrorView, AuthoringContext, MachineAuthor } from '@astral-mcp/harness';

export type DrivePhase =
  'authoring' | 'running' | 'awaiting_approval' | 'healing' | 'completed' | 'failed';

export interface ApprovalPrompt {
  /** inputRequest key (also the pending call id). */
  key: string;
  /** Full human-readable elicitation message (server-derived, S6). */
  message: string;
}

/** What the UI shows for one suspension (R18/R23 numbers included). */
export interface SuspensionInfo {
  /** 1-based round-trip count for this attempt. */
  trip: number;
  /** Sealed blob size in bytes. */
  blobBytes: number;
  prompts: ApprovalPrompt[];
}

export interface DriveState {
  phase: DrivePhase;
  /** 1-based authoring attempt. */
  attempt: number;
  /** Latest authored module source. */
  code?: string | undefined;
  error?: AttemptErrorView | undefined;
  /** Captured console output from the latest terminal result (R31). */
  logs: LogEntry[];
  suspension?: SuspensionInfo | undefined;
  output?: unknown;
}

export interface DriveCallbacks {
  /** Called on every state change; the UI re-renders from this. */
  onUpdate(state: DriveState): void;
  /**
   * Called on every suspension. Resolves with the user's verdicts, keyed by
   * prompt key; an omitted key is a decline (R17).
   */
  approve(info: SuspensionInfo): Promise<Record<string, InputResponse>>;
}

export interface DriveOptions {
  /** Self-heal ceiling, counting the first attempt. Default 3. */
  maxAttempts?: number;
  /** Hard ceiling on round trips per attempt. Default 32. */
  maxRounds?: number;
}

interface TerminalView {
  isError: boolean;
  error?: AttemptErrorView;
  logs: LogEntry[];
  output?: unknown;
}

function readPrompts(suspension: InputRequiredResult): ApprovalPrompt[] {
  const requests = suspension.inputRequests ?? {};
  return Object.entries(requests).map(([key, request]) => {
    if (request.method === 'elicitation/create' && 'message' in request.params) {
      return { key, message: request.params.message };
    }
    return { key, message: '(no message)' };
  });
}

function readTerminal(result: {
  isError?: boolean | undefined;
  structuredContent?: Record<string, unknown> | undefined;
}): TerminalView {
  const structured = result.structuredContent ?? {};
  const logs = Array.isArray(structured['logs']) ? (structured['logs'] as LogEntry[]) : [];
  if (result.isError === true) {
    return {
      isError: true,
      error: {
        phase: String(structured['phase'] ?? 'unknown'),
        message: String(structured['message'] ?? ''),
        hint: String(structured['hint'] ?? ''),
      },
      logs,
    };
  }
  return { isError: false, logs, output: structured['output'] };
}

/**
 * Run one task interactively: author → execute → pause on approvals →
 * self-heal on structured errors. Resolves with the final state
 * (`completed` or `failed`).
 */
export async function driveTask(
  facade: ProjectionFacade,
  author: MachineAuthor,
  task: string,
  apiDocs: string,
  callbacks: DriveCallbacks,
  options: DriveOptions = {},
): Promise<DriveState> {
  const maxAttempts = options.maxAttempts ?? 3;
  const maxRounds = options.maxRounds ?? 32;
  let previous: AuthoringContext['previous'];
  let state: DriveState = { phase: 'authoring', attempt: 1, logs: [] };

  const update = (next: Partial<DriveState>): DriveState => {
    state = { ...state, ...next };
    callbacks.onUpdate(state);
    return state;
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    update({ phase: 'authoring', attempt, suspension: undefined, error: undefined, logs: [] });
    let code: string;
    try {
      code = await author.author({
        task,
        apiDocs,
        attempt,
        ...(previous !== undefined ? { previous } : {}),
      });
    } catch (thrown) {
      // An SDK failure (bad key, quota, network) is not a machine-authoring
      // failure — do NOT feed it through the self-heal loop; surface it as a
      // structured failure so the UI stays alive and the facade can close.
      return update({
        phase: 'failed',
        error: {
          phase: 'author',
          message: thrown instanceof Error ? thrown.message : String(thrown),
          hint: 'The authoring model call failed; check ANTHROPIC_API_KEY, quota, and network, then retry.',
        },
        suspension: undefined,
      });
    }
    update({ code });

    let args: ExecuteMachineArgs = { code };
    let trips = 0;
    let terminal: TerminalView | undefined;

    for (;;) {
      update({ phase: 'running', suspension: undefined });
      const result = await facade.executeMachine(args, 'modern');

      if (!isInputRequiredResult(result)) {
        // Same narrowing the harness runner performs: a terminal result's
        // relevant fields are isError + structuredContent.
        terminal = readTerminal(
          result as { isError?: boolean; structuredContent?: Record<string, unknown> },
        );
        break;
      }

      trips += 1;
      if (trips > maxRounds) {
        // Cap check BEFORE prompting: a verdict for a round we can never
        // resume would be silently discarded, so abort without asking.
        break;
      }
      const requestState = result.requestState;
      if (requestState === undefined) {
        // A suspension without its sealed blob is a self-declared server
        // bug — retrying the author cannot fix it, so fail the whole drive
        // instead of burning self-heal attempts.
        return update({
          phase: 'failed',
          error: {
            phase: 'protocol',
            message: 'suspension carried no requestState',
            hint: 'This is a server bug; the sealed blob is mandatory on suspensions.',
          },
          suspension: undefined,
        });
      }
      const info: SuspensionInfo = {
        trip: trips,
        blobBytes: Buffer.byteLength(requestState, 'utf8'),
        prompts: readPrompts(result),
      };
      update({ phase: 'awaiting_approval', suspension: info });
      const inputResponses = await callbacks.approve(info);
      args = { code, requestState, inputResponses };
    }

    if (terminal === undefined) {
      return update({
        phase: 'failed',
        error: {
          phase: 'terminal',
          message: `aborted after ${maxRounds} round trips`,
          hint: 'The machine kept suspending; restructure it to need fewer approvals.',
        },
        suspension: undefined,
      });
    }

    if (!terminal.isError) {
      return update({
        phase: 'completed',
        output: terminal.output,
        logs: terminal.logs,
        suspension: undefined,
      });
    }

    const error = terminal.error as AttemptErrorView;
    if (attempt === maxAttempts) {
      return update({ phase: 'failed', error, logs: terminal.logs, suspension: undefined });
    }
    previous = { code, error };
    update({ phase: 'healing', error, logs: terminal.logs, suspension: undefined });
  }

  // Unreachable: the loop always returns on its last attempt.
  return state;
}
