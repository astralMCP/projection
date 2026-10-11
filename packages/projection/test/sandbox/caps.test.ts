import { describe, expect, it } from 'vitest';
import { ProjectionError } from '../../src/errors.js';
import { createSandboxSession } from '../../src/sandbox/index.js';
import { BRIDGE_STUB, withSession } from './helpers.js';

describe('resource caps (R12/R13)', () => {
  it('kills a tight infinite loop at the wall-clock cap via the in-VM interrupt handler', async () => {
    // A synchronous `while(true)` blocks the host event loop, so no host
    // timer can fire while it spins — only the QuickJS interrupt handler can
    // stop it. Completing at all (well under the generous outer bound below)
    // proves the interrupt fired inside the VM (R13).
    await withSession({ caps: { segmentWallClockMs: 1_500 } }, async (session) => {
      const startedAt = Date.now();
      const error = await session.evaluate(`while (true) {} export default 1;`).then(
        () => undefined,
        (err: unknown) => err,
      );
      const elapsed = Date.now() - startedAt;
      expect(error).toBeInstanceOf(ProjectionError);
      expect((error as ProjectionError).phase).toBe('cap_exceeded');
      expect((error as ProjectionError).message).toContain('wall-clock');
      expect(elapsed).toBeLessThan(10_000);
    });
  });

  it('fails fast on further evaluate calls once the segment budget is exhausted', async () => {
    await withSession({ caps: { segmentWallClockMs: 1_000 } }, async (session) => {
      await session.evaluate(`while (true) {} export default 1;`).catch(() => {});
      const startedAt = Date.now();
      const error = await session.evaluate(`export default 2;`).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(ProjectionError);
      expect((error as ProjectionError).phase).toBe('cap_exceeded');
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    });
  });

  // What the cap bounds: in the emscripten QuickJS build the limit check is
  // `accounted + request > limit`, but a live allocation is accounted only
  // as ~8 bytes of bookkeeping (malloc_usable_size is 0), not its payload.
  // So the cap bounds the size of a single allocation request, not total
  // sandbox memory: any number of sub-cap allocations adds up to WASM linear
  // memory (~2 GB) at any cap setting, ending in the same out-of-memory
  // error. Each test below therefore fails if the limit is missing or wrong:
  // one request above the cap, or the iteration count of a doubling sequence.
  it('refuses a single allocation above the WASM memory cap', async () => {
    // 16 MB is above the 8 MB cap but below the 256 MB hard max, so this
    // succeeds (returns 16777216) if the limit is missing or clamped high.
    await withSession({ caps: { wasmMemoryBytes: 8 * 1024 * 1024 } }, async (session) => {
      const error = await session
        .evaluate(`export default 'x'.repeat(16 * 1024 * 1024).length;`)
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      expect(error).toBeInstanceOf(ProjectionError);
      expect((error as ProjectionError).phase).toBe('cap_exceeded');
      expect((error as ProjectionError).message).toMatch(/memory/i);
    });
  });

  it('the cap value, not WASM exhaustion, ends a growing allocation sequence', async () => {
    // Each `concat` is one request twice the size of the last. The last
    // logged iteration depends only on the cap, not on machine load
    // (measured: 9 at 8 MB, 10 at 16 MB, 12 at 64 MB, 14 at 256 MB, 16 with
    // no limit, where WASM exhaustion ends it).
    await withSession(
      { caps: { wasmMemoryBytes: 8 * 1024 * 1024, segmentWallClockMs: 20_000 } },
      async (session) => {
        const error = await session
          .evaluate(
            `let hoard = new Array(1024).fill(0);
             for (let i = 0; i < 64; i++) { console.log(i); hoard = hoard.concat(hoard); }
             export default hoard.length;`,
          )
          .then(
            () => undefined,
            (err: unknown) => err,
          );
        expect(error).toBeInstanceOf(ProjectionError);
        expect((error as ProjectionError).phase).toBe('cap_exceeded');
        expect((error as ProjectionError).message).toMatch(/memory/i);
        const iterations = (error as ProjectionError).logs.map((entry) => Number(entry.message));
        expect(iterations.length).toBeGreaterThan(0);
        expect(Math.max(...iterations)).toBeLessThanOrEqual(11);
      },
    );
  });

  it('rejects oversized code before evaluation (maxCodeBytes)', async () => {
    const error = await createSandboxSession({
      code: `export default 1; // ${'x'.repeat(2048)}`,
      caps: { maxCodeBytes: 1_024 },
      bridgeSource: BRIDGE_STUB,
      onToolCall: () => ({}),
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ProjectionError);
    expect((error as ProjectionError).phase).toBe('cap_exceeded');
    expect((error as ProjectionError).message).toContain('1024');
    expect((error as ProjectionError).hint.length).toBeGreaterThan(0);
  });

  it('clamps requested caps at the hard maxima', async () => {
    await withSession(
      { caps: { segmentWallClockMs: Number.MAX_SAFE_INTEGER } },
      async (session) => {
        expect(session.caps.segmentWallClockMs).toBe(60_000);
      },
    );
  });
});
