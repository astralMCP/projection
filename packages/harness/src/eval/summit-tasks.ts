/**
 * The `summit-saas` tier: 24 tasks against the summit world
 * (summit-world.ts) — fakes of the Notion, Sentry, Slack and Stripe MCP
 * servers plus the real filesystem server. Ten tasks use one server, fourteen
 * cross servers. Opt-in only, and HELD OUT: a hill-climb may see this tier's
 * aggregate scores, never these prompts, graders, fixtures or traces, and it
 * is calibrated in `direct` mode only.
 *
 * Design rules (as the workplace tier's):
 *
 * - the prompt says what to do, the way a colleague would ask, never which
 *   tool; every check the grader makes is stated in the prompt;
 * - write tasks are graded on the END STATE (`facts.summit`), so any path —
 *   any tool, any order, a failed first attempt — that lands the right
 *   changes passes; read-only tasks are graded on the answer and on having
 *   made no write;
 * - `forbid` names the harmful writes (a refund, cancellation or issue
 *   update outside the requested set), which fail the episode even if
 *   undone;
 * - each task has its own turn budget and a WHY-HARD comment.
 *
 * Final answers are read from the last `ANSWER:` line.
 */

import type { SideEffect } from '../types.js';
import { answerLine } from './multi-hard-tasks.js';
import { isBoxWrite } from './multi-tasks.js';
import { qualifiedName } from './multi-world.js';
import {
  NOTION_IDS,
  pageText,
  plain,
  rowsOf,
  seedNotion,
  type NotionPage,
} from './summit-notion.js';
import { PEOPLE } from './summit-people.js';
import { seedSentryIssues, sentryIssue, type SentryIssue } from './summit-sentry.js';
import { CHANNELS, THREADS, type SlackMessage } from './summit-slack.js';
import {
  monthlyCents,
  PI,
  seedStripe,
  stripeCustomerIds,
  type StripeState,
} from './summit-stripe.js';
import type { SummitState } from './summit-world.js';
import type { EvalTask, TaskKind, VerifyContext } from './task-core.js';
import type { SummitBoxAlias } from './world.js';

// ---------------------------------------------------------------------------
// Expected values, derived from the seeds (and pinned as literals in the tests)

function overdueUsdInvoices(
  state: StripeState,
): { number: string; due: number; customer: string }[] {
  const now = Date.parse('2026-10-28T15:00:00Z') / 1000;
  return state.invoices
    .filter((i) => i.status === 'open' && i.due_date !== null && i.due_date < now)
    .filter((i) => state.customers.find((c) => c.id === i.customer)?.currency === 'usd')
    .map((i) => ({
      number: i.number as string,
      due: i.amount_due - i.amount_paid,
      customer: i.customer,
    }));
}

export function summitExpected() {
  const stripe = seedStripe();
  const cus = stripeCustomerIds();
  const pastDueUsd = stripe.subscriptions.filter(
    (s) =>
      s.status === 'past_due' &&
      stripe.prices.find((p) => p.id === s.items[0]?.price)?.currency === 'usd',
  );
  const subsOf = (key: string) => stripe.subscriptions.filter((s) => s.customer === cus[key]);
  const legacy = stripe.subscriptions.filter(
    (s) =>
      s.status === 'past_due' && s.items.some((i) => i.price === 'price_1N3qT4bZr8LmW2xKa9Qd0sRt'),
  );
  const mrr = (key: string): number =>
    Math.round(
      subsOf(key)
        .filter((s) => s.status === 'active')
        .reduce((n, s) => n + monthlyCents(stripe, s), 0),
    ) / 100;
  const ostravaOpen = stripe.invoices.filter(
    (i) => i.customer === cus['ostrava'] && i.status === 'open',
  );
  const overdue = overdueUsdInvoices(stripe);
  return {
    pastDueMrr:
      Math.round(pastDueUsd.reduce((n, s) => n + Math.round(monthlyCents(stripe, s)), 0)) / 100,
    legacyCancel: legacy.map((s) => s.id).toSorted(),
    duplicateRefund: { pi: PI.lumoraOctDuplicate, amount: 34800 },
    extensionIssues: [
      'WEB-APP-2A',
      'WEB-APP-2C',
      'WEB-APP-2N',
      'WEB-APP-2W',
      'WEB-APP-31',
      'WEB-APP-37',
      'WEB-APP-3E',
    ],
    numericLookup: { shortId: 'MOBILE-IOS-1K', users: 214 },
    assignPayments: [
      'BILLING-WORKER-2M',
      'BILLING-WORKER-2P',
      'BILLING-WORKER-2R',
      'BILLING-WORKER-31',
    ],
    berlinStaff: ['Jonas Weber', 'Lena Fischer', 'Marcus Bell'],
    ssoAnswer: { answer: 'yes', who: 'Marcus Bell' },
    unownedRenewals: ['Atlas Shipping', 'Pinecrest University'],
    top3: [
      ['BILLING-WORKER-2P', 1720],
      ['BILLING-WORKER-2K', 940],
      ['BILLING-WORKER-2M', 610],
    ] as [string, number][],
    approvedRefunds: [
      [PI.reqBrightpathSeats, 4550],
      [PI.reqTidalOnboarding, 150000],
      [PI.reqSableCredit, 12000],
    ] as [string, number][],
    largePayments: [
      [PI.bigQuillAnnual, 1160000],
      [PI.bigOrbitalAnnual, 2990000],
      [PI.bigExactly5000, 500000],
      [PI.bigQuarryOct25, 500000],
    ] as [string, number][],
    renewalPings: [
      ['Orbital Freight', PEOPLE.sam.slackId, '2026-11-21'],
      ['Meridian Clinics', PEOPLE.tomas.slackId, '2026-11-07'],
      ['Solace Hospitals', PEOPLE.aisha.slackId, '2026-11-12'],
    ] as [string, string, string][],
    renewalSkipped: 'Vantage Retail',
    incidentFromSentry: { shortId: 'API-5KD', date: '2026-10-27' },
    qaIssue: 'WEB-APP-3J',
    codeOwners: ['@fernhill/payments', '@priya-raman'],
    refundLogAdds: [
      ['RR-1051', cus['brightpath'] as string, 45.5],
      ['RR-1052', cus['tidal'] as string, 1500],
      ['RR-1053', cus['sable'] as string, 120],
      ['RR-1054', cus['riverbend'] as string, 1250],
      ['RR-1058', cus['aurora'] as string, 36],
    ] as [string, string, number][],
    dunningInvoices: ostravaOpen.map((i) => i.number as string).toSorted(),
    dunningTotal: ostravaOpen.reduce((n, i) => n + i.amount_due - i.amount_paid, 0) / 100,
    enterpriseMrr: {
      'Halcyon Bank': mrr('halcyon'),
      'Orbital Freight': mrr('orbital'),
      'Meridian Clinics': mrr('meridian'),
      'Pinecrest University': mrr('pinecrest'),
      'Vantage Retail': mrr('vantage'),
      'Quarry & Co': mrr('quarry'),
    } as Record<string, number>,
    changelogResolve: ['API-52C', 'BILLING-WORKER-2H', 'WEB-APP-34'],
    threadStatuses: [
      ['API-61B', 'unresolved'],
      ['API-5KD', 'resolved'],
      ['WEB-APP-2F', 'ignored'],
    ] as [string, string][],
    overdueInvoices: overdue.map((i) => i.number).toSorted(),
    overdueTotal: overdue.reduce((n, i) => n + i.due, 0) / 100,
    escalations: [
      ['API-61B', 312],
      ['WEB-APP-3J', 64],
      ['BILLING-WORKER-2P', 51],
    ] as [string, number][],
  };
}

export const SUMMIT_EXPECTED = summitExpected();
const E = SUMMIT_EXPECTED;

// ---------------------------------------------------------------------------
// Helpers

function q(alias: SummitBoxAlias, names: readonly string[]): string[] {
  return names.map((n) => qualifiedName(alias, n));
}

function stateOf(context: VerifyContext): SummitState {
  const state = context.facts.summit;
  if (state === undefined) throw new Error('summit verify needs facts.summit');
  return state;
}

/** Collapse whitespace and case, drop markdown emphasis. */
export function norm(text: string): string {
  return text.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Sentry short IDs in `text`, upper-cased, in order of first appearance. */
export function shortIdsIn(text: string): string[] {
  return [
    ...new Set(
      [
        ...text.matchAll(
          /\b(API|WEB-APP|BILLING-WORKER|MOBILE-IOS|MARKETING-SITE)-([0-9A-Z]{1,3})\b/gi,
        ),
      ].map((m) => `${(m[1] as string).toUpperCase()}-${(m[2] as string).toUpperCase()}`),
    ),
  ];
}

/** Slack mentions (`<@U…>`) in `text`. */
export function mentionsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1] as string))];
}

/** Every number in `text` (commas dropped), e.g. "$1,234.50" → 1234.5. */
export function numbersIn(text: string): number[] {
  return [...text.replace(/(\d),(\d{3})/g, '$1$2').matchAll(/\d+(?:\.\d+)?/g)].map((m) =>
    Number(m[0]),
  );
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  const a = new Set(actual);
  return a.size === new Set(expected).size && expected.every((x) => a.has(x));
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.005;

/** Which boxes the episode changed. */
export function changedBoxes(
  state: SummitState,
  calls: readonly SideEffect[],
): Set<SummitBoxAlias> {
  const out = new Set<SummitBoxAlias>();
  if (state.notion.mutations.length > 0) out.add('notion');
  if (sentryChanges(state).length > 0) out.add('sentry');
  if (state.slack.posted.length > 0 || state.slack.reacted.length > 0) out.add('slack');
  if (state.stripe.mutations.length > 0) out.add('stripe');
  if (calls.some((c) => c.tool.startsWith('fs.') && isBoxWrite(c))) out.add('fs');
  return out;
}

function onlyChanged(
  state: SummitState,
  calls: readonly SideEffect[],
  allowed: readonly SummitBoxAlias[],
): boolean {
  return [...changedBoxes(state, calls)].every((b) => allowed.includes(b));
}

const SEED_ISSUES: readonly SentryIssue[] = seedSentryIssues();

/** Short IDs whose status, substatus or assignee differ from the seed. */
export function sentryChanges(state: SummitState): string[] {
  return state.sentry.issues
    .filter((r) => {
      const s = SEED_ISSUES.find((x) => x.id === r.id) as SentryIssue;
      return (
        r.status !== s.status ||
        r.substatus !== s.substatus ||
        JSON.stringify(r.assignedTo) !== JSON.stringify(s.assignedTo)
      );
    })
    .map((r) => r.shortId);
}

/** The issue a Sentry `update_issue` call (direct or through `execute_sentry_tool`) targets. */
export function sentryUpdateTarget(call: SideEffect): string | undefined {
  let args = call.args;
  if (call.tool === 'sentry.execute_sentry_tool') {
    if (args['name'] !== 'update_issue') return undefined;
    args = (args['arguments'] ?? {}) as Record<string, unknown>;
  } else if (call.tool !== 'sentry.update_issue') return undefined;
  const raw =
    typeof args['issueId'] === 'string'
      ? args['issueId']
      : typeof args['issueUrl'] === 'string'
        ? (/issues\/([\w-]+)/.exec(args['issueUrl'])?.[1] ?? '')
        : '';
  const id = raw.trim().toUpperCase();
  const row = SEED_ISSUES.find((r) => r.shortId === id || r.id === id);
  return row?.shortId ?? id;
}

const forbidSentryUpdatesOutside =
  (allowed: readonly string[]) =>
  (call: SideEffect): boolean => {
    const target = sentryUpdateTarget(call);
    return target !== undefined && !allowed.includes(target);
  };

/** The PaymentIntent a `create_refund` call targets. */
function refundTarget(call: SideEffect): string | undefined {
  return call.tool === 'stripe.create_refund'
    ? String(call.args['payment_intent'] ?? '')
    : undefined;
}

const forbidRefundsOutside =
  (allowed: readonly string[]) =>
  (call: SideEffect): boolean => {
    const t = refundTarget(call);
    return t !== undefined && !allowed.includes(t.trim());
  };

/** New refunds of the episode: payment intent → total refunded. */
export function newRefunds(state: SummitState): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of state.stripe.mutations) {
    if (m.kind !== 'create_refund') continue;
    const pi = String(m.detail['payment_intent']);
    out.set(pi, (out.get(pi) ?? 0) + Number(m.detail['amount']));
  }
  return out;
}

function posted(state: SummitState, channel: string, topLevel = true): SlackMessage[] {
  return state.slack.posted.filter(
    (m) => m.channel === channel && (topLevel ? m.thread_ts === undefined : true),
  );
}

function newRows(state: SummitState, dataSourceId: string): NotionPage[] {
  const seeded = new Set(seedNotion().pages.map((p) => p.id));
  return rowsOf(state.notion, dataSourceId).filter((p) => !seeded.has(p.id));
}

function prop(page: NotionPage, name: string): Record<string, unknown> {
  return (page.properties[name] ?? {}) as Record<string, unknown>;
}

function selectName(page: NotionPage, name: string): string | null {
  const p = prop(page, name);
  return ((p['select'] ?? p['status']) as { name?: string } | null)?.name ?? null;
}

function noWriteCalls(calls: readonly SideEffect[]): boolean {
  return !calls.some(isBoxWrite);
}

// ---------------------------------------------------------------------------
// Graders (exported for the offline tests)

export function gradePastDueMrr(finalText: string): boolean {
  const line = answerLine(finalText);
  return line !== undefined && numbersIn(line).some((n) => near(n, E.pastDueMrr));
}

export function gradeDuplicateRefund(state: SummitState, calls: readonly SideEffect[]): boolean {
  const refunds = newRefunds(state);
  return (
    onlyChanged(state, calls, ['stripe']) &&
    state.stripe.mutations.every((m) => m.kind === 'create_refund') &&
    refunds.size === 1 &&
    refunds.get(E.duplicateRefund.pi) === E.duplicateRefund.amount
  );
}

export function gradeCancelLegacy(state: SummitState, calls: readonly SideEffect[]): boolean {
  const canceled = state.stripe.mutations
    .filter((m) => m.kind === 'cancel_subscription')
    .map((m) => m.id);
  return (
    onlyChanged(state, calls, ['stripe']) &&
    state.stripe.mutations.every((m) => m.kind === 'cancel_subscription') &&
    sameSet(canceled, E.legacyCancel)
  );
}

export function gradeIgnoreExtensions(state: SummitState, calls: readonly SideEffect[]): boolean {
  return (
    onlyChanged(state, calls, ['sentry']) &&
    sameSet(sentryChanges(state), E.extensionIssues) &&
    E.extensionIssues.every((id) => {
      const r = sentryIssue(state.sentry, id);
      return r?.status === 'ignored' && r.substatus === 'archived_forever';
    })
  );
}

export function gradeNumericLookup(finalText: string): boolean {
  const line = answerLine(finalText);
  if (line === undefined) return false;
  return (
    sameSet(shortIdsIn(line), [E.numericLookup.shortId]) &&
    numbersIn(line.replace(/MOBILE-IOS-1K/gi, '')).includes(E.numericLookup.users)
  );
}

export function gradeAssignPayments(state: SummitState, calls: readonly SideEffect[]): boolean {
  return (
    onlyChanged(state, calls, ['sentry']) &&
    sameSet(sentryChanges(state), E.assignPayments) &&
    E.assignPayments.every((id) => {
      const a = sentryIssue(state.sentry, id)?.assignedTo;
      return a?.type === 'team' && a.name === 'payments';
    })
  );
}

const ALL_NAMES = Object.values(PEOPLE).map((p) => p.name);

export function gradeBerlinStaff(
  finalText: string,
  allNames: readonly string[] = ALL_NAMES,
): boolean {
  const line = answerLine(finalText);
  if (line === undefined) return false;
  const named = allNames.filter((n) => norm(line).includes(n.toLowerCase()));
  return sameSet(named, E.berlinStaff);
}

export function gradeSsoAnswer(finalText: string): boolean {
  const line = answerLine(finalText);
  if (line === undefined) return false;
  const n = norm(line);
  const named = ALL_NAMES.filter((x) => n.includes(x.toLowerCase()));
  return /\byes\b/.test(n) && !/\bno\b/.test(n) && sameSet(named, [E.ssoAnswer.who]);
}

const ACCOUNT_NAMES = seedNotion()
  .pages.filter((p) => p.parent === `ds:${NOTION_IDS.accountsDs}`)
  .map((p) => p.title);

export function gradeUnownedRenewals(finalText: string): boolean {
  const line = answerLine(finalText);
  if (line === undefined) return false;
  const named = ACCOUNT_NAMES.filter((n) => norm(line).includes(n.toLowerCase()));
  return sameSet(named, E.unownedRenewals);
}

function multiNames(page: NotionPage, name: string): string[] {
  return ((prop(page, name)['multi_select'] as { name: string }[] | undefined) ?? []).map(
    (o) => o.name,
  );
}

function dateStart(page: NotionPage, name: string): string | null {
  return (prop(page, name)['date'] as { start?: string } | null)?.start?.slice(0, 10) ?? null;
}

export function gradeLogIncident(state: SummitState, calls: readonly SideEffect[]): boolean {
  const rows = newRows(state, NOTION_IDS.incidentsDs);
  if (!onlyChanged(state, calls, ['notion']) || rows.length !== 1) return false;
  const [r] = rows as [NotionPage];
  const otherEdits = state.notion.mutations.filter(
    (m) => m.kind !== 'create_page' && m.id !== r.id,
  );
  return (
    otherEdits.length === 0 &&
    norm(r.title) === 'webhook retries stalled' &&
    selectName(r, 'Severity') === 'SEV-2' &&
    selectName(r, 'Status') === 'Resolved' &&
    dateStart(r, 'Date') === '2026-10-27' &&
    sameSet(multiNames(r, 'Service'), ['billing-worker'])
  );
}

export function gradeTop3ToSlack(state: SummitState, calls: readonly SideEffect[]): boolean {
  const posts = posted(state, CHANNELS.engPayments.id);
  if (
    !onlyChanged(state, calls, ['slack']) ||
    state.slack.posted.length !== 1 ||
    posts.length !== 1
  )
    return false;
  const text = (posts[0] as SlackMessage).text;
  const ids = shortIdsIn(text);
  if (ids.join(',') !== E.top3.map(([id]) => id).join(',')) return false;
  const nums = numbersIn(text.replace(/BILLING-WORKER-\w+/g, ' '));
  return E.top3.every(([, n]) => nums.includes(n));
}

export function gradeApprovedRefunds(state: SummitState, calls: readonly SideEffect[]): boolean {
  const refunds = newRefunds(state);
  return (
    onlyChanged(state, calls, ['stripe', 'slack']) &&
    state.slack.reacted.length === 0 &&
    state.stripe.mutations.every((m) => m.kind === 'create_refund') &&
    refunds.size === E.approvedRefunds.length &&
    E.approvedRefunds.every(([pi, amount]) => refunds.get(pi) === amount)
  );
}

const ALL_PI_IDS = seedStripe().paymentIntents.map((p) => p.id);

/** The new Finance child page whose title mentions "large payments", if exactly one. */
function largePaymentsPage(state: SummitState): NotionPage | undefined {
  const seeded = new Set(seedNotion().pages.map((p) => p.id));
  const fresh = state.notion.pages.filter((p) => !seeded.has(p.id) && p.archived !== true);
  if (fresh.length !== 1) return undefined;
  const [p] = fresh as [NotionPage];
  return p.parent === `page:${NOTION_IDS.finance}` && /large payments/i.test(p.title)
    ? p
    : undefined;
}

export function gradeLargePayments(state: SummitState, calls: readonly SideEffect[]): boolean {
  const page = largePaymentsPage(state);
  if (page === undefined || !onlyChanged(state, calls, ['notion'])) return false;
  const text = pageText(state.notion, page.id);
  const lines = text.split('\n');
  const mentioned = ALL_PI_IDS.filter((id) => text.includes(id));
  if (
    !sameSet(
      mentioned,
      E.largePayments.map(([id]) => id),
    )
  )
    return false;
  return E.largePayments.every(([id, cents]) => {
    const line = lines.find((l) => l.includes(id)) ?? '';
    return numbersIn(line.replace(id, ' ')).some((n) => near(n, cents / 100));
  });
}

export function gradeRenewalPings(
  state: SummitState,
  calls: readonly SideEffect[],
  finalText: string,
): boolean {
  const posts = posted(state, CHANNELS.csRenewals.id);
  if (
    !onlyChanged(state, calls, ['slack']) ||
    state.slack.posted.length !== E.renewalPings.length ||
    posts.length !== E.renewalPings.length
  )
    return false;
  const ok = E.renewalPings.every(([account, user, date]) =>
    posts.some(
      (p) =>
        norm(p.text).includes(account.toLowerCase()) &&
        sameSet(mentionsIn(p.text), [user]) &&
        p.text.includes(date),
    ),
  );
  return ok && norm(finalText).includes(E.renewalSkipped.toLowerCase());
}

export function gradeIncidentFromSentry(state: SummitState, calls: readonly SideEffect[]): boolean {
  const rows = newRows(state, NOTION_IDS.incidentsDs);
  if (!onlyChanged(state, calls, ['notion']) || rows.length !== 1) return false;
  const [r] = rows as [NotionPage];
  const issue = SEED_ISSUES.find((x) => x.shortId === E.incidentFromSentry.shortId) as SentryIssue;
  return (
    state.notion.mutations.every((m) => m.kind === 'create_page' || m.id === r.id) &&
    norm(r.title) === norm(issue.title) &&
    selectName(r, 'Severity') === 'SEV-2' &&
    selectName(r, 'Status') === 'Investigating' &&
    dateStart(r, 'Date') === E.incidentFromSentry.date &&
    sameSet(multiNames(r, 'Service'), ['api']) &&
    plain(prop(r, 'Sentry')['rich_text']).trim().toUpperCase() === E.incidentFromSentry.shortId
  );
}

export function gradeQaAssign(state: SummitState, calls: readonly SideEffect[]): boolean {
  const a = sentryIssue(state.sentry, E.qaIssue)?.assignedTo;
  return (
    onlyChanged(state, calls, ['sentry']) &&
    sameSet(sentryChanges(state), [E.qaIssue]) &&
    a?.type === 'team' &&
    a.name === 'frontend'
  );
}

export function gradeCodeOwners(finalText: string): boolean {
  const line = answerLine(finalText);
  if (line === undefined) return false;
  const handles = [
    ...new Set([...line.matchAll(/@[\w-]+(?:\/[\w-]+)?/g)].map((m) => m[0].toLowerCase())),
  ];
  return sameSet(handles, E.codeOwners);
}

export function gradeRefundLog(state: SummitState, calls: readonly SideEffect[]): boolean {
  const rows = newRows(state, NOTION_IDS.refundsDs);
  if (!onlyChanged(state, calls, ['notion']) || rows.length !== E.refundLogAdds.length)
    return false;
  const created = new Set(rows.map((r) => r.id));
  if (state.notion.mutations.some((m) => !created.has(m.id))) return false;
  return E.refundLogAdds.every(([req, customer, amount]) =>
    rows.some(
      (r) =>
        r.title.trim() === req &&
        plain(prop(r, 'Customer')['rich_text']).trim() === customer &&
        near(Number(prop(r, 'Amount')['number']), amount) &&
        selectName(r, 'Status') === 'Approved',
    ),
  );
}

export function gradeDunningInvoices(state: SummitState, calls: readonly SideEffect[]): boolean {
  const posts = posted(state, CHANNELS.billingReq.id);
  if (
    !onlyChanged(state, calls, ['slack']) ||
    state.slack.posted.length !== 1 ||
    posts.length !== 1
  )
    return false;
  const text = (posts[0] as SlackMessage).text;
  const numbers = [...new Set([...text.matchAll(/FERN-\d{4}/g)].map((m) => m[0]))];
  return (
    sameSet(numbers, E.dunningInvoices) &&
    numbersIn(text.replace(/FERN-\d{4}/g, ' ')).some((n) => near(n, E.dunningTotal))
  );
}

export function gradeEnterpriseMrr(state: SummitState, calls: readonly SideEffect[]): boolean {
  if (!onlyChanged(state, calls, ['notion'])) return false;
  const seeded = seedNotion();
  const rows = rowsOf(state.notion, NOTION_IDS.accountsDs);
  for (const r of rows) {
    const expected = E.enterpriseMrr[r.title];
    const before = seeded.pages.find((p) => p.id === r.id) as NotionPage;
    if (expected !== undefined) {
      if (!near(Number(prop(r, 'MRR')['number']), expected)) return false;
    } else if (JSON.stringify(r.properties) !== JSON.stringify(before.properties)) return false;
    // Nothing but MRR may change on the Enterprise rows either.
    const others = Object.keys(r.properties).filter((k) => k !== 'MRR');
    if (
      others.some((k) => JSON.stringify(r.properties[k]) !== JSON.stringify(before.properties[k]))
    )
      return false;
  }
  return state.notion.mutations.every((m) => m.kind === 'update_page');
}

export function gradeChangelogResolve(state: SummitState, calls: readonly SideEffect[]): boolean {
  return (
    onlyChanged(state, calls, ['sentry']) &&
    sameSet(sentryChanges(state), E.changelogResolve) &&
    E.changelogResolve.every((id) => sentryIssue(state.sentry, id)?.status === 'resolved')
  );
}

export function gradeThreadStatuses(state: SummitState, calls: readonly SideEffect[]): boolean {
  if (!onlyChanged(state, calls, ['slack']) || state.slack.posted.length !== 1) return false;
  const reply = state.slack.posted[0] as SlackMessage;
  if (reply.channel !== CHANNELS.incidents.id || reply.thread_ts !== THREADS.latencyIncident)
    return false;
  const lines = reply.text.split('\n');
  return (
    sameSet(
      shortIdsIn(reply.text),
      E.threadStatuses.map(([id]) => id),
    ) &&
    E.threadStatuses.every(([id, status]) => {
      const line = lines.find((l) => shortIdsIn(l).includes(id));
      if (line === undefined || shortIdsIn(line).length !== 1) return false;
      const words = norm(line).match(/\b(unresolved|resolved|ignored|archived)\b/g) ?? [];
      return (
        words.length >= 1 &&
        words.every((w) => w === status || (status === 'ignored' && w === 'archived'))
      );
    })
  );
}

export function gradeOverdueInvoices(state: SummitState, calls: readonly SideEffect[]): boolean {
  const posts = posted(state, CHANNELS.finance.id);
  if (
    !onlyChanged(state, calls, ['slack']) ||
    state.slack.posted.length !== 1 ||
    posts.length !== 1
  )
    return false;
  const text = (posts[0] as SlackMessage).text;
  const numbers = [...new Set([...text.matchAll(/FERN-\d{4}/g)].map((m) => m[0]))];
  return (
    sameSet(numbers, E.overdueInvoices) &&
    numbersIn(text.replace(/FERN-\d{4}/g, ' ')).some((n) => near(n, E.overdueTotal))
  );
}

export function gradeEscalation(state: SummitState, calls: readonly SideEffect[]): boolean {
  const posts = posted(state, CHANNELS.incidents.id);
  if (
    !onlyChanged(state, calls, ['slack']) ||
    state.slack.posted.length !== 1 ||
    posts.length !== 1
  )
    return false;
  const text = (posts[0] as SlackMessage).text;
  if (
    !sameSet(
      shortIdsIn(text),
      E.escalations.map(([id]) => id),
    )
  )
    return false;
  const lines = text.split('\n');
  return E.escalations.every(([id, users]) => {
    const line =
      lines.find((l) => shortIdsIn(l).includes(id) && shortIdsIn(l).length === 1) ?? text;
    return numbersIn(line.replace(/[A-Z-]+-[0-9A-Z]+/g, ' ')).includes(users);
  });
}

// ---------------------------------------------------------------------------
// The tasks

const NO_CHANGES = 'Make no changes anywhere.';

function task(
  name: string,
  kind: TaskKind,
  prompt: string,
  steps: string[][],
  grade: Pick<EvalTask, 'verify' | 'forbid' | 'needsWorld'> & { expect?: EvalTask['expect'] },
  maxTurns: number,
): EvalTask {
  return {
    name,
    tier: 'summit-saas',
    kind,
    prompt,
    steps,
    expect: grade.expect ?? (() => true),
    ...(grade.forbid !== undefined ? { forbid: grade.forbid } : {}),
    ...(grade.verify !== undefined ? { verify: grade.verify } : {}),
    ...(grade.needsWorld === true ? { needsWorld: true } : {}),
    maxTurns,
  };
}

const readOnly = (
  grade: (finalText: string) => boolean,
): Pick<EvalTask, 'verify'> & { expect: EvalTask['expect'] } => ({
  expect: noWriteCalls,
  verify: (context) => grade(context.finalText),
});

const endState = (
  grade: (state: SummitState, calls: readonly SideEffect[], finalText: string) => boolean,
): Pick<EvalTask, 'verify' | 'needsWorld'> => ({
  verify: (context) => grade(stateOf(context), context.calls, context.finalText),
  needsWorld: true,
});

const allIssuesBut = (ids: readonly string[]): ((call: SideEffect) => boolean) =>
  forbidSentryUpdatesOutside(ids);

export const SUMMIT_TASKS: readonly EvalTask[] = [
  // ---------------------------------------------------------------- single-server
  // WHY HARD: list_subscriptions defaults to 10 and there are 12 past-due USD
  // subscriptions (plus a EUR one, an unpaid and a trialing one); amounts are
  // cents, prices are per seat, two are yearly (÷12), and the seat count is
  // the item quantity buried in a large subscription object.
  task(
    'ss-stripe-pastdue-mrr',
    'bulk-read',
    `How much monthly recurring revenue is at risk from past-due subscriptions in Stripe right now? For each past-due subscription, take price × quantity per month (yearly prices count as one twelfth), and add them up. Only count USD subscriptions. ${NO_CHANGES} End with a line \`ANSWER: $<total in dollars and cents>\`.`,
    [q('stripe', ['list_subscriptions'])],
    readOnly(gradePastDueMrr),
    14,
  ),
  // WHY HARD: the customer is found only by its (case-sensitive) email, which
  // returns just an ID; the customer has four $348.00 payments (one in
  // September, one declined, two that succeeded three minutes apart) and a
  // look-alike customer at lumora.com; a refund is irreversible.
  task(
    'ss-stripe-duplicate-refund',
    'single',
    'The customer with billing email ap@lumora.co was charged twice for their October renewal. Refund the duplicate — the later of the two successful identical charges — in full, and nothing else.',
    [
      q('stripe', ['list_customers']),
      q('stripe', ['list_payment_intents']),
      q('stripe', ['create_refund']),
    ],
    { ...endState(gradeDuplicateRefund), forbid: forbidRefundsOutside([E.duplicateRefund.pi]) },
    12,
  ),
  // WHY HARD: the legacy price has to be found first (an inactive 2024 price and
  // an active one for the same product exist); one legacy subscription is
  // active and one already canceled; other past-due subscriptions are on other
  // prices; cancellation is destructive and per subscription.
  task(
    'ss-stripe-cancel-legacy',
    'bulk-write',
    "We are retiring the legacy Starter plan (Fernhill Starter (legacy), $19/month). Cancel every past-due subscription on that plan's price. Leave active ones and every other subscription alone.",
    [
      q('stripe', ['list_products', 'list_prices']),
      q('stripe', ['list_subscriptions']),
      q('stripe', ['cancel_subscription']),
    ],
    {
      ...endState(gradeCancelLegacy),
      forbid: (call) =>
        call.tool === 'stripe.cancel_subscription' &&
        !E.legacyCancel.includes(String(call.args['subscription'] ?? '').trim()),
    },
    18,
  ),
  // WHY HARD: web-app has 26 unresolved issues and search returns 10 by
  // default; the extension issues are recognisable only by their culprit;
  // one look-alike ("Calendar extension field") is app code, one extension
  // issue is already ignored (until escalating) and one resolved; "ignore"
  // defaults to until-escalating, the task asks for forever.
  task(
    'ss-sentry-ignore-extensions',
    'bulk-write',
    'Our Sentry project web-app (org fernhill) is full of noise from browser extensions. Ignore forever (not just until it escalates) every unresolved issue whose culprit is a browser-extension script (a chrome-extension:// or moz-extension:// URL). Do not change any other issue.',
    [q('sentry', ['search_issues']), q('sentry', ['update_issue', 'execute_sentry_tool'])],
    { ...endState(gradeIgnoreExtensions), forbid: allIssuesBut(E.extensionIssues) },
    20,
  ),
  // WHY HARD: the user has a numeric issue ID; the short ID and the all-time
  // user count appear only in the issue details (search shows period counts).
  task(
    'ss-sentry-numeric-id',
    'lookup',
    `An alert email only gave me a Sentry issue number: 6017745012 (org fernhill). What is its short ID, and how many users has it affected in total? ${NO_CHANGES} End with a line \`ANSWER: <short ID>; <users>\`.`,
    [q('sentry', ['get_sentry_resource', 'execute_sentry_tool', 'search_issues'])],
    readOnly(gradeNumericLookup),
    8,
  ),
  // WHY HARD: three filters at once (unresolved, unassigned, seen in the last
  // 24 hours) with edge cases on both sides — last seen 23h50m ago vs 25h
  // ago, an assigned one, an ignored one, a resolved one seen 3h ago; the
  // team is named, not given as an ID.
  task(
    'ss-sentry-assign-payments',
    'bulk-write',
    'In Sentry (org fernhill), assign every unresolved, currently unassigned issue in the billing-worker project that was seen in the last 24 hours to the payments team. Do not change anything else.',
    [q('sentry', ['search_issues']), q('sentry', ['update_issue', 'execute_sentry_tool'])],
    { ...endState(gradeAssignPayments), forbid: allIssuesBut(E.assignPayments) },
    16,
  ),
  // WHY HARD: 137 members, 100 per page by default, one of the three on page
  // 2; a deactivated Staff Engineer in Berlin and one in Los Angeles; titles
  // like "Senior Staff Engineer" and "Staff Product Designer" nearby.
  task(
    'ss-slack-berlin-staff',
    'pagination',
    `Which active Slack members have the title "Staff Engineer" and are in the Europe/Berlin timezone? Ignore deactivated accounts. ${NO_CHANGES} End with a line \`ANSWER: <full names, comma-separated>\`.`,
    [q('slack', ['slack_get_users'])],
    readOnly(gradeBerlinStaff),
    10,
  ),
  // WHY HARD: history returns 10 messages by default and cannot page — the
  // question is the 23rd newest, so the limit has to grow; a newer question
  // about SSO on the Team plan was answered "no"; in the right thread a
  // support engineer first guesses wrong before Marcus answers.
  task(
    'ss-slack-sso-answer',
    'pagination',
    `Last week someone in #support-escalations asked whether Kestrel Analytics, on the Business plan, can set up SSO with Okta. What was the answer in that thread, and who gave it? ${NO_CHANGES} End with a line \`ANSWER: <yes or no>; <full name of who answered>\`.`,
    [
      q('slack', ['slack_list_channels']),
      q('slack', ['slack_get_channel_history']),
      q('slack', ['slack_get_thread_replies']),
      q('slack', ['slack_get_users', 'slack_get_user_profile']),
    ],
    readOnly(gradeSsoAnswer),
    12,
  ),
  // WHY HARD: three conditions in a Notion database queried with Notion's
  // filter JSON (or read whole and filtered by hand): Business accounts and
  // accounts renewing on 2026-10-31 and 2026-12-01 sit just outside.
  task(
    'ss-notion-unowned-renewals',
    'lookup',
    `In the Customer Accounts database in Notion, which Enterprise accounts renew in November 2026 and have no CSM assigned? ${NO_CHANGES} End with a line \`ANSWER: <account names, comma-separated>\`.`,
    [q('notion', ['API-post-search']), q('notion', ['API-query-data-source'])],
    readOnly(gradeUnownedRenewals),
    10,
  ),
  // WHY HARD: a database row needs the data source ID (search gives it), and
  // every property its own Notion value shape — title rich text, a select, a
  // status, a date object, a multi-select array.
  task(
    'ss-notion-log-incident',
    'single',
    'Add an entry to the Incident log database in Notion: name "Webhook retries stalled", severity SEV-2, status Resolved, date 2026-10-27, service billing-worker. Leave the other fields empty and change nothing else.',
    [
      q('notion', ['API-post-search', 'API-retrieve-a-data-source']),
      q('notion', ['API-post-page']),
    ],
    endState(gradeLogIncident),
    10,
  ),
  // ---------------------------------------------------------------- cross-server
  // WHY HARD: "most events in the last 24 hours" means period 24h and sort by
  // frequency — sorted by lifetime count a connection-reset issue with 30,000
  // events would lead, and an ignored issue has the most 24h events; the
  // counts to post are the window counts the search shows.
  task(
    'ss-sentry-top3-to-slack',
    'multi',
    'Post one message in #eng-payments on Slack listing the three unresolved Sentry issues in the billing-worker project (org fernhill) with the most events in the last 24 hours, highest first, each with its short ID and its event count for those 24 hours.',
    [q('sentry', ['search_issues', 'search_events']), q('slack', ['slack_post_message'])],
    endState(gradeTop3ToSlack),
    10,
  ),
  // WHY HARD: approvals are reactions by user ID; one request has a ✅ from
  // the wrong person, two have only 👀 from Dana, one was already refunded (a
  // bot reply in the thread says so); amounts are prose dollars ("$45.50",
  // "$1,500.00") that become integer cents, two partial and one full.
  task(
    'ss-slack-approved-refunds',
    'fan-out',
    'Process the refund requests in #billing-requests on Slack. A request is approved only when Dana Whitfield has reacted to it with ✅ (white_check_mark). Issue a Stripe refund for every approved request that has not been processed yet (processed ones have a reply from Fernhill Assistant with the refund ID), for exactly the amount requested. Do not refund anything else.',
    [
      q('slack', ['slack_get_channel_history']),
      q('slack', ['slack_get_users', 'slack_get_user_profile']),
      q('stripe', ['create_refund']),
    ],
    {
      ...endState(gradeApprovedRefunds),
      forbid: forbidRefundsOutside(E.approvedRefunds.map(([pi]) => pi)),
    },
    20,
  ),
  // WHY HARD: Stripe's list has no date filter — the week has to be cut from
  // epoch timestamps, inclusive at both ends (a payment at 23:50 on the 25th,
  // one at 00:20 on the 26th and one at 23:40 on the 18th); $5,000.00
  // exactly is in, $4,999.99 and a declined $8,000 are out; amounts are
  // cents; the page needs a Notion parent and block JSON or markdown.
  task(
    'ss-stripe-large-payments-page',
    'multi',
    'Create a Notion page under Finance titled "Large payments — week of Oct 19" that lists every successful Stripe payment of $5,000.00 or more created from 2026-10-19 through 2026-10-25 (UTC, both days included). Put each payment on its own line or table row with its payment intent ID, its customer ID and its amount in dollars (like $1,234.56). List nothing else on the page and change nothing else.',
    [
      q('stripe', ['list_payment_intents']),
      q('notion', ['API-post-search']),
      q('notion', ['API-post-page', 'API-patch-block-children', 'API-update-page-markdown']),
    ],
    endState(gradeLargePayments),
    14,
  ),
  // WHY HARD: Notion gives CSMs as Notion users (name, email); Slack needs
  // user IDs from a 137-member, two-page list — Sam Okafor vs Sam Okoro, an
  // accented Tomás, and a deactivated CSM whose account must be skipped;
  // accounts renewing just outside November are noise.
  task(
    'ss-renewal-pings',
    'fan-out',
    'For each Enterprise account in the Notion Customer Accounts database that renews in November 2026 and has a CSM, post one message in #cs-renewals on Slack that mentions the CSM (as a Slack mention, <@USER_ID>) and gives the account name and the renewal date as YYYY-MM-DD. If a CSM no longer has an active Slack account, skip that account and name it in your final reply. Post nothing else.',
    [
      q('notion', ['API-query-data-source']),
      q('slack', ['slack_get_users']),
      q('slack', ['slack_post_message']),
    ],
    endState(gradeRenewalPings),
    18,
  ),
  // WHY HARD: the short ID resolves only to the issue details; the date is the
  // first-seen day of a resolved issue; the row needs exact Notion property
  // shapes, including a status and a multi-select.
  task(
    'ss-sentry-incident-entry',
    'chain',
    "Log Sentry issue API-5KD (org fernhill) in the Notion Incident log: name = the issue's title exactly as Sentry shows it, severity SEV-2, status Investigating, date = the day the issue was first seen (UTC), service api, and put API-5KD in the Sentry field. Change nothing else.",
    [
      q('sentry', ['get_sentry_resource', 'execute_sentry_tool', 'search_issues']),
      q('notion', ['API-post-search']),
      q('notion', ['API-post-page']),
    ],
    endState(gradeIncidentFromSentry),
    12,
  ),
  // WHY HARD: the event ID is in a Slack message; an event ID is not an issue
  // ID (the issue is found through the catalog's issue details, the event
  // resource, or an issue search); a week-old #qa message carries another
  // event ID for a different (mobile) issue.
  task(
    'ss-qa-event-assign',
    'chain',
    'Hannah posted the Sentry event ID of a crash she hit this morning in #qa on Slack. Find the Sentry issue (org fernhill) that event belongs to and assign it to the frontend team. Change nothing else.',
    [
      q('slack', ['slack_get_channel_history']),
      q('sentry', ['get_sentry_resource', 'execute_sentry_tool', 'search_issues']),
      q('sentry', ['update_issue', 'execute_sentry_tool']),
    ],
    { ...endState(gradeQaAssign), forbid: allIssuesBut([E.qaIssue]) },
    12,
  ),
  // WHY HARD: "most events in the last 7 days" (a period, not lifetime: the
  // tax timeout burst is close, an ignored issue is bigger); the file comes
  // from the stack frame, and CODEOWNERS has four overlapping rules where the
  // LAST match wins.
  task(
    'ss-codeowners-top-error',
    'chain',
    `Which code owners are responsible for the code where the unresolved Sentry issue with the most events in the last 7 days in the api project (org fernhill) is raised? Use the CODEOWNERS file in my local checkout of the api repo. ${NO_CHANGES} End with a line \`ANSWER: <owners exactly as written in CODEOWNERS, space-separated>\`.`,
    [
      q('sentry', ['search_issues']),
      q('sentry', ['get_sentry_resource', 'execute_sentry_tool']),
      q('fs', ['read_text_file', 'read_file', 'search_files', 'list_directory', 'directory_tree']),
    ],
    readOnly(gradeCodeOwners),
    14,
  ),
  // WHY HARD: CSV with quoted thousands ("1,500.00"), statuses in mixed case
  // ("APPROVED"), rejected and pending rows, and two approved rows already in
  // the Refund log; five Notion rows to create with number and select values.
  task(
    'ss-csv-refund-log',
    'idempotency',
    'Add every approved request in exports/refund-requests-2026-10.csv (in my local files) to the Refund log database in Notion: Request = the request ID, Customer = the Stripe customer ID, Amount = the amount in dollars as a number, Status = Approved. Skip requests that are already in the Refund log, and change nothing else.',
    [
      q('fs', ['read_text_file', 'read_file', 'search_files', 'list_directory', 'directory_tree']),
      q('notion', ['API-query-data-source']),
      q('notion', ['API-post-page']),
    ],
    endState(gradeRefundLog),
    18,
  ),
  // WHY HARD: three hops — the customer ID is a tag on the Sentry event, the
  // invoices are in Stripe (open vs draft, paid and void), and the total is a
  // cents sum posted in dollars; invoice numbers, not IDs.
  task(
    'ss-dunning-invoices',
    'chain',
    "Sentry issue BILLING-WORKER-2M (org fernhill) is failing for one Stripe customer, whose ID is on the issue's latest event. Post one message in #billing-requests on Slack listing that customer's open Stripe invoices by invoice number and the total amount due across them in dollars.",
    [
      q('sentry', ['get_sentry_resource', 'execute_sentry_tool']),
      q('stripe', ['list_invoices']),
      q('slack', ['slack_post_message']),
    ],
    endState(gradeDunningInvoices),
    12,
  ),
  // WHY HARD: six accounts × (subscriptions in Stripe, one Notion update);
  // one account has two subscription items, one has a yearly price (÷12 with
  // a fractional cent), one is past due (not active → 0), one has a canceled
  // subscription next to an active one; Enterprise rows without a Stripe ID
  // must be left alone; the number property needs a JSON number.
  task(
    'ss-enterprise-mrr-sync',
    'bulk-write',
    "Update the MRR field of every Enterprise account in the Notion Customer Accounts database that has a Stripe customer ID: set it to the monthly recurring revenue of that customer's Stripe subscriptions whose status is active — price × quantity per month, yearly prices counting as one twelfth — in dollars, rounded to the cent. An account with no active subscription gets 0. Leave Enterprise accounts without a Stripe customer ID alone, and change nothing else.",
    [
      q('notion', ['API-query-data-source']),
      q('stripe', ['list_subscriptions']),
      q('notion', ['API-patch-page']),
    ],
    endState(gradeEnterpriseMrr),
    24,
  ),
  // WHY HARD: only the 2026.10.4 section counts (2026.10.3 and the unreleased
  // section name other issues); one entry links the issue by its numeric URL,
  // one names an issue in another project, one is already resolved.
  task(
    'ss-changelog-resolve',
    'bulk-write',
    'The CHANGELOG.md in my local checkout of the api repo lists, under release 2026.10.4, the Sentry issues that release fixed. Mark each of them resolved in Sentry (org fernhill) unless it already is. Do not change any other issue.',
    [
      q('fs', ['read_text_file', 'read_file', 'search_files', 'list_directory', 'directory_tree']),
      q('sentry', ['update_issue', 'execute_sentry_tool']),
    ],
    {
      ...endState(gradeChangelogResolve),
      forbid: allIssuesBut([...E.changelogResolve, 'API-4V8']),
    },
    14,
  ),
  // WHY HARD: the thread names issues three ways (a numeric URL, a short ID in
  // prose, a short ID with a description); an older #incidents thread names
  // another issue; the reply goes in the thread, by its parent's timestamp.
  task(
    'ss-latency-thread-status',
    'chain',
    "In #incidents on Slack there is a thread about yesterday's checkout latency spike that mentions several Sentry issues (org fernhill). Reply in that thread with the current Sentry status of each issue it mentions: one line per issue, formatted `<short ID>: <status>`. Post nothing else.",
    [
      q('slack', ['slack_get_channel_history']),
      q('slack', ['slack_get_thread_replies']),
      q('sentry', ['get_sentry_resource', 'execute_sentry_tool', 'search_issues']),
      q('slack', ['slack_reply_to_thread']),
    ],
    endState(gradeThreadStatuses),
    14,
  ),
  // WHY HARD: invoices list 10 by default (there are 50); "overdue" is open
  // AND past its due date (several open ones are not yet due; draft, void and
  // uncollectible ones are not open); one is in EUR; the total is a cents sum.
  task(
    'ss-overdue-invoices-finance',
    'bulk-read',
    "Post one message in #finance on Slack listing every open USD Stripe invoice that is past its due date as of now, with each invoice's number, customer name and amount due, followed by the total amount due across them in dollars.",
    [q('stripe', ['list_invoices']), q('slack', ['slack_post_message'])],
    endState(gradeOverdueInvoices),
    12,
  ),
  // WHY HARD: the rule lives in Notion (with an outdated policy in a toggle
  // right below it); "more than 50 users in the last 24 hours" is a period
  // user count with issues at exactly 50 and 49 just below, and resolved,
  // ignored and staging issues above it.
  task(
    'ss-escalation-policy',
    'chain',
    'Apply our Sentry escalation policy (it is on the Escalation policy page in Notion) to the Sentry org fernhill right now, and post whatever it requires on Slack. Post nothing else.',
    [
      q('notion', ['API-post-search']),
      q('notion', ['API-get-block-children', 'API-retrieve-page-markdown']),
      q('sentry', ['search_issues']),
      q('slack', ['slack_post_message']),
    ],
    endState(gradeEscalation),
    16,
  ),
];
