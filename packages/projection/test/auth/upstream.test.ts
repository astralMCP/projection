/**
 * `UpstreamSpec` validation, canonical URLs and identity (PRD R51, R60),
 * and how the facades discriminate a `{ url }` source from the other kinds
 * (R39, R51) — all before anything connects.
 */

import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import {
  MemoryTokenStore,
  ProjectionError,
  wrapMcpServer,
  wrapMcpServers,
} from '../../src/index.js';
import { isUpstreamSpecShape, resolveUpstreamSpec } from '../../src/auth/index.js';

const KEY = new Uint8Array(32).fill(3);

function validateError(run: () => unknown): ProjectionError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(ProjectionError);
    expect((err as ProjectionError).phase).toBe('validate');
    return err as ProjectionError;
  }
  throw new Error('expected a validate error');
}

const resolve = (url: unknown, oauth?: unknown) =>
  resolveUpstreamSpec(oauth === undefined ? { url } : { url, oauth }, 'the source');

describe('URL rules (R51)', () => {
  it.each([
    ['https://api.example.com/mcp', 'https://api.example.com/mcp'],
    ['HTTPS://API.Example.COM/mcp', 'https://api.example.com/mcp'],
    ['https://api.example.com:443/mcp', 'https://api.example.com/mcp'],
    ['https://api.example.com:8443/mcp', 'https://api.example.com:8443/mcp'],
    ['https://api.example.com', 'https://api.example.com/'],
    ['https://api.example.com/mcp/', 'https://api.example.com/mcp/'],
    ['https://api.example.com/mcp?tenant=a', 'https://api.example.com/mcp?tenant=a'],
    ['https://api.example.com/u@ser/mcp?who=a@b', 'https://api.example.com/u%40ser/mcp?who=a%40b'],
    ['http://127.0.0.1:3000/mcp', 'http://127.0.0.1:3000/mcp'],
    ['http://localhost/mcp', 'http://localhost/mcp'],
    ['http://[::1]:8080/mcp', 'http://[::1]:8080/mcp'],
    ['https://bücher.example/mcp', 'https://xn--bcher-kva.example/mcp'],
  ])('%s canonicalizes to %s', (input, canonical) => {
    const resolved = resolve(input);
    expect(resolved.canonicalUrl).toBe(canonical);
    expect(resolved.identity).toBe(`url:${canonical}`);
    // R60: a URL identity never contains "@", so it never equals a name@version.
    expect(resolved.identity).not.toContain('@');
  });

  it('accepts a URL object', () => {
    expect(resolve(new URL('https://api.example.com/mcp')).canonicalUrl).toBe(
      'https://api.example.com/mcp',
    );
  });

  it.each([
    ['http://api.example.com/mcp', /https:/],
    ['http://127.0.0.2/mcp', /https:/],
    ['ftp://api.example.com/mcp', /https:/],
    ['ws://localhost/mcp', /https:/],
    ['https://user:SECRET-PASSWORD@api.example.com/mcp', /credentials/],
    ['https://token@api.example.com/mcp', /credentials/],
    ['https://api.example.com/mcp#frag', /fragment/],
    ['https://api.example.com/mcp#', /fragment/],
    ['not a url', /valid absolute URL/],
    ['/relative/mcp', /valid absolute URL/],
  ])('%s is a validate error', (input, message) => {
    const err = validateError(() => resolve(input));
    expect(err.message).toMatch(message);
    // A credential in the URL never reaches the message.
    expect(`${err.message} ${err.hint}`).not.toContain('SECRET-PASSWORD');
  });

  it('rejects a non-string url and unknown keys', () => {
    validateError(() => resolve(42));
    validateError(() => resolveUpstreamSpec({ url: 'https://a.example/', headers: {} }, 'x'));
  });
});

describe('oauth options (R51)', () => {
  const url = 'https://api.example.com/mcp';

  it('accepts the phase-1 settings and freezes them', () => {
    const resolved = resolve(url, {
      clientId: 'abc',
      clientSecret: 'shh',
      scopes: ['repo', 'read:org', 'repo'],
      signInHosts: ['accounts.example.com', 'xn--bcher-kva.example'],
      tokenEndpoint: 'https://login.example.com/token',
      deviceAuthorizationEndpoint: 'https://login.example.com/device',
    });
    expect(resolved.oauth).toEqual({
      clientId: 'abc',
      clientSecret: 'shh',
      scopes: ['repo', 'read:org'],
      signInHosts: ['accounts.example.com', 'xn--bcher-kva.example'],
      tokenEndpoint: 'https://login.example.com/token',
      deviceAuthorizationEndpoint: 'https://login.example.com/device',
    });
    expect(Object.isFrozen(resolved.oauth)).toBe(true);
  });

  it.each([
    [{}, /clientId/],
    [{ clientId: '' }, /clientId/],
    [{ clientId: 'a', extra: 1 }, /unknown setting/],
    [{ clientId: 'a', clientMetadataUrl: 'https://x.example/cimd' }, /not supported yet/],
    [{ clientId: 'a', authorizationEndpoint: 'https://x.example/authorize' }, /not supported yet/],
    [{ clientId: 'a', tokenEndpoint: 'http://login.example.com/token' }, /https:/],
    [{ clientId: 'a', tokenEndpoint: 'http://127.0.0.1/token' }, /https:/],
    [{ clientId: 'a', deviceAuthorizationEndpoint: 'nope' }, /valid absolute URL/],
    [{ clientId: 'a', scopes: 'repo' }, /array/],
    [{ clientId: 'a', scopes: ['has space'] }, /invalid entry/],
    [{ clientId: 'a', signInHosts: ['https://accounts.example.com'] }, /invalid entry/],
    [{ clientId: 'a', signInHosts: ['Accounts.example.com'] }, /invalid entry/],
    [{ clientId: 'a', signInHosts: ['*.example.com'] }, /invalid entry/],
    [{ clientId: 'a', signInHosts: ['example.com:443'] }, /invalid entry/],
    [{ clientId: 'a', clientSecret: 42 }, /clientSecret/],
    ['oauth', /must be an object/],
  ])('%j is a validate error', (oauth, message) => {
    expect(validateError(() => resolve(url, oauth)).message).toMatch(message);
  });

  it('never quotes the client secret', () => {
    const err = validateError(() =>
      resolve(url, { clientId: 'a', clientSecret: 'SECRET-VALUE', scopes: ['bad scope'] }),
    );
    expect(`${err.message} ${err.hint}`).not.toContain('SECRET-VALUE');
  });

  it('allows a loopback http endpoint only for a loopback source', () => {
    expect(
      resolve('http://127.0.0.1:9/mcp', {
        clientId: 'a',
        tokenEndpoint: 'http://127.0.0.1:9/token',
      }).oauth?.tokenEndpoint,
    ).toBe('http://127.0.0.1:9/token');
    validateError(() => resolve(url, { clientId: 'a', tokenEndpoint: 'http://localhost/token' }));
  });
});

describe('source discrimination (R39, R51)', () => {
  it('a plain object with own url, no own source and no connect/callTool is an UpstreamSpec', () => {
    expect(isUpstreamSpecShape({ url: 'https://a.example/' })).toBe(true);
    expect(isUpstreamSpecShape({ url: 'x', source: {} })).toBe(false);
    expect(isUpstreamSpecShape({ url: 'x', connect() {} })).toBe(false);
    expect(isUpstreamSpecShape({ url: 'x', callTool() {} })).toBe(false);
    expect(isUpstreamSpecShape(Object.create({ url: 'x' }))).toBe(false);
    expect(isUpstreamSpecShape(new McpServer({ name: 'n', version: '1' }))).toBe(false);
  });

  it('wrapMcpServer validates a URL source before connecting', async () => {
    await expect(
      wrapMcpServer({ url: 'http://api.example.com/mcp' }, { blob: { key: KEY } }),
    ).rejects.toMatchObject({ phase: 'validate' });
    await expect(
      wrapMcpServer({ url: 'https://api.example.com/mcp', token: 'x' } as never, {
        blob: { key: KEY },
      }),
    ).rejects.toMatchObject({ phase: 'validate' });
  });

  it('rejects a tokenStore without get/set/delete', async () => {
    await expect(
      wrapMcpServer(
        { url: 'https://api.example.com/mcp' },
        { blob: { key: KEY }, tokenStore: { get: () => undefined } as never },
      ),
    ).rejects.toMatchObject({ phase: 'validate' });
  });

  it('wrapMcpServers rejects two sources with the same canonical URL, before connecting', async () => {
    const err = await wrapMcpServers(
      {
        a: { url: 'https://API.example.com:443/mcp' },
        b: { source: { url: 'https://api.example.com/mcp' } },
      },
      { blob: { key: KEY }, tokenStore: new MemoryTokenStore() },
    ).catch((caught: unknown) => caught);
    expect(err).toMatchObject({ phase: 'validate' });
    expect((err as ProjectionError).message).toMatch(/same server URL/);
  });

  it('wrapMcpServers validates URL sources given directly or as ServerSourceConfig.source', async () => {
    for (const source of [
      { url: 'https://user:pw@api.example.com/mcp' },
      { source: { url: 'https://api.example.com/mcp#x' } },
      { source: { url: 'https://api.example.com/mcp', oauth: { clientId: 'a', bogus: 1 } } },
    ]) {
      await expect(
        wrapMcpServers({ gh: source as never }, { blob: { key: KEY } }),
      ).rejects.toMatchObject({ phase: 'validate' });
    }
  });
});
