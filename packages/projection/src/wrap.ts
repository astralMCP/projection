/**
 * `wrapMcpServer` — the integrating developer's entry point (PRD G1, R1).
 *
 * Introspects a wrapped MCP server, generates its `@astral-mcp/tools`
 * artifacts, and returns a facade exposing exactly two tools —
 * `execute_machine` and `discover_apis` — plus the resources backing
 * discovery. The wrapped server's own tools are never exposed (R1).
 *
 * The facade's primary shape is an SDK **server factory**, because that is
 * the only place the SDK tells a server which protocol era it is serving:
 *
 * ```ts
 * import { createMcpHandler } from '@modelcontextprotocol/server';
 *
 * const facade = await wrapMcpServer(myServer, { blob: { key } });
 * export default createMcpHandler(facade.serverFactory);
 * ```
 *
 * `createMcpHandler` (and `serveStdio`) call the factory once per serving
 * unit with `McpRequestContext.era`, so `createServer` can both apply the
 * code-mode `instructions` (R29 — `Server` only accepts them in its
 * constructor) and hand the era to the MRTR adapter for down-negotiation
 * (R28). `registerOn` remains for callers who build the `McpServer`
 * themselves, and takes the era explicitly for the same reason.
 *
 * Anything more exotic can drive `facade.executeMachine` /
 * `facade.discoverApis` directly — the facade is plain data and functions,
 * holding no cross-request state (R27).
 */

import type { Client } from '@modelcontextprotocol/client';
import { describeTool, searchTools } from './catalog/index.js';
import {
  McpServer,
  type Implementation,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { DASHBOARD_RESOURCE_URI } from './apps/dashboard.js';
import { toStructuredError } from './errors.js';
import { WORKFLOW_PROMPTS } from './prompts/workflow-prompts.js';
import { createIntrospector, type Introspector } from './introspector/index.js';
import {
  buildInstructions,
  buildResources,
  discoverApis,
  errorResult,
  executeMachine,
  type CallToolResult,
  type ExecuteMachineArgs,
  type ProjectionResource,
  type ProjectionSelection,
  type ProtocolEra,
  type ToolCallResult,
} from './mrtr/index.js';
import { generateToolTypes, type ToolTypeText } from './typegen/index.js';
import {
  clampCaps,
  DEFAULT_SERVER_ALIAS,
  type BlobSealerConfig,
  type PolicyOverrides,
  type RedactionHook,
  type ResourceCaps,
  type ServerCatalog,
} from './types.js';
import { ProjectionError } from './errors.js';

export interface WrapOptions {
  /** Blob sealing configuration; required for any gated flow (R22). */
  blob: BlobSealerConfig;
  /** Resource cap overrides, clamped at the hard maxima (R12). */
  caps?: Partial<ResourceCaps>;
  /** Per-tool policy overrides (R14). */
  policy?: PolicyOverrides;
  /** Masks sensitive argument fields before they reach an approval prompt (R16). */
  redact?: RedactionHook;
  /** Replaces the library's code-mode preamble (R29). */
  codeModePreamble?: string;
  /** Compatibility switches for pre-2026-07-28 clients. */
  compat?: {
    /**
     * Serve approval suspensions to legacy clients through the SDK's
     * server→client `elicitation/create` shim instead of failing fast
     * (R28 amendment; DECISIONS D6). The client must declare the
     * `elicitation` capability. Statelessness is suspended for the open
     * call — free over stdio, needs session affinity over legacy HTTP.
     */
    legacyElicitation?: boolean;
  };
  /** Identity the servers built by `createServer` advertise. */
  serverInfo?: Implementation;
  /**
   * Which projections the facade serves (R1, R32). Code mode
   * (`execute_machine`, `discover_apis`) defaults on. The catalog projection
   * (`search_tools`, `describe_tool`, `call_tool`) defaults OFF until
   * `call_tool` ships; disabling both is an error at wrap time.
   */
  projections?: ProjectionsOptions;
}

/** Per-projection on/off switches (R1, R32). */
export interface ProjectionsOptions {
  codeMode?: boolean;
  catalog?: boolean;
}

const DEFAULT_PROJECTIONS: ProjectionSelection = { codeMode: true, catalog: false };

/** Options for registering the code-mode surface on a server the caller built. */
export interface RegisterOptions {
  /**
   * The protocol era this server instance serves (R28). Omitted means
   * `'legacy'`: a hand-connected `McpServer` never negotiates 2026-07-28, so
   * defaulting to legacy is the honest — and fail-safe — reading.
   */
  era?: ProtocolEra;
}

export interface ProjectionFacade {
  /** Catalog of the wrapped server. */
  readonly catalog: ServerCatalog;
  /** Instructions to advertise: the wrapped server's, then the preamble (R29). */
  readonly instructions: string;
  /** Generated `.d.ts` for the wrapped server's tools. */
  readonly dts: string;
  /** Resources served at stable `projection://` URIs (R3). */
  readonly resources: ProjectionResource[];
  /**
   * Server factory to hand to `createMcpHandler` or `serveStdio` (R28, R29).
   * Every instance it builds carries the code-mode `instructions` and knows
   * the era it is serving.
   */
  readonly serverFactory: McpServerFactory;

  /**
   * Run `execute_machine` for one `tools/call`, first attempt or retry.
   * `clientCanElicit` reports whether the connected client declared the
   * `elicitation` capability (legacy compat only; omit when unknown).
   */
  executeMachine(
    args: ExecuteMachineArgs,
    era?: ProtocolEra,
    clientCanElicit?: boolean,
  ): Promise<ToolCallResult>;
  /** Run `discover_apis`. */
  discoverApis(): CallToolResult;
  /** Run `search_tools` (R33). Failures come back as R25 structured error results. */
  searchTools(args: { query?: string; cursor?: string }): CallToolResult;
  /** Run `describe_tool` (R34). Failures come back as R25 structured error results. */
  describeTool(args: { name: string }): CallToolResult;
  /** The projections this facade serves (R32). */
  readonly projections: ProjectionSelection;
  /** Build an `McpServer` carrying the instructions, both tools and the resources. */
  createServer(ctx?: RegisterOptions): McpServer;
  /** Register both tools and the resources on an `McpServer` the caller built. */
  registerOn(server: McpServer, options?: RegisterOptions): void;
  /** Close the connection to the wrapped server. */
  close(): Promise<void>;
}

const EXECUTE_MACHINE_DESCRIPTION = `Run an LLM-authored XState v5 state machine that orchestrates this server's tools.

Author a module that default-exports a machine built with XState v5 setup(...).createMachine(...), and request tools with the toolCall action from '@astral-mcp/tools'. Read-only tools run immediately; every other tool pauses the machine and asks the user to approve that exact call before it runs, so handle TOOL_RESULT, TOOL_ERROR and TOOL_DENIED. Machine context must stay JSON-serializable, and invoke/fromPromise is rejected.

Call discover_apis first for the tool types, the full authoring contract, and worked examples.`;

const DISCOVER_APIS_DESCRIPTION = `Return this server's tool type definitions, the machine authoring contract, and worked examples. Call this before authoring a machine for execute_machine.`;

const SEARCH_TOOLS_DESCRIPTION = `List this server's tools, one page at a time, optionally filtered by a plain substring on name and description. Each entry gives the tool's name, a one-line purpose, whether it runs immediately or asks the user for approval, and whether the server marks it destructive. Call describe_tool before calling a tool whose arguments you have not seen.`;

const DESCRIBE_TOOL_DESCRIPTION = `Return one tool's description, its input and output JSON Schemas, its approval posture, and its generated TypeScript types. Call this before call_tool, or when authoring a machine that uses the tool.`;

/**
 * Wrap an MCP server (an in-process instance or a connected client) into a
 * code-mode facade.
 */
export async function wrapMcpServer(
  source: McpServer | Client,
  options: WrapOptions,
): Promise<ProjectionFacade> {
  const introspector = await createIntrospector({ [DEFAULT_SERVER_ALIAS]: source });
  const catalog = introspector.catalog.servers.get(DEFAULT_SERVER_ALIAS);
  if (catalog === undefined) {
    throw new ProjectionError(
      'protocol',
      'introspection produced no catalog for the wrapped server',
      {
        hint: 'Check that the wrapped server initialized successfully.',
      },
    );
  }

  const projections = resolveProjections(options.projections);
  const { dts, bridgeSource, overview, toolTypes } = generateToolTypes(catalog);
  const resources = buildResources(catalog, dts);
  const instructions = buildInstructions(catalog, options.codeModePreamble, projections);

  return new Facade({
    introspector,
    catalog,
    dts,
    bridgeSource,
    overview,
    toolTypes,
    resources,
    instructions,
    options,
    projections,
  });
}

/** R1: at least one projection must be on, or the facade serves nothing. */
function resolveProjections(options: ProjectionsOptions | undefined): ProjectionSelection {
  const selection: ProjectionSelection = {
    codeMode: options?.codeMode ?? DEFAULT_PROJECTIONS.codeMode,
    catalog: options?.catalog ?? DEFAULT_PROJECTIONS.catalog,
  };
  if (!selection.codeMode && !selection.catalog) {
    throw new ProjectionError('terminal', 'at least one projection must be enabled', {
      hint: 'Set projections.codeMode and/or projections.catalog to true (both default to on).',
    });
  }
  return selection;
}

interface FacadeDeps {
  introspector: Introspector;
  catalog: ServerCatalog;
  dts: string;
  bridgeSource: string;
  overview: string;
  toolTypes: Map<string, ToolTypeText>;
  resources: ProjectionResource[];
  instructions: string;
  options: WrapOptions;
  projections: ProjectionSelection;
}

class Facade implements ProjectionFacade {
  readonly catalog: ServerCatalog;
  readonly instructions: string;
  readonly dts: string;
  readonly resources: ProjectionResource[];
  readonly serverFactory: McpServerFactory;
  readonly projections: ProjectionSelection;
  private readonly deps: FacadeDeps;

  constructor(deps: FacadeDeps) {
    this.deps = deps;
    this.catalog = deps.catalog;
    this.instructions = deps.instructions;
    this.dts = deps.dts;
    this.resources = deps.resources;
    this.projections = deps.projections;
    // Bound so it can be handed to `createMcpHandler` detached.
    this.serverFactory = (ctx) => this.createServer(ctx);
  }

  executeMachine(
    args: ExecuteMachineArgs,
    era?: ProtocolEra,
    clientCanElicit?: boolean,
  ): Promise<ToolCallResult> {
    const { options } = this.deps;
    return executeMachine(args, {
      catalog: this.deps.catalog,
      bridgeSource: this.deps.bridgeSource,
      executor: this.deps.introspector,
      blob: options.blob,
      ...(options.caps !== undefined ? { caps: options.caps } : {}),
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
      ...(options.redact !== undefined ? { redact: options.redact } : {}),
      ...(era !== undefined ? { protocolEra: era } : {}),
      ...(options.compat?.legacyElicitation === true ? { legacyElicitation: true } : {}),
      ...(clientCanElicit !== undefined ? { clientCanElicit } : {}),
    });
  }

  discoverApis(): CallToolResult {
    return discoverApis(this.deps.catalog, this.deps.overview);
  }

  searchTools(args: { query?: string; cursor?: string }): CallToolResult {
    try {
      return searchTools(this.deps.catalog, args, this.policyOption());
    } catch (err) {
      return errorResult(toStructuredError(err));
    }
  }

  describeTool(args: { name: string }): CallToolResult {
    try {
      return describeTool(this.deps.catalog, args, {
        ...this.policyOption(),
        toolTypes: this.deps.toolTypes,
      });
    } catch (err) {
      return errorResult(toStructuredError(err));
    }
  }

  /** `exactOptionalPropertyTypes`: an absent policy must stay absent. */
  private policyOption(): { policy?: PolicyOverrides } {
    const { policy } = this.deps.options;
    return policy !== undefined ? { policy } : {};
  }

  /**
   * R29: `Server` accepts `instructions` only in its constructor, so the
   * code-mode preamble can be delivered from here and nowhere else. This is
   * also where the era arrives, which is why the factory shape is the
   * library's recommended entry point.
   */
  createServer(ctx?: RegisterOptions): McpServer {
    const server = new McpServer(
      this.deps.options.serverInfo ?? {
        name: `projection-${this.deps.catalog.alias}`,
        version: '0.1.0',
      },
      {
        instructions: this.instructions,
        // Keeps the SDK shim's round budget aligned with Projection's R18
        // trip cap, so Projection's structured trip-cap error always fires
        // before the shim's generic round-limit failure (which would
        // otherwise cap legacy-elicitation flows at the SDK default of 8
        // rounds even when caps.maxRoundTrips is raised).
        inputRequired: { maxRounds: clampCaps(this.deps.options.caps ?? {}).maxRoundTrips },
      },
    );
    this.registerOn(server, ctx);
    return server;
  }

  registerOn(server: McpServer, options?: RegisterOptions): void {
    const era = options?.era;

    if (this.projections.codeMode) this.registerCodeMode(server, era);
    if (this.projections.catalog) this.registerCatalog(server);

    // Resources back both projections: describe_tool points at the .d.ts,
    // and the MCP Apps dashboard rides execute_machine results.
    for (const resource of this.resources) {
      server.registerResource(
        resource.name,
        resource.uri,
        {
          description: resource.description,
          mimeType: resource.mimeType,
          ...(resource._meta !== undefined ? { _meta: resource._meta } : {}),
        },
        () => ({
          contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }],
        }),
      );
    }
  }

  /** Catalog projection (R32–R34): `search_tools`, `describe_tool`. */
  private registerCatalog(server: McpServer): void {
    // Both are pure reads over the catalog; the annotation lets hosts that
    // gate on annotations run them without a prompt (R35).
    server.registerTool(
      'search_tools',
      {
        title: 'Search the tool catalog',
        description: SEARCH_TOOLS_DESCRIPTION,
        inputSchema: z.object({
          query: z
            .string()
            .optional()
            .describe('Plain substring to match on name and description.'),
          cursor: z.string().optional().describe('nextCursor from a previous page.'),
        }),
        annotations: { readOnlyHint: true },
      },
      (args) =>
        this.searchTools({
          ...(args.query !== undefined ? { query: args.query } : {}),
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        }),
    );

    server.registerTool(
      'describe_tool',
      {
        title: 'Describe one tool',
        description: DESCRIBE_TOOL_DESCRIPTION,
        inputSchema: z.object({
          name: z.string().describe('Tool name as listed by search_tools.'),
        }),
        annotations: { readOnlyHint: true },
      },
      (args) => this.describeTool({ name: args.name }),
    );
  }

  /** Code mode (R1–R3): `execute_machine`, `discover_apis`, the workflow prompts. */
  private registerCodeMode(server: McpServer, era: ProtocolEra | undefined): void {
    server.registerTool(
      'execute_machine',
      {
        title: 'Execute a state machine',
        description: EXECUTE_MACHINE_DESCRIPTION,
        inputSchema: EXECUTE_MACHINE_INPUT_SCHEMA,
        // MCP Apps (SEP-1865): app-capable hosts render the workflow
        // dashboard in place of the raw result. Hosts without the extension
        // ignore _meta.ui entirely.
        _meta: { ui: { resourceUri: DASHBOARD_RESOURCE_URI } },
      },
      async (args, ctx) => {
        // Legacy compat: whether the SDK's elicitation shim has a channel to
        // this client. Read per call — capabilities are negotiated on the
        // connection, not known at registration — and left unknown when the
        // SDK has none to report (per-request legacy HTTP), so the shim's
        // own per-request failure stays the one the caller sees there.
        // Mirrors the shim's form-capability rule: form mode needs
        // `elicitation.form`, and a bare `elicitation: {}` counts as implied
        // form support only when `url` is absent too.
        const clientCaps = server.server.getClientCapabilities();
        const elicitation = clientCaps?.elicitation;
        const clientCanElicit =
          clientCaps === undefined
            ? undefined
            : elicitation !== undefined &&
              (elicitation.form !== undefined || elicitation.url === undefined);
        return await this.executeMachine(
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
          clientCanElicit,
        );
      },
    );

    server.registerTool(
      'discover_apis',
      {
        title: 'Discover the tool API',
        description: DISCOVER_APIS_DESCRIPTION,
        inputSchema: z.object({}),
      },
      () => this.discoverApis(),
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
                text: prompt.build(args as Record<string, string | undefined>, this.catalog),
              },
            },
          ],
        }),
      );
    }
  }

  close(): Promise<void> {
    return this.deps.introspector.close();
  }
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
