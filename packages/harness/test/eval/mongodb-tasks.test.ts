/**
 * MongoDB-tier predicates, offline (no mongod): each task fires on its
 * golden calls, stays quiet on nothing and on the right tool with empty
 * arguments, rejects the plausible wrong sequence, and `forbid` catches the
 * wrong write. `verify` is exercised against a real deployment in
 * mongodb-world.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  MONGODB_TASKS,
  promptFor,
  worldOf,
  type EvalTask,
  type SideEffect,
} from '../../src/index.js';
import { GOLDEN, type Golden } from './mongodb-goldens.js';

/** `success` before verify: expect holds and nothing forbidden was called. */
function scores(t: EvalTask, calls: SideEffect[]): boolean {
  const forbid = t.forbid;
  return t.expect(calls) && !(forbid !== undefined && calls.some((c) => forbid(c)));
}

function task(name: string): EvalTask {
  return MONGODB_TASKS.find((t) => t.name === name) as EvalTask;
}
const base = { connectionId: 'preconfigured', database: 'shop' };
const orders = { ...base, collection: 'orders' };
const customers = { ...base, collection: 'customers' };
const products = { ...base, collection: 'products' };
/** Text-only verifies never touch the deployment, so they run offline. */
const verifies = (t: EvalTask, finalText: string): Promise<boolean> | boolean =>
  (t.verify as NonNullable<EvalTask['verify']>)({ calls: [], finalText, facts: {} });

describe('mongodb tasks', () => {
  it('has 15 tasks in the mongodb tier, each with a golden', () => {
    expect(MONGODB_TASKS).toHaveLength(15);
    expect(MONGODB_TASKS.every((t) => t.tier === 'mongodb')).toBe(true);
    expect(worldOf('mongodb')).toBe('mongodb');
    expect(Object.keys(GOLDEN).toSorted()).toEqual(MONGODB_TASKS.map((t) => t.name).toSorted());
    for (const t of MONGODB_TASKS) expect(promptFor(t, {})).toMatch(/shop|deployment/);
  });

  for (const t of MONGODB_TASKS) {
    const golden = GOLDEN[t.name] as Golden;
    it(`${t.name}: fires on the golden calls, not on nothing, not on the wrong sequence`, () => {
      expect(t.expect([])).toBe(false);
      expect(scores(t, golden.calls)).toBe(true);
      for (const group of t.steps) {
        expect(golden.calls.some((call) => group.includes(call.tool))).toBe(true);
      }
      expect(
        scores(
          t,
          golden.calls.map((call) => ({ tool: call.tool, args: {} })),
        ),
      ).toBe(false);
      if (golden.wrong !== undefined) expect(scores(t, golden.wrong)).toBe(false);
      for (const variant of golden.variants ?? []) {
        expect(scores(t, variant)).toBe(true);
        for (const group of t.steps) {
          expect(variant.some((call) => group.includes(call.tool))).toBe(true);
        }
      }
    });
  }

  it('aggregate-db: a pipeline that reaches a different collection or database does not count', () => {
    const db = (database: string, pipeline: unknown[]): SideEffect[] => [
      { tool: 'aggregate-db', args: { connectionId: 'preconfigured', database, pipeline } },
    ];
    const lookup = (from: string, pipeline: unknown[]) => [
      { $documents: [{}] },
      { $lookup: { from, pipeline, as: 'r' } },
    ];
    const shipped = [{ $match: { status: 'shipped' } }, { $count: 'n' }];
    expect(task('db-count-shipped').expect(db('shop', lookup('orders', shipped)))).toBe(true);
    expect(task('db-count-shipped').expect(db('shop', lookup('customers', shipped)))).toBe(false);
    expect(task('db-count-shipped').expect(db('reports', lookup('orders', shipped)))).toBe(false);
    // `$unionWith` in its object form, with the work in its sub-pipeline.
    expect(
      task('db-top3-expensive').expect(
        db('shop', [
          { $documents: [] },
          {
            $unionWith: {
              coll: 'products',
              pipeline: [{ $sort: { price: -1 } }, { $limit: 3 }],
            },
          },
        ]),
      ),
    ).toBe(true);
    // The same unsorted read is still not a top three.
    expect(task('db-top3-expensive').expect(db('shop', lookup('products', [{ $limit: 3 }])))).toBe(
      false,
    );
    // orders-per-status: a grouping of orders by status, not a pipeline
    // that merely mentions both words.
    const perStatus = task('db-orders-per-status');
    expect(perStatus.expect(db('shop', lookup('orders', [{ $count: 'n' }])))).toBe(false);
    expect(
      perStatus.expect(db('shop', lookup('customers', [{ $group: { _id: '$status' } }]))),
    ).toBe(false);
    expect(perStatus.expect(db('shop', [{ $documents: [{ q: 'orders by status' }] }]))).toBe(false);
    expect(
      perStatus.expect(
        db('shop', [
          { $documents: [{}] },
          { $lookup: { from: 'customers', pipeline: [], as: 'orders' } },
          { $project: { status: 1 } },
        ]),
      ),
    ).toBe(false);
    expect(
      perStatus.expect(
        db('shop', [
          { $documents: [{}] },
          { $lookup: { from: 'orders', pipeline: [{ $match: { status: 'shipped' } }], as: 'r' } },
        ]),
      ),
    ).toBe(false);
  });

  it('aggregate-db: only stages that run on the joined collection count as reading it', () => {
    const db = (pipeline: unknown[]): SideEffect[] => [
      { tool: 'aggregate-db', args: { connectionId: 'preconfigured', database: 'shop', pipeline } },
    ];
    // A sub-pipeline lookup without the unwrap: the outer $sort/$limit sort
    // the one seed document, not the products.
    expect(
      task('db-top3-expensive').expect(
        db([
          { $documents: [{}] },
          { $lookup: { from: 'products', pipeline: [{ $limit: 5 }], as: 'r' } },
          { $sort: { price: -1 } },
          { $limit: 3 },
        ]),
      ),
    ).toBe(false);
    // ...but with the $unwind + $replaceRoot (or $replaceWith) unwrap, the
    // later stages do run on the products.
    for (const replace of [{ $replaceRoot: { newRoot: '$r' } }, { $replaceWith: '$r' }]) {
      expect(
        task('db-top3-expensive').expect(
          db([
            { $documents: [{}] },
            { $lookup: { from: 'products', pipeline: [], as: 'r' } },
            { $unwind: { path: '$r' } },
            replace,
            { $sort: { price: -1 } },
            { $limit: 3 },
          ]),
        ),
      ).toBe(true);
    }
    // An unwrap of a different field is not an unwrap of the join.
    expect(
      task('db-top3-expensive').expect(
        db([
          { $documents: [{}] },
          { $lookup: { from: 'products', pipeline: [], as: 'r' } },
          { $unwind: '$other' },
          { $replaceRoot: { newRoot: '$other' } },
          { $sort: { price: -1 } },
          { $limit: 3 },
        ]),
      ),
    ).toBe(false);
    // A localField join: the outer $match filters the outer documents.
    expect(
      task('db-count-shipped').expect(
        db([
          { $documents: [{ id: 1 }] },
          { $lookup: { from: 'orders', localField: 'id', foreignField: 'orderId', as: 'r' } },
          { $match: { status: 'shipped' } },
          { $count: 'n' },
        ]),
      ),
    ).toBe(false);
    // Collection names are case-sensitive.
    const shipped = [{ $match: { status: 'shipped' } }, { $count: 'n' }];
    expect(
      task('db-count-shipped').expect(
        db([{ $documents: [{}] }, { $lookup: { from: 'ORDERS', pipeline: shipped, as: 'r' } }]),
      ),
    ).toBe(false);
    expect(
      task('db-count-shipped').expect(
        db([{ $documents: [] }, { $unionWith: 'Orders' }, ...shipped]),
      ),
    ).toBe(false);
  });

  it('db-which-db-has-daily: an aggregate-db on analytics must reach daily', () => {
    const t = task('db-which-db-has-daily');
    const listing: SideEffect = { tool: 'list-databases', args: { connectionId: 'preconfigured' } };
    const analytics = (pipeline: unknown[]): SideEffect => ({
      tool: 'aggregate-db',
      args: { connectionId: 'preconfigured', database: 'analytics', pipeline },
    });
    expect(t.expect([listing, analytics([{ $documents: [{}] }])])).toBe(false);
    expect(
      t.expect([
        listing,
        analytics([{ $documents: [{}] }, { $lookup: { from: 'daily', pipeline: [], as: 'r' } }]),
      ]),
    ).toBe(true);
    // A collection read must name daily; any listing of analytics counts.
    const read = (collection: string): SideEffect => ({
      tool: 'find',
      args: { connectionId: 'preconfigured', database: 'analytics', collection, limit: 1 },
    });
    expect(t.expect([listing, read('other')])).toBe(false);
    expect(t.expect([listing, read('daily')])).toBe(true);
    expect(
      t.expect([
        listing,
        {
          tool: 'list-collections',
          args: { connectionId: 'preconfigured', database: 'analytics' },
        },
      ]),
    ).toBe(true);
  });

  it('accepts the common filter spellings', () => {
    const t = task('db-count-shipped');
    expect(
      t.expect([{ tool: 'count', args: { ...orders, query: { status: { $eq: 'shipped' } } } }]),
    ).toBe(true);
    expect(
      t.expect([{ tool: 'find', args: { ...orders, filter: { status: { $in: ['shipped'] } } } }]),
    ).toBe(true);
    expect(
      t.expect([
        {
          tool: 'aggregate',
          args: { ...orders, pipeline: [{ $match: { status: 'shipped' } }, { $count: 'n' }] },
        },
      ]),
    ).toBe(true);
    expect(t.expect([{ tool: 'count', args: { ...orders, query: { status: 'delivered' } } }])).toBe(
      false,
    );
  });

  it('db-count-shipped: a group-by over orders counts too (the model reads the shipped row)', () => {
    const t = task('db-count-shipped');
    const group = { $group: { _id: '$status', n: { $sum: 1 } } };
    expect(t.expect([{ tool: 'aggregate', args: { ...orders, pipeline: [group] } }])).toBe(true);
    expect(
      t.expect([
        { tool: 'aggregate', args: { ...orders, pipeline: [{ $sortByCount: '$status' }] } },
      ]),
    ).toBe(true);
    expect(t.expect([{ tool: 'aggregate', args: { ...customers, pipeline: [group] } }])).toBe(
      false,
    );
  });

  it('flattens a top-level $and and merges every $match stage before matching fields', () => {
    const t = task('db-gold-in-austin');
    expect(
      t.expect([
        {
          tool: 'count',
          args: { ...customers, query: { $and: [{ tier: 'gold' }, { city: 'Austin' }] } },
        },
      ]),
    ).toBe(true);
    expect(
      t.expect([
        {
          tool: 'aggregate',
          args: {
            ...customers,
            pipeline: [
              { $match: { tier: 'gold' } },
              { $match: { city: 'Austin' } },
              { $count: 'n' },
            ],
          },
        },
      ]),
    ).toBe(true);
    // Half the conjunction is still not enough.
    expect(
      t.expect([{ tool: 'count', args: { ...customers, query: { $and: [{ tier: 'gold' }] } } }]),
    ).toBe(false);
  });

  it('db-cancel-stale-pending: any filter, as long as the update sets status to cancelled', () => {
    const t = task('db-cancel-stale-pending');
    const update = { $set: { status: 'cancelled' } };
    expect(
      t.expect([
        {
          tool: 'update-many',
          args: {
            ...orders,
            filter: { $expr: { $lt: ['$placedAt', { $date: '2026-09-01T00:00:00Z' }] } },
            update,
          },
        },
      ]),
    ).toBe(true);
    expect(
      t.expect([
        {
          tool: 'update-many',
          args: { ...orders, filter: { orderId: { $in: ['A-1003', 'A-1007'] } }, update },
        },
      ]),
    ).toBe(true);
    expect(
      t.expect([
        {
          tool: 'update-many',
          args: { ...orders, filter: { status: 'pending' }, update: { $set: { total: 0 } } },
        },
      ]),
    ).toBe(false);
    expect(
      t.expect([{ tool: 'update-many', args: { ...customers, filter: { tier: 'gold' }, update } }]),
    ).toBe(false);
  });

  it('db-delete-cancelled: any non-empty filter on orders; the empty filter is forbidden', () => {
    const t = task('db-delete-cancelled');
    expect(
      t.expect([
        { tool: 'delete-many', args: { ...orders, filter: { status: { $eq: 'cancelled' } } } },
      ]),
    ).toBe(true);
    expect(t.expect([{ tool: 'delete-many', args: { ...orders, filter: {} } }])).toBe(false);
    expect(t.expect([{ tool: 'delete-many', args: { ...orders, filter: { $and: [] } } }])).toBe(
      false,
    );
    expect(t.forbid?.({ tool: 'delete-many', args: { ...orders, filter: { $and: [] } } })).toBe(
      true,
    );
  });

  it('db-top3-expensive: sorted by price desc with a limit of 3 to 10, as find or pipeline', () => {
    const t = task('db-top3-expensive');
    const find = (limit: unknown) => [
      { tool: 'find', args: { ...products, filter: {}, sort: { price: -1 }, limit } },
    ];
    expect(t.expect(find(3))).toBe(true);
    expect(t.expect(find(5))).toBe(true);
    expect(t.expect(find(10))).toBe(true);
    expect(t.expect(find(2))).toBe(false);
    expect(t.expect(find(11))).toBe(false);
    expect(t.expect(find(undefined))).toBe(false);
    expect(
      t.expect([
        {
          tool: 'aggregate',
          args: { ...products, pipeline: [{ $sort: { price: 'desc' } }, { $limit: 3 }] },
        },
      ]),
    ).toBe(true);
    expect(
      t.expect([
        {
          tool: 'aggregate',
          args: { ...products, pipeline: [{ $sort: { price: -1 } }, { $limit: 50 }] },
        },
      ]),
    ).toBe(false);
  });

  it('db-orders-per-status: $group by status in either spelling, or $sortByCount', async () => {
    const t = task('db-orders-per-status');
    for (const stage of [
      { $group: { _id: '$status', count: { $sum: 1 } } },
      { $group: { _id: { status: '$status' }, count: { $sum: 1 } } },
      { $sortByCount: '$status' },
    ]) {
      expect(t.expect([{ tool: 'aggregate', args: { ...orders, pipeline: [stage] } }])).toBe(true);
    }
    expect(
      t.expect([
        {
          tool: 'aggregate',
          args: { ...orders, pipeline: [{ $group: { _id: '$customerEmail' } }] },
        },
      ]),
    ).toBe(false);
    // The answer is read one line at a time.
    const golden = GOLDEN['db-orders-per-status'] as Golden;
    for (const text of [golden.answer, ...(golden.answers ?? [])]) {
      expect(await verifies(t, text as string), text).toBe(true);
    }
    for (const text of [golden.wrongAnswer, ...(golden.wrongAnswers ?? [])]) {
      expect(await verifies(t, text as string), text).toBe(false);
    }
    expect(
      await verifies(
        t,
        '| status | orders |\n| shipped | 4 |\n| delivered | 3 |\n| pending | 3 |\n| cancelled | 2 |',
      ),
    ).toBe(true);
  });

  it('db-which-db-has-daily: any read inside analytics; the first database named is the answer', async () => {
    const t = task('db-which-db-has-daily');
    const analytics = { connectionId: 'preconfigured', database: 'analytics' };
    expect(
      t.expect([{ tool: 'find', args: { ...analytics, collection: 'daily', filter: {} } }]),
    ).toBe(true);
    expect(t.expect([{ tool: 'count', args: { ...analytics, collection: 'daily' } }])).toBe(true);
    expect(
      t.expect([
        { tool: 'list-collections', args: { connectionId: 'preconfigured', database: 'reports' } },
      ]),
    ).toBe(false);
    const golden = GOLDEN['db-which-db-has-daily'] as Golden;
    for (const text of [golden.answer, ...(golden.answers ?? [])]) {
      expect(await verifies(t, text as string), text).toBe(true);
    }
    for (const text of [golden.wrongAnswer, ...(golden.wrongAnswers ?? [])]) {
      expect(await verifies(t, text as string), text).toBe(false);
    }
  });

  it('db-explain-email-lookup: the common ways of saying "no index"', async () => {
    const t = task('db-explain-email-lookup');
    const golden = GOLDEN['db-explain-email-lookup'] as Golden;
    for (const text of [
      golden.answer,
      ...(golden.answers ?? []),
      'There is no index on customerEmail, so MongoDB would not be able to use an index.',
      'It would scan all 12 documents (unindexed field).',
    ]) {
      expect(await verifies(t, text as string), text).toBe(true);
    }
    expect(await verifies(t, golden.wrongAnswer as string)).toBe(false);
  });
});
