/**
 * The summit world's `notion` box: a fake of Notion's official MCP server,
 * `@notionhq/notion-mcp-server` v2.5.2 (makenotion/notion-mcp-server tag
 * v2.5.2, commit 730ae781ba28beeaf0865025a3f2ed4c25ea2387, 2026-09-20).
 *
 * Definitions: the server generates its 24 tools from
 * `scripts/notion-openapi.json` (Notion API 2025-09-03, "Data Source
 * Edition") with `src/openapi-mcp-server/openapi/parser.ts`. We ran a port
 * of that converter over the spec at the tag and checked every tool's
 * name, description, properties and `required` against the server's own
 * snapshot (`openapi/__tests__/__snapshots__/notion-spec.snapshot.test.ts.snap`);
 * the result is test/fixtures/summit/notion-tools.json, served verbatim:
 * `API-<operationId>` names, "Notion | <summary>" descriptions with their
 * error responses, every schema carrying all component `$defs`, complex
 * parameters wrapped in `anyOf: [<schema>, {type: string}]`, annotations
 * `{title, readOnlyHint: true}` for GET and `{title, destructiveHint: true}`
 * for everything else (so `API-post-search` is "destructive").
 *
 * Behaviour kept from `mcp/proxy.ts` and `client/http-client.ts`:
 *
 * - no schema validation: the arguments become the HTTP request (path and
 *   query parameters by name, everything else — unknown keys included —
 *   the JSON body), and Notion's API answers;
 * - string arguments that look like JSON are parsed first
 *   (`deserializeParams`, up to three levels of encoding);
 * - a success is `JSON.stringify(response.data)`; an API error is NOT
 *   `isError`: it is the text `{"status":<code>,"object":"error","code":…,
 *   "message":…}` (the proxy's `status: 'error'` overwritten by the body's);
 * - Notion paginates with `start_cursor` / `page_size` (default and max
 *   100) and answers `has_more` / `next_cursor`; a block's children need
 *   their own call when `has_children`;
 * - rich text is arrays of runs (`plain_text`, `annotations`, `href`);
 *   people are user mentions and `people` properties; IDs are UUIDs,
 *   accepted with or without dashes;
 * - pages in a database have a `data_source_id` parent (2025-09-03);
 *   `API-query-data-source` takes Notion's filter and sort objects;
 * - the markdown endpoints render and parse Notion-flavoured markdown
 *   (approximated: headings, lists, to-dos, toggles as `<details>`, tables
 *   as `<table>`, mentions as `<mention-user>`, child pages as `<page>`).
 */

import catalogFixture from '../../test/fixtures/summit/notion-tools.json' with { type: 'json' };
import type { SideEffect } from '../types.js';
import {
  compactJson,
  createSummitBox,
  uuidFrom,
  type Args,
  type BoxResult,
  type SummitBox,
  type SummitTool,
} from './summit-core.js';
import { ASSISTANT, PEOPLE, type Person } from './summit-people.js';
import { stripeCustomerIds } from './summit-stripe.js';
import type { WorldTool } from './world.js';

const CATALOG = catalogFixture as unknown as { tools: WorldTool[] };
export const NOTION_TOOLS: readonly WorldTool[] = CATALOG.tools;
export const NOTION_WRITE_TOOLS: readonly string[] = [
  'API-patch-block-children',
  'API-update-a-block',
  'API-delete-a-block',
  'API-patch-page',
  'API-post-page',
  'API-create-a-comment',
  'API-update-a-data-source',
  'API-create-a-data-source',
  'API-move-page',
  'API-update-page-markdown',
];

// ---------------------------------------------------------------------------
// Rich text

export interface RichText {
  type: 'text' | 'mention';
  text?: { content: string; link: { url: string } | null };
  mention?:
    | { type: 'user'; user: { object: 'user'; id: string } }
    | { type: 'page'; page: { id: string } }
    | { type: 'date'; date: { start: string; end: null } };
  annotations: {
    bold: boolean;
    italic: boolean;
    strikethrough: boolean;
    underline: boolean;
    code: boolean;
    color: string;
  };
  plain_text: string;
  href: string | null;
}

const ANN = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: 'default',
};

export function rt(content: string, extra: Partial<RichText['annotations']> = {}): RichText {
  return {
    type: 'text',
    text: { content, link: null },
    annotations: { ...ANN, ...extra },
    plain_text: content,
    href: null,
  };
}

function mention(p: Person): RichText {
  return {
    type: 'mention',
    mention: { type: 'user', user: { object: 'user', id: p.notionId } },
    annotations: { ...ANN },
    plain_text: `@${p.name}`,
    href: null,
  };
}

export function plain(rich: unknown): string {
  return Array.isArray(rich)
    ? rich
        .map((r) =>
          String(
            (r as RichText).plain_text ??
              (r as { text?: { content?: string } }).text?.content ??
              '',
          ),
        )
        .join('')
    : '';
}

// ---------------------------------------------------------------------------
// State

export interface NotionBlock {
  id: string;
  parent: string;
  type: string;
  data: Record<string, unknown>;
  created: string;
  edited: string;
  createdBy: string;
  archived?: boolean;
}

export interface NotionPage {
  id: string;
  /** `page:<id>`, `ds:<data source id>` or `workspace`. */
  parent: string;
  title: string;
  icon: string | null;
  properties: Record<string, unknown>;
  created: string;
  edited: string;
  createdBy: string;
  archived?: boolean;
  shared: boolean;
}

export interface NotionDataSource {
  id: string;
  databaseId: string;
  /** The page the database lives on. */
  pageId: string;
  title: string;
  schema: Record<string, { id: string; type: string; config: Record<string, unknown> }>;
  created: string;
}

export interface NotionState {
  pages: NotionPage[];
  blocks: NotionBlock[];
  dataSources: NotionDataSource[];
  comments: { id: string; parent: string; text: string; by: string; created: string }[];
  mutations: { kind: string; id: string; detail: Record<string, unknown> }[];
  seq: number;
}

const U = (seed: string): string => uuidFrom(`notion:${seed}`);

export const NOTION_IDS = {
  hq: U('page:hq'),
  cs: U('page:cs'),
  finance: U('page:finance'),
  engineering: U('page:engineering'),
  people: U('page:people'),
  escalation: U('page:escalation'),
  oncall: U('page:oncall'),
  releaseNotes: U('page:release-notes'),
  playbook: U('page:playbook'),
  closeChecklist: U('page:close-checklist'),
  revenueSep: U('page:revenue-sep'),
  accountsDb: U('db:accounts'),
  accountsDs: U('ds:accounts'),
  refundsDb: U('db:refunds'),
  refundsDs: U('ds:refunds'),
  incidentsDb: U('db:incidents'),
  incidentsDs: U('ds:incidents'),
} as const;

const T0 = '2026-03-04T10:12:00.000Z';

function selectOptions(
  names: string[],
  colors: string[],
): { id: string; name: string; color: string }[] {
  return names.map((name, i) => ({
    id: U(`opt:${name}`).slice(0, 4),
    name,
    color: colors[i % colors.length] as string,
  }));
}

const PLAN = selectOptions(
  ['Starter', 'Team', 'Business', 'Enterprise'],
  ['gray', 'blue', 'purple', 'orange'],
);
const HEALTH = selectOptions(['Green', 'Yellow', 'Red'], ['green', 'yellow', 'red']);
const REGION = selectOptions(['NA', 'EMEA', 'APAC'], ['blue', 'brown', 'pink']);
const SEVERITY = selectOptions(['SEV-1', 'SEV-2', 'SEV-3'], ['red', 'orange', 'yellow']);
const INC_STATUS = selectOptions(
  ['Investigating', 'Mitigated', 'Resolved'],
  ['red', 'yellow', 'green'],
);
const SERVICES = selectOptions(
  ['api', 'web-app', 'billing-worker', 'mobile-ios', 'marketing-site'],
  ['blue', 'green', 'purple', 'pink', 'gray'],
);
const REFUND_STATUS = selectOptions(
  ['Requested', 'Approved', 'Refunded', 'Rejected'],
  ['gray', 'blue', 'green', 'red'],
);

function dataSources(): NotionDataSource[] {
  const prop = (
    name: string,
    type: string,
    config: Record<string, unknown> = {},
  ): [string, { id: string; type: string; config: Record<string, unknown> }] => [
    name,
    {
      id: type === 'title' ? 'title' : encodeURIComponent(U(`prop:${name}`).slice(0, 4)),
      type,
      config,
    },
  ];
  return [
    {
      id: NOTION_IDS.accountsDs,
      databaseId: NOTION_IDS.accountsDb,
      pageId: NOTION_IDS.cs,
      title: 'Customer Accounts',
      created: T0,
      schema: Object.fromEntries([
        prop('Account', 'title'),
        prop('Stripe customer', 'rich_text'),
        prop('Plan', 'select', { options: PLAN }),
        prop('CSM', 'people'),
        prop('Renewal date', 'date'),
        prop('ARR', 'number', { format: 'dollar' }),
        prop('MRR', 'number', { format: 'dollar' }),
        prop('Health', 'select', { options: HEALTH }),
        prop('Region', 'select', { options: REGION }),
      ]),
    },
    {
      id: NOTION_IDS.refundsDs,
      databaseId: NOTION_IDS.refundsDb,
      pageId: NOTION_IDS.finance,
      title: 'Refund log',
      created: '2025-01-15T09:00:00.000Z',
      schema: Object.fromEntries([
        prop('Request', 'title'),
        prop('Customer', 'rich_text'),
        prop('Amount', 'number', { format: 'dollar' }),
        prop('Status', 'select', { options: REFUND_STATUS }),
        prop('Requested on', 'date'),
        prop('Notes', 'rich_text'),
      ]),
    },
    {
      id: NOTION_IDS.incidentsDs,
      databaseId: NOTION_IDS.incidentsDb,
      pageId: NOTION_IDS.engineering,
      title: 'Incident log',
      created: '2024-06-02T09:00:00.000Z',
      schema: Object.fromEntries([
        prop('Name', 'title'),
        prop('Severity', 'select', { options: SEVERITY }),
        prop('Status', 'status', {
          options: INC_STATUS,
          groups: [
            { id: 'grp1', name: 'To-do', color: 'gray', option_ids: [INC_STATUS[0]?.id] },
            { id: 'grp2', name: 'In progress', color: 'blue', option_ids: [INC_STATUS[1]?.id] },
            { id: 'grp3', name: 'Complete', color: 'green', option_ids: [INC_STATUS[2]?.id] },
          ],
        }),
        prop('Date', 'date'),
        prop('Service', 'multi_select', { options: SERVICES }),
        prop('Sentry', 'rich_text'),
        prop('Owner', 'people'),
      ]),
    },
  ];
}

// ---------------------------------------------------------------------------
// Fixture rows

interface AccountRow {
  name: string;
  stripe?: string | undefined;
  plan: string;
  csm?: Person;
  renewal: string;
  arr: number;
  mrr: number | null;
  health: string;
  region: string;
}

/** The Customer Accounts rows the tasks are about, and noise around them. */
export function accountRows(): AccountRow[] {
  const ids = stripeCustomerIds();
  const P = PEOPLE;
  return [
    {
      name: 'Halcyon Bank',
      stripe: ids['halcyon'],
      plan: 'Enterprise',
      csm: P.aisha,
      renewal: '2027-03-19',
      arr: 30000,
      mrr: 2500,
      health: 'Green',
      region: 'NA',
    },
    {
      name: 'Orbital Freight',
      stripe: ids['orbital'],
      plan: 'Enterprise',
      csm: P.sam,
      renewal: '2026-11-21',
      arr: 29900,
      mrr: 2250,
      health: 'Yellow',
      region: 'EMEA',
    },
    {
      name: 'Meridian Clinics',
      stripe: ids['meridian'],
      plan: 'Enterprise',
      csm: P.tomas,
      renewal: '2026-11-07',
      arr: 33600,
      mrr: 2500,
      health: 'Green',
      region: 'NA',
    },
    {
      name: 'Pinecrest University',
      stripe: ids['pinecrest'],
      plan: 'Enterprise',
      renewal: '2026-11-03',
      arr: 27000,
      mrr: 1740,
      health: 'Yellow',
      region: 'NA',
    },
    {
      name: 'Vantage Retail',
      stripe: ids['vantage'],
      plan: 'Enterprise',
      csm: P.tom,
      renewal: '2026-11-30',
      arr: 30000,
      mrr: 2500,
      health: 'Red',
      region: 'NA',
    },
    {
      name: 'Quarry & Co',
      stripe: ids['quarry'],
      plan: 'Enterprise',
      csm: P.aisha,
      renewal: '2026-12-01',
      arr: 60000,
      mrr: 2500,
      health: 'Green',
      region: 'EMEA',
    },
    {
      name: 'Atlas Shipping',
      plan: 'Enterprise',
      renewal: '2026-11-18',
      arr: 45000,
      mrr: null,
      health: 'Green',
      region: 'APAC',
    },
    {
      name: 'Northgate Insurance',
      plan: 'Enterprise',
      csm: P.sam,
      renewal: '2026-10-31',
      arr: 52000,
      mrr: null,
      health: 'Yellow',
      region: 'NA',
    },
    {
      name: 'Solace Hospitals',
      plan: 'Enterprise',
      csm: P.aisha,
      renewal: '2026-11-12',
      arr: 41000,
      mrr: null,
      health: 'Green',
      region: 'EMEA',
    },
    {
      name: 'Kestrel Analytics',
      stripe: ids['kestrel'],
      plan: 'Business',
      renewal: '2026-11-15',
      arr: 6264,
      mrr: 522,
      health: 'Red',
      region: 'NA',
    },
    {
      name: 'Brightpath Logistics',
      stripe: ids['brightpath'],
      plan: 'Business',
      csm: P.sam,
      renewal: '2027-04-23',
      arr: 3480,
      mrr: 290,
      health: 'Green',
      region: 'NA',
    },
    {
      name: 'Sable Security',
      stripe: ids['sable'],
      plan: 'Business',
      csm: P.tomas,
      renewal: '2027-03-28',
      arr: 11484,
      mrr: 957,
      health: 'Green',
      region: 'NA',
    },
    {
      name: 'Velvet Hotels',
      stripe: ids['velvet'],
      plan: 'Business',
      csm: P.aisha,
      renewal: '2026-11-25',
      arr: 16704,
      mrr: 1392,
      health: 'Green',
      region: 'EMEA',
    },
    {
      name: 'Beacon Credit Union',
      stripe: ids['beacon'],
      plan: 'Business',
      csm: P.sam,
      renewal: '2027-03-17',
      arr: 9048,
      mrr: 754,
      health: 'Yellow',
      region: 'NA',
    },
    {
      name: 'Quill Publishing',
      stripe: ids['quill'],
      plan: 'Business',
      csm: P.tomas,
      renewal: '2026-10-20',
      arr: 11600,
      mrr: 967,
      health: 'Green',
      region: 'NA',
    },
    {
      name: 'Yarrow Foods',
      stripe: ids['yarrow'],
      plan: 'Business',
      renewal: '2026-12-03',
      arr: 7308,
      mrr: 609,
      health: 'Green',
      region: 'NA',
    },
    {
      name: 'Keystone Realty',
      stripe: ids['keystone'],
      plan: 'Business',
      csm: P.sam,
      renewal: '2026-11-22',
      arr: 4176,
      mrr: 348,
      health: 'Red',
      region: 'NA',
    },
    {
      name: 'Lumora Health',
      stripe: ids['lumora'],
      plan: 'Team',
      csm: P.aisha,
      renewal: '2026-12-01',
      arr: 4176,
      mrr: 348,
      health: 'Green',
      region: 'NA',
    },
    {
      name: 'Parallax Media',
      stripe: ids['parallax'],
      plan: 'Team',
      renewal: '2027-01-13',
      arr: 3168,
      mrr: 264,
      health: 'Green',
      region: 'NA',
    },
    {
      name: 'Riverbend Schools',
      stripe: ids['riverbend'],
      plan: 'Team',
      csm: P.tomas,
      renewal: '2027-08-28',
      arr: 14400,
      mrr: 1200,
      health: 'Green',
      region: 'NA',
    },
    {
      name: 'Tidal Energy',
      stripe: ids['tidal'],
      plan: 'Team',
      renewal: '2026-11-12',
      arr: 2016,
      mrr: 168,
      health: 'Yellow',
      region: 'EMEA',
    },
    {
      name: 'Willow Care',
      stripe: ids['willow'],
      plan: 'Team',
      renewal: '2026-11-15',
      arr: 1584,
      mrr: 132,
      health: 'Red',
      region: 'EMEA',
    },
    {
      name: 'Xylo Games',
      stripe: ids['xylo'],
      plan: 'Team',
      renewal: '2026-11-19',
      arr: 2448,
      mrr: 204,
      health: 'Green',
      region: 'APAC',
    },
    {
      name: 'Ostrava Robotics',
      stripe: ids['ostrava'],
      plan: 'Team',
      csm: P.tomas,
      renewal: '2026-11-20',
      arr: 4176,
      mrr: 348,
      health: 'Red',
      region: 'EMEA',
    },
    {
      name: 'Juniper Studios',
      stripe: ids['juniper'],
      plan: 'Team',
      renewal: '2026-12-17',
      arr: 1152,
      mrr: 96,
      health: 'Yellow',
      region: 'NA',
    },
    {
      name: 'Acorn Dental',
      stripe: ids['acornDental'],
      plan: 'Starter',
      renewal: '2026-11-02',
      arr: 228,
      mrr: 19,
      health: 'Yellow',
      region: 'NA',
    },
    {
      name: 'Cobalt Yoga Studio',
      stripe: ids['cobalt'],
      plan: 'Starter',
      renewal: '2026-11-30',
      arr: 228,
      mrr: 19,
      health: 'Green',
      region: 'NA',
    },
  ];
}

interface RefundRow {
  request: string;
  customer: string;
  amount: number;
  status: string;
  requested: string;
  notes?: string;
}

export function refundRows(): RefundRow[] {
  const ids = stripeCustomerIds();
  return [
    {
      request: 'RR-1041',
      customer: ids['umber'] as string,
      amount: 48,
      status: 'Refunded',
      requested: '2026-09-04',
      notes: 'Cancelled within 7 days',
    },
    {
      request: 'RR-1043',
      customer: ids['xylo'] as string,
      amount: 204,
      status: 'Refunded',
      requested: '2026-09-18',
    },
    {
      request: 'RR-1044',
      customer: ids['mosaic'] as string,
      amount: 203,
      status: 'Rejected',
      requested: '2026-09-22',
      notes: 'Outside refund window',
    },
    {
      request: 'RR-1046',
      customer: ids['parallax'] as string,
      amount: 210,
      status: 'Refunded',
      requested: '2026-10-21',
    },
    {
      request: 'RR-1049',
      customer: ids['yarrow'] as string,
      amount: 60.9,
      status: 'Approved',
      requested: '2026-10-23',
    },
    {
      request: 'RR-1056',
      customer: ids['velvet'] as string,
      amount: 80,
      status: 'Approved',
      requested: '2026-10-26',
    },
  ];
}

interface IncidentRow {
  name: string;
  severity: string;
  status: string;
  date: string;
  services: string[];
  sentry?: string;
  owner?: Person;
}

function incidentRows(): IncidentRow[] {
  const P = PEOPLE;
  return [
    {
      name: 'Calendar sync delays for Google accounts',
      severity: 'SEV-2',
      status: 'Resolved',
      date: '2026-10-22',
      services: ['api'],
      sentry: 'API-4QX',
      owner: P.jonas,
    },
    {
      name: 'Webhook deliveries failing with 502',
      severity: 'SEV-3',
      status: 'Resolved',
      date: '2026-10-11',
      services: ['api'],
      sentry: 'API-4V8',
      owner: P.nadia,
    },
    {
      name: 'iOS crash on recurring events',
      severity: 'SEV-2',
      status: 'Mitigated',
      date: '2026-10-12',
      services: ['mobile-ios'],
      sentry: 'MOBILE-IOS-1K',
      owner: P.kenji,
    },
    {
      name: 'Checkout latency spike',
      severity: 'SEV-1',
      status: 'Mitigated',
      date: '2026-10-27',
      services: ['api', 'web-app'],
      owner: P.nadia,
    },
    {
      name: 'Dunning emails not sent',
      severity: 'SEV-3',
      status: 'Investigating',
      date: '2026-10-21',
      services: ['billing-worker'],
      sentry: 'BILLING-WORKER-2M',
      owner: P.priya,
    },
    {
      name: 'Login loop for SAML users',
      severity: 'SEV-2',
      status: 'Resolved',
      date: '2026-09-30',
      services: ['web-app'],
      owner: P.marcus,
    },
    {
      name: 'Billing worker queue backlog',
      severity: 'SEV-3',
      status: 'Resolved',
      date: '2026-09-14',
      services: ['billing-worker'],
      owner: P.priya,
    },
  ];
}

// ---------------------------------------------------------------------------
// Seeding

function propValue(ds: NotionDataSource, name: string, value: unknown): unknown {
  const def = ds.schema[name] as { id: string; type: string };
  const base = { id: def.id, type: def.type };
  switch (def.type) {
    case 'title':
      return { ...base, title: [rt(String(value))] };
    case 'rich_text':
      return { ...base, rich_text: value === undefined || value === '' ? [] : [rt(String(value))] };
    case 'select':
    case 'status': {
      const opts = (ds.schema[name]?.config['options'] ?? []) as {
        id: string;
        name: string;
        color: string;
      }[];
      const opt = opts.find((o) => o.name === value);
      return { ...base, [def.type]: opt ?? null };
    }
    case 'multi_select': {
      const opts = (ds.schema[name]?.config['options'] ?? []) as {
        id: string;
        name: string;
        color: string;
      }[];
      return {
        ...base,
        multi_select: (value as string[]).map(
          (v) =>
            opts.find((o) => o.name === v) ?? {
              id: U(`opt:${v}`).slice(0, 4),
              name: v,
              color: 'default',
            },
        ),
      };
    }
    case 'people':
      return { ...base, people: value === undefined ? [] : [userObject(value as Person)] };
    case 'date':
      return {
        ...base,
        date:
          value === undefined || value === null
            ? null
            : { start: String(value), end: null, time_zone: null },
      };
    case 'number':
      return { ...base, number: value === undefined ? null : value };
    default:
      return { ...base, [def.type]: value };
  }
}

function userObject(p: Person): Record<string, unknown> {
  return {
    object: 'user',
    id: p.notionId,
    name: p.name,
    avatar_url: null,
    type: 'person',
    person: { email: p.email },
  };
}

export function seedNotion(): NotionState {
  const P = PEOPLE;
  const pages: NotionPage[] = [];
  const blocks: NotionBlock[] = [];
  const ds = dataSources();
  const page = (
    id: string,
    parent: string,
    title: string,
    icon: string | null,
    createdBy: Person,
    created: string,
    shared = true,
  ): NotionPage => {
    const p: NotionPage = {
      id,
      parent,
      title,
      icon,
      properties: { title: { id: 'title', type: 'title', title: [rt(title)] } },
      created,
      edited: created,
      createdBy: createdBy.notionId,
      shared,
    };
    pages.push(p);
    return p;
  };
  let order = 0;
  const block = (
    parent: string,
    type: string,
    data: Record<string, unknown>,
    by: Person = P.raj,
    created = T0,
  ): NotionBlock => {
    order += 1;
    const b: NotionBlock = {
      id: U(`block:${parent}:${order}`),
      parent,
      type,
      data,
      created,
      edited: created,
      createdBy: by.notionId,
    };
    blocks.push(b);
    return b;
  };
  const para = (parent: string, text: string | RichText[], by?: Person): NotionBlock =>
    block(
      parent,
      'paragraph',
      { rich_text: typeof text === 'string' ? [rt(text)] : text, color: 'default' },
      by,
    );
  const heading = (parent: string, level: 1 | 2 | 3, text: string, by?: Person): NotionBlock =>
    block(
      parent,
      `heading_${level}`,
      { rich_text: [rt(text)], is_toggleable: false, color: 'default' },
      by,
    );
  const bullet = (parent: string, text: string | RichText[], by?: Person): NotionBlock =>
    block(
      parent,
      'bulleted_list_item',
      { rich_text: typeof text === 'string' ? [rt(text)] : text, color: 'default' },
      by,
    );
  const childPage = (parent: string, p: NotionPage): NotionBlock => {
    const b = block(parent, 'child_page', { title: p.title });
    b.id = p.id;
    return b;
  };
  const childDb = (parent: string, dbId: string, title: string): NotionBlock => {
    const b = block(parent, 'child_database', { title });
    b.id = dbId;
    return b;
  };

  const hq = page(
    NOTION_IDS.hq,
    'workspace',
    'Fernhill HQ',
    '🏔️',
    P.raj,
    '2025-01-06T09:00:00.000Z',
  );
  const cs = page(
    NOTION_IDS.cs,
    `page:${hq.id}`,
    'Customer Success',
    '🤝',
    P.olivia,
    '2025-01-06T09:10:00.000Z',
  );
  const fin = page(
    NOTION_IDS.finance,
    `page:${hq.id}`,
    'Finance',
    '💰',
    P.dana,
    '2025-01-06T09:20:00.000Z',
  );
  const eng = page(
    NOTION_IDS.engineering,
    `page:${hq.id}`,
    'Engineering',
    '🛠️',
    P.raj,
    '2025-01-06T09:30:00.000Z',
  );
  const people = page(
    NOTION_IDS.people,
    `page:${hq.id}`,
    'People & Hiring',
    '🧑‍🤝‍🧑',
    P.olivia,
    '2025-01-06T09:40:00.000Z',
    false,
  );
  para(
    hq.id,
    'Start here. Team spaces are linked below; ask in #general if you cannot find something.',
  );
  childPage(hq.id, cs);
  childPage(hq.id, fin);
  childPage(hq.id, eng);
  childPage(hq.id, people);

  // Customer Success
  para(
    cs.id,
    'Every paying account has a row in Customer Accounts. CSM is the account owner; leave it empty if the account is unowned.',
    P.olivia,
  );
  childDb(cs.id, NOTION_IDS.accountsDb, 'Customer Accounts');
  const playbook = page(
    NOTION_IDS.playbook,
    `page:${cs.id}`,
    'Renewal playbook',
    '📘',
    P.olivia,
    '2025-04-02T09:00:00.000Z',
  );
  childPage(cs.id, playbook);
  heading(playbook.id, 2, '60 days out', P.olivia);
  bullet(
    playbook.id,
    'CSM posts the renewal in #cs-renewals with the account and renewal date.',
    P.olivia,
  );
  bullet(playbook.id, 'Unowned Enterprise accounts are escalated to the Support Lead.', P.olivia);

  // Finance
  para(
    fin.id,
    [
      rt('Finance space. Refunds are approved by '),
      mention(P.dana),
      rt(' and logged in the Refund log below.'),
    ],
    P.dana,
  );
  childDb(fin.id, NOTION_IDS.refundsDb, 'Refund log');
  const close = page(
    NOTION_IDS.closeChecklist,
    `page:${fin.id}`,
    'Month-end close checklist',
    '✅',
    P.dana,
    '2025-02-01T09:00:00.000Z',
  );
  childPage(fin.id, close);
  for (const item of [
    'Reconcile Stripe payouts',
    'Chase open invoices older than 14 days',
    'Review refunds over $500',
    'Export revenue report',
  ]) {
    block(close.id, 'to_do', { rich_text: [rt(item)], checked: false, color: 'default' }, P.dana);
  }
  const rev = page(
    NOTION_IDS.revenueSep,
    `page:${fin.id}`,
    'Monthly revenue — September 2026',
    '📈',
    P.dana,
    '2026-10-02T09:00:00.000Z',
  );
  childPage(fin.id, rev);
  para(rev.id, 'Gross revenue $212,480.00; refunds $1,912.00; net $210,568.00.', P.dana);

  // Engineering
  childDb(eng.id, NOTION_IDS.incidentsDb, 'Incident log');
  const esc = page(
    NOTION_IDS.escalation,
    `page:${eng.id}`,
    'Escalation policy',
    '🚨',
    P.nadia,
    '2026-10-05T09:00:00.000Z',
  );
  const oncall = page(
    NOTION_IDS.oncall,
    `page:${eng.id}`,
    'On-call',
    '📟',
    P.nadia,
    '2025-02-11T09:00:00.000Z',
  );
  const notes = page(
    NOTION_IDS.releaseNotes,
    `page:${eng.id}`,
    'Release notes 2026',
    '🗒️',
    P.raj,
    '2026-01-05T09:00:00.000Z',
  );
  childPage(eng.id, esc);
  childPage(eng.id, oncall);
  childPage(eng.id, notes);
  heading(esc.id, 2, 'Sentry escalation', P.nadia);
  para(
    esc.id,
    [
      rt('Any '),
      rt('unresolved', { bold: true }),
      rt(' Sentry issue in the '),
      rt('production', { bold: true }),
      rt(' environment that has affected '),
      rt('more than 50 users in the last 24 hours', { bold: true }),
      rt(' must be posted to #incidents.'),
    ],
    P.nadia,
  );
  para(
    esc.id,
    'Post one message that lists each such issue’s short ID and the number of users it affected in that 24-hour window. Resolved and ignored issues are not escalated.',
    P.nadia,
  );
  heading(esc.id, 2, 'Customer escalations', P.nadia);
  para(esc.id, 'Enterprise customer outages page the account’s CSM and the Support Lead.', P.nadia);
  const old = block(
    esc.id,
    'toggle',
    { rich_text: [rt('Previous policy (until 2026-10-01)')], color: 'default' },
    P.nadia,
  );
  para(old.id, 'Post any issue with more than 100 events in the last hour to #eng.', P.nadia);
  para(
    oncall.id,
    [rt('Primary this week: '), mention(P.nadia), rt('. Secondary: '), mention(P.jonas), rt('.')],
    P.nadia,
  );
  // A long page: 128 blocks (needs paging past the first 100 children).
  for (let v = 1; v <= 16; v++) {
    heading(
      notes.id,
      2,
      `2026.${v <= 8 ? '0' : ''}${Math.ceil(v / 2) + (v > 8 ? 1 : 0)}.${(v % 4) + 1}`,
      P.raj,
    );
    for (let i = 0; i < 7; i++)
      bullet(
        notes.id,
        `Change ${v}-${i + 1}: ${['bug fixes', 'performance', 'calendar sync', 'billing', 'admin', 'mobile', 'API'][i]} improvements`,
        P.raj,
      );
  }

  // Database rows
  const dsAcc = ds[0] as NotionDataSource;
  accountRows().forEach((row, i) => {
    const id = U(`row:account:${row.name}`);
    const created = new Date(Date.parse('2025-03-01T09:00:00Z') + i * 86_400_000 * 5).toISOString();
    pages.push({
      id,
      parent: `ds:${dsAcc.id}`,
      title: row.name,
      icon: null,
      created,
      edited: created,
      createdBy: P.olivia.notionId,
      shared: true,
      properties: {
        Account: propValue(dsAcc, 'Account', row.name),
        'Stripe customer': propValue(dsAcc, 'Stripe customer', row.stripe ?? ''),
        Plan: propValue(dsAcc, 'Plan', row.plan),
        CSM: propValue(dsAcc, 'CSM', row.csm),
        'Renewal date': propValue(dsAcc, 'Renewal date', row.renewal),
        ARR: propValue(dsAcc, 'ARR', row.arr),
        MRR: propValue(dsAcc, 'MRR', row.mrr ?? undefined),
        Health: propValue(dsAcc, 'Health', row.health),
        Region: propValue(dsAcc, 'Region', row.region),
      },
    });
  });
  const dsRef = ds[1] as NotionDataSource;
  refundRows().forEach((row, i) => {
    const id = U(`row:refund:${row.request}`);
    const created = `${row.requested}T1${i % 10}:00:00.000Z`;
    pages.push({
      id,
      parent: `ds:${dsRef.id}`,
      title: row.request,
      icon: null,
      created,
      edited: created,
      createdBy: P.dana.notionId,
      shared: true,
      properties: {
        Request: propValue(dsRef, 'Request', row.request),
        Customer: propValue(dsRef, 'Customer', row.customer),
        Amount: propValue(dsRef, 'Amount', row.amount),
        Status: propValue(dsRef, 'Status', row.status),
        'Requested on': propValue(dsRef, 'Requested on', row.requested),
        Notes: propValue(dsRef, 'Notes', row.notes ?? ''),
      },
    });
  });
  const dsInc = ds[2] as NotionDataSource;
  incidentRows().forEach((row) => {
    const id = U(`row:incident:${row.name}`);
    const created = `${row.date}T12:00:00.000Z`;
    pages.push({
      id,
      parent: `ds:${dsInc.id}`,
      title: row.name,
      icon: null,
      created,
      edited: created,
      createdBy: P.nadia.notionId,
      shared: true,
      properties: {
        Name: propValue(dsInc, 'Name', row.name),
        Severity: propValue(dsInc, 'Severity', row.severity),
        Status: propValue(dsInc, 'Status', row.status),
        Date: propValue(dsInc, 'Date', row.date),
        Service: propValue(dsInc, 'Service', row.services),
        Sentry: propValue(dsInc, 'Sentry', row.sentry ?? ''),
        Owner: propValue(dsInc, 'Owner', row.owner),
      },
    });
  });
  return { pages, blocks, dataSources: ds, comments: [], mutations: [], seq: 0 };
}

// ---------------------------------------------------------------------------
// Rendering

const NOTION_PEOPLE: readonly Person[] = Object.values(PEOPLE);

function partialUser(id: string): Record<string, unknown> {
  return { object: 'user', id };
}

function compactId(id: string): string {
  return id.replace(/-/g, '');
}

function pageUrl(p: NotionPage): string {
  return `https://www.notion.so/${p.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${compactId(p.id)}`;
}

function parentObject(state: NotionState, parent: string): Record<string, unknown> {
  if (parent === 'workspace') return { type: 'workspace', workspace: true };
  const [kind, id] = parent.split(':') as [string, string];
  if (kind === 'ds') {
    const ds = state.dataSources.find((d) => d.id === id) as NotionDataSource;
    return { type: 'data_source_id', data_source_id: ds.id, database_id: ds.databaseId };
  }
  if (kind === 'page') return { type: 'page_id', page_id: id };
  return { type: 'block_id', block_id: id };
}

function renderPage(state: NotionState, p: NotionPage): Record<string, unknown> {
  return {
    object: 'page',
    id: p.id,
    created_time: p.created,
    last_edited_time: p.edited,
    created_by: partialUser(p.createdBy),
    last_edited_by: partialUser(p.createdBy),
    cover: null,
    icon: p.icon === null ? null : { type: 'emoji', emoji: p.icon },
    parent: parentObject(state, p.parent),
    archived: p.archived === true,
    in_trash: p.archived === true,
    is_locked: false,
    properties: p.properties,
    url: pageUrl(p),
    public_url: null,
  };
}

function renderBlock(state: NotionState, b: NotionBlock): Record<string, unknown> {
  const parentPage = state.pages.some((p) => p.id === b.parent);
  return {
    object: 'block',
    id: b.id,
    parent: parentPage
      ? { type: 'page_id', page_id: b.parent }
      : { type: 'block_id', block_id: b.parent },
    created_time: b.created,
    last_edited_time: b.edited,
    created_by: partialUser(b.createdBy),
    last_edited_by: partialUser(b.createdBy),
    has_children:
      b.type === 'child_page' || b.type === 'child_database'
        ? true
        : childrenOf(state, b.id).length > 0,
    archived: b.archived === true,
    in_trash: b.archived === true,
    type: b.type,
    [b.type]: b.data,
  };
}

function renderDataSource(state: NotionState, ds: NotionDataSource): Record<string, unknown> {
  return {
    object: 'data_source',
    id: ds.id,
    created_time: ds.created,
    last_edited_time: ds.created,
    created_by: partialUser(PEOPLE.olivia.notionId),
    last_edited_by: partialUser(PEOPLE.olivia.notionId),
    title: [rt(ds.title)],
    description: [],
    properties: Object.fromEntries(
      Object.entries(ds.schema).map(([name, d]) => [
        name,
        { id: d.id, name, type: d.type, [d.type]: d.config },
      ]),
    ),
    parent: { type: 'database_id', database_id: ds.databaseId },
    database_parent: { type: 'page_id', page_id: ds.pageId },
    archived: false,
    in_trash: false,
    is_inline: false,
    url: `https://www.notion.so/${compactId(ds.databaseId)}`,
    public_url: null,
  };
}

function renderDatabase(state: NotionState, ds: NotionDataSource): Record<string, unknown> {
  return {
    object: 'database',
    id: ds.databaseId,
    title: [rt(ds.title)],
    description: [],
    parent: { type: 'page_id', page_id: ds.pageId },
    is_inline: false,
    in_trash: false,
    is_locked: false,
    created_time: ds.created,
    last_edited_time: ds.created,
    data_sources: [{ id: ds.id, name: ds.title }],
    icon: null,
    cover: null,
    url: `https://www.notion.so/${compactId(ds.databaseId)}`,
    public_url: null,
  };
}

export function childrenOf(state: NotionState, parent: string): NotionBlock[] {
  return state.blocks.filter((b) => b.parent === parent && b.archived !== true);
}

/** All the plain text of a page's blocks (recursively), one line per block (graders). */
export function pageText(state: NotionState, pageId: string): string {
  const lines: string[] = [];
  const walk = (parent: string): void => {
    for (const b of childrenOf(state, parent)) {
      if (b.type === 'table_row')
        lines.push(((b.data['cells'] as unknown[][]) ?? []).map((c) => plain(c)).join(' | '));
      else if (b.type === 'child_page' || b.type === 'child_database')
        lines.push(String(b.data['title'] ?? ''));
      else lines.push(plain(b.data['rich_text']));
      walk(b.id);
    }
  };
  walk(pageId);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Markdown (Notion-flavoured, approximated)

function mdInline(rich: unknown): string {
  if (!Array.isArray(rich)) return '';
  return rich
    .map((r: RichText) => {
      if (r.type === 'mention' && r.mention?.type === 'user')
        return `<mention-user url="user://${r.mention.user.id}">${r.plain_text.replace(/^@/, '')}</mention-user>`;
      let t = r.plain_text;
      if (r.annotations?.code === true) t = `\`${t}\``;
      if (r.annotations?.bold === true) t = `**${t}**`;
      if (r.annotations?.italic === true) t = `*${t}*`;
      return t;
    })
    .join('');
}

function toMarkdown(state: NotionState, parent: string, indent = ''): string {
  const out: string[] = [];
  let n = 0;
  for (const b of childrenOf(state, parent)) {
    const text = mdInline(b.data['rich_text']);
    n = b.type === 'numbered_list_item' ? n + 1 : 0;
    const kids = (): string => toMarkdown(state, b.id, `${indent}\t`);
    switch (b.type) {
      case 'heading_1':
      case 'heading_2':
      case 'heading_3':
        out.push(`${indent}${'#'.repeat(Number(b.type.slice(-1)))} ${text}`);
        break;
      case 'bulleted_list_item':
        out.push(`${indent}- ${text}`, kids());
        break;
      case 'numbered_list_item':
        out.push(`${indent}${n}. ${text}`, kids());
        break;
      case 'to_do':
        out.push(`${indent}- [${b.data['checked'] === true ? 'x' : ' '}] ${text}`, kids());
        break;
      case 'toggle':
        out.push(
          `${indent}<details>`,
          `${indent}<summary>${text}</summary>`,
          kids(),
          `${indent}</details>`,
        );
        break;
      case 'quote':
        out.push(`${indent}> ${text}`);
        break;
      case 'divider':
        out.push(`${indent}---`);
        break;
      case 'code':
        out.push(
          `${indent}\`\`\`${String(b.data['language'] ?? '')}`,
          plainLines(b.data['rich_text']),
          `${indent}\`\`\``,
        );
        break;
      case 'child_page':
        out.push(
          `${indent}<page url="https://www.notion.so/${compactId(b.id)}">${String(b.data['title'])}</page>`,
        );
        break;
      case 'child_database':
        out.push(
          `${indent}<database url="https://www.notion.so/${compactId(b.id)}">${String(b.data['title'])}</database>`,
        );
        break;
      case 'table': {
        const rows = childrenOf(state, b.id);
        out.push(`${indent}<table header-row="${b.data['has_column_header'] === true}">`);
        for (const r of rows)
          out.push(
            `${indent}\t<tr>${((r.data['cells'] as unknown[][]) ?? []).map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`,
          );
        out.push(`${indent}</table>`);
        break;
      }
      default:
        out.push(`${indent}${text}`);
    }
  }
  return out.filter((l) => l !== '').join('\n');
}

function plainLines(rich: unknown): string {
  return plain(rich);
}

function parseInline(text: string): RichText[] {
  const out: RichText[] = [];
  const re = /<mention-user url="user:\/\/([0-9a-f-]+)">([^<]*)<\/mention-user>|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if ((m.index ?? 0) > last) out.push(rt(text.slice(last, m.index)));
    if (m[1] !== undefined) {
      const p = NOTION_PEOPLE.find((x) => x.notionId === m[1]);
      out.push(p !== undefined ? mention(p) : rt(m[2] ?? ''));
    } else out.push(rt(m[3] ?? '', { bold: true }));
    last = (m.index ?? 0) + m[0].length;
  }
  if (last < text.length) out.push(rt(text.slice(last)));
  return out.length === 0 ? [] : out;
}

interface ParsedBlock {
  type: string;
  data: Record<string, unknown>;
  children: ParsedBlock[];
}

/** Parse Notion-flavoured markdown into blocks (the subset {@link toMarkdown} writes, plus pipe tables). */
export function parseMarkdown(md: string): ParsedBlock[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: ParsedBlock[] = [];
  const stack: { indent: number; list: ParsedBlock[] }[] = [{ indent: -1, list: out }];
  const push = (indent: number, b: ParsedBlock): void => {
    while (stack.length > 1 && (stack.at(-1) as { indent: number }).indent >= indent) stack.pop();
    (stack.at(-1) as { list: ParsedBlock[] }).list.push(b);
    stack.push({ indent, list: b.children });
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    if (raw.trim() === '') continue;
    const indent = (/^[\t ]*/.exec(raw)?.[0] ?? '').replace(/ {2}/g, '\t').length;
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,3}) (.*)$/.exec(line)) !== null)
      push(indent, {
        type: `heading_${(m[1] as string).length}`,
        data: { rich_text: parseInline(m[2] as string), is_toggleable: false, color: 'default' },
        children: [],
      });
    else if ((m = /^[-*] \[( |x|X)\] (.*)$/.exec(line)) !== null)
      push(indent, {
        type: 'to_do',
        data: { rich_text: parseInline(m[2] as string), checked: m[1] !== ' ', color: 'default' },
        children: [],
      });
    else if ((m = /^[-*] (.*)$/.exec(line)) !== null)
      push(indent, {
        type: 'bulleted_list_item',
        data: { rich_text: parseInline(m[1] as string), color: 'default' },
        children: [],
      });
    else if ((m = /^\d+\. (.*)$/.exec(line)) !== null)
      push(indent, {
        type: 'numbered_list_item',
        data: { rich_text: parseInline(m[1] as string), color: 'default' },
        children: [],
      });
    else if ((m = /^> (.*)$/.exec(line)) !== null)
      push(indent, {
        type: 'quote',
        data: { rich_text: parseInline(m[1] as string), color: 'default' },
        children: [],
      });
    else if (/^-{3,}$/.test(line)) push(indent, { type: 'divider', data: {}, children: [] });
    else if (line.startsWith('```')) {
      const body: string[] = [];
      for (i++; i < lines.length && !(lines[i] as string).trim().startsWith('```'); i++)
        body.push(lines[i] as string);
      push(indent, {
        type: 'code',
        data: {
          rich_text: [rt(body.join('\n'))],
          language: line.slice(3) || 'plain text',
          caption: [],
        },
        children: [],
      });
    } else if (line.startsWith('<details>')) {
      const summary = /<summary>(.*)<\/summary>/.exec(lines[i + 1] ?? '');
      if (summary !== null) i++;
      push(indent, {
        type: 'toggle',
        data: { rich_text: parseInline(summary?.[1] ?? ''), color: 'default' },
        children: [],
      });
    } else if (line.startsWith('</details>')) {
      while (stack.length > 1 && (stack.at(-1) as { indent: number }).indent >= indent) stack.pop();
    } else if (line.startsWith('<table')) {
      const rows: string[][] = [];
      for (i++; i < lines.length && !(lines[i] as string).includes('</table>'); i++) {
        const cells = [...(lines[i] as string).matchAll(/<td>(.*?)<\/td>/g)].map(
          (c) => c[1] as string,
        );
        if (cells.length > 0) rows.push(cells);
      }
      push(indent, tableBlock(rows, /header-row="true"/.test(line)));
    } else if (line.startsWith('|')) {
      const rows: string[][] = [];
      for (; i < lines.length && (lines[i] as string).trim().startsWith('|'); i++) {
        const cells = (lines[i] as string)
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
      }
      i--;
      push(indent, tableBlock(rows, true));
    } else if (
      (m = /^<page url="[^"]*">(.*)<\/page>$/.exec(line)) !== null ||
      (m = /^<database url="[^"]*">(.*)<\/database>$/.exec(line)) !== null
    ) {
      // References to existing children: kept as-is by the caller.
      push(indent, {
        type: line.startsWith('<page') ? 'child_page' : 'child_database',
        data: { title: m[1] },
        children: [],
      });
    } else
      push(indent, {
        type: 'paragraph',
        data: { rich_text: parseInline(line), color: 'default' },
        children: [],
      });
  }
  return out;
}

function tableBlock(rows: string[][], header: boolean): ParsedBlock {
  const width = Math.max(1, ...rows.map((r) => r.length));
  return {
    type: 'table',
    data: { table_width: width, has_column_header: header, has_row_header: false },
    children: rows.map((r) => ({
      type: 'table_row',
      data: { cells: Array.from({ length: width }, (_, i) => parseInline(r[i] ?? '')) },
      children: [],
    })),
  };
}

// ---------------------------------------------------------------------------
// The proxy's argument normalisation (mcp/proxy.ts deserializeParams)

function unwrapJsonString(value: string): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth++) {
    const t = current.trim();
    const could =
      (t.startsWith('{') && t.endsWith('}')) ||
      (t.startsWith('[') && t.endsWith(']')) ||
      (t.startsWith('"') && t.endsWith('"'));
    if (!could) break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      break;
    }
    if (typeof parsed === 'object' && parsed !== null) return deserializeValue(parsed);
    if (typeof parsed === 'string') {
      current = parsed;
      continue;
    }
    break;
  }
  return value;
}

export function deserializeValue(value: unknown): unknown {
  if (typeof value === 'string') return unwrapJsonString(value);
  if (Array.isArray(value)) return value.map(deserializeValue);
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deserializeValue(v)]));
  return value;
}

// ---------------------------------------------------------------------------
// Handlers

class NotionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function errorText(e: NotionError, requestId: string): BoxResult {
  return compactJson({
    status: e.status,
    object: 'error',
    code: e.code,
    message: e.message,
    request_id: requestId,
  });
}

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

function normId(raw: unknown, field: string): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const fromUrl = /([0-9a-f]{32})(?:\?|$)/i.exec(s)?.[1];
  const candidate = fromUrl ?? s;
  if (!UUID_RE.test(candidate))
    throw new NotionError(
      400,
      'validation_error',
      `path failed validation: path.${field} should be a valid uuid, instead was \`${JSON.stringify(raw ?? null)}\`.`,
    );
  const hex = candidate.replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function notFound(kind: string, id: string): NotionError {
  return new NotionError(
    404,
    'object_not_found',
    `Could not find ${kind} with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`,
  );
}

function paginate<T>(
  items: readonly T[],
  args: Args,
  idOf: (t: T) => string,
): { results: T[]; next_cursor: string | null; has_more: boolean } {
  const rawSize = args['page_size'];
  const size = rawSize === undefined ? 100 : Number(rawSize);
  if (!Number.isInteger(size) || size < 1 || size > 100)
    throw new NotionError(
      400,
      'validation_error',
      `body failed validation: body.page_size should be ≤ \`100\`, instead was \`${JSON.stringify(rawSize)}\`.`,
    );
  let start = 0;
  const cursor = args['start_cursor'];
  if (cursor !== undefined && cursor !== null && cursor !== '') {
    start = items.findIndex((t) => idOf(t) === String(cursor));
    if (start < 0)
      throw new NotionError(
        400,
        'validation_error',
        `start_cursor provided is invalid: ${String(cursor)}`,
      );
  }
  const results = items.slice(start, start + size);
  const next = items[start + size];
  return {
    results,
    next_cursor: next === undefined ? null : idOf(next),
    has_more: next !== undefined,
  };
}

const NOW = '2026-10-28T15:00:00.000Z';

function richFromRequest(value: unknown, path: string): RichText[] {
  if (!Array.isArray(value))
    throw new NotionError(
      400,
      'validation_error',
      `body failed validation: ${path} should be an array, instead was \`${JSON.stringify(value ?? null)}\`.`,
    );
  return value.map((item, i) => {
    if (typeof item === 'string') return rt(item);
    const r = item as Record<string, unknown>;
    if (r['type'] === 'mention' || r['mention'] !== undefined) {
      const user = (
        (r['mention'] as Record<string, unknown> | undefined)?.['user'] as
          | { id?: string }
          | undefined
      )?.id;
      const p = NOTION_PEOPLE.find((x) => x.notionId === user);
      if (p !== undefined) return mention(p);
    }
    const text = r['text'] as { content?: unknown; link?: { url: string } | null } | undefined;
    if (text === undefined || typeof text.content !== 'string')
      throw new NotionError(
        400,
        'validation_error',
        `body failed validation: ${path}[${i}].text should be defined, instead was \`undefined\`.`,
      );
    const ann = {
      ...ANN,
      ...(r['annotations'] as Record<string, unknown> | undefined),
    } as RichText['annotations'];
    return {
      type: 'text',
      text: { content: text.content, link: text.link ?? null },
      annotations: ann,
      plain_text: text.content,
      href: text.link?.url ?? null,
    };
  });
}

const RICH_TYPES = [
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'quote',
  'callout',
  'code',
];
const BLOCK_TYPES = [...RICH_TYPES, 'divider', 'table', 'table_row', 'bookmark', 'equation'];

function blockFromRequest(raw: unknown, path: string): ParsedBlock {
  if (typeof raw !== 'object' || raw === null)
    throw new NotionError(
      400,
      'validation_error',
      `body failed validation: ${path} should be an object, instead was \`${JSON.stringify(raw)}\`.`,
    );
  const obj = raw as Record<string, unknown>;
  const type =
    typeof obj['type'] === 'string'
      ? (obj['type'] as string)
      : BLOCK_TYPES.find((t) => obj[t] !== undefined);
  if (type === undefined || !BLOCK_TYPES.includes(type))
    throw new NotionError(
      400,
      'validation_error',
      `body failed validation. Fix one:\n${path}.paragraph should be defined, instead was \`undefined\`.\n${path}.heading_1 should be defined, instead was \`undefined\`.\n${path}.bulleted_list_item should be defined, instead was \`undefined\`.\n${path}.to_do should be defined, instead was \`undefined\`.\n${path}.table should be defined, instead was \`undefined\`.`,
    );
  const body = obj[type] as Record<string, unknown> | undefined;
  if (body === undefined)
    throw new NotionError(
      400,
      'validation_error',
      `body failed validation: ${path}.${type} should be defined, instead was \`undefined\`.`,
    );
  const data: Record<string, unknown> = { ...body };
  if (RICH_TYPES.includes(type)) {
    data['rich_text'] = richFromRequest(body['rich_text'], `${path}.${type}.rich_text`);
    data['color'] = body['color'] ?? 'default';
    if (type === 'to_do') data['checked'] = body['checked'] === true;
    if (type.startsWith('heading')) data['is_toggleable'] = body['is_toggleable'] === true;
  }
  let children: ParsedBlock[] = [];
  const kids = (body['children'] ?? obj['children']) as unknown;
  if (type === 'table') {
    if (!Array.isArray(kids) || kids.length === 0)
      throw new NotionError(
        400,
        'validation_error',
        `body failed validation: ${path}.table.children should be defined, instead was \`undefined\`.`,
      );
    const width = Number(body['table_width']);
    if (!Number.isInteger(width) || width < 1)
      throw new NotionError(
        400,
        'validation_error',
        `body failed validation: ${path}.table.table_width should be defined, instead was \`undefined\`.`,
      );
    children = kids.map((k, i) => {
      const row = blockFromRequest(k, `${path}.table.children[${i}]`);
      const cells = (row.data['cells'] as unknown[] | undefined) ?? [];
      if (row.type !== 'table_row' || cells.length !== width)
        throw new NotionError(
          400,
          'validation_error',
          `Number of cells in table row must match the table width of the parent table`,
        );
      row.data['cells'] = cells.map((c, j) =>
        richFromRequest(c, `${path}.table.children[${i}].table_row.cells[${j}]`),
      );
      return row;
    });
    data['table_width'] = width;
    data['has_column_header'] = body['has_column_header'] === true;
    data['has_row_header'] = body['has_row_header'] === true;
    delete data['children'];
  } else if (Array.isArray(kids)) {
    children = kids.map((k, i) => blockFromRequest(k, `${path}.${type}.children[${i}]`));
    delete data['children'];
  }
  return { type, data, children };
}

/** Evaluate a Notion filter object against a row. */
function matchesFilter(
  ds: NotionDataSource,
  row: NotionPage,
  filter: Record<string, unknown>,
): boolean {
  if (Array.isArray(filter['and']))
    return (filter['and'] as Record<string, unknown>[]).every((f) => matchesFilter(ds, row, f));
  if (Array.isArray(filter['or']))
    return (filter['or'] as Record<string, unknown>[]).some((f) => matchesFilter(ds, row, f));
  if (typeof filter['timestamp'] === 'string') {
    const ts = filter['timestamp'] === 'created_time' ? row.created : row.edited;
    return dateCond(
      ts.slice(0, 10),
      filter[filter['timestamp'] as string] as Record<string, unknown>,
    );
  }
  const name = String(filter['property'] ?? '');
  const entry = Object.entries(ds.schema).find(
    ([n, d]) => n === name || d.id === name || decodeURIComponent(d.id) === name,
  );
  if (entry === undefined)
    throw new NotionError(
      400,
      'validation_error',
      `Could not find property with name or id: ${name}`,
    );
  const [propName, def] = entry;
  const value = row.properties[propName] as Record<string, unknown>;
  const condKey = Object.keys(filter).find((k) => k !== 'property');
  if (condKey === undefined)
    throw new NotionError(
      400,
      'validation_error',
      'body failed validation: body.filter should be defined.',
    );
  const cond = filter[condKey] as Record<string, unknown>;
  const typeOk =
    condKey === def.type ||
    (condKey === 'rich_text' && def.type === 'title') ||
    (condKey === 'title' && def.type === 'rich_text') ||
    (condKey === 'select' && def.type === 'status') ||
    (condKey === 'status' && def.type === 'select');
  if (!typeOk)
    throw new NotionError(
      400,
      'validation_error',
      `body failed validation: body.filter.${condKey} does not match the type of property "${propName}" (${def.type}).`,
    );
  switch (def.type) {
    case 'title':
    case 'rich_text':
      return textCond(plain(value[def.type]), cond);
    case 'select':
    case 'status': {
      const v = (value[def.type] as { name?: string } | null)?.name ?? null;
      if ('equals' in cond) return v === cond['equals'];
      if ('does_not_equal' in cond) return v !== cond['does_not_equal'];
      if ('is_empty' in cond) return v === null;
      if ('is_not_empty' in cond) return v !== null;
      return true;
    }
    case 'multi_select': {
      const vs = ((value['multi_select'] as { name: string }[]) ?? []).map((o) => o.name);
      if ('contains' in cond) return vs.includes(String(cond['contains']));
      if ('does_not_contain' in cond) return !vs.includes(String(cond['does_not_contain']));
      if ('is_empty' in cond) return vs.length === 0;
      if ('is_not_empty' in cond) return vs.length > 0;
      return true;
    }
    case 'people': {
      const ids = ((value['people'] as { id: string }[]) ?? []).map((p) => p.id);
      if ('contains' in cond) return ids.includes(String(cond['contains']));
      if ('does_not_contain' in cond) return !ids.includes(String(cond['does_not_contain']));
      if ('is_empty' in cond) return ids.length === 0;
      if ('is_not_empty' in cond) return ids.length > 0;
      return true;
    }
    case 'date': {
      const d = (value['date'] as { start?: string } | null)?.start ?? null;
      if ('is_empty' in cond) return d === null;
      if ('is_not_empty' in cond) return d !== null;
      return d !== null && dateCond(d.slice(0, 10), cond);
    }
    case 'number': {
      const n = value['number'] as number | null;
      if ('is_empty' in cond) return n === null;
      if ('is_not_empty' in cond) return n !== null;
      if (n === null) return false;
      const c = Number(Object.values(cond)[0]);
      const k = Object.keys(cond)[0];
      return (
        {
          equals: n === c,
          does_not_equal: n !== c,
          greater_than: n > c,
          less_than: n < c,
          greater_than_or_equal_to: n >= c,
          less_than_or_equal_to: n <= c,
        }[k as 'equals'] ?? true
      );
    }
    default:
      return true;
  }
}

function textCond(v: string, cond: Record<string, unknown>): boolean {
  const s = v.toLowerCase();
  const c = String(Object.values(cond)[0] ?? '').toLowerCase();
  switch (Object.keys(cond)[0]) {
    case 'equals':
      return v === String(cond['equals']);
    case 'does_not_equal':
      return v !== String(cond['does_not_equal']);
    case 'contains':
      return s.includes(c);
    case 'does_not_contain':
      return !s.includes(c);
    case 'starts_with':
      return s.startsWith(c);
    case 'ends_with':
      return s.endsWith(c);
    case 'is_empty':
      return v === '';
    case 'is_not_empty':
      return v !== '';
    default:
      return true;
  }
}

function dateCond(d: string, cond: Record<string, unknown>): boolean {
  const k = Object.keys(cond)[0];
  const c = String(Object.values(cond)[0] ?? '').slice(0, 10);
  switch (k) {
    case 'equals':
      return d === c;
    case 'before':
      return d < c;
    case 'after':
      return d > c;
    case 'on_or_before':
      return d <= c;
    case 'on_or_after':
      return d >= c;
    case 'past_week':
      return d >= '2026-10-21' && d <= '2026-10-28';
    case 'next_month':
      return d >= '2026-10-28' && d <= '2026-11-28';
    default:
      return true;
  }
}

function propertyFromRequest(ds: NotionDataSource, name: string, value: unknown): unknown {
  const entry = Object.entries(ds.schema).find(([n, d]) => n === name || d.id === name);
  if (entry === undefined)
    throw new NotionError(400, 'validation_error', `${name} is not a property that exists.`);
  const [propName, def] = entry;
  const keyed =
    typeof value === 'object' && value !== null && !Array.isArray(value) && def.type in value;
  // A property value is an object keyed by its type ({"number": 5}); only
  // title and rich text also take the bare rich-text array.
  if (!keyed && !(Array.isArray(value) && (def.type === 'title' || def.type === 'rich_text')))
    throw new NotionError(
      400,
      'validation_error',
      `body failed validation: body.properties.${propName}.${def.type} should be defined, instead was \`undefined\`.`,
    );
  const v = (keyed ? (value as Record<string, unknown>)[def.type] : value) as unknown;
  const base = { id: def.id, type: def.type };
  const options = (def.config['options'] ?? []) as { id: string; name: string; color: string }[];
  switch (def.type) {
    case 'title':
    case 'rich_text':
      return { ...base, [def.type]: richFromRequest(v, `body.properties.${propName}.${def.type}`) };
    case 'number':
      if (v !== null && typeof v !== 'number')
        throw new NotionError(
          400,
          'validation_error',
          `body failed validation: body.properties.${propName}.number should be a number or \`null\`, instead was \`${JSON.stringify(v)}\`.`,
        );
      return { ...base, number: v };
    case 'select':
    case 'status': {
      if (v === null) return { ...base, [def.type]: null };
      const n = (v as { name?: string; id?: string }).name;
      const id = (v as { id?: string }).id;
      const opt = options.find((o) => o.name === n || o.id === id);
      if (opt === undefined) {
        if (def.type === 'status')
          throw new NotionError(
            400,
            'validation_error',
            `Invalid status option. Status option "${String(n)}" does not exist".`,
          );
        if (n === undefined)
          throw new NotionError(
            400,
            'validation_error',
            `body failed validation: body.properties.${propName}.select.name should be defined.`,
          );
        const created = { id: uuidFrom(`opt:new:${n}`).slice(0, 4), name: n, color: 'default' };
        options.push(created);
        return { ...base, select: created };
      }
      return { ...base, [def.type]: opt };
    }
    case 'multi_select': {
      if (!Array.isArray(v))
        throw new NotionError(
          400,
          'validation_error',
          `body failed validation: body.properties.${propName}.multi_select should be an array, instead was \`${JSON.stringify(v)}\`.`,
        );
      return {
        ...base,
        multi_select: v.map((o: { name?: string }) => {
          const found = options.find((x) => x.name === o.name);
          if (found !== undefined) return found;
          const created = {
            id: uuidFrom(`opt:new:${String(o.name)}`).slice(0, 4),
            name: String(o.name),
            color: 'default',
          };
          options.push(created);
          return created;
        }),
      };
    }
    case 'date': {
      if (v === null) return { ...base, date: null };
      const start = (v as { start?: string }).start;
      if (typeof start !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(start))
        throw new NotionError(
          400,
          'validation_error',
          `body failed validation: body.properties.${propName}.date.start should be a valid ISO 8601 date string, instead was \`${JSON.stringify(start ?? null)}\`.`,
        );
      return {
        ...base,
        date: { start, end: (v as { end?: string }).end ?? null, time_zone: null },
      };
    }
    case 'people': {
      if (!Array.isArray(v))
        throw new NotionError(
          400,
          'validation_error',
          `body failed validation: body.properties.${propName}.people should be an array.`,
        );
      return {
        ...base,
        people: v.map((u: { id?: string }) => {
          const p = NOTION_PEOPLE.find((x) => x.notionId === u.id);
          if (p === undefined)
            throw new NotionError(
              400,
              'validation_error',
              `Could not find user with ID: ${String(u.id)}`,
            );
          return userObject(p);
        }),
      };
    }
    default:
      return { ...base, [def.type]: v };
  }
}

function handlers(state: NotionState): Record<string, (args: Args) => unknown> {
  const page = (id: string): NotionPage => {
    const p = state.pages.find((x) => x.id === id && x.shared && x.archived !== true);
    if (p === undefined) throw notFound('page', id);
    return p;
  };
  const anyBlockOrPage = (id: string): 'page' | 'block' => {
    if (state.pages.some((p) => p.id === id && p.shared)) return 'page';
    if (state.blocks.some((b) => b.id === id && b.archived !== true)) return 'block';
    throw notFound('block', id);
  };
  const dsById = (id: string): NotionDataSource => {
    const ds = state.dataSources.find((d) => d.id === id || d.databaseId === id);
    if (ds === undefined) throw notFound('data source', id);
    if (ds.id !== id)
      throw new NotionError(
        400,
        'validation_error',
        `Provided ID ${id} is a database, not a data source. Use the data source ID from the database's data_sources list.`,
      );
    return ds;
  };
  const insertBlocks = (parent: string, parsed: ParsedBlock[], after?: string): NotionBlock[] => {
    // Sibling order is array order within a parent, so a block placed right
    // after `after` (and each next one after the previous) keeps its place.
    const created: NotionBlock[] = [];
    let index = after === undefined ? -1 : state.blocks.findIndex((b) => b.id === after) + 1;
    for (const p of parsed) {
      state.seq += 1;
      const b: NotionBlock = {
        id: uuidFrom(`notion:new-block:${state.seq}`),
        parent,
        type: p.type,
        data: p.data,
        created: NOW,
        edited: NOW,
        createdBy: ASSISTANT.notionBotId,
      };
      if (index < 0) state.blocks.push(b);
      else state.blocks.splice(index++, 0, b);
      created.push(b, ...insertBlocks(b.id, p.children));
    }
    return created;
  };
  const visiblePages = (): NotionPage[] =>
    state.pages.filter((p) => p.shared && p.archived !== true);
  const listOf = (results: unknown[], extra: Record<string, unknown>): Record<string, unknown> => ({
    object: 'list',
    ...extra,
    results,
    request_id: '',
  });

  return {
    'API-get-user': (args) => {
      const id = normId(args['user_id'], 'user_id');
      if (id === ASSISTANT.notionBotId) return selfUser();
      const p = NOTION_PEOPLE.find((x) => x.notionId === id);
      if (p === undefined) throw notFound('user', id);
      return userObject(p);
    },
    'API-get-users': (args) => {
      const all = [
        ...NOTION_PEOPLE.filter((p) => p.deleted !== true || p.key === 'tom').map(userObject),
        selfUser(),
      ];
      const page = paginate(all, args, (u) => String(u['id']));
      return listOf(page.results, {
        next_cursor: page.next_cursor,
        has_more: page.has_more,
        type: 'user',
        user: {},
      });
    },
    'API-get-self': () => selfUser(),
    'API-post-search': (args) => {
      const q = String(args['query'] ?? '').toLowerCase();
      const filter = args['filter'] as { value?: string; property?: string } | undefined;
      if (
        filter !== undefined &&
        filter.value !== undefined &&
        !['page', 'data_source'].includes(filter.value)
      )
        throw new NotionError(
          400,
          'validation_error',
          'body failed validation: body.filter.value should be `"page"` or `"data_source"`, instead was `"' +
            String(filter.value) +
            '"`.',
        );
      const items: {
        kind: 'page' | 'ds';
        edited: string;
        title: string;
        render: () => unknown;
        id: string;
      }[] = [];
      if (filter?.value !== 'data_source')
        for (const p of visiblePages())
          items.push({
            kind: 'page',
            edited: p.edited,
            title: p.title,
            render: () => renderPage(state, p),
            id: p.id,
          });
      if (filter?.value !== 'page')
        for (const ds of state.dataSources)
          items.push({
            kind: 'ds',
            edited: ds.created,
            title: ds.title,
            render: () => renderDataSource(state, ds),
            id: ds.id,
          });
      const matched = items.filter((i) => q === '' || i.title.toLowerCase().includes(q));
      const sort = args['sort'] as { direction?: string } | undefined;
      const sorted = matched.toSorted(
        (a, b) =>
          (sort?.direction === 'ascending'
            ? a.edited.localeCompare(b.edited)
            : b.edited.localeCompare(a.edited)) || a.id.localeCompare(b.id),
      );
      const page = paginate(sorted, args, (i) => i.id);
      return listOf(
        page.results.map((i) => i.render()),
        {
          next_cursor: page.next_cursor,
          has_more: page.has_more,
          type: 'page_or_data_source',
          page_or_data_source: {},
        },
      );
    },
    'API-get-block-children': (args) => {
      const id = normId(args['block_id'], 'block_id');
      anyBlockOrPage(id);
      const page = paginate(childrenOf(state, id), args, (b) => b.id);
      return listOf(
        page.results.map((b) => renderBlock(state, b)),
        { next_cursor: page.next_cursor, has_more: page.has_more, type: 'block', block: {} },
      );
    },
    'API-patch-block-children': (args) => {
      const id = normId(args['block_id'], 'block_id');
      const kind = anyBlockOrPage(id);
      if (kind === 'block') {
        const b = state.blocks.find((x) => x.id === id) as NotionBlock;
        if (
          ['divider', 'child_page', 'child_database', 'table_row', 'code', 'table'].includes(b.type)
        )
          throw new NotionError(
            400,
            'validation_error',
            `Block type ${b.type} does not support children.`,
          );
      }
      const children = args['children'];
      if (!Array.isArray(children))
        throw new NotionError(
          400,
          'validation_error',
          `body failed validation: body.children should be an array, instead was \`${JSON.stringify(children ?? null)}\`.`,
        );
      if (children.length > 100)
        throw new NotionError(
          400,
          'validation_error',
          'body failed validation: body.children.length should be ≤ `100`, instead was `' +
            children.length +
            '`.',
        );
      const parsed = children.map((c, i) => blockFromRequest(c, `body.children[${i}]`));
      const after = args['after'] === undefined ? undefined : normId(args['after'], 'after');
      if (after !== undefined && !childrenOf(state, id).some((b) => b.id === after))
        throw new NotionError(
          400,
          'validation_error',
          `after block ${after} is not a child of ${id}`,
        );
      const created = insertBlocks(id, parsed, after);
      state.mutations.push({ kind: 'append', id, detail: { count: created.length } });
      const top = created.filter((b) => b.parent === id);
      return listOf(
        top.map((b) => renderBlock(state, b)),
        { next_cursor: null, has_more: false, type: 'block', block: {} },
      );
    },
    'API-retrieve-a-block': (args) => {
      const id = normId(args['block_id'], 'block_id');
      const b = state.blocks.find((x) => x.id === id && x.archived !== true);
      if (b === undefined) {
        const p = state.pages.find((x) => x.id === id && x.shared);
        if (p !== undefined)
          return {
            object: 'block',
            id: p.id,
            parent: parentObject(state, p.parent),
            created_time: p.created,
            last_edited_time: p.edited,
            created_by: partialUser(p.createdBy),
            last_edited_by: partialUser(p.createdBy),
            has_children: true,
            archived: false,
            in_trash: false,
            type: 'child_page',
            child_page: { title: p.title },
          };
        throw notFound('block', id);
      }
      return renderBlock(state, b);
    },
    'API-update-a-block': (args) => {
      const id = normId(args['block_id'], 'block_id');
      const b = state.blocks.find((x) => x.id === id && x.archived !== true);
      if (b === undefined) throw notFound('block', id);
      const body = args[b.type] as Record<string, unknown> | undefined;
      if (args['archived'] === true || args['in_trash'] === true) {
        b.archived = true;
        state.mutations.push({ kind: 'delete', id, detail: {} });
        return renderBlock(state, b);
      }
      if (body === undefined) {
        const keys = Object.keys(args).filter((k) => k !== 'block_id');
        throw new NotionError(
          400,
          'validation_error',
          `body failed validation. Fix one:\nbody.${b.type} should be defined, instead was \`undefined\`.\nbody.archived should be defined, instead was \`undefined\`.${keys.length > 0 ? `\nbody.${keys[0]} should be not present, instead was \`${JSON.stringify(args[keys[0] as string]).slice(0, 80)}\`.` : ''}`,
        );
      }
      if (body['rich_text'] !== undefined)
        b.data['rich_text'] = richFromRequest(body['rich_text'], `body.${b.type}.rich_text`);
      if (b.type === 'to_do' && typeof body['checked'] === 'boolean')
        b.data['checked'] = body['checked'];
      b.edited = NOW;
      state.mutations.push({ kind: 'update', id, detail: body });
      return renderBlock(state, b);
    },
    'API-delete-a-block': (args) => {
      const id = normId(args['block_id'], 'block_id');
      const b = state.blocks.find((x) => x.id === id && x.archived !== true);
      if (b === undefined) throw notFound('block', id);
      b.archived = true;
      state.mutations.push({ kind: 'delete', id, detail: {} });
      return renderBlock(state, b);
    },
    'API-retrieve-a-page': (args) => renderPage(state, page(normId(args['page_id'], 'page_id'))),
    'API-patch-page': (args) => {
      const p = page(normId(args['page_id'], 'page_id'));
      const props = args['properties'];
      if (props !== undefined) {
        if (typeof props !== 'object' || props === null || Array.isArray(props))
          throw new NotionError(
            400,
            'validation_error',
            'body failed validation: body.properties should be an object.',
          );
        if (p.parent.startsWith('ds:')) {
          const ds = state.dataSources.find((d) => `ds:${d.id}` === p.parent) as NotionDataSource;
          const updates = Object.entries(props as Record<string, unknown>).map(([k, v]) => {
            const entry = Object.entries(ds.schema).find(([n, d]) => n === k || d.id === k);
            return [entry?.[0] ?? k, propertyFromRequest(ds, k, v)] as const;
          });
          for (const [k, v] of updates) p.properties[k] = v;
          state.mutations.push({
            kind: 'update_page',
            id: p.id,
            detail: Object.fromEntries(updates.map(([k]) => [k, true])),
          });
        } else {
          for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
            if (k !== 'title')
              throw new NotionError(400, 'validation_error', `${k} is not a property that exists.`);
            const title = richFromRequest(
              Array.isArray(v) ? v : (v as Record<string, unknown>)['title'],
              'body.properties.title.title',
            );
            p.properties['title'] = { id: 'title', type: 'title', title };
            p.title = plain(title);
          }
          state.mutations.push({ kind: 'update_page', id: p.id, detail: { title: true } });
        }
      }
      if (args['archived'] === true || args['in_trash'] === true) {
        p.archived = true;
        state.mutations.push({ kind: 'trash_page', id: p.id, detail: {} });
      }
      p.edited = NOW;
      return renderPage(state, p);
    },
    'API-post-page': (args) => {
      const parentRaw = args['parent'] as Record<string, unknown> | undefined;
      if (parentRaw === undefined || typeof parentRaw !== 'object')
        throw new NotionError(
          400,
          'validation_error',
          'body failed validation: body.parent should be defined, instead was `undefined`.',
        );
      let parent: string;
      let ds: NotionDataSource | undefined;
      if (parentRaw['data_source_id'] !== undefined || parentRaw['database_id'] !== undefined) {
        const raw = parentRaw['data_source_id'] ?? parentRaw['database_id'];
        const id = normId(
          raw,
          parentRaw['data_source_id'] !== undefined
            ? 'parent.data_source_id'
            : 'parent.database_id',
        );
        ds = state.dataSources.find((d) => d.id === id || d.databaseId === id);
        if (ds === undefined) throw notFound('database', id);
        parent = `ds:${ds.id}`;
      } else if (parentRaw['page_id'] !== undefined) {
        const id = normId(parentRaw['page_id'], 'parent.page_id');
        page(id);
        parent = `page:${id}`;
      } else if (parentRaw['type'] === 'workspace' || parentRaw['workspace'] === true) {
        throw new NotionError(
          400,
          'validation_error',
          'Integrations cannot create workspace-level pages unless they have insert content capabilities at the workspace level.',
        );
      } else
        throw new NotionError(
          400,
          'validation_error',
          'body failed validation: body.parent.page_id should be defined, instead was `undefined`.',
        );
      const props = (args['properties'] ?? {}) as Record<string, unknown>;
      if (typeof props !== 'object' || Array.isArray(props))
        throw new NotionError(
          400,
          'validation_error',
          'body failed validation: body.properties should be an object.',
        );
      const properties: Record<string, unknown> = {};
      let title = '';
      if (ds !== undefined) {
        for (const [k, v] of Object.entries(props)) {
          const name = Object.entries(ds.schema).find(([n, d]) => n === k || d.id === k)?.[0] ?? k;
          properties[name] = propertyFromRequest(ds, k, v);
        }
        for (const [name, def] of Object.entries(ds.schema)) {
          if (!(name in properties))
            properties[name] = propValue(ds, name, def.type === 'multi_select' ? [] : undefined);
          if (def.type === 'title')
            title = plain((properties[name] as Record<string, unknown>)['title']);
        }
      } else {
        const t = props['title'] ?? props['Title'] ?? props['Name'];
        if (t === undefined && Object.keys(props).length > 0)
          throw new NotionError(
            400,
            'validation_error',
            `${Object.keys(props)[0]} is not a property that exists.`,
          );
        const rich =
          t === undefined
            ? []
            : richFromRequest(
                Array.isArray(t) ? t : (t as Record<string, unknown>)['title'],
                'body.properties.title.title',
              );
        properties['title'] = { id: 'title', type: 'title', title: rich };
        title = plain(rich);
      }
      const children = args['children'];
      const parsed = Array.isArray(children)
        ? children.map((c, i) => blockFromRequest(c, `body.children[${i}]`))
        : [];
      state.seq += 1;
      const p: NotionPage = {
        id: uuidFrom(`notion:new-page:${state.seq}`),
        parent,
        title,
        icon: null,
        properties,
        created: NOW,
        edited: NOW,
        createdBy: ASSISTANT.notionBotId,
        shared: true,
      };
      state.pages.push(p);
      if (parent.startsWith('page:')) {
        state.seq += 1;
        state.blocks.push({
          id: p.id,
          parent: parent.slice(5),
          type: 'child_page',
          data: { title },
          created: NOW,
          edited: NOW,
          createdBy: ASSISTANT.notionBotId,
        });
      }
      insertBlocks(p.id, parsed);
      state.mutations.push({ kind: 'create_page', id: p.id, detail: { parent } });
      return renderPage(state, p);
    },
    'API-retrieve-a-page-property': (args) => {
      const p = page(normId(args['page_id'], 'page_id'));
      const key = decodeURIComponent(String(args['property_id'] ?? ''));
      const entry = Object.entries(p.properties).find(
        ([n, v]) => n === key || decodeURIComponent(String((v as { id: string }).id)) === key,
      );
      if (entry === undefined)
        throw new NotionError(404, 'object_not_found', `Could not find property with ID: ${key}`);
      const v = entry[1] as Record<string, unknown>;
      const type = String(v['type']);
      if (['title', 'rich_text', 'people'].includes(type)) {
        const items = ((v[type] as unknown[]) ?? []).map((x) => ({
          object: 'property_item',
          id: v['id'],
          type,
          [type]: type === 'people' ? x : x,
        }));
        return listOf(items, {
          next_cursor: null,
          has_more: false,
          type: 'property_item',
          property_item: { id: v['id'], next_url: null, type, [type]: {} },
        });
      }
      return { object: 'property_item', id: v['id'], type, [type]: v[type] };
    },
    'API-retrieve-a-comment': (args) => {
      const id = normId(args['block_id'], 'block_id');
      anyBlockOrPage(id);
      const list = state.comments
        .filter((c) => c.parent === id)
        .map((c) => ({
          object: 'comment',
          id: c.id,
          parent: { type: 'page_id', page_id: c.parent },
          discussion_id: uuidFrom(`disc:${c.id}`),
          created_time: c.created,
          last_edited_time: c.created,
          created_by: partialUser(c.by),
          rich_text: [rt(c.text)],
          display_name: { type: 'integration', resolved_name: ASSISTANT.name },
        }));
      const pg = paginate(list, args, (c) => String(c['id']));
      return listOf(pg.results, {
        next_cursor: pg.next_cursor,
        has_more: pg.has_more,
        type: 'comment',
        comment: {},
      });
    },
    'API-create-a-comment': (args) => {
      const parent = args['parent'] as { page_id?: string } | undefined;
      const id = normId(parent?.page_id, 'parent.page_id');
      page(id);
      const rich = richFromRequest(args['rich_text'], 'body.rich_text');
      state.seq += 1;
      const c = {
        id: uuidFrom(`notion:comment:${state.seq}`),
        parent: id,
        text: plain(rich),
        by: ASSISTANT.notionBotId,
        created: NOW,
      };
      state.comments.push(c);
      state.mutations.push({ kind: 'comment', id, detail: { text: c.text } });
      return {
        object: 'comment',
        id: c.id,
        parent: { type: 'page_id', page_id: id },
        discussion_id: uuidFrom(`disc:${c.id}`),
        created_time: NOW,
        last_edited_time: NOW,
        created_by: partialUser(ASSISTANT.notionBotId),
        rich_text: rich,
        display_name: { type: 'integration', resolved_name: ASSISTANT.name },
      };
    },
    'API-query-data-source': (args) => {
      const ds = dsById(normId(args['data_source_id'], 'data_source_id'));
      let rows = state.pages.filter((p) => p.parent === `ds:${ds.id}` && p.archived !== true);
      const filter = args['filter'];
      if (filter !== undefined && filter !== null) {
        if (typeof filter !== 'object')
          throw new NotionError(
            400,
            'validation_error',
            'body failed validation: body.filter should be an object.',
          );
        rows = rows.filter((r) => matchesFilter(ds, r, filter as Record<string, unknown>));
      }
      const sorts = args['sorts'];
      if (Array.isArray(sorts) && sorts.length > 0) {
        rows = rows.toSorted((a, b) => {
          for (const s of sorts as {
            property?: string;
            timestamp?: string;
            direction?: string;
          }[]) {
            const key = (r: NotionPage): string | number => {
              if (s.timestamp !== undefined)
                return s.timestamp === 'created_time' ? r.created : r.edited;
              const v = r.properties[String(s.property)] as Record<string, unknown> | undefined;
              if (v === undefined)
                throw new NotionError(
                  400,
                  'validation_error',
                  `Could not find sort property with name or id: ${String(s.property)}`,
                );
              const t = String(v['type']);
              const raw = v[t];
              if (t === 'number') return (raw as number | null) ?? -Infinity;
              if (t === 'date') return (raw as { start?: string } | null)?.start ?? '';
              if (t === 'select' || t === 'status')
                return (raw as { name?: string } | null)?.name ?? '';
              return plain(raw);
            };
            const x = key(a);
            const y = key(b);
            const cmp =
              typeof x === 'number' && typeof y === 'number'
                ? x - y
                : String(x).localeCompare(String(y));
            if (cmp !== 0) return s.direction === 'descending' ? -cmp : cmp;
          }
          return 0;
        });
      } else rows = rows.toSorted((a, b) => b.created.localeCompare(a.created));
      const pg = paginate(rows, args, (r) => r.id);
      return listOf(
        pg.results.map((r) => renderPage(state, r)),
        {
          next_cursor: pg.next_cursor,
          has_more: pg.has_more,
          type: 'page_or_data_source',
          page_or_data_source: {},
        },
      );
    },
    'API-retrieve-a-data-source': (args) =>
      renderDataSource(state, dsById(normId(args['data_source_id'], 'data_source_id'))),
    'API-update-a-data-source': (args) => {
      const ds = dsById(normId(args['data_source_id'], 'data_source_id'));
      const props = args['properties'] as
        | Record<string, Record<string, unknown> | null>
        | undefined;
      for (const [name, d] of Object.entries(props ?? {})) {
        if (d === null) delete ds.schema[name];
        else {
          const type = Object.keys(d).find((k) => k !== 'name') ?? 'rich_text';
          ds.schema[name] = {
            id: encodeURIComponent(uuidFrom(`prop:new:${name}`).slice(0, 4)),
            type,
            config: (d[type] as Record<string, unknown>) ?? {},
          };
        }
      }
      if (Array.isArray(args['title']))
        ds.title = plain(richFromRequest(args['title'], 'body.title'));
      state.mutations.push({ kind: 'update_data_source', id: ds.id, detail: {} });
      return renderDataSource(state, ds);
    },
    'API-create-a-data-source': (args) => {
      const parent = args['parent'] as { page_id?: string } | undefined;
      const pageId = normId(parent?.page_id, 'parent.page_id');
      page(pageId);
      state.seq += 1;
      const ds: NotionDataSource = {
        id: uuidFrom(`notion:new-ds:${state.seq}`),
        databaseId: uuidFrom(`notion:new-db:${state.seq}`),
        pageId,
        title: plain(
          Array.isArray(args['title']) ? richFromRequest(args['title'], 'body.title') : [],
        ),
        created: NOW,
        schema: {},
      };
      for (const [name, d] of Object.entries(
        (args['properties'] ?? {}) as Record<string, Record<string, unknown>>,
      )) {
        const type = Object.keys(d).find((k) => k !== 'name') ?? 'rich_text';
        ds.schema[name] = {
          id:
            type === 'title'
              ? 'title'
              : encodeURIComponent(uuidFrom(`prop:new:${name}`).slice(0, 4)),
          type,
          config: (d[type] as Record<string, unknown>) ?? {},
        };
      }
      if (!Object.values(ds.schema).some((d) => d.type === 'title'))
        throw new NotionError(400, 'validation_error', 'Title is not provided');
      state.dataSources.push(ds);
      state.blocks.push({
        id: ds.databaseId,
        parent: pageId,
        type: 'child_database',
        data: { title: ds.title },
        created: NOW,
        edited: NOW,
        createdBy: ASSISTANT.notionBotId,
      });
      state.mutations.push({ kind: 'create_data_source', id: ds.id, detail: {} });
      return renderDataSource(state, ds);
    },
    'API-list-data-source-templates': (args) => {
      dsById(normId(args['data_source_id'], 'data_source_id'));
      return { object: 'list', templates: [], has_more: false, next_cursor: null };
    },
    'API-retrieve-a-database': (args) => {
      const id = normId(args['database_id'], 'database_id');
      const ds = state.dataSources.find((d) => d.databaseId === id);
      if (ds === undefined) {
        if (state.dataSources.some((d) => d.id === id))
          throw new NotionError(
            400,
            'validation_error',
            `Provided ID ${id} is a data source, not a database. Use the retrieve a data source API.`,
          );
        throw notFound('database', id);
      }
      return renderDatabase(state, ds);
    },
    'API-move-page': (args) => {
      const p = page(normId(args['page_id'], 'page_id'));
      const parent = args['parent'] as Record<string, unknown> | undefined;
      if (parent?.['page_id'] !== undefined) {
        const id = normId(parent['page_id'], 'parent.page_id');
        page(id);
        p.parent = `page:${id}`;
      } else
        throw new NotionError(
          400,
          'validation_error',
          'body failed validation: body.parent.page_id should be defined, instead was `undefined`.',
        );
      state.mutations.push({ kind: 'move_page', id: p.id, detail: { parent: p.parent } });
      return renderPage(state, p);
    },
    'API-retrieve-page-markdown': (args) => {
      const id = normId(args['page_id'], 'page_id');
      anyBlockOrPage(id);
      return {
        object: 'page_markdown',
        id,
        markdown: toMarkdown(state, id),
        truncated: false,
        unknown_block_ids: [],
      };
    },
    'API-update-page-markdown': (args) => {
      const id = normId(args['page_id'], 'page_id');
      page(id);
      const type = String(args['type'] ?? '');
      const current = toMarkdown(state, id);
      let next: string;
      if (type === 'replace_content') {
        const body = args['replace_content'] as
          | { new_str?: string; allow_deleting_content?: boolean }
          | undefined;
        if (typeof body?.new_str !== 'string')
          throw new NotionError(
            400,
            'validation_error',
            'body failed validation: body.replace_content.new_str should be defined, instead was `undefined`.',
          );
        next = body.new_str;
        const kept = childrenOf(state, id).filter(
          (b) => b.type === 'child_page' || b.type === 'child_database',
        );
        const lost = kept.filter((b) => !next.includes(String(b.data['title'])));
        if (lost.length > 0 && body.allow_deleting_content !== true)
          throw new NotionError(
            400,
            'validation_error',
            `The new content would delete ${lost.length} child page(s) or database(s). Set allow_deleting_content to true to allow this.`,
          );
      } else if (type === 'update_content') {
        const body = args['update_content'] as
          | {
              content_updates?: {
                old_str: string;
                new_str: string;
                replace_all_matches?: boolean;
              }[];
            }
          | undefined;
        if (!Array.isArray(body?.content_updates))
          throw new NotionError(
            400,
            'validation_error',
            'body failed validation: body.update_content.content_updates should be defined, instead was `undefined`.',
          );
        next = current;
        for (const u of body.content_updates) {
          if (!next.includes(u.old_str))
            throw new NotionError(
              400,
              'validation_error',
              `old_str not found in page content: ${JSON.stringify(u.old_str).slice(0, 120)}`,
            );
          next =
            u.replace_all_matches === true
              ? next.split(u.old_str).join(u.new_str)
              : next.replace(u.old_str, u.new_str);
        }
      } else if (type === 'insert_content') {
        const body = args['insert_content'] as
          | { content?: string; after?: string; position?: { type?: string } }
          | undefined;
        const content = String(body?.content ?? '');
        if (body?.after !== undefined) {
          const [start] = body.after.split('...');
          const at = current.indexOf(start ?? '');
          if (at < 0) throw new NotionError(400, 'validation_error', 'Selection not found');
          const lineEnd = current.indexOf('\n', at);
          next =
            lineEnd < 0
              ? `${current}\n${content}`
              : `${current.slice(0, lineEnd)}\n${content}${current.slice(lineEnd)}`;
        } else
          next =
            body?.position?.type === 'start' ? `${content}\n${current}` : `${current}\n${content}`;
      } else if (type === 'replace_content_range') {
        const body = args['replace_content_range'] as
          | { content?: string; content_range?: string }
          | undefined;
        const [start, end] = String(body?.content_range ?? '').split('...');
        const a = current.indexOf(start ?? '\u0000');
        const b = end === undefined ? -1 : current.indexOf(end, a);
        if (a < 0 || b < 0) throw new NotionError(400, 'validation_error', 'Selection not found');
        next = `${current.slice(0, a)}${String(body?.content ?? '')}${current.slice(b + (end as string).length)}`;
      } else
        throw new NotionError(
          400,
          'validation_error',
          `body failed validation: body.type should be one of \`"replace_content"\`, \`"update_content"\`, \`"insert_content"\`, \`"replace_content_range"\`, instead was \`${JSON.stringify(args['type'] ?? null)}\`.`,
        );
      // Re-materialise the page: child pages and databases keep their identity.
      const keep = childrenOf(state, id).filter(
        (b) => b.type === 'child_page' || b.type === 'child_database',
      );
      const archive = (parent: string): void => {
        for (const b of state.blocks.filter((x) => x.parent === parent && x.archived !== true)) {
          if (b.type === 'child_page' || b.type === 'child_database') continue;
          b.archived = true;
          archive(b.id);
        }
      };
      archive(id);
      for (const b of keep) state.blocks.splice(state.blocks.indexOf(b), 1);
      const parsed = parseMarkdown(next);
      for (const p of parsed) {
        if (p.type === 'child_page' || p.type === 'child_database') {
          const existing = keep.find((b) => b.data['title'] === p.data['title']);
          if (existing !== undefined) {
            state.blocks.push(existing);
            keep.splice(keep.indexOf(existing), 1);
          }
        } else insertBlocks(id, [p]);
      }
      for (const b of keep) {
        b.archived = true;
        state.blocks.push(b);
      }
      state.mutations.push({ kind: 'markdown', id, detail: { type } });
      return {
        object: 'page_markdown',
        id,
        markdown: toMarkdown(state, id),
        truncated: false,
        unknown_block_ids: [],
      };
    },
  };
}

function selfUser(): Record<string, unknown> {
  return {
    object: 'user',
    id: ASSISTANT.notionBotId,
    name: ASSISTANT.name,
    avatar_url: null,
    type: 'bot',
    bot: {
      owner: { type: 'workspace', workspace: true },
      workspace_name: 'Fernhill',
      workspace_limits: { max_file_upload_size_in_bytes: 5368709120 },
    },
  };
}

export function createNotionBox(
  state: NotionState,
  onCall?: (call: SideEffect) => void,
): SummitBox {
  const h = handlers(state);
  let requests = 0;
  const tools: SummitTool[] = NOTION_TOOLS.map((def) => ({
    ...def,
    handler: (args: Args): BoxResult => {
      requests += 1;
      const requestId = uuidFrom(`notion:request:${requests}`);
      const fn = h[def.name];
      try {
        if (fn === undefined)
          throw new NotionError(404, 'invalid_request_url', 'Invalid request URL.');
        const data = fn(deserializeValue(args) as Args);
        return compactJson(
          typeof data === 'object' && data !== null && 'request_id' in data
            ? { ...data, request_id: requestId }
            : data,
        );
      } catch (e) {
        if (e instanceof NotionError) return errorText(e, requestId);
        throw e;
      }
    },
  }));
  return createSummitBox({ name: 'Notion API', version: '1.0.0' }, tools, onCall, {
    unknownTool: (name) => `Method ${name} not found`,
  });
}

/** The rows of a data source (graders). */
export function rowsOf(state: NotionState, dataSourceId: string): NotionPage[] {
  return state.pages.filter((p) => p.parent === `ds:${dataSourceId}` && p.archived !== true);
}
