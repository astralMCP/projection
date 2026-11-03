/**
 * Sources given by URL, end to end against an in-process OAuth-protected
 * MCP server and authorization server on 127.0.0.1 (PRD §6.10 phase 1,
 * part A: R47 `introspectTimeoutMs`, R51, R53 provider rules, R58 refresh,
 * single-flight and compare-and-delete, R59, R60, R61; S1). Every case also
 * greps every result, error, blob and byte of console, stdout and stderr
 * output for the tokens it used (§13 "No credential leaks").
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  MemoryTokenStore,
  openBlob,
  ProjectionError,
  wrapMcpServer,
  wrapMcpServers,
  type MultiProjectionFacade,
  type ProjectionFacade,
  type TokenStore,
} from '../../src/index.js';
import {
  AUTH_RUN_TIMEOUT_MS,
  encodeTokenRecord,
  tokenStoreKey,
  type TokenRecord,
} from '../../src/auth/index.js';
import { canonicalRequest } from '../../src/catalog/index.js';
import { ACCEPT, completed, sealedState } from '../mrtr/helpers.js';
import { fsServer } from '../multi/helpers.js';
import {
  FakeAuthorizationServer,
  getRecord,
  json,
  putRecord,
  startFakeHttpServer,
  startFakeUpstream,
  type FakeHttpServer,
  type FakeUpstream,
} from './fakes/index.js';
import { captureOutput, dump, leakedSecrets, type CapturedOutput } from './leak-guard.js';

const KEY = new Uint8Array(32).fill(7);
const CLIENT_ID = 'projection-test-client';
const CLIENT_SECRET = 'CLIENT-SECRET-DO-NOT-LEAK';

let output: CapturedOutput;
let facades: (ProjectionFacade | MultiProjectionFacade)[];
let closers: (() => Promise<void>)[];
/** Every value a test produced, for the leak grep. */
let produced: unknown[];
/** Every secret a test used. */
let secrets: string[];

beforeEach(() => {
  facades = [];
  closers = [];
  produced = [];
  secrets = [CLIENT_SECRET];
  output = captureOutput();
});

afterEach(async () => {
  for (const facade of facades) await facade.close();
  for (const close of closers.reverse()) await close();
  output.restore();
  vi.restoreAllMocks();
  // S1 / R59: no token or secret anywhere a test could read back.
  expect(leakedSecrets(`${output.text()}\n${produced.map(dump).join('\n')}`, secrets)).toEqual([]);
});

async function start(options: Parameters<typeof startFakeUpstream>[0] = {}): Promise<FakeUpstream> {
  const fake = await startFakeUpstream(options);
  closers.push(() => fake.close());
  return fake;
}

async function server(handle: Parameters<typeof startFakeHttpServer>[0]): Promise<FakeHttpServer> {
  const fake = await startFakeHttpServer(handle);
  closers.push(() => fake.close());
  return fake;
}

function keyFor(fake: FakeUpstream | string): string {
  return tokenStoreKey(typeof fake === 'string' ? fake : fake.resource.url, CLIENT_ID);
}

/** Mint a token set the fake accepts; its values join the leak grep. */
function issue(fake: FakeUpstream | FakeAuthorizationServer, prefix?: string) {
  const as = fake instanceof FakeAuthorizationServer ? fake : fake.as;
  const issued = as.issue(prefix);
  secrets.push(issued.access_token, issued.refresh_token);
  return { ...issued, issuer: as.issuer };
}

/** Every token the fake authorization server may mint by refreshing, for the leak grep. */
function refreshedSecrets(): void {
  for (let i = 1; i <= 40; i += 1) {
    secrets.push(`AT-refreshed-${i}-SECRET-ACCESS`, `RT-refreshed-${i}-SECRET-REFRESH`);
  }
}

/** A store pre-loaded with a token set the fake accepts. */
async function storeWith(
  fake: FakeUpstream,
  record?: Partial<TokenRecord>,
): Promise<{ store: MemoryTokenStore; record: TokenRecord }> {
  const full: TokenRecord = { ...issue(fake), ...record };
  const store = new MemoryTokenStore();
  await putRecord(store, keyFor(fake), full);
  return { store, record: full };
}

async function wrapUrl(
  fake: FakeUpstream | string,
  store: TokenStore,
  oauth: Record<string, unknown> = {},
  options: { introspectTimeoutMs?: number } = {},
): Promise<ProjectionFacade> {
  const facade = await wrapMcpServer(
    {
      url: typeof fake === 'string' ? fake : fake.resource.url,
      oauth: { clientId: CLIENT_ID, ...oauth },
    },
    { blob: { key: KEY }, tokenStore: store, ...options },
  );
  facades.push(facade);
  return facade;
}

async function wrapFailure(run: () => Promise<unknown>): Promise<ProjectionError> {
  try {
    const value = await run();
    produced.push(value);
  } catch (err) {
    produced.push(err);
    expect(err).toBeInstanceOf(ProjectionError);
    return err as ProjectionError;
  }
  throw new Error('expected the wrap to fail');
}

async function call(facade: ProjectionFacade | MultiProjectionFacade, name = 'whoami') {
  const result = await facade.callTool({ name, args: {} }, 'modern');
  produced.push(result);
  return result;
}

/** The structured error body of an `isError` call result. */
function errorBody(result: unknown): { phase: string; message: string; hint: string } {
  const done = completed(result as Parameters<typeof completed>[0]);
  expect(done.isError).toBe(true);
  return done.structuredContent as { phase: string; message: string; hint: string };
}

describe('wrapping a server by URL with a stored token (R51, R59, R60)', () => {
  it('connects with the stored token, owns the client, and uses the url: identity', async () => {
    const fake = await start();
    const { store, record } = await storeWith(fake);
    const facade = await wrapUrl(fake, store, { clientSecret: CLIENT_SECRET });

    expect(facade.catalog.identity).toBe(`url:${fake.resource.url}`);
    expect(facade.catalog.tools.map((tool) => tool.name).toSorted()).toEqual([
      'create_issue',
      'whoami',
    ]);
    expect(fake.resource.presentedTokens).toContain(record.access_token);

    const read = await call(facade);
    produced.push(
      facade.instructions,
      facade.dts,
      facade.resources,
      facade.discoverApis(),
      facade.searchTools({}),
    );
    expect(completed(read).isError).not.toBe(true);
    expect(JSON.stringify(read)).toContain('octocat');
    // The authorization server was never asked for anything: the token worked.
    expect(fake.as.requests).toEqual([]);
  });

  it('binds approval blobs to the url: identity and keeps tokens out of them (S1, R60)', async () => {
    const fake = await start();
    const { store } = await storeWith(fake);
    const facade = await wrapUrl(fake, store);
    const request = { name: 'create_issue', args: { title: 'hello' } };

    const suspended = await facade.callTool(request, 'modern');
    const blob = sealedState(suspended);
    const payload = openBlob(blob, {
      expectedKind: 'call',
      code: canonicalRequest(request.name, request.args),
      serverIdentity: `url:${fake.resource.url}`,
      config: { key: KEY },
    });
    produced.push(suspended, payload);
    expect(payload.serverIdentity).toBe(`url:${fake.resource.url}`);

    const approved = await facade.callTool(
      { ...request, requestState: blob, inputResponses: { call: ACCEPT } },
      'modern',
    );
    produced.push(approved);
    expect(JSON.stringify(approved)).toContain('created hello');
  });

  it('closes the client and transport it owns on close()', async () => {
    const closeSpy = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close');
    const fake = await start();
    const { store } = await storeWith(fake);
    const facade = await wrapUrl(fake, store);
    expect(closeSpy).not.toHaveBeenCalled();
    await facade.close();
    facades = [];
    expect(closeSpy).toHaveBeenCalledTimes(1);
    const after = await call(facade);
    expect(completed(after).isError).toBe(true);
  });

  it('wraps a public server given by URL without any oauth settings', async () => {
    const fake = await start({ resource: { public: true } });
    const facade = await wrapMcpServer(
      { url: fake.resource.url },
      { blob: { key: KEY }, tokenStore: new MemoryTokenStore() },
    );
    facades.push(facade);
    expect(facade.catalog.identity).toBe(`url:${fake.resource.url}`);
  });

  it('a code-mode-only facade over a URL works (R54 refuses it only once locked boxes land)', async () => {
    const fake = await start();
    const { store } = await storeWith(fake);
    const facade = await wrapMcpServer(
      { url: fake.resource.url, oauth: { clientId: CLIENT_ID } },
      { blob: { key: KEY }, tokenStore: store, projections: { codeMode: true, catalog: false } },
    );
    facades.push(facade);
    expect(facade.dts).toContain('whoami');
  });
});

describe('a source that needs sign-in fails the wrap with an auth error (phase 1, part A)', () => {
  it('no stored token: auth phase, says sign-in is required and is not supported yet, contacts no authorization server', async () => {
    const fake = await start();
    const err = await wrapFailure(() => wrapUrl(fake, new MemoryTokenStore()));
    expect(err.phase).toBe('auth');
    expect(err.message).toMatch(/requires sign-in/);
    expect(err.hint).toContain('is not supported in this version');
    expect(err.message).toContain('127.0.0.1');
    expect(err).toMatchObject({ reason: 'sign_in_required' });
    // R58: the provider never starts a flow — no authorization URL, no
    // authorize or device request, no token request.
    expect(fake.as.requests).toEqual([]);
  });

  it('no oauth.clientId: the auth error names the setting', async () => {
    const fake = await start();
    const err = await wrapFailure(() =>
      wrapMcpServer(
        { url: fake.resource.url },
        { blob: { key: KEY }, tokenStore: new MemoryTokenStore() },
      ),
    );
    expect(err.phase).toBe('auth');
    expect(err.hint).toContain('oauth.clientId');
  });

  it('a stored token that no longer works and cannot refresh: auth error after one retry, record kept', async () => {
    const fake = await start();
    const { store, record } = await storeWith(fake);
    const accessOnly: TokenRecord = { access_token: record.access_token, issuer: record.issuer };
    await putRecord(store, keyFor(fake), accessOnly);
    fake.as.expire(record.access_token);
    const err = await wrapFailure(() => wrapUrl(fake, store));
    expect(err.phase).toBe('auth');
    expect(err.message).toMatch(/requires sign-in/);
    expect(fake.as.tokenRequests).toEqual([]);
    // Re-lock deletion arrives with part B; part A only refuses.
    expect(await getRecord(store, keyFor(fake))).toEqual(accessOnly);
  });

  it('re-read before re-lock: a token another process stores after the 401 is picked up (R58)', async () => {
    const fake = await start();
    const { store, record } = await storeWith(fake);
    const key = keyFor(fake);
    await putRecord(store, key, { access_token: record.access_token, issuer: record.issuer });
    fake.as.expire(record.access_token);
    const fresh = issue(fake, 'other-process');
    // The other process stores its token just after this one re-read the
    // store in onUnauthorized (still the failed token, nothing to refresh).
    let armed = false;
    fake.resource.options.onChallenge = () => {
      armed = true;
    };
    const racing: TokenStore = {
      get: async (k) => {
        const value = await store.get(k);
        if (armed) {
          armed = false;
          await putRecord(store, k, fresh);
        }
        return value;
      },
      set: (k, v) => store.set(k, v),
      delete: (k, e) => store.delete(k, e),
    };
    const facade = await wrapUrl(fake, racing);
    expect(JSON.stringify(await call(facade))).toContain('octocat');
    expect(fake.as.tokenRequests).toEqual([]);
  });

  it('an insufficient_scope answer is an auth error naming oauth.scopes (R58)', async () => {
    const fake = await start({ resource: { insufficientScope: true } });
    const { store } = await storeWith(fake);
    const err = await wrapFailure(() => wrapUrl(fake, store));
    expect(err.phase).toBe('auth');
    expect(err.hint).toContain('oauth.scopes');
  });

  it('a non-auth failure still fails closed outside the auth phase (R47)', async () => {
    const fake = await start({ resource: { failWith: 500 } });
    const { store } = await storeWith(fake);
    const err = await wrapFailure(() => wrapUrl(fake, store));
    expect(err.phase).toBe('protocol');
    expect(err.message).toContain('127.0.0.1');
  });
});

describe('credentials echoed by the upstream never surface (S1, R59)', () => {
  it('a 5xx body echoing the Authorization header: the wrap error carries no token', async () => {
    const fake = await start({ resource: { failWith: 500, echoAuthorization: true } });
    const { store, record } = await storeWith(fake);
    const err = await wrapFailure(() => wrapUrl(fake, store));
    expect(err.phase).toBe('protocol');
    // The 2026-07-28 version probe (G2) reports the status without quoting
    // the body; whatever the error does quote must be scrubbed (the
    // call-time case below exercises the scrubber on a quoted body).
    expect(err.message).toContain('HTTP 500');
    expect(dump(err)).not.toContain(record.access_token);
    expect(err.cause).toBeUndefined();
  });

  it('a 5xx body echoing the Authorization header at call time: the call_tool result carries no token', async () => {
    const fake = await start();
    const { store, record } = await storeWith(fake);
    const facade = await wrapUrl(fake, store);
    fake.resource.options.failWith = 500;
    fake.resource.options.echoAuthorization = true;
    const result = await call(facade);
    const body = errorBody(result);
    expect(body.phase).toBe('upstream');
    expect(body.message).toContain('[redacted]');
    expect(JSON.stringify(result)).not.toContain(record.access_token);
  });

  it('a tool description echoing the token reaches neither the catalog nor the types', async () => {
    const fake = await start({ resource: { echoTokenInDescription: true } });
    const { store, record } = await storeWith(fake);
    const facade = await wrapUrl(fake, store);
    produced.push(facade.catalog, facade.dts, facade.searchTools({}), facade.discoverApis());
    expect(JSON.stringify(facade.catalog)).toContain('[redacted]');
    expect(JSON.stringify(facade.catalog)).not.toContain(record.access_token);
  });
});

describe('store errors never surface (R59)', () => {
  it('a store whose errors quote the tokens, on get, set and delete: fixed copy only', async () => {
    const fake = await start({ refresh: 'invalid_grant' });
    const { store, record } = await storeWith(fake);
    fake.as.expire(record.access_token);
    const hostile: TokenStore = {
      get: (key) => store.get(key),
      set: (_key, value) => Promise.reject(new Error(`cannot write ${value}`)),
      delete: () => Promise.reject(new Error(`cannot delete ${record.refresh_token ?? ''}`)),
    };
    const err = await wrapFailure(() => wrapUrl(fake, hostile));
    expect(err).toMatchObject({ phase: 'auth', reason: 'token_store' });

    const getFails: TokenStore = {
      get: () => Promise.reject(new Error(`get failed ${record.access_token}`)),
      set: (key, value) => store.set(key, value),
      delete: (key, expected) => store.delete(key, expected),
    };
    const err2 = await wrapFailure(() => wrapUrl(fake, getFails));
    expect(err2).toMatchObject({ phase: 'auth', reason: 'token_store' });
  });
});

describe('a hostile resource cannot redirect a refresh (R61)', () => {
  it('metadata naming another authorization server: no refresh token is sent to it', async () => {
    const fake = await start();
    const { record } = await storeWith(fake);
    const evilBodies: string[] = [];
    const evil = await FakeAuthorizationServer.start({
      routes: {
        '/token': async (request) => {
          evilBodies.push(await request.text());
          return json({ access_token: 'EVIL', token_type: 'Bearer' });
        },
      },
    });
    closers.push(() => evil.close());
    let resourceUrl = '';
    const metadata = await server(() =>
      json({ resource: resourceUrl, authorization_servers: [evil.issuer] }),
    );
    const resource = await server(
      () =>
        new Response('unauthorized', {
          status: 401,
          headers: {
            'www-authenticate': `Bearer resource_metadata="${metadata.origin}/.well-known/oauth-protected-resource"`,
          },
        }),
    );
    resourceUrl = `${resource.origin}/mcp`;
    const store = new MemoryTokenStore();
    // A record the real authorization server issued, stored for this URL.
    await putRecord(store, keyFor(resourceUrl), record);
    const err = await wrapFailure(() => wrapUrl(resourceUrl, store));
    expect(err.phase).toBe('auth');
    expect(evilBodies).toEqual([]);
  });
});

describe('the token goes only to the configured resource (R61)', () => {
  it('a redirect from /mcp to /other on the same origin is refused: no token reaches /other', async () => {
    const as = await FakeAuthorizationServer.start();
    closers.push(() => as.close());
    const issued = issue(as);
    const seenAt: string[] = [];
    const resource = await server((request) => {
      const path = new URL(request.url).pathname;
      if (request.headers.get('authorization')?.includes(issued.access_token) === true) {
        seenAt.push(path);
      }
      if (path === '/mcp') {
        return new Response(null, { status: 307, headers: { location: '/other' } });
      }
      return new Response('nope', { status: 404 });
    });
    const url = `${resource.origin}/mcp`;
    const store = new MemoryTokenStore();
    await putRecord(store, keyFor(url), issued);
    const err = await wrapFailure(() => wrapUrl(url, store));
    expect(err.phase).toBe('protocol');
    expect(err.message).toMatch(/redirected a request to another URL/);
    expect(err.message).not.toContain('/other');
    expect(seenAt).toEqual(['/mcp']);
  });

  it('a cross-origin redirect is not followed with the token', async () => {
    const as = await FakeAuthorizationServer.start();
    closers.push(() => as.close());
    const issued = issue(as);
    const evilSeen: string[] = [];
    const evil = await server((request) => {
      evilSeen.push(request.headers.get('authorization') ?? '(none)');
      return new Response('x', { status: 404 });
    });
    const resource = await server(
      () => new Response(null, { status: 307, headers: { location: `${evil.origin}/mcp` } }),
    );
    const url = `${resource.origin}/mcp`;
    const store = new MemoryTokenStore();
    await putRecord(store, keyFor(url), issued);
    await wrapFailure(() => wrapUrl(url, store));
    expect(evilSeen).toEqual([]);
  });
});

describe('refresh through the SDK (R58, R59)', () => {
  it('refreshes an expired token, stores the rotated set, and proceeds', async () => {
    const fake = await start({ refresh: 'rotate' });
    refreshedSecrets();
    const { store, record } = await storeWith(fake);
    fake.as.expire(record.access_token);

    const facade = await wrapUrl(fake, store);
    const stored = await getRecord(store, keyFor(fake));
    expect(stored).toBeDefined();
    expect(stored?.access_token).not.toBe(record.access_token);
    expect(stored?.refresh_token).toBeDefined();
    expect(stored?.refresh_token).not.toBe(record.refresh_token);
    expect(stored?.issuer).toBe(fake.as.issuer);
    expect(stored?.expires_at).toBeGreaterThan(Date.now() / 1000);
    expect(fake.as.tokenRequests).toHaveLength(1);
    expect(JSON.stringify(await call(facade))).toContain('octocat');
  });

  it('refreshes a record whose expires_at has passed before sending it', async () => {
    const fake = await start({ refresh: 'rotate' });
    refreshedSecrets();
    const { store, record } = await storeWith(fake, {
      expires_at: Math.floor(Date.now() / 1000) - 60,
    });
    await wrapUrl(fake, store);
    expect(fake.as.tokenRequests).toHaveLength(1);
    // The expired token was never presented: no 401 round trip.
    expect(fake.resource.presentedTokens).not.toContain(record.access_token);
  });

  it('keeps the old refresh token when the server does not rotate it', async () => {
    const fake = await start({ refresh: 'keep' });
    refreshedSecrets();
    const { store, record } = await storeWith(fake);
    fake.as.expire(record.access_token);
    await wrapUrl(fake, store);
    const stored = await getRecord(store, keyFor(fake));
    expect(stored?.refresh_token).toBe(record.refresh_token);
  });

  it('refreshes after the wrap, at call time', async () => {
    const fake = await start({ refresh: 'rotate' });
    refreshedSecrets();
    const { store, record } = await storeWith(fake);
    const facade = await wrapUrl(fake, store);
    fake.as.expire(record.access_token);
    expect(JSON.stringify(await call(facade))).toContain('octocat');
    expect(fake.as.tokenRequests).toHaveLength(1);
  });

  it('concurrent 401s after expiry share exactly one refresh, and every call succeeds', async () => {
    const fake = await start({ refresh: 'rotate' });
    refreshedSecrets();
    const { store, record } = await storeWith(fake);
    const facade = await wrapUrl(fake, store);
    fake.as.expire(record.access_token);
    const results = await Promise.all([1, 2, 3, 4].map(() => call(facade)));
    for (const result of results) expect(JSON.stringify(result)).toContain('octocat');
    expect(fake.as.tokenRequests).toHaveLength(1);
  });

  it('a 401 at call time with nothing to refresh is an auth outcome, not an upstream one (R25)', async () => {
    const fake = await start();
    const { store, record } = await storeWith(fake);
    await putRecord(store, keyFor(fake), {
      access_token: record.access_token,
      issuer: record.issuer,
    });
    const facade = await wrapUrl(fake, store);
    fake.as.expire(record.access_token);
    const body = errorBody(await call(facade));
    expect(body.phase).toBe('auth');
    expect(body.message).toMatch(/requires sign-in/);
    expect(body.hint).not.toMatch(/Check the arguments/);
  });

  it('a definitive refresh failure (invalid_grant) compare-and-deletes the record', async () => {
    const fake = await start({ refresh: 'invalid_grant' });
    const { store, record } = await storeWith(fake);
    fake.as.expire(record.access_token);
    const err = await wrapFailure(() => wrapUrl(fake, store));
    expect(err.phase).toBe('auth');
    expect(err.message).toMatch(/requires sign-in/);
    expect(await store.get(keyFor(fake))).toBeUndefined();
  });

  it('compare-and-delete spares a record another process stored meanwhile', async () => {
    const fake = await start({ refresh: 'invalid_grant' });
    const { store, record } = await storeWith(fake);
    fake.as.expire(record.access_token);
    const other = issue(fake, 'other-process');
    const replacement: TokenRecord = { access_token: other.access_token, issuer: fake.as.issuer };
    // Another process stores a fresh record while this one's refresh fails.
    const racing: TokenStore = {
      get: (key) => store.get(key),
      set: (key, value) => store.set(key, value),
      delete: async (key, expected) => {
        await putRecord(store, key, replacement);
        return store.delete(key, expected);
      },
    };
    // The replacement is valid, so the request goes through with it.
    const facade = await wrapUrl(fake, racing);
    produced.push(facade.catalog);
    expect(await getRecord(store, keyFor(fake))).toEqual(replacement);
  });

  it('a transient refresh failure (5xx) keeps the record, says so, and the SDK console.warn is dropped (R58)', async () => {
    const fake = await start({ refresh: 'server_error' });
    const { store, record } = await storeWith(fake);
    fake.as.expire(record.access_token);
    const err = await wrapFailure(() => wrapUrl(fake, store));
    expect(err.phase).toBe('auth');
    expect(err).toMatchObject({ reason: 'refresh_failed' });
    expect(err.message).toMatch(/refreshing the stored sign-in failed/);
    expect(err.message).toMatch(/kept/);
    expect(await getRecord(store, keyFor(fake))).toEqual(record);
    expect(fake.as.tokenRequests).toHaveLength(1);
    expect(output.text()).not.toContain('[mcp-sdk]');
  });

  it('a token endpoint answering malformed JSON that echoes the refresh token: refresh_failed, record kept', async () => {
    const fake = await start();
    const { store, record } = await storeWith(fake);
    fake.as.options.routes = {
      '/token': async (request) =>
        new Response(
          `<<not json ${new URLSearchParams(await request.text()).get('refresh_token')}`,
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    };
    fake.as.expire(record.access_token);
    const err = await wrapFailure(() => wrapUrl(fake, store));
    expect(err).toMatchObject({ phase: 'auth', reason: 'refresh_failed' });
    expect(await getRecord(store, keyFor(fake))).toEqual(record);
  });

  it('an unreachable token endpoint: refresh_failed, record kept', async () => {
    const fake = await start();
    const { store, record } = await storeWith(fake);
    const issuer = fake.as.issuer;
    fake.as.options.routes = {
      '/.well-known/oauth-authorization-server': () =>
        json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: 'http://127.0.0.1:1/token',
          response_types_supported: ['code'],
        }),
    };
    fake.as.expire(record.access_token);
    const err = await wrapFailure(() => wrapUrl(fake, store));
    expect(err).toMatchObject({ phase: 'auth', reason: 'refresh_failed' });
    expect(await getRecord(store, keyFor(fake))).toEqual(record);
  });

  it('invalid_client is a client-configuration error, not a sign-in one; the record is kept', async () => {
    const fake = await start({ refresh: { error: 'invalid_client', echoSecret: true } });
    const { store, record } = await storeWith(fake);
    fake.as.expire(record.access_token);
    const err = await wrapFailure(() => wrapUrl(fake, store, { clientSecret: CLIENT_SECRET }));
    expect(err).toMatchObject({ phase: 'auth', reason: 'client_rejected' });
    expect(err.message).toContain('invalid_client');
    expect(err.message).not.toMatch(/requires sign-in/);
    expect(err.hint).toContain('oauth.clientId');
    expect(await getRecord(store, keyFor(fake))).toEqual(record);
  });

  it('an authorization-server error carries only a valid OAuth error code, never its text (R57)', async () => {
    const fake = await start({ refresh: { error: 'access_denied', echoSecret: true } });
    const { store, record } = await storeWith(fake);
    fake.as.expire(record.access_token);
    const err = await wrapFailure(() => wrapUrl(fake, store));
    expect(err.phase).toBe('auth');
    expect(err.message).toContain('"access_denied"');
    expect(err.message).not.toContain('rejected');
    expect(err.cause).toBeUndefined();
  });

  it('an OAuth error code outside ^[a-z_]+$ is dropped (R57)', async () => {
    const fake = await start({ refresh: { error: 'Weird-Code<script>', echoSecret: true } });
    const { store, record } = await storeWith(fake);
    fake.as.expire(record.access_token);
    const err = await wrapFailure(() => wrapUrl(fake, store));
    expect(err.phase).toBe('auth');
    expect(err.message).not.toContain('Weird');
    expect(err.message).not.toContain('OAuth error');
  });

  it('two facades refreshing at once print no SDK warning text', async () => {
    const one = await start({ refresh: 'server_error' });
    const two = await start({ refresh: { error: 'invalid_grant', echoSecret: true } });
    const a = await storeWith(one);
    const b = await storeWith(two);
    one.as.expire(a.record.access_token);
    two.as.expire(b.record.access_token);
    await Promise.all([
      wrapFailure(() => wrapUrl(one, a.store)),
      wrapFailure(() => wrapUrl(two, b.store)),
    ]);
    expect(output.text()).not.toContain('[mcp-sdk]');
  });

  it('a logger that replaces console.warn during a refresh keeps working and never sees SDK text', async () => {
    const fake = await start({ refresh: 'server_error' });
    const { store, record } = await storeWith(fake);
    const logged: unknown[][] = [];
    const logger = (...args: unknown[]): void => {
      logged.push(args);
    };
    fake.as.options.routes = {
      '/token': async (request) => {
        console.warn = logger; // installed while the auth run is in flight
        return new Response(`internal error ${await request.text()}`, { status: 500 });
      },
    };
    fake.as.expire(record.access_token);
    await wrapFailure(() => wrapUrl(fake, store));
    console.warn('integrator warning');
    produced.push(logged);
    expect(logged.some((args) => String(args[0]).startsWith('[mcp-sdk]'))).toBe(false);
    expect(logged).toContainEqual(['integrator warning']);
  });
});

describe('a refresh that never answers is bounded (R58)', () => {
  /** Shorten the auth-run deadline to `ms` for this test. */
  function shortenAuthRuns(ms: number): void {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) =>
      timeout(delay === AUTH_RUN_TIMEOUT_MS ? ms : delay),
    );
  }

  /** A token endpoint that hangs while `hang.on` is true, and answers normally after. */
  function hangTokenEndpoint(fake: FakeUpstream): { on: boolean; seen: number } {
    const hang = { on: true, seen: 0 };
    fake.as.options.routes = {
      '/token': () => {
        hang.seen += 1;
        if (hang.on) return new Promise<Response>(() => undefined);
        fake.as.options.routes = {};
        return new Response('not ready', { status: 503 });
      },
    };
    return hang;
  }

  it('the run deadline is 30 seconds', () => {
    expect(AUTH_RUN_TIMEOUT_MS).toBe(30_000);
  });

  it('a never-answering token endpoint fails the call with refresh_failed within the deadline; after recovery the next call refreshes', async () => {
    shortenAuthRuns(300);
    const fake = await start({ refresh: 'rotate' });
    refreshedSecrets();
    const { store, record } = await storeWith(fake);
    const facade = await wrapUrl(fake, store);
    fake.as.expire(record.access_token);
    const hang = hangTokenEndpoint(fake);
    const started = Date.now();
    const result = await call(facade);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(hang.seen).toBe(1);
    expect(errorBody(result)).toMatchObject({ phase: 'auth' });
    expect(JSON.stringify(result)).toContain('refresh');
    expect(await getRecord(store, keyFor(fake))).toEqual(record); // kept
    hang.on = false;
    fake.as.options.routes = {}; // the authorization server recovers
    expect(JSON.stringify(await call(facade))).toContain('octocat');
    expect(fake.as.tokenRequests).toHaveLength(2);
  }, 15_000);

  it('a concurrent call joins the bounded refresh, and a new facade over the same store is not stuck behind it', async () => {
    shortenAuthRuns(300);
    const fake = await start({ refresh: 'rotate' });
    refreshedSecrets();
    const { store, record } = await storeWith(fake);
    const facade = await wrapUrl(fake, store);
    fake.as.expire(record.access_token);
    const hang = hangTokenEndpoint(fake);
    const pending = Promise.all([call(facade), call(facade)]);
    while (hang.seen === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    hang.on = false;
    fake.as.options.routes = {};
    // A new facade over the same store meets the same expired record and
    // joins the hung flight — only until its deadline, sharing its failure.
    const started = Date.now();
    const joined = await wrapFailure(() => wrapUrl(fake, store));
    expect(joined).toMatchObject({ phase: 'auth', reason: 'refresh_failed' });
    expect(Date.now() - started).toBeLessThan(5_000);
    for (const result of await pending) expect(errorBody(result).phase).toBe('auth');
    // The failed flight has cleared: the next wrap refreshes afresh.
    const second = await wrapUrl(fake, store);
    expect(JSON.stringify(await call(second))).toContain('octocat');
    expect(hang.seen).toBe(1);
    expect(fake.as.tokenRequests).toHaveLength(2);
  }, 15_000);

  it('close() aborts the refresh its facade has in flight, so another facade refreshes at once', async () => {
    const fake = await start({ refresh: 'rotate' });
    refreshedSecrets();
    const { store, record } = await storeWith(fake);
    const first = await wrapUrl(fake, store);
    fake.as.expire(record.access_token);
    const hang = hangTokenEndpoint(fake);
    const pending = call(first);
    while (hang.seen === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const started = Date.now();
    await first.close();
    // The closed facade's call fails at once rather than after the deadline.
    expect(errorBody(await pending).phase).toMatch(/^(auth|upstream)$/);
    hang.on = false;
    fake.as.options.routes = {};
    const second = await wrapUrl(fake, store);
    expect(JSON.stringify(await call(second))).toContain('octocat');
    // Far below the 30-second default deadline.
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);
});

describe('redaction never corrupts what a URL source declares (S1)', () => {
  /** A plain MCP server over HTTP that accepts any bearer token. */
  async function plainServer(instructions?: string, description = 'A plain tool.') {
    return server(async (request) => {
      const mcp = new McpServer(
        { name: 'plain-remote', version: '1.0.0' },
        instructions !== undefined ? { instructions } : {},
      );
      mcp.registerTool(
        'plain',
        { description, inputSchema: z.object({}), annotations: { readOnlyHint: true } },
        () => ({
          content: [
            { type: 'text' as const, text: 'a normal result with 1 and 2 and the word tool' },
          ],
        }),
      );
      return createMcpHandler(() => mcp).fetch(request);
    });
  }

  it('short tokens and a short client secret are never substring-redacted', async () => {
    const remote = await plainServer();
    const url = `${remote.origin}/mcp`;
    for (const token of ['a', 'e', '"', ':', 'true', '1', 'tool']) {
      const store = new MemoryTokenStore();
      await store.set(
        keyFor(url),
        encodeTokenRecord({ access_token: token, issuer: 'https://as.example' }),
      );
      const facade = await wrapUrl(url, store, { clientSecret: 'dev' });
      expect(facade.catalog.tools.map((tool) => tool.name)).toEqual(['plain']);
      expect(facade.dts).toContain('plain');
      const result = JSON.stringify(await call(facade, 'plain'));
      expect(result).toContain('a normal result with 1 and 2 and the word tool');
      expect(result).not.toContain('[redacted]');
    }
  });

  it('a token interleaved with zero-width characters is redacted on multi-server box surfaces', async () => {
    const token = 'AT-ZW-SECRET-TOKEN-0123456789';
    secrets.push(token);
    const hidden = token.split('').join('\u200b');
    const remote = await plainServer(
      `Overview: your key is ${hidden} today.\nMore.`,
      `Plain ${hidden} tool.`,
    );
    const url = `${remote.origin}/mcp`;
    const store = new MemoryTokenStore();
    await store.set(
      keyFor(url),
      encodeTokenRecord({ access_token: token, issuer: 'https://as.example' }),
    );
    const facade = await wrapMcpServers(
      { fs: fsServer([]), gh: { source: { url, oauth: { clientId: CLIENT_ID } } } },
      { blob: { key: KEY }, tokenStore: store },
    );
    facades.push(facade);
    const surfaces = {
      instructions: facade.instructions,
      resources: facade.resources,
      discover: facade.discoverApis(),
      dts: facade.dts,
      search: facade.searchTools({ query: 'plain' }),
      describe: facade.describeTool({ name: 'gh.plain' }),
      call: await facade.callTool({ name: 'gh.plain', args: {} }, 'modern'),
    };
    produced.push(surfaces);
    expect(JSON.stringify(surfaces)).toContain('[redacted]');
  });

  it('a repeated tools/list cursor is redacted before it is cut to 64 characters', async () => {
    const token = 'AT-CURSOR-SECRET-TOKEN-0123456789';
    secrets.push(token, token.slice(0, 10));
    const cursor = `${'c'.repeat(56)}${token}`; // the token straddles the cut
    const remote = await server(async (request) => {
      const mcp = new McpServer({ name: 'looping', version: '1.0.0' });
      mcp.registerTool('t', { description: 'd', inputSchema: z.object({}) }, () => ({
        content: [],
      }));
      mcp.server.setRequestHandler('tools/list', () => ({
        tools: [{ name: 't', inputSchema: { type: 'object' as const } }],
        nextCursor: cursor,
      }));
      return createMcpHandler(() => mcp).fetch(request);
    });
    const url = `${remote.origin}/mcp`;
    const store = new MemoryTokenStore();
    await store.set(
      keyFor(url),
      encodeTokenRecord({ access_token: token, issuer: 'https://as.example' }),
    );
    const err = await wrapFailure(() => wrapUrl(url, store));
    expect(err.message).toContain('pagination loops');
    expect(err.message).not.toContain(token.slice(0, 8));
  });
});

describe('introspectTimeoutMs (R47)', () => {
  it('a source that never answers fails the wrap in the protocol phase, naming its host, and its connection is closed', async () => {
    const closeSpy = vi.spyOn(StreamableHTTPClientTransport.prototype, 'close');
    const silent = await server(() => new Promise<Response>(() => undefined));
    const started = Date.now();
    const err = await wrapFailure(() =>
      wrapUrl(`${silent.origin}/mcp`, new MemoryTokenStore(), {}, { introspectTimeoutMs: 100 }),
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(err.phase).toBe('protocol');
    expect(err.message).toBe(
      'the wrapped server (127.0.0.1) did not finish connecting and listing its tools within 100 ms',
    );
    expect(err.hint).toContain('introspectTimeoutMs');
    expect(closeSpy).toHaveBeenCalled();
  });

  it('on a multi-server facade it names the alias, closes what Projection opened, and leaves a caller-owned Client open', async () => {
    const silent = await server(() => new Promise<Response>(() => undefined));
    const local = new McpServer({ name: 'local', version: '1.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await local.connect(serverSide);
    const client = new Client({ name: 'caller', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientSide);
    closers.push(() => client.close());
    const fs = fsServer([]);
    const err = await wrapFailure(() =>
      wrapMcpServers(
        { fs, mine: client, slow: { url: `${silent.origin}/mcp` } },
        { blob: { key: KEY }, tokenStore: new MemoryTokenStore(), introspectTimeoutMs: 100 },
      ),
    );
    expect(err.phase).toBe('protocol');
    expect(err.message).toContain('source "slow" (127.0.0.1)');
    // The in-process server Projection connected is released…
    expect(fs.isConnected()).toBe(false);
    // …and the caller's Client still works.
    await expect(client.ping()).resolves.toBeDefined();
  });

  it('must be a positive whole number of milliseconds', async () => {
    for (const introspectTimeoutMs of [0, -1, 1.5, Number.NaN, '100']) {
      const err = await wrapFailure(() =>
        wrapMcpServer(fsServer([]), {
          blob: { key: KEY },
          introspectTimeoutMs: introspectTimeoutMs as number,
        }),
      );
      expect(err.phase).toBe('validate');
    }
  });
});

describe('signOut (R59)', () => {
  it('deletes the stored tokens of a single-server facade; the next request presents none', async () => {
    const fake = await start();
    const { store } = await storeWith(fake);
    const facade = await wrapUrl(fake, store);
    await facade.signOut();
    expect(await store.get(keyFor(fake))).toBeUndefined();
    const before = fake.resource.presentedTokens.length;
    expect(errorBody(await call(facade)).phase).toBe('auth');
    expect(fake.resource.presentedTokens.length).toBe(before);
  });

  it('is a validate error on a facade over a pre-built server, or with an alias', async () => {
    const facade = await wrapMcpServer(fsServer([]), { blob: { key: KEY } });
    facades.push(facade);
    await expect(facade.signOut()).rejects.toMatchObject({ phase: 'validate' });
    await expect(facade.signOut('fs')).rejects.toMatchObject({ phase: 'validate' });
  });

  it('a store that cannot delete is an auth error in fixed copy', async () => {
    const fake = await start();
    const { store } = await storeWith(fake);
    const broken: TokenStore = {
      get: (key) => store.get(key),
      set: (key, value) => store.set(key, value),
      delete: () => Promise.reject(new Error('STORE-LIBRARY-TEXT')),
    };
    const facade = await wrapUrl(fake, broken);
    const err = await facade.signOut().catch((caught: unknown) => caught);
    produced.push(err);
    expect(err).toMatchObject({ phase: 'auth' });
    expect(dump(err)).not.toContain('STORE-LIBRARY-TEXT');
  });
});

describe('multi-server facades with a box given by URL (R39, R41, R51, R60)', () => {
  it('puts the url: identity in the multi: pairs, and signOut works per box', async () => {
    const fake = await start();
    const { store } = await storeWith(fake);
    const facade = await wrapMcpServers(
      {
        fs: fsServer([]),
        gh: {
          source: { url: fake.resource.url, oauth: { clientId: CLIENT_ID } },
          description: 'Issues',
        },
      },
      { blob: { key: KEY }, tokenStore: store },
    );
    facades.push(facade);
    const identity = (facade as unknown as { snapshot: { view: { identity: string } } }).snapshot
      .view.identity;
    expect(identity).toBe(
      `multi:${JSON.stringify([
        ['fs', 'files@1.0.0'],
        ['gh', `url:${fake.resource.url}`],
      ])}`,
    );
    const read = await call(facade, 'gh.whoami');
    produced.push(facade.instructions);
    expect(JSON.stringify(read)).toContain('octocat');

    await expect(facade.signOut('fs')).rejects.toMatchObject({ phase: 'validate' });
    await expect(facade.signOut('nope')).rejects.toMatchObject({ phase: 'validate' });
    await expect(facade.signOut('__proto__')).rejects.toMatchObject({ phase: 'validate' });
    await facade.signOut('gh');
    expect(await store.get(keyFor(fake))).toBeUndefined();
  });

  it('a URL box given directly needing sign-in fails the wrap with an auth error naming the alias', async () => {
    const fake = await start();
    const err = await wrapFailure(() =>
      wrapMcpServers(
        { fs: fsServer([]), gh: { url: fake.resource.url, oauth: { clientId: CLIENT_ID } } },
        { blob: { key: KEY }, tokenStore: new MemoryTokenStore() },
      ),
    );
    expect(err.phase).toBe('auth');
    expect(err.message).toContain('source "gh"');
  });

  it('signOut() without an alias clears every URL box; with none, it is a validate error', async () => {
    const fake = await start();
    const { store } = await storeWith(fake);
    const facade = await wrapMcpServers(
      { gh: { url: fake.resource.url, oauth: { clientId: CLIENT_ID } } },
      { blob: { key: KEY }, tokenStore: store },
    );
    facades.push(facade);
    await facade.signOut();
    expect(await store.get(keyFor(fake))).toBeUndefined();

    const plain = await wrapMcpServers({ fs: fsServer([]) }, { blob: { key: KEY } });
    facades.push(plain);
    await expect(plain.signOut()).rejects.toMatchObject({ phase: 'validate' });
  });

  it('signOut() still clears every other box when one box cannot delete, then reports the failure', async () => {
    const one = await start();
    const two = await start();
    const store = new MemoryTokenStore();
    await putRecord(store, keyFor(one), issue(one));
    await putRecord(store, keyFor(two), issue(two));
    const failing = keyFor(one);
    const partial: TokenStore = {
      get: (key) => store.get(key),
      set: (key, value) => store.set(key, value),
      delete: (key, expected) =>
        key === failing
          ? Promise.reject(new Error('STORE-LIBRARY-TEXT'))
          : store.delete(key, expected),
    };
    const facade = await wrapMcpServers(
      {
        one: { url: one.resource.url, oauth: { clientId: CLIENT_ID } },
        two: { url: two.resource.url, oauth: { clientId: CLIENT_ID } },
      },
      { blob: { key: KEY }, tokenStore: partial },
    );
    facades.push(facade);
    const err = await facade.signOut().catch((caught: unknown) => caught);
    produced.push(err);
    expect(err).toMatchObject({ phase: 'auth' });
    expect((err as Error).message).toContain('source "one"');
    expect(dump(err)).not.toContain('STORE-LIBRARY-TEXT');
    expect(await store.get(keyFor(two))).toBeUndefined();
    expect(await store.get(keyFor(one))).toBeDefined();
  });
});
