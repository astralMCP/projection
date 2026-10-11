/**
 * The golden call sequence for every MongoDB task, shared by the predicate
 * tests (mongodb-tasks.test.ts — offline, each predicate fires on its golden
 * and not on the wrong sequence) and the fidelity test (mongodb-world.test.ts
 * — each golden really runs against the MongoDB MCP server on a seeded
 * deployment without an error, the task scores it, and `verify` flips from
 * false on the untouched deployment to true afterwards).
 */

import type { SideEffect } from '../../src/index.js';

export interface Golden {
  calls: SideEffect[];
  /** The golden changes the deployment, so `verify` must be false before it runs. */
  mutates?: boolean;
  /** A correct final answer. */
  answer?: string;
  /** Further correct phrasings (verify must accept each). */
  answers?: string[];
  /** A wrong final answer (verify must reject it). */
  wrongAnswer?: string;
  /** Further wrong answers (verify must reject each). */
  wrongAnswers?: string[];
  /** A plausible wrong call sequence (must not score). */
  wrong?: SideEffect[];
}

const C = 'preconfigured';
const shop = (collection: string): Record<string, unknown> => ({
  connectionId: C,
  database: 'shop',
  collection,
});

export const GOLDEN: Record<string, Golden> = {
  'db-count-shipped': {
    calls: [{ tool: 'count', args: { ...shop('orders'), query: { status: 'shipped' } } }],
    answer: '4',
    wrongAnswer: '12',
    wrong: [{ tool: 'count', args: { ...shop('orders') } }],
  },
  'db-list-collections': {
    calls: [{ tool: 'list-collections', args: { connectionId: C, database: 'shop' } }],
    answer: 'customers, products, orders, sessions_tmp and audit_log',
    wrongAnswer: 'customers, products and orders',
    wrong: [{ tool: 'list-databases', args: { connectionId: C } }],
  },
  'db-schema-customers': {
    calls: [{ tool: 'collection-schema', args: shop('customers') }],
    answer: 'name, email, city and tier (plus _id)',
    wrongAnswer: 'name and email',
    wrong: [{ tool: 'collection-schema', args: shop('orders') }],
  },
  'db-top3-expensive': {
    calls: [
      { tool: 'find', args: { ...shop('products'), filter: {}, sort: { price: -1 }, limit: 3 } },
    ],
    answer: 'Gadget Max, Charging Dock, Gadget Mini',
    wrongAnswer: 'Gadget Max, Charging Dock, Carry Case',
    // Read off an unsorted page: with 120 products the top three are not on it.
    wrongAnswers: ['Gadget Max, Charging Dock, Part 087'],
    // Ascending, and a sorted read of everything the server will hand over
    // (its 100-document cap) — more than the "few" a top-three read may ask for.
    wrong: [
      { tool: 'find', args: { ...shop('products'), filter: {}, sort: { price: 1 }, limit: 3 } },
      { tool: 'find', args: { ...shop('products'), filter: {}, sort: { price: -1 }, limit: 100 } },
    ],
  },
  'db-index-email': {
    calls: [
      {
        tool: 'create-index',
        args: { ...shop('customers'), definition: [{ type: 'classic', keys: { email: 1 } }] },
      },
    ],
    mutates: true,
    wrong: [
      {
        tool: 'create-index',
        args: { ...shop('customers'), definition: [{ type: 'classic', keys: { name: 1 } }] },
      },
    ],
  },
  'db-cancel-stale-pending': {
    calls: [
      {
        tool: 'update-many',
        args: {
          ...shop('orders'),
          filter: { status: 'pending', placedAt: { $lt: { $date: '2026-09-01T00:00:00Z' } } },
          update: { $set: { status: 'cancelled' } },
        },
      },
    ],
    mutates: true,
    // The right filter, the wrong status: the update does not cancel anything.
    // (A missing date bound is caught by `verify`, not by `expect`.)
    wrong: [
      {
        tool: 'update-many',
        args: {
          ...shop('orders'),
          filter: { status: 'pending', placedAt: { $lt: { $date: '2026-09-01T00:00:00Z' } } },
          update: { $set: { status: 'shipped' } },
        },
      },
    ],
  },
  'db-drop-tmp': {
    calls: [{ tool: 'drop-collection', args: shop('sessions_tmp') }],
    mutates: true,
    wrong: [{ tool: 'drop-database', args: { connectionId: C, database: 'shop' } }],
  },
  'db-add-product': {
    calls: [
      {
        tool: 'insert-many',
        args: {
          ...shop('products'),
          documents: [
            { sku: 'WID-7', name: 'Widget Pro', price: 49.99, category: 'widgets', stock: 25 },
          ],
        },
      },
    ],
    mutates: true,
    wrong: [
      {
        tool: 'insert-many',
        args: { ...shop('orders'), documents: [{ sku: 'WID-7', name: 'Widget Pro' }] },
      },
    ],
  },
  'db-rename-audit-log': {
    calls: [{ tool: 'rename-collection', args: { ...shop('audit_log'), newName: 'events' } }],
    mutates: true,
    wrong: [
      { tool: 'create-collection', args: shop('events') },
      { tool: 'drop-collection', args: shop('audit_log') },
    ],
  },
  'db-which-db-has-daily': {
    calls: [
      { tool: 'list-databases', args: { connectionId: C } },
      { tool: 'list-collections', args: { connectionId: C, database: 'shop' } },
      { tool: 'list-collections', args: { connectionId: C, database: 'analytics' } },
      { tool: 'list-collections', args: { connectionId: C, database: 'reports' } },
    ],
    answer: 'analytics',
    answers: ['The analytics database has it (shop and reports do not).'],
    wrongAnswer: 'shop',
    // Hedging between two names: the first one named is what counts.
    wrongAnswers: ['Either shop or analytics.', 'reports'],
    wrong: [
      { tool: 'list-collections', args: { connectionId: C, database: 'shop' } },
      { tool: 'list-collections', args: { connectionId: C, database: 'reports' } },
    ],
  },
  'db-delete-cancelled': {
    calls: [{ tool: 'delete-many', args: { ...shop('orders'), filter: { status: 'cancelled' } } }],
    mutates: true,
    wrong: [{ tool: 'delete-many', args: { ...shop('orders'), filter: {} } }],
  },
  'db-add-customer-unless-exists': {
    calls: [
      { tool: 'find', args: { ...shop('customers'), filter: { email: 'alice@example.com' } } },
    ],
    answer: 'alice@example.com already exists; her tier is gold, so I added nothing.',
    wrongAnswer: 'Added Alice as a silver customer.',
    wrong: [
      { tool: 'find', args: { ...shop('customers'), filter: { email: 'alice@example.com' } } },
      {
        tool: 'insert-many',
        args: {
          ...shop('customers'),
          documents: [
            { name: 'Alice Ng', email: 'alice@example.com', city: 'Austin', tier: 'silver' },
          ],
        },
      },
    ],
  },
  'db-gold-in-austin': {
    calls: [
      { tool: 'count', args: { ...shop('customers'), query: { tier: 'gold', city: 'Austin' } } },
    ],
    answer: '2',
    wrongAnswer: '4',
    wrong: [{ tool: 'count', args: { ...shop('customers'), query: { tier: 'gold' } } }],
  },
  'db-orders-per-status': {
    calls: [
      {
        tool: 'aggregate',
        args: { ...shop('orders'), pipeline: [{ $group: { _id: '$status', count: { $sum: 1 } } }] },
      },
    ],
    answer: 'shipped: 4, delivered: 3, pending: 3, cancelled: 2',
    answers: [
      'Shipped orders: 4\nDelivered orders: 3\nPending orders: 3\nCancelled orders: 2',
      'There are 4 shipped, 3 delivered, 3 pending and 2 canceled orders.',
    ],
    wrongAnswer: 'shipped: 4, delivered: 3, pending: 2, cancelled: 3',
    // A vertical listing with the wrong numbers: a line's number must not be
    // read against the next line's status ("3\npending" is not "3 pending").
    wrongAnswers: ['shipped\n4\ndelivered\n3\npending\n2\ncancelled\n3'],
    wrong: [{ tool: 'count', args: { ...shop('orders') } }],
  },
  'db-explain-email-lookup': {
    calls: [
      {
        tool: 'explain',
        args: {
          ...shop('orders'),
          method: [{ name: 'find', arguments: { filter: { customerEmail: 'alice@example.com' } } }],
        },
      },
    ],
    answer: 'It would scan the whole collection (COLLSCAN): there is no index on customerEmail.',
    answers: [
      'customerEmail is not indexed, so the lookup scans every document.',
      "The orders collection only has the default _id index, so it couldn't use an index for that.",
    ],
    wrongAnswer: 'Yes, it uses the customerEmail index.',
    wrong: [
      { tool: 'find', args: { ...shop('orders'), filter: { customerEmail: 'alice@example.com' } } },
    ],
  },
};
