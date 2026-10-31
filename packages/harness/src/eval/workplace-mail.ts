/**
 * The workplace world's `mail` box: a mailbox server shaped like the
 * popular webmail MCP servers — search with a query syntax, read one
 * message, send (annotated destructive: an email cannot be unsent), draft,
 * relabel. Answers are plain text, as those servers' are.
 *
 * The assistant's mailbox is `assistant@northwind.dev`. One customer email
 * (from ops@globex.example) mentions an account ID that appears in an
 * error's title in the errors box.
 */

import type { SideEffect } from '../types.js';
import {
  argNumber,
  argString,
  createFakeBox,
  json,
  text,
  toolError,
  type FakeArgs,
  type FakeBox,
  type FakeTool,
} from './workplace-fake.js';
import { PEOPLE, WORLD_NOW } from './workplace-people.js';

export interface Email {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  subject: string;
  date: string;
  body: string;
  labels: string[];
}

export interface SentEmail {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
}

export interface MailState {
  inbox: Email[];
  sent: SentEmail[];
  drafts: SentEmail[];
  relabels: { id: string; add: string[]; remove: string[] }[];
}

export const CUSTOMER_EMAIL = 'ops@globex.example';
export const ASSISTANT_EMAIL = 'assistant@northwind.dev';

function email(
  n: number,
  from: string,
  subject: string,
  date: string,
  body: string,
  labels = ['INBOX'],
): Email {
  const id = `18f2${(0xa000 + n * 37).toString(16)}c${n}`;
  return { id, threadId: id, from, to: [ASSISTANT_EMAIL], subject, date, body, labels };
}

export function seedMail(): MailState {
  return {
    inbox: [
      email(
        1,
        'Globex Ops <ops@globex.example>',
        'Charged twice again??',
        '2026-10-13T16:20:00Z',
        'Hi,\n\nOur account acct_globex_0042 was charged twice for invoice INV-88213 on Oct 12. This is the second time this month. Can you tell us what is going on and whether it is being tracked?\n\nThanks,\nGlobex Operations',
        ['INBOX', 'UNREAD'],
      ),
      email(
        2,
        'Initech IT <it@initech.example>',
        'Invoice address change',
        '2026-10-13T11:05:00Z',
        'Hello, please update our billing address to 4120 Freidrich Lane, Austin TX. Account acct_initech_0007.',
      ),
      email(
        3,
        `Dana Okafor <${PEOPLE.dana.email}>`,
        '2.8 scope',
        '2026-10-12T18:30:00Z',
        'Must ship: idempotent refunds, retry budget. Nice to have: dark mode tokens.',
      ),
      email(
        4,
        'Errors Digest <digest@northwind.errors.example>',
        'Weekly digest for northwind',
        '2026-10-12T07:00:00Z',
        'checkout-api: 6 new issues. billing-worker: 10 new issues. notify-svc: 2 new issues.',
      ),
      email(
        5,
        'billing-alerts@northwind.dev',
        'Daily ledger reconciliation: 37 mismatches',
        '2026-10-10T06:00:00Z',
        'Reconciliation found 37 accounts with duplicate charges. See INC-2041.',
      ),
      email(
        6,
        'Conference Team <events@devconf.example>',
        'Your talk was accepted!',
        '2026-10-09T09:00:00Z',
        'Congratulations! Please confirm by Friday.',
        ['INBOX', 'CATEGORY_PROMOTIONS'],
      ),
      email(
        7,
        `Grace Liu <${PEOPLE.grace.email}>`,
        'QA sign-off 2.7.3',
        '2026-10-14T08:40:00Z',
        'Blocked on the currency TypeError in checkout-api. Will sign off once it is fixed.',
        ['INBOX', 'UNREAD'],
      ),
      email(
        8,
        'Globex Billing <billing@globex.example>',
        'PO for Q4',
        '2026-10-06T10:00:00Z',
        'Attached is our purchase order for Q4. No action needed on your side.',
      ),
    ],
    sent: [],
    drafts: [],
    relabels: [],
  };
}

// ---------------------------------------------------------------------------
// Search

const DAY = 86_400_000;

/** An `after:`/`before:` date (`2026/10/13`, `2026-10-13` or epoch seconds), as UTC ms. */
function searchDate(value: string): number | undefined {
  if (/^\d{9,}$/.test(value)) return Number(value) * 1000;
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value);
  if (m === null) return undefined;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** A `newer_than:`/`older_than:` period (`2d`, `1m`, `1y`) in ms. */
function searchPeriod(value: string): number | undefined {
  const m = /^(\d+)([dmy])$/.exec(value);
  if (m === null) return undefined;
  return Number(m[1]) * DAY * (m[2] === 'd' ? 1 : m[2] === 'm' ? 30 : 365);
}

/**
 * Whether `e` matches a search query, with the mail search operators the
 * real service supports — `from:` `to:` `subject:` `label:` `in:` `is:`
 * `has:` `after:` `before:` `newer_than:` `older_than:`, free text, and `-`
 * to negate a term — so an operator is never silently ignored. Dates are
 * UTC, relative periods end at {@link WORLD_NOW}.
 */
function matches(e: Email, query: string): boolean {
  const tokens = query.match(/(?:-?\S+:"[^"]*"|-?"[^"]*"|\S+)/g) ?? [];
  const at = Date.parse(e.date);
  const term = (raw: string): boolean => {
    const m = /^(from|to|subject|label|is|in|has|after|before|newer_than|older_than):(.*)$/i.exec(
      raw,
    );
    const strip = (v: string): string => v.replace(/^"|"$/g, '').toLowerCase();
    if (m === null) {
      const needle = strip(raw);
      return `${e.subject}\n${e.body}\n${e.from}`.toLowerCase().includes(needle);
    }
    const key = (m[1] as string).toLowerCase();
    const value = strip(m[2] as string);
    const labels = e.labels.map((l) => l.toLowerCase());
    switch (key) {
      case 'from':
        return e.from.toLowerCase().includes(value);
      case 'to':
        return e.to.some((t) => t.toLowerCase().includes(value));
      case 'subject':
        return e.subject.toLowerCase().includes(value);
      case 'label':
        return labels.includes(value);
      case 'in':
        return value === 'anywhere' || labels.includes(value);
      case 'is':
        return value === 'read' ? !labels.includes('unread') : labels.includes(value);
      case 'has':
        return false; // no message has attachments, stars by colour, or user labels
      case 'after':
      case 'before': {
        const t = searchDate(value);
        if (t === undefined) return false;
        return key === 'after' ? at >= t : at < t;
      }
      default: {
        const ms = searchPeriod(value);
        if (ms === undefined) return false;
        const edge = Date.parse(WORLD_NOW) - ms;
        return key === 'newer_than' ? at >= edge : at < edge;
      }
    }
  };
  return tokens.every((raw) => (raw.startsWith('-') ? !term(raw.slice(1)) : term(raw)));
}

/** Label IDs a message can be given: the system labels (no user labels exist). */
const LABEL_IDS: ReadonlySet<string> = new Set([
  'INBOX',
  'UNREAD',
  'STARRED',
  'IMPORTANT',
  'SPAM',
  'TRASH',
  'CATEGORY_PERSONAL',
  'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
]);

function addresses(args: FakeArgs, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string').map((x) => x.trim());
}

const SEND_SCHEMA = {
  type: 'object',
  properties: {
    to: {
      type: 'array',
      items: { type: 'string' },
      description: 'List of recipient email addresses',
    },
    subject: { type: 'string', description: 'Email subject' },
    body: { type: 'string', description: 'Email body content (plain text)' },
    cc: { type: 'array', items: { type: 'string' }, description: 'List of CC recipients' },
    bcc: { type: 'array', items: { type: 'string' }, description: 'List of BCC recipients' },
    inReplyTo: { type: 'string', description: 'Message ID being replied to' },
    threadId: { type: 'string', description: 'Thread ID to reply to' },
  },
  required: ['to', 'subject', 'body'],
} as const;

/** The mail box over `state`. */
export function createMailBox(state: MailState, onCall?: (call: SideEffect) => void): FakeBox {
  const compose = (args: FakeArgs): SentEmail | string => {
    const to = addresses(args, 'to');
    const cc = addresses(args, 'cc');
    const bcc = addresses(args, 'bcc');
    if (to === undefined || cc === undefined || bcc === undefined)
      return 'Recipients must be arrays of email addresses.';
    if (to.length === 0) return 'At least one recipient is required.';
    const bad = [...to, ...cc, ...bcc].find((a) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));
    if (bad !== undefined) return `Invalid email address: ${bad}`;
    const inReplyTo = argString(args, 'inReplyTo');
    return {
      to,
      cc,
      bcc,
      subject: argString(args, 'subject') ?? '',
      body: argString(args, 'body') ?? '',
      ...(inReplyTo !== undefined ? { inReplyTo } : {}),
    };
  };

  const tools: FakeTool[] = [
    {
      name: 'search_emails',
      description:
        'Searches for emails using search syntax (from:, to:, subject:, label:, is:unread, free text). Returns ID, subject, sender and date of each match, newest first.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: "Search query (e.g., 'from:example@gmail.com')" },
          maxResults: {
            type: 'number',
            description: 'Maximum number of results to return (default 10)',
          },
        },
        required: ['query'],
      },
      annotations: { title: 'Search emails', readOnlyHint: true, openWorldHint: true },
      handler: (args) => {
        const query = argString(args, 'query') ?? '';
        const max = Math.max(argNumber(args, 'maxResults') ?? 10, 1);
        const hits = state.inbox
          .filter((e) => matches(e, query))
          .toSorted((a, b) => b.date.localeCompare(a.date))
          .slice(0, max);
        if (hits.length === 0) return text('No messages found.');
        return text(
          hits
            .map((e) => `ID: ${e.id}\nSubject: ${e.subject}\nFrom: ${e.from}\nDate: ${e.date}\n`)
            .join('\n'),
        );
      },
    },
    {
      name: 'read_email',
      description: 'Retrieves the content of a specific email',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'ID of the email message to retrieve' },
        },
        required: ['messageId'],
      },
      annotations: { title: 'Read email', readOnlyHint: true, openWorldHint: true },
      handler: (args) => {
        const e = state.inbox.find((x) => x.id === argString(args, 'messageId'));
        if (e === undefined)
          return toolError(
            `Error: Requested entity was not found (message ${argString(args, 'messageId') ?? ''}).`,
          );
        return text(
          `Thread ID: ${e.threadId}\nSubject: ${e.subject}\nFrom: ${e.from}\nTo: ${e.to.join(', ')}\nDate: ${e.date}\n\n${e.body}`,
        );
      },
    },
    {
      name: 'send_email',
      description: 'Sends a new email',
      inputSchema: SEND_SCHEMA,
      annotations: {
        title: 'Send email',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: (args) => {
        const m = compose(args);
        if (typeof m === 'string') return toolError(m);
        state.sent.push(m);
        return text(
          `Email sent successfully with ID: 19a0${state.sent.length.toString(16).padStart(4, '0')}`,
        );
      },
    },
    {
      name: 'draft_email',
      description: 'Draft a new email (saved, not sent)',
      inputSchema: SEND_SCHEMA,
      annotations: {
        title: 'Draft email',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      handler: (args) => {
        const m = compose(args);
        if (typeof m === 'string') return toolError(m);
        state.drafts.push(m);
        return text(`Email draft created successfully with ID: r-${state.drafts.length}`);
      },
    },
    {
      name: 'modify_email',
      description: 'Modifies email labels (move to different folders, mark read/unread)',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'ID of the email message to modify' },
          addLabelIds: { type: 'array', items: { type: 'string' } },
          removeLabelIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['messageId'],
      },
      annotations: {
        title: 'Modify email labels',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: (args) => {
        const e = state.inbox.find((x) => x.id === argString(args, 'messageId'));
        if (e === undefined) return toolError('Error: Requested entity was not found.');
        const add = addresses(args, 'addLabelIds') ?? [];
        const remove = addresses(args, 'removeLabelIds') ?? [];
        // Label IDs, not names: an unknown one is the API's 400.
        const unknown = [...add, ...remove].find((l) => !LABEL_IDS.has(l));
        if (unknown !== undefined) return toolError(`Error: Invalid label: ${unknown}`);
        e.labels = [...new Set([...e.labels.filter((l) => !remove.includes(l)), ...add])];
        state.relabels.push({ id: e.id, add, remove });
        return json({ id: e.id, labelIds: e.labels });
      },
    },
  ];
  return createFakeBox({ name: 'mail-mcp', version: '1.1.11' }, tools, onCall);
}
