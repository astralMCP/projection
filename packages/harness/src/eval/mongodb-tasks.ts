/**
 * The MongoDB tier: 15 tasks against the real MongoDB MCP server on a
 * seeded throwaway deployment (mongodb-world.ts), phrased for a user who
 * knows their database and nothing about the server's tools.
 *
 * Built to discriminate between the server's near-duplicate tools and
 * between argument shapes: a count (`count` with a query, or `find` /
 * `aggregate` that filter or group); a top-N by price (`sort` + `limit`, or
 * a `$sort`/`$limit` pipeline — the 120-product fixture puts the top three
 * out of reach of an unsorted read); a group-by (`aggregate` with `$group`
 * or `$sortByCount`, or one `count` per status); a scoped update
 * (`update-many` that sets the status — never a delete; the filter's
 * correctness is carried by `verify` on the deployment, since a date bound,
 * an `$expr` or an `$in` of ids found first are all legitimate); a scoped
 * delete (`delete-many` with a filter — never an empty one, never a drop); a
 * drop of one collection (not the database); a rename; a conditional insert
 * that must NOT happen because the customer exists; and a query-plan
 * question (`explain` or `collection-indexes`). Every tool also needs
 * `connectionId: "preconfigured"`, which both modes have to read off the
 * schema.
 *
 * `expect` scores the recorded calls; mutation tasks `verify` the
 * deployment through the driver, and question tasks verify the answer.
 * Filters are accepted in their common spellings (`{status: 'x'}`,
 * `{status: {$eq: 'x'}}`, `{status: {$in: ['x']}}`, a top-level `$and`, a
 * pipeline whose conditions are spread over several `$match` stages).
 *
 * Reads are also accepted through `aggregate-db`, the database-level
 * aggregate (no `collection` argument): models reach a collection from it
 * with a `$documents` seed and a `$lookup` (`from` + sub-pipeline), or a
 * `$unionWith`. {@link viaDatabaseAggregate} turns such a call back into
 * the `aggregate`(s) on the collection it reads, so every read predicate
 * sees both shapes.
 */

import type { SideEffect } from '../types.js';
import {
  FIXTURE_CUSTOMERS,
  FIXTURE_PRODUCTS,
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

/**
 * One flat filter document: a top-level `$and` is merged into its siblings
 * (`{$and: [{a: 1}, {b: 2}]}` → `{a: 1, b: 2}`), so `fieldIs`/`boundsBelow`
 * see every condition regardless of how the model spelt the conjunction.
 */
function flatten(filter: Doc): Doc {
  const { $and, ...rest } = filter;
  if (!Array.isArray($and)) return filter;
  return $and.filter(isDoc).reduce<Doc>((acc, clause) => ({ ...acc, ...flatten(clause) }), rest);
}

/** The filter argument under whichever name the tool uses (`filter`, or `query` for count), flattened. */
function filterOf(args: Args): Doc {
  const value = args['filter'] ?? args['query'];
  return isDoc(value) ? flatten(value) : {};
}

/** The pipeline's stages, each `{ $stage: spec }`. */
function stagesOf(args: Args): Doc[] {
  const pipeline = args['pipeline'];
  return Array.isArray(pipeline) ? pipeline.filter(isDoc) : [];
}

/** Every `$match` stage's filter, merged into one flattened document. */
function matchOf(args: Args): Doc {
  let merged: Doc = {};
  for (const entry of stagesOf(args)) {
    const match = entry['$match'];
    if (isDoc(match)) merged = { ...merged, ...flatten(match) };
  }
  return merged;
}

function stage(args: Args, name: string): unknown {
  for (const s of stagesOf(args)) if (s[name] !== undefined) return s[name];
  return undefined;
}

/**
 * The `$unwind` / `$replaceRoot` / `$replaceWith` spec names `$<field>`.
 * `$unwind` takes `'$r'` or `{path: '$r'}`; `$replaceRoot` takes
 * `{newRoot: '$r'}`; `$replaceWith` takes `'$r'`.
 */
function namesField(spec: unknown, field: string, key?: string): boolean {
  const value = isDoc(spec) && key !== undefined ? spec[key] : spec;
  return value === `$${field}`;
}

/**
 * The `$lookup` at `stages[i]` is unwrapped by the next two stages — an
 * `$unwind` of its `as` field, then a `$replaceRoot`/`$replaceWith` to it —
 * so the stages after them run on the joined collection's documents.
 */
function unwrapsLookup(stages: Doc[], i: number, as: unknown): boolean {
  if (typeof as !== 'string') return false;
  const unwind = stages[i + 1];
  const replace = stages[i + 2];
  return (
    unwind !== undefined &&
    replace !== undefined &&
    (namesField(unwind['$unwind'], as) || namesField(unwind['$unwind'], as, 'path')) &&
    (namesField(replace['$replaceRoot'], as, 'newRoot') || namesField(replace['$replaceWith'], as))
  );
}

/**
 * Every way an `aggregate-db` call on `database` reads `collection`, each as
 * the arguments of the equivalent collection `aggregate`; empty when it does
 * not reach the collection. Collection names compare case-sensitively, as
 * MongoDB's do.
 *
 * - `$unionWith` (`'coll'` or `{coll, pipeline?}`): its sub-pipeline, then
 *   every stage after it — the union's documents flow on down the outer
 *   pipeline.
 * - `$lookup {from, pipeline?, as}` immediately followed by `$unwind` and
 *   `$replaceRoot`/`$replaceWith` of `as` (the usual `$documents` →
 *   `$lookup` → `$unwind` → `$replaceRoot` shape): its sub-pipeline, then
 *   every stage after the unwrap.
 * - Any other `$lookup` of it: its sub-pipeline only (empty for a
 *   `localField` join). Later stages run on the outer documents, with the
 *   joined ones nested under `as`, so they are not reads of the collection.
 */
function viaDatabaseAggregate(
  call: SideEffect,
  collection: string,
  database: string = SHOP_DB,
): Args[] {
  if (call.tool !== 'aggregate-db' || !sameText(call.args['database'], database)) return [];
  const stages = stagesOf(call.args);
  const reads: Args[] = [];
  const read = (inner: unknown, after: Doc[]): void => {
    const sub = Array.isArray(inner) ? inner.filter(isDoc) : [];
    reads.push({ database, collection, pipeline: [...sub, ...after] });
  };
  for (const [i, entry] of stages.entries()) {
    const lookup = entry['$lookup'];
    const union = entry['$unionWith'];
    if (isDoc(lookup) && lookup['from'] === collection) {
      const unwrapped = unwrapsLookup(stages, i, lookup['as']);
      read(lookup['pipeline'], unwrapped ? stages.slice(i + 3) : []);
    } else if (union === collection) {
      read([], stages.slice(i + 1));
    } else if (isDoc(union) && union['coll'] === collection) {
      read(union['pipeline'], stages.slice(i + 1));
    }
  }
  return reads;
}

/**
 * Some call is a collection `aggregate` on `collection` whose arguments
 * satisfy `where`, or an `aggregate-db` that reads it the same way.
 */
function aggregates(
  calls: SideEffect[],
  collection: string,
  where: (args: Args) => boolean,
  database: string = SHOP_DB,
): boolean {
  return calls.some((call) => {
    if (call.tool === 'aggregate') return on(call.args, collection, database) && where(call.args);
    return viaDatabaseAggregate(call, collection, database).some(where);
  });
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

function isEmpty(doc: Doc): boolean {
  return Object.keys(doc).length === 0;
}

/** A read of `collection` that filters by `where` (count/find, or an aggregate's $match). */
function filteredRead(
  calls: SideEffect[],
  collection: string,
  where: (f: Doc) => boolean,
): boolean {
  return (
    has(calls, ['count', 'find'], (args) => on(args, collection) && where(filterOf(args))) ||
    aggregates(calls, collection, (args) => where(matchOf(args)))
  );
}

/** Any read of `collection`'s contents, filtered or not. */
const READ_TOOLS = ['find', 'count', 'aggregate', 'aggregate-db', 'collection-schema'];

function reads(calls: SideEffect[], collection: string): boolean {
  return (
    has(calls, READ_TOOLS, (args) => on(args, collection)) ||
    aggregates(calls, collection, () => true)
  );
}

/**
 * An `aggregate` over `collection` that groups by `field`: `$group` with an
 * `_id` naming the field (`'$status'` or `{status: '$status'}`), or a
 * `$sortByCount` of it. The model then reads the per-group counts off the
 * result.
 */
function groupsBy(calls: SideEffect[], collection: string, field: string): boolean {
  return aggregates(calls, collection, (args) => {
    const group = stage(args, '$group');
    const sortByCount = stage(args, '$sortByCount');
    return (
      (isDoc(group) && (JSON.stringify(group['_id']) ?? '').includes(field)) ||
      (sortByCount !== undefined && JSON.stringify(sortByCount).includes(field))
    );
  });
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

/** A numeric limit (the schema types it as a number) within `[min, max]`. */
function limitBetween(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Writes aimed at `collection` that a task may forbid. */
function destroys(call: SideEffect, collection: string): boolean {
  return (
    (call.tool === 'drop-collection' && on(call.args, collection)) ||
    (call.tool === 'delete-many' && on(call.args, collection)) ||
    call.tool === 'drop-database'
  );
}

/** The `update-many` update sets `field` to `value` (`{$set: {field: value}}`). */
function sets(args: Args, field: string, value: string): boolean {
  const update = args['update'];
  return isDoc(update) && isDoc(update['$set']) && sameText(update['$set'][field], value);
}

const number = (n: number): RegExp => new RegExp(`(^|\\D)${n}(\\D|$)`);

/**
 * `status: n` (prose or table, optionally "status orders: n") or
 * `n [orders [are]] status`, on one line: only horizontal whitespace may
 * separate the words, so a vertical listing cannot bleed one line's number
 * into the next line's status. "cancelled" also matches "canceled".
 */
const statusCount = (status: string, n: number): RegExp => {
  const word = status === 'cancelled' ? 'cancel+ed' : status;
  return new RegExp(
    `${word}[^\\w\\s]{0,2}(?:[ \\t]+orders?)?[ \\t]*[^\\w\\s]{0,4}[ \\t]*${n}(?:\\D|$)` +
      `|(?:^|\\D)${n}[ \\t]+(?:\\w+[ \\t]+){0,2}${word}`,
    'i',
  );
};

/**
 * The `create-index` definition indexes `field`. Only the array form
 * (`[{ type, keys: { field: 1 } }]`) exists: the mirrored schema rejects a
 * bare keys object or a top-level `{keys}` before the call is recorded.
 */
function indexesField(args: Args, field: string): boolean {
  const definition = args['definition'];
  return (
    Array.isArray(definition) &&
    definition.some(
      (spec) => isDoc(spec) && isDoc(spec['keys']) && spec['keys'][field] !== undefined,
    )
  );
}

/** The first database name the answer mentions, among the deployment's three. */
function firstDatabaseNamed(text: string): string | undefined {
  return /\b(shop|analytics|reports)\b/i.exec(text)?.[1]?.toLowerCase();
}

export const MONGODB_TASKS: readonly EvalTask[] = [
  // --- A filtered count: count with a query, find/aggregate filtering on
  // status, or a group-by whose shipped row the model reads.
  {
    name: 'db-count-shipped',
    tier: 'mongodb',
    kind: 'single',
    prompt:
      'How many orders in the shop database have status "shipped"? Answer with just the number.',
    steps: [['count', 'find', 'aggregate', 'aggregate-db']],
    expect: (calls) =>
      filteredRead(calls, 'orders', (f) => fieldIs(f, 'status', 'shipped')) ||
      groupsBy(calls, 'orders', 'status'),
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
    steps: [['collection-schema', 'find', 'aggregate', 'aggregate-db']],
    expect: (calls) => reads(calls, 'customers'),
    verify: (context) =>
      ['name', 'email', 'city', 'tier'].every((field) => context.finalText.includes(field)),
  },
  // --- Top N: sort + limit, or a $sort/$limit pipeline. A limit of a few
  // (3–10) is fine — the model reads the top three off the result; with 120
  // products an unsorted read cannot (see FIXTURE_PRODUCTS).
  {
    name: 'db-top3-expensive',
    tier: 'mongodb',
    kind: 'single',
    prompt:
      'Which are the three most expensive products in the shop database? Answer with just their names.',
    steps: [['find', 'aggregate', 'aggregate-db']],
    expect: (calls) =>
      has(
        calls,
        'find',
        (args) =>
          on(args, 'products') &&
          sortedBy(args['sort'], 'price', -1) &&
          limitBetween(args['limit'], 3, 10),
      ) ||
      aggregates(
        calls,
        'products',
        (args) =>
          sortedBy(stage(args, '$sort'), 'price', -1) && limitBetween(stage(args, '$limit'), 3, 10),
      ),
    verify: (context) =>
      ['Gadget Max', 'Charging Dock', 'Gadget Mini'].every((n) => context.finalText.includes(n)) &&
      !['Widget Basic', 'Widget Plus', 'Carry Case', 'Part '].some((n) =>
        context.finalText.includes(n),
      ),
  },
  // --- An index.
  {
    name: 'db-index-email',
    tier: 'mongodb',
    kind: 'single',
    needsWorld: true,
    prompt: 'Add an index on the email field of the customers collection in the shop database.',
    steps: [['create-index']],
    // The server takes `definition: [{ type: 'classic', keys: { email: 1 } }]`.
    expect: (calls) =>
      has(calls, 'create-index', (args) => on(args, 'customers') && indexesField(args, 'email')),
    verify: (context) =>
      withMongodb(context.facts, async (client) => {
        const indexes = await client.db(SHOP_DB).collection('customers').indexes();
        return indexes.some((index) => isDoc(index['key']) && index['key']['email'] !== undefined);
      }),
  },
  // --- A scoped update: an update-many that sets the status; never a
  // delete. The filter is not scored — a `$date` bound, an `$expr`, or an
  // `orderId $in` list after a find are all legitimate — so correctness is
  // carried by `verify`: exactly the two stale orders flipped, the recent
  // one kept, nothing removed.
  {
    name: 'db-cancel-stale-pending',
    tier: 'mongodb',
    kind: 'single',
    needsWorld: true,
    prompt:
      'In the shop database, mark every order that is still "pending" and was placed before 1 September 2026 as "cancelled".',
    steps: [['update-many']],
    expect: (calls) =>
      has(calls, 'update-many', (args) => on(args, 'orders') && sets(args, 'status', 'cancelled')),
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
    needsWorld: true,
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
    needsWorld: true,
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
          (await products.countDocuments({})) === FIXTURE_PRODUCTS.length + 1
        );
      }),
  },
  // --- Rename, not copy + drop.
  {
    name: 'db-rename-audit-log',
    tier: 'mongodb',
    kind: 'single',
    needsWorld: true,
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
  // --- Cross-database discovery: any read that looked inside `analytics`
  // (a listing, or a probe of its collections), and an answer that names
  // it first — `reports` is a decoy with a `daily_summary` collection.
  {
    name: 'db-which-db-has-daily',
    tier: 'mongodb',
    kind: 'multi',
    prompt:
      'One of the databases on this deployment has a collection called daily. Which database is it? Answer with just the database name.',
    steps: [['list-databases'], ['list-collections', ...READ_TOOLS]],
    // A database-level `aggregate-db` on analytics counts only when it
    // reaches `daily`: `[{$documents: [{}]}]` runs there without touching
    // a collection.
    expect: (calls) =>
      has(calls, 'list-collections', (args) => sameText(args['database'], 'analytics')) ||
      has(calls, ['find', 'count', 'aggregate', 'collection-schema'], (args) =>
        on(args, 'daily', 'analytics'),
      ) ||
      aggregates(calls, 'daily', () => true, 'analytics'),
    verify: (context) => firstDatabaseNamed(context.finalText) === 'analytics',
  },
  // --- A scoped delete: a filter, never an empty one, never a drop.
  {
    name: 'db-delete-cancelled',
    tier: 'mongodb',
    kind: 'single',
    needsWorld: true,
    prompt: 'Remove every cancelled order from the shop database.',
    steps: [['delete-many']],
    expect: (calls) =>
      has(calls, 'delete-many', (args) => on(args, 'orders') && !isEmpty(filterOf(args))),
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
    needsWorld: true,
    prompt:
      'Add a customer to the shop database: alice@example.com, name "Alice Ng", city Austin, tier silver — unless a customer with that email already exists, in which case add nothing and tell me their current tier.',
    steps: [READ_TOOLS],
    expect: (calls) =>
      filteredRead(calls, 'customers', (f) => fieldIs(f, 'email', 'alice@example.com')) ||
      has(calls, 'find', (args) => on(args, 'customers')) ||
      aggregates(calls, 'customers', () => true),
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
    steps: [['count', 'find', 'aggregate', 'aggregate-db']],
    expect: (calls) =>
      filteredRead(
        calls,
        'customers',
        (f) => fieldIs(f, 'tier', 'gold') && fieldIs(f, 'city', 'Austin'),
      ),
    verify: (context) => number(2).test(context.finalText.trim()),
  },
  // --- Group by: one aggregate ($group or $sortByCount), or a count per
  // status. A database-level `aggregate-db` counts through `groupsBy` (the
  // observed shape: `$documents` → `$lookup {from: 'orders', pipeline:
  // [$group by status]}` → `$unwind` → `$replaceRoot`); `verify` checks
  // every status's count.
  {
    name: 'db-orders-per-status',
    tier: 'mongodb',
    kind: 'single',
    prompt: 'In the shop database, how many orders are there for each status?',
    steps: [['aggregate', 'aggregate-db', 'count']],
    expect: (calls) =>
      groupsBy(calls, 'orders', 'status') ||
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
      /collscan|collection scan|scan(s|ning)? the (whole|entire|full) collection|scan(s|ning)? (all|every|each)|no index|not indexed|isn'?t indexed|unindexed|not use an index|does(n't| not) use an index|(can|could|would)( ?not|n'?t) (be able to )?use an index|without an index|full scan|only .{0,20}_id index/i.test(
        context.finalText,
      ),
  },
];
