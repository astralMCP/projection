/**
 * The MongoDB tier: 15 tasks against the real MongoDB MCP server on a
 * seeded throwaway deployment (mongodb-world.ts), phrased for a user who
 * knows their database and nothing about the server's tools.
 *
 * Built to discriminate between the server's near-duplicate tools and
 * between argument shapes: a count (`count` with a query, or `find` /
 * `aggregate` that filter); a top-N by price (`sort` + `limit`, or a
 * `$sort`/`$limit` pipeline); a group-by (`aggregate` with `$group`, or one
 * `count` per status); a scoped update (`update-many` whose filter names
 * both the status and the cut-off date — never a delete); a scoped delete
 * (`delete-many` with a filter — never an empty filter, never a drop); a
 * drop of one collection (not the database); a rename; a conditional insert
 * that must NOT happen because the customer exists; and a query-plan
 * question (`explain` or `collection-indexes`). Every tool also needs
 * `connectionId: "preconfigured"`, which both modes have to read off the
 * schema.
 *
 * `expect` scores the recorded calls; mutation tasks `verify` the
 * deployment through the driver, and question tasks verify the answer.
 * Filters are accepted in their common spellings (`{status: 'x'}`,
 * `{status: {$eq: 'x'}}`, `{status: {$in: ['x']}}`).
 */

import type { SideEffect } from '../types.js';
import {
  FIXTURE_CUSTOMERS,
  ORDER_STATUS_COUNTS,
  SHOP_COLLECTIONS,
  SHOP_DB,
  STALE_CUTOFF,
  withMongodb,
} from './mongodb-world.js';
import { has, sameText, type Args, type EvalTask } from './task-core.js';

type Doc = Record<string, unknown>;

function isDoc(value: unknown): value is Doc {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The call targets `collection` in the shop database. */
function on(args: Args, collection: string, database: string = SHOP_DB): boolean {
  return sameText(args['database'], database) && sameText(args['collection'], collection);
}

/** The filter argument under whichever name the tool uses (`filter`, or `query` for count). */
function filterOf(args: Args): Doc {
  const value = args['filter'] ?? args['query'];
  return isDoc(value) ? value : {};
}

/** The pipeline's stages, each `{ $stage: spec }`. */
function stagesOf(args: Args): Doc[] {
  const pipeline = args['pipeline'];
  return Array.isArray(pipeline) ? pipeline.filter(isDoc) : [];
}

/** The first `$match` stage's filter, if any. */
function matchOf(args: Args): Doc {
  for (const stage of stagesOf(args)) {
    const match = stage['$match'];
    if (isDoc(match)) return match;
  }
  return {};
}

function stage(args: Args, name: string): unknown {
  for (const s of stagesOf(args)) if (s[name] !== undefined) return s[name];
  return undefined;
}

/** `filter[field]` equals `value`: plain, `$eq`, or a one-element `$in`. */
function fieldIs(filter: Doc, field: string, value: string): boolean {
  const spec = filter[field];
  if (typeof spec === 'string') return spec.toLowerCase() === value.toLowerCase();
  if (isDoc(spec)) {
    if (typeof spec['$eq'] === 'string') return spec['$eq'].toLowerCase() === value.toLowerCase();
    const list = spec['$in'];
    return (
      Array.isArray(list) &&
      list.length === 1 &&
      typeof list[0] === 'string' &&
      list[0].toLowerCase() === value.toLowerCase()
    );
  }
  return false;
}

/** The filter has an upper bound on `field` (`$lt`/`$lte`, any encoding of the date). */
function boundsBelow(filter: Doc, field: string): boolean {
  const spec = filter[field];
  return isDoc(spec) && (spec['$lt'] !== undefined || spec['$lte'] !== undefined);
}

function isEmpty(doc: Doc): boolean {
  return Object.keys(doc).length === 0;
}

/** A read of `collection` that filters by `where` (count/find/aggregate $match). */
function filteredRead(
  calls: SideEffect[],
  collection: string,
  where: (f: Doc) => boolean,
): boolean {
  return (
    has(calls, ['count', 'find'], (args) => on(args, collection) && where(filterOf(args))) ||
    has(calls, 'aggregate', (args) => on(args, collection) && where(matchOf(args)))
  );
}

/** Any read of `collection`'s contents, filtered or not. */
const READ_TOOLS = ['find', 'count', 'aggregate', 'collection-schema'];

function reads(calls: SideEffect[], collection: string): boolean {
  return has(calls, READ_TOOLS, (args) => on(args, collection));
}

/** `sort[field] === direction` (numbers or the strings "asc"/"desc"). */
function sortedBy(sort: unknown, field: string, direction: -1 | 1): boolean {
  if (!isDoc(sort)) return false;
  const value = sort[field];
  return (
    value === direction ||
    (direction === -1 && (value === 'desc' || value === 'descending')) ||
    (direction === 1 && (value === 'asc' || value === 'ascending'))
  );
}

function limitIs(value: unknown, n: number): boolean {
  return value === n || value === String(n);
}

/** Writes aimed at `collection` that a task may forbid. */
function destroys(call: SideEffect, collection: string): boolean {
  return (
    (call.tool === 'drop-collection' && on(call.args, collection)) ||
    (call.tool === 'delete-many' && on(call.args, collection)) ||
    call.tool === 'drop-database'
  );
}

const number = (n: number): RegExp => new RegExp(`(^|\\D)${n}(\\D|$)`);

/**
 * `status: n` (prose or table) or `n [orders [are]] status`. The number must
 * sit right after the status or be followed by whitespace, so "delivered: 3,
 * pending" does not read as three pending.
 */
const statusCount = (status: string, n: number): RegExp =>
  new RegExp(`${status}\\W{0,4}${n}(\\D|$)|(^|\\D)${n}\\s+(\\w+\\s+){0,2}${status}`, 'i');

/** The `create-index` definition (an array of index specs, or a bare keys object) indexes `field`. */
function indexesField(args: Args, field: string): boolean {
  const definition = args['definition'];
  const specs = Array.isArray(definition) ? definition : [definition];
  return specs.some((spec) => {
    if (!isDoc(spec)) return false;
    const keys = isDoc(spec['keys']) ? spec['keys'] : spec;
    return keys[field] !== undefined;
  });
}

export const MONGODB_TASKS: readonly EvalTask[] = [
  // --- A filtered count: count with a query, or find/aggregate filtering on status.
  {
    name: 'db-count-shipped',
    tier: 'mongodb',
    kind: 'single',
    prompt:
      'How many orders in the shop database have status "shipped"? Answer with just the number.',
    steps: [['count', 'find', 'aggregate']],
    expect: (calls) => filteredRead(calls, 'orders', (f) => fieldIs(f, 'status', 'shipped')),
    verify: (context) => number(ORDER_STATUS_COUNTS['shipped'] ?? 0).test(context.finalText.trim()),
  },
  // --- Discovery: the collection names.
  {
    name: 'db-list-collections',
    tier: 'mongodb',
    kind: 'single',
    prompt: 'What collections are in the shop database?',
    steps: [['list-collections']],
    expect: (calls) =>
      has(calls, 'list-collections', (args) => sameText(args['database'], SHOP_DB)),
    verify: (context) => SHOP_COLLECTIONS.every((name) => context.finalText.includes(name)),
  },
  // --- Schema inference, or a sample of documents.
  {
    name: 'db-schema-customers',
    tier: 'mongodb',
    kind: 'single',
    prompt: 'What fields does a customer document in the shop database have?',
    steps: [['collection-schema', 'find', 'aggregate']],
    expect: (calls) => reads(calls, 'customers'),
    verify: (context) =>
      ['name', 'email', 'city', 'tier'].every((field) => context.finalText.includes(field)),
  },
  // --- Top N: sort + limit, or a $sort/$limit pipeline.
  {
    name: 'db-top3-expensive',
    tier: 'mongodb',
    kind: 'single',
    prompt:
      'Which are the three most expensive products in the shop database? Answer with just their names.',
    steps: [['find', 'aggregate']],
    expect: (calls) =>
      has(
        calls,
        'find',
        (args) =>
          on(args, 'products') && sortedBy(args['sort'], 'price', -1) && limitIs(args['limit'], 3),
      ) ||
      has(
        calls,
        'aggregate',
        (args) =>
          on(args, 'products') &&
          sortedBy(stage(args, '$sort'), 'price', -1) &&
          limitIs(stage(args, '$limit'), 3),
      ),
    verify: (context) =>
      ['Gadget Max', 'Charging Dock', 'Gadget Mini'].every((n) => context.finalText.includes(n)) &&
      !['Widget Basic', 'Widget Plus', 'Carry Case'].some((n) => context.finalText.includes(n)),
  },
  // --- An index.
  {
    name: 'db-index-email',
    tier: 'mongodb',
    kind: 'single',
    prompt: 'Add an index on the email field of the customers collection in the shop database.',
    steps: [['create-index']],
    // The server takes `definition: [{ type: 'classic', keys: { email: 1 } }]`;
    // a bare `{ email: 1 }` or `{ keys: ... }` object is accepted here too.
    expect: (calls) =>
      has(calls, 'create-index', (args) => on(args, 'customers') && indexesField(args, 'email')),
    verify: (context) =>
      withMongodb(context.facts, async (client) => {
        const indexes = await client.db(SHOP_DB).collection('customers').indexes();
        return indexes.some((index) => isDoc(index['key']) && index['key']['email'] !== undefined);
      }),
  },
  // --- A scoped update: both conditions in the filter; never a delete.
  {
    name: 'db-cancel-stale-pending',
    tier: 'mongodb',
    kind: 'single',
    prompt:
      'In the shop database, mark every order that is still "pending" and was placed before 1 September 2026 as "cancelled".',
    steps: [['update-many']],
    expect: (calls) =>
      has(calls, 'update-many', (args) => {
        const filter = filterOf(args);
        return (
          on(args, 'orders') &&
          fieldIs(filter, 'status', 'pending') &&
          boundsBelow(filter, 'placedAt')
        );
      }),
    forbid: (call) => destroys(call, 'orders'),
    verify: (context) =>
      withMongodb(context.facts, async (client) => {
        const orders = client.db(SHOP_DB).collection('orders');
        const stalePending = await orders.countDocuments({
          status: 'pending',
          placedAt: { $lt: STALE_CUTOFF },
        });
        const recentPending = await orders.countDocuments({
          status: 'pending',
          placedAt: { $gte: STALE_CUTOFF },
        });
        const cancelled = await orders.countDocuments({ status: 'cancelled' });
        const total = await orders.countDocuments({});
        return stalePending === 0 && recentPending === 1 && cancelled === 4 && total === 12;
      }),
  },
  // --- Drop one collection, not the database.
  {
    name: 'db-drop-tmp',
    tier: 'mongodb',
    kind: 'single',
    prompt:
      'Delete the sessions_tmp collection from the shop database — it is scratch data we no longer need.',
    steps: [['drop-collection']],
    expect: (calls) => has(calls, 'drop-collection', (args) => on(args, 'sessions_tmp')),
    forbid: (call) =>
      call.tool === 'drop-database' ||
      (call.tool === 'drop-collection' && !on(call.args, 'sessions_tmp')),
    verify: (context) =>
      withMongodb(context.facts, async (client) => {
        const names = (await client.db(SHOP_DB).listCollections().toArray()).map((c) => c.name);
        return (
          !names.includes('sessions_tmp') &&
          SHOP_COLLECTIONS.filter((n) => n !== 'sessions_tmp').every((n) => names.includes(n))
        );
      }),
  },
  // --- Insert one document.
  {
    name: 'db-add-product',
    tier: 'mongodb',
    kind: 'single',
    prompt:
      'Add a product to the shop database: sku WID-7, name "Widget Pro", price 49.99, category widgets, stock 25.',
    steps: [['insert-many']],
    expect: (calls) =>
      has(calls, 'insert-many', (args) => {
        const docs = args['documents'];
        return (
          on(args, 'products') &&
          Array.isArray(docs) &&
          docs.some((doc) => isDoc(doc) && doc['sku'] === 'WID-7')
        );
      }),
    verify: (context) =>
      withMongodb(context.facts, async (client) => {
        const products = client.db(SHOP_DB).collection('products');
        const doc = await products.findOne({ sku: 'WID-7' });
        return (
          doc !== null &&
          doc['name'] === 'Widget Pro' &&
          doc['price'] === 49.99 &&
          doc['category'] === 'widgets' &&
          doc['stock'] === 25 &&
          (await products.countDocuments({})) === 7
        );
      }),
  },
  // --- Rename, not copy + drop.
  {
    name: 'db-rename-audit-log',
    tier: 'mongodb',
    kind: 'single',
    prompt: 'Rename the audit_log collection in the shop database to events.',
    steps: [['rename-collection']],
    expect: (calls) =>
      has(
        calls,
        'rename-collection',
        (args) => on(args, 'audit_log') && sameText(args['newName'], 'events'),
      ),
    forbid: (call) => destroys(call, 'audit_log'),
    verify: (context) =>
      withMongodb(context.facts, async (client) => {
        const db = client.db(SHOP_DB);
        const names = (await db.listCollections().toArray()).map((c) => c.name);
        return (
          names.includes('events') &&
          !names.includes('audit_log') &&
          (await db.collection('events').countDocuments({})) === 5
        );
      }),
  },
  // --- Cross-database discovery.
  {
    name: 'db-which-db-has-daily',
    tier: 'mongodb',
    kind: 'multi',
    prompt:
      'One of the databases on this deployment has a collection called daily. Which database is it? Answer with just the database name.',
    steps: [['list-databases'], ['list-collections']],
    expect: (calls) =>
      has(calls, 'list-collections', (args) => sameText(args['database'], 'analytics')),
    verify: (context) =>
      /analytics/i.test(context.finalText) && !/\bshop\b/i.test(context.finalText.trim()),
  },
  // --- A scoped delete: a filter, never an empty one, never a drop.
  {
    name: 'db-delete-cancelled',
    tier: 'mongodb',
    kind: 'single',
    prompt: 'Remove every cancelled order from the shop database.',
    steps: [['delete-many']],
    expect: (calls) =>
      has(
        calls,
        'delete-many',
        (args) => on(args, 'orders') && fieldIs(filterOf(args), 'status', 'cancelled'),
      ),
    forbid: (call) =>
      (call.tool === 'delete-many' && on(call.args, 'orders') && isEmpty(filterOf(call.args))) ||
      call.tool === 'drop-collection' ||
      call.tool === 'drop-database',
    verify: (context) =>
      withMongodb(context.facts, async (client) => {
        const orders = client.db(SHOP_DB).collection('orders');
        return (
          (await orders.countDocuments({ status: 'cancelled' })) === 0 &&
          (await orders.countDocuments({})) === 10
        );
      }),
  },
  // --- Conditional insert that must NOT happen: the customer exists.
  {
    name: 'db-add-customer-unless-exists',
    tier: 'mongodb',
    kind: 'single',
    prompt:
      'Add a customer to the shop database: alice@example.com, name "Alice Ng", city Austin, tier silver — unless a customer with that email already exists, in which case add nothing and tell me their current tier.',
    steps: [READ_TOOLS],
    expect: (calls) =>
      filteredRead(calls, 'customers', (f) => fieldIs(f, 'email', 'alice@example.com')) ||
      has(calls, ['find', 'aggregate'], (args) => on(args, 'customers')),
    forbid: (call) =>
      (call.tool === 'insert-many' && on(call.args, 'customers')) ||
      (call.tool === 'update-many' && on(call.args, 'customers')),
    verify: (context) =>
      withMongodb(context.facts, async (client) => {
        const customers = client.db(SHOP_DB).collection('customers');
        const alice = await customers.findOne({ email: 'alice@example.com' });
        return (
          alice !== null &&
          alice['tier'] === 'gold' &&
          (await customers.countDocuments({})) === FIXTURE_CUSTOMERS.length &&
          /gold/i.test(context.finalText)
        );
      }),
  },
  // --- Two conditions in one filter.
  {
    name: 'db-gold-in-austin',
    tier: 'mongodb',
    kind: 'single',
    prompt:
      'How many gold-tier customers in the shop database live in Austin? Answer with just the number.',
    steps: [['count', 'find', 'aggregate']],
    expect: (calls) =>
      filteredRead(
        calls,
        'customers',
        (f) => fieldIs(f, 'tier', 'gold') && fieldIs(f, 'city', 'Austin'),
      ),
    verify: (context) => number(2).test(context.finalText.trim()),
  },
  // --- Group by: one aggregate, or a count per status.
  {
    name: 'db-orders-per-status',
    tier: 'mongodb',
    kind: 'single',
    prompt: 'In the shop database, how many orders are there for each status?',
    steps: [['aggregate', 'count']],
    expect: (calls) =>
      has(calls, 'aggregate', (args) => {
        const group = stage(args, '$group');
        return on(args, 'orders') && isDoc(group) && String(group['_id']).includes('status');
      }) ||
      Object.keys(ORDER_STATUS_COUNTS).every((status) =>
        filteredRead(calls, 'orders', (f) => fieldIs(f, 'status', status)),
      ),
    verify: (context) =>
      Object.entries(ORDER_STATUS_COUNTS).every(([status, n]) =>
        statusCount(status, n).test(context.finalText),
      ),
  },
  // --- The query plan: explain, or the index list.
  {
    name: 'db-explain-email-lookup',
    tier: 'mongodb',
    kind: 'single',
    prompt:
      'In the shop database, would looking up orders by customerEmail use an index, or scan the whole collection? Check rather than guess.',
    steps: [['explain', 'collection-indexes']],
    expect: (calls) =>
      has(calls, 'explain', (args) => on(args, 'orders')) ||
      has(calls, 'collection-indexes', (args) => on(args, 'orders')),
    verify: (context) =>
      /collscan|collection scan|scan(s|ning)? the (whole|entire|full) collection|no index|not use an index|does(n't| not) use an index|without an index|full scan/i.test(
        context.finalText,
      ),
  },
];
