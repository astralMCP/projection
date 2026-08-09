/**
 * Live smoke test against a REAL Glama-directory server (PRD §13 matrix
 * #2): the GitHub MCP reference server
 * (@modelcontextprotocol/server-github, pinned), spawned over stdio with a
 * real token, talking to the real GitHub API.
 *
 * This is the typegen/catalog-stress case: 26 tools with rich, deeply
 * nested JSON Schemas we did not author. The server ships no annotations,
 * so every tool — including searches — is approval-gated (S5), and the
 * suspension blob must stay inside the §10 budget despite the large
 * catalog (the blob carries the pending call, never the catalog).
 *
 * Explicit opt-in only: MCC_LIVE_GITHUB=1 AND a non-empty GITHUB_TOKEN (or
 * GITHUB_PERSONAL_ACCESS_TOKEN), which may live in the repo-root .env.
 * A plain `pnpm test` never talks to GitHub. Run it with:
 *
 *   MCC_LIVE_GITHUB=1 pnpm --filter @mccircuit/harness exec vitest run test/smoke/github.live.test.ts
 *
 * The suite performs READ calls only (one search, one file fetch); every
 * write tool is exercised strictly through the approval gate and DECLINED,
 * so nothing on GitHub is ever created or modified.
 */

import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { wrapMcpServer, type McCircuitFacade } from 'mccircuit';
import { loadNearestDotEnv, runScenario, declineAll } from '../../src/index.js';

const require = createRequire(import.meta.url);

// Secrets may live in the repo-root .env rather than the shell.
loadNearestDotEnv();
const token =
  (process.env['GITHUB_TOKEN'] ?? '') !== ''
    ? (process.env['GITHUB_TOKEN'] as string)
    : (process.env['GITHUB_PERSONAL_ACCESS_TOKEN'] ?? '');
const optedIn = process.env['MCC_LIVE_GITHUB'] === '1';

/** Search repositories — a read, but unannotated, so it still asks. */
const SEARCH_REPOS = `
import { setup, assign } from 'xstate';
import { toolCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'searchRepos',
  context: ({ input }) => ({ query: input.query, found: null, status: 'pending' }),
  initial: 'searching',
  states: {
    searching: {
      entry: toolCall('search_repositories', ({ context }) => ({ query: context.query })),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ found: ({ event }) => event.result, status: 'searched' }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'declined' }) },
        TOOL_ERROR: { target: 'done', actions: assign({ status: 'error' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status, found: context.found }),
});
`;

/** Create an issue — a write; the test ALWAYS declines it. */
const CREATE_ISSUE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@mccircuit/tools';

export default setup({}).createMachine({
  id: 'createIssue',
  context: { status: 'pending', reason: null },
  initial: 'creating',
  states: {
    creating: {
      entry: toolCall('create_issue', () => ({
        owner: 'modelcontextprotocol',
        repo: 'servers',
        title: 'McCircuit smoke test - must never be created',
      })),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: 'created' }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'declined', reason: ({ event }) => event.reason ?? null }) },
        TOOL_ERROR: { target: 'done', actions: assign({ status: 'error' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status, reason: context.reason }),
});
`;

let client: Client;
let facade: McCircuitFacade;

describe.skipIf(!optedIn || token === '')('github-mcp-server live (PRD §13 matrix #2)', () => {
  beforeAll(async () => {
    const serverEntry = join(
      dirname(require.resolve('@modelcontextprotocol/server-github/package.json')),
      'dist/index.js',
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      // Minimal child environment: the token and nothing else of ours.
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: token },
      // Native-binding-free, but keep startup diagnostics visible anyway.
      stderr: 'inherit',
    });
    client = new Client({ name: 'mcc-smoke', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
    facade = await wrapMcpServer(client, { blob: { key: randomBytes(32) } });
  }, 30_000);

  afterAll(async () => {
    await facade?.close();
    await client?.close();
  });

  it('introspects the 26-tool catalog and typegen survives the schema stress', () => {
    const names = facade.catalog.tools.map((t) => t.name);
    expect(names).toHaveLength(26);
    expect(names).toContain('search_repositories');
    expect(names).toContain('create_pull_request');
    expect(names).toContain('push_files');
    expect(facade.catalog.identity).toBe('github-mcp-server@0.6.2');
    // Unannotated across the board: the default-ask posture governs (S5).
    expect(facade.catalog.tools.every((t) => t.annotations === undefined)).toBe(true);

    // Typegen produced a substantial surface from schemas we never authored
    // (nested objects, arrays of objects, enums) without falling back to a
    // single `unknown` blob per tool.
    expect(facade.dts).toContain('search_repositories');
    expect(facade.dts).toContain('create_pull_request');
    expect(facade.dts.length).toBeGreaterThan(10_000);
    expect(facade.dts).not.toContain('any;');
  });

  it(
    'gated live read: search_repositories asks, approval returns real results',
    { timeout: 60_000 },
    async () => {
      const prompts: string[] = [];
      const result = await runScenario(
        facade,
        { calls: [] },
        {
          name: 'github-search',
          code: SEARCH_REPOS,
          input: { query: 'repo:modelcontextprotocol/servers' },
          verdicts: (prompt) => {
            prompts.push(prompt.message);
            return { action: 'accept' };
          },
        },
      );

      expect(result.status).toBe('completed');
      expect(result.rounds).toBe(1); // unannotated read still asks (S5)
      const output = result.output as { status: string; found: unknown };
      expect(output.status).toBe('searched');
      expect(JSON.stringify(output.found)).toContain('modelcontextprotocol');

      expect(prompts[0]).toContain('search_repositories');
      // §10: the blob carries the pending call, not the 26-tool catalog.
      expect(result.maxBlobBytes).toBeLessThan(8 * 1024);
    },
  );

  it(
    'a declined write never reaches GitHub and the approver saw the args',
    { timeout: 60_000 },
    async () => {
      const prompts: string[] = [];
      const result = await runScenario(
        facade,
        { calls: [] },
        {
          name: 'github-issue-declined',
          code: CREATE_ISSUE,
          verdicts: (prompt) => {
            prompts.push(prompt.message);
            return declineAll('smoke test: never create real issues')(prompt);
          },
        },
      );

      expect(result.status).toBe('completed');
      expect(result.output).toEqual({
        status: 'declined',
        reason: 'smoke test: never create real issues',
      });
      // R16: the exact would-be issue was visible, inert, to the approver.
      expect(prompts[0]).toContain('create_issue');
      expect(prompts[0]).toContain('must never be created');
    },
  );
});
