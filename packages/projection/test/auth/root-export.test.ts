/**
 * `KeyringTokenStore` from the package root (DECISIONS D37): a consumer
 * can construct one for its own credentials, inject the keyring module,
 * and catch `TokenStoreError`.
 */

import { describe, expect, it } from 'vitest';
import {
  KeyringTokenStore,
  TokenStoreError,
  type KeyringModule,
  type KeyringTokenStoreOptions,
  type TokenStore,
} from '../../src/index.js';
import { createFakeKeyring } from './fakes/keyring.js';

describe('KeyringTokenStore from the package root', () => {
  it('stores, reads and deletes through an injected module', async () => {
    const fake = createFakeKeyring('ok');
    const load: () => Promise<KeyringModule> = () => Promise.resolve(fake.module);
    const options: KeyringTokenStoreOptions = { load, warn: () => undefined };
    const store: TokenStore = new KeyringTokenStore(options);

    await store.set('myapp:["pipedream"]', 'SECRET-VALUE');
    expect(await store.get('myapp:["pipedream"]')).toBe('SECRET-VALUE');
    expect([...fake.items.values()]).toEqual(['SECRET-VALUE']);
    expect(fake.entries[0]?.service).toBe('@astral-mcp/projection');
    expect(await store.delete('myapp:["pipedream"]', 'SECRET-VALUE')).toBe(true);
    expect(fake.items.size).toBe(0);
  });

  it('falls back to memory with one warning when the module is missing', async () => {
    const warnings: string[] = [];
    const store = new KeyringTokenStore({
      load: () =>
        Promise.reject(Object.assign(new Error('not installed'), { code: 'ERR_MODULE_NOT_FOUND' })),
      warn: (message) => warnings.push(message),
    });
    await store.set('myapp:["a"]', 'V1');
    await store.set('myapp:["b"]', 'V2');
    expect(await store.get('myapp:["a"]')).toBe('V1');
    expect(store.fallenBack).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain('V1');
  });

  it('throws the exported TokenStoreError when a delete cannot reach the store', async () => {
    const fake = createFakeKeyring('ok');
    const store = new KeyringTokenStore({
      load: () => Promise.resolve(fake.module),
      warn: () => undefined,
    });
    await store.set('myapp:["a"]', 'V1');
    fake.mode = 'throw-on-delete';
    const err = await store.delete('myapp:["a"]').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenStoreError);
    expect((err as Error).message).toBe('the token store failed');
  });
});
