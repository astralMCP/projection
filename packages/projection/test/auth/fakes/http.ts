/**
 * A tiny in-process HTTP server on 127.0.0.1 that hands each request to a
 * fetch-style handler — the base of the fake protected resource and the
 * fake authorization server. Every request is recorded (method, path,
 * headers, body) so a test can assert what was, and was not, sent.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface FakeHttpServer {
  /** `http://127.0.0.1:<port>` */
  readonly origin: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

function flattenHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

/** Start a server on an ephemeral loopback port. */
export async function startFakeHttpServer(handle: FetchHandler): Promise<FakeHttpServer> {
  const requests: RecordedRequest[] = [];
  let origin = '';
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const method = req.method ?? 'GET';
      const headers = flattenHeaders(req);
      requests.push({ method, path: req.url ?? '/', headers, body: body.toString('utf8') });
      let response: Response;
      try {
        response = await handle(
          new Request(`${origin}${req.url ?? '/'}`, {
            method,
            headers,
            ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
          }),
        );
      } catch {
        response = new Response('fake server handler failed', { status: 500 });
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body !== null) {
        for await (const chunk of response.body) res.write(chunk);
      }
      res.end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
