/**
 * Predicates over recorded GitHub calls, shared by the GitHub tiers
 * (tasks.ts) and the multi tier (multi-tasks.ts): repository and number
 * matching, the ways a comment becomes visible, PR and issue lookups, and
 * ref/path normalization. Lenient where the API allows synonyms
 * (`issue_number` vs `pullNumber`, numbers as strings, owner/repo case, a
 * defaulted `state`, `refs/heads/` and `./` prefixes).
 */

import type { SideEffect } from '../types.js';
import { BASIC_REPO } from './github-fake.js';
import { containsText, firstOf, sameNumber, sameText, str, type Args } from './task-core.js';

export interface RepoRef {
  owner: string;
  repo: string;
}

/** owner/repo as the prompt states them (case-insensitive). */
export function inRepo(args: Args, ref: RepoRef = BASIC_REPO): boolean {
  return sameText(args['owner'], ref.owner) && sameText(args['repo'], ref.repo);
}

/** `labels` as lower-cased names, whether given as strings or `{ name }` objects. */
export function labelNames(value: unknown): string[] {
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

/** Every tool that can put a comment on a PR or issue (the tool-correct step group). */
export const COMMENT_TOOLS = [
  'add_issue_comment',
  'pull_request_review_write',
  'add_comment_to_pending_review',
  'add_reply_to_pull_request_comment',
];

export const NUMBER_KEYS = ['issue_number', 'pullNumber', 'pull_number'];

/** The call addresses PR/issue `number` in `ref`. */
export function targets(args: Args, number: number, ref: RepoRef = BASIC_REPO): boolean {
  return inRepo(args, ref) && sameNumber(firstOf(args, NUMBER_KEYS), number);
}

/** The call addresses some PR/issue in `ref` other than `number`. */
export function targetsOther(args: Args, number: number, ref: RepoRef): boolean {
  const n = firstOf(args, NUMBER_KEYS);
  return inRepo(args, ref) && n !== undefined && !sameNumber(n, number);
}

/**
 * Index of the first `pull_request_review_write` with method `submit_pending`
 * for PR `number` after `from`, or -1. Submitting is what turns a pending
 * review (and the comments attached to it) into something anyone can see.
 */
export function submittedAfter(
  calls: SideEffect[],
  number: number,
  from: number,
  ref: RepoRef,
): number {
  return calls.findIndex(
    (call, i) =>
      i > from &&
      call.tool === 'pull_request_review_write' &&
      call.args['method'] === 'submit_pending' &&
      targets(call.args, number, ref),
  );
}

/**
 * Index of the call that makes a comment containing `body` (or whose body
 * satisfies it, when a predicate) visible on PR/issue `number`, or -1. `add_issue_comment` and
 * `add_reply_to_pull_request_comment` post immediately. A
 * `pull_request_review_write` posts immediately only when it carries an
 * `event` (COMMENT / APPROVE / REQUEST_CHANGES); without one, `create` only
 * opens a PENDING review, which — like `add_comment_to_pending_review` —
 * shows nothing until a later `submit_pending` for the same PR, so the
 * comment is attributed to that submit's index (ordering checks compare
 * against the moment the comment became visible).
 */
export function commented(
  calls: SideEffect[],
  number: number,
  body: string | ((text: string) => boolean),
  ref: RepoRef = BASIC_REPO,
): number {
  const matches =
    typeof body === 'string'
      ? (value: unknown) => containsText(value, body)
      : (value: unknown) => body(str(value) ?? '');
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i] as SideEffect;
    if (!COMMENT_TOOLS.includes(call.tool)) continue;
    if (!targets(call.args, number, ref) || !matches(call.args['body'])) continue;
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
export function reviewed(
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
export function searchesPrsIn(call: SideEffect, ref: RepoRef): boolean {
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
export function listsOpenPrs(call: SideEffect, ref: RepoRef = BASIC_REPO): boolean {
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
export function looksUpPrs(call: SideEffect, ref: RepoRef = BASIC_REPO): boolean {
  const args = call.args;
  if (call.tool === 'list_pull_requests') {
    return inRepo(args, ref) && !sameText(args['state'], 'closed');
  }
  return (
    searchesPrsIn(call, ref) && !/\b(is|state):(closed|merged)\b/i.test(str(args['query']) ?? '')
  );
}

/** A lookup that would list or search the issues of `ref`. */
export function looksUpIssues(call: SideEffect, ref: RepoRef): boolean {
  if (call.tool === 'list_issues') return inRepo(call.args, ref);
  if (call.tool === 'search_issues') {
    return inRepo(call.args, ref) || containsText(call.args['query'], `${ref.owner}/${ref.repo}`);
  }
  return false;
}

/** Git refs may be fully qualified; `refs/heads/main` names the main branch. */
export function branchName(value: unknown): string | undefined {
  return str(value)
    ?.trim()
    .replace(/^refs\/heads\//, '');
}

/** Repo-relative paths may carry a `./` or `/` prefix. */
export function repoPath(value: unknown): string | undefined {
  return str(value)
    ?.trim()
    .replace(/^(\.\/|\/)+/, '');
}
