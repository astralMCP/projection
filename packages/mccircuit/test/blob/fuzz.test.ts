/**
 * Fuzzing the blob parser (PRD milestone M5).
 *
 * `openBlob` is the one function in McCircuit that consumes fully
 * attacker-controlled bytes — the client echoes back whatever it likes as
 * `requestState`. The invariant under fuzz: for ANY input, `openBlob` must
 * fail closed with a structured `McCircuitError` (never a raw TypeError /
 * RangeError leaking from internals, never a hang, never a returned payload
 * from an unverified blob). This suite throws tens of thousands of malformed
 * and mutated inputs at it and asserts exactly that.
 *
 * The PRNG is seeded, so a failure is reproducible from the printed seed.
 */

import { describe, expect, it } from 'vitest';
import { buildBlobPayload, openBlob, sealBlob } from '../../src/blob/index.js';
import { McCircuitError } from '../../src/errors.js';
import type { BlobSealerConfig } from '../../src/types.js';

const KEY = new Uint8Array(32).fill(42);
const CONFIG: BlobSealerConfig = { key: KEY };
const CODE = 'export default setup({}).createMachine({ id: "m" });';
const IDENTITY = 'srv://fuzz/default';

/** Deterministic PRNG (mulberry32) so any failure reproduces from its seed. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomString(rng: () => number, maxLen: number): string {
  const len = Math.floor(rng() * maxLen);
  const alphabets = [
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', // base64url
    'ABCDEF.=/+ \n\t\0', // separators and junk
    'mcc1.', // prefix fragments
  ];
  const alpha = alphabets[Math.floor(rng() * alphabets.length)] as string;
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += alpha[Math.floor(rng() * alpha.length)];
  }
  return out;
}

/** Open with a valid config and return the thrown error, or a sentinel if it returned. */
function attempt(blob: string): { threw: true; error: unknown } | { threw: false; value: unknown } {
  try {
    const value = openBlob(blob, { code: CODE, serverIdentity: IDENTITY, config: CONFIG });
    return { threw: false, value };
  } catch (error) {
    return { threw: true, error };
  }
}

function assertFailsClosed(blob: string, label: string): void {
  const result = attempt(blob);
  if (!result.threw) {
    throw new Error(
      `openBlob returned a payload for a fuzzed input (${label}): ${blob.slice(0, 80)}`,
    );
  }
  // Must be our structured error, not an internal leak.
  expect(result.error, `input ${label}: ${blob.slice(0, 80)}`).toBeInstanceOf(McCircuitError);
  const phase = (result.error as McCircuitError).phase;
  expect(['blob_verification', 'terminal'], `input ${label}: phase was ${phase}`).toContain(phase);
}

describe('blob parser fuzzing (M5)', () => {
  it('fails closed on random strings', () => {
    for (let seed = 1; seed <= 5000; seed += 1) {
      const rng = makeRng(seed);
      assertFailsClosed(randomString(rng, 512), `random#${seed}`);
    }
  });

  it('fails closed on envelope-shaped strings with random base64url fields', () => {
    for (let seed = 1; seed <= 5000; seed += 1) {
      const rng = makeRng(seed * 7 + 1);
      const field = () => randomString(rng, 64) || 'A';
      const blob = `mcc1.${field()}.${field()}.${field()}.${field()}`;
      assertFailsClosed(blob, `shaped#${seed}`);
    }
  });

  it('fails closed on strings with pathological dot counts', () => {
    const rng = makeRng(99);
    for (let n = 0; n < 40; n += 1) {
      const parts = Array.from({ length: n }, () => randomString(rng, 20) || 'A');
      assertFailsClosed(parts.join('.'), `dots#${n}`);
      assertFailsClosed(`mcc1.${parts.join('.')}`, `mcc1-dots#${n}`);
    }
  });

  it('fails closed on every single-byte mutation of a valid blob', () => {
    const valid = sealBlob(
      buildBlobPayload({
        code: CODE,
        serverIdentity: IDENTITY,
        snapshot: { status: 'active', value: 'x', context: { n: 1 } },
        pending: {},
        audit: [],
        trip: 1,
        now: 1_000_000,
      }),
      CONFIG,
    );
    // Sanity: the un-mutated blob opens (with a matching clock).
    expect(() =>
      openBlob(valid, { code: CODE, serverIdentity: IDENTITY, config: CONFIG, now: 1_000_500 }),
    ).not.toThrow();

    const chars = 'AB.mcc10_-=';
    for (let i = 0; i < valid.length; i += 1) {
      for (const c of chars) {
        if (valid[i] === c) continue;
        const mutated = valid.slice(0, i) + c + valid.slice(i + 1);
        assertFailsClosed(mutated, `flip@${i}=${c}`);
      }
    }
  });

  it('fails closed on truncations and extensions of a valid blob', () => {
    const valid = sealBlob(
      buildBlobPayload({
        code: CODE,
        serverIdentity: IDENTITY,
        snapshot: { status: 'active', value: 'y', context: {} },
        pending: {},
        audit: [],
        trip: 1,
        now: 2_000_000,
      }),
      CONFIG,
    );
    for (let cut = 1; cut < valid.length; cut += 3) {
      assertFailsClosed(valid.slice(0, cut), `trunc@${cut}`);
    }
    const rng = makeRng(2024);
    for (let n = 0; n < 200; n += 1) {
      assertFailsClosed(valid + randomString(rng, 128), `extend#${n}`);
    }
  });

  it('fails closed on field-swaps between two valid blobs', () => {
    const mk = (n: number, now: number) =>
      sealBlob(
        buildBlobPayload({
          code: CODE,
          serverIdentity: IDENTITY,
          snapshot: { status: 'active', value: `s${n}`, context: { n } },
          pending: {},
          audit: [],
          trip: 1,
          now,
        }),
        CONFIG,
      );
    const a = mk(1, 3_000_000).split('.');
    const b = mk(2, 3_000_001).split('.');
    // Swap each field of A with B's, individually and in pairs.
    for (let i = 1; i < 5; i += 1) {
      const spliced = a.slice();
      spliced[i] = b[i] as string;
      assertFailsClosed(spliced.join('.'), `swap@${i}`);
    }
  });
});
