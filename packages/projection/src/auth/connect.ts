/**
 * The connection Projection builds for a source given by URL (PRD R51):
 * a Streamable HTTP transport carrying Projection's auth provider and its
 * guarded fetch, and the SDK `Client` over it, which Projection owns and
 * closes. Also the facade's `signOut` for the source (R59), and how every
 * failure of the source is reported: an auth failure as a typed
 * {@link UpstreamAuthProjectionError} (R25 `auth`), anything else in text
 * scrubbed of every credential the connection presented (S1).
 */

import {
  Client,
  StreamableHTTPClientTransport,
  type FetchLike,
} from '@modelcontextprotocol/client';
import { ProjectionError } from '../errors.js';
import { INTROSPECTOR_CLIENT_INFO } from '../introspector/constants.js';
import { capLength, neutralizeControlChars } from '../text-safety.js';
import type { ToolCallOutcome } from '../types.js';
import {
  createProviderContext,
  createUpstreamAuthProvider,
  findUpstreamAuthFailure,
  type ProviderContext,
  type UpstreamAuthError,
  type UpstreamAuthReason,
} from './provider.js';
import { MAX_UPSTREAM_ERROR_CHARS } from './secrets.js';
import type { TokenStore } from './token-store.js';
import { isLoopbackHost, type ResolvedUpstream } from './upstream.js';

// ---------------------------------------------------------------------------
// The guarded fetch (R61)
// ---------------------------------------------------------------------------

/** Why the connection's fetch refused to send or follow a request. */
export type RefusedReason = 'redirect' | 'token_elsewhere' | 'insecure';

/** A request the connection's fetch refused; fixed copy, no URL. */
export class UpstreamRequestRefused extends Error {
  readonly reason: RefusedReason;
  constructor(reason: RefusedReason) {
    super('the request to the upstream server was refused');
    this.name = 'UpstreamRequestRefused';
    this.reason = reason;
  }
}

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Same origin and path: the canonical resource (R61), whatever the query. */
function sameResource(a: URL, b: URL): boolean {
  return a.origin === b.origin && a.pathname === b.pathname;
}

function bearerOf(headers: RequestInit['headers']): string | undefined {
  if (headers === undefined) return undefined;
  const value = new Headers(headers).get('authorization');
  return value !== null && /^bearer /i.test(value) ? value.slice('bearer '.length) : undefined;
}

/**
 * The fetch every request of a URL source goes through — the transport's
 * own requests and the auth runs' (R61):
 *
 * - a bearer token goes only to the canonical resource (origin and path);
 * - redirects are never followed by the underlying fetch (`redirect:
 *   'manual'` whatever the caller passed), and a redirect from the resource
 *   to any other URL is refused, so the SDK's same-origin redirect
 *   following cannot carry the token to another path either;
 * - for a source that is not loopback, nothing is sent over plain `http:`;
 * - each resource response is noted with the bearer token it answered, so
 *   a 401 is matched to the token that failed (R58).
 */
export function createUpstreamFetch(
  context: ProviderContext,
  base: FetchLike = (url, init) => fetch(url, init),
): FetchLike {
  const resource = context.upstream.url;
  const sourceIsLoopback = isLoopbackHost(resource.hostname);
  return async (url, init) => {
    const target = new URL(url);
    const bearer = bearerOf(init?.headers);
    const toResource = sameResource(target, resource);
    if (bearer !== undefined && !toResource) throw new UpstreamRequestRefused('token_elsewhere');
    if (target.protocol !== 'https:' && !sourceIsLoopback) {
      throw new UpstreamRequestRefused('insecure');
    }
    const response = await base(url, { ...init, redirect: 'manual' });
    if (!toResource) return response;
    const location = REDIRECT_STATUSES.has(response.status)
      ? response.headers.get('location')
      : null;
    if (location !== null) {
      let next: URL | undefined;
      try {
        next = new URL(location, target);
      } catch {
        next = undefined;
      }
      if (next === undefined || !sameResource(next, resource)) {
        await response.body?.cancel().catch(() => undefined);
        throw new UpstreamRequestRefused('redirect');
      }
    }
    context.presented.set(response, bearer);
    return response;
  };
}

function findRefused(err: unknown): UpstreamRequestRefused | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof UpstreamRequestRefused) return current;
    current = current.cause;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * An upstream auth failure of a source given by URL (R25 `auth`, R57):
 * library copy naming the source, plus at most the OAuth `error` code; the
 * typed {@link reason} is what callers branch on (just-in-time sign-in
 * re-locks a box on it).
 */
export class UpstreamAuthProjectionError extends ProjectionError {
  readonly reason: UpstreamAuthReason;
  readonly oauthCode?: string;

  constructor(
    reason: UpstreamAuthReason,
    oauthCode: string | undefined,
    message: string,
    hint: string,
  ) {
    super('auth', message, { hint });
    this.name = 'UpstreamAuthProjectionError';
    this.reason = reason;
    if (oauthCode !== undefined) this.oauthCode = oauthCode;
  }
}

const INTERIM =
  'Just-in-time sign-in (asking the user to sign in on first use) is not supported in this version; until then, wrap this server with an integrator-owned Client whose transport carries its own authorization.';

/** The R25 `auth` error for `failure` of the source `where` names. Library copy only (R57). */
function authError(where: string, failure: UpstreamAuthError): UpstreamAuthProjectionError {
  const code = failure.oauthCode !== undefined ? ` (OAuth error "${failure.oauthCode}")` : '';
  const make = (message: string, hint: string): UpstreamAuthProjectionError =>
    new UpstreamAuthProjectionError(failure.reason, failure.oauthCode, message, hint);
  switch (failure.reason) {
    case 'no_client':
      return make(
        `${where} requires sign-in, and no OAuth client is configured for it`,
        `Set oauth.clientId to an OAuth client you registered with the server's authorization server, with the device flow enabled. ${INTERIM}`,
      );
    case 'insufficient_scope':
      return make(
        `${where}: the granted scopes do not cover the request`,
        'Set oauth.scopes to the scopes the server needs, then sign in again (signOut clears the stored token).',
      );
    case 'token_store':
      return make(
        `${where}: the token store failed`,
        'Check the configured tokenStore, or the OS credential store if you use the default.',
      );
    case 'refresh_failed':
      return make(
        `${where}: refreshing the stored sign-in failed (the authorization server did not answer usably, or could not be reached); the stored sign-in is kept`,
        "This is usually temporary: try again. If it persists, check that the server's authorization server is reachable and its OAuth metadata is valid.",
      );
    case 'client_rejected':
      return make(
        `${where}: the authorization server rejected the OAuth client (OAuth error "invalid_client" or "unauthorized_client"); the stored sign-in is kept`,
        "Check oauth.clientId — and oauth.clientSecret, if the registration has one — against the client registered with the server's authorization server.",
      );
    case 'insecure_endpoint':
      return make(
        `${where}: an authorization-server endpoint is not https:`,
        "Every authorization-server endpoint must be https: (http: only on a loopback host, and only when the source URL is itself loopback). Check the server's OAuth metadata.",
      );
    case 'oauth_error':
    case 'failed':
      return make(
        `${where}: upstream authorization failed${code}`,
        `Check the server's OAuth metadata and oauth settings. ${INTERIM}`,
      );
    case 'sign_in_required':
      return make(
        `${where} requires sign-in: it answered 401 Unauthorized and no usable token is stored`,
        INTERIM,
      );
  }
}

function refusedText(where: string, reason: RefusedReason): { message: string; hint: string } {
  switch (reason) {
    case 'redirect':
      return {
        message: `${where} redirected a request to another URL; Projection sends the sign-in token only to the configured URL, so the redirect was not followed`,
        hint: 'If the server has moved, use its new endpoint URL as the source URL.',
      };
    case 'token_elsewhere':
      return {
        message: `${where}: a request carrying the sign-in token was addressed to another URL than the configured one, and was not sent`,
        hint: 'Projection sends the sign-in token only to the configured URL.',
      };
    case 'insecure':
      return {
        message: `${where}: a request would have been sent over plain http, and was not sent`,
        hint: 'Every request of an https: source stays on https:.',
      };
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// The connector
// ---------------------------------------------------------------------------

/**
 * One `UpstreamSpec` source, validated and bound to its token store. The
 * introspector opens it like any other source; Projection owns the client.
 */
export class UpstreamConnector {
  readonly upstream: ResolvedUpstream;
  readonly #context: ProviderContext;
  /** How messages name the source: `source "github"`, or `the wrapped server`. */
  readonly label: string;

  constructor(upstream: ResolvedUpstream, store: TokenStore, label: string) {
    this.upstream = upstream;
    this.label = label;
    this.#context = createProviderContext(upstream, store);
    this.#context.fetch = createUpstreamFetch(this.#context);
  }

  /** The R60 identity, `url:<canonical url>`. */
  get identity(): string {
    return this.upstream.identity;
  }

  /** The source and its host, for messages: `source "github" (api.github.com)`. */
  get where(): string {
    return `${this.label} (${this.upstream.host})`;
  }

  /**
   * Connect (R51): Streamable HTTP with Projection's auth provider and
   * guarded fetch, `onInsufficientScope: 'throw'` and the SDK's default
   * `redirectPolicy` (never `'follow'`, R58, R61). Aborting `signal` closes
   * the half-open connection. Any failure is {@link toError}'s.
   */
  async open(signal?: AbortSignal): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(this.upstream.url, {
      authProvider: createUpstreamAuthProvider(this.#context),
      onInsufficientScope: 'throw',
      fetch: this.#context.fetch,
    });
    const client = new Client(INTROSPECTOR_CLIENT_INFO, { capabilities: {} });
    const abort = (): void => {
      void client.close().catch(() => undefined);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted === true) throw new Error('aborted');
      await client.connect(transport);
    } catch (err) {
      await client.close().catch(() => undefined);
      throw this.toError(err);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    return client;
  }

  /** `text` from this source, inert, with every credential it presented redacted, and bounded. */
  redactText(text: string): string {
    return capLength(
      neutralizeControlChars(this.#context.secrets.scrub(text)),
      MAX_UPSTREAM_ERROR_CHARS,
    );
  }

  /**
   * `value` from this source with every credential it presented redacted.
   * Throws a {@link ProjectionError} when the value cannot be checked (fail
   * closed, `SecretSet.scrubValue`).
   */
  redact<T>(value: T): T {
    return this.#context.secrets.scrubValue(value);
  }

  /**
   * Abort every auth request this connection's runs have in flight (a
   * refresh, its discovery), so a facade that closes leaves no refresh
   * behind for another facade over the same store to wait on.
   */
  close(): void {
    this.#context.lifetime.abort();
  }

  /** The typed `auth` error for `err`, when it is an upstream auth failure. */
  authFailure(err: unknown): UpstreamAuthProjectionError | undefined {
    if (err instanceof UpstreamAuthProjectionError) return err;
    const failure = findUpstreamAuthFailure(err);
    return failure !== undefined ? authError(this.where, failure) : undefined;
  }

  /**
   * Any failure to connect to or introspect this source, as a
   * {@link ProjectionError}: an auth failure as the typed `auth` error; a
   * refused request in fixed copy; anything else a `protocol` error (R47)
   * whose text is redacted and bounded — never the raw error, whose
   * message, data or cause may quote a server body that echoes the token.
   */
  toError(err: unknown): ProjectionError {
    const auth = this.authFailure(err);
    if (auth !== undefined) return auth;
    const refused = findRefused(err);
    if (refused !== undefined) {
      const { message, hint } = refusedText(this.where, refused.reason);
      return new ProjectionError('protocol', message, { hint });
    }
    if (err instanceof ProjectionError) {
      return new ProjectionError(err.phase, this.redactText(err.message), {
        hint: this.redactText(err.hint),
        diagnostics: err.diagnostics,
      });
    }
    return new ProjectionError(
      'protocol',
      `${this.where} failed to connect or list its tools: ${this.redactText(errorText(err))}`,
      { hint: 'Check the server URL and that the server is reachable and answering MCP.' },
    );
  }

  /** A tool call to this source that threw, as the outcome `call_tool` and a machine see (R25). */
  callFailure(name: string, err: unknown): Extract<ToolCallOutcome, { ok: false }> {
    const auth = this.authFailure(err);
    if (auth !== undefined) {
      return {
        ok: false,
        error: { message: auth.message, detail: { phase: 'auth', reason: auth.reason } },
        auth: { hint: auth.hint },
      };
    }
    const refused = findRefused(err);
    if (refused !== undefined) {
      return { ok: false, error: { message: refusedText(this.where, refused.reason).message } };
    }
    return {
      ok: false,
      error: {
        message: `Tool call "${name}" failed: ${this.redactText(errorText(err))}`,
        detail: err instanceof Error ? { name: err.name } : this.#redactOrOmit(err),
      },
    };
  }

  /** `value` redacted, or `undefined` when it cannot be checked. */
  #redactOrOmit(value: unknown): unknown {
    try {
      return this.redact(value);
    } catch {
      return undefined;
    }
  }

  /**
   * Delete the stored tokens of this source (R59). No revocation yet (phase
   * 1b). A store that cannot delete is an `auth` error: a sign-out must not
   * silently leave the token behind.
   */
  async signOut(): Promise<void> {
    const key = this.#context.key;
    if (key === undefined) return;
    try {
      await this.#context.store.delete(key);
    } catch {
      // Fixed copy whatever failed: neither the keyring library's text
      // (TokenStoreError) nor an integrator store's own error is surfaced.
      throw new ProjectionError('auth', `could not remove the stored sign-in for ${this.label}`, {
        hint: `The token store failed. Remove the entry by hand: service "@astral-mcp/projection" in the OS credential store, or your configured tokenStore.`,
      });
    }
  }
}

/** The R25 `auth` error for an upstream auth failure of `connector` (library copy, R57). */
export function upstreamAuthProjectionError(
  connector: UpstreamConnector,
  failure: UpstreamAuthError,
): UpstreamAuthProjectionError {
  return authError(connector.where, failure);
}
