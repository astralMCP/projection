/**
 * The workplace world's `docs` box: a block-based docs/wiki server shaped
 * like the popular one's official MCP server, down to its tool names
 * (`API-post-search`, `API-get-block-children`, …, generated from an
 * OpenAPI spec). Deliberately token-heavy, as the real one is: every page,
 * block and database row comes back as the full API object — parent,
 * timestamps, created_by/last_edited_by, and rich text as arrays of
 * annotated runs with `plain_text` and `href`.
 *
 * Quirks kept on purpose:
 *
 * - content is nested: a page's children are blocks, and a block with
 *   `has_children` (a toggle, a table, a toggleable heading) needs its own
 *   `API-get-block-children` call — the on-call table is three levels down;
 * - people appear as user mentions whose `plain_text` is the display name
 *   (`@Aiko Tanaka`) next to a docs-only UUID; no email anywhere;
 * - IDs are UUIDs, accepted with or without dashes;
 * - appending (`API-patch-block-children`) takes the API's nested block JSON
 *   and answers a malformed child with a 400-style validation error.
 */

import type { SideEffect } from '../types.js';
import {
  argNumber,
  argString,
  createFakeBox,
  decodeCursor,
  encodeCursor,
  json,
  toolError,
  type FakeArgs,
  type FakeBox,
  type FakeTool,
} from './workplace-fake.js';
import { PEOPLE, type Person } from './workplace-people.js';

export interface RichText {
  type: 'text' | 'mention';
  text?: { content: string; link: null };
  mention?: { type: 'user'; user: { object: 'user'; id: string } };
  annotations: {
    bold: boolean;
    italic: boolean;
    strikethrough: boolean;
    underline: boolean;
    code: boolean;
    color: string;
  };
  plain_text: string;
  href: null;
}

export interface DocBlock {
  id: string;
  /** The page or block this block is a child of. */
  parent: string;
  type: string;
  /** The type-specific payload (`{ rich_text, color, checked? }`, `{ cells }`, …). */
  data: Record<string, unknown>;
  /** Order key within the parent. */
  order: number;
  createdBy: string;
  createdTime: string;
}

export interface DocPage {
  id: string;
  title: string;
  icon: string;
  /** `workspace`, a page ID, or a database ID. */
  parent:
    | { type: 'workspace' }
    | { type: 'page_id'; page_id: string }
    | { type: 'database_id'; database_id: string };
  /** Database row properties beyond the title. */
  properties?: Record<string, unknown>;
  lastEdited: string;
}

export interface DocDatabase {
  id: string;
  title: string;
  parent: string;
  schema: Record<string, { type: string }>;
}

export interface DocsState {
  pages: DocPage[];
  databases: DocDatabase[];
  blocks: DocBlock[];
  /** Appends and deletes the episode made, in order. */
  mutations: { kind: 'append' | 'delete' | 'update'; blockId: string; detail: unknown }[];
}

// ---------------------------------------------------------------------------
// IDs

export const DOC_IDS = {
  home: '0b6a5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d',
  oncall: '1f0c9e8d-7b6a-4c5d-8e3f-2a1b0c9d8e7f',
  oncallQ3: '1f0c9e8d-7b6a-4c5d-8e3f-2a1b0c9d0001',
  oncallQ3Table: '1f0c9e8d-7b6a-4c5d-8e3f-2a1b0c9d0002',
  oncallQ4: '1f0c9e8d-7b6a-4c5d-8e3f-2a1b0c9d0003',
  oncallQ4Table: '1f0c9e8d-7b6a-4c5d-8e3f-2a1b0c9d0004',
  services: '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d',
  postmortems: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
  inc2041: '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a',
  inc2041Actions: '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e0a01',
  inc2033: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b',
  inc2033Actions: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f0a01',
  runbookBilling: '6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c',
  qaPlan: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
} as const;

const BOT_USER = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';

// ---------------------------------------------------------------------------
// Rich text

const PLAIN = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: 'default',
};

export function rt(content: string, annotations: Partial<RichText['annotations']> = {}): RichText {
  return {
    type: 'text',
    text: { content, link: null },
    annotations: { ...PLAIN, ...annotations },
    plain_text: content,
    href: null,
  };
}

export function mention(p: Person): RichText {
  return {
    type: 'mention',
    mention: { type: 'user', user: { object: 'user', id: p.docsId } },
    annotations: { ...PLAIN },
    plain_text: `@${p.name}`,
    href: null,
  };
}

/** The plain text of a rich-text array. */
export function plainText(runs: unknown): string {
  if (!Array.isArray(runs)) return '';
  return runs
    .map((r) => {
      if (typeof r !== 'object' || r === null) return '';
      const run = r as Record<string, unknown>;
      if (typeof run['plain_text'] === 'string') return run['plain_text'];
      const t = run['text'];
      if (
        typeof t === 'object' &&
        t !== null &&
        typeof (t as Record<string, unknown>)['content'] === 'string'
      ) {
        return (t as Record<string, unknown>)['content'] as string;
      }
      return '';
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Fixture

const LOREM = [
  'This page is maintained by the platform team and reviewed every quarter. If something here is wrong, fix it and mention the change in the weekly sync so the rest of the team hears about it.',
  'Historical context lives in the linked postmortems; prefer linking to them over restating their conclusions here, because restated conclusions drift out of date faster than anyone notices.',
  'When in doubt, page the secondary rather than waiting: a false page costs minutes, a missed page costs customers. The escalation policy below is the order to follow.',
];

function seedBlocks(): DocBlock[] {
  const blocks: DocBlock[] = [];
  let n = 0;
  const add = (
    parent: string,
    type: string,
    data: Record<string, unknown>,
    id?: string,
  ): string => {
    n += 1;
    const blockId =
      id ?? `b10c${String(n).padStart(4, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
    blocks.push({
      id: blockId,
      parent,
      type,
      data,
      order: n,
      createdBy: PEOPLE.dana.docsId,
      createdTime: '2026-09-01T10:00:00.000Z',
    });
    return blockId;
  };
  const para = (parent: string, ...runs: RichText[]): string =>
    add(parent, 'paragraph', { rich_text: runs, color: 'default' });
  const heading = (
    parent: string,
    level: 1 | 2 | 3,
    content: string,
    toggleable = false,
    id?: string,
  ): string =>
    add(
      parent,
      `heading_${level}`,
      { rich_text: [rt(content)], is_toggleable: toggleable, color: 'default' },
      id,
    );
  const bullet = (parent: string, content: string): string =>
    add(parent, 'bulleted_list_item', { rich_text: [rt(content)], color: 'default' });
  const todo = (parent: string, content: string, checked: boolean): string =>
    add(parent, 'to_do', { rich_text: [rt(content)], checked, color: 'default' });
  const table = (parent: string, id: string, rows: [string, Person, Person][]): void => {
    add(parent, 'table', { table_width: 3, has_column_header: true, has_row_header: false }, id);
    add(id, 'table_row', {
      cells: [
        [rt('Week of', { bold: true })],
        [rt('Primary', { bold: true })],
        [rt('Secondary', { bold: true })],
      ],
    });
    for (const [week, primary, secondary] of rows) {
      add(id, 'table_row', { cells: [[rt(week)], [mention(primary)], [mention(secondary)]] });
    }
  };
  const P = PEOPLE;

  // Engineering home: child pages and databases.
  add(DOC_IDS.home, 'paragraph', {
    rich_text: [rt('Start here. Everything engineering-wide is linked below.')],
    color: 'default',
  });
  add(DOC_IDS.home, 'child_page', { title: 'On-call rotation' }, DOC_IDS.oncall);
  add(DOC_IDS.home, 'child_database', { title: 'Services' }, DOC_IDS.services);
  add(DOC_IDS.home, 'child_database', { title: 'Postmortems' }, DOC_IDS.postmortems);
  add(DOC_IDS.home, 'child_page', { title: 'Runbook: billing-worker' }, DOC_IDS.runbookBilling);
  add(DOC_IDS.home, 'child_page', { title: 'Release 2.8 QA plan' }, DOC_IDS.qaPlan);

  // On-call rotation: the table is page → toggle → table → rows.
  heading(DOC_IDS.oncall, 1, 'How on-call works');
  for (const p of LOREM) para(DOC_IDS.oncall, rt(p));
  add(DOC_IDS.oncall, 'callout', {
    rich_text: [
      rt(
        'This page is the source of truth for the rotation. Swaps are agreed in #ops and then edited here. Weeks start on Monday (UTC).',
      ),
    ],
    icon: { type: 'emoji', emoji: '📟' },
    color: 'yellow_background',
  });
  add(
    DOC_IDS.oncall,
    'toggle',
    { rich_text: [rt('2026 Q3 rotation')], color: 'default' },
    DOC_IDS.oncallQ3,
  );
  table(DOC_IDS.oncallQ3, DOC_IDS.oncallQ3Table, [
    ['2026-09-14', P.omar, P.aiko],
    ['2026-09-21', P.sam, P.jonas],
    ['2026-09-28', P.jonas, P.sam],
  ]);
  add(
    DOC_IDS.oncall,
    'toggle',
    { rich_text: [rt('2026 Q4 rotation')], color: 'default' },
    DOC_IDS.oncallQ4,
  );
  table(DOC_IDS.oncallQ4, DOC_IDS.oncallQ4Table, [
    ['2026-10-05', P.priya, P.omar],
    ['2026-10-12', P.aiko, P.marco],
    ['2026-10-19', P.dana, P.priya],
    ['2026-10-26', P.jonas, P.sam],
    ['2026-11-02', P.omar, P.aiko],
  ]);
  para(
    DOC_IDS.oncall,
    rt('Escalation: page the secondary after 15 minutes, then the engineering manager.'),
  );

  // INC-2041 postmortem.
  heading(DOC_IDS.inc2041, 2, 'Summary');
  para(
    DOC_IDS.inc2041,
    rt(
      'On 2026-10-09 billing-worker retried ledger writes that had already committed, double-charging 37 accounts for about 40 minutes. ',
    ),
    rt('Root cause: ', { bold: true }),
    rt('retries did not carry the original idempotency key.'),
  );
  heading(DOC_IDS.inc2041, 2, 'Timeline');
  for (const line of [
    '14:02 UTC — retry storm begins after a ledger-db failover',
    '14:09 UTC — first duplicate-charge alert',
    '14:15 UTC — incident declared',
    '14:31 UTC — retries paused',
    '14:42 UTC — duplicate charges stop',
    '16:00 UTC — refunds plan agreed',
  ]) {
    bullet(DOC_IDS.inc2041, line);
  }
  heading(DOC_IDS.inc2041, 2, 'Action items', true, DOC_IDS.inc2041Actions);
  todo(DOC_IDS.inc2041Actions, 'Add idempotency key check before ledger write', true);
  todo(DOC_IDS.inc2041Actions, 'Alert when retry queue depth > 500', false);
  heading(DOC_IDS.inc2041, 2, 'Lessons');
  para(DOC_IDS.inc2041, rt(LOREM[1] as string));

  // INC-2033 postmortem (a decoy with its own action items).
  heading(DOC_IDS.inc2033, 2, 'Summary');
  para(
    DOC_IDS.inc2033,
    rt('On 2026-09-22 notify-svc sent duplicate password-reset emails after a queue redelivery.'),
  );
  heading(DOC_IDS.inc2033, 2, 'Action items', true, DOC_IDS.inc2033Actions);
  todo(DOC_IDS.inc2033Actions, 'Deduplicate reset emails by token', true);
  todo(DOC_IDS.inc2033Actions, 'Alert on queue redelivery rate', false);

  // Runbook and QA plan: long pages.
  heading(DOC_IDS.runbookBilling, 1, 'billing-worker runbook');
  for (let k = 0; k < 9; k += 1) para(DOC_IDS.runbookBilling, rt(LOREM[k % 3] as string));
  heading(DOC_IDS.runbookBilling, 2, 'Owner');
  para(
    DOC_IDS.runbookBilling,
    rt('Owned by '),
    mention(P.jonas),
    rt('. See the Services database for the current owner of every service.'),
  );
  heading(DOC_IDS.qaPlan, 1, 'Release 2.8 QA plan');
  for (let k = 0; k < 6; k += 1) para(DOC_IDS.qaPlan, rt(LOREM[(k + 1) % 3] as string));

  return blocks;
}

function servicesRow(
  name: string,
  owner: Person,
  tier: string,
  channel: string,
  id: string,
): DocPage {
  return {
    id,
    title: name,
    icon: '🧩',
    parent: { type: 'database_id', database_id: DOC_IDS.services },
    properties: {
      Owner: {
        id: 'own%3A',
        type: 'people',
        people: [
          {
            object: 'user',
            id: owner.docsId,
            name: owner.name,
            avatar_url: null,
            type: 'person',
            person: {},
          },
        ],
      },
      Tier: {
        id: 'tr%3B',
        type: 'select',
        select: { id: `sel-${tier}`, name: tier, color: tier === 'Tier 1' ? 'red' : 'gray' },
      },
      'Chat channel': { id: 'ch%3C', type: 'rich_text', rich_text: [rt(channel)] },
      'Last reviewed': {
        id: 'lr%3D',
        type: 'date',
        date: { start: '2026-10-01', end: null, time_zone: null },
      },
    },
    lastEdited: '2026-10-02T09:30:00.000Z',
  };
}

export function seedDocs(): DocsState {
  const P = PEOPLE;
  const page = (
    id: string,
    title: string,
    icon: string,
    parent: DocPage['parent'],
    lastEdited: string,
    properties?: Record<string, unknown>,
  ): DocPage => ({
    id,
    title,
    icon,
    parent,
    lastEdited,
    ...(properties !== undefined ? { properties } : {}),
  });
  const pm = (inc: string, date: string, status: string): Record<string, unknown> => ({
    Incident: { id: 'inc%3A', type: 'rich_text', rich_text: [rt(inc)] },
    Date: { id: 'dt%3B', type: 'date', date: { start: date, end: null, time_zone: null } },
    Status: {
      id: 'st%3C',
      type: 'status',
      status: { id: `s-${status}`, name: status, color: 'green' },
    },
  });
  return {
    pages: [
      page(
        DOC_IDS.home,
        'Engineering Home',
        '🏠',
        { type: 'workspace' },
        '2026-10-01T08:00:00.000Z',
      ),
      page(
        DOC_IDS.oncall,
        'On-call rotation',
        '📟',
        { type: 'page_id', page_id: DOC_IDS.home },
        '2026-10-08T10:12:00.000Z',
      ),
      page(
        DOC_IDS.runbookBilling,
        'Runbook: billing-worker',
        '📕',
        { type: 'page_id', page_id: DOC_IDS.home },
        '2026-09-30T08:00:00.000Z',
      ),
      page(
        DOC_IDS.qaPlan,
        'Release 2.8 QA plan',
        '🧪',
        { type: 'page_id', page_id: DOC_IDS.home },
        '2026-10-06T08:00:00.000Z',
      ),
      page(
        DOC_IDS.inc2041,
        'INC-2041: billing-worker double charges',
        '🔥',
        { type: 'database_id', database_id: DOC_IDS.postmortems },
        '2026-10-10T09:00:00.000Z',
        pm('INC-2041', '2026-10-09', 'In review'),
      ),
      page(
        DOC_IDS.inc2033,
        'INC-2033: duplicate password-reset emails',
        '🔥',
        { type: 'database_id', database_id: DOC_IDS.postmortems },
        '2026-09-25T09:00:00.000Z',
        pm('INC-2033', '2026-09-22', 'Done'),
      ),
      servicesRow(
        'payments-api',
        P.marco,
        'Tier 1',
        '#eng-backend',
        '8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0001',
      ),
      servicesRow(
        'checkout-api',
        P.priya,
        'Tier 1',
        '#eng-backend',
        '8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0002',
      ),
      servicesRow(
        'billing-worker',
        P.jonas,
        'Tier 1',
        '#eng-backend',
        '8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0003',
      ),
      servicesRow(
        'notify-svc',
        P.sam,
        'Tier 2',
        '#eng-backend',
        '8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0004',
      ),
      servicesRow(
        'ledger',
        P.omar,
        'Tier 1',
        '#eng-backend',
        '8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0005',
      ),
      servicesRow('storefront', P.marcoB, 'Tier 2', '#web', '8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0006'),
    ],
    databases: [
      {
        id: DOC_IDS.services,
        title: 'Services',
        parent: DOC_IDS.home,
        schema: {
          Name: { type: 'title' },
          Owner: { type: 'people' },
          Tier: { type: 'select' },
          'Chat channel': { type: 'rich_text' },
          'Last reviewed': { type: 'date' },
        },
      },
      {
        id: DOC_IDS.postmortems,
        title: 'Postmortems',
        parent: DOC_IDS.home,
        schema: {
          Name: { type: 'title' },
          Incident: { type: 'rich_text' },
          Date: { type: 'date' },
          Status: { type: 'status' },
        },
      },
    ],
    blocks: seedBlocks(),
    mutations: [],
  };
}

// ---------------------------------------------------------------------------
// API objects

/** A UUID with dashes, from a dashed or undashed one; undefined when not a UUID. */
export function normalizeId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const hex = value.trim().toLowerCase().replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/.test(hex)) return undefined;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const user = (id: string): Record<string, unknown> => ({ object: 'user', id });

function pageObject(state: DocsState, p: DocPage): Record<string, unknown> {
  return {
    object: 'page',
    id: p.id,
    created_time: '2026-09-01T10:00:00.000Z',
    last_edited_time: p.lastEdited,
    created_by: user(PEOPLE.dana.docsId),
    last_edited_by: user(PEOPLE.dana.docsId),
    cover: null,
    icon: { type: 'emoji', emoji: p.icon },
    parent: p.parent,
    archived: false,
    in_trash: false,
    properties: {
      ...p.properties,
      [p.parent.type === 'database_id' ? 'Name' : 'title']: {
        id: 'title',
        type: 'title',
        title: [rt(p.title)],
      },
    },
    url: `https://docs.northwind.dev/${p.title.replace(/[^A-Za-z0-9]+/g, '-')}-${p.id.replace(/-/g, '')}`,
    public_url: null,
    has_children: state.blocks.some((b) => b.parent === p.id),
  };
}

function databaseObject(d: DocDatabase): Record<string, unknown> {
  return {
    object: 'database',
    id: d.id,
    title: [rt(d.title)],
    description: [],
    parent: { type: 'page_id', page_id: d.parent },
    properties: Object.fromEntries(
      Object.entries(d.schema).map(([name, s]) => [
        name,
        { id: name.slice(0, 3).toLowerCase(), name, type: s.type, [s.type]: {} },
      ]),
    ),
    is_inline: false,
    archived: false,
    url: `https://docs.northwind.dev/${d.id.replace(/-/g, '')}`,
  };
}

function blockObject(state: DocsState, b: DocBlock): Record<string, unknown> {
  const parentIsPage = state.pages.some((p) => p.id === b.parent);
  return {
    object: 'block',
    id: b.id,
    parent: parentIsPage
      ? { type: 'page_id', page_id: b.parent }
      : { type: 'block_id', block_id: b.parent },
    created_time: b.createdTime,
    last_edited_time: b.createdTime,
    created_by: user(b.createdBy),
    last_edited_by: user(b.createdBy),
    has_children:
      state.blocks.some((c) => c.parent === b.id) ||
      b.type === 'child_page' ||
      b.type === 'child_database',
    archived: false,
    in_trash: false,
    type: b.type,
    [b.type]: b.data,
  };
}

/** The children of `parent`, in order. */
export function childrenOf(state: DocsState, parent: string): DocBlock[] {
  return state.blocks.filter((b) => b.parent === parent).toSorted((a, b) => a.order - b.order);
}

function listResponse(
  results: unknown[],
  next: string | null,
  type: string,
): Record<string, unknown> {
  return {
    object: 'list',
    results,
    next_cursor: next,
    has_more: next !== null,
    type,
    [type]: {},
    request_id: 'req-7b1e4c9a',
  };
}

const ALLOWED_CHILD_TYPES = [
  'paragraph',
  'to_do',
  'bulleted_list_item',
  'numbered_list_item',
  'heading_1',
  'heading_2',
  'heading_3',
  'quote',
  'callout',
];

/** Validate one appended child; a string is the validation message. */
function validateChild(
  child: unknown,
  k: number,
): { type: string; data: Record<string, unknown> } | string {
  if (typeof child !== 'object' || child === null || Array.isArray(child))
    return `body.children[${k}] should be an object`;
  const c = child as Record<string, unknown>;
  const type = c['type'];
  const inferred =
    typeof type === 'string' ? type : ALLOWED_CHILD_TYPES.find((t) => c[t] !== undefined);
  if (inferred === undefined || !ALLOWED_CHILD_TYPES.includes(inferred)) {
    return `body.children[${k}].type should be one of ${ALLOWED_CHILD_TYPES.map((t) => `"${t}"`).join(', ')}`;
  }
  const payload = c[inferred];
  if (typeof payload !== 'object' || payload === null)
    return `body.children[${k}].${inferred} should be defined`;
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p['rich_text']))
    return `body.children[${k}].${inferred}.rich_text should be an array`;
  const runs = (p['rich_text'] as unknown[]).map((r, j) => {
    if (typeof r !== 'object' || r === null) return undefined;
    const run = r as Record<string, unknown>;
    const t = run['text'];
    if (
      typeof t !== 'object' ||
      t === null ||
      typeof (t as Record<string, unknown>)['content'] !== 'string'
    )
      return j;
    return rt((t as Record<string, unknown>)['content'] as string);
  });
  const bad = runs.findIndex((r) => typeof r !== 'object');
  if (bad >= 0)
    return `body.children[${k}].${inferred}.rich_text[${bad}].text.content should be a string`;
  const data: Record<string, unknown> = { rich_text: runs, color: 'default' };
  if (inferred === 'to_do') data['checked'] = p['checked'] === true;
  return { type: inferred, data };
}

const validationError = (message: string): ReturnType<typeof toolError> =>
  toolError(
    JSON.stringify({
      object: 'error',
      status: 400,
      code: 'validation_error',
      message: `body failed validation: ${message}.`,
    }),
  );

const notFound = (id: string | undefined): ReturnType<typeof toolError> =>
  toolError(
    JSON.stringify({
      object: 'error',
      status: 404,
      code: 'object_not_found',
      message: `Could not find block with ID: ${id ?? ''}. Make sure the relevant pages and databases are shared with your integration.`,
    }),
  );

function paged<T>(
  items: readonly T[],
  scope: string,
  args: FakeArgs,
): { slice: T[]; next: string | null } | undefined {
  const size = Math.min(Math.max(argNumber(args, 'page_size') ?? 100, 1), 100);
  const cursor = argString(args, 'start_cursor');
  let offset = 0;
  if (cursor !== undefined && cursor !== '') {
    const decoded = decodeCursor(scope, cursor);
    if (decoded === undefined) return undefined;
    offset = decoded;
  }
  const slice = items.slice(offset, offset + size);
  return { slice, next: offset + size < items.length ? encodeCursor(scope, offset + size) : null };
}

/** The docs box over `state`. */
export function createDocsBox(state: DocsState, onCall?: (call: SideEffect) => void): FakeBox {
  let seq = 0;
  const blockOrPage = (id: string | undefined): string | undefined =>
    id !== undefined &&
    (state.pages.some((p) => p.id === id) || state.blocks.some((b) => b.id === id))
      ? id
      : undefined;

  const tools: FakeTool[] = [
    {
      name: 'API-post-search',
      description:
        'Search by title. Returns pages and databases the integration can access whose title contains the query (all of them for an empty query).',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The text that the API compares page and database titles against.',
          },
          filter: {
            type: 'object',
            description:
              'A set of criteria, `value` and `property` keys, that limits the results to either only pages or only databases.',
            properties: {
              value: { type: 'string', enum: ['page', 'database'] },
              property: { type: 'string', enum: ['object'] },
            },
          },
          sort: {
            type: 'object',
            properties: {
              direction: { type: 'string', enum: ['ascending', 'descending'] },
              timestamp: { type: 'string', enum: ['last_edited_time'] },
            },
          },
          start_cursor: {
            type: 'string',
            description: 'A cursor value returned in a previous response.',
          },
          page_size: {
            type: 'integer',
            description:
              'The number of items from the full list to include in the response. Maximum: 100.',
            default: 100,
          },
        },
      },
      annotations: { title: 'Search by title', readOnlyHint: true, openWorldHint: true },
      handler: (args) => {
        const q = (argString(args, 'query') ?? '').toLowerCase();
        const filter = args['filter'];
        const only =
          typeof filter === 'object' && filter !== null
            ? (filter as Record<string, unknown>)['value']
            : undefined;
        const results: Record<string, unknown>[] = [
          ...(only === 'database'
            ? []
            : state.pages
                .filter((p) => p.title.toLowerCase().includes(q))
                .map((p) => pageObject(state, p))),
          ...(only === 'page'
            ? []
            : state.databases.filter((d) => d.title.toLowerCase().includes(q)).map(databaseObject)),
        ];
        const p = paged(results, `search:${q}:${String(only)}`, args);
        if (p === undefined) return validationError('start_cursor is invalid');
        return json(listResponse(p.slice, p.next, 'page_or_database'));
      },
    },
    {
      name: 'API-retrieve-a-page',
      description:
        'Retrieve a page (its properties, not its content; use API-get-block-children with the page ID for the content)',
      inputSchema: {
        type: 'object',
        properties: {
          page_id: { type: 'string', description: 'Identifier for a page' },
          filter_properties: {
            type: 'string',
            description: 'A list of page property value IDs associated with the page.',
          },
        },
        required: ['page_id'],
      },
      annotations: { title: 'Retrieve a page', readOnlyHint: true, openWorldHint: true },
      handler: (args) => {
        const id = normalizeId(argString(args, 'page_id'));
        const p = state.pages.find((x) => x.id === id);
        if (p === undefined) return notFound(argString(args, 'page_id'));
        return json(pageObject(state, p));
      },
    },
    {
      name: 'API-get-block-children',
      description:
        'Retrieve block children. Returns the first level of children of a block or page; a child with has_children needs its own call.',
      inputSchema: {
        type: 'object',
        properties: {
          block_id: { type: 'string', description: 'Identifier for a block (a page ID works too)' },
          start_cursor: {
            type: 'string',
            description:
              'If supplied, this endpoint will return a page of results starting after the cursor provided.',
          },
          page_size: {
            type: 'integer',
            description:
              'The number of items from the full list desired in the response. Maximum: 100',
            default: 100,
          },
        },
        required: ['block_id'],
      },
      annotations: { title: 'Retrieve block children', readOnlyHint: true, openWorldHint: true },
      handler: (args) => {
        const id = blockOrPage(normalizeId(argString(args, 'block_id')));
        if (id === undefined) return notFound(argString(args, 'block_id'));
        const p = paged(childrenOf(state, id), `children:${id}`, args);
        if (p === undefined) return validationError('start_cursor is invalid');
        return json(
          listResponse(
            p.slice.map((b) => blockObject(state, b)),
            p.next,
            'block',
          ),
        );
      },
    },
    {
      name: 'API-post-database-query',
      description: 'Query a database. Returns its rows (pages), optionally filtered and sorted.',
      inputSchema: {
        type: 'object',
        properties: {
          database_id: { type: 'string', description: 'Identifier for a database.' },
          filter: {
            type: 'object',
            description:
              'When supplied, limits which pages are returned based on the filter conditions. Supported here: {"property": "<name>", "title"|"rich_text": {"contains": "<text>"}}',
          },
          sorts: { type: 'array', items: { type: 'object' } },
          start_cursor: { type: 'string' },
          page_size: { type: 'integer', default: 100 },
        },
        required: ['database_id'],
      },
      annotations: { title: 'Query a database', readOnlyHint: true, openWorldHint: true },
      handler: (args) => {
        const id = normalizeId(argString(args, 'database_id'));
        const db = state.databases.find((d) => d.id === id);
        if (db === undefined) return notFound(argString(args, 'database_id'));
        let rows = state.pages.filter(
          (p) => p.parent.type === 'database_id' && p.parent.database_id === db.id,
        );
        const filter = args['filter'];
        if (typeof filter === 'object' && filter !== null) {
          const f = filter as Record<string, unknown>;
          const cond = (f['title'] ?? f['rich_text']) as Record<string, unknown> | undefined;
          const needle =
            typeof cond?.['contains'] === 'string'
              ? (cond['contains'] as string).toLowerCase()
              : undefined;
          if (needle !== undefined) {
            const prop = f['property'];
            rows = rows.filter((p) => {
              if (prop === 'Name' || prop === 'title' || f['title'] !== undefined)
                return p.title.toLowerCase().includes(needle);
              const v = (p.properties?.[String(prop)] as Record<string, unknown> | undefined)?.[
                'rich_text'
              ];
              return plainText(v).toLowerCase().includes(needle);
            });
          }
        }
        const p = paged(
          rows.map((r) => pageObject(state, r)),
          `query:${db.id}:${JSON.stringify(filter ?? null)}`,
          args,
        );
        if (p === undefined) return validationError('start_cursor is invalid');
        return json(listResponse(p.slice, p.next, 'page_or_database'));
      },
    },
    {
      name: 'API-patch-block-children',
      description:
        'Append block children. Creates and appends new children blocks to the parent block_id specified (a page ID appends to the end of the page).',
      inputSchema: {
        type: 'object',
        properties: {
          block_id: {
            type: 'string',
            description: 'Identifier for a block. Also accepts a page ID.',
          },
          children: {
            type: 'array',
            description:
              'Child content to append to a container block as an array of block objects, e.g. {"type": "to_do", "to_do": {"rich_text": [{"type": "text", "text": {"content": "..."}}], "checked": false}}',
            items: { type: 'object' },
          },
          after: {
            type: 'string',
            description:
              'The ID of the existing block that the new block should be appended after.',
          },
        },
        required: ['block_id', 'children'],
      },
      annotations: {
        title: 'Append block children',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      handler: (args) => {
        const id = blockOrPage(normalizeId(argString(args, 'block_id')));
        if (id === undefined) return notFound(argString(args, 'block_id'));
        const children = args['children'];
        if (!Array.isArray(children) || children.length === 0)
          return validationError('body.children should be a non-empty array');
        const parsed = children.map((c, k) => validateChild(c, k));
        const bad = parsed.find((p) => typeof p === 'string');
        if (typeof bad === 'string') return validationError(bad);
        const created: DocBlock[] = [];
        for (const p of parsed as { type: string; data: Record<string, unknown> }[]) {
          seq += 1;
          const block: DocBlock = {
            id: `c0ffee00-0000-4000-8000-${String(seq).padStart(12, '0')}`,
            parent: id,
            type: p.type,
            data: p.data,
            order: 10_000 + seq,
            createdBy: BOT_USER,
            createdTime: '2026-10-14T12:00:00.000Z',
          };
          state.blocks.push(block);
          created.push(block);
        }
        state.mutations.push({
          kind: 'append',
          blockId: id,
          detail: created.map((b) => ({ type: b.type, text: plainText(b.data['rich_text']) })),
        });
        return json(
          listResponse(
            created.map((b) => blockObject(state, b)),
            null,
            'block',
          ),
        );
      },
    },
    {
      name: 'API-delete-a-block',
      description: 'Delete a block (moves it to the trash)',
      inputSchema: {
        type: 'object',
        properties: { block_id: { type: 'string', description: 'Identifier for a block' } },
        required: ['block_id'],
      },
      annotations: {
        title: 'Delete a block',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      handler: (args) => {
        const id = normalizeId(argString(args, 'block_id'));
        const k = state.blocks.findIndex((b) => b.id === id);
        if (k < 0) return notFound(argString(args, 'block_id'));
        const [removed] = state.blocks.splice(k, 1);
        state.mutations.push({ kind: 'delete', blockId: id as string, detail: removed?.type });
        return json({ ...blockObject(state, removed as DocBlock), archived: true, in_trash: true });
      },
    },
  ];
  return createFakeBox({ name: 'docs-mcp-server', version: '1.9.0' }, tools, onCall);
}
