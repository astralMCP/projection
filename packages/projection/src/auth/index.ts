/**
 * Upstream auth (PRD §6.10, §7): sources given by URL, Projection's OAuth
 * client provider, and the token store. Phase 1A: wrap by URL, use and
 * refresh stored tokens, `signOut`; just-in-time sign-in (locked boxes, the
 * device flow) is phase 1B.
 */

import { ProjectionError } from '../errors.js';
import { defaultTokenStore, isTokenStore, type TokenStore } from './token-store.js';

export {
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
  sameTokenRecord,
  tokenStoreKey,
  FALLBACK_WARNING,
  KEYRING_SERVICE,
  KEYRING_TIMEOUT_MS,
  LOCAL_PRINCIPAL,
  type KeyringModule,
  type KeyringTokenStoreOptions,
  type TokenRecord,
  type TokenStore,
} from './token-store.js';
export {
  createUpstreamAuthProvider,
  findUpstreamAuthFailure,
  ProjectionOAuthProvider,
  UpstreamAuthError,
  withSdkWarningsSuppressed,
  AUTH_SEAM_MARKER,
  LOOPBACK_REDIRECT_URL,
} from './provider.js';
export { UpstreamConnector, upstreamAuthProjectionError } from './connect.js';

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
