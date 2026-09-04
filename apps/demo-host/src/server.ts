/**
 * MCP Apps demo server (PRD §12.1 demo surface).
 *
 * Wraps the official filesystem reference server — one of the §13
 * smoke-matrix test servers — with Projection, serves the code-mode facade
 * over StreamableHTTP at /mcp, and serves the static host page that renders
 * the workflow dashboard app in a sandboxed iframe.
 *
 * The upstream runs as a stdio child over a seeded temp directory, exactly
 * like the smoke tests, so approved writes land on a real disk.
 */

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { wrapMcpServer } from '@astral-mcp/projection';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');
const PORT = Number(process.env['PORT'] ?? 8787);

async function main(): Promise<void> {
  // The demo workspace the filesystem server is sandboxed to.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'projection-apps-demo-')));
  writeFileSync(join(dir, 'notes.txt'), 'Projection MCP Apps demo — hello from the real disk.');
  writeFileSync(join(dir, 'todo.txt'), '- watch the dashboard render');

  const serverEntry = join(
    dirname(require.resolve('@modelcontextprotocol/server-filesystem/package.json')),
    'dist/index.js',
  );
  const client = new Client({ name: 'apps-demo-host', version: '0.1.0' }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry, dir],
      stderr: 'inherit',
    }),
  );

  const facade = await wrapMcpServer(client, { blob: { key: randomBytes(32) } });
  const handler = createMcpHandler(facade.serverFactory);

  const statics = new Map([
    ['/', { path: join(PUBLIC_DIR, 'index.html'), type: 'text/html; charset=utf-8' }],
    [
      '/host.iife.js',
      { path: join(PUBLIC_DIR, 'host.iife.js'), type: 'text/javascript; charset=utf-8' },
    ],
  ]);

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

      if (url.pathname === '/config') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ dir }));
        return;
      }

      const asset = statics.get(url.pathname);
      if (asset !== undefined) {
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
        res.end(readFileSync(asset.path));
        return;
      }

      if (url.pathname === '/mcp') {
        // Adapt Node's request to the fetch-style handler.
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(name, value);
          else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
        }
        const response = await handler.fetch(
          new Request(url, {
            method: req.method,
            headers,
            ...(body.length > 0 ? { body, duplex: 'half' } : {}),
          } as RequestInit),
        );
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    })().catch((err: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    });
  });

  server.listen(PORT, () => {
    console.info(`Projection MCP Apps demo: http://localhost:${PORT}`);
    console.info(`Wrapped upstream: filesystem server over ${dir}`);
  });

  const shutdown = async (): Promise<void> => {
    server.close();
    await facade.close();
    await client.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

await main();
