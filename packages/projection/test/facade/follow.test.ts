/**
 * The tools/list_changed scheduler (R65, DECISIONS D43) with fake re-listing
 * hooks: each box has its own re-listing in flight and is applied as soon
 * as it lands, and a refreshTools() waiter is answered by the first
 * re-listing that started after it, never starved by later notifications.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { distrustOverrides, ListChangeTracker } from '../../src/facade/follow.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let cleanup: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

function tracker(aliases: string[], relist: (alias: string, call: number) => Promise<string>) {
  const applied: string[] = [];
  const calls = new Map<string, number>();
  const t = new ListChangeTracker<string>(
    aliases,
    { follow: true, debounceMs: 0, minIntervalMs: 100 },
    {
      relist: (alias) => {
        const call = (calls.get(alias) ?? 0) + 1;
        calls.set(alias, call);
        return relist(alias, call);
      },
      apply: (results) => {
        for (const alias of results.keys()) applied.push(alias);
      },
      distrust: () => undefined,
    },
  );
  cleanup.push(() => t.close());
  return { t, applied };
}

/** Notify `alias` every `ms` until the test ends. */
function storm(t: ListChangeTracker<string>, alias: string, ms: number): void {
  const timer = setInterval(() => t.notify(alias), ms);
  cleanup.push(() => clearInterval(timer));
}

describe('ListChangeTracker scheduling (R65)', () => {
  it('a slow box that keeps notifying never holds a fast box back', async () => {
    const { t, applied } = tracker(['slow', 'fast'], (alias) =>
      sleep(alias === 'slow' ? 1_500 : 1).then(() => alias),
    );
    t.notify('slow');
    storm(t, 'slow', 50);
    const started = Date.now();
    await t.refresh('fast');
    expect(Date.now() - started).toBeLessThan(700);
    expect(applied).toEqual(['fast']);
    expect(t.trusted().has('fast')).toBe(true);
    expect(t.trusted().has('slow')).toBe(false);
  });

  it('refresh resolves even while notifications keep overtaking the re-listings', async () => {
    const { t, applied } = tracker(['box'], () => sleep(50).then(() => 'box'));
    storm(t, 'box', 10);
    await t.refresh('box');
    expect(applied.length).toBeGreaterThan(0);
  });

  it('a refresh is not rejected by a re-listing that started before it', async () => {
    const { t } = tracker(['box'], (_alias, call) =>
      call === 1
        ? sleep(50).then(() => Promise.reject(new Error('first walk failed')))
        : sleep(1).then(() => 'box'),
    );
    t.notify('box');
    await sleep(20);
    // The first re-listing is in flight; it fails, and the refresh waits
    // for the retry that started after it.
    await expect(t.refresh('box')).resolves.toBeUndefined();
  });

  it('a refresh is rejected by the failure of a re-listing that started after it', async () => {
    const { t } = tracker(['box'], () => sleep(1).then(() => Promise.reject(new Error('down'))));
    await expect(t.refresh('box')).rejects.toThrow('down');
  });

  it('nothing applies after close', async () => {
    const { t, applied } = tracker(['box'], () => sleep(30).then(() => 'box'));
    t.notify('box');
    await sleep(10);
    t.close();
    await sleep(50);
    expect(applied).toEqual([]);
  });
});

describe('distrustOverrides (R65.5)', () => {
  it('keeps exact entries and tightening rule outcomes; drops rule auto', () => {
    const kept = distrustOverrides(
      { exact_auto: 'auto', rule_auto: 'auto', rule_ask: 'ask', rule_deny: 'deny' },
      { exact_auto: 'auto' },
      () => true,
    );
    expect(kept).toEqual({ exact_auto: 'auto', rule_ask: 'ask', rule_deny: 'deny' });
  });

  it('leaves names outside the dirty boxes alone', () => {
    expect(
      distrustOverrides({ 'a.x': 'auto' }, undefined, (name) => name.startsWith('b.')),
    ).toEqual({ 'a.x': 'auto' });
  });
});
