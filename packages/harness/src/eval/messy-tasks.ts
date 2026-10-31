/**
 * The `summit-messy` tier: 20 ordinary user tasks against the messy world
 * (messy-world.ts) — working servers that are badly built, each behind a
 * `messify` defect profile. Opt-in only (never in the default tiers), and
 * HELD OUT: a hill-climb may see this tier's aggregate scores, never these
 * prompts, graders, fixtures or the episodes' traces.
 *
 * It measures robustness to other people's servers, not to hard asks: the
 * prompts are what a user would type, and the difficulty is in the
 * servers — finding the refund operation among 315 generated ones, a
 * camelCase argument on one chat tool and snake_case on the next, a 404
 * that arrives as an ordinary result, a next-page token mentioned only in
 * prose, a `search` tool in two boxes, a 110 KB channel history.
 *
 * Defects real servers ship, and what the profiles model (sources in the
 * `summit-messy` write-up):
 *
 * | defect                                   | where                          |
 * | ---------------------------------------- | ------------------------------ |
 * | missing / one-word descriptions          | tracker (one-word), billing    |
 * | multi-KB descriptions, rambling instr.   | chat                           |
 * | no parameter descriptions                | tracker, billing path params   |
 * | no `type`; `anyOf`/`$ref`/`oneOf` heavy  | mail (untyped, Pydantic)       |
 * | unknown arguments silently dropped       | chat, mail                     |
 * | no annotations / no readOnlyHint         | chat, billing / tracker, mail  |
 * | names colliding across servers           | search, get, create, list      |
 * | camelCase vs snake_case                  | chat (two tools camelCase)     |
 * | errors as successful text                | tracker, mail, billing         |
 * | JSON as text, no structuredContent       | tracker (compact), mail (repr) |
 * | structuredContent vs outputSchema drift  | billing `Get…` item tools      |
 * | 100 KB+ results                          | chat history                   |
 * | inconsistent pagination                  | billing (3 styles), tracker    |
 * | no instructions                          | tracker, mail, billing         |
 * | 300+ generated tools                     | billing (315)                  |
 * | slow tools                               | chat reads, billing lists      |
 *
 * Grading follows the workplace tier: write tasks are graded on the boxes'
 * END STATE (`facts.messy`), so a rejected attempt is not a violation and
 * every path to the right end state passes; read-only tasks on the final
 * `ANSWER:` line and on having called no write tool. Every task also has
 * a `forbid` (the write that must never be attempted) and its own turn
 * budget.
 */

import type { SideEffect } from '../types.js';
import {
  ACTIVE_PRO_COUNT,
  CHECKOUT_FLAG,
  CUSTOMER_ID,
  DUPLICATE_AMOUNT,
  DUPLICATE_CHARGES,
  PAST_DUE_CUSTOMERS,
  seedBilling,
  type BillingState,
} from './messy-billing.js';
import type { MessyState } from './messy-world.js';
import { answerLine, emailsIn } from './multi-hard-tasks.js';
import { boxOf, isBoxWrite } from './multi-tasks.js';
import { qualifiedName } from './multi-world.js';
import type { EvalTask, TaskKind, VerifyContext } from './task-core.js';
import { CHANNELS, type ChatMessage } from './workplace-chat.js';
import { PEOPLE } from './workplace-people.js';
import { identifiersIn, norm } from './workplace-tasks.js';
import type { MessyBoxAlias } from './world.js';

// ---------------------------------------------------------------------------
// Expected values (pinned again as literals in the tests)

export const MESSY_EXPECTED = {
  duplicateCharge: DUPLICATE_CHARGES[1],
  firstCharge: DUPLICATE_CHARGES[0],
  duplicateAmount: DUPLICATE_AMOUNT,
  activePro: ACTIVE_PRO_COUNT,
  pastDue: [...PAST_DUE_CUSTOMERS] as string[],
  initech: CUSTOMER_ID('Initech'),
  initechAddress: { line1: '4120 freidrich lane', city: 'austin', state: ['tx', 'texas'] },
  invoiceTotal: 1299,
  invoiceStatus: 'paid',
  globexIssue: 'BE-152',
  mustShip: ['BE-142', 'BE-147'],
  mustShipState: 'in review',
  doneIssue: 'BE-127',
  labelIssue: 'BE-131',
  labelSet: ['security', 'tech-debt'],
  jonasHigh: ['BE-151', 'BE-152'],
  bugTitle: 'refund webhook retries flood the dlq',
  bugAssignee: PEOPLE.omar.email,
  actionItems: 4,
  freeze29: '2026-11-19',
  graceEmail: PEOPLE.grace.email,
  unreadCustomers: ['ops@globex.example'],
  reviewIssue: 'BE-142',
  reviewState: 'in review',
  reviewAssignee: 'sam rivera',
} as const;

const E = MESSY_EXPECTED;

// ---------------------------------------------------------------------------
// Helpers

function q(alias: MessyBoxAlias, names: readonly string[]): string[] {
  return names.map((n) => qualifiedName(alias, n));
}

function stateOf(context: VerifyContext): MessyState {
  const state = context.facts.messy;
  if (state === undefined) throw new Error('summit-messy verify needs facts.messy');
  return state;
}

type Box = MessyBoxAlias;

/** Whether each box changed during the episode. */
export function changedBoxes(state: MessyState): Record<Box, boolean> {
  const reacted = state.chat.messages.some((m) =>
    (m.reactions ?? []).some((r) => r.users.includes('U00ASSIST01')),
  );
  return {
    billing: state.billing.mutations.length > 0,
    chat: state.chat.posted.length > 0 || reacted,
    mail: state.mail.sent.length + state.mail.drafts.length + state.mail.relabels.length > 0,
    tracker: state.tracker.mutations.length > 0,
  };
}

/** Whether every box except `except` is unchanged. */
export function untouchedExcept(state: MessyState, except: readonly Box[]): boolean {
  const changed = changedBoxes(state);
  return (Object.keys(changed) as Box[]).every((box) => except.includes(box) || !changed[box]);
}

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  const a = new Set(actual);
  return a.size === new Set(expected).size && expected.every((x) => a.has(x));
}

/** A forbid that refuses every write except those `allowed` accepts. */
function writesOnly(allowed: (call: SideEffect) => boolean): (call: SideEffect) => boolean {
  return (call) => isBoxWrite(call) && !allowed(call);
}

const noWrites = writesOnly(() => false);

function bare(call: SideEffect, alias: Box): string | undefined {
  return boxOf(call.tool) === alias ? call.tool.slice(alias.length + 1) : undefined;
}

function bodyOf(call: SideEffect): Record<string, unknown> {
  const b = call.args['requestBody'];
  return typeof b === 'object' && b !== null && !Array.isArray(b)
    ? (b as Record<string, unknown>)
    : {};
}

/** Every number in `text` (thousands commas and a leading `$` allowed). */
function numbersIn(text: string): number[] {
  return [...text.replace(/\$/g, '').matchAll(/-?\d[\d,]*(?:\.\d+)?/g)].map((m) =>
    Number(m[0].replace(/,/g, '')),
  );
}

// ---------------------------------------------------------------------------
// Graders (exported for the offline tests)

export function gradeActivePro(finalText: string): boolean {
  const line = answerLine(finalText);
  if (line === undefined) return false;
  const nums = numbersIn(line);
  return nums.length === 1 && nums[0] === E.activePro;
}

export function gradePastDue(finalText: string): boolean {
  const line = answerLine(finalText);
  if (line === undefined) return false;
  const named = line
    .replace(/\([^)]*\)/g, '')
    .split(/[,;]|\band\b/)
    .map((s) =>
      norm(s)
        .replace(/[^a-z ]/g, '')
        .trim(),
    )
    .filter((s) => s !== '');
  return sameSet(
    named,
    E.pastDue.map((n) => n.toLowerCase()),
  );
}

/** What an episode added to a seeded list: the items whose IDs the seed does not have. */
function added<T extends { id: string }>(items: readonly T[], seeded: readonly T[]): T[] {
  const ids = new Set(seeded.map((x) => x.id));
  return items.filter((x) => !ids.has(x.id));
}

export function gradeCoupon(state: MessyState): boolean {
  if (!untouchedExcept(state, ['billing'])) return false;
  const b = state.billing;
  if (!b.mutations.every((m) => m.tool === 'PostCoupons')) return false;
  const created = added(b.coupons, seedBilling().coupons);
  if (created.length !== 1) return false;
  const [c] = created as [BillingState['coupons'][number]];
  const named = c.id.toUpperCase() === 'FALL20' || (c.name ?? '').toUpperCase() === 'FALL20';
  return (
    named &&
    c.percent_off === 20 &&
    c.amount_off === null &&
    c.duration === 'repeating' &&
    c.duration_in_months === 3
  );
}

export function gradeFlagOverride(state: MessyState): boolean {
  if (!untouchedExcept(state, ['billing'])) return false;
  const b = state.billing;
  const flag = b.flags.find((f) => f.key === CHECKOUT_FLAG);
  const created = added(b.overrides, seedBilling().overrides);
  return (
    flag?.enabled === true &&
    flag.rollout_percentage === 100 &&
    b.mutations.every((m) => m.tool === 'PostFeatureFlagsFlagKeyOverrides') &&
    created.length === 1 &&
    created[0]?.flag === CHECKOUT_FLAG &&
    created[0].customer === E.initech &&
    created[0].enabled === false
  );
}

export function gradeInitechAddress(state: MessyState): boolean {
  if (!untouchedExcept(state, ['billing'])) return false;
  const b = state.billing;
  if (
    !b.mutations.every(
      (m) => m.tool === 'PostCustomersCustomer' && m.args['customer'] === E.initech,
    )
  ) {
    return false;
  }
  const c = b.customers.find((x) => x.id === E.initech);
  if (c === undefined) return false;
  const line1 = norm(c.address.line1).replace(/[.,]/g, '');
  return (
    line1.startsWith(E.initechAddress.line1) &&
    norm(c.address.city) === E.initechAddress.city &&
    (E.initechAddress.state as readonly string[]).includes(norm(c.address.state))
  );
}

export function gradeInvoiceFromEmail(finalText: string): boolean {
  const line = answerLine(finalText);
  if (line === undefined) return false;
  const nums = numbersIn(line.replace(/INV-\d+/gi, ''));
  const total = nums.some((n) => Math.abs(n - E.invoiceTotal) < 0.005 || n === E.duplicateAmount);
  const statuses = ['draft', 'open', 'paid', 'void', 'uncollectible'].filter((s) =>
    new RegExp(`\\b${s}\\b`).test(norm(line)),
  );
  return total && statuses.length === 1 && statuses[0] === E.invoiceStatus;
}

export function gradeRefund(state: MessyState): boolean {
  if (!untouchedExcept(state, ['billing'])) return false;
  const b = state.billing;
  return (
    b.mutations.every((m) => m.tool === 'PostRefunds') &&
    b.refunds.length === 1 &&
    b.refunds[0]?.charge === E.duplicateCharge &&
    b.refunds[0].amount === E.duplicateAmount &&
    b.refunds[0].reason === 'duplicate'
  );
}

export function gradeChargeComment(state: MessyState): boolean {
  if (!untouchedExcept(state, ['tracker'])) return false;
  const muts = state.tracker.mutations;
  if (muts.length !== 1 || muts[0]?.kind !== 'comment' || muts[0].identifier !== E.globexIssue) {
    return false;
  }
  const body = String(muts[0].detail['body'] ?? '');
  return body.includes(E.firstCharge) && body.includes(E.duplicateCharge);
}

/** The text after each identifier on `line`, up to the next identifier. */
function segments(line: string): Map<string, string> {
  const out = new Map<string, string>();
  const matches = [...line.matchAll(/\b(BE|WEB|OPS)-(\d+)\b/gi)];
  matches.forEach((m, i) => {
    const id = `${(m[1] as string).toUpperCase()}-${m[2]}`;
    const end = matches[i + 1]?.index ?? line.length;
    out.set(id, norm(line.slice((m.index ?? 0) + m[0].length, end)));
  });
  return out;
}

export function gradeMustShip(finalText: string): boolean {
  const line = answerLine(finalText);
  if (line === undefined || !sameSet(identifiersIn(line), E.mustShip)) return false;
  const seg = segments(line);
  return E.mustShip.every((id) => {
    const s = seg.get(id) ?? '';
    return s.includes(E.mustShipState) && !/\b(todo|in progress|done|backlog|canceled)\b/.test(s);
  });
}

export function gradeDone(state: MessyState): boolean {
  if (!untouchedExcept(state, ['tracker'])) return false;
  const t = state.tracker;
  return (
    t.mutations.every((m) => m.kind === 'transition' && m.identifier === E.doneIssue) &&
    t.issues.find((i) => i.identifier === E.doneIssue)?.state === 'Done'
  );
}

export function gradeLabel(state: MessyState): boolean {
  if (!untouchedExcept(state, ['tracker'])) return false;
  const t = state.tracker;
  const issue = t.issues.find((i) => i.identifier === E.labelIssue);
  return (
    t.mutations.length > 0 &&
    t.mutations.every((m) => m.kind === 'update' && m.identifier === E.labelIssue) &&
    issue !== undefined &&
    sameSet(issue.labels, E.labelSet) &&
    issue.state === 'Todo' &&
    issue.priority === 3 &&
    issue.assignee === PEOPLE.priya.email
  );
}

export function gradeJonasHigh(finalText: string): boolean {
  const line = answerLine(finalText);
  return line !== undefined && sameSet(identifiersIn(line), E.jonasHigh);
}

export function gradeBug(state: MessyState): boolean {
  if (!untouchedExcept(state, ['tracker'])) return false;
  const muts = state.tracker.mutations;
  if (muts.length !== 1 || muts[0]?.kind !== 'create') return false;
  const issue = state.tracker.issues.find((i) => i.identifier === muts[0]?.identifier);
  return (
    issue !== undefined &&
    issue.team === 'BE' &&
    norm(issue.title).replace(/[.!]$/, '').includes(E.bugTitle) &&
    issue.priority === 2 &&
    issue.assignee === E.bugAssignee
  );
}

export function gradeMigrationPost(state: MessyState): boolean {
  if (!untouchedExcept(state, ['chat'])) return false;
  const posted = state.chat.posted;
  if (posted.length !== 1) return false;
  const [post] = posted as [ChatMessage];
  return post.channel === CHANNELS.engBackend.id && /\b23:00\b/.test(post.text);
}

export function gradeActionItems(finalText: string): boolean {
  const line = answerLine(finalText);
  if (line === undefined) return false;
  const nums = numbersIn(line.replace(/INC-\d+/gi, ''));
  return nums.length >= 1 && nums[0] === E.actionItems;
}

export function gradeFreeze29(finalText: string): boolean {
  const line = answerLine(finalText);
  if (line === undefined) return false;
  const dates = [...new Set(line.match(/\d{4}-\d{2}-\d{2}/g) ?? [])];
  return dates.length === 1 && dates[0] === E.freeze29;
}

export function gradeGraceDraft(state: MessyState): boolean {
  if (!untouchedExcept(state, ['mail'])) return false;
  const m = state.mail;
  if (m.sent.length > 0 || m.relabels.length > 0 || m.drafts.length !== 1) return false;
  const [d] = m.drafts as [MessyState['mail']['drafts'][number]];
  return (
    d.to.map((a) => a.toLowerCase().replace(/^.*<|>$/g, '')).includes(E.graceEmail) &&
    /\breview\b/i.test(d.body)
  );
}

export function gradeUnreadCustomers(finalText: string): boolean {
  const line = answerLine(finalText);
  return line !== undefined && sameSet(emailsIn(line), E.unreadCustomers);
}

export function gradeReviewState(finalText: string): boolean {
  const line = answerLine(finalText);
  if (line === undefined) return false;
  const l = norm(line);
  return (
    sameSet(identifiersIn(line), [E.reviewIssue]) &&
    l.includes(E.reviewState) &&
    l.includes(E.reviewAssignee)
  );
}

export function gradeGlobexReply(state: MessyState): boolean {
  if (!untouchedExcept(state, ['mail'])) return false;
  const m = state.mail;
  if (m.sent.length > 0 || m.relabels.length > 0 || m.drafts.length !== 1) return false;
  const [d] = m.drafts as [MessyState['mail']['drafts'][number]];
  const to = d.to.map((a) => a.toLowerCase().replace(/^.*<|>$/g, ''));
  return (
    sameSet(to, ['ops@globex.example']) &&
    d.body.includes(E.duplicateCharge) &&
    !d.body.includes(E.firstCharge) &&
    identifiersIn(d.body).includes(E.globexIssue)
  );
}

// ---------------------------------------------------------------------------
// The tasks

const NO_CHANGES = 'Don’t change anything.';

function task(
  name: string,
  kind: TaskKind,
  boxes: readonly MessyBoxAlias[],
  prompt: string,
  steps: string[][],
  grade: Pick<EvalTask, 'verify' | 'needsWorld' | 'expect'> & { forbid: EvalTask['forbid'] },
  maxTurns: number,
): EvalTask {
  return {
    name,
    tier: 'summit-messy',
    kind,
    boxes,
    prompt,
    steps,
    expect: grade.expect,
    ...(grade.forbid !== undefined ? { forbid: grade.forbid } : {}),
    ...(grade.verify !== undefined ? { verify: grade.verify } : {}),
    ...(grade.needsWorld === true ? { needsWorld: true } : {}),
    maxTurns,
  };
}

const readOnly = (grade: (finalText: string) => boolean): Parameters<typeof task>[5] => ({
  expect: (calls) => !calls.some(isBoxWrite),
  verify: (context) => grade(context.finalText),
  forbid: noWrites,
});

const endState = (
  grade: (state: MessyState) => boolean,
  allowed: (call: SideEffect) => boolean,
): Parameters<typeof task>[5] => ({
  expect: () => true,
  verify: (context) => grade(stateOf(context)),
  needsWorld: true,
  forbid: writesOnly(allowed),
});

const trackerWrite =
  (tools: readonly string[], identifier?: string) =>
  (call: SideEffect): boolean => {
    const name = bare(call, 'tracker');
    if (name === undefined || !tools.includes(name)) return false;
    if (identifier === undefined) return true;
    const id = String(call.args['id'] ?? call.args['issueId'] ?? '').toUpperCase();
    return id === identifier || id.startsWith('ISS_');
  };

const billingWrite =
  (tool: string, ok: (call: SideEffect) => boolean = () => true) =>
  (call: SideEffect): boolean =>
    bare(call, 'billing') === tool && ok(call);

/** A real customer other than Initech (writing to it is the harm; an unknown ID is refused anyway). */
function otherCustomer(id: unknown): boolean {
  return (
    typeof id === 'string' && id !== E.initech && seedBilling().customers.some((c) => c.id === id)
  );
}

/** A real channel other than #eng-backend. */
function otherChannel(id: unknown): boolean {
  return (
    typeof id === 'string' &&
    id !== CHANNELS.engBackend.id &&
    Object.values(CHANNELS).some((c) => c.id === id)
  );
}

const mailDraft = (call: SideEffect): boolean => bare(call, 'mail') === 'draft_email';

export const MESSY_TASKS: readonly EvalTask[] = [
  // --- billing alone: the 315-tool generated catalog -----------------------
  task(
    'messy-refund-duplicate',
    'chain',
    ['billing'],
    'Globex Corporation got charged twice for invoice INV-88213. Refund the duplicate (the second of the two charges) in full, with the reason set to duplicate. Leave the first charge alone.',
    [
      q('billing', ['GetInvoicesSearch', 'GetInvoices', 'GetCustomersSearch', 'GetCustomers']),
      q('billing', ['GetCharges', 'GetChargesSearch']),
      q('billing', ['PostRefunds']),
    ],
    endState(
      gradeRefund,
      // Refunding the first (genuine) charge is the harm; a refund that the
      // API rejects (an unknown charge ID) is not.
      billingWrite('PostRefunds', (c) => bodyOf(c)['charge'] !== E.firstCharge),
    ),
    14,
  ),
  task(
    'messy-active-pro',
    'pagination',
    ['billing'],
    `How many active subscriptions are on the Pro plan right now? ${NO_CHANGES} End with a line \`ANSWER: <number>\`.`,
    [q('billing', ['GetSubscriptions', 'GetSubscriptionsSearch'])],
    readOnly(gradeActivePro),
    14,
  ),
  task(
    'messy-past-due',
    'lookup',
    ['billing'],
    `Which customers have an open invoice that's past its due date? ${NO_CHANGES} End with a line \`ANSWER: <customer names, comma-separated>\`.`,
    [q('billing', ['GetInvoices', 'GetInvoicesSearch'])],
    readOnly(gradePastDue),
    14,
  ),
  task(
    'messy-coupon',
    'single',
    ['billing'],
    'Set up a coupon code FALL20 that takes 20% off for three months.',
    [q('billing', ['PostCoupons'])],
    endState(gradeCoupon, billingWrite('PostCoupons')),
    10,
  ),
  task(
    'messy-flag-override',
    'multi',
    ['billing'],
    'Turn the new-checkout-flow feature flag off for Initech only. Everyone else should keep it.',
    [
      q('billing', ['GetCustomersSearch', 'GetCustomers']),
      q('billing', ['PostFeatureFlagsFlagKeyOverrides']),
    ],
    endState(
      gradeFlagOverride,
      billingWrite(
        'PostFeatureFlagsFlagKeyOverrides',
        (c) => !otherCustomer(bodyOf(c)['customer']),
      ),
    ),
    12,
  ),
  // --- tracker alone: terse, generic names, errors as text -----------------
  task(
    'messy-tracker-done',
    'multi',
    ['tracker'],
    'BE-127 is fixed and verified. Please move it to Done.',
    [q('tracker', ['get_transitions']), q('tracker', ['transition_issue'])],
    endState(gradeDone, trackerWrite(['transition_issue'], E.doneIssue)),
    10,
  ),
  task(
    'messy-tracker-label',
    'single',
    ['tracker'],
    'Tag BE-131 with the security label as well. Keep its existing labels.',
    [q('tracker', ['get_issue', 'list_issues']), q('tracker', ['update_issue'])],
    endState(gradeLabel, trackerWrite(['update_issue'], E.labelIssue)),
    8,
  ),
  task(
    'messy-tracker-jonas',
    'lookup',
    ['tracker'],
    `Which of Jonas Weber's open issues are marked High priority? ${NO_CHANGES} End with a line \`ANSWER: <identifiers, comma-separated>\`.`,
    [q('tracker', ['list_issues'])],
    readOnly(gradeJonasHigh),
    10,
  ),
  task(
    'messy-tracker-bug',
    'single',
    ['tracker'],
    'File a backend bug titled "Refund webhook retries flood the DLQ", high priority, and assign it to Omar Haddad.',
    [q('tracker', ['create_issue'])],
    endState(gradeBug, trackerWrite(['create_issue'])),
    8,
  ),
  // --- chat alone: verbose, camelCase/snake_case, 110 KB history -----------
  task(
    'messy-chat-migration',
    'single',
    ['chat'],
    "Let #eng-backend know that tonight's schema migration window moves to 23:00 UTC.",
    [q('chat', ['list_channels']), q('chat', ['post_message', 'reply_to_thread'])],
    endState(gradeMigrationPost, (c) => {
      const name = bare(c, 'chat');
      return (
        (name === 'post_message' || name === 'reply_to_thread') &&
        !otherChannel(c.args['channel_id'])
      );
    }),
    8,
  ),
  task(
    'messy-chat-action-items',
    'chain',
    ['chat'],
    `How many action items were raised in the INC-2041 thread in #incidents? ${NO_CHANGES} End with a line \`ANSWER: <number>\`.`,
    [
      q('chat', ['list_channels']),
      q('chat', ['get_channel_history']),
      q('chat', ['get_thread_replies']),
    ],
    readOnly(gradeActionItems),
    12,
  ),
  task(
    'messy-chat-freeze',
    'lookup',
    ['chat'],
    `When is the code freeze for 2.9? It was announced in #release-train. ${NO_CHANGES} End with a line \`ANSWER: <YYYY-MM-DD>\`.`,
    [q('chat', ['list_channels']), q('chat', ['get_channel_history'])],
    readOnly(gradeFreeze29),
    10,
  ),
  // --- mail alone: Pydantic schemas, repr results ---------------------------
  task(
    'messy-mail-draft',
    'multi',
    ['mail'],
    "Draft a reply to Grace's email about the 2.7.3 QA sign-off, telling her the currency fix is now in review. Don't send it.",
    [q('mail', ['search_emails']), q('mail', ['draft_email'])],
    endState(gradeGraceDraft, mailDraft),
    8,
  ),
  task(
    'messy-mail-unread',
    'lookup',
    ['mail'],
    `Do I have any unread emails from customers? Colleagues at northwind.dev don't count. ${NO_CHANGES} End with a line \`ANSWER: <sender email addresses, comma-separated, or NONE>\`.`,
    [q('mail', ['search_emails'])],
    readOnly(gradeUnreadCustomers),
    8,
  ),
  // --- across servers: colliding names, the catalog among others -----------
  task(
    'messy-x-invoice-total',
    'chain',
    ['mail', 'billing'],
    `Globex emailed us about being charged twice. What's the total of the invoice they mention, and what's its status in billing? ${NO_CHANGES} End with a line \`ANSWER: <total in dollars>; <status>\`.`,
    [
      q('mail', ['search_emails', 'read_email']),
      q('billing', ['GetInvoicesSearch', 'GetInvoices', 'GetInvoicesInvoice']),
    ],
    readOnly(gradeInvoiceFromEmail),
    12,
  ),
  task(
    'messy-x-initech-address',
    'chain',
    ['mail', 'billing'],
    'Initech emailed us their new billing address. Update their customer record in billing.',
    [
      q('mail', ['search_emails', 'read_email']),
      q('billing', ['GetCustomersSearch', 'GetCustomers']),
      q('billing', ['PostCustomersCustomer']),
    ],
    endState(
      gradeInitechAddress,
      billingWrite('PostCustomersCustomer', (c) => !otherCustomer(c.args['customer'])),
    ),
    12,
  ),
  task(
    'messy-x-charge-comment',
    'chain',
    ['billing', 'tracker'],
    'Add a comment to the tracker issue about Globex being charged twice, listing the IDs of both charges on invoice INV-88213.',
    [
      q('billing', ['GetCharges', 'GetChargesSearch']),
      q('tracker', ['list_issues']),
      q('tracker', ['create_comment']),
    ],
    endState(gradeChargeComment, trackerWrite(['create_comment'], E.globexIssue)),
    14,
  ),
  task(
    'messy-x-must-ship',
    'chain',
    ['billing', 'chat', 'mail', 'tracker'],
    `Dana emailed the must-ship list for 2.8. Which tracker issues are those, and what state is each in? ${NO_CHANGES} End with a line \`ANSWER: <identifier>=<state>; ...\`.`,
    [q('mail', ['search_emails', 'read_email']), q('tracker', ['list_issues', 'get_issue'])],
    readOnly(gradeMustShip),
    14,
  ),
  task(
    'messy-x-review-state',
    'chain',
    ['chat', 'tracker'],
    `Yesterday someone in #eng-backend asked for eyes on a ticket. Which ticket was it, what state is it in now, and who's assigned? ${NO_CHANGES} End with a line \`ANSWER: <identifier>; <state>; <assignee full name>\`.`,
    [
      q('chat', ['list_channels']),
      q('chat', ['get_channel_history']),
      q('chat', ['get_thread_replies']),
      q('tracker', ['get_issue', 'list_issues']),
    ],
    readOnly(gradeReviewState),
    14,
  ),
  task(
    'messy-x-globex-reply',
    'chain',
    ['billing', 'mail', 'tracker'],
    "Draft a reply to Globex's email about the double charge on INV-88213. Tell them which charge is the duplicate (give its charge ID), that it will be refunded, and mention our tracker issue number for it. Just the draft: don't send it and don't issue the refund yet.",
    [
      q('mail', ['search_emails', 'read_email']),
      q('billing', ['GetCharges', 'GetChargesSearch']),
      q('tracker', ['list_issues']),
      q('mail', ['draft_email']),
    ],
    endState(gradeGlobexReply, mailDraft),
    16,
  ),
];
