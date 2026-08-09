/**
 * Smoke test against a REAL Glama-directory server (PRD §13 matrix #1):
 * the official filesystem reference server
 * (@modelcontextprotocol/server-filesystem, pinned), spawned over stdio and
 * wrapped through the same `wrapMcpServer(client)` path a deployment uses.
 *
 * What only a real server can prove:
 * - introspection over a live stdio connection (v2 Client → v1-SDK server);
 * - typegen against schemas we didn't author;
 * - annotation-driven policy on genuine annotations (reads are
 *   readOnlyHint: true → run inline; write_file carries
 *   destructiveHint: true → gated WITH the destructive warning copy, R14);
 * - approved side effects landing on the actual filesystem, declined ones
 *   never happening (S2), asserted out of band on disk.
 *
 * No network, no credentials: the server is a devDependency and runs as a
 * child process, so this is CI-safe and deterministic.
 */

import { createRequire } from 'node:module';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { wrapMcpServer, type McCircuitFacade } from 'mccircuit';
import { runScenario, declineAll } from '../../src/index.js';

const require = createRequire(import.meta.url);

/** Read machine: read_text_file is readOnlyHint: true → completes inline. */
const READ_NOTES = `
import { setup, assign } from 'xstate';
import { toolCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'readNotes',
  context: ({ input }) => ({ path: input.path, text: null }),
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('read_text_file', ({ context }) => ({ path: context.path })),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ text: ({ event }) => event.result }) },
        TOOL_ERROR: { target: 'failed', actions: assign({ text: ({ event }) => event.error.message }) },
      },
    },
    done: { type: 'final' },
    failed: { type: 'final' },
  },
  output: ({ context }) => ({ text: context.text }),
});
`;

/** Write machine: write_file is destructiveHint: true → suspends for approval. */
const WRITE_FILE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'writeFile',
  context: ({ input }) => ({ path: input.path, content: input.content, status: 'pending' }),
  initial: 'writing',
  states: {
    writing: {
      entry: toolCall('write_file', ({ context }) => ({ path: context.path, content: context.content })),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: 'written' }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'declined' }) },
        TOOL_ERROR: { target: 'done', actions: assign({ status: 'error' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status }),
});
`;

let dir: string;
let client: Client;
let facade: McCircuitFacade;

beforeAll(async () => {
  // realpath: macOS tmpdir is a /var symlink; the server resolves and
  // compares real paths when enforcing its allowed-directory sandbox.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcc-smoke-fs-')));
  writeFileSync(join(dir, 'notes.txt'), 'hello from the real filesystem');

  const serverEntry = join(
    dirname(require.resolve('@modelcontextprotocol/server-filesystem/package.json')),
    'dist/index.js',
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry, dir],
    // inherit: server startup failures print to stderr; the one-line startup
    // banner is acceptable log noise.
    stderr: 'inherit',
  });
  client = new Client({ name: 'mcc-smoke', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);

  facade = await wrapMcpServer(client, { blob: { key: randomBytes(32) } });
}, 30_000);

afterAll(async () => {
  await facade?.close();
  await client?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('official filesystem server through McCircuit (PRD §13 matrix #1)', () => {
  it('introspects the live catalog and generates types for foreign schemas', () => {
    const names = facade.catalog.tools.map((t) => t.name);
    expect(names).toContain('read_text_file');
    expect(names).toContain('write_file');
    expect(names).toContain('move_file');
    expect(names.length).toBeGreaterThanOrEqual(10);

    // Identity recorded for blob binding (R30) comes from the real server.
    expect(facade.catalog.identity).toBe('secure-filesystem-server@0.2.0');

    // Annotations survived introspection: reads read-only, writes destructive.
    const read = facade.catalog.tools.find((t) => t.name === 'read_text_file');
    const write = facade.catalog.tools.find((t) => t.name === 'write_file');
    expect(read?.annotations?.readOnlyHint).toBe(true);
    expect(write?.annotations?.destructiveHint).toBe(true);

    // Typegen produced callable signatures for schemas we did not author.
    expect(facade.dts).toContain('read_text_file');
    expect(facade.dts).toContain('write_file');
  });

  it('read-only machine completes inline against the real server', async () => {
    const result = await runScenario(
      facade,
      { calls: [] },
      {
        name: 'smoke-read',
        code: READ_NOTES,
        input: { path: join(dir, 'notes.txt') },
      },
    );

    expect(result.status).toBe('completed');
    expect(result.rounds).toBe(0); // no approval needed (S5: readOnlyHint honored)
    // The real server declares an outputSchema and returns structuredContent
    // ({ content }), which the executor rightly prefers over the text block.
    expect(result.output).toEqual({ text: { content: 'hello from the real filesystem' } });
  });

  it('gated write suspends with the DESTRUCTIVE warning, executes on approval', async () => {
    const target = join(dir, 'out.txt');
    const prompts: string[] = [];

    const result = await runScenario(
      facade,
      { calls: [] },
      {
        name: 'smoke-write-approved',
        code: WRITE_FILE,
        input: { path: target, content: 'approved by smoke test' },
        verdicts: (prompt) => {
          prompts.push(prompt.message);
          // S2: nothing on disk before the verdict.
          expect(existsSync(target)).toBe(false);
          return { action: 'accept' };
        },
      },
    );

    expect(result.status).toBe('completed');
    expect(result.rounds).toBe(1);
    expect(result.output).toEqual({ status: 'written' });
    // The approved side effect landed on the real filesystem.
    expect(readFileSync(target, 'utf8')).toBe('approved by smoke test');

    // R14: destructiveHint → clearly stronger warning language in the copy.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('DESTRUCTIVE');
    expect(prompts[0]).toContain('write_file');

    // §10 budget holds on a real-server workflow.
    expect(result.maxBlobBytes).toBeGreaterThan(0);
    expect(result.maxBlobBytes).toBeLessThan(8 * 1024);
  });

  it('declined write never touches the disk and the machine takes its fallback', async () => {
    const target = join(dir, 'never.txt');

    const result = await runScenario(
      facade,
      { calls: [] },
      {
        name: 'smoke-write-declined',
        code: WRITE_FILE,
        input: { path: target, content: 'should never exist' },
        verdicts: declineAll('not today'),
      },
    );

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ status: 'declined' });
    expect(existsSync(target)).toBe(false);
  });
});
