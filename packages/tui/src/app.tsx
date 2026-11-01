/**
 * The Ink surface (PRD §13 "Manual TUI"): type a task, watch the authored
 * machine + validation results + console logs stream by, and answer each
 * approval prompt with a single key. Blob size and trip count are shown on
 * every suspension.
 */

import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useRef, useState } from 'react';
import {
  neutralizeControlChars,
  type InputResponse,
  type ProjectionFacade,
} from '@astral-mcp/projection';
import type { MachineAuthor } from '@astral-mcp/harness';
import { driveTask, type DriveState, type SuspensionInfo } from './driver.js';

export interface AppProps {
  facade: ProjectionFacade;
  author: MachineAuthor;
  apiDocs: string;
  /** Wrapped-server label shown in the header. */
  serverLabel: string;
  maxAttempts?: number;
}

interface PendingApproval {
  info: SuspensionInfo;
  resolve: (verdicts: Record<string, InputResponse>) => void;
}

const PHASE_LABEL: Record<DriveState['phase'], string> = {
  authoring: 'model is authoring a machine…',
  running: 'running machine segment…',
  awaiting_approval: 'awaiting your approval',
  healing: 'self-healing from a structured error…',
  completed: 'completed',
  failed: 'failed',
};

export function App({ facade, author, apiDocs, serverLabel, maxAttempts }: AppProps) {
  const { exit } = useApp();
  const [task, setTask] = useState('');
  const [drive, setDrive] = useState<DriveState | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingApproval | undefined>(undefined);
  const [promptIndex, setPromptIndex] = useState(0);
  // While the task input has focus every printable key belongs to it — a
  // task like "query the orders" must not trip the global "q quits" binding.
  // Esc toggles focus off (command mode: q quits) and back on.
  const [inputFocused, setInputFocused] = useState(true);
  // Verdicts collected so far for the current suspension.
  const verdictsRef = useRef<Record<string, InputResponse>>({});

  const startTask = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed === '' || busy) return;
      setBusy(true);
      setDrive(undefined);
      void driveTask(
        facade,
        author,
        trimmed,
        apiDocs,
        {
          onUpdate: setDrive,
          approve: (info) =>
            new Promise((resolve) => {
              verdictsRef.current = {};
              setPromptIndex(0);
              setPending({ info, resolve });
            }),
        },
        maxAttempts !== undefined ? { maxAttempts } : {},
      )
        .catch((thrown: unknown) => {
          // Safety net: driveTask resolves failures into state, so this
          // should be unreachable — but a residual rejection must land in
          // UI state, never crash the render loop as an unhandled rejection.
          setDrive({
            phase: 'failed',
            attempt: 1,
            logs: [],
            error: {
              phase: 'driver',
              message: thrown instanceof Error ? thrown.message : String(thrown),
              hint: 'Unexpected driver failure; check ANTHROPIC_API_KEY and network, then retry.',
            },
          });
        })
        .finally(() => {
          setBusy(false);
          setTask('');
        });
    },
    [apiDocs, author, busy, facade, maxAttempts],
  );

  useInput(
    (input, key) => {
      if (pending === undefined) {
        if (busy) return;
        if (key.escape) {
          setInputFocused((focused) => !focused);
          return;
        }
        if (inputFocused) return; // keystrokes belong to the task input
        if (input === 'q' && !key.meta && !key.ctrl) exit();
        else if (key.return) setInputFocused(true);
        return;
      }
      const prompt = pending.info.prompts[promptIndex];
      if (prompt === undefined) return;
      let verdict: InputResponse | undefined;
      if (input === 'y') verdict = { action: 'accept' };
      else if (input === 'n') verdict = { action: 'decline' };
      else if (input === 'i') verdict = undefined; // omit = decline (R17)
      else return;
      if (verdict !== undefined) verdictsRef.current[prompt.key] = verdict;
      const next = promptIndex + 1;
      if (next < pending.info.prompts.length) {
        setPromptIndex(next);
      } else {
        const { resolve } = pending;
        setPending(undefined);
        resolve(verdictsRef.current);
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column" gap={1}>
      <Text>
        <Text bold color="cyan">
          Projection TUI
        </Text>
        {'  '}wrapped server: <Text color="green">{serverLabel}</Text>
        {'  '}model: <Text color="green">{author.name}</Text>
      </Text>

      {!busy && (
        <Box>
          <Text bold>task&gt; </Text>
          <TextInput value={task} onChange={setTask} onSubmit={startTask} focus={inputFocused} />
        </Box>
      )}

      {drive !== undefined && (
        <Box flexDirection="column" gap={1}>
          <Text>
            attempt <Text bold>{drive.attempt}</Text>:{' '}
            <Text color="yellow">{PHASE_LABEL[drive.phase]}</Text>
          </Text>

          {drive.code !== undefined && (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              <Text dimColor>authored machine</Text>
              {/* Model-authored text: strip ANSI/OSC control chars, keep line
                  structure (S6). */}
              <Text>{neutralizeControlChars(drive.code, { allowNewline: true })}</Text>
            </Box>
          )}

          {drive.error !== undefined && (
            <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
              {/* Error copy can echo model-authored text — render it inert (S6). */}
              <Text color="red" bold>
                {neutralizeControlChars(drive.error.phase)}:{' '}
                {neutralizeControlChars(drive.error.message)}
              </Text>
              <Text dimColor>hint: {neutralizeControlChars(drive.error.hint)}</Text>
            </Box>
          )}

          {drive.logs.length > 0 && (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              <Text dimColor>console</Text>
              {drive.logs.map((log, i) => (
                <Text key={i}>
                  {/* console.log from authored code is untrusted: no escape
                      sequences may reach the terminal (S6). */}
                  [{log.level}] {neutralizeControlChars(log.message, { allowNewline: true })}
                </Text>
              ))}
            </Box>
          )}

          {pending !== undefined && (
            <Box flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={1}>
              <Text bold>
                round trip {pending.info.trip} · blob {pending.info.blobBytes} bytes · prompt{' '}
                {promptIndex + 1}/{pending.info.prompts.length}
              </Text>
              <Text>{pending.info.prompts[promptIndex]?.message ?? ''}</Text>
              <Text bold color="yellow">
                [y] approve · [n] deny · [i] ignore
              </Text>
            </Box>
          )}

          {drive.phase === 'completed' && (
            <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
              <Text color="green" bold>
                output
              </Text>
              <Text>{JSON.stringify(drive.output ?? null, null, 2)}</Text>
            </Box>
          )}
        </Box>
      )}

      {!busy &&
        (inputFocused ? (
          <Text dimColor>type a task and press enter · esc then q to quit</Text>
        ) : (
          <Text dimColor>q to quit · esc or enter to edit the task</Text>
        ))}
    </Box>
  );
}
