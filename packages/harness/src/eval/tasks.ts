/**
 * Tool-choice tasks: what to do, never how. Each prompt is phrased for a
 * model that has never seen the GitHub catalog, and each expectation is a
 * predicate over the upstream calls the fake actually recorded — so the
 * same task scores identically whether the model reached the tool directly
 * or through Projection's `call_tool` / `execute_machine`.
 *
 * Matching is lenient where the API allows synonyms (`issue_number` vs
 * `pullNumber`, numbers as strings, owner/repo case) and strict on the
 * values the prompt states (titles, bodies, branch names, merge method).
 */

import type { SideEffect } from '../types.js';

export type TaskKind = 'single' | 'multi';

export interface EvalTask {
  /** Stable identifier (PROJ_EVAL_TASKS filter, report rows). */
  name: string;
  kind: TaskKind;
  /** The user's request. */
  prompt: string;
  /**
   * Upstream tools that solve each step; "tool-correct" means every step
   * saw a call to one of its tools, regardless of arguments.
   */
  steps: string[][];
  /** Full success: the right tool(s) with the right arguments. */
  expect(calls: SideEffect[]): boolean;
}

const OWNER = 'modelcontextprotocol';
const REPO = 'servers';

type Args = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
}

function sameText(value: unknown, expected: string): boolean {
  return str(value)?.trim().toLowerCase() === expected.toLowerCase();
}

function containsText(value: unknown, expected: string): boolean {
  return (str(value)?.toLowerCase() ?? '').includes(expected.toLowerCase());
}

function sameNumber(value: unknown, expected: number): boolean {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return n === expected;
}

/** owner/repo as the prompt states them (case-insensitive). */
function inRepo(args: Args, owner = OWNER, repo = REPO): boolean {
  return sameText(args['owner'], owner) && sameText(args['repo'], repo);
}

/** The first of these keys that is present. */
function firstOf(args: Args, keys: string[]): unknown {
  for (const key of keys) if (args[key] !== undefined) return args[key];
  return undefined;
}

function find(
  calls: SideEffect[],
  tool: string | string[],
  where: (args: Args) => boolean,
): number {
  const names = Array.isArray(tool) ? tool : [tool];
  return calls.findIndex((call) => names.includes(call.tool) && where(call.args));
}

function has(
  calls: SideEffect[],
  tool: string | string[],
  where: (args: Args) => boolean,
): boolean {
  return find(calls, tool, where) >= 0;
}

/** A comment on PR/issue `number` whose body contains `body`, by any commenting tool. */
const COMMENT_TOOLS = [
  'add_issue_comment',
  'pull_request_review_write',
  'add_comment_to_pending_review',
  'add_reply_to_pull_request_comment',
];
function commented(calls: SideEffect[], number: number, body: string): number {
  return find(
    calls,
    COMMENT_TOOLS,
    (args) =>
      inRepo(args) &&
      sameNumber(firstOf(args, ['issue_number', 'pullNumber', 'pull_number']), number) &&
      containsText(args['body'], body),
  );
}

const ISSUE_TITLE = 'Crash on startup';
const ISSUE_BODY = 'The server crashes on startup when the config file is missing.';

export const TOOL_CHOICE_TASKS: readonly EvalTask[] = [
  {
    name: 'create-issue',
    kind: 'single',
    prompt: `Open a new issue in the GitHub repository ${OWNER}/${REPO} titled "${ISSUE_TITLE}" with the body "${ISSUE_BODY}"`,
    steps: [['issue_write']],
    expect: (calls) =>
      has(
        calls,
        'issue_write',
        (args) =>
          args['method'] === 'create' &&
          inRepo(args) &&
          sameText(args['title'], ISSUE_TITLE) &&
          containsText(args['body'], 'config file is missing'),
      ),
  },
  {
    name: 'list-open-prs',
    kind: 'single',
    prompt: `List the open pull requests in ${OWNER}/${REPO}.`,
    steps: [['list_pull_requests']],
    expect: (calls) =>
      has(calls, 'list_pull_requests', (args) => inRepo(args) && sameText(args['state'], 'open')),
  },
  {
    name: 'read-readme',
    kind: 'single',
    prompt: `Show me the contents of README.md in ${OWNER}/${REPO}.`,
    steps: [['get_file_contents']],
    expect: (calls) =>
      has(
        calls,
        'get_file_contents',
        (args) =>
          inRepo(args) &&
          (sameText(args['path'], 'README.md') || sameText(args['path'], '/README.md')),
      ),
  },
  {
    name: 'who-am-i',
    kind: 'single',
    prompt: 'What is my GitHub username?',
    steps: [['get_me']],
    expect: (calls) => has(calls, 'get_me', () => true),
  },
  {
    name: 'search-repos',
    kind: 'single',
    prompt: 'Search GitHub for repositories matching "model context protocol".',
    steps: [['search_repositories']],
    expect: (calls) =>
      has(calls, 'search_repositories', (args) =>
        containsText(args['query'], 'model context protocol'),
      ),
  },
  {
    name: 'trigger-workflow',
    kind: 'single',
    prompt: `Run the ci.yml workflow on the main branch of ${OWNER}/${REPO}.`,
    steps: [['actions_run_trigger']],
    expect: (calls) =>
      has(
        calls,
        'actions_run_trigger',
        (args) =>
          args['method'] === 'run_workflow' &&
          inRepo(args) &&
          sameText(args['workflow_id'], 'ci.yml') &&
          sameText(args['ref'], 'main'),
      ),
  },
  {
    name: 'comment-on-pr',
    kind: 'single',
    prompt: `Leave the comment "Looks good to me" on pull request #12 in ${OWNER}/${REPO}.`,
    steps: [COMMENT_TOOLS],
    expect: (calls) => commented(calls, 12, 'Looks good to me') >= 0,
  },
  {
    name: 'star-repo',
    kind: 'single',
    prompt: `Star the repository ${OWNER}/${REPO}.`,
    steps: [['star_repository']],
    expect: (calls) => has(calls, 'star_repository', (args) => inRepo(args)),
  },
  {
    name: 'list-notifications',
    kind: 'single',
    prompt: 'Show me my GitHub notifications.',
    steps: [['list_notifications']],
    expect: (calls) => has(calls, 'list_notifications', () => true),
  },
  {
    name: 'merge-pr-squash',
    kind: 'single',
    prompt: `Squash-merge pull request #7 in ${OWNER}/${REPO}.`,
    steps: [['merge_pull_request']],
    expect: (calls) =>
      has(
        calls,
        'merge_pull_request',
        (args) =>
          inRepo(args) &&
          sameNumber(firstOf(args, ['pullNumber', 'pull_number']), 7) &&
          sameText(args['merge_method'], 'squash'),
      ),
  },
  {
    name: 'create-branch',
    kind: 'single',
    prompt: `In ${OWNER}/${REPO}, create a branch named feature/x from main.`,
    steps: [['create_branch']],
    expect: (calls) =>
      has(
        calls,
        'create_branch',
        (args) =>
          inRepo(args) &&
          sameText(args['branch'], 'feature/x') &&
          sameText(args['from_branch'], 'main'),
      ),
  },
  {
    name: 'fork-repo',
    kind: 'single',
    prompt: `Fork ${OWNER}/${REPO} to my account.`,
    steps: [['fork_repository']],
    expect: (calls) => has(calls, 'fork_repository', (args) => inRepo(args)),
  },
  {
    name: 'find-issue-then-comment',
    kind: 'multi',
    prompt: `In ${OWNER}/${REPO}, find the issue about a crash on startup and comment "investigating" on it.`,
    steps: [['search_issues', 'list_issues'], COMMENT_TOOLS],
    expect: (calls) => {
      const found = find(calls, ['search_issues', 'list_issues'], () => true);
      const comment = commented(calls, 42, 'investigating');
      return found >= 0 && comment > found;
    },
  },
  {
    name: 'list-prs-then-merge',
    kind: 'multi',
    prompt: `In ${OWNER}/${REPO}, squash-merge the open pull request titled "Fix typo".`,
    steps: [['list_pull_requests', 'search_pull_requests'], ['merge_pull_request']],
    expect: (calls) => {
      const listed = find(calls, ['list_pull_requests', 'search_pull_requests'], () => true);
      const merged = find(
        calls,
        'merge_pull_request',
        (args) =>
          inRepo(args) &&
          sameNumber(firstOf(args, ['pullNumber', 'pull_number']), 7) &&
          sameText(args['merge_method'], 'squash'),
      );
      return listed >= 0 && merged > listed;
    },
  },
  {
    name: 'me-then-star-dotfiles',
    kind: 'multi',
    prompt: 'Star the "dotfiles" repository on my own GitHub account.',
    steps: [['get_me'], ['star_repository']],
    expect: (calls) => {
      const me = find(calls, 'get_me', () => true);
      const starred = find(calls, 'star_repository', (args) => inRepo(args, 'vibdev', 'dotfiles'));
      return me >= 0 && starred > me;
    },
  },
];

/** Resolve a comma list of task names (PROJ_EVAL_TASKS); unknown names throw. */
export function resolveTasks(spec: string | undefined): EvalTask[] {
  if (spec === undefined || spec.trim() === '') return [...TOOL_CHOICE_TASKS];
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((name) => {
      const task = TOOL_CHOICE_TASKS.find((t) => t.name === name);
      if (task === undefined) {
        throw new Error(
          `unknown task "${name}"; known: ${TOOL_CHOICE_TASKS.map((t) => t.name).join(', ')}`,
        );
      }
      return task;
    });
}
