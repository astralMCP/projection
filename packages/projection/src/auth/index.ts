/**
 * Upstream auth (PRD §6.10, §7): sources given by URL, Projection's OAuth
 * client provider, and the token store. Phase 1, part A: wrap by URL, use
 * and refresh stored tokens, `signOut`; just-in-time sign-in (locked boxes,
 * the device flow) is phase 1, part B.
 */

import { ProjectionError } from '../errors.js';
import { defaultTokenStore, isTokenStore, type TokenStore } from './token-store.js';

export {
  MAX_URL_CHARS,
  canonicalizeUrl,
  isLoopbackHost,
  isUpstreamSpecShape,
  resolveUpstreamSpec,
  type ResolvedOAuth,
  type ResolvedUpstream,
  type UpstreamOAuthOptions,
  type UpstreamSpec,
} from './upstream.js';
export {
  defaultTokenStore,
  isTokenStore,
  keyringAccount,
  KeyringTokenStore,
  MemoryTokenStore,
  tokenStoreKey,
  FALLBACK_WARNING,
  KEYRING_SERVICE,
  KEYRING_TIMEOUT_MS,
  LOCAL_PRINCIPAL,
  REGISTRATION_KEY_KIND,
  TOKENS_KEY_KIND,
  TokenStoreError,
  type KeyringEntry,
  type KeyringModule,
  type KeyringTokenStoreOptions,
  type TokenStore,
} from './token-store.js';
export { decodeTokenRecord, encodeTokenRecord, type TokenRecord } from './token-record.js';
export { MIN_REDACTED_SECRET_CHARS, REDACTED, SecretSet } from './secrets.js';
export {
  assertAuthEndpointAllowed,
  AUTH_RUN_TIMEOUT_MS,
  createProviderContext,
  createUpstreamAuthProvider,
  findUpstreamAuthFailure,
  installSdkWarningFilter,
  ProjectionOAuthProvider,
  UpstreamAuthError,
  withSdkWarningsSuppressed,
  AUTH_SEAM_MARKER,
  LOOPBACK_REDIRECT_URL,
  type ProviderContext,
  type UpstreamAuthReason,
} from './provider.js';
export {
  createUpstreamFetch,
  UpstreamAuthProjectionError,
  UpstreamConnector,
  UpstreamRequestRefused,
  upstreamAuthProjectionError,
} from './connect.js';

/**
 * `WrapOptions.tokenStore`, validated (R59): an object with `get`, `set`
 * and `delete`, else a `validate` error. Returns a getter so the default
 * store is created only when a source given by URL needs it.
 */
export function tokenStoreOption(value: unknown): () => TokenStore {
  if (value === undefined) return defaultTokenStore;
  if (!isTokenStore(value)) {
    throw new ProjectionError('validate', 'tokenStore must have get, set and delete methods', {
      hint: 'Pass an object implementing TokenStore, or omit tokenStore to use the OS credential store.',
    });
  }
  return () => value;
}
