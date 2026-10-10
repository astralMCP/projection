/**
 * The two ways a model reaches the wrapped GitHub server in the tool-choice
 * eval. Both run against the same offline fake, so the recorded upstream
 * calls are directly comparable:
 *
 * - **direct**: the fake's 95 tools are the model's tools, verbatim
 *   (description + JSON Schema), executed over an in-memory MCP connection.
 *   The system prompt is a one-line host framing followed by the server's
 *   own `instructions`, as a real host would inject them.
 * - **projection**: the fake is wrapped with `wrapMcpServer` (both
 *   projections on) and served through `createMcpHandler`; the model's tools
 *   are whatever the facade lists (`search_tools`, `describe_tool`,
 *   `call_tool`, `discover_apis`, `execute_machine`), and the system prompt
 *   is the facade's `instructions` (the server's own, then Projection's
 *   preamble — R29). A 2026-07-28 client with a scripted approve-all
 *   `elicitation/create` handler auto-fulfils every MRTR round trip inside
 *   one `callTool`, so the model sees only the final result — the fake has no
 *   side effects, so approving everything is safe.
 *
 * Tool results are the result's text blocks joined, which is what a host
 * like Claude Code shows the model.
 */

import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, InMemoryTransport } from '@modelcontextprotocol/server';
import { MRTR_PROTOCOL_REVISION, wrapMcpServer } from '@astral-mcp/projection';
import type { AgentRuntime, AgentTool, AgentToolResult } from './agent.js';
import { createGithubFake, type GithubFake, type GithubFakeOptions } from './github-fake.js';

export type EvalMode = 'direct' | 'projection';
export const EVAL_MODES: readonly EvalMode[] = ['direct', 'projection'];

/** Resolve a comma list of modes (PROJ_EVAL_MODES); unknown names throw. */
export function resolveModes(spec: string | undefined): EvalMode[] {
  if (spec === undefined || spec.trim() === '') return [...EVAL_MODES];
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((name) => {
      if (name !== 'direct' && name !== 'projection') {
        throw new Error(`unknown mode "${name}"; known: ${EVAL_MODES.join(', ')}`);
      }
      return name;
    });
}

export const DIRECT_SYSTEM_PROMPT =
  "You operate GitHub through the tools provided. Complete the user's task, then stop.";

const PROJECTION_ENDPOINT = new URL('http://tool-choice-eval.projection.test/mcp');
const CLIENT_INFO = { name: 'tool-choice-eval', version: '0.0.0' };

/** One episode's connection to the fake, in one mode. */
export interface ModeSession {
  mode: EvalMode;
  runtime: AgentRuntime;
  /** The fake behind this session; `fake.calls` is what the tasks score. */
  fake: GithubFake;
  /** Approval prompts answered (projection only; always 0 for direct). */
  readonly approvals: number;
  close(): Promise<void>;
}

interface ToolCallResultView {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean | undefined;
}

function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'text' &&
    typeof (block as { text?: unknown }).text === 'string'
  );
}

/** The text a host shows the model for a tools/call result. */
export function toolResultText(result: ToolCallResultView): AgentToolResult {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const texts = blocks.flatMap((block) => (isTextBlock(block) ? [block.text] : []));
  const text =
    texts.length > 0
      ? texts.join('\n')
      : result.structuredContent !== undefined
        ? JSON.stringify(result.structuredContent)
        : '';
  return { text, ...(result.isError === true ? { isError: true } : {}) };
}

/** Direct: the fake's tools verbatim over an in-memory MCP connection. */
export async function openDirectSession(options: GithubFakeOptions = {}): Promise<ModeSession> {
  const fake = createGithubFake(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  await fake.server.connect(serverTransport);
  await client.connect(clientTransport);

  const system =
    fake.instructions !== undefined
      ? `${DIRECT_SYSTEM_PROMPT}\n\n${fake.instructions}`
      : DIRECT_SYSTEM_PROMPT;
  const tools: AgentTool[] = fake.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));

  return {
    mode: 'direct',
    fake,
    approvals: 0,
    runtime: {
      system,
      tools,
      call: async (name, input) =>
        toolResultText(await client.callTool({ name, arguments: input })),
    },
    close: async () => {
      await client.close();
    },
  };
}

/** Projection: the facade's tools over the 2026-07-28 wire, approve-all. */
export async function openProjectionSession(options: GithubFakeOptions = {}): Promise<ModeSession> {
  const fake = createGithubFake(options);
  const facade = await wrapMcpServer(fake.server, { blob: { key: randomBytes(32) } });
  const handler = createMcpHandler(facade.serverFactory);
  const state = { approvals: 0 };

  const client = new Client(CLIENT_INFO, {
    capabilities: { elicitation: {} },
    versionNegotiation: { mode: { pin: MRTR_PROTOCOL_REVISION } },
  });
  client.setRequestHandler('elicitation/create', () => {
    state.approvals += 1;
    return { action: 'accept' as const, content: {} };
  });
  await client.connect(
    new StreamableHTTPClientTransport(PROJECTION_ENDPOINT, {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );

  const listed = await client.listTools();
  const tools: AgentTool[] = listed.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema as Record<string, unknown>,
  }));
  const system = client.getInstructions() ?? facade.instructions;

  return {
    mode: 'projection',
    fake,
    get approvals() {
      return state.approvals;
    },
    runtime: {
      system,
      tools,
      call: async (name, input) =>
        toolResultText(await client.callTool({ name, arguments: input })),
    },
    close: async () => {
      await client.close();
      await facade.close();
    },
  };
}

export function openSession(mode: EvalMode, options: GithubFakeOptions = {}): Promise<ModeSession> {
  return mode === 'direct' ? openDirectSession(options) : openProjectionSession(options);
}
