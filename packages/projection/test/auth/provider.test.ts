/**
 * Projection's OAuth client provider in isolation (PRD R57, R58 "Provider
 * rules"): it never starts a flow or opens anything, it compare-and-deletes
 * only the record it presented, the auth-failure classification, fixed-copy
 * errors, and the SDK console.warn suppression.
 */

import {
  InsufficientScopeError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findUpstreamAuthFailure,
  LOOPBACK_REDIRECT_URL,
  MemoryTokenStore,
  ProjectionOAuthProvider,
  resolveUpstreamSpec,
  tokenStoreKey,
  UpstreamAuthError,
  withSdkWarningsSuppressed,
  type TokenRecord,
} from '../../src/auth/index.js';

const upstream = resolveUpstreamSpec(
  { url: 'https://api.example.com/mcp', oauth: { clientId: 'client-1', clientSecret: 'shh' } },
  'the source',
);
const KEY = tokenStoreKey(upstream.canonicalUrl, 'client-1');
const R1: TokenRecord = { access_token: 'A1', refresh_token: 'R1', issuer: 'https://as.example' };
const R2: TokenRecord = { access_token: 'A2', refresh_token: 'R2', issuer: 'https://as.example' };

afterEach(() => vi.restoreAllMocks());

function provider(store = new MemoryTokenStore()) {
  return { store, provider: new ProjectionOAuthProvider({ upstream, store, key: KEY }) };
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
    const p = new ProjectionOAuthProvider({
      upstream: bare,
      store: new MemoryTokenStore(),
      key: undefined,
    });
    expect(() => p.clientInformation()).toThrow(UpstreamAuthError);
  });

  it('re-reads the store on every tokens() call', async () => {
    const { store, provider: p } = provider();
    expect(await p.tokens()).toBeUndefined();
    await store.set(KEY, R1);
    expect((await p.tokens())?.access_token).toBe('A1');
    await store.set(KEY, R2);
    expect((await p.tokens())?.access_token).toBe('A2');
  });

  it('invalidateCredentials compare-and-deletes only the record it presented', async () => {
    const { store, provider: p } = provider();
    await store.set(KEY, R1);
    await p.tokens();
    await store.set(KEY, R2); // another process refreshed meanwhile
    await p.invalidateCredentials('tokens');
    expect(await store.get(KEY)).toEqual(R2);

    const second = provider(store).provider;
    await second.tokens();
    await second.invalidateCredentials('tokens');
    expect(await store.get(KEY)).toBeUndefined();
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
    const stored = await store.get(KEY);
    expect(stored).toMatchObject({
      access_token: 'A3',
      refresh_token: 'R3',
      issuer: 'https://as.example',
    });
    expect(JSON.stringify(stored)).not.toContain('ID');
  });

  it('a throwing store becomes a fixed-copy token_store error', async () => {
    const p = new ProjectionOAuthProvider({
      upstream,
      key: KEY,
      store: {
        get: () => Promise.reject(new Error('LIBRARY TEXT')),
        set: () => Promise.reject(new Error('LIBRARY TEXT')),
        delete: () => Promise.reject(new Error('LIBRARY TEXT')),
      },
    });
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

describe('SDK console.warn suppression (R58)', () => {
  it('drops [mcp-sdk] warnings during an auth run only, passes others, and restores console.warn', async () => {
    const seen: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      seen.push(args);
    };
    try {
      const patched = console.warn;
      await withSdkWarningsSuppressed(async () => {
        console.warn('[mcp-sdk] Could not refresh OAuth tokens. Cause: SECRET');
        await withSdkWarningsSuppressed(async () => {
          console.warn('[mcp-sdk] nested');
        });
        console.warn('integrator warning');
      });
      expect(console.warn).toBe(patched);
      console.warn('[mcp-sdk] outside an auth run');
      expect(seen).toEqual([['integrator warning'], ['[mcp-sdk] outside an auth run']]);
    } finally {
      console.warn = original;
    }
  });

  it('restores console.warn when the run throws', async () => {
    const before = console.warn;
    await expect(
      withSdkWarningsSuppressed(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(console.warn).toBe(before);
  });
});
