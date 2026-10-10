/**
 * The offline GitHub fake: serves the dumped 95-tool catalog verbatim,
 * records calls, answers from the canned world, and rejects schema-invalid
 * arguments before anything is recorded. The hard tier's scripted
 * behaviours are pure functions of the arguments, checked here call by call.
 */

import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { wrapMcpServer } from '@astral-mcp/projection';
import { describe, expect, it } from 'vitest';
import {
  answerFor,
  branchesListed,
  createGithubFake,
  FakeError,
  fakeError,
  pageOf,
  queryTerms,
  textMatches,
  GITHUB_CATALOG,
  GITHUB_FAKE_ANSWERS,
  HARD_BRANCHES,
  toolResultText,
  type AgentToolResult,
  type GithubFake,
} from '../../src/index.js';

const ACME = { owner: 'acme', repo: 'widgets' };
const BASIC = { owner: 'modelcontextprotocol', repo: 'servers' };

async function connect(fake: GithubFake): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fake-test', version: '0.0.0' }, { capabilities: {} });
  await fake.server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

/** Call a tool on a fresh fake over MCP and parse the JSON answer (or return the error). */
async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<{ value?: unknown; error?: string; result: AgentToolResult }> {
  const fake = createGithubFake();
  const client = await connect(fake);
  try {
    const result = toolResultText(await client.callTool({ name, arguments: args }));
    if (result.isError === true) return { error: result.text, result };
    return { value: JSON.parse(result.text) as unknown, result };
  } finally {
    await client.close();
  }
}

/** The answer the table gives, without the MCP round trip. */
function answer(name: string, args: Record<string, unknown>): unknown {
  return answerFor({ ...GITHUB_FAKE_ANSWERS }, name, args);
}

const numbers = (value: unknown): number[] =>
  (Array.isArray(value) ? value : ((value as { items?: unknown[] }).items ?? [])).map(
    (item) => (item as { number: number }).number,
  );

describe('github fake', () => {
  it('lists exactly the dumped catalog, schemas and annotations intact', async () => {
    expect(GITHUB_CATALOG.tools).toHaveLength(95);
    const fake = createGithubFake();
    const client = await connect(fake);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).toSorted()).toEqual(GITHUB_CATALOG.tools.map((t) => t.name));
      for (const expected of GITHUB_CATALOG.tools) {
        const served = tools.find((t) => t.name === expected.name);
        expect(served?.description).toBe(expected.description);
        expect(served?.inputSchema).toEqual(expected.inputSchema);
        expect(served?.annotations).toEqual(expected.annotations);
      }
      expect(client.getInstructions()).toContain('Tool selection guidance');
    } finally {
      await client.close();
    }
  });

  it('wraps under Projection with the full catalog and the server instructions', async () => {
    const fake = createGithubFake();
    const facade = await wrapMcpServer(fake.server, { blob: { key: randomBytes(32) } });
    try {
      expect(facade.catalog.tools).toHaveLength(95);
      expect(facade.instructions).toContain('Tool selection guidance');
      expect(facade.dts).toContain('issue_write');
    } finally {
      await facade.close();
    }
  });

  it('records calls and answers from the canned table, defaulting to ok', async () => {
    const fake = createGithubFake();
    const client = await connect(fake);
    try {
      const me = toolResultText(await client.callTool({ name: 'get_me', arguments: {} }));
      expect(me).toEqual({ text: '{"login":"vibdev"}' });
      const star = toolResultText(
        await client.callTool({ name: 'star_repository', arguments: { owner: 'a', repo: 'b' } }),
      );
      expect(star).toEqual({ text: '{"ok":true}' });
      expect(fake.calls).toEqual([
        { tool: 'get_me', args: {} },
        { tool: 'star_repository', args: { owner: 'a', repo: 'b' } },
      ]);
    } finally {
      await client.close();
    }
  });

  it('rejects schema-invalid arguments without recording a call', async () => {
    const fake = createGithubFake();
    const client = await connect(fake);
    try {
      let rejected = false;
      try {
        const result = await client.callTool({
          name: 'star_repository',
          arguments: { owner: 'a' }, // repo is required
        });
        rejected = result.isError === true;
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
      expect(fake.calls).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('can drop the instructions, narrow the catalog, and script an answer', async () => {
    const fake = createGithubFake({
      tools: GITHUB_CATALOG.tools.filter((t) => t.name === 'get_me' || t.name === 'get_label'),
      instructions: false,
      answers: {
        get_me: { login: 'someone-else' },
        get_label: (args) => fakeError(`no label ${String(args['name'])}`),
      },
    });
    const client = await connect(fake);
    try {
      expect((await client.listTools()).tools).toHaveLength(2);
      expect(client.getInstructions()).toBeUndefined();
      const me = toolResultText(await client.callTool({ name: 'get_me', arguments: {} }));
      expect(me.text).toBe('{"login":"someone-else"}');
      const label = toolResultText(
        await client.callTool({
          name: 'get_label',
          arguments: { owner: 'a', repo: 'b', name: 'x' },
        }),
      );
      expect(label).toEqual({ text: 'no label x', isError: true });
      expect(fake.calls).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  describe('basic world (modelcontextprotocol/servers) is unchanged', () => {
    it('answers the static values the basic tasks rely on', () => {
      expect(numbers(answer('list_pull_requests', { ...BASIC }))).toEqual([7, 9]);
      expect(
        numbers(answer('search_pull_requests', { query: 'repo:modelcontextprotocol/servers' })),
      ).toEqual([7, 9]);
      expect(numbers(answer('list_issues', { ...BASIC }))).toEqual([42]);
      expect(numbers(answer('search_issues', { query: 'crash on startup' }))).toEqual([42]);
      expect(numbers(answer('search_issues', { ...BASIC, query: 'anything at all' }))).toEqual([
        42,
      ]);
      expect(answer('issue_read', { ...BASIC, method: 'get', issue_number: 42 })).toMatchObject({
        number: 42,
      });
      expect(answer('pull_request_read', { ...BASIC, method: 'get', pullNumber: 7 })).toMatchObject(
        { number: 7 },
      );
      expect(
        answer('create_branch', { ...BASIC, branch: 'feature/x', from_branch: 'main' }),
      ).toMatchObject({ ok: true });
      expect(answer('get_file_contents', { ...BASIC, path: 'README.md' })).toEqual({ ok: true });
      expect(answer('star_repository', { ...BASIC })).toEqual({ ok: true });
      expect(
        answer('issue_write', { ...BASIC, method: 'create', title: 'Crash on startup' }),
      ).toMatchObject({ number: 101 });
      // The basic search still finds something (its repo), so episodes stay short.
      expect(answer('search_repositories', { query: 'model context protocol' })).toMatchObject({
        total_count: 1,
        items: [{ full_name: 'modelcontextprotocol/servers' }],
      });
      expect(answer('get_label', { ...BASIC, name: 'bug' })).toEqual({ ok: true });
    });
  });

  describe('hard world (acme/widgets and the user)', () => {
    it('is a pure function of the arguments: the same call answers the same twice', async () => {
      const fake = createGithubFake();
      const client = await connect(fake);
      try {
        const a = toolResultText(
          await client.callTool({ name: 'list_branches', arguments: { ...ACME, page: 2 } }),
        );
        const b = toolResultText(
          await client.callTool({ name: 'list_branches', arguments: { ...ACME, page: 2 } }),
        );
        expect(a).toEqual(b);
        // And a fresh fake starts from the same world.
        const fresh = await call('list_branches', { ...ACME, page: 2 });
        expect(fresh.result).toEqual(a);
      } finally {
        await client.close();
      }
    });

    it('list_issues: newest first, filters by state and labels, honours direction', () => {
      const all = answer('list_issues', { ...ACME }) as { issues: unknown[]; totalCount: number };
      expect(numbers(all.issues)).toEqual([30, 25, 23, 17]);
      expect(all.totalCount).toBe(4);
      expect(
        numbers(
          (answer('list_issues', { ...ACME, state: 'OPEN' }) as { issues: unknown[] }).issues,
        ),
      ).toEqual([25, 23, 17]);
      expect(
        numbers(
          (answer('list_issues', { ...ACME, labels: ['bug'] }) as { issues: unknown[] }).issues,
        ),
      ).toEqual([30, 23, 17]);
      expect(
        numbers(
          (
            answer('list_issues', { ...ACME, state: 'OPEN', labels: ['bug'] }) as {
              issues: unknown[];
            }
          ).issues,
        ),
      ).toEqual([23, 17]);
      expect(
        numbers(
          (
            answer('list_issues', {
              ...ACME,
              state: 'OPEN',
              labels: ['bug'],
              orderBy: 'CREATED_AT',
              direction: 'ASC',
            }) as { issues: unknown[] }
          ).issues,
        ),
      ).toEqual([17, 23]);
      const first = all.issues[0] as {
        labels: { name: string }[];
        created_at: string;
        state: string;
      };
      expect(first.state).toBe('closed');
      expect(first.labels).toEqual([{ name: 'bug' }]);
      expect(first.created_at).toBe('2026-09-28T09:00:00Z');
    });

    it('search_issues: scoped to acme/widgets it text-matches; existing title found, missing one empty', () => {
      expect(numbers(answer('search_issues', { ...ACME, query: 'Flaky test in CI' }))).toEqual([
        23,
      ]);
      expect(
        numbers(
          answer('search_issues', { query: 'repo:acme/widgets "Flaky test in CI" in:title' }),
        ),
      ).toEqual([23]);
      expect(numbers(answer('search_issues', { ...ACME, query: 'flaky tests' }))).toEqual([23]);
      expect(numbers(answer('search_issues', { ...ACME, query: 'Add dark mode' }))).toEqual([]);
      expect(numbers(answer('search_issues', { ...ACME, query: 'dark mode' }))).toEqual([]);
      expect(numbers(answer('search_issues', { ...ACME, query: 'crash config missing' }))).toEqual([
        17,
      ]);
      // Qualifiers are honoured the way the real server honours them.
      expect(numbers(answer('search_issues', { ...ACME, query: 'is:open label:bug' }))).toEqual([
        23, 17,
      ]);
      expect(
        numbers(answer('search_issues', { query: 'repo:acme/widgets state:open label:bug' })),
      ).toEqual([23, 17]);
      expect(numbers(answer('search_issues', { ...ACME, query: 'is:closed' }))).toEqual([30]);
      expect(
        numbers(answer('search_issues', { ...ACME, query: 'is:issue label:documentation' })),
      ).toEqual([25]);
      expect(
        numbers(answer('search_issues', { ...ACME, query: 'label:bug label:needs-triage' })),
      ).toEqual([17]);
      expect(
        numbers(
          answer('search_issues', {
            ...ACME,
            query: 'is:open label:bug',
            sort: 'created',
            order: 'asc',
          }),
        ),
      ).toEqual([17, 23]);
      // No text terms and no qualifiers: everything in the repo.
      expect(numbers(answer('search_issues', { ...ACME, query: '' }))).toEqual([30, 25, 23, 17]);
    });

    it('issue_read: get, get_labels, and a 404 for unknown numbers', () => {
      expect(answer('issue_read', { ...ACME, method: 'get', issue_number: 25 })).toMatchObject({
        number: 25,
        title: 'Docs: add usage examples',
        labels: [{ name: 'documentation' }],
      });
      expect(answer('issue_read', { ...ACME, method: 'get_labels', issue_number: 17 })).toEqual([
        { name: 'bug' },
        { name: 'needs-triage' },
      ]);
      expect(answer('issue_read', { ...ACME, method: 'get', issue_number: 99 })).toBeInstanceOf(
        FakeError,
      );
      // PRs are issues: reading one by number works, with a pull_request marker.
      expect(answer('issue_read', { ...ACME, method: 'get', issue_number: 12 })).toMatchObject({
        number: 12,
        pull_request: {},
      });
      expect(answer('issue_read', { ...ACME, method: 'get_comments', issue_number: 12 })).toEqual(
        [],
      );
      expect(answer('issue_read', { ...ACME, method: 'get_labels', issue_number: 12 })).toEqual([]);
    });

    it('list_pull_requests / search_pull_requests: four open PRs (three per page), author and head filters', () => {
      const listed = answer('list_pull_requests', { ...ACME, state: 'open' }) as {
        items: unknown[];
        has_next_page: boolean;
      };
      expect(numbers(listed.items)).toEqual([12, 11, 10]);
      expect(listed.has_next_page).toBe(true); // #8 is on page 2 at the default page size
      expect(
        numbers(
          (answer('list_pull_requests', { ...ACME, perPage: 10 }) as { items: unknown[] }).items,
        ),
      ).toEqual([12, 11, 10, 8]);
      expect((listed.items[1] as { user: { login: string } }).user.login).toBe('alice');
      expect(
        numbers(
          (
            answer('list_pull_requests', { ...ACME, head: 'acme:release-1.3' }) as {
              items: unknown[];
            }
          ).items,
        ),
      ).toEqual([11]);
      expect(
        numbers(
          answer('search_pull_requests', { query: 'repo:acme/widgets is:open author:alice' }),
        ),
      ).toEqual([11, 10]);
      expect(numbers(answer('search_pull_requests', { ...ACME, query: 'author:bob' }))).toEqual([
        12,
      ]);
      expect(numbers(answer('search_pull_requests', { ...ACME, query: 'CHANGELOG' }))).toEqual([]); // titles only
      expect(numbers(answer('search_pull_requests', { ...ACME, query: 'release' }))).toEqual([11]);
      // `is:pr` is a type, not a state; a later `is:closed` still filters.
      expect(
        numbers(answer('search_pull_requests', { ...ACME, query: 'is:pr is:closed' })),
      ).toEqual([]);
      expect(numbers(answer('search_pull_requests', { ...ACME, query: 'is:pr is:open' }))).toEqual([
        12, 11, 10, 8,
      ]);
    });

    it('pull_request_read: files per PR and the review thread on #8', () => {
      expect(answer('pull_request_read', { ...ACME, method: 'get_files', pullNumber: 11 })).toEqual(
        [
          { filename: 'CHANGELOG.md', status: 'modified' },
          { filename: 'package.json', status: 'modified' },
        ],
      );
      expect(answer('pull_request_read', { ...ACME, method: 'get_files', pullNumber: 10 })).toEqual(
        [
          { filename: 'src/fetch.ts', status: 'modified' },
          { filename: 'test/fetch.test.ts', status: 'modified' },
        ],
      );
      const comments = answer('pull_request_read', {
        ...ACME,
        method: 'get_review_comments',
        pullNumber: 8,
      }) as {
        id: number;
        user: { login: string };
        path: string;
      }[];
      expect(comments.map((c) => [c.id, c.user.login, c.path])).toEqual([
        [9001, 'bob', 'src/auth.ts'],
        [9002, 'carol', 'README.md'],
      ]);
      expect(
        answer('pull_request_read', { ...ACME, method: 'get_review_comments', pullNumber: 10 }),
      ).toEqual([]);
      expect(answer('pull_request_read', { ...ACME, method: 'get', pullNumber: 12 })).toMatchObject(
        {
          number: 12,
          user: { login: 'bob' },
        },
      );
      expect(
        answer('pull_request_read', { ...ACME, method: 'get', pullNumber: 99 }),
      ).toBeInstanceOf(FakeError);
    });

    it('list_branches: three per page by default, release/1.3 on page 2, perPage honoured', () => {
      const page1 = answer('list_branches', { ...ACME }) as {
        items: { name: string }[];
        has_next_page: boolean;
        total_count: number;
      };
      expect(page1.items.map((b) => b.name)).toEqual(['chore/ci', 'develop', 'docs/site']);
      expect(page1.has_next_page).toBe(true);
      expect(page1.total_count).toBe(6);
      const page2 = answer('list_branches', { ...ACME, page: 2 }) as {
        items: { name: string }[];
        has_next_page: boolean;
      };
      expect(page2.items.map((b) => b.name)).toEqual(['master', 'release/1.2', 'release/1.3']);
      expect(page2.has_next_page).toBe(false);
      expect((answer('list_branches', { ...ACME, page: 3 }) as { items: unknown[] }).items).toEqual(
        [],
      );
      expect(
        (answer('list_branches', { ...ACME, perPage: 100 }) as { items: unknown[] }).items,
      ).toHaveLength(6);
      expect(branchesListed({ ...ACME })).toEqual(['chore/ci', 'develop', 'docs/site']);
      expect(branchesListed({ ...ACME, page: 2 })).toContain('release/1.3');
      expect(branchesListed({ ...ACME, page: '2' })).toContain('release/1.3');
      expect(branchesListed({ ...ACME, perPage: 5 })).not.toContain('release/1.3');
      expect(branchesListed({ ...BASIC, page: 2 })).toEqual([]);
      expect(HARD_BRANCHES).not.toContain('main');
      expect(pageOf([1, 2, 3, 4, 5], { page: 2, perPage: 2 })).toEqual({
        items: [3, 4],
        page: 2,
        per_page: 2,
        total_count: 5,
        has_next_page: true,
      });
    });

    it('create_branch: from main fails naming the default; from master or omitted succeeds', async () => {
      const failed = await call('create_branch', {
        ...ACME,
        branch: 'hotfix/login',
        from_branch: 'main',
      });
      expect(failed.error).toMatch(/"main" does not exist/);
      expect(failed.error).toMatch(/default branch is "master"/);
      expect(failed.result.isError).toBe(true);
      const ok = await call('create_branch', {
        ...ACME,
        branch: 'hotfix/login',
        from_branch: 'master',
      });
      expect(ok.value).toEqual({ ok: true, ref: 'refs/heads/hotfix/login' });
      const omitted = await call('create_branch', { ...ACME, branch: 'hotfix/login' });
      expect(omitted.value).toMatchObject({ ok: true });
      expect(
        answer('create_branch', { ...ACME, branch: 'x', from_branch: 'refs/heads/release/1.3' }),
      ).toMatchObject({ ok: true });
      expect(answer('create_branch', { ...ACME, branch: 'x', from_branch: 'nope' })).toBeInstanceOf(
        FakeError,
      );
    });

    it('get_file_contents: README.md is a 404, the root lists readme.md, readme.md has content', async () => {
      const missing = await call('get_file_contents', { ...ACME, path: 'README.md' });
      expect(missing.error).toMatch(/404/);
      expect(missing.error).toContain('README.md');
      expect(missing.error).not.toContain('readme.md'); // the error does not hand over the answer
      for (const root of ['', '/', '.', './']) {
        expect(answer('get_file_contents', { ...ACME, path: root })).toEqual([
          { name: 'package.json', type: 'file', path: 'package.json' },
          { name: 'readme.md', type: 'file', path: 'readme.md' },
          { name: 'src', type: 'dir', path: 'src' },
        ]);
      }
      expect(answer('get_file_contents', { ...ACME })).toHaveLength(3);
      const found = await call('get_file_contents', { ...ACME, path: 'readme.md' });
      expect(found.value).toMatchObject({
        path: 'readme.md',
        content: expect.stringContaining('widgets'),
      });
      expect(answer('get_file_contents', { ...ACME, path: './readme.md' })).toMatchObject({
        path: 'readme.md',
      });
      expect(answer('get_file_contents', { ...ACME, path: 'Readme.md' })).toBeInstanceOf(FakeError);
      expect(answer('get_file_contents', { ...ACME, path: 'src/' })).toEqual([
        { name: 'auth.ts', type: 'file', path: 'src/auth.ts' },
        { name: 'fetch.ts', type: 'file', path: 'src/fetch.ts' },
        { name: 'index.ts', type: 'file', path: 'src/index.ts' },
      ]);
      expect(answer('get_repository_tree', { ...ACME })).toMatchObject({
        tree: expect.arrayContaining([{ path: 'readme.md', type: 'file' }]),
      });
    });

    it('list_starred_repositories: acme/widgets is already starred, whoever asks', () => {
      const starred = answer('list_starred_repositories', {}) as { full_name: string }[];
      expect(starred.map((r) => r.full_name)).toEqual(['acme/widgets', 'octocat/Hello-World']);
      expect(answer('list_starred_repositories', { username: 'vibdev' })).toEqual(starred);
    });

    it("search_repositories: the user's repos by user:/@me, acme/widgets by name, else the basic repo", () => {
      const mine = answer('search_repositories', { query: 'user:vibdev' }) as {
        items: { full_name: string }[];
      };
      expect(mine.items.map((r) => r.full_name)).toEqual([
        'vibdev/blog',
        'vibdev/dotfiles',
        'vibdev/toolbox',
      ]);
      expect(answer('search_repositories', { query: 'user:@me' })).toEqual(mine);
      expect(answer('search_repositories', { query: 'owner:vibdev fork:true' })).toEqual(mine);
      expect(answer('search_repositories', { query: 'vibdev' })).toEqual(mine);
      expect(answer('search_repositories', { query: 'widgets in:name' })).toMatchObject({
        items: [{ full_name: 'acme/widgets', default_branch: 'master' }],
      });
      expect(answer('search_repositories', { query: 'model context protocol' })).toMatchObject({
        total_count: 1,
        items: [{ full_name: 'modelcontextprotocol/servers', default_branch: 'main' }],
      });
    });

    it('list_dependabot_alerts: only vibdev/toolbox has open alerts; state and severity filter', () => {
      const alerts = answer('list_dependabot_alerts', { owner: 'vibdev', repo: 'toolbox' }) as {
        dependency: { package: { name: string } };
      }[];
      expect(alerts.map((a) => a.dependency.package.name)).toEqual(['lodash', 'minimist']);
      expect(
        answer('list_dependabot_alerts', { owner: 'vibdev', repo: 'toolbox', severity: 'high' }),
      ).toHaveLength(1);
      expect(
        answer('list_dependabot_alerts', { owner: 'vibdev', repo: 'toolbox', state: 'fixed' }),
      ).toEqual([]);
      expect(answer('list_dependabot_alerts', { owner: 'vibdev', repo: 'dotfiles' })).toEqual([]);
      expect(answer('list_dependabot_alerts', { owner: 'vibdev', repo: 'blog' })).toEqual([]);
      expect(answer('list_dependabot_alerts', { ...ACME })).toEqual([]);
    });

    it('list_label / get_label: the labels the hard tasks need already exist', () => {
      expect(answer('list_label', { ...ACME })).toEqual([
        { name: 'bug' },
        { name: 'documentation' },
        { name: 'good first issue' },
        { name: 'needs-triage' },
      ]);
      expect(answer('get_label', { ...ACME, name: 'Good First Issue' })).toEqual({
        name: 'good first issue',
        color: 'ededed',
      });
      expect(answer('get_label', { ...ACME, name: 'nope' })).toBeInstanceOf(FakeError);
      expect(answer('semantic_issue_similarity_search', { ...ACME, issue_number: 23 })).toEqual([]);
    });

    it('issue_write: a create answers with a number and url; an update acknowledges', () => {
      expect(answer('issue_write', { ...ACME, method: 'create', title: 'Add dark mode' })).toEqual({
        number: 101,
        title: 'Add dark mode',
        state: 'open',
        html_url: 'https://github.com/acme/widgets/issues/101',
      });
      expect(
        answer('issue_write', { ...ACME, method: 'update', issue_number: 17, state: 'closed' }),
      ).toEqual({ ok: true, number: 17 });
    });

    it('writes that are not scripted still answer ok and are recorded', async () => {
      const fake = createGithubFake();
      const client = await connect(fake);
      try {
        const result = toolResultText(
          await client.callTool({
            name: 'actions_run_trigger',
            arguments: { ...ACME, method: 'rerun_failed_jobs', run_id: 123 },
          }),
        );
        expect(result).toEqual({ text: '{"ok":true}' });
        expect(fake.calls).toEqual([
          {
            tool: 'actions_run_trigger',
            args: { ...ACME, method: 'rerun_failed_jobs', run_id: 123 },
          },
        ]);
      } finally {
        await client.close();
      }
    });
  });

  describe('text matching helpers', () => {
    it('strips qualifiers, quotes and stopwords from a query', () => {
      expect(queryTerms('repo:acme/widgets "Flaky test in CI" in:title is:open')).toEqual([
        'flaky',
        'test',
        'ci',
      ]);
      expect(queryTerms('Add dark mode')).toEqual(['add', 'dark', 'mode']);
      expect(queryTerms('')).toEqual([]);
    });

    it('matches when at least half the terms occur as word prefixes either way', () => {
      expect(textMatches('Flaky test in CI', ['flaky', 'test', 'ci'])).toBe(true);
      expect(textMatches('Flaky test in CI', ['flaky', 'tests'])).toBe(true);
      expect(textMatches('Docs: add usage examples', ['add', 'dark', 'mode'])).toBe(false);
      expect(textMatches('anything', [])).toBe(true);
    });
  });
});
