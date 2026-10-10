/**
 * Tool-choice tasks: what to do, never how. Each prompt is phrased for a
 * model that has never seen the GitHub catalog, and each expectation is a
 * predicate over the upstream calls the fake actually recorded — so the
 * same task scores identically whether the model reached the tool directly
 * or through Projection's `call_tool` / `execute_machine`.
 *
 * Two tiers. The **basic** tier (15 tasks, `modelcontextprotocol/servers`)
 * is one or two obvious calls each; current models saturate it. The **hard**
 * tier (15 tasks, `acme/widgets` and the user's own repositories) is built
 * to discriminate: several write tools whose `method` enum the prompt's
 * verb must pick; candidate lists the prompt's criterion narrows to one;
 * a paged listing with the target on page 2; first attempts the fake rejects
 * until the arguments are corrected; conditional writes that must NOT happen
 * when a lookup shows them unnecessary; multi-step chains; and URLs to parse.
 * Hard tasks may also `forbid` calls (a wrong write is a failure even when
 * the right one also happened) and assert ordering (a write must follow the
 * lookup that justified it).
 *
 * Matching is lenient where the API allows synonyms (`issue_number` vs
 * `pullNumber`, numbers as strings, owner/repo case, a defaulted `state`,
 * `refs/heads/` and `./` prefixes) and strict on the values the prompt
 * states (titles, bodies, branch names, merge method). Comment predicates
 * count only calls that make the comment visible: a pending review is not a
 * comment until it is submitted.
 */

import type { SideEffect } from '../types.js';
import { BASIC_REPO, branchesListed, FAKE_USER, HARD_BRANCHES, HARD_REPO } from './github-fake.js';

export type TaskKind = 'single' | 'multi';
export type TaskTier = 'basic' | 'hard';
export const TASK_TIERS: readonly TaskTier[] = ['basic', 'hard'];

export interface EvalTask {
  /** Stable identifier (PROJ_EVAL_TASKS filter, report rows). */
  name: string;
  tier: TaskTier;
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
  /**
   * A call that must not appear: any recorded call matching this fails the
   * episode regardless of `expect`. Absent means nothing is forbidden.
   */
  forbid?(call: SideEffect): boolean;
}

interface RepoRef {
  owner: string;
  repo: string;
}

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
function inRepo(args: Args, ref: RepoRef = BASIC_REPO): boolean {
  return sameText(args['owner'], ref.owner) && sameText(args['repo'], ref.repo);
}

/** The first of these keys that is present. */
function firstOf(args: Args, keys: string[]): unknown {
  for (const key of keys) if (args[key] !== undefined) return args[key];
  return undefined;
}

/** `labels` as lower-cased names, whether given as strings or `{ name }` objects. */
function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const name =
      typeof item === 'string'
        ? item
        : typeof item === 'object' && item !== null
          ? (item as { name?: unknown }).name
          : undefined;
    return typeof name === 'string' ? [name.trim().toLowerCase()] : [];
  });
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

function count(
  calls: SideEffect[],
  tool: string | string[],
  where: (args: Args) => boolean,
): number {
  const names = Array.isArray(tool) ? tool : [tool];
  return calls.filter((call) => names.includes(call.tool) && where(call.args)).length;
}

/** Every tool that can put a comment on a PR or issue (the tool-correct step group). */
const COMMENT_TOOLS = [
  'add_issue_comment',
  'pull_request_review_write',
  'add_comment_to_pending_review',
  'add_reply_to_pull_request_comment',
];

const NUMBER_KEYS = ['issue_number', 'pullNumber', 'pull_number'];

/** The call addresses PR/issue `number` in `ref`. */
function targets(args: Args, number: number, ref: RepoRef = BASIC_REPO): boolean {
  return inRepo(args, ref) && sameNumber(firstOf(args, NUMBER_KEYS), number);
}

/** The call addresses some PR/issue in `ref` other than `number`. */
function targetsOther(args: Args, number: number, ref: RepoRef): boolean {
  const n = firstOf(args, NUMBER_KEYS);
  return inRepo(args, ref) && n !== undefined && !sameNumber(n, number);
}

/**
 * Index of the first `pull_request_review_write` with method `submit_pending`
 * for PR `number` after `from`, or -1. Submitting is what turns a pending
 * review (and the comments attached to it) into something anyone can see.
 */
function submittedAfter(calls: SideEffect[], number: number, from: number, ref: RepoRef): number {
  return calls.findIndex(
    (call, i) =>
      i > from &&
      call.tool === 'pull_request_review_write' &&
      call.args['method'] === 'submit_pending' &&
      targets(call.args, number, ref),
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
function commented(
  calls: SideEffect[],
  number: number,
  body: string,
  ref: RepoRef = BASIC_REPO,
): number {
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i] as SideEffect;
    if (!COMMENT_TOOLS.includes(call.tool)) continue;
    if (!targets(call.args, number, ref) || !containsText(call.args['body'], body)) continue;
    switch (call.tool) {
      case 'add_issue_comment':
      case 'add_reply_to_pull_request_comment':
        return i;
      case 'pull_request_review_write': {
        if (typeof call.args['event'] === 'string' && call.args['event'] !== '') return i;
        const submit = submittedAfter(calls, number, i, ref);
        if (submit >= 0) return submit;
        break;
      }
      case 'add_comment_to_pending_review': {
        const submit = submittedAfter(calls, number, i, ref);
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
 * Index of the call that makes a review with `event` and a body containing
 * `body` visible on PR `number`, or -1: a `create` carrying the event (the
 * body on it), or a `submit_pending` carrying the event whose body is on the
 * submit itself, on the pending `create` before it, or on an
 * `add_comment_to_pending_review` before it.
 */
function reviewed(
  calls: SideEffect[],
  number: number,
  body: string,
  event: string,
  ref: RepoRef,
): number {
  return calls.findIndex((call, i) => {
    if (call.tool !== 'pull_request_review_write' || !targets(call.args, number, ref)) return false;
    if (!sameText(call.args['event'], event)) return false;
    if (call.args['method'] === 'create') return containsText(call.args['body'], body);
    if (call.args['method'] !== 'submit_pending') return false;
    if (containsText(call.args['body'], body)) return true;
    return calls.some(
      (earlier, j) =>
        j < i &&
        targets(earlier.args, number, ref) &&
        containsText(earlier.args['body'], body) &&
        ((earlier.tool === 'pull_request_review_write' &&
          earlier.args['method'] === 'create' &&
          (earlier.args['event'] === undefined || earlier.args['event'] === '')) ||
          earlier.tool === 'add_comment_to_pending_review'),
    );
  });
}

/** `search_pull_requests` scoped to `ref`: by `owner`/`repo` arguments or a `repo:` qualifier. */
function searchesPrsIn(call: SideEffect, ref: RepoRef): boolean {
  return (
    call.tool === 'search_pull_requests' &&
    (inRepo(call.args, ref) || containsText(call.args['query'], `${ref.owner}/${ref.repo}`))
  );
}

/**
 * A lookup that would list the open PRs of `ref` and nothing else:
 * `list_pull_requests` with `state` open or absent (GitHub defaults to open;
 * `closed` / `all` are wrong), or a scoped `search_pull_requests` asking for
 * open ones.
 */
function listsOpenPrs(call: SideEffect, ref: RepoRef = BASIC_REPO): boolean {
  const args = call.args;
  if (call.tool === 'list_pull_requests') {
    return inRepo(args, ref) && (args['state'] === undefined || sameText(args['state'], 'open'));
  }
  return (
    searchesPrsIn(call, ref) &&
    (containsText(args['query'], 'is:open') || containsText(args['query'], 'state:open'))
  );
}

/**
 * A lookup that would surface an open PR of `ref` among its results: a
 * listing that is not restricted to closed PRs, or a scoped search that does
 * not ask for closed or merged ones. The open filter is optional here — when
 * the prompt names the PR by title, the title is what picks it.
 */
function looksUpPrs(call: SideEffect, ref: RepoRef = BASIC_REPO): boolean {
  const args = call.args;
  if (call.tool === 'list_pull_requests') {
    return inRepo(args, ref) && !sameText(args['state'], 'closed');
  }
  return (
    searchesPrsIn(call, ref) && !/\b(is|state):(closed|merged)\b/i.test(str(args['query']) ?? '')
  );
}

/** A lookup that would list or search the issues of `ref`. */
function looksUpIssues(call: SideEffect, ref: RepoRef): boolean {
  if (call.tool === 'list_issues') return inRepo(call.args, ref);
  if (call.tool === 'search_issues') {
    return inRepo(call.args, ref) || containsText(call.args['query'], `${ref.owner}/${ref.repo}`);
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

const BASIC = BASIC_REPO;
const HARD = HARD_REPO;
const BASIC_SLUG = `${BASIC.owner}/${BASIC.repo}`;
const HARD_SLUG = `${HARD.owner}/${HARD.repo}`;

const ISSUE_TITLE = 'Crash on startup';
const ISSUE_BODY = 'The server crashes on startup when the config file is missing.';

export const BASIC_TASKS: readonly EvalTask[] = [
  {
    name: 'create-issue',
    tier: 'basic',
    kind: 'single',
    prompt: `Open a new issue in the GitHub repository ${BASIC_SLUG} titled "${ISSUE_TITLE}" with the body "${ISSUE_BODY}"`,
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
    tier: 'basic',
    kind: 'single',
    prompt: `List the open pull requests in ${BASIC_SLUG}.`,
    steps: [['list_pull_requests', 'search_pull_requests']],
    expect: (calls) => calls.some((call) => listsOpenPrs(call)),
  },
  {
    name: 'read-readme',
    tier: 'basic',
    kind: 'single',
    prompt: `Show me the contents of README.md in ${BASIC_SLUG}.`,
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
    tier: 'basic',
    kind: 'single',
    prompt: 'What is my GitHub username?',
    steps: [['get_me']],
    expect: (calls) => has(calls, 'get_me', () => true),
  },
  {
    name: 'search-repos',
    tier: 'basic',
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
    tier: 'basic',
    kind: 'single',
    prompt: `Run the ci.yml workflow on the main branch of ${BASIC_SLUG}.`,
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
    tier: 'basic',
    kind: 'single',
    prompt: `Leave the comment "Looks good to me" on pull request #12 in ${BASIC_SLUG}.`,
    steps: [COMMENT_TOOLS],
    expect: (calls) => commented(calls, 12, 'Looks good to me') >= 0,
  },
  {
    name: 'star-repo',
    tier: 'basic',
    kind: 'single',
    prompt: `Star the repository ${BASIC_SLUG}.`,
    steps: [['star_repository']],
    expect: (calls) => has(calls, 'star_repository', (args) => inRepo(args)),
  },
  {
    name: 'list-notifications',
    tier: 'basic',
    kind: 'single',
    prompt: 'Show me my GitHub notifications.',
    steps: [['list_notifications']],
    expect: (calls) => has(calls, 'list_notifications', () => true),
  },
  {
    name: 'merge-pr-squash',
    tier: 'basic',
    kind: 'single',
    prompt: `Squash-merge pull request #7 in ${BASIC_SLUG}.`,
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
    tier: 'basic',
    kind: 'single',
    prompt: `In ${BASIC_SLUG}, create a branch named feature/x from main.`,
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
    tier: 'basic',
    kind: 'single',
    prompt: `Fork ${BASIC_SLUG} to my account.`,
    steps: [['fork_repository']],
    expect: (calls) => has(calls, 'fork_repository', (args) => inRepo(args)),
  },
  {
    name: 'find-issue-then-comment',
    tier: 'basic',
    kind: 'multi',
    prompt: `In ${BASIC_SLUG}, find the issue about a crash on startup and comment "investigating" on it.`,
    steps: [['search_issues', 'list_issues'], COMMENT_TOOLS],
    expect: (calls) => {
      const found = find(calls, ['search_issues', 'list_issues'], () => true);
      const comment = commented(calls, 42, 'investigating');
      return found >= 0 && comment > found;
    },
  },
  {
    name: 'list-prs-then-merge',
    tier: 'basic',
    kind: 'multi',
    prompt: `In ${BASIC_SLUG}, squash-merge the open pull request titled "Fix typo".`,
    steps: [['list_pull_requests', 'search_pull_requests'], ['merge_pull_request']],
    expect: (calls) => {
      const listed = calls.findIndex((call) => looksUpPrs(call));
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
    tier: 'basic',
    kind: 'multi',
    prompt: 'Star the "dotfiles" repository on my own GitHub account.',
    steps: [['get_me'], ['star_repository']],
    expect: (calls) => {
      const me = find(calls, 'get_me', () => true);
      const starred = find(calls, 'star_repository', (args) =>
        inRepo(args, { owner: FAKE_USER, repo: 'dotfiles' }),
      );
      return me >= 0 && starred > me;
    },
  },
];

// ---------------------------------------------------------------------------
// Hard tier. The world these run against is in github-fake.ts: acme/widgets
// has issues #17 (bug, needs-triage), #23 "Flaky test in CI" (bug, the newest
// OPEN bug), #25 (documentation) and #30 (bug, newest but closed); open PRs
// #8 (carol; review thread comment 9001 by bob on src/auth.ts), #10 (alice),
// #11 (alice, touches CHANGELOG.md) and #12 (bob, touches CHANGELOG.md);
// six branches paged three at a time with no `main` (default `master`,
// release/1.2 and release/1.3 on page 2); a lowercase `readme.md`. The user
// (vibdev) owns blog, dotfiles and toolbox — only toolbox has open Dependabot
// alerts (lodash, minimist) — and has already starred acme/widgets.

const USER_TOOLBOX = { owner: FAKE_USER, repo: 'toolbox' };
const PR_URL = (n: number): string => `https://github.com/${HARD_SLUG}/pull/${n}`;

const isIssueCreate = (call: SideEffect): boolean =>
  call.tool === 'issue_write' && sameText(call.args['method'], 'create');
const isComment = (call: SideEffect): boolean => COMMENT_TOOLS.includes(call.tool);

export const HARD_TASKS: readonly EvalTask[] = [
  // --- Ambiguous tool choice: the verb picks a tool AND a method.
  {
    name: 'close-issue-not-planned',
    tier: 'hard',
    kind: 'single',
    prompt: `In ${HARD_SLUG}, close issue #17 as not planned.`,
    steps: [['issue_write']],
    expect: (calls) =>
      has(
        calls,
        'issue_write',
        (args) =>
          sameText(args['method'], 'update') &&
          targets(args, 17, HARD) &&
          sameText(args['state'], 'closed') &&
          sameText(args['state_reason'], 'not_planned'),
      ),
    forbid: isIssueCreate,
  },
  {
    name: 'label-issue-keep-existing',
    tier: 'hard',
    kind: 'single',
    prompt: `Add the label "good first issue" to issue #25 in ${HARD_SLUG}, keeping the labels it already has.`,
    steps: [['issue_write']],
    // issue_write replaces the label set, so a correct call carries both the
    // new label and the existing `documentation` (readable via issue_read
    // get_labels or list_issues). label_write edits the repository's label
    // definitions, which this task never needs — the label exists.
    expect: (calls) =>
      has(calls, 'issue_write', (args) => {
        const labels = labelNames(args['labels']);
        return (
          sameText(args['method'], 'update') &&
          targets(args, 25, HARD) &&
          labels.includes('good first issue') &&
          labels.includes('documentation')
        );
      }),
    forbid: (call) => call.tool === 'label_write',
  },
  {
    name: 'reply-in-review-thread',
    tier: 'hard',
    kind: 'multi',
    prompt: `On pull request #8 in ${HARD_SLUG}, reply "Fixed in the latest push" to bob's review comment on src/auth.ts.`,
    steps: [['pull_request_read'], ['add_reply_to_pull_request_comment']],
    // The comment id (9001) is only knowable from the PR's review comments; a
    // top-level PR comment is not a reply in the thread.
    expect: (calls) => {
      const read = find(calls, 'pull_request_read', (args) => targets(args, 8, HARD));
      const reply = find(
        calls,
        'add_reply_to_pull_request_comment',
        (args) =>
          inRepo(args, HARD) &&
          sameNumber(args['commentId'], 9001) &&
          (args['pullNumber'] === undefined || sameNumber(args['pullNumber'], 8)) &&
          containsText(args['body'], 'Fixed in the latest push'),
      );
      return read >= 0 && reply > read;
    },
    forbid: (call) => call.tool === 'add_issue_comment' && targets(call.args, 8, HARD),
  },
  {
    name: 'rerun-failed-jobs',
    tier: 'hard',
    kind: 'single',
    prompt: `In ${HARD_SLUG}, re-run only the failed jobs of workflow run 123.`,
    steps: [['actions_run_trigger']],
    expect: (calls) =>
      has(
        calls,
        'actions_run_trigger',
        (args) =>
          sameText(args['method'], 'rerun_failed_jobs') &&
          inRepo(args, HARD) &&
          sameNumber(args['run_id'], 123),
      ),
    forbid: (call) =>
      call.tool === 'actions_run_trigger' && !sameText(call.args['method'], 'rerun_failed_jobs'),
  },

  // --- Discovery-dependent inputs: the lookup returns several, the prompt picks one.
  {
    name: 'merge-alice-changelog-pr',
    tier: 'hard',
    kind: 'multi',
    prompt: `In ${HARD_SLUG}, squash-merge the open pull request by alice that touches CHANGELOG.md.`,
    steps: [
      ['list_pull_requests', 'search_pull_requests'],
      ['pull_request_read'],
      ['merge_pull_request'],
    ],
    // #10 is by alice (no CHANGELOG), #12 touches CHANGELOG (by bob); only
    // #11 is both. The listing shows authors, not files, so a merge counts
    // only after the files (or diff) of one of alice's PRs were looked at —
    // #11's directly, or #10's, which rules it out.
    expect: (calls) => {
      const listed = calls.findIndex((call) => looksUpPrs(call, HARD));
      const checked = calls.findIndex(
        (call, i) =>
          i > listed &&
          call.tool === 'pull_request_read' &&
          ['get_files', 'get_diff'].includes(str(call.args['method']) ?? '') &&
          (targets(call.args, 11, HARD) || targets(call.args, 10, HARD)),
      );
      const merged = find(
        calls,
        'merge_pull_request',
        (args) => targets(args, 11, HARD) && sameText(args['merge_method'], 'squash'),
      );
      return listed >= 0 && checked > listed && merged > checked;
    },
    forbid: (call) => call.tool === 'merge_pull_request' && !targets(call.args, 11, HARD),
  },
  {
    name: 'comment-newest-open-bug',
    tier: 'hard',
    kind: 'multi',
    prompt: `In ${HARD_SLUG}, comment "Taking a look" on the newest open issue labelled bug.`,
    steps: [['list_issues', 'search_issues'], COMMENT_TOOLS],
    // #30 is the newest bug but closed; #23 is the newest open one.
    expect: (calls) => {
      const listed = calls.findIndex((call) => looksUpIssues(call, HARD));
      const comment = commented(calls, 23, 'Taking a look', HARD);
      return listed >= 0 && comment > listed;
    },
    forbid: (call) => isComment(call) && targetsOther(call.args, 23, HARD),
  },

  // --- Pagination: the target branch is on page 2 of the default page size.
  {
    name: 'branch-from-latest-release-branch',
    tier: 'hard',
    kind: 'multi',
    prompt: `In ${HARD_SLUG}, create a branch release/1.4 from the highest-numbered release/* branch.`,
    steps: [['list_branches'], ['create_branch']],
    // Success needs a listing that actually showed release/1.3 (page 2, or a
    // page size large enough to include it) before the create.
    expect: (calls) => {
      const shown = calls.findIndex(
        (call) =>
          call.tool === 'list_branches' && branchesListed(call.args).includes('release/1.3'),
      );
      const created = find(
        calls,
        'create_branch',
        (args) =>
          inRepo(args, HARD) &&
          sameText(branchName(args['branch']), 'release/1.4') &&
          sameText(branchName(args['from_branch']), 'release/1.3'),
      );
      return shown >= 0 && created > shown;
    },
    forbid: (call) =>
      call.tool === 'create_branch' &&
      inRepo(call.args, HARD) &&
      !sameText(branchName(call.args['from_branch']), 'release/1.3'),
  },

  // --- Error recovery: the first attempt fails; the corrected call is scored.
  {
    name: 'branch-off-main-or-default',
    tier: 'hard',
    kind: 'single',
    prompt: `Create a branch named hotfix/login in ${HARD_SLUG}, based on main — or on the default branch if there is no main.`,
    steps: [['create_branch']],
    // The fake rejects from_branch main (no such branch; default is master).
    // The corrected call names master; or it omits from_branch (letting the
    // server pick the default) once the model has established there is no
    // main — by that failure, by a listing that showed every branch, or by a
    // repository search that reported the default branch. Omitting it blind
    // is not the stated task.
    expect: (calls) => {
      const knowsNoMain = (before: number): boolean => {
        const earlier = calls.slice(0, before);
        if (
          earlier.some(
            (c) =>
              c.tool === 'create_branch' &&
              inRepo(c.args, HARD) &&
              sameText(branchName(c.args['from_branch']), 'main'),
          )
        ) {
          return true;
        }
        const seen = new Set(
          earlier.filter((c) => c.tool === 'list_branches').flatMap((c) => branchesListed(c.args)),
        );
        if (HARD_BRANCHES.every((b) => seen.has(b))) return true;
        return earlier.some(
          (c) => c.tool === 'search_repositories' && containsText(c.args['query'], HARD.repo),
        );
      };
      return calls.some(
        (call, i) =>
          call.tool === 'create_branch' &&
          inRepo(call.args, HARD) &&
          sameText(branchName(call.args['branch']), 'hotfix/login') &&
          (sameText(branchName(call.args['from_branch']), 'master') ||
            (call.args['from_branch'] === undefined && knowsNoMain(i))),
      );
    },
  },
  {
    name: 'read-lowercase-readme',
    tier: 'hard',
    kind: 'single',
    prompt: `Show me the contents of the readme file in ${HARD_SLUG}.`,
    steps: [['get_file_contents']],
    // README.md is a 404 there; the file is `readme.md` (found by listing the
    // root or by trying the lowercase name). Case matters: it is the fake's
    // actual path.
    expect: (calls) =>
      has(
        calls,
        'get_file_contents',
        (args) => inRepo(args, HARD) && repoPath(args['path']) === 'readme.md',
      ),
  },

  // --- Conditional writes: the lookup decides whether a write happens.
  {
    name: 'upsert-issue-exists',
    tier: 'hard',
    kind: 'multi',
    prompt: `In ${HARD_SLUG}, if there is already an issue titled "Flaky test in CI", comment "Still happening on 1.3" on it; otherwise create an issue with that title.`,
    steps: [['search_issues', 'list_issues'], COMMENT_TOOLS],
    expect: (calls) => {
      const looked = calls.findIndex((call) => looksUpIssues(call, HARD));
      const comment = commented(calls, 23, 'Still happening on 1.3', HARD);
      return looked >= 0 && comment > looked;
    },
    forbid: isIssueCreate,
  },
  {
    name: 'upsert-issue-missing',
    tier: 'hard',
    kind: 'multi',
    prompt: `In ${HARD_SLUG}, if there is already an issue titled "Add dark mode", comment "Still wanted" on it; otherwise create an issue with that title.`,
    steps: [['search_issues', 'list_issues'], ['issue_write']],
    expect: (calls) => {
      const looked = calls.findIndex((call) => looksUpIssues(call, HARD));
      const creates = count(
        calls,
        'issue_write',
        (args) =>
          sameText(args['method'], 'create') &&
          inRepo(args, HARD) &&
          sameText(args['title'], 'Add dark mode'),
      );
      const created = find(
        calls,
        'issue_write',
        (args) => sameText(args['method'], 'create') && inRepo(args, HARD),
      );
      return looked >= 0 && creates === 1 && created > looked;
    },
    forbid: isComment,
  },
  {
    name: 'star-unless-starred',
    tier: 'hard',
    kind: 'multi',
    prompt: `Star ${HARD_SLUG} unless I have already starred it.`,
    steps: [['list_starred_repositories']],
    // The user's stars already include acme/widgets: look, then do nothing.
    expect: (calls) => has(calls, 'list_starred_repositories', () => true),
    forbid: (call) => call.tool === 'star_repository' || call.tool === 'unstar_repository',
  },

  // --- A 3–5 step chain with a discovered target.
  {
    name: 'dependabot-summary-issue',
    tier: 'hard',
    kind: 'multi',
    prompt:
      'Find which of my own GitHub repositories has open Dependabot alerts and open an issue in that repository summarizing them.',
    steps: [['search_repositories'], ['list_dependabot_alerts'], ['issue_write']],
    // get_me → search_repositories user:vibdev → alerts per repo (only
    // toolbox has any: lodash, minimist) → issue in vibdev/toolbox naming both.
    expect: (calls) => {
      const repos = find(
        calls,
        'search_repositories',
        (args) => containsText(args['query'], FAKE_USER) || containsText(args['query'], '@me'),
      );
      const alerts = find(calls, 'list_dependabot_alerts', (args) => inRepo(args, USER_TOOLBOX));
      // Each alert is named by its package or its CVE, in the title or body.
      const created = find(calls, 'issue_write', (args) => {
        const text = `${str(args['title']) ?? ''}\n${str(args['body']) ?? ''}`;
        return (
          sameText(args['method'], 'create') &&
          inRepo(args, USER_TOOLBOX) &&
          (containsText(text, 'lodash') || containsText(text, 'CVE-2021-23337')) &&
          (containsText(text, 'minimist') || containsText(text, 'CVE-2021-44906'))
        );
      });
      return repos >= 0 && alerts > repos && created > alerts;
    },
    forbid: (call) => isIssueCreate(call) && !inRepo(call.args, USER_TOOLBOX),
  },

  // --- URL parsing: owner, repo and number come from a link.
  {
    name: 'url-close-pr-with-comment',
    tier: 'hard',
    kind: 'multi',
    prompt: `Close ${PR_URL(12)} without merging and leave the comment "Superseded by #11" on it.`,
    steps: [['update_pull_request', 'issue_write'], COMMENT_TOOLS],
    // A PR closes through update_pull_request or, since PRs are issues,
    // issue_write update; either way state=closed and never a merge.
    expect: (calls) => {
      const closed =
        has(
          calls,
          'update_pull_request',
          (args) => targets(args, 12, HARD) && sameText(args['state'], 'closed'),
        ) ||
        has(
          calls,
          'issue_write',
          (args) =>
            sameText(args['method'], 'update') &&
            targets(args, 12, HARD) &&
            sameText(args['state'], 'closed'),
        );
      return closed && commented(calls, 12, 'Superseded by #11', HARD) >= 0;
    },
    forbid: (call) => call.tool === 'merge_pull_request',
  },
  {
    name: 'url-request-changes',
    tier: 'hard',
    kind: 'single',
    prompt: `Request changes on ${PR_URL(10)} with the review comment "Please add tests".`,
    steps: [['pull_request_review_write']],
    // A review with event REQUEST_CHANGES (submitted directly, or pending then
    // submitted). APPROVE/COMMENT, or a plain PR comment, is not it.
    expect: (calls) => reviewed(calls, 10, 'Please add tests', 'REQUEST_CHANGES', HARD) >= 0,
    forbid: (call) =>
      (call.tool === 'pull_request_review_write' &&
        inRepo(call.args, HARD) &&
        sameText(call.args['event'], 'APPROVE')) ||
      call.tool === 'merge_pull_request',
  },
];

export const TOOL_CHOICE_TASKS: readonly EvalTask[] = [...BASIC_TASKS, ...HARD_TASKS];

/** Resolve a comma list of tier names (PROJ_EVAL_TIERS); unknown names throw. */
export function resolveTiers(spec: string | undefined): TaskTier[] {
  if (spec === undefined || spec.trim() === '') return [...TASK_TIERS];
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((name) => {
      if (!TASK_TIERS.includes(name as TaskTier)) {
        throw new Error(`unknown tier "${name}"; known: ${TASK_TIERS.join(', ')}`);
      }
      return name as TaskTier;
    });
}

/**
 * Resolve a comma list of task names (PROJ_EVAL_TASKS) within `tiers`
 * (default: all). Unknown names throw, and so does naming a task outside
 * the selected tiers — the matrix never silently shrinks.
 */
export function resolveTasks(
  spec: string | undefined,
  tiers: readonly TaskTier[] = TASK_TIERS,
): EvalTask[] {
  const inTiers = TOOL_CHOICE_TASKS.filter((t) => tiers.includes(t.tier));
  if (spec === undefined || spec.trim() === '') return inTiers;
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
      if (!tiers.includes(task.tier)) {
        throw new Error(
          `task "${name}" is in tier ${task.tier}, which the selected tiers (${tiers.join(', ')}) exclude`,
        );
      }
      return task;
    });
}
