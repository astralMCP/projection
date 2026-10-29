/**
 * A fake OAuth-protected MCP server on 127.0.0.1 (RFC 9728): it publishes
 * protected resource metadata naming a {@link FakeAuthorizationServer},
 * answers 401 with `WWW-Authenticate` to a request without a valid token,
 * and serves a tiny MCP server (over the SDK's Streamable HTTP handler) to a
 * request with one. Per-test switches cover the failure shapes; every
 * request, and every bearer token presented, is recorded.
 */

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  FakeAuthorizationServer,
  type FakeAuthorizationServerOptions,
} from './authorization-server.js';
import { json, startFakeHttpServer, type FakeHttpServer } from './http.js';

export const RESOURCE_PATH = '/mcp';

export interface FakeProtectedResourceOptions {
  /** Serve without requiring a token at all. */
  public?: boolean;
  /** Answer every MCP request with this status and a plain-text body (non-auth failure). */
  failWith?: number;
  /** Answer authenticated requests 403 `insufficient_scope`. */
  insufficientScope?: boolean;
  /** `scopes_supported` in the resource metadata. */
  scopesSupported?: string[];
  /** Server name/version the MCP server reports. Default `fake-remote@1.0.0`. */
  serverInfo?: { name: string; version: string };
}

/** The MCP server behind the fake resource: one read-only tool and one write. */
function mcpServer(info: { name: string; version: string }): McpServer {
  const server = new McpServer(info, { instructions: 'A fake remote server behind OAuth.' });
  server.registerTool(
    'whoami',
    {
      description: 'Report the signed-in user.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () => ({ content: [{ type: 'text' as const, text: 'octocat' }] }),
  );
  server.registerTool(
    'create_issue',
    {
      description: 'Create an issue.',
      inputSchema: z.object({ title: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ title }) => ({ content: [{ type: 'text' as const, text: `created ${title}` }] }),
  );
  return server;
}

export class FakeProtectedResource {
  readonly #server: FakeHttpServer;
  readonly #as: FakeAuthorizationServer;
  options: FakeProtectedResourceOptions;
  /** Every bearer token presented, valid or not. */
  readonly presentedTokens: string[] = [];

  private constructor(
    server: FakeHttpServer,
    as: FakeAuthorizationServer,
    options: FakeProtectedResourceOptions,
  ) {
    this.#server = server;
    this.#as = as;
    this.options = options;
  }

  static async start(
    as: FakeAuthorizationServer,
    options: FakeProtectedResourceOptions = {},
  ): Promise<FakeProtectedResource> {
    let self: FakeProtectedResource | undefined;
    const server = await startFakeHttpServer((request) => {
      if (self === undefined) return new Response('not ready', { status: 503 });
      return self.#handle(request);
    });
    self = new FakeProtectedResource(server, as, options);
    return self;
  }

  get origin(): string {
    return this.#server.origin;
  }

  /** The MCP endpoint: what an `UpstreamSpec.url` points at. */
  get url(): string {
    return `${this.#server.origin}${RESOURCE_PATH}`;
  }

  get metadataUrl(): string {
    return `${this.#server.origin}/.well-known/oauth-protected-resource${RESOURCE_PATH}`;
  }

  get requests() {
    return this.#server.requests;
  }

  close(): Promise<void> {
    return this.#server.close();
  }

  #challenge(): Response {
    return new Response('unauthorized', {
      status: 401,
      headers: { 'www-authenticate': `Bearer resource_metadata="${this.metadataUrl}"` },
    });
  }

  async #handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      return json({
        resource: this.url,
        authorization_servers: [this.#as.issuer],
        ...(this.options.scopesSupported !== undefined
          ? { scopes_supported: this.options.scopesSupported }
          : {}),
        bearer_methods_supported: ['header'],
      });
    }
    if (path !== RESOURCE_PATH) return new Response('not found', { status: 404 });
    if (this.options.failWith !== undefined) {
      return new Response('the fake upstream is down', { status: this.options.failWith });
    }
    if (this.options.public !== true) {
      const header = request.headers.get('authorization') ?? '';
      const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
      if (token !== undefined) this.presentedTokens.push(token);
      if (token === undefined || !this.#as.isValidAccessToken(token)) return this.#challenge();
      if (this.options.insufficientScope === true) {
        return new Response('forbidden', {
          status: 403,
          headers: {
            'www-authenticate': `Bearer error="insufficient_scope", scope="repo admin", resource_metadata="${this.metadataUrl}"`,
          },
        });
      }
    }
    const handler = createMcpHandler(() =>
      mcpServer(this.options.serverInfo ?? { name: 'fake-remote', version: '1.0.0' }),
    );
    return handler.fetch(request);
  }
}

/** A fake authorization server and a fake protected resource that trusts it. */
export interface FakeUpstream {
  as: FakeAuthorizationServer;
  resource: FakeProtectedResource;
  close(): Promise<void>;
}

/** Start a fake authorization server and a fake protected resource that trusts it. */
export async function startFakeUpstream(
  options: FakeAuthorizationServerOptions & { resource?: FakeProtectedResourceOptions } = {},
): Promise<FakeUpstream> {
  const { resource: resourceOptions, ...asOptions } = options;
  const as = await FakeAuthorizationServer.start(asOptions);
  const resource = await FakeProtectedResource.start(as, resourceOptions);
  return {
    as,
    resource,
    close: async () => {
      await resource.close();
      await as.close();
    },
  };
}
