/**
 * The two ways a model reaches the wrapped server in the tool-choice eval.
 * Both run against the same per-episode world (an offline fake, or a real
 * server behind a recording proxy — see world.ts), so the recorded upstream
 * calls are directly comparable:
 *
 * - **direct**: the world's tools are the model's tools, verbatim
 *   (description + JSON Schema), executed over an in-memory MCP connection.
 *   The system prompt is the world's one-line host framing followed by the
 *   server's own `instructions`, as a real host would inject them.
 * - **projection**: the world is wrapped with `wrapMcpServer` (both
 *   projections on) and served through `createMcpHandler`; the model's tools
 *   are whatever the facade lists (`search_tools`, `describe_tool`,
 *   `call_tool`, `discover_apis`, `execute_machine`), and the system prompt
 *   is the facade's `instructions` (the server's own, then Projection's
 *   preamble — R29). A 2026-07-28 client with a scripted approve-all
 *   `elicitation/create` handler auto-fulfils every MRTR round trip inside
 *   one `callTool`, so the model sees only the final result. Approving
 *   everything is safe: the GitHub fake has no side effects and the real
 *   servers act on a throwaway sandbox.
 *
 * Tool results are the result's content blocks joined in order: text
 * verbatim, anything else as a one-line placeholder (`[image image/png,
 * N bytes]`), which is what a host like Claude Code shows the model.
 */

import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, InMemoryTransport } from '@modelcontextprotocol/server';
import { MRTR_PROTOCOL_REVISION, wrapMcpServer } from '@astral-mcp/projection';
import type { AgentRuntime, AgentTool, AgentToolResult } from './agent.js';
import type { EvalWorld } from './world.js';

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

const PROJECTION_ENDPOINT = new URL('http://tool-choice-eval.projection.test/mcp');
const CLIENT_INFO = { name: 'tool-choice-eval', version: '0.0.0' };

/** One episode's connection to its world, in one mode. */
export interface ModeSession {
  mode: EvalMode;
  runtime: AgentRuntime;
  /** The world behind this session; `world.calls` is what the tasks score. */
  world: EvalWorld;
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

/**
 * A non-text block as a host would summarise it to the model: an image's
 * type and size, not its bytes. Rendering a placeholder (rather than
 * dropping the block) keeps `read_media_file` distinguishable from an empty
 * result in the transcript.
 */
function placeholder(block: unknown): string {
  const view = (typeof block === 'object' && block !== null ? block : {}) as {
    type?: unknown;
    data?: unknown;
    mimeType?: unknown;
    resource?: { uri?: unknown; mimeType?: unknown };
  };
  const type = typeof view.type === 'string' ? view.type : 'unknown';
  const size = typeof view.data === 'string' ? `, ${view.data.length} bytes` : '';
  const mime = typeof view.mimeType === 'string' ? ` ${view.mimeType}` : '';
  switch (type) {
    case 'image':
    case 'audio':
      return `[${type}${mime}${size}]`;
    case 'resource': {
      const uri = typeof view.resource?.uri === 'string' ? ` ${view.resource.uri}` : '';
      const resourceMime =
        typeof view.resource?.mimeType === 'string' ? ` ${view.resource.mimeType}` : '';
      return `[resource${uri}${resourceMime}]`;
    }
    default:
      return `[${type} block]`;
  }
}

/** The text a host shows the model for a tools/call result. */
export function toolResultText(result: ToolCallResultView): AgentToolResult {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const lines = blocks.map((block) => (isTextBlock(block) ? block.text : placeholder(block)));
  const text =
    lines.length > 0
      ? lines.join('\n')
      : result.structuredContent !== undefined
        ? JSON.stringify(result.structuredContent)
        : '';
  return { text, ...(result.isError === true ? { isError: true } : {}) };
}

/** Direct: the world's tools verbatim over an in-memory MCP connection. */
export async function openDirectSession(world: EvalWorld): Promise<ModeSession> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  await world.server.connect(serverTransport);
  await client.connect(clientTransport);

  const system =
    world.instructions !== undefined
      ? `${world.directSystemPrompt}\n\n${world.instructions}`
      : world.directSystemPrompt;
  const tools: AgentTool[] = world.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));

  return {
    mode: 'direct',
    world,
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
export async function openProjectionSession(world: EvalWorld): Promise<ModeSession> {
  const facade = await wrapMcpServer(world.server, { blob: { key: randomBytes(32) } });
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
  let tools: AgentTool[];
  let system: string;
  try {
    await client.connect(
      new StreamableHTTPClientTransport(PROJECTION_ENDPOINT, {
        fetch: (url, init) => handler.fetch(new Request(url, init)),
      }),
    );
    const listed = await client.listTools();
    tools = listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));
    system = client.getInstructions() ?? facade.instructions;
  } catch (err) {
    // Nobody else holds the facade: release it (and the half-open client)
    // rather than leak a wrapped server per failed episode.
    await client.close().catch(() => {});
    await facade.close().catch(() => {});
    throw err;
  }

  return {
    mode: 'projection',
    world,
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

export function openSession(mode: EvalMode, world: EvalWorld): Promise<ModeSession> {
  return mode === 'direct' ? openDirectSession(world) : openProjectionSession(world);
}
