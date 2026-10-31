/**
 * Task predicates: each fires on its canonical upstream call sequence and
 * stays quiet on nothing; lenient on synonyms, strict on stated values.
 * Hard tasks also get a wrong-but-plausible sequence (a right behaviour
 * must pass, a wrong one must not) and their `forbid` checks.
 */

import { describe, expect, it } from 'vitest';
import {
  BASIC_TASKS,
  FILESYSTEM_TASKS,
  HARD_TASKS,
  MONGODB_TASKS,
  MULTI_HARD_TASKS,
  WORKPLACE_TASKS,
  HITL_TASKS,
  MESSY_TASKS,
  MULTI_TASKS,
  promptFor,
  resolveTasks,
  resolveTiers,
  TOOL_CHOICE_TASKS,
  worldOf,
  type EvalTask,
  type SideEffect,
} from '../../src/index.js';

/** The GitHub tiers; the filesystem tier has its own test file. */
const GITHUB_TASKS = [...BASIC_TASKS, ...HARD_TASKS];

const REPO = { owner: 'modelcontextprotocol', repo: 'servers' };
const ACME = { owner: 'acme', repo: 'widgets' };
const TOOLBOX = { owner: 'vibdev', repo: 'toolbox' };

function task(name: string): EvalTask {
  const found = TOOL_CHOICE_TASKS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no task ${name}`);
  return found;
}

/** `success` as the runner computes it: expect holds and nothing forbidden was called. */
function scores(t: EvalTask, calls: SideEffect[]): boolean {
  const forbid = t.forbid;
  return t.expect(calls) && !(forbid !== undefined && calls.some((c) => forbid(c)));
}

/** The canonical upstream calls that solve each task. */
const GOLDEN: Record<string, SideEffect[]> = {
  'create-issue': [
    {
      tool: 'issue_write',
      args: {
        ...REPO,
        method: 'create',
        title: 'Crash on startup',
        body: 'The server crashes on startup when the config file is missing.',
      },
    },
  ],
  'list-open-prs': [{ tool: 'list_pull_requests', args: { ...REPO, state: 'open' } }],
  'read-readme': [{ tool: 'get_file_contents', args: { ...REPO, path: 'README.md' } }],
  'who-am-i': [{ tool: 'get_me', args: {} }],
  'search-repos': [{ tool: 'search_repositories', args: { query: 'model context protocol' } }],
  'trigger-workflow': [
    {
      tool: 'actions_run_trigger',
      args: { ...REPO, method: 'run_workflow', workflow_id: 'ci.yml', ref: 'main' },
    },
  ],
  'comment-on-pr': [
    { tool: 'add_issue_comment', args: { ...REPO, issue_number: 12, body: 'Looks good to me' } },
  ],
  'star-repo': [{ tool: 'star_repository', args: { ...REPO } }],
  'list-notifications': [{ tool: 'list_notifications', args: {} }],
  'merge-pr-squash': [
    { tool: 'merge_pull_request', args: { ...REPO, pullNumber: 7, merge_method: 'squash' } },
  ],
  'create-branch': [
    { tool: 'create_branch', args: { ...REPO, branch: 'feature/x', from_branch: 'main' } },
  ],
  'fork-repo': [{ tool: 'fork_repository', args: { ...REPO } }],
  'find-issue-then-comment': [
    {
      tool: 'search_issues',
      args: { query: 'repo:modelcontextprotocol/servers crash on startup' },
    },
    { tool: 'add_issue_comment', args: { ...REPO, issue_number: 42, body: 'investigating' } },
  ],
  'list-prs-then-merge': [
    { tool: 'list_pull_requests', args: { ...REPO, state: 'open' } },
    { tool: 'merge_pull_request', args: { ...REPO, pullNumber: 7, merge_method: 'squash' } },
  ],
  'me-then-star-dotfiles': [
    { tool: 'get_me', args: {} },
    { tool: 'star_repository', args: { owner: 'vibdev', repo: 'dotfiles' } },
  ],

  // --- hard tier
  'close-issue-not-planned': [
    {
      tool: 'issue_write',
      args: {
        ...ACME,
        method: 'update',
        issue_number: 17,
        state: 'closed',
        state_reason: 'not_planned',
      },
    },
  ],
  'label-issue-keep-existing': [
    { tool: 'issue_read', args: { ...ACME, method: 'get_labels', issue_number: 25 } },
    {
      tool: 'issue_write',
      args: {
        ...ACME,
        method: 'update',
        issue_number: 25,
        labels: ['documentation', 'good first issue'],
      },
    },
  ],
  'reply-in-review-thread': [
    { tool: 'pull_request_read', args: { ...ACME, method: 'get_review_comments', pullNumber: 8 } },
    {
      tool: 'add_reply_to_pull_request_comment',
      args: { ...ACME, pullNumber: 8, commentId: 9001, body: 'Fixed in the latest push' },
    },
  ],
  'rerun-failed-jobs': [
    { tool: 'actions_run_trigger', args: { ...ACME, method: 'rerun_failed_jobs', run_id: 123 } },
  ],
  'merge-alice-changelog-pr': [
    { tool: 'list_pull_requests', args: { ...ACME, state: 'open' } },
    { tool: 'pull_request_read', args: { ...ACME, method: 'get_files', pullNumber: 10 } },
    { tool: 'pull_request_read', args: { ...ACME, method: 'get_files', pullNumber: 11 } },
    { tool: 'merge_pull_request', args: { ...ACME, pullNumber: 11, merge_method: 'squash' } },
  ],
  'comment-newest-open-bug': [
    { tool: 'list_issues', args: { ...ACME, state: 'OPEN', labels: ['bug'] } },
    { tool: 'add_issue_comment', args: { ...ACME, issue_number: 23, body: 'Taking a look' } },
  ],
  'branch-from-latest-release-branch': [
    { tool: 'list_branches', args: { ...ACME } },
    { tool: 'list_branches', args: { ...ACME, page: 2 } },
    {
      tool: 'create_branch',
      args: { ...ACME, branch: 'release/1.4', from_branch: 'release/1.3' },
    },
  ],
  'branch-off-main-or-default': [
    { tool: 'create_branch', args: { ...ACME, branch: 'hotfix/login', from_branch: 'main' } },
    { tool: 'create_branch', args: { ...ACME, branch: 'hotfix/login', from_branch: 'master' } },
  ],
  'read-lowercase-readme': [
    { tool: 'get_file_contents', args: { ...ACME, path: 'README.md' } },
    { tool: 'get_file_contents', args: { ...ACME, path: '' } },
    { tool: 'get_file_contents', args: { ...ACME, path: 'readme.md' } },
  ],
  'upsert-issue-exists': [
    { tool: 'search_issues', args: { ...ACME, query: 'Flaky test in CI' } },
    {
      tool: 'add_issue_comment',
      args: { ...ACME, issue_number: 23, body: 'Still happening on 1.3' },
    },
  ],
  'upsert-issue-missing': [
    { tool: 'search_issues', args: { ...ACME, query: 'Add dark mode' } },
    { tool: 'issue_write', args: { ...ACME, method: 'create', title: 'Add dark mode' } },
  ],
  'star-unless-starred': [{ tool: 'list_starred_repositories', args: {} }],
  'dependabot-summary-issue': [
    { tool: 'get_me', args: {} },
    { tool: 'search_repositories', args: { query: 'user:vibdev' } },
    { tool: 'list_dependabot_alerts', args: { owner: 'vibdev', repo: 'blog' } },
    { tool: 'list_dependabot_alerts', args: { owner: 'vibdev', repo: 'dotfiles' } },
    { tool: 'list_dependabot_alerts', args: { ...TOOLBOX } },
    {
      tool: 'issue_write',
      args: {
        ...TOOLBOX,
        method: 'create',
        title: 'Open Dependabot alerts',
        body: '- lodash (high, CVE-2021-23337)\n- minimist (medium, CVE-2021-44906)',
      },
    },
  ],
  'url-close-pr-with-comment': [
    { tool: 'update_pull_request', args: { ...ACME, pullNumber: 12, state: 'closed' } },
    { tool: 'add_issue_comment', args: { ...ACME, issue_number: 12, body: 'Superseded by #11' } },
  ],
  'url-request-changes': [
    {
      tool: 'pull_request_review_write',
      args: {
        ...ACME,
        method: 'create',
        pullNumber: 10,
        event: 'REQUEST_CHANGES',
        body: 'Please add tests',
      },
    },
  ],
};

/**
 * For each hard task, a plausible wrong behaviour: the right tool family
 * reached, but the wrong method, target, or an extra forbidden write.
 */
const WRONG: Record<string, SideEffect[]> = {
  // Closed, but as completed.
  'close-issue-not-planned': [
    {
      tool: 'issue_write',
      args: {
        ...ACME,
        method: 'update',
        issue_number: 17,
        state: 'closed',
        state_reason: 'completed',
      },
    },
  ],
  // Drops the existing label.
  'label-issue-keep-existing': [
    {
      tool: 'issue_write',
      args: { ...ACME, method: 'update', issue_number: 25, labels: ['good first issue'] },
    },
  ],
  // A top-level PR comment instead of a thread reply.
  'reply-in-review-thread': [
    { tool: 'pull_request_read', args: { ...ACME, method: 'get_review_comments', pullNumber: 8 } },
    {
      tool: 'add_issue_comment',
      args: { ...ACME, issue_number: 8, body: 'Fixed in the latest push' },
    },
  ],
  // Re-runs the whole run.
  'rerun-failed-jobs': [
    { tool: 'actions_run_trigger', args: { ...ACME, method: 'rerun_workflow_run', run_id: 123 } },
  ],
  // Merges alice's other PR.
  'merge-alice-changelog-pr': [
    { tool: 'list_pull_requests', args: { ...ACME, state: 'open' } },
    { tool: 'merge_pull_request', args: { ...ACME, pullNumber: 10, merge_method: 'squash' } },
  ],
  // The newest bug overall is closed.
  'comment-newest-open-bug': [
    { tool: 'list_issues', args: { ...ACME, labels: ['bug'] } },
    { tool: 'add_issue_comment', args: { ...ACME, issue_number: 30, body: 'Taking a look' } },
  ],
  // Never saw page 2: guessed release/1.3 from nothing.
  'branch-from-latest-release-branch': [
    { tool: 'list_branches', args: { ...ACME } },
    {
      tool: 'create_branch',
      args: { ...ACME, branch: 'release/1.4', from_branch: 'release/1.3' },
    },
  ],
  // Gave up after the error.
  'branch-off-main-or-default': [
    { tool: 'create_branch', args: { ...ACME, branch: 'hotfix/login', from_branch: 'main' } },
  ],
  // Only ever asked for the capitalised name.
  'read-lowercase-readme': [
    { tool: 'get_file_contents', args: { ...ACME, path: 'README.md' } },
    { tool: 'get_file_contents', args: { ...ACME, path: 'README' } },
  ],
  // Created a duplicate as well as commenting.
  'upsert-issue-exists': [
    { tool: 'search_issues', args: { ...ACME, query: 'Flaky test in CI' } },
    {
      tool: 'add_issue_comment',
      args: { ...ACME, issue_number: 23, body: 'Still happening on 1.3' },
    },
    { tool: 'issue_write', args: { ...ACME, method: 'create', title: 'Flaky test in CI' } },
  ],
  // Commented on an unrelated issue instead of creating.
  'upsert-issue-missing': [
    { tool: 'search_issues', args: { ...ACME, query: 'Add dark mode' } },
    { tool: 'add_issue_comment', args: { ...ACME, issue_number: 25, body: 'Still wanted' } },
  ],
  // Starred without looking (or after looking).
  'star-unless-starred': [
    { tool: 'list_starred_repositories', args: {} },
    { tool: 'star_repository', args: { ...ACME } },
  ],
  // Opened the issue in the wrong repository.
  'dependabot-summary-issue': [
    { tool: 'search_repositories', args: { query: 'user:vibdev' } },
    { tool: 'list_dependabot_alerts', args: { ...TOOLBOX } },
    {
      tool: 'issue_write',
      args: { owner: 'vibdev', repo: 'dotfiles', method: 'create', title: 'lodash, minimist' },
    },
  ],
  // Merged it.
  'url-close-pr-with-comment': [
    { tool: 'merge_pull_request', args: { ...ACME, pullNumber: 12, merge_method: 'squash' } },
    { tool: 'add_issue_comment', args: { ...ACME, issue_number: 12, body: 'Superseded by #11' } },
  ],
  // A plain comment, not a review requesting changes.
  'url-request-changes': [
    { tool: 'add_issue_comment', args: { ...ACME, issue_number: 10, body: 'Please add tests' } },
  ],
};

describe('tool-choice tasks', () => {
  it('covers every GitHub task with a golden sequence, and names are unique', () => {
    const names = TOOL_CHOICE_TASKS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(TOOL_CHOICE_TASKS).toEqual([
      ...GITHUB_TASKS,
      ...FILESYSTEM_TASKS,
      ...MONGODB_TASKS,
      ...MULTI_TASKS,
      ...MULTI_HARD_TASKS,
      ...WORKPLACE_TASKS,
      ...HITL_TASKS,
      ...MESSY_TASKS,
    ]);
    expect(Object.keys(GOLDEN).toSorted()).toEqual(GITHUB_TASKS.map((t) => t.name).toSorted());
    expect(BASIC_TASKS).toHaveLength(15);
    expect(HARD_TASKS.length).toBeGreaterThanOrEqual(12);
    expect(BASIC_TASKS.every((t) => t.tier === 'basic')).toBe(true);
    expect(HARD_TASKS.every((t) => t.tier === 'hard')).toBe(true);
    expect(Object.keys(WRONG).toSorted()).toEqual(HARD_TASKS.map((t) => t.name).toSorted());
  });

  it('prompts say what, never how: no tool names', () => {
    for (const t of TOOL_CHOICE_TASKS) {
      // The tools of the task's own world: a GitHub prompt may say "find",
      // which is a MongoDB tool, not one the GitHub server has. The multi
      // world has every box's tools; its steps name them `<alias>.<name>`,
      // and a prompt must not name the bare tool either.
      const toolNames = new Set(
        TOOL_CHOICE_TASKS.filter((o) => o.tier === t.tier)
          .flatMap((o) => o.steps.flat())
          .map((name) => (worldOf(t.tier) === 'multi' ? name.replace(/^[a-z]+\./, '') : name)),
      );
      if (worldOf(t.tier) === 'multi') {
        // Every box's tools, not only the ones some step names.
        for (const name of ['find', 'count', 'aggregate', 'explain', 'search_files']) {
          toolNames.add(name);
        }
      }
      const prompt = promptFor(t, { root: '/home/me/project' });
      // As a word: "account" may contain "count", but no prompt names a tool.
      for (const name of toolNames) {
        expect(prompt).not.toMatch(new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`, 'i'));
      }
    }
  });

  for (const t of GITHUB_TASKS) {
    it(`${t.name}: fires on the golden calls and not on nothing`, () => {
      const golden = GOLDEN[t.name] as SideEffect[];
      expect(t.expect([])).toBe(false);
      expect(scores(t, golden)).toBe(true);
      // Every step's tool group is hit by the golden sequence.
      for (const group of t.steps) {
        expect(golden.some((call) => group.includes(call.tool))).toBe(true);
      }
      // The right tool with wrong arguments (where arguments matter) is not success.
      const stripped = golden.map((call) => ({ tool: call.tool, args: {} }));
      const argless = ['get_me', 'list_notifications', 'list_starred_repositories'];
      if (t.steps.flat().every((name) => !argless.includes(name))) {
        expect(scores(t, stripped)).toBe(false);
      }
    });
  }

  for (const t of HARD_TASKS) {
    it(`${t.name}: does not score the plausible wrong behaviour`, () => {
      expect(scores(t, WRONG[t.name] as SideEffect[])).toBe(false);
    });
  }

  it('list-open-prs: a defaulted state or an open-PR search counts, closed/all do not', () => {
    const t = task('list-open-prs');
    const list = (args: Record<string, unknown>): SideEffect[] => [
      { tool: 'list_pull_requests', args },
    ];
    const search = (args: Record<string, unknown>): SideEffect[] => [
      { tool: 'search_pull_requests', args },
    ];
    expect(t.expect(list({ ...REPO }))).toBe(true);
    expect(t.expect(list({ ...REPO, state: 'OPEN' }))).toBe(true);
    expect(t.expect(list({ ...REPO, state: 'closed' }))).toBe(false);
    expect(t.expect(list({ ...REPO, state: 'all' }))).toBe(false);
    expect(t.expect(list({ owner: 'someone', repo: 'else' }))).toBe(false);
    expect(t.expect(search({ query: 'repo:modelcontextprotocol/servers is:open' }))).toBe(true);
    expect(t.expect(search({ query: 'is:pr state:open repo:ModelContextProtocol/Servers' }))).toBe(
      true,
    );
    expect(t.expect(search({ ...REPO, query: 'is:open' }))).toBe(true);
    expect(t.expect(search({ query: 'repo:modelcontextprotocol/servers' }))).toBe(false);
    expect(t.expect(search({ ...REPO, query: '' }))).toBe(false);
    expect(t.expect(search({ query: 'is:open' }))).toBe(false);
    expect(t.expect(search({ query: 'repo:modelcontextprotocol/servers is:closed' }))).toBe(false);
  });

  it('list-prs-then-merge: the lookup may put the repo in the query or in owner/repo', () => {
    const t = task('list-prs-then-merge');
    const merge: SideEffect = {
      tool: 'merge_pull_request',
      args: { ...REPO, pullNumber: 7, merge_method: 'squash' },
    };
    const search = (args: Record<string, unknown>): SideEffect => ({
      tool: 'search_pull_requests',
      args,
    });
    const list = (args: Record<string, unknown>): SideEffect => ({
      tool: 'list_pull_requests',
      args,
    });
    expect(
      t.expect([search({ query: 'repo:modelcontextprotocol/servers is:open Fix typo' }), merge]),
    ).toBe(true);
    expect(t.expect([search({ query: 'repo:modelcontextprotocol/servers Fix typo' }), merge])).toBe(
      true,
    );
    expect(t.expect([search({ ...REPO, query: 'is:open Fix typo' }), merge])).toBe(true);
    expect(t.expect([search({ ...REPO, query: 'Fix typo in:title' }), merge])).toBe(true);
    expect(t.expect([search({ ...REPO, query: 'Fix typo is:closed' }), merge])).toBe(false);
    expect(t.expect([search({ query: 'Fix typo' }), merge])).toBe(false);
    expect(t.expect([search({ owner: 'other', repo: 'repo', query: 'Fix typo' }), merge])).toBe(
      false,
    );
    expect(t.expect([list({ ...REPO }), merge])).toBe(true);
    expect(t.expect([list({ ...REPO, state: 'all' }), merge])).toBe(true);
    expect(t.expect([list({ ...REPO, state: 'closed' }), merge])).toBe(false);
    expect(t.expect([merge, list({ ...REPO })])).toBe(false);
  });

  it('comments count only once they are visible: pending reviews need a submit', () => {
    const comment = task('comment-on-pr');
    const pending: SideEffect = {
      tool: 'pull_request_review_write',
      args: { ...REPO, method: 'create', pullNumber: 12, body: 'Looks good to me' },
    };
    const lineComment: SideEffect = {
      tool: 'add_comment_to_pending_review',
      args: {
        ...REPO,
        pullNumber: 12,
        path: 'README.md',
        subjectType: 'FILE',
        body: 'Looks good to me',
      },
    };
    const submit: SideEffect = {
      tool: 'pull_request_review_write',
      args: { ...REPO, method: 'submit_pending', pullNumber: 12, event: 'COMMENT' },
    };
    const submitOtherPr: SideEffect = {
      tool: 'pull_request_review_write',
      args: { ...REPO, method: 'submit_pending', pullNumber: 13, event: 'COMMENT' },
    };
    expect(comment.expect([pending])).toBe(false);
    expect(comment.expect([lineComment])).toBe(false);
    expect(comment.expect([pending, lineComment])).toBe(false);
    expect(comment.expect([pending, submitOtherPr])).toBe(false);
    expect(comment.expect([pending, submit])).toBe(true);
    expect(comment.expect([pending, lineComment, submit])).toBe(true);
    expect(comment.expect([submit, pending])).toBe(false);
    expect(
      comment.expect([
        {
          tool: 'pull_request_review_write',
          args: {
            ...REPO,
            method: 'create',
            pullNumber: 12,
            body: 'Looks good to me',
            event: 'APPROVE',
          },
        },
      ]),
    ).toBe(true);
    expect(
      comment.expect([
        {
          tool: 'pull_request_review_write',
          args: {
            ...REPO,
            method: 'submit_pending',
            pullNumber: 12,
            body: 'Looks good to me',
            event: 'COMMENT',
          },
        },
      ]),
    ).toBe(true);
    expect(
      comment.expect([
        {
          tool: 'add_reply_to_pull_request_comment',
          args: { ...REPO, pullNumber: 12, commentId: 1, body: 'Looks good to me' },
        },
      ]),
    ).toBe(true);

    const multi = task('find-issue-then-comment');
    const lookup: SideEffect = { tool: 'list_issues', args: { ...REPO } };
    const pending42: SideEffect = {
      tool: 'pull_request_review_write',
      args: { ...REPO, method: 'create', pullNumber: 42, body: 'investigating' },
    };
    const submit42: SideEffect = {
      tool: 'pull_request_review_write',
      args: { ...REPO, method: 'submit_pending', pullNumber: 42, event: 'COMMENT' },
    };
    expect(multi.expect([lookup, pending42, submit42])).toBe(true);
    expect(multi.expect([lookup, pending42])).toBe(false);
    expect(multi.expect([pending42, lookup, submit42])).toBe(true);
    expect(multi.expect([pending42, submit42, lookup])).toBe(false);
  });

  it('normalises ref and path prefixes, and keeps from_branch strict', () => {
    const workflow = task('trigger-workflow');
    const run = (ref: string): SideEffect[] => [
      {
        tool: 'actions_run_trigger',
        args: { ...REPO, method: 'run_workflow', workflow_id: 'ci.yml', ref },
      },
    ];
    expect(workflow.expect(run('refs/heads/main'))).toBe(true);
    expect(workflow.expect(run('main'))).toBe(true);
    expect(workflow.expect(run('refs/heads/develop'))).toBe(false);
    expect(workflow.expect(run('refs/tags/main'))).toBe(false);

    const readme = task('read-readme');
    const read = (path: string): SideEffect[] => [
      { tool: 'get_file_contents', args: { ...REPO, path } },
    ];
    expect(readme.expect(read('README.md'))).toBe(true);
    expect(readme.expect(read('./README.md'))).toBe(true);
    expect(readme.expect(read('/README.md'))).toBe(true);
    expect(readme.expect(read('readme.md'))).toBe(true);
    expect(readme.expect(read('docs/README.md'))).toBe(false);
    expect(readme.expect(read('README'))).toBe(false);

    const branch = task('create-branch');
    expect(branch.expect([{ tool: 'create_branch', args: { ...REPO, branch: 'feature/x' } }])).toBe(
      false,
    );
    expect(
      branch.expect([
        { tool: 'create_branch', args: { ...REPO, branch: 'feature/x', from_branch: 'develop' } },
      ]),
    ).toBe(false);
  });

  it('is lenient on synonyms and types, strict on stated values', () => {
    const merge = task('merge-pr-squash');
    expect(
      merge.expect([
        {
          tool: 'merge_pull_request',
          args: {
            owner: 'ModelContextProtocol',
            repo: 'Servers',
            pull_number: '7',
            merge_method: 'squash',
          },
        },
      ]),
    ).toBe(true);
    expect(
      merge.expect([
        { tool: 'merge_pull_request', args: { ...REPO, pullNumber: 7, merge_method: 'merge' } },
      ]),
    ).toBe(false);

    const comment = task('comment-on-pr');
    expect(
      comment.expect([
        {
          tool: 'pull_request_review_write',
          args: {
            ...REPO,
            method: 'create',
            pullNumber: 12,
            body: 'Looks good to me!',
            event: 'COMMENT',
          },
        },
      ]),
    ).toBe(true);
    expect(
      comment.expect([
        {
          tool: 'add_issue_comment',
          args: { ...REPO, issue_number: 13, body: 'Looks good to me' },
        },
      ]),
    ).toBe(false);

    const multi = task('find-issue-then-comment');
    expect(
      multi.expect([
        { tool: 'add_issue_comment', args: { ...REPO, issue_number: 42, body: 'investigating' } },
        { tool: 'list_issues', args: { ...REPO } },
      ]),
    ).toBe(false);
  });

  describe('hard tier', () => {
    it('close-issue-not-planned: needs update + closed + not_planned on #17', () => {
      const t = task('close-issue-not-planned');
      const update = (extra: Record<string, unknown>): SideEffect[] => [
        { tool: 'issue_write', args: { ...ACME, method: 'update', issue_number: 17, ...extra } },
      ];
      expect(scores(t, update({ state: 'closed', state_reason: 'not_planned' }))).toBe(true);
      expect(scores(t, update({ state: 'CLOSED', state_reason: 'NOT_PLANNED' }))).toBe(true);
      expect(scores(t, update({ state: 'closed' }))).toBe(false);
      expect(scores(t, update({ state_reason: 'not_planned' }))).toBe(false);
      expect(scores(t, update({ state: 'closed', state_reason: 'duplicate' }))).toBe(false);
      expect(
        scores(t, [
          {
            tool: 'issue_write',
            args: {
              ...ACME,
              method: 'update',
              issue_number: 23,
              state: 'closed',
              state_reason: 'not_planned',
            },
          },
        ]),
      ).toBe(false);
      // Creating anything is forbidden even alongside the right update.
      expect(
        scores(t, [
          ...update({ state: 'closed', state_reason: 'not_planned' }),
          { tool: 'issue_write', args: { ...ACME, method: 'create', title: 'x' } },
        ]),
      ).toBe(false);
    });

    it('label-issue-keep-existing: both labels, in any order or shape; label_write forbidden', () => {
      const t = task('label-issue-keep-existing');
      const update = (labels: unknown): SideEffect[] => [
        { tool: 'issue_write', args: { ...ACME, method: 'update', issue_number: 25, labels } },
      ];
      expect(scores(t, update(['good first issue', 'documentation']))).toBe(true);
      expect(scores(t, update(['Documentation', 'Good First Issue']))).toBe(true);
      expect(scores(t, update([{ name: 'documentation' }, { name: 'good first issue' }]))).toBe(
        true,
      );
      expect(scores(t, update(['good first issue']))).toBe(false);
      expect(scores(t, update(['documentation']))).toBe(false);
      expect(scores(t, update('good first issue'))).toBe(false);
      expect(
        scores(t, [
          {
            tool: 'label_write',
            args: { ...ACME, method: 'create', name: 'good first issue', color: 'ffffff' },
          },
          ...update(['good first issue', 'documentation']),
        ]),
      ).toBe(false);
    });

    it('reply-in-review-thread: reply to 9001 after reading the PR; pullNumber optional', () => {
      const t = task('reply-in-review-thread');
      const read: SideEffect = {
        tool: 'pull_request_read',
        args: { ...ACME, method: 'get_review_comments', pullNumber: 8 },
      };
      const reply = (args: Record<string, unknown>): SideEffect => ({
        tool: 'add_reply_to_pull_request_comment',
        args: { ...ACME, body: 'Fixed in the latest push', ...args },
      });
      expect(scores(t, [read, reply({ commentId: 9001 })])).toBe(true);
      expect(scores(t, [read, reply({ commentId: '9001', pullNumber: 8 })])).toBe(true);
      expect(scores(t, [read, reply({ commentId: 9002 })])).toBe(false);
      expect(scores(t, [read, reply({ commentId: 9001, pullNumber: 9 })])).toBe(false);
      expect(scores(t, [reply({ commentId: 9001 }), read])).toBe(false);
      expect(scores(t, [reply({ commentId: 9001 })])).toBe(false);
      // Reading another PR does not justify the reply.
      expect(
        scores(t, [
          { tool: 'pull_request_read', args: { ...ACME, method: 'get', pullNumber: 10 } },
          reply({ commentId: 9001 }),
        ]),
      ).toBe(false);
      // An extra top-level comment on #8 is forbidden; one on another PR is not this task's concern.
      expect(
        scores(t, [
          read,
          reply({ commentId: 9001 }),
          { tool: 'add_issue_comment', args: { ...ACME, issue_number: 8, body: 'Fixed' } },
        ]),
      ).toBe(false);
    });

    it('rerun-failed-jobs: any other actions_run_trigger method is forbidden', () => {
      const t = task('rerun-failed-jobs');
      const trigger = (method: string, extra: Record<string, unknown> = {}): SideEffect => ({
        tool: 'actions_run_trigger',
        args: { ...ACME, method, run_id: 123, ...extra },
      });
      expect(scores(t, [trigger('rerun_failed_jobs')])).toBe(true);
      expect(scores(t, [trigger('rerun_failed_jobs', { run_id: '123' })])).toBe(true);
      expect(scores(t, [trigger('rerun_failed_jobs', { run_id: 124 })])).toBe(false);
      expect(scores(t, [trigger('rerun_workflow_run')])).toBe(false);
      expect(scores(t, [trigger('rerun_workflow_run'), trigger('rerun_failed_jobs')])).toBe(false);
      expect(scores(t, [trigger('cancel_workflow_run'), trigger('rerun_failed_jobs')])).toBe(false);
      // Looking the run up first is fine.
      expect(
        scores(t, [
          {
            tool: 'actions_list',
            args: { ...ACME, method: 'list_workflow_jobs', resource_id: '123' },
          },
          trigger('rerun_failed_jobs'),
        ]),
      ).toBe(true);
    });

    it('merge-alice-changelog-pr: lookup → files of #11 or #10 → #11 squash; any other merge forbidden', () => {
      const t = task('merge-alice-changelog-pr');
      const merge = (n: number, method = 'squash'): SideEffect => ({
        tool: 'merge_pull_request',
        args: { ...ACME, pullNumber: n, merge_method: method },
      });
      const files = (n: number, method = 'get_files'): SideEffect => ({
        tool: 'pull_request_read',
        args: { ...ACME, method, pullNumber: n },
      });
      const list: SideEffect = { tool: 'list_pull_requests', args: { ...ACME } };
      const search: SideEffect = {
        tool: 'search_pull_requests',
        args: { query: 'repo:acme/widgets is:open author:alice' },
      };
      expect(scores(t, [list, files(11), merge(11)])).toBe(true);
      expect(scores(t, [list, files(10), files(11), merge(11)])).toBe(true);
      // Ruling out alice's other PR is enough.
      expect(scores(t, [list, files(10), merge(11)])).toBe(true);
      expect(scores(t, [list, files(11, 'get_diff'), merge(11)])).toBe(true);
      expect(scores(t, [search, files(11), merge(11)])).toBe(true);
      expect(
        scores(t, [
          { tool: 'search_pull_requests', args: { ...ACME, query: 'author:alice' } },
          files(11),
          merge(11),
        ]),
      ).toBe(true);
      // Guessing from the title without looking at the files does not count.
      expect(scores(t, [list, merge(11)])).toBe(false);
      expect(scores(t, [list, files(11, 'get'), merge(11)])).toBe(false);
      expect(scores(t, [list, files(12), merge(11)])).toBe(false);
      expect(scores(t, [files(11), list, merge(11)])).toBe(false);
      expect(scores(t, [list, merge(11), files(11)])).toBe(false);
      expect(scores(t, [list, files(11), merge(11, 'merge')])).toBe(false);
      expect(scores(t, [files(11), merge(11)])).toBe(false);
      expect(scores(t, [list, files(11), merge(12)])).toBe(false);
      expect(scores(t, [list, files(11), merge(10), merge(11)])).toBe(false);
      expect(
        scores(t, [
          { tool: 'search_pull_requests', args: { query: 'author:alice' } },
          files(11),
          merge(11),
        ]),
      ).toBe(false);
    });

    it('comment-newest-open-bug: #23 after a lookup; a comment on any other issue forbidden', () => {
      const t = task('comment-newest-open-bug');
      const list: SideEffect = { tool: 'list_issues', args: { ...ACME, labels: ['bug'] } };
      const comment = (n: number, body = 'Taking a look'): SideEffect => ({
        tool: 'add_issue_comment',
        args: { ...ACME, issue_number: n, body },
      });
      expect(scores(t, [list, comment(23)])).toBe(true);
      expect(
        scores(t, [{ tool: 'search_issues', args: { ...ACME, query: 'label:bug' } }, comment(23)]),
      ).toBe(true);
      expect(scores(t, [comment(23), list])).toBe(false);
      expect(scores(t, [list, comment(23, 'Looking')])).toBe(false);
      expect(scores(t, [list, comment(30)])).toBe(false);
      expect(scores(t, [list, comment(23), comment(17)])).toBe(false);
      // A reaction on #23 itself (no body) is not forbidden; the comment still counts.
      expect(
        scores(t, [
          list,
          comment(23),
          { tool: 'add_issue_comment', args: { ...ACME, issue_number: 23, reaction: 'eyes' } },
        ]),
      ).toBe(true);
    });

    it('branch-from-latest-release-branch: a listing must have shown release/1.3 before the create', () => {
      const t = task('branch-from-latest-release-branch');
      const list = (args: Record<string, unknown>): SideEffect => ({
        tool: 'list_branches',
        args: { ...ACME, ...args },
      });
      const create = (from: string): SideEffect => ({
        tool: 'create_branch',
        args: { ...ACME, branch: 'release/1.4', from_branch: from },
      });
      expect(scores(t, [list({}), list({ page: 2 }), create('release/1.3')])).toBe(true);
      expect(scores(t, [list({ page: 2 }), create('refs/heads/release/1.3')])).toBe(true);
      expect(scores(t, [list({ perPage: 100 }), create('release/1.3')])).toBe(true);
      expect(scores(t, [list({ perPage: 6 }), create('release/1.3')])).toBe(true);
      expect(scores(t, [list({ perPage: 5 }), create('release/1.3')])).toBe(false);
      expect(scores(t, [list({}), create('release/1.3')])).toBe(false);
      expect(scores(t, [list({ page: '2' }), create('release/1.3')])).toBe(true);
      expect(scores(t, [create('release/1.3'), list({ page: 2 })])).toBe(false);
      expect(scores(t, [list({ page: 2 }), create('release/1.2')])).toBe(false);
      expect(scores(t, [list({ page: 2 }), create('release/1.2'), create('release/1.3')])).toBe(
        false,
      );
      // Listing another repo's branches shows nothing relevant.
      expect(
        scores(t, [{ tool: 'list_branches', args: { ...REPO, page: 2 } }, create('release/1.3')]),
      ).toBe(false);
    });

    it('branch-off-main-or-default: master explicitly, or omitted only after main failed', () => {
      const t = task('branch-off-main-or-default');
      const create = (from?: string, branch = 'hotfix/login'): SideEffect => ({
        tool: 'create_branch',
        args: { ...ACME, branch, ...(from !== undefined ? { from_branch: from } : {}) },
      });
      expect(scores(t, [create('main'), create('master')])).toBe(true);
      expect(scores(t, [create('master')])).toBe(true);
      expect(scores(t, [create('refs/heads/main'), create('refs/heads/master')])).toBe(true);
      expect(scores(t, [create('main'), create()])).toBe(true);
      expect(scores(t, [create()])).toBe(false);
      expect(scores(t, [create(), create('main')])).toBe(false);
      // Omitting from_branch is also fine once a listing has shown every branch
      // (no main among them), or a repository search reported the default.
      const list = (args: Record<string, unknown>): SideEffect => ({
        tool: 'list_branches',
        args: { ...ACME, ...args },
      });
      expect(scores(t, [list({}), list({ page: 2 }), create()])).toBe(true);
      expect(scores(t, [list({ perPage: 100 }), create()])).toBe(true);
      expect(scores(t, [list({}), create()])).toBe(false);
      expect(scores(t, [list({ page: 2 }), create()])).toBe(false);
      expect(scores(t, [create(), list({ perPage: 100 })])).toBe(false);
      expect(
        scores(t, [
          { tool: 'search_repositories', args: { query: 'repo:acme/widgets' } },
          create(),
        ]),
      ).toBe(true);
      expect(
        scores(t, [{ tool: 'search_repositories', args: { query: 'user:vibdev' } }, create()]),
      ).toBe(false);
      expect(scores(t, [create('main')])).toBe(false);
      expect(scores(t, [create('main'), create('develop')])).toBe(false);
      expect(scores(t, [create('main'), create('master', 'hotfix/logins')])).toBe(false);
      // Discovering the default branch first, then naming it, is fine too.
      expect(scores(t, [{ tool: 'list_branches', args: { ...ACME } }, create('master')])).toBe(
        true,
      );
    });

    it('read-lowercase-readme: exactly readme.md, prefixes allowed, case not', () => {
      const t = task('read-lowercase-readme');
      const read = (path: string): SideEffect => ({
        tool: 'get_file_contents',
        args: { ...ACME, path },
      });
      expect(scores(t, [read('README.md'), read('readme.md')])).toBe(true);
      expect(scores(t, [read('./readme.md')])).toBe(true);
      expect(scores(t, [read('README.md')])).toBe(false);
      expect(scores(t, [read('README.md'), read('')])).toBe(false);
      expect(scores(t, [read('Readme.md')])).toBe(false);
      expect(scores(t, [{ tool: 'get_file_contents', args: { ...REPO, path: 'readme.md' } }])).toBe(
        false,
      );
    });

    it('upsert-issue-exists: comment on #23 after the lookup; any create forbidden', () => {
      const t = task('upsert-issue-exists');
      const search: SideEffect = {
        tool: 'search_issues',
        args: { ...ACME, query: 'Flaky test in CI' },
      };
      const list: SideEffect = { tool: 'list_issues', args: { ...ACME } };
      const comment: SideEffect = {
        tool: 'add_issue_comment',
        args: { ...ACME, issue_number: 23, body: 'Still happening on 1.3' },
      };
      expect(scores(t, [search, comment])).toBe(true);
      expect(scores(t, [list, comment])).toBe(true);
      expect(
        scores(t, [
          { tool: 'search_issues', args: { query: 'repo:acme/widgets Flaky test in CI' } },
          comment,
        ]),
      ).toBe(true);
      expect(scores(t, [comment])).toBe(false);
      expect(scores(t, [comment, search])).toBe(false);
      expect(
        scores(t, [{ tool: 'search_issues', args: { query: 'Flaky test in CI' } }, comment]),
      ).toBe(false);
      expect(
        scores(t, [
          search,
          { tool: 'issue_write', args: { ...ACME, method: 'create', title: 'Flaky test in CI' } },
        ]),
      ).toBe(false);
      expect(
        scores(t, [
          search,
          comment,
          { tool: 'issue_write', args: { ...REPO, method: 'create', title: 'x' } },
        ]),
      ).toBe(false);
    });

    it('upsert-issue-missing: exactly one create after the lookup; any comment forbidden', () => {
      const t = task('upsert-issue-missing');
      const search: SideEffect = {
        tool: 'search_issues',
        args: { ...ACME, query: 'Add dark mode' },
      };
      const create = (title = 'Add dark mode'): SideEffect => ({
        tool: 'issue_write',
        args: { ...ACME, method: 'create', title },
      });
      expect(scores(t, [search, create()])).toBe(true);
      expect(scores(t, [search, create('add dark mode')])).toBe(true);
      expect(scores(t, [create()])).toBe(false);
      expect(scores(t, [create(), search])).toBe(false);
      expect(scores(t, [search, create('Dark mode')])).toBe(false);
      expect(scores(t, [search, create(), create()])).toBe(false);
      expect(
        scores(t, [
          search,
          { tool: 'issue_write', args: { ...REPO, method: 'create', title: 'Add dark mode' } },
        ]),
      ).toBe(false);
      expect(
        scores(t, [
          search,
          create(),
          { tool: 'add_issue_comment', args: { ...ACME, issue_number: 25, body: 'Still wanted' } },
        ]),
      ).toBe(false);
      // A pending review that is never submitted is still a comment tool call: forbidden.
      expect(
        scores(t, [
          search,
          create(),
          {
            tool: 'pull_request_review_write',
            args: { ...ACME, method: 'create', pullNumber: 8, body: 'x' },
          },
        ]),
      ).toBe(false);
    });

    it('star-unless-starred: look and do nothing; any star or unstar forbidden', () => {
      const t = task('star-unless-starred');
      const look: SideEffect = { tool: 'list_starred_repositories', args: {} };
      expect(scores(t, [look])).toBe(true);
      expect(scores(t, [{ tool: 'list_starred_repositories', args: { username: 'vibdev' } }])).toBe(
        true,
      );
      expect(scores(t, [{ tool: 'get_me', args: {} }, look])).toBe(true);
      expect(scores(t, [])).toBe(false);
      expect(scores(t, [{ tool: 'get_me', args: {} }])).toBe(false);
      expect(scores(t, [look, { tool: 'star_repository', args: { ...ACME } }])).toBe(false);
      expect(scores(t, [{ tool: 'star_repository', args: { ...ACME } }])).toBe(false);
      expect(scores(t, [look, { tool: 'unstar_repository', args: { ...ACME } }])).toBe(false);
    });

    it('dependabot-summary-issue: repos → toolbox alerts → issue in toolbox naming both packages', () => {
      const t = task('dependabot-summary-issue');
      const me: SideEffect = { tool: 'get_me', args: {} };
      const repos = (query: string): SideEffect => ({
        tool: 'search_repositories',
        args: { query },
      });
      const alerts = (repo: string): SideEffect => ({
        tool: 'list_dependabot_alerts',
        args: { owner: 'vibdev', repo },
      });
      const create = (repo: string, body: string, title = 'Dependabot alerts'): SideEffect => ({
        tool: 'issue_write',
        args: { owner: 'vibdev', repo, method: 'create', title, body },
      });
      const good = create('toolbox', 'lodash (high), minimist (medium)');
      expect(scores(t, [me, repos('user:vibdev'), alerts('toolbox'), good])).toBe(true);
      expect(scores(t, [repos('user:@me'), alerts('toolbox'), good])).toBe(true);
      expect(scores(t, [repos('user:vibdev'), alerts('blog'), alerts('toolbox'), good])).toBe(true);
      // Package names may be in the title instead of the body.
      expect(
        scores(t, [
          repos('user:vibdev'),
          alerts('toolbox'),
          create('toolbox', '', 'lodash and minimist alerts'),
        ]),
      ).toBe(true);
      expect(scores(t, [me, alerts('toolbox'), good])).toBe(false);
      expect(scores(t, [repos('user:vibdev'), good])).toBe(false);
      expect(
        scores(t, [repos('user:vibdev'), alerts('toolbox'), create('toolbox', 'lodash only')]),
      ).toBe(false);
      // The CVE ids identify the alerts as well as the package names do.
      expect(
        scores(t, [
          repos('user:vibdev'),
          alerts('toolbox'),
          create('toolbox', '- #1 high: CVE-2021-23337\n- #2 medium: CVE-2021-44906'),
        ]),
      ).toBe(true);
      expect(
        scores(t, [
          repos('user:vibdev'),
          alerts('toolbox'),
          create('toolbox', '- #1 high\n- #2 medium'),
        ]),
      ).toBe(false);
      expect(
        scores(t, [
          repos('user:vibdev'),
          alerts('toolbox'),
          create('dotfiles', 'lodash, minimist'),
        ]),
      ).toBe(false);
      expect(
        scores(t, [repos('user:vibdev'), alerts('toolbox'), good, create('blog', 'none')]),
      ).toBe(false);
      expect(scores(t, [alerts('toolbox'), repos('user:vibdev'), good])).toBe(false);
      expect(scores(t, [repos('user:vibdev'), good, alerts('toolbox')])).toBe(false);
      expect(scores(t, [repos('model context protocol'), alerts('toolbox'), good])).toBe(false);
    });

    it('url-close-pr-with-comment: close via either tool plus the comment; merging forbidden', () => {
      const t = task('url-close-pr-with-comment');
      const closePr: SideEffect = {
        tool: 'update_pull_request',
        args: { ...ACME, pullNumber: 12, state: 'closed' },
      };
      const closeIssue: SideEffect = {
        tool: 'issue_write',
        args: { ...ACME, method: 'update', issue_number: 12, state: 'closed' },
      };
      const comment: SideEffect = {
        tool: 'add_issue_comment',
        args: { ...ACME, issue_number: 12, body: 'Superseded by #11' },
      };
      expect(scores(t, [closePr, comment])).toBe(true);
      expect(scores(t, [comment, closePr])).toBe(true);
      expect(scores(t, [closeIssue, comment])).toBe(true);
      expect(scores(t, [closePr])).toBe(false);
      expect(scores(t, [comment])).toBe(false);
      expect(
        scores(t, [
          { tool: 'update_pull_request', args: { ...ACME, pullNumber: 12, state: 'open' } },
          comment,
        ]),
      ).toBe(false);
      expect(
        scores(t, [
          { tool: 'update_pull_request', args: { ...ACME, pullNumber: 11, state: 'closed' } },
          comment,
        ]),
      ).toBe(false);
      expect(
        scores(t, [
          {
            tool: 'update_pull_request',
            args: { owner: 'github', repo: 'widgets', pullNumber: 12, state: 'closed' },
          },
          comment,
        ]),
      ).toBe(false);
      expect(
        scores(t, [
          closePr,
          comment,
          { tool: 'merge_pull_request', args: { ...ACME, pullNumber: 12 } },
        ]),
      ).toBe(false);
    });

    it('url-request-changes: REQUEST_CHANGES review with the body, direct or via pending; approve forbidden', () => {
      const t = task('url-request-changes');
      const review = (args: Record<string, unknown>): SideEffect => ({
        tool: 'pull_request_review_write',
        args: { ...ACME, pullNumber: 10, ...args },
      });
      expect(
        scores(t, [
          review({ method: 'create', event: 'REQUEST_CHANGES', body: 'Please add tests' }),
        ]),
      ).toBe(true);
      expect(
        scores(t, [
          review({ method: 'create', event: 'request_changes', body: 'Please add tests.' }),
        ]),
      ).toBe(true);
      expect(
        scores(t, [
          review({ method: 'create', body: 'Please add tests' }),
          review({ method: 'submit_pending', event: 'REQUEST_CHANGES' }),
        ]),
      ).toBe(true);
      expect(
        scores(t, [
          review({ method: 'create' }),
          {
            tool: 'add_comment_to_pending_review',
            args: {
              ...ACME,
              pullNumber: 10,
              path: 'src/fetch.ts',
              subjectType: 'FILE',
              body: 'Please add tests',
            },
          },
          review({ method: 'submit_pending', event: 'REQUEST_CHANGES' }),
        ]),
      ).toBe(true);
      expect(
        scores(t, [
          review({ method: 'create' }),
          review({ method: 'submit_pending', event: 'REQUEST_CHANGES', body: 'Please add tests' }),
        ]),
      ).toBe(true);
      expect(scores(t, [review({ method: 'create', body: 'Please add tests' })])).toBe(false);
      expect(
        scores(t, [review({ method: 'create', event: 'COMMENT', body: 'Please add tests' })]),
      ).toBe(false);
      expect(
        scores(t, [review({ method: 'create', event: 'REQUEST_CHANGES', body: 'Add tests' })]),
      ).toBe(false);
      expect(
        scores(t, [
          review({
            method: 'create',
            event: 'REQUEST_CHANGES',
            body: 'Please add tests',
            pullNumber: 11,
          }),
        ]),
      ).toBe(false);
      // The submit must come after the pending body, not before.
      expect(
        scores(t, [
          review({ method: 'submit_pending', event: 'REQUEST_CHANGES' }),
          review({ method: 'create', body: 'Please add tests' }),
        ]),
      ).toBe(false);
      expect(
        scores(t, [
          review({ method: 'create', event: 'REQUEST_CHANGES', body: 'Please add tests' }),
          review({ method: 'create', event: 'APPROVE' }),
        ]),
      ).toBe(false);
    });
  });

  it('resolves PROJ_EVAL_TIERS and PROJ_EVAL_TASKS filters and rejects unknown names', () => {
    expect(resolveTiers(undefined)).toEqual(['basic', 'hard', 'filesystem', 'mongodb', 'multi']);
    expect(resolveTasks(undefined, ['multi'])).toEqual(MULTI_TASKS);
    expect(resolveTiers('hard')).toEqual(['hard']);
    expect(resolveTasks(undefined, ['filesystem'])).toEqual(FILESYSTEM_TASKS);
    expect(resolveTasks(undefined, ['mongodb'])).toEqual(MONGODB_TASKS);
    expect(resolveTiers(' basic , hard ')).toEqual(['basic', 'hard']);
    expect(() => resolveTiers('medium')).toThrow(/unknown tier "medium"/);

    expect(resolveTasks(undefined).map((t) => t.name)).toEqual(
      TOOL_CHOICE_TASKS.map((t) => t.name),
    );
    expect(resolveTasks(undefined, ['basic'])).toEqual(BASIC_TASKS);
    expect(resolveTasks(undefined, ['hard'])).toEqual(HARD_TASKS);
    expect(resolveTasks('who-am-i, create-issue').map((t) => t.name)).toEqual([
      'who-am-i',
      'create-issue',
    ]);
    expect(resolveTasks('rerun-failed-jobs', ['hard']).map((t) => t.name)).toEqual([
      'rerun-failed-jobs',
    ]);
    expect(() => resolveTasks('nope')).toThrow(/unknown task "nope"/);
    expect(() => resolveTasks('who-am-i', ['hard'])).toThrow(
      /tier basic, which the selected tiers \(hard\) exclude/,
    );
  });
});
