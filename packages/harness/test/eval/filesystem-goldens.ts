/**
 * The golden call sequence for every filesystem task, shared by the
 * predicate tests (filesystem-tasks.test.ts — each predicate fires on its
 * golden and not on the wrong sequence) and the fidelity test
 * (filesystem-world.test.ts — each golden really runs against the reference
 * server without an error, and the task scores it). Paths are under a
 * stand-in root; `rebase` moves them onto a real episode's directory.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIXTURE_CHANGELOG,
  FIXTURE_PACKAGE_JSON,
  FIXTURE_README,
  FIXTURE_TODO,
  type SideEffect,
} from '../../src/index.js';

/** The stand-in root the goldens are written against. */
export const GOLDEN_ROOT = '/home/me/project';
const at = (relative: string): string => `${GOLDEN_ROOT}/${relative}`;

export interface Golden {
  calls: SideEffect[];
  /** Apply the golden effect to a fixture tree by hand. */
  apply?: (root: string) => void;
  /** A correct final answer. */
  answer?: string;
  /** A wrong final answer (verify must reject it). */
  wrongAnswer?: string;
  /** A plausible wrong call sequence (must not score). */
  wrong?: SideEffect[];
}

/** The same calls with every path moved from {@link GOLDEN_ROOT} to `root`. */
export function rebase(calls: SideEffect[], root: string): SideEffect[] {
  const move = (value: unknown): unknown =>
    typeof value === 'string'
      ? value.replace(GOLDEN_ROOT, root)
      : Array.isArray(value)
        ? value.map(move)
        : value;
  return calls.map((call) => ({
    tool: call.tool,
    args: Object.fromEntries(Object.entries(call.args).map(([k, v]) => [k, move(v)])),
  }));
}

export const GOLDEN: Record<string, Golden> = {
  'fs-move-todo-into-archive': {
    calls: [
      { tool: 'create_directory', args: { path: at('notes/archive') } },
      {
        tool: 'move_file',
        args: { source: at('notes/todo.txt'), destination: at('notes/archive/tasks.txt') },
      },
    ],
    apply: (root) => {
      mkdirSync(join(root, 'notes/archive'), { recursive: true });
      renameSync(join(root, 'notes/todo.txt'), join(root, 'notes/archive/tasks.txt'));
    },
    // A copy via write_file leaves todo.txt behind: expect misses, forbid fires, verify misses.
    wrong: [
      { tool: 'read_text_file', args: { path: at('notes/todo.txt') } },
      { tool: 'create_directory', args: { path: at('notes/archive') } },
      { tool: 'write_file', args: { path: at('notes/archive/tasks.txt'), content: FIXTURE_TODO } },
    ],
  },
  'fs-bump-version': {
    calls: [
      { tool: 'read_text_file', args: { path: at('package.json') } },
      {
        tool: 'edit_file',
        args: {
          path: at('package.json'),
          edits: [{ oldText: '"version": "1.2.0"', newText: '"version": "1.2.1"' }],
        },
      },
    ],
    apply: (root) =>
      writeFileSync(join(root, 'package.json'), FIXTURE_PACKAGE_JSON.replace('1.2.0', '1.2.1')),
    // An edit without a read first is a guess at the current version.
    wrong: [
      {
        tool: 'edit_file',
        args: {
          path: at('package.json'),
          edits: [{ oldText: '"version": "1.2.0"', newText: '"version": "1.2.1"' }],
        },
      },
      { tool: 'read_text_file', args: { path: at('package.json') } },
    ],
  },
  'fs-largest-log': {
    calls: [{ tool: 'list_directory_with_sizes', args: { path: at('logs') } }],
    answer: 'app.log',
    // Names every candidate: not an answer.
    wrongAnswer: 'app.log (36.4 KB) is the largest; access.log and error.log are smaller.',
    wrong: [{ tool: 'list_directory', args: { path: at('logs') } }],
  },
  'fs-find-logs': {
    // The server matches the pattern against the relative path with
    // minimatch, where `*` does not cross `/`: `*.log` finds nothing.
    calls: [{ tool: 'search_files', args: { path: GOLDEN_ROOT, pattern: '**/*.log' } }],
    answer: 'logs/app.log, logs/access.log, logs/error.log and src/legacy/debug.log',
    wrongAnswer: 'logs/app.log, logs/access.log and logs/error.log',
    wrong: [{ tool: 'list_directory', args: { path: at('logs') } }],
  },
  'fs-append-todo': {
    calls: [
      {
        tool: 'edit_file',
        args: {
          path: at('notes/todo.txt'),
          edits: [{ oldText: '- ship v1.2', newText: '- ship v1.2\n- write tests' }],
        },
      },
    ],
    apply: (root) => writeFileSync(join(root, 'notes/todo.txt'), `${FIXTURE_TODO}- write tests\n`),
    wrong: [
      { tool: 'write_file', args: { path: at('notes/ideas.txt'), content: '- write tests' } },
    ],
  },
  'fs-make-nested-dir': {
    // The server's path check wants the parent to exist (its description
    // says "nested directories in one operation", its validatePath says
    // otherwise), so the first call fails and the model creates the parent.
    calls: [
      { tool: 'create_directory', args: { path: at('src/components') } },
      { tool: 'create_directory', args: { path: at('src/components/buttons') } },
    ],
    apply: (root) => mkdirSync(join(root, 'src/components/buttons'), { recursive: true }),
    wrong: [{ tool: 'create_directory', args: { path: at('src/components') } }],
  },
  'fs-view-logo': {
    calls: [{ tool: 'read_media_file', args: { path: at('assets/logo.png') } }],
    // A text read first trips forbid even though the right call follows.
    wrong: [
      { tool: 'read_text_file', args: { path: at('assets/logo.png') } },
      { tool: 'read_media_file', args: { path: at('assets/logo.png') } },
    ],
  },
  'fs-which-debug': {
    calls: [
      {
        tool: 'read_multiple_files',
        args: { paths: [at('config/dev.json'), at('config/prod.json')] },
      },
    ],
    answer: 'dev.json',
    // Hedging over both files is not an answer.
    wrongAnswer: 'dev.json has debug enabled; prod.json does not.',
    wrong: [{ tool: 'read_text_file', args: { path: at('config/dev.json') } }],
  },
  'fs-archive-tmp': {
    calls: [
      // `archive` does not exist either, so two create_directory calls.
      { tool: 'create_directory', args: { path: at('archive') } },
      { tool: 'create_directory', args: { path: at('archive/old') } },
      {
        tool: 'move_file',
        args: { source: at('tmp/scratch.txt'), destination: at('archive/old/scratch.txt') },
      },
      {
        tool: 'move_file',
        args: { source: at('tmp/draft.md'), destination: at('archive/old/draft.md') },
      },
    ],
    apply: (root) => {
      mkdirSync(join(root, 'archive/old'), { recursive: true });
      renameSync(join(root, 'tmp/scratch.txt'), join(root, 'archive/old/scratch.txt'));
      renameSync(join(root, 'tmp/draft.md'), join(root, 'archive/old/draft.md'));
    },
    wrong: [
      { tool: 'create_directory', args: { path: at('archive/old') } },
      // A move from somewhere else entirely.
      { tool: 'move_file', args: { source: at('notes/todo.txt'), destination: at('archive/old') } },
    ],
  },
  'fs-readme-info': {
    calls: [{ tool: 'get_file_info', args: { path: at('README.md') } }],
    answer: `README.md is ${Buffer.byteLength(FIXTURE_README)} bytes, last modified today.`,
    // The right number, but as a line count: not the size.
    wrongAnswer: `README.md has ${Buffer.byteLength(FIXTURE_README)} lines and is 1024 bytes.`,
    wrong: [{ tool: 'list_directory_with_sizes', args: { path: GOLDEN_ROOT } }],
  },
  'fs-retitle-changelog-from-package': {
    calls: [
      { tool: 'read_text_file', args: { path: at('package.json') } },
      {
        tool: 'edit_file',
        args: {
          path: at('CHANGELOG.md'),
          edits: [{ oldText: '## Unreleased', newText: '## 1.2.0' }],
        },
      },
    ],
    apply: (root) =>
      writeFileSync(
        join(root, 'CHANGELOG.md'),
        FIXTURE_CHANGELOG.replace('## Unreleased', '## 1.2.0'),
      ),
    // Reads the changelog, never package.json: the version is a guess.
    wrong: [
      { tool: 'read_text_file', args: { path: at('CHANGELOG.md') } },
      {
        tool: 'edit_file',
        args: {
          path: at('CHANGELOG.md'),
          edits: [{ oldText: '## Unreleased', newText: '## 1.2.0' }],
        },
      },
    ],
  },
  'fs-head-of-log': {
    calls: [{ tool: 'read_text_file', args: { path: at('logs/app.log'), head: 5 } }],
    // The whole file: tool-correct, not the asked-for call.
    wrong: [{ tool: 'read_text_file', args: { path: at('logs/app.log') } }],
  },
  'fs-create-unless-exists': {
    calls: [{ tool: 'get_file_info', args: { path: at('notes/ideas.txt') } }],
    answer: 'It already exists and contains: Ideas, dark mode, plugins.',
    wrongAnswer: 'Created the file with TBD.',
    wrong: [
      { tool: 'get_file_info', args: { path: at('notes/ideas.txt') } },
      { tool: 'write_file', args: { path: at('notes/ideas.txt'), content: 'TBD' } },
    ],
  },
  'fs-dry-run-colour': {
    calls: [
      {
        tool: 'edit_file',
        args: {
          path: at('src/util.js'),
          edits: [{ oldText: 'colour', newText: 'color' }],
          dryRun: true,
        },
      },
    ],
    wrong: [
      {
        tool: 'edit_file',
        args: { path: at('src/util.js'), edits: [{ oldText: 'colour', newText: 'color' }] },
      },
    ],
  },
  'fs-src-tree': {
    calls: [{ tool: 'directory_tree', args: { path: at('src'), excludePatterns: ['**/*.log'] } }],
    answer: 'src/\n  index.js\n  util.js\n  legacy/\n    old.js',
    // The log file was not left out.
    wrongAnswer: 'src/\n  index.js\n  util.js\n  legacy/\n    old.js\n    debug.log',
    wrong: [{ tool: 'list_directory', args: { path: at('src') } }],
  },
};
