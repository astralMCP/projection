/**
 * Building and populating the facade's `McpServer` (PRD R1, R3, R28, R29,
 * R32–R35), shared by `wrapMcpServer` and `wrapMcpServers`.
 *
 * Each facade kind supplies its handlers and its model-facing copy; the tool
 * names, input schemas, annotations, the MRTR retry plumbing and the legacy
 * capability probe are defined once, here, so a multi-server facade gates
 * exactly like a single-server one.
 */

import {
  McpServer,
  type RegisteredTool,
  type ServerContext,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { DASHBOARD_RESOURCE_URI } from '../apps/dashboard.js';
import { boxSearchTool } from '../catalog/boxes.js';
import type { CallToolArgs } from '../catalog/index.js';
import type {
  CallToolResult,
  ExecuteMachineArgs,
  ProjectionResource,
  ProtocolEra,
  ToolCallResult,
} from '../mrtr/index.js';
import { WORKFLOW_PROMPTS } from '../prompts/workflow-prompts.js';
import { capLength, neutralizeControlChars } from '../text-safety.js';
import { clampCaps, type ServerCatalog, type UpstreamCallOptions } from '../types.js';
import type { DirectTool } from './direct.js';
import type { WrapOptions } from './options.js';

/** The model-facing copy of the catalog tools: what differs between facade kinds. */
export interface CatalogToolCopy {
  /**
   * The search tools, in registration order (R33, R43): `search_tools` on a
   * single-server facade; one `search_<alias>` per box on a multi-server
   * facade, then `search_tools` when its view serves the global search.
   */
  searches: readonly SearchToolCopy[];
  describeDescription: string;
  callDescription: string;
  /** Description of the `name` argument of `describe_tool` and `call_tool`. */
  toolName: string;
  /** Description of `describe_tool`'s `types` argument. */
  describeTypes: string;
}

/** The copy of one search tool (R33, R43). */
export interface SearchToolCopy {
  /** The box a `search_<alias>` searches (R43); absent for `search_tools`. */
  alias?: string;
  title: string;
  description: string;
  /** Description of the `query` argument. */
  query: string;
}

/** The catalog tools' handlers (R32–R35). */
export interface CatalogHandlers {
  /** `search_tools`, or `search_<alias>` when `alias` is given (multi-server, R43). */
  searchTools(args: { query?: string; cursor?: string }, alias?: string): CallToolResult;
  describeTool(args: { name: string; types?: boolean }): CallToolResult;
  callTool(
    args: CallToolArgs,
    era?: ProtocolEra,
    clientCanElicit?: boolean,
    clientUrlElicitation?: boolean,
  ): Promise<ToolCallResult>;
}

/** The code-mode tools' handlers (R1–R3). */
export interface CodeModeHandlers {
  executeMachine(
    args: ExecuteMachineArgs,
    era?: ProtocolEra,
    clientCanElicit?: boolean,
    clientUrlElicitation?: boolean,
  ): Promise<ToolCallResult>;
  discoverApis(): CallToolResult;
}

/**
 * R29: `Server` accepts `instructions` only in its constructor, so the
 * preamble can be delivered from here and nowhere else. This is also where
 * the era arrives, which is why the factory shape is the library's
 * recommended entry point.
 */
export function createProjectionServer(
  options: WrapOptions,
  defaultName: string,
  instructions: string,
): McpServer {
  return new McpServer(options.serverInfo ?? { name: defaultName, version: '0.1.0' }, {
    instructions,
    // Keeps the SDK shim's round budget aligned with Projection's R18
    // trip cap, so Projection's structured trip-cap error always fires
    // before the shim's generic round-limit failure (which would
    // otherwise cap legacy-elicitation flows at the SDK default of 8
    // rounds even when caps.maxRoundTrips is raised).
    inputRequired: { maxRounds: clampCaps(options.caps ?? {}).maxRoundTrips },
  });
}

/**
 * Resources back both projections: describe_tool points at the .d.ts, and
 * the MCP Apps dashboard rides execute_machine results. A read serves the
 * resource of that URI in `current()` — the facade's current snapshot, so
 * a server held open across a tools/list_changed refresh (R65) serves the
 * refreshed text — falling back to the one registered.
 */
export function registerResources(
  server: McpServer,
  resources: readonly ProjectionResource[],
  current: () => readonly ProjectionResource[] = () => resources,
): void {
  for (const registered of resources) {
    const resource = registered;
    server.registerResource(
      resource.name,
      resource.uri,
      {
        description: resource.description,
        mimeType: resource.mimeType,
        ...(resource._meta !== undefined ? { _meta: resource._meta } : {}),
      },
      () => {
        const served = current().find((candidate) => candidate.uri === resource.uri) ?? resource;
        return {
          contents: [{ uri: served.uri, mimeType: served.mimeType, text: served.text }],
        };
      },
    );
  }
}

/** Catalog projection (R32–R35): `search_tools`, `describe_tool`, `call_tool`. */
export function registerCatalogTools(
  server: McpServer,
  era: ProtocolEra | undefined,
  handlers: CatalogHandlers,
  copy: CatalogToolCopy,
): Map<string, RegisteredTool> {
  const handles = new Map<string, RegisteredTool>();
  // The search tools and `describe_tool` are pure reads over the catalog;
  // the annotation lets hosts that gate on annotations run them without a
  // prompt (R35, R43).
  for (const search of copy.searches) {
    const alias = search.alias;
    const name = searchToolName(search);
    handles.set(
      name,
      registerSearchTool(server, name, search, (args) => handlers.searchTools(args, alias)),
    );
  }

  const describe = server.registerTool(
    'describe_tool',
    {
      title: 'Describe one tool',
      description: copy.describeDescription,
      inputSchema: z.object({
        name: z.string().describe(copy.toolName),
        types: z.boolean().optional().describe(copy.describeTypes),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) =>
      handlers.describeTool({
        name: args.name,
        ...(args.types !== undefined ? { types: args.types } : {}),
      }),
  );

  handles.set('describe_tool', describe);

  // No annotations on purpose (R35): hosts that gate on annotations must
  // never auto-run it. `args` is validated by Projection, not zod, so a
  // non-object arrives as an R25 structured error rather than an SDK one.
  const call = server.registerTool(
    'call_tool',
    {
      title: 'Call one tool',
      description: copy.callDescription,
      inputSchema: z.object({
        name: z.string().describe(copy.toolName),
        args: z
          .unknown()
          .optional()
          .describe(
            "JSON object of arguments, as a search hit's args or describe_tool shows them.",
          ),
      }),
    },
    async (args, ctx) =>
      await handlers.callTool(
        {
          name: args.name,
          ...(args.args !== undefined ? { args: args.args } : {}),
          ...maybeRequestState(ctx.mcpReq.requestState<unknown>()),
          ...(ctx.mcpReq.inputResponses !== undefined
            ? { inputResponses: ctx.mcpReq.inputResponses }
            : {}),
          upstream: upstreamCallOptions(args.name, ctx),
        },
        era,
        clientCanElicit(server),
        clientUrlElicitation(server),
      ),
  );
  handles.set('call_tool', call);
  return handles;
}

/** The tool a search copy registers: `search_<alias>` for a box, else `search_tools`. */
function searchToolName(search: SearchToolCopy): string {
  return search.alias !== undefined ? boxSearchTool(search.alias) : 'search_tools';
}

/** What a facade registered on a server it may have to update later (R65). */
export interface HeldRegistration {
  era: ProtocolEra | undefined;
  /** Projection's catalog tools by name (absent when the projection is off). */
  catalogTools: Map<string, RegisteredTool> | undefined;
  /** The mediated tools listed directly, by listed name. */
  direct: Map<string, { tool: DirectTool; handle: RegisteredTool }>;
}

/**
 * Bring a server registered from an older snapshot up to `copy` and
 * `directTools` (R65): the mediated tools are added, removed or replaced,
 * and the catalog tools' descriptions updated (their set never changes —
 * the surface is pinned at wrap time). A new tool whose name the server
 * already has registered (an integrator's own, via `registerOn`) is skipped
 * on that server. Returns whether any tool definition the server lists
 * changed.
 */
export function reconcileHeldServer(
  server: McpServer,
  held: HeldRegistration,
  handlers: Pick<CatalogHandlers, 'callTool'>,
  copy: CatalogToolCopy | undefined,
  directTools: readonly DirectTool[],
): boolean {
  let changed = false;
  if (copy !== undefined && held.catalogTools !== undefined) {
    const descriptions = new Map<string, string>([
      ...copy.searches.map((search) => [searchToolName(search), search.description] as const),
      ['describe_tool', copy.describeDescription],
      ['call_tool', copy.callDescription],
    ]);
    for (const [name, description] of descriptions) {
      const handle = held.catalogTools.get(name);
      if (handle !== undefined && handle.description !== description) {
        handle.update({ description });
        changed = true;
      }
    }
  }
  const wanted = new Map(directTools.map((tool) => [tool.name, tool]));
  for (const [name, { tool, handle }] of held.direct) {
    const next = wanted.get(name);
    if (next !== undefined && sameDirectTool(tool, next)) continue;
    handle.remove();
    held.direct.delete(name);
    changed = true;
  }
  // A name the integrator already registered on this server is skipped
  // there alone (registerDirectTools), never failing the rest.
  const added = directTools.filter((tool) => !held.direct.has(tool.name));
  for (const [name, entry] of registerDirectTools(server, held.era, handlers, added)) {
    held.direct.set(name, entry);
    changed = true;
  }
  return changed;
}

/** Whether two lists of mediated tools would be listed and routed identically. */
export function sameDirectTools(a: readonly DirectTool[], b: readonly DirectTool[]): boolean {
  return (
    a.length === b.length && a.every((tool, index) => sameDirectTool(tool, b[index] as DirectTool))
  );
}

/** Whether two mediated tools would be listed and routed identically. */
export function sameDirectTool(a: DirectTool, b: DirectTool): boolean {
  return JSON.stringify(directToolSpec(a)) === JSON.stringify(directToolSpec(b));
}

function directToolSpec(tool: DirectTool): unknown {
  return [
    tool.name,
    tool.target,
    tool.title ?? null,
    tool.description,
    tool.inputSchema,
    tool.annotations,
  ];
}

/**
 * Direct listing (`projections.direct`, `facade/direct.ts`): one mediated
 * tool per wrapped tool, each a thin alias of `call_tool` — the handler is
 * the facade's `callTool`, given the tool's catalog name, the model's
 * arguments as `args`, the MRTR retry envelope, the upstream progress and
 * cancellation options and the client's elicitation capabilities, read from
 * the transport exactly as for `call_tool` (so a forwarded upstream question,
 * decline copy and audit redaction are `call_tool`'s own). The annotations
 * are Projection's own, from its decided posture (`advertisedAnnotations`),
 * never the server's: a host that auto-runs read-only tools may only skip
 * its prompt where Projection would not ask either. A tool whose name the
 * server already has registered is skipped on that server.
 */
export function registerDirectTools(
  server: McpServer,
  era: ProtocolEra | undefined,
  handlers: Pick<CatalogHandlers, 'callTool'>,
  tools: readonly DirectTool[],
): Map<string, { tool: DirectTool; handle: RegisteredTool }> {
  const handles = new Map<string, { tool: DirectTool; handle: RegisteredTool }>();
  for (const tool of tools) {
    const handle = registerSkippingTaken(() =>
      server.registerTool(
        tool.name,
        {
          ...(tool.title !== undefined ? { title: tool.title } : {}),
          description: tool.description,
          inputSchema: advertisedSchema(tool.inputSchema),
          annotations: { ...tool.annotations },
        },
        async (args: unknown, ctx) =>
          await handlers.callTool(
            {
              name: tool.target,
              ...(args !== undefined ? { args } : {}),
              ...maybeRequestState(ctx.mcpReq.requestState<unknown>()),
              ...(ctx.mcpReq.inputResponses !== undefined
                ? { inputResponses: ctx.mcpReq.inputResponses }
                : {}),
              // Progress and cancellation as for `call_tool`, attributed to the
              // catalog name so a relayed message reads the same either way.
              upstream: upstreamCallOptions(tool.target, ctx),
            },
            era,
            clientCanElicit(server),
            clientUrlElicitation(server),
          ),
      ),
    );
    if (handle !== undefined) handles.set(tool.name, { tool, handle });
  }
  return handles;
}

/**
 * Register one mediated tool, or skip it when `server` already has a tool
 * by that name: an integrator's own tool (registered before `registerOn`)
 * keeps it, and a wrapped server that later lists a tool under the same
 * name can never make registration fail for every later server (R65).
 * Projection's own catalog and code-mode tools have reserved names and
 * are registered elsewhere, so a collision there still throws.
 */
function registerSkippingTaken(register: () => RegisteredTool): RegisteredTool | undefined {
  try {
    return register();
  } catch {
    return undefined;
  }
}

/**
 * A pass-through Standard Schema advertising `schema` in `tools/list`.
 * Arguments are not validated by the SDK: `call_tool`'s own R35 validation
 * runs on them, so a mediated tool fails exactly as `call_tool` would.
 */
function advertisedSchema(schema: Record<string, unknown>): StandardSchemaWithJSON {
  return {
    '~standard': {
      version: 1,
      vendor: 'astral-mcp-projection',
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}

/** Upstream progress messages are server prose (S5): inert and bounded. */
const MAX_PROGRESS_MESSAGE_CHARS = 200;

/**
 * The upstream half of a `call_tool` request: cancelling the facade request
 * cancels the upstream call, and when the client asked for progress (a
 * `progressToken` in `_meta`), the upstream's progress reports are relayed
 * under the client's own token. A relayed message is the wrapped server's
 * text (S5): attributed to the tool (`<tool>: <message>`; a qualified name
 * on a multi-server facade names the box, R40), control and bidi characters
 * neutralized, capped. `name` only reaches a report once the catalog has
 * accepted it — an unknown tool never runs.
 */
function upstreamCallOptions(name: string, ctx: ServerContext): UpstreamCallOptions {
  const token = ctx.mcpReq._meta?.progressToken;
  if (token === undefined) return { signal: ctx.mcpReq.signal };
  return {
    signal: ctx.mcpReq.signal,
    onProgress: (report) => {
      const params: {
        progressToken: string | number;
        progress: number;
        total?: number;
        message?: string;
      } = { progressToken: token, progress: report.progress };
      if (report.total !== undefined) params.total = report.total;
      if (report.message !== undefined) {
        params.message = neutralizeControlChars(
          capLength(`${name}: ${report.message}`, MAX_PROGRESS_MESSAGE_CHARS),
        );
      }
      // Best effort: a client that went away misses a progress report, and
      // the call itself carries on.
      ctx.mcpReq.notify({ method: 'notifications/progress', params }).catch(() => undefined);
    },
  };
}

/** One search tool (R33, R43): `{ query?, cursor? }`, read-only. */
function registerSearchTool(
  server: McpServer,
  name: string,
  copy: { title: string; description: string; query: string },
  search: (args: { query?: string; cursor?: string }) => CallToolResult,
): RegisteredTool {
  return server.registerTool(
    name,
    {
      title: copy.title,
      description: copy.description,
      inputSchema: z.object({
        query: z.string().optional().describe(copy.query),
        cursor: z.string().optional().describe('nextCursor from a previous page.'),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) =>
      search({
        ...(args.query !== undefined ? { query: args.query } : {}),
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      }),
  );
}

/** Code mode (R1–R3): `execute_machine`, `discover_apis`, the workflow prompts. */
export function registerCodeModeTools(
  server: McpServer,
  era: ProtocolEra | undefined,
  handlers: CodeModeHandlers,
  copy: { executeMachine: string; discoverApis: string },
  promptCatalog: () => ServerCatalog,
): void {
  server.registerTool(
    'execute_machine',
    {
      title: 'Execute a state machine',
      description: copy.executeMachine,
      inputSchema: EXECUTE_MACHINE_INPUT_SCHEMA,
      // MCP Apps (SEP-1865): app-capable hosts render the workflow
      // dashboard in place of the raw result. Hosts without the extension
      // ignore _meta.ui entirely.
      _meta: { ui: { resourceUri: DASHBOARD_RESOURCE_URI } },
    },
    async (args, ctx) =>
      await handlers.executeMachine(
        {
          code: args.code,
          // `exactOptionalPropertyTypes`: an absent optional argument must
          // stay absent rather than becoming an explicit `undefined`.
          ...(args.lang !== undefined ? { lang: args.lang } : {}),
          ...(args.input !== undefined ? { input: args.input } : {}),
          // MRTR's retry fields are request params, not tool arguments:
          // the SDK lifts them off `params` before the handler runs, so
          // they are read from the context rather than from `args`. The
          // raw wire string is what we want — `openBlob` performs the full
          // R21 verification, including the `codeHash` binding that a
          // `requestState.verify` hook could not check (it never sees the
          // re-sent `code`).
          ...maybeRequestState(ctx.mcpReq.requestState<unknown>()),
          ...(ctx.mcpReq.inputResponses !== undefined
            ? { inputResponses: ctx.mcpReq.inputResponses }
            : {}),
        },
        era,
        clientCanElicit(server),
        clientUrlElicitation(server),
      ),
  );

  server.registerTool(
    'discover_apis',
    {
      title: 'Discover the tool API',
      description: copy.discoverApis,
      inputSchema: z.object({}),
    },
    () => handlers.discoverApis(),
  );

  // Workflow prompts (/save-workflow, /visualize-workflow): templated
  // guidance the client's model runs against ITS conversation context —
  // the facade is stateless (R27) and holds no call history itself.
  for (const prompt of WORKFLOW_PROMPTS) {
    const shape: Record<string, z.ZodType> = {};
    for (const [arg, spec] of Object.entries(prompt.args)) {
      const base = z.string().describe(spec.description);
      shape[arg] = spec.required ? base : base.optional();
    }
    server.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description, argsSchema: z.object(shape) },
      (args: Record<string, unknown>) => ({
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              // Safe: the zod argsSchema above admits only (optional) strings.
              text: prompt.build(args as Record<string, string | undefined>, promptCatalog()),
            },
          },
        ],
      }),
    );
  }
}

/**
 * Legacy compat: whether the SDK's elicitation shim has a channel to this
 * client. Read per call — capabilities are negotiated on the connection, not
 * known at registration — and left unknown when the SDK has none to report
 * (per-request legacy HTTP), so the shim's own per-request failure stays the
 * one the caller sees there. Mirrors the shim's form-capability rule: form
 * mode needs `elicitation.form`, and a bare `elicitation: {}` counts as
 * implied form support only when `url` is absent too.
 */
function clientCanElicit(server: McpServer): boolean | undefined {
  const clientCaps = server.server.getClientCapabilities();
  if (clientCaps === undefined) return undefined;
  const elicitation = clientCaps.elicitation;
  return (
    elicitation !== undefined && (elicitation.form !== undefined || elicitation.url === undefined)
  );
}

/**
 * Whether the client declared URL-mode elicitation (G1: a forwarded link is
 * sent in URL mode only then). Read per call, like {@link clientCanElicit}.
 */
function clientUrlElicitation(server: McpServer): boolean {
  return server.server.getClientCapabilities()?.elicitation?.url !== undefined;
}

/**
 * `ctx.mcpReq.requestState()` is typed as a caller-asserted cast, so it is
 * read as `unknown` and narrowed here: without a configured
 * `ServerOptions.requestState.verify` hook the SDK hands back the raw wire
 * string, and anything else means someone wired a decoding hook Projection
 * does not own.
 */
function maybeRequestState(state: unknown): { requestState?: string } {
  return typeof state === 'string' ? { requestState: state } : {};
}

/**
 * `execute_machine` arguments (R2).
 *
 * The MRTR retry fields are deliberately absent: `requestState` and
 * `inputResponses` are siblings of `arguments` in a `tools/call`, not
 * members of it, and the SDK surfaces them on the handler context.
 */
const EXECUTE_MACHINE_INPUT_SCHEMA = z.object({
  code: z.string().describe('The machine module source: a default-exported XState v5 machine.'),
  lang: z
    .enum(['ts', 'js'])
    .optional()
    .describe('Language of `code`. Defaults to TypeScript-compatible parsing.'),
  input: z.unknown().optional().describe('Passed to the machine as its `input`.'),
});
