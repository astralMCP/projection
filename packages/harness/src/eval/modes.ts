/**
 * The ways a model reaches the wrapped server(s) in the tool-choice eval.
 * Every mode runs against the same per-episode world (an offline fake, or a
 * real server behind a recording proxy — see world.ts), so the recorded
 * upstream calls are directly comparable:
 *
 * Every mode's system prompt starts with the world's one-line host framing
 * (`hostSystemPrompt`, neutral about how the tools are reached): a real host
 * has its own system prompt whatever it connects to, so only what follows
 * it differs between modes.
 *
 * - **direct**: the world's tools are the model's tools, verbatim
 *   (description + JSON Schema), executed over an in-memory MCP connection.
 *   The framing is followed by the server's own `instructions`, as a real
 *   host would inject them.
 * - **projection**: the world is wrapped with `wrapMcpServer` (both
 *   projections on) and served through `createMcpHandler`; the model's tools
 *   are whatever the facade lists (`search_tools`, `describe_tool`,
 *   `call_tool`, `discover_apis`, `execute_machine`), and the framing is
 *   followed by the facade's `instructions` (the server's own, then
 *   Projection's preamble — R29). A 2026-07-28 client with a scripted approve-all
 *   `elicitation/create` handler auto-fulfils every MRTR round trip inside
 *   one `callTool`, so the model sees only the final result. Approving
 *   everything is safe: the GitHub fake has no side effects and the real
 *   servers act on a throwaway sandbox.
 *
 * On the **multi** world (three boxes — see multi-world.ts) the modes are:
 *
 * - **direct**: the **flat list baseline** — every tool of every box inlined
 *   as a native tool named `<alias>__<name>` (Claude Code's
 *   `mcp__<server>__<tool>` naming), each routed to its box over its own
 *   in-memory connection. Real hosts may defer a large tool set behind
 *   their own tool search instead of inlining it; this baseline does not.
 *   The system prompt is the multi framing, then every box's
 *   `instructions` under a heading naming its alias. Names stay
 *   within the Messages API's tool-name rule (`^[a-zA-Z0-9_-]{1,64}$`):
 *   any other character becomes `_` and a longer name would be truncated
 *   with a hash suffix ({@link hostToolName}); none of the current boxes'
 *   names needs either (the longest is 51 characters).
 * - **projection**: `wrapMcpServers({ github, fs, mongo })` with default
 *   options — both projections, the global `search_tools` on.
 * - **projection-boxes**: the same with `catalog: { globalSearch: false }`,
 *   so the only search tools are the per-box `search_<alias>` ones.
 *
 * Both Projection modes pass no box `description`s by default; the
 * `boxDescriptions` session option (PROJ_EVAL_BOX_DESCRIPTIONS=1) passes
 * {@link MULTI_BOX_DESCRIPTIONS} as the host's descriptions instead.
 *
 * `projection-boxes` exists only for the multi world (a single-server
 * facade has no boxes and no `catalog` option); the runner skips it for
 * every other tier ({@link modeApplies}).
 *
 * Tool results are the result's content blocks joined in order: text
 * verbatim, anything else as a one-line placeholder (`[image image/png,
 * N bytes]`), which is what a host like Claude Code shows the model.
 */

import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';
import { MRTR_PROTOCOL_REVISION, wrapMcpServer, wrapMcpServers } from '@astral-mcp/projection';
import type { AgentRuntime, AgentTool, AgentToolResult } from './agent.js';
import { MULTI_BOX_DESCRIPTIONS } from './multi-world.js';
import type { EvalWorld, MultiWorld, WorldName } from './world.js';

export type EvalMode = 'direct' | 'projection' | 'projection-boxes';
export const EVAL_MODES: readonly EvalMode[] = ['direct', 'projection', 'projection-boxes'];

/** Resolve a comma list of modes (PROJ_EVAL_MODES); unknown names throw. */
export function resolveModes(spec: string | undefined): EvalMode[] {
  if (spec === undefined || spec.trim() === '') return [...EVAL_MODES];
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((name) => {
      if (!(EVAL_MODES as readonly string[]).includes(name)) {
        throw new Error(`unknown mode "${name}"; known: ${EVAL_MODES.join(', ')}`);
      }
      return name as EvalMode;
    });
}

/**
 * Whether `mode` runs in `world`: `projection-boxes` (global search off)
 * only means something on a multi-server facade, so the runner plans it for
 * the multi world alone — single-server tiers run exactly the episodes they
 * always did.
 */
export function modeApplies(mode: EvalMode, world: WorldName): boolean {
  return mode !== 'projection-boxes' || world === 'multi';
}

/** Whether `mode` reaches the world through a Projection facade. */
export function isProjectionMode(mode: EvalMode): boolean {
  return mode !== 'direct';
}

/** The Messages API's rule for a tool name. */
export const HOST_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
export const HOST_TOOL_NAME_MAX = 64;

/**
 * The host-style name of box `alias`'s tool `name`: `<alias>__<name>`, with
 * any character the Messages API does not allow replaced by `_`, and — only
 * when that is longer than {@link HOST_TOOL_NAME_MAX} — truncated
 * deterministically to fit with `_` and the first 8 hex digits of the
 * SHA-256 of the untruncated name, so distinct long names stay distinct.
 */
export function hostToolName(alias: string, name: string): string {
  const raw = `${alias}__${name}`;
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (safe.length <= HOST_TOOL_NAME_MAX) return safe;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 8);
  return `${safe.slice(0, HOST_TOOL_NAME_MAX - 9)}_${hash}`;
}

/** Options for opening a mode's session. */
export interface SessionOptions {
  /**
   * Multi world, Projection modes: pass {@link MULTI_BOX_DESCRIPTIONS} to
   * `wrapMcpServers` as the host's box descriptions. Default false.
   */
  boxDescriptions?: boolean;
  /**
   * Projection modes: a line appended to the session's system prompt, after
   * the facade's instructions (PROJ_EVAL_FORCE_CODE_MODE=1 sets it to
   * {@link FORCE_CODE_MODE_LINE}). The task prompt is unchanged.
   */
  systemSuffix?: string;
}

/** The system-prompt line PROJ_EVAL_FORCE_CODE_MODE=1 appends (Projection modes only). */
export const FORCE_CODE_MODE_LINE = 'Use code mode (discover_apis, execute_machine) for this task.';

/** The heading direct mode puts above the boxes' instructions, as Claude Code does. */
export const MULTI_INSTRUCTIONS_HEADER =
  '# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:';

/**
 * Direct mode's system prompt on the multi world: the framing, then every
 * box that advertises instructions, under a heading naming its alias.
 */
export function multiDirectSystemPrompt(world: MultiWorld): string {
  const sections = world.boxes.flatMap((box) =>
    box.world.instructions !== undefined ? [`## ${box.alias}\n\n${box.world.instructions}`] : [],
  );
  return sections.length === 0
    ? world.hostSystemPrompt
    : [world.hostSystemPrompt, MULTI_INSTRUCTIONS_HEADER, ...sections].join('\n\n');
}

/**
 * The facade's discovery tools: reading about tools, never calling one. A
 * multi-server facade adds its per-box `search_<alias>` tools to these.
 */
export const PROJECTION_DISCOVERY_TOOLS: ReadonlySet<string> = new Set([
  'search_tools',
  'describe_tool',
  'discover_apis',
]);

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
  /**
   * MRTR retries sent (projection only): one per approval round trip, however
   * many approvals it carried. Absent for direct.
   */
  readonly roundTrips?: number;
  /**
   * Tools whose turns are free under the eval's turn budget: Projection's
   * discovery surface, which direct mode has inline. Empty for direct.
   */
  readonly budgetFreeTools: ReadonlySet<string>;
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
  if (world.name === 'multi') return openMultiDirectSession(world);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  await world.server.connect(serverTransport);
  await client.connect(clientTransport);

  const system =
    world.instructions !== undefined
      ? `${world.hostSystemPrompt}\n\n${world.instructions}`
      : world.hostSystemPrompt;
  const tools: AgentTool[] = world.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));

  return {
    mode: 'direct',
    world,
    approvals: 0,
    budgetFreeTools: new Set(),
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

/** What a projection session needs from a facade, single- or multi-server. */
interface FacadeLike {
  serverFactory: Parameters<typeof createMcpHandler>[0];
  instructions: string;
  close(): Promise<void>;
}

/**
 * Serve `facade` over the 2026-07-28 wire to an approve-all client and
 * return the session. Takes ownership of the facade: it is closed with the
 * session, or here if the client cannot connect.
 */
async function connectFacade(
  mode: EvalMode,
  world: EvalWorld,
  facade: FacadeLike,
  budgetFree: (tools: AgentTool[]) => ReadonlySet<string>,
  systemSuffix?: string,
): Promise<ModeSession> {
  const handler = createMcpHandler(facade.serverFactory);
  const state = { approvals: 0, roundTrips: 0 };

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
        fetch: (url, init) => {
          // A retry carries the answers to the previous round's input requests.
          if (typeof init?.body === 'string' && init.body.includes('"inputResponses"')) {
            state.roundTrips += 1;
          }
          return handler.fetch(new Request(url, init));
        },
      }),
    );
    const listed = await client.listTools();
    tools = listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));
    // The host's framing first, as in direct mode; then what the facade says.
    system = `${world.hostSystemPrompt}\n\n${client.getInstructions() ?? facade.instructions}`;
    if (systemSuffix !== undefined) system = `${system}\n\n${systemSuffix}`;
  } catch (err) {
    // Nobody else holds the facade: release it (and the half-open client)
    // rather than leak a wrapped server per failed episode.
    await client.close().catch(() => {});
    await facade.close().catch(() => {});
    throw err;
  }

  return {
    mode,
    world,
    get approvals() {
      return state.approvals;
    },
    get roundTrips() {
      return state.roundTrips;
    },
    budgetFreeTools: budgetFree(tools),
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

/** Projection: the facade's tools over the 2026-07-28 wire, approve-all. */
export async function openProjectionSession(
  world: EvalWorld,
  options: SessionOptions = {},
): Promise<ModeSession> {
  if (world.name === 'multi') return openMultiProjectionSession(world, 'projection', options);
  const facade = await wrapMcpServer(world.server, { blob: { key: randomBytes(32) } });
  return connectFacade(
    'projection',
    world,
    facade,
    () => PROJECTION_DISCOVERY_TOOLS,
    options.systemSuffix,
  );
}

/**
 * The multi world behind `wrapMcpServers`, one box per alias, default
 * options except `catalog.globalSearch: false` for `projection-boxes` (and
 * the host's box descriptions when `options.boxDescriptions`). Discovery
 * turns are free as on a single-server facade, `search_<alias>` included.
 */
export async function openMultiProjectionSession(
  world: MultiWorld,
  mode: Exclude<EvalMode, 'direct'>,
  options: SessionOptions = {},
): Promise<ModeSession> {
  const sources: Record<string, McpServer | { source: McpServer; description: string }> =
    Object.fromEntries(
      world.boxes.map((box) => [
        box.alias,
        options.boxDescriptions === true
          ? { source: box.world.server, description: MULTI_BOX_DESCRIPTIONS[box.alias] }
          : box.world.server,
      ]),
    );
  const facade = await wrapMcpServers(sources, {
    blob: { key: randomBytes(32) },
    ...(mode === 'projection-boxes' ? { catalog: { globalSearch: false } } : {}),
  });
  return connectFacade(
    mode,
    world,
    facade,
    (tools) =>
      new Set([
        ...PROJECTION_DISCOVERY_TOOLS,
        ...tools.filter((tool) => tool.name.startsWith('search_')).map((tool) => tool.name),
      ]),
    options.systemSuffix,
  );
}

/**
 * Direct on the multi world: one in-memory connection per box, every tool
 * offered under its {@link hostToolName} and routed back to its box.
 */
export async function openMultiDirectSession(world: MultiWorld): Promise<ModeSession> {
  const clients: Client[] = [];
  const closeAll = async (): Promise<void> => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
  };
  const routes = new Map<string, { client: Client; name: string }>();
  const tools: AgentTool[] = [];
  try {
    for (const box of world.boxes) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client(CLIENT_INFO, { capabilities: {} });
      clients.push(client);
      await box.world.server.connect(serverTransport);
      await client.connect(clientTransport);
      for (const tool of box.world.tools) {
        const name = hostToolName(box.alias, tool.name);
        if (routes.has(name)) {
          throw new Error(`direct mode: two tools map to the host name "${name}"`);
        }
        routes.set(name, { client, name: tool.name });
        tools.push({ name, description: tool.description, inputSchema: tool.inputSchema });
      }
    }
  } catch (err) {
    await closeAll();
    throw err;
  }

  return {
    mode: 'direct',
    world,
    approvals: 0,
    budgetFreeTools: new Set(),
    runtime: {
      system: multiDirectSystemPrompt(world),
      tools,
      call: async (name, input) => {
        const route = routes.get(name);
        if (route === undefined) return { text: `Tool ${name} not found`, isError: true };
        return toolResultText(await route.client.callTool({ name: route.name, arguments: input }));
      },
    },
    close: closeAll,
  };
}

export function openSession(
  mode: EvalMode,
  world: EvalWorld,
  options: SessionOptions = {},
): Promise<ModeSession> {
  switch (mode) {
    case 'direct':
      return openDirectSession(world);
    case 'projection':
      return openProjectionSession(world, options);
    case 'projection-boxes':
      if (world.name !== 'multi') {
        return Promise.reject(
          new Error(`mode projection-boxes needs the multi world, not ${world.name}`),
        );
      }
      return openMultiProjectionSession(world, mode, options);
  }
}
