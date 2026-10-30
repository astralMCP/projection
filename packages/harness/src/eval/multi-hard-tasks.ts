/**
 * The `multi-hard` tier: 12 tasks against the multi world opened with
 * `variant: 'hard'` (multi-world.ts) — the same three boxes (`github`,
 * `fs`, `mongo`) with far more data in them (multi-hard-fixtures.ts,
 * multi-hard-github.ts). Opt-in only: an unset PROJ_EVAL_TIERS never
 * selects it.
 *
 * Every other tier saturates; these are built so that completion and cost
 * can differ between surfaces — one call per item vs one machine — by
 * multiples. Five families, each task tagged with its `kind` and its N:
 *
 * - **bulk-read** (3): one answer over N ≥ 25 items — a total per gold
 *   customer (30), an ERROR-line tally per service log (28), the open
 *   issues whose title names a file in the project (40 candidates, 26
 *   hits). Graded on the final text, exactly: every expected item with
 *   its exact value, nothing extra.
 * - **bulk-write** (3): 8–20 approved writes — label 12 stale issues
 *   (keeping their labels), comment on the 9 open PRs that change
 *   src/export/, insert the 14 missing audit documents. Graded on the
 *   recorded side effects (and, for MongoDB, the end state): exactly the
 *   expected set, no extras, no writes outside it.
 * - **chain** (2): five or six dependent hops across all three boxes.
 *   Graded on the final answer.
 * - **pagination** (2): the answer sits past GitHub's default page of 30
 *   (a 64-branch list, a 62-release list with the answer at item 47).
 * - **branching** (2): a per-item choice between two kinds of write —
 *   an issue or a PR comment per failing check, a tier update or a file
 *   line per VIP email.
 *
 * Answers that are sets or single values are read from a final
 * `ANSWER: …` line the prompt asks for, so no grader depends on wording;
 * per-item tables are read line by line (the item's identifier, then the
 * first number after it on that line).
 *
 * Each task's turn budget is 2N + 10 action turns ({@link budget}), where
 * N counts the per-item calls a one-call-per-item strategy needs, so such
 * a strategy can finish; discovery turns stay free as in every tier.
 */

import type { SideEffect } from '../types.js';
import { FILE_READ_TOOLS, readText, root } from './filesystem-tasks.js';
import { HARD_REPO } from './github-fake.js';
import { COMMENT_TOOLS, labelNames, targets, inRepo } from './github-predicates.js';
import { SHOP_DB, withMongodb } from './mongodb-world.js';
import {
  ALL_HARD_ORDERS,
  EXPECTED_CHAIN_ORDERS,
  EXPECTED_ERROR_COUNTS,
  EXPECTED_GOLD_TOTALS,
  EXPECTED_MISSING_AUDITS,
  EXPECTED_VIP_MISSING,
  EXPECTED_VIP_UPGRADES,
  HARD_AUDIT_DOCS,
  HARD_STAFF,
  HARD_TIER_BY_EMAIL,
  SHIPPED_ORDER_IDS,
} from './multi-hard-fixtures.js';
import {
  CHECKS_PR,
  EXPECTED_EXPORT_PRS,
  EXPECTED_FEATURE_BRANCHES,
  EXPECTED_FIRST_2025_TAG,
  EXPECTED_FIX_ISSUES,
  EXPECTED_MISSING_FILES,
  EXPECTED_STALE_ISSUES,
  EXPECTED_TITLE_FILE_ISSUES,
  OWNER_LOGIN,
  RHEA_OPEN_ASSIGNED,
} from './multi-hard-github.js';
import { boxOf, isBoxWrite, unbox } from './multi-tasks.js';
import { qualifiedName } from './multi-world.js';
import { firstOf, sameText, str, type EvalTask } from './task-core.js';
import type { BoxAlias } from './world.js';

const HARD = HARD_REPO;
const SLUG = `${HARD.owner}/${HARD.repo}`;

/** The 2N + 10 action-turn budget for a task with N per-item calls. */
export function budget(n: number): number {
  return 2 * n + 10;
}

function inBox(alias: BoxAlias, names: readonly string[]): string[] {
  return names.map((name) => qualifiedName(alias, name));
}

/** Some call went to box `alias`. */
function touched(calls: SideEffect[], alias: BoxAlias): boolean {
  return calls.some((call) => boxOf(call.tool) === alias);
}

// ---------------------------------------------------------------------------
// Answer parsing

/** Markdown emphasis and code marks, which never change a value. */
function plain(text: string): string {
  return text.replace(/[*_`]/g, '');
}

/**
 * The text after the last `ANSWER:` marker (case-insensitive, emphasis
 * ignored), up to the end of that line; undefined when there is none.
 */
export function answerLine(finalText: string): string | undefined {
  const lines = plain(finalText).split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /\banswer\s*:\s*(.*)$/i.exec(lines[i] as string);
    if (m !== null) return (m[1] as string).trim();
  }
  return undefined;
}

/** `#N` numbers on the ANSWER line, as a sorted unique list (undefined without one). */
export function answerIssueNumbers(finalText: string): number[] | undefined {
  const line = answerLine(finalText);
  if (line === undefined) return undefined;
  return [...new Set([...line.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))].toSorted(
    (a, b) => a - b,
  );
}

function sameSet<T>(actual: readonly T[], expected: readonly T[]): boolean {
  const a = new Set(actual);
  const e = new Set(expected);
  return a.size === e.size && [...e].every((x) => a.has(x));
}

/** A number token: digits with optional thousands commas and decimals. */
const NUMBER = /-?\d[\d,]*(?:\.\d+)?/;

function parseNumber(token: string): number {
  return Number(token.replace(/,/g, ''));
}

/** Escape `text` for a RegExp. */
function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * For each line naming `id` as a whole token (not inside a longer name or
 * address), the first number after it on that line. An id the text never
 * names yields an empty list.
 */
export function valuesAfter(text: string, id: string): number[] {
  const token = new RegExp(`(?<![\\w.@/-])${escaped(id)}(?![\\w@-]|\\.\\w)`, 'i');
  const out: number[] = [];
  for (const line of plain(text).split('\n')) {
    const m = token.exec(line);
    if (m === null) continue;
    const rest = line.slice(m.index + m[0].length).replace(/\$/g, '');
    const n = NUMBER.exec(rest);
    if (n !== null) out.push(parseNumber(n[0]));
  }
  return out;
}

/** Every line naming `id` gives exactly `expected` (within half a cent), and at least one does. */
function statesValue(text: string, id: string, expected: number): boolean {
  const values = valuesAfter(text, id);
  return values.length > 0 && values.every((v) => Math.abs(v - expected) < 0.005);
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** Every email address in `text`, lower-cased. */
export function emailsIn(text: string): string[] {
  return [...plain(text).matchAll(EMAIL)].map((m) => m[0].toLowerCase().replace(/\.$/, ''));
}

// ---------------------------------------------------------------------------
// Side-effect helpers

/** The GitHub box's calls (bare names). */
function github(calls: SideEffect[]): SideEffect[] {
  return unbox(calls, 'github').calls;
}

/** The issue/PR number a GitHub call addresses. */
function numberOf(args: Record<string, unknown>): number | undefined {
  const n = firstOf(args, ['issue_number', 'pullNumber', 'pull_number']);
  const v = typeof n === 'number' ? n : typeof n === 'string' ? Number(n) : NaN;
  return Number.isFinite(v) ? v : undefined;
}

const isUpdate = (call: SideEffect): boolean =>
  call.tool === 'issue_write' && sameText(call.args['method'], 'update');
const isCreate = (call: SideEffect): boolean =>
  call.tool === 'issue_write' && sameText(call.args['method'], 'create');

/**
 * A call that makes a comment visible on PR/issue `n` right away, or a
 * pending review's submit (when its comments become visible): the units a
 * "one comment per PR" grader counts.
 */
function postsCommentOn(call: SideEffect, n: number): boolean {
  if (!targets(call.args, n, HARD)) return false;
  switch (call.tool) {
    case 'add_issue_comment':
      return typeof call.args['body'] === 'string' && call.args['body'].trim() !== '';
    case 'add_reply_to_pull_request_comment':
      return true;
    case 'pull_request_review_write': {
      const method = str(call.args['method']) ?? '';
      const event = str(call.args['event']) ?? '';
      return (method === 'create' && event !== '') || method === 'submit_pending';
    }
    default:
      return false;
  }
}

/**
 * The text a comment on `n` carries, joined across the calls that can hold
 * a comment body (the immediate ones, and a pending review's parts).
 */
function commentText(calls: SideEffect[], n: number): string {
  return calls
    .filter((call) => COMMENT_TOOLS.includes(call.tool) && targets(call.args, n, HARD))
    .map((call) => str(call.args['body']) ?? '')
    .join('\n');
}

/** Normalise an issue title: trimmed, quotes and code marks dropped. */
function titleOf(call: SideEffect): string {
  return (str(call.args['title']) ?? '').replace(/[`'"]/g, '').trim();
}

// ---------------------------------------------------------------------------
// Graders, exported for the offline tests

/** bulk-read: every gold customer's exact total, and no other customer's email. */
export function gradeGoldTotals(finalText: string): boolean {
  const gold = Object.keys(EXPECTED_GOLD_TOTALS);
  const named = new Set(emailsIn(finalText));
  const others = Object.keys(HARD_TIER_BY_EMAIL).filter((email) => !gold.includes(email));
  return (
    gold.every((email) => statesValue(finalText, email, EXPECTED_GOLD_TOTALS[email] as number)) &&
    others.every((email) => !named.has(email))
  );
}

/** bulk-read: every service log's exact ERROR-line tally. */
export function gradeErrorCounts(finalText: string): boolean {
  return Object.entries(EXPECTED_ERROR_COUNTS).every(([file, n]) =>
    statesValue(finalText, file, n),
  );
}

/** bulk-read: the ANSWER line's issue numbers are exactly the expected ones. */
export function gradeTitleFiles(finalText: string): boolean {
  const numbers = answerIssueNumbers(finalText);
  return numbers !== undefined && sameSet(numbers, EXPECTED_TITLE_FILE_ISSUES);
}

/**
 * bulk-write: the stale issues' final labels. Every `issue_write` update is
 * on a stale issue and touches only its labels; replaying them in order,
 * each stale issue ends with exactly its old labels plus `stale`.
 */
export function gradeStaleLabels(calls: SideEffect[]): boolean {
  const updates = github(calls).filter((call) => isUpdate(call) && inRepo(call.args, HARD));
  const finalLabels = new Map<number, string[]>();
  for (const call of updates) {
    const n = numberOf(call.args);
    if (n === undefined || !Array.isArray(call.args['labels'])) return false;
    finalLabels.set(n, labelNames(call.args['labels']));
  }
  const expected = Object.entries(EXPECTED_STALE_ISSUES).map(([n, labels]) => ({
    n: Number(n),
    labels: [...labels, 'stale'],
  }));
  return (
    sameSet(
      [...finalLabels.keys()],
      expected.map((e) => e.n),
    ) && expected.every((e) => sameSet(finalLabels.get(e.n) ?? [], e.labels))
  );
}

/** A write the stale-label task does not allow. */
export function forbidStaleLabels(call: SideEffect): boolean {
  if (!isBoxWrite(call)) return false;
  if (boxOf(call.tool) !== 'github') return true;
  const bare = call.tool.slice('github.'.length);
  if (bare !== 'issue_write' || !sameText(call.args['method'], 'update')) return true;
  if (!inRepo(call.args, HARD)) return true;
  const n = numberOf(call.args);
  if (n === undefined || !(n in EXPECTED_STALE_ISSUES)) return true;
  // Labels only: any other field changed is a write outside the set.
  return ['title', 'body', 'state', 'state_reason', 'assignees', 'milestone', 'type'].some(
    (key) => call.args[key] !== undefined,
  );
}

const EXPORT_COMMENT = 'Please add a CHANGELOG entry for the export changes.';

/** bulk-write: exactly one comment, with the requested text, on each expected PR. */
export function gradeExportComments(calls: SideEffect[]): boolean {
  const gh = github(calls);
  return EXPECTED_EXPORT_PRS.every(
    (n) =>
      gh.filter((call) => postsCommentOn(call, n)).length === 1 &&
      /changelog entry for the export changes/i.test(commentText(gh, n)),
  );
}

/** A write the export-comment task does not allow: anything but a comment on an expected PR. */
export function forbidExportComments(call: SideEffect): boolean {
  if (!isBoxWrite(call)) return false;
  if (boxOf(call.tool) !== 'github') return true;
  const bare = { tool: call.tool.slice('github.'.length), args: call.args };
  if (!COMMENT_TOOLS.includes(bare.tool)) return true;
  const n = numberOf(call.args);
  return !inRepo(call.args, HARD) || n === undefined || !EXPECTED_EXPORT_PRS.includes(n);
}

/** `shipped` audit documents the hard world seeds for `orderId`. */
function seededShipped(orderId: string): number {
  return HARD_AUDIT_DOCS.filter((doc) => doc['action'] === 'shipped' && doc['orderId'] === orderId)
    .length;
}

/**
 * bulk-write (MongoDB end state): every shipped order has exactly one
 * `shipped` audit document, every other order keeps the ones it had, and
 * the collection grew by exactly the missing ones.
 */
export function gradeAuditDocs(docs: readonly Record<string, unknown>[]): boolean {
  const baseCount = 5 + HARD_AUDIT_DOCS.length;
  if (docs.length !== baseCount + EXPECTED_MISSING_AUDITS.length) return false;
  const shippedFor = (orderId: string): number =>
    docs.filter((doc) => doc['action'] === 'shipped' && doc['orderId'] === orderId).length;
  return ALL_HARD_ORDERS.every((order) =>
    SHIPPED_ORDER_IDS.includes(order.orderId)
      ? shippedFor(order.orderId) === 1
      : shippedFor(order.orderId) === seededShipped(order.orderId),
  );
}

/** A write the audit task does not allow: anything but an insert into audit_log. */
export function forbidAudit(call: SideEffect): boolean {
  if (!isBoxWrite(call)) return false;
  if (boxOf(call.tool) !== 'mongo') return true;
  return (
    call.tool !== 'mongo.insert-many' ||
    !sameText(call.args['collection'], 'audit_log') ||
    !sameText(call.args['database'], SHOP_DB)
  );
}

/** chain: the ANSWER line's order ids are exactly the customer's. */
export function gradeChainOrders(finalText: string): boolean {
  const line = answerLine(finalText);
  if (line === undefined) return false;
  const ids = [...line.matchAll(/\b[A-Z]-\d{4}\b/gi)].map((m) => m[0].toUpperCase());
  return sameSet(ids, EXPECTED_CHAIN_ORDERS);
}

const OWNER_EMAIL = (HARD_STAFF.find((s) => s.github === OWNER_LOGIN) as { email: string }).email;

/** chain: the ANSWER line holds the owner's email (and no other) and the open-issue tally. */
export function gradeOwner(finalText: string): boolean {
  const line = answerLine(finalText);
  if (line === undefined) return false;
  const emails = emailsIn(line);
  if (!sameSet(emails, [OWNER_EMAIL])) return false;
  const numbers = [...line.replace(EMAIL, ' ').matchAll(/\b\d+\b/g)].map((m) => Number(m[0]));
  return numbers.length === 1 && numbers[0] === RHEA_OPEN_ASSIGNED;
}

/** pagination: the ANSWER line holds exactly one number, the feature-branch tally. */
export function gradeFeatureBranches(finalText: string): boolean {
  const line = answerLine(finalText);
  if (line === undefined) return false;
  const numbers = [...line.matchAll(/\b\d+\b/g)].map((m) => Number(m[0]));
  return numbers.length === 1 && numbers[0] === EXPECTED_FEATURE_BRANCHES;
}

/** pagination: the ANSWER line names the tag, and no other version. */
export function gradeFirst2025(finalText: string): boolean {
  const line = answerLine(finalText);
  if (line === undefined) return false;
  const tags = [...line.matchAll(/\bv?\d+\.\d+\.\d+(?:-[\w.]+)?\b/gi)].map((m) =>
    m[0].toLowerCase(),
  );
  return tags.length === 1 && tags[0] === EXPECTED_FIRST_2025_TAG.toLowerCase();
}

/**
 * branching: one issue titled `Fix <path>` per failing check's file that
 * exists, none for the others, and every missing file named in a comment on
 * the PR.
 */
export function gradeFailingChecks(calls: SideEffect[]): boolean {
  const gh = github(calls);
  const creates = gh.filter((call) => isCreate(call) && inRepo(call.args, HARD)).map(titleOf);
  const wanted = EXPECTED_FIX_ISSUES.map((path) => `Fix ${path}`);
  const once = creates.length === wanted.length && sameSet(creates, wanted);
  const comments = commentText(gh, CHECKS_PR);
  const posted = gh.some((call) => postsCommentOn(call, CHECKS_PR));
  return once && posted && EXPECTED_MISSING_FILES.every((path) => comments.includes(path));
}

/** A write the failing-checks task does not allow. */
export function forbidFailingChecks(call: SideEffect): boolean {
  if (!isBoxWrite(call)) return false;
  if (boxOf(call.tool) !== 'github') return true;
  const bare = { tool: call.tool.slice('github.'.length), args: call.args };
  if (!inRepo(call.args, HARD)) return true;
  if (isCreate(bare)) return !EXPECTED_FIX_ISSUES.map((p) => `Fix ${p}`).includes(titleOf(bare));
  if (COMMENT_TOOLS.includes(bare.tool)) return numberOf(call.args) !== CHECKS_PR;
  return true;
}

/** branching (MongoDB end state): the VIP customers are gold, everyone else as seeded. */
export function gradeVipTiers(customers: readonly Record<string, unknown>[]): boolean {
  if (customers.length !== Object.keys(HARD_TIER_BY_EMAIL).length) return false;
  return customers.every((doc) => {
    const email = str(doc['email']) ?? '';
    const seeded = HARD_TIER_BY_EMAIL[email];
    if (seeded === undefined) return false;
    return doc['tier'] === (EXPECTED_VIP_UPGRADES.includes(email) ? 'gold' : seeded);
  });
}

/** branching (file end state): notes/missing-vips.txt names exactly the missing emails. */
export function gradeMissingVips(text: string | undefined): boolean {
  return text !== undefined && sameSet([...new Set(emailsIn(text))], EXPECTED_VIP_MISSING);
}

/** A write the VIP task does not allow: only customer updates and the missing-vips file. */
export function forbidVip(call: SideEffect): boolean {
  if (!isBoxWrite(call)) return false;
  const alias = boxOf(call.tool);
  if (alias === 'mongo') {
    return call.tool !== 'mongo.update-many' || !sameText(call.args['collection'], 'customers');
  }
  if (alias === 'fs') {
    if (call.tool !== 'fs.write_file' && call.tool !== 'fs.edit_file') return true;
    const path = (str(call.args['path']) ?? '').replace(/\\/g, '/');
    return !(path === 'notes/missing-vips.txt' || path.endsWith('/notes/missing-vips.txt'));
  }
  return true;
}

// ---------------------------------------------------------------------------
// The tasks

const TIER = 'multi-hard' as const;
const ANSWER_FORMAT = (what: string): string =>
  `End your reply with a line "ANSWER: " followed by ${what}.`;

/** Expected values the tests pin as literals. */
export const MULTI_HARD_EXPECTED = {
  goldTotals: EXPECTED_GOLD_TOTALS,
  errorCounts: EXPECTED_ERROR_COUNTS,
  titleFileIssues: EXPECTED_TITLE_FILE_ISSUES,
  staleIssues: EXPECTED_STALE_ISSUES,
  exportPrs: EXPECTED_EXPORT_PRS,
  missingAudits: EXPECTED_MISSING_AUDITS,
  chainOrders: EXPECTED_CHAIN_ORDERS,
  owner: { email: OWNER_EMAIL, openAssigned: RHEA_OPEN_ASSIGNED },
  featureBranches: EXPECTED_FEATURE_BRANCHES,
  first2025Tag: EXPECTED_FIRST_2025_TAG,
  fixIssues: EXPECTED_FIX_ISSUES,
  missingFiles: EXPECTED_MISSING_FILES,
  vipUpgrades: EXPECTED_VIP_UPGRADES,
  vipMissing: EXPECTED_VIP_MISSING,
} as const;

// Ns: the per-item calls a one-call-per-item strategy makes.
const N_GOLD = Object.keys(EXPECTED_GOLD_TOTALS).length; // 30 customers
const N_LOGS = Object.keys(EXPECTED_ERROR_COUNTS).length; // 28 files
const N_TITLES = 40; // open issues whose title names a path, each checked
const N_STALE = Object.keys(EXPECTED_STALE_ISSUES).length; // 12 writes
const N_EXPORT = 26 + EXPECTED_EXPORT_PRS.length; // 26 open PRs inspected + 9 comments
const N_AUDIT = EXPECTED_MISSING_AUDITS.length; // 14 inserts
const N_CHAIN_RELEASE = 6; // package.json, release, issue, customer, orders (+ the other issues)
const N_CHAIN_OWNER = 5; // PRs, checks, CODEOWNERS, staff, assigned issues
const N_BRANCH_PAGES = 3; // 64 branches at 30 per page
const N_RELEASE_PAGES = 3; // 62 releases at 30 per page
const N_CHECKS = 15; // check runs of #139, 11 failing
const N_VIPS = 15; // emails in notes/vip.txt

export const MULTI_HARD_TASKS: readonly EvalTask[] = [
  // --- bulk-read
  {
    name: 'hard-gold-order-totals',
    tier: TIER,
    kind: 'bulk-read',
    n: N_GOLD,
    maxTurns: budget(N_GOLD),
    prompt: `For every gold-tier customer in the ${SHOP_DB} database, work out the total value of their orders, leaving out cancelled orders. Reply with one line per customer in the form "email: total", with the total in dollars to two decimals.`,
    steps: [inBox('mongo', ['find', 'aggregate', 'aggregate-db'])],
    expect: (calls) => touched(calls, 'mongo'),
    forbid: isBoxWrite,
    verify: (context) => gradeGoldTotals(context.finalText),
  },
  {
    name: 'hard-log-error-lines',
    tier: TIER,
    kind: 'bulk-read',
    n: N_LOGS,
    maxTurns: budget(N_LOGS),
    prompt:
      'For each log file in logs/services in my project, how many lines have the level ERROR? Reply with one line per file in the form "file name: number".',
    steps: [inBox('fs', FILE_READ_TOOLS)],
    expect: (calls) => unbox(calls, 'fs').calls.some((call) => FILE_READ_TOOLS.includes(call.tool)),
    forbid: isBoxWrite,
    verify: (context) => gradeErrorCounts(context.finalText),
  },
  {
    name: 'hard-issues-naming-files',
    tier: TIER,
    kind: 'bulk-read',
    n: N_TITLES,
    maxTurns: budget(N_TITLES),
    prompt: `Which open issues in the GitHub repository ${SLUG} have a title that names a file existing in my project? Paths in titles are relative to the project root. ${ANSWER_FORMAT('the issue numbers, comma-separated (for example: ANSWER: #3, #8)')}`,
    steps: [
      inBox('github', ['list_issues', 'search_issues']),
      inBox('fs', ['directory_tree', 'list_directory', 'search_files', 'get_file_info']),
    ],
    expect: (calls) => touched(calls, 'github') && touched(calls, 'fs'),
    forbid: isBoxWrite,
    verify: (context) => gradeTitleFiles(context.finalText),
  },

  // --- bulk-write
  {
    name: 'hard-label-stale-issues',
    tier: TIER,
    kind: 'bulk-write',
    n: N_STALE,
    maxTurns: budget(N_STALE),
    prompt: `In the GitHub repository ${SLUG}, add the label "stale" to every open issue that has not been updated since 2026-07-01 (its last update is before that date). Keep each issue's existing labels, and change nothing else.`,
    steps: [inBox('github', ['list_issues', 'search_issues']), inBox('github', ['issue_write'])],
    expect: gradeStaleLabels,
    forbid: forbidStaleLabels,
  },
  {
    name: 'hard-comment-export-prs',
    tier: TIER,
    kind: 'bulk-write',
    n: N_EXPORT,
    maxTurns: budget(N_EXPORT),
    prompt: `Post the comment "${EXPORT_COMMENT}" on every open pull request in the GitHub repository ${SLUG} that changes at least one file under src/export/. Don't comment anywhere else.`,
    steps: [
      inBox('github', ['list_pull_requests', 'search_pull_requests']),
      inBox('github', ['pull_request_read']),
      inBox('github', COMMENT_TOOLS),
    ],
    expect: gradeExportComments,
    forbid: forbidExportComments,
  },
  {
    name: 'hard-audit-shipped-orders',
    tier: TIER,
    kind: 'bulk-write',
    n: N_AUDIT,
    maxTurns: budget(N_AUDIT),
    needsWorld: true,
    prompt: `In the ${SHOP_DB} database, every order with status "shipped" should have a document in the audit_log collection with action "shipped" and that order's orderId. Add one for each shipped order that doesn't have one yet, and change nothing else.`,
    steps: [inBox('mongo', ['find', 'aggregate']), inBox('mongo', ['insert-many'])],
    expect: (calls) => unbox(calls, 'mongo').calls.some((call) => call.tool === 'insert-many'),
    forbid: forbidAudit,
    verify: (context) =>
      withMongodb(context.facts, async (client) =>
        gradeAuditDocs(await client.db(SHOP_DB).collection('audit_log').find({}).toArray()),
      ),
  },

  // --- chain
  {
    name: 'hard-chain-release-reporter',
    tier: TIER,
    kind: 'chain',
    n: N_CHAIN_RELEASE,
    maxTurns: budget(N_CHAIN_RELEASE),
    prompt: `Take the version in my project's package.json and locate the matching release of the GitHub repository ${SLUG}. Its release notes reference some issues: work out who opened the oldest of them. That GitHub user is a customer in the ${SHOP_DB} database (customers record their GitHub username). Which order ids does that customer have? ${ANSWER_FORMAT('every one of their order ids, comma-separated')}`,
    steps: [
      inBox('fs', FILE_READ_TOOLS),
      inBox('github', ['get_release_by_tag', 'list_releases', 'get_latest_release']),
      inBox('github', ['issue_read', 'list_issues', 'search_issues']),
      inBox('mongo', ['find', 'aggregate']),
    ],
    expect: (calls) => touched(calls, 'fs') && touched(calls, 'github') && touched(calls, 'mongo'),
    forbid: isBoxWrite,
    verify: (context) => gradeChainOrders(context.finalText),
  },
  {
    name: 'hard-chain-failing-owner',
    tier: TIER,
    kind: 'chain',
    n: N_CHAIN_OWNER,
    maxTurns: budget(N_CHAIN_OWNER),
    prompt: `The newest open pull request in the GitHub repository ${SLUG} has a failing check. Take the file that check reports, look up its owner in my project's CODEOWNERS file, then look that owner up by GitHub username in the staff collection of the ${SHOP_DB} database. Tell me their email address and how many open issues in ${SLUG} are assigned to them. ${ANSWER_FORMAT('the email address and the number, separated by a space')}`,
    steps: [
      inBox('github', ['list_pull_requests', 'search_pull_requests']),
      inBox('github', ['pull_request_read']),
      inBox('fs', FILE_READ_TOOLS),
      inBox('mongo', ['find', 'aggregate']),
      inBox('github', ['search_issues', 'list_issues']),
    ],
    expect: (calls) => touched(calls, 'fs') && touched(calls, 'github') && touched(calls, 'mongo'),
    forbid: isBoxWrite,
    verify: (context) => gradeOwner(context.finalText),
  },

  // --- pagination
  {
    name: 'hard-page-feature-branches',
    tier: TIER,
    kind: 'pagination',
    n: N_BRANCH_PAGES,
    maxTurns: budget(N_BRANCH_PAGES),
    prompt: `How many branches in the GitHub repository ${SLUG} have names starting with "feature/"? ${ANSWER_FORMAT('the number')}`,
    steps: [inBox('github', ['list_branches'])],
    expect: (calls) => github(calls).some((call) => call.tool === 'list_branches'),
    forbid: isBoxWrite,
    verify: (context) => gradeFeatureBranches(context.finalText),
  },
  {
    name: 'hard-page-first-2025-release',
    tier: TIER,
    kind: 'pagination',
    n: N_RELEASE_PAGES,
    maxTurns: budget(N_RELEASE_PAGES),
    prompt: `Which release of the GitHub repository ${SLUG} was the first one published in 2025? ${ANSWER_FORMAT('its tag')}`,
    steps: [inBox('github', ['list_releases', 'list_tags', 'get_release_by_tag'])],
    expect: (calls) => github(calls).some((call) => call.tool === 'list_releases'),
    forbid: isBoxWrite,
    verify: (context) => gradeFirst2025(context.finalText),
  },

  // --- branching
  {
    name: 'hard-branch-failing-checks',
    tier: TIER,
    kind: 'branching',
    n: N_CHECKS,
    maxTurns: budget(N_CHECKS),
    prompt: `Pull request #${CHECKS_PR} in the GitHub repository ${SLUG} has failing checks, and each failing check reports one file. For each such file: if it exists in my project, open an issue in ${SLUG} titled "Fix <path>" with the path as the check reports it (one issue per file); if it doesn't exist, comment on pull request #${CHECKS_PR} naming the missing file instead. Make no other changes.`,
    steps: [
      inBox('github', ['pull_request_read']),
      inBox('fs', ['get_file_info', 'directory_tree', 'list_directory', 'search_files']),
      inBox('github', ['issue_write']),
      inBox('github', COMMENT_TOOLS),
    ],
    expect: gradeFailingChecks,
    forbid: forbidFailingChecks,
  },
  {
    name: 'hard-branch-vip-tiers',
    tier: TIER,
    kind: 'branching',
    n: N_VIPS,
    maxTurns: budget(N_VIPS),
    needsWorld: true,
    prompt: `notes/vip.txt in my project lists VIP customers by email. For each email: if a customer with that email exists in the ${SHOP_DB} database, make sure their tier is "gold"; otherwise add the email as a line to notes/missing-vips.txt in my project. Change nothing else.`,
    steps: [
      inBox('fs', FILE_READ_TOOLS),
      inBox('mongo', ['find', 'aggregate']),
      inBox('mongo', ['update-many']),
      inBox('fs', ['write_file', 'edit_file']),
    ],
    expect: (calls) =>
      unbox(calls, 'mongo').calls.some((call) => call.tool === 'update-many') &&
      unbox(calls, 'fs').calls.some((call) => ['write_file', 'edit_file'].includes(call.tool)),
    forbid: forbidVip,
    verify: async (context) =>
      gradeMissingVips(readText(root(context), 'notes/missing-vips.txt')) &&
      (await withMongodb(context.facts, async (client) =>
        gradeVipTiers(await client.db(SHOP_DB).collection('customers').find({}).toArray()),
      )),
  },
];
