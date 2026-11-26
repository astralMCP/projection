/**
 * The Projection ablation modes, offline: each is `projection` with one
 * feature taken away through a public `WrapOptions` field, and each lists
 * the surface that leaves.
 */

import { describe, expect, it } from 'vitest';
import {
  openSession,
  openWorld,
  projectionWrapOptions,
  resolveModes,
  type EvalMode,
} from '../../src/index.js';

describe('ablation mode names', () => {
  it('resolve', () => {
    expect(
      resolveModes('projection-search,projection-nocode,projection-codeonly,projection-nopreamble'),
    ).toHaveLength(4);
  });
});

describe('Projection ablations', () => {
  it('each wraps with one public option', () => {
    expect(projectionWrapOptions('projection')).toEqual({});
    expect(projectionWrapOptions('projection-search')).toEqual({ projections: { direct: false } });
    expect(projectionWrapOptions('projection-nocode')).toEqual({
      projections: { codeMode: false },
    });
    expect(projectionWrapOptions('projection-codeonly')).toEqual({
      projections: { catalog: false },
    });
    expect(projectionWrapOptions('projection-nopreamble')).toEqual({ codeModePreamble: '' });
    expect(projectionWrapOptions('projection-psychoscript')).toEqual({
      codeRuntime: 'psychoscript',
    });
  });

  it('lists the surface each ablation leaves (workplace world)', async () => {
    const surfaces: Record<string, { tools: string[]; system: string }> = {};
    for (const mode of [
      'projection',
      'projection-search',
      'projection-nocode',
      'projection-codeonly',
      'projection-nopreamble',
    ] as EvalMode[]) {
      const world = await openWorld('workplace');
      const session = await openSession(mode, world, {});
      try {
        surfaces[mode] = {
          tools: session.runtime.tools.map((t) => t.name),
          system: session.runtime.system,
        };
      } finally {
        await session.close();
        await world.close();
      }
    }
    const has = (mode: string, tool: string): boolean =>
      surfaces[mode]?.tools.includes(tool) ?? false;
    expect(has('projection-search', 'search_tools')).toBe(true);
    expect(has('projection-search', 'execute_machine')).toBe(true);
    expect(has('projection-nocode', 'execute_machine')).toBe(false);
    expect(has('projection-nocode', 'call_tool')).toBe(true);
    expect(has('projection-codeonly', 'execute_machine')).toBe(true);
    expect(has('projection-codeonly', 'call_tool')).toBe(false);
    expect(surfaces['projection-nopreamble']?.tools).toEqual(surfaces['projection']?.tools);
    expect(
      (surfaces['projection-nopreamble']?.system.length ?? 0) <
        (surfaces['projection']?.system.length ?? 0),
    ).toBe(true);
  }, 120_000);
});

describe('ablations on a single-server facade', () => {
  it('nopreamble drops the routing copy; codeonly drops the catalog', async () => {
    const open = async (mode: EvalMode) => {
      const world = await openWorld('github');
      const session = await openSession(mode, world);
      const view = {
        tools: session.runtime.tools.map((t) => t.name),
        system: session.runtime.system,
      };
      await session.close();
      await world.close();
      return view;
    };
    const full = await open('projection-search');
    const bare = await open('projection-nopreamble');
    const code = await open('projection-codeonly');
    expect(full.system).toContain('execute_machine');
    expect(bare.system).not.toContain('execute_machine');
    expect(code.tools).toEqual(expect.arrayContaining(['execute_machine', 'discover_apis']));
    expect(code.tools).not.toContain('call_tool');
  });
});

describe('projection-psychoscript: the projection surface on the experimental program runtime', () => {
  it('lists the same tools, teaches programs, and runs one over the GitHub fake', async () => {
    const open = async (mode: EvalMode) => {
      const world = await openWorld('github');
      return { world, session: await openSession(mode, world) };
    };
    const machines = await open('projection');
    const programs = await open('projection-psychoscript');
    try {
      expect(programs.session.runtime.tools.map((t) => t.name)).toEqual(
        machines.session.runtime.tools.map((t) => t.name),
      );
      expect(programs.session.runtime.system).toContain('JavaScript program');
      expect(programs.session.runtime.system).not.toContain('XState');
      const execute = programs.session.runtime.tools.find((t) => t.name === 'execute_machine');
      expect(execute?.description).toContain('await tools.<tool>(args)');

      const discovered = await programs.session.runtime.call('discover_apis', {});
      expect(discovered.text).toContain('plain JavaScript PROGRAM');

      const code = `
const page = await tools.list_issues({ owner: 'modelcontextprotocol', repo: 'servers', state: 'OPEN' })
return { count: Array.isArray(page?.issues) ? page.issues.length : -1 }
`;
      const ran = await programs.session.runtime.call('execute_machine', { code });
      expect(ran.isError, ran.text).not.toBe(true);
      expect(ran.text).toMatch(/"count":\s*\d+/);
      expect(programs.world.calls.map((c) => c.tool)).toContain('list_issues');
    } finally {
      for (const { session, world } of [machines, programs]) {
        await session.close();
        await world.close();
      }
    }
  });
});
