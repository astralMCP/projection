import { describe, expect, it } from 'vitest';
import { generateToolTypes } from '../../src/typegen/index.js';
import type { ServerCatalog, ToolCatalogEntry } from '../../src/types.js';

function tool(overrides: Partial<ToolCatalogEntry> = {}): ToolCatalogEntry {
  return { name: 'read_file', inputSchema: { type: 'object' }, ...overrides };
}

function catalog(overrides: Partial<ServerCatalog> = {}): ServerCatalog {
  return {
    alias: 'default',
    identity: 'files@1.0.0',
    tools: [tool()],
    ...overrides,
  };
}

/** Import a generated bridge module and return its `tools` export. */
async function loadBridge(source: string): Promise<Record<string, unknown>> {
  const url = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  const mod = (await import(/* @vite-ignore */ url)) as { tools: Record<string, unknown> };
  return mod.tools;
}

describe('hostile wrapped server (S5)', () => {
  it('cannot inject executable statements into the bridge via server identity', async () => {
    const evil = catalog({ identity: 'evil\nglobalThis.__PWNED__ = 1;//@1.0.0' });
    const { bridgeSource } = generateToolTypes(evil);

    // The injected statement must not survive as its own source line.
    for (const line of bridgeSource.split('\n')) {
      if (line.includes('__PWNED__')) {
        expect(line.startsWith('//')).toBe(true);
      }
    }
    delete (globalThis as Record<string, unknown>)['__PWNED__'];
    await loadBridge(bridgeSource);
    expect((globalThis as Record<string, unknown>)['__PWNED__']).toBeUndefined();
  });

  it('cannot inject top-level declarations into the .d.ts via server identity', () => {
    const { dts } = generateToolTypes(
      catalog({ identity: 'x\nexport const backdoor = 1;\n//@1.0.0' }),
    );
    expect(dts.split('\n')).not.toContain('export const backdoor = 1;');
  });

  it('caps an oversized server identity', () => {
    const { dts, bridgeSource } = generateToolTypes(catalog({ identity: 'z'.repeat(10_000) }));
    for (const source of [dts, bridgeSource]) {
      const header = source.split('\n').find((l) => l.includes('wrapped server'));
      expect(header).toBeDefined();
      expect((header as string).length).toBeLessThan(400);
    }
  });

  it('keeps a __proto__-named tool callable and enumerable in the bridge', async () => {
    const { bridgeSource } = generateToolTypes(
      catalog({ tools: [tool({ name: '__proto__' }), tool({ name: 'read_file' })] }),
    );
    const tools = await loadBridge(bridgeSource);
    expect(typeof tools).toBe('object');
    expect(Object.keys(tools).sort()).toEqual(['__proto__', 'read_file']);
    expect(typeof tools['__proto__']).toBe('function');
    // A fresh object is untouched: no prototype pollution.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('collapses duplicate tool names so types and bridge agree', async () => {
    const { dts, bridgeSource } = generateToolTypes(
      catalog({
        tools: [
          tool({ name: 'run', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } }),
          tool({ name: 'run', inputSchema: { type: 'object', properties: { b: { type: 'number' } } } }),
        ],
      }),
    );
    expect(dts.split('\n').filter((l) => l.trim().startsWith('run:'))).toHaveLength(1);
    const tools = await loadBridge(bridgeSource);
    expect(Object.keys(tools)).toEqual(['run']);
  });
});
