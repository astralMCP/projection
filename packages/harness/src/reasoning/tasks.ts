/**
 * The benchmark task suite (PRD §13: "scripted task prompts"), phrased
 * against the file-server fixture. Each task states WHAT to do, never HOW
 * to author the machine — the API docs carry that — so the suite measures
 * authoring, not prompt-following.
 */

import type { ScenarioResult } from '../types.js';
import type { BenchmarkTask } from './loop.js';

function wrote(result: ScenarioResult, path: string): boolean {
  return result.sideEffects.some((e) => e.tool === 'write_file' && e.args['path'] === path);
}

/** Tasks against `createFileServer({ '/notes.txt': ..., '/todo.txt': ... })`. */
export const FILE_SERVER_TASKS: readonly BenchmarkTask[] = [
  {
    name: 'read-one-file',
    prompt: 'Read the file at /notes.txt and return its contents as { text }.',
    expect: (result) =>
      result.rounds === 0 && result.sideEffects.some((e) => e.tool === 'read_file'),
  },
  {
    name: 'list-then-read',
    prompt:
      'List the files on the server, then read the first path in the list and return { path, text }.',
    expect: (result) => result.sideEffects.some((e) => e.tool === 'list_files'),
  },
  {
    name: 'write-with-approval',
    prompt:
      'Write the content "hello from the benchmark" to /out.txt and return { status: "written" } once done. If the user declines the write, return { status: "declined" } instead of failing.',
    expect: (result) => result.rounds >= 1 && wrote(result, '/out.txt'),
  },
  {
    name: 'read-modify-write',
    prompt:
      'Read /todo.txt, append the line "- ship benchmark" to its contents, and write the result back to /todo.txt. Return { status } describing what happened, handling a declined write gracefully.',
    expect: (result) =>
      result.sideEffects.some((e) => e.tool === 'read_file') && wrote(result, '/todo.txt'),
  },
];

/** Initial files the suite's tasks assume. */
export const FILE_SERVER_FIXTURE: Record<string, string> = {
  '/notes.txt': 'benchmark notes',
  '/todo.txt': '- existing item',
};
