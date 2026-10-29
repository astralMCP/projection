/**
 * The connection Projection builds for a source given by URL (PRD R51):
 * a Streamable HTTP transport carrying Projection's auth provider, and the
 * SDK `Client` over it, which Projection owns and closes. Also the facade's
 * `signOut` for the source (R59) and the mapping of an upstream auth failure
 * to the R25 `auth` phase.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ProjectionError } from '../errors.js';
import {
  createUpstreamAuthProvider,
  findUpstreamAuthFailure,
  type ProviderContext,
  type UpstreamAuthError,
} from './provider.js';
import { tokenStoreKey, type TokenStore } from './token-store.js';
import type { ResolvedUpstream } from './upstream.js';

const CLIENT_INFO = { name: 'projection-introspector', version: '0.1.0' };

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
    this.#context = {
      upstream,
      store,
      key:
        upstream.oauth !== undefined
          ? tokenStoreKey(upstream.canonicalUrl, upstream.oauth.clientId)
          : undefined,
    };
  }

  /** The R60 identity, `url:<canonical url>`. */
  get identity(): string {
    return this.upstream.identity;
  }

  /**
   * Connect (R51): Streamable HTTP with Projection's auth provider,
   * `onInsufficientScope: 'throw'` and the SDK's default `redirectPolicy`
   * (never `'follow'`, R58, R61). An auth failure becomes an `auth`
   * {@link ProjectionError}; any other failure propagates as today (R47).
   */
  async open(): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(this.upstream.url, {
      authProvider: createUpstreamAuthProvider(this.#context),
      onInsufficientScope: 'throw',
    });
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    try {
      await client.connect(transport);
    } catch (err) {
      await client.close().catch(() => undefined);
      throw this.mapError(err);
    }
    return client;
  }

  /** `err` as an `auth` {@link ProjectionError} when it is an upstream auth failure, else unchanged. */
  mapError(err: unknown): unknown {
    const failure = findUpstreamAuthFailure(err);
    return failure !== undefined ? upstreamAuthProjectionError(this, failure) : err;
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

/**
 * The R25 `auth` error for an upstream auth failure at wrap time. Library
 * copy only, plus the OAuth `error` code when it matched `^[a-z_]+$` (R57).
 * Phase 1A interim: a source that needs a sign-in fails the wrap; locked
 * boxes and just-in-time sign-in arrive in the next change (phase 1B).
 */
export function upstreamAuthProjectionError(
  connector: UpstreamConnector,
  failure: UpstreamAuthError,
): ProjectionError {
  const where = `${connector.label} (${connector.upstream.host})`;
  const code = failure.oauthCode !== undefined ? ` (OAuth error "${failure.oauthCode}")` : '';
  const interim =
    'Just-in-time sign-in (asking the user to sign in on first use) lands in the next Projection change; until then, wrap this server with an integrator-owned Client whose transport carries its own authorization.';
  switch (failure.reason) {
    case 'no_client':
      return new ProjectionError(
        'auth',
        `${where} requires sign-in, and no OAuth client is configured for it`,
        {
          hint: `Set oauth.clientId to an OAuth client you registered with the server's authorization server, with the device flow enabled. ${interim}`,
        },
      );
    case 'insufficient_scope':
      return new ProjectionError('auth', `${where}: the granted scopes do not cover the request`, {
        hint: 'Set oauth.scopes to the scopes the server needs, then sign in again (signOut clears the stored token).',
      });
    case 'token_store':
      return new ProjectionError('auth', `${where}: the token store failed`, {
        hint: 'Check the configured tokenStore, or the OS credential store if you use the default.',
      });
    case 'oauth_error':
    case 'failed':
      return new ProjectionError('auth', `${where}: upstream authorization failed${code}`, {
        hint: `Check the server's OAuth metadata and oauth settings. ${interim}`,
      });
    case 'sign_in_required':
      return new ProjectionError(
        'auth',
        `${where} requires sign-in: it answered 401 Unauthorized and no usable token is stored`,
        { hint: interim },
      );
  }
}
