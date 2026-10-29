/**
 * The golden call sequence for every multi-tier task, shared by the
 * predicate tests (multi-tasks.test.ts — offline: each predicate fires on
 * its golden and not on the wrong sequences) and the fidelity test
 * (multi-world.test.ts — each golden runs clean against the real boxes
 * through every mode's tool surface, the task scores it, and `verify`
 * holds). Calls are qualified `<alias>.<name>`, as the multi world records
 * them; filesystem paths are under the filesystem goldens' stand-in root
 * (`rebase` moves them onto a real episode's directory).
 */

import { HARD_PULLS, type SideEffect } from '../../src/index.js';
import { GOLDEN as FS_GOLDEN, GOLDEN_ROOT, type Golden as FsGolden } from './filesystem-goldens.js';
import { GOLDEN as DB_GOLDEN, type Golden as DbGolden } from './mongodb-goldens.js';

export { GOLDEN_ROOT, rebase } from './filesystem-goldens.js';

export interface Golden {
  calls: SideEffect[];
  /** Further correct call sequences (each must score and run clean). */
  variants?: SideEffect[][];
  /** The golden changes the world's end state, so `verify` must be false before it runs. */
  mutates?: boolean;
  /** A correct final answer. */
  answer?: string;
  /** A wrong final answer (verify must reject it). */
  wrongAnswer?: string;
  /** Plausible wrong call sequences (none may score). */
  wrong?: SideEffect[][];
  /**
   * A sequence that scores on the calls but leaves the wrong end state:
   * it runs clean and `expect` holds, but `verify` must not.
   */
  wrongEffect?: SideEffect[];
}

const at = (relative: string): string => `${GOLDEN_ROOT}/${relative}`;
const ACME = { owner: 'acme', repo: 'widgets' };
const shop = (collection: string): Record<string, unknown> => ({
  connectionId: 'preconfigured',
  database: 'shop',
  collection,
});

const fs = (tool: string, args: Record<string, unknown>): SideEffect => ({
  tool: `fs.${tool}`,
  args,
});
const github = (tool: string, args: Record<string, unknown>): SideEffect => ({
  tool: `github.${tool}`,
  args,
});
const mongo = (tool: string, args: Record<string, unknown>): SideEffect => ({
  tool: `mongo.${tool}`,
  args,
});
const qualify = (alias: string, calls: SideEffect[]): SideEffect[] =>
  calls.map((call) => ({ tool: `${alias}.${call.tool}`, args: call.args }));

const readChangelog = fs('read_text_file', { path: at('CHANGELOG.md') });
const releaseIssue = (body: string, ref: Record<string, string> = ACME): SideEffect =>
  github('issue_write', { method: 'create', ...ref, title: 'Release 1.2.1', body });
const countShipped = mongo('count', { ...shop('orders'), query: { status: 'shipped' } });
const comment = (issue: number, body: string): SideEffect =>
  github('add_issue_comment', { ...ACME, issue_number: issue, body });
const sizedLogs = fs('list_directory_with_sizes', { path: at('logs'), sortBy: 'size' });
const audit = (file: string): SideEffect =>
  mongo('insert-many', { ...shop('audit_log'), documents: [{ action: 'largest-log', file }] });
const readPackage = fs('read_text_file', { path: at('package.json') });
const branch = (name: string, from?: string): SideEffect =>
  github('create_branch', {
    ...ACME,
    branch: name,
    ...(from !== undefined ? { from_branch: from } : {}),
  });
const titles = (pulls: readonly { title: string }[]): string =>
  `${pulls.map((p) => p.title).join('\n')}\n`;
const writePrs = (content: string): SideEffect =>
  fs('write_file', { path: at('notes/prs.txt'), content });
const findGrace = mongo('find', { ...shop('customers'), filter: { name: 'Grace Lin' } });
const appendGrace = fs('edit_file', {
  path: at('notes/todo.txt'),
  edits: [{ oldText: '- ship v1.2', newText: '- ship v1.2\n- grace@example.com' }],
});

const readReadme = fs('read_text_file', { path: at('README.md') });
const githubReadme = github('get_file_contents', { ...ACME, path: 'readme.md' });
const githubSrc = github('get_file_contents', { ...ACME, path: 'src' });
const listSrc = fs('list_directory', { path: at('src') });
/** A write into the GitHub box (not read-only): what box choice forbids from the fs side. */
const githubWrite = github('create_or_update_file', {
  ...ACME,
  path: 'readme.md',
  content: '# widgets\n',
  message: 'Update readme',
  branch: 'master',
});
const fsWrite = (relative: string): SideEffect =>
  fs('write_file', { path: at(relative), content: 'overwritten\n' });
const findGraceOrders = mongo('find', {
  ...shop('orders'),
  filter: { customerEmail: 'grace@example.com' },
});
const findGraceByEmail = mongo('find', {
  ...shop('customers'),
  filter: { email: 'grace@example.com' },
});
const tailAppLog = fs('read_text_file', { path: at('logs/app.log'), tail: 1 });

const fsControl = FS_GOLDEN['fs-largest-log'] as FsGolden;
const dbControl = DB_GOLDEN['db-count-shipped'] as DbGolden;

export const GOLDEN: Record<string, Golden> = {
  'cross-changelog-to-issue': {
    calls: [readChangelog, releaseIssue('## Unreleased\n\n- Add CSV export')],
    wrong: [
      // The issue before the read: the body is a guess.
      [releaseIssue('- Add CSV export'), readChangelog],
      // The whole changelog, released section included.
      [readChangelog, releaseIssue('- Add CSV export\n\n## 1.1.0\n\n- Initial public release')],
      // The wrong repository.
      [readChangelog, releaseIssue('- Add CSV export', { owner: 'vibdev', repo: 'toolbox' })],
      // Two issues.
      [readChangelog, releaseIssue('- Add CSV export'), releaseIssue('- Add CSV export')],
      // A wrong body first, corrected after: the wrong issue is public.
      [
        readChangelog,
        releaseIssue('## 1.1.0\n\n- Initial public release'),
        releaseIssue('- Add CSV export'),
      ],
      [readChangelog, releaseIssue(''), releaseIssue('- Add CSV export')],
    ],
  },
  'cross-shipped-to-comment': {
    calls: [countShipped, comment(23, '4 orders have shipped.')],
    variants: [
      [
        mongo('aggregate', {
          ...shop('orders'),
          pipeline: [{ $group: { _id: '$status', n: { $sum: 1 } } }],
        }),
        comment(23, 'Shipped orders: 4'),
      ],
      [countShipped, comment(23, 'Four orders have shipped.')],
    ],
    wrong: [
      [countShipped, comment(23, '12 orders')],
      // A wrong number posted first, then corrected (observed live).
      [countShipped, comment(23, 'There are 0 shipped orders.'), comment(23, 'There are 4.')],
      [countShipped, comment(17, '4 orders have shipped.')],
      // A 4 in the comment, but not the shipped count.
      [countShipped, comment(23, 'shipped: 3, delivered: 4')],
      [countShipped, comment(23, '0 shipped orders found across 4 statuses')],
      [comment(23, '4'), countShipped],
      [mongo('count', { ...shop('orders') }), comment(23, '4')],
    ],
  },
  'cross-largest-log-to-audit': {
    calls: [sizedLogs, audit('app.log')],
    mutates: true,
    wrong: [
      [sizedLogs, audit('access.log')],
      [fs('list_directory', { path: at('logs') }), audit('app.log')],
      [audit('app.log'), sizedLogs],
    ],
  },
  'cross-version-to-branch': {
    calls: [readPackage, branch('release/1.2.0')],
    variants: [
      [readPackage, branch('release/1.2.0', 'master')],
      // The first attempt from main fails (no such branch); the retry counts.
      [readPackage, branch('release/1.2.0', 'main'), branch('release/1.2.0', 'master')],
    ],
    wrong: [
      [readPackage, branch('release/1.2.1')],
      [readPackage, branch('release/1.2.0', 'main')],
      [branch('release/1.2.0'), readPackage],
    ],
  },
  'cross-open-prs-to-notes': {
    calls: [
      github('list_pull_requests', { ...ACME, state: 'open', perPage: 10 }),
      writePrs(titles(HARD_PULLS)),
    ],
    mutates: true,
    wrong: [
      [writePrs(titles(HARD_PULLS)), github('list_pull_requests', { ...ACME, state: 'open' })],
      [github('list_pull_requests', { ...ACME, state: 'closed' }), writePrs(titles(HARD_PULLS))],
    ],
    // Page 1 only (three per page): the fourth title is missing.
    wrongEffect: [
      github('list_pull_requests', { ...ACME, state: 'open' }),
      writePrs(titles(HARD_PULLS.slice(0, 3))),
    ],
  },
  'cross-email-to-todo': {
    calls: [findGrace, appendGrace],
    mutates: true,
    wrong: [
      [appendGrace, findGrace],
      [
        findGrace,
        mongo('update-many', { ...shop('customers'), filter: {}, update: { $set: { x: 1 } } }),
        appendGrace,
      ],
    ],
    // The email replaces the list instead of joining it.
    wrongEffect: [
      findGrace,
      fs('write_file', { path: at('notes/todo.txt'), content: 'grace@example.com\n' }),
    ],
  },
  'box-readme-fs': {
    calls: [fs('list_allowed_directories', {}), readReadme],
    // A look at the wrong box first is a detour, not a failure.
    variants: [[githubReadme, readReadme]],
    answer: '# Widgets\n\nA small demo project.\n\nCurrent version: 1.2.0',
    wrongAnswer: '# widgets\n\nSmall, sturdy widgets.',
    wrong: [
      [githubReadme],
      // A write into the wrong box fails the episode.
      [readReadme, githubWrite],
    ],
  },
  'box-readme-github': {
    calls: [githubReadme],
    variants: [
      [github('get_file_contents', { ...ACME, path: '/' }), githubReadme],
      [readReadme, githubReadme],
    ],
    answer: '# widgets\n\nSmall, sturdy widgets.',
    wrongAnswer:
      '# widgets\n\nSmall, sturdy widgets. (Your local copy says: A small demo project.)',
    wrong: [
      [readReadme],
      [github('get_file_contents', { ...ACME, path: 'README.md' })],
      [githubReadme, fsWrite('README.md')],
    ],
  },
  'box-src-fs': {
    calls: [listSrc],
    variants: [
      [fs('directory_tree', { path: at('src') })],
      // The whole project's tree shows src.
      [fs('directory_tree', { path: GOLDEN_ROOT })],
      [githubSrc, listSrc],
    ],
    answer: 'index.js, util.js and the legacy/ folder',
    wrongAnswer: 'auth.ts, fetch.ts, index.ts',
    wrong: [[githubSrc], [fs('directory_tree', { path: at('logs') })], [listSrc, githubWrite]],
  },
  'box-src-github': {
    calls: [githubSrc],
    variants: [
      [github('get_repository_tree', { ...ACME, recursive: true, path_filter: 'src' })],
      [listSrc, githubSrc],
    ],
    answer: 'auth.ts, fetch.ts, index.ts',
    wrongAnswer: 'index.js, util.js',
    wrong: [
      [listSrc],
      // Not recursive: the root tree shows only the src entry.
      [github('get_repository_tree', { ...ACME, path_filter: 'src' })],
      [githubSrc, fsWrite('src/index.js')],
    ],
  },
  'global-version-branch': {
    calls: [readPackage, github('list_branches', { ...ACME, page: 2 })],
    variants: [[readReadme, github('list_branches', { ...ACME, perPage: 100 })]],
    answer:
      'The project is on version 1.2.0. acme/widgets has a release/1.2 branch for that line (and release/1.3).',
    wrongAnswer: 'The project is on 1.2.0, and there is no release/1.2.0 branch.',
    wrong: [
      // Page 1 (three branches) has no release branch.
      [readPackage, github('list_branches', ACME)],
      [github('list_branches', { ...ACME, page: 2 })],
      [readPackage, github('list_branches', { ...ACME, page: 2 }), branch('release/1.2.0')],
    ],
  },
  'global-who-is-grace': {
    calls: [findGraceByEmail, findGraceOrders],
    variants: [
      [
        mongo('aggregate', {
          ...shop('customers'),
          pipeline: [
            { $match: { email: 'grace@example.com' } },
            {
              $lookup: {
                from: 'orders',
                localField: 'email',
                foreignField: 'customerEmail',
                as: 'orders',
              },
            },
          ],
        }),
      ],
    ],
    answer:
      'grace@example.com is Grace Lin, a silver-tier customer in Austin. Her order A-1007 is pending.',
    wrongAnswer: 'That is Grace Lin; her order has shipped.',
    wrong: [
      [findGraceByEmail],
      [findGraceOrders],
      [
        findGraceByEmail,
        findGraceOrders,
        mongo('update-many', {
          ...shop('orders'),
          filter: { orderId: 'A-1007' },
          update: { $set: { status: 'shipped' } },
        }),
      ],
    ],
  },
  'global-csv-released': {
    calls: [readChangelog],
    variants: [[github('search_issues', { query: 'repo:acme/widgets CSV export' }), readChangelog]],
    answer: 'No. CSV export is listed under "Unreleased" in CHANGELOG.md in your project.',
    wrongAnswer: 'Yes, according to the CHANGELOG it shipped in 1.1.0.',
    wrong: [
      [github('search_issues', { query: 'repo:acme/widgets CSV export' })],
      [readChangelog, fs('edit_file', { path: at('CHANGELOG.md'), edits: [] })],
    ],
  },
  'global-last-log-entry': {
    calls: [tailAppLog],
    variants: [
      [
        mongo('find', { ...shop('audit_log'), sort: { at: -1 }, limit: 1 }),
        fs('search_files', { path: GOLDEN_ROOT, pattern: '**/app.log' }),
        tailAppLog,
      ],
    ],
    answer: 'The last entry in logs/app.log is request id=1399.',
    wrongAnswer: 'The last entry is request id=1000.',
    wrong: [
      [mongo('find', { ...shop('audit_log'), sort: { at: -1 }, limit: 1 })],
      [fs('get_file_info', { path: at('logs/app.log') })],
    ],
  },
  'ctl-comment-newest-open-bug': {
    calls: [
      github('list_issues', { ...ACME, state: 'OPEN', labels: ['bug'] }),
      comment(23, 'Taking a look'),
    ],
    wrong: [
      [github('list_issues', { ...ACME, labels: ['bug'] }), comment(30, 'Taking a look')],
      // Unqualified names are not calls to the github box.
      [
        { tool: 'list_issues', args: { ...ACME, state: 'OPEN', labels: ['bug'] } },
        { tool: 'add_issue_comment', args: { ...ACME, issue_number: 23, body: 'Taking a look' } },
      ],
    ],
  },
  'ctl-fs-largest-log': {
    calls: qualify('fs', fsControl.calls),
    ...(fsControl.answer !== undefined ? { answer: fsControl.answer } : {}),
    ...(fsControl.wrongAnswer !== undefined ? { wrongAnswer: fsControl.wrongAnswer } : {}),
    wrong: [qualify('fs', fsControl.wrong ?? [])],
  },
  'ctl-db-count-shipped': {
    calls: qualify('mongo', dbControl.calls),
    ...(dbControl.answer !== undefined ? { answer: dbControl.answer } : {}),
    ...(dbControl.wrongAnswer !== undefined ? { wrongAnswer: dbControl.wrongAnswer } : {}),
    wrong: [qualify('mongo', dbControl.wrong ?? [])],
  },
};
