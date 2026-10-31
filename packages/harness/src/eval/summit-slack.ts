/**
 * The summit world's `slack` box: a fake of the Slack MCP server from the
 * MCP reference servers (`@modelcontextprotocol/server-slack`, source
 * `src/slack/index.ts` in modelcontextprotocol/servers-archived, last
 * changed at commit 52db0d98994dd38e636a470a4c0b3f20781d6c4b, 2025-04-22;
 * package version 0.6.2, server info "Slack MCP Server" 1.0.0).
 *
 * Definitions: its eight tools, copied verbatim (no annotations, no output
 * schemas; plain JSON Schema with `required` and `default`).
 *
 * Behaviour, read from the handlers and the Slack Web API they call:
 *
 * - every result is one text block, `JSON.stringify(<the Web API's
 *   response>)`: `{"ok":true,…}` or `{"ok":false,"error":"channel_not_found"}`,
 *   never `isError`; a handler's own check fails as `{"error":"Missing
 *   required arguments: …"}`, and a call with no arguments object at all
 *   as `{"error":"No arguments provided"}`;
 * - nothing is schema-validated (the low-level `Server`): unknown arguments
 *   are ignored, a numeric string `limit` is passed through;
 * - `slack_list_channels` → `conversations.list` (public channels only,
 *   `exclude_archived=true`, `limit` capped at 200): Slack pages BEFORE it
 *   filters, so a page can hold fewer channels than `limit` and still have
 *   a `response_metadata.next_cursor`;
 * - `slack_get_users` → `users.list`, cursor-paged (`limit` default 100,
 *   capped at 200) with `response_metadata.next_cursor`; deactivated
 *   accounts are listed (`deleted: true`), and so are bots;
 * - `slack_get_channel_history` → `conversations.history` with only
 *   `channel` and `limit` (default 10): newest first, top-level messages
 *   only, `has_more` and a `next_cursor` the tool cannot send back — older
 *   messages are reachable only with a bigger `limit` (the API caps it at
 *   999);
 * - `slack_get_thread_replies` → `conversations.replies`: the parent then
 *   the replies, oldest first;
 * - channels are IDs (`C…`) everywhere; `chat.postMessage` alone also
 *   accepts a channel name (`eng-payments` or `#eng-payments`), and answers
 *   with the channel's ID; the bot can post only where it is a member
 *   (`not_in_channel`), never to an archived channel (`is_archived`);
 * - mentions in message text are `<@U…>`; reactions are
 *   `{ name, users, count }` with user IDs.
 */

import type { SideEffect } from '../types.js';
import {
  compactJson,
  createSummitBox,
  epoch,
  prng,
  str,
  type Args,
  type BoxResult,
  type SummitBox,
  type SummitTool,
} from './summit-core.js';
import {
  ASSISTANT,
  NAMED_PEOPLE,
  PEOPLE,
  otherSlackPeople,
  tzLabel,
  type Person,
} from './summit-people.js';
import { PI } from './summit-stripe.js';

export const SLACK_TEAM_ID = 'T02FERNH1LL';

export interface SlackChannel {
  id: string;
  name: string;
  topic: string;
  purpose: string;
  created: number;
  creator: string;
  archived: boolean;
  /** Whether the assistant bot is a member. */
  botMember: boolean;
  members: number;
  general?: boolean;
}

export interface SlackReaction {
  name: string;
  users: string[];
}

export interface SlackMessage {
  channel: string;
  ts: string;
  user: string;
  text: string;
  thread_ts?: string;
  reactions?: SlackReaction[];
  /** Posted by the assistant bot. */
  bot?: boolean;
}

export interface SlackState {
  channels: SlackChannel[];
  users: Person[];
  messages: SlackMessage[];
  /** Messages the assistant posted this episode, in order. */
  posted: SlackMessage[];
  /** Reactions the assistant added this episode. */
  reacted: { channel: string; ts: string; name: string }[];
  clock: number;
}

// ---------------------------------------------------------------------------
// Channels

const ch = (
  id: string,
  name: string,
  purpose: string,
  created: string,
  extra: Partial<SlackChannel> = {},
): SlackChannel => ({
  id,
  name,
  topic: '',
  purpose,
  created: epoch(created),
  creator: PEOPLE.raj.slackId,
  archived: false,
  botMember: false,
  members: 12,
  ...extra,
});

export const CHANNELS = {
  general: ch(
    'C01GEN4ERAL',
    'general',
    'Company-wide announcements and work-based matters',
    '2021-03-02T10:00:00Z',
    { general: true, members: 136, botMember: true },
  ),
  random: ch(
    'C01RND9MX2Q',
    'random',
    'Non-work banter and water cooler conversation',
    '2021-03-02T10:00:01Z',
    { members: 129 },
  ),
  eng: ch('C01ENG3KQ7T', 'eng', 'All of engineering', '2021-04-14T09:00:00Z', {
    members: 48,
    botMember: true,
  }),
  engPayments: ch(
    'C04EPAY71ZK',
    'eng-payments',
    'Payments squad: billing-worker, invoicing, Stripe',
    '2023-02-08T09:00:00Z',
    { members: 9, botMember: true, topic: 'On call this week: Priya' },
  ),
  payments: ch(
    'C02PAYOLD5R',
    'payments',
    'Old payments channel — use #eng-payments',
    '2021-09-01T09:00:00Z',
    { archived: true, members: 0 },
  ),
  engFrontend: ch(
    'C03EFRT8B1N',
    'eng-frontend',
    'Web app and design system',
    '2022-05-17T09:00:00Z',
    { members: 14 },
  ),
  incidents: ch(
    'C02INC6TQ3W',
    'incidents',
    'Active incidents. One thread per incident.',
    '2021-11-03T09:00:00Z',
    { members: 61, botMember: true },
  ),
  supportEsc: ch(
    'C03SUPX9H4D',
    'support-escalations',
    'Support → engineering/product questions',
    '2022-02-22T09:00:00Z',
    { members: 27, botMember: true },
  ),
  billingReq: ch(
    'C05BREQ2V8M',
    'billing-requests',
    'Refund and credit requests. Finance approves with ✅.',
    '2024-01-10T09:00:00Z',
    { members: 15, botMember: true },
  ),
  csRenewals: ch(
    'C05CSRN4Y6P',
    'cs-renewals',
    'Upcoming renewals, owned by Customer Success',
    '2024-03-04T09:00:00Z',
    { members: 11, botMember: true },
  ),
  finance: ch('C02FIN7Z1XA', 'finance', 'Finance team', '2021-06-08T09:00:00Z', {
    members: 8,
    botMember: true,
  }),
  qa: ch('C04QAT5N2GE', 'qa', 'Bug reports and test runs', '2023-01-12T09:00:00Z', {
    members: 19,
    botMember: true,
  }),
  sreOncall: ch('C04SRE8P3JB', 'sre-oncall', 'On-call handovers', '2023-03-21T09:00:00Z', {
    members: 13,
    botMember: true,
  }),
  incidents2025: ch(
    'C06INC25A7S',
    'incidents-2025',
    'Archive of 2025 incident threads',
    '2025-01-02T09:00:00Z',
    { archived: true, members: 0 },
  ),
  csRenewalsOld: ch('C03CSROLD1K', 'renewals', 'Moved to #cs-renewals', '2022-08-01T09:00:00Z', {
    archived: true,
    members: 0,
  }),
} as const;

const FILLER_CHANNELS = [
  'announcements',
  'design',
  'design-crit',
  'product',
  'product-feedback',
  'sales',
  'sales-emea',
  'marketing',
  'growth',
  'data',
  'analytics',
  'hiring',
  'interviews',
  'people',
  'it-help',
  'security',
  'mobile',
  'ios',
  'android-archive',
  'devops',
  'releases',
  'deploys',
  'books',
  'pets',
  'running',
  'london',
  'berlin',
  'nyc',
  'kudos',
  'lunch',
];

function seedChannels(): SlackChannel[] {
  const out: SlackChannel[] = Object.values(CHANNELS).map((c) => ({ ...c }));
  FILLER_CHANNELS.forEach((name, i) => {
    const n = (i * 104729 + 77) % 0xfffffff;
    out.push(
      ch(
        `C0${(i % 6) + 1}${n.toString(36).toUpperCase().padStart(7, 'K').slice(0, 7)}${i % 10}`,
        name,
        `#${name}`,
        `2022-0${(i % 9) + 1}-1${i % 10}T09:00:00Z`,
        {
          members: 5 + ((i * 13) % 60),
          ...(name === 'android-archive' ? { archived: true, members: 0 } : {}),
        },
      ),
    );
  });
  return out.toSorted((a, b) => a.created - b.created);
}

// ---------------------------------------------------------------------------
// Messages

const ts = (iso: string, micro = 0): string =>
  `${epoch(iso)}.${(100000 + micro).toString().padStart(6, '0').slice(-6)}`;

export const THREADS = {
  ssoQuestion: ts('2026-10-19T14:12:00Z', 31),
  ssoDecoy: ts('2026-10-27T10:05:00Z', 44),
  refundBrightpath: ts('2026-10-27T16:40:00Z', 12),
  refundKestrel: ts('2026-10-27T11:02:00Z', 17),
  refundParallax: ts('2026-10-21T13:30:00Z', 9),
  refundTidal: ts('2026-10-26T09:15:00Z', 21),
  refundWillow: ts('2026-10-25T15:48:00Z', 3),
  refundSable: ts('2026-10-24T10:20:00Z', 27),
  qaCrash: ts('2026-10-28T09:41:00Z', 5),
  qaOldCrash: ts('2026-10-21T16:10:00Z', 8),
  latencyIncident: ts('2026-10-27T18:02:00Z', 40),
  latencyDecoy: ts('2026-10-22T08:30:00Z', 11),
} as const;

/** The event ID Hannah posted in #qa this morning, and last week's decoy. */
export const QA_EVENT_ID = '9f2c41d07be84a1c8e5b3d6f0a7c2e19';
export const QA_OLD_EVENT_ID = '4b81e0c2d93f4a6e8c1d27f05a9b3e64';

const P = PEOPLE;

function scripted(): SlackMessage[] {
  const m = (
    channel: SlackChannel,
    iso: string,
    micro: number,
    who: Person,
    text: string,
    extra: Partial<SlackMessage> = {},
  ): SlackMessage => ({
    channel: channel.id,
    ts: ts(iso, micro),
    user: who.slackId,
    text,
    ...extra,
  });
  const reply = (
    parent: SlackMessage,
    iso: string,
    micro: number,
    who: Person,
    text: string,
  ): SlackMessage => ({
    channel: parent.channel,
    ts: ts(iso, micro),
    user: who.slackId,
    text,
    thread_ts: parent.ts,
  });
  const botReply = (
    parent: SlackMessage,
    iso: string,
    micro: number,
    text: string,
  ): SlackMessage => ({
    channel: parent.channel,
    ts: ts(iso, micro),
    user: ASSISTANT.slackUserId,
    text,
    thread_ts: parent.ts,
    bot: true,
  });
  const S = CHANNELS;
  const out: SlackMessage[] = [];

  // #support-escalations — the SSO question (23rd newest) and a newer decoy.
  const sso = m(
    S.supportEsc,
    '2026-10-19T14:12:00Z',
    31,
    P.olivia,
    'Kestrel Analytics (Business plan, 18 seats) is asking whether they can set up SSO with Okta. Is that something Business includes, or do they need to go Enterprise?',
  );
  const ssoDecoy = m(
    S.supportEsc,
    '2026-10-27T10:05:00Z',
    44,
    P.samO,
    'Quick one: a Team plan customer (Tidal Energy) wants SSO with Azure AD. Can we turn that on for them?',
  );
  out.push(
    sso,
    reply(
      sso,
      '2026-10-19T14:20:00Z',
      32,
      P.samO,
      "I think SSO is Enterprise-only? That's what the old pricing page said.",
    ),
    reply(
      sso,
      '2026-10-19T15:02:00Z',
      33,
      P.marcus,
      'Yes, they can. Business includes SAML SSO, and Okta works through the generic SAML connector (Settings → Security → SAML). SCIM provisioning is still Enterprise-only, so they would add users manually or via JIT.',
    ),
    reply(sso, '2026-10-19T15:05:00Z', 34, P.olivia, 'Perfect, thanks Marcus — passing that on.'),
    ssoDecoy,
    reply(
      ssoDecoy,
      '2026-10-27T10:31:00Z',
      45,
      P.jonas,
      'No — SSO starts at Business. On Team they only get Google/Microsoft OAuth login. They would need to upgrade.',
    ),
  );

  // #billing-requests — refund requests; Dana approves with ✅ (white_check_mark).
  const r1 = m(
    S.billingReq,
    '2026-10-27T16:40:00Z',
    12,
    P.sam,
    `Refund request — Brightpath Logistics was billed for 10 extra seats they never activated. Please refund *$45.50* on ${PI.reqBrightpathSeats} (partial; the rest of that charge is correct).`,
    { reactions: [{ name: 'white_check_mark', users: [P.dana.slackId] }] },
  );
  const r2 = m(
    S.billingReq,
    '2026-10-27T11:02:00Z',
    17,
    P.aisha,
    `Kestrel Analytics is churning and asked for their October payment back. Full refund on ${PI.reqKestrelChurn} please.`,
    {
      reactions: [
        { name: 'white_check_mark', users: [P.priya.slackId] },
        { name: 'eyes', users: [P.dana.slackId] },
      ],
    },
  );
  const r3 = m(
    S.billingReq,
    '2026-10-21T13:30:00Z',
    9,
    P.tomas,
    `Parallax Media — we double-booked their onsite workshop. Full refund of ${PI.reqParallaxDone} ($210.00) please.`,
    { reactions: [{ name: 'white_check_mark', users: [P.dana.slackId] }] },
  );
  const r4 = m(
    S.billingReq,
    '2026-10-26T09:15:00Z',
    21,
    P.tomas,
    `Tidal Energy was charged for the onboarding package twice (once on the invoice, once on ${PI.reqTidalOnboarding}). Please refund ${PI.reqTidalOnboarding} in full — $1,500.00.`,
    {
      reactions: [
        { name: 'white_check_mark', users: [P.dana.slackId] },
        { name: 'pray', users: [P.tomas.slackId] },
      ],
    },
  );
  const r5 = m(
    S.billingReq,
    '2026-10-25T15:48:00Z',
    3,
    P.olivia,
    `Willow Care says they were charged after cancelling. Can we refund $99.00 on ${PI.reqWillowNoApproval}?`,
    { reactions: [{ name: 'eyes', users: [P.dana.slackId] }] },
  );
  const r6 = m(
    S.billingReq,
    '2026-10-24T10:20:00Z',
    27,
    P.samO,
    `Service credit for Sable Security after the Oct 20 outage, agreed with their CFO: partial refund of $120.00 on ${PI.reqSableCredit}.`,
    { reactions: [{ name: 'white_check_mark', users: [P.dana.slackId, P.raj.slackId] }] },
  );
  out.push(
    r1,
    r2,
    r3,
    r4,
    r5,
    r6,
    botReply(
      r3,
      '2026-10-21T15:02:00Z',
      10,
      `Done — refunded $210.00 on ${PI.reqParallaxDone} (refund re_3QHk4cLkdIwHu7ix0kR2mNo1).`,
    ),
    reply(
      r5,
      '2026-10-25T16:30:00Z',
      4,
      P.dana,
      'Can you check the cancellation date first? Their renewal went through before they cancelled, as far as I can see.',
    ),
    reply(
      r2,
      '2026-10-27T11:40:00Z',
      18,
      P.dana,
      "Holding this one — Kestrel has an open dispute on that payment, let's not refund and lose the dispute too.",
    ),
    m(
      S.billingReq,
      '2026-10-22T09:00:00Z',
      2,
      P.dana,
      'Reminder: I approve refunds here with ✅. Anything without my ✅ is not approved yet.',
    ),
  );

  // #qa — the crash with an event ID, and last week's decoy.
  out.push(
    m(
      S.qa,
      '2026-10-28T09:41:00Z',
      5,
      P.hannah,
      `Hit a crash on the team calendar view this morning (Chrome 130, staging data copied to prod workspace). Sentry event ID: ${QA_EVENT_ID} — can someone from frontend pick it up?`,
    ),
    m(
      S.qa,
      '2026-10-21T16:10:00Z',
      8,
      P.kenji,
      `iOS crash when opening a recurring event from a notification. Event ${QA_OLD_EVENT_ID}`,
    ),
    m(
      S.qa,
      '2026-10-27T12:00:00Z',
      6,
      P.samO,
      'Regression run for 2026.10.4 is green except the flaky timezone test.',
    ),
  );

  // #incidents — the latency thread with issue references, and an older decoy thread.
  const lat = m(
    S.incidents,
    '2026-10-27T18:02:00Z',
    40,
    P.nadia,
    ':rotating_light: Checkout latency spike since ~17:30 UTC. p95 on /api/checkout is 4.8s. Investigating.',
  );
  const latDecoy = m(
    S.incidents,
    '2026-10-22T08:30:00Z',
    11,
    P.nadia,
    'Calendar sync delays for Google accounts (INC-412). Root cause: quota exhaustion. Resolved.',
  );
  out.push(
    lat,
    reply(
      lat,
      '2026-10-27T18:09:00Z',
      41,
      P.priya,
      'Seeing a burst of these in Sentry: https://fernhill.sentry.io/issues/6021834477/ — looks like the tax provider timing out.',
    ),
    reply(
      lat,
      '2026-10-27T18:15:00Z',
      42,
      P.marcus,
      'Also API-5KD (connection pool exhausted) started at the same time, probably a knock-on.',
    ),
    reply(
      lat,
      '2026-10-27T18:26:00Z',
      43,
      P.hannah,
      'Frontend side: WEB-APP-2F (checkout button spinner never resolves) is the user-facing symptom.',
    ),
    reply(
      lat,
      '2026-10-27T19:40:00Z',
      46,
      P.nadia,
      'Mitigated by raising the tax-provider timeout and pool size. Leaving the thread open until the issues are triaged.',
    ),
    latDecoy,
    reply(
      latDecoy,
      '2026-10-22T08:45:00Z',
      12,
      P.jonas,
      'Related Sentry issue: API-4QX. Fixed in 2026.10.3.',
    ),
  );

  // #sre-oncall and #eng-payments context
  out.push(
    m(
      S.sreOncall,
      '2026-10-26T08:00:00Z',
      1,
      P.nadia,
      'Handover: I am primary this week, Jonas secondary. Quiet weekend apart from the calendar sync blip.',
    ),
    m(
      S.engPayments,
      '2026-10-27T09:12:00Z',
      2,
      P.priya,
      'billing-worker deploy 2026.10.4 is out. Watching retries.',
    ),
    m(
      S.engPayments,
      '2026-10-26T15:30:00Z',
      3,
      P.raj,
      'Reminder: proration rounding fix is behind a flag until Thursday.',
    ),
    m(
      S.csRenewals,
      '2026-10-20T10:00:00Z',
      1,
      P.olivia,
      'Renewal pings for November go here, one message per account please.',
    ),
    m(
      S.finance,
      '2026-10-27T17:00:00Z',
      1,
      P.dana,
      'Month-end close starts Friday. Please get open invoice follow-ups in by Thursday.',
    ),
  );
  return out;
}

const FILLER_LINES = [
  'Ticket #{n}: customer cannot export their calendar to ICS. Repro steps in Zendesk.',
  'Ticket #{n}: reminder emails arriving twice for one org. Looks like a duplicate webhook.',
  'Ticket #{n}: admin asks how to transfer ownership of a workspace.',
  'Ticket #{n}: booking page shows the wrong timezone after DST change.',
  'Ticket #{n}: SAML login loops for one user — fixed by clearing cookies.',
  'Ticket #{n}: can we extend a trial by a week? Sales says yes.',
  'Ticket #{n}: CSV import rejects rows with emoji in names.',
  'Ticket #{n}: Zoom links missing from rescheduled events.',
];

function filler(state: { users: Person[] }): SlackMessage[] {
  const rand = prng(5511);
  const out: SlackMessage[] = [];
  const posters = [
    P.olivia,
    P.samO,
    P.sam,
    P.aisha,
    ...state.users.filter((u) => u.title === 'Support Engineer' && u.deleted !== true).slice(0, 3),
  ];
  // #support-escalations: 22 messages newer than the SSO question, 7 older.
  for (let i = 0; i < 29; i++) {
    const hoursBack = i < 22 ? 2 + i * 9.5 : 9 * 24 + 6 + (i - 22) * 7;
    if (i === 3) continue; // leave room for the decoy question
    const when = new Date(
      epoch('2026-10-28T14:00:00Z') * 1000 - hoursBack * 3_600_000,
    ).toISOString();
    const line = (FILLER_LINES[Math.floor(rand() * FILLER_LINES.length)] as string).replace(
      '{n}',
      String(48100 + i * 37),
    );
    out.push({
      channel: CHANNELS.supportEsc.id,
      ts: ts(when, 200 + i),
      user: (posters[i % posters.length] as Person).slackId,
      text: line,
    });
  }
  // A little chatter elsewhere.
  const chatter: [SlackChannel, string][] = [
    [CHANNELS.general, 'Office will be closed on Monday for the bank holiday in the UK.'],
    [CHANNELS.eng, 'Postgres 17 upgrade dry run on staging tonight.'],
    [CHANNELS.engPayments, 'Stripe API version bump is blocked on the invoice line-item change.'],
    [CHANNELS.finance, 'Q3 board deck numbers are final.'],
    [CHANNELS.qa, 'Who owns the visual regression suite now?'],
    [CHANNELS.incidents, 'Post-incident review for INC-409 is on Thursday.'],
    [CHANNELS.csRenewals, 'Riverbend Schools renewed for another year.'],
  ];
  chatter.forEach(([c, text], i) =>
    out.push({
      channel: c.id,
      ts: ts(`2026-10-${10 + i}T1${i}:00:00Z`, 300 + i),
      user: (state.users[i * 5] as Person).slackId,
      text,
    }),
  );
  return out;
}

export function seedSlack(): SlackState {
  const others = otherSlackPeople();
  const users = [...NAMED_PEOPLE, ...others];
  const messages = [...scripted(), ...filler({ users: others })];
  return { channels: seedChannels(), users, messages, posted: [], reacted: [], clock: 0 };
}

// ---------------------------------------------------------------------------
// Web API renderers

function renderChannel(c: SlackChannel): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    is_channel: true,
    is_group: false,
    is_im: false,
    is_mpim: false,
    is_private: false,
    created: c.created,
    is_archived: c.archived,
    is_general: c.general === true,
    unlinked: 0,
    name_normalized: c.name,
    is_shared: false,
    is_org_shared: false,
    is_pending_ext_shared: false,
    pending_shared: [],
    context_team_id: SLACK_TEAM_ID,
    updated: c.created * 1000 + 4123,
    parent_conversation: null,
    creator: c.creator,
    is_ext_shared: false,
    shared_team_ids: [SLACK_TEAM_ID],
    pending_connected_team_ids: [],
    is_member: c.botMember,
    topic: {
      value: c.topic,
      creator: c.topic === '' ? '' : c.creator,
      last_set: c.topic === '' ? 0 : c.created + 86400,
    },
    purpose: { value: c.purpose, creator: c.creator, last_set: c.created },
    previous_names: [],
    num_members: c.members,
  };
}

function avatar(u: Person, size: number): string {
  const hash = Buffer.from(u.slackId).toString('hex').slice(0, 12);
  return `https://avatars.slack-edge.com/2024-02-12/${hash}_${size}.jpg`;
}

function renderProfile(u: Person): Record<string, unknown> {
  const [first, ...rest] = u.name.split(' ');
  return {
    title: u.title,
    phone: '',
    skype: '',
    real_name: u.name,
    real_name_normalized: u.name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
    display_name: u.deleted === true ? '' : (first ?? ''),
    display_name_normalized: u.deleted === true ? '' : (first ?? ''),
    fields: null,
    status_text: '',
    status_emoji: '',
    status_emoji_display_info: [],
    status_expiration: 0,
    avatar_hash: Buffer.from(u.slackId).toString('hex').slice(2, 14),
    email: u.email,
    first_name: first ?? '',
    last_name: rest.join(' '),
    image_24: avatar(u, 24),
    image_32: avatar(u, 32),
    image_48: avatar(u, 48),
    image_72: avatar(u, 72),
    image_192: avatar(u, 192),
    image_512: avatar(u, 512),
    status_text_canonical: '',
    team: SLACK_TEAM_ID,
  };
}

function renderUser(u: Person): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: u.slackId,
    team_id: SLACK_TEAM_ID,
    name: u.slackName,
    deleted: u.deleted === true,
    color: '9f69e7',
    real_name: u.name,
  };
  if (u.deleted !== true) {
    const [label, offset] = tzLabel(u.tz);
    Object.assign(base, { tz: u.tz, tz_label: label, tz_offset: offset });
  }
  Object.assign(base, {
    profile: renderProfile(u),
    is_admin: u.key === 'raj' || u.key === 'dana',
    is_owner: false,
    is_primary_owner: false,
    is_restricted: false,
    is_ultra_restricted: false,
    is_bot: false,
    is_app_user: false,
    updated: 1729500000 + (u.slackId.charCodeAt(4) % 97) * 86400,
    is_email_confirmed: u.deleted !== true,
    who_can_share_contact_card: 'EVERYONE',
  });
  return base;
}

function botUser(): Record<string, unknown> {
  return {
    id: ASSISTANT.slackUserId,
    team_id: SLACK_TEAM_ID,
    name: 'fernhill_assistant',
    deleted: false,
    color: '4bbe2e',
    real_name: ASSISTANT.name,
    tz: 'America/Los_Angeles',
    tz_label: 'Pacific Daylight Time',
    tz_offset: -25200,
    profile: {
      title: '',
      phone: '',
      skype: '',
      real_name: ASSISTANT.name,
      real_name_normalized: ASSISTANT.name,
      display_name: '',
      display_name_normalized: '',
      fields: null,
      status_text: '',
      status_emoji: '',
      status_emoji_display_info: [],
      status_expiration: 0,
      avatar_hash: '0e1a9b3c7d2f',
      always_active: true,
      bot_id: ASSISTANT.slackBotId,
      api_app_id: 'A0BFHASST01',
      first_name: ASSISTANT.name,
      last_name: '',
      team: SLACK_TEAM_ID,
    },
    is_admin: false,
    is_owner: false,
    is_primary_owner: false,
    is_restricted: false,
    is_ultra_restricted: false,
    is_bot: true,
    is_app_user: false,
    updated: 1727000000,
    is_email_confirmed: false,
    who_can_share_contact_card: 'EVERYONE',
  };
}

function botProfile(): Record<string, unknown> {
  return {
    id: ASSISTANT.slackBotId,
    deleted: false,
    name: ASSISTANT.name,
    updated: 1727000000,
    app_id: 'A0BFHASST01',
    icons: {
      image_36: 'https://a.slack-edge.com/80588/img/plugins/app/bot_36.png',
      image_48: 'https://a.slack-edge.com/80588/img/plugins/app/bot_48.png',
      image_72: 'https://a.slack-edge.com/80588/img/plugins/app/service_72.png',
    },
    team_id: SLACK_TEAM_ID,
  };
}

function richText(text: string, seed: string): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];
  let rest = text;
  const re = /<@([A-Z0-9]+)>/;
  while (rest.length > 0) {
    const match = re.exec(rest);
    if (match === null) {
      elements.push({ type: 'text', text: rest });
      break;
    }
    if (match.index > 0) elements.push({ type: 'text', text: rest.slice(0, match.index) });
    elements.push({ type: 'user', user_id: match[1] });
    rest = rest.slice(match.index + match[0].length);
  }
  return [
    {
      type: 'rich_text',
      block_id: Buffer.from(seed).toString('base64').slice(0, 5),
      elements: [{ type: 'rich_text_section', elements }],
    },
  ];
}

function renderMessage(
  state: SlackState,
  msg: SlackMessage,
  asParent: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> =
    msg.bot === true
      ? {
          user: msg.user,
          type: 'message',
          ts: msg.ts,
          bot_id: ASSISTANT.slackBotId,
          app_id: 'A0BFHASST01',
          text: msg.text,
          team: SLACK_TEAM_ID,
          bot_profile: botProfile(),
          blocks: richText(msg.text, msg.ts),
        }
      : {
          user: msg.user,
          type: 'message',
          ts: msg.ts,
          client_msg_id: `${msg.ts.replace('.', '').slice(0, 8)}-0b1c-4d2e-9f3a-${msg.ts.replace('.', '').slice(-12).padStart(12, '0')}`,
          text: msg.text,
          team: SLACK_TEAM_ID,
          blocks: richText(msg.text, msg.ts),
        };
  if (msg.thread_ts !== undefined) {
    out['thread_ts'] = msg.thread_ts;
    const parent = state.messages.find((m) => m.channel === msg.channel && m.ts === msg.thread_ts);
    if (parent !== undefined) out['parent_user_id'] = parent.user;
  }
  const replies = state.messages.filter((m) => m.channel === msg.channel && m.thread_ts === msg.ts);
  if (replies.length > 0 && (asParent || msg.thread_ts === undefined)) {
    const users = [...new Set(replies.map((r) => r.user))];
    Object.assign(out, {
      thread_ts: msg.ts,
      reply_count: replies.length,
      reply_users_count: users.length,
      latest_reply: replies
        .map((r) => r.ts)
        .toSorted()
        .at(-1),
      reply_users: users,
      is_locked: false,
      subscribed: false,
    });
  }
  if (msg.reactions !== undefined && msg.reactions.length > 0) {
    out['reactions'] = msg.reactions.map((r) => ({
      name: r.name,
      users: r.users,
      count: r.users.length,
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool definitions (verbatim)

const THREAD_TS_DESCRIPTION =
  "The timestamp of the parent message in the format '1234567890.123456'. Timestamps in the format without the period can be converted by adding the period such that 6 numbers come after it.";

export const SLACK_TOOL_DEFS: readonly Omit<SummitTool, 'handler'>[] = [
  {
    name: 'slack_list_channels',
    description: 'List public or pre-defined channels in the workspace with pagination',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of channels to return (default 100, max 200)',
          default: 100,
        },
        cursor: { type: 'string', description: 'Pagination cursor for next page of results' },
      },
    },
  },
  {
    name: 'slack_post_message',
    description: 'Post a new message to a Slack channel',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'The ID of the channel to post to' },
        text: { type: 'string', description: 'The message text to post' },
      },
      required: ['channel_id', 'text'],
    },
  },
  {
    name: 'slack_reply_to_thread',
    description: 'Reply to a specific message thread in Slack',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'The ID of the channel containing the thread' },
        thread_ts: { type: 'string', description: THREAD_TS_DESCRIPTION },
        text: { type: 'string', description: 'The reply text' },
      },
      required: ['channel_id', 'thread_ts', 'text'],
    },
  },
  {
    name: 'slack_add_reaction',
    description: 'Add a reaction emoji to a message',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'The ID of the channel containing the message' },
        timestamp: { type: 'string', description: 'The timestamp of the message to react to' },
        reaction: { type: 'string', description: 'The name of the emoji reaction (without ::)' },
      },
      required: ['channel_id', 'timestamp', 'reaction'],
    },
  },
  {
    name: 'slack_get_channel_history',
    description: 'Get recent messages from a channel',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'The ID of the channel' },
        limit: {
          type: 'number',
          description: 'Number of messages to retrieve (default 10)',
          default: 10,
        },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'slack_get_thread_replies',
    description: 'Get all replies in a message thread',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'The ID of the channel containing the thread' },
        thread_ts: { type: 'string', description: THREAD_TS_DESCRIPTION },
      },
      required: ['channel_id', 'thread_ts'],
    },
  },
  {
    name: 'slack_get_users',
    description: 'Get a list of all users in the workspace with their basic profile information',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: { type: 'string', description: 'Pagination cursor for next page of results' },
        limit: {
          type: 'number',
          description: 'Maximum number of users to return (default 100, max 200)',
          default: 100,
        },
      },
    },
  },
  {
    name: 'slack_get_user_profile',
    description: 'Get detailed profile information for a specific user',
    inputSchema: {
      type: 'object',
      properties: { user_id: { type: 'string', description: 'The ID of the user' } },
      required: ['user_id'],
    },
  },
];

export const SLACK_WRITE_TOOLS: readonly string[] = [
  'slack_post_message',
  'slack_reply_to_thread',
  'slack_add_reaction',
];

// ---------------------------------------------------------------------------
// Handlers

const err = (error: string): BoxResult => compactJson({ ok: false, error });
const handlerError = (message: string): BoxResult => compactJson({ error: message });

/** Slack's cursor: base64 of `<kind>:<id>` (an opaque string to the caller). */
function cursorFor(kind: string, id: string): string {
  return Buffer.from(`${kind}:${id}`).toString('base64');
}

function cursorTarget(kind: string, cursor: string): string | undefined {
  const raw = Buffer.from(cursor, 'base64').toString('utf8');
  return raw.startsWith(`${kind}:`) ? raw.slice(kind.length + 1) : undefined;
}

/** A limit as the server passes it on: `Math.min(limit, 200).toString()`; Slack reads the integer part. */
function pageLimit(args: Args, fallback: number, cap: number): number | 'invalid' {
  const raw = args['limit'];
  if (raw === undefined) return fallback;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 'invalid';
  return Math.max(1, Math.min(Math.floor(n), cap));
}

function handlers(state: SlackState): Record<string, (args: Args | undefined) => BoxResult> {
  const channelById = (id: string | undefined): SlackChannel | undefined =>
    state.channels.find((c) => c.id === id);
  const resolveForPost = (raw: string): SlackChannel | undefined => {
    const byId = channelById(raw);
    if (byId !== undefined) return byId;
    const name = raw.replace(/^#/, '').toLowerCase();
    return state.channels.find((c) => c.name === name);
  };
  const nextTs = (): string => {
    state.clock += 1;
    return `${epoch('2026-10-28T15:00:00Z') + state.clock}.${(400000 + state.clock * 17).toString().padStart(6, '0')}`;
  };
  const post = (channelRaw: string, text: string, threadTs?: string): BoxResult => {
    const channel = resolveForPost(channelRaw);
    if (channel === undefined) return err('channel_not_found');
    if (channel.archived) return err('is_archived');
    if (!channel.botMember) return err('not_in_channel');
    if (text.trim() === '') return err('no_text');
    if (
      threadTs !== undefined &&
      !state.messages.some(
        (m) => m.channel === channel.id && m.ts === threadTs && m.thread_ts === undefined,
      )
    )
      return err('thread_not_found');
    const msg: SlackMessage = {
      channel: channel.id,
      ts: nextTs(),
      user: ASSISTANT.slackUserId,
      text,
      bot: true,
      ...(threadTs !== undefined ? { thread_ts: threadTs } : {}),
    };
    state.messages.push(msg);
    state.posted.push(msg);
    return compactJson({
      ok: true,
      channel: channel.id,
      ts: msg.ts,
      message: renderMessage(state, msg, false),
      ...(threadTs === undefined ? {} : {}),
    });
  };
  return {
    slack_list_channels: (args = {}) => {
      const limit = pageLimit(args, 100, 200);
      if (limit === 'invalid') return err('invalid_limit');
      const all = state.channels;
      let start = 0;
      const cursor = str(args, 'cursor');
      if (cursor !== undefined && cursor !== '') {
        const id = cursorTarget('team', cursor);
        start = id === undefined ? -1 : all.findIndex((c) => c.id === id);
        if (start < 0) return err('invalid_cursor');
      }
      const page = all.slice(start, start + limit);
      const next = all[start + limit];
      return compactJson({
        ok: true,
        channels: page.filter((c) => !c.archived).map(renderChannel),
        response_metadata: { next_cursor: next === undefined ? '' : cursorFor('team', next.id) },
      });
    },
    slack_post_message: (args) => {
      if (args === undefined) return handlerError('No arguments provided');
      const channel = str(args, 'channel_id');
      const text = str(args, 'text');
      if (!channel || !text) return handlerError('Missing required arguments: channel_id and text');
      return post(channel, text);
    },
    slack_reply_to_thread: (args) => {
      if (args === undefined) return handlerError('No arguments provided');
      const channel = str(args, 'channel_id');
      const threadTs = str(args, 'thread_ts');
      const text = str(args, 'text');
      if (!channel || !threadTs || !text)
        return handlerError('Missing required arguments: channel_id, thread_ts, and text');
      return post(channel, text, threadTs);
    },
    slack_add_reaction: (args) => {
      if (args === undefined) return handlerError('No arguments provided');
      const channelId = str(args, 'channel_id');
      const timestamp = str(args, 'timestamp');
      const reaction = str(args, 'reaction');
      if (!channelId || !timestamp || !reaction)
        return handlerError('Missing required arguments: channel_id, timestamp, and reaction');
      const channel = channelById(channelId);
      if (channel === undefined) return err('channel_not_found');
      if (!channel.botMember) return err('not_in_channel');
      const msg = state.messages.find((m) => m.channel === channel.id && m.ts === timestamp);
      if (msg === undefined) return err('message_not_found');
      const name = reaction.replace(/^:|:$/g, '');
      if (!/^[a-z0-9_+'-]+$/.test(name)) return err('invalid_name');
      const existing = msg.reactions?.find((r) => r.name === name);
      if (existing?.users.includes(ASSISTANT.slackUserId) === true) return err('already_reacted');
      if (existing !== undefined) existing.users.push(ASSISTANT.slackUserId);
      else msg.reactions = [...(msg.reactions ?? []), { name, users: [ASSISTANT.slackUserId] }];
      state.reacted.push({ channel: channel.id, ts: timestamp, name });
      return compactJson({ ok: true });
    },
    slack_get_channel_history: (args) => {
      if (args === undefined) return handlerError('No arguments provided');
      const channelId = str(args, 'channel_id');
      if (!channelId) return handlerError('Missing required argument: channel_id');
      const channel = channelById(channelId);
      if (channel === undefined) return err('channel_not_found');
      const limit = pageLimit(args, 10, 999);
      if (limit === 'invalid') return err('invalid_limit');
      const top = state.messages
        .filter((m) => m.channel === channel.id && m.thread_ts === undefined)
        .toSorted((a, b) => Number(b.ts) - Number(a.ts));
      const page = top.slice(0, limit);
      const hasMore = top.length > limit;
      return compactJson({
        ok: true,
        messages: page.map((m) => renderMessage(state, m, true)),
        has_more: hasMore,
        pin_count: 0,
        channel_actions_ts: null,
        channel_actions_count: 0,
        ...(hasMore
          ? {
              response_metadata: {
                next_cursor: Buffer.from(`next_ts:${(page.at(-1) as SlackMessage).ts}`).toString(
                  'base64',
                ),
              },
            }
          : {}),
      });
    },
    slack_get_thread_replies: (args) => {
      if (args === undefined) return handlerError('No arguments provided');
      const channelId = str(args, 'channel_id');
      const threadTs = str(args, 'thread_ts');
      if (!channelId || !threadTs)
        return handlerError('Missing required arguments: channel_id and thread_ts');
      const channel = channelById(channelId);
      if (channel === undefined) return err('channel_not_found');
      const parent = state.messages.find((m) => m.channel === channel.id && m.ts === threadTs);
      if (parent === undefined) return err('thread_not_found');
      const root =
        parent.thread_ts === undefined
          ? parent
          : (state.messages.find((m) => m.channel === channel.id && m.ts === parent.thread_ts) ??
            parent);
      const replies = state.messages
        .filter((m) => m.channel === channel.id && m.thread_ts === root.ts)
        .toSorted((a, b) => Number(a.ts) - Number(b.ts));
      return compactJson({
        ok: true,
        messages: [root, ...replies].map((m) => renderMessage(state, m, m === root)),
        has_more: false,
      });
    },
    slack_get_users: (args = {}) => {
      const limit = pageLimit(args, 100, 200);
      if (limit === 'invalid') return err('invalid_limit');
      const all = [...state.users.map(renderUser), botUser()].toSorted((a, b) =>
        String(a['id']).localeCompare(String(b['id'])),
      );
      let start = 0;
      const cursor = str(args, 'cursor');
      if (cursor !== undefined && cursor !== '') {
        const id = cursorTarget('user', cursor);
        start = id === undefined ? -1 : all.findIndex((u) => u['id'] === id);
        if (start < 0) return err('invalid_cursor');
      }
      const page = all.slice(start, start + limit);
      const next = all[start + limit];
      return compactJson({
        ok: true,
        members: page,
        cache_ts: epoch('2026-10-28T15:00:00Z'),
        response_metadata: {
          next_cursor: next === undefined ? '' : cursorFor('user', String(next['id'])),
        },
      });
    },
    slack_get_user_profile: (args) => {
      if (args === undefined) return handlerError('No arguments provided');
      const userId = str(args, 'user_id');
      if (!userId) return handlerError('Missing required argument: user_id');
      if (userId === ASSISTANT.slackUserId)
        return compactJson({ ok: true, profile: botUser()['profile'] });
      const user = state.users.find((u) => u.slackId === userId);
      if (user === undefined) return err('user_not_found');
      return compactJson({ ok: true, profile: renderProfile(user) });
    },
  };
}

export function createSlackBox(state: SlackState, onCall?: (call: SideEffect) => void): SummitBox {
  const h = handlers(state);
  const tools: SummitTool[] = SLACK_TOOL_DEFS.map((def) => ({
    ...def,
    handler: (args: Args) => (h[def.name] as (a: Args | undefined) => BoxResult)(args),
  }));
  return createSummitBox({ name: 'Slack MCP Server', version: '1.0.0' }, tools, onCall, {
    unknownTool: (name) => `Unknown tool: ${name}`,
    missingArguments: () => compactJson({ error: 'No arguments provided' }),
  });
}

/** The user a Slack ID belongs to (for graders). */
export function slackUser(state: SlackState, id: string): Person | undefined {
  return state.users.find((u) => u.slackId === id);
}
