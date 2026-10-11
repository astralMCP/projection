/**
 * Filesystem-tier predicates: each task fires on its golden upstream calls
 * and stays quiet on nothing or on the right tool with empty arguments;
 * `forbid` catches the wrong write; and `verify` is exercised against a
 * real fixture tree — the golden effect applied by hand passes, the
 * untouched tree (or a wrong answer) fails.
 */

import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FILESYSTEM_TASKS,
  FIXTURE_CHANGELOG,
  FIXTURE_PACKAGE_JSON,
  FIXTURE_README,
  FIXTURE_TODO,
  promptFor,
  worldOf,
  writeFilesystemFixture,
  type EvalTask,
  type SideEffect,
} from '../../src/index.js';

const R = '/home/me/project';
const at = (relative: string): string => `${R}/${relative}`;

function task(name: string): EvalTask {
  const found = FILESYSTEM_TASKS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no task ${name}`);
  return found;
}

/** `success` before verify: expect holds and nothing forbidden was called. */
function scores(t: EvalTask, calls: SideEffect[]): boolean {
  const forbid = t.forbid;
  return t.expect(calls) && !(forbid !== undefined && calls.some((c) => forbid(c)));
}

interface Golden {
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

const GOLDEN: Record<string, Golden> = {
  'fs-rename-todo': {
    calls: [
      {
        tool: 'move_file',
        args: { source: at('notes/todo.txt'), destination: at('notes/tasks.txt') },
      },
    ],
    apply: (root) => renameSync(join(root, 'notes/todo.txt'), join(root, 'notes/tasks.txt')),
    // A copy via write_file leaves todo.txt behind: expect misses, verify misses.
    wrong: [
      { tool: 'read_text_file', args: { path: at('notes/todo.txt') } },
      { tool: 'write_file', args: { path: at('notes/tasks.txt'), content: FIXTURE_TODO } },
    ],
  },
  'fs-bump-version': {
    calls: [
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
    wrong: [{ tool: 'edit_file', args: { path: at('package.json'), edits: [], dryRun: true } }],
  },
  'fs-largest-log': {
    calls: [{ tool: 'list_directory_with_sizes', args: { path: at('logs') } }],
    answer: 'The largest file is app.log (36.4 KB).',
    wrongAnswer: 'The largest file is error.log.',
    wrong: [{ tool: 'list_directory', args: { path: at('logs') } }],
  },
  'fs-find-logs': {
    calls: [{ tool: 'search_files', args: { path: R, pattern: '*.log' } }],
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
    calls: [{ tool: 'create_directory', args: { path: at('src/components/buttons') } }],
    apply: (root) => mkdirSync(join(root, 'src/components/buttons'), { recursive: true }),
    wrong: [{ tool: 'create_directory', args: { path: at('src/components') } }],
  },
  'fs-view-logo': {
    calls: [{ tool: 'read_media_file', args: { path: at('assets/logo.png') } }],
    wrong: [{ tool: 'read_text_file', args: { path: at('assets/logo.png') } }],
  },
  'fs-which-debug': {
    calls: [
      {
        tool: 'read_multiple_files',
        args: { paths: [at('config/dev.json'), at('config/prod.json')] },
      },
    ],
    answer: 'dev.json has debug enabled; prod.json does not.',
    wrongAnswer: 'Only the production config has it on.',
    wrong: [{ tool: 'read_text_file', args: { path: at('config/dev.json') } }],
  },
  'fs-archive-tmp': {
    calls: [
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
    wrong: [{ tool: 'create_directory', args: { path: at('archive/old') } }],
  },
  'fs-readme-info': {
    calls: [{ tool: 'get_file_info', args: { path: at('README.md') } }],
    answer: `README.md is ${Buffer.byteLength(FIXTURE_README)} bytes, last modified today.`,
    wrongAnswer: 'README.md is 1024 bytes.',
    wrong: [{ tool: 'read_text_file', args: { path: at('README.md') } }],
  },
  'fs-retitle-changelog': {
    calls: [
      {
        tool: 'edit_file',
        args: {
          path: at('CHANGELOG.md'),
          edits: [{ oldText: '## Unreleased', newText: '## 1.2.1' }],
        },
      },
    ],
    apply: (root) =>
      writeFileSync(
        join(root, 'CHANGELOG.md'),
        FIXTURE_CHANGELOG.replace('## Unreleased', '## 1.2.1'),
      ),
    wrong: [{ tool: 'edit_file', args: { path: at('README.md'), edits: [] } }],
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
    calls: [{ tool: 'directory_tree', args: { path: at('src') } }],
    answer: 'src/\n  index.js\n  util.js\n  legacy/\n    old.js\n    debug.log',
    wrongAnswer: 'src/\n  index.js\n  util.js\n  legacy/',
    wrong: [{ tool: 'list_directory', args: { path: at('src') } }],
  },
};

describe('filesystem tasks', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fs-tasks-'));
    writeFilesystemFixture(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('has 15 tasks in the filesystem tier, each with a golden', () => {
    expect(FILESYSTEM_TASKS).toHaveLength(15);
    expect(FILESYSTEM_TASKS.every((t) => t.tier === 'filesystem')).toBe(true);
    expect(worldOf('filesystem')).toBe('filesystem');
    expect(Object.keys(GOLDEN).toSorted()).toEqual(FILESYSTEM_TASKS.map((t) => t.name).toSorted());
    for (const t of FILESYSTEM_TASKS) expect(promptFor(t, { root: R })).toContain(R);
  });

  for (const t of FILESYSTEM_TASKS) {
    const golden = GOLDEN[t.name] as Golden;

    it(`${t.name}: fires on the golden calls, not on nothing, not on the wrong sequence`, () => {
      expect(t.expect([])).toBe(false);
      expect(scores(t, golden.calls)).toBe(true);
      for (const group of t.steps) {
        expect(golden.calls.some((call) => group.includes(call.tool))).toBe(true);
      }
      expect(
        scores(
          t,
          golden.calls.map((call) => ({ tool: call.tool, args: {} })),
        ),
      ).toBe(false);
      if (golden.wrong !== undefined) expect(scores(t, golden.wrong)).toBe(false);
      // Relative paths match too.
      const relative = golden.calls.map((call) => ({
        tool: call.tool,
        args: Object.fromEntries(
          Object.entries(call.args).map(([k, v]) => [
            k,
            typeof v === 'string' ? v.replace(`${R}/`, '').replace(R, '.') : v,
          ]),
        ),
      }));
      expect(scores(t, relative)).toBe(true);
    });

    if (t.verify !== undefined) {
      const verify = t.verify.bind(t);
      it(`${t.name}: verify accepts the golden end state and rejects the untouched one`, async () => {
        const context = (finalText: string) => ({
          calls: golden.calls,
          finalText,
          facts: { root },
        });
        if (golden.apply !== undefined) {
          expect(await verify(context(golden.answer ?? ''))).toBe(false);
          golden.apply(root);
        }
        expect(await verify(context(golden.answer ?? ''))).toBe(true);
        if (golden.wrongAnswer !== undefined) {
          expect(await verify(context(golden.wrongAnswer))).toBe(false);
        }
      });
    }
  }

  it('fs-dry-run-colour and fs-create-unless-exists: verify rejects a mutated tree', async () => {
    writeFileSync(join(root, 'src/util.js'), 'export const defaultColor = "blue";\n');
    writeFileSync(join(root, 'notes/ideas.txt'), 'TBD');
    const facts = { root };
    expect(await task('fs-dry-run-colour').verify?.({ calls: [], finalText: '', facts })).toBe(
      false,
    );
    expect(
      await task('fs-create-unless-exists').verify?.({ calls: [], finalText: 'dark mode', facts }),
    ).toBe(false);
  });
});
