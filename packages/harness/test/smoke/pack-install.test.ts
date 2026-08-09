/**
 * Published-artifact smoke test: `npm pack` the workspace `mccircuit`,
 * install the tarball into a fresh temp project (dependencies resolved from
 * the registry, exactly like a consumer install), and run a machine
 * end-to-end in a child process.
 *
 * This is the only test class that catches works-in-workspace,
 * broken-when-published bugs: v0.1.0 shipped without `typescript` in
 * dependencies (the generated tools bridge is always TypeScript, so the
 * transpiler is a hard runtime requirement) — every workspace test passed
 * while every consumer install was broken. Needs registry network, same as
 * `pnpm install` itself; skipped only when MCC_SKIP_PACK_SMOKE=1.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCCIRCUIT_DIR = resolve(HERE, '../../../mccircuit');

const CONSUMER_SCRIPT = `
import { McpServer } from '@modelcontextprotocol/server';
import { wrapMcpServer } from 'mccircuit';
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
import { toolCall } from '@mccircuit/tools';
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

describe.skipIf(process.env['MCC_SKIP_PACK_SMOKE'] === '1')(
  'packed-tarball consumer install',
  () => {
    it(
      'a fresh npm install of the packed mccircuit runs a machine end-to-end',
      { timeout: 300_000 },
      () => {
        // `npm pack` ships whatever dist/ is on disk — no build runs here.
        // Without this guard the test smoke-tests stale output after src
        // edits, or packs a dist-less tarball on a fresh clone.
        const distEntry = join(MCCIRCUIT_DIR, 'dist', 'index.mjs');
        expect(
          existsSync(distEntry),
          `${distEntry} is missing — run "pnpm run build" first so the packed tarball contains current build output`,
        ).toBe(true);

        const dir = mkdtempSync(join(tmpdir(), 'mcc-pack-smoke-'));
        try {
          // Pack the CURRENT workspace state of the library (runs no scripts).
          const tarball = execFileSync('npm', ['pack', '--pack-destination', dir], {
            cwd: MCCIRCUIT_DIR,
            encoding: 'utf8',
          })
            .trim()
            .split('\n')
            .at(-1) as string;

          writeFileSync(
            join(dir, 'package.json'),
            JSON.stringify({ name: 'pack-smoke', private: true, type: 'module' }),
          );
          // Consumer-style install: the tarball plus its peer usage deps,
          // everything else resolved from the registry per the tarball's own
          // dependency ranges — exactly what a real `npm install mccircuit` does.
          execFileSync(
            'npm',
            [
              'install',
              '--no-audit',
              '--no-fund',
              join(dir, tarball),
              '@modelcontextprotocol/server@2.0.0',
            ],
            { cwd: dir, encoding: 'utf8', stdio: 'pipe' },
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
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  },
);
