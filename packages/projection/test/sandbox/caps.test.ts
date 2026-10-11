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

  it('enforces the WASM memory cap inside the VM', async () => {
    // Allocation pattern matters here. QuickJS's limit check is
    // `accounted + request > limit`, but in the emscripten build the
    // accounted size of a live allocation is only its bookkeeping overhead,
    // not its payload (malloc_usable_size is 0 under emscripten). So a hoard
    // of many small strings is refused only once WASM linear memory itself
    // is exhausted (~2 GB, ~6 s on a fast machine, >20 s under CI load),
    // which is what made this case race the wall-clock budget. A doubling
    // array instead makes each `concat` a single request twice the size of
    // the last, so one request exceeds the 8 MB cap within ~10 iterations
    // and the memory error is deterministic and fast (tens of ms).
    await withSession(
      { caps: { wasmMemoryBytes: 8 * 1024 * 1024, segmentWallClockMs: 20_000 } },
      async (session) => {
        const startedAt = Date.now();
        const error = await session
          .evaluate(
            `let hoard = new Array(1024).fill(0);
             for (let i = 0; i < 64; i++) { hoard = hoard.concat(hoard); }
             export default hoard.length;`,
          )
          .then(
            () => undefined,
            (err: unknown) => err,
          );
        const elapsed = Date.now() - startedAt;
        expect(error).toBeInstanceOf(ProjectionError);
        expect((error as ProjectionError).phase).toBe('cap_exceeded');
        expect((error as ProjectionError).message).toMatch(/memory/i);
        expect((error as ProjectionError).message).toContain(String(8 * 1024 * 1024));
        // Well under the segment budget: the memory cap, not the wall clock, ended it.
        expect(elapsed).toBeLessThan(10_000);
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
