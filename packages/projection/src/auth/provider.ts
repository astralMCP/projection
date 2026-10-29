/**
 * Projection's OAuth client provider for sources given by URL (PRD R53,
 * R58 "Provider rules", R59).
 *
 * The transport Projection builds gets an SDK `AuthProvider` whose two
 * members are the SDK's own `adaptOAuthProvider` behaviour, with
 * Projection's rules around it:
 *
 * - `token()` reads the token store on every request (R58 "re-read before
 *   refresh"), so a token another process stored or refreshed is used.
 * - `onUnauthorized()` (a 401) re-reads the store and, only when the stored
 *   record has a refresh token, runs the SDK's `auth()` over a fresh
 *   {@link ProjectionOAuthProvider} delegate created for that one run. The
 *   SDK refreshes; on a definitive refresh failure it calls
 *   `invalidateCredentials('tokens')`, which compare-and-deletes exactly the
 *   record that delegate presented (R58), so a record another process has
 *   just stored survives. The SDK's `console.warn` output during the run is
 *   dropped (R58), and whatever it throws is reduced to a fixed-copy
 *   {@link UpstreamAuthError} carrying at most an OAuth `error` code that
 *   matches `^[a-z_]+$` (R57): no SDK message text, no cause.
 *
 * Driving `auth()` from here rather than handing the transport the
 * `OAuthClientProvider` directly is what lets Projection bound the SDK's
 * console output to exactly the auth run; behaviour is otherwise the
 * adapter's. The transport is built with `onInsufficientScope: 'throw'` and
 * the default `redirectPolicy` (see `connect.ts`).
 *
 * The provider never starts an interactive flow: it sets a loopback
 * `redirectUrl` with no listener behind it, `redirectToAuthorization` only
 * records that sign-in is needed, and — phase 1 having no flow to start from
 * here — `state()` stops `auth()` with a sign-in-required error before it
 * even builds an authorization URL. It implements no `saveClientInformation`
 * (so the SDK never registers a client dynamically) and no
 * `prepareTokenRequest` (the device-code redemption delegate is phase 1B's).
 */

import {
  auth,
  extractWWWAuthenticateParams,
  InsufficientScopeError,
  OAuthError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
  type AuthProvider,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import type { ResolvedUpstream } from './upstream.js';
import { normalizeTokenRecord, type TokenRecord, type TokenStore } from './token-store.js';

/** Projection's own auth-seam marker (R58): an error carrying it means sign-in is needed or failed. */
export const AUTH_SEAM_MARKER: unique symbol = Symbol.for('@astral-mcp/projection/auth-seam');

/**
 * Why an upstream auth step failed, in library terms:
 *
 * - `sign_in_required`: no usable token (none stored, none that refreshes).
 * - `no_client`: the server requires sign-in and no `oauth.clientId` is configured (R52).
 * - `insufficient_scope`: the granted scopes do not cover the request (R58).
 * - `oauth_error`: the authorization server refused (its `error` code, when valid, rides along).
 * - `token_store`: the token store failed.
 * - `failed`: anything else in the auth machinery (invalid or insecure metadata, a network failure).
 */
export type UpstreamAuthReason =
  | 'sign_in_required'
  | 'no_client'
  | 'insufficient_scope'
  | 'oauth_error'
  | 'token_store'
  | 'failed';

const MESSAGES: Record<UpstreamAuthReason, string> = {
  sign_in_required: 'upstream sign-in is required',
  no_client: 'upstream sign-in is required and no OAuth client is configured',
  insufficient_scope: 'the granted scopes do not cover the request',
  oauth_error: 'the authorization server refused the request',
  token_store: 'the token store failed',
  failed: 'upstream authorization failed',
};

/** An OAuth `error` code is kept only when it matches this (R57). */
const OAUTH_ERROR_CODE = /^[a-z_]+$/;

/**
 * An upstream auth failure in fixed library copy (R57): no SDK text, no
 * token-store text, no cause.
 */
export class UpstreamAuthError extends Error {
  readonly [AUTH_SEAM_MARKER] = true;
  readonly reason: UpstreamAuthReason;
  /** The authorization server's OAuth `error` code, when it matched `^[a-z_]+$`. */
  readonly oauthCode?: string;

  constructor(reason: UpstreamAuthReason, oauthCode?: string) {
    super(MESSAGES[reason]);
    this.name = 'UpstreamAuthError';
    this.reason = reason;
    if (oauthCode !== undefined && OAUTH_ERROR_CODE.test(oauthCode)) this.oauthCode = oauthCode;
  }
}

/** The loopback redirect URL the provider always reports (R58); no listener runs behind it in phase 1. */
export const LOOPBACK_REDIRECT_URL = 'http://127.0.0.1/callback';

/**
 * The upstream auth failure behind `err`, if any (R58: exactly three errors
 * mean sign-in is needed): an {@link UpstreamAuthError} (Projection's
 * marker), the SDK's `UnauthorizedError`, its `InsufficientScopeError`, and —
 * the same 401 one step later — the `SdkHttpError` the transport raises when
 * a request still answers 401 after `onUnauthorized` ran. Walks `cause`
 * links a few levels, since callers may wrap the transport's error.
 */
export function findUpstreamAuthFailure(err: unknown): UpstreamAuthError | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof UpstreamAuthError) return current;
    if (
      typeof current === 'object' &&
      (current as Record<symbol, unknown>)[AUTH_SEAM_MARKER] === true
    ) {
      return new UpstreamAuthError('failed');
    }
    if (current instanceof InsufficientScopeError)
      return new UpstreamAuthError('insufficient_scope');
    if (current instanceof UnauthorizedError) return new UpstreamAuthError('sign_in_required');
    if (current instanceof SdkHttpError && current.code === SdkErrorCode.ClientHttpAuthentication) {
      return new UpstreamAuthError('sign_in_required');
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

/** Reduce anything `auth()` or the store threw to fixed copy (R57). */
function toUpstreamAuthError(err: unknown): UpstreamAuthError {
  if (err instanceof UpstreamAuthError) return err;
  if (err instanceof OAuthError) return new UpstreamAuthError('oauth_error', err.code);
  return findUpstreamAuthFailure(err) ?? new UpstreamAuthError('failed');
}

// ---------------------------------------------------------------------------
// SDK console output during auth (R58)
// ---------------------------------------------------------------------------

const SDK_WARNING_PREFIX = '[mcp-sdk]';
let suppressionDepth = 0;
let originalWarn: typeof console.warn | undefined;

/**
 * Run `body` with the SDK's `console.warn` output dropped (R58): the SDK
 * warns from inside `auth()` with text that can quote authorization-server
 * responses. Only `[mcp-sdk]`-prefixed warnings are dropped, and only while
 * an auth run is in flight; anything else passes through.
 */
export async function withSdkWarningsSuppressed<T>(body: () => Promise<T>): Promise<T> {
  if (suppressionDepth === 0) {
    const original = console.warn;
    originalWarn = original;
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith(SDK_WARNING_PREFIX)) return;
      original.apply(console, args);
    };
  }
  suppressionDepth += 1;
  try {
    return await body();
  } finally {
    suppressionDepth -= 1;
    if (suppressionDepth === 0 && originalWarn !== undefined) {
      console.warn = originalWarn;
      originalWarn = undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/** What the provider needs to know about its source. */
export interface ProviderContext {
  readonly upstream: ResolvedUpstream;
  readonly store: TokenStore;
  /** The token-set key (R59), or `undefined` when no `oauth.clientId` is configured. */
  readonly key: string | undefined;
}

async function readRecord(context: ProviderContext): Promise<TokenRecord | undefined> {
  if (context.key === undefined) return undefined;
  try {
    return await context.store.get(context.key);
  } catch {
    throw new UpstreamAuthError('token_store');
  }
}

function toStoredTokens(record: TokenRecord): StoredOAuthTokens {
  return {
    access_token: record.access_token,
    token_type: 'Bearer',
    ...(record.refresh_token !== undefined ? { refresh_token: record.refresh_token } : {}),
    ...(record.scope !== undefined ? { scope: record.scope } : {}),
    issuer: record.issuer,
  };
}

/**
 * Projection's `OAuthClientProvider` (R53, R58). One instance is a delegate
 * for one `auth()` run: it remembers the record it presented so that
 * `invalidateCredentials('tokens')` deletes exactly that record, and nothing
 * else is shared between runs.
 */
export class ProjectionOAuthProvider implements OAuthClientProvider {
  readonly #context: ProviderContext;
  #presented: TokenRecord | undefined;
  #signInNeeded = false;

  constructor(context: ProviderContext) {
    this.#context = context;
  }

  /** True once the SDK asked to send the user to an authorization URL (it never is). */
  get signInNeeded(): boolean {
    return this.#signInNeeded;
  }

  get redirectUrl(): string {
    return LOOPBACK_REDIRECT_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    const scopes = this.#context.upstream.oauth?.scopes;
    return {
      client_name: '@astral-mcp/projection',
      redirect_uris: [LOOPBACK_REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(scopes !== undefined && scopes.length > 0 ? { scope: scopes.join(' ') } : {}),
    };
  }

  /**
   * The client the integrator registered (R52). Without one, sign-in cannot
   * happen: stop here, before the SDK would try dynamic registration.
   */
  clientInformation(): StoredOAuthClientInformation {
    const oauth = this.#context.upstream.oauth;
    if (oauth === undefined) throw new UpstreamAuthError('no_client');
    return {
      client_id: oauth.clientId,
      ...(oauth.clientSecret !== undefined ? { client_secret: oauth.clientSecret } : {}),
    };
  }

  /** The stored token set, re-read from the store on every call (R58). */
  async tokens(): Promise<StoredOAuthTokens | undefined> {
    const record = await readRecord(this.#context);
    this.#presented = record;
    return record !== undefined ? toStoredTokens(record) : undefined;
  }

  /** Store a token set the SDK obtained (a refresh), bound to its issuer (R59, R61). */
  async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    const key = this.#context.key;
    const issuer = tokens.issuer ?? ctx?.issuer;
    if (key === undefined || issuer === undefined) throw new UpstreamAuthError('failed');
    const record = normalizeTokenRecord({
      access_token: tokens.access_token,
      ...(tokens.refresh_token !== undefined ? { refresh_token: tokens.refresh_token } : {}),
      ...(typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in)
        ? { expires_at: Math.floor(Date.now() / 1000) + Math.max(0, Math.floor(tokens.expires_in)) }
        : {}),
      ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
      issuer,
    });
    try {
      await this.#context.store.set(key, record);
    } catch {
      throw new UpstreamAuthError('token_store');
    }
    this.#presented = record;
  }

  /**
   * Phase 1 has no interactive flow to start from inside the transport:
   * stop `auth()` before it builds an authorization URL (R58).
   */
  state(): string {
    this.#signInNeeded = true;
    throw new UpstreamAuthError('sign_in_required');
  }

  /** Records that sign-in is needed; never opens a browser or starts a flow (R58). */
  redirectToAuthorization(): void {
    this.#signInNeeded = true;
  }

  saveCodeVerifier(): void {
    // No authorization-code flow in phase 1: nothing to keep.
  }

  codeVerifier(): string {
    throw new UpstreamAuthError('sign_in_required');
  }

  /**
   * A definitive refresh failure (`invalid_grant`, `invalid_client`):
   * compare-and-delete the record this run presented (R58).
   */
  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope !== 'all' && scope !== 'tokens') return;
    const key = this.#context.key;
    const presented = this.#presented;
    this.#presented = undefined;
    if (key === undefined || presented === undefined) return;
    try {
      await this.#context.store.delete(key, presented);
    } catch {
      throw new UpstreamAuthError('token_store');
    }
  }
}

/**
 * The transport's `AuthProvider` for one source (see the module comment):
 * `token()` reads the store per request; `onUnauthorized()` refreshes through
 * the SDK when the stored record can be refreshed, and otherwise reports
 * that sign-in is required.
 */
export function createUpstreamAuthProvider(context: ProviderContext): AuthProvider {
  return {
    token: async () => (await readRecord(context))?.access_token,
    onUnauthorized: async (ctx) => {
      if (context.upstream.oauth === undefined) throw new UpstreamAuthError('no_client');
      const record = await readRecord(context);
      // Nothing to refresh: the request needs a sign-in, which phase 1A
      // cannot start from here.
      if (record?.refresh_token === undefined) throw new UpstreamAuthError('sign_in_required');
      const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(ctx.response);
      const delegate = new ProjectionOAuthProvider(context);
      let result: string;
      try {
        result = await withSdkWarningsSuppressed(() =>
          auth(delegate, {
            serverUrl: ctx.serverUrl,
            ...(resourceMetadataUrl !== undefined ? { resourceMetadataUrl } : {}),
            ...(scope !== undefined ? { scope } : {}),
            fetchFn: ctx.fetchFn,
          }),
        );
      } catch (err) {
        throw toUpstreamAuthError(err);
      }
      if (result !== 'AUTHORIZED') throw new UpstreamAuthError('sign_in_required');
    },
  };
}
