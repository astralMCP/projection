/**
 * The workplace world's `chat` box: a team-chat server shaped like the
 * popular reference chat MCP servers — channel list, channel history
 * (newest first, cursor-paged, ten per page by default), thread replies,
 * users, a user profile, post / reply / react.
 *
 * Quirks a real one has, kept on purpose:
 *
 * - every ID is opaque (`C05R1JZ8P3M`, `U07K2M9QF3A`); people appear in
 *   message text only as `<@U…>` mentions; tools take channel IDs, and a
 *   channel *name* gets `{"ok":false,"error":"channel_not_found"}` back as
 *   an ordinary (non-error) result, the way the chat API answers;
 * - `get_users` lists no emails — only `get_user_profile` has one — and
 *   `get_user_profile` declares no annotations at all;
 * - history lists top-level messages only; a thread's replies come from
 *   `get_thread_replies`;
 * - deactivated users stay in the list with `deleted: true`; the profile
 *   (users.profile.get) has no such flag.
 */

import type { SideEffect } from '../types.js';
import {
  argNumber,
  argString,
  createFakeBox,
  decodeCursor,
  encodeCursor,
  epochSeconds,
  json,
  type FakeArgs,
  type FakeBox,
  type FakeTool,
} from './workplace-fake.js';
import { ALL_PEOPLE, BOTS, PEOPLE, WORLD_NOW } from './workplace-people.js';

export interface ChatChannel {
  id: string;
  name: string;
  topic: string;
  purpose: string;
  members: number;
}

export interface ChatMessage {
  channel: string;
  user: string;
  text: string;
  ts: string;
  /** Set on replies (and on a parent that has replies, equal to its own ts). */
  thread_ts?: string;
  reactions?: { name: string; users: string[] }[];
}

/** A Slack-style ts for an ISO instant: epoch seconds, six-digit suffix. */
export function tsOf(iso: string, seq = 0): string {
  return `${epochSeconds(iso)}.${String(100 + seq).padStart(6, '0')}`;
}

export const CHANNELS = {
  general: {
    id: 'C03A7LMN2QB',
    name: 'general',
    topic: 'Company-wide',
    purpose: 'Announcements and everything else',
    members: 58,
  },
  random: { id: 'C02X9TT4D7S', name: 'random', topic: '', purpose: 'Non-work banter', members: 51 },
  design: {
    id: 'C01DSGN7Q2W',
    name: 'design',
    topic: 'Figma links welcome',
    purpose: 'Product design',
    members: 12,
  },
  ops: {
    id: 'C07PS3RT9KL',
    name: 'ops',
    topic: 'Infra changes and on-call swaps',
    purpose: 'Operations',
    members: 19,
  },
  support: {
    id: 'C08SPRT4M1N',
    name: 'support',
    topic: 'Escalations from the support queue',
    purpose: 'Customer support',
    members: 23,
  },
  web: {
    id: 'C09FRNT6D2P',
    name: 'web',
    topic: 'Storefront and dashboard',
    purpose: 'Web team',
    members: 14,
  },
  qa: {
    id: 'C0AQA8B1C3D',
    name: 'qa',
    topic: '',
    purpose: 'Test plans and release QA',
    members: 9,
  },
  data: {
    id: 'C0BDT5E7F9G',
    name: 'data',
    topic: 'Warehouse and dashboards',
    purpose: 'Data team',
    members: 8,
  },
  hiring: { id: 'C0CHR2J4K6L', name: 'hiring', topic: '', purpose: 'Interview loops', members: 11 },
  engBackend: {
    id: 'C04Q8H2KX1N',
    name: 'eng-backend',
    topic: `payments-api owner: <@${PEOPLE.priya.chatId}> · review-queue thread daily at 09:00 UTC`,
    purpose: 'Backend engineering',
    members: 21,
  },
  incidents: {
    id: 'C05R1JZ8P3M',
    name: 'incidents',
    topic: 'Sev1/Sev2 live here. Postmortems in docs.',
    purpose: 'Incident response',
    members: 44,
  },
  releaseTrain: {
    id: 'C06V2PQ9W4R',
    name: 'release-train',
    topic: 'Freeze dates, branch cuts, deploys',
    purpose: 'Release coordination',
    members: 37,
  },
} as const satisfies Record<string, ChatChannel>;

const BOT = BOTS.errors.chatId;
const DEPLOY = BOTS.deploy.chatId;
const P = PEOPLE;

// ---------------------------------------------------------------------------
// Fixture messages

/** The #incidents parent for CHECKOUT-API-3B. */
export const THREAD_3B_TS = tsOf('2026-10-13T08:05:00Z');
/** The #incidents parent for CHECKOUT-API-2K (a decoy thread for the 3B task). */
export const THREAD_2K_TS = tsOf('2026-10-11T06:20:00Z');
/** The #incidents parent for INC-2041. */
export const THREAD_INC2041_TS = tsOf('2026-10-09T15:00:00Z');
/** The #eng-backend "Review queue — 2026-10-14" parent. */
export const REVIEW_QUEUE_TS = tsOf('2026-10-14T09:00:00Z');
/** Yesterday's review-queue parent (a decoy). */
export const REVIEW_QUEUE_PREV_TS = tsOf('2026-10-13T09:00:00Z');
/** Dana's 2.8 code-freeze announcement in #release-train. */
export const FREEZE_TS = tsOf('2026-10-02T16:00:00Z');

/** The action items in the INC-2041 thread, without their `AI: ` prefix. */
export const INC2041_ACTION_ITEMS = [
  'Add idempotency key check before ledger write',
  'Alert when retry queue depth > 500',
  'Backfill refunds for the 37 double-charged accounts',
  'Document the retry policy in the billing-worker runbook',
] as const;

function m(
  channel: ChatChannel,
  user: string,
  iso: string,
  body: string,
  thread?: string,
  seq = 0,
): ChatMessage {
  const ts = tsOf(iso, seq);
  return {
    channel: channel.id,
    user,
    text: body,
    ts,
    ...(thread !== undefined ? { thread_ts: thread } : {}),
  };
}

function incidentMessages(): ChatMessage[] {
  const c = CHANNELS.incidents;
  return [
    m(c, DEPLOY, '2026-10-06T10:00:00Z', 'Weekly incident review moved to Thursdays.'),
    m(
      c,
      P.dana.chatId,
      '2026-10-09T15:00:00Z',
      'INC-2041 — billing-worker double-charged on retries. Postmortem: docs › Postmortems › INC-2041. Please add action items in this thread, one per message, prefixed with `AI:`',
      THREAD_INC2041_TS,
    ),
    m(
      c,
      P.jonas.chatId,
      '2026-10-09T15:12:00Z',
      'AI: Add idempotency key check before ledger write',
      THREAD_INC2041_TS,
    ),
    m(
      c,
      P.aiko.chatId,
      '2026-10-09T15:20:00Z',
      'AI: Alert when retry queue depth > 500',
      THREAD_INC2041_TS,
    ),
    m(
      c,
      P.sam.chatId,
      '2026-10-09T15:31:00Z',
      'dashboards were slow during the incident fwiw, not an action item, just noting',
      THREAD_INC2041_TS,
    ),
    m(
      c,
      P.jonas.chatId,
      '2026-10-09T16:02:00Z',
      'AI: Backfill refunds for the 37 double-charged accounts',
      THREAD_INC2041_TS,
    ),
    m(
      c,
      P.dana.chatId,
      '2026-10-09T16:40:00Z',
      'AI: Document the retry policy in the billing-worker runbook',
      THREAD_INC2041_TS,
    ),
    m(c, P.omar.chatId, '2026-10-09T17:05:00Z', '+1 to the runbook item', THREAD_INC2041_TS),
    m(
      c,
      BOT,
      '2026-10-10T02:14:00Z',
      ':white_check_mark: Resolved *CHECKOUT-API-1F* — TimeoutError: inventory service did not respond within 5000ms',
    ),
    m(
      c,
      BOT,
      '2026-10-11T06:20:00Z',
      ':rotating_light: New issue *CHECKOUT-API-2K* — PaymentDeclinedError: card_declined not handled · checkout-api · production',
      THREAD_2K_TS,
    ),
    m(
      c,
      P.aiko.chatId,
      '2026-10-11T06:41:00Z',
      'Looking. Seems to be one merchant config.',
      THREAD_2K_TS,
    ),
    m(
      c,
      P.aiko.chatId,
      '2026-10-11T07:30:00Z',
      'Mitigated by disabling the merchant; ticket is open in the tracker.',
      THREAD_2K_TS,
    ),
    m(
      c,
      BOT,
      '2026-10-12T11:00:00Z',
      ':white_check_mark: Resolved *CHECKOUT-API-7Q* — SyntaxError: Unexpected token < in JSON at position 0',
    ),
    m(
      c,
      BOT,
      '2026-10-13T00:05:00Z',
      ':rotating_light: New issue *CHECKOUT-API-8T* — Error: Redis connection lost · checkout-api · production',
      tsOf('2026-10-13T00:05:00Z'),
    ),
    m(
      c,
      P.aiko.chatId,
      '2026-10-13T00:20:00Z',
      'Known failover noise, ignoring it in errors.',
      tsOf('2026-10-13T00:05:00Z'),
    ),
    m(c, DEPLOY, '2026-10-13T07:55:00Z', 'Deployed checkout-api 2.7.3 to production (12 commits).'),
    m(
      c,
      BOT,
      '2026-10-13T08:05:00Z',
      ":rotating_light: New issue *CHECKOUT-API-3B* — TypeError: Cannot read properties of undefined (reading 'currency') · checkout-api · production",
      THREAD_3B_TS,
    ),
    m(
      c,
      P.aiko.chatId,
      '2026-10-13T08:19:00Z',
      'Looking. Started right after the 2.7.3 deploy.',
      THREAD_3B_TS,
    ),
    m(
      c,
      P.dana.chatId,
      '2026-10-13T08:44:00Z',
      'Who owns the suspect commit? Please loop them in here.',
      THREAD_3B_TS,
    ),
    m(
      c,
      BOT,
      '2026-10-13T20:10:00Z',
      ':rotating_light: New issue *CHECKOUT-API-4D* — ValueError: invalid coupon code format · checkout-api · production',
    ),
    m(
      c,
      P.grace.chatId,
      '2026-10-14T08:30:00Z',
      'QA sign-off for 2.7.3 hotfix is blocked on the currency bug.',
    ),
  ];
}

function engBackendMessages(): ChatMessage[] {
  const c = CHANNELS.engBackend;
  return [
    m(
      c,
      P.dana.chatId,
      '2026-10-12T09:00:00Z',
      'Review queue — 2026-10-12',
      tsOf('2026-10-12T09:00:00Z'),
    ),
    m(
      c,
      P.jonas.chatId,
      '2026-10-12T09:20:00Z',
      'BE-140 is waiting on review',
      tsOf('2026-10-12T09:00:00Z'),
    ),
    m(c, P.omar.chatId, '2026-10-12T14:00:00Z', 'Anyone else seeing slow CI on the monorepo?'),
    m(c, P.dana.chatId, '2026-10-13T09:00:00Z', 'Review queue — 2026-10-13', REVIEW_QUEUE_PREV_TS),
    m(c, P.sam.chatId, '2026-10-13T09:14:00Z', 'BE-142 could use eyes', REVIEW_QUEUE_PREV_TS),
    m(
      c,
      P.priya.chatId,
      '2026-10-13T11:02:00Z',
      'Lunch-and-learn on ledger internals moved to Friday.',
    ),
    m(
      c,
      P.jonas.chatId,
      '2026-10-13T16:45:00Z',
      'billing-worker 4.13.1 is out with the retry fix.',
    ),
    m(c, P.dana.chatId, '2026-10-14T09:00:00Z', 'Review queue — 2026-10-14', REVIEW_QUEUE_TS),
    m(
      c,
      P.dana.chatId,
      '2026-10-14T09:01:00Z',
      'Reply here with anything waiting on review.',
      REVIEW_QUEUE_TS,
    ),
    m(
      c,
      P.omar.chatId,
      '2026-10-14T09:40:00Z',
      'Reminder: schema migration window tonight 22:00 UTC.',
    ),
    m(c, P.aiko.chatId, '2026-10-14T10:05:00Z', 'Paging is noisy today, sorry in advance.'),
    m(c, P.sam.chatId, '2026-10-14T10:30:00Z', 'notify-svc dashboards are back.'),
  ];
}

/** #release-train: the 2.8 freeze announcement is the 34th newest of 35 messages (page 4 at 10 per page). */
function releaseTrainMessages(): ChatMessage[] {
  const c = CHANNELS.releaseTrain;
  const out: ChatMessage[] = [
    m(c, P.dana.chatId, '2026-10-01T15:00:00Z', 'Release 2.7.1 is out. Thanks all!'),
    m(
      c,
      P.dana.chatId,
      '2026-10-02T16:00:00Z',
      ':mega: Code freeze for *2.8* is *2026-10-22 at 17:00 UTC*. Branch cut the next morning. Anything not merged by then rides 2.9.',
    ),
  ];
  const services = ['checkout-api', 'billing-worker', 'notify-svc', 'storefront', 'ledger'];
  // 33 later messages: deploys, plus decoys about other releases.
  for (let i = 0; i < 33; i += 1) {
    const day = 3 + Math.floor(i / 3);
    const hour = 9 + (i % 3) * 3;
    const iso = `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;
    const svc = services[i % services.length] as string;
    let body = `Deployed ${svc} build #${1400 + i} to staging.`;
    let user: string = DEPLOY;
    if (i === 12) {
      user = P.dana.chatId;
      body = 'Reminder: the *2.7.2* hotfix freeze is tomorrow (2026-10-08) at noon UTC.';
    } else if (i === 28) {
      user = P.dana.chatId;
      body = 'Heads-up: *2.9* code freeze is tentatively 2026-11-19. Will confirm next month.';
    } else if (i === 20) {
      user = P.grace.chatId;
      body = 'QA plan for 2.8 is in docs, please skim it before the freeze.';
    }
    out.push(m(c, user, iso, body));
  }
  return out;
}

function otherMessages(): ChatMessage[] {
  const g = CHANNELS.general;
  const o = CHANNELS.ops;
  return [
    m(g, P.dana.chatId, '2026-10-10T12:00:00Z', 'Office closed Monday 2026-10-19 for maintenance.'),
    m(g, P.grace.chatId, '2026-10-13T15:00:00Z', 'Welcome to our new QA engineer!'),
    m(o, P.aiko.chatId, '2026-10-08T10:00:00Z', 'Rotation for Q4 is in the docs on-call page.'),
    m(o, P.omar.chatId, '2026-10-13T18:00:00Z', 'Certificate rotation done for *.northwind.dev.'),
  ];
}

export interface ChatState {
  channels: ChatChannel[];
  messages: ChatMessage[];
  /** Messages the episode posted, in order. */
  posted: ChatMessage[];
}

/** A fresh chat state (deterministic, no clock). */
export function seedChat(): ChatState {
  return {
    channels: Object.values(CHANNELS).map((c) => ({ ...c })),
    messages: [
      ...incidentMessages(),
      ...engBackendMessages(),
      ...releaseTrainMessages(),
      ...otherMessages(),
    ],
    posted: [],
  };
}

// ---------------------------------------------------------------------------
// The server

interface ChatUser {
  id: string;
  name: string;
  real_name: string;
  deleted: boolean;
  is_bot: boolean;
  profile: { display_name: string; real_name: string; title: string };
}

/** The users list, in the order the server returns it. */
function chatUsers(): ChatUser[] {
  const bots: ChatUser[] = Object.values(BOTS).map((b) => ({
    id: b.chatId,
    name: b.handle,
    real_name: b.name,
    deleted: false,
    is_bot: true,
    profile: { display_name: b.handle, real_name: b.name, title: '' },
  }));
  const people: ChatUser[] = ALL_PEOPLE.map((p) => ({
    id: p.chatId,
    name: p.handle,
    real_name: p.name,
    deleted: p.chatDeleted === true,
    is_bot: false,
    profile: {
      display_name: p.handle,
      real_name: p.name,
      title: p.chatDeleted === true ? '' : p.title,
    },
  })).toSorted((a, b) => a.id.localeCompare(b.id));
  return [...bots, ...people];
}

const notOk = (error: string): ReturnType<typeof json> => json({ ok: false, error });

function page<T>(
  items: readonly T[],
  scope: string,
  args: FakeArgs,
  defaultLimit: number,
  maxLimit: number,
): { items: T[]; next: string } | { error: string } {
  const limit = Math.min(Math.max(argNumber(args, 'limit') ?? defaultLimit, 1), maxLimit);
  const cursor = argString(args, 'cursor');
  let offset = 0;
  if (cursor !== undefined && cursor !== '') {
    const decoded = decodeCursor(scope, cursor);
    if (decoded === undefined) return { error: 'invalid_cursor' };
    offset = decoded;
  }
  const slice = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? encodeCursor(scope, offset + limit) : '';
  return { items: slice, next };
}

function view(message: ChatMessage, all: readonly ChatMessage[]): Record<string, unknown> {
  const replies = all.filter((r) => r.thread_ts === message.ts && r.ts !== message.ts);
  return {
    type: 'message',
    user: message.user,
    text: message.text,
    ts: message.ts,
    ...(message.thread_ts !== undefined ? { thread_ts: message.thread_ts } : {}),
    ...(replies.length > 0
      ? {
          reply_count: replies.length,
          reply_users: [...new Set(replies.map((r) => r.user))],
          latest_reply: replies.at(-1)?.ts,
        }
      : {}),
    ...(message.reactions !== undefined && message.reactions.length > 0
      ? { reactions: message.reactions.map((r) => ({ ...r, count: r.users.length })) }
      : {}),
  };
}

const CHANNEL_ID = {
  type: 'string',
  description: 'The ID of the channel (e.g. C0123456789). Channel names are not accepted.',
} as const;

/** The chat box over `state`. */
export function createChatBox(state: ChatState, onCall?: (call: SideEffect) => void): FakeBox {
  let postSeq = 0;
  const channelOf = (args: FakeArgs): ChatChannel | undefined => {
    const id = argString(args, 'channel_id');
    return state.channels.find((c) => c.id === id);
  };
  const post = (channel: ChatChannel, body: string, thread?: string): ChatMessage => {
    postSeq += 1;
    const message: ChatMessage = {
      channel: channel.id,
      user: 'U00ASSIST01',
      text: body,
      ts: tsOf(WORLD_NOW, postSeq),
      ...(thread !== undefined ? { thread_ts: thread } : {}),
    };
    state.messages.push(message);
    state.posted.push(message);
    return message;
  };

  const tools: FakeTool[] = [
    {
      name: 'list_channels',
      description: 'List public channels in the workspace with pagination',
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
      annotations: { title: 'List channels', readOnlyHint: true, openWorldHint: true },
      handler: (args) => {
        const p = page(state.channels, 'channels', args, 100, 200);
        if ('error' in p) return notOk(p.error);
        return json({
          ok: true,
          channels: p.items.map((c) => ({
            id: c.id,
            name: c.name,
            is_channel: true,
            is_private: false,
            is_archived: false,
            num_members: c.members,
            topic: { value: c.topic },
            purpose: { value: c.purpose },
          })),
          response_metadata: { next_cursor: p.next },
        });
      },
    },
    {
      name: 'get_channel_history',
      description:
        'Get recent messages from a channel, newest first. Thread replies are not included; use get_thread_replies for those.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: CHANNEL_ID,
          limit: {
            type: 'number',
            description: 'Number of messages to retrieve (default 10, max 100)',
            default: 10,
          },
          cursor: {
            type: 'string',
            description: 'Pagination cursor (response_metadata.next_cursor of the previous page)',
          },
        },
        required: ['channel_id'],
      },
      annotations: { title: 'Get channel history', readOnlyHint: true, openWorldHint: true },
      handler: (args) => {
        const channel = channelOf(args);
        if (channel === undefined) return notOk('channel_not_found');
        const top = state.messages
          .filter(
            (x) => x.channel === channel.id && (x.thread_ts === undefined || x.thread_ts === x.ts),
          )
          .toSorted((a, b) => Number(b.ts) - Number(a.ts));
        const p = page(top, `history:${channel.id}`, args, 10, 100);
        if ('error' in p) return notOk(p.error);
        return json({
          ok: true,
          messages: p.items.map((x) => view(x, state.messages)),
          has_more: p.next !== '',
          response_metadata: { next_cursor: p.next },
        });
      },
    },
    {
      name: 'get_thread_replies',
      description:
        'Get all replies in a message thread, oldest first. The first message is the thread parent.',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: CHANNEL_ID,
          thread_ts: {
            type: 'string',
            description:
              "The timestamp of the parent message in the format '1234567890.123456'. Timestamps in the format without the period can be converted by adding the period such that 6 numbers come after it.",
          },
        },
        required: ['channel_id', 'thread_ts'],
      },
      annotations: { title: 'Get thread replies', readOnlyHint: true, openWorldHint: true },
      handler: (args) => {
        const channel = channelOf(args);
        if (channel === undefined) return notOk('channel_not_found');
        const ts = argString(args, 'thread_ts');
        const found = state.messages.find((x) => x.channel === channel.id && x.ts === ts);
        if (found === undefined) return notOk('thread_not_found');
        // The ts of any message in a thread selects the whole thread, as
        // conversations.replies does (its parent or one of its replies).
        const parent =
          found.thread_ts !== undefined && found.thread_ts !== found.ts
            ? (state.messages.find((x) => x.channel === channel.id && x.ts === found.thread_ts) ??
              found)
            : found;
        const thread = state.messages
          .filter(
            (x) => x.channel === channel.id && (x.ts === parent.ts || x.thread_ts === parent.ts),
          )
          .toSorted((a, b) => Number(a.ts) - Number(b.ts));
        return json({
          ok: true,
          messages: thread.map((x) => view(x, state.messages)),
          has_more: false,
        });
      },
    },
    {
      name: 'post_message',
      description: 'Post a new message to a channel',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'The ID of the channel to post to' },
          text: {
            type: 'string',
            description: 'The message text to post. Mention a user as <@USER_ID>.',
          },
        },
        required: ['channel_id', 'text'],
      },
      annotations: {
        title: 'Post message',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: (args) => {
        const channel = channelOf(args);
        if (channel === undefined) return notOk('channel_not_found');
        const message = post(channel, argString(args, 'text') ?? '');
        return json({
          ok: true,
          channel: channel.id,
          ts: message.ts,
          message: view(message, state.messages),
        });
      },
    },
    {
      name: 'reply_to_thread',
      description: 'Reply to a specific message thread',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: 'The ID of the channel containing the thread',
          },
          thread_ts: {
            type: 'string',
            description:
              "The timestamp of the parent message in the format '1234567890.123456'. Timestamps in the format without the period can be converted by adding the period such that 6 numbers come after it.",
          },
          text: { type: 'string', description: 'The reply text. Mention a user as <@USER_ID>.' },
        },
        required: ['channel_id', 'thread_ts', 'text'],
      },
      annotations: {
        title: 'Reply to thread',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: (args) => {
        const channel = channelOf(args);
        if (channel === undefined) return notOk('channel_not_found');
        const ts = argString(args, 'thread_ts');
        const parent = state.messages.find(
          (x) =>
            x.channel === channel.id &&
            x.ts === ts &&
            (x.thread_ts === undefined || x.thread_ts === x.ts),
        );
        if (parent === undefined) return notOk('thread_not_found');
        parent.thread_ts = parent.ts;
        const message = post(channel, argString(args, 'text') ?? '', parent.ts);
        return json({
          ok: true,
          channel: channel.id,
          ts: message.ts,
          message: view(message, state.messages),
        });
      },
    },
    {
      name: 'add_reaction',
      description: 'Add a reaction emoji to a message',
      inputSchema: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: 'The ID of the channel containing the message',
          },
          timestamp: { type: 'string', description: 'The timestamp of the message to react to' },
          reaction: { type: 'string', description: 'The name of the emoji reaction (without ::)' },
        },
        required: ['channel_id', 'timestamp', 'reaction'],
      },
      annotations: {
        title: 'Add reaction',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: (args) => {
        const channel = channelOf(args);
        if (channel === undefined) return notOk('channel_not_found');
        const message = state.messages.find(
          (x) => x.channel === channel.id && x.ts === argString(args, 'timestamp'),
        );
        if (message === undefined) return notOk('message_not_found');
        const name = (argString(args, 'reaction') ?? '').replace(/:/g, '');
        message.reactions ??= [];
        const existing = message.reactions.find((r) => r.name === name);
        if (existing !== undefined) return notOk('already_reacted');
        message.reactions.push({ name, users: ['U00ASSIST01'] });
        return json({ ok: true });
      },
    },
    {
      name: 'get_users',
      description:
        'Get a list of all users in the workspace with their basic profile information. Emails are not included; use get_user_profile.',
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
      annotations: { title: 'List users', readOnlyHint: true, openWorldHint: true },
      handler: (args) => {
        const p = page(chatUsers(), 'users', args, 100, 200);
        if ('error' in p) return notOk(p.error);
        return json({ ok: true, members: p.items, response_metadata: { next_cursor: p.next } });
      },
    },
    {
      // Declares no annotations, as many real servers' tools do.
      name: 'get_user_profile',
      description: 'Get detailed profile information for a specific user, including email',
      inputSchema: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: 'The ID of the user (e.g. U0123456789)' },
        },
        required: ['user_id'],
      },
      handler: (args) => {
        const id = argString(args, 'user_id');
        const p = ALL_PEOPLE.find((x) => x.chatId === id);
        if (p === undefined) {
          const bot = Object.values(BOTS).find((b) => b.chatId === id);
          if (bot === undefined) return notOk('user_not_found');
          return json({
            ok: true,
            profile: {
              real_name: bot.name,
              display_name: bot.handle,
              bot_id: `B${bot.chatId.slice(1)}`,
            },
          });
        }
        return json({
          ok: true,
          profile: {
            real_name: p.name,
            display_name: p.handle,
            email: p.email,
            title: p.chatDeleted === true ? '' : p.title,
            tz: 'Europe/Berlin',
            status_text: p.chatDeleted === true ? '' : 'Working',
          },
        });
      },
    },
  ];
  return createFakeBox({ name: 'chat-mcp', version: '1.4.2' }, tools, onCall);
}
