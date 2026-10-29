/**
 * A fake OAuth authorization server (RFC 8414 metadata + a token endpoint)
 * on 127.0.0.1, with per-test switches. It is the source of truth for which
 * access tokens are valid: the fake protected resource asks it.
 *
 * Phase 1A exercises the refresh grant. Phase 1B extends this fake with the
 * device authorization, registration and revocation endpoints (the
 * `routes` hook adds a path without touching the core).
 */

import { json, startFakeHttpServer, type FakeHttpServer, type FetchHandler } from './http.js';

/** What the token endpoint does with a `refresh_token` grant. */
export type RefreshBehavior =
  /** Issue a new access token and rotate the refresh token. */
  | 'rotate'
  /** Issue a new access token and keep the refresh token (no `refresh_token` in the response). */
  | 'keep'
  /** `400 { error: "invalid_grant" }`: the refresh token is dead. */
  | 'invalid_grant'
  /** A 500 with a non-JSON body (the SDK warns and gives up the refresh). */
  | 'server_error'
  /** `400` with a custom `error` and an `error_description` that echoes the refresh token. */
  | { error: string; echoSecret: true };

export interface IssuedTokens {
  access_token: string;
  refresh_token?: string;
}

export interface FakeAuthorizationServerOptions {
  /** Response to a refresh grant. Default `'rotate'`. */
  refresh?: RefreshBehavior;
  /** `expires_in` of issued tokens. Default 3600. */
  expiresIn?: number;
  /** Extra routes by path, consulted before the built-in ones. */
  routes?: Record<string, FetchHandler>;
}

export class FakeAuthorizationServer {
  readonly #server: FakeHttpServer;
  readonly #validAccess = new Set<string>();
  readonly #validRefresh = new Set<string>();
  #counter = 0;
  options: FakeAuthorizationServerOptions;

  private constructor(server: FakeHttpServer, options: FakeAuthorizationServerOptions) {
    this.#server = server;
    this.options = options;
  }

  static async start(
    options: FakeAuthorizationServerOptions = {},
  ): Promise<FakeAuthorizationServer> {
    let self: FakeAuthorizationServer | undefined;
    const server = await startFakeHttpServer((request) => {
      if (self === undefined) return new Response('not ready', { status: 503 });
      return self.#handle(request);
    });
    self = new FakeAuthorizationServer(server, options);
    return self;
  }

  get issuer(): string {
    return this.#server.origin;
  }

  get requests() {
    return this.#server.requests;
  }

  /** Requests to the token endpoint. */
  get tokenRequests() {
    return this.#server.requests.filter((request) => request.path === '/token');
  }

  /** Mint a token set the fake resource accepts. Distinctive values, easy to grep for. */
  issue(prefix = 'tok'): IssuedTokens & { refresh_token: string } {
    this.#counter += 1;
    const tokens = {
      access_token: `AT-${prefix}-${this.#counter}-SECRET-ACCESS`,
      refresh_token: `RT-${prefix}-${this.#counter}-SECRET-REFRESH`,
    };
    this.#validAccess.add(tokens.access_token);
    this.#validRefresh.add(tokens.refresh_token);
    return tokens;
  }

  /** Make an access token stop working (expired or revoked). */
  expire(accessToken: string): void {
    this.#validAccess.delete(accessToken);
  }

  isValidAccessToken(token: string): boolean {
    return this.#validAccess.has(token);
  }

  close(): Promise<void> {
    return this.#server.close();
  }

  #metadata(): Record<string, unknown> {
    const issuer = this.issuer;
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      device_authorization_endpoint: `${issuer}/device`,
      response_types_supported: ['code'],
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:device_code',
      ],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    };
  }

  async #handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const route = this.options.routes?.[path];
    if (route !== undefined) return route(request);
    if (
      path === '/.well-known/oauth-authorization-server' ||
      path === '/.well-known/openid-configuration'
    ) {
      return json(this.#metadata());
    }
    if (path === '/token' && request.method === 'POST') return this.#token(await request.text());
    return new Response('not found', { status: 404 });
  }

  #token(body: string): Response {
    const params = new URLSearchParams(body);
    if (params.get('grant_type') !== 'refresh_token') {
      return json({ error: 'unsupported_grant_type' }, 400);
    }
    const refresh = params.get('refresh_token') ?? '';
    const behavior = this.options.refresh ?? 'rotate';
    if (typeof behavior === 'object') {
      return json(
        { error: behavior.error, error_description: `refresh token ${refresh} was rejected` },
        400,
      );
    }
    if (behavior === 'server_error') {
      return new Response(`internal error while handling ${refresh}`, { status: 500 });
    }
    if (behavior === 'invalid_grant' || !this.#validRefresh.has(refresh)) {
      return json({ error: 'invalid_grant', error_description: `bad refresh ${refresh}` }, 400);
    }
    const issued = this.issue('refreshed');
    const response: Record<string, unknown> = {
      access_token: issued.access_token,
      token_type: 'Bearer',
      expires_in: this.options.expiresIn ?? 3600,
    };
    if (behavior === 'rotate') {
      this.#validRefresh.delete(refresh);
      response['refresh_token'] = issued.refresh_token;
    } else {
      this.#validRefresh.delete(issued.refresh_token);
    }
    return json(response);
  }
}
