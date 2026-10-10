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
