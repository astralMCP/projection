/**
 * Offline fakes for upstream sign-in tests (PRD §13): an in-process
 * authorization server and an OAuth-protected MCP server on 127.0.0.1,
 * plus a fake `@napi-rs/keyring` module, and helpers that store and read
 * Projection's serialized token records. Phase 1, part B extends these.
 */

import { decodeTokenRecord, encodeTokenRecord, type TokenRecord } from '../../../src/auth/index.js';
import type { TokenStore } from '../../../src/index.js';

export * from './authorization-server.js';
export * from './http.js';
export * from './keyring.js';
export * from './protected-resource.js';

/** Store `record` under `key` the way Projection does (its serialization). */
export function putRecord(store: TokenStore, key: string, record: TokenRecord): Promise<void> {
  return store.set(key, encodeTokenRecord(record));
}

/** The record stored under `key`, decoded, or `undefined`. */
export async function getRecord(store: TokenStore, key: string): Promise<TokenRecord | undefined> {
  return decodeTokenRecord(await store.get(key));
}
