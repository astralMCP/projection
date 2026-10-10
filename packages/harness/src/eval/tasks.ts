/**
 * Tool-choice tasks: what to do, never how. Each prompt is phrased for a
 * model that has never seen the GitHub catalog, and each expectation is a
 * predicate over the upstream calls the fake actually recorded — so the
 * same task scores identically whether the model reached the tool directly
 * or through Projection's `call_tool` / `execute_machine`.
 *
 * Matching is lenient where the API allows synonyms (`issue_number` vs
 * `pullNumber`, numbers as strings, owner/repo case, a defaulted `state`,
 * `refs/heads/` and `./` prefixes) and strict on the values the prompt
 * states (titles, bodies, branch names, merge method). Comment predicates
 * count only calls that make the comment visible: a pending review is not a
 * comment until it is submitted.
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

/** Every tool that can put a comment on a PR or issue (the tool-correct step group). */
const COMMENT_TOOLS = [
  'add_issue_comment',
  'pull_request_review_write',
  'add_comment_to_pending_review',
  'add_reply_to_pull_request_comment',
];

/** The call addresses PR/issue `number` in the task repo. */
function targets(args: Args, number: number): boolean {
  return (
    inRepo(args) && sameNumber(firstOf(args, ['issue_number', 'pullNumber', 'pull_number']), number)
  );
}

/**
 * Index of the first `pull_request_review_write` with method `submit_pending`
 * for PR `number` after `from`, or -1. Submitting is what turns a pending
 * review (and the comments attached to it) into something anyone can see.
 */
function submittedAfter(calls: SideEffect[], number: number, from: number): number {
  return calls.findIndex(
    (call, i) =>
      i > from &&
      call.tool === 'pull_request_review_write' &&
      call.args['method'] === 'submit_pending' &&
      targets(call.args, number),
  );
}

/**
 * Index of the call that makes a comment containing `body` visible on
 * PR/issue `number`, or -1. `add_issue_comment` and
 * `add_reply_to_pull_request_comment` post immediately. A
 * `pull_request_review_write` posts immediately only when it carries an
 * `event` (COMMENT / APPROVE / REQUEST_CHANGES); without one, `create` only
 * opens a PENDING review, which — like `add_comment_to_pending_review` —
 * shows nothing until a later `submit_pending` for the same PR, so the
 * comment is attributed to that submit's index (ordering checks compare
 * against the moment the comment became visible).
 */
function commented(calls: SideEffect[], number: number, body: string): number {
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i] as SideEffect;
    if (!COMMENT_TOOLS.includes(call.tool)) continue;
    if (!targets(call.args, number) || !containsText(call.args['body'], body)) continue;
    switch (call.tool) {
      case 'add_issue_comment':
      case 'add_reply_to_pull_request_comment':
        return i;
      case 'pull_request_review_write': {
        if (typeof call.args['event'] === 'string' && call.args['event'] !== '') return i;
        const submit = submittedAfter(calls, number, i);
        if (submit >= 0) return submit;
        break;
      }
      case 'add_comment_to_pending_review': {
        const submit = submittedAfter(calls, number, i);
        if (submit >= 0) return submit;
        break;
      }
      default:
        break;
    }
  }
  return -1;
}

/**
 * A lookup that would list the open PRs of the task repo: `list_pull_requests`
 * with `state` open or absent (GitHub defaults to open; `closed` / `all` are
 * wrong), or `search_pull_requests` whose query names the repo and asks for
 * open ones.
 */
function listsOpenPrs(call: SideEffect): boolean {
  const args = call.args;
  if (call.tool === 'list_pull_requests') {
    return inRepo(args) && (args['state'] === undefined || sameText(args['state'], 'open'));
  }
  if (call.tool === 'search_pull_requests') {
    return (
      containsText(args['query'], `${OWNER}/${REPO}`) &&
      (containsText(args['query'], 'is:open') || containsText(args['query'], 'state:open'))
    );
  }
  return false;
}

/** Git refs may be fully qualified; `refs/heads/main` names the main branch. */
function branchName(value: unknown): string | undefined {
  return str(value)
    ?.trim()
    .replace(/^refs\/heads\//, '');
}

/** Repo-relative paths may carry a `./` or `/` prefix. */
function repoPath(value: unknown): string | undefined {
  return str(value)
    ?.trim()
    .replace(/^(\.\/|\/)+/, '');
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
    steps: [['list_pull_requests', 'search_pull_requests']],
    expect: (calls) => calls.some(listsOpenPrs),
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
        (args) => inRepo(args) && sameText(repoPath(args['path']), 'README.md'),
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
          sameText(branchName(args['ref']), 'main'),
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
    // from_branch is strict: the prompt states "from main", so omitting it
    // (which lets the server pick the default branch) is not the stated task.
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
      const listed = calls.findIndex(listsOpenPrs);
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
