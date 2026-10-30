/**
 * The hard world's GitHub answers, offline (called directly, no server):
 * its issue/PR search qualifiers (date ranges, negated and missing labels
 * and assignees, an error for anything else), the issue numbers `create`
 * hands out, and its issue dates. The base fake's search is checked
 * unchanged alongside, so the existing tiers see the same answers.
 */

import { describe, expect, it } from 'vitest';
import {
  dateRange,
  hardGithubAnswers,
  parseHardQuery,
  FakeError,
  GITHUB_FAKE_ANSWERS,
  HARD_MAX_NUMBER,
  HARD_WORLD_ISSUES,
  HARD_WORLD_PULLS,
  MULTI_HARD_EXPECTED as E,
  type FakeAnswer,
} from '../../src/index.js';

const ACME = { owner: 'acme', repo: 'widgets' };

function call(answers: Readonly<Record<string, FakeAnswer>>, tool: string, args: object): unknown {
  const answer = answers[tool];
  if (typeof answer !== 'function') throw new Error(`no scripted ${tool}`);
  return answer({ ...args });
}

/** Every issue number a hard search_issues query returns (all pages). */
function issueSearch(query: string): number[] | FakeError {
  const result = call(hardGithubAnswers(), 'search_issues', { query, perPage: 100 });
  if (result instanceof FakeError) return result;
  const { items } = result as { items: { number: number }[] };
  return items.map((i) => i.number).toSorted((a, b) => a - b);
}

function pullSearch(query: string): number[] | FakeError {
  const result = call(hardGithubAnswers(), 'search_pull_requests', { query, perPage: 100 });
  if (result instanceof FakeError) return result;
  const { items } = result as { items: { number: number }[] };
  return items.map((i) => i.number).toSorted((a, b) => a - b);
}

const numbers = (pred: (issue: (typeof HARD_WORLD_ISSUES)[number]) => boolean): number[] =>
  HARD_WORLD_ISSUES.filter(pred)
    .map((i) => i.number)
    .toSorted((a, b) => a - b);

const STALE = Object.keys(E.staleIssues)
  .map(Number)
  .toSorted((a, b) => a - b);

describe('hard world issue dates', () => {
  it('no issue was updated before it was created', () => {
    for (const issue of HARD_WORLD_ISSUES) {
      expect(issue.updated_at >= issue.created_at, `#${issue.number}`).toBe(true);
      if (issue.closed_at !== null) {
        expect(issue.closed_at >= issue.created_at, `#${issue.number}`).toBe(true);
      }
    }
  });

  it('the stale issues are exactly the open ones last updated before 2026-07-01', () => {
    expect(STALE).toEqual(
      numbers((i) => i.state === 'open' && Date.parse(i.updated_at) < Date.parse('2026-07-01')),
    );
  });
});

describe('hard world search qualifiers', () => {
  it('updated: and created: take <, <=, >, >=, ranges and exact days', () => {
    expect(issueSearch('repo:acme/widgets is:open updated:<2026-07-01')).toEqual(STALE);
    expect(issueSearch('repo:acme/widgets is:issue is:open updated:<=2026-06-30')).toEqual(STALE);
    const fresh = numbers((i) => i.state === 'open' && i.updated_at >= '2026-07-01');
    expect(issueSearch('repo:acme/widgets is:open updated:>=2026-07-01')).toEqual(fresh);
    expect(issueSearch('repo:acme/widgets is:open updated:>2026-06-30')).toEqual(fresh);
    expect(issueSearch('repo:acme/widgets state:open updated:*..2026-06-30')).toEqual(STALE);
    const inJan = numbers((i) => i.created_at.startsWith('2026-01-'));
    expect(inJan.length).toBeGreaterThan(0);
    expect(issueSearch('repo:acme/widgets created:2026-01-01..2026-01-31')).toEqual(inJan);
    const day = (HARD_WORLD_ISSUES.find((i) => i.number === 50)?.created_at ?? '').slice(0, 10);
    expect(issueSearch(`repo:acme/widgets created:${day}`)).toEqual(
      numbers((i) => i.created_at.startsWith(day)),
    );
    // A date-time compares to the instant.
    const at = HARD_WORLD_ISSUES.find((i) => i.number === 50)?.created_at ?? '';
    expect(issueSearch(`repo:acme/widgets created:<${at}`)).toEqual(
      numbers((i) => i.created_at < at),
    );
  });

  it('-label:, no:label and no:assignee filter', () => {
    expect(issueSearch('repo:acme/widgets is:open -label:bug')).toEqual(
      numbers((i) => i.state === 'open' && !i.labels.includes('bug')),
    );
    expect(issueSearch('repo:acme/widgets is:open no:label')).toEqual(
      numbers((i) => i.state === 'open' && i.labels.length === 0),
    );
    expect(issueSearch('repo:acme/widgets is:open no:assignee')).toEqual(
      numbers((i) => i.state === 'open' && i.assignees.length === 0),
    );
    expect(issueSearch('repo:acme/widgets is:open label:bug,enhancement')).toEqual(
      numbers(
        (i) => i.state === 'open' && (i.labels.includes('bug') || i.labels.includes('enhancement')),
      ),
    );
    expect(issueSearch('repo:acme/widgets is:open assignee:rhea-m')).toHaveLength(
      E.owner.openAssigned,
    );
  });

  it('an unsupported qualifier is a 422, never ignored', () => {
    for (const query of [
      'repo:acme/widgets is:open milestone:v2',
      'repo:acme/widgets is:open -author:vibdev',
      'repo:acme/widgets no:milestone',
      'repo:acme/widgets is:locked',
      'repo:acme/widgets updated:<last-week',
      'repo:acme/widgets label:',
      'repo:acme/widgets sort:comments-desc',
    ]) {
      const result = issueSearch(query);
      expect(result, query).toBeInstanceOf(FakeError);
      expect((result as FakeError).message, query).toMatch(/^422 Validation Failed/);
    }
    expect(pullSearch('repo:acme/widgets is:pr is:merged')).toBeInstanceOf(FakeError);
    expect(parseHardQuery('reviewed-by:vibdev')).toBeInstanceOf(FakeError);
  });

  it('PR search takes the same qualifiers', () => {
    const open = HARD_WORLD_PULLS.filter((p) => p.state === 'open');
    expect(pullSearch('repo:acme/widgets is:pr is:open')).toEqual(
      open.map((p) => p.number).toSorted((a, b) => a - b),
    );
    expect(pullSearch('repo:acme/widgets is:pr is:open created:>=2026-10-01')).toEqual(
      open
        .filter((p) => p.created_at >= '2026-10-01')
        .map((p) => p.number)
        .toSorted((a, b) => a - b),
    );
    const sorted = call(hardGithubAnswers(), 'search_pull_requests', {
      query: 'repo:acme/widgets is:open sort:created-desc',
      perPage: 1,
    }) as { items: { number: number }[] };
    expect(sorted.items[0]?.number).toBe(146);
  });

  it('dateRange: whole days for dates, instants for date-times', () => {
    const before = dateRange('<2026-07-01');
    expect(before?.('2026-06-30T23:59:59Z')).toBe(true);
    expect(before?.('2026-07-01T00:00:00Z')).toBe(false);
    const onOrBefore = dateRange('<=2026-07-01');
    expect(onOrBefore?.('2026-07-01T23:59:59Z')).toBe(true);
    expect(onOrBefore?.('2026-07-02T00:00:00Z')).toBe(false);
    const after = dateRange('>2026-07-01');
    expect(after?.('2026-07-01T23:59:59Z')).toBe(false);
    expect(after?.('2026-07-02T00:00:00Z')).toBe(true);
    const range = dateRange('2026-07-01..2026-07-02');
    expect(range?.('2026-07-02T23:00:00Z')).toBe(true);
    expect(range?.('2026-07-03T00:00:00Z')).toBe(false);
    expect(dateRange('>2026-07-01T12:00:00Z')?.('2026-07-01T12:00:01Z')).toBe(true);
    expect(dateRange('2026-13-45')).toBeUndefined();
    expect(dateRange('yesterday')).toBeUndefined();
  });

  it('leaves the base fake search unchanged: its qualifiers stay as they were', () => {
    // The base fake ignores what it does not know (its tiers were scored
    // that way); only the hard world's search errors.
    const base = GITHUB_FAKE_ANSWERS['search_issues'];
    if (typeof base !== 'function') throw new Error('no base search_issues');
    const plain = base({ query: 'repo:acme/widgets is:open' });
    for (const query of [
      'repo:acme/widgets is:open updated:<2026-07-01',
      'repo:acme/widgets is:open -label:bug',
      'repo:acme/widgets is:open milestone:v2',
    ]) {
      expect(base({ query }), query).toEqual(plain);
    }
    // Outside acme/widgets the hard answers fall through to the base fake.
    const other = { query: 'repo:octo/other is:open updated:<2026-07-01' };
    expect(call(hardGithubAnswers(), 'search_issues', other)).toEqual(base(other));
  });
});

describe('hard world issue creation', () => {
  it('numbers created issues above every existing issue and PR, each one unique', () => {
    const answers = hardGithubAnswers();
    const create = (title: string): { number: number; title: string } =>
      call(answers, 'issue_write', { ...ACME, method: 'create', title }) as {
        number: number;
        title: string;
      };
    const existing = new Set([
      ...HARD_WORLD_ISSUES.map((i) => i.number),
      ...HARD_WORLD_PULLS.map((p) => p.number),
    ]);
    expect(HARD_MAX_NUMBER).toBe(Math.max(...existing));
    const made = ['Fix a', 'Fix b', 'Fix c'].map(create);
    expect(made.map((m) => m.number)).toEqual([
      HARD_MAX_NUMBER + 1,
      HARD_MAX_NUMBER + 2,
      HARD_MAX_NUMBER + 3,
    ]);
    expect(made.every((m) => !existing.has(m.number))).toBe(true);
    expect(made[1]?.title).toBe('Fix b');
    // Each world numbers its own.
    const fresh = call(hardGithubAnswers(), 'issue_write', {
      ...ACME,
      method: 'create',
      title: 'x',
    }) as { number: number };
    expect(fresh.number).toBe(HARD_MAX_NUMBER + 1);
  });
});

describe('hard world writes show in later reads', () => {
  type Answers = Readonly<Record<string, FakeAnswer>>;
  const issues = (
    answers: Answers,
    query: string,
  ): { number: number; labels: { name: string }[] }[] =>
    (call(answers, 'search_issues', { query, perPage: 100 }) as { items: never[] }).items;

  it('an issue update shows in get, list and search; the seed is untouched', () => {
    const answers = hardGithubAnswers();
    const n = Number(Object.keys(E.staleIssues)[0]);
    const seeded = HARD_WORLD_ISSUES.find((i) => i.number === n);
    const before = issues(answers, 'repo:acme/widgets is:open label:stale');
    expect(before).toHaveLength(0);
    call(answers, 'issue_write', {
      ...ACME,
      method: 'update',
      issue_number: n,
      labels: [...(seeded?.labels ?? []), 'stale'],
    });
    const got = call(answers, 'issue_read', { ...ACME, method: 'get', issue_number: n }) as {
      labels: { name: string }[];
      updated_at: string;
    };
    expect(got.labels.map((l) => l.name)).toContain('stale');
    expect(got.updated_at > '2026-10-29').toBe(true);
    expect(issues(answers, 'repo:acme/widgets is:open label:stale').map((i) => i.number)).toEqual([
      n,
    ]);
    // No longer stale by date either: updating it touched it.
    expect(
      issues(answers, 'repo:acme/widgets is:open updated:<2026-07-01').map((i) => i.number),
    ).not.toContain(n);
    const listed = call(answers, 'list_issues', {
      ...ACME,
      state: 'OPEN',
      labels: ['stale'],
    }) as { issues: { number: number }[] };
    expect(listed.issues.map((i) => i.number)).toEqual([n]);
    // The module's seed (what graders and expected values use) is unchanged.
    expect(seeded?.labels).not.toContain('stale');
    expect(HARD_WORLD_ISSUES.find((i) => i.number === n)?.labels).toEqual(seeded?.labels);
  });

  it('a created issue shows in get, list and search', () => {
    const answers = hardGithubAnswers();
    const made = call(answers, 'issue_write', {
      ...ACME,
      method: 'create',
      title: 'Fix src/api/routes.ts',
      body: 'From #139.',
    }) as { number: number };
    expect(made.number).toBe(HARD_MAX_NUMBER + 1);
    const got = call(answers, 'issue_read', {
      ...ACME,
      method: 'get',
      issue_number: made.number,
    }) as { title: string; state: string };
    expect(got).toMatchObject({ title: 'Fix src/api/routes.ts', state: 'open' });
    expect(
      issues(answers, 'repo:acme/widgets is:open in:title Fix src/api/routes.ts').map(
        (i) => i.number,
      ),
    ).toContain(made.number);
    const listed = call(answers, 'list_issues', { ...ACME, state: 'OPEN' }) as {
      issues: { number: number }[];
      totalCount: number;
    };
    expect(listed.issues[0]?.number).toBe(made.number);
    expect(listed.totalCount).toBe(HARD_WORLD_ISSUES.filter((i) => i.state === 'open').length + 1);
  });

  it('comments and reviews show in the issue and PR reads', () => {
    const answers = hardGithubAnswers();
    call(answers, 'add_issue_comment', {
      ...ACME,
      issue_number: 113,
      body: 'Please add a CHANGELOG entry.',
    });
    const onPr = call(answers, 'pull_request_read', {
      ...ACME,
      method: 'get_comments',
      pullNumber: 113,
    }) as { body: string }[];
    expect(onPr.map((c) => c.body)).toEqual(['Please add a CHANGELOG entry.']);
    const viaIssue = call(answers, 'issue_read', {
      ...ACME,
      method: 'get_comments',
      issue_number: 113,
    }) as { body: string }[];
    expect(viaIssue).toHaveLength(1);

    const n = Number(Object.keys(E.staleIssues)[0]);
    const before = (
      call(answers, 'issue_read', { ...ACME, method: 'get', issue_number: n }) as {
        comments: number;
      }
    ).comments;
    call(answers, 'add_issue_comment', { ...ACME, issue_number: n, body: 'ping' });
    const after = call(answers, 'issue_read', { ...ACME, method: 'get', issue_number: n }) as {
      comments: number;
    };
    expect(after.comments).toBe(before + 1);

    // A pending review, a comment on it, then its submit.
    call(answers, 'pull_request_review_write', { ...ACME, method: 'create', pullNumber: 116 });
    call(answers, 'add_comment_to_pending_review', {
      ...ACME,
      pullNumber: 116,
      path: 'src/export/csv.ts',
      body: 'here',
    });
    let reviews = call(answers, 'pull_request_read', {
      ...ACME,
      method: 'get_reviews',
      pullNumber: 116,
    }) as { state: string; comments: unknown[] }[];
    expect(reviews.map((r) => r.state)).toEqual(['PENDING']);
    call(answers, 'pull_request_review_write', {
      ...ACME,
      method: 'submit_pending',
      pullNumber: 116,
      event: 'COMMENT',
      body: 'Changelog?',
    });
    reviews = call(answers, 'pull_request_read', {
      ...ACME,
      method: 'get_reviews',
      pullNumber: 116,
    }) as { state: string; comments: unknown[] }[];
    expect(reviews).toMatchObject([
      { state: 'COMMENTED', body: 'Changelog?', comments: [{ body: 'here' }] },
    ]);
    call(answers, 'pull_request_review_write', {
      ...ACME,
      method: 'create',
      pullNumber: 120,
      event: 'APPROVE',
    });
    expect(
      call(answers, 'pull_request_read', { ...ACME, method: 'get_reviews', pullNumber: 120 }),
    ).toMatchObject([{ state: 'APPROVED' }]);
    // Writes to a number that does not exist are 404s, as before.
    expect(
      call(answers, 'add_issue_comment', { ...ACME, issue_number: 999, body: 'x' }),
    ).toBeInstanceOf(FakeError);
  });

  it('keeps state per world: a fresh world sees none of another’s writes', () => {
    const first = hardGithubAnswers();
    call(first, 'issue_write', { ...ACME, method: 'update', issue_number: 32, labels: ['stale'] });
    call(first, 'add_issue_comment', { ...ACME, issue_number: 113, body: 'x' });
    call(first, 'issue_write', { ...ACME, method: 'create', title: 'only in the first' });
    const second = hardGithubAnswers();
    expect(issues(second, 'repo:acme/widgets label:stale')).toHaveLength(0);
    expect(
      call(second, 'issue_read', { ...ACME, method: 'get', issue_number: HARD_MAX_NUMBER + 1 }),
    ).toBeInstanceOf(FakeError);
    expect(
      call(second, 'pull_request_read', { ...ACME, method: 'get_comments', pullNumber: 113 }),
    ).toEqual([]);
  });

  it('leaves the base fake stateless, exactly as before', () => {
    const comment = GITHUB_FAKE_ANSWERS['add_issue_comment'];
    if (typeof comment !== 'function') throw new Error('no base add_issue_comment');
    expect(comment({ owner: 'octo', repo: 'other', issue_number: 1, body: 'x' })).toEqual({
      ok: true,
    });
    expect(GITHUB_FAKE_ANSWERS['pull_request_review_write']).toBeUndefined();
    // Outside acme/widgets the hard answers fall through to the base ones.
    const answers = hardGithubAnswers();
    expect(
      call(answers, 'add_issue_comment', {
        owner: 'octo',
        repo: 'other',
        issue_number: 1,
        body: 'x',
      }),
    ).toEqual({ ok: true });
    expect(
      call(answers, 'pull_request_review_write', {
        owner: 'octo',
        repo: 'other',
        pullNumber: 1,
        method: 'create',
      }),
    ).toEqual({ ok: true });
  });
});
