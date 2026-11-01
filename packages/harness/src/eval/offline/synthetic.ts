/**
 * The synthetic large catalog: 59 resources × 17 operations = 1,003 tools,
 * generated deterministically, in the shape of a broad SaaS API gateway
 * (billing, support, CRM, infra, …). It stresses search at a scale none of
 * the eval worlds reaches, and it mixes three naming styles the way a
 * gateway over several upstream APIs does: `list_invoices` (snake,
 * verb-first), `listInvoices` (camel) and `invoice-list` (kebab,
 * noun-first). The descriptions share boilerplate across tools on purpose
 * ("Results are paginated", "by its ID"), as real catalogs do.
 *
 * {@link syntheticQueries} draws seeded (query, gold) pairs from it: half
 * use the catalog's own words ("delete webhook"), half a paraphrase a user
 * might type instead ("remove a webhook", "how many invoices").
 */

import type { WorldTool } from '../world.js';
import type { CatalogFixture } from './catalogs.js';

interface Resource {
  noun: string;
  plural: string;
  area: string;
}

const RESOURCES: readonly Resource[] = [
  { noun: 'invoice', plural: 'invoices', area: 'billing' },
  { noun: 'customer', plural: 'customers', area: 'billing' },
  { noun: 'subscription', plural: 'subscriptions', area: 'billing' },
  { noun: 'payment', plural: 'payments', area: 'billing' },
  { noun: 'refund', plural: 'refunds', area: 'billing' },
  { noun: 'coupon', plural: 'coupons', area: 'billing' },
  { noun: 'product', plural: 'products', area: 'catalog' },
  { noun: 'price', plural: 'prices', area: 'catalog' },
  { noun: 'order', plural: 'orders', area: 'commerce' },
  { noun: 'shipment', plural: 'shipments', area: 'commerce' },
  { noun: 'warehouse', plural: 'warehouses', area: 'commerce' },
  { noun: 'inventory item', plural: 'inventory items', area: 'commerce' },
  { noun: 'ticket', plural: 'tickets', area: 'support' },
  { noun: 'ticket comment', plural: 'ticket comments', area: 'support' },
  { noun: 'macro', plural: 'macros', area: 'support' },
  { noun: 'agent', plural: 'agents', area: 'support' },
  { noun: 'user', plural: 'users', area: 'admin' },
  { noun: 'team', plural: 'teams', area: 'admin' },
  { noun: 'role', plural: 'roles', area: 'admin' },
  { noun: 'api key', plural: 'api keys', area: 'admin' },
  { noun: 'webhook', plural: 'webhooks', area: 'admin' },
  { noun: 'audit log', plural: 'audit logs', area: 'admin' },
  { noun: 'project', plural: 'projects', area: 'planning' },
  { noun: 'task', plural: 'tasks', area: 'planning' },
  { noun: 'milestone', plural: 'milestones', area: 'planning' },
  { noun: 'sprint', plural: 'sprints', area: 'planning' },
  { noun: 'document', plural: 'documents', area: 'docs' },
  { noun: 'folder', plural: 'folders', area: 'docs' },
  { noun: 'calendar event', plural: 'calendar events', area: 'calendar' },
  { noun: 'meeting', plural: 'meetings', area: 'calendar' },
  { noun: 'contact', plural: 'contacts', area: 'crm' },
  { noun: 'deal', plural: 'deals', area: 'crm' },
  { noun: 'pipeline', plural: 'pipelines', area: 'crm' },
  { noun: 'lead', plural: 'leads', area: 'crm' },
  { noun: 'campaign', plural: 'campaigns', area: 'marketing' },
  { noun: 'email template', plural: 'email templates', area: 'marketing' },
  { noun: 'segment', plural: 'segments', area: 'marketing' },
  { noun: 'survey', plural: 'surveys', area: 'marketing' },
  { noun: 'form', plural: 'forms', area: 'marketing' },
  { noun: 'dashboard', plural: 'dashboards', area: 'analytics' },
  { noun: 'report', plural: 'reports', area: 'analytics' },
  { noun: 'metric', plural: 'metrics', area: 'analytics' },
  { noun: 'alert', plural: 'alerts', area: 'monitoring' },
  { noun: 'incident', plural: 'incidents', area: 'monitoring' },
  { noun: 'on-call schedule', plural: 'on-call schedules', area: 'monitoring' },
  { noun: 'deployment', plural: 'deployments', area: 'delivery' },
  { noun: 'build', plural: 'builds', area: 'delivery' },
  { noun: 'artifact', plural: 'artifacts', area: 'delivery' },
  { noun: 'secret', plural: 'secrets', area: 'delivery' },
  { noun: 'environment', plural: 'environments', area: 'delivery' },
  { noun: 'domain', plural: 'domains', area: 'network' },
  { noun: 'dns record', plural: 'dns records', area: 'network' },
  { noun: 'certificate', plural: 'certificates', area: 'network' },
  { noun: 'bucket', plural: 'buckets', area: 'storage' },
  { noun: 'backup', plural: 'backups', area: 'storage' },
  { noun: 'cluster', plural: 'clusters', area: 'compute' },
  { noun: 'queue', plural: 'queues', area: 'messaging' },
  { noun: 'topic', plural: 'topics', area: 'messaging' },
  { noun: 'channel', plural: 'channels', area: 'messaging' },
];

type Verb =
  | 'list'
  | 'get'
  | 'create'
  | 'update'
  | 'delete'
  | 'search'
  | 'archive'
  | 'restore'
  | 'export'
  | 'import'
  | 'count'
  | 'assign'
  | 'duplicate'
  | 'publish'
  | 'approve'
  | 'cancel'
  | 'sync';

const VERBS: readonly Verb[] = [
  'list',
  'get',
  'create',
  'update',
  'delete',
  'search',
  'archive',
  'restore',
  'export',
  'import',
  'count',
  'assign',
  'duplicate',
  'publish',
  'approve',
  'cancel',
  'sync',
];

/** Verbs whose tool name takes the plural (`list_invoices`, `export_invoices`). */
const PLURAL_VERBS: ReadonlySet<Verb> = new Set([
  'list',
  'search',
  'export',
  'import',
  'count',
  'sync',
]);
const READ_ONLY: ReadonlySet<Verb> = new Set(['list', 'get', 'search', 'export', 'count']);

function describe(verb: Verb, r: Resource): string {
  const { noun, plural, area } = r;
  switch (verb) {
    case 'list':
      return `List ${plural} in the ${area} workspace. Results are paginated; filter by status or owner.`;
    case 'get':
      return `Get one ${noun} by its ID, with all of its fields.`;
    case 'create':
      return `Create a new ${noun} in the ${area} workspace.`;
    case 'update':
      return `Update fields of an existing ${noun} by its ID.`;
    case 'delete':
      return `Permanently delete a ${noun} by its ID. This cannot be undone.`;
    case 'search':
      return `Search ${plural} by keyword, with full-text matching on names and notes.`;
    case 'archive':
      return `Archive a ${noun} so it is hidden from default listings.`;
    case 'restore':
      return `Restore an archived ${noun} by its ID.`;
    case 'export':
      return `Export ${plural} as a CSV or JSON file.`;
    case 'import':
      return `Import ${plural} from a CSV or JSON file.`;
    case 'count':
      return `Count ${plural} matching a filter, without returning them.`;
    case 'assign':
      return `Assign a ${noun} to a user or team.`;
    case 'duplicate':
      return `Duplicate a ${noun}, copying its settings into a new one.`;
    case 'publish':
      return `Publish a ${noun} so it becomes visible to others.`;
    case 'approve':
      return `Approve a pending ${noun}.`;
    case 'cancel':
      return `Cancel a ${noun} that is in progress.`;
    case 'sync':
      return `Sync ${plural} with the connected external system.`;
  }
}

type Style = 'snake' | 'camel' | 'kebab';
const STYLES: readonly Style[] = ['snake', 'camel', 'kebab'];

function words(phrase: string): string[] {
  return phrase.split(/[\s-]+/).filter((w) => w.length > 0);
}

function toolName(verb: Verb, r: Resource, style: Style): string {
  const object = words(PLURAL_VERBS.has(verb) ? r.plural : r.noun);
  switch (style) {
    case 'snake':
      return [verb, ...object].join('_');
    case 'camel':
      return [verb, ...object.map((w) => w[0]?.toUpperCase() + w.slice(1))].join('');
    case 'kebab':
      return [...object, verb].join('-');
  }
}

function inputSchema(verb: Verb, r: Resource): Record<string, unknown> {
  if (PLURAL_VERBS.has(verb)) {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: `Filter for ${r.plural}` },
        limit: { type: 'number', description: 'Page size' },
        cursor: { type: 'string', description: 'Cursor from a previous page' },
      },
    };
  }
  if (verb === 'create') {
    return {
      type: 'object',
      properties: {
        name: { type: 'string', description: `Name of the new ${r.noun}` },
        fields: { type: 'object', description: 'Other fields' },
      },
      required: ['name'],
    };
  }
  return {
    type: 'object',
    properties: { id: { type: 'string', description: `The ${r.noun} ID` } },
    required: ['id'],
  };
}

/** The style a resource's tools are named in: deterministic, cycling. */
function styleOf(index: number): Style {
  return STYLES[index % STYLES.length] ?? 'snake';
}

/** The 1,003-tool catalog, sorted by resource then operation (generation order). */
export function syntheticCatalog(): CatalogFixture {
  const tools: WorldTool[] = [];
  RESOURCES.forEach((r, index) => {
    const style = styleOf(index);
    for (const verb of VERBS) {
      tools.push({
        name: toolName(verb, r, style),
        description: describe(verb, r),
        inputSchema: inputSchema(verb, r),
        annotations: {
          readOnlyHint: READ_ONLY.has(verb),
          destructiveHint: verb === 'delete',
        },
      });
    }
  });
  return {
    server: { name: 'synthetic-gateway', version: '1.0.0' },
    instructions: '',
    tools,
  };
}

/**
 * Query templates per operation. The first uses the catalog's own verb; the
 * others are what a user might type instead. `{n}` is the singular noun,
 * `{p}` the plural.
 */
const QUERY_TEMPLATES: Readonly<Record<Verb, readonly string[]>> = {
  list: ['list {p}', 'show all {p}', 'all {p}'],
  get: ['get {n}', 'show one {n}', '{n} details'],
  create: ['create {n}', 'add a new {n}', 'new {n}'],
  update: ['update {n}', 'edit {n}', 'change a {n}'],
  delete: ['delete {n}', 'remove {n}', 'get rid of a {n}'],
  search: ['search {p}', 'find {p} by keyword', 'look up {p}'],
  archive: ['archive {n}', 'hide an old {n}'],
  restore: ['restore {n}', 'unarchive {n}', 'bring back an archived {n}'],
  export: ['export {p}', 'download {p} as csv'],
  import: ['import {p}', 'upload {p} from a csv'],
  count: ['count {p}', 'how many {p}', 'number of {p}'],
  assign: ['assign {n}', 'give a {n} to a teammate'],
  duplicate: ['duplicate {n}', 'copy a {n}', 'clone {n}'],
  publish: ['publish {n}', 'make a {n} public'],
  approve: ['approve {n}', 'sign off on a {n}'],
  cancel: ['cancel {n}', 'stop a {n}', 'abort {n}'],
  sync: ['sync {p}', 'refresh {p} from the external system'],
};

/** mulberry32: a small seeded PRNG, so generation never reads the clock. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** One generated query, its gold tool, and whether it paraphrases the catalog's verb. */
export interface SyntheticQuery {
  query: string;
  gold: string;
  paraphrase: boolean;
}

/**
 * `count` seeded (query, gold) pairs over distinct tools: a random
 * resource and operation each, alternating the catalog's own verb and a
 * random paraphrase.
 */
export function syntheticQueries(count: number, seed: number): SyntheticQuery[] {
  const random = seededRandom(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const seen = new Set<string>();
  const out: SyntheticQuery[] = [];
  while (out.length < count) {
    const index = Math.floor(random() * RESOURCES.length);
    const r = RESOURCES[index] as Resource;
    const verb = pick(VERBS);
    const gold = toolName(verb, r, styleOf(index));
    if (seen.has(gold)) continue;
    seen.add(gold);
    const templates = QUERY_TEMPLATES[verb];
    const paraphrase = out.length % 2 === 1 && templates.length > 1;
    const template = paraphrase ? pick(templates.slice(1)) : (templates[0] as string);
    out.push({
      query: template.replace('{n}', r.noun).replace('{p}', r.plural),
      gold,
      paraphrase,
    });
  }
  return out;
}
