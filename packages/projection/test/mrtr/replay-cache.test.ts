/**
 * The process-local replay cache (R38, DECISIONS D42): replay detection,
 * the atomic test-and-set under concurrent calls, expiry sweeps, the
 * refusal of nonces at or before a swept `exp` after a clock step, and the
 * cap that refuses rather than evicting a live nonce.
 */

import { describe, expect, it } from 'vitest';
import { ProjectionError } from '../../src/errors.js';
import { DEFAULT_REPLAY_CACHE_MAX_ENTRIES, MemoryReplayCache } from '../../src/index.js';

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

async function expectClockRefusal(p: Promise<boolean>): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProjectionError);
  expect((err as ProjectionError).phase).toBe('blob_verification');
  expect((err as ProjectionError).message).toContain('server clock changed');
  expect((err as ProjectionError).message).not.toContain('replayed');
}

async function expectCapRefusal(p: Promise<boolean>): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProjectionError);
  expect((err as ProjectionError).phase).toBe('cap_exceeded');
}

describe('MemoryReplayCache (R38, D42)', () => {
  it('records a nonce on first sight and reports every later sight as a replay', async () => {
    const c = clock();
    const cache = new MemoryReplayCache({ now: c.now });
    const exp = c.now() + 60_000;
    expect(await cache.seen('n1', exp)).toBe(false);
    expect(await cache.seen('n1', exp)).toBe(true);
    expect(await cache.seen('n1', exp)).toBe(true);
    expect(await cache.seen('n2', exp)).toBe(false);
  });

  it('tests and sets synchronously: of two concurrent calls exactly one is first', async () => {
    const cache = new MemoryReplayCache();
    const exp = Date.now() + 60_000;
    const results = await Promise.all([cache.seen('n', exp), cache.seen('n', exp)]);
    expect(results.sort()).toEqual([false, true]);
    const many = await Promise.all(Array.from({ length: 50 }, () => cache.seen('m', exp)));
    expect(many.filter((r) => !r)).toHaveLength(1);
  });

  it('keeps a nonce until its exp and refuses it at or after exp', async () => {
    const c = clock();
    const cache = new MemoryReplayCache({ now: c.now });
    const exp = c.now() + 5_000;
    expect(await cache.seen('n', exp)).toBe(false);
    c.advance(4_999);
    expect(await cache.seen('n', exp)).toBe(true);
    c.advance(1);
    expect(await cache.seen('n', exp)).toBe(true);
    // Swept once a sweep runs, and still refused. (The sealer refuses
    // now >= exp first, so only a clock step brings it back here.)
    c.advance(1_000);
    await expectClockRefusal(cache.seen('n', exp));
    expect(cache.size).toBe(0);
  });

  it('sweeps expired nonces so memory is bounded by the live window', async () => {
    const c = clock();
    const cache = new MemoryReplayCache({ now: c.now });
    for (let i = 0; i < 100; i++) expect(await cache.seen(`old${i}`, c.now() + 1_000)).toBe(false);
    expect(cache.size).toBe(100);
    c.advance(2_000);
    expect(await cache.seen('fresh', c.now() + 1_000)).toBe(false);
    expect(cache.size).toBe(1);
  });

  it('refuses a nonce whose exp is at or before one already swept, even if the clock steps back', async () => {
    const c = clock();
    const cache = new MemoryReplayCache({ now: c.now });
    const exp = c.now() + 1_000;
    expect(await cache.seen('a', exp)).toBe(false);
    c.advance(2_000);
    expect(await cache.seen('b', c.now() + 1_000)).toBe(false); // sweeps 'a'
    c.advance(-10_000);
    await expectClockRefusal(cache.seen('a', exp));
    // A fresh nonce cannot be checked either: refused, not called a replay.
    await expectClockRefusal(cache.seen('c', c.now() + 1_000));
    await expectClockRefusal(cache.seen('c', c.now() + 1_000)); // not recorded
    // A nonce still held is a replay; one past the swept exp is accepted.
    expect(await cache.seen('b', 0)).toBe(true);
    expect(await cache.seen('d', exp + 1)).toBe(false);
  });

  it('refuses a fresh nonce after the clock steps forward and back', async () => {
    const c = clock();
    const cache = new MemoryReplayCache({ now: c.now });
    expect(await cache.seen('a', c.now() + 60_000)).toBe(false);
    c.advance(3_600_000);
    expect(await cache.seen('b', c.now() + 60_000)).toBe(false); // sweeps 'a'
    c.advance(-3_599_000);
    await expectClockRefusal(cache.seen('c', c.now() + 30_000));
    // A nonce expiring after the swept one passes.
    expect(await cache.seen('c', c.now() + 60_000)).toBe(false);
  });

  it('when full, refuses new nonces rather than evicting a live one', async () => {
    const c = clock();
    const cache = new MemoryReplayCache({ now: c.now, maxEntries: 2 });
    const exp = c.now() + 60_000;
    expect(await cache.seen('a', exp)).toBe(false);
    expect(await cache.seen('b', exp)).toBe(false);
    const err = await cache.seen('c', exp).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectionError);
    expect((err as ProjectionError).phase).toBe('cap_exceeded');
    // The live nonces are still remembered.
    expect(await cache.seen('a', exp)).toBe(true);
    expect(await cache.seen('b', exp)).toBe(true);
    expect(cache.size).toBe(2);
    // Room frees only when entries expire; the refused nonce was not recorded.
    c.advance(60_000);
    expect(await cache.seen('c', c.now() + 60_000)).toBe(false);
  });

  it('when full, sweeps at most once a second, then accepts once entries expire', async () => {
    const c = clock();
    const cache = new MemoryReplayCache({ now: c.now, maxEntries: 2 });
    expect(await cache.seen('a', c.now() + 500)).toBe(false); // sweeps (none due)
    expect(await cache.seen('b', c.now() + 500)).toBe(false);
    await expectCapRefusal(cache.seen('c', c.now() + 60_000));
    // Past both exps but inside the sweep window: still full, still refused.
    c.advance(600);
    await expectCapRefusal(cache.seen('c', c.now() + 60_000));
    expect(cache.size).toBe(2);
    c.advance(400);
    expect(await cache.seen('c', c.now() + 60_000)).toBe(false);
    expect(cache.size).toBe(1);
  });

  it('rejects an invalid exp or maxEntries', async () => {
    const cache = new MemoryReplayCache();
    await expect(cache.seen('n', Number.NaN)).rejects.toBeInstanceOf(ProjectionError);
    expect(() => new MemoryReplayCache({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => new MemoryReplayCache({ maxEntries: 1.5 })).toThrow(RangeError);
    expect(DEFAULT_REPLAY_CACHE_MAX_ENTRIES).toBe(100_000);
  });
});
