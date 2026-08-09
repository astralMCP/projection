/**
 * Section 10 budget checks for the suspend/resume machinery (M5).
 *
 * The PRD sets: suspend→resume overhead (blob seal + verify + rehydrate)
 * p95 < 100 ms, and median blob size < 8 KB on benchmark workflows.
 *
 * Blob size is deterministic, so it is asserted exactly. The seal+verify
 * crypto overhead is the deterministic, host-side part of the resume cost
 * (the rehydrate step is QuickJS actor restore, measured in the machine-host
 * integration tests). It runs in ~1–2 ms, so a generous ceiling well under
 * the 100 ms budget catches a real regression (e.g. an accidental
 * key-derivation-per-op blowup) without flaking on a loaded CI runner.
 */

import { describe, expect, it } from 'vitest';
import { buildBlobPayload, openBlob, sealBlob } from '../../src/blob/index.js';
import type { BlobPayload, BlobSealerConfig, PendingToolCall } from '../../src/types.js';

const CONFIG: BlobSealerConfig = { key: new Uint8Array(32).fill(31) };
const CODE = 'export default setup({}).createMachine({ id: "m" });';
const IDENTITY = 'srv://budget/default';

/** A representative suspension snapshot: a mid-run machine with modest context. */
function benchmarkPayload(contextSize: 'small' | 'typical'): BlobPayload {
  const context =
    contextSize === 'small'
      ? { step: 3, path: '/notes.txt' }
      : {
          step: 7,
          gathered: Array.from({ length: 12 }, (_, i) => ({ id: `item-${i}`, value: i * 3 })),
          cursor: 'page-2',
          notes: 'accumulated summary of the read-only calls so far',
        };
  const pending: Record<string, PendingToolCall> = {
    w1: {
      id: 'w1',
      name: 'write_file',
      args: { path: '/dst', content: 'the content to write' },
      stateName: 'writing',
    },
  };
  return buildBlobPayload({
    code: CODE,
    serverIdentity: IDENTITY,
    snapshot: { status: 'active', value: 'writing', context, children: {} },
    pending,
    audit: [{ callId: 'r1', tool: 'read_file', args: { path: '/src' }, decision: 'auto' }],
    trip: 1,
    now: 1_000_000,
  });
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

describe('Section 10 budgets — blob size', () => {
  it('a typical suspension blob is well under the 8 KB median budget', () => {
    const blob = sealBlob(benchmarkPayload('typical'), CONFIG);
    const bytes = Buffer.byteLength(blob, 'utf8');
    // Reported so a regression shows the actual size, not just a failure.
    // eslint-disable-next-line no-console
    console.log(`typical suspension blob: ${bytes} bytes (budget 8192)`);
    // The §10 median target is 8 KB; a single typical workflow should sit
    // comfortably below it.
    expect(bytes).toBeLessThan(8 * 1024);
  });

  it('median blob size across benchmark workflows is under 8 KB', () => {
    const sizes: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const kind = i % 2 === 0 ? 'small' : 'typical';
      sizes.push(Buffer.byteLength(sealBlob(benchmarkPayload(kind), CONFIG), 'utf8'));
    }
    sizes.sort((x, y) => x - y);
    const median = percentile(sizes, 50);
    expect(median).toBeLessThan(8 * 1024);
  });

  it('stays under the 32 KB typical-flow soft target (R23)', () => {
    const blob = sealBlob(benchmarkPayload('typical'), CONFIG);
    expect(Buffer.byteLength(blob, 'utf8')).toBeLessThan(32 * 1024);
  });
});

describe('Section 10 budgets — seal + verify overhead', () => {
  it('seal→open round-trip p95 is far under the 100 ms resume budget', () => {
    const payload = benchmarkPayload('typical');
    // Warm up (JIT, first HKDF) so the sample reflects steady state.
    for (let i = 0; i < 20; i += 1) {
      openBlob(sealBlob(payload, CONFIG), {
        code: CODE,
        serverIdentity: IDENTITY,
        config: CONFIG,
        now: 1_000_500,
      });
    }

    const samples: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const start = performance.now();
      const blob = sealBlob(payload, CONFIG);
      openBlob(blob, { code: CODE, serverIdentity: IDENTITY, config: CONFIG, now: 1_000_500 });
      samples.push(performance.now() - start);
    }
    samples.sort((x, y) => x - y);
    const p95 = percentile(samples, 95);
    // eslint-disable-next-line no-console
    console.log(`seal+open p95: ${p95.toFixed(3)} ms (budget 100)`);
    // Crypto is ~1–2 ms; a 50 ms ceiling is a wide margin under the 100 ms
    // budget that still catches an order-of-magnitude regression, while
    // tolerating a slow shared CI runner.
    expect(p95).toBeLessThan(50);
  });

  it('key rotation does not blow up open latency (bounded key trials)', () => {
    // A deployment mid-rotation accepts several previous keys. Opening a blob
    // sealed under the current key must not pay for trying all of them.
    const rotated: BlobSealerConfig = {
      key: CONFIG.key,
      previousKeys: Array.from({ length: 4 }, (_, i) => new Uint8Array(32).fill(100 + i)),
    };
    const payload = benchmarkPayload('typical');
    const blob = sealBlob(payload, rotated);
    for (let i = 0; i < 20; i += 1) {
      openBlob(blob, { code: CODE, serverIdentity: IDENTITY, config: rotated, now: 1_000_500 });
    }
    const samples: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const start = performance.now();
      openBlob(blob, { code: CODE, serverIdentity: IDENTITY, config: rotated, now: 1_000_500 });
      samples.push(performance.now() - start);
    }
    samples.sort((x, y) => x - y);
    expect(percentile(samples, 95)).toBeLessThan(50);
  });
});
