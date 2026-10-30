/**
 * acme/widgets as the `multi-hard` tier's GitHub box sees it: the base
 * fake's four issues, four PRs and six branches, plus 80 issues, 36 pull
 * requests (with changed files and check runs), 58 branches and 62
 * releases. Served by answer overrides merged over the base fake's
 * (`createGithubFake({ answers })`) only when the multi world is opened
 * with `variant: 'hard'`; every other repository falls through to the base
 * answers unchanged.
 *
 * Paged tools use GitHub's real default page size of 30 (the base fake
 * uses 3 to make page 2 matter for its four-item lists; here the lists are
 * 26–84 items long). Unlike the base fake (stateless), writes persist for
 * the episode: issue creates and updates (labels replaced, as on GitHub),
 * issue comments and PR reviews change the world's state, and later lists,
 * searches and reads show them, so a model that checks its work sees it
 * landed. The state is per world ({@link hardGithubAnswers}), so nothing
 * is shared across episodes; created issues get the next number above
 * every existing issue and PR. Graders read the recorded calls, not this
 * state.
 *
 * Issue and PR search parse GitHub's qualifiers ({@link parseHardQuery}):
 * `created:`/`updated:` ranges, `-label:`, `no:label`, `no:assignee` and
 * the rest a model needs here; any other qualifier is a 422-style error
 * rather than silently ignored. The base fake's search is unchanged.
 */

import {
  fakeError,
  FakeError,
  GITHUB_FAKE_ANSWERS,
  HARD_BRANCHES,
  HARD_DEFAULT_BRANCH,
  HARD_ISSUES,
  HARD_LABELS,
  HARD_PULLS,
  HARD_REPO,
  HARD_REVIEW_COMMENTS,
  queryTerms,
  textMatches,
  type FakeAnswer,
  type FakeArgs,
} from './github-fake.js';
import { HARD_PROJECT_PATHS } from './multi-hard-fixtures.js';

/** GitHub's default page size for REST and GraphQL listings. */
export const HARD_GITHUB_PAGE_SIZE = 30;

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function daysAfter(start: string, days: number): string {
  return new Date(Date.parse(start) + Math.round(days * 86_400) * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Issues

export interface HardIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  assignees: string[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  body: string;
}

/** Paths an issue title names that exist in the project (26) ... */
export const TITLE_PATHS_PRESENT: readonly string[] = [
  'src/export/csv.ts',
  'src/export/json.ts',
  'src/export/xml.ts',
  'src/export/index.ts',
  'src/exporter.ts',
  'src/api/routes.ts',
  'src/api/auth.ts',
  'src/api/users.ts',
  'src/db/pool.ts',
  'src/db/migrate.ts',
  'src/ui/table.tsx',
  'src/ui/chart.tsx',
  'src/cli/main.ts',
  'src/cli/args.ts',
  'docs/setup.md',
  'docs/api.md',
  'scripts/release.sh',
  'src/util.js',
  'src/index.js',
  'config/prod.json',
  'config/dev.json',
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'src/legacy/old.js',
  'test/export/csv.test.ts',
];
/** ... and that do not (14): near misses, and acme/widgets' own src/fetch.ts and src/auth.ts. */
export const TITLE_PATHS_ABSENT: readonly string[] = [
  'src/export/pdf.ts',
  'src/api/admin.ts',
  'src/db/cache.ts',
  'src/ui/modal.tsx',
  'src/cli/init.ts',
  'docs/faq.md',
  'scripts/deploy.sh',
  'src/util.ts',
  'config/staging.json',
  'lib/index.js',
  'src/fetch.ts',
  'src/auth.ts',
  'test/fetch.test.ts',
  'src/export/csv.js',
];

const PATH_TITLES = [
  (p: string) => `Crash in ${p} on empty input`,
  (p: string) => `${p}: handle unicode names`,
  (p: string) => `Typo in ${p}`,
  (p: string) => `Refactor ${p}`,
  (p: string) => `Add tests for ${p}`,
  (p: string) => `${p} logs too much`,
];
const PLAIN_TITLES = [
  'Dark mode for the dashboard',
  'Slow startup on Windows',
  'Support Node 24',
  'Document the release process',
  'Improve error messages',
  'Add a CONTRIBUTING guide',
  'Widgets flicker on resize',
  'Allow custom colour themes',
  'Memory grows during long exports',
  'Retry budget is too low',
  'Translate the UI to German',
  'Keyboard shortcuts',
  'Pagination in the admin list',
  'Telemetry opt-out',
  'Offline mode',
  'Better empty states',
  'Rate limit the public API',
];
const CLOSED_TITLES = [
  'CSV export drops the header row',
  'Connection pool leaks on timeout',
  'JSON export escapes slashes twice',
  'Charts ignore the locale',
  'Login loop after token refresh',
  'Wrong totals in the summary table',
  'Installer fails on ARM',
  'Crash in src/export/csv.ts with quoted fields',
  'Typo in docs/setup.md',
  'Refactor src/db/pool.ts',
  'src/api/routes.ts: missing 404 route',
  'Add tests for src/cli/args.ts',
  'README.md has a broken badge',
  'Crash in src/ui/chart.tsx on resize',
  'package.json lists an unused dependency',
  'Old Safari support',
  'Upgrade the test runner',
  'Flaky upload test',
  'Remove the legacy theme',
];

/** The release-notes issues of v1.2.0, all closed; #41 is the oldest and tkowal filed it. */
export const CHAIN_ISSUES: Readonly<Record<number, { title: string; user: string }>> = {
  41: { title: 'Export hangs on very large tables', user: 'tkowal' },
  57: { title: 'Pool exhaustion under load', user: 'mrossi' },
  63: { title: 'Chart legend overlaps the axis', user: 'tkowalski' },
  72: { title: 'CLI ignores --quiet', user: 'pnair' },
};
export const CHAIN_REPORTER = 'tkowal';

/** Open issues last updated before 2026-07-01: the stale-label task's targets. */
export const STALE_CUTOFF_DATE = '2026-07-01';

const REPORTERS = [
  'tkowal',
  'mrossi',
  'iduarte',
  'pnair',
  'jweber',
  'vhahn',
  'acole',
  'dana-k',
  'omar-s',
  'lfischer',
  'tkowalski',
  'vibdev',
];
const ASSIGNEE_POOL = ['dana-k', 'omar-s', 'vibdev', 'rhea-mm'];
/** The chain-two owner; assigned to exactly {@link RHEA_OPEN_ASSIGNED} open issues. */
export const OWNER_LOGIN = 'rhea-m';

/**
 * The 80 new issues #31–#110, created every 3.4 days from 2025-12-01. The
 * plan: 40 open issues whose title names a path (26 present, 14 absent),
 * 17 open ones whose title names none (some name a path in the body), and
 * 23 closed ones (the four release-notes issues among them, and eight
 * whose titles name present paths). Twelve open issues created before
 * mid-June have not been updated since; the rest were touched July–October.
 */
const NEW_ISSUES: readonly HardIssue[] = (() => {
  const rand = prng(7);
  type Spec = { kind: 'path' | 'plain' | 'closed'; title: string; path?: string };
  const specs: Spec[] = [
    ...shuffled([...TITLE_PATHS_PRESENT, ...TITLE_PATHS_ABSENT], rand).map((path, i) => ({
      kind: 'path' as const,
      title: (PATH_TITLES[i % PATH_TITLES.length] as (p: string) => string)(path),
      path,
    })),
    ...PLAIN_TITLES.map((title) => ({ kind: 'plain' as const, title })),
    ...CLOSED_TITLES.map((title) => ({ kind: 'closed' as const, title })),
  ];
  const free = Array.from({ length: 80 }, (_, i) => 31 + i).filter((n) => !(n in CHAIN_ISSUES));
  const order = shuffled(specs, rand);
  const byNumber = new Map<number, Spec>();
  free.forEach((n, i) => byNumber.set(n, order[i] as Spec));
  for (const [n, chain] of Object.entries(CHAIN_ISSUES)) {
    byNumber.set(Number(n), { kind: 'closed', title: chain.title });
  }

  const issues: HardIssue[] = [];
  for (let n = 31; n <= 110; n += 1) {
    const spec = byNumber.get(n) as Spec;
    const created = daysAfter('2025-12-01T10:00:00Z', (n - 31) * 3.4);
    const open = spec.kind !== 'closed';
    const chain = CHAIN_ISSUES[n];
    const user = chain?.user ?? (REPORTERS[(n * 5) % REPORTERS.length] as string);
    const labelRoll = rand();
    const labels =
      labelRoll < 0.35
        ? ['bug']
        : labelRoll < 0.5
          ? ['enhancement']
          : labelRoll < 0.6
            ? ['documentation', 'needs-triage']
            : [];
    const touched = open
      ? daysAfter('2026-07-02T09:00:00Z', rand() * 110)
      : daysAfter(created, 5 + rand() * 20);
    // An open issue created after its drawn update (#97, #99, #104) is
    // updated a few days after creation instead: never before it.
    const updated = touched < created ? daysAfter(created, 2 + (n % 5)) : touched;
    const body =
      spec.kind === 'plain' && n % 3 === 0
        ? 'Profiling points at src/db/pool.ts.'
        : spec.kind === 'path'
          ? `Seen in ${spec.path ?? ''}.`
          : 'See the discussion in the linked PR.';
    issues.push({
      number: n,
      title: spec.title,
      state: open ? 'open' : 'closed',
      labels,
      user,
      assignees: [],
      created_at: created,
      updated_at: updated,
      closed_at: open ? null : updated,
      body,
    });
  }

  // Twelve open issues created before 2026-06-15 go stale: their last
  // update stays before the cut-off. Chosen every other one, oldest first.
  const staleCandidates = issues.filter(
    (i) => i.state === 'open' && i.created_at < '2026-06-15T00:00:00Z',
  );
  const stale = staleCandidates.filter((_, i) => i % 2 === 0).slice(0, 12);
  for (const issue of stale) issue.updated_at = daysAfter(issue.created_at, 2 + (issue.number % 9));
  // Near misses: the next two open candidates were touched just after the cut-off.
  for (const issue of staleCandidates.filter((_, i) => i % 2 === 1).slice(0, 2)) {
    issue.updated_at = daysAfter('2026-07-01T00:00:00Z', 1.5);
  }

  // Assignees: rhea-m on seven open issues and three closed ones; rhea-mm
  // (a near namesake) and others spread over the rest.
  const openOnes = issues.filter((i) => i.state === 'open');
  const closedOnes = issues.filter((i) => i.state === 'closed');
  openOnes.forEach((issue, i) => {
    if (i % 8 === 3) issue.assignees = [OWNER_LOGIN];
    else if (i % 5 === 1) issue.assignees = [ASSIGNEE_POOL[i % ASSIGNEE_POOL.length] as string];
  });
  closedOnes.slice(0, 3).forEach((issue) => (issue.assignees = [OWNER_LOGIN]));
  return issues;
})();

/** The base fake's four acme/widgets issues, with the fields the hard view adds. */
const BASE_ISSUES: readonly HardIssue[] = HARD_ISSUES.map((issue) => ({
  number: issue.number,
  title: issue.title,
  state: issue.state,
  labels: [...issue.labels],
  user: 'vibdev',
  assignees: [],
  created_at: issue.created_at,
  updated_at: issue.created_at,
  closed_at: issue.state === 'closed' ? issue.created_at : null,
  body: issue.body,
}));

/** Every issue of acme/widgets in the hard world, newest number first. */
export const HARD_WORLD_ISSUES: readonly HardIssue[] = [...BASE_ISSUES, ...NEW_ISSUES].toSorted(
  (a, b) => b.number - a.number,
);

/** Open issues whose title names a file that exists in the project. */
export const EXPECTED_TITLE_FILE_ISSUES: readonly number[] = HARD_WORLD_ISSUES.filter(
  (issue) =>
    issue.state === 'open' && [...HARD_PROJECT_PATHS].some((path) => titleNames(issue.title, path)),
)
  .map((issue) => issue.number)
  .toSorted((a, b) => a - b);

/** Whether `title` names `path` as a whole path (not as a prefix of a longer one). */
export function titleNames(title: string, path: string): boolean {
  const escaped = path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`(^|[\\s\`'"(])${escaped}(?=$|[\\s\`'"):,;]|\\.(\\s|$))`).test(title);
}

/** Open issues last updated before {@link STALE_CUTOFF_DATE}, with their labels. */
export const EXPECTED_STALE_ISSUES: Readonly<Record<number, readonly string[]>> =
  Object.fromEntries(
    HARD_WORLD_ISSUES.filter(
      (issue) => issue.state === 'open' && issue.updated_at < `${STALE_CUTOFF_DATE}T00:00:00Z`,
    ).map((issue) => [issue.number, issue.labels]),
  );

/** Open issues assigned to {@link OWNER_LOGIN}. */
export const RHEA_OPEN_ASSIGNED: number = HARD_WORLD_ISSUES.filter(
  (issue) => issue.state === 'open' && issue.assignees.includes(OWNER_LOGIN),
).length;

/** Labels defined in acme/widgets in the hard world. */
export const HARD_WORLD_LABELS: readonly string[] = [...HARD_LABELS, 'enhancement', 'stale'];

// ---------------------------------------------------------------------------
// Pull requests

export interface HardCheckRun {
  name: string;
  conclusion: 'success' | 'failure' | 'skipped';
  summary: string;
}

export interface HardPull {
  number: number;
  title: string;
  state: 'open' | 'closed';
  author: string;
  head: string;
  created_at: string;
  files: string[];
  checks: HardCheckRun[];
}

const PASSING_CHECKS: readonly HardCheckRun[] = [
  { name: 'build', conclusion: 'success', summary: 'Build succeeded.' },
  { name: 'lint', conclusion: 'success', summary: 'No problems.' },
  { name: 'test', conclusion: 'success', summary: 'All tests passed.' },
];

/** The branching task's PR. */
export const CHECKS_PR = 139;
/**
 * #139's check runs: 11 failing, each reporting one file (two report the
 * same file), 3 passing, 1 skipped.
 */
export const CHECKS_PR_RUNS: readonly HardCheckRun[] = [
  { name: 'build', conclusion: 'success', summary: 'Build succeeded.' },
  { name: 'lint', conclusion: 'failure', summary: 'src/api/routes.ts:42:7 no-unused-vars' },
  { name: 'typecheck', conclusion: 'failure', summary: 'src/api/routes.ts(42,7): error TS2304' },
  { name: 'unit-api', conclusion: 'success', summary: '48 passed.' },
  { name: 'unit-db', conclusion: 'failure', summary: '1 failed in src/db/pool.ts' },
  { name: 'unit-export', conclusion: 'failure', summary: '2 failed in src/export/xml.ts' },
  { name: 'unit-cache', conclusion: 'failure', summary: '3 failed in src/cache/lru.ts' },
  { name: 'unit-cli', conclusion: 'failure', summary: '1 failed in src/cli/args.ts' },
  { name: 'e2e-ui', conclusion: 'failure', summary: 'Snapshot mismatch in src/ui/chart.tsx' },
  { name: 'e2e-export', conclusion: 'failure', summary: 'Timeout in src/export/pdf.ts' },
  { name: 'docs-links', conclusion: 'failure', summary: 'Broken link in docs/api.md' },
  { name: 'bench', conclusion: 'failure', summary: 'Regression in src/perf/bench.ts' },
  { name: 'license-check', conclusion: 'failure', summary: 'Missing header in scripts/license.sh' },
  { name: 'unit-auth', conclusion: 'success', summary: '12 passed.' },
  { name: 'coverage', conclusion: 'skipped', summary: 'Skipped on draft runs.' },
];

/** The file each failing check of #139 reports. */
export function reportedFile(run: HardCheckRun): string | undefined {
  return /([\w-]+\/[\w./-]+\.\w+)/.exec(run.summary)?.[1];
}

/** #139's failing checks' files that exist in the project: one issue each. */
export const EXPECTED_FIX_ISSUES: readonly string[] = [
  ...new Set(
    CHECKS_PR_RUNS.filter((run) => run.conclusion === 'failure')
      .map(reportedFile)
      .filter((path): path is string => path !== undefined && HARD_PROJECT_PATHS.has(path)),
  ),
];
/** #139's failing checks' files that do not: named in a comment on the PR. */
export const EXPECTED_MISSING_FILES: readonly string[] = [
  ...new Set(
    CHECKS_PR_RUNS.filter((run) => run.conclusion === 'failure')
      .map(reportedFile)
      .filter((path): path is string => path !== undefined && !HARD_PROJECT_PATHS.has(path)),
  ),
];

/** The newest open PR (chain two): one failing check, in a file /src/db/ owns. */
export const NEWEST_PR = 146;
const NEWEST_PR_RUNS: readonly HardCheckRun[] = [
  { name: 'build', conclusion: 'success', summary: 'Build succeeded.' },
  { name: 'lint', conclusion: 'success', summary: 'No problems.' },
  {
    name: 'unit-db',
    conclusion: 'failure',
    summary: '1 failed in src/db/pool.ts: connection not released',
  },
  { name: 'unit-api', conclusion: 'success', summary: '48 passed.' },
];
export const NEWEST_PR_FAILING_FILE = 'src/db/pool.ts';

/** Open PRs that change a file under src/export/ (the comment task's targets). */
const EXPORT_PRS: ReadonlySet<number> = new Set([113, 116, 120, 124, 127, 131, 135, 140, 144]);

/**
 * PRs #111–#146, created every 1.5 days from 2026-08-27. 22 are open (the
 * base fake's four make 26), 14 closed. Nine open ones change files under
 * src/export/; decoys change src/exporter.ts, test/export/, or are closed.
 */
const NEW_PULLS: readonly HardPull[] = (() => {
  const rand = prng(11);
  const closed = new Set([112, 115, 118, 119, 122, 126, 129, 130, 133, 136, 138, 141, 143, 145]);
  const exportFiles = [
    'src/export/csv.ts',
    'src/export/json.ts',
    'src/export/xml.ts',
    'src/export/index.ts',
  ];
  const otherFiles = [
    'src/api/routes.ts',
    'src/api/users.ts',
    'src/db/migrate.ts',
    'src/ui/table.tsx',
    'src/cli/main.ts',
    'docs/setup.md',
    'README.md',
    'package.json',
    'pnpm-lock.yaml',
  ];
  const decoys: Readonly<Record<number, { title: string; files: string[] }>> = {
    114: { title: 'Speed up the exporter', files: ['src/exporter.ts'] },
    117: { title: 'Export tests: cover quoting', files: ['test/export/csv.test.ts'] },
    121: { title: 'Export docs', files: ['docs/api.md', 'README.md'] },
    118: { title: 'CSV export: stream rows', files: ['src/export/csv.ts'] },
    133: {
      title: 'XML export: pretty print',
      files: ['src/export/xml.ts', 'test/export/csv.test.ts'],
    },
  };
  const pulls: HardPull[] = [];
  for (let n = 111; n <= 146; n += 1) {
    const open = !closed.has(n);
    const decoy = decoys[n];
    let title: string;
    let files: string[];
    if (decoy !== undefined) {
      ({ title, files } = decoy);
    } else if (EXPORT_PRS.has(n)) {
      const picked = exportFiles.filter((_, i) => (n + i) % 3 !== 0);
      // One target's title says nothing about exports; one also changes src/exporter.ts.
      title =
        n === 124 ? 'Tidy imports' : `Export: improve ${(picked[0] ?? '').split('/').at(-1) ?? ''}`;
      files = [...picked, ...(n === 131 ? ['src/exporter.ts'] : []), 'CHANGELOG.md'];
    } else {
      const count = 1 + Math.floor(rand() * 3);
      files = shuffled(otherFiles, rand).slice(0, count);
      title = `Update ${(files[0] ?? '').split('/').at(-1) ?? ''}`;
    }
    pulls.push({
      number: n,
      title,
      state: open ? 'open' : 'closed',
      author: REPORTERS[(n * 3) % REPORTERS.length] as string,
      head: `feature/pr-${n}`,
      created_at: daysAfter('2026-08-27T09:00:00Z', (n - 111) * 1.5),
      files,
      checks:
        n === CHECKS_PR
          ? [...CHECKS_PR_RUNS]
          : n === NEWEST_PR
            ? [...NEWEST_PR_RUNS]
            : [...PASSING_CHECKS],
    });
  }
  return pulls;
})();

/** Every PR of acme/widgets in the hard world, newest first by creation. */
export const HARD_WORLD_PULLS: readonly HardPull[] = [
  ...HARD_PULLS.map((pull) => ({
    ...pull,
    files: [...pull.files],
    checks: [...PASSING_CHECKS],
  })),
  ...NEW_PULLS,
].toSorted((a, b) => b.created_at.localeCompare(a.created_at));

/** Open PRs that change a file under src/export/. */
export const EXPECTED_EXPORT_PRS: readonly number[] = HARD_WORLD_PULLS.filter(
  (pull) => pull.state === 'open' && pull.files.some((file) => file.startsWith('src/export/')),
)
  .map((pull) => pull.number)
  .toSorted((a, b) => a - b);

// ---------------------------------------------------------------------------
// Branches and releases

/** 64 branches, alphabetical as GitHub lists them: the base six plus 58. */
export const HARD_WORLD_BRANCHES: readonly string[] = (() => {
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

export const EXPECTED_FEATURE_BRANCHES: number = HARD_WORLD_BRANCHES.filter((b) =>
  b.startsWith('feature/'),
).length;

export interface HardRelease {
  tag_name: string;
  name: string;
  published_at: string;
  prerelease: boolean;
  body: string;
}

/** The project's version (package.json) is 1.2.0; its release is tagged v1.2.0. */
export const CHAIN_RELEASE_TAG = 'v1.2.0';

/**
 * 62 releases, oldest first: fifteen in 2023–2024, then 46 from 2025-01 to
 * 2026-09 ending at v1.2.0, then the v1.3.0-rc.1 prerelease. Listed newest
 * first, the first 2025 release is item 47 — on page 2 at the default 30.
 */
export const HARD_WORLD_RELEASES: readonly HardRelease[] = (() => {
  // 60 versions 0.1.0 … 1.1.5 (eleven minors, five or six patches each), then 1.2.0.
  const minors = ['0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9', '1.0', '1.1'];
  const patches = [5, 6, 5, 6, 5, 6, 5, 6, 5, 5, 6];
  const all = [
    ...minors.flatMap((minor, m) =>
      Array.from({ length: patches[m] as number }, (_, p) => `${minor}.${p}`),
    ),
    '1.2.0',
  ];
  const releases: HardRelease[] = all.map((version, i) => {
    const published =
      i < 15
        ? daysAfter('2023-03-01T12:00:00Z', i * 45)
        : daysAfter('2025-01-08T12:00:00Z', (i - 15) * 13.5);
    const refs = [31 + ((i * 7) % 80), 31 + ((i * 13) % 80)].filter((n) => !(n in CHAIN_ISSUES));
    const body =
      version === '1.2.0'
        ? "## What's changed\n\n- Fix export on very large tables (#63, #41)\n- Fix pool exhaustion (#72, #57)\n"
        : `## What's changed\n\n- Maintenance and fixes (${refs.map((n) => `#${n}`).join(', ')})\n`;
    return {
      tag_name: `v${version}`,
      name: `v${version}`,
      published_at: published,
      prerelease: false,
      body,
    };
  });
  releases.push({
    tag_name: 'v1.3.0-rc.1',
    name: 'v1.3.0 release candidate 1',
    published_at: '2026-10-10T12:00:00Z',
    prerelease: true,
    body: "## What's changed\n\n- Release candidate for 1.3.0\n",
  });
  return releases.toReversed();
})();

/** The tag of the first release published in 2025. */
export const EXPECTED_FIRST_2025_TAG: string = (() => {
  const in2025 = HARD_WORLD_RELEASES.filter((r) => r.published_at.startsWith('2025-'));
  return (in2025.toSorted((a, b) => a.published_at.localeCompare(b.published_at))[0] as HardRelease)
    .tag_name;
})();

// ---------------------------------------------------------------------------
// Answers

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

function isHardRepo(args: FakeArgs): boolean {
  return lower(args['owner']) === HARD_REPO.owner && lower(args['repo']) === HARD_REPO.repo;
}

function scopedToHardRepo(args: FakeArgs): boolean {
  const query = lower(args['query']);
  return isHardRepo(args) || query.includes(`${HARD_REPO.owner}/${HARD_REPO.repo}`);
}

/** Keep only `fields` (when given) of each item. */
function pick(item: Record<string, unknown>, fields: unknown): Record<string, unknown> {
  if (!Array.isArray(fields) || fields.length === 0) return item;
  const keep = new Set(fields.map((f) => String(f)));
  return Object.fromEntries(Object.entries(item).filter(([key]) => keep.has(key)));
}

interface Page<T> {
  items: T[];
  page: number;
  perPage: number;
  total: number;
  hasNext: boolean;
}

function paged<T>(items: readonly T[], args: FakeArgs): Page<T> {
  const page = Math.max(1, Math.floor(num(args['page']) ?? 1));
  const perPage = Math.min(
    100,
    Math.max(1, Math.floor(num(args['perPage']) ?? HARD_GITHUB_PAGE_SIZE)),
  );
  const start = (page - 1) * perPage;
  return {
    items: items.slice(start, start + perPage),
    page,
    perPage,
    total: items.length,
    hasNext: start + perPage < items.length,
  };
}

const ISSUE_URL = `https://github.com/${HARD_REPO.owner}/${HARD_REPO.repo}/issues/`;
const PULL_URL = `https://github.com/${HARD_REPO.owner}/${HARD_REPO.repo}/pull/`;

/** A comment posted on an issue or PR during the episode. */
interface HardComment {
  id: number;
  user: { login: string };
  body: string;
  created_at: string;
  html_url: string;
}

/** A PR review submitted (or left pending) during the episode. */
interface HardReview {
  id: number;
  user: { login: string };
  state: 'PENDING' | 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED';
  body: string;
  /** Comments added to it while pending. */
  comments: { path: string; body: string }[];
  submitted_at: string | null;
}

/**
 * One world's acme/widgets as its writes leave it: the seeded issues
 * (copied, so updates never touch {@link HARD_WORLD_ISSUES}) plus the
 * issues, comments and reviews written since. Created by
 * {@link hardGithubAnswers} per world, so nothing is shared across
 * episodes. Writes stamp a clock that starts after every seeded date.
 */
interface HardState {
  issues: HardIssue[];
  comments: Map<number, HardComment[]>;
  reviews: Map<number, HardReview[]>;
  /** The last issue number handed out. */
  lastNumber: number;
  /** The last comment / review id handed out. */
  lastId: number;
  /** Writes so far, for the write clock. */
  writes: number;
}

/** The fake's login: whoever the token belongs to. */
const WRITER = 'vibdev';
/** The write clock: write k happens k minutes after this. */
const WRITE_CLOCK_START = Date.parse('2026-10-29T12:00:00Z');

function newState(): HardState {
  return {
    issues: HARD_WORLD_ISSUES.map((issue) => ({
      ...issue,
      labels: [...issue.labels],
      assignees: [...issue.assignees],
    })),
    comments: new Map(),
    reviews: new Map(),
    lastNumber: HARD_MAX_NUMBER,
    lastId: 900_000,
    writes: 0,
  };
}

function tick(st: HardState): string {
  st.writes += 1;
  return new Date(WRITE_CLOCK_START + st.writes * 60_000).toISOString();
}

function issueView(issue: HardIssue, st: HardState): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    user: { login: issue.user },
    labels: issue.labels.map((name) => ({ name })),
    assignees: issue.assignees.map((login) => ({ login })),
    // Seeded issues report a few earlier comments; this episode's add to them.
    comments:
      (issue.number <= HARD_MAX_NUMBER ? issue.number % 4 : 0) +
      (st.comments.get(issue.number)?.length ?? 0),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    body: issue.body,
    html_url: `${ISSUE_URL}${issue.number}`,
  };
}

function pullView(pull: HardPull): Record<string, unknown> {
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    user: { login: pull.author },
    head: { ref: pull.head },
    base: { ref: HARD_DEFAULT_BRANCH },
    created_at: pull.created_at,
    updated_at: pull.created_at,
    changed_files: pull.files.length,
    html_url: `${PULL_URL}${pull.number}`,
  };
}

function cursorOf(offset: number): string {
  return Buffer.from(`cursor:${offset}`).toString('base64');
}

function offsetOf(cursor: unknown): number {
  const text = str(cursor);
  if (text === undefined || text === '') return 0;
  const decoded = Buffer.from(text, 'base64').toString('utf8');
  const m = /^cursor:(\d+)$/.exec(decoded);
  return m === null ? 0 : Number(m[1]);
}

function listIssues(st: HardState, args: FakeArgs): unknown {
  const state = lower(args['state']);
  const labels = Array.isArray(args['labels']) ? args['labels'].map(lower) : [];
  const since = str(args['since']);
  let issues = st.issues.filter(
    (issue) =>
      (state === '' || issue.state === state) &&
      labels.every((label) => issue.labels.includes(label)) &&
      (since === undefined || since === '' || issue.updated_at >= since),
  );
  const orderBy = lower(args['orderBy']);
  const key: keyof HardIssue =
    orderBy === 'updated_at' ? 'updated_at' : orderBy === 'comments' ? 'number' : 'created_at';
  issues = issues.toSorted((a, b) => String(b[key]).localeCompare(String(a[key])));
  if (key === 'number') issues = issues.toSorted((a, b) => (b.number % 4) - (a.number % 4));
  if (lower(args['direction']) === 'asc') issues = issues.toReversed();
  const perPage = Math.min(
    100,
    Math.max(1, Math.floor(num(args['perPage']) ?? HARD_GITHUB_PAGE_SIZE)),
  );
  const offset = offsetOf(args['after']);
  const page = issues.slice(offset, offset + perPage);
  const hasNextPage = offset + perPage < issues.length;
  return {
    issues: page.map((issue) => pick(issueView(issue, st), args['fields'])),
    pageInfo: {
      hasNextPage,
      hasPreviousPage: offset > 0,
      endCursor: hasNextPage ? cursorOf(offset + perPage) : null,
    },
    totalCount: issues.length,
  };
}

// ---------------------------------------------------------------------------
// Search queries (hard world only: the base fake's search is unchanged)

/** One issue or PR as the hard world's search filters it. */
interface Searchable {
  kind: 'issue' | 'pr';
  state: 'open' | 'closed';
  title: string;
  body: string;
  labels: readonly string[];
  assignees: readonly string[];
  author: string;
  head?: string;
  created_at: string;
  updated_at: string;
}

function issueSearchable(issue: HardIssue): Searchable {
  return {
    kind: 'issue',
    state: issue.state,
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
    assignees: issue.assignees,
    author: issue.user,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

function pullSearchable(pull: HardPull): Searchable {
  return {
    kind: 'pr',
    state: pull.state,
    title: pull.title,
    body: '',
    labels: [],
    assignees: [],
    author: pull.author,
    head: pull.head,
    created_at: pull.created_at,
    updated_at: pull.created_at,
  };
}

/** A parsed hard-world search query: its qualifiers as filters, plus the free text. */
interface HardQuery {
  filters: ((item: Searchable) => boolean)[];
  terms: string[];
  /** Where the free text must match (`in:`); both when unset. */
  textIn: Set<'title' | 'body'>;
  sort?: { key: 'created_at' | 'updated_at'; asc: boolean };
}

const DAY_MS = 86_400_000;

const msOf = (iso: string): number => Date.parse(iso);

/**
 * A date qualifier operand as a half-open interval [start, end) in ms: a
 * date covers its whole UTC day, a date-time just that instant. Undefined
 * when it is neither.
 */
function dateSpan(value: string): { start: number; end: number } | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const start = Date.parse(`${value}T00:00:00Z`);
    return Number.isNaN(start) ? undefined : { start, end: start + DAY_MS };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(value)) {
    const start = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`);
    return Number.isNaN(start) ? undefined : { start, end: start + 1 };
  }
  return undefined;
}

/**
 * GitHub's date qualifier syntax (`created:`, `updated:`) as a predicate on
 * an ISO timestamp: `<D`, `<=D`, `>D`, `>=D`, `D..D` (either side `*`), or
 * an exact `D`. A date compares by whole days (`<2026-07-01` is before that
 * day, `>2026-07-01` after it, `2026-07-01` within it). Undefined when the
 * operand does not parse.
 */
export function dateRange(spec: string): ((iso: string) => boolean) | undefined {
  const range = /^(.*)\.\.(.*)$/.exec(spec);
  if (range !== null) {
    const [lo, hi] = [range[1] as string, range[2] as string];
    const from = lo === '*' ? { start: -Infinity, end: -Infinity } : dateSpan(lo);
    const to = hi === '*' ? { start: Infinity, end: Infinity } : dateSpan(hi);
    if (from === undefined || to === undefined) return undefined;
    return (iso) => msOf(iso) >= from.start && msOf(iso) < to.end;
  }
  const m = /^(<=|>=|<|>)?(.+)$/.exec(spec);
  const span = m === null ? undefined : dateSpan(m[2] as string);
  if (m === null || span === undefined) return undefined;
  switch (m[1]) {
    case '<':
      return (iso) => msOf(iso) < span.start;
    case '<=':
      return (iso) => msOf(iso) < span.end;
    case '>':
      return (iso) => msOf(iso) >= span.end;
    case '>=':
      return (iso) => msOf(iso) >= span.start;
    default:
      return (iso) => msOf(iso) >= span.start && msOf(iso) < span.end;
  }
}

/** A `name:value` qualifier (optionally negated), value unquoted. */
const QUALIFIER = /(^|\s)(-?)([A-Za-z][\w-]*):("[^"]*"|\S*)/g;

const invalid = (message: string): FakeError =>
  fakeError(
    `422 Validation Failed: ${message} (search query not supported by this repository's search).`,
  );

/**
 * Parse a search query for `kind` (issue or PR search). Supported: `repo:`,
 * `user:`, `org:`, `is:`/`state:` open|closed, `is:`/`type:` issue|pr,
 * `in:` title|body, `label:` (comma = any of), `-label:`, `no:label`,
 * `no:assignee`, `assignee:`, `author:`, `head:` (PRs), `created:` and
 * `updated:` ranges, and `sort:` created|updated[-asc|-desc]. Anything
 * else is a 422-style error, never silently ignored.
 */
export function parseHardQuery(query: string): HardQuery | FakeError {
  const parsed: HardQuery = { filters: [], terms: [], textIn: new Set() };
  const textIn = parsed.textIn;
  for (const m of query.matchAll(QUALIFIER)) {
    const negated = m[2] === '-';
    const name = (m[3] as string).toLowerCase();
    const raw = (m[4] as string).replace(/^"|"$/g, '');
    const value = raw.toLowerCase();
    const whole = `${m[2] ?? ''}${m[3] ?? ''}:${m[4] ?? ''}`;
    if (value === '') return invalid(`"${whole}" has no value`);
    if (negated && name !== 'label') return invalid(`"${whole}": only -label: may be negated`);
    switch (name) {
      case 'repo':
      case 'user':
      case 'org':
        break;
      case 'is':
      case 'state':
      case 'type':
        if (value === 'open' || value === 'closed') {
          if (name === 'type') return invalid(`"${whole}": type is issue or pr`);
          parsed.filters.push((item) => item.state === value);
        } else if (value === 'issue' || value === 'pr') {
          if (name === 'state') return invalid(`"${whole}": state is open or closed`);
          const kind = value === 'issue' ? 'issue' : 'pr';
          parsed.filters.push((item) => item.kind === kind);
        } else {
          return invalid(`"${whole}" is not supported`);
        }
        break;
      case 'in':
        for (const field of value.split(',')) {
          if (field !== 'title' && field !== 'body') return invalid(`"${whole}" is not supported`);
          textIn.add(field);
        }
        break;
      case 'label': {
        const any = value.split(',').filter((l) => l !== '');
        parsed.filters.push((item) => {
          const has = any.some((label) => item.labels.includes(label));
          return negated ? !has : has;
        });
        break;
      }
      case 'no':
        if (value === 'label') parsed.filters.push((item) => item.labels.length === 0);
        else if (value === 'assignee') parsed.filters.push((item) => item.assignees.length === 0);
        else return invalid(`"${whole}" is not supported`);
        break;
      case 'assignee': {
        const login = value.replace(/^@/, '');
        parsed.filters.push((item) => item.assignees.includes(login));
        break;
      }
      case 'author': {
        const login = value.replace(/^@/, '');
        parsed.filters.push((item) => item.author === login);
        break;
      }
      case 'head':
        parsed.filters.push((item) => item.head === value);
        break;
      case 'created':
      case 'updated': {
        const test = dateRange(raw.toUpperCase());
        if (test === undefined) return invalid(`"${whole}" is not a date or date range`);
        const key = name === 'created' ? 'created_at' : 'updated_at';
        parsed.filters.push((item) => test(item[key]));
        break;
      }
      case 'sort': {
        const s = /^(created|updated)(?:-(asc|desc))?$/.exec(value);
        if (s === null) return invalid(`"${whole}" is not supported`);
        parsed.sort = {
          key: s[1] === 'created' ? 'created_at' : 'updated_at',
          asc: s[2] === 'asc',
        };
        break;
      }
      default:
        return invalid(`unknown qualifier "${name}:"`);
    }
  }
  parsed.terms = queryTerms(query.replace(QUALIFIER, ' '));
  return parsed;
}

/** `items` matching `query`, sorted by its `sort:` or the call's `sort`/`order`. */
function searchHard<T>(
  items: readonly T[],
  view: (item: T) => Searchable,
  query: HardQuery,
  args: FakeArgs,
): T[] {
  const text = (item: Searchable): string =>
    query.textIn.size === 0
      ? `${item.title} ${item.body}`
      : [...query.textIn].map((field) => item[field]).join(' ');
  let hits = items.filter((item) => {
    const v = view(item);
    return query.filters.every((f) => f(v)) && textMatches(text(v), query.terms);
  });
  const argSort = lower(args['sort']);
  const sort =
    query.sort ??
    (argSort === 'created' || argSort === 'updated'
      ? {
          key: argSort === 'created' ? ('created_at' as const) : ('updated_at' as const),
          asc: lower(args['order']) === 'asc',
        }
      : undefined);
  if (sort !== undefined) {
    hits = hits.toSorted((a, b) => view(b)[sort.key].localeCompare(view(a)[sort.key]));
    if (sort.asc) hits = hits.toReversed();
  } else if (lower(args['order']) === 'asc') {
    hits = hits.toReversed();
  }
  return hits;
}

function searchIssues(st: HardState, args: FakeArgs): unknown {
  const query = parseHardQuery(str(args['query']) ?? '');
  if (query instanceof FakeError) return query;
  // search_issues searches issues only (the real server adds is:issue).
  const issues = searchHard(st.issues, issueSearchable, query, args);
  const page = paged(issues, args);
  return {
    total_count: page.total,
    incomplete_results: false,
    items: page.items.map((issue) => pick(issueView(issue, st), args['fields'])),
  };
}

function searchPulls(args: FakeArgs): unknown {
  const query = parseHardQuery(str(args['query']) ?? '');
  if (query instanceof FakeError) return query;
  // search_pull_requests searches PRs only (the real server adds is:pr).
  const pulls = searchHard(HARD_WORLD_PULLS, pullSearchable, query, args);
  const page = paged(pulls, args);
  return {
    total_count: page.total,
    incomplete_results: false,
    items: page.items.map((pull) => pick(pullView(pull), args['fields'])),
  };
}

function issueRead(st: HardState, args: FakeArgs): unknown {
  const n = num(args['issue_number']);
  const issue = st.issues.find((i) => i.number === n);
  const method = lower(args['method']);
  if (issue === undefined) {
    const pull = HARD_WORLD_PULLS.find((p) => p.number === n);
    if (pull !== undefined) {
      if (method === 'get' || method === '') {
        return { ...pullView(pull), pull_request: { url: `${PULL_URL}${pull.number}` } };
      }
      // A PR's conversation comments are issue comments.
      return method === 'get_comments' ? [...(st.comments.get(pull.number) ?? [])] : [];
    }
    return fakeError(`404 Not Found: issue #${String(n)}.`);
  }
  switch (method) {
    case 'get_labels':
      return issue.labels.map((name) => ({ name }));
    case 'get_comments':
      return [...(st.comments.get(issue.number) ?? [])];
    case 'get_sub_issues':
      return [];
    case 'get_parent':
      return null;
    default:
      return issueView(issue, st);
  }
}

/** The highest issue or PR number in the hard world: a created issue gets the next one. */
export const HARD_MAX_NUMBER: number = Math.max(
  ...HARD_WORLD_ISSUES.map((issue) => issue.number),
  ...HARD_WORLD_PULLS.map((pull) => pull.number),
);

/** `labels` as names, or a 422 for one acme/widgets does not define. */
function knownLabels(labels: unknown[]): string[] | FakeError {
  const names = labels.map((l) => String(l));
  for (const label of names) {
    if (!HARD_WORLD_LABELS.includes(label.toLowerCase())) {
      return fakeError(`422 Validation Failed: label "${label}" does not exist in acme/widgets.`);
    }
  }
  return names;
}

/**
 * issue_write against the world's state: `create` adds an open issue with
 * the next number; `update` changes the issue in place (labels replaced, as
 * on GitHub). Later reads see either.
 */
function issueWrite(st: HardState, args: FakeArgs): unknown {
  if (lower(args['method']) === 'create') {
    const labels = knownLabels(Array.isArray(args['labels']) ? args['labels'] : []);
    if (labels instanceof FakeError) return labels;
    const at = tick(st);
    st.lastNumber += 1;
    const issue: HardIssue = {
      number: st.lastNumber,
      title: str(args['title']) ?? '',
      state: 'open',
      labels,
      user: WRITER,
      assignees: Array.isArray(args['assignees']) ? args['assignees'].map(String) : [],
      created_at: at,
      updated_at: at,
      closed_at: null,
      body: str(args['body']) ?? '',
    };
    st.issues.unshift(issue);
    return issueView(issue, st);
  }
  const n = num(args['issue_number']);
  const issue = st.issues.find((i) => i.number === n);
  if (issue === undefined) return fakeError(`404 Not Found: issue #${String(n)}.`);
  const labels = Array.isArray(args['labels']) ? knownLabels(args['labels']) : issue.labels;
  if (labels instanceof FakeError) return labels;
  const at = tick(st);
  const state =
    lower(args['state']) === 'closed'
      ? 'closed'
      : lower(args['state']) === 'open'
        ? 'open'
        : issue.state;
  if (state !== issue.state) issue.closed_at = state === 'closed' ? at : null;
  issue.labels = [...labels];
  issue.title = str(args['title']) ?? issue.title;
  issue.state = state;
  issue.body = str(args['body']) ?? issue.body;
  if (Array.isArray(args['assignees'])) issue.assignees = args['assignees'].map(String);
  issue.updated_at = at;
  return issueView(issue, st);
}

/** add_issue_comment: the comment lands on the issue or PR, and its reads show it. */
function addIssueComment(st: HardState, args: FakeArgs): unknown {
  const n = num(args['issue_number']);
  const exists =
    st.issues.some((i) => i.number === n) || HARD_WORLD_PULLS.some((p) => p.number === n);
  if (n === undefined || !exists) return fakeError(`404 Not Found: issue #${String(n)}.`);
  const body = str(args['body']);
  if (body === undefined) return fakeError('missing required parameter: body');
  const at = tick(st);
  st.lastId += 1;
  const comment: HardComment = {
    id: st.lastId,
    user: { login: WRITER },
    body,
    created_at: at,
    html_url: `${ISSUE_URL}${n}#issuecomment-${st.lastId}`,
  };
  st.comments.set(n, [...(st.comments.get(n) ?? []), comment]);
  const issue = st.issues.find((i) => i.number === n);
  if (issue !== undefined) issue.updated_at = at;
  return comment;
}

const REVIEW_STATES: Readonly<Record<string, HardReview['state']>> = {
  COMMENT: 'COMMENTED',
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
};

/** The PR's pending review by the writer, if any. */
function pendingReview(st: HardState, n: number): HardReview | undefined {
  return st.reviews.get(n)?.find((r) => r.state === 'PENDING');
}

/**
 * pull_request_review_write: `create` with an event submits a review,
 * without one leaves it pending; `submit_pending` submits the pending one
 * with its event; `delete_pending` drops it. get_reviews shows the result.
 */
function reviewWrite(st: HardState, args: FakeArgs): unknown {
  const n = num(args['pullNumber']);
  if (n === undefined || !HARD_WORLD_PULLS.some((p) => p.number === n)) {
    return fakeError(`404 Not Found: pull request #${String(n)}.`);
  }
  const method = lower(args['method']);
  const event = (str(args['event']) ?? '').trim().toUpperCase();
  const submitted = event === '' ? undefined : REVIEW_STATES[event];
  if (event !== '' && submitted === undefined) {
    return fakeError(`422 Validation Failed: unknown review event "${event}".`);
  }
  const reviews = st.reviews.get(n) ?? [];
  switch (method) {
    case 'create': {
      if (pendingReview(st, n) !== undefined) {
        return fakeError('422 Validation Failed: you already have a pending review on this PR.');
      }
      const at = tick(st);
      st.lastId += 1;
      const review: HardReview = {
        id: st.lastId,
        user: { login: WRITER },
        state: submitted ?? 'PENDING',
        body: str(args['body']) ?? '',
        comments: [],
        submitted_at: submitted === undefined ? null : at,
      };
      st.reviews.set(n, [...reviews, review]);
      return review;
    }
    case 'submit_pending': {
      const review = pendingReview(st, n);
      if (review === undefined) return fakeError('404 Not Found: no pending review on this PR.');
      if (submitted === undefined) return fakeError('missing required parameter: event');
      review.state = submitted;
      review.body = str(args['body']) ?? review.body;
      review.submitted_at = tick(st);
      return review;
    }
    case 'delete_pending': {
      const review = pendingReview(st, n);
      if (review === undefined) return fakeError('404 Not Found: no pending review on this PR.');
      tick(st);
      st.reviews.set(
        n,
        reviews.filter((r) => r !== review),
      );
      return { ok: true };
    }
    default:
      return fakeError(`unknown method "${method}"`);
  }
}

/** add_comment_to_pending_review: the comment joins the writer's pending review. */
function addPendingComment(st: HardState, args: FakeArgs): unknown {
  const n = num(args['pullNumber']);
  const review = n === undefined ? undefined : pendingReview(st, n);
  if (review === undefined) return fakeError('404 Not Found: no pending review on this PR.');
  tick(st);
  review.comments.push({ path: str(args['path']) ?? '', body: str(args['body']) ?? '' });
  return { ok: true, review_id: review.id };
}

function pullsFor(args: FakeArgs): HardPull[] {
  const state = lower(args['state']) || 'open';
  const head = lower(args['head']).replace(/^[^:]*:/, '');
  const base = lower(args['base']);
  let pulls = HARD_WORLD_PULLS.filter(
    (pull) =>
      (state === 'all' || pull.state === state) &&
      (head === '' || pull.head === head) &&
      (base === '' || base === HARD_DEFAULT_BRANCH),
  );
  if (lower(args['direction']) === 'asc' || lower(args['order']) === 'asc') {
    pulls = pulls.toReversed();
  }
  return pulls;
}

function pullRead(st: HardState, args: FakeArgs): unknown {
  const n = num(args['pullNumber']);
  const pull = HARD_WORLD_PULLS.find((p) => p.number === n);
  if (pull === undefined) return fakeError(`404 Not Found: pull request #${String(n)}.`);
  switch (lower(args['method'])) {
    case 'get_files':
      return paged(pull.files, args).items.map((filename) => ({
        filename,
        status: 'modified',
        additions: 3 + (filename.length % 17),
        deletions: filename.length % 5,
      }));
    case 'get_check_runs':
      return {
        total_count: pull.checks.length,
        check_runs: pull.checks.map((run, i) => ({
          id: pull.number * 100 + i,
          name: run.name,
          status: 'completed',
          conclusion: run.conclusion,
          output: { title: run.name, summary: run.summary },
        })),
      };
    case 'get_status':
      return {
        state: pull.checks.some((run) => run.conclusion === 'failure') ? 'failure' : 'success',
        total_count: pull.checks.length,
      };
    case 'get_diff':
      return pull.files
        .map(
          (file) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n`,
        )
        .join('');
    case 'get_review_comments':
      return (HARD_REVIEW_COMMENTS[pull.number] ?? []).map((comment) => ({
        id: comment.id,
        user: { login: comment.author },
        path: comment.path,
        body: comment.body,
      }));
    case 'get_comments':
      return [...(st.comments.get(pull.number) ?? [])];
    case 'get_reviews':
      // Submitted reviews; a pending one is visible only to its author (the writer).
      return [...(st.reviews.get(pull.number) ?? [])];
    case 'get_commits':
      return [];
    default:
      return { ...pullView(pull), mergeable: true };
  }
}

function releaseView(release: HardRelease, i: number): Record<string, unknown> {
  return {
    id: 9000 + i,
    tag_name: release.tag_name,
    name: release.name,
    body: release.body,
    draft: false,
    prerelease: release.prerelease,
    published_at: release.published_at,
    author: { login: 'vibdev' },
    html_url: `https://github.com/${HARD_REPO.owner}/${HARD_REPO.repo}/releases/tag/${release.tag_name}`,
  };
}

function releaseByTag(args: FakeArgs): unknown {
  const tag = (str(args['tag']) ?? '').trim();
  const i = HARD_WORLD_RELEASES.findIndex((r) => r.tag_name.toLowerCase() === tag.toLowerCase());
  if (i < 0) {
    return fakeError(
      `404 Not Found: no release with tag "${tag}" in ${HARD_REPO.owner}/${HARD_REPO.repo}.`,
    );
  }
  return releaseView(HARD_WORLD_RELEASES[i] as HardRelease, i);
}

/** Wrap a base answer: acme/widgets gets `hard`, anything else the base fake's answer. */
function forHardRepo(
  tool: string,
  hard: (args: FakeArgs) => unknown,
  scope = isHardRepo,
): FakeAnswer {
  const base = GITHUB_FAKE_ANSWERS[tool];
  return (args: FakeArgs) => {
    if (scope(args)) return hard(args);
    if (base === undefined) return { ok: true };
    return typeof base === 'function' ? base(args) : base;
  };
}

/**
 * The answer overrides the hard world's GitHub box is created with, over
 * fresh state per world (one world per episode): issue creates and
 * updates, issue comments and PR reviews change that state, and every
 * later list, search and read in the same world shows them. Created issues
 * are numbered from {@link HARD_MAX_NUMBER} + 1 on, every one unique.
 * Nothing is shared across worlds, and graders still read the recorded
 * calls, never this state.
 */
export function hardGithubAnswers(): Readonly<Record<string, FakeAnswer>> {
  const st = newState();
  return {
    list_issues: forHardRepo('list_issues', (args) => listIssues(st, args)),
    search_issues: forHardRepo('search_issues', (args) => searchIssues(st, args), scopedToHardRepo),
    issue_read: forHardRepo('issue_read', (args) => issueRead(st, args)),
    issue_write: forHardRepo('issue_write', (args) => issueWrite(st, args)),
    add_issue_comment: forHardRepo('add_issue_comment', (args) => addIssueComment(st, args)),
    pull_request_review_write: forHardRepo('pull_request_review_write', (args) =>
      reviewWrite(st, args),
    ),
    add_comment_to_pending_review: forHardRepo('add_comment_to_pending_review', (args) =>
      addPendingComment(st, args),
    ),
    list_label: forHardRepo('list_label', () => HARD_WORLD_LABELS.map((name) => ({ name }))),
    get_label: forHardRepo('get_label', (args) => {
      const name = lower(args['name']);
      return HARD_WORLD_LABELS.includes(name)
        ? { name, color: 'ededed' }
        : fakeError(`404 Not Found: no label "${name}" in ${HARD_REPO.owner}/${HARD_REPO.repo}.`);
    }),
    list_pull_requests: forHardRepo('list_pull_requests', (args) => {
      const page = paged(pullsFor(args), args);
      return page.items.map((pull) => pick(pullView(pull), args['fields']));
    }),
    search_pull_requests: forHardRepo('search_pull_requests', searchPulls, scopedToHardRepo),
    pull_request_read: forHardRepo('pull_request_read', (args) => pullRead(st, args)),
    list_branches: forHardRepo('list_branches', (args) =>
      paged(HARD_WORLD_BRANCHES, args).items.map((name) => ({
        name,
        protected: name === HARD_DEFAULT_BRANCH,
      })),
    ),
    list_releases: forHardRepo('list_releases', (args) =>
      paged(
        HARD_WORLD_RELEASES.map((release, i) => ({ release, i })),
        args,
      ).items.map(({ release, i }) => pick(releaseView(release, i), args['fields'])),
    ),
    get_release_by_tag: forHardRepo('get_release_by_tag', releaseByTag),
    get_latest_release: forHardRepo('get_latest_release', () => {
      const i = HARD_WORLD_RELEASES.findIndex((r) => !r.prerelease);
      return releaseView(HARD_WORLD_RELEASES[i] as HardRelease, i);
    }),
    list_tags: forHardRepo('list_tags', (args) =>
      paged(HARD_WORLD_RELEASES, args).items.map((release) => ({
        name: release.tag_name,
        commit: { sha: `c0ffee${release.tag_name.replace(/\W/g, '')}` },
      })),
    ),
  };
}
