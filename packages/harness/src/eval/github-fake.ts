/**
 * An offline fake of the remote GitHub MCP server
 * (`https://api.githubcopilot.com/mcp/` with `X-MCP-Toolsets: all`).
 *
 * The real 95-tool catalog — names, descriptions, input JSON Schemas and
 * annotations — plus the server's own `instructions` were dumped once into
 * `test/fixtures/github-catalog.json` and are served here by an in-process
 * `McpServer` that records every call and answers from a small canned
 * world. The tool-choice eval needs the decision surface a model actually
 * faces (95 real schemas, the real guidance), not real GitHub, so nothing
 * here does I/O.
 *
 * The world has two repositories. `modelcontextprotocol/servers` answers the
 * basic tier with static values (the crash issue is #42, the "Fix typo" PR is
 * #7). `acme/widgets`, plus the user's own repositories, answers the hard
 * tier with *scripted* behaviours — pure functions of the call's arguments,
 * so every episode (which gets a fresh fake) sees exactly the same world:
 * candidate lists the prompt's criterion narrows, paged listings with the
 * target on page 2, first attempts that fail with an `isError` result until
 * the arguments are corrected, and lookups that make a write unnecessary.
 *
 * Output schemas are kept in the fixture for reference but not registered:
 * the SDK validates `structuredContent` against a declared output schema,
 * and the canned answers make no attempt to satisfy GitHub's.
 */

import { fromJsonSchema, McpServer, type JsonSchemaType } from '@modelcontextprotocol/server';
import fixture from '../../test/fixtures/github-catalog.json' with { type: 'json' };
import type { SideEffect } from '../types.js';

export interface GithubCatalogTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface GithubCatalogFixture {
  server: { name: string; title?: string; version: string };
  /** The server's `instructions`, as a real host would inject them. */
  instructions: string;
  tools: GithubCatalogTool[];
}

/** The dumped catalog: 95 tools sorted by name, plus the server's instructions. */
export const GITHUB_CATALOG: Readonly<GithubCatalogFixture> = fixture as GithubCatalogFixture;

export type FakeArgs = Record<string, unknown>;

/**
 * A tool result the fake returns with `isError: true` — what the real server
 * does for a 404 or a bad ref. The model sees `message` as the result text.
 */
export class FakeError {
  constructor(readonly message: string) {}
}

export function fakeError(message: string): FakeError {
  return new FakeError(message);
}

/** A scripted answer: a function of the call's arguments returning a JSON value or a {@link FakeError}. */
export type FakeAnswerFn = (args: FakeArgs) => unknown;

/**
 * A canned answer: a JSON value returned verbatim, or a {@link FakeAnswerFn}.
 * (Spelled out rather than `unknown` so inline arrows get their `args` typed.)
 */
export type FakeAnswer =
  FakeAnswerFn | Record<string, unknown> | readonly unknown[] | string | number | boolean | null;

// ---------------------------------------------------------------------------
// The world

/** The basic tier's repository. */
export const BASIC_REPO = { owner: 'modelcontextprotocol', repo: 'servers' } as const;
/** The hard tier's repository: default branch `master`, lowercase readme. */
export const HARD_REPO = { owner: 'acme', repo: 'widgets' } as const;
/** The authenticated user. */
export const FAKE_USER = 'vibdev';

/** Default page size the fake uses when a paged tool is called without `perPage`. */
export const FAKE_PAGE_SIZE = 3;

export interface FakeIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  created_at: string;
  body: string;
}

export interface FakePullRequest {
  number: number;
  title: string;
  state: 'open' | 'closed';
  author: string;
  head: string;
  created_at: string;
  files: string[];
}

export interface FakeReviewComment {
  id: number;
  author: string;
  path: string;
  body: string;
}

/** Issues in acme/widgets, newest first. #30 is the newest bug but closed. */
export const HARD_ISSUES: readonly FakeIssue[] = [
  {
    number: 30,
    title: 'Memory leak in file watcher',
    state: 'closed',
    labels: ['bug'],
    created_at: '2026-09-28T09:00:00Z',
    body: 'Fixed in 1.3.',
  },
  {
    number: 25,
    title: 'Docs: add usage examples',
    state: 'open',
    labels: ['documentation'],
    created_at: '2026-09-25T09:00:00Z',
    body: 'The readme has no examples.',
  },
  {
    number: 23,
    title: 'Flaky test in CI',
    state: 'open',
    labels: ['bug'],
    created_at: '2026-09-20T09:00:00Z',
    body: 'test/fetch.test.ts fails about one run in five.',
  },
  {
    number: 17,
    title: 'Crash when config file is missing',
    state: 'open',
    labels: ['bug', 'needs-triage'],
    created_at: '2026-09-01T09:00:00Z',
    body: 'Stack trace attached.',
  },
];

/** Labels defined in acme/widgets (so none needs creating). */
export const HARD_LABELS: readonly string[] = [
  'bug',
  'documentation',
  'good first issue',
  'needs-triage',
];

/** Open PRs in acme/widgets, newest first. Only #11 is by alice AND touches CHANGELOG.md. */
export const HARD_PULLS: readonly FakePullRequest[] = [
  {
    number: 12,
    title: 'Bump dependencies',
    state: 'open',
    author: 'bob',
    head: 'chore/bump-deps',
    created_at: '2026-10-03T09:00:00Z',
    files: ['CHANGELOG.md', 'package.json', 'pnpm-lock.yaml'],
  },
  {
    number: 11,
    title: 'Prepare 1.3 release',
    state: 'open',
    author: 'alice',
    head: 'release-1.3',
    created_at: '2026-10-02T09:00:00Z',
    files: ['CHANGELOG.md', 'package.json'],
  },
  {
    number: 10,
    title: 'Add retry to fetch',
    state: 'open',
    author: 'alice',
    head: 'feature/retry',
    created_at: '2026-10-01T09:00:00Z',
    files: ['src/fetch.ts', 'test/fetch.test.ts'],
  },
  {
    number: 8,
    title: 'Harden token refresh',
    state: 'open',
    author: 'carol',
    head: 'fix/token-refresh',
    created_at: '2026-09-29T09:00:00Z',
    files: ['src/auth.ts', 'README.md'],
  },
];

/** Review-thread comments on acme/widgets PR #8. */
export const HARD_REVIEW_COMMENTS: Readonly<Record<number, readonly FakeReviewComment[]>> = {
  8: [
    { id: 9001, author: 'bob', path: 'src/auth.ts', body: 'Should this handle expired tokens?' },
    { id: 9002, author: 'carol', path: 'README.md', body: 'Typo: recieve -> receive.' },
  ],
};

/** Branches in acme/widgets, alphabetical as GitHub lists them; no `main`. */
export const HARD_BRANCHES: readonly string[] = [
  'chore/ci',
  'develop',
  'docs/site',
  'master',
  'release/1.2',
  'release/1.3',
];
export const HARD_DEFAULT_BRANCH = 'master';

/** Files at the root of acme/widgets. The readme is lowercase. */
export const HARD_ROOT_FILES: readonly { name: string; type: 'file' | 'dir' }[] = [
  { name: 'package.json', type: 'file' },
  { name: 'readme.md', type: 'file' },
  { name: 'src', type: 'dir' },
];
export const HARD_README_TEXT = '# widgets\n\nSmall, sturdy widgets.\n';
export const HARD_SRC_FILES: readonly string[] = ['auth.ts', 'fetch.ts', 'index.ts'];
/** The number the fake gives any issue it "creates". */
export const CREATED_ISSUE_NUMBER = 101;

/** The user's own repositories; only toolbox has open Dependabot alerts. */
export const USER_REPOS: readonly string[] = ['blog', 'dotfiles', 'toolbox'];
export const USER_DEPENDABOT_ALERTS: Readonly<Record<string, readonly unknown[]>> = {
  toolbox: [
    {
      number: 1,
      state: 'open',
      security_advisory: {
        severity: 'high',
        summary: 'Prototype pollution in lodash',
        cve_id: 'CVE-2021-23337',
      },
      dependency: { package: { name: 'lodash' }, manifest_path: 'package.json' },
    },
    {
      number: 2,
      state: 'open',
      security_advisory: {
        severity: 'medium',
        summary: 'Prototype pollution in minimist',
        cve_id: 'CVE-2021-44906',
      },
      dependency: { package: { name: 'minimist' }, manifest_path: 'package.json' },
    },
  ],
};

/** The repositories starred by the user; acme/widgets is already among them. */
export const USER_STARRED: readonly string[] = ['acme/widgets', 'octocat/Hello-World'];

// ---------------------------------------------------------------------------
// Argument helpers

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function lower(value: unknown): string {
  return (str(value) ?? '').trim().toLowerCase();
}

function isRepo(args: FakeArgs, ref: { owner: string; repo: string }): boolean {
  return lower(args['owner']) === ref.owner && lower(args['repo']) === ref.repo;
}

/** The search is scoped to `ref`: owner/repo arguments, or a `repo:owner/name` qualifier. */
function searchScopedTo(args: FakeArgs, ref: { owner: string; repo: string }): boolean {
  return (
    isRepo(args, ref) ||
    lower(args['query']).includes(`repo:${ref.owner}/${ref.repo}`) ||
    lower(args['query']).includes(`${ref.owner}/${ref.repo}`)
  );
}

/** Every value of a `name:value` qualifier in the query, lower-cased and unquoted. */
function qualifiers(query: string, name: string): string[] {
  return [...query.matchAll(new RegExp(`(?:^|\\s)${name}:("[^"]*"|\\S+)`, 'gi'))].map((m) =>
    (m[1] ?? '').replace(/^"|"$/g, '').toLowerCase(),
  );
}

function qualifier(query: string, name: string): string | undefined {
  return qualifiers(query, name)[0];
}

/** The `is:`/`state:` state a search asks for (`pr`/`issue` are type qualifiers, not states). */
function searchState(query: string): string {
  return (
    [...qualifiers(query, 'is'), ...qualifiers(query, 'state')].find(
      (v) => v !== 'pr' && v !== 'issue',
    ) ?? ''
  );
}

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'the',
  'in',
  'on',
  'of',
  'for',
  'to',
  'is',
  'or',
  'about',
  'with',
  'issue',
  'issues',
  'pull',
  'request',
  'pr',
  'title',
  'titled',
  'exact',
  'exactly',
  'open',
  'closed',
]);

/** Free-text words of a search query: no qualifiers, no stopwords, no quotes. */
export function queryTerms(query: unknown): string[] {
  return lower(query)
    .split(/\s+/)
    .filter((word) => !word.includes(':'))
    .map((word) => word.replace(/^"+|"+$/g, '').replace(/[^a-z0-9_./-]/g, ''))
    .filter((word) => word !== '' && !STOPWORDS.has(word));
}

/**
 * Lenient text match standing in for GitHub's ranked search: at least half of
 * the query's terms (rounded up) occur, as word prefixes either way, in the
 * text. No terms means no text constraint.
 */
export function textMatches(text: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const words = text.toLowerCase().split(/[^a-z0-9_./-]+/);
  const hits = terms.filter((term) =>
    words.some((word) => word.startsWith(term) || term.startsWith(word)),
  ).length;
  return hits >= Math.ceil(terms.length / 2);
}

export interface FakePage<T> {
  items: T[];
  page: number;
  per_page: number;
  total_count: number;
  has_next_page: boolean;
}

/**
 * One page of `items` as the fake's `page`/`perPage` tools serve it (page 1
 * and {@link FAKE_PAGE_SIZE} when absent). Exported so a task predicate can
 * ask whether a recorded listing call would have shown the target.
 */
export function pageOf<T>(items: readonly T[], args: FakeArgs): FakePage<T> {
  const page = Math.max(1, Math.floor(num(args['page']) ?? 1));
  const perPage = Math.max(1, Math.floor(num(args['perPage']) ?? FAKE_PAGE_SIZE));
  const start = (page - 1) * perPage;
  return {
    items: items.slice(start, start + perPage),
    page,
    per_page: perPage,
    total_count: items.length,
    has_next_page: start + perPage < items.length,
  };
}

/** The branch names a `list_branches` call with these arguments returns for acme/widgets. */
export function branchesListed(args: FakeArgs): string[] {
  return isRepo(args, HARD_REPO) ? pageOf(HARD_BRANCHES, args).items : [];
}

// ---------------------------------------------------------------------------
// Scripted behaviours (pure functions of the arguments)

function issueView(issue: FakeIssue): unknown {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    created_at: issue.created_at,
    body: issue.body,
    html_url: `https://github.com/${HARD_REPO.owner}/${HARD_REPO.repo}/issues/${issue.number}`,
  };
}

function pullView(pull: FakePullRequest): unknown {
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    user: { login: pull.author },
    head: { ref: pull.head },
    base: { ref: HARD_DEFAULT_BRANCH },
    created_at: pull.created_at,
    html_url: `https://github.com/${HARD_REPO.owner}/${HARD_REPO.repo}/pull/${pull.number}`,
  };
}

const BASIC_ISSUE = { number: 42, title: 'Crash on startup', state: 'open' };
const BASIC_PULLS = [
  { number: 7, title: 'Fix typo', state: 'open' },
  { number: 9, title: 'Add feature', state: 'open' },
];

function hardIssues(args: FakeArgs): FakeIssue[] {
  const state = lower(args['state']);
  const labels = Array.isArray(args['labels']) ? args['labels'].map(lower) : [];
  let issues = HARD_ISSUES.filter(
    (issue) =>
      (state === '' || issue.state === state) &&
      labels.every((label) => issue.labels.map((l) => l.toLowerCase()).includes(label)),
  );
  if (lower(args['direction']) === 'asc') issues = issues.toReversed();
  return issues;
}

function hardPulls(args: FakeArgs, query?: string): FakePullRequest[] {
  const state = lower(args['state']) || (query !== undefined ? searchState(query) : '');
  const author = query !== undefined ? qualifier(query, 'author') : undefined;
  const head = lower(args['head']).replace(/^[^:]*:/, '');
  const terms = query !== undefined ? queryTerms(query) : [];
  let pulls = HARD_PULLS.filter(
    (pull) =>
      (state === '' || state === 'all' || pull.state === state) &&
      (author === undefined || pull.author === author) &&
      (head === '' || pull.head === head) &&
      textMatches(pull.title, terms),
  );
  if (lower(args['direction']) === 'asc' || lower(args['order']) === 'asc') {
    pulls = pulls.toReversed();
  }
  return pulls;
}

function searchIssuesFor(args: FakeArgs): unknown {
  if (!searchScopedTo(args, HARD_REPO)) {
    return { total_count: 1, items: [BASIC_ISSUE] };
  }
  const query = str(args['query']) ?? '';
  const state = searchState(query);
  const labels = qualifiers(query, 'label');
  const terms = queryTerms(query);
  let issues = HARD_ISSUES.filter(
    (issue) =>
      (state === '' || issue.state === state) &&
      labels.every((label) => issue.labels.map((l) => l.toLowerCase()).includes(label)) &&
      textMatches(`${issue.title} ${issue.body}`, terms),
  );
  if (lower(args['order']) === 'asc') issues = issues.toReversed();
  const items = issues.map(issueView);
  return { total_count: items.length, items };
}

function fileContentsFor(args: FakeArgs): unknown {
  if (!isRepo(args, HARD_REPO)) return { ok: true };
  const path = (str(args['path']) ?? '')
    .trim()
    .replace(/^(\.\/|\/)+/, '')
    .replace(/\/+$/, '');
  if (path === '' || path === '.') {
    return HARD_ROOT_FILES.map((entry) => ({ ...entry, path: entry.name }));
  }
  if (path === 'readme.md') {
    return { type: 'file', path, encoding: 'utf-8', content: HARD_README_TEXT };
  }
  if (path === 'src')
    return HARD_SRC_FILES.map((name) => ({ name, type: 'file', path: `src/${name}` }));
  return fakeError(
    `404 Not Found: no file or directory at path "${path}" in ${HARD_REPO.owner}/${HARD_REPO.repo}.`,
  );
}

function createBranchFor(args: FakeArgs): unknown {
  const from = lower(args['from_branch']).replace(/^refs\/heads\//, '');
  if (isRepo(args, HARD_REPO) && from !== '' && !HARD_BRANCHES.includes(from)) {
    return fakeError(
      `422 Reference not found: branch "${from}" does not exist in ${HARD_REPO.owner}/${HARD_REPO.repo} (the default branch is "${HARD_DEFAULT_BRANCH}").`,
    );
  }
  return { ok: true, ref: `refs/heads/${str(args['branch']) ?? ''}` };
}

function pullRequestReadFor(args: FakeArgs): unknown {
  if (!isRepo(args, HARD_REPO)) {
    return { number: 7, title: 'Fix typo', state: 'open', mergeable: true };
  }
  const number = num(args['pullNumber']);
  const pull = HARD_PULLS.find((p) => p.number === number);
  if (pull === undefined) return fakeError(`404 Not Found: pull request #${String(number)}.`);
  switch (lower(args['method'])) {
    case 'get_files':
      return pull.files.map((filename) => ({ filename, status: 'modified' }));
    case 'get_review_comments':
      return (HARD_REVIEW_COMMENTS[pull.number] ?? []).map((comment) => ({
        id: comment.id,
        user: { login: comment.author },
        path: comment.path,
        body: comment.body,
        html_url: `https://github.com/${HARD_REPO.owner}/${HARD_REPO.repo}/pull/${pull.number}#discussion_r${comment.id}`,
      }));
    case 'get_comments':
    case 'get_reviews':
    case 'get_commits':
    case 'get_check_runs':
      return [];
    case 'get_status':
      return { state: 'success' };
    case 'get_diff':
      return '';
    default:
      return { ...(pullView(pull) as Record<string, unknown>), mergeable: true };
  }
}

function issueReadFor(args: FakeArgs): unknown {
  if (!isRepo(args, HARD_REPO)) {
    return { ...BASIC_ISSUE, body: 'Crashes on boot.' };
  }
  const number = num(args['issue_number']);
  const issue = HARD_ISSUES.find((i) => i.number === number);
  if (issue === undefined) {
    // Pull requests are issues too: reading one by number works on GitHub.
    const pull = HARD_PULLS.find((p) => p.number === number);
    if (pull !== undefined && lower(args['method']) !== 'get_labels') {
      return lower(args['method']) === 'get' || lower(args['method']) === ''
        ? { ...(pullView(pull) as Record<string, unknown>), pull_request: { url: '' } }
        : [];
    }
    if (pull !== undefined) return [];
    return fakeError(`404 Not Found: issue #${String(number)}.`);
  }
  switch (lower(args['method'])) {
    case 'get_labels':
      return issue.labels.map((name) => ({ name }));
    case 'get_comments':
    case 'get_sub_issues':
      return [];
    case 'get_parent':
      return null;
    default:
      return issueView(issue);
  }
}

function searchRepositoriesFor(args: FakeArgs): unknown {
  const query = lower(args['query']);
  const user = qualifier(query, 'user') ?? qualifier(query, 'owner') ?? qualifier(query, 'org');
  if (user === FAKE_USER || user === '@me' || (user === undefined && query.includes(FAKE_USER))) {
    const items = USER_REPOS.map((name) => ({
      full_name: `${FAKE_USER}/${name}`,
      name,
      owner: { login: FAKE_USER },
      default_branch: 'main',
    }));
    return { total_count: items.length, items };
  }
  if (query.includes(HARD_REPO.repo)) {
    return {
      total_count: 1,
      items: [
        {
          full_name: `${HARD_REPO.owner}/${HARD_REPO.repo}`,
          name: HARD_REPO.repo,
          owner: { login: HARD_REPO.owner },
          default_branch: HARD_DEFAULT_BRANCH,
        },
      ],
    };
  }
  // Any other query finds the basic tier's repository, as it did before the
  // hard tier existed (a non-empty answer keeps the basic episodes short).
  return {
    total_count: 1,
    items: [
      {
        full_name: `${BASIC_REPO.owner}/${BASIC_REPO.repo}`,
        name: BASIC_REPO.repo,
        owner: { login: BASIC_REPO.owner },
        default_branch: 'main',
      },
    ],
  };
}

function issueWriteFor(args: FakeArgs): unknown {
  const slug = `${lower(args['owner'])}/${lower(args['repo'])}`;
  if (lower(args['method']) === 'create') {
    return {
      number: CREATED_ISSUE_NUMBER,
      title: str(args['title']) ?? '',
      state: 'open',
      html_url: `https://github.com/${slug}/issues/${CREATED_ISSUE_NUMBER}`,
    };
  }
  return { ok: true, number: num(args['issue_number']) ?? null };
}

function dependabotAlertsFor(args: FakeArgs): unknown {
  if (lower(args['owner']) !== FAKE_USER) return [];
  const alerts = USER_DEPENDABOT_ALERTS[lower(args['repo'])] ?? [];
  const severity = lower(args['severity']);
  const state = lower(args['state']) || 'open';
  return alerts.filter((alert) => {
    const a = alert as { state: string; security_advisory: { severity: string } };
    return a.state === state && (severity === '' || a.security_advisory.severity === severity);
  });
}

/**
 * Canned answers keyed by tool name. Anything not listed answers
 * `{ ok: true }`. Static values serve the basic tier's repository; functions
 * script the hard tier's world (see the module comment).
 */
export const GITHUB_FAKE_ANSWERS: Readonly<Record<string, FakeAnswer>> = {
  get_me: { login: FAKE_USER },
  search_issues: searchIssuesFor,
  list_issues: (args) =>
    isRepo(args, HARD_REPO)
      ? {
          issues: hardIssues(args).map(issueView),
          pageInfo: { hasNextPage: false, endCursor: null },
          totalCount: hardIssues(args).length,
        }
      : [BASIC_ISSUE],
  issue_read: issueReadFor,
  list_pull_requests: (args) =>
    isRepo(args, HARD_REPO) ? pageOf(hardPulls(args).map(pullView), args) : BASIC_PULLS,
  search_pull_requests: (args) => {
    if (!searchScopedTo(args, HARD_REPO)) return { total_count: 2, items: BASIC_PULLS };
    const items = hardPulls({}, str(args['query']) ?? '').map(pullView);
    return { total_count: items.length, items };
  },
  pull_request_read: pullRequestReadFor,
  issue_write: issueWriteFor,
  list_label: (args) =>
    isRepo(args, HARD_REPO) ? HARD_LABELS.map((name) => ({ name })) : { ok: true },
  get_label: (args) => {
    if (!isRepo(args, HARD_REPO)) return { ok: true };
    const name = lower(args['name']);
    return HARD_LABELS.includes(name)
      ? { name, color: 'ededed' }
      : fakeError(`404 Not Found: no label "${name}" in ${HARD_REPO.owner}/${HARD_REPO.repo}.`);
  },
  semantic_issue_similarity_search: (args) => (isRepo(args, HARD_REPO) ? [] : { ok: true }),
  list_branches: (args) =>
    isRepo(args, HARD_REPO)
      ? pageOf(
          HARD_BRANCHES.map((name) => ({ name, protected: name === HARD_DEFAULT_BRANCH })),
          args,
        )
      : { ok: true },
  create_branch: createBranchFor,
  get_file_contents: fileContentsFor,
  get_repository_tree: (args) =>
    isRepo(args, HARD_REPO)
      ? { sha: 'deadbeef', tree: HARD_ROOT_FILES.map((e) => ({ path: e.name, type: e.type })) }
      : { ok: true },
  list_starred_repositories: () =>
    USER_STARRED.map((fullName) => ({
      full_name: fullName,
      owner: { login: fullName.split('/')[0] },
      name: fullName.split('/')[1],
    })),
  search_repositories: searchRepositoriesFor,
  list_dependabot_alerts: dependabotAlertsFor,
  list_notifications: [
    { id: '1', unread: true, reason: 'mention', subject: { title: 'Crash on startup' } },
  ],
};

export interface GithubFake {
  /** The fake, not yet connected: hand it to `wrapMcpServer` or a transport. */
  server: McpServer;
  /** Every tool call the fake executed, in order. */
  readonly calls: SideEffect[];
  /** The catalog it serves. */
  readonly tools: readonly GithubCatalogTool[];
  /** The instructions it advertises (undefined when disabled). */
  readonly instructions: string | undefined;
}

export interface GithubFakeOptions {
  /** Catalog to serve. Default: the full 95-tool dump. */
  tools?: readonly GithubCatalogTool[];
  /** Extra or overriding canned answers, merged over {@link GITHUB_FAKE_ANSWERS}. */
  answers?: Record<string, FakeAnswer>;
  /**
   * Server instructions to advertise. Default: the real server's. Pass
   * `false` to advertise none.
   */
  instructions?: string | false;
  /** Called with every call as it is recorded (see `WorldOptions.onCall`). */
  onCall?: (call: SideEffect) => void;
}

/** Resolve a canned answer for a call. */
export function answerFor(
  answers: Record<string, FakeAnswer>,
  tool: string,
  args: FakeArgs,
): unknown {
  if (!Object.hasOwn(answers, tool)) return { ok: true };
  const answer = answers[tool];
  return typeof answer === 'function' ? (answer as FakeAnswerFn)(args) : answer;
}

/**
 * Build the fake. Each tool is registered with its real JSON Schema (via the
 * SDK's `fromJsonSchema`, so `tools/list` serves the schema verbatim and
 * schema-invalid arguments are rejected before the handler runs, as the real
 * server would) and its real annotations (so Projection's posture policy —
 * read-only runs, everything else asks — sees what it would see live). The
 * fake holds no state between calls: a new one per episode starts clean.
 */
export function createGithubFake(options: GithubFakeOptions = {}): GithubFake {
  const tools = options.tools ?? GITHUB_CATALOG.tools;
  const answers: Record<string, FakeAnswer> = { ...GITHUB_FAKE_ANSWERS, ...options.answers };
  const instructions =
    options.instructions === false
      ? undefined
      : (options.instructions ?? GITHUB_CATALOG.instructions);
  const calls: SideEffect[] = [];
  const server = new McpServer(
    { name: GITHUB_CATALOG.server.name, version: `${GITHUB_CATALOG.server.version}-fake` },
    ...(instructions !== undefined ? [{ instructions }] : []),
  );

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema as JsonSchemaType),
        ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
      },
      (args) => {
        const recorded = args ?? {};
        calls.push({ tool: tool.name, args: recorded });
        options.onCall?.({ tool: tool.name, args: recorded });
        const answer = answerFor(answers, tool.name, recorded);
        if (answer instanceof FakeError) {
          return { isError: true, content: [{ type: 'text' as const, text: answer.message }] };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(answer) }] };
      },
    );
  }

  return { server, calls, tools, instructions };
}
