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

  function expectMemoryCapExceeded(error: unknown): void {
    expect(error).toBeInstanceOf(ProjectionError);
    expect((error as ProjectionError).phase).toBe('cap_exceeded');
    expect((error as ProjectionError).message).toMatch(/memory/i);
    expect((error as ProjectionError).message).not.toMatch(/wall-clock/);
  }

  // Two mechanisms enforce the memory cap. QuickJS's own `memoryLimit`
  // refuses a single request larger than the cap — all it can do under
  // emscripten, where it accounts ~8 bytes of bookkeeping per live
  // allocation rather than payload. The session's WebAssembly memory
  // `maximum` bounds the total (DECISIONS D15). The two tests below pin the
  // per-request refusal and the cap-determined end of a doubling sequence;
  // the hoard tests after them pin the total bound.
  it('refuses a single allocation above the WASM memory cap', async () => {
    // 32 MB is above the 16 MB cap but below the 256 MB hard max, so this
    // returns 33554432 if the cap is clamped high.
    await withSession({ caps: { wasmMemoryBytes: 16 * 1024 * 1024 } }, async (session) => {
      const error = await session
        .evaluate(`export default 'x'.repeat(32 * 1024 * 1024).length;`)
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      expectMemoryCapExceeded(error);
    });
  });

  it('the cap value, not WASM exhaustion, ends a growing allocation sequence', async () => {
    // Each `concat` is one request twice the size of the last. The last
    // logged iteration depends only on the cap, not on machine load
    // (measured: 8 at 16 MB, 11 at 64 MB, 13 at 256 MB; 16 with no limit,
    // where WASM exhaustion at ~2 GB ends it).
    await withSession(
      { caps: { wasmMemoryBytes: 16 * 1024 * 1024, segmentWallClockMs: 20_000 } },
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
        expectMemoryCapExceeded(error);
        const iterations = (error as ProjectionError).logs.map((entry) => Number(entry.message));
        expect(iterations.length).toBeGreaterThan(0);
        expect(Math.max(...iterations)).toBeLessThanOrEqual(10);
      },
    );
  });

  /**
   * Evaluate `source` under a 16 MB memory cap (the floor; 8 MB is requested
   * to prove the clamp) and return the error and the time it took to fail.
   * The cap is the WebAssembly memory's `maximum`, so the engine refuses
   * growth as soon as the heap would pass it; QuickJS's own accounting is
   * blind to payload bytes under emscripten and would let these hoards run
   * to ~2 GB (6-7 s) before failing.
   */
  async function hoardUnderCap(source: string): Promise<{ error: unknown; elapsedMs: number }> {
    return withSession(
      { caps: { wasmMemoryBytes: 8 * 1024 * 1024, segmentWallClockMs: 20_000 } },
      async (session) => {
        expect(session.caps.wasmMemoryBytes).toBe(16 * 1024 * 1024);
        const startedAt = Date.now();
        const error = await session.evaluate(source).then(
          () => undefined,
          (err: unknown) => err,
        );
        return { error, elapsedMs: Date.now() - startedAt };
      },
    );
  }

  it('bounds real bytes: hoarding many sub-cap strings fails fast at the cap', async () => {
    const { error, elapsedMs } = await hoardUnderCap(
      `const hoard = [];
       for (let i = 0; i < 1e9; i++) { hoard.push('x'.repeat(4096)); }
       export default hoard.length;`,
    );
    expectMemoryCapExceeded(error);
    expect(elapsedMs, `took ${elapsedMs} ms to hit the memory cap`).toBeLessThan(2_000);
  });

  it('bounds real bytes: hoarding 1 MB typed arrays fails fast at the cap', async () => {
    // Each request is far below the cap, so QuickJS's own limit never
    // refuses one; only the memory's maximum stops the sum.
    const { error, elapsedMs } = await hoardUnderCap(
      `const hoard = [];
       for (let i = 0; i < 1e9; i++) { hoard.push(new Uint8Array(1 << 20)); }
       export default hoard.length;`,
    );
    expectMemoryCapExceeded(error);
    expect(elapsedMs, `took ${elapsedMs} ms to hit the memory cap`).toBeLessThan(2_000);
  });

  it('bounds real bytes: a doubling array fails at the cap', async () => {
    const { error, elapsedMs } = await hoardUnderCap(
      `let a = [1];
       for (;;) { a = a.concat(a); }
       export default a.length;`,
    );
    expectMemoryCapExceeded(error);
    expect(elapsedMs, `took ${elapsedMs} ms to hit the memory cap`).toBeLessThan(2_000);
  });

  it('leaves room for ordinary work under the memory floor', async () => {
    // The 16 MB floor is the module's initial heap, which the booted runtime
    // (xstate, the bridge) already lives in; a few MB of machine data must
    // still fit, or the floor would be a trap rather than a bound.
    await withSession({ caps: { wasmMemoryBytes: 16 * 1024 * 1024 } }, async (session) => {
      const result = await session.evaluate(
        `const rows = [];
         for (let i = 0; i < 512; i++) { rows.push('x'.repeat(4096)); }
         export default rows.length;`,
      );
      expect(result).toBe(512);
    });
  });

  it('isolates memory per session: one session exhausting its cap leaves another untouched', async () => {
    await withSession({ caps: { wasmMemoryBytes: 16 * 1024 * 1024 } }, async (hoarder) => {
      await withSession({ caps: { wasmMemoryBytes: 16 * 1024 * 1024 } }, async (bystander) => {
        const error = await hoarder
          .evaluate(
            `globalThis.hoard = [];
             for (let i = 0; i < 1e9; i++) { globalThis.hoard.push(new Uint8Array(1 << 20)); }
             export default 0;`,
          )
          .then(
            () => undefined,
            (err: unknown) => err,
          );
        expectMemoryCapExceeded(error);
        // The hoard is still live in the hoarder's VM (it is reachable from
        // its global object); the bystander has its own heap and is unaffected.
        expect(
          await bystander.evaluate(
            `const rows = [];
             for (let i = 0; i < 256; i++) { rows.push('x'.repeat(4096)); }
             export default rows.length;`,
          ),
        ).toBe(256);
        // The hoarder's VM survives the failed allocation (the result is an
        // ordinary in-VM error, not a trap) but stays at its cap.
        expect(await hoarder.evaluate(`export default 2 + 2;`)).toBe(4);
      });
    });
  });

  it('gives a session a fresh runtime even when it reuses a pooled module instance', async () => {
    // Sessions with the same cap run on pooled WASM instances in sequence.
    // The QuickJS runtime is torn down between them, so nothing authored in
    // one session — globals included — can be observed by the next.
    const caps = { wasmMemoryBytes: 32 * 1024 * 1024 };
    await withSession({ caps }, async (first) => {
      expect(await first.evaluate(`globalThis.leak = 'secret'; export default 1;`)).toBe(1);
    });
    await withSession({ caps }, async (second) => {
      expect(await second.evaluate(`export default typeof globalThis.leak;`)).toBe('undefined');
    });
  });

  it('does not let an exhausted instance poison the next session with the same cap', async () => {
    const caps = { wasmMemoryBytes: 16 * 1024 * 1024 };
    await withSession({ caps }, async (hoarder) => {
      const error = await hoarder
        .evaluate(
          `globalThis.hoard = [];
           for (let i = 0; i < 1e9; i++) { globalThis.hoard.push(new Uint8Array(1 << 20)); }
           export default 0;`,
        )
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      expectMemoryCapExceeded(error);
    });
    // Whether the exhausted instance was dropped or reused, the next session
    // has its whole cap available again.
    await withSession({ caps }, async (next) => {
      const result = await next.evaluate(
        `const rows = [];
         for (let i = 0; i < 512; i++) { rows.push('x'.repeat(4096)); }
         export default rows.length;`,
      );
      expect(result).toBe(512);
    });
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

  it('clamps the memory cap up to the 16 MB floor the WASM module starts with', async () => {
    await withSession({ caps: { wasmMemoryBytes: 1 } }, async (session) => {
      expect(session.caps.wasmMemoryBytes).toBe(16 * 1024 * 1024);
    });
  });
});
