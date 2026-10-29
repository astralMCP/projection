/**
 * A fake `@napi-rs/keyring` module for token-store tests: an in-memory
 * "OS store" that records every entry's metadata (service, account,
 * options) and every operation, with switches for the failure shapes —
 * a store that throws (with secret-looking library text), hangs, or reads
 * back something other than what was written. CI never touches the real
 * OS credential store.
 */

import type { KeyringEntry, KeyringModule } from '../../../src/auth/token-store.js';

export type FakeKeyringMode =
  | 'ok'
  /** Every operation rejects with library text that must never surface. */
  | 'throw'
  /** Every operation never settles. */
  | 'hang'
  /** Writes succeed but read back a different value. */
  | 'corrupt-readback'
  /** Only deletes fail. */
  | 'throw-on-delete';

export const LIBRARY_ERROR_TEXT =
  'KEYRING-LIBRARY-INTERNAL-ERROR secret-service: org.freedesktop.Secret';

export interface FakeKeyring {
  module: KeyringModule;
  /** The stored passwords, keyed `<service>\u0000<account>`. */
  items: Map<string, string>;
  /** Every entry constructed. */
  entries: { service: string; account: string; options: unknown }[];
  /** Every operation performed. */
  ops: { op: 'get' | 'set' | 'delete'; account: string }[];
  mode: FakeKeyringMode;
}

const failure = (): Promise<never> => Promise.reject(new Error(LIBRARY_ERROR_TEXT));
const hang = (): Promise<never> => new Promise<never>(() => undefined);

export function createFakeKeyring(mode: FakeKeyringMode = 'ok'): FakeKeyring {
  const fake: FakeKeyring = {
    items: new Map(),
    entries: [],
    ops: [],
    mode,
    module: undefined as unknown as KeyringModule,
  };
  class AsyncEntry implements KeyringEntry {
    readonly #slot: string;
    readonly #account: string;
    constructor(service: string, account: string, options?: unknown) {
      fake.entries.push({ service, account, options });
      this.#slot = `${service}\u0000${account}`;
      this.#account = account;
    }
    getPassword(): Promise<string | null> {
      fake.ops.push({ op: 'get', account: this.#account });
      if (fake.mode === 'throw') return failure();
      if (fake.mode === 'hang') return hang();
      const value = fake.items.get(this.#slot);
      if (fake.mode === 'corrupt-readback' && value !== undefined)
        return Promise.resolve(`${value} `);
      return Promise.resolve(value ?? null);
    }
    setPassword(password: string): Promise<void> {
      fake.ops.push({ op: 'set', account: this.#account });
      if (fake.mode === 'throw') return failure();
      if (fake.mode === 'hang') return hang();
      fake.items.set(this.#slot, password);
      return Promise.resolve();
    }
    deletePassword(): Promise<boolean> {
      fake.ops.push({ op: 'delete', account: this.#account });
      if (fake.mode === 'throw' || fake.mode === 'throw-on-delete') return failure();
      if (fake.mode === 'hang') return hang();
      return Promise.resolve(fake.items.delete(this.#slot));
    }
  }
  fake.module = { AsyncEntry };
  return fake;
}
