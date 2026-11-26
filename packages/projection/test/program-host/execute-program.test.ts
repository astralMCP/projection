/**
 * The experimental psychoscript program runtime end to end through
 * execute_machine: reads, approvals across round trips, batched approvals
 * from Promise.all, denials as catchable errors, policy, caps, and the
 * errors a model gets for programs that cannot run.
 */
import { describe, expect, it } from 'vitest';
import { executeMachine } from '../../src/mrtr/index.js';
import type { ExecuteMachineDeps, ToolCallResult } from '../../src/mrtr/index.js';
import type { BlobSealerConfig, StructuredError } from '../../src/types.js';
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

/** Answer every pending call of a suspension with `answers[key]` (default ACCEPT). */
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

describe('psychoscript runtime: reads complete in one call', () => {
  it('runs a read and returns the program value', async () => {
    const executor = new FakeExecutor({ read_file: { ok: true, result: '{"lines":[1,2,3]}' } });
    const code = `
const file = await tools.read_file({ path: input.path })
return { count: file.lines.length }
`;
    const result = await executeMachine({ code, input: { path: '/a' } }, deps({ executor }));
    expect(output(result)).toEqual({ count: 3 });
    expect(executor.calls).toEqual([{ name: 'read_file', args: { path: '/a' } }]);
  });

  it('strips TypeScript types by default and runs lang: js as written', async () => {
    const ts = `const n: number = 2\nreturn n * 2`;
    expect(output(await executeMachine({ code: ts }, deps()))).toBe(4);
    const js = `return [1, 2].map((x) => x + 1)`;
    expect(output(await executeMachine({ code: js, lang: 'js' }, deps()))).toEqual([2, 3]);
  });
});

describe('psychoscript runtime: approvals', () => {
  const code = `
const before = await tools.list_dir({ path: '/' })
try {
  await tools.write_file({ path: input.path, content: 'hello' })
  return { status: 'written', before }
} catch (e) {
  if (e.name !== 'ToolDenied') throw e
  return { status: 'skipped', reason: e.reason ?? null }
}
`;

  it('suspends on a gated call before running it, then runs it once when approved', async () => {
    const executor = new FakeExecutor();
    const d = deps({ executor });
    const first = await executeMachine({ code, input: { path: '/a' } }, d);
    expect(requestKeys(first)).toEqual(['write_file#2']);
    expect(executor.calls.map((c) => c.name)).toEqual(['list_dir']);
    const done = await resume(code, first, d);
    expect(output(done)).toEqual({ status: 'written', before: 'list_dir-ok' });
    // The read before the approval is not run again on resume.
    expect(executor.calls.map((c) => c.name)).toEqual(['list_dir', 'write_file']);
    expect(structured(done)['approvals']).toMatchObject([
      { tool: 'list_dir', decision: 'auto' },
      { tool: 'write_file', decision: 'approved', args: { path: '/a', content: 'hello' } },
    ]);
  });

  it('a declined call throws ToolDenied into the program, with the note', async () => {
    const executor = new FakeExecutor();
    const d = deps({ executor });
    const first = await executeMachine({ code, input: { path: '/a' } }, d);
    const done = await resume(code, first, d, { 'write_file#2': decline('not today') });
    expect(output(done)).toEqual({ status: 'skipped', reason: 'not today' });
    expect(executor.calls.map((c) => c.name)).toEqual(['list_dir']);
  });

  it('an uncaught denial fails the run with a hint to catch it, and lists the refusal', async () => {
    const d = deps();
    const bare = `await tools.write_file({ path: '/a', content: 'x' })\nreturn 'done'`;
    const first = await executeMachine({ code: bare }, d);
    const failed = error(await resume(bare, first, d, { 'write_file#1': decline() }));
    expect(failed.phase).toBe('runtime');
    expect(failed.message).toContain('declined');
    expect(failed.hint).toContain('ToolDenied');
  });

  it('gated calls made together (Promise.all) go to the user in ONE round trip', async () => {
    const executor = new FakeExecutor();
    const d = deps({ executor });
    const batch = `
const paths = ['/a', '/b', '/c']
const results = await Promise.allSettled(paths.map((path) => tools.write_file({ path, content: 'x' })))
return results.map((r, i) => [paths[i], r.status])
`;
    const first = await executeMachine({ code: batch }, d);
    expect(requestKeys(first)).toEqual(['write_file#1', 'write_file#2', 'write_file#3']);
    const done = await resume(batch, first, d, { 'write_file#2': decline() });
    expect(output(done)).toEqual([
      ['/a', 'fulfilled'],
      ['/b', 'rejected'],
      ['/c', 'fulfilled'],
    ]);
    expect(executor.calls.map((c) => c.args['path'])).toEqual(['/a', '/c']);
  });

  it('sequential gated calls take one round trip each, and approved writes never run twice', async () => {
    const executor = new FakeExecutor();
    const d = deps({ executor });
    const seq = `
await tools.write_file({ path: '/a', content: 'x' })
await tools.write_file({ path: '/b', content: 'x' })
return 'ok'
`;
    const first = await executeMachine({ code: seq }, d);
    const second = await resume(seq, first, d);
    expect(requestKeys(second)).toEqual(['write_file#2']);
    const done = await resume(seq, second, d);
    expect(output(done)).toBe('ok');
    expect(executor.calls.map((c) => c.args['path'])).toEqual(['/a', '/b']);
  });

  it('a policy deny throws ToolDenied at once, with no prompt', async () => {
    const executor = new FakeExecutor();
    const d = deps({ executor, policy: { delete_file: 'deny' } });
    const code2 = `
try { await tools.delete_file({ path: '/a' }) } catch (e) { return [e.name, e.byPolicy] }
`;
    expect(output(await executeMachine({ code: code2 }, d))).toEqual(['ToolDenied', true]);
    expect(executor.calls).toEqual([]);
  });

  it('a program blob does not resume on an XState facade, and the reverse', async () => {
    const d = deps();
    const first = await executeMachine({ code, input: { path: '/a' } }, d);
    const onXState = await resume(code, first, deps({ runtime: 'xstate' }));
    expect(error(onXState).phase).toBe('blob_verification');
  });
});

describe('psychoscript runtime: errors a model can act on', () => {
  it('a syntax error is a validate error with its line', async () => {
    const failed = error(await executeMachine({ code: 'return 1 +', lang: 'js' }, deps()));
    expect(failed.phase).toBe('validate');
    expect(failed.diagnostics[0]).toMatchObject({ line: 1 });
  });

  it('export is refused with the fix', async () => {
    const failed = error(await executeMachine({ code: 'export const a = 1', lang: 'js' }, deps()));
    expect(failed.message).toContain('Return the result instead');
  });

  it('an unknown tool fails the workflow with did-you-mean, even inside try/catch', async () => {
    const code = `try { await tools.read_fil({ path: '/a' }) } catch (e) { return 'swallowed' }`;
    const failed = error(await executeMachine({ code }, deps()));
    expect(failed.phase).toBe('validate');
    expect(failed.hint).toContain('read_file');
  });

  it('a failed tool call throws ToolError with the server message', async () => {
    const executor = new FakeExecutor({
      read_file: { ok: false, error: { message: 'ENOENT: no such file' } },
    });
    const code = `try { await tools.read_file({ path: '/x' }) } catch (e) { return [e.name, e.message] }`;
    expect(output(await executeMachine({ code }, deps({ executor })))).toEqual([
      'ToolError',
      'ENOENT: no such file',
    ]);
  });

  it('a loop that never ends stops at the segment wall clock', async () => {
    const failed = error(
      await executeMachine(
        { code: 'while (true) {}', lang: 'js' },
        deps({ caps: { segmentWallClockMs: 200 } }),
      ),
    );
    expect(failed.phase).toBe('cap_exceeded');
  });

  it('console output rides on the result', async () => {
    const result = await executeMachine({ code: `console.log('hi', 1)\nreturn 1` }, deps());
    expect(structured(result)['logs']).toMatchObject([{ level: 'log', message: 'hi 1' }]);
  });
});

describe('psychoscript runtime: Projection tools called from inside a program', () => {
  it('tools.search_tools(...) says to call it directly, without a misleading did-you-mean', async () => {
    const code = `return await tools.search_tools({ query: 'merge' })`;
    const failed = error(await executeMachine({ code }, deps()));
    expect(failed.phase).toBe('validate');
    expect(failed.message).toContain('not a function inside programs');
    expect(failed.hint).toContain('Call search_tools directly');
    expect(failed.hint).not.toContain('Did you mean');
  });
});
