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
