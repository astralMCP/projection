/**
 * Section 10 budget checks (M5).
 *
 * PRD §10 targets: suspend→resume overhead (blob seal + verify + rehydrate)
 * p95 < 100 ms, and median blob size < 8 KB on benchmark workflows.
 *
 * "Overhead" here is measured as the real end-to-end resume leg — the second
 * `execute_machine` call that verifies the blob, boots a QuickJS VM, restores
 * the actor, and runs it to completion — because that whole path, not the
 * crypto alone, is what the 100 ms budget bounds. The crypto seal+verify is
 * measured separately to show it is a negligible fraction of that cost, so a
 * regression there is attributed correctly.
 *
 * Timing ceilings are set to catch a real regression (a few-fold blowup)
 * while tolerating a loaded CI runner, and every measurement is surfaced in
 * its assertion message so a failure reports the actual number.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildBlobPayload, openBlob, sealBlob } from '../../src/blob/index.js';
import {
  isInputRequiredResult,
  wrapMcpServer,
  type BlobPayload,
  type BlobSealerConfig,
  type InputRequiredResult,
  type PendingToolCall,
} from '../../src/index.js';

const CONFIG: BlobSealerConfig = { key: new Uint8Array(32).fill(31) };
const CODE = 'export default setup({}).createMachine({ id: "m" });';
const IDENTITY = 'srv://budget/default';

/** Nearest-rank percentile of an already-sorted, non-empty array. */
function percentile(sorted: number[], p: number): number {
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

// ---------------------------------------------------------------------------
// Blob size
// ---------------------------------------------------------------------------

function sealWithContext(context: unknown): string {
  const pending: Record<string, PendingToolCall> = {
    w1: {
      id: 'w1',
      name: 'write_file',
      args: { path: '/dst', content: 'the content to write' },
      stateName: 'writing',
    },
  };
  const payload: BlobPayload = buildBlobPayload({
    code: CODE,
    serverIdentity: IDENTITY,
    snapshot: { status: 'active', value: 'writing', context, children: {} },
    pending,
    audit: [{ callId: 'r1', tool: 'read_file', args: { path: '/src' }, decision: 'auto' }],
    trip: 1,
    now: 1_000_000,
  });
  return sealBlob(payload, CONFIG);
}

describe('Section 10 budgets — blob size', () => {
  it('a typical suspension blob is well under the 8 KB median budget', () => {
    const bytes = Buffer.byteLength(sealWithContext({ step: 7, cursor: 'page-2' }), 'utf8');
    expect(bytes, `typical blob was ${bytes} bytes`).toBeLessThan(8 * 1024);
  });

  it('compresses the payload — a size regression that dropped compression would breach', () => {
    // A realistically bloated context: accumulated read results the model
    // forgot to slim. Raw JSON is large; deflate must bring the sealed blob
    // well down, or R23 / the §10 budget is at risk.
    const bloated = {
      notes: 'summary '.repeat(2000),
      gathered: Array.from({ length: 200 }, (_, i) => ({
        id: `item-${i}`,
        text: 'lorem ipsum dolor sit amet consectetur',
      })),
    };
    const rawJsonBytes = Buffer.byteLength(JSON.stringify(bloated), 'utf8');
    const sealed = sealWithContext(bloated);
    const sealedBytes = Buffer.byteLength(sealed, 'utf8');

    // Compression must be doing real work: the sealed blob is a small
    // fraction of the raw JSON. Disabling deflate (level 0) makes this fail.
    expect(
      sealedBytes,
      `sealed ${sealedBytes} vs raw JSON ${rawJsonBytes} (ratio ${(sealedBytes / rawJsonBytes).toFixed(3)})`,
    ).toBeLessThan(rawJsonBytes * 0.25);
    // And the highly compressible case still lands under the 8 KB budget.
    expect(sealedBytes, `bloated-but-compressible blob was ${sealedBytes} bytes`).toBeLessThan(
      8 * 1024,
    );
  });
});

// ---------------------------------------------------------------------------
// Seal + verify crypto overhead (the host-side fraction of the resume cost)
// ---------------------------------------------------------------------------

describe('Section 10 budgets — seal/verify crypto overhead', () => {
  it('seal→open round-trip p95 is a small fraction of the resume budget', () => {
    const openOpts = { code: CODE, serverIdentity: IDENTITY, config: CONFIG, now: 1_000_500 };
    const sealOne = () =>
      sealBlob(
        buildBlobPayload({
          code: CODE,
          serverIdentity: IDENTITY,
          snapshot: { status: 'active', value: 'writing', context: { step: 7 }, children: {} },
          pending: {},
          audit: [],
          trip: 1,
          now: 1_000_000,
        }),
        CONFIG,
      );
    for (let i = 0; i < 50; i += 1) openBlob(sealOne(), openOpts);

    const samples: number[] = [];
    for (let i = 0; i < 500; i += 1) {
      const start = performance.now();
      openBlob(sealOne(), openOpts);
      samples.push(performance.now() - start);
    }
    samples.sort((x, y) => x - y);
    const p95 = percentile(samples, 95);
    // Steady-state crypto is ~0.1 ms. A 3 ms ceiling is ~30x that — ample for
    // CI jitter, but a 200x key-derivation regression (~15 ms) fails it.
    expect(p95, `seal+open p95 was ${p95.toFixed(3)} ms`).toBeLessThan(3);
  });

  it('a blob sealed under a rotated-out key does not walk every trial in vain', () => {
    // Worst case for R22 rotation: the blob was sealed under the OLDEST key,
    // so opening trials the current key and each newer previous key first.
    const keys = Array.from({ length: 5 }, (_, i) => new Uint8Array(32).fill(50 + i));
    const current = keys[0] as Uint8Array;
    const oldest = keys[keys.length - 1] as Uint8Array;
    const rotated: BlobSealerConfig = { key: current, previousKeys: keys.slice(1) };
    const singleKey: BlobSealerConfig = { key: oldest };

    const payload = buildBlobPayload({
      code: CODE,
      serverIdentity: IDENTITY,
      snapshot: { status: 'active', value: 'writing', context: { step: 1 }, children: {} },
      pending: {},
      audit: [],
      trip: 1,
      now: 1_000_000,
    });
    // Sealed under the oldest key: opening under `rotated` must trial all 5.
    const blob = sealBlob(payload, singleKey);
    const openOpts = { code: CODE, serverIdentity: IDENTITY, now: 1_000_500 };

    const time = (config: BlobSealerConfig): number => {
      for (let i = 0; i < 50; i += 1) openBlob(blob, { ...openOpts, config });
      const s: number[] = [];
      for (let i = 0; i < 200; i += 1) {
        const start = performance.now();
        openBlob(blob, { ...openOpts, config });
        s.push(performance.now() - start);
      }
      s.sort((x, y) => x - y);
      return percentile(s, 95);
    };

    const worstCase = time(rotated); // 5 key trials
    const singleTrial = time({ key: oldest }); // 1 key trial
    // The full 5-key walk costs on the order of a single open, not a
    // pathological multiple — and stays well under the resume budget.
    expect(
      worstCase,
      `5-key open p95 ${worstCase.toFixed(3)} ms vs 1-key ${singleTrial.toFixed(3)} ms`,
    ).toBeLessThan(Math.max(singleTrial * 10, 3));
  });
});

// ---------------------------------------------------------------------------
// Full suspend → resume overhead (the actual §10 metric, incl. rehydrate)
// ---------------------------------------------------------------------------

const RESUME_MACHINE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'copy',
  context: { seen: null, status: 'pending' },
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('read_file', () => ({ path: '/src' })),
      on: { TOOL_RESULT: { target: 'writing', actions: assign({ seen: ({ event }) => event.result }) } },
    },
    writing: {
      entry: toolCall('write_file', ({ context }) => ({ path: '/dst', content: context.seen }), { id: 'w1' }),
      on: { TOOL_RESULT: { target: 'done', actions: assign({ status: 'written' }) } },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status }),
});
`;

async function makeFacade() {
  const server = new McpServer({ name: 'files', version: '1.0.0' });
  server.registerTool(
    'read_file',
    {
      description: 'Read.',
      inputSchema: z.object({ path: z.string() }),
      annotations: { readOnlyHint: true },
    },
    ({ path }) => ({ content: [{ type: 'text' as const, text: `contents of ${path}` }] }),
  );
  server.registerTool(
    'write_file',
    { description: 'Write.', inputSchema: z.object({ path: z.string(), content: z.string() }) },
    () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  );
  return wrapMcpServer(server, { blob: { key: CONFIG.key } });
}

describe('Section 10 budgets — end-to-end suspend/resume overhead', () => {
  it('the resume leg (verify + rehydrate + run) p95 is under the 100 ms budget', async () => {
    const facade = await makeFacade();
    try {
      const measure = async (): Promise<number> => {
        const suspended = await facade.executeMachine({ code: RESUME_MACHINE }, 'modern');
        const requestState = (suspended as InputRequiredResult).requestState as string;
        const start = performance.now();
        const done = await facade.executeMachine(
          { code: RESUME_MACHINE, requestState, inputResponses: { w1: { action: 'accept' } } },
          'modern',
        );
        const elapsed = performance.now() - start;
        expect(isInputRequiredResult(done)).toBe(false);
        return elapsed;
      };

      for (let i = 0; i < 3; i += 1) await measure(); // warm the QuickJS runtime
      const samples: number[] = [];
      for (let i = 0; i < 20; i += 1) samples.push(await measure());
      samples.sort((x, y) => x - y);
      const p95 = percentile(samples, 95);
      const median = percentile(samples, 50);
      expect(
        p95,
        `resume-leg p95 ${p95.toFixed(1)} ms, median ${median.toFixed(1)} ms (budget 100)`,
      ).toBeLessThan(100);
    } finally {
      await facade.close();
    }
  });
});
