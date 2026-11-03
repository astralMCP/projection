/**
 * Published-artifact smoke test: `npm pack` the workspace `@astral-mcp/projection`,
 * install the tarball into a fresh temp project (dependencies resolved from
 * the registry, exactly like a consumer install), and run a machine
 * end-to-end in a child process.
 *
 * This is the only test class that catches works-in-workspace,
 * broken-when-published bugs: v0.1.0 shipped without `typescript` in
 * dependencies (the generated tools bridge is always TypeScript, so the
 * transpiler is a hard runtime requirement) — every workspace test passed
 * while every consumer install was broken. Needs registry network, same as
 * `pnpm install` itself; skipped only when PROJ_SKIP_PACK_SMOKE=1.
 *
 * It also checks the optional keyring dependency (PRD R59): that the
 * installed package resolves `@napi-rs/keyring`, and that wrapping a public
 * server by URL still works when the module cannot load — with the import
 * blocked by a resolve hook, so the real OS credential store is never
 * touched — printing the in-memory fallback warning exactly once.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECTION_DIR = resolve(HERE, '../../../projection');

/**
 * The SDK the consumer installs alongside the tarball, as its own
 * dependency: `@modelcontextprotocol/{client,server}` are peer dependencies
 * of Projection (DECISIONS D40), so this is the copy Projection imports too.
 * The version is Projection's own exact devDependency pin, read from its
 * manifest, and must satisfy the published peer range.
 */
const PROJECTION_MANIFEST = JSON.parse(
  readFileSync(join(PROJECTION_DIR, 'package.json'), 'utf8'),
) as {
  devDependencies: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
const SDK_PACKAGES = ['@modelcontextprotocol/server', '@modelcontextprotocol/client'] as const;
const SDK_VERSION = PROJECTION_MANIFEST.devDependencies['@modelcontextprotocol/server'];
if (SDK_VERSION === undefined) {
  throw new Error(
    '@astral-mcp/projection no longer pins @modelcontextprotocol/server for its own build',
  );
}
for (const name of SDK_PACKAGES) {
  if (PROJECTION_MANIFEST.peerDependencies?.[name] === undefined) {
    throw new Error(`@astral-mcp/projection no longer takes ${name} as a peer dependency`);
  }
}

const CONSUMER_SCRIPT = `
import { McpServer } from '@modelcontextprotocol/server';
import { wrapMcpServer } from '@astral-mcp/projection';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const server = new McpServer({ name: 'pack-smoke', version: '1.0.0' });
server.registerTool(
  'greet',
  { description: 'hi', inputSchema: z.object({ name: z.string() }), annotations: { readOnlyHint: true } },
  ({ name }) => ({ content: [{ type: 'text', text: 'hello ' + name }] }),
);

const facade = await wrapMcpServer(server, { blob: { key: randomBytes(32) } });
const result = await facade.executeMachine({ code: \`
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';
export default setup({}).createMachine({
  id: 'g', context: { text: null }, initial: 'greeting',
  states: { greeting: { entry: toolCall('greet', () => ({ name: 'npm' })),
    on: { TOOL_RESULT: { target: 'done', actions: assign({ text: ({ event }) => event.result }) } } },
    done: { type: 'final' } },
  output: ({ context }) => ({ text: context.text }),
});\` }, 'modern');
console.log(JSON.stringify(result.structuredContent ?? {}));
await facade.close();
`;

/** Resolves the optional keyring module from the consumer and from the installed package. */
const RESOLVE_KEYRING_SCRIPT = `
import { createRequire } from 'node:module';
const fromConsumer = import.meta.resolve('@napi-rs/keyring');
const fromPackage = createRequire(import.meta.resolve('@astral-mcp/projection/package.json')).resolve('@napi-rs/keyring');
console.log(JSON.stringify({ fromConsumer, fromPackage }));
`;

/**
 * Resolves each SDK package from the consumer and from the installed
 * package, and lists every SDK package manifest on disk: a single copy means
 * one path per package, the same from both sides.
 */
const RESOLVE_SDK_SCRIPT = `
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const fromPackage = createRequire(import.meta.resolve('@astral-mcp/projection/package.json'));
const resolved = {};
for (const name of ${JSON.stringify(SDK_PACKAGES)}) {
  resolved[name] = { fromConsumer: import.meta.resolve(name), fromPackage: 'file://' + fromPackage.resolve(name) };
}
const copies = [];
const walk = (dir) => {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const scope = join(dir, entry);
    if (entry === '@modelcontextprotocol') {
      for (const name of readdirSync(scope)) {
        const manifest = join(scope, name, 'package.json');
        if (existsSync(manifest)) {
          copies.push(name + '@' + JSON.parse(readFileSync(manifest, 'utf8')).version + ' ' + join(scope, name));
        }
        walk(join(scope, name, 'node_modules'));
      }
    } else if (entry.startsWith('@')) {
      for (const name of readdirSync(scope)) walk(join(scope, name, 'node_modules'));
    } else {
      walk(join(scope, 'node_modules'));
    }
  }
};
walk('node_modules');
console.log(JSON.stringify({ resolved, copies }));
`;

/** A resolve hook that makes `@napi-rs/keyring` unloadable, as on a platform without a prebuilt binary. */
const BLOCK_KEYRING_HOOKS = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@napi-rs/keyring' || specifier.startsWith('@napi-rs/keyring/')) {
    const error = new Error('Cannot find package ' + specifier + ' (blocked by the pack smoke test)');
    error.code = 'ERR_MODULE_NOT_FOUND';
    throw error;
  }
  return nextResolve(specifier, context);
}
`;

const REGISTER_BLOCK_SCRIPT = `
import { register } from 'node:module';
register('./block-keyring-hooks.mjs', import.meta.url);
`;

/** Wraps a public MCP server by URL with the default token store, calls a tool, and closes. */
const URL_WRAP_SCRIPT = `
import { createServer } from 'node:http';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { wrapMcpServer } from '@astral-mcp/projection';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'public-smoke', version: '1.0.0' });
  server.registerTool(
    'greet',
    { description: 'hi', inputSchema: z.object({ name: z.string() }), annotations: { readOnlyHint: true } },
    ({ name }) => ({ content: [{ type: 'text', text: 'hello ' + name }] }),
  );
  return server;
});
const http = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const method = req.method ?? 'GET';
  const response = await handler.fetch(
    new Request('http://127.0.0.1:' + http.address().port + req.url, {
      method,
      headers: req.headers,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
    }),
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body !== null) for await (const chunk of response.body) res.write(chunk);
  res.end();
});
await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));

// An oauth.clientId makes the provider consult the (default) token store.
const facade = await wrapMcpServer(
  { url: 'http://127.0.0.1:' + http.address().port + '/mcp', oauth: { clientId: 'pack-smoke' } },
  { blob: { key: randomBytes(32) } },
);
const result = await facade.callTool({ name: 'greet', args: { name: 'url' } }, 'modern');
console.log(JSON.stringify(result.structuredContent ?? result.content ?? {}));
await facade.close();
http.closeAllConnections();
http.close();
`;

const FALLBACK_WARNING_START = '[@astral-mcp/projection] The OS credential store is unavailable';

describe.skipIf(process.env['PROJ_SKIP_PACK_SMOKE'] === '1')(
  'packed-tarball consumer install',
  () => {
    it(
      'a fresh npm install of the packed @astral-mcp/projection runs a machine end-to-end and wraps a server by URL without the keyring',
      { timeout: 300_000 },
      () => {
        // `npm pack` ships whatever dist/ is on disk — no build runs here.
        // Without this guard the test smoke-tests stale output after src
        // edits, or packs a dist-less tarball on a fresh clone.
        const distEntry = join(PROJECTION_DIR, 'dist', 'index.mjs');
        expect(
          existsSync(distEntry),
          `${distEntry} is missing — run "pnpm run build" first so the packed tarball contains current build output`,
        ).toBe(true);

        const dir = mkdtempSync(join(tmpdir(), 'proj-pack-smoke-'));
        try {
          // Pack the CURRENT workspace state of the library (runs no scripts).
          const tarball = execFileSync('npm', ['pack', '--pack-destination', dir], {
            cwd: PROJECTION_DIR,
            encoding: 'utf8',
          })
            .trim()
            .split('\n')
            .at(-1) as string;

          writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({ name: 'pack-smoke', private: true, type: 'module' }),
          );
          // Consumer-style install: the tarball plus the consumer's own SDK
          // (Projection's peers), everything else resolved from the registry
          // per the tarball's own dependency ranges — exactly what a real
          // `npm install @astral-mcp/projection @modelcontextprotocol/server @modelcontextprotocol/client` does.
          execFileSync(
            'npm',
            [
              'install',
              '--no-audit',
              '--no-fund',
              join(dir, tarball),
              ...SDK_PACKAGES.map((name) => `${name}@${SDK_VERSION}`),
            ],
            { cwd: dir, encoding: 'utf8', stdio: 'pipe' },
          );

          // D40: the peers are satisfied (`npm ls` exits non-zero on an
          // invalid or missing peer) and the consumer's SDK is the only copy
          // installed — Projection imports the very modules the consumer does,
          // so `instanceof McpServer` holds across the boundary.
          execFileSync('npm', ['ls', '--all', ...SDK_PACKAGES], { cwd: dir, stdio: 'pipe' });
          writeFileSync(join(dir, 'resolve-sdk.mjs'), RESOLVE_SDK_SCRIPT);
          const sdk = JSON.parse(
            execFileSync(process.execPath, ['resolve-sdk.mjs'], {
              cwd: dir,
              encoding: 'utf8',
              stdio: 'pipe',
            }).trim(),
          ) as {
            resolved: Record<string, { fromConsumer: string; fromPackage: string }>;
            copies: string[];
          };
          for (const name of SDK_PACKAGES) {
            const { fromConsumer, fromPackage } = sdk.resolved[name] ?? {};
            expect(fromConsumer, name).toContain(`node_modules/${name}/`);
            expect(fromPackage, name).not.toContain('@astral-mcp/projection/node_modules');
            // Same package directory from both sides (the ESM and CJS
            // entry files differ; the directory must not).
            const root = (url: string | undefined): string =>
              (url ?? '').slice(0, (url ?? '').indexOf(`node_modules/${name}/`));
            expect(root(fromPackage), name).toBe(root(fromConsumer));
          }
          const sdkCopies = sdk.copies.filter((copy) =>
            SDK_PACKAGES.some((name) => copy.startsWith(`${name.split('/')[1]}@`)),
          );
          expect(sdkCopies.map((copy) => copy.split(' ')[0]).sort()).toEqual(
            SDK_PACKAGES.map((name) => `${name.split('/')[1]}@${SDK_VERSION}`).sort(),
          );

          writeFileSync(join(dir, 'main.mjs'), CONSUMER_SCRIPT);
          const out = execFileSync(process.execPath, ['main.mjs'], {
            cwd: dir,
            encoding: 'utf8',
            stdio: 'pipe',
          });

          const structured = JSON.parse(out.trim().split('\n').at(-1) as string) as {
            output?: unknown;
            approvals?: unknown[];
            phase?: string;
            message?: string;
          };
          expect(
            structured.output,
            `machine failed: ${structured.phase}: ${structured.message}`,
          ).toEqual({ text: 'hello npm' });
          // The audit trail records the auto-executed read too.
          expect(structured.approvals).toHaveLength(1);

          // R59: the optional keyring dependency installs with the package
          // and resolves from it.
          writeFileSync(join(dir, 'resolve-keyring.mjs'), RESOLVE_KEYRING_SCRIPT);
          const resolved = JSON.parse(
            execFileSync(process.execPath, ['resolve-keyring.mjs'], {
              cwd: dir,
              encoding: 'utf8',
              stdio: 'pipe',
            }).trim(),
          ) as { fromConsumer: string; fromPackage: string };
          expect(resolved.fromConsumer).toContain('@napi-rs/keyring');
          expect(resolved.fromPackage).toContain('@napi-rs/keyring');

          // R59 fallback: with the keyring import blocked (never touching
          // the OS store), wrapping a public server by URL works and warns
          // exactly once.
          writeFileSync(join(dir, 'block-keyring-hooks.mjs'), BLOCK_KEYRING_HOOKS);
          writeFileSync(join(dir, 'register-block-keyring.mjs'), REGISTER_BLOCK_SCRIPT);
          writeFileSync(join(dir, 'url-wrap.mjs'), URL_WRAP_SCRIPT);
          const run = spawnSync(
            process.execPath,
            ['--import', './register-block-keyring.mjs', 'url-wrap.mjs'],
            { cwd: dir, encoding: 'utf8', timeout: 60_000 },
          );
          expect(run.status, `url-wrap.mjs failed: ${run.stderr}`).toBe(0);
          expect(run.stdout).toContain('hello url');
          expect(run.stderr.split(FALLBACK_WARNING_START)).toHaveLength(2);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  },
);
