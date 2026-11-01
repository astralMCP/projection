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
  ACME_BRANCHES,
  HARD_LABELS,
  HARD_README_TEXT,
  queryTerms,
  textMatches,
  GITHUB_CATALOG,
  GITHUB_FAKE_ANSWERS,
  HARD_BRANCHES,
  toolResultText,
  type AgentToolResult,
  type GithubFake,
} from '../../src/index.js';
import { FakeContent, FakeText } from '../../src/eval/github-fake.js';

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
    try {
      return { value: JSON.parse(result.text) as unknown, result };
    } catch {
      return { result }; // a text answer (a diff, a file's status line and content)
    }
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

  it('records calls and answers from the canned table, and unmodeled tools realistically', async () => {
    const fake = createGithubFake();
    const client = await connect(fake);
    try {
      const me = toolResultText(await client.callTool({ name: 'get_me', arguments: {} }));
      expect(JSON.parse(me.text)).toMatchObject({ login: 'vibdev', details: { public_repos: 3 } });
      const star = toolResultText(
        await client.callTool({ name: 'star_repository', arguments: { ...BASIC } }),
      );
      expect(star).toEqual({
        text: 'Successfully starred repository modelcontextprotocol/servers',
      });
      expect(fake.calls).toEqual([
        { tool: 'get_me', args: {} },
        { tool: 'star_repository', args: { ...BASIC } },
      ]);
    } finally {
      await client.close();
    }
  });

  it('answers unmodeled tools like the real server: never a bare ok', async () => {
    const fake = createGithubFake();
    const client = await connect(fake);
    try {
      const call = async (name: string, args: Record<string, unknown>) =>
        toolResultText(await client.callTool({ name, arguments: args }));
      expect(await call('list_releases', ACME)).toEqual({ text: '[]' });
      expect((await call('get_latest_release', ACME)).isError).toBe(true);
      expect(await call('search_code', { query: 'csv' })).toEqual({
        text: '{"total_count":0,"incomplete_results":false,"items":[]}',
      });
      // A repository GitHub does not have is a 404 for any tool.
      const missing = await call('star_repository', { owner: 'a', repo: 'b' });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain('404 Not Found');
      // Writes answer the real success shape.
      expect(
        JSON.parse((await call('merge_pull_request', { ...BASIC, pullNumber: 7 })).text),
      ).toMatchObject({ merged: true, message: 'Pull Request successfully merged' });
      expect(
        JSON.parse(
          (await call('update_pull_request', { ...ACME, pullNumber: 12, state: 'closed' })).text,
        ),
      ).toEqual({ id: expect.any(String), url: 'https://github.com/acme/widgets/pull/12' });
      for (const text of [
        (await call('star_repository', ACME)).text,
        (await call('merge_pull_request', ACME)).text,
      ]) {
        expect(text).not.toContain('"ok":true');
      }
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

  describe('basic world (modelcontextprotocol/servers)', () => {
    it('answers what the basic tasks read, in the real shapes', async () => {
      expect(numbers(answer('list_pull_requests', { ...BASIC }))).toEqual([12, 9, 7]);
      expect(
        numbers(answer('search_pull_requests', { query: 'repo:modelcontextprotocol/servers' })),
      ).toEqual([12, 9, 7]);
      expect(
        numbers((answer('list_issues', { ...BASIC }) as { issues: unknown[] }).issues),
      ).toEqual([42, 40, 36]);
      expect(numbers(answer('search_issues', { ...BASIC, query: 'crash on startup' }))).toEqual([
        42, 40, 36,
      ]);
      expect(
        numbers(answer('search_issues', { ...BASIC, query: 'crash on startup is:open' })),
      ).toEqual([42, 40]);
      expect(answer('issue_read', { ...BASIC, method: 'get', issue_number: 42 })).toMatchObject({
        number: 42,
        title: 'Crash on startup',
      });
      // A large repository: any number exists there.
      expect(
        answer('pull_request_read', { ...BASIC, method: 'get', pullNumber: 12 }),
      ).toMatchObject({
        number: 12,
      });
      expect(
        answer('add_issue_comment', { ...BASIC, issue_number: 12, body: 'LGTM' }),
      ).toMatchObject({
        url: expect.stringContaining('/modelcontextprotocol/servers/issues/12#issuecomment-'),
      });
      expect(
        answer('create_branch', { ...BASIC, branch: 'feature/x', from_branch: 'main' }),
      ).toMatchObject({ ref: 'refs/heads/feature/x', object: { type: 'commit' } });
      const readme = await call('get_file_contents', { ...BASIC, path: 'README.md' });
      expect(readme.error).toBeUndefined();
      expect(readme.result.text).toContain(
        'reference implementations for the Model Context Protocol',
      );
      expect(answer('search_repositories', { query: 'model context protocol' })).toMatchObject({
        total_count: 1,
        items: [{ full_name: 'modelcontextprotocol/servers', default_branch: 'main' }],
      });
      expect(answer('get_label', { ...BASIC, name: 'bug' })).toMatchObject({ name: 'bug' });
    });
  });

  describe('hard world (acme/widgets and the user), as the real server answers', () => {
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
        const fresh = await call('list_branches', { ...ACME, page: 2 });
        expect(fresh.result).toEqual(a);
      } finally {
        await client.close();
      }
    });

    it('list_issues: open and closed by default, GraphQL items, labels match any, cursor pages', async () => {
      const all = answer('list_issues', { ...ACME }) as {
        issues: Record<string, unknown>[];
        totalCount: number;
        pageInfo: Record<string, unknown>;
      };
      expect(numbers(all.issues)).toEqual([30, 25, 23, 17]);
      expect(all.totalCount).toBe(4);
      expect(all.pageInfo).toMatchObject({ hasNextPage: false, hasPreviousPage: false });
      // GraphQL shape (upstream issues.go:925): uppercase state, user login, label names, no url.
      expect(all.issues[0]).toEqual({
        number: 30,
        title: 'Memory leak in file watcher',
        body: 'Fixed in 1.3.',
        state: 'CLOSED',
        user: { login: 'vibdev' },
        labels: ['bug'],
        assignees: [],
        created_at: '2026-09-28T09:00:00Z',
        updated_at: '2026-09-28T09:00:00Z',
      });
      const list = (args: Record<string, unknown>): number[] =>
        numbers((answer('list_issues', { ...ACME, ...args }) as { issues: unknown[] }).issues);
      expect(list({ state: 'OPEN' })).toEqual([25, 23, 17]);
      expect(list({ labels: ['bug'] })).toEqual([30, 23, 17]);
      expect(list({ labels: ['documentation', 'needs-triage'] })).toEqual([25, 17]);
      expect(list({ state: 'OPEN', labels: ['bug'], direction: 'ASC' })).toEqual([17, 23]);
      const first = answer('list_issues', { ...ACME, perPage: 3 }) as {
        issues: unknown[];
        pageInfo: { hasNextPage: boolean; endCursor: string };
      };
      expect(numbers(first.issues)).toEqual([30, 25, 23]);
      expect(first.pageInfo.hasNextPage).toBe(true);
      expect(list({ perPage: 3, after: first.pageInfo.endCursor })).toEqual([17]);
      // The server normalises case before validating (upstream typed_read_normalizers.go).
      const lowerState = await call('list_issues', { ...ACME, state: 'open', direction: 'asc' });
      expect(numbers((lowerState.value as { issues: unknown[] }).issues)).toEqual([17, 23, 25]);
      // page is refused with the server's own hint (upstream issues.go:3895).
      const paged = await call('list_issues', { ...ACME, page: 2 });
      expect(paged.error).toMatch(
        /^This tool uses cursor-based pagination\. Use the 'after' parameter/,
      );
      expect(answer('list_issues', { owner: 'acme', repo: 'nope' })).toBeInstanceOf(FakeError);
    });

    it('search_issues: is:issue implied, repo: from owner/repo, raw REST items', () => {
      expect(numbers(answer('search_issues', { ...ACME, query: 'Flaky test in CI' }))).toEqual([
        23,
      ]);
      expect(
        numbers(
          answer('search_issues', { query: 'repo:acme/widgets "Flaky test in CI" in:title' }),
        ),
      ).toEqual([23]);
      expect(numbers(answer('search_issues', { ...ACME, query: 'Add dark mode' }))).toEqual([]);
      expect(numbers(answer('search_issues', { ...ACME, query: 'is:open label:bug' }))).toEqual([
        23, 17,
      ]);
      expect(numbers(answer('search_issues', { ...ACME, query: 'is:closed' }))).toEqual([30]);
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
      const result = answer('search_issues', { ...ACME, query: 'Flaky' }) as {
        total_count: number;
        incomplete_results: boolean;
        items: Record<string, unknown>[];
      };
      expect(result.incomplete_results).toBe(false);
      const item = result.items[0] as Record<string, unknown>;
      expect(Object.keys(item)).toEqual(Object.keys(item).toSorted());
      expect(item).toMatchObject({
        number: 23,
        state: 'open',
        html_url: 'https://github.com/acme/widgets/issues/23',
        user: { login: 'vibdev', type: 'User' },
        labels: [{ name: 'bug', color: 'd73a4a' }],
      });
      expect(answer('search_issues', { ...ACME, query: '' })).toBeInstanceOf(FakeError);
      expect(answer('search_issues', { query: 'repo:acme/nope crash' })).toBeInstanceOf(FakeError);
    });

    it('issue_read: MinimalIssue, get_labels wrapper, {parent:null}, and the real 404 text', () => {
      expect(answer('issue_read', { ...ACME, method: 'get', issue_number: 25 })).toEqual({
        number: 25,
        title: 'Docs: add usage examples',
        body: 'The readme has no examples.',
        state: 'open',
        html_url: 'https://github.com/acme/widgets/issues/25',
        user: expect.objectContaining({
          login: 'vibdev',
          profile_url: 'https://github.com/vibdev',
        }),
        author_association: 'OWNER',
        labels: ['documentation'],
        assignees: [],
        comments: 1,
        created_at: '2026-09-25T09:00:00Z',
        updated_at: '2026-09-25T09:00:00Z',
      });
      expect(answer('issue_read', { ...ACME, method: 'get_labels', issue_number: 17 })).toEqual({
        labels: [
          expect.objectContaining({ name: 'bug', color: 'd73a4a' }),
          expect.objectContaining({ name: 'needs-triage' }),
        ],
        totalCount: 2,
      });
      expect(answer('issue_read', { ...ACME, method: 'get_parent', issue_number: 17 })).toEqual({
        parent: null,
      });
      expect(
        (answer('issue_read', { ...ACME, method: 'get', issue_number: 99 }) as FakeError).message,
      ).toBe(
        'failed to get issue: GET https://api.github.com/repos/acme/widgets/issues/99: 404 Not Found []',
      );
      // PRs are issues: reading one by number works.
      expect(answer('issue_read', { ...ACME, method: 'get', issue_number: 12 })).toMatchObject({
        number: 12,
        html_url: 'https://github.com/acme/widgets/pull/12',
      });
    });

    it('list_pull_requests: a bare array of MinimalPullRequest, 30 per page', () => {
      const listed = answer('list_pull_requests', { ...ACME, state: 'open' }) as Record<
        string,
        unknown
      >[];
      expect(numbers(listed)).toEqual([12, 11, 10, 8]);
      expect(listed[1]).toMatchObject({
        number: 11,
        draft: false,
        merged: false,
        user: { login: 'alice' },
        head: { ref: 'release-1.3', sha: expect.stringMatching(/^[0-9a-f]{40}$/) },
        base: { ref: 'master', repo: { full_name: 'acme/widgets' } },
      });
      expect(listed[1]).not.toHaveProperty('mergeable');
      expect(numbers(answer('list_pull_requests', { ...ACME, perPage: 2, page: 2 }))).toEqual([
        10, 8,
      ]);
      expect(numbers(answer('list_pull_requests', { ...ACME, head: 'acme:release-1.3' }))).toEqual([
        11,
      ]);
      expect(
        numbers(
          answer('search_pull_requests', { query: 'repo:acme/widgets is:open author:alice' }),
        ),
      ).toEqual([11, 10]);
      expect(numbers(answer('search_pull_requests', { ...ACME, query: 'release' }))).toEqual([11]);
      const item = (
        answer('search_pull_requests', { ...ACME, query: 'release' }) as {
          items: Record<string, unknown>[];
        }
      ).items[0];
      expect(item).toMatchObject({
        pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/11' },
      });
    });

    it('pull_request_read: real per-method shapes; review comments as threads with no id field', async () => {
      expect(answer('pull_request_read', { ...ACME, method: 'get_files', pullNumber: 11 })).toEqual(
        [
          {
            filename: 'CHANGELOG.md',
            status: 'modified',
            additions: 15,
            deletions: 2,
            changes: 17,
          },
          {
            filename: 'package.json',
            status: 'modified',
            additions: 15,
            deletions: 2,
            changes: 17,
          },
        ],
      );
      const threads = answer('pull_request_read', {
        ...ACME,
        method: 'get_review_comments',
        pullNumber: 8,
      }) as { review_threads: { comments: Record<string, unknown>[] }[]; totalCount: number };
      expect(threads.totalCount).toBe(2);
      const first = threads.review_threads[0]?.comments[0] as Record<string, unknown>;
      expect(first).toMatchObject({
        author: 'bob',
        path: 'src/auth.ts',
        html_url: 'https://github.com/acme/widgets/pull/8#discussion_r9001',
      });
      expect(first).not.toHaveProperty('id');
      const get = answer('pull_request_read', { ...ACME, method: 'get', pullNumber: 12 });
      expect(get).toMatchObject({ number: 12, mergeable_state: 'clean', changed_files: 3 });
      expect(get).not.toHaveProperty('mergeable');
      expect(
        answer('pull_request_read', { ...ACME, method: 'get_status', pullNumber: 12 }),
      ).toMatchObject({
        state: 'pending',
        total_count: 0,
        statuses: [],
      });
      expect(
        answer('pull_request_read', { ...ACME, method: 'get_check_runs', pullNumber: 12 }),
      ).toEqual({
        total_count: 0,
        check_runs: [],
      });
      const diff = await call('pull_request_read', { ...ACME, method: 'get_diff', pullNumber: 10 });
      expect(diff.result.text).toMatch(/^diff --git a\/src\/fetch\.ts b\/src\/fetch\.ts/);
      expect(
        (answer('pull_request_read', { ...ACME, method: 'get', pullNumber: 99 }) as FakeError)
          .message,
      ).toBe(
        'failed to get pull request: GET https://api.github.com/repos/acme/widgets/pulls/99: 404 Not Found []',
      );
    });

    it('list_branches: a bare array of {name, sha, protected}, 30 per page, release/* on page 3', () => {
      const page1 = answer('list_branches', { ...ACME }) as { name: string; sha: string }[];
      expect(page1).toHaveLength(30);
      expect(page1[0]).toEqual({
        name: 'chore/bump-node',
        sha: expect.stringMatching(/^[0-9a-f]{40}$/),
        protected: false,
      });
      const page3 = answer('list_branches', { ...ACME, page: 3 }) as { name: string }[];
      expect(page3.map((b) => b.name)).toEqual([
        'release/1.0',
        'release/1.1',
        'release/1.2',
        'release/1.3',
      ]);
      expect(answer('list_branches', { ...ACME, page: 4 })).toEqual([]);
      expect(answer('list_branches', { ...ACME, perPage: 100 })).toHaveLength(ACME_BRANCHES.length);
      expect(branchesListed({ ...ACME, page: 3 })).toContain('release/1.3');
      expect(branchesListed({ ...ACME, page: '3' })).toContain('release/1.3');
      expect(branchesListed({ ...ACME })).not.toContain('release/1.3');
      expect(branchesListed({ ...BASIC, page: 2 })).toEqual([]);
      expect(ACME_BRANCHES).not.toContain('main');
      expect(HARD_BRANCHES.every((b) => ACME_BRANCHES.includes(b))).toBe(true);
      expect(pageOf([1, 2, 3, 4, 5], { page: 2, perPage: 2 })).toEqual({
        items: [3, 4],
        page: 2,
        perPage: 2,
        hasNext: true,
      });
    });

    it('create_branch: a missing source is a bare 404 on the ref; success is the new Reference', async () => {
      const failed = await call('create_branch', {
        ...ACME,
        branch: 'hotfix/login',
        from_branch: 'main',
      });
      expect(failed.error).toBe(
        'failed to get reference: GET https://api.github.com/repos/acme/widgets/git/ref/heads/main: 404 Not Found []',
      );
      const ok = await call('create_branch', {
        ...ACME,
        branch: 'hotfix/login',
        from_branch: 'master',
      });
      expect(ok.value).toMatchObject({
        ref: 'refs/heads/hotfix/login',
        object: { type: 'commit', sha: expect.stringMatching(/^[0-9a-f]{40}$/) },
      });
      const omitted = await call('create_branch', { ...ACME, branch: 'hotfix/login' });
      expect(omitted.value).toMatchObject({ ref: 'refs/heads/hotfix/login' });
      expect((answer('create_branch', { ...ACME, branch: 'develop' }) as FakeError).message).toBe(
        'failed to create branch: Reference already exists',
      );
    });

    it("get_file_contents: a file is text plus a resource; a miss gets the server's suffix match or error", async () => {
      const missing = await call('get_file_contents', { ...ACME, path: 'README.md' });
      expect(missing.error).toBe(
        'Failed to get file contents. The path does not point to a file or directory, or the file does not exist in the repository.',
      );
      const root = answer('get_file_contents', { ...ACME, path: '/' }) as Record<string, unknown>[];
      expect(root.map((e) => [e['name'], e['type']])).toEqual([
        ['package.json', 'file'],
        ['readme.md', 'file'],
        ['src', 'dir'],
      ]);
      expect(root[1]).toMatchObject({
        path: 'readme.md',
        html_url: 'https://github.com/acme/widgets/blob/master/readme.md',
        download_url: 'https://raw.githubusercontent.com/acme/widgets/master/readme.md',
      });
      expect(answer('get_file_contents', { ...ACME })).toEqual(root);
      const found = answer('get_file_contents', { ...ACME, path: 'readme.md' }) as FakeContent;
      expect(found).toBeInstanceOf(FakeContent);
      expect(found.blocks[0]).toEqual({
        type: 'text',
        text: expect.stringMatching(/^successfully downloaded text file \(SHA: [0-9a-f]{40}\)$/),
      });
      expect(found.blocks[1]).toMatchObject({
        type: 'resource',
        resource: { mimeType: 'text/plain; charset=utf-8', text: HARD_README_TEXT },
      });
      // The host shows the resource's text to the model.
      const viaMcp = await call('get_file_contents', { ...ACME, path: 'readme.md' });
      expect(viaMcp.result.text).toContain('Small, sturdy widgets.');
      // A partial path resolves through the tree, not as an error.
      const partial = answer('get_file_contents', { ...ACME, path: 'auth.ts' }) as FakeText;
      expect(partial.text).toMatch(
        /^Resolved potential matches in the repository tree .*\["src\/auth\.ts"\]/,
      );
      // ref main falls back to the default branch with a note; another bad ref fails.
      const viaMain = answer('get_file_contents', {
        ...ACME,
        path: 'readme.md',
        ref: 'main',
      }) as FakeContent;
      expect((viaMain.blocks[0] as { text: string }).text).toContain(
        "Note: the provided ref 'main' does not exist, default branch 'refs/heads/master' was used instead.",
      );
      expect(
        (answer('get_file_contents', { ...ACME, path: 'readme.md', ref: 'nope' }) as FakeError)
          .message,
      ).toBe('failed to resolve git reference: could not resolve ref "nope" as a branch or a tag');
    });

    it('get_repository_tree: blob/tree entries with mode and sha; path_filter is a plain prefix', () => {
      const tree = (args: Record<string, unknown>) =>
        answer('get_repository_tree', { ...ACME, ...args }) as {
          tree: { path: string; type: string }[];
          truncated: boolean;
          count: number;
          tree_sha: string;
        };
      expect(tree({}).tree.map((e) => [e.path, e.type])).toEqual([
        ['package.json', 'blob'],
        ['readme.md', 'blob'],
        ['src', 'tree'],
      ]);
      expect(tree({})).toMatchObject({ truncated: false, count: 3, tree_sha: 'master' });
      expect(tree({ recursive: true, path_filter: 'src/' }).tree.map((e) => e.path)).toEqual([
        'src/auth.ts',
        'src/fetch.ts',
        'src/index.ts',
      ]);
      // No trimming: a leading ./ matches nothing, as upstream git.go's HasPrefix.
      expect(tree({ recursive: true, path_filter: './src/' }).tree).toEqual([]);
    });

    it("add_issue_comment: body or reaction required, with the server's text; answers {id, url}", () => {
      expect(
        (answer('add_issue_comment', { ...ACME, issue_number: 23 }) as FakeError).message,
      ).toBe('at least one of body or reaction is required');
      expect(answer('add_issue_comment', { ...ACME, issue_number: 23, body: 'hi' })).toEqual({
        id: expect.stringMatching(/^\d+$/),
        url: expect.stringMatching(
          /^https:\/\/github\.com\/acme\/widgets\/issues\/23#issuecomment-\d+$/,
        ),
      });
      expect(answer('add_issue_comment', { ...ACME, issue_number: 99, body: 'hi' })).toBeInstanceOf(
        FakeError,
      );
    });

    it('list_starred_repositories: bare MinimalRepository array (no owner object)', () => {
      const starred = answer('list_starred_repositories', {}) as Record<string, unknown>[];
      expect(starred.map((r) => r['full_name'])).toEqual(['acme/widgets', 'octocat/Hello-World']);
      expect(starred[0]).toMatchObject({
        name: 'widgets',
        html_url: 'https://github.com/acme/widgets',
      });
      expect(starred[0]).not.toHaveProperty('owner');
    });

    it('search_repositories: owner scoping and text over names and descriptions; unrelated queries find nothing', () => {
      const mine = answer('search_repositories', { query: 'user:vibdev' }) as {
        items: { full_name: string }[];
      };
      expect(mine.items.map((r) => r.full_name)).toEqual([
        'vibdev/blog',
        'vibdev/dotfiles',
        'vibdev/toolbox',
      ]);
      expect(answer('search_repositories', { query: 'user:@me' })).toEqual(mine);
      expect(answer('search_repositories', { query: 'vibdev' })).toEqual(mine);
      expect(answer('search_repositories', { query: 'widgets in:name' })).toMatchObject({
        items: [{ full_name: 'acme/widgets', default_branch: 'master' }],
      });
      expect(answer('search_repositories', { query: 'quantum teleporter' })).toEqual({
        total_count: 0,
        incomplete_results: false,
        items: [],
      });
    });

    it('list_dependabot_alerts: {alerts, pageInfo}; no state means every state', () => {
      const alerts = answer('list_dependabot_alerts', { owner: 'vibdev', repo: 'toolbox' }) as {
        alerts: { dependency: { package: { name: string } } }[];
        pageInfo: unknown;
      };
      expect(alerts.alerts.map((a) => a.dependency.package.name)).toEqual(['lodash', 'minimist']);
      expect(alerts.pageInfo).toEqual({ hasNextPage: false, hasPreviousPage: false });
      const high = answer('list_dependabot_alerts', {
        owner: 'vibdev',
        repo: 'toolbox',
        severity: 'high',
      }) as {
        alerts: unknown[];
      };
      expect(high.alerts).toHaveLength(1);
      expect(
        (
          answer('list_dependabot_alerts', { owner: 'vibdev', repo: 'dotfiles' }) as {
            alerts: unknown[];
          }
        ).alerts,
      ).toEqual([]);
    });

    it("list_label / get_label: GraphQL label objects in a wrapper; a miss is the server's text", () => {
      const labels = answer('list_label', { ...ACME }) as {
        labels: { name: string; color: string; id: string; description: string }[];
        totalCount: number;
      };
      expect(labels.labels.map((l) => l.name)).toEqual([...HARD_LABELS]);
      expect(labels.totalCount).toBe(4);
      expect(answer('get_label', { ...ACME, name: 'Good First Issue' })).toMatchObject({
        name: 'good first issue',
        color: '7057ff',
      });
      expect((answer('get_label', { ...ACME, name: 'nope' }) as FakeError).message).toBe(
        "label 'nope' not found in acme/widgets",
      );
      expect(answer('semantic_issue_similarity_search', { ...ACME, issue_number: 23 })).toEqual([]);
    });

    it('issue_write: create needs a title; create and update answer {id, url}, never the issue', async () => {
      const untitled = await call('issue_write', { ...ACME, method: 'create' });
      expect(untitled.error).toBe('missing required parameter: title');
      expect(answer('issue_write', { ...ACME, method: 'create', title: 'Add dark mode' })).toEqual({
        id: expect.stringMatching(/^\d+$/),
        url: 'https://github.com/acme/widgets/issues/101',
      });
      expect(
        answer('issue_write', { ...ACME, method: 'update', issue_number: 17, state: 'closed' }),
      ).toEqual({
        id: expect.stringMatching(/^\d+$/),
        url: 'https://github.com/acme/widgets/issues/17',
      });
      expect(
        (answer('issue_write', { ...ACME, method: 'update', state: 'closed' }) as FakeError)
          .message,
      ).toBe('missing required parameter: issue_number');
      expect(
        (
          answer('issue_write', {
            ...ACME,
            method: 'update',
            issue_number: 99,
            state: 'closed',
          }) as FakeError
        ).message,
      ).toBe(
        'failed to update issue: PATCH https://api.github.com/repos/acme/widgets/issues/99: 404 Not Found []',
      );
    });

    it('writes that are not scripted answer the real success shape and are recorded', async () => {
      const fake = createGithubFake();
      const client = await connect(fake);
      try {
        const result = toolResultText(
          await client.callTool({
            name: 'actions_run_trigger',
            arguments: { ...ACME, method: 'rerun_failed_jobs', run_id: 123 },
          }),
        );
        expect(JSON.parse(result.text)).toEqual({
          message: 'Failed jobs have been queued for re-run',
          run_id: 123,
          status: '201 Created',
          status_code: 201,
        });
        const review = toolResultText(
          await client.callTool({
            name: 'pull_request_review_write',
            arguments: {
              ...ACME,
              method: 'create',
              pullNumber: 10,
              event: 'REQUEST_CHANGES',
              body: 'x',
            },
          }),
        );
        expect(review.text).toBe('pull request review submitted successfully');
        expect(fake.calls.map((c) => c.tool)).toEqual([
          'actions_run_trigger',
          'pull_request_review_write',
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
