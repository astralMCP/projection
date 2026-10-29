/**
 * The token store (PRD R58, R59, §13 "Token store"): keys, compare-and-
 * delete, the keyring adapter against a fake `@napi-rs/keyring` (CI never
 * touches the real OS store), the in-memory fallback with exactly one
 * warning, the 5-second timeout, and fixed-copy failures. One opt-in test
 * (`PROJ_LIVE_KEYCHAIN=1`) round-trips a ≥4 KB record through the real OS
 * store and deletes it.
 */

import { describe, expect, it } from 'vitest';
import {
  FALLBACK_WARNING,
  KEYRING_SERVICE,
  KEYRING_TIMEOUT_MS,
  keyringAccount,
  KeyringTokenStore,
  MemoryTokenStore,
  sameTokenRecord,
  tokenStoreKey,
  type TokenRecord,
} from '../../src/auth/index.js';
import {
  TokenStoreError,
  parseTokenRecord,
  serializeTokenRecord,
} from '../../src/auth/token-store.js';
import { createFakeKeyring, LIBRARY_ERROR_TEXT } from './fakes/keyring.js';
import { dump } from './leak-guard.js';

const URL_KEY = tokenStoreKey('https://api.example.com/mcp?tenant=acme', 'client-1');
const RECORD: TokenRecord = {
  access_token: 'AT-SECRET',
  refresh_token: 'RT-SECRET',
  expires_at: 1_900_000_000,
  scope: 'repo',
  issuer: 'https://login.example.com',
};

function keyringStore(mode: Parameters<typeof createFakeKeyring>[0] = 'ok', timeoutMs = 50) {
  const fake = createFakeKeyring(mode);
  const warnings: string[] = [];
  const store = new KeyringTokenStore({
    load: () => Promise.resolve(fake.module),
    timeoutMs,
    warn: (message) => warnings.push(message),
  });
  return { fake, store, warnings };
}

describe('keys and records (R59, R62)', () => {
  it('keys by canonical URL, client id and the local principal, injectively', () => {
    expect(URL_KEY).toBe(
      JSON.stringify(['tokens', 'https://api.example.com/mcp?tenant=acme', 'client-1', 'local']),
    );
    expect(tokenStoreKey('a","b', 'c')).not.toBe(tokenStoreKey('a', 'b","c'));
  });

  it('serializes records as ASCII JSON without unknown fields (no id_token)', () => {
    const text = serializeTokenRecord({
      ...RECORD,
      scope: 'répo',
      id_token: 'ID-TOKEN',
    } as TokenRecord);
    expect(text).toMatch(/^[\x20-\x7e]*$/);
    expect(text).not.toContain('ID-TOKEN');
    expect(parseTokenRecord(text)?.scope).toBe('répo');
    expect(parseTokenRecord('not json')).toBeUndefined();
    expect(parseTokenRecord('{"access_token":""}')).toBeUndefined();
  });
});

describe('MemoryTokenStore compare-and-delete (R58)', () => {
  it('deletes unconditionally without expected, only on a match with it', async () => {
    const store = new MemoryTokenStore();
    await store.set(URL_KEY, RECORD);
    expect(await store.delete(URL_KEY, { ...RECORD, access_token: 'OTHER' })).toBe(false);
    expect(await store.get(URL_KEY)).toEqual(RECORD);
    expect(await store.delete(URL_KEY, { ...RECORD })).toBe(true);
    expect(await store.get(URL_KEY)).toBeUndefined();
    expect(await store.delete(URL_KEY)).toBe(false);
    await store.set(URL_KEY, RECORD);
    expect(await store.delete(URL_KEY)).toBe(true);
    expect(sameTokenRecord(RECORD, { ...RECORD })).toBe(true);
  });
});

describe('KeyringTokenStore (R59)', () => {
  it('files entries under the service with a SHA-256 account: no URL in the metadata', async () => {
    const { fake, store, warnings } = keyringStore();
    await store.set(URL_KEY, RECORD);
    expect(await store.get(URL_KEY)).toEqual(RECORD);
    expect(fake.entries.length).toBeGreaterThan(0);
    for (const entry of fake.entries) {
      expect(entry.service).toBe(KEYRING_SERVICE);
      expect(entry.account).toBe(keyringAccount(URL_KEY));
      expect(entry.account).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(entry)).not.toMatch(/example|tenant|https?:/);
      // Pinned to the Secret Service on Linux, never the session keyring.
      expect(entry.options).toEqual({ linux: { store: 'secret-service' } });
    }
    expect(warnings).toEqual([]);
  });

  it('round-trips a large record and reads back every write', async () => {
    const { fake, store } = keyringStore();
    const large: TokenRecord = { ...RECORD, access_token: `AT-${'x'.repeat(5000)}` };
    await store.set(URL_KEY, large);
    expect(await store.get(URL_KEY)).toEqual(large);
    // set, then the read-back get.
    expect(fake.ops.slice(0, 2).map((op) => op.op)).toEqual(['set', 'get']);
  });

  it('compare-and-deletes against the stored record', async () => {
    const { store } = keyringStore();
    await store.set(URL_KEY, RECORD);
    expect(await store.delete(URL_KEY, { ...RECORD, access_token: 'NEWER' })).toBe(false);
    expect(await store.get(URL_KEY)).toEqual(RECORD);
    expect(await store.delete(URL_KEY, RECORD)).toBe(true);
    expect(await store.get(URL_KEY)).toBeUndefined();
  });

  it('falls back to memory with exactly one warning when the module is absent', async () => {
    const warnings: string[] = [];
    const store = new KeyringTokenStore({
      load: () =>
        Promise.reject(new Error(`Cannot find module '@napi-rs/keyring' ${LIBRARY_ERROR_TEXT}`)),
      warn: (message) => warnings.push(message),
    });
    await store.set(URL_KEY, RECORD);
    expect(await store.get(URL_KEY)).toEqual(RECORD);
    await store.set(tokenStoreKey('https://b.example/', 'c'), RECORD);
    expect(warnings).toEqual([FALLBACK_WARNING]);
    expect(store.fallenBack).toBe(true);
  });

  it('falls back when the store throws; the warning carries no library text or secret', async () => {
    const { store, warnings } = keyringStore('throw');
    await store.set(URL_KEY, RECORD);
    expect(await store.get(URL_KEY)).toEqual(RECORD);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(LIBRARY_ERROR_TEXT);
    expect(warnings[0]).not.toContain('SECRET');
  });

  it('a write that reads back differently is a store failure (verified writes)', async () => {
    const { store, warnings } = keyringStore('corrupt-readback');
    await store.set(URL_KEY, RECORD);
    expect(store.fallenBack).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(await store.get(URL_KEY)).toEqual(RECORD);
  });

  it('a hung operation times out and falls back', async () => {
    const { store, warnings } = keyringStore('hang', 20);
    const started = Date.now();
    await store.set(URL_KEY, RECORD);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await store.get(URL_KEY)).toEqual(RECORD);
    expect(warnings).toHaveLength(1);
  });

  it('a hung module load times out and falls back', async () => {
    const warnings: string[] = [];
    const store = new KeyringTokenStore({
      load: () => new Promise(() => undefined),
      timeoutMs: 20,
      warn: (message) => warnings.push(message),
    });
    expect(await store.get(URL_KEY)).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it('the default timeout is 5 seconds', () => {
    expect(KEYRING_TIMEOUT_MS).toBe(5_000);
  });

  it('a failing delete throws fixed copy (a sign-out must not silently keep the token)', async () => {
    const { fake, store } = keyringStore();
    await store.set(URL_KEY, RECORD);
    fake.mode = 'throw-on-delete';
    const err = await store.delete(URL_KEY).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(TokenStoreError);
    expect(dump(err)).not.toContain(LIBRARY_ERROR_TEXT);
    expect(store.fallenBack).toBe(true);
  });
});

describe.skipIf(process.env['PROJ_LIVE_KEYCHAIN'] !== '1')(
  'the real OS credential store (opt-in)',
  () => {
    it('round-trips a record of at least 4 KB and deletes it', async () => {
      const warnings: string[] = [];
      const store = new KeyringTokenStore({ warn: (message) => warnings.push(message) });
      const key = tokenStoreKey(
        `https://live-keychain-test.invalid/${Date.now()}`,
        'projection-live-test',
      );
      const record: TokenRecord = { ...RECORD, access_token: `AT-${'y'.repeat(4200)}` };
      try {
        await store.set(key, record);
        expect(warnings).toEqual([]);
        expect(await store.get(key)).toEqual(record);
      } finally {
        expect(await store.delete(key)).toBe(true);
      }
      expect(await store.get(key)).toBeUndefined();
    });
  },
);
