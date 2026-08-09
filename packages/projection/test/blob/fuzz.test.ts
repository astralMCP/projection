/**
 * Fuzzing the blob parser (PRD milestone M5).
 *
 * `openBlob` is the one function in Projection that consumes fully
 * attacker-controlled bytes — the client echoes back whatever it likes as
 * `requestState`. The invariant under fuzz: for ANY input, `openBlob` must
 * fail closed with a structured `ProjectionError` (never a raw TypeError /
 * RangeError leaking from internals, never a hang, never a returned payload
 * from an unverified blob).
 *
 * Coverage is deliberately split, because AEAD makes the layers reachable in
 * two different ways:
 *
 * - Random / mutated / truncated inputs (no valid key) exercise the size
 *   guard and the parse + GCM-authentication layers — anything an attacker
 *   without the key can produce. These cannot reach the post-decryption
 *   semantic checks, because those only run after the tag verifies.
 * - To fuzz the semantic layer (version, expiry, codeHash, serverIdentity,
 *   payload shape), the "broken payload, valid key" suite seals genuinely
 *   authenticated blobs whose plaintext is deliberately wrong — modelling a
 *   snapshot minted by an incompatible library version, an expired blob, or
 *   a resume against different code/server.
 *
 * The PRNG is seeded, so a failure is reproducible from the printed seed.
 */

import { describe, expect, it } from 'vitest';
import { buildBlobPayload, openBlob, sealBlob } from '../../src/blob/index.js';
import { ProjectionError } from '../../src/errors.js';
import type { BlobPayload, BlobSealerConfig, PendingToolCall } from '../../src/types.js';

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
    'proj1.', // prefix fragments
  ];
  const alpha = alphabets[Math.floor(rng() * alphabets.length)] as string;
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += alpha[Math.floor(rng() * alpha.length)];
  }
  return out;
}

/**
 * Open with a valid config and return the thrown error, or a sentinel if it
 * returned. `now` is passed explicitly so results never depend on wall clock.
 */
function attempt(
  blob: string,
  now: number,
): { threw: true; error: unknown } | { threw: false; value: unknown } {
  try {
    const value = openBlob(blob, { code: CODE, serverIdentity: IDENTITY, config: CONFIG, now });
    return { threw: false, value };
  } catch (error) {
    return { threw: true, error };
  }
}

/** A clock far past any fuzzed blob's expiry — for inputs that should never open. */
const EXPIRED_NOW = 10_000_000_000;

function assertFailsClosed(blob: string, label: string): void {
  const result = attempt(blob, EXPIRED_NOW);
  if (!result.threw) {
    throw new Error(
      `openBlob returned a payload for a fuzzed input (${label}): ${blob.slice(0, 80)}`,
    );
  }
  // Must be our structured error, not an internal leak.
  expect(result.error, `input ${label}: ${blob.slice(0, 80)}`).toBeInstanceOf(ProjectionError);
  const phase = (result.error as ProjectionError).phase;
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
      const blob = `proj1.${field()}.${field()}.${field()}.${field()}`;
      assertFailsClosed(blob, `shaped#${seed}`);
    }
  });

  it('fails closed on strings with pathological dot counts', () => {
    const rng = makeRng(99);
    for (let n = 0; n < 40; n += 1) {
      const parts = Array.from({ length: n }, () => randomString(rng, 20) || 'A');
      assertFailsClosed(parts.join('.'), `dots#${n}`);
      assertFailsClosed(`proj1.${parts.join('.')}`, `proj1-dots#${n}`);
    }
  });

  it('no single-byte mutation produces a different valid payload', () => {
    const sealedAt = 1_000_000;
    const openAt = 1_000_500; // inside the TTL, so expiry never masks a result
    const payload = buildBlobPayload({
      code: CODE,
      serverIdentity: IDENTITY,
      snapshot: { status: 'active', value: 'x', context: { n: 1 } },
      pending: {},
      audit: [],
      trip: 1,
      now: sealedAt,
    });
    const valid = sealBlob(payload, CONFIG);
    const original = openBlob(valid, {
      code: CODE,
      serverIdentity: IDENTITY,
      config: CONFIG,
      now: openAt,
    });

    // The honest invariant: a one-byte change either fails closed, or — for
    // base64url's low-bit aliasing, where a different char decodes to the
    // same bytes — re-opens the SAME payload. It can never yield a DIFFERENT
    // valid payload or a raw crash. Opened inside the TTL so nothing here
    // leans on wall-clock expiry.
    const chars = 'AB.proj10_-=';
    for (let i = 0; i < valid.length; i += 1) {
      for (const c of chars) {
        if (valid[i] === c) continue;
        const mutated = valid.slice(0, i) + c + valid.slice(i + 1);
        const result = attempt(mutated, openAt);
        if (result.threw) {
          expect(result.error, `flip@${i}=${c}`).toBeInstanceOf(ProjectionError);
          const phase = (result.error as ProjectionError).phase;
          expect(['blob_verification', 'terminal'], `flip@${i}=${c}`).toContain(phase);
        } else {
          expect(result.value, `flip@${i}=${c} opened a different payload`).toEqual(original);
        }
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

  it('rejects an oversized input fast, before any crypto work (size guard)', () => {
    // Feed inputs far past the acceptance limit and confirm they are rejected
    // quickly — the guard runs before base64/AES, so this cannot hang.
    for (const megabytes of [1, 4, 16]) {
      const huge = 'proj1.' + 'A'.repeat(megabytes * 1024 * 1024);
      const started = performance.now();
      assertFailsClosed(huge, `oversized-${megabytes}MB`);
      expect(performance.now() - started, `${megabytes}MB took too long`).toBeLessThan(100);
    }
  });
});

/**
 * The semantic layer only runs after GCM authenticates, so it is unreachable
 * from an attacker without the key. To fuzz it we seal genuinely
 * authenticated blobs whose plaintext is deliberately wrong — the honest way
 * these branches fire in production (an incompatible library version, an
 * expired blob, a resume against different code or a different server).
 */
describe('blob semantic-layer fuzzing (valid key, broken payload)', () => {
  const OPEN_NOW = 5_000_000;

  function sealRaw(overrides: Partial<BlobPayload>): string {
    const base = buildBlobPayload({
      code: CODE,
      serverIdentity: IDENTITY,
      snapshot: { status: 'active', value: 'x', context: {} },
      pending: {},
      audit: [],
      trip: 1,
      now: OPEN_NOW - 1000,
    });
    return sealBlob({ ...base, ...overrides } as BlobPayload, CONFIG);
  }

  function assertSemanticReject(blob: string, label: string): void {
    const result = attempt(blob, OPEN_NOW);
    expect(result.threw, `${label} should have failed`).toBe(true);
    if (!result.threw) return;
    expect(result.error, label).toBeInstanceOf(ProjectionError);
    expect(['blob_verification', 'terminal'], label).toContain(
      (result.error as ProjectionError).phase,
    );
  }

  it('rejects an unknown schema version', () => {
    assertSemanticReject(sealRaw({ v: 999 }), 'bad v');
    assertSemanticReject(sealRaw({ v: 'x' as unknown as number }), 'string v');
  });

  it('rejects mismatched library / XState versions (no snapshot migration)', () => {
    assertSemanticReject(sealRaw({ libv: '0.0.0-other' }), 'bad libv');
    assertSemanticReject(sealRaw({ xstatev: '4.0.0' }), 'bad xstatev');
  });

  it('rejects an expired blob', () => {
    assertSemanticReject(sealRaw({ exp: OPEN_NOW - 1 }), 'expired');
  });

  it('rejects a resume whose codeHash does not match the re-sent code (S4)', () => {
    assertSemanticReject(sealRaw({ codeHash: 'deadbeef'.repeat(8) }), 'bad codeHash');
  });

  it('rejects a blob minted against a different wrapped server (R30)', () => {
    assertSemanticReject(sealRaw({ serverIdentity: 'srv://other/default' }), 'wrong server');
  });

  it('rejects structurally malformed pending / audit', () => {
    assertSemanticReject(
      sealRaw({ pending: { k: { id: 'k' } as unknown as PendingToolCall } }),
      'pending missing fields',
    );
    assertSemanticReject(
      sealRaw({ audit: 'not-an-array' as unknown as BlobPayload['audit'] }),
      'audit not array',
    );
    assertSemanticReject(sealRaw({ trip: 'x' as unknown as number }), 'trip not a number');
  });

  it('still opens a correctly-sealed blob (the good path is not over-rejected)', () => {
    const good = sealRaw({});
    const result = attempt(good, OPEN_NOW);
    expect(result.threw).toBe(false);
  });
});
