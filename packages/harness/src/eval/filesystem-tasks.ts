/**
 * The filesystem tier: 15 tasks against the real filesystem reference
 * server (filesystem-world.ts), phrased for a user who knows their project
 * directory and nothing about the server's tools.
 *
 * Built to discriminate between the server's near-duplicate tools and
 * between argument choices: a rename (`move_file`, never read-then-write);
 * a one-line change (`edit_file`, or a `write_file` that preserves every
 * other byte); a size question (`list_directory_with_sizes` /
 * `get_file_info`); a recursive search where a flat listing misses a nested
 * file; an image (`read_media_file`, not a text read); `head` to read only
 * the first lines of a large log; a conditional create that must NOT happen
 * because the file exists; a `dryRun` edit that must leave the file alone;
 * a multi-step move into a directory that has to be created first.
 *
 * Every task's `expect` scores the recorded calls; mutation tasks also
 * `verify` the tree on disk, and question tasks verify the answer names
 * the right thing. Paths are matched by suffix (`…/notes/todo.txt`), so a
 * model that passes the absolute path and one that resolves relative to
 * the root both match.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SideEffect } from '../types.js';
import {
  FIXTURE_CHANGELOG,
  FIXTURE_IDEAS,
  FIXTURE_PACKAGE_JSON,
  FIXTURE_README,
  FIXTURE_TODO,
  FIXTURE_UTIL_JS,
} from './filesystem-world.js';
import {
  containsText,
  has,
  sameNumber,
  str,
  type Args,
  type EvalTask,
  type VerifyContext,
} from './task-core.js';

/** Slashes normalized, trailing slash and `./` dropped. */
function normalizePath(value: unknown): string | undefined {
  const raw = str(value);
  if (raw === undefined) return undefined;
  const slashes = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return slashes.startsWith('./') ? slashes.slice(2) : slashes;
}

/** The value names `relative` (a file or directory under the root), absolute or relative. */
function pathIs(value: unknown, relative: string): boolean {
  const path = normalizePath(value);
  return path !== undefined && (path === relative || path.endsWith(`/${relative}`));
}

/** The value names `relative` or something inside it. */
function pathWithin(value: unknown, relative: string): boolean {
  const path = normalizePath(value);
  return (
    path !== undefined &&
    (pathIs(path, relative) || path.startsWith(`${relative}/`) || path.includes(`/${relative}/`))
  );
}

/** Any entry of `paths` (read_multiple_files) names `relative`. */
function pathsInclude(value: unknown, relative: string): boolean {
  return Array.isArray(value) && value.some((item) => pathIs(item, relative));
}

function readText(root: string, relative: string): string | undefined {
  try {
    return readFileSync(join(root, relative), 'utf8');
  } catch {
    return undefined;
  }
}

/** Equal up to a missing or extra final newline. */
function sameContent(actual: string | undefined, expected: string): boolean {
  return actual !== undefined && actual.replace(/\n$/, '') === expected.replace(/\n$/, '');
}

function root(context: VerifyContext): string {
  const value = context.facts.root;
  if (value === undefined) throw new Error('filesystem task verified without a root');
  return value;
}

/** The tools that can read a file's contents or metadata. */
const READ_TOOLS = [
  'read_text_file',
  'read_file',
  'read_multiple_files',
  'get_file_info',
  'list_directory',
  'list_directory_with_sizes',
  'directory_tree',
  'search_files',
];

/** A tool that changes the tree, aimed at `relative`. */
function mutates(call: SideEffect, relative: string): boolean {
  switch (call.tool) {
    case 'write_file':
      return pathIs(call.args['path'], relative);
    case 'edit_file':
      return pathIs(call.args['path'], relative) && call.args['dryRun'] !== true;
    case 'move_file':
      return pathIs(call.args['source'], relative) || pathIs(call.args['destination'], relative);
    default:
      return false;
  }
}

/**
 * The model looked before leaping: read `relative`, listed its `directory`,
 * or walked/searched the tree (which shows the file either way).
 */
function looksAt(calls: SideEffect[], relative: string, directory: string): boolean {
  return calls.some(
    (call) =>
      call.tool === 'directory_tree' ||
      call.tool === 'search_files' ||
      (READ_TOOLS.includes(call.tool) &&
        (pathIs(call.args['path'], relative) ||
          pathsInclude(call.args['paths'], relative) ||
          pathIs(call.args['path'], directory))),
  );
}

const EDIT_TOOLS = ['edit_file', 'write_file'];

function editsFile(args: Args, relative: string): boolean {
  return pathIs(args['path'], relative) && args['dryRun'] !== true;
}

const LOG_FILES = ['app.log', 'access.log', 'error.log', 'debug.log'];

export const FILESYSTEM_TASKS: readonly EvalTask[] = [
  // --- Rename: move_file, not read + write (there is no delete tool, so a
  // copy leaves the original behind and verify catches it).
  {
    name: 'fs-rename-todo',
    tier: 'filesystem',
    kind: 'single',
    prompt: (facts) => `In my project at ${facts.root}, rename notes/todo.txt to notes/tasks.txt.`,
    steps: [['move_file']],
    expect: (calls) =>
      has(
        calls,
        'move_file',
        (args) =>
          pathIs(args['source'], 'notes/todo.txt') &&
          pathIs(args['destination'], 'notes/tasks.txt'),
      ),
    verify: (context) =>
      sameContent(readText(root(context), 'notes/tasks.txt'), FIXTURE_TODO) &&
      !existsSync(join(root(context), 'notes/todo.txt')),
  },
  // --- One-line change: edit_file, or a write_file that keeps every other byte.
  {
    name: 'fs-bump-version',
    tier: 'filesystem',
    kind: 'single',
    prompt: (facts) =>
      `In ${facts.root}/package.json, bump the version from 1.2.0 to 1.2.1. Change nothing else.`,
    steps: [EDIT_TOOLS],
    expect: (calls) => has(calls, EDIT_TOOLS, (args) => editsFile(args, 'package.json')),
    verify: (context) =>
      sameContent(
        readText(root(context), 'package.json'),
        FIXTURE_PACKAGE_JSON.replace('1.2.0', '1.2.1'),
      ),
  },
  // --- Sizes: a plain listing has no sizes; list_directory_with_sizes or
  // get_file_info per file does.
  {
    name: 'fs-largest-log',
    tier: 'filesystem',
    kind: 'single',
    prompt: (facts) => `Which file in ${facts.root}/logs is the largest? Tell me its name.`,
    steps: [['list_directory_with_sizes', 'get_file_info']],
    expect: (calls) =>
      has(calls, 'list_directory_with_sizes', (args) => pathIs(args['path'], 'logs')) ||
      has(calls, 'get_file_info', (args) => pathIs(args['path'], 'logs/app.log')),
    verify: (context) =>
      /app\.log/i.test(context.finalText) &&
      !/(access|error)\.log is the largest/i.test(context.finalText),
  },
  // --- Recursive search: logs/ holds three, src/legacy/debug.log is the
  // fourth that a flat listing of logs/ misses.
  {
    name: 'fs-find-logs',
    tier: 'filesystem',
    kind: 'single',
    prompt: (facts) =>
      `List every .log file anywhere in my project at ${facts.root}, including subfolders.`,
    steps: [['search_files', 'directory_tree']],
    expect: (calls) =>
      has(calls, 'search_files', (args) => containsText(args['pattern'], 'log')) ||
      has(calls, 'directory_tree', () => true),
    verify: (context) => LOG_FILES.every((name) => context.finalText.includes(name)),
  },
  // --- Append a line.
  {
    name: 'fs-append-todo',
    tier: 'filesystem',
    kind: 'single',
    prompt: (facts) => `Add the line "- write tests" at the end of ${facts.root}/notes/todo.txt.`,
    steps: [EDIT_TOOLS],
    expect: (calls) => has(calls, EDIT_TOOLS, (args) => editsFile(args, 'notes/todo.txt')),
    verify: (context) =>
      sameContent(readText(root(context), 'notes/todo.txt'), `${FIXTURE_TODO}- write tests\n`),
  },
  // --- Nested directory in one call.
  {
    name: 'fs-make-nested-dir',
    tier: 'filesystem',
    kind: 'single',
    prompt: (facts) => `Create the folder src/components/buttons in my project at ${facts.root}.`,
    steps: [['create_directory']],
    expect: (calls) =>
      has(calls, 'create_directory', (args) => pathIs(args['path'], 'src/components/buttons')),
    verify: (context) => {
      try {
        return statSync(join(root(context), 'src/components/buttons')).isDirectory();
      } catch {
        return false;
      }
    },
  },
  // --- An image is not text.
  {
    name: 'fs-view-logo',
    tier: 'filesystem',
    kind: 'single',
    prompt: (facts) => `Show me the image at ${facts.root}/assets/logo.png.`,
    steps: [['read_media_file']],
    expect: (calls) =>
      has(calls, 'read_media_file', (args) => pathIs(args['path'], 'assets/logo.png')),
  },
  // --- Two files, one question: read_multiple_files, or two reads.
  {
    name: 'fs-which-debug',
    tier: 'filesystem',
    kind: 'single',
    prompt: (facts) =>
      `Which of ${facts.root}/config/dev.json and ${facts.root}/config/prod.json has debug enabled?`,
    steps: [['read_multiple_files', 'read_text_file', 'read_file']],
    expect: (calls) => {
      const read = (relative: string): boolean =>
        has(calls, ['read_text_file', 'read_file'], (args) => pathIs(args['path'], relative)) ||
        has(calls, 'read_multiple_files', (args) => pathsInclude(args['paths'], relative));
      return read('config/dev.json') && read('config/prod.json');
    },
    verify: (context) => /dev\.json|\bdev\b/i.test(context.finalText),
  },
  // --- Multi-step: the destination has to exist before the moves.
  {
    name: 'fs-archive-tmp',
    tier: 'filesystem',
    kind: 'multi',
    prompt: (facts) =>
      `Move everything inside ${facts.root}/tmp into ${facts.root}/archive/old (create that folder if it does not exist).`,
    steps: [['create_directory', 'move_file'], ['move_file']],
    expect: (calls) => has(calls, 'move_file', (args) => pathWithin(args['source'], 'tmp')),
    verify: (context) => {
      const base = root(context);
      const moved =
        sameContent(readText(base, 'archive/old/scratch.txt'), 'scratch\n') &&
        sameContent(readText(base, 'archive/old/draft.md'), '# Draft\n');
      let tmpLeft: string[] = [];
      try {
        tmpLeft = readdirSync(join(base, 'tmp'));
      } catch {
        tmpLeft = [];
      }
      return moved && tmpLeft.length === 0;
    },
  },
  // --- Metadata: size in bytes and mtime come from get_file_info.
  {
    name: 'fs-readme-info',
    tier: 'filesystem',
    kind: 'single',
    prompt: (facts) =>
      `How big is ${facts.root}/README.md in bytes, and when was it last modified?`,
    steps: [['get_file_info', 'list_directory_with_sizes']],
    expect: (calls) =>
      has(calls, 'get_file_info', (args) => pathIs(args['path'], 'README.md')) ||
      has(calls, 'list_directory_with_sizes', (args) => normalizePath(args['path']) !== undefined),
    verify: (context) =>
      context.finalText.includes(String(Buffer.byteLength(FIXTURE_README, 'utf8'))),
  },
  // --- Retitle a heading.
  {
    name: 'fs-retitle-changelog',
    tier: 'filesystem',
    kind: 'single',
    prompt: (facts) =>
      `In ${facts.root}/CHANGELOG.md, change the heading "## Unreleased" to "## 1.2.1".`,
    steps: [EDIT_TOOLS],
    expect: (calls) => has(calls, EDIT_TOOLS, (args) => editsFile(args, 'CHANGELOG.md')),
    verify: (context) =>
      sameContent(
        readText(root(context), 'CHANGELOG.md'),
        FIXTURE_CHANGELOG.replace('## Unreleased', '## 1.2.1'),
      ),
  },
  // --- Argument choice: `head` reads five lines of a 36 KB log; reading the
  // whole file is tool-correct but not the asked-for call.
  {
    name: 'fs-head-of-log',
    tier: 'filesystem',
    kind: 'single',
    prompt: (facts) => `Show me just the first 5 lines of ${facts.root}/logs/app.log.`,
    steps: [['read_text_file', 'read_file']],
    expect: (calls) =>
      has(
        calls,
        ['read_text_file', 'read_file'],
        (args) => pathIs(args['path'], 'logs/app.log') && sameNumber(args['head'], 5),
      ),
  },
  // --- Conditional create that must NOT happen: the file exists.
  {
    name: 'fs-create-unless-exists',
    tier: 'filesystem',
    kind: 'single',
    prompt: (facts) =>
      `Create ${facts.root}/notes/ideas.txt containing just "TBD" — unless it already exists, in which case leave it alone and tell me what is in it.`,
    steps: [READ_TOOLS],
    expect: (calls) => looksAt(calls, 'notes/ideas.txt', 'notes'),
    forbid: (call) => mutates(call, 'notes/ideas.txt'),
    verify: (context) =>
      sameContent(readText(root(context), 'notes/ideas.txt'), FIXTURE_IDEAS) &&
      /dark mode/i.test(context.finalText),
  },
  // --- Preview, do not apply: edit_file with dryRun (or a read and a
  // hand-made diff); any real edit is a failure.
  {
    name: 'fs-dry-run-colour',
    tier: 'filesystem',
    kind: 'single',
    prompt: (facts) =>
      `In ${facts.root}/src/util.js, show me what would change if every "colour" became "color" — but do not modify the file.`,
    steps: [['edit_file', 'read_text_file', 'read_file']],
    expect: (calls) =>
      has(
        calls,
        'edit_file',
        (args) => pathIs(args['path'], 'src/util.js') && args['dryRun'] === true,
      ) ||
      has(calls, ['read_text_file', 'read_file'], (args) => pathIs(args['path'], 'src/util.js')),
    forbid: (call) => mutates(call, 'src/util.js'),
    verify: (context) => sameContent(readText(root(context), 'src/util.js'), FIXTURE_UTIL_JS),
  },
  // --- A tree, not a flat listing (or flat listings of every level).
  {
    name: 'fs-src-tree',
    tier: 'filesystem',
    kind: 'single',
    prompt: (facts) => `Give me a tree view of everything under ${facts.root}/src.`,
    steps: [['directory_tree', 'list_directory']],
    expect: (calls) =>
      has(calls, 'directory_tree', (args) => pathIs(args['path'], 'src')) ||
      (has(calls, 'list_directory', (args) => pathIs(args['path'], 'src')) &&
        has(calls, 'list_directory', (args) => pathIs(args['path'], 'src/legacy'))),
    verify: (context) =>
      ['index.js', 'util.js', 'old.js', 'debug.log'].every((name) =>
        context.finalText.includes(name),
      ),
  },
];
