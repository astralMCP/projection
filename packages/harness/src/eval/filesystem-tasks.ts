/**
 * The filesystem tier: 15 tasks against the real filesystem reference
 * server (filesystem-world.ts), phrased for a user who knows their project
 * directory and nothing about the server's tools.
 *
 * Built to discriminate between the server's near-duplicate tools and
 * between argument choices: a move into a directory that does not exist yet
 * (`move_file` after `create_directory`, never read-then-write); a one-line
 * change that needs a read first (`edit_file`, or a `write_file` that
 * preserves every other byte); a size question (`list_directory_with_sizes`
 * / `get_file_info`); a recursive search where a flat listing misses a
 * nested file; an image (`read_media_file`, not a text read); `head` to
 * read only the first lines of a large log; a conditional create that must
 * NOT happen because the file exists; a `dryRun` edit that must leave the
 * file alone; a multi-step move into a directory that has to be created
 * first.
 *
 * Every task's `expect` scores the recorded calls; mutation tasks also
 * `verify` the tree on disk, and question tasks verify the answer names
 * the right thing (and only the right thing — the prompts ask for just the
 * file name so a hedge that lists every candidate does not pass). Paths are
 * matched by suffix (`…/notes/todo.txt`), so a model that passes the
 * absolute path and one that resolves relative to the root both match.
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
import { find, has, str, type Args, type EvalTask, type VerifyContext } from './task-core.js';

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

/** The value names some path at all (the right tool with no arguments is not a hit). */
function anyPath(args: Args): boolean {
  return normalizePath(args['path']) !== undefined;
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

/** The tools that show a file's contents. */
const FILE_READ_TOOLS = ['read_text_file', 'read_file', 'read_multiple_files'];

/** The tools that can read a file's contents or metadata. */
const READ_TOOLS = [
  ...FILE_READ_TOOLS,
  'get_file_info',
  'list_directory',
  'list_directory_with_sizes',
  'directory_tree',
  'search_files',
];

/** The tools that list a directory flat (`directory_tree` recurses). */
const FLAT_LISTINGS = ['list_directory', 'list_directory_with_sizes'];

/** A call to one of `FILE_READ_TOOLS` that shows `relative`. */
function readsFile(args: Args, relative: string): boolean {
  return pathIs(args['path'], relative) || pathsInclude(args['paths'], relative);
}

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

/**
 * A read of `source` happened before the first edit/write of `target`: the
 * model cannot know the current text (or the value it is copying) without
 * one, so an edit that comes first is a guess.
 */
function readThenEdits(calls: SideEffect[], source: string, target: string): boolean {
  const read = find(calls, FILE_READ_TOOLS, (args) => readsFile(args, source));
  const edit = find(calls, EDIT_TOOLS, (args) => editsFile(args, target));
  return read >= 0 && edit > read;
}

/**
 * A line of the answer that lists debug.log as a tree or list entry: only
 * tree-drawing characters, bullets, a list number or a table bar before a
 * path ending in it (`│   ├── debug.log`, `- legacy/debug.log`,
 * `1. debug.log`, `    debug.log`). A mention inside prose —
 * "(debug.log was excluded)", "I left out debug.log" — is not an entry.
 */
const LISTS_DEBUG_LOG = /^[ \t│├└─┬┼╰|*+>-]*(?:\d+[.)][ \t]+)?[^\s(]*debug\.log/m;

const LOG_FILES = ['app.log', 'access.log', 'error.log', 'debug.log'];

export const FILESYSTEM_TASKS: readonly EvalTask[] = [
  // --- Move into a directory that does not exist: the server rejects the
  // move until `create_directory` has run, so this takes two calls and a
  // recovery from an isError. Not read + write (there is no delete tool, so
  // a copy leaves the original behind and verify catches it).
  {
    name: 'fs-move-todo-into-archive',
    tier: 'filesystem',
    kind: 'multi',
    needsWorld: true,
    prompt: (facts) =>
      `In my project at ${facts.root}, move notes/todo.txt to notes/archive/tasks.txt.`,
    steps: [['create_directory', 'move_file'], ['move_file']],
    expect: (calls) =>
      has(
        calls,
        'move_file',
        (args) =>
          pathIs(args['source'], 'notes/todo.txt') &&
          pathIs(args['destination'], 'notes/archive/tasks.txt'),
      ),
    forbid: (call) =>
      call.tool === 'write_file' && pathIs(call.args['path'], 'notes/archive/tasks.txt'),
    verify: (context) =>
      sameContent(readText(root(context), 'notes/archive/tasks.txt'), FIXTURE_TODO) &&
      !existsSync(join(root(context), 'notes/todo.txt')),
  },
  // --- One-line change: the prompt does not say the current version, so
  // the file has to be read first; then edit_file, or a write_file that
  // keeps every other byte.
  {
    name: 'fs-bump-version',
    tier: 'filesystem',
    kind: 'single',
    needsWorld: true,
    prompt: (facts) =>
      `The version in ${facts.root}/package.json is out of date — bump the patch number. Change nothing else.`,
    steps: [FILE_READ_TOOLS, EDIT_TOOLS],
    expect: (calls) => readThenEdits(calls, 'package.json', 'package.json'),
    verify: (context) =>
      sameContent(
        readText(root(context), 'package.json'),
        FIXTURE_PACKAGE_JSON.replace('1.2.0', '1.2.1'),
      ),
  },
  // --- Sizes: a plain listing has no sizes; list_directory_with_sizes or
  // get_file_info per file does. The answer must name app.log alone: a
  // model that lists all three files has not answered.
  {
    name: 'fs-largest-log',
    tier: 'filesystem',
    kind: 'single',
    prompt: (facts) =>
      `Which file in ${facts.root}/logs is the largest? Answer with just the file name.`,
    steps: [['list_directory_with_sizes', 'get_file_info']],
    expect: (calls) =>
      has(calls, 'list_directory_with_sizes', (args) => pathIs(args['path'], 'logs')) ||
      has(calls, 'get_file_info', (args) => pathIs(args['path'], 'logs/app.log')),
    verify: (context) =>
      /app\.log/i.test(context.finalText) && !/(access|error)\.log/i.test(context.finalText),
  },
  // --- Recursive search: logs/ holds three, src/legacy/debug.log is the
  // fourth that a flat listing of logs/ misses. Any recursive call counts
  // (the server's `*` does not cross `/`, so the pattern is the model's
  // problem — verify checks it found all four); so does a flat listing of
  // src/legacy, which only a model that walked the tree would make.
  {
    name: 'fs-find-logs',
    tier: 'filesystem',
    kind: 'single',
    prompt: (facts) =>
      `List every .log file anywhere in my project at ${facts.root}, including subfolders.`,
    steps: [['search_files', 'directory_tree', ...FLAT_LISTINGS]],
    expect: (calls) =>
      has(calls, 'search_files', (args) => str(args['pattern']) !== undefined) ||
      has(calls, 'directory_tree', anyPath) ||
      has(calls, FLAT_LISTINGS, (args) => pathIs(args['path'], 'src/legacy')),
    verify: (context) => LOG_FILES.every((name) => context.finalText.includes(name)),
  },
  // --- Append a line.
  {
    name: 'fs-append-todo',
    tier: 'filesystem',
    kind: 'single',
    needsWorld: true,
    prompt: (facts) => `Add the line "- write tests" at the end of ${facts.root}/notes/todo.txt.`,
    steps: [EDIT_TOOLS],
    expect: (calls) => has(calls, EDIT_TOOLS, (args) => editsFile(args, 'notes/todo.txt')),
    verify: (context) =>
      sameContent(readText(root(context), 'notes/todo.txt'), `${FIXTURE_TODO}- write tests\n`),
  },
  // --- Nested directory. The description promises nested creation in one
  // call, but the server's path check rejects a path whose parent does not
  // exist, so the honest route is an isError, then the parent, then the
  // target; `expect` only insists the target itself was created.
  {
    name: 'fs-make-nested-dir',
    tier: 'filesystem',
    kind: 'multi',
    needsWorld: true,
    prompt: (facts) => `Create the folder src/components/buttons in my project at ${facts.root}.`,
    steps: [['create_directory']],
    expect: (calls) =>
      has(calls, 'create_directory', (args) => pathIs(args['path'], 'src/components/buttons')),
    verify: (context) => {
      // Outside the try: an unset `facts.root` is a harness error, not a miss.
      const target = join(root(context), 'src/components/buttons');
      try {
        return statSync(target).isDirectory();
      } catch {
        return false;
      }
    },
  },
  // --- An image is not text. This measures the first choice: a text read
  // of the PNG fails the episode even when read_media_file follows.
  {
    name: 'fs-view-logo',
    tier: 'filesystem',
    kind: 'single',
    prompt: (facts) => `Show me the image at ${facts.root}/assets/logo.png.`,
    steps: [['read_media_file']],
    expect: (calls) =>
      has(calls, 'read_media_file', (args) => pathIs(args['path'], 'assets/logo.png')),
    forbid: (call) =>
      FILE_READ_TOOLS.includes(call.tool) && readsFile(call.args, 'assets/logo.png'),
  },
  // --- Two files, one question: read_multiple_files, or two reads. BOTH
  // files must be read — dev.json alone shows debug on, but the question
  // is which of the two has it, and prod.json might too; a model that
  // reads one and answers has guessed. The answer must name dev.json and
  // not prod.json.
  {
    name: 'fs-which-debug',
    tier: 'filesystem',
    kind: 'single',
    prompt: (facts) =>
      `Which of ${facts.root}/config/dev.json and ${facts.root}/config/prod.json has debug enabled? Answer with just the file name.`,
    steps: [FILE_READ_TOOLS],
    expect: (calls) => {
      const read = (relative: string): boolean =>
        has(calls, FILE_READ_TOOLS, (args) => readsFile(args, relative));
      return read('config/dev.json') && read('config/prod.json');
    },
    verify: (context) =>
      /dev\.json/i.test(context.finalText) && !/prod\.json/i.test(context.finalText),
  },
  // --- Multi-step: the destination has to exist before the moves. A move
  // of either file, or of the whole directory, counts; verify settles
  // whether everything arrived.
  {
    name: 'fs-archive-tmp',
    tier: 'filesystem',
    kind: 'multi',
    needsWorld: true,
    prompt: (facts) =>
      `Move everything inside ${facts.root}/tmp into ${facts.root}/archive/old (create that folder if it does not exist).`,
    steps: [['create_directory', 'move_file'], ['move_file']],
    expect: (calls) =>
      has(
        calls,
        'move_file',
        (args) =>
          pathIs(args['source'], 'tmp/scratch.txt') ||
          pathIs(args['source'], 'tmp/draft.md') ||
          pathIs(args['source'], 'tmp'),
      ),
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
  // --- Metadata: size in bytes and mtime come from get_file_info (a sized
  // listing has the bytes but not the mtime). The answer must give the
  // byte count as a byte count, not as a line number or a stray digit run.
  {
    name: 'fs-readme-info',
    tier: 'filesystem',
    kind: 'single',
    prompt: (facts) =>
      `How big is ${facts.root}/README.md in bytes, and when was it last modified?`,
    steps: [['get_file_info']],
    expect: (calls) => has(calls, 'get_file_info', (args) => pathIs(args['path'], 'README.md')),
    verify: (context) =>
      new RegExp(`\\b${Buffer.byteLength(FIXTURE_README, 'utf8')}\\s*(bytes?|B)\\b`, 'i').test(
        context.finalText,
      ),
  },
  // --- Retitle a heading with a value from another file: package.json
  // has to be read before CHANGELOG.md is edited.
  {
    name: 'fs-retitle-changelog-from-package',
    tier: 'filesystem',
    kind: 'single',
    needsWorld: true,
    prompt: (facts) =>
      `In ${facts.root}/CHANGELOG.md, rename the "Unreleased" section heading to the current version from package.json.`,
    steps: [FILE_READ_TOOLS, EDIT_TOOLS],
    expect: (calls) => readThenEdits(calls, 'package.json', 'CHANGELOG.md'),
    verify: (context) =>
      sameContent(
        readText(root(context), 'CHANGELOG.md'),
        FIXTURE_CHANGELOG.replace('## Unreleased', '## 1.2.0'),
      ),
  },
  // --- Argument choice: `head` reads five lines of a 36 KB log; reading the
  // whole file is tool-correct but not the asked-for call. The server's
  // schema wants a number — a string "5" is rejected before the handler
  // runs, so it is never recorded.
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
        (args) =>
          pathIs(args['path'], 'logs/app.log') &&
          typeof args['head'] === 'number' &&
          args['head'] === 5,
      ),
  },
  // --- Conditional create that must NOT happen: the file exists.
  {
    name: 'fs-create-unless-exists',
    tier: 'filesystem',
    kind: 'single',
    needsWorld: true,
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
    needsWorld: true,
    prompt: (facts) =>
      `In ${facts.root}/src/util.js, show me what would change if every "colour" became "color" — but do not modify the file.`,
    steps: [['edit_file', ...FILE_READ_TOOLS]],
    expect: (calls) =>
      has(
        calls,
        'edit_file',
        (args) => pathIs(args['path'], 'src/util.js') && args['dryRun'] === true,
      ) || has(calls, FILE_READ_TOOLS, (args) => readsFile(args, 'src/util.js')),
    forbid: (call) => mutates(call, 'src/util.js'),
    verify: (context) => sameContent(readText(root(context), 'src/util.js'), FIXTURE_UTIL_JS),
  },
  // --- A tree, not a flat listing (or flat listings of every level). The
  // "leaving out log files" clause is the model's to honour: the server's
  // `directory_tree` `excludePatterns: ['*.log']` does not filter nested
  // files (observed: `src/legacy/debug.log` still comes back), so the model
  // has to drop it from the tree by hand. verify wants every source file
  // somewhere in the answer and debug.log on no line that reads as a tree
  // or list entry (`LISTS_DEBUG_LOG`), so a sentence saying debug.log was left
  // out does not fail an answer whose tree correctly omits it.
  {
    name: 'fs-src-tree',
    tier: 'filesystem',
    kind: 'single',
    prompt: (facts) =>
      `Give me a tree view of everything under ${facts.root}/src, leaving out log files.`,
    steps: [['directory_tree', ...FLAT_LISTINGS]],
    expect: (calls) =>
      has(calls, 'directory_tree', anyPath) ||
      (has(calls, FLAT_LISTINGS, (args) => pathIs(args['path'], 'src')) &&
        has(calls, FLAT_LISTINGS, (args) => pathIs(args['path'], 'src/legacy'))),
    verify: (context) =>
      ['index.js', 'util.js', 'old.js'].every((name) => context.finalText.includes(name)) &&
      !LISTS_DEBUG_LOG.test(context.finalText),
  },
];
