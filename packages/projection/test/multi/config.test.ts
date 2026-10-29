/**
 * `wrapMcpServers` configuration (PRD R39, R42, R48, R49): every mistake is
 * a `validate` error raised before any source is connected.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import {
  ProjectionError,
  wrapMcpServers,
  type ServerSourceConfig,
  type WrapServersOptions,
} from '../../src/index.js';
import { fsServer, githubServer, KEY, type RecordedCall } from './helpers.js';

const options: WrapServersOptions = { blob: { key: KEY } };

/** The wrap error, asserting it is a `validate` ProjectionError. */
async function validateError(
  sources: unknown,
  extra: Partial<WrapServersOptions> = {},
): Promise<ProjectionError> {
  let caught: unknown;
  try {
    await wrapMcpServers(sources as Record<string, McpServer>, { ...options, ...extra });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ProjectionError);
  expect((caught as ProjectionError).phase).toBe('validate');
  return caught as ProjectionError;
}

describe('source discrimination and settings (R39)', () => {
  it('accepts McpServer instances and { source } configurations side by side', async () => {
    const log: RecordedCall[] = [];
    const facade = await wrapMcpServers(
      {
        fs: fsServer(log),
        github: { source: githubServer(log), description: 'Issues and pull requests.' },
      },
      options,
    );
    expect([...facade.catalog.servers.keys()].toSorted()).toEqual(['fs', 'github']);
    expect(facade.skipped).toEqual([]);
    await facade.close();
  });

  it('rejects a source that is neither a server, a client nor a configuration', async () => {
    const error = await validateError({ fs: { path: '/tmp' } });
    expect(error.message).toContain('not an McpServer, a Client or a { source } configuration');
    await validateError({ fs: null });
    await validateError({ fs: 'files' });
  });

  it('rejects an unknown configuration key, so a misspelt setting is never dropped', async () => {
    const server = fsServer([]);
    const error = await validateError({ fs: { source: server, aprovals: 'destructive-only' } });
    expect(error.message).toContain('unknown setting "aprovals"');
    expect(server.isConnected()).toBe(false);
  });

  it('rejects a configuration whose source is not a server, or is itself a configuration', async () => {
    await validateError({ fs: { source: {} } });
    await validateError({ fs: { source: { source: fsServer([]) } } });
  });

  it('rejects a non-string description, and neutralizes and caps a string one', async () => {
    await validateError({ fs: { source: fsServer([]), description: 42 } });
    const facade = await wrapMcpServers(
      { fs: { source: fsServer([]), description: `Files‮\nand ${'x'.repeat(300)}` } },
      options,
    );
    const shelfLine = facade.instructions.split('\n').find((line) => line.startsWith('- fs'));
    expect(shelfLine).toBeDefined();
    expect(shelfLine).not.toContain('‮');
    expect(shelfLine).toContain('Files��and');
    // 200 characters plus the ellipsis, then the tool count.
    expect(shelfLine).toMatch(/x…\s\(3 tools\)$/);
    expect(shelfLine?.length).toBeLessThan(230);
    await facade.close();
  });

  it('rejects a malformed per-source approvals mode', async () => {
    const error = await validateError({ fs: { source: fsServer([]), approvals: 'never' } });
    expect(error.message).toContain('source "fs"');
    expect(error.message).toContain('approvals');
  });

  it('rejects optional sources, which are not supported yet (R47)', async () => {
    const error = await validateError({ fs: { source: fsServer([]), optional: true } });
    expect(error.message).toContain('optional sources are not supported yet');
    await validateError({ fs: { source: fsServer([]), optional: 'yes' } });
    // `optional: false` is the default behaviour and is accepted.
    const facade = await wrapMcpServers(
      { fs: { source: fsServer([]), optional: false } satisfies ServerSourceConfig },
      options,
    );
    await facade.close();
  });

  it('rejects the same source under two aliases, directly or through a configuration', async () => {
    const server = fsServer([]);
    expect((await validateError({ a: server, b: server })).message).toContain('two aliases');
    expect((await validateError({ a: server, b: { source: server } })).message).toContain(
      'two aliases',
    );
    expect(server.isConnected()).toBe(false);
  });

  it('rejects anything but a record of sources', async () => {
    await validateError([fsServer([])]);
    await validateError(null);
    await validateError(new Map([['fs', fsServer([])]]));
  });
});

describe('aliases (R39, R48)', () => {
  it.each([
    ['Fs', 'uppercase'],
    ['my_fs', 'underscore'],
    ['my.fs', 'dot'],
    ['my-fs', 'dash'],
    ['1fs', 'leading digit'],
    ['a'.repeat(25), 'longer than 24 characters'],
    ['', 'empty'],
  ])('rejects %j (%s)', async (alias) => {
    const error = await validateError({ [alias]: fsServer([]) });
    expect(error.message).toContain('is not valid');
  });

  it.each(['default', 'tools'])('rejects the reserved alias %j', async (alias) => {
    const error = await validateError({ [alias]: fsServer([]) });
    expect(error.message).toContain('reserved');
  });

  it('accepts a 24-character alias and a JS reserved word', async () => {
    const facade = await wrapMcpServers(
      { ['a'.repeat(24)]: fsServer([]), delete: githubServer([]) },
      options,
    );
    expect([...facade.catalog.servers.keys()].toSorted()).toEqual(['a'.repeat(24), 'delete']);
    await facade.close();
  });

  it('takes 1 to 16 sources', async () => {
    expect((await validateError({})).message).toContain('at least one source');
    const seventeen = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`s${i}`, fsServer([])]),
    );
    expect((await validateError(seventeen)).message).toContain('at most 16 sources');
    const sixteen = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`s${i}`, fsServer([])]),
    );
    const facade = await wrapMcpServers(sixteen, options);
    expect(facade.catalog.servers.size).toBe(16);
    await facade.close();
  });
});

describe('facade policy keys (R42)', () => {
  it('rejects an unqualified key', async () => {
    const error = await validateError({ fs: fsServer([]) }, { policy: { write_file: 'deny' } });
    expect(error.message).toContain('not a qualified tool name');
  });

  it('rejects a key whose alias names no configured source', async () => {
    const server = fsServer([]);
    const error = await validateError({ fs: server }, { policy: { 'fss.write_file': 'deny' } });
    expect(error.message).toContain('names no configured source "fss"');
    expect(server.isConnected()).toBe(false);
  });

  it('ignores a key naming an unknown tool in a known box', async () => {
    const facade = await wrapMcpServers(
      { fs: fsServer([]) },
      { ...options, policy: { 'fs.no_such_tool': 'deny' } },
    );
    await facade.close();
  });
});

describe('facade options', () => {
  it('rejects a malformed global approvals mode (R49)', async () => {
    await validateError({ fs: fsServer([]) }, {
      approvals: 'sometimes',
    } as unknown as Partial<WrapServersOptions>);
  });

  it('accepts catalog.globalSearch either way and rejects unknown catalog keys or non-booleans (R43)', async () => {
    await validateError({ fs: fsServer([]) }, {
      catalog: { global: true },
    } as unknown as Partial<WrapServersOptions>);
    await validateError({ fs: fsServer([]) }, {
      catalog: { globalSearch: 'no' },
    } as unknown as Partial<WrapServersOptions>);
    const facades = await Promise.all(
      [true, false].map((globalSearch) =>
        wrapMcpServers({ fs: fsServer([]) }, { ...options, catalog: { globalSearch } }),
      ),
    );
    await Promise.all(facades.map((facade) => facade.close()));
  });

  it('defaults code mode off (R45, not served yet) and refuses an explicit request for it', async () => {
    const error = await validateError({ fs: fsServer([]) }, { projections: { codeMode: true } });
    expect(error.message).toContain('code mode is not supported on multi-server facades yet');

    const facade = await wrapMcpServers({ fs: fsServer([]) }, options);
    expect(facade.projections).toEqual({ codeMode: false, catalog: true });
    expect(structuredPhase(facade.discoverApis())).toBe('validate');
    expect(structuredPhase(await facade.executeMachine({ code: '' }))).toBe('validate');
    await facade.close();
  });

  it('refuses turning the catalog projection off, the only one served yet (R1, R45)', async () => {
    const server = fsServer([]);
    const error = await validateError({ fs: server }, { projections: { catalog: false } });
    expect(error.message).toContain('the catalog projection is required on multi-server facades');
    expect(error.hint).toContain('Omit projections.catalog');
    expect(server.isConnected()).toBe(false);
  });

  it('requires options with blob.key, before anything connects', async () => {
    const server = fsServer([]);
    const outcomes = await Promise.allSettled(
      [undefined, {}, { blob: {} }].map((missing) =>
        wrapMcpServers({ fs: server }, missing as unknown as WrapServersOptions),
      ),
    );
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      const caught: unknown = outcome.status === 'rejected' ? outcome.reason : undefined;
      expect(caught).toBeInstanceOf(ProjectionError);
      expect((caught as ProjectionError).phase).toBe('validate');
      expect((caught as ProjectionError).message).toContain('blob.key');
    }
    expect(server.isConnected()).toBe(false);
  });
});

describe('limits (R48)', () => {
  it('fails the wrap with a protocol error over 4000 tools in total, closing every connection', async () => {
    const servers = [0, 1, 2].map((i) => fsServer([], many(`t${i}`)));
    let caught: unknown;
    try {
      await wrapMcpServers({ a: servers[0]!, b: servers[1]!, c: servers[2]! }, options);
    } catch (err) {
      caught = err;
    }
    expect((caught as ProjectionError).phase).toBe('protocol');
    expect((caught as ProjectionError).message).toContain('over the facade limit of 4000');
    for (const server of servers) expect(server.isConnected()).toBe(false);
  });
});

/** 1,400 read-only tools named `<prefix>_<i>`. */
function many(prefix: string): { name: string; readOnly: boolean }[] {
  return Array.from({ length: 1_400 }, (_, i) => ({ name: `${prefix}_${i}`, readOnly: true }));
}

function structuredPhase(result: object): unknown {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent?.['phase'];
}
