/**
 * Token residence (PRD R59, S1): the {@link TokenStore} contract, its keys,
 * the in-memory store, and the default store — the OS credential store
 * through the optional native library `@napi-rs/keyring` (macOS Keychain,
 * Linux Secret Service, Windows Credential Manager), with an in-memory
 * fallback.
 *
 * Nothing in this module logs, rethrows or embeds a token or an error from
 * the keyring library: a store failure is reported in fixed library copy.
 */

import { createHash } from 'node:crypto';

/**
 * A stored token set (R59). Serialized as ASCII JSON; an `id_token` is never
 * stored. `expires_at` is in seconds since the epoch. `issuer` is the
 * authorization server the tokens were issued by, so they are never
 * presented to another one (SEP-2352 / R61).
 */
export interface TokenRecord {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
  issuer: string;
}

/**
 * Where upstream tokens live (R59). `WrapOptions.tokenStore` replaces the
 * default OS-credential-store one; a horizontally scaled deployment supplies
 * a shared store (R27).
 *
 * - `get` returns the record stored under `key`, or `undefined`.
 * - `set` replaces it.
 * - `delete` removes it and reports whether it removed anything. With
 *   `expected`, it is a compare-and-delete (R58): it deletes only when the
 *   stored record still equals `expected` (see {@link sameTokenRecord}), so a
 *   record another process has just stored survives.
 *
 * Implementations must never log or surface a record.
 */
export interface TokenStore {
  get(key: string): Promise<TokenRecord | undefined>;
  set(key: string, record: TokenRecord): Promise<void>;
  delete(key: string, expected?: TokenRecord): Promise<boolean>;
}

/** The single principal of phase 1 (R62). */
export const LOCAL_PRINCIPAL = 'local';

/** The keyring service name every entry is filed under (R59). */
export const KEYRING_SERVICE = '@astral-mcp/projection';

/** Every keyring operation, and loading the module, is bounded by this (R59). */
export const KEYRING_TIMEOUT_MS = 5_000;

/** The one-time warning printed when the in-memory fallback takes over (R59). No secret, no library text. */
export const FALLBACK_WARNING =
  '[@astral-mcp/projection] The OS credential store is unavailable, so upstream sign-in tokens are kept in memory for this process only: users will sign in again after a restart.\n';

/**
 * The token-set key (R59): canonical resource URL, client id and principal,
 * JSON-encoded so the key is injective whatever the parts contain.
 */
export function tokenStoreKey(
  canonicalUrl: string,
  clientId: string,
  principal: string = LOCAL_PRINCIPAL,
): string {
  return JSON.stringify(['tokens', canonicalUrl, clientId, principal]);
}

/** The keyring account for a store key: lowercase hex SHA-256, so no URL reaches the store's metadata (R59). */
export function keyringAccount(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** A copy holding only the {@link TokenRecord} fields, in a fixed order. */
export function normalizeTokenRecord(record: TokenRecord): TokenRecord {
  return {
    access_token: record.access_token,
    ...(record.refresh_token !== undefined ? { refresh_token: record.refresh_token } : {}),
    ...(record.expires_at !== undefined ? { expires_at: record.expires_at } : {}),
    ...(record.scope !== undefined ? { scope: record.scope } : {}),
    issuer: record.issuer,
  };
}

/** Field-by-field equality of two records: what compare-and-delete compares (R58). */
export function sameTokenRecord(a: TokenRecord, b: TokenRecord): boolean {
  return serializeTokenRecord(a) === serializeTokenRecord(b);
}

/** ASCII JSON of a record (R59): every non-ASCII character escaped. */
export function serializeTokenRecord(record: TokenRecord): string {
  return JSON.stringify(normalizeTokenRecord(record)).replace(
    /[\u0080-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/** Parse a stored record; anything malformed reads as absent (the user signs in again). */
export function parseTokenRecord(text: string): TokenRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const accessToken = record['access_token'];
  const issuer = record['issuer'];
  const expiresAt = record['expires_at'];
  if (typeof accessToken !== 'string' || accessToken === '' || typeof issuer !== 'string')
    return undefined;
  if (!optionalString(record['refresh_token']) || !optionalString(record['scope']))
    return undefined;
  if (expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))) {
    return undefined;
  }
  return normalizeTokenRecord(record as unknown as TokenRecord);
}

function isTokenRecord(value: unknown): value is TokenRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { access_token?: unknown }).access_token === 'string' &&
    typeof (value as { issuer?: unknown }).issuer === 'string'
  );
}

/**
 * The process-local store: the fallback, and what tests and single-process
 * deployments that want no persistence can pass as `tokenStore`.
 */
export class MemoryTokenStore implements TokenStore {
  readonly #records = new Map<string, string>();

  get(key: string): Promise<TokenRecord | undefined> {
    const text = this.#records.get(key);
    return Promise.resolve(text === undefined ? undefined : parseTokenRecord(text));
  }

  set(key: string, record: TokenRecord): Promise<void> {
    if (!isTokenRecord(record)) return Promise.reject(new TokenStoreError());
    this.#records.set(key, serializeTokenRecord(record));
    return Promise.resolve();
  }

  delete(key: string, expected?: TokenRecord): Promise<boolean> {
    const text = this.#records.get(key);
    if (text === undefined) return Promise.resolve(false);
    if (expected !== undefined && text !== serializeTokenRecord(expected))
      return Promise.resolve(false);
    this.#records.delete(key);
    return Promise.resolve(true);
  }
}

/**
 * A token-store failure, in fixed library copy: the keyring library's own
 * error text is never kept, logged or surfaced (R59).
 */
export class TokenStoreError extends Error {
  constructor() {
    super('the token store failed');
    this.name = 'TokenStoreError';
  }
}

// ---------------------------------------------------------------------------
// The keyring-backed default store
// ---------------------------------------------------------------------------

/** The slice of `@napi-rs/keyring`'s `AsyncEntry` Projection uses. */
export interface KeyringEntry {
  getPassword(signal?: AbortSignal | null): Promise<string | null | undefined>;
  setPassword(password: string, signal?: AbortSignal | null): Promise<void>;
  deletePassword(signal?: AbortSignal | null): Promise<boolean>;
}

/** The slice of the `@napi-rs/keyring` module Projection uses. */
export interface KeyringModule {
  AsyncEntry: new (
    service: string,
    account: string,
    options?: { linux?: { store?: 'secret-service' | 'keyutils' } },
  ) => KeyringEntry;
}

export interface KeyringTokenStoreOptions {
  /** Loads the keyring module. Default: a dynamic `import('@napi-rs/keyring')`. */
  load?: () => Promise<KeyringModule>;
  /** Per-operation timeout. Default {@link KEYRING_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Where the one-time fallback warning goes. Default: `process.stderr`. */
  warn?: (message: string) => void;
}

const KEYRING_SPECIFIER = '@napi-rs/keyring';

async function importKeyring(): Promise<KeyringModule> {
  // A variable specifier keeps bundlers from resolving the optional
  // dependency at build time; it is loaded on first use only.
  const specifier: string = KEYRING_SPECIFIER;
  const loaded = (await import(specifier)) as Partial<KeyringModule> & {
    default?: Partial<KeyringModule>;
  };
  const module = loaded.AsyncEntry !== undefined ? loaded : loaded.default;
  if (module?.AsyncEntry === undefined) throw new TokenStoreError();
  return module as KeyringModule;
}

/** Thrown inside {@link withTimeout}; never escapes the store. */
class KeyringTimeout extends Error {}

async function withTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new KeyringTimeout());
    }, timeoutMs);
    // A hung native call must not keep the process alive on its own.
    timer.unref?.();
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The default store (R59): one keyring entry per key — service
 * `@astral-mcp/projection`, account the SHA-256 of the key — holding the
 * record as ASCII JSON. On Linux the entry is pinned to the Secret Service,
 * so a machine without one falls back instead of using the non-persistent
 * kernel keyring. `@napi-rs/keyring` has no label setting, so entries carry
 * no label.
 *
 * Every write is read back and compared. Every operation, and loading the
 * module, is bounded by the timeout. When the module is absent or fails to
 * load, or an operation fails, times out or mis-verifies, the store falls
 * back to memory for the rest of its life with one warning on stderr; the
 * failing `get` / `set` is served from memory. A failing `delete` deletes
 * from memory too but then throws {@link TokenStoreError}: a sign-out that
 * silently left the token in the OS store would be worse than an error.
 */
export class KeyringTokenStore implements TokenStore {
  readonly #load: () => Promise<KeyringModule>;
  readonly #timeoutMs: number;
  readonly #warn: (message: string) => void;
  readonly #memory = new MemoryTokenStore();
  #module: Promise<KeyringModule | undefined> | undefined;
  #fallenBack = false;

  constructor(options: KeyringTokenStoreOptions = {}) {
    this.#load = options.load ?? importKeyring;
    this.#timeoutMs = options.timeoutMs ?? KEYRING_TIMEOUT_MS;
    this.#warn = options.warn ?? ((message) => process.stderr.write(message));
  }

  /** True once the store has fallen back to memory. */
  get fallenBack(): boolean {
    return this.#fallenBack;
  }

  async get(key: string): Promise<TokenRecord | undefined> {
    const entry = await this.#entry(key);
    if (entry === undefined) return this.#memory.get(key);
    try {
      const text = await withTimeout(this.#timeoutMs, (signal) => entry.getPassword(signal));
      return typeof text === 'string' ? parseTokenRecord(text) : undefined;
    } catch {
      this.#fallBack();
      return this.#memory.get(key);
    }
  }

  async set(key: string, record: TokenRecord): Promise<void> {
    if (!isTokenRecord(record)) throw new TokenStoreError();
    const entry = await this.#entry(key);
    if (entry === undefined) return this.#memory.set(key, record);
    const text = serializeTokenRecord(record);
    try {
      await withTimeout(this.#timeoutMs, (signal) => entry.setPassword(text, signal));
      const readBack = await withTimeout(this.#timeoutMs, (signal) => entry.getPassword(signal));
      if (readBack !== text) throw new TokenStoreError();
    } catch {
      this.#fallBack();
      await this.#memory.set(key, record);
    }
  }

  async delete(key: string, expected?: TokenRecord): Promise<boolean> {
    const entry = await this.#entry(key);
    if (entry === undefined) return this.#memory.delete(key, expected);
    try {
      if (expected !== undefined) {
        const text = await withTimeout(this.#timeoutMs, (signal) => entry.getPassword(signal));
        if (typeof text !== 'string' || text !== serializeTokenRecord(expected)) return false;
      }
      return await withTimeout(this.#timeoutMs, (signal) => entry.deletePassword(signal));
    } catch {
      this.#fallBack();
      await this.#memory.delete(key, expected);
      throw new TokenStoreError();
    }
  }

  async #entry(key: string): Promise<KeyringEntry | undefined> {
    if (this.#fallenBack) return undefined;
    this.#module ??= withTimeout(this.#timeoutMs, () => this.#load()).catch(() => undefined);
    const module = await this.#module;
    if (module === undefined) {
      this.#fallBack();
      return undefined;
    }
    try {
      return new module.AsyncEntry(KEYRING_SERVICE, keyringAccount(key), {
        linux: { store: 'secret-service' },
      });
    } catch {
      this.#fallBack();
      return undefined;
    }
  }

  #fallBack(): void {
    if (this.#fallenBack) return;
    this.#fallenBack = true;
    try {
      this.#warn(FALLBACK_WARNING);
    } catch {
      // A broken stderr must not break sign-in.
    }
  }
}

let defaultStore: KeyringTokenStore | undefined;

/**
 * The process-wide default store (R59): one {@link KeyringTokenStore}, so the
 * fallback warning is printed at most once per process however many facades
 * use it.
 */
export function defaultTokenStore(): TokenStore {
  defaultStore ??= new KeyringTokenStore();
  return defaultStore;
}

/** True when `value` has the three {@link TokenStore} methods. */
export function isTokenStore(value: unknown): value is TokenStore {
  if (typeof value !== 'object' || value === null) return false;
  const store = value as Record<string, unknown>;
  return (
    typeof store['get'] === 'function' &&
    typeof store['set'] === 'function' &&
    typeof store['delete'] === 'function'
  );
}
