/**
 * `wrapMcpServer` — the integrating developer's entry point (PRD G1, R1).
 *
 * Introspects a wrapped MCP server, generates its `@astral-mcp/tools`
 * artifacts, and returns a facade exposing Projection's own tools — code
 * mode's `execute_machine` and `discover_apis`, the catalog projection's
 * `search_tools` and `describe_tool` (R32) — plus the resources backing
 * them. The wrapped server's own tools are never exposed (R1).
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
 * `instructions` (R29 — `Server` only accepts them in its constructor) and
 * hand the era to the MRTR adapter for down-negotiation
 * (R28). `registerOn` remains for callers who build the `McpServer`
 * themselves, and takes the era explicitly for the same reason.
 *
 * Anything more exotic can drive `facade.executeMachine` /
 * `facade.discoverApis` directly — the facade is plain data and functions,
 * holding no cross-request state (R27).
 */

import type { Client } from '@modelcontextprotocol/client';
import type { McpServer, McpServerFactory } from '@modelcontextprotocol/server';
import {
  isUpstreamSpecShape,
  resolveUpstreamSpec,
  tokenStoreOption,
  UpstreamConnector,
  type UpstreamSpec,
} from './auth/index.js';
import { callTool, describeTool, searchTools, type CallToolArgs } from './catalog/index.js';
import { ProjectionError, toStructuredError } from './errors.js';
import {
  approvalGateDeps,
  assertUpstreamElicitationMode,
  freezePolicySettings,
  resolveIntrospectTimeout,
  resolveProjections,
  type PolicySettings,
  type RegisterOptions,
  type WrapOptions,
} from './facade/options.js';
import {
  createProjectionServer,
  registerCatalogTools,
  registerCodeModeTools,
  registerResources,
  type CatalogToolCopy,
} from './facade/server.js';
import { createIntrospector, type Introspector } from './introspector/index.js';
import {
  buildInstructions,
  buildResources,
  discoverApis,
  errorResult,
  executeMachine,
  type ApprovalGateDeps,
  type CallToolResult,
  type ExecuteMachineArgs,
  type ProjectionResource,
  type ProjectionSelection,
  type ProtocolEra,
  type ToolCallResult,
} from './mrtr/index.js';
import { generateToolTypes, type ToolTypeText } from './typegen/index.js';
import { assertApprovalsMode } from './policy/index.js';
import { DEFAULT_SERVER_ALIAS, type ServerCatalog } from './types.js';

export type { ProjectionsOptions, RegisterOptions, WrapOptions } from './facade/options.js';

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
   * Every instance it builds carries the `instructions` and knows the era it
   * is serving.
   */
  readonly serverFactory: McpServerFactory;

  /**
   * Run `execute_machine` for one `tools/call`, first attempt or retry.
   * `clientCanElicit` reports whether the connected client declared the
   * `elicitation` capability (legacy compat only; omit when unknown), and
   * `clientUrlElicitation` whether it declared URL mode (a forwarded
   * server link, G1, is otherwise shown as text in a form).
   */
  executeMachine(
    args: ExecuteMachineArgs,
    era?: ProtocolEra,
    clientCanElicit?: boolean,
    clientUrlElicitation?: boolean,
  ): Promise<ToolCallResult>;
  /** Run `discover_apis`. */
  discoverApis(): CallToolResult;
  /** Run `search_tools` (R33). Failures come back as R25 structured error results. */
  searchTools(args: { query?: string; cursor?: string }): CallToolResult;
  /** Run `describe_tool` (R34). Failures come back as R25 structured error results. */
  describeTool(args: { name: string; types?: boolean }): CallToolResult;
  /**
   * Run `call_tool` (R35) for one `tools/call`, first attempt or retry.
   * `era`, `clientCanElicit` and `clientUrlElicitation` as for `executeMachine`.
   */
  callTool(
    args: CallToolArgs,
    era?: ProtocolEra,
    clientCanElicit?: boolean,
    clientUrlElicitation?: boolean,
  ): Promise<ToolCallResult>;
  /** The projections this facade serves (R32). Frozen: fixed at wrap time. */
  readonly projections: Readonly<ProjectionSelection>;
  /** Build an `McpServer` carrying the instructions, the enabled projections' tools and the resources. */
  createServer(ctx?: RegisterOptions): McpServer;
  /** Register the enabled projections' tools and the resources on an `McpServer` the caller built. */
  registerOn(server: McpServer, options?: RegisterOptions): void;
  /**
   * Delete the stored upstream tokens (R59) of the sources given by URL:
   * on a single-server facade, its source (call it without an alias); on a
   * multi-server facade, the box named by `alias`, or every such box
   * without one. No revocation yet. A facade or box not built from an
   * `UpstreamSpec`, or an unknown alias, is a `validate` error.
   */
  signOut(alias?: string): Promise<void>;
  /** Close the connection to the wrapped server. */
  close(): Promise<void>;
}

const EXECUTE_MACHINE_DESCRIPTION = `Run an LLM-authored XState v5 state machine that orchestrates this server's tools.

Author a module that default-exports a machine built with XState v5 setup(...).createMachine(...), and request tools with the toolCall action from '@astral-mcp/tools'. A tool marked "asks for approval" pauses the machine until the user approves that exact call, so handle TOOL_RESULT, TOOL_ERROR and TOOL_DENIED. Machine context must stay JSON-serializable, and invoke/fromPromise is rejected.

Call discover_apis first for the tool types, the full authoring contract, and worked examples.`;

const DISCOVER_APIS_DESCRIPTION = `Return this server's tool type definitions, the machine authoring contract, and worked examples. Call this before authoring a machine for execute_machine.`;

const SEARCH_TOOLS_DESCRIPTION = `List this server's tools, one page at a time, optionally matched against a query: the query is split into words, a tool matches if any word appears in its name, title or description, and matches are ranked (name hits weigh more), so a guessed name like create_issue or a phrase like "comment on a pull request" works. Each entry gives the tool's name, a one-line purpose, whether it runs immediately, asks the user for approval, or is blocked by policy, and whether the server marks it destructive. Call describe_tool before calling a tool whose arguments you have not seen.`;

const CALL_TOOL_DESCRIPTION = `Run one of this server's tools by name with a JSON object of arguments. Call describe_tool first to see the tool's arguments. A tool marked "asks for approval" first asks the user to approve this exact call; a result with status "declined" means the user said no — nothing ran, and you must not retry the same call unless the user asks for it. Status "denied_by_policy" means the server's policy blocks the tool. For several steps, branching on results, or a workflow worth saving, author a machine and use execute_machine instead.`;

const DESCRIBE_TOOL_DESCRIPTION = `Return one tool's description, its input and output JSON Schemas, and its approval posture. Call this before call_tool. Pass types: true to also get the tool's generated TypeScript when authoring a machine for execute_machine.`;

const CATALOG_TOOL_COPY: CatalogToolCopy = {
  searches: [
    {
      title: 'Search the tool catalog',
      description: SEARCH_TOOLS_DESCRIPTION,
      query:
        'Words to match against tool names, titles and descriptions; any word matches, name hits weigh more.',
    },
  ],
  describeDescription: DESCRIBE_TOOL_DESCRIPTION,
  callDescription: CALL_TOOL_DESCRIPTION,
  toolName: 'Tool name as listed by search_tools.',
  describeTypes: 'Also return the generated TypeScript for this tool (for authoring a machine).',
};

const CODE_MODE_COPY = {
  executeMachine: EXECUTE_MACHINE_DESCRIPTION,
  discoverApis: DISCOVER_APIS_DESCRIPTION,
};

/**
 * Wrap an MCP server — an in-process instance, a connected client, or a
 * remote server given by URL (`{ url, oauth? }`, R51) — into a Projection
 * facade.
 */
export async function wrapMcpServer(
  source: McpServer | Client | UpstreamSpec,
  options: WrapOptions,
): Promise<ProjectionFacade> {
  // Validate the selection, the approvals mode, the token store and a URL
  // source BEFORE connecting: the throw must not leave an in-process wrapped
  // server attached to a transport nobody will close.
  const projections = resolveProjections(options.projections);
  const approvals = assertApprovalsMode(options.approvals);
  const introspectTimeoutMs = resolveIntrospectTimeout(options.introspectTimeoutMs);
  const upstreamElicitation = assertUpstreamElicitationMode(options.upstreamElicitation);
  const tokenStore = tokenStoreOption(options.tokenStore);
  const connector = isUpstreamSpecShape(source)
    ? new UpstreamConnector(
        resolveUpstreamSpec(source, 'the wrapped server'),
        tokenStore(),
        'the wrapped server',
      )
    : undefined;

  const introspector = await createIntrospector(
    { [DEFAULT_SERVER_ALIAS]: connector ?? (source as McpServer | Client) },
    {
      timeoutMs: introspectTimeoutMs,
      describe: () => connector?.where ?? 'the wrapped server',
      ...(upstreamElicitation === 'forward'
        ? { forwardElicitation: new Set([DEFAULT_SERVER_ALIAS]) }
        : {}),
    },
  );
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

  // The policy settings (overrides + approvals mode) are snapshotted once,
  // here, and that one frozen copy feeds typegen AND the gate / catalog
  // tools: the posture baked into the `.d.ts` resource and the overview must
  // be the posture `describe_tool` and the approval gate decide with.
  const policySettings = freezePolicySettings({ policy: options.policy, approvals });

  const { dts, bridgeSource, overview, toolTypes } = generateToolTypes(catalog, policySettings);
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
    policySettings,
    projections,
    ...(connector !== undefined ? { connector } : {}),
  });
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
  /**
   * The wrap-time snapshot of `options.policy` and `options.approvals` (see
   * `WrapOptions`): the one context every surface decides policy with.
   */
  policySettings: PolicySettings;
  projections: Readonly<ProjectionSelection>;
  /** The source given by URL, when the facade wraps one (R51). */
  connector?: UpstreamConnector;
}

class Facade implements ProjectionFacade {
  readonly catalog: ServerCatalog;
  readonly instructions: string;
  readonly dts: string;
  readonly resources: ProjectionResource[];
  readonly serverFactory: McpServerFactory;
  readonly projections: Readonly<ProjectionSelection>;
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
    clientUrlElicitation?: boolean,
  ): Promise<ToolCallResult> {
    return executeMachine(args, {
      ...this.gateDeps(era, clientCanElicit, clientUrlElicitation),
      bridgeSource: this.deps.bridgeSource,
    });
  }

  callTool(
    args: CallToolArgs,
    era?: ProtocolEra,
    clientCanElicit?: boolean,
    clientUrlElicitation?: boolean,
  ): Promise<ToolCallResult> {
    return callTool(args, this.gateDeps(era, clientCanElicit, clientUrlElicitation));
  }

  /**
   * The approval-gate dependencies both gated tools share (R35, R38): one
   * place to wire the facade's options, so `execute_machine` and `call_tool`
   * can never drift on policy, redaction, caps or replay protection.
   */
  private gateDeps(
    era: ProtocolEra | undefined,
    clientCanElicit: boolean | undefined,
    clientUrlElicitation?: boolean,
  ): ApprovalGateDeps {
    return approvalGateDeps({
      catalog: this.deps.catalog,
      blobDomain: 'single',
      executor: this.deps.introspector,
      options: this.deps.options,
      policySettings: this.deps.policySettings,
      era,
      clientCanElicit,
      clientUrlElicitation,
    });
  }

  discoverApis(): CallToolResult {
    const { catalogInlineThreshold } = this.deps.options;
    return discoverApis(this.deps.catalog, this.deps.overview, {
      catalog: this.projections.catalog,
      ...(catalogInlineThreshold !== undefined ? { inlineThreshold: catalogInlineThreshold } : {}),
    });
  }

  searchTools(args: { query?: string; cursor?: string }): CallToolResult {
    try {
      return searchTools(this.deps.catalog, args, this.deps.policySettings);
    } catch (err) {
      return errorResult(toStructuredError(err));
    }
  }

  describeTool(args: { name: string; types?: boolean }): CallToolResult {
    try {
      return describeTool(this.deps.catalog, args, {
        ...this.deps.policySettings,
        toolTypes: this.deps.toolTypes,
      });
    } catch (err) {
      return errorResult(toStructuredError(err));
    }
  }

  /**
   * R29: `Server` accepts `instructions` only in its constructor, so the
   * preamble can be delivered from here and nowhere else. This is also where
   * the era arrives, which is why the factory shape is the library's
   * recommended entry point.
   */
  createServer(ctx?: RegisterOptions): McpServer {
    const server = createProjectionServer(
      this.deps.options,
      `projection-${this.deps.catalog.alias}`,
      this.instructions,
    );
    this.registerOn(server, ctx);
    return server;
  }

  registerOn(server: McpServer, options?: RegisterOptions): void {
    const era = options?.era;
    if (this.projections.codeMode) {
      registerCodeModeTools(server, era, this, CODE_MODE_COPY, this.catalog);
    }
    if (this.projections.catalog) registerCatalogTools(server, era, this, CATALOG_TOOL_COPY);
    registerResources(server, this.resources);
  }

  async signOut(alias?: string): Promise<void> {
    if (alias !== undefined) {
      throw new ProjectionError('validate', 'signOut on a single-server facade takes no alias', {
        hint: 'Call signOut() without arguments.',
      });
    }
    const connector = this.deps.connector;
    if (connector === undefined) {
      throw new ProjectionError(
        'validate',
        'signOut applies only to a facade over a server given by URL',
        {
          hint: 'This facade wraps a pre-built McpServer or Client, whose authorization its owner manages.',
        },
      );
    }
    await connector.signOut();
  }

  close(): Promise<void> {
    return this.deps.introspector.close();
  }
}
