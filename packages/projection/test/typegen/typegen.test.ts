import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { describeTool, type ToolDescription } from '../../src/catalog/index.js';
import {
  generateToolTypes,
  TOOL_CALL_HOST_GLOBAL,
  TOOLS_MODULE_SPECIFIER,
} from '../../src/typegen/index.js';
import { schemaToTsType } from '../../src/typegen/json-schema.js';
import type { PolicyOverrides, ServerAlias, ServerCatalog, ToolCatalog } from '../../src/types.js';
import { fixtureCatalog } from './fixture.js';

const generated = generateToolTypes(fixtureCatalog);

/**
 * Golden-file assertion (PRD M1). Regenerate with:
 *   UPDATE_GOLDEN=1 pnpm exec vitest run test/typegen
 * The golden .d.ts lives inside `test/` and is therefore typechecked by
 * `tsc --noEmit`, so it must stay valid strict TypeScript.
 */
function expectGolden(name: string, actual: string): void {
  const path = fileURLToPath(new URL(`./__golden__/${name}`, import.meta.url));
  if (process.env['UPDATE_GOLDEN'] !== undefined) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual);
  }
  expect(actual).toBe(readFileSync(path, 'utf8'));
}

describe('generateToolTypes — .d.ts output', () => {
  it('matches the golden file', () => {
    expectGolden('tools.d.ts', generated.dts);
  });

  it('accepts a full single-server ToolCatalog (R30 interface shape)', () => {
    const catalog: ToolCatalog = {
      servers: new Map<ServerAlias, ServerCatalog>([['default', fixtureCatalog]]),
    };
    expect(generateToolTypes(catalog)).toEqual(generated);
  });

  it('rejects a multi-server catalog with a v1 hint', () => {
    const catalog: ToolCatalog = {
      servers: new Map<ServerAlias, ServerCatalog>([
        ['a', fixtureCatalog],
        ['b', { ...fixtureCatalog, alias: 'b' }],
      ]),
    };
    expect(() => generateToolTypes(catalog)).toThrowError(/exactly one wrapped server/);
  });

  it('quotes weird tool names and sanitizes their type names', () => {
    expect(generated.dts).toContain('"create-ticket!": (args: CreateTicketInput)');
    expect(generated.dts).toContain('"123 spaced name": (args?: Tool123SpacedNameInput)');
  });

  it('marks argument-less tools with an optional parameter', () => {
    expect(generated.dts).toContain('noargs: (args?: NoargsInput) => Promise<unknown>;');
  });

  it('handles an empty catalog', () => {
    const empty = generateToolTypes({ alias: 'default', identity: 'empty@0.0.0', tools: [] });
    expect(empty.dts).toContain('export declare const tools: Record<string, never>;');
    expect(empty.overview).toContain('(none)');
  });
});

describe('generateToolTypes — runtime bridge', () => {
  const hookProperty = TOOL_CALL_HOST_GLOBAL as '__projection_toolcall';

  async function importBridge(): Promise<Record<string, (args?: unknown) => unknown>> {
    const url = `data:text/javascript;base64,${Buffer.from(generated.bridgeSource).toString('base64')}`;
    const module = (await import(url)) as { tools: Record<string, (args?: unknown) => unknown> };
    return module.tools;
  }

  it('matches the golden file', () => {
    expectGolden('bridge.mjs', generated.bridgeSource);
  });

  it('is dependency-free (no imports) and documents the host hook', () => {
    expect(generated.bridgeSource).not.toMatch(/^\s*import\s/m);
    expect(generated.bridgeSource).not.toMatch(/\brequire\s*\(/);
    expect(generated.bridgeSource).toContain(TOOL_CALL_HOST_GLOBAL);
    expect(generated.bridgeSource).toContain(TOOLS_MODULE_SPECIFIER);
  });

  it('is syntactically valid ESM exposing one function per tool', async () => {
    const tools = await importBridge();
    expect(Object.keys(tools)).toEqual([
      'get_weather',
      'create-ticket!',
      'search',
      'noargs',
      '123 spaced name',
    ]);
    for (const fn of Object.values(tools)) {
      expect(typeof fn).toBe('function');
    }
    expect(Object.isFrozen(tools)).toBe(true);
  });

  it('routes calls through the injected host global with the exact tool name', async () => {
    const tools = await importBridge();
    const calls: [string, unknown][] = [];
    (globalThis as Record<string, unknown>)[hookProperty] = (name: string, args: unknown) => {
      calls.push([name, args]);
      return 'handle-1';
    };
    try {
      expect(tools['get_weather']?.({ city: 'Oslo' })).toBe('handle-1');
      expect(tools['create-ticket!']?.({ ticket: { title: 't' } })).toBe('handle-1');
      expect(tools['noargs']?.()).toBe('handle-1');
      expect(calls).toEqual([
        ['get_weather', { city: 'Oslo' }],
        ['create-ticket!', { ticket: { title: 't' } }],
        ['noargs', {}],
      ]);
    } finally {
      delete (globalThis as Record<string, unknown>)[hookProperty];
    }
  });

  it('throws a clear error when the host hook is missing', async () => {
    const tools = await importBridge();
    expect(() => tools['get_weather']?.({ city: 'Oslo' })).toThrowError(
      new RegExp(TOOL_CALL_HOST_GLOBAL),
    );
  });
});

describe('generateToolTypes — overview block', () => {
  it('matches the golden file', () => {
    expectGolden('overview.txt', generated.overview);
  });

  it('lists every tool with a read-only/approval flag on one line', () => {
    expect(generated.overview).toContain(
      '- get_weather [runs immediately] — Get the current weather',
    );
    expect(generated.overview).toContain(
      '- create-ticket! [asks for approval, destructive] — Create a ticket.',
    );
    expect(generated.overview).toContain('- search [asks for approval] —');
    expect(generated.overview).toContain(
      '- 123 spaced name [asks for approval] — (no description)',
    );
  });
});

describe('generateToolTypes — policy overrides (R14, R33)', () => {
  const policy: PolicyOverrides = { get_weather: 'deny' };
  const denied = generateToolTypes(fixtureCatalog, { policy });

  it('a deny override reads "blocked by policy" in the overview and the .d.ts', () => {
    expect(denied.overview).toContain(
      '- get_weather [blocked by policy] — Get the current weather for a city.',
    );
    expect(denied.dts).toContain('Blocked by policy: calls to this tool are refused.');
    expect(denied.toolTypes.get('get_weather')?.dts).toContain('Blocked by policy:');
  });

  it('describe_tool, the overview flag and the per-tool .d.ts slice agree on the posture', () => {
    const described = describeTool(fixtureCatalog, { name: 'get_weather' }, { policy })
      .structuredContent as ToolDescription;
    expect(described.posture).toBe('blocked by policy');
    const overviewLine = denied.overview.split('\n').find((l) => l.startsWith('- get_weather '));
    expect(overviewLine).toContain(`[${described.posture}]`);
    // The doc comment leads with the same words, in sentence case.
    const sentenceCase = `${described.posture[0]?.toUpperCase() ?? ''}${described.posture.slice(1)}:`;
    expect(denied.toolTypes.get('get_weather')?.dts).toContain(sentenceCase);
  });

  it('keeps the destructive marker on every posture', () => {
    for (const [decision, lead] of [
      ['auto', 'Runs immediately'],
      ['ask', 'Asks for approval'],
      ['deny', 'Blocked by policy'],
    ] as const) {
      const { toolTypes } = generateToolTypes(fixtureCatalog, {
        policy: { 'create-ticket!': decision },
      });
      const slice = toolTypes.get('create-ticket!')?.dts ?? '';
      expect(slice, decision).toMatch(
        new RegExp(`${lead}: [^\\n]*\\. The server marks this tool destructive\\.`),
      );
    }
  });
});

describe('generateToolTypes — approvals mode (R49)', () => {
  it("'every-write' is byte-identical to the default, so every golden stands", () => {
    expect(generateToolTypes(fixtureCatalog, { approvals: 'every-write' })).toEqual(generated);
  });

  it("'destructive-only' changes nothing for a catalog with no destructiveHint: false tool", () => {
    // The fixture's writes are unannotated or destructiveHint: true: both still ask.
    expect(generateToolTypes(fixtureCatalog, { approvals: 'destructive-only' })).toEqual(generated);
  });

  it("'destructive-only' flips only an explicit destructiveHint: false write, in the .d.ts and the overview", () => {
    const catalog: ServerCatalog = {
      ...fixtureCatalog,
      tools: [
        ...fixtureCatalog.tools,
        {
          name: 'touch',
          description: 'Update a timestamp.',
          inputSchema: { type: 'object' },
          annotations: { destructiveHint: false },
        },
      ],
    };
    const every = generateToolTypes(catalog);
    const relaxed = generateToolTypes(catalog, { approvals: 'destructive-only' });
    expect(every.overview).toContain('- touch [asks for approval] — Update a timestamp.');
    expect(relaxed.overview).toContain('- touch [runs immediately] — Update a timestamp.');
    expect(every.toolTypes.get('touch')?.dts).toContain('Asks for approval:');
    expect(relaxed.toolTypes.get('touch')?.dts).toContain('Runs immediately:');
    expect(relaxed.dts).toContain('Runs immediately: no user approval required.');
    // Every other tool reads the same in both modes.
    for (const tool of fixtureCatalog.tools) {
      expect(relaxed.toolTypes.get(tool.name)?.dts).toBe(every.toolTypes.get(tool.name)?.dts);
    }
    // A per-tool override still wins over the mode.
    const pinned = generateToolTypes(catalog, {
      approvals: 'destructive-only',
      policy: { touch: 'ask' },
    });
    expect(pinned.overview).toContain('- touch [asks for approval] —');
  });
});

describe('schemaToTsType — converter edge cases', () => {
  it('degrades unsupported constructs to unknown', () => {
    expect(schemaToTsType({ not: { type: 'string' } })).toBe('unknown');
    expect(schemaToTsType('nonsense')).toBe('unknown');
    expect(schemaToTsType(true)).toBe('unknown');
    expect(schemaToTsType(false)).toBe('never');
    expect(schemaToTsType({ type: 'quaternion' })).toBe('unknown');
  });

  it('handles primitives, enums, and const', () => {
    expect(schemaToTsType({ type: 'integer' })).toBe('number');
    expect(schemaToTsType({ enum: ['a', 1, null] })).toBe('"a" | 1 | null');
    expect(schemaToTsType({ const: 'fixed' })).toBe('"fixed"');
    expect(schemaToTsType({ type: ['string', 'null'] })).toBe('string | null');
  });

  it('handles arrays, tuples, and unions of objects', () => {
    expect(schemaToTsType({ type: 'array', items: { type: 'string' } })).toBe('string[]');
    expect(
      schemaToTsType({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } }),
    ).toBe('Array<string | number>');
    expect(
      schemaToTsType({ type: 'array', prefixItems: [{ type: 'number' }, { type: 'string' }] }),
    ).toBe('[number, string]');
  });

  it('handles allOf as an intersection', () => {
    expect(
      schemaToTsType({
        allOf: [{ type: 'string' }, { anyOf: [{ type: 'number' }, { type: 'boolean' }] }],
      }),
    ).toBe('string & (number | boolean)');
  });

  it('resolves in-document $refs and breaks cycles with unknown', () => {
    const schema = {
      type: 'object',
      properties: { node: { $ref: '#/$defs/Node' } },
      $defs: {
        Node: {
          type: 'object',
          properties: { next: { $ref: '#/$defs/Node' } },
        },
      },
    };
    const rendered = schemaToTsType(schema);
    expect(rendered).toContain('node?: {');
    expect(rendered).toContain('next?: unknown;');
    expect(schemaToTsType({ $ref: '#/nowhere' })).toBe('unknown');
  });

  it('handles additionalProperties variants', () => {
    expect(schemaToTsType({ type: 'object' })).toBe('Record<string, unknown>');
    expect(schemaToTsType({ type: 'object', additionalProperties: false })).toBe(
      'Record<string, never>',
    );
    expect(schemaToTsType({ type: 'object', additionalProperties: { type: 'number' } })).toBe(
      'Record<string, number>',
    );
    expect(
      schemaToTsType({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
        additionalProperties: { type: 'string' },
      }),
    ).toContain('& Record<string, string>');
  });
});
