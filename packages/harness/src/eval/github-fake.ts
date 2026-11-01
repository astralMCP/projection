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
 * **Fidelity source.** The dump is of the hosted server build
 * `remote-7eab724b…` (2026-10-10), which is not public. Its schemas match
 * the open-source github/github-mcp-server at commit eb47a99 (2026-10-08,
 * v2.0.0 plus two fixes) apart from the remote's `x-mcp-header` schema
 * annotations and six remote-only tools. Every answer shape, error text,
 * page size and validation rule below is taken from that commit and cited
 * as `upstream <file>:<line>` (paths under `pkg/github/`). The host speaks
 * a pre-2026-07-28 protocol, so the server's legacy era applies: no output
 * schemas, no `structuredContent`, one compact JSON text block per result
 * (`pkg/inventory/server_tool.go:448`, `typed_output.go:251`).
 *
 * The world has two repositories. `modelcontextprotocol/servers` answers the
 * basic tier; it stands in for a large real repository, so any issue or PR
 * number exists there. `acme/widgets`, plus the user's own repositories,
 * answers the hard tier with *scripted* behaviours — pure functions of the
 * call's arguments, so every episode (which gets a fresh fake) sees exactly
 * the same world: candidate lists the prompt's criterion narrows, paged
 * listings with the target past the first page, first attempts that fail
 * with an `isError` result until the arguments are corrected, and lookups
 * that make a write unnecessary. Any other repository is a 404, as on
 * GitHub.
 *
 * No output schemas are registered (the legacy era advertises none), so the
 * GitHub box reaches Projection with "none declared" on every tool.
 */

import { createHash } from 'node:crypto';
import {
  fromJsonSchema,
  McpServer,
  type JsonSchemaType,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
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

/** A plain-text (not JSON) success result, as the server sends for some writes. */
export class FakeText {
  constructor(readonly text: string) {}
}

export function fakeText(text: string): FakeText {
  return new FakeText(text);
}

/** A content block the fake can send besides text: an embedded text resource. */
export type FakeBlock =
  | { type: 'text'; text: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; text: string } };

/** A success result made of several content blocks (get_file_contents' file answer). */
export class FakeContent {
  constructor(readonly blocks: FakeBlock[]) {}
}

/** A scripted answer: a function of the call's arguments returning a JSON value or a {@link FakeError}. */
export type FakeAnswerFn = (args: FakeArgs) => unknown;

/**
 * A canned answer: a JSON value returned verbatim, or a {@link FakeAnswerFn}.
 * (Spelled out rather than `unknown` so inline arrows get their `args` typed.)
 */
export type FakeAnswer =
  | FakeAnswerFn
  | Record<string, unknown>
  | readonly unknown[]
  | string
  | number
  | boolean
  | null;

// ---------------------------------------------------------------------------
// Real error and id formats

/** The REST base URL go-github prints in its errors. */
export const API = 'https://api.github.com';
const WEB = 'https://github.com';

/**
 * A REST failure as the server reports it: its own prefix, then go-github's
 * `METHOD URL: STATUS []` (upstream `pkg/errors/error.go:162`). `path`
 * includes any query string go-github sent.
 */
export function apiError(
  prefix: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  status = '404 Not Found',
): FakeError {
  return fakeError(`${prefix}: ${method} ${API}${path}: ${status} []`);
}

/** A stable positive integer for `key` within [base, base + span). */
export function stableId(key: string, base = 1_000_000, span = 90_000_000): number {
  const digest = createHash('sha256').update(key).digest();
  return base + (digest.readUInt32BE(0) % span);
}

/** A stable 40-hex commit / blob sha for `key`. */
export function stableSha(key: string): string {
  return createHash('sha1').update(key).digest('hex');
}

/** go-github's default `per_page` the server passes when `perPage` is absent (upstream params.go:416). */
export const GITHUB_PAGE_SIZE = 30;

/**
 * Default page size of the fake's page/perPage tools: GitHub's 30. (Kept
 * under its old name for the harness's exports; it was 3 before the
 * fidelity pass.)
 */
export const FAKE_PAGE_SIZE = GITHUB_PAGE_SIZE;

// ---------------------------------------------------------------------------
// The world

/** The basic tier's repository. */
export const BASIC_REPO = { owner: 'modelcontextprotocol', repo: 'servers' } as const;
/** The hard tier's repository: default branch `master`, lowercase readme. */
export const HARD_REPO = { owner: 'acme', repo: 'widgets' } as const;
/** The authenticated user. */
export const FAKE_USER = 'vibdev';

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

/** The six branches the hard tasks name; no `main`. */
export const HARD_BRANCHES: readonly string[] = [
  'chore/ci',
  'develop',
  'docs/site',
  'master',
  'release/1.2',
  'release/1.3',
];
export const HARD_DEFAULT_BRANCH = 'master';

/**
 * Every branch of acme/widgets, alphabetical as GitHub lists them: the six
 * above plus 58 feature, fix, chore, docs, release and Dependabot branches.
 * At GitHub's default page size of 30 the release/* branches are on page 3.
 */
export const ACME_BRANCHES: readonly string[] = (() => {
  const features = [
    'audit-log',
    'bulk-edit',
    'csv-export',
    'dark-mode',
    'drag-drop',
    'emoji-picker',
    'filters',
    'i18n',
    'inline-edit',
    'json-export',
    'keyboard',
    'live-preview',
    'markdown',
    'offline',
    'pagination',
    'pdf-export',
    'plugins',
    'presence',
    'retry',
    'search-v2',
    'sharing',
    'themes',
    'webhooks',
  ].map((name) => `feature/${name}`);
  const fixes = [
    'auth-loop',
    'chart-legend',
    'cli-quiet',
    'csv-header',
    'date-parse',
    'empty-state',
    'focus-trap',
    'leak-watch',
    'locale',
    'pool-exhaustion',
    'race-upload',
    'safari',
    'scroll-jump',
    'tz-offset',
    'xml-escape',
  ].map((name) => `fix/${name}`);
  const chores = ['bump-node', 'eslint-flat', 'lockfile', 'prettier', 'renovate', 'tsconfig'].map(
    (name) => `chore/${name}`,
  );
  const docs = ['api-ref', 'faq', 'migration', 'readme-badges'].map((name) => `docs/${name}`);
  const releases = ['release/1.0', 'release/1.1'];
  const deps = ['express-5', 'typescript-6', 'vitest-5', 'zod-4', 'undici-7'].map(
    (name) => `dependabot/npm_and_yarn/${name}`,
  );
  // Near misses: not under feature/.
  const decoys = ['features/legacy-ui', 'feature-flags', 'experiment/feature-x'];
  return [
    ...HARD_BRANCHES,
    ...features,
    ...fixes,
    ...chores,
    ...docs,
    ...releases,
    ...deps,
    ...decoys,
  ].toSorted();
})();

/** Files at the root of acme/widgets. The readme is lowercase. */
export const HARD_ROOT_FILES: readonly { name: string; type: 'file' | 'dir' }[] = [
  { name: 'package.json', type: 'file' },
  { name: 'readme.md', type: 'file' },
  { name: 'src', type: 'dir' },
];
export const HARD_README_TEXT = '# widgets\n\nSmall, sturdy widgets.\n';
const HARD_PACKAGE_JSON = '{\n  "name": "widgets",\n  "private": true\n}\n';
export const HARD_SRC_FILES: readonly string[] = ['auth.ts', 'fetch.ts', 'index.ts'];
/** The number the fake gives any issue it "creates" (in its url). */
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

/** One repository the fake knows: everything else is a 404. */
export interface FakeRepo {
  owner: string;
  repo: string;
  default_branch: string;
  description: string;
  language: string;
  stars: number;
  created_at: string;
  updated_at: string;
}

const REPOS: readonly FakeRepo[] = [
  {
    ...BASIC_REPO,
    default_branch: 'main',
    description: 'Model Context Protocol Servers',
    language: 'TypeScript',
    stars: 71_204,
    created_at: '2024-11-19T01:10:17Z',
    updated_at: '2026-10-09T22:41:03Z',
  },
  {
    ...HARD_REPO,
    default_branch: HARD_DEFAULT_BRANCH,
    description: 'Small, sturdy widgets.',
    language: 'TypeScript',
    stars: 214,
    created_at: '2022-04-02T08:00:00Z',
    updated_at: '2026-10-03T09:00:00Z',
  },
  ...USER_REPOS.map((repo, i) => ({
    owner: FAKE_USER,
    repo,
    default_branch: 'main',
    description: ['My blog', 'My dotfiles', 'Small scripts I use every day'][i] ?? '',
    language: ['Astro', 'Shell', 'TypeScript'][i] ?? '',
    stars: [3, 12, 7][i] ?? 0,
    created_at: '2021-06-01T10:00:00Z',
    updated_at: '2026-09-15T10:00:00Z',
  })),
  {
    owner: 'octocat',
    repo: 'Hello-World',
    default_branch: 'master',
    description: 'My first repository on GitHub!',
    language: '',
    stars: 3_100,
    created_at: '2011-01-26T19:01:12Z',
    updated_at: '2026-10-01T00:00:00Z',
  },
];

/** The basic repository's issues: #42 is the crash; the others are near misses. */
const BASIC_ISSUES: readonly FakeIssue[] = [
  {
    number: 42,
    title: 'Crash on startup',
    state: 'open',
    labels: ['bug'],
    created_at: '2026-09-30T12:00:00Z',
    body: 'Crashes on boot.',
  },
  {
    number: 40,
    title: 'Startup is slow with many servers configured',
    state: 'open',
    labels: ['enhancement'],
    created_at: '2026-09-27T12:00:00Z',
    body: 'Takes ten seconds to start.',
  },
  {
    number: 36,
    title: 'Crash when the config file is empty',
    state: 'closed',
    labels: ['bug'],
    created_at: '2026-09-12T12:00:00Z',
    body: 'Fixed by #37.',
  },
];

/** The basic repository's open PRs: #7 is "Fix typo". */
const BASIC_PULLS: readonly FakePullRequest[] = [
  {
    number: 12,
    title: 'Update the README examples',
    state: 'open',
    author: 'dsp',
    head: 'docs/readme-examples',
    created_at: '2026-10-05T12:00:00Z',
    files: ['README.md'],
  },
  {
    number: 9,
    title: 'Add feature',
    state: 'open',
    author: 'jspahrsummers',
    head: 'feature/add-feature',
    created_at: '2026-10-02T12:00:00Z',
    files: ['src/index.ts'],
  },
  {
    number: 7,
    title: 'Fix typo',
    state: 'open',
    author: 'olaservo',
    head: 'fix/typo',
    created_at: '2026-09-29T12:00:00Z',
    files: ['README.md'],
  },
];
const BASIC_BRANCHES: readonly string[] = [
  'docs/readme-examples',
  'feature/add-feature',
  'fix/typo',
  'main',
];
const BASIC_README_TEXT =
  '# Model Context Protocol servers\n\nThis repository is a collection of reference implementations for the Model Context Protocol (MCP).\n';

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
  return (
    lower(args['owner']) === ref.owner.toLowerCase() &&
    lower(args['repo']) === ref.repo.toLowerCase()
  );
}

/** The repository `args` names, if the fake knows it (GitHub names are case-insensitive). */
export function repoOf(args: FakeArgs): FakeRepo | undefined {
  return REPOS.find((repo) => isRepo(args, repo));
}

/** `owner/repo` as GitHub spells it, or as the call did when unknown. */
function slugOf(args: FakeArgs): string {
  const repo = repoOf(args);
  return repo !== undefined
    ? `${repo.owner}/${repo.repo}`
    : `${str(args['owner']) ?? ''}/${str(args['repo']) ?? ''}`;
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
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((word) => word !== '');
  const hits = terms.filter((term) =>
    words.some((word) => word.startsWith(term) || term.startsWith(word)),
  ).length;
  return hits >= Math.ceil(terms.length / 2);
}

export interface FakePage<T> {
  items: T[];
  page: number;
  perPage: number;
  hasNext: boolean;
}

/**
 * One page of `items` the way the server's page/perPage tools fetch one
 * (page 1 and {@link GITHUB_PAGE_SIZE} when absent or 0, upstream
 * params.go:416). The listing itself is a bare array: GitHub's REST lists
 * carry no total and no next flag in the body. Exported so a task predicate
 * can ask whether a recorded listing call would have shown the target.
 */
export function pageOf<T>(items: readonly T[], args: FakeArgs): FakePage<T> {
  const page = Math.max(1, Math.floor(num(args['page']) || 1));
  const perPage = Math.min(100, Math.max(1, Math.floor(num(args['perPage']) || GITHUB_PAGE_SIZE)));
  const start = (page - 1) * perPage;
  return {
    items: items.slice(start, start + perPage),
    page,
    perPage,
    hasNext: start + perPage < items.length,
  };
}

/** The branch names a `list_branches` call with these arguments returns for acme/widgets. */
export function branchesListed(args: FakeArgs): string[] {
  return isRepo(args, HARD_REPO) ? pageOf(ACME_BRANCHES, args).items : [];
}

// ---------------------------------------------------------------------------
// Views: the real server's JSON shapes (upstream minimal_types.go)

/** An issue or PR as the views need it, whichever world holds it. */
export interface IssueRecord {
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: readonly string[];
  user: string;
  assignees: readonly string[];
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  body: string;
  /** Set when the issue is a pull request (search and the issues API return PRs too). */
  pull?: boolean;
}

export interface PullRecord {
  number: number;
  title: string;
  state: 'open' | 'closed';
  author: string;
  head: string;
  base: string;
  created_at: string;
  updated_at: string;
  files: readonly string[];
  body?: string;
}

/** `MinimalUser` (upstream minimal_types.go:150): the login plus id and urls. */
export function minimalUser(login: string): Record<string, unknown> {
  const id = stableId(`user:${login}`);
  return {
    login,
    id,
    profile_url: `${WEB}/${login}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
  };
}

/** go-github's full `User` object, as raw REST payloads (search items) carry it. */
function restUser(login: string): Record<string, unknown> {
  const id = stableId(`user:${login}`);
  return {
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    html_url: `${WEB}/${login}`,
    id,
    login,
    node_id: `U_kgDO${id.toString(36).toUpperCase()}`,
    site_admin: false,
    type: 'User',
    url: `${API}/users/${login}`,
  };
}

const LABEL_COLORS: Readonly<Record<string, [string, string]>> = {
  bug: ['d73a4a', "Something isn't working"],
  documentation: ['0075ca', 'Improvements or additions to documentation'],
  enhancement: ['a2eeef', 'New feature or request'],
  'good first issue': ['7057ff', 'Good for newcomers'],
  'needs-triage': ['ededed', 'Not yet looked at'],
  stale: ['ffffff', 'No activity for a while'],
};

/** A label as GraphQL lists it (list_label, get_label, get_labels): upstream labels.go. */
export function labelView(name: string, slug: string): Record<string, unknown> {
  const [color, description] = LABEL_COLORS[name] ?? ['ededed', ''];
  return {
    color,
    description,
    id: `LA_kwDO${stableId(`label:${slug}:${name}`).toString(36).toUpperCase()}`,
    name,
  };
}

function restLabel(name: string, slug: string): Record<string, unknown> {
  const [color, description] = LABEL_COLORS[name] ?? ['ededed', ''];
  const id = stableId(`label:${slug}:${name}`);
  return {
    color,
    default: ['bug', 'documentation', 'enhancement', 'good first issue'].includes(name),
    description,
    id,
    name,
    node_id: `LA_kwDO${id.toString(36).toUpperCase()}`,
    url: `${API}/repos/${slug}/labels/${encodeURIComponent(name)}`,
  };
}

/** The issue's REST id (MinimalResponse ids are these, as strings). */
export function issueId(slug: string, number: number): number {
  return stableId(`issue:${slug}#${number}`, 3_000_000_000, 400_000_000);
}

/** `MinimalIssue` (upstream minimal_types.go:562): issue_read get. */
export function minimalIssue(slug: string, issue: IssueRecord): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    ...(issue.body !== '' ? { body: issue.body } : {}),
    state: issue.state,
    ...(issue.state === 'closed' ? { state_reason: 'completed' } : {}),
    html_url: `${WEB}/${slug}/${issue.pull === true ? 'pull' : 'issues'}/${issue.number}`,
    user: minimalUser(issue.user),
    author_association: issue.user === FAKE_USER ? 'OWNER' : 'CONTRIBUTOR',
    ...(issue.labels.length > 0 ? { labels: [...issue.labels] } : {}),
    assignees: [...issue.assignees],
    ...(issue.comments > 0 ? { comments: issue.comments } : {}),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    ...(issue.closed_at !== null ? { closed_at: issue.closed_at } : {}),
  };
}

/**
 * One issue of list_issues (GraphQL, upstream issues.go:925): uppercase
 * state, the user as `{login}`, label names, no url.
 */
export function listedIssue(issue: IssueRecord): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    ...(issue.body !== '' ? { body: issue.body } : {}),
    state: issue.state.toUpperCase(),
    user: { login: issue.user },
    ...(issue.labels.length > 0 ? { labels: [...issue.labels] } : {}),
    assignees: [...issue.assignees],
    ...(issue.comments > 0 ? { comments: issue.comments } : {}),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

/**
 * One search_issues / search_pull_requests item: the raw REST issue, keys
 * alphabetical (the server re-marshals it through a map, upstream
 * issues.go:2171).
 */
export function searchItem(slug: string, issue: IssueRecord): Record<string, unknown> {
  const kind = issue.pull === true ? 'pull' : 'issues';
  const url = `${API}/repos/${slug}/issues/${issue.number}`;
  const id = issueId(slug, issue.number);
  return {
    active_lock_reason: null,
    assignee: issue.assignees[0] !== undefined ? restUser(issue.assignees[0]) : null,
    assignees: issue.assignees.map(restUser),
    author_association: issue.user === FAKE_USER ? 'OWNER' : 'CONTRIBUTOR',
    body: issue.body,
    closed_at: issue.closed_at,
    comments: issue.comments,
    comments_url: `${url}/comments`,
    created_at: issue.created_at,
    html_url: `${WEB}/${slug}/${kind}/${issue.number}`,
    id,
    labels: issue.labels.map((name) => restLabel(name, slug)),
    labels_url: `${url}/labels{/name}`,
    locked: false,
    node_id: `${issue.pull === true ? 'PR' : 'I'}_kwDO${id.toString(36).toUpperCase()}`,
    number: issue.number,
    ...(issue.pull === true
      ? {
          pull_request: {
            diff_url: `${WEB}/${slug}/pull/${issue.number}.diff`,
            html_url: `${WEB}/${slug}/pull/${issue.number}`,
            merged_at: null,
            patch_url: `${WEB}/${slug}/pull/${issue.number}.patch`,
            url: `${API}/repos/${slug}/pulls/${issue.number}`,
          },
        }
      : {}),
    repository_url: `${API}/repos/${slug}`,
    score: 1,
    state: issue.state,
    ...(issue.state === 'closed' ? { state_reason: 'completed' } : {}),
    title: issue.title,
    updated_at: issue.updated_at,
    url,
    user: restUser(issue.user),
  };
}

/** A PR as the issues API (and search) sees it. */
export function pullAsIssue(pull: PullRecord): IssueRecord {
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    labels: [],
    user: pull.author,
    assignees: [],
    comments: 0,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.state === 'closed' ? pull.updated_at : null,
    body: pull.body ?? '',
    pull: true,
  };
}

function lineCounts(file: string): { additions: number; deletions: number } {
  return { additions: 3 + (file.length % 17), deletions: file.length % 5 };
}

/**
 * `MinimalPullRequest` (upstream minimal_types.go:713). A list item lacks
 * what GitHub's list endpoint does not send (`merged` stays false, no
 * mergeable_state or line counts); `single` adds them, as the single-PR
 * endpoint does.
 */
export function minimalPull(
  slug: string,
  pull: PullRecord,
  single: boolean,
): Record<string, unknown> {
  const description = REPOS.find((r) => `${r.owner}/${r.repo}` === slug)?.description;
  const branch = (ref: string): Record<string, unknown> => ({
    ref,
    sha: stableSha(`${slug}:${ref}`),
    repo: { full_name: slug, ...(description !== undefined ? { description } : {}) },
  });
  const counts = pull.files.map(lineCounts);
  return {
    number: pull.number,
    title: pull.title,
    ...(pull.body !== undefined && pull.body !== '' ? { body: pull.body } : {}),
    state: pull.state,
    draft: false,
    merged: false,
    ...(single && pull.state === 'open' ? { mergeable_state: 'clean' } : {}),
    html_url: `${WEB}/${slug}/pull/${pull.number}`,
    user: minimalUser(pull.author),
    head: branch(pull.head),
    base: branch(pull.base),
    ...(single
      ? {
          additions: counts.reduce((sum, c) => sum + c.additions, 0),
          deletions: counts.reduce((sum, c) => sum + c.deletions, 0),
          changed_files: pull.files.length,
          commits: 1 + (pull.number % 3),
        }
      : {}),
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    ...(pull.state === 'closed' ? { closed_at: pull.updated_at } : {}),
  };
}

/** `MinimalPRFile` (upstream minimal_types.go:261): get_files. */
export function prFile(file: string): Record<string, unknown> {
  const { additions, deletions } = lineCounts(file);
  return {
    filename: file,
    status: 'modified',
    additions,
    deletions,
    changes: additions + deletions,
  };
}

/** get_diff: the raw unified diff, as text (upstream pullrequests.go:247). */
export function prDiff(files: readonly string[]): string {
  return files
    .map(
      (file) =>
        `diff --git a/${file} b/${file}\nindex ${stableSha(`a:${file}`).slice(0, 7)}..${stableSha(`b:${file}`).slice(0, 7)} 100644\n--- a/${file}\n+++ b/${file}\n@@ -1,3 +1,4 @@\n line one\n+line added\n line two\n line three\n`,
    )
    .join('');
}

/**
 * get_review_comments (GraphQL review threads, upstream pullrequests.go:532):
 * a wrapper of threads; comments carry the author login and an html_url
 * (whose `#discussion_r<id>` holds the REST comment id), but no id field.
 */
export function reviewThreads(
  slug: string,
  number: number,
  comments: readonly {
    id: number;
    author: string;
    path: string;
    body: string;
    created_at?: string;
  }[],
): Record<string, unknown> {
  return {
    review_threads: comments.map((comment) => ({
      id: `PRRT_kwDO${comment.id.toString(36).toUpperCase()}`,
      is_resolved: false,
      is_outdated: false,
      is_collapsed: false,
      comments: [
        {
          body: comment.body,
          path: comment.path,
          line: 10 + (comment.id % 40),
          original_line: 10 + (comment.id % 40),
          author: comment.author,
          created_at: comment.created_at ?? '2026-10-01T10:00:00Z',
          updated_at: comment.created_at ?? '2026-10-01T10:00:00Z',
          html_url: `${WEB}/${slug}/pull/${number}#discussion_r${comment.id}`,
        },
      ],
      total_count: 1,
    })),
    totalCount: comments.length,
    pageInfo: { hasNextPage: false, hasPreviousPage: false },
  };
}

/** `MinimalRepository` (upstream minimal_types.go): search_repositories items. */
function minimalRepo(repo: FakeRepo, forStars = false): Record<string, unknown> {
  return {
    id: stableId(`repo:${repo.owner}/${repo.repo}`),
    name: repo.repo,
    full_name: `${repo.owner}/${repo.repo}`,
    ...(!forStars && repo.description !== '' ? { description: repo.description } : {}),
    html_url: `${WEB}/${repo.owner}/${repo.repo}`,
    ...(repo.language !== '' ? { language: repo.language } : {}),
    stargazers_count: repo.stars,
    forks_count: Math.floor(repo.stars / 9),
    open_issues_count: Math.floor(repo.stars / 40),
    updated_at: repo.updated_at,
    ...(!forStars ? { created_at: repo.created_at } : {}),
    private: false,
    fork: false,
    archived: false,
    default_branch: repo.default_branch,
  };
}

// ---------------------------------------------------------------------------
// The base world's records

const BASIC_SLUG = `${BASIC_REPO.owner}/${BASIC_REPO.repo}`;

function issueRecord(issue: FakeIssue, user: string): IssueRecord {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    labels: issue.labels,
    user,
    assignees: [],
    comments: issue.number % 3,
    created_at: issue.created_at,
    updated_at: issue.created_at,
    closed_at: issue.state === 'closed' ? issue.created_at : null,
    body: issue.body,
  };
}

function pullRecord(pull: FakePullRequest, base: string): PullRecord {
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    author: pull.author,
    head: pull.head,
    base,
    created_at: pull.created_at,
    updated_at: pull.created_at,
    files: pull.files,
  };
}

const HARD_ISSUE_RECORDS = HARD_ISSUES.map((issue) => issueRecord(issue, 'vibdev'));
const HARD_PULL_RECORDS = HARD_PULLS.map((pull) => pullRecord(pull, HARD_DEFAULT_BRANCH));
const BASIC_ISSUE_RECORDS = BASIC_ISSUES.map((issue) => issueRecord(issue, 'mcp-user'));
const BASIC_PULL_RECORDS = BASIC_PULLS.map((pull) => pullRecord(pull, 'main'));

/**
 * The basic repository stands in for a large real one: a number it does not
 * list is still an issue there, synthesised so that reads of it succeed.
 */
function basicIssueByNumber(n: number): IssueRecord {
  const listed = BASIC_ISSUE_RECORDS.find((i) => i.number === n);
  if (listed !== undefined) return listed;
  const pull = BASIC_PULL_RECORDS.find((p) => p.number === n);
  if (pull !== undefined) return pullAsIssue(pull);
  return issueRecord(
    {
      number: n,
      title: `Issue #${n}`,
      state: 'open',
      labels: [],
      created_at: '2026-06-01T12:00:00Z',
      body: '',
    },
    'mcp-user',
  );
}

function basicPullByNumber(n: number): PullRecord {
  return (
    BASIC_PULL_RECORDS.find((p) => p.number === n) ??
    pullRecord(
      {
        number: n,
        title: `Pull request #${n}`,
        state: 'open',
        author: 'mcp-user',
        head: `patch-${n}`,
        created_at: '2026-06-01T12:00:00Z',
        files: ['README.md'],
      },
      'main',
    )
  );
}

/** The issues of a repository the fake models (user repositories have none). */
function issuesOf(repo: FakeRepo): readonly IssueRecord[] {
  if (repo === REPOS[0]) return BASIC_ISSUE_RECORDS;
  if (repo === REPOS[1]) return HARD_ISSUE_RECORDS;
  return [];
}

function pullsOf(repo: FakeRepo): readonly PullRecord[] {
  if (repo === REPOS[0]) return BASIC_PULL_RECORDS;
  if (repo === REPOS[1]) return HARD_PULL_RECORDS;
  return [];
}

function branchesOf(repo: FakeRepo): readonly string[] {
  if (repo === REPOS[0]) return BASIC_BRANCHES;
  if (repo === REPOS[1]) return ACME_BRANCHES;
  return [repo.default_branch];
}

/** The issue `n` of `repo` (a PR number reads as its issue, as on GitHub). */
function issueByNumber(repo: FakeRepo, n: number | undefined): IssueRecord | undefined {
  if (n === undefined) return undefined;
  if (repo === REPOS[0]) return basicIssueByNumber(n);
  const issue = issuesOf(repo).find((i) => i.number === n);
  if (issue !== undefined) return issue;
  const pull = pullsOf(repo).find((p) => p.number === n);
  return pull !== undefined ? pullAsIssue(pull) : undefined;
}

function pullByNumber(repo: FakeRepo, n: number | undefined): PullRecord | undefined {
  if (n === undefined) return undefined;
  if (repo === REPOS[0]) return basicPullByNumber(n);
  return pullsOf(repo).find((p) => p.number === n);
}

// ---------------------------------------------------------------------------
// Scripted behaviours (pure functions of the arguments)

/**
 * list_issues (GraphQL, upstream issues.go:3737): open AND closed unless
 * `state` says otherwise (:3830); `labels` matches issues with any of them
 * (GraphQL `issues(labels:)`); cursor pages of `perPage` (30) with
 * `pageInfo` and `totalCount`; `page` is refused (:3895).
 */
export function listIssuesPage(issues: readonly IssueRecord[], args: FakeArgs): unknown {
  if (args['page'] !== undefined) {
    return fakeError(
      "This tool uses cursor-based pagination. Use the 'after' parameter with the 'endCursor' value from the previous response instead of 'page'.",
    );
  }
  const since = str(args['since']);
  if (
    since !== undefined &&
    since !== '' &&
    !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/.test(since)
  ) {
    return fakeError(
      `failed to list issues: invalid ISO 8601 timestamp: ${since} (supported formats: YYYY-MM-DDThh:mm:ssZ or YYYY-MM-DD)`,
    );
  }
  const state = lower(args['state']);
  const labels = Array.isArray(args['labels']) ? args['labels'].map(lower) : [];
  let hits = issues.filter(
    (issue) =>
      issue.pull !== true &&
      (state === '' || issue.state === state) &&
      (labels.length === 0 ||
        labels.some((label) => issue.labels.map((l) => l.toLowerCase()).includes(label))) &&
      (since === undefined || since === '' || issue.updated_at >= since),
  );
  const orderBy = lower(args['orderBy']);
  const key = orderBy === 'updated_at' ? 'updated_at' : 'created_at';
  hits = hits.toSorted((a, b) => b[key].localeCompare(a[key]) || b.number - a.number);
  if (orderBy === 'comments') hits = hits.toSorted((a, b) => b.comments - a.comments);
  if (lower(args['direction']) === 'asc') hits = hits.toReversed();
  const perPage = Math.min(100, Math.max(1, Math.floor(num(args['perPage']) || GITHUB_PAGE_SIZE)));
  const offset = offsetOf(args['after']);
  const page = hits.slice(offset, offset + perPage);
  const hasNextPage = offset + perPage < hits.length;
  return {
    issues: page.map((issue) => pickFields(listedIssue(issue), args['fields'])),
    totalCount: hits.length,
    pageInfo: {
      hasNextPage,
      hasPreviousPage: offset > 0,
      ...(page.length > 0 ? { startCursor: cursorOf(offset) } : {}),
      ...(page.length > 0 ? { endCursor: cursorOf(offset + page.length) } : {}),
    },
  };
}

/** A GraphQL-style opaque cursor for offset `n`. */
export function cursorOf(n: number): string {
  return Buffer.from(`cursor:v2:${n}`).toString('base64');
}

export function offsetOf(cursor: unknown): number {
  const text = str(cursor);
  if (text === undefined || text === '') return 0;
  const m = /^cursor:v2:(\d+)$/.exec(Buffer.from(text, 'base64').toString('utf8'));
  return m === null ? 0 : Number(m[1]);
}

/** Keep only `fields` (when given) of an item, as the server's `fields` param does. */
export function pickFields(
  item: Record<string, unknown>,
  fields: unknown,
): Record<string, unknown> {
  if (!Array.isArray(fields) || fields.length === 0) return item;
  const keep = new Set(fields.map((f) => String(f)));
  return Object.fromEntries(
    Object.entries(item)
      .filter(([key]) => keep.has(key))
      .toSorted(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * search_issues / search_pull_requests over the base world: `is:issue` or
 * `is:pr` is implied, `repo:` from owner/repo when both are given
 * (upstream search_utils.go:105); `{total_count, incomplete_results, items}`
 * with raw REST items, paged 30 at a time.
 */
function searchFor(kind: 'issue' | 'pr', args: FakeArgs): unknown {
  const query = str(args['query']) ?? '';
  if (query.trim() === '') return fakeError('missing required parameter: query');
  const scoped =
    REPOS.find((repo) => searchScopedTo(args, repo)) ??
    (qualifier(query, 'repo') !== undefined ? undefined : null);
  // A repo: qualifier naming no repository GitHub has: 422.
  if (scoped === undefined) {
    return fakeError(
      `failed to search ${kind === 'issue' ? 'issues' : 'pull requests'}: Validation Failed\nSearch.q (invalid): The listed users and repositories cannot be searched either because the resources do not exist or you do not have permission to view them.`,
    );
  }
  const repos = scoped === null ? REPOS.slice(0, 2) : [scoped];
  const state = searchState(query);
  const labels = qualifiers(query, 'label');
  const author = qualifier(query, 'author');
  const terms = queryTerms(query);
  const hits: { slug: string; issue: IssueRecord }[] = [];
  for (const repo of repos) {
    const slug = `${repo.owner}/${repo.repo}`;
    const pool: IssueRecord[] =
      kind === 'issue' ? [...issuesOf(repo)] : pullsOf(repo).map(pullAsIssue);
    for (const issue of pool) {
      if (state !== '' && issue.state !== state) continue;
      if (!labels.every((label) => issue.labels.map((l) => l.toLowerCase()).includes(label)))
        continue;
      if (author !== undefined && issue.user.toLowerCase() !== author.replace(/^@/, '')) continue;
      if (!textMatches(`${issue.title} ${issue.body}`, terms)) continue;
      hits.push({ slug, issue });
    }
  }
  let ordered = hits;
  const sort = lower(args['sort']);
  if (sort === 'created' || sort === 'updated') {
    const key = sort === 'created' ? 'created_at' : 'updated_at';
    ordered = hits.toSorted((a, b) => b.issue[key].localeCompare(a.issue[key]));
    if (lower(args['order']) === 'asc') ordered = ordered.toReversed();
  }
  const page = pageOf(ordered, args);
  return {
    total_count: ordered.length,
    incomplete_results: false,
    items: page.items.map(({ slug, issue }) => pickFields(searchItem(slug, issue), args['fields'])),
  };
}

/** get_file_contents' success for a text file: a status line plus the file as an embedded resource (upstream repositories.go:1173). */
export function fileContent(
  slug: string,
  ref: string,
  path: string,
  text: string,
  note = '',
): FakeContent {
  return new FakeContent([
    {
      type: 'text',
      text: `successfully downloaded text file (SHA: ${stableSha(`blob:${slug}:${path}:${text}`)})${note}`,
    },
    {
      type: 'resource',
      resource: {
        uri: `repo://${slug}/sha/${stableSha(`${slug}:${ref}`)}/contents/${path}`,
        mimeType: 'text/plain; charset=utf-8',
        text,
      },
    },
  ]);
}

/** A directory listing entry: go-github's RepositoryContent (upstream repositories.go:1194). */
export function dirEntry(
  slug: string,
  ref: string,
  path: string,
  type: 'file' | 'dir',
): Record<string, unknown> {
  const name = path.split('/').at(-1) ?? path;
  const sha = stableSha(`${type}:${slug}:${path}`);
  return {
    type,
    size: type === 'file' ? 40 + (path.length % 60) * 13 : 0,
    name,
    path,
    sha,
    url: `${API}/repos/${slug}/contents/${path}?ref=${ref}`,
    git_url: `${API}/repos/${slug}/git/${type === 'file' ? 'blobs' : 'trees'}/${sha}`,
    html_url: `${WEB}/${slug}/${type === 'file' ? 'blob' : 'tree'}/${ref}/${path}`,
    ...(type === 'file'
      ? { download_url: `https://raw.githubusercontent.com/${slug}/${ref}/${path}` }
      : {}),
  };
}

/** Every path in a modelled repository's tree, files and directories. */
function treeOf(repo: FakeRepo): { path: string; type: 'file' | 'dir'; text?: string }[] {
  if (repo === REPOS[1]) {
    return [
      { path: 'package.json', type: 'file', text: HARD_PACKAGE_JSON },
      { path: 'readme.md', type: 'file', text: HARD_README_TEXT },
      { path: 'src', type: 'dir' },
      ...HARD_SRC_FILES.map((name) => ({
        path: `src/${name}`,
        type: 'file' as const,
        text: `// ${name}\nexport {};\n`,
      })),
    ];
  }
  if (repo === REPOS[0]) {
    return [
      { path: 'LICENSE', type: 'file', text: 'MIT License\n' },
      { path: 'README.md', type: 'file', text: BASIC_README_TEXT },
      {
        path: 'package.json',
        type: 'file',
        text: '{\n  "name": "@modelcontextprotocol/servers"\n}\n',
      },
      { path: 'src', type: 'dir' },
      { path: 'src/index.ts', type: 'file', text: 'export {};\n' },
    ];
  }
  return [{ path: 'README.md', type: 'file', text: `# ${repo.repo}\n` }];
}

/**
 * The ref a get_file_contents call resolves to (upstream
 * repositories_helper.go:475): empty is the default branch; a branch or
 * tag name must exist, except `main`, which silently falls back to the
 * default branch with a note.
 */
function resolveRef(repo: FakeRepo, args: FakeArgs): { ref: string; note: string } | FakeError {
  const raw = (str(args['ref']) ?? '').trim();
  if (str(args['sha']) !== undefined && str(args['sha']) !== '')
    return { ref: str(args['sha']) as string, note: '' };
  if (raw === '') return { ref: repo.default_branch, note: '' };
  if (/^[0-9a-f]{40}$/i.test(raw)) return { ref: raw, note: '' };
  const name = raw.replace(/^refs\/(heads|tags)\//, '').replace(/^(heads|tags)\//, '');
  if (branchesOf(repo).includes(name)) return { ref: name, note: '' };
  if (name === 'main') {
    return {
      ref: repo.default_branch,
      note: ` Note: the provided ref 'main' does not exist, default branch 'refs/heads/${repo.default_branch}' was used instead.`,
    };
  }
  if (raw.startsWith('refs/')) {
    return fakeError(
      `failed to resolve git reference: failed to get final reference for "${raw}": GET ${API}/repos/${repo.owner}/${repo.repo}/git/ref/${raw.replace(/^refs\//, '')}: 404 Not Found []`,
    );
  }
  return fakeError(
    `failed to resolve git reference: could not resolve ref "${raw}" as a branch or a tag`,
  );
}

/**
 * get_file_contents (upstream repositories.go:984): a file is a status line
 * plus an embedded text resource; a directory a bare array of entries; a
 * path that is neither gets the tree's case-sensitive suffix matches (not
 * an error) or, with none, the server's "Failed to get file contents" error.
 */
function fileContentsFor(args: FakeArgs): unknown {
  const repo = repoOf(args);
  if (repo === undefined) {
    return fakeError(
      `failed to resolve git reference: failed to get repository info: GET ${API}/repos/${slugOf(args)}: 404 Not Found []`,
    );
  }
  const slug = `${repo.owner}/${repo.repo}`;
  const resolved = resolveRef(repo, args);
  if (resolved instanceof FakeError) return resolved;
  const path = (str(args['path']) ?? '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const tree = treeOf(repo);
  const children = (dir: string): Record<string, unknown>[] =>
    tree
      .filter((entry) => {
        const parent = entry.path.includes('/')
          ? entry.path.slice(0, entry.path.lastIndexOf('/'))
          : '';
        return parent === dir;
      })
      .map((entry) =>
        pickFields(dirEntry(slug, resolved.ref, entry.path, entry.type), args['fields']),
      );
  if (path === '') return children('');
  const hit = tree.find((entry) => entry.path === path);
  if (hit?.type === 'file')
    return fileContent(slug, resolved.ref, path, hit.text ?? '', resolved.note);
  if (hit?.type === 'dir') return children(path);
  const matches = tree
    .filter((entry) => entry.path.endsWith(path))
    .slice(0, 3)
    .map((entry) => (entry.type === 'dir' ? `${entry.path}/` : entry.path));
  if (matches.length > 0) {
    return fakeText(
      `Resolved potential matches in the repository tree (resolved refs: {"Ref":"refs/heads/${resolved.ref}","SHA":"${stableSha(`${slug}:${resolved.ref}`)}"}, matching files: ${JSON.stringify(matches)}).`,
    );
  }
  return fakeError(
    'Failed to get file contents. The path does not point to a file or directory, or the file does not exist in the repository.',
  );
}

/**
 * get_repository_tree (upstream git.go:20): the tree at the default branch
 * (or `tree_sha`); `path_filter` is a plain prefix test on the entry path.
 */
function repositoryTreeFor(args: FakeArgs): unknown {
  const repo = repoOf(args);
  if (repo === undefined) {
    return apiError('failed to get repository info', 'GET', `/repos/${slugOf(args)}`);
  }
  const slug = `${repo.owner}/${repo.repo}`;
  const treeSha = (str(args['tree_sha']) ?? '').trim() || repo.default_branch;
  const recursive = args['recursive'] === true;
  const filter = str(args['path_filter']) ?? '';
  const entries = treeOf(repo)
    .filter((entry) => recursive || !entry.path.includes('/'))
    .filter((entry) => entry.path.startsWith(filter))
    .map((entry) => {
      const sha = stableSha(`${entry.type}:${slug}:${entry.path}`);
      return {
        path: entry.path,
        type: entry.type === 'file' ? 'blob' : 'tree',
        ...(entry.type === 'file' ? { size: 40 + (entry.path.length % 60) * 13 } : {}),
        mode: entry.type === 'file' ? '100644' : '040000',
        sha,
        url: `${API}/repos/${slug}/git/${entry.type === 'file' ? 'blobs' : 'trees'}/${sha}`,
      };
    });
  return {
    sha: stableSha(`${slug}:${treeSha}`),
    truncated: false,
    tree: entries,
    tree_sha: treeSha,
    owner: repo.owner,
    repo: repo.repo,
    recursive,
    count: entries.length,
  };
}

/**
 * add_issue_comment (upstream issues.go:1402): a body or a reaction; the
 * new comment's `{id, url}`.
 */
function addIssueCommentFor(args: FakeArgs): unknown {
  if (args['body'] === undefined && args['reaction'] === undefined) {
    return fakeError('at least one of body or reaction is required');
  }
  const repo = repoOf(args);
  const n = num(args['issue_number']);
  if (repo === undefined || issueByNumber(repo, n) === undefined) {
    return apiError(
      'failed to create comment',
      'POST',
      `/repos/${slugOf(args)}/issues/${String(n)}/comments`,
    );
  }
  const slug = `${repo.owner}/${repo.repo}`;
  const id = stableId(
    `comment:${slug}#${String(n)}:${str(args['body']) ?? ''}`,
    3_300_000_000,
    100_000_000,
  );
  return { id: String(id), url: `${WEB}/${slug}/issues/${String(n)}#issuecomment-${id}` };
}

/**
 * create_branch (upstream repositories.go:1532): from `from_branch` or the
 * default branch; a missing source is go-github's 404 on the ref (no hint
 * about the default branch); success is the new git Reference.
 */
function createBranchFor(args: FakeArgs): unknown {
  const repo = repoOf(args);
  const branch = (str(args['branch']) ?? '').trim();
  if (branch === '') return fakeError('missing required parameter: branch');
  if (repo === undefined) {
    return apiError(
      args['from_branch'] === undefined ? 'failed to get repository' : 'failed to get reference',
      'GET',
      args['from_branch'] === undefined
        ? `/repos/${slugOf(args)}`
        : `/repos/${slugOf(args)}/git/ref/heads/${str(args['from_branch']) ?? ''}`,
    );
  }
  const slug = `${repo.owner}/${repo.repo}`;
  const from = (str(args['from_branch']) ?? '').trim() || repo.default_branch;
  if (!branchesOf(repo).includes(from)) {
    return apiError('failed to get reference', 'GET', `/repos/${slug}/git/ref/heads/${from}`);
  }
  if (branchesOf(repo).includes(branch.replace(/^refs\/heads\//, ''))) {
    return fakeError('failed to create branch: Reference already exists');
  }
  const sha = stableSha(`${slug}:${from}`);
  return {
    ref: `refs/heads/${branch}`,
    url: `${API}/repos/${slug}/git/refs/heads/${branch}`,
    object: { type: 'commit', sha, url: `${API}/repos/${slug}/git/commits/${sha}` },
    node_id: `REF_kwDO${stableId(`ref:${slug}:${branch}`).toString(36).toUpperCase()}`,
  };
}

/** pull_request_read over the base world (upstream pullrequests.go:27). */
function pullRequestReadFor(args: FakeArgs): unknown {
  const repo = repoOf(args);
  const n = num(args['pullNumber']);
  const method = lower(args['method']);
  const pull = repo === undefined ? undefined : pullByNumber(repo, n);
  const slug = slugOf(args);
  if (repo === undefined || pull === undefined) {
    return method === 'get_comments'
      ? apiError(
          'failed to get issue comments',
          'GET',
          `/repos/${slug}/issues/${String(n)}/comments?page=1&per_page=30`,
        )
      : apiError('failed to get pull request', 'GET', `/repos/${slug}/pulls/${String(n)}`);
  }
  switch (method) {
    case 'get_files':
      return pageOf(pull.files, args).items.map(prFile);
    case 'get_review_comments':
      return reviewThreads(
        slug,
        pull.number,
        repo === REPOS[1] ? (HARD_REVIEW_COMMENTS[pull.number] ?? []) : [],
      );
    case 'get_comments':
    case 'get_reviews':
      return [];
    case 'get_commits': {
      const sha = stableSha(`${slug}:${pull.head}`);
      return [
        {
          sha,
          html_url: `${WEB}/${slug}/commit/${sha}`,
          commit: {
            message: pull.title,
            author: {
              name: pull.author,
              email: `${pull.author}@users.noreply.github.com`,
              date: pull.created_at,
            },
          },
          author: minimalUser(pull.author),
        },
      ];
    }
    case 'get_check_runs':
      return { total_count: 0, check_runs: [] };
    case 'get_status':
      return {
        state: 'pending',
        sha: stableSha(`${slug}:${pull.head}`),
        total_count: 0,
        statuses: [],
      };
    case 'get_diff':
      return fakeText(prDiff(pull.files));
    default:
      return minimalPull(slug, pull, true);
  }
}

/** issue_read over the base world (upstream issues.go:793). */
function issueReadFor(args: FakeArgs): unknown {
  const repo = repoOf(args);
  const n = num(args['issue_number']);
  const method = lower(args['method']);
  const slug = slugOf(args);
  const issue = repo === undefined ? undefined : issueByNumber(repo, n);
  if (repo === undefined || issue === undefined) return issueReadMissing(slug, n, method);
  return issueReadOf(slug, issue, method, []);
}

/** issue_read's answer for an issue that exists. */
export function issueReadOf(
  slug: string,
  issue: IssueRecord,
  method: string,
  comments: readonly unknown[],
): unknown {
  switch (method) {
    case 'get_labels':
      return {
        labels: issue.labels.map((name) => labelView(name, slug)),
        totalCount: issue.labels.length,
      };
    case 'get_comments':
      return [...comments];
    case 'get_sub_issues':
      return [];
    case 'get_parent':
      return { parent: null };
    default:
      return minimalIssue(slug, issue);
  }
}

/** issue_read's error for an issue (or repository) that does not exist. */
export function issueReadMissing(slug: string, n: number | undefined, method: string): FakeError {
  switch (method) {
    case 'get_labels':
      return fakeError(
        `Failed to get issue labels: Could not resolve to an Issue with the number of ${String(n)}.`,
      );
    case 'get_comments':
      return apiError(
        'failed to get issue comments',
        'GET',
        `/repos/${slug}/issues/${String(n)}/comments?page=1&per_page=30`,
      );
    case 'get_sub_issues':
      return apiError(
        'failed to list sub-issues',
        'GET',
        `/repos/${slug}/issues/${String(n)}/sub_issues?page=1&per_page=30`,
      );
    case 'get_parent':
      return fakeError(
        `failed to get issue parent: Could not resolve to an Issue with the number of ${String(n)}.`,
      );
    default:
      return apiError('failed to get issue', 'GET', `/repos/${slug}/issues/${String(n)}`);
  }
}

/**
 * search_repositories (upstream search.go:22): `{total_count,
 * incomplete_results, items}` of MinimalRepository. `user:`/`owner:`/`org:`
 * scope to an owner; free text matches names and descriptions.
 */
function searchRepositoriesFor(args: FakeArgs): unknown {
  const query = lower(args['query']);
  if (query === '')
    return fakeError(
      'invalid arguments: normalize tool arguments: missing required parameter: query',
    );
  const owner = qualifier(query, 'user') ?? qualifier(query, 'owner') ?? qualifier(query, 'org');
  const ownerLogin = owner === '@me' ? FAKE_USER : owner;
  const terms = queryTerms(query);
  const hits = REPOS.filter(
    (repo) =>
      (ownerLogin === undefined || repo.owner.toLowerCase() === ownerLogin) &&
      textMatches(
        `${repo.owner} ${repo.repo} ${repo.owner}/${repo.repo} ${repo.description}`,
        terms,
      ),
  );
  const page = pageOf(hits, args);
  return {
    total_count: hits.length,
    incomplete_results: false,
    items: page.items.map((repo) => minimalRepo(repo)),
  };
}

/**
 * issue_write (upstream issues.go:2695): create needs a title; update
 * needs an issue_number; both answer the issue's `{id, url}`, never the
 * issue itself (:3376, :3603).
 */
function issueWriteFor(args: FakeArgs): unknown {
  const repo = repoOf(args);
  const slug = slugOf(args);
  if (lower(args['method']) === 'create') {
    if ((str(args['title']) ?? '') === '') return fakeError('missing required parameter: title');
    if (repo === undefined)
      return apiError('failed to create issue', 'POST', `/repos/${slug}/issues`);
    return {
      id: String(issueId(slug, CREATED_ISSUE_NUMBER)),
      url: `${WEB}/${slug}/issues/${CREATED_ISSUE_NUMBER}`,
    };
  }
  const update = validateIssueUpdate(args);
  if (update !== undefined) return update;
  const n = num(args['issue_number']) as number;
  if (repo === undefined || issueByNumber(repo, n) === undefined) {
    return apiError('failed to update issue', 'PATCH', `/repos/${slug}/issues/${n}`);
  }
  const kind = issueByNumber(repo, n)?.pull === true ? 'pull' : 'issues';
  return { id: String(issueId(slug, n)), url: `${WEB}/${slug}/${kind}/${n}` };
}

/** issue_write update's own checks, before any API call (upstream issues.go:3014, :3618). */
export function validateIssueUpdate(args: FakeArgs): FakeError | undefined {
  if (!(num(args['issue_number']) ?? 0))
    return fakeError('missing required parameter: issue_number');
  const reason = lower(args['state_reason']);
  if (args['duplicate_of'] !== undefined && reason !== 'duplicate') {
    return fakeError("duplicate_of can only be used when state_reason is 'duplicate'");
  }
  if (reason === 'duplicate' && args['duplicate_of'] === undefined) {
    return fakeError("duplicate_of must be provided when state_reason is 'duplicate'");
  }
  return undefined;
}

/**
 * list_dependabot_alerts (upstream dependabot.go:100): `{alerts,
 * pageInfo}`; the advertised `state` default is not applied, so no state
 * means every state.
 */
function dependabotAlertsFor(args: FakeArgs): unknown {
  const repo = repoOf(args);
  if (repo === undefined) {
    const slug = slugOf(args);
    return fakeError(
      `failed to list alerts for repository '${slug}'. Your token may not have access to Dependabot alerts on ${slug}. To access Dependabot alerts, the token needs the 'security_events' scope or, for fine-grained tokens, Dependabot alerts read permission for this specific repository.: GET ${API}/repos/${slug}/dependabot/alerts?per_page=30: 404 Not Found []`,
    );
  }
  const alerts = repo.owner === FAKE_USER ? (USER_DEPENDABOT_ALERTS[repo.repo] ?? []) : [];
  const severity = lower(args['severity']);
  const state = lower(args['state']);
  const slug = `${repo.owner}/${repo.repo}`;
  return {
    alerts: alerts
      .filter((alert) => {
        const a = alert as { state: string; security_advisory: { severity: string } };
        return (
          (state === '' || a.state === state) &&
          (severity === '' || a.security_advisory.severity === severity)
        );
      })
      .map((alert) => {
        const a = alert as { number: number };
        return {
          ...(alert as Record<string, unknown>),
          url: `${API}/repos/${slug}/dependabot/alerts/${a.number}`,
          html_url: `${WEB}/${slug}/security/dependabot/${a.number}`,
          created_at: '2026-09-02T08:00:00Z',
          updated_at: '2026-09-02T08:00:00Z',
        };
      }),
    pageInfo: { hasNextPage: false, hasPreviousPage: false },
  };
}

/** list_label (upstream labels.go:131): `{labels, totalCount}`, no paging. */
function listLabelFor(args: FakeArgs): unknown {
  const repo = repoOf(args);
  if (repo === undefined) {
    return fakeError(
      `Failed to list labels: Could not resolve to a Repository with the name '${slugOf(args)}'.`,
    );
  }
  const slug = `${repo.owner}/${repo.repo}`;
  const names = repo === REPOS[1] ? HARD_LABELS : ['bug', 'documentation', 'enhancement'];
  return { labels: names.map((name) => labelView(name, slug)), totalCount: names.length };
}

/** get_label (upstream labels.go:29): the label, or `label 'X' not found in o/r`. */
function getLabelFor(args: FakeArgs): unknown {
  const repo = repoOf(args);
  const name = str(args['name']) ?? '';
  if (repo === undefined) {
    return fakeError(
      `Failed to find label: Could not resolve to a Repository with the name '${slugOf(args)}'.`,
    );
  }
  const slug = `${repo.owner}/${repo.repo}`;
  const names = repo === REPOS[1] ? HARD_LABELS : ['bug', 'documentation', 'enhancement'];
  const found = names.find((n) => n.toLowerCase() === name.toLowerCase());
  return found !== undefined
    ? labelView(found, slug)
    : fakeError(`label '${name}' not found in ${slug}`);
}

/** get_me (upstream context_tools.go:116): MinimalUser with `details`. */
const GET_ME = {
  ...minimalUser(FAKE_USER),
  details: {
    name: 'Vib Dev',
    public_repos: USER_REPOS.length,
    public_gists: 2,
    followers: 18,
    following: 9,
    created_at: '2019-03-14T09:12:44Z',
    updated_at: '2026-10-01T08:00:00Z',
    private_gists: 0,
    total_private_repos: 0,
    owned_private_repos: 0,
  },
};

/** list_notifications (upstream notifications.go:28): raw go-github notifications. */
function notificationsFor(args: FakeArgs): unknown {
  const basic = REPOS[0] as FakeRepo;
  const all = [
    {
      id: '1',
      repository: {
        id: stableId(`repo:${BASIC_SLUG}`),
        name: basic.repo,
        full_name: BASIC_SLUG,
        owner: restUser(basic.owner),
        private: false,
        html_url: `${WEB}/${BASIC_SLUG}`,
      },
      subject: {
        title: 'Crash on startup',
        url: `${API}/repos/${BASIC_SLUG}/issues/42`,
        latest_comment_url: `${API}/repos/${BASIC_SLUG}/issues/comments/3300000042`,
        type: 'Issue',
      },
      reason: 'mention',
      unread: true,
      updated_at: '2026-10-08T14:00:00Z',
      last_read_at: '2026-10-07T09:00:00Z',
      url: `${API}/notifications/threads/1`,
    },
  ];
  const repo = args['owner'] !== undefined || args['repo'] !== undefined ? repoOf(args) : null;
  if (repo === undefined)
    return apiError(
      'failed to get notifications',
      'GET',
      `/repos/${slugOf(args)}/notifications?page=1&per_page=30`,
    );
  return pageOf(
    all.filter((n) => repo === null || n.repository.full_name === `${repo.owner}/${repo.repo}`),
    args,
  ).items;
}

/**
 * Canned answers keyed by tool name. Static values serve the basic tier's
 * repository; functions script the hard tier's world (see the module
 * comment). A tool without one gets {@link unmodeledAnswer}.
 */
export const GITHUB_FAKE_ANSWERS: Readonly<Record<string, FakeAnswer>> = {
  get_me: GET_ME,
  search_issues: (args) => searchFor('issue', args),
  list_issues: (args) => {
    const repo = repoOf(args);
    if (repo === undefined) {
      return fakeError(
        `failed to list issues: Could not resolve to a Repository with the name '${slugOf(args)}'.`,
      );
    }
    return listIssuesPage(issuesOf(repo), args);
  },
  issue_read: issueReadFor,
  list_pull_requests: (args) => {
    const repo = repoOf(args);
    if (repo === undefined) {
      return apiError(
        'failed to list pull requests',
        'GET',
        `/repos/${slugOf(args)}/pulls?page=1&per_page=30`,
      );
    }
    const state = lower(args['state']) || 'open';
    const head = lower(args['head']).replace(/^[^:]*:/, '');
    const base = lower(args['base']);
    let pulls = pullsOf(repo).filter(
      (pull) =>
        (state === 'all' || pull.state === state) &&
        (head === '' || pull.head === head) &&
        (base === '' || pull.base === base),
    );
    if (lower(args['direction']) === 'asc') pulls = pulls.toReversed();
    const slug = `${repo.owner}/${repo.repo}`;
    return pageOf(pulls, args).items.map((pull) =>
      pickFields(minimalPull(slug, pull, false), args['fields']),
    );
  },
  search_pull_requests: (args) => searchFor('pr', args),
  pull_request_read: pullRequestReadFor,
  issue_write: issueWriteFor,
  list_label: listLabelFor,
  get_label: getLabelFor,
  list_branches: (args) => {
    const repo = repoOf(args);
    const page = pageOf(repo === undefined ? [] : branchesOf(repo), args);
    if (repo === undefined) {
      return apiError(
        'failed to list branches',
        'GET',
        `/repos/${slugOf(args)}/branches?page=${page.page}&per_page=${page.perPage}`,
      );
    }
    const slug = `${repo.owner}/${repo.repo}`;
    return page.items.map((name) => ({
      name,
      sha: stableSha(`${slug}:${name}`),
      protected: name === repo.default_branch,
    }));
  },
  create_branch: createBranchFor,
  get_file_contents: fileContentsFor,
  get_repository_tree: repositoryTreeFor,
  add_issue_comment: addIssueCommentFor,
  list_starred_repositories: (args) => {
    const repos = USER_STARRED.map(
      (full) => REPOS.find((r) => `${r.owner}/${r.repo}` === full) as FakeRepo,
    );
    return pageOf(repos, args).items.map((repo) => minimalRepo(repo, true));
  },
  search_repositories: searchRepositoriesFor,
  list_dependabot_alerts: dependabotAlertsFor,
  list_notifications: notificationsFor,
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

/** The text of the real server's write tools' success, where it is plain text. */
const WRITE_TEXT: Readonly<Record<string, (args: FakeArgs) => string>> = {
  star_repository: (args) => `Successfully starred repository ${slugOf(args)}`,
  unstar_repository: (args) => `Successfully unstarred repository ${slugOf(args)}`,
  // upstream pullrequests.go:2142-2332
  pull_request_review_write: (args) => {
    switch (lower(args['method'])) {
      case 'create':
        return (str(args['event']) ?? '') === ''
          ? 'pending pull request created'
          : 'pull request review submitted successfully';
      case 'submit_pending':
        return 'pending pull request review successfully submitted';
      case 'delete_pending':
        return 'pending pull request review successfully deleted';
      case 'unresolve_thread':
        return 'review thread unresolved successfully';
      default:
        return 'review thread resolved successfully';
    }
  },
  add_comment_to_pending_review: () =>
    'pull request review comment successfully added to pending review',
};

/**
 * What a tool without a canned answer returns: what the real server says
 * about data the fake does not hold, never a bare `{ ok: true }` (a model
 * cannot tell that from "nothing there" or from a failure).
 *
 * - On a repository GitHub does not have: a 404.
 * - Reads: a `list_*` answers `[]`, a `search_*` an empty result page, any
 *   other read a 404.
 * - Writes: the real tool's success shape where it is known —
 *   `merge_pull_request`'s merge result, `actions_run_trigger`'s queued
 *   run, star/unstar's text — and otherwise the `{id, url}` MinimalResponse
 *   most of the server's writes return (upstream minimal_types.go:418).
 */
export function unmodeledAnswer(tool: GithubCatalogTool, args: FakeArgs = {}): unknown {
  const scoped = args['owner'] !== undefined && args['repo'] !== undefined;
  if (scoped && repoOf(args) === undefined) {
    return apiError(`failed to call ${tool.name}`, 'GET', `/repos/${slugOf(args)}`);
  }
  if (tool.annotations?.readOnlyHint === true) {
    if (tool.name.startsWith('search_')) {
      return { total_count: 0, incomplete_results: false, items: [] };
    }
    // The remote-only searches (no public source) answer an empty list.
    if (tool.name.startsWith('list_') || tool.name.includes('_search')) return [];
    return fakeError(`failed to call ${tool.name}: 404 Not Found`);
  }
  const text = WRITE_TEXT[tool.name];
  if (text !== undefined) return fakeText(text(args));
  const slug = slugOf(args);
  switch (tool.name) {
    case 'merge_pull_request':
      return {
        sha: stableSha(`merge:${slug}#${str(args['pullNumber']) ?? ''}`),
        merged: true,
        message: 'Pull Request successfully merged',
      };
    case 'actions_run_trigger':
      return actionsRunTrigger(args);
    case 'fork_repository':
      return {
        id: String(stableId(`fork:${slug}`)),
        url: `${WEB}/${str(args['organization']) ?? FAKE_USER}/${str(args['repo']) ?? ''}`,
      };
    default: {
      const n = str(args['pullNumber']) ?? str(args['issue_number']);
      return {
        id: String(stableId(`${tool.name}:${JSON.stringify(args)}`, 3_000_000_000, 400_000_000)),
        url: n !== undefined && scoped ? `${WEB}/${slug}/pull/${n}` : `${WEB}/${slug}`,
      };
    }
  }
}

/** actions_run_trigger's success per method (upstream actions.go:905). */
function actionsRunTrigger(args: FakeArgs): unknown {
  const runId = num(args['run_id']) ?? 0;
  switch (lower(args['method'])) {
    case 'run_workflow':
      return {
        inputs: args['inputs'] ?? null,
        message: 'Workflow run has been queued',
        ref: str(args['ref']) ?? '',
        status: '204 No Content',
        status_code: 204,
        workflow_id: str(args['workflow_id']) ?? '',
        workflow_type: /^\d+$/.test(str(args['workflow_id']) ?? '')
          ? 'workflow_id'
          : 'workflow_file',
      };
    case 'rerun_workflow_run':
      return {
        message: 'Workflow run has been queued for re-run',
        run_id: runId,
        status: '201 Created',
        status_code: 201,
      };
    case 'rerun_failed_jobs':
      return {
        message: 'Failed jobs have been queued for re-run',
        run_id: runId,
        status: '201 Created',
        status_code: 201,
      };
    case 'cancel_workflow_run':
      return {
        message: 'Workflow run has been cancelled',
        run_id: runId,
        status: '202 Accepted',
        status_code: 202,
      };
    default:
      return {
        message: 'Workflow run logs have been deleted',
        run_id: runId,
        status: '204 No Content',
        status_code: 204,
      };
  }
}

/** Resolve a canned answer for a call; undefined when there is none. */
export function answerFor(
  answers: Record<string, FakeAnswer>,
  tool: string,
  args: FakeArgs,
): unknown {
  if (!Object.hasOwn(answers, tool)) {
    const spec = GITHUB_CATALOG.tools.find((t) => t.name === tool);
    return spec !== undefined ? unmodeledAnswer(spec, args) : fakeError(`unknown tool: ${tool}`);
  }
  const answer = answers[tool];
  return typeof answer === 'function' ? (answer as FakeAnswerFn)(args) : answer;
}

/**
 * Arguments as the real server normalises them before validating them
 * against the schema (upstream typed_read_normalizers.go:13): list_issues
 * upper-cases `state`, `orderBy` and `direction`; the paged read tools turn
 * numeric strings in `page`/`perPage` into numbers and drop a 0.
 */
const NORMALIZED: Readonly<Record<string, { upper: readonly string[] }>> = {
  list_issues: { upper: ['state', 'orderBy', 'direction'] },
  list_pull_requests: { upper: [] },
  search_pull_requests: { upper: [] },
  search_issues: { upper: [] },
  list_branches: { upper: [] },
  list_tags: { upper: [] },
  list_commits: { upper: [] },
  search_repositories: { upper: [] },
  list_dependabot_alerts: { upper: [] },
};

export function normalizeArgs(tool: string, args: unknown): unknown {
  const rule = NORMALIZED[tool];
  if (rule === undefined || typeof args !== 'object' || args === null) return args;
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const field of rule.upper) {
    if (typeof out[field] === 'string') out[field] = (out[field] as string).toUpperCase();
  }
  for (const field of ['page', 'perPage']) {
    const value = out[field];
    if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) out[field] = Number(value);
    if (out[field] === 0) delete out[field];
  }
  return out;
}

/** The tool's JSON Schema as a validator that normalises arguments first (see {@link normalizeArgs}). */
function inputSchemaFor(tool: GithubCatalogTool): StandardSchemaWithJSON<Record<string, unknown>> {
  const schema = fromJsonSchema<Record<string, unknown>>(tool.inputSchema as JsonSchemaType);
  if (NORMALIZED[tool.name] === undefined) return schema;
  const standard = schema['~standard'];
  return {
    '~standard': {
      ...standard,
      validate: (data: unknown) => standard.validate(normalizeArgs(tool.name, data)),
    },
  } as StandardSchemaWithJSON<Record<string, unknown>>;
}

/**
 * Build the fake. Each tool is registered with its real JSON Schema (via the
 * SDK's `fromJsonSchema`, so `tools/list` serves the schema verbatim and
 * schema-invalid arguments are rejected before the handler runs, as the real
 * server would — after the real server's own argument normalisation) and
 * its real annotations (so Projection's posture policy — read-only runs,
 * everything else asks — sees what it would see live). The base fake holds
 * no state between calls: a new one per episode starts clean.
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
        inputSchema: inputSchemaFor(tool),
        ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
      },
      (args) => {
        const recorded = args ?? {};
        calls.push({ tool: tool.name, args: recorded });
        options.onCall?.({ tool: tool.name, args: recorded });
        const answer = Object.hasOwn(answers, tool.name)
          ? answerFor(answers, tool.name, recorded)
          : unmodeledAnswer(tool, recorded);
        return toCallResult(answer);
      },
    );
  }

  return { server, calls, tools, instructions };
}

/** An answer as the MCP result the real server sends: compact JSON text, or its text/content/error. */
export function toCallResult(answer: unknown): {
  content: FakeBlock[];
  isError?: true;
} {
  if (answer instanceof FakeError) {
    return { isError: true, content: [{ type: 'text', text: answer.message }] };
  }
  if (answer instanceof FakeText) return { content: [{ type: 'text', text: answer.text }] };
  if (answer instanceof FakeContent) return { content: answer.blocks };
  return { content: [{ type: 'text', text: JSON.stringify(answer) }] };
}
