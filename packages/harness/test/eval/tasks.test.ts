/**
 * Task predicates: each fires on its canonical upstream call sequence and
 * stays quiet on nothing; lenient on synonyms, strict on stated values.
 */

import { describe, expect, it } from 'vitest';
import { resolveTasks, TOOL_CHOICE_TASKS, type SideEffect } from '../../src/index.js';

const REPO = { owner: 'modelcontextprotocol', repo: 'servers' };

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
};

describe('tool-choice tasks', () => {
  it('covers every task with a golden sequence, and names are unique', () => {
    const names = TOOL_CHOICE_TASKS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(GOLDEN).toSorted()).toEqual(names.toSorted());
  });

  for (const task of TOOL_CHOICE_TASKS) {
    it(`${task.name}: fires on the golden calls and not on nothing`, () => {
      const golden = GOLDEN[task.name] as SideEffect[];
      expect(task.expect([])).toBe(false);
      expect(task.expect(golden)).toBe(true);
      // Every step's tool group is hit by the golden sequence.
      for (const group of task.steps) {
        expect(golden.some((call) => group.includes(call.tool))).toBe(true);
      }
      // The right tool with wrong arguments (where arguments matter) is not success.
      const stripped = golden.map((call) => ({ tool: call.tool, args: {} }));
      if (task.steps.flat().every((name) => !['get_me', 'list_notifications'].includes(name))) {
        expect(task.expect(stripped)).toBe(false);
      }
    });
  }

  it('list-open-prs: a defaulted state or an open-PR search counts, closed/all do not', () => {
    const task = TOOL_CHOICE_TASKS.find((t) => t.name === 'list-open-prs');
    const list = (args: Record<string, unknown>): SideEffect[] => [
      { tool: 'list_pull_requests', args },
    ];
    const search = (query: string): SideEffect[] => [
      { tool: 'search_pull_requests', args: { query } },
    ];
    expect(task?.expect(list({ ...REPO }))).toBe(true);
    expect(task?.expect(list({ ...REPO, state: 'OPEN' }))).toBe(true);
    expect(task?.expect(list({ ...REPO, state: 'closed' }))).toBe(false);
    expect(task?.expect(list({ ...REPO, state: 'all' }))).toBe(false);
    expect(task?.expect(list({ owner: 'someone', repo: 'else' }))).toBe(false);
    expect(task?.expect(search('repo:modelcontextprotocol/servers is:open'))).toBe(true);
    expect(task?.expect(search('is:pr state:open repo:ModelContextProtocol/Servers'))).toBe(true);
    expect(task?.expect(search('repo:modelcontextprotocol/servers'))).toBe(false);
    expect(task?.expect(search('is:open'))).toBe(false);
    expect(task?.expect(search('repo:modelcontextprotocol/servers is:closed'))).toBe(false);

    // The multi-step lookup uses the same rule, and the merge must follow it.
    const multi = TOOL_CHOICE_TASKS.find((t) => t.name === 'list-prs-then-merge');
    const merge: SideEffect = {
      tool: 'merge_pull_request',
      args: { ...REPO, pullNumber: 7, merge_method: 'squash' },
    };
    expect(
      multi?.expect([...search('repo:modelcontextprotocol/servers is:open Fix typo'), merge]),
    ).toBe(true);
    expect(multi?.expect([...list({ ...REPO }), merge])).toBe(true);
    expect(multi?.expect([...list({ ...REPO, state: 'closed' }), merge])).toBe(false);
    expect(multi?.expect([merge, ...list({ ...REPO })])).toBe(false);
  });

  it('comments count only once they are visible: pending reviews need a submit', () => {
    const comment = TOOL_CHOICE_TASKS.find((t) => t.name === 'comment-on-pr');
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
    // A pending review alone, or a pending-review comment alone, posts nothing.
    expect(comment?.expect([pending])).toBe(false);
    expect(comment?.expect([lineComment])).toBe(false);
    expect(comment?.expect([pending, lineComment])).toBe(false);
    expect(comment?.expect([pending, submitOtherPr])).toBe(false);
    // Submitting the pending review makes it visible.
    expect(comment?.expect([pending, submit])).toBe(true);
    expect(comment?.expect([pending, lineComment, submit])).toBe(true);
    // A submit before the pending create does not count for it.
    expect(comment?.expect([submit, pending])).toBe(false);
    // A review created with an event posts immediately; so does the body on the submit.
    expect(
      comment?.expect([
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
      comment?.expect([
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
      comment?.expect([
        {
          tool: 'add_reply_to_pull_request_comment',
          args: { ...REPO, pullNumber: 12, commentId: 1, body: 'Looks good to me' },
        },
      ]),
    ).toBe(true);

    // Ordering compares against the moment the comment became visible.
    const multi = TOOL_CHOICE_TASKS.find((t) => t.name === 'find-issue-then-comment');
    const lookup: SideEffect = { tool: 'list_issues', args: { ...REPO } };
    const pending42: SideEffect = {
      tool: 'pull_request_review_write',
      args: { ...REPO, method: 'create', pullNumber: 42, body: 'investigating' },
    };
    const submit42: SideEffect = {
      tool: 'pull_request_review_write',
      args: { ...REPO, method: 'submit_pending', pullNumber: 42, event: 'COMMENT' },
    };
    expect(multi?.expect([lookup, pending42, submit42])).toBe(true);
    expect(multi?.expect([lookup, pending42])).toBe(false);
    expect(multi?.expect([pending42, lookup, submit42])).toBe(true);
    expect(multi?.expect([pending42, submit42, lookup])).toBe(false);
  });

  it('normalises ref and path prefixes, and keeps from_branch strict', () => {
    const workflow = TOOL_CHOICE_TASKS.find((t) => t.name === 'trigger-workflow');
    const run = (ref: string): SideEffect[] => [
      {
        tool: 'actions_run_trigger',
        args: { ...REPO, method: 'run_workflow', workflow_id: 'ci.yml', ref },
      },
    ];
    expect(workflow?.expect(run('refs/heads/main'))).toBe(true);
    expect(workflow?.expect(run('main'))).toBe(true);
    expect(workflow?.expect(run('refs/heads/develop'))).toBe(false);
    expect(workflow?.expect(run('refs/tags/main'))).toBe(false);

    const readme = TOOL_CHOICE_TASKS.find((t) => t.name === 'read-readme');
    const read = (path: string): SideEffect[] => [
      { tool: 'get_file_contents', args: { ...REPO, path } },
    ];
    expect(readme?.expect(read('README.md'))).toBe(true);
    expect(readme?.expect(read('./README.md'))).toBe(true);
    expect(readme?.expect(read('/README.md'))).toBe(true);
    expect(readme?.expect(read('readme.md'))).toBe(true);
    expect(readme?.expect(read('docs/README.md'))).toBe(false);
    expect(readme?.expect(read('README'))).toBe(false);

    const branch = TOOL_CHOICE_TASKS.find((t) => t.name === 'create-branch');
    expect(
      branch?.expect([{ tool: 'create_branch', args: { ...REPO, branch: 'feature/x' } }]),
    ).toBe(false);
    expect(
      branch?.expect([
        { tool: 'create_branch', args: { ...REPO, branch: 'feature/x', from_branch: 'develop' } },
      ]),
    ).toBe(false);
  });

  it('is lenient on synonyms and types, strict on stated values', () => {
    const merge = TOOL_CHOICE_TASKS.find((t) => t.name === 'merge-pr-squash');
    expect(
      merge?.expect([
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
      merge?.expect([
        { tool: 'merge_pull_request', args: { ...REPO, pullNumber: 7, merge_method: 'merge' } },
      ]),
    ).toBe(false);

    const comment = TOOL_CHOICE_TASKS.find((t) => t.name === 'comment-on-pr');
    expect(
      comment?.expect([
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
      comment?.expect([
        {
          tool: 'add_issue_comment',
          args: { ...REPO, issue_number: 13, body: 'Looks good to me' },
        },
      ]),
    ).toBe(false);

    const multi = TOOL_CHOICE_TASKS.find((t) => t.name === 'find-issue-then-comment');
    // The comment must come after the lookup.
    expect(
      multi?.expect([
        { tool: 'add_issue_comment', args: { ...REPO, issue_number: 42, body: 'investigating' } },
        { tool: 'list_issues', args: { ...REPO } },
      ]),
    ).toBe(false);
  });

  it('resolves PROJ_EVAL_TASKS filters and rejects unknown names', () => {
    expect(resolveTasks(undefined).map((t) => t.name)).toEqual(
      TOOL_CHOICE_TASKS.map((t) => t.name),
    );
    expect(resolveTasks('who-am-i, create-issue').map((t) => t.name)).toEqual([
      'who-am-i',
      'create-issue',
    ]);
    expect(() => resolveTasks('nope')).toThrow(/unknown task "nope"/);
  });
});
