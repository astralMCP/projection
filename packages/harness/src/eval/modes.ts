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
 *   Projection's preamble — R29). A 2026-07-28 client whose
 *   `elicitation/create` handler is an approver persona (hitl.ts; approve-all
 *   unless the task or PROJ_EVAL_APPROVER says otherwise) auto-fulfils
 *   every MRTR round trip inside one `callTool`, so the model sees only the
 *   final result; every prompt and answer is recorded on the session.
 *   Approving everything is safe: the GitHub fake has no side effects and
 *   the real servers act on a throwaway sandbox.
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
 * The opt-in **native** baselines are direct mode with the same tools, the
 * same system prompt and the same host gate, offered through Anthropic's own
 * server tools instead of inline ({@link nativeToolsOf}; agent.ts
 * `NativeTools`):
 *
 * - **native-search**: every tool `defer_loading: true` behind the tool
 *   search tool (BM25 by default, regex with PROJ_EVAL_TOOL_SEARCH=regex).
 * - **native-ptc**: the code execution tool, every tool callable from code
 *   (`allowed_callers`); programmatic calls reach the host as ordinary
 *   `tool_use` blocks and pass the same gate. Not on Haiku 4.5
 *   ({@link modeSupportsModel}).
 *
 * The opt-in **ablations** are `projection` minus one feature, through
 * public `WrapOptions` only ({@link projectionWrapOptions}):
 * `projection-search` (never list tools directly), `projection-nocode`
 * (catalog only), `projection-codeonly` (code mode only) and
 * `projection-nopreamble` (no routing preamble).
 *
 * Both Projection modes pass no box `description`s by default; the
 * `boxDescriptions` session option (PROJ_EVAL_BOX_DESCRIPTIONS=1) passes
 * each box's host description (MULTI_BOX_DESCRIPTIONS, WORKPLACE_BOX_DESCRIPTIONS) instead.
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
import {
  MRTR_PROTOCOL_REVISION,
  wrapMcpServer,
  wrapMcpServers,
  type ApprovalPrompts,
} from '@astral-mcp/projection';
import {
  PTC_MODELS,
  type AgentRuntime,
  type AgentTool,
  type AgentToolResult,
  type NativeTools,
  type PtcCallers,
  type ToolSearchVariant,
} from './agent.js';
import {
  createApprover,
  elicitationRecord,
  mediatedToolTarget,
  parseApprovalItems,
  toolNameIndex,
  type ApproverPersona,
  type ElicitationRecord,
  type TaskApprover,
} from './hitl.js';
import { isBoxedWorldName, type EvalWorld, type MultiWorld, type WorldName } from './world.js';

export type EvalMode =
  | 'direct'
  | 'native-search'
  | 'native-ptc'
  | 'projection'
  | 'projection-boxes'
  | 'projection-direct'
  | 'projection-auto'
  | 'projection-search'
  | 'projection-nocode'
  | 'projection-codeonly'
  | 'projection-nopreamble';
/** The modes a run plans by default (the opt-in exploration modes are not among them). */
export const EVAL_MODES: readonly EvalMode[] = ['direct', 'projection', 'projection-boxes'];
/**
 * Every mode PROJ_EVAL_MODES accepts: the defaults plus the opt-in
 * exploration modes. `projection-direct` wraps with `projections.direct:
 * true` (every wrapped tool also listed as a mediated `call_tool` alias);
 * `projection-auto` with `direct: 'auto'` (listed when the definitions fit
 * the default budget).
 */
export const KNOWN_EVAL_MODES: readonly EvalMode[] = [
  ...EVAL_MODES,
  'projection-direct',
  'projection-auto',
  'native-search',
  'native-ptc',
  'projection-search',
  'projection-nocode',
  'projection-codeonly',
  'projection-nopreamble',
];

/**
 * The `projections.direct` setting a Projection mode passes explicitly;
 * `false` here means "not passed" (the library default, `'auto'`), except
 * for `projection-search`, which {@link projectionWrapOptions} passes as an
 * explicit `false`.
 */
export function directSettingOf(mode: EvalMode): 'auto' | boolean {
  return mode === 'projection-direct' ? true : mode === 'projection-auto' ? 'auto' : false;
}

/**
 * The public `WrapOptions` a Projection mode sets on top of the defaults —
 * the ablations take one feature away each, through options only:
 *
 * - `projection-search`: `projections.direct: false` (never list the tools
 *   directly; always search).
 * - `projection-nocode`: `projections.codeMode: false` (catalog only, so
 *   no `execute_machine` / `discover_apis`).
 * - `projection-codeonly`: `projections.catalog: false` (code mode only;
 *   no search/describe/call, and so no direct listing).
 * - `projection-nopreamble`: `codeModePreamble: ''` (no routing preamble in
 *   the instructions; the server's own instructions and, on a multi-server
 *   facade, the box list stay).
 */
export function projectionWrapOptions(mode: EvalMode): {
  projections?: { direct?: 'auto' | boolean; codeMode?: boolean; catalog?: boolean };
  codeModePreamble?: string;
} {
  switch (mode) {
    case 'projection-direct':
      return { projections: { direct: true } };
    case 'projection-auto':
      return { projections: { direct: 'auto' } };
    case 'projection-search':
      return { projections: { direct: false } };
    case 'projection-nocode':
      return { projections: { codeMode: false } };
    case 'projection-codeonly':
      return { projections: { catalog: false } };
    case 'projection-nopreamble':
      return { codeModePreamble: '' };
    default:
      return {};
  }
}

/** The modes that offer the raw tools through Anthropic's server tools. */
export function isNativeMode(mode: EvalMode): mode is 'native-search' | 'native-ptc' {
  return mode === 'native-search' || mode === 'native-ptc';
}

/**
 * Whether `mode` can run on model `modelId`: programmatic tool calling
 * (`native-ptc`) is not available on Haiku 4.5 (or any model outside
 * {@link PTC_MODELS}); `anthropic` is false for a preset served by another
 * provider, which has none of the native server tools.
 */
export function modeSupportsModel(mode: EvalMode, modelId: string, anthropic = true): boolean {
  if (isNativeMode(mode) && !anthropic) return false;
  return mode !== 'native-ptc' || PTC_MODELS.has(modelId);
}

/** The server-tool configuration of a native mode. */
export function nativeToolsOf(
  mode: EvalMode,
  options: Pick<SessionOptions, 'toolSearch' | 'ptcCallers'> = {},
): NativeTools | undefined {
  if (mode === 'native-search')
    return { kind: 'tool-search', variant: options.toolSearch ?? 'bm25' };
  if (mode === 'native-ptc') return { kind: 'ptc', callers: options.ptcCallers ?? 'code' };
  return undefined;
}

/** Resolve a comma list of modes (PROJ_EVAL_MODES); unknown names throw. */
export function resolveModes(spec: string | undefined): EvalMode[] {
  if (spec === undefined || spec.trim() === '') return [...EVAL_MODES];
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((name) => {
      if (!(KNOWN_EVAL_MODES as readonly string[]).includes(name)) {
        throw new Error(`unknown mode "${name}"; known: ${KNOWN_EVAL_MODES.join(', ')}`);
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
  return mode !== 'projection-boxes' || isBoxedWorldName(world);
}

/** Whether `mode` reaches the world through a Projection facade. */
export function isProjectionMode(mode: EvalMode): boolean {
  return mode.startsWith('projection');
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
   * Boxed worlds, Projection modes: pass each box's `description` to
   * `wrapMcpServers` as the host's box descriptions. Default false.
   */
  boxDescriptions?: boolean;
  /**
   * Projection modes: a line appended to the session's system prompt, after
   * the facade's instructions (PROJ_EVAL_FORCE_CODE_MODE=1 sets it to
   * {@link FORCE_CODE_MODE_LINE}). The task prompt is unchanged.
   */
  systemSuffix?: string;
  /**
   * Who answers approval prompts (hitl.ts). Absent: approve-all, and direct
   * mode runs every call ungated as it always did. Present: Projection's
   * prompts go to this persona, and direct mode puts a simulated host
   * approval gate in front of every call that is not `readOnlyHint: true`
   * (the same rule as Projection's default policy), so both modes face the
   * same person.
   */
  approver?: TaskApprover;
  /**
   * Projection modes: `WrapOptions.approvalPrompts`
   * (PROJ_EVAL_APPROVAL_PROMPTS). Absent: the facade's default (per-call).
   */
  approvalPrompts?: ApprovalPrompts;
  /** `native-search`: the tool search variant (PROJ_EVAL_TOOL_SEARCH). Default `bm25`. */
  toolSearch?: ToolSearchVariant;
  /** `native-ptc`: each tool's `allowed_callers` (PROJ_EVAL_PTC_CALLERS). Default `code`. */
  ptcCallers?: PtcCallers;
  /**
   * Every mode: a host system prompt put before the session's own system
   * prompt (PROJ_EVAL_HOST_PROMPT=realistic; host-prompt.ts), as a host's
   * own prompt precedes whatever its servers contribute. It joins the same
   * system block, so the one system breakpoint caches it with the rest.
   */
  hostPrompt?: string;
}

/**
 * The simulated host gate's form: like a host's "tell the assistant what to
 * do instead" box, a refusal may carry a note.
 */
export const HOST_APPROVAL_SCHEMA = {
  type: 'object',
  properties: { reason: { type: 'string', description: 'Optional note for the assistant.' } },
} as const;

/** What direct mode's simulated host gate tells the model when a call is refused. */
export const HOST_DECLINED_TEXT = 'The user declined this tool call, so it was not run.';
export const HOST_CANCELLED_TEXT =
  'The user dismissed the approval prompt for this tool call, so it was not run.';

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
  /**
   * Approval prompts answered: Projection's elicitations, or direct mode's
   * simulated host gate (0 for direct without an approver).
   */
  readonly approvals: number;
  /** Every approval prompt and its answer, in order (hitl.ts). */
  readonly elicitations: readonly ElicitationRecord[];
  /** The persona that answered them. */
  readonly approver: ApproverPersona;
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

/** A gated call's rendering in direct mode's simulated host approval prompt. */
export function hostPromptText(
  hostName: string,
  box: string | undefined,
  destructive: boolean,
  args: Record<string, unknown>,
): string {
  return [
    `Allow tool call: ${hostName}${box !== undefined ? ` (server: ${box})` : ''}`,
    ...(destructive ? ['⚠ The server marks this tool as destructive.'] : []),
    '',
    'Arguments:',
    JSON.stringify(args, null, 2),
  ].join('\n');
}

/**
 * Direct mode's simulated host approval gate: with an approver, every call
 * to a tool that is not `readOnlyHint: true` is shown to it first; a
 * refused call is not run and the model gets the host's refusal text.
 * Without one, `run` is called straight through.
 */
function hostGate(
  world: EvalWorld,
  approverSpec: TaskApprover | undefined,
): {
  elicitations: ElicitationRecord[];
  approvals: () => number;
  gate(
    hostName: string,
    qualified: string,
    args: Record<string, unknown>,
    run: () => Promise<AgentToolResult>,
  ): Promise<AgentToolResult>;
} {
  const elicitations: ElicitationRecord[] = [];
  if (approverSpec === undefined) {
    return { elicitations, approvals: () => 0, gate: (_h, _q, _a, run) => run() };
  }
  const approver = createApprover(approverSpec);
  const index = toolNameIndex(world);
  let toolCalls = 0;
  return {
    elicitations,
    approvals: () => elicitations.length,
    async gate(hostName, qualified, args, run) {
      const at = toolCalls;
      toolCalls += 1;
      const tool = index.tools.get(qualified);
      if (tool?.annotations?.readOnlyHint === true) return run();
      const message = hostPromptText(
        hostName,
        tool?.box,
        tool?.annotations?.destructiveHint === true,
        args,
      );
      const items = parseApprovalItems(message, HOST_APPROVAL_SCHEMA, index);
      const decision = approver.decide(items, HOST_APPROVAL_SCHEMA);
      elicitations.push(
        elicitationRecord({
          seq: elicitations.length,
          source: 'host',
          toolCall: { index: at, name: hostName },
          call: { tool: qualified, args },
          key: 'host',
          mode: 'form',
          message,
          requestedSchema: HOST_APPROVAL_SCHEMA,
          items,
          decision,
          worldCallsAtAnswer: world.calls.length,
        }),
      );
      switch (decision.response.action) {
        case 'accept':
          return run();
        case 'decline': {
          const reason = decision.response.content?.['reason'];
          return {
            text:
              typeof reason === 'string'
                ? `${HOST_DECLINED_TEXT} Their note: ${JSON.stringify(reason)}`
                : HOST_DECLINED_TEXT,
          };
        }
        case 'cancel':
          return { text: HOST_CANCELLED_TEXT };
      }
    },
  };
}

/**
 * Direct: the world's tools verbatim over an in-memory MCP connection. With
 * a native `mode`, the same tools and the same host gate, offered through
 * that mode's server tool ({@link nativeToolsOf}): only how the model
 * reaches the definitions changes. A call made from code execution reaches
 * the host as an ordinary `tool_use`, so it passes the same gate; a refusal
 * is returned to the running code, which sees the host's refusal text as
 * the tool's result.
 */
export async function openDirectSession(
  world: EvalWorld,
  options: SessionOptions = {},
  mode: 'direct' | 'native-search' | 'native-ptc' = 'direct',
): Promise<ModeSession> {
  if ('boxes' in world) return openMultiDirectSession(world, options, mode);
  const native = nativeToolsOf(mode, options);
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

  const host = hostGate(world, options.approver);
  return {
    mode,
    world,
    get approvals() {
      return host.approvals();
    },
    elicitations: host.elicitations,
    approver: options.approver?.persona ?? 'approve-all',
    budgetFreeTools: new Set(),
    runtime: {
      system,
      tools,
      ...(native !== undefined ? { native } : {}),
      call: (name, input) =>
        host.gate(name, name, input, async () =>
          toolResultText(await client.callTool({ name, arguments: input })),
        ),
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
  options: SessionOptions = {},
): Promise<ModeSession> {
  const { systemSuffix } = options;
  const handler = createMcpHandler(facade.serverFactory);
  const state = { approvals: 0, roundTrips: 0, toolCalls: 0 };
  const approverSpec = options.approver ?? { persona: 'approve-all' as const };
  const approver = createApprover(approverSpec);
  const index = toolNameIndex(world);
  const elicitations: ElicitationRecord[] = [];
  /** The model's tool call in flight: prompts arrive inside it. */
  let inflight: { index: number; name: string; input: Record<string, unknown> } | undefined;

  const client = new Client(CLIENT_INFO, {
    capabilities: { elicitation: {} },
    versionNegotiation: { mode: { pin: MRTR_PROTOCOL_REVISION } },
  });
  client.setRequestHandler('elicitation/create', (request, ctx) => {
    state.approvals += 1;
    const params = (request.params ?? {}) as {
      message?: unknown;
      requestedSchema?: unknown;
      mode?: unknown;
    };
    const message = typeof params.message === 'string' ? params.message : '';
    const schema = params.requestedSchema;
    const items = parseApprovalItems(message, schema, index);
    const decision = approver.decide(items, schema);
    const input = inflight?.input;
    const callArgs = input?.['args'];
    // A mediated tool (`projections.direct`) is call_tool under the
    // catalog name, its input the call's args: attribute it the same way.
    const mediated =
      inflight !== undefined && inflight.name !== 'call_tool'
        ? mediatedToolTarget(inflight.name, index)
        : undefined;
    elicitations.push(
      elicitationRecord({
        seq: elicitations.length,
        source: 'projection',
        toolCall: { index: inflight?.index ?? -1, name: inflight?.name ?? '' },
        ...(inflight?.name === 'call_tool' && typeof input?.['name'] === 'string'
          ? {
              call: {
                tool: input['name'],
                args:
                  typeof callArgs === 'object' && callArgs !== null && !Array.isArray(callArgs)
                    ? (callArgs as Record<string, unknown>)
                    : {},
              },
            }
          : mediated !== undefined && input !== undefined
            ? { call: { tool: mediated, args: input } }
            : {}),
        key: String((ctx as { mcpReq?: { id?: unknown } } | undefined)?.mcpReq?.id ?? ''),
        mode: typeof params.mode === 'string' ? params.mode : 'form',
        message,
        requestedSchema: schema,
        items,
        decision,
        worldCallsAtAnswer: world.calls.length,
      }),
    );
    return { ...decision.response };
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
    elicitations,
    approver: approverSpec.persona,
    budgetFreeTools: budgetFree(tools),
    runtime: {
      system,
      tools,
      call: async (name, input) => {
        inflight = { index: state.toolCalls, name, input };
        state.toolCalls += 1;
        try {
          return toolResultText(await client.callTool({ name, arguments: input }));
        } finally {
          inflight = undefined;
        }
      },
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
  return openSingleProjectionSession(world, 'projection', options);
}

/**
 * A Projection mode on any world: the multi-server facade for a boxed
 * world, else `wrapMcpServer`, with the mode's `projections.direct`.
 * Mediated tools (direct listing) are action tools: only the discovery
 * tools are budget-free, as in `projection`.
 */
async function openSingleProjectionSession(
  world: EvalWorld,
  mode: Exclude<EvalMode, 'direct' | 'native-search' | 'native-ptc'>,
  options: SessionOptions = {},
): Promise<ModeSession> {
  if ('boxes' in world) return openMultiProjectionSession(world, mode, options);
  const facade = await wrapMcpServer(world.server, {
    blob: { key: randomBytes(32) },
    ...projectionWrapOptions(mode),
    ...(options.approvalPrompts !== undefined ? { approvalPrompts: options.approvalPrompts } : {}),
  });
  return connectFacade(mode, world, facade, () => PROJECTION_DISCOVERY_TOOLS, options);
}

/**
 * The multi world behind `wrapMcpServers`, one box per alias, default
 * options except `catalog.globalSearch: false` for `projection-boxes` (and
 * the host's box descriptions when `options.boxDescriptions`). Discovery
 * turns are free as on a single-server facade, `search_<alias>` included.
 */
export async function openMultiProjectionSession(
  world: MultiWorld,
  mode: Exclude<EvalMode, 'direct' | 'native-search' | 'native-ptc'>,
  options: SessionOptions = {},
): Promise<ModeSession> {
  const sources: Record<string, McpServer | { source: McpServer; description: string }> =
    Object.fromEntries(
      world.boxes.map((box) => [
        box.alias,
        options.boxDescriptions === true && box.description !== undefined
          ? { source: box.world.server, description: box.description }
          : box.world.server,
      ]),
    );
  const facade = await wrapMcpServers(sources, {
    blob: { key: randomBytes(32) },
    ...(mode === 'projection-boxes' ? { catalog: { globalSearch: false } } : {}),
    ...projectionWrapOptions(mode),
    ...(options.approvalPrompts !== undefined ? { approvalPrompts: options.approvalPrompts } : {}),
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
    options,
  );
}

/**
 * Direct on the multi world: one in-memory connection per box, every tool
 * offered under its {@link hostToolName} and routed back to its box.
 */
export async function openMultiDirectSession(
  world: MultiWorld,
  options: SessionOptions = {},
  mode: 'direct' | 'native-search' | 'native-ptc' = 'direct',
): Promise<ModeSession> {
  const native = nativeToolsOf(mode, options);
  const clients: Client[] = [];
  const closeAll = async (): Promise<void> => {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
  };
  const routes = new Map<string, { client: Client; name: string; alias: string }>();
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
        routes.set(name, { client, name: tool.name, alias: box.alias });
        tools.push({ name, description: tool.description, inputSchema: tool.inputSchema });
      }
    }
  } catch (err) {
    await closeAll();
    throw err;
  }

  const host = hostGate(world, options.approver);
  return {
    mode,
    world,
    get approvals() {
      return host.approvals();
    },
    elicitations: host.elicitations,
    approver: options.approver?.persona ?? 'approve-all',
    budgetFreeTools: new Set(),
    runtime: {
      system: multiDirectSystemPrompt(world),
      tools,
      ...(native !== undefined ? { native } : {}),
      call: async (name, input) => {
        const route = routes.get(name);
        if (route === undefined) return { text: `Tool ${name} not found`, isError: true };
        return host.gate(name, `${route.alias}.${route.name}`, input, async () =>
          toolResultText(await route.client.callTool({ name: route.name, arguments: input })),
        );
      },
    },
    close: closeAll,
  };
}

export async function openSession(
  mode: EvalMode,
  world: EvalWorld,
  options: SessionOptions = {},
): Promise<ModeSession> {
  const session = await openModeSession(mode, world, options);
  if (options.hostPrompt !== undefined && options.hostPrompt !== '') {
    session.runtime.system = `${options.hostPrompt}\n\n${session.runtime.system}`;
  }
  return session;
}

function openModeSession(
  mode: EvalMode,
  world: EvalWorld,
  options: SessionOptions,
): Promise<ModeSession> {
  switch (mode) {
    case 'direct':
    case 'native-search':
    case 'native-ptc':
      return openDirectSession(world, options, mode);
    case 'projection':
      return openProjectionSession(world, options);
    case 'projection-boxes':
      if (!('boxes' in world)) {
        return Promise.reject(
          new Error(`mode projection-boxes needs a boxed world, not ${world.name}`),
        );
      }
      return openMultiProjectionSession(world, mode, options);
    case 'projection-direct':
    case 'projection-auto':
    case 'projection-search':
    case 'projection-nocode':
    case 'projection-codeonly':
    case 'projection-nopreamble':
      return openSingleProjectionSession(world, mode, options);
  }
}
