/**
 * The token store (PRD R58, R59, §13 "Token store"): keys, Projection's
 * record serialization, compare-and-delete over opaque strings, the keyring
 * adapter against a fake `@napi-rs/keyring` (CI never touches the real OS
 * store), the in-memory fallback with exactly one warning, the 5-second
 * timeout, per-key serialization, late writes, deletes after the fallback,
 * and fixed-copy failures. One opt-in test (`PROJ_LIVE_KEYCHAIN=1`)
 * round-trips a ≥4 KB record through the real OS store and deletes it.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeTokenRecord,
  encodeTokenRecord,
  FALLBACK_WARNING,
  KEYRING_SERVICE,
  KEYRING_TIMEOUT_MS,
  keyringAccount,
  KeyringTokenStore,
  MemoryTokenStore,
  tokenStoreKey,
  TokenStoreError,
  type TokenRecord,
} from '../../src/auth/index.js';
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
const VALUE = encodeTokenRecord(RECORD);
const NEWER = encodeTokenRecord({ ...RECORD, access_token: 'AT-NEWER-SECRET' });

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

/** The one OS entry the fake holds, if any. */
function osEntry(fake: ReturnType<typeof createFakeKeyring>): string | undefined {
  return [...fake.items.values()][0];
}

/** The error of importing a package that is not installed. */
function moduleNotFound(): Error {
  return Object.assign(new Error(`Cannot find package '@napi-rs/keyring' ${LIBRARY_ERROR_TEXT}`), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
}

async function until(check: () => boolean, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    // eslint-disable-next-line no-await-in-loop -- polling a background effect
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('keys and records (R59, R62)', () => {
  it('keys a token set by kind, canonical URL, client id and the local principal, injectively', () => {
    expect(URL_KEY).toBe(
      `tokens:${JSON.stringify(['https://api.example.com/mcp?tenant=acme', 'client-1', 'local'])}`,
    );
    expect(URL_KEY.startsWith('tokens:')).toBe(true);
    expect(tokenStoreKey('a","b', 'c')).not.toBe(tokenStoreKey('a', 'b","c'));
  });

  it('serializes records as ASCII JSON without unknown fields (no id_token)', () => {
    const text = encodeTokenRecord({
      ...RECORD,
      scope: 'répo',
      id_token: 'ID-TOKEN',
    } as TokenRecord);
    expect(text).toMatch(/^[\x20-\x7e]*$/);
    expect(text).not.toContain('ID-TOKEN');
    expect(decodeTokenRecord(text)?.scope).toBe('répo');
    expect(decodeTokenRecord('not json')).toBeUndefined();
    expect(decodeTokenRecord('{"access_token":""}')).toBeUndefined();
    expect(decodeTokenRecord(42)).toBeUndefined();
    expect(decodeTokenRecord(undefined)).toBeUndefined();
  });
});

describe('MemoryTokenStore compare-and-delete (R58)', () => {
  it('stores opaque strings; deletes unconditionally without expected, only on an exact match with it', async () => {
    const store = new MemoryTokenStore();
    await store.set(URL_KEY, VALUE);
    expect(await store.get(URL_KEY)).toBe(VALUE);
    expect(await store.delete(URL_KEY, NEWER)).toBe(false);
    expect(await store.get(URL_KEY)).toBe(VALUE);
    expect(await store.delete(URL_KEY, VALUE)).toBe(true);
    expect(await store.get(URL_KEY)).toBeUndefined();
    expect(await store.delete(URL_KEY)).toBe(false);
    await store.set(URL_KEY, VALUE);
    expect(await store.delete(URL_KEY)).toBe(true);
    await expect(store.set(URL_KEY, RECORD as unknown as string)).rejects.toBeInstanceOf(
      TokenStoreError,
    );
  });
});

describe('KeyringTokenStore (R59)', () => {
  it('files entries under the service with a SHA-256 account: no URL in the metadata', async () => {
    const { fake, store, warnings } = keyringStore();
    await store.set(URL_KEY, VALUE);
    expect(await store.get(URL_KEY)).toBe(VALUE);
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

  it('round-trips a large value and reads back every write', async () => {
    const { fake, store } = keyringStore();
    const large = encodeTokenRecord({ ...RECORD, access_token: `AT-${'x'.repeat(5000)}` });
    await store.set(URL_KEY, large);
    expect(await store.get(URL_KEY)).toBe(large);
    // set, then the read-back get.
    expect(fake.ops.slice(0, 2).map((op) => op.op)).toEqual(['set', 'get']);
  });

  it('compare-and-deletes against the stored string', async () => {
    const { store } = keyringStore();
    await store.set(URL_KEY, VALUE);
    expect(await store.delete(URL_KEY, NEWER)).toBe(false);
    expect(await store.get(URL_KEY)).toBe(VALUE);
    expect(await store.delete(URL_KEY, VALUE)).toBe(true);
    expect(await store.get(URL_KEY)).toBeUndefined();
  });

  it('falls back to memory with exactly one warning when the module is absent', async () => {
    const warnings: string[] = [];
    const store = new KeyringTokenStore({
      load: () => Promise.reject(moduleNotFound()),
      warn: (message) => warnings.push(message),
    });
    await store.set(URL_KEY, VALUE);
    expect(await store.get(URL_KEY)).toBe(VALUE);
    await store.set(tokenStoreKey('https://b.example/', 'c'), VALUE);
    expect(await store.delete(URL_KEY)).toBe(true);
    expect(warnings).toEqual([FALLBACK_WARNING]);
    expect(store.fallenBack).toBe(true);
  });

  it('falls back when the store throws; the warning carries no library text or secret', async () => {
    const { store, warnings } = keyringStore('throw');
    await store.set(URL_KEY, VALUE);
    expect(await store.get(URL_KEY)).toBe(VALUE);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(LIBRARY_ERROR_TEXT);
    expect(warnings[0]).not.toContain('SECRET');
  });

  it('a write that reads back differently is a store failure (verified writes)', async () => {
    const { store, warnings } = keyringStore('corrupt-readback');
    await store.set(URL_KEY, VALUE);
    expect(store.fallenBack).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(await store.get(URL_KEY)).toBe(VALUE);
  });

  it('a hung operation times out and falls back', async () => {
    const { store, warnings } = keyringStore('hang', 20);
    const started = Date.now();
    await store.set(URL_KEY, VALUE);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await store.get(URL_KEY)).toBe(VALUE);
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
    await store.set(URL_KEY, VALUE);
    fake.mode = 'throw-on-delete';
    const err = await store.delete(URL_KEY).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(TokenStoreError);
    expect(dump(err)).not.toContain(LIBRARY_ERROR_TEXT);
    expect(store.fallenBack).toBe(true);
  });
});

describe('KeyringTokenStore after the fallback (R59)', () => {
  it('a delete still removes the OS entry left behind by a transient failure (sign-out)', async () => {
    const { fake, store } = keyringStore();
    await store.set(URL_KEY, VALUE);
    fake.mode = 'throw';
    await store.get(URL_KEY); // e.g. a keychain prompt dismissed once
    expect(store.fallenBack).toBe(true);
    fake.mode = 'ok';
    expect(await store.delete(URL_KEY)).toBe(true);
    expect(fake.items.size).toBe(0);
  });

  it('a delete that cannot reach the OS entry throws fixed copy', async () => {
    const { fake, store } = keyringStore();
    await store.set(URL_KEY, VALUE);
    fake.mode = 'throw';
    await store.get(URL_KEY);
    const err = await store.delete(URL_KEY).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(TokenStoreError);
    expect(dump(err)).not.toContain(LIBRARY_ERROR_TEXT);
    expect(fake.items.size).toBe(1);
  });

  it('a rotated value is written behind to the OS entry, so it never keeps a dead refresh token', async () => {
    const { fake, store } = keyringStore();
    await store.set(URL_KEY, VALUE);
    fake.mode = 'throw';
    await store.get(URL_KEY);
    fake.mode = 'ok';
    await store.set(URL_KEY, NEWER);
    expect(await store.get(URL_KEY)).toBe(NEWER);
    await until(() => osEntry(fake) === NEWER);
  });

  it('a compare-and-delete of a key never seen in the keyring stays in memory', async () => {
    const { fake, store } = keyringStore('throw');
    await store.set(URL_KEY, VALUE); // falls back at once
    fake.mode = 'ok';
    const opsBefore = fake.ops.length;
    expect(await store.delete(URL_KEY, VALUE)).toBe(true);
    expect(fake.ops.length).toBe(opsBefore);
  });
});

describe('KeyringTokenStore delete without a working OS store (R59)', () => {
  it('no OS store at all (headless Linux without a Secret Service): signOut returns the memory result', async () => {
    const { fake, store } = keyringStore('throw');
    await store.set(URL_KEY, VALUE);
    expect(store.fallenBack).toBe(true);
    expect(await store.delete(URL_KEY)).toBe(true);
    expect(await store.get(URL_KEY)).toBeUndefined();
    expect(await store.delete(URL_KEY)).toBe(false);
    expect(fake.ops.some((op) => op.op === 'delete')).toBe(true);
  });

  it('the module is not installed: signOut returns the memory result', async () => {
    const store = new KeyringTokenStore({
      load: () => Promise.reject(moduleNotFound()),
      warn: () => undefined,
    });
    await store.set(URL_KEY, VALUE);
    expect(await store.delete(URL_KEY)).toBe(true);
    expect(await store.delete(URL_KEY)).toBe(false);
  });

  it('the module failed to load (an error other than not installed): delete throws fixed copy', async () => {
    const store = new KeyringTokenStore({
      load: () => Promise.reject(new Error(`native binding failed ${LIBRARY_ERROR_TEXT}`)),
      warn: () => undefined,
    });
    await store.set(URL_KEY, VALUE);
    const err = await store.delete(URL_KEY).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(TokenStoreError);
    expect(dump(err)).not.toContain(LIBRARY_ERROR_TEXT);
    // Memory is cleared all the same.
    expect(await store.get(URL_KEY)).toBeUndefined();
  });

  it('the module load timed out: delete throws (an entry from an earlier process may remain)', async () => {
    const fake = createFakeKeyring('ok');
    const earlier = new KeyringTokenStore({ load: () => Promise.resolve(fake.module) });
    await earlier.set(URL_KEY, VALUE);
    const store = new KeyringTokenStore({
      load: () => new Promise(() => undefined),
      timeoutMs: 20,
      warn: () => undefined,
    });
    expect(await store.get(URL_KEY)).toBeUndefined();
    await expect(store.delete(URL_KEY)).rejects.toBeInstanceOf(TokenStoreError);
    expect(osEntry(fake)).toBe(VALUE);
  });

  it('once the OS store has worked in this process, a failing delete of an unseen key still throws', async () => {
    const { fake, store } = keyringStore();
    await store.set(tokenStoreKey('https://b.example/mcp', 'c'), VALUE); // the store works
    fake.mode = 'throw';
    await expect(store.delete(URL_KEY)).rejects.toBeInstanceOf(TokenStoreError);
    // After the fallback too.
    await expect(store.delete(URL_KEY)).rejects.toBeInstanceOf(TokenStoreError);
  });
});

describe('KeyringTokenStore ordering and late writes (R58, R59)', () => {
  it('runs operations on one key one at a time, in order', async () => {
    const { fake, store } = keyringStore('ok', 1_000);
    fake.holdWrites = true;
    const first = store.set(URL_KEY, VALUE);
    const second = store.set(URL_KEY, NEWER);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The second write has not started: it waits for the first to settle.
    expect(fake.ops.filter((op) => op.op === 'set')).toHaveLength(1);
    fake.holdWrites = false;
    fake.releaseWrites();
    await Promise.all([first, second]);
    expect(osEntry(fake)).toBe(NEWER);
    expect(store.fallenBack).toBe(false);
  });

  it('a timed-out write that lands later does not leave its stale value in the OS store', async () => {
    const fake = createFakeKeyring('ok');
    const slow = new KeyringTokenStore({
      load: () => Promise.resolve(fake.module),
      timeoutMs: 20,
      warn: () => undefined,
    });
    const other = new KeyringTokenStore({
      load: () => Promise.resolve(fake.module),
      warn: () => undefined,
    });
    const stale = encodeTokenRecord({ ...RECORD, access_token: 'AT-SLOW-SECRET' });
    fake.holdWrites = true;
    await slow.set(URL_KEY, stale); // times out: this process keeps it in memory
    expect(slow.fallenBack).toBe(true);
    fake.holdWrites = false;
    await other.set(URL_KEY, NEWER); // another process stores a newer record
    fake.releaseWrites(); // the slow native write lands after it
    await until(() => osEntry(fake) !== stale);
    expect(osEntry(fake) ?? '').not.toContain('SLOW');
  });

  it('a late write is replaced by the newer value this process holds', async () => {
    const { fake, store } = keyringStore('ok', 20);
    await store.set(URL_KEY, VALUE); // seen in the keyring
    fake.holdWrites = true;
    const stale = encodeTokenRecord({ ...RECORD, access_token: 'AT-SLOW-SECRET' });
    await store.set(URL_KEY, stale); // times out
    fake.holdWrites = false;
    await store.set(URL_KEY, NEWER); // after the fallback: memory, and written behind
    fake.releaseWrites();
    await until(() => osEntry(fake) === NEWER);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(osEntry(fake)).toBe(NEWER);
  });

  it('a write-behind that lands after a timed-out signOut is deleted again', async () => {
    const { fake, store } = keyringStore('ok', 50);
    await store.set(URL_KEY, VALUE); // seen in the keyring
    fake.mode = 'throw';
    await store.get(URL_KEY); // a transient failure: fallback
    fake.mode = 'ok';
    fake.holdWrites = true;
    await store.set(URL_KEY, NEWER); // memory, and written behind (held)
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The delete waits behind the held write and times out.
    await expect(store.delete(URL_KEY)).rejects.toBeInstanceOf(TokenStoreError);
    expect(await store.get(URL_KEY)).toBeUndefined();
    fake.holdWrites = false;
    fake.releaseWrites(); // the write-behind lands after the sign-out
    await until(() => fake.items.size === 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.items.size).toBe(0);
    // A retried signOut now succeeds.
    expect(await store.delete(URL_KEY)).toBe(false);
  });

  it('write-behinds that land after a signOut leave nothing in the OS store', async () => {
    const { fake, store } = keyringStore('ok', 50);
    await store.set(URL_KEY, VALUE);
    fake.holdWrites = true;
    const stale = encodeTokenRecord({ ...RECORD, access_token: 'AT-SLOW-SECRET' });
    await store.set(URL_KEY, stale); // times out: fallback, written behind
    await store.set(URL_KEY, NEWER); // fallen back: memory, written behind
    await store.delete(URL_KEY).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 120));
    fake.holdWrites = false;
    fake.releaseWrites();
    await until(() => fake.items.size === 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.items.size).toBe(0);
    expect(await store.get(URL_KEY)).toBeUndefined();
  });

  it('a late write-behind of the value memory still holds stays in the OS store', async () => {
    const { fake, store } = keyringStore('ok', 30);
    await store.set(URL_KEY, VALUE);
    fake.mode = 'throw';
    await store.get(URL_KEY); // fallback
    fake.mode = 'ok';
    fake.holdWrites = true;
    await store.set(URL_KEY, NEWER); // written behind, held past its timeout
    await new Promise((resolve) => setTimeout(resolve, 60));
    fake.holdWrites = false;
    fake.releaseWrites();
    await until(() => osEntry(fake) === NEWER);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(osEntry(fake)).toBe(NEWER);
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
      const value = encodeTokenRecord({ ...RECORD, access_token: `AT-${'y'.repeat(4200)}` });
      try {
        await store.set(key, value);
        expect(warnings).toEqual([]);
        expect(await store.get(key)).toBe(value);
      } finally {
        expect(await store.delete(key)).toBe(true);
      }
      expect(await store.get(key)).toBeUndefined();
    });
  },
);
