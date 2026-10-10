/**
 * An offline fake of the remote GitHub MCP server
 * (`https://api.githubcopilot.com/mcp/` with `X-MCP-Toolsets: all`).
 *
 * The real 95-tool catalog — names, descriptions, input JSON Schemas and
 * annotations — plus the server's own `instructions` were dumped once into
 * `test/fixtures/github-catalog.json` and are served here by an in-process
 * `McpServer` that records every call and answers from a small canned
 * table. The tool-choice eval needs the decision surface a model actually
 * faces (95 real schemas, the real guidance), not real GitHub, so nothing
 * here does I/O.
 *
 * Output schemas are kept in the fixture for reference but not registered:
 * the SDK validates `structuredContent` against a declared output schema,
 * and the canned answers make no attempt to satisfy GitHub's.
 */

import { fromJsonSchema, McpServer, type JsonSchemaType } from '@modelcontextprotocol/server';
import fixture from '../../test/fixtures/github-catalog.json' with { type: 'json' };
import type { SideEffect } from '../types.js';

export interface GithubCatalogTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface GithubCatalogFixture {
  server: { name: string; title?: string; version: string };
  /** The server's `instructions`, as a real host would inject them. */
  instructions: string;
  tools: GithubCatalogTool[];
}

/** The dumped catalog: 95 tools sorted by name, plus the server's instructions. */
export const GITHUB_CATALOG: Readonly<GithubCatalogFixture> = fixture as GithubCatalogFixture;

/**
 * Canned answers keyed by tool name. Anything not listed answers
 * `{ ok: true }`. The values are what the multi-step tasks in `tasks.ts`
 * rely on: the crash issue is #42, the "Fix typo" PR is #7, the user is
 * `vibdev`.
 */
export const GITHUB_FAKE_ANSWERS: Readonly<Record<string, unknown>> = {
  get_me: { login: 'vibdev' },
  search_issues: {
    total_count: 1,
    items: [{ number: 42, title: 'Crash on startup', state: 'open' }],
  },
  list_issues: [{ number: 42, title: 'Crash on startup', state: 'open' }],
  issue_read: { number: 42, title: 'Crash on startup', state: 'open', body: 'Crashes on boot.' },
  list_pull_requests: [
    { number: 7, title: 'Fix typo', state: 'open' },
    { number: 9, title: 'Add feature', state: 'open' },
  ],
  search_pull_requests: {
    total_count: 2,
    items: [
      { number: 7, title: 'Fix typo', state: 'open' },
      { number: 9, title: 'Add feature', state: 'open' },
    ],
  },
  pull_request_read: { number: 7, title: 'Fix typo', state: 'open', mergeable: true },
  list_notifications: [
    { id: '1', unread: true, reason: 'mention', subject: { title: 'Crash on startup' } },
  ],
};

export interface GithubFake {
  /** The fake, not yet connected: hand it to `wrapMcpServer` or a transport. */
  server: McpServer;
  /** Every tool call the fake executed, in order. */
  readonly calls: SideEffect[];
  /** The catalog it serves. */
  readonly tools: readonly GithubCatalogTool[];
  /** The instructions it advertises (undefined when disabled). */
  readonly instructions: string | undefined;
}

export interface GithubFakeOptions {
  /** Catalog to serve. Default: the full 95-tool dump. */
  tools?: readonly GithubCatalogTool[];
  /** Extra or overriding canned answers, merged over {@link GITHUB_FAKE_ANSWERS}. */
  answers?: Record<string, unknown>;
  /**
   * Server instructions to advertise. Default: the real server's. Pass
   * `false` to advertise none.
   */
  instructions?: string | false;
}

/**
 * Build the fake. Each tool is registered with its real JSON Schema (via the
 * SDK's `fromJsonSchema`, so `tools/list` serves the schema verbatim and
 * schema-invalid arguments are rejected before the handler runs, as the real
 * server would) and its real annotations (so Projection's posture policy —
 * read-only runs, everything else asks — sees what it would see live).
 */
export function createGithubFake(options: GithubFakeOptions = {}): GithubFake {
  const tools = options.tools ?? GITHUB_CATALOG.tools;
  const answers: Record<string, unknown> = { ...GITHUB_FAKE_ANSWERS, ...options.answers };
  const instructions =
    options.instructions === false
      ? undefined
      : (options.instructions ?? GITHUB_CATALOG.instructions);
  const calls: SideEffect[] = [];
  const server = new McpServer(
    { name: GITHUB_CATALOG.server.name, version: `${GITHUB_CATALOG.server.version}-fake` },
    ...(instructions !== undefined ? [{ instructions }] : []),
  );

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema as JsonSchemaType),
        ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
      },
      (args) => {
        calls.push({ tool: tool.name, args: args ?? {} });
        const answer = Object.hasOwn(answers, tool.name) ? answers[tool.name] : { ok: true };
        return { content: [{ type: 'text' as const, text: JSON.stringify(answer) }] };
      },
    );
  }

  return { server, calls, tools, instructions };
}
