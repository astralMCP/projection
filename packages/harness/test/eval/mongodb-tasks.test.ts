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
    });
  }

  it('accepts the common filter spellings', () => {
    const task = MONGODB_TASKS.find((t) => t.name === 'db-count-shipped') as EvalTask;
    const base = { connectionId: 'preconfigured', database: 'shop', collection: 'orders' };
    expect(
      task.expect([{ tool: 'count', args: { ...base, query: { status: { $eq: 'shipped' } } } }]),
    ).toBe(true);
    expect(
      task.expect([{ tool: 'find', args: { ...base, filter: { status: { $in: ['shipped'] } } } }]),
    ).toBe(true);
    expect(
      task.expect([
        {
          tool: 'aggregate',
          args: { ...base, pipeline: [{ $match: { status: 'shipped' } }, { $count: 'n' }] },
        },
      ]),
    ).toBe(true);
    expect(
      task.expect([{ tool: 'count', args: { ...base, query: { status: 'delivered' } } }]),
    ).toBe(false);
  });
});
