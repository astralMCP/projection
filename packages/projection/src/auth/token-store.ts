/**
 * Token residence (PRD R59, S1): the {@link TokenStore} contract, its keys,
 * the in-memory store, and the default store — the OS credential store
 * through the optional native library `@napi-rs/keyring` (macOS Keychain,
 * Linux Secret Service, Windows Credential Manager), with an in-memory
 * fallback.
 *
 * A store holds opaque strings. What Projection stores under a `tokens:`
 * key is its own serialization of a token set (`token-record.ts`); a store
 * never parses it.
 *
 * Nothing in this module logs, rethrows or embeds a stored value or an
 * error from the keyring library: a store failure is reported in fixed
 * library copy.
 */

import { createHash } from 'node:crypto';

/**
 * Where upstream credentials live (R59). `WrapOptions.tokenStore` replaces
 * the default OS-credential-store one; a horizontally scaled deployment
 * supplies a shared store (R27).
 *
 * Keys and values are opaque strings. A key is `<kind>:<JSON array>`; the
 * kind before the first `:` says what the value is, so a store can route
 * or label entries without parsing anything else:
 *
 * - `tokens:["<canonical resource URL>","<client id>","<principal>"]` — a
 *   token set ({@link tokenStoreKey});
 * - `registration:…` — reserved for dynamic client registrations (phase 1b).
 *
 * Values are Projection's serialization (ASCII JSON) and must be returned
 * byte for byte.
 *
 * - `get` returns the value stored under `key`, or `undefined`.
 * - `set` replaces it.
 * - `delete` removes it and reports whether it removed anything. With
 *   `expected`, it is a compare-and-delete (R58): it deletes only when the
 *   stored value is still exactly `expected`, so a value another process
 *   has just stored survives.
 *
 * Implementations must never log or surface a value.
 */
export interface TokenStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string, expected?: string): Promise<boolean>;
}

/** The single principal of phase 1 (R62). */
export const LOCAL_PRINCIPAL = 'local';

/** The key kind of a token set. */
export const TOKENS_KEY_KIND = 'tokens';

/** The key kind reserved for dynamic client registrations (phase 1b). */
export const REGISTRATION_KEY_KIND = 'registration';

/** The keyring service name every entry is filed under (R59). */
export const KEYRING_SERVICE = '@astral-mcp/projection';

/** Every keyring operation, and loading the module, is bounded by this (R59). */
export const KEYRING_TIMEOUT_MS = 5_000;

/** The one-time warning printed when the in-memory fallback takes over (R59). No secret, no library text. */
export const FALLBACK_WARNING =
  '[@astral-mcp/projection] The OS credential store is unavailable, so upstream sign-in tokens are kept in memory for this process only: users will sign in again after a restart.\n';

/**
 * The token-set key (R59): `tokens:` then the JSON array of canonical
 * resource URL, client id and principal — JSON-encoded so the key is
 * injective whatever the parts contain.
 */
export function tokenStoreKey(
  canonicalUrl: string,
  clientId: string,
  principal: string = LOCAL_PRINCIPAL,
): string {
  return `${TOKENS_KEY_KIND}:${JSON.stringify([canonicalUrl, clientId, principal])}`;
}

/** The keyring account for a store key: lowercase hex SHA-256, so no URL reaches the store's metadata (R59). */
export function keyringAccount(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
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

/**
 * The process-local store: the fallback, and what tests and single-process
 * deployments that want no persistence can pass as `tokenStore`.
 */
export class MemoryTokenStore implements TokenStore {
  readonly #values = new Map<string, string>();

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.#values.get(key));
  }

  set(key: string, value: string): Promise<void> {
    if (typeof value !== 'string') return Promise.reject(new TokenStoreError());
    this.#values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string, expected?: string): Promise<boolean> {
    const value = this.#values.get(key);
    if (value === undefined) return Promise.resolve(false);
    if (expected !== undefined && value !== expected) return Promise.resolve(false);
    this.#values.delete(key);
    return Promise.resolve(true);
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
  /**
   * Loads the keyring module. Default: a dynamic import of
   * `@napi-rs/keyring` that is left to runtime, so a bundled app works when
   * the package is installed beside it (marked external); without it the
   * store falls back to memory. Pass `load` to supply the module your own
   * way (a CommonJS `require`, a vendored copy) or a fake in tests.
   */
  load?: () => Promise<KeyringModule>;
  /**
   * Per-operation timeout in milliseconds: a finite number from 1 to
   * 2147483647. Default 5000 ms.
   */
  timeoutMs?: number;
  /** Where the one-time fallback warning goes. Default: `process.stderr`. */
  warn?: (message: string) => void;
}

const KEYRING_SPECIFIER = '@napi-rs/keyring';

/** The largest delay a Node timer accepts. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** True for the error of importing a module that is not installed. */
function isModuleNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

async function importKeyring(): Promise<KeyringModule> {
  // A variable specifier leaves the optional dependency to runtime: a
  // bundler does not resolve it, and Node loads it on first use only.
  const specifier: string = KEYRING_SPECIFIER;
  const loaded = (await import(specifier)) as Partial<KeyringModule> & {
    default?: Partial<KeyringModule>;
  };
  const module = loaded.AsyncEntry !== undefined ? loaded : loaded.default;
  if (module?.AsyncEntry === undefined) throw new TokenStoreError();
  return module as KeyringModule;
}

/** A keyring operation that did not finish in time; never escapes the store. */
class KeyringTimeout extends Error {}

const noop = (): void => undefined;

/**
 * `promise`, rejected with {@link KeyringTimeout} (and `controller`
 * aborted) when it has not settled within `timeoutMs`.
 */
function bounded<T>(
  timeoutMs: number,
  controller: AbortController,
  promise: Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new KeyringTimeout());
    }, timeoutMs);
    // A hung native call must not keep the process alive on its own.
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new TokenStoreError());
      },
    );
  });
}

/**
 * The default store (R59): one keyring entry per key — service
 * `@astral-mcp/projection`, account the SHA-256 of the key — holding the
 * value as given. On Linux the entry is pinned to the Secret Service, so a
 * machine without one falls back instead of using the non-persistent kernel
 * keyring. `@napi-rs/keyring` has no label setting, so entries carry no
 * label.
 *
 * - **Bounded and serialized.** Every operation, and loading the module, is
 *   bounded by the timeout. Operations on one key run one at a time, in
 *   order, within the process, so a slow write cannot land after a later
 *   one.
 * - **Verified writes.** Every write is read back and compared.
 * - **Fallback.** When the module is absent or fails to load, or an
 *   operation fails, times out or mis-verifies, the store falls back to
 *   memory for the rest of its life with one warning on stderr; the failing
 *   `get` / `set` is served from memory.
 * - **Late writes.** A write that timed out but lands later is reconciled
 *   once it settles: the entry is rewritten with the newer value this store
 *   holds in memory, or, when there is none, compare-and-deleted, so the
 *   abandoned value does not stay in the OS store.
 * - **After the fallback.** A `set` of a key this store has seen in the
 *   keyring is also written there, best effort and in the background, so
 *   the OS entry never keeps a refresh token that rotation has killed (a
 *   write-behind that lands after its timeout is reconciled like any late
 *   write, so it cannot bring back a value a `delete` removed meanwhile). A
 *   `delete` still deletes from the keyring when the module had loaded (a
 *   compare-and-delete only for a key seen there), and throws
 *   {@link TokenStoreError} when it cannot and the token may be there: the
 *   key was seen in the keyring, or some keyring operation has succeeded in
 *   this process. A sign-out that silently left the token in the OS store
 *   would be worse than an error. When no keyring operation ever worked (a
 *   machine with no OS store), the memory result stands. A module that is
 *   not installed is the normal fallback too; one that failed to load
 *   (timed out, threw) makes `delete` throw, since a store it could not
 *   reach may hold an entry from an earlier process.
 *
 * Compare-and-delete is read, compare, delete: serialized within the
 * process, but not atomic across processes (R58 accepts this).
 */
export class KeyringTokenStore implements TokenStore {
  readonly #load: () => Promise<KeyringModule>;
  readonly #timeoutMs: number;
  readonly #warn: (message: string) => void;
  readonly #memory = new MemoryTokenStore();
  #module: Promise<KeyringModule | undefined> | undefined;
  #fallenBack = false;
  /** The module was found but failed to load (timed out or threw) — not merely absent. */
  #loadFailed = false;
  /** Some keyring operation has succeeded in this process: the OS store works, or did. */
  #keyringWorked = false;
  /** Keys this store has written to, or read a value from, the keyring. */
  readonly #inKeyring = new Set<string>();
  /** Per key, the tail of its queue of keyring operations (it never rejects). */
  readonly #queues = new Map<string, Promise<void>>();

  constructor(options: KeyringTokenStoreOptions = {}) {
    this.#load = options.load ?? importKeyring;
    const timeoutMs = options.timeoutMs ?? KEYRING_TIMEOUT_MS;
    // Node turns an out-of-range timer delay into 1 ms.
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new RangeError('timeoutMs must be between 1 and 2147483647');
    }
    this.#timeoutMs = timeoutMs;
    this.#warn = options.warn ?? ((message) => process.stderr.write(message));
  }

  /** True once the store has fallen back to memory. */
  get fallenBack(): boolean {
    return this.#fallenBack;
  }

  async get(key: string): Promise<string | undefined> {
    if (!this.#fallenBack) {
      const entry = await this.#entry(key);
      if (entry !== undefined) {
        try {
          const value = await this.#op(key, (signal) => entry.getPassword(signal));
          if (typeof value !== 'string') return undefined;
          this.#inKeyring.add(key);
          return value;
        } catch {
          this.#fallBack();
        }
      }
    }
    return this.#memory.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    if (typeof value !== 'string') throw new TokenStoreError();
    if (!this.#fallenBack) {
      const entry = await this.#entry(key);
      if (entry !== undefined) {
        try {
          // Write and read back as one queued operation, so no other
          // operation on the key can run in between.
          const readBack = await this.#op(
            key,
            async (signal) => {
              await entry.setPassword(value, signal);
              return entry.getPassword(signal);
            },
            () => this.#reconcileLateWrite(key, entry, value),
          );
          if (readBack !== value) throw new TokenStoreError();
          this.#inKeyring.add(key);
          return;
        } catch {
          this.#fallBack();
        }
      }
    }
    await this.#memory.set(key, value);
    this.#writeBehind(key, value);
  }

  async delete(key: string, expected?: string): Promise<boolean> {
    if (!this.#fallenBack) {
      const entry = await this.#entry(key);
      if (entry !== undefined) {
        try {
          return await this.#keyringDelete(key, entry, expected);
        } catch {
          this.#fallBack();
          const fromMemory = await this.#memory.delete(key, expected);
          if (this.#mayHold(key)) throw new TokenStoreError();
          return fromMemory;
        }
      }
    }
    // Fallen back (or the module never loaded): memory, then the keyring
    // entry this process may have left behind.
    const fromMemory = await this.#memory.delete(key, expected);
    const module = await this.#module;
    if (module === undefined) {
      if (this.#loadFailed) throw new TokenStoreError();
      return fromMemory;
    }
    if (expected !== undefined && !this.#inKeyring.has(key)) return fromMemory;
    try {
      const fromKeyring = await this.#keyringDelete(key, this.#newEntry(module, key), expected);
      return fromMemory || fromKeyring;
    } catch {
      if (this.#mayHold(key)) throw new TokenStoreError();
      return fromMemory;
    }
  }

  /**
   * Whether the OS store may hold `key` although deleting it failed: the
   * key was seen there, or the store has worked in this process.
   */
  #mayHold(key: string): boolean {
    return this.#inKeyring.has(key) || this.#keyringWorked;
  }

  /** Read, compare, delete — one queued operation (R58). */
  async #keyringDelete(key: string, entry: KeyringEntry, expected?: string): Promise<boolean> {
    const deleted = await this.#op(key, async (signal) => {
      if (expected !== undefined) {
        const value = await entry.getPassword(signal);
        if (value !== expected) return false;
      }
      return entry.deletePassword(signal);
    });
    if (deleted) this.#inKeyring.delete(key);
    return deleted;
  }

  /**
   * Run `run` after every earlier keyring operation on `key` has settled,
   * bounded by the timeout (queue wait included). An operation whose turn
   * comes after its timeout is skipped. `onLate` runs when the operation
   * succeeds after its caller was told it timed out.
   */
  #op<T>(key: string, run: (signal: AbortSignal) => Promise<T>, onLate?: () => void): Promise<T> {
    const controller = new AbortController();
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const operation = previous.then(() => {
      if (controller.signal.aborted) throw new KeyringTimeout();
      return run(controller.signal);
    });
    const tail = operation.then(() => {
      this.#keyringWorked = true;
      if (controller.signal.aborted) onLate?.();
    }, noop);
    this.#queues.set(key, tail);
    void tail.then(() => {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    });
    return bounded(this.#timeoutMs, controller, operation);
  }

  /**
   * A write of `written` landed after its timeout, when this store had
   * already fallen back to memory. Rewrite the entry with the newer value
   * memory holds, or compare-and-delete the abandoned one, so a stale value
   * never stays in the OS store (best effort; queued like any operation).
   * `keepIfCurrent` (a write-behind) leaves the entry alone when memory
   * still holds exactly `written`.
   */
  #reconcileLateWrite(
    key: string,
    entry: KeyringEntry,
    written: string,
    keepIfCurrent = false,
  ): void {
    void (async () => {
      const latest = await this.#memory.get(key);
      if (keepIfCurrent && latest === written) return;
      if (latest !== undefined && latest !== written) {
        await this.#op(key, (signal) => entry.setPassword(latest, signal));
        this.#inKeyring.add(key);
      } else {
        await this.#keyringDelete(key, entry, written);
      }
    })().catch(noop);
  }

  /**
   * After the fallback, also write a value to the keyring entry this store
   * has seen, best effort and in the background (see the class comment).
   */
  #writeBehind(key: string, value: string): void {
    if (!this.#inKeyring.has(key)) return;
    void (async () => {
      const module = await this.#module;
      if (module === undefined) return;
      const entry = this.#newEntry(module, key);
      await this.#op(
        key,
        (signal) => entry.setPassword(value, signal),
        // Landed after its timeout, perhaps after a delete: reconcile, so a
        // value signed out meanwhile does not come back to the OS store.
        () => this.#reconcileLateWrite(key, entry, value, true),
      );
    })().catch(noop);
  }

  #newEntry(module: KeyringModule, key: string): KeyringEntry {
    return new module.AsyncEntry(KEYRING_SERVICE, keyringAccount(key), {
      linux: { store: 'secret-service' },
    });
  }

  async #entry(key: string): Promise<KeyringEntry | undefined> {
    // Started inside the chain, so a load that throws synchronously is a
    // failed load like any other.
    this.#module ??= bounded(
      this.#timeoutMs,
      new AbortController(),
      Promise.resolve().then(() => this.#load()),
    ).catch((err: unknown) => {
      this.#loadFailed = !isModuleNotFound(err);
      return undefined;
    });
    const module = await this.#module;
    if (module === undefined) {
      this.#fallBack();
      return undefined;
    }
    try {
      return this.#newEntry(module, key);
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
