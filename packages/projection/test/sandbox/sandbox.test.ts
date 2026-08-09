import { describe, expect, it } from 'vitest';
import { ProjectionError } from '../../src/errors.js';
import { createSandboxSession, type SandboxToolCall } from '../../src/sandbox/index.js';
import { BRIDGE_STUB, TOGGLE_MACHINE_JS, withSession } from './helpers.js';

describe('sandbox execution (R10)', () => {
  it('executes a JS module and marshals driver results to the host', async () => {
    await withSession({ code: `export default { answer: 21 * 2 };` }, async (session) => {
      const result = await session.evaluate(
        `export default globalThis.__projection.module.default.answer;`,
      );
      expect(result).toBe(42);
    });
  });

  it('executes a TS module by transpiling without type checking', async () => {
    const tsCode = `
      interface Ctx { n: number }
      const value: Ctx = { n: 7 };
      // A type error a checker would reject, but transpile-only must accept:
      const loose: string = 123 as unknown as string;
      export default value;
    `;
    await withSession({ code: tsCode, lang: 'ts' }, async (session) => {
      const result = await session.evaluate(
        `export default globalThis.__projection.module.default;`,
      );
      expect(result).toEqual({ n: 7 });
    });
  });

  it('persists driver state on globalThis.__projection.state across evaluate calls', async () => {
    await withSession({}, async (session) => {
      await session.evaluate(`globalThis.__projection.state.x = 5; export default null;`);
      const result = await session.evaluate(`export default globalThis.__projection.state.x + 1;`);
      expect(result).toBe(6);
    });
  });
});

describe('xstate in the VM (R8)', () => {
  it('imports xstate, creates a machine, and steps it', async () => {
    await withSession({ code: TOGGLE_MACHINE_JS }, async (session) => {
      const result = (await session.evaluate(`
        import { createActor } from 'xstate';
        const actor = createActor(globalThis.__projection.module.default);
        actor.start();
        const before = actor.getSnapshot().value;
        actor.send({ type: 'TOGGLE' });
        globalThis.__projection.state.actor = actor;
        export default { before, after: actor.getSnapshot().value, persisted: actor.getPersistedSnapshot() };
      `)) as { before: string; after: string; persisted: { value: string; status: string } };
      expect(result.before).toBe('off');
      expect(result.after).toBe('on');
      expect(result.persisted.value).toBe('on');
      expect(result.persisted.status).toBe('active');

      // The actor survives across evaluate calls via the state stash.
      const value = await session.evaluate(`
        const actor = globalThis.__projection.state.actor;
        actor.send({ type: 'TOGGLE' });
        export default actor.getSnapshot().value;
      `);
      expect(value).toBe('off');
    });
  });

  it('supports setup()/createMachine authored in TS', async () => {
    const tsMachine = `
      import { setup } from 'xstate';
      interface Ctx { count: number }
      export default setup({ types: { context: {} as Ctx } }).createMachine({
        id: 'counter',
        initial: 'idle',
        context: { count: 0 },
        states: { idle: { on: { GO: 'done' } }, done: { type: 'final' } },
      });
    `;
    await withSession({ code: tsMachine, lang: 'ts' }, async (session) => {
      const result = await session.evaluate(`
        import { createActor } from 'xstate';
        const actor = createActor(globalThis.__projection.module.default);
        actor.start();
        actor.send({ type: 'GO' });
        export default actor.getSnapshot().status;
      `);
      expect(result).toBe('done');
    });
  });
});

describe('tool-call bridging (S1)', () => {
  it('surfaces bridge calls to the host handler and marshals results back', async () => {
    const seen: SandboxToolCall[] = [];
    const code = `
      import { callTool } from '@astral-mcp/tools';
      export async function run() {
        return await callTool('search_issues', { label: 'bug', limit: 3 });
      }
      export default null;
    `;
    await withSession(
      {
        code,
        bridgeSource: BRIDGE_STUB,
        onToolCall: (call) => {
          seen.push(call);
          return { ok: true, result: { issues: ['#1', '#2'], forTool: call.name } };
        },
      },
      async (session) => {
        const result = await session.evaluate(
          `export default await globalThis.__projection.module.run();`,
        );
        expect(seen).toEqual([{ name: 'search_issues', args: { label: 'bug', limit: 3 } }]);
        expect(result).toEqual({
          ok: true,
          result: { issues: ['#1', '#2'], forTool: 'search_issues' },
        });
      },
    );
  });

  it('rejects the in-VM promise when the host handler throws', async () => {
    const code = `
      import { callTool } from '@astral-mcp/tools';
      export default null;
      export async function run() {
        try {
          await callTool('explode', {});
          return 'no-error';
        } catch (err) {
          return 'caught: ' + err.message;
        }
      }
    `;
    await withSession(
      {
        code,
        onToolCall: () => {
          throw new Error('upstream unavailable');
        },
      },
      async (session) => {
        const result = await session.evaluate(
          `export default await globalThis.__projection.module.run();`,
        );
        expect(result).toBe('caught: upstream unavailable');
      },
    );
  });
});

describe('isolation invariants (R11/N3, R9, S1)', () => {
  it('has no fetch global in the VM', async () => {
    await withSession({}, async (session) => {
      const result = await session.evaluate(
        `export default { direct: typeof fetch, viaGlobal: typeof globalThis.fetch };`,
      );
      expect(result).toEqual({ direct: 'undefined', viaGlobal: 'undefined' });
    });
  });

  it('does not leak host environment variables through process.env (S1)', async () => {
    // The QuickJS provider injects a `process` global whose `env` is the
    // tool-call binding object. If a provider change ever folded host env
    // into it, authored code would read secrets here. Plant a canary and
    // prove it stays on the host.
    const canary = 'PROJ_HOST_ENV_CANARY_9f13';
    process.env[canary] = 'leaked';
    try {
      await withSession({}, async (session) => {
        const result = await session.evaluate(
          `const p = globalThis.process;
           export default {
             hasProcess: typeof p,
             canary: p && p.env ? p.env[${JSON.stringify(canary)}] : 'no-env',
             envKeys: p && p.env ? Object.keys(p.env).sort() : [],
           };`,
        );
        const seen = result as { hasProcess: string; canary: unknown; envKeys: string[] };
        expect(seen.canary).toBeUndefined();
        // The only thing reachable through process.env is the I/O binding.
        expect(seen.envKeys).not.toContain('PATH');
        expect(seen.envKeys).not.toContain('HOME');
        expect(seen.envKeys).not.toContain(canary);
      });
    } finally {
      delete process.env[canary];
    }
  });

  it('rejects node:fs imports from authored code', async () => {
    const error = await createSandboxSession({
      code: `import fs from 'node:fs'; export default typeof fs;`,
      bridgeSource: BRIDGE_STUB,
      onToolCall: () => ({}),
    }).then(
      async (session) => {
        await session.dispose();
        return undefined;
      },
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ProjectionError);
    expect((error as ProjectionError).phase).toBe('validate');
    expect((error as ProjectionError).hint).toContain("'xstate'");
  });

  it('rejects every other import specifier (R8)', async () => {
    const errors = await Promise.all(
      ['node:child_process', 'left-pad', 'path'].map((specifier) =>
        createSandboxSession({
          code: `import x from '${specifier}'; export default typeof x;`,
          bridgeSource: BRIDGE_STUB,
          onToolCall: () => ({}),
        }).then(
          async (session) => {
            await session.dispose();
            return undefined;
          },
          (err: unknown) => err,
        ),
      ),
    );
    for (const error of errors) {
      expect(error).toBeInstanceOf(ProjectionError);
      expect((error as ProjectionError).phase).toBe('validate');
    }
  });
});

describe('error phases (R25)', () => {
  it('reports TS syntax errors as phase transpile with diagnostics', async () => {
    const error = await createSandboxSession({
      code: `const x: = broken syntax here ===`,
      lang: 'ts',
      bridgeSource: BRIDGE_STUB,
      onToolCall: () => ({}),
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ProjectionError);
    expect((error as ProjectionError).phase).toBe('transpile');
    expect((error as ProjectionError).diagnostics.length).toBeGreaterThan(0);
    expect((error as ProjectionError).hint.length).toBeGreaterThan(0);
  });

  it('reports JS syntax errors as phase validate', async () => {
    const error = await createSandboxSession({
      code: `export default function ( { broken`,
      bridgeSource: BRIDGE_STUB,
      onToolCall: () => ({}),
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ProjectionError);
    expect((error as ProjectionError).phase).toBe('validate');
  });

  it('reports top-level throws as phase runtime with logs attached', async () => {
    const error = await createSandboxSession({
      code: `console.log('before the crash'); throw new Error('boom');`,
      bridgeSource: BRIDGE_STUB,
      onToolCall: () => ({}),
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ProjectionError);
    const structured = (error as ProjectionError).toStructured();
    expect(structured.phase).toBe('runtime');
    expect(structured.message).toContain('boom');
    expect(structured.logs.map((l) => l.message)).toContain('before the crash');
  });

  it('rejects evaluate after dispose', async () => {
    const session = await createSandboxSession({
      code: `export default 1;`,
      bridgeSource: BRIDGE_STUB,
      onToolCall: () => ({}),
    });
    await session.dispose();
    await session.dispose(); // idempotent
    await expect(session.evaluate(`export default 2;`)).rejects.toMatchObject({
      phase: 'runtime',
    });
  });
});
