/**
 * Projection's OAuth client provider in isolation (PRD R57, R58 "Provider
 * rules", R61): it never starts a flow or opens anything, it
 * compare-and-deletes only the value it presented, the auth-failure
 * classification, fixed-copy errors, the `https:` rule for
 * authorization-server endpoints, the connection's guarded fetch, and the
 * SDK console.warn filter.
 */

import {
  InsufficientScopeError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
  type FetchLike,
} from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertAuthEndpointAllowed,
  createProviderContext,
  createUpstreamAuthProvider,
  createUpstreamFetch,
  findUpstreamAuthFailure,
  installSdkWarningFilter,
  LOOPBACK_REDIRECT_URL,
  MemoryTokenStore,
  ProjectionOAuthProvider,
  resolveUpstreamSpec,
  SecretSet,
  tokenStoreKey,
  UpstreamAuthError,
  UpstreamRequestRefused,
  withSdkWarningsSuppressed,
  type TokenRecord,
  type TokenStore,
} from '../../src/auth/index.js';
import { getRecord, json, putRecord } from './fakes/index.js';

const upstream = resolveUpstreamSpec(
  { url: 'https://api.example.com/mcp', oauth: { clientId: 'client-1', clientSecret: 'shh' } },
  'the source',
);
const KEY = tokenStoreKey(upstream.canonicalUrl, 'client-1');
const R1: TokenRecord = { access_token: 'A1', refresh_token: 'R1', issuer: 'https://as.example' };
const R2: TokenRecord = { access_token: 'A2', refresh_token: 'R2', issuer: 'https://as.example' };

afterEach(() => vi.restoreAllMocks());

function provider(store: TokenStore = new MemoryTokenStore()) {
  return { store, provider: new ProjectionOAuthProvider(createProviderContext(upstream, store)) };
}

describe('provider rules (R58)', () => {
  it('reports a loopback redirect URL and the configured client, with no dynamic registration', () => {
    const { provider: p } = provider();
    expect(p.redirectUrl).toBe(LOOPBACK_REDIRECT_URL);
    expect(new URL(p.redirectUrl).hostname).toBe('127.0.0.1');
    expect(p.clientInformation()).toEqual({ client_id: 'client-1', client_secret: 'shh' });
    expect('saveClientInformation' in p).toBe(false);
    expect('prepareTokenRequest' in p).toBe(false);
  });

  it('never starts a flow: state() stops auth(), redirectToAuthorization only records', () => {
    const { provider: p } = provider();
    expect(p.signInNeeded).toBe(false);
    expect(() => p.state()).toThrow(UpstreamAuthError);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(p.redirectToAuthorization()).toBeUndefined();
    expect(p.signInNeeded).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(() => p.codeVerifier()).toThrow(UpstreamAuthError);
  });

  it('without an oauth client, clientInformation stops before registration', () => {
    const bare = resolveUpstreamSpec({ url: 'https://api.example.com/mcp' }, 'the source');
    const p = new ProjectionOAuthProvider(createProviderContext(bare, new MemoryTokenStore()));
    expect(() => p.clientInformation()).toThrow(UpstreamAuthError);
  });

  it('re-reads the store on every tokens() call', async () => {
    const { store, provider: p } = provider();
    expect(await p.tokens()).toBeUndefined();
    await putRecord(store, KEY, R1);
    expect((await p.tokens())?.access_token).toBe('A1');
    await putRecord(store, KEY, R2);
    expect((await p.tokens())?.access_token).toBe('A2');
  });

  it('invalidateCredentials compare-and-deletes only the value it presented', async () => {
    const { store, provider: p } = provider();
    await putRecord(store, KEY, R1);
    await p.tokens();
    await putRecord(store, KEY, R2); // another process refreshed meanwhile
    await p.invalidateCredentials('tokens');
    expect(await getRecord(store, KEY)).toEqual(R2);

    const second = provider(store).provider;
    await second.tokens();
    await second.invalidateCredentials('tokens');
    expect(await store.get(KEY)).toBeUndefined();
  });

  it('a rejected client (invalid_client) stops the run and keeps the record', async () => {
    const { store, provider: p } = provider();
    await putRecord(store, KEY, R1);
    await p.tokens();
    const err = await p.invalidateCredentials('client').catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(UpstreamAuthError);
    expect((err as UpstreamAuthError).reason).toBe('client_rejected');
    expect(await getRecord(store, KEY)).toEqual(R1);
  });

  it('saveTokens stores the issuer-bound record without an id_token', async () => {
    const { store, provider: p } = provider();
    await p.saveTokens(
      {
        access_token: 'A3',
        token_type: 'Bearer',
        expires_in: 60,
        refresh_token: 'R3',
        id_token: 'ID',
      } as never,
      { issuer: 'https://as.example' },
    );
    const stored = await getRecord(store, KEY);
    expect(stored).toMatchObject({
      access_token: 'A3',
      refresh_token: 'R3',
      issuer: 'https://as.example',
    });
    expect(await store.get(KEY)).not.toContain('ID');
  });

  it('a throwing store becomes a fixed-copy token_store error', async () => {
    const p = new ProjectionOAuthProvider(
      createProviderContext(upstream, {
        get: () => Promise.reject(new Error('LIBRARY TEXT')),
        set: () => Promise.reject(new Error('LIBRARY TEXT')),
        delete: () => Promise.reject(new Error('LIBRARY TEXT')),
      }),
    );
    const err = await p.tokens().catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(UpstreamAuthError);
    expect((err as UpstreamAuthError).reason).toBe('token_store');
    expect((err as Error).message).not.toContain('LIBRARY');
  });
});

describe('auth-failure classification (R58)', () => {
  it('recognizes exactly the sign-in errors, through cause chains', () => {
    expect(findUpstreamAuthFailure(new UnauthorizedError())?.reason).toBe('sign_in_required');
    expect(findUpstreamAuthFailure(new InsufficientScopeError({}))?.reason).toBe(
      'insufficient_scope',
    );
    expect(
      findUpstreamAuthFailure(
        new SdkHttpError(
          SdkErrorCode.ClientHttpAuthentication,
          'Server returned 401 after re-authentication',
          {
            status: 401,
            statusText: 'Unauthorized',
          },
        ),
      )?.reason,
    ).toBe('sign_in_required');
    const ours = new UpstreamAuthError('no_client');
    expect(findUpstreamAuthFailure(new Error('wrapped', { cause: ours }))).toBe(ours);
    expect(findUpstreamAuthFailure(new Error('ECONNREFUSED'))).toBeUndefined();
    expect(
      findUpstreamAuthFailure(
        new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'Error POSTing', {
          status: 500,
          statusText: 'x',
        }),
      ),
    ).toBeUndefined();
  });

  it('keeps an OAuth error code only when it matches ^[a-z_]+$ (R57)', () => {
    expect(new UpstreamAuthError('oauth_error', 'invalid_client').oauthCode).toBe('invalid_client');
    expect(new UpstreamAuthError('oauth_error', 'Bad Code').oauthCode).toBeUndefined();
    expect(new UpstreamAuthError('oauth_error', 'x\ny').oauthCode).toBeUndefined();
  });
});

describe('authorization-server endpoints must be https: (R61)', () => {
  it('admits http: only on loopback, and only for a loopback source', () => {
    expect(() =>
      assertAuthEndpointAllowed(new URL('https://as.example/token'), false),
    ).not.toThrow();
    expect(() =>
      assertAuthEndpointAllowed(new URL('http://127.0.0.1:9/token'), true),
    ).not.toThrow();
    for (const [url, loopbackSource] of [
      ['http://127.0.0.1:9/token', false],
      ['http://localhost/token', false],
      ['http://as.example/token', true],
      ['ftp://as.example/token', true],
    ] as const) {
      const err = (() => {
        try {
          assertAuthEndpointAllowed(new URL(url), loopbackSource);
        } catch (caught) {
          return caught;
        }
        return undefined;
      })();
      expect(err).toBeInstanceOf(UpstreamAuthError);
      expect((err as UpstreamAuthError).reason).toBe('insecure_endpoint');
    }
  });

  it('refuses a refresh at an http: loopback token endpoint named by an https: source', async () => {
    // Offline: the https: source, its metadata and the authorization
    // server exist only in this stub fetch.
    const requests: string[] = [];
    const stub: FetchLike = (url) => {
      const href = String(url);
      requests.push(href);
      if (href.startsWith('https://api.example.com/.well-known/oauth-protected-resource')) {
        return Promise.resolve(
          json({
            resource: 'https://api.example.com/mcp',
            authorization_servers: ['https://as.example'],
          }),
        );
      }
      if (href.startsWith('https://as.example/.well-known/')) {
        return Promise.resolve(
          json({
            issuer: 'https://as.example',
            authorization_endpoint: 'https://as.example/authorize',
            token_endpoint: 'http://127.0.0.1:9/token',
            response_types_supported: ['code'],
          }),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    };
    const store = new MemoryTokenStore();
    await putRecord(store, KEY, R1);
    const context = createProviderContext(upstream, store);
    const auth = createUpstreamAuthProvider(context);
    expect(await auth.token()).toBe('A1');
    const err = await auth
      .onUnauthorized?.({
        response: new Response('unauthorized', { status: 401 }),
        serverUrl: upstream.url,
        fetchFn: stub,
      })
      .catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(UpstreamAuthError);
    expect((err as UpstreamAuthError).reason).toBe('insecure_endpoint');
    expect(requests.some((href) => href.startsWith('http://127.0.0.1'))).toBe(false);
    // Nothing was refreshed or deleted.
    expect(await getRecord(store, KEY)).toEqual(R1);
  });
});

function guarded(base: FetchLike, source = upstream) {
  const context = createProviderContext(source, new MemoryTokenStore());
  return { context, fetch: createUpstreamFetch(context, base) };
}

describe("the connection's guarded fetch (R58, R61)", () => {
  const bearer = { headers: { authorization: 'Bearer A1' } };

  it('sends a bearer token only to the configured resource', async () => {
    const base = vi.fn<FetchLike>(() => Promise.resolve(new Response('ok')));
    const { fetch } = guarded(base);
    await fetch('https://api.example.com/mcp', bearer);
    await expect(fetch('https://api.example.com/other', bearer)).rejects.toBeInstanceOf(
      UpstreamRequestRefused,
    );
    await expect(fetch('https://evil.example/mcp', bearer)).rejects.toBeInstanceOf(
      UpstreamRequestRefused,
    );
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect from the resource to another path or origin, and notes the token a response answered', async () => {
    const { context, fetch } = guarded((url) =>
      Promise.resolve(
        String(url).endsWith('/mcp')
          ? new Response(null, { status: 307, headers: { location: '/other' } })
          : new Response('ok'),
      ),
    );
    const err = await fetch('https://api.example.com/mcp', bearer).catch(
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(UpstreamRequestRefused);
    expect((err as UpstreamRequestRefused).reason).toBe('redirect');

    const same = guarded(() => Promise.resolve(new Response('ok')));
    const response = await same.fetch('https://api.example.com/mcp?x=1', bearer);
    expect(same.context.presented.get(response)).toBe('A1');
    void context;
  });

  it('sends nothing over plain http: for a source that is not loopback', async () => {
    const base = vi.fn<FetchLike>(() => Promise.resolve(new Response('ok')));
    const { fetch } = guarded(base);
    await expect(fetch('http://as.example/.well-known/x')).rejects.toBeInstanceOf(
      UpstreamRequestRefused,
    );
    expect(base).not.toHaveBeenCalled();
  });
});

describe('redaction (S1)', () => {
  it('scrubs every remembered secret, in its encoded spellings too, and keeps values intact otherwise', () => {
    const secrets = new SecretSet();
    secrets.pin('client/secret+1');
    secrets.add('AT-SECRET', undefined, '');
    expect(secrets.scrub('Bearer AT-SECRET; secret=client%2Fsecret%2B1')).toBe(
      'Bearer [redacted]; secret=[redacted]',
    );
    const value = { a: 'no secret here' };
    expect(secrets.scrubValue(value)).toBe(value);
    expect(secrets.scrubValue({ a: 'x AT-SECRET y' })).toEqual({ a: 'x [redacted] y' });
  });
});

describe('SDK console.warn filter (R58)', () => {
  it('drops [mcp-sdk] warnings inside an auth run only; others pass, outside a run too', async () => {
    const seen: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      seen.push(args);
    };
    try {
      let releaseA!: () => void;
      const a = withSdkWarningsSuppressed(async () => {
        console.warn('[mcp-sdk] Could not refresh OAuth tokens. Cause: SECRET');
        await new Promise<void>((resolve) => (releaseA = resolve));
        console.warn('integrator warning');
      });
      // An unrelated [mcp-sdk] warning while the run is in flight, outside it.
      console.warn('[mcp-sdk] excluding tool from tools/list: unrelated');
      releaseA();
      await a;
      console.warn('[mcp-sdk] outside an auth run');
      expect(seen).toEqual([
        ['[mcp-sdk] excluding tool from tools/list: unrelated'],
        ['integrator warning'],
        ['[mcp-sdk] outside an auth run'],
      ]);
    } finally {
      console.warn = original;
    }
  });

  it('never swaps console.warn back: a logger installed mid-run stays installed', async () => {
    const original = console.warn;
    const mine = vi.fn();
    try {
      await withSdkWarningsSuppressed(async () => {
        console.warn = mine;
        await Promise.resolve();
      });
      expect(console.warn).toBe(mine);
      console.warn('after');
      expect(mine).toHaveBeenCalledWith('after');
    } finally {
      console.warn = original;
    }
  });

  it('drops SDK warnings even after a logger replaced console.warn, wrapping it at the point of use', async () => {
    const original = console.warn;
    const mine = vi.fn();
    try {
      await withSdkWarningsSuppressed(async () => {
        console.warn = mine; // a logger replaces console.warn mid-run…
        installSdkWarningFilter(); // …and the next request of the run wraps it
        console.warn('[mcp-sdk] OAuth "invalid_grant" — Cause: "RT-SECRET"');
        console.warn('integrator warning');
      });
      expect(mine).toHaveBeenCalledTimes(1);
      expect(mine).toHaveBeenCalledWith('integrator warning');
      console.warn('[mcp-sdk] outside');
      expect(mine).toHaveBeenLastCalledWith('[mcp-sdk] outside');
    } finally {
      console.warn = original;
    }
  });
});
