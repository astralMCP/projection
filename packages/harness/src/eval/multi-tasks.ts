/**
 * The multi tier: 17 tasks against the multi world (multi-world.ts) — the
 * GitHub fake, the real filesystem server and the real MongoDB server as
 * three boxes of one episode (`github`, `fs`, `mongo`). The world records
 * every call as `<alias>.<name>`, so the predicates here see which box a
 * call went to and in what order across boxes. The boxes a task needs are
 * the aliases its `steps` name ({@link taskBoxes}); a call into any other
 * box is a detour — a statistic (run.ts), never by itself a failure.
 *
 * Four kinds of task:
 *
 * - **Cross-box** (6): one box's output feeds another — the changelog's
 *   Unreleased entries become a GitHub issue; a shipped-order count becomes
 *   a comment; the largest log file's name becomes a document; the
 *   package version becomes a branch name; open PR titles become a file;
 *   a customer's email becomes a todo line. The write must follow the read
 *   that justified it, and must carry the value read (exact fixture values:
 *   `- Add CSV export`, 4 shipped orders, `app.log`, `1.2.0`, the four open
 *   PRs of acme/widgets — one page at GitHub's 30 — and grace@example.com).
 * - **Box choice** (4): two boxes have a similarly named tool — the
 *   project's README (filesystem) vs acme/widgets' readme (GitHub's
 *   `get_file_contents`), the project's `src` folder vs acme/widgets'.
 *   Success is the right box's read, an answer with the right box's content
 *   and none of the other's, and no write into the wrong box; a read of the
 *   wrong box is a detour, not a failure. The same rule holds in both
 *   directions. The project prompts give no path: the filesystem box's
 *   allowed directory is the project.
 * - **Global** (4): a question whose prompt does not say which box holds
 *   the answer — the project's version and whether acme/widgets has a
 *   release branch for it (fs, then github), who grace@example.com is and
 *   the status of her order (mongo), whether CSV export is released yet
 *   (the project's changelog), the last request id in app.log (fs). Where
 *   a model looks first is what a global search can help with. Graded on
 *   the answer (`verify`) and on having consulted the boxes that hold it;
 *   any write fails (the prompts ask questions).
 * - **Single-box controls** (3): one task per box copied verbatim from its
 *   single-server tier (prompt, predicates, verify), so a drop in the multi
 *   tier can be split between routing across boxes and the task itself.
 *   Two of them are halves of cross-box tasks (`db-count-shipped`,
 *   `fs-largest-log`).
 */

import type { SideEffect } from '../types.js';
import {
  EDIT_TOOLS,
  editsFile,
  FILE_READ_TOOLS,
  FILESYSTEM_TASKS,
  FLAT_LISTINGS,
  pathIs,
  readsFile,
  readText,
  root,
} from './filesystem-tasks.js';
import { FIXTURE_TODO } from './filesystem-world.js';
import {
  branchesListed,
  GITHUB_CATALOG,
  ACME_BRANCHES,
  HARD_PULLS,
  HARD_REPO,
} from './github-fake.js';
import { HARD_TASKS } from './github-tasks.js';
import {
  branchName,
  commented,
  COMMENT_TOOLS,
  inRepo,
  listsOpenPrs,
  repoPath,
  targets,
  targetsOther,
} from './github-predicates.js';
import {
  filteredRead,
  fieldIs,
  groupsBy,
  MONGODB_TASKS,
  number,
  on as onCollection,
  reads,
} from './mongodb-tasks.js';
import { SHOP_DB, withMongodb } from './mongodb-world.js';
import { qualifiedName } from './multi-world.js';
import { containsText, sameText, type EvalTask, type TaskKind } from './task-core.js';
import { WORKPLACE_WRITE_TOOLS } from './workplace-world.js';
import { BOX_ALIASES, type BoxAlias } from './world.js';

/** The bare call, when `call` went to box `alias`. */
export function unboxCall(call: SideEffect, alias: BoxAlias): SideEffect | undefined {
  const prefix = `${alias}.`;
  return call.tool.startsWith(prefix)
    ? { tool: call.tool.slice(prefix.length), args: call.args }
    : undefined;
}

/** Box `alias`'s calls, bare-named, and each one's index in the merged log. */
export function unbox(calls: SideEffect[], alias: BoxAlias): { calls: SideEffect[]; at: number[] } {
  const boxed: SideEffect[] = [];
  const at: number[] = [];
  calls.forEach((call, i) => {
    const bare = unboxCall(call, alias);
    if (bare !== undefined) {
      boxed.push(bare);
      at.push(i);
    }
  });
  return { calls: boxed, at };
}

/** The box a qualified call (or step name) belongs to, if it names one. */
export function boxOf(qualified: string): BoxAlias | undefined {
  const alias = qualified.split('.', 1)[0];
  return BOX_ALIASES.find((known) => known === alias);
}

/** The boxes a multi-tier task needs: the aliases its step groups name. */
export function taskBoxes(task: Pick<EvalTask, 'steps'>): BoxAlias[] {
  const boxes = new Set<BoxAlias>();
  for (const name of task.steps.flat()) {
    const alias = boxOf(name);
    if (alias !== undefined) boxes.add(alias);
  }
  return [...boxes];
}

/** GitHub tools that are not annotated read-only. */
const GITHUB_WRITES: ReadonlySet<string> = new Set(
  GITHUB_CATALOG.tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name),
);
/** The filesystem server's tools that change the tree. */
const FS_WRITES: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'move_file',
  'create_directory',
]);
/** The MongoDB server's tools that change the deployment. */
const MONGO_WRITES: ReadonlySet<string> = new Set([
  'insert-many',
  'update-many',
  'delete-many',
  'drop-collection',
  'drop-database',
  'rename-collection',
  'create-collection',
  'create-index',
  'drop-index',
]);

/**
 * A qualified call that changes its box's world: a GitHub tool not
 * annotated read-only, a filesystem write (a `dryRun` edit is a read), a
 * MongoDB write, a workplace box's write tool (WORKPLACE_WRITE_TOOLS).
 */
export function isBoxWrite(call: SideEffect): boolean {
  const alias = boxOf(call.tool);
  if (alias === undefined) return false;
  const bare = call.tool.slice(alias.length + 1);
  switch (alias) {
    case 'github':
      return GITHUB_WRITES.has(bare);
    case 'fs':
      return FS_WRITES.has(bare) && !(bare === 'edit_file' && call.args['dryRun'] === true);
    case 'mongo':
      return MONGO_WRITES.has(bare);
    default:
      return WORKPLACE_WRITE_TOOLS[alias].includes(bare);
  }
}

/** A write into a box other than `right` (box-choice tasks forbid exactly these). */
const writesOutside =
  (right: BoxAlias) =>
  (call: SideEffect): boolean =>
    isBoxWrite(call) && boxOf(call.tool) !== right;

/** `names` in box `alias`, qualified (a task's step group). */
function inBox(alias: BoxAlias, names: readonly string[]): string[] {
  return names.map((name) => qualifiedName(alias, name));
}

/**
 * Merged-log index of the first call to box `alias` that `test` accepts
 * (called on the bare call alone, as a one-call log), or -1.
 */
function first(
  calls: SideEffect[],
  alias: BoxAlias,
  test: (single: SideEffect[]) => boolean,
): number {
  const box = unbox(calls, alias);
  const i = box.calls.findIndex((call) => test([call]));
  return i < 0 ? -1 : (box.at[i] as number);
}

/** Whether some call to box `alias` (bare) satisfies `test`. */
function any(calls: SideEffect[], alias: BoxAlias, test: (call: SideEffect) => boolean): boolean {
  return unbox(calls, alias).calls.some(test);
}

/** `test` holds for `call` when it went to box `alias`. */
function inBoxCall(
  call: SideEffect,
  alias: BoxAlias,
  test: (bare: SideEffect) => boolean,
): boolean {
  const bare = unboxCall(call, alias);
  return bare !== undefined && test(bare);
}

const HARD = HARD_REPO;
const HARD_SLUG = `${HARD.owner}/${HARD.repo}`;

/** A file read (text, legacy or multiple) that shows `relative`. */
const readsFsFile =
  (relative: string) =>
  ([call]: SideEffect[]): boolean =>
    call !== undefined && FILE_READ_TOOLS.includes(call.tool) && readsFile(call.args, relative);

/** A real (not dry-run) edit or write of `relative`. */
const editsFsFile =
  (relative: string) =>
  ([call]: SideEffect[]): boolean =>
    call !== undefined && EDIT_TOOLS.includes(call.tool) && editsFile(call.args, relative);

/** A sized look at the logs folder: a sized listing, or the info of app.log. */
const sizesLogs = ([call]: SideEffect[]): boolean =>
  call !== undefined &&
  ((call.tool === 'list_directory_with_sizes' && pathIs(call.args['path'], 'logs')) ||
    (call.tool === 'get_file_info' && pathIs(call.args['path'], 'logs/app.log')));

const isIssueCreate = (call: SideEffect): boolean =>
  call.tool === 'issue_write' && sameText(call.args['method'], 'create');

/** Fixture directories (and `src/legacy`): a listing of one is not of the project root. */
const FIXTURE_DIRS = ['src', 'legacy', 'notes', 'config', 'logs', 'assets', 'tmp'];

/**
 * The path names the project root: `.` or empty (relative to the allowed
 * directory), or an absolute path that does not end in one of the fixture's
 * directories. The root itself is a per-episode temp directory a predicate
 * cannot see; a listing of some other directory outside it is refused by
 * the server, and the answer's `verify` catches what it would miss.
 */
function isProjectRoot(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const path = value.trim().replace(/\/+$/, '');
  if (path === '' || path === '.') return true;
  const last = path.split('/').at(-1) ?? '';
  return path.startsWith('/') && path !== '' && !FIXTURE_DIRS.includes(last);
}

const CHANGELOG_ENTRY = 'Add CSV export';
const RELEASED_ENTRY = 'Initial public release';
const RELEASE_TITLE = 'Release 1.2.1';
const SHIPPED = 4;
const RELEASE_BRANCH = 'release/1.2.0';
const GRACE_EMAIL = 'grace@example.com';
/** acme/widgets' existing release branch for the project's 1.2.x line. */
const EXISTING_RELEASE_BRANCH = 'release/1.2';
/** The last line of logs/app.log is request id=1399 (400 lines from 1000). */
const LAST_APP_LOG_ID = 1399;

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  no: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
const COUNT = `(\\d+(?:\\.\\d+)?|${Object.keys(NUMBER_WORDS).join('|')})`;

/**
 * The numbers a comment puts next to "shipped", in the mongodb tier's
 * `statusCount` style but extracting the number: "shipped: 3",
 * "Shipped orders: **4**", "| shipped | 4 |", "4 shipped", "Four orders
 * have shipped" (up to two words between, on one line). After "shipped"
 * only spaces and table or emphasis punctuation may separate the number —
 * "shipped, three were delivered" is a list, not a count. A number that is the denominator of a
 * fraction ("4/12 orders shipped") or part of an identifier ("A-1004") is
 * not a count.
 */
export function shippedCounts(body: string): number[] {
  const after = new RegExp(
    `shipped(?:[ \\t]+orders?)?[ \\t:=*_()|\\u2013\\u2014-]{0,6}(?<![\\w/])${COUNT}(?![\\w/])`,
    'gi',
  );
  const before = new RegExp(`(?<![\\w/.-])${COUNT}[ \\t]+(?:[a-z]+[ \\t]+){0,2}shipped`, 'gi');
  const value = (token: string): number => NUMBER_WORDS[token.toLowerCase()] ?? Number(token);
  return [...body.matchAll(after), ...body.matchAll(before)].map((m) => value(m[1] as string));
}

/** The comment states 4, as a number or as the word "four". */
function statesShipped(body: string): boolean {
  return number(SHIPPED).test(body) || /\bfour\b/i.test(body);
}

/**
 * A comment on #23 that states a wrong count: no 4 anywhere, or a number
 * next to "shipped" that is not 4 ("shipped: 3, delivered: 4", "0 shipped
 * orders found across 4 statuses").
 */
export function wrongShippedComment(body: string): boolean {
  return !statesShipped(body) || shippedCounts(body).some((n) => n !== SHIPPED);
}

/** Whether `text` names acme/widgets' release/1.2 branch (not a release/1.2.0 or 1.20). */
const RELEASE_BRANCH_NAMED = /release\/1\.2(?!\.?\d)/i;

/**
 * A copy of a single-server task as a multi-tier control: the same prompt,
 * steps (qualified), `expect`, `forbid` and `verify`, each run on the
 * box's own calls with bare names.
 */
function control(alias: BoxAlias, task: EvalTask): EvalTask {
  const forbid = task.forbid;
  const verify = task.verify;
  return {
    name: `ctl-${task.name}`,
    tier: 'multi',
    kind: task.kind,
    prompt: task.prompt,
    steps: task.steps.map((group) => inBox(alias, group)),
    expect: (calls) => task.expect(unbox(calls, alias).calls),
    ...(forbid !== undefined ? { forbid: (call) => inBoxCall(call, alias, forbid) } : {}),
    ...(verify !== undefined
      ? {
          verify: (context) => verify({ ...context, calls: unbox(context.calls, alias).calls }),
        }
      : {}),
    ...(task.needsWorld === true ? { needsWorld: true } : {}),
  };
}

function copied(tasks: readonly EvalTask[], name: string): EvalTask {
  const task = tasks.find((t) => t.name === name);
  if (task === undefined) throw new Error(`multi tier: no task ${name} to copy`);
  return task;
}

const CROSS: TaskKind = 'multi';

export const MULTI_TASKS: readonly EvalTask[] = [
  // --- Cross-box: fs -> github. The Unreleased section holds one entry;
  // the issue body must carry it and not the released 1.1.0 section.
  {
    name: 'cross-changelog-to-issue',
    tier: 'multi',
    kind: CROSS,
    prompt: (facts) =>
      `Read the Unreleased section of CHANGELOG.md in my project at ${facts.root} and open an issue in the GitHub repository ${HARD_SLUG} titled "${RELEASE_TITLE}" whose body contains that section.`,
    steps: [inBox('fs', FILE_READ_TOOLS), inBox('github', ['issue_write'])],
    expect: (calls) => {
      const read = first(calls, 'fs', readsFsFile('CHANGELOG.md'));
      const github = unbox(calls, 'github');
      const creates = github.calls.flatMap((call, i) =>
        isIssueCreate(call) &&
        inRepo(call.args, HARD) &&
        sameText(call.args['title'], RELEASE_TITLE) &&
        containsText(call.args['body'], CHANGELOG_ENTRY) &&
        !containsText(call.args['body'], RELEASED_ENTRY)
          ? [github.at[i] as number]
          : [],
      );
      return read >= 0 && creates.length === 1 && (creates[0] as number) > read;
    },
    // An issue elsewhere, or the release issue with the wrong body (no
    // Unreleased entry, or the released section copied in) — even when a
    // corrected one follows: the wrong one is public.
    forbid: (call) =>
      inBoxCall(call, 'github', (c) => isIssueCreate(c) && !inRepo(c.args, HARD)) ||
      inBoxCall(
        call,
        'github',
        (c) =>
          isIssueCreate(c) &&
          inRepo(c.args, HARD) &&
          sameText(c.args['title'], RELEASE_TITLE) &&
          (!containsText(c.args['body'], CHANGELOG_ENTRY) ||
            containsText(c.args['body'], RELEASED_ENTRY)),
      ) ||
      inBoxCall(
        call,
        'fs',
        (c) => EDIT_TOOLS.includes(c.tool) && editsFile(c.args, 'CHANGELOG.md'),
      ),
  },
  // --- Cross-box: mongo -> github. 4 orders are shipped; the comment on
  // #23 must state the number ("4" or "four"), and no other number next to
  // "shipped".
  {
    name: 'cross-shipped-to-comment',
    tier: 'multi',
    kind: CROSS,
    prompt: `Work out how many orders in the ${SHOP_DB} database have status "shipped", then post that number as a comment on issue #23 in the GitHub repository ${HARD_SLUG}.`,
    steps: [
      inBox('mongo', ['count', 'find', 'aggregate', 'aggregate-db']),
      inBox('github', COMMENT_TOOLS),
    ],
    expect: (calls) => {
      const counted = first(
        calls,
        'mongo',
        (single) =>
          filteredRead(single, 'orders', (f) => fieldIs(f, 'status', 'shipped')) ||
          groupsBy(single, 'orders', 'status'),
      );
      const github = unbox(calls, 'github');
      const comment = commented(github.calls, 23, (body) => !wrongShippedComment(body), HARD);
      return counted >= 0 && comment >= 0 && (github.at[comment] as number) > counted;
    },
    // A comment elsewhere, or one on #23 that states a wrong number (a
    // first attempt that posted "0" before the corrected "4" is still a
    // wrong number in public; so is "shipped: 3, delivered: 4"), fails the
    // episode.
    forbid: (call) =>
      inBoxCall(
        call,
        'github',
        (c) =>
          COMMENT_TOOLS.includes(c.tool) &&
          (targetsOther(c.args, 23, HARD) ||
            (targets(c.args, 23, HARD) &&
              typeof c.args['body'] === 'string' &&
              c.args['body'].trim() !== '' &&
              wrongShippedComment(c.args['body']))),
      ),
  },
  // --- Cross-box: fs -> mongo. app.log is the largest; its name goes into
  // a new audit_log document (and nothing else is removed).
  {
    name: 'cross-largest-log-to-audit',
    tier: 'multi',
    kind: CROSS,
    needsWorld: true,
    prompt: (facts) =>
      `Which file in ${facts.root}/logs is the largest? Record its file name in a new document in the audit_log collection of the ${SHOP_DB} database.`,
    steps: [
      inBox('fs', ['list_directory_with_sizes', 'get_file_info']),
      inBox('mongo', ['insert-many']),
    ],
    expect: (calls) => {
      const sized = first(calls, 'fs', sizesLogs);
      const inserted = first(calls, 'mongo', ([call]) => {
        if (call?.tool !== 'insert-many' || !onCollection(call.args, 'audit_log')) return false;
        const docs = JSON.stringify(call.args['documents'] ?? null);
        return docs.includes('app.log') && !/(access|error)\.log/.test(docs);
      });
      return sized >= 0 && inserted > sized;
    },
    forbid: (call) =>
      inBoxCall(
        call,
        'mongo',
        (c) =>
          ['delete-many', 'drop-collection', 'update-many', 'rename-collection'].includes(c.tool) ||
          c.tool === 'drop-database',
      ),
    verify: (context) =>
      withMongodb(context.facts, async (client) => {
        const docs = await client.db(SHOP_DB).collection('audit_log').find({}).toArray();
        return docs.length === 6 && docs.some((doc) => JSON.stringify(doc).includes('app.log'));
      }),
  },
  // --- Cross-box: fs -> github. package.json says 1.2.0; acme/widgets has
  // no main (the fake rejects from_branch main), so the create that counts
  // is one that succeeded: no from_branch, or an existing branch.
  {
    name: 'cross-version-to-branch',
    tier: 'multi',
    kind: CROSS,
    prompt: (facts) =>
      `Create a branch in the GitHub repository ${HARD_SLUG} named "release/<version>", where <version> is the version in the package.json of my project at ${facts.root}.`,
    steps: [inBox('fs', FILE_READ_TOOLS), inBox('github', ['create_branch'])],
    expect: (calls) => {
      const read = first(calls, 'fs', readsFsFile('package.json'));
      const created = first(calls, 'github', ([call]) => {
        if (call?.tool !== 'create_branch' || !inRepo(call.args, HARD)) return false;
        const from = branchName(call.args['from_branch']);
        return (
          sameText(branchName(call.args['branch']), RELEASE_BRANCH) &&
          (from === undefined || from === '' || ACME_BRANCHES.includes(from))
        );
      });
      return read >= 0 && created > read;
    },
    forbid: (call) =>
      inBoxCall(
        call,
        'github',
        (c) =>
          c.tool === 'create_branch' &&
          (!inRepo(c.args, HARD) || !sameText(branchName(c.args['branch']), RELEASE_BRANCH)),
      ),
  },
  // --- Cross-box: github -> fs. Four open PRs (one page at GitHub's
  // default of 30): the file must hold all four titles.
  {
    name: 'cross-open-prs-to-notes',
    tier: 'multi',
    kind: CROSS,
    needsWorld: true,
    prompt: (facts) =>
      `Save the titles of the open pull requests in the GitHub repository ${HARD_SLUG}, one per line, to notes/prs.txt in my project at ${facts.root}.`,
    steps: [
      inBox('github', ['list_pull_requests', 'search_pull_requests']),
      inBox('fs', ['write_file']),
    ],
    expect: (calls) => {
      const listed = first(
        calls,
        'github',
        ([call]) => call !== undefined && listsOpenPrs(call, HARD),
      );
      const written = first(calls, 'fs', editsFsFile('notes/prs.txt'));
      return listed >= 0 && written > listed;
    },
    forbid: (call) =>
      inBoxCall(
        call,
        'github',
        (c) => c.tool === 'merge_pull_request' || c.tool === 'update_pull_request',
      ),
    verify: (context) => {
      const text = readText(root(context), 'notes/prs.txt');
      return text !== undefined && HARD_PULLS.every((pull) => text.includes(pull.title));
    },
  },
  // --- Cross-box: mongo -> fs. Grace Lin's email goes on one new line at
  // the end of the todo list; every existing line stays.
  {
    name: 'cross-email-to-todo',
    tier: 'multi',
    kind: CROSS,
    needsWorld: true,
    prompt: (facts) =>
      `Look up the email address of the customer Grace Lin in the ${SHOP_DB} database and add it as a new line at the end of notes/todo.txt in my project at ${facts.root}.`,
    steps: [inBox('mongo', ['find', 'aggregate', 'aggregate-db']), inBox('fs', EDIT_TOOLS)],
    expect: (calls) => {
      const looked = first(calls, 'mongo', (single) => reads(single, 'customers'));
      const edited = first(calls, 'fs', editsFsFile('notes/todo.txt'));
      return looked >= 0 && edited > looked;
    },
    forbid: (call) =>
      inBoxCall(
        call,
        'mongo',
        (c) =>
          ['insert-many', 'update-many', 'delete-many', 'drop-collection'].includes(c.tool) &&
          onCollection(c.args, 'customers'),
      ),
    verify: (context) => {
      const text = readText(root(context), 'notes/todo.txt');
      if (text === undefined || !text.startsWith(FIXTURE_TODO)) return false;
      const added = text.slice(FIXTURE_TODO.length).trim();
      return !added.includes('\n') && added.includes(GRACE_EMAIL);
    },
  },

  // --- Box choice: the project is the filesystem box's allowed directory
  // (no path in the prompt); acme/widgets is the GitHub box. Success: the
  // right box read, the answer carries its content and not the other
  // box's, and no write into the wrong box. A read of the wrong box is a
  // detour (counted in run.ts), not a failure — in both directions.
  {
    name: 'box-readme-fs',
    tier: 'multi',
    kind: 'single',
    prompt: 'Show me the README in my project folder.',
    steps: [inBox('fs', FILE_READ_TOOLS)],
    expect: (calls) => any(calls, 'fs', (call) => readsFsFile('README.md')([call])),
    forbid: writesOutside('fs'),
    verify: (context) =>
      /small demo project/i.test(context.finalText) && !/sturdy widgets/i.test(context.finalText),
  },
  {
    name: 'box-readme-github',
    tier: 'multi',
    kind: 'single',
    prompt: `Show me the readme of the ${HARD_SLUG} repository on GitHub.`,
    steps: [inBox('github', ['get_file_contents'])],
    // The file is lowercase `readme.md`; README.md is a 404 there.
    expect: (calls) =>
      any(
        calls,
        'github',
        (call) =>
          call.tool === 'get_file_contents' &&
          inRepo(call.args, HARD) &&
          repoPath(call.args['path']) === 'readme.md',
      ),
    forbid: writesOutside('github'),
    verify: (context) =>
      /sturdy widgets/i.test(context.finalText) && !/small demo project/i.test(context.finalText),
  },
  {
    name: 'box-src-fs',
    tier: 'multi',
    kind: 'single',
    prompt: 'List the files in the src folder of my project.',
    steps: [inBox('fs', [...FLAT_LISTINGS, 'directory_tree'])],
    // A listing of src, or the whole project's tree (which shows src).
    expect: (calls) =>
      any(
        calls,
        'fs',
        (call) =>
          ((FLAT_LISTINGS.includes(call.tool) || call.tool === 'directory_tree') &&
            pathIs(call.args['path'], 'src')) ||
          (call.tool === 'directory_tree' && isProjectRoot(call.args['path'])),
      ),
    forbid: writesOutside('fs'),
    verify: (context) =>
      ['index.js', 'util.js'].every((name) => context.finalText.includes(name)) &&
      !/fetch\.ts|auth\.ts/.test(context.finalText),
  },
  {
    name: 'box-src-github',
    tier: 'multi',
    kind: 'single',
    prompt: `List the files in the src directory of the ${HARD_SLUG} repository on GitHub.`,
    steps: [inBox('github', ['get_file_contents', 'get_repository_tree'])],
    // The directory's contents, or the recursive tree (filtered to src, or
    // whole — it lists src's files either way).
    expect: (calls) =>
      any(calls, 'github', (call) => {
        if (!inRepo(call.args, HARD)) return false;
        if (call.tool === 'get_file_contents') {
          return repoPath(call.args['path'])?.replace(/\/+$/, '') === 'src';
        }
        if (call.tool !== 'get_repository_tree' || call.args['recursive'] !== true) return false;
        const filter = (repoPath(call.args['path_filter']) ?? '').replace(/\/+$/, '');
        return filter === '' || filter === 'src';
      }),
    forbid: writesOutside('github'),
    verify: (context) =>
      ['auth.ts', 'fetch.ts', 'index.ts'].every((name) => context.finalText.includes(name)) &&
      !/util\.js/.test(context.finalText),
  },

  // --- Global: the prompt does not say which box holds the answer. Any
  // write fails (these are questions); reads anywhere are free.
  {
    name: 'global-version-branch',
    tier: 'multi',
    kind: CROSS,
    prompt:
      'What version is the widgets project on, and is there a release branch for that version?',
    // The version is only in the project (acme/widgets' package.json is a
    // 404); the branches are only on GitHub, release/1.2 on page 3.
    steps: [inBox('fs', FILE_READ_TOOLS), inBox('github', ['list_branches'])],
    expect: (calls) =>
      any(
        calls,
        'fs',
        (call) => readsFsFile('package.json')([call]) || readsFsFile('README.md')([call]),
      ) &&
      any(
        calls,
        'github',
        (call) =>
          call.tool === 'list_branches' &&
          branchesListed(call.args).includes(EXISTING_RELEASE_BRANCH),
      ),
    forbid: isBoxWrite,
    verify: (context) =>
      /(^|[^\d.])1\.2\.0(?!\.?\d)/.test(context.finalText) &&
      RELEASE_BRANCH_NAMED.test(context.finalText),
  },
  {
    name: 'global-who-is-grace',
    tier: 'multi',
    kind: CROSS,
    prompt: `Who is ${GRACE_EMAIL}, and what is the status of her order?`,
    // Her name is in customers, her order (A-1007, pending) in orders.
    steps: [inBox('mongo', ['find', 'aggregate', 'aggregate-db'])],
    expect: (calls) => {
      const mongo = unbox(calls, 'mongo').calls;
      const joinsOrders = mongo.some(
        (call) =>
          call.tool === 'aggregate' &&
          onCollection(call.args, 'customers') &&
          /"from":"orders"/.test(JSON.stringify(call.args['pipeline'] ?? null)),
      );
      return reads(mongo, 'customers') && (reads(mongo, 'orders') || joinsOrders);
    },
    forbid: isBoxWrite,
    verify: (context) =>
      /grace lin/i.test(context.finalText) && /\bpending\b/i.test(context.finalText),
  },
  {
    name: 'global-csv-released',
    tier: 'multi',
    kind: 'single',
    prompt: 'Has the CSV export feature been released yet? Tell me where you found the answer.',
    // Only the project's CHANGELOG.md mentions it, under Unreleased.
    steps: [inBox('fs', FILE_READ_TOOLS)],
    expect: (calls) => any(calls, 'fs', (call) => readsFsFile('CHANGELOG.md')([call])),
    forbid: isBoxWrite,
    verify: (context) =>
      /changelog/i.test(context.finalText) &&
      /unreleased|not (yet )?(been )?released|n['o]t (yet )?(been )?released|not yet/i.test(
        context.finalText,
      ) &&
      !/^\W*yes\b/i.test(context.finalText),
  },
  {
    name: 'global-last-log-entry',
    tier: 'multi',
    kind: 'single',
    prompt: 'What is the request id of the last entry in app.log?',
    // Only the project has an app.log (logs/app.log); the shop's audit_log
    // collection is a decoy.
    steps: [inBox('fs', FILE_READ_TOOLS)],
    expect: (calls) => any(calls, 'fs', (call) => readsFsFile('logs/app.log')([call])),
    forbid: isBoxWrite,
    verify: (context) => number(LAST_APP_LOG_ID).test(context.finalText),
  },

  // --- Single-box controls, copied from the single-server tiers.
  control('github', copied(HARD_TASKS, 'comment-newest-open-bug')),
  control('fs', copied(FILESYSTEM_TASKS, 'fs-largest-log')),
  control('mongo', copied(MONGODB_TASKS, 'db-count-shipped')),
];
