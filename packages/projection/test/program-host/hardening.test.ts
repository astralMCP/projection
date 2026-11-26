/**
 * The program runtime's hardening (D48): batches survive long computations,
 * every executed call reaches the audit, never-awaited gated calls are
 * reported and not run, per-segment logs, refusals after a fatal failure,
 * and the size caps on arguments and suspended state.
 */
import { describe, expect, it } from 'vitest';
import { executeMachine } from '../../src/mrtr/index.js';
import type { ExecuteMachineDeps, ToolCallResult } from '../../src/mrtr/index.js';
import { runProgramSegment } from '../../src/program-host/host.js';
import type {
  BlobSealerConfig,
  SegmentOutcome,
  StructuredError,
  ToolCallOutcome,
  ToolExecutor,
} from '../../src/types.js';
import { BRIDGE_SOURCE, CATALOG, FakeExecutor } from '../machine-host/fixtures.js';
import {
  ACCEPT,
  completed,
  decline,
  isSuspended,
  requestKeys,
  sealedState,
  structured,
} from '../mrtr/helpers.js';

const BLOB: BlobSealerConfig = { key: new Uint8Array(32).fill(7) };

function deps(overrides: Partial<ExecuteMachineDeps> = {}): ExecuteMachineDeps {
  return {
    catalog: CATALOG,
    bridgeSource: BRIDGE_SOURCE,
    executor: new FakeExecutor(),
    blob: BLOB,
    protocolEra: 'modern',
    runtime: 'psychoscript',
    ...overrides,
  };
}

function output(result: ToolCallResult): unknown {
  const done = completed(result);
  expect(done.isError, JSON.stringify(structured(result))).toBeUndefined();
  return structured(result)['output'];
}

function error(result: ToolCallResult): StructuredError {
  expect(completed(result).isError).toBe(true);
  return structured(result) as unknown as StructuredError;
}

function text(result: ToolCallResult): string {
  return completed(result)
    .content.map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}

async function resume(
  code: string,
  first: ToolCallResult,
  d: ExecuteMachineDeps,
  answers: Record<string, ReturnType<typeof decline>> = {},
): Promise<ToolCallResult> {
  expect(isSuspended(first), JSON.stringify(first)).toBe(true);
  const inputResponses = Object.fromEntries(
    requestKeys(first).map((key) => [key, answers[key] ?? ACCEPT]),
  );
  return executeMachine({ code, requestState: sealedState(first), inputResponses }, d);
}

/** An executor whose calls to `slow` paths settle after `ms`. */
class SlowExecutor implements ToolExecutor {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  readonly settled: string[] = [];
  constructor(
    private readonly slow: ReadonlySet<string>,
    private readonly ms: number,
  ) {}
  async callTool(
    _alias: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallOutcome> {
    this.calls.push({ name, args });
    const path = String(args['path']);
    if (this.slow.has(path)) await new Promise((resolve) => setTimeout(resolve, this.ms));
    this.settled.push(path);
    return { ok: true, result: `${name}-ok` };
  }
}

describe('gated calls started together share one round trip, however long the work between', () => {
  it('a long loop between two gated calls does not split the batch', async () => {
    const executor = new FakeExecutor();
    const d = deps({ executor });
    const code = `
const p = tools.write_file({ path: '/a', content: 'x' })
let x = 0
for (let i = 0; i < 3e6; i++) x += i
const q = tools.write_file({ path: '/b', content: 'x' })
await Promise.all([p, q])
return x > 0
`;
    const first = await executeMachine({ code, lang: 'js' }, d);
    expect(requestKeys(first)).toEqual(['write_file#1', 'write_file#2']);
    expect(output(await resume(code, first, d))).toBe(true);
    expect(executor.calls.map((c) => c.args['path'])).toEqual(['/a', '/b']);
  }, 60_000);

  it('Promise.allSettled over 40 calls, each building a long string, asks once', async () => {
    const executor = new FakeExecutor();
    const d = deps({ executor });
    const code = `
const paths = Array.from({ length: 40 }, (_, i) => '/f' + i)
const results = await Promise.allSettled(paths.map((path) => {
  let content = ''
  for (let i = 0; i < 2000; i++) content += String.fromCharCode(97 + (i % 26))
  return tools.write_file({ path, content })
}))
return results.filter((r) => r.status === 'fulfilled').length
`;
    const first = await executeMachine({ code, lang: 'js' }, d);
    expect(requestKeys(first)).toHaveLength(40);
    expect(output(await resume(code, first, d))).toBe(40);
    expect(executor.calls).toHaveLength(40);
  }, 60_000);
});

describe('every call that ran is in the audit, whenever the run ends', () => {
  it('an approved write still executing when the program throws is listed as done', async () => {
    const executor = new SlowExecutor(new Set(['/b']), 100);
    const d = deps({ executor });
    const code = `
const a = tools.write_file({ path: '/a', content: 'x' })
const b = tools.write_file({ path: '/b', content: 'x' })
await Promise.race([a, b])
throw new Error('boom')
`;
    const first = await executeMachine({ code, lang: 'js' }, d);
    expect(requestKeys(first)).toEqual(['write_file#1', 'write_file#2']);
    const failed = await resume(code, first, d);
    expect(error(failed).phase).toBe('runtime');
    // The slow write settled before the result was built, and is listed.
    expect(executor.settled).toEqual(['/a', '/b']);
    expect(text(failed)).toMatch(/these 2 calls were approved and ran/u);
    expect(text(failed)).toContain('"/b"');
  });

  it('a read still executing when the program returns is in the approvals', async () => {
    const executor = new SlowExecutor(new Set(['/slow']), 50);
    const d = deps({ executor });
    const code = `tools.read_file({ path: '/slow' }); return 'done'`;
    const done = await executeMachine({ code, lang: 'js' }, d);
    expect(output(done)).toBe('done');
    expect(structured(done)['approvals']).toMatchObject([{ tool: 'read_file', decision: 'auto' }]);
  });
});

describe('a gated call never awaited is not run, and the result says so', () => {
  for (const [label, code] of [
    ['returned at once', `tools.write_file({ path: '/a', content: 'x' }); return 'done'`],
    [
      'returned after a long loop',
      `tools.write_file({ path: '/a', content: 'x' })\nlet x = 0\nfor (let i = 0; i < 3e6; i++) x += i\nreturn 'done'`,
    ],
  ] as const) {
    it(
      label,
      async () => {
        const executor = new FakeExecutor();
        const done = await executeMachine({ code, lang: 'js' }, deps({ executor }));
        expect(output(done)).toBe('done');
        expect(executor.calls).toEqual([]);
        expect(structured(done)['approvals']).toEqual([]);
        const notes = structured(done)['notes'] as string[];
        expect(notes[0]).toMatch(/never awaited, so it was not run and the user was not asked/u);
        expect(notes[0]).toContain('"write_file#1"');
      },
      60_000,
    );
  }

  it('an unhandled rejection is a note', async () => {
    const code = `Promise.reject(new Error('lost')); return 1`;
    const done = await executeMachine({ code, lang: 'js' }, deps());
    expect(output(done)).toBe(1);
    expect((structured(done)['notes'] as string[]).join('\n')).toMatch(/program warning: .*lost/u);
  });
});

describe('console output: this segment only, on every path, capped', () => {
  it('a segment that hits the wall clock keeps its console output', async () => {
    const failed = error(
      await executeMachine(
        { code: `console.log('hello')\nwhile (true) {}`, lang: 'js' },
        deps({ caps: { segmentWallClockMs: 200 } }),
      ),
    );
    expect(failed.phase).toBe('cap_exceeded');
    expect(failed.logs).toMatchObject([{ level: 'log', message: 'hello', segment: 0 }]);
  });

  it('a suspended segment carries its lines, and a resumed one reports only its own', async () => {
    const code = `
console.log('before')
await tools.write_file({ path: '/a', content: 'x' })
console.warn('after')
return 'ok'
`;
    const base = { code, lang: 'js' as const, catalog: CATALOG, bridgeSource: BRIDGE_SOURCE };
    const first = await runProgramSegment({ ...base, executor: new FakeExecutor() });
    expect(first.status).toBe('suspended');
    const suspended = first as Extract<SegmentOutcome, { status: 'suspended' }>;
    expect(suspended.logs).toMatchObject([{ level: 'log', message: 'before', segment: 0 }]);

    const second = await runProgramSegment({
      ...base,
      executor: new FakeExecutor(),
      segment: 1,
      resume: {
        snapshot: suspended.snapshot,
        pending: suspended.pending,
        verdicts: { 'write_file#1': { kind: 'approved' } },
        audit: suspended.audit,
        trip: suspended.trip,
      },
    });
    expect(second.status).toBe('completed');
    expect((second as Extract<SegmentOutcome, { status: 'completed' }>).logs).toEqual([
      expect.objectContaining({ level: 'warn', message: 'after', segment: 1 }),
    ]);
  });

  it('console output is capped at maxConsoleBytes', async () => {
    const code = `for (let i = 0; i < 200; i++) console.log('line ' + i + ' ' + 'x'.repeat(50))\nreturn 1`;
    const done = await executeMachine(
      { code, lang: 'js' },
      deps({ caps: { maxConsoleBytes: 1024 } }),
    );
    const logs = structured(done)['logs'] as { message: string }[];
    const bytes = logs.reduce((sum, log) => sum + Buffer.byteLength(log.message), 0);
    expect(bytes).toBeLessThan(1500);
    expect(logs.some((log) => log.message.includes('console output truncated'))).toBe(true);
  });
});

describe('after a fatal failure nothing else runs', () => {
  it('an unknown tool caught by the program stops later calls from executing', async () => {
    const executor = new FakeExecutor();
    const code = `
try { await tools.read_fil({ path: '/a' }) } catch (e) {}
await tools.read_file({ path: '/a' })
return 'went on'
`;
    const failed = error(await executeMachine({ code, lang: 'js' }, deps({ executor })));
    expect(failed.phase).toBe('validate');
    expect(executor.calls).toEqual([]);
  });

  it('the read-call cap stops later calls from executing', async () => {
    const executor = new FakeExecutor();
    const code = `
try { await tools.read_file({ path: '/a' }); await tools.read_file({ path: '/b' }) } catch (e) {}
await tools.list_dir({ path: '/' })
return 'went on'
`;
    const failed = error(
      await executeMachine(
        { code, lang: 'js' },
        deps({ executor, caps: { maxReadCallsPerSegment: 1 } }),
      ),
    );
    expect(failed.phase).toBe('cap_exceeded');
    expect(executor.calls.map((c) => c.args['path'])).toEqual(['/a']);
  });

  it('a pending call whose tool left the catalog fails the workflow, even inside try/catch', async () => {
    const code = `
try { await tools.write_file({ path: '/a', content: 'x' }) } catch (e) { return 'swallowed' }
return 'ran'
`;
    const base = { code, lang: 'js' as const, bridgeSource: BRIDGE_SOURCE };
    const first = await runProgramSegment({
      ...base,
      catalog: CATALOG,
      executor: new FakeExecutor(),
    });
    const suspended = first as Extract<SegmentOutcome, { status: 'suspended' }>;
    expect(suspended.status).toBe('suspended');
    const executor = new FakeExecutor();
    const second = await runProgramSegment({
      ...base,
      catalog: { ...CATALOG, tools: CATALOG.tools.filter((t) => t.name !== 'write_file') },
      executor,
      segment: 1,
      resume: {
        snapshot: suspended.snapshot,
        pending: suspended.pending,
        verdicts: { 'write_file#1': { kind: 'approved' } },
        audit: suspended.audit,
        trip: suspended.trip,
      },
    });
    expect(second.status).toBe('error');
    expect((second as Extract<SegmentOutcome, { status: 'error' }>).error.phase).toBe('validate');
    expect(executor.calls).toEqual([]);
  });
});

describe('size caps', () => {
  it('a tool call whose arguments are over maxInputBytes fails catchably, unrecorded', async () => {
    const executor = new FakeExecutor();
    const code = `
try {
  await tools.write_file({ path: '/a', content: 'x'.repeat(5000) })
} catch (e) { return [e.name, e.message] }
`;
    const done = await executeMachine(
      { code, lang: 'js' },
      deps({ executor, caps: { maxInputBytes: 1024 } }),
    );
    const [name, message] = output(done) as [string, string];
    expect(name).toBe('ToolError');
    expect(message).toMatch(/over the limit of 1024 bytes/u);
    expect(executor.calls).toEqual([]);
    expect(structured(done)['approvals']).toEqual([]);
  });

  it('a run whose state is too large to suspend fails with cap_exceeded', async () => {
    const code = `
const big = 'x'.repeat(600000)
await tools.write_file({ path: '/a', content: 'x' })
return big.length
`;
    const failed = error(
      await executeMachine(
        { code, lang: 'js' },
        deps({ blob: { ...BLOB, maxBlobBytes: 32 * 1024 } }),
      ),
    );
    expect(failed.phase).toBe('cap_exceeded');
    expect(failed.message).toMatch(/too large to suspend/u);
    expect(failed.hint).toMatch(/Keep less data in variables/u);
  });
});
