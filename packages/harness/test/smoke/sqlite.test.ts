/**
 * Smoke test against a REAL Glama-directory server (PRD §13 matrix #3, the
 * adversarial policy case): `mcp-sqlite` (pinned), a community SQLite
 * server spawned over stdio. It is the database shape the PRD warns about —
 * a `query` tool whose argument is opaque SQL — and it also happens to be
 * completely UNANNOTATED, which makes it the matrix's "deliberately
 * unannotated server" check as well.
 *
 * What this proves that the file-server smoke test cannot:
 * - S5 default posture on a real server: with no annotations at all, EVERY
 *   tool asks — including semantically read-only ones like `read_records`;
 * - opaque SQL is gated and the exact SQL string is visible, inert, in the
 *   approval copy (R16) — a declined DELETE leaves the data untouched;
 * - developer overrides (R14) beat the default on the same live catalog:
 *   `auto` un-gates a vouched-for read, `deny` blocks `query` outright with
 *   the canonical policy reason and no prompt.
 *
 * CI-safe: the server is a pinned devDependency child process (sqlite3
 * native binding allow-listed in pnpm-workspace.yaml `allowBuilds`).
 */

import { createRequire } from 'node:module';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { wrapMcpServer, type ProjectionFacade } from '@astral-mcp/projection';
import { runScenario, declineAll } from '../../src/index.js';

const require = createRequire(import.meta.url);

/** Read via the record API — semantically read-only, but unannotated. */
const READ_RECORDS = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'readRecords',
  context: { rows: null, status: 'pending' },
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('read_records', () => ({ table: 'users' })),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ rows: ({ event }) => event.result, status: 'read' }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'declined' }) },
        TOOL_ERROR: { target: 'done', actions: assign({ status: 'error' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status, rows: context.rows }),
});
`;

/** Raw SQL through the opaque query tool. */
const RAW_QUERY = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'rawQuery',
  context: ({ input }) => ({ sql: input.sql, status: 'pending', reason: null }),
  initial: 'querying',
  states: {
    querying: {
      entry: toolCall('query', ({ context }) => ({ sql: context.sql })),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: 'ran' }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'declined', reason: ({ event }) => event.reason ?? null }) },
        TOOL_ERROR: { target: 'done', actions: assign({ status: 'error' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status, reason: context.reason }),
});
`;

const LIST_TABLES = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'listTables',
  context: { tables: null, status: 'pending' },
  initial: 'listing',
  states: {
    listing: {
      entry: toolCall('list_tables', () => ({})),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ tables: ({ event }) => event.result, status: 'listed' }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'declined' }) },
        TOOL_ERROR: { target: 'done', actions: assign({ status: 'error' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status, tables: context.tables }),
});
`;

let dir: string;
let client: Client;
/** Default policy: unannotated server, so everything asks (S5). */
let facade: ProjectionFacade;
/** Developer overrides: vouch for list_tables, ban raw SQL outright. */
let overridden: ProjectionFacade;

async function countUsers(): Promise<number> {
  const result = (await client.callTool({
    name: 'query',
    arguments: { sql: 'SELECT count(*) AS n FROM users' },
  })) as { content?: { type: string; text?: string }[] };
  const text = result.content?.[0]?.text ?? '[]';
  return (JSON.parse(text) as { n: number }[])[0]?.n ?? -1;
}

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'proj-smoke-sqlite-')));
  const serverEntry = join(
    dirname(require.resolve('mcp-sqlite/package.json')),
    'mcp-sqlite-server.js',
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry, join(dir, 'demo.db')],
    // inherit: native-binding startup failures (sqlite3 prebuilt/ABI) print to
    // stderr; the one-line startup banner is acceptable log noise.
    stderr: 'inherit',
  });
  client = new Client({ name: 'proj-smoke', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);

  // Seed outside the gate: this is fixture setup, not the system under test.
  await client.callTool({
    name: 'query',
    arguments: { sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)' },
  });
  await client.callTool({
    name: 'create_record',
    arguments: { table: 'users', data: { name: 'ada' } },
  });
  await client.callTool({
    name: 'create_record',
    arguments: { table: 'users', data: { name: 'grace' } },
  });

  facade = await wrapMcpServer(client, { blob: { key: randomBytes(32) } });
  overridden = await wrapMcpServer(client, {
    blob: { key: randomBytes(32) },
    policy: { list_tables: 'auto', query: 'deny' },
  });
}, 30_000);

afterAll(async () => {
  await facade?.close();
  await overridden?.close();
  await client?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('mcp-sqlite through Projection (PRD §13 matrix #3: opaque SQL, unannotated)', () => {
  it('introspects a fully unannotated catalog and generates types', () => {
    const names = facade.catalog.tools.map((t) => t.name);
    expect(names).toContain('query');
    expect(names).toContain('read_records');
    expect(names).toHaveLength(8);
    expect(facade.catalog.identity).toBe('mcp-sqlite-server@1.0.0');
    // The adversarial premise: not one tool carries annotations.
    expect(facade.catalog.tools.every((t) => t.annotations === undefined)).toBe(true);
    expect(facade.dts).toContain('query');
    expect(facade.dts).toContain('read_records');
  });

  it('S5 default posture: even a semantically read-only tool asks', async () => {
    const prompts: string[] = [];
    const result = await runScenario(
      facade,
      { calls: [] },
      {
        name: 'sqlite-read-asks',
        code: READ_RECORDS,
        verdicts: (prompt) => {
          prompts.push(prompt.message);
          return { action: 'accept' };
        },
      },
    );

    expect(result.status).toBe('completed');
    expect(result.rounds).toBe(1); // unannotated -> ask, despite being a read
    const output = result.output as { status: string; rows: unknown };
    expect(output.status).toBe('read');
    // The server returns rows as JSON text; a machine receives it parsed (D29).
    expect(output.rows).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'ada' })]));

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('read_records');
    // Unannotated is not destructive-flagged; the strong warning is reserved.
    expect(prompts[0]).not.toContain('DESTRUCTIVE');
    expect(result.maxBlobBytes).toBeLessThan(8 * 1024);
  });

  it('a declined DELETE through opaque SQL leaves the data untouched (S2/R16)', async () => {
    const prompts: string[] = [];
    expect(await countUsers()).toBe(2);

    const result = await runScenario(
      facade,
      { calls: [] },
      {
        name: 'sqlite-delete-declined',
        code: RAW_QUERY,
        input: { sql: 'DELETE FROM users' },
        verdicts: (prompt) => {
          prompts.push(prompt.message);
          return declineAll('that deletes everything')(prompt);
        },
      },
    );

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ status: 'declined', reason: 'that deletes everything' });
    // R16: the approver saw the EXACT SQL, rendered inert inside the args block.
    expect(prompts[0]).toContain('DELETE FROM users');
    // The data never changed.
    expect(await countUsers()).toBe(2);
  });

  it('an approved SELECT through query still required the round trip', async () => {
    const result = await runScenario(
      facade,
      { calls: [] },
      {
        name: 'sqlite-select-approved',
        code: RAW_QUERY,
        input: { sql: 'SELECT name FROM users ORDER BY name' },
      },
    );
    expect(result.status).toBe('completed');
    expect(result.rounds).toBe(1); // annotations cannot vouch for SQL, so it asks
    expect(result.output).toEqual({ status: 'ran', reason: null });
  });

  it('developer overrides beat the default: auto un-gates, deny blocks without a prompt (R14)', async () => {
    // list_tables overridden to auto: completes inline, zero round trips.
    const listed = await runScenario(
      overridden,
      { calls: [] },
      { name: 'sqlite-list-auto', code: LIST_TABLES },
    );
    expect(listed.status).toBe('completed');
    expect(listed.rounds).toBe(0);
    const listOutput = listed.output as { status: string; tables: unknown };
    expect(listOutput.status).toBe('listed');
    expect(listOutput.tables).toEqual([{ name: 'users' }]);

    // query overridden to deny: no prompt, canonical policy reason, no change.
    const denied = await runScenario(
      overridden,
      { calls: [] },
      {
        name: 'sqlite-query-denied',
        code: RAW_QUERY,
        input: { sql: 'DELETE FROM users' },
        verdicts: () => {
          throw new Error('deny must not prompt');
        },
      },
    );
    expect(denied.status).toBe('completed');
    expect(denied.rounds).toBe(0);
    const deniedOutput = denied.output as { status: string; reason: string };
    expect(deniedOutput.status).toBe('declined');
    expect(deniedOutput.reason).toContain('denied by server policy');
    expect(await countUsers()).toBe(2);
  });
});
