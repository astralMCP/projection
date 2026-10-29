/**
 * Projection's OAuth client provider for sources given by URL (PRD R53,
 * R58 "Provider rules", R59).
 *
 * The transport Projection builds gets an SDK `AuthProvider` — not the
 * `OAuthClientProvider` itself — with Projection's rules around the SDK's
 * own `auth()`:
 *
 * - `token()` reads the token store on every request (R58 "re-read before
 *   refresh"), so a token another process stored or refreshed is used. A
 *   record whose `expires_at` has passed is refreshed before it is sent.
 * - `onUnauthorized()` (a 401) re-reads the store. When it holds a token
 *   other than the one the failed request presented, the request is simply
 *   sent again with it (R58 "re-read before re-lock"). Otherwise, when the
 *   stored record has a refresh token, it refreshes: one refresh per store
 *   key at a time in the process, which every concurrent 401 joins
 *   ({@link refreshOnce}). The refresh runs the SDK's `auth()` over a fresh
 *   {@link ProjectionOAuthProvider} delegate created for that one run. On a
 *   definitive refresh failure the SDK calls
 *   `invalidateCredentials('tokens')`, which compare-and-deletes exactly the
 *   stored value that delegate presented (R58), so a record another process
 *   has just stored survives. A record with nothing to refresh with is sent
 *   once more as well, so a token stored meanwhile is still picked up; a
 *   second 401 then means sign-in is required.
 * - The SDK's `[mcp-sdk]` `console.warn` output during an auth run is
 *   dropped (R58, {@link withSdkWarningsSuppressed}), and whatever `auth()`
 *   throws is reduced to a fixed-copy {@link UpstreamAuthError} carrying at
 *   most an OAuth `error` code that matches `^[a-z_]+$` (R57): no SDK
 *   message text, no cause.
 *
 * Driving `auth()` from here rather than handing the transport the
 * `OAuthClientProvider` is what lets Projection bound the SDK's console
 * output to the auth run, single-flight the refresh, and know which token a
 * failed request presented. The transport is built with
 * `onInsufficientScope: 'throw'` and the default `redirectPolicy` (see
 * `connect.ts`).
 *
 * The provider never starts an interactive flow: it sets a loopback
 * `redirectUrl` with no listener behind it, `redirectToAuthorization` only
 * records that sign-in is needed, and — this version having no flow to
 * start from here — `state()` stops `auth()` before it even builds an
 * authorization URL. It implements no `saveClientInformation` (so the SDK
 * never registers a client dynamically) and no `prepareTokenRequest` (the
 * device-code redemption delegate arrives with just-in-time sign-in, phase
 * 1, part B).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  auth,
  extractWWWAuthenticateParams,
  InsufficientScopeError,
  OAuthError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
  type AuthProvider,
  type FetchLike,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { SecretSet } from './secrets.js';
import { decodeTokenRecord, encodeTokenRecord, type TokenRecord } from './token-record.js';
import { tokenStoreKey, type TokenStore } from './token-store.js';
import { isLoopbackHost, type ResolvedUpstream } from './upstream.js';

/** Projection's own auth-seam marker (R58): an error carrying it means sign-in is needed or failed. */
export const AUTH_SEAM_MARKER: unique symbol = Symbol.for('@astral-mcp/projection/auth-seam');

/**
 * Why an upstream auth step failed, in library terms:
 *
 * - `sign_in_required`: no usable token (none stored, none that refreshes).
 * - `no_client`: the server requires sign-in and no `oauth.clientId` is configured (R52).
 * - `insufficient_scope`: the granted scopes do not cover the request (R58).
 * - `refresh_failed`: a refresh could not complete for a transient reason
 *   (a 5xx, a malformed response, a network failure); the stored record is kept.
 * - `client_rejected`: the authorization server refused the OAuth client
 *   (`invalid_client` / `unauthorized_client`); the stored record is kept.
 * - `insecure_endpoint`: an authorization-server endpoint is not `https:` (R61).
 * - `oauth_error`: the authorization server refused (its `error` code, when valid, rides along).
 * - `token_store`: the token store failed.
 * - `failed`: anything else in the auth machinery (invalid metadata, for example).
 */
export type UpstreamAuthReason =
  | 'sign_in_required'
  | 'no_client'
  | 'insufficient_scope'
  | 'refresh_failed'
  | 'client_rejected'
  | 'insecure_endpoint'
  | 'oauth_error'
  | 'token_store'
  | 'failed';

const MESSAGES: Record<UpstreamAuthReason, string> = {
  sign_in_required: 'upstream sign-in is required',
  no_client: 'upstream sign-in is required and no OAuth client is configured',
  insufficient_scope: 'the granted scopes do not cover the request',
  refresh_failed: 'refreshing the upstream token failed',
  client_rejected: 'the authorization server rejected the OAuth client',
  insecure_endpoint: 'an authorization-server endpoint is not https',
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

/** The loopback redirect URL the provider always reports (R58); no listener runs behind it yet. */
export const LOOPBACK_REDIRECT_URL = 'http://127.0.0.1/callback';

/**
 * The upstream auth failure behind `err`, if any. Four errors mean sign-in
 * is needed (R58's three, plus the same 401 one step later): an
 * {@link UpstreamAuthError} or anything carrying Projection's marker, the
 * SDK's `UnauthorizedError`, its `InsufficientScopeError`, and the
 * `SdkHttpError` with code `ClientHttpAuthentication` the transport raises
 * when a request still answers 401 after `onUnauthorized` ran. Walks
 * `cause` links a few levels, since callers may wrap the transport's error.
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

/**
 * R61: an authorization-server URL must be `https:`; `http:` only on a
 * loopback host, and only when the source itself is loopback. (The SDK's
 * own token-endpoint check admits loopback `http:` for any source.)
 */
export function assertAuthEndpointAllowed(url: URL, sourceIsLoopback: boolean): void {
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && sourceIsLoopback && isLoopbackHost(url.hostname)) return;
  throw new UpstreamAuthError('insecure_endpoint');
}

// ---------------------------------------------------------------------------
// SDK console output during auth (R58)
// ---------------------------------------------------------------------------

const SDK_WARNING_PREFIX = '[mcp-sdk]';

/** Set for exactly the async context of an auth run. */
const authRun = new AsyncLocalStorage<true>();

/** Marks the `console.warn` wrappers this module installed (module-local: another copy of Projection has its own). */
const FILTER = Symbol('projection-sdk-warning-filter');

/**
 * Make sure `console.warn` drops `[mcp-sdk]` warnings raised inside an auth
 * run, and passes everything else to whatever `console.warn` was.
 *
 * The SDK warns from inside `auth()` with text that can quote
 * authorization-server responses, refresh tokens included. The wrapper is
 * permanent — never swapped back — so a logger that replaces
 * `console.warn` while a run is in flight is never overwritten, and an
 * `[mcp-sdk]` warning outside an auth run (another client's) is never
 * dropped: the filter consults an `AsyncLocalStorage` flag that only the
 * auth run's own async context carries. Because a logger may replace
 * `console.warn` at any time, this is called at every point of use — at
 * the start of each auth run and around every request the run makes, which
 * is where the SDK's warnings follow — and wraps the current function again
 * if it is not one of ours. Wrapping preserves the replacement: it still
 * receives every message the filter does not drop.
 */
export function installSdkWarningFilter(): void {
  const current = console.warn as typeof console.warn & { [FILTER]?: true };
  if (current[FILTER] === true) return;
  const filtered = (...args: unknown[]): void => {
    if (
      authRun.getStore() === true &&
      typeof args[0] === 'string' &&
      args[0].startsWith(SDK_WARNING_PREFIX)
    ) {
      return;
    }
    Reflect.apply(current, console, args);
  };
  Object.defineProperty(filtered, FILTER, { value: true });
  console.warn = filtered;
}

/** Run `body` as an auth run: the SDK's `[mcp-sdk]` warnings inside it are dropped (R58). */
export function withSdkWarningsSuppressed<T>(body: () => Promise<T>): Promise<T> {
  installSdkWarningFilter();
  return authRun.run(true, body);
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/** What the provider needs to know about its source; one per connection. */
export interface ProviderContext {
  readonly upstream: ResolvedUpstream;
  readonly store: TokenStore;
  /** The token-set key (R59), or `undefined` when no `oauth.clientId` is configured. */
  readonly key: string | undefined;
  /** Every secret this connection presented or was given, for redaction (`secrets.ts`). */
  readonly secrets: SecretSet;
  /** The bearer token each resource response answered, recorded by the connection's fetch. */
  readonly presented: WeakMap<Response, string | undefined>;
  /** The connection's fetch: a proactive refresh discovers and requests through it. */
  fetch: FetchLike;
}

/** A provider context for `upstream` over `store` (the client secret is remembered for redaction). */
export function createProviderContext(
  upstream: ResolvedUpstream,
  store: TokenStore,
): ProviderContext {
  const secrets = new SecretSet();
  secrets.pin(upstream.oauth?.clientSecret);
  return {
    upstream,
    store,
    key:
      upstream.oauth !== undefined
        ? tokenStoreKey(upstream.canonicalUrl, upstream.oauth.clientId)
        : undefined,
    secrets,
    presented: new WeakMap(),
    fetch: (url, init) => fetch(url, init),
  };
}

/** The stored value, as is. A store failure is fixed copy. */
async function readStored(context: ProviderContext): Promise<string | undefined> {
  if (context.key === undefined) return undefined;
  try {
    const value = await context.store.get(context.key);
    return typeof value === 'string' ? value : undefined;
  } catch {
    throw new UpstreamAuthError('token_store');
  }
}

/** The stored record, remembered for redaction. */
async function readRecord(context: ProviderContext): Promise<TokenRecord | undefined> {
  const record = decodeTokenRecord(await readStored(context));
  if (record !== undefined) context.secrets.add(record.access_token, record.refresh_token);
  return record;
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

/** What one auth run is told about the request that needed it. */
interface AuthRunOptions {
  serverUrl: URL;
  resourceMetadataUrl?: URL;
  scope?: string;
  fetchFn: FetchLike;
}

/**
 * Projection's `OAuthClientProvider` (R53, R58). One instance is a delegate
 * for one `auth()` run: it remembers the stored value it presented so that
 * `invalidateCredentials('tokens')` deletes exactly that value, and nothing
 * else is shared between runs.
 */
export class ProjectionOAuthProvider implements OAuthClientProvider {
  readonly #context: ProviderContext;
  /** The stored value `tokens()` last read (or `saveTokens` wrote). */
  #presented: string | undefined;
  #signInNeeded = false;
  /** A refresh grant was sent in this run (and has not been answered definitively). */
  #refreshAttempted = false;
  /** A request this run refused to send (R61). */
  #refused: UpstreamAuthError | undefined;

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
    const stored = await readStored(this.#context);
    const record = decodeTokenRecord(stored);
    this.#presented = record !== undefined ? stored : undefined;
    if (record === undefined) return undefined;
    this.#context.secrets.add(record.access_token, record.refresh_token);
    return toStoredTokens(record);
  }

  /** Store a token set the SDK obtained (a refresh), bound to its issuer (R59, R61). */
  async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    const key = this.#context.key;
    const issuer = tokens.issuer ?? ctx?.issuer;
    this.#context.secrets.add(tokens.access_token, tokens.refresh_token);
    if (key === undefined || issuer === undefined) throw new UpstreamAuthError('failed');
    const value = encodeTokenRecord({
      access_token: tokens.access_token,
      ...(tokens.refresh_token !== undefined ? { refresh_token: tokens.refresh_token } : {}),
      ...(typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in)
        ? { expires_at: Math.floor(Date.now() / 1000) + Math.max(0, Math.floor(tokens.expires_in)) }
        : {}),
      ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
      issuer,
    });
    try {
      await this.#context.store.set(key, value);
    } catch {
      throw new UpstreamAuthError('token_store');
    }
    this.#presented = value;
  }

  /**
   * This version has no interactive flow to start from inside the
   * transport: stop `auth()` before it builds an authorization URL (R58).
   * The SDK gets here after a refresh it could not complete for a transient
   * reason too (it falls back to a new authorization), which is reported as
   * such, with the record kept.
   */
  state(): string {
    this.#signInNeeded = true;
    if (this.#refused !== undefined) throw this.#refused;
    throw new UpstreamAuthError(this.#refreshAttempted ? 'refresh_failed' : 'sign_in_required');
  }

  /** Records that sign-in is needed; never opens a browser or starts a flow (R58). */
  redirectToAuthorization(): void {
    this.#signInNeeded = true;
  }

  saveCodeVerifier(): void {
    // No authorization-code flow in this version: nothing to keep.
  }

  codeVerifier(): string {
    throw new UpstreamAuthError('sign_in_required');
  }

  /**
   * A definitive refresh failure. `invalid_grant`: compare-and-delete the
   * value this run presented (R58), and sign-in is required. `invalid_client`
   * / `unauthorized_client` (the SDK invalidates `client` first): a client
   * configuration problem, not a sign-in one — stop here and keep the
   * record, which a corrected configuration can still refresh.
   */
  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'client') throw new UpstreamAuthError('client_rejected');
    if (scope !== 'all' && scope !== 'tokens') return;
    this.#refreshAttempted = false;
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

  /**
   * The fetch this run's requests go through: R61's `https:` rule, the
   * console filter at the point of use, and a note of a refresh grant sent.
   */
  #guard(base: FetchLike): FetchLike {
    const sourceIsLoopback = isLoopbackHost(this.#context.upstream.url.hostname);
    return async (url, init) => {
      installSdkWarningFilter();
      try {
        assertAuthEndpointAllowed(new URL(url), sourceIsLoopback);
      } catch (err) {
        this.#refused = err as UpstreamAuthError;
        throw err;
      }
      const body = init?.body;
      if (body instanceof URLSearchParams && body.get('grant_type') === 'refresh_token') {
        this.#refreshAttempted = true;
      }
      try {
        return await base(url, init);
      } finally {
        installSdkWarningFilter();
      }
    };
  }

  /** Run the SDK's `auth()` with this delegate; anything but `AUTHORIZED` is a fixed-copy error. */
  async authorize(options: AuthRunOptions): Promise<void> {
    let result: string;
    try {
      result = await withSdkWarningsSuppressed(() =>
        auth(this, {
          serverUrl: options.serverUrl,
          ...(options.resourceMetadataUrl !== undefined
            ? { resourceMetadataUrl: options.resourceMetadataUrl }
            : {}),
          ...(options.scope !== undefined ? { scope: options.scope } : {}),
          fetchFn: this.#guard(options.fetchFn),
        }),
      );
    } catch (err) {
      throw this.#refused ?? toUpstreamAuthError(err);
    }
    if (result !== 'AUTHORIZED') throw this.#refused ?? new UpstreamAuthError('sign_in_required');
  }
}

// ---------------------------------------------------------------------------
// Refresh, one at a time per stored record
// ---------------------------------------------------------------------------

/** In-flight refreshes, per store and key: concurrent 401s on one record share one refresh. */
const refreshes = new WeakMap<TokenStore, Map<string, Promise<void>>>();

/**
 * Refresh the record whose access token `stale` failed — once: a refresh
 * already in flight for the same store and key is joined (and its failure
 * shared). The flight re-reads the store first and does nothing when the
 * stored token is no longer `stale` (refreshed by another request or
 * process) or there is no refresh token.
 */
function refreshOnce(
  context: ProviderContext,
  stale: string,
  options: AuthRunOptions,
): Promise<void> {
  const key = context.key;
  if (key === undefined) return Promise.reject(new UpstreamAuthError('no_client'));
  let flights = refreshes.get(context.store);
  if (flights === undefined) {
    flights = new Map();
    refreshes.set(context.store, flights);
  }
  const existing = flights.get(key);
  if (existing !== undefined) return existing;
  const flight = (async () => {
    const current = await readRecord(context);
    if (current === undefined) throw new UpstreamAuthError('sign_in_required');
    if (current.access_token !== stale || current.refresh_token === undefined) return;
    await new ProjectionOAuthProvider(context).authorize(options);
  })();
  flights.set(key, flight);
  const clear = (): void => {
    if (flights.get(key) === flight) flights.delete(key);
  };
  flight.then(clear, clear);
  return flight;
}

/** A record is refreshed before use once fewer than this many seconds of its life remain. */
const EXPIRY_MARGIN_SECONDS = 30;

function hasExpired(record: TokenRecord): boolean {
  return (
    record.expires_at !== undefined &&
    record.expires_at <= Math.floor(Date.now() / 1000) + EXPIRY_MARGIN_SECONDS
  );
}

/**
 * The transport's `AuthProvider` for one source (see the module comment).
 */
export function createUpstreamAuthProvider(context: ProviderContext): AuthProvider {
  /** The token the latest `token()` call returned: the fallback when a response was not seen by the connection's fetch. */
  let lastToken: string | undefined;
  return {
    token: async () => {
      let record = await readRecord(context);
      if (
        record?.refresh_token !== undefined &&
        context.upstream.oauth !== undefined &&
        hasExpired(record)
      ) {
        // Proactive refresh (R59). Whatever fails here, the request goes
        // out with what the store holds, and a 401 decides (R58).
        try {
          await refreshOnce(context, record.access_token, {
            serverUrl: context.upstream.url,
            fetchFn: context.fetch,
          });
        } catch {
          // See above.
        }
        record = await readRecord(context);
      }
      lastToken = record?.access_token;
      return lastToken;
    },
    onUnauthorized: async (ctx) => {
      if (context.upstream.oauth === undefined) throw new UpstreamAuthError('no_client');
      const presented = context.presented.has(ctx.response)
        ? context.presented.get(ctx.response)
        : lastToken;
      const record = await readRecord(context);
      // Nothing stored: the request needs a sign-in, which this version
      // cannot start from here.
      if (record === undefined) throw new UpstreamAuthError('sign_in_required');
      // Re-read before refresh and before re-lock (R58): the store holds
      // another token than the one that failed — send the request again
      // with it. With nothing to refresh with, send it again anyway: a token
      // stored meanwhile is picked up, and a second 401 means sign-in.
      if (record.access_token !== presented || record.refresh_token === undefined) return;
      const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(ctx.response);
      try {
        await refreshOnce(context, presented, {
          serverUrl: ctx.serverUrl,
          ...(resourceMetadataUrl !== undefined ? { resourceMetadataUrl } : {}),
          ...(scope !== undefined ? { scope } : {}),
          fetchFn: ctx.fetchFn,
        });
      } catch (err) {
        // Re-read before re-lock (R58): a token another process stored
        // while this refresh failed is used rather than reported away.
        const latest = await readRecord(context).catch(() => undefined);
        if (latest !== undefined && latest.access_token !== presented) return;
        throw err;
      }
    },
  };
}
