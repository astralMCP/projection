/**
 * Sources given by URL, end to end against an in-process OAuth-protected
 * MCP server and authorization server on 127.0.0.1 (PRD §6.10 phase 1A:
 * R51, R53 provider rules, R58 refresh and compare-and-delete, R59, R60;
 * S1). Every case also greps every result, error, blob and byte of console
 * and stderr output for the tokens it used (§13 "No credential leaks").
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryTokenStore,
  openBlob,
  ProjectionError,
  wrapMcpServer,
  wrapMcpServers,
  type MultiProjectionFacade,
  type ProjectionFacade,
  type TokenRecord,
  type TokenStore,
} from '../../src/index.js';
import { tokenStoreKey } from '../../src/auth/index.js';
import { canonicalRequest } from '../../src/catalog/index.js';
import { ACCEPT, completed, sealedState } from '../mrtr/helpers.js';
import { fsServer } from '../multi/helpers.js';
import { startFakeUpstream, type FakeUpstream } from './fakes/index.js';
import { captureOutput, dump, leakedSecrets, type CapturedOutput } from './leak-guard.js';

const KEY = new Uint8Array(32).fill(7);
const CLIENT_ID = 'projection-test-client';
const CLIENT_SECRET = 'CLIENT-SECRET-DO-NOT-LEAK';

let upstream: FakeUpstream;
let output: CapturedOutput;
let facades: (ProjectionFacade | MultiProjectionFacade)[];
/** Every value a test produced, for the leak grep. */
let produced: unknown[];
/** Every secret a test used. */
let secrets: string[];

beforeEach(() => {
  facades = [];
  produced = [];
  secrets = [CLIENT_SECRET];
  output = captureOutput();
});

afterEach(async () => {
  for (const facade of facades) await facade.close();
  await upstream?.close();
  output.restore();
  // S1 / R59: no token or secret anywhere a test could read back.
  expect(leakedSecrets(`${output.text()}\n${produced.map(dump).join('\n')}`, secrets)).toEqual([]);
});

async function start(options: Parameters<typeof startFakeUpstream>[0] = {}): Promise<FakeUpstream> {
  upstream = await startFakeUpstream(options);
  return upstream;
}

function keyFor(fake: FakeUpstream): string {
  return tokenStoreKey(fake.resource.url, CLIENT_ID);
}

/** A store pre-loaded with a token set the fake accepts. */
async function storeWith(
  fake: FakeUpstream,
  record?: Partial<TokenRecord>,
): Promise<{ store: MemoryTokenStore; record: TokenRecord }> {
  const issued = fake.as.issue();
  secrets.push(issued.access_token, issued.refresh_token);
  const full: TokenRecord = { ...issued, issuer: fake.as.issuer, ...record };
  const store = new MemoryTokenStore();
  await store.set(keyFor(fake), full);
  return { store, record: full };
}

async function wrapUrl(
  fake: FakeUpstream,
  store: TokenStore,
  oauth: Record<string, unknown> = {},
): Promise<ProjectionFacade> {
  const facade = await wrapMcpServer(
    { url: fake.resource.url, oauth: { clientId: CLIENT_ID, ...oauth } },
    { blob: { key: KEY }, tokenStore: store },
  );
  facades.push(facade);
  return facade;
}

async function wrapFailure(run: () => Promise<unknown>): Promise<ProjectionError> {
  try {
    produced.push(await run());
  } catch (err) {
    produced.push(err);
    expect(err).toBeInstanceOf(ProjectionError);
    return err as ProjectionError;
  }
  throw new Error('expected the wrap to fail');
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

    const read = await facade.callTool({ name: 'whoami', args: {} }, 'modern');
    produced.push(
      read,
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
    const call = { name: 'create_issue', args: { title: 'hello' } };

    const suspended = await facade.callTool(call, 'modern');
    const blob = sealedState(suspended);
    const payload = openBlob(blob, {
      expectedKind: 'call',
      code: canonicalRequest(call.name, call.args),
      serverIdentity: `url:${fake.resource.url}`,
      config: { key: KEY },
    });
    produced.push(suspended, payload);
    expect(payload.serverIdentity).toBe(`url:${fake.resource.url}`);

    const approved = await facade.callTool(
      { ...call, requestState: blob, inputResponses: { call: ACCEPT } },
      'modern',
    );
    produced.push(approved);
    expect(JSON.stringify(approved)).toContain('created hello');
  });

  it('closes the client it owns on close()', async () => {
    const fake = await start();
    const { store } = await storeWith(fake);
    const facade = await wrapUrl(fake, store);
    await facade.close();
    facades = [];
    const after = await facade.callTool({ name: 'whoami', args: {} }, 'modern');
    produced.push(after);
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
});

describe('a source that needs sign-in fails the wrap with an auth error (phase 1A interim)', () => {
  it('no stored token: auth phase, says sign-in is required and comes next, contacts no authorization server', async () => {
    const fake = await start();
    const err = await wrapFailure(() => wrapUrl(fake, new MemoryTokenStore()));
    expect(err.phase).toBe('auth');
    expect(err.message).toMatch(/requires sign-in/);
    expect(`${err.message} ${err.hint}`).toMatch(/next Projection change/);
    expect(err.message).toContain('127.0.0.1');
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

  it('a stored token that no longer works and cannot refresh: auth error, record kept', async () => {
    const fake = await start();
    const { store, record } = await storeWith(fake);
    const accessOnly: TokenRecord = { access_token: record.access_token, issuer: record.issuer };
    await store.set(keyFor(fake), accessOnly);
    fake.as.expire(record.access_token);
    const err = await wrapFailure(() => wrapUrl(fake, store));
    expect(err.phase).toBe('auth');
    expect(fake.as.tokenRequests).toEqual([]);
    // Re-lock deletion arrives with phase 1B; phase 1A only refuses.
    expect(await store.get(keyFor(fake))).toEqual(accessOnly);
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
    let caught: unknown;
    try {
      produced.push(await wrapUrl(fake, store));
    } catch (err) {
      caught = err;
      produced.push(err);
    }
    expect(caught).toBeDefined();
    expect(caught instanceof ProjectionError && caught.phase === 'auth').toBe(false);
  });
});

describe('refresh through the SDK (R58, R59)', () => {
  it('refreshes an expired token, stores the rotated set, and proceeds', async () => {
    const fake = await start({ refresh: 'rotate' });
    const { store, record } = await storeWith(fake);
    fake.as.expire(record.access_token);

    const facade = await wrapUrl(fake, store);
    const stored = await store.get(keyFor(fake));
    expect(stored).toBeDefined();
    secrets.push(stored?.access_token ?? '', stored?.refresh_token ?? '');
    expect(stored?.access_token).not.toBe(record.access_token);
    expect(stored?.refresh_token).toBeDefined();
    expect(stored?.refresh_token).not.toBe(record.refresh_token);
    expect(stored?.issuer).toBe(fake.as.issuer);
    expect(stored?.expires_at).toBeGreaterThan(Date.now() / 1000);
    expect(fake.as.tokenRequests).toHaveLength(1);
    const read = await facade.callTool({ name: 'whoami', args: {} }, 'modern');
    produced.push(read);
    expect(JSON.stringify(read)).toContain('octocat');
  });

  it('keeps the old refresh token when the server does not rotate it', async () => {
    const fake = await start({ refresh: 'keep' });
    const { store, record } = await storeWith(fake);
    fake.as.expire(record.access_token);
    await wrapUrl(fake, store);
    const stored = await store.get(keyFor(fake));
    secrets.push(stored?.access_token ?? '');
    expect(stored?.refresh_token).toBe(record.refresh_token);
  });

  it('a definitive refresh failure (invalid_grant) compare-and-deletes the record', async () => {
    const fake = await start({ refresh: 'invalid_grant' });
    const { store, record } = await storeWith(fake);
    fake.as.expire(record.access_token);
    const err = await wrapFailure(() => wrapUrl(fake, store));
    expect(err.phase).toBe('auth');
    expect(await store.get(keyFor(fake))).toBeUndefined();
  });

  it('compare-and-delete spares a record another process stored meanwhile', async () => {
    const fake = await start({ refresh: 'invalid_grant' });
    const { store, record } = await storeWith(fake);
    fake.as.expire(record.access_token);
    const other = fake.as.issue('other-process');
    secrets.push(other.access_token, other.refresh_token);
    const replacement: TokenRecord = { access_token: other.access_token, issuer: fake.as.issuer };
    // Another process stores a fresh record while this one's refresh fails.
    const racing: TokenStore = {
      get: (key) => store.get(key),
      set: (key, value) => store.set(key, value),
      delete: async (key, expected) => {
        await store.set(key, replacement);
        return store.delete(key, expected);
      },
    };
    await wrapFailure(() => wrapUrl(fake, racing));
    expect(await store.get(keyFor(fake))).toEqual(replacement);
  });

  it('a transient refresh failure keeps the record, and the SDK console.warn is dropped (R58)', async () => {
    const fake = await start({ refresh: 'server_error' });
    const { store, record } = await storeWith(fake);
    fake.as.expire(record.access_token);
    const err = await wrapFailure(() => wrapUrl(fake, store));
    expect(err.phase).toBe('auth');
    expect(await store.get(keyFor(fake))).toEqual(record);
    expect(fake.as.tokenRequests).toHaveLength(1);
    expect(output.text()).not.toContain('[mcp-sdk]');
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
});

describe('signOut (R59)', () => {
  it('deletes the stored tokens of a single-server facade', async () => {
    const fake = await start();
    const { store } = await storeWith(fake);
    const facade = await wrapUrl(fake, store);
    await facade.signOut();
    expect(await store.get(keyFor(fake))).toBeUndefined();
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
    const identity = (facade as unknown as { deps: { view: { identity: string } } }).deps.view
      .identity;
    expect(identity).toBe(
      `multi:${JSON.stringify([
        ['fs', 'files@1.0.0'],
        ['gh', `url:${fake.resource.url}`],
      ])}`,
    );
    const read = await facade.callTool({ name: 'gh.whoami', args: {} }, 'modern');
    produced.push(read, facade.instructions);
    expect(JSON.stringify(read)).toContain('octocat');

    await expect(facade.signOut('fs')).rejects.toMatchObject({ phase: 'validate' });
    await expect(facade.signOut('nope')).rejects.toMatchObject({ phase: 'validate' });
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
});
