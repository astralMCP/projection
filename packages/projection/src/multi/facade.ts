/**
 * `wrapMcpServers` — one facade over several wrapped servers, each a **tool
 * box** under an integrator-chosen alias (PRD §6.9, R39–R49; DECISIONS D16).
 *
 * ```ts
 * const facade = await wrapMcpServers(
 *   { fs: fsServer, github: { source: githubClient, description: 'Issues and PRs' } },
 *   { blob: { key } },
 * );
 * export default createMcpHandler(facade.serverFactory);
 * ```
 *
 * Every tool is addressed by its qualified name `<alias>.<name>` (R40) on
 * every surface; the gate, the policy engine, the blob sealer and the MRTR
 * adapter are the single-server ones, run over the merged view built by
 * `catalog/boxes.ts`. Blobs bind the server-set identity and are sealed in
 * their own key domain (R41).
 *
 * Both projections are served, as on a single-server facade: code mode
 * generates one `tools.<alias>` object type per box and machines call
 * `toolCall('<alias>.<name>', …)`, routed by alias (R45).
 *
 * Scope of this release, by design (the rest of §6.9 lands in follow-ups):
 *
 * - One global `search_tools` across every box (R43). The per-box
 *   `search_<alias>` tools, box overviews and the full shelf (R43–R45) come
 *   later; the instructions carry a minimal shelf meanwhile.
 * - Fail-closed wrapping only; `optional` sources and `introspectTimeoutMs`
 *   (R47) come later.
 */

import type { Client } from '@modelcontextprotocol/client';
import type { McpServer, McpServerFactory } from '@modelcontextprotocol/server';
import {
  buildBoxedCatalog,
  toolApprovalsFor,
  type BoxedCatalog,
  type ToolBox,
} from '../catalog/boxes.js';
import { callTool, describeTool, searchBoxes, type CallToolArgs } from '../catalog/index.js';
import { ProjectionError, toStructuredError } from '../errors.js';
import {
  approvalGateDeps,
  freezePolicySettings,
  resolveProjections,
  type PolicySettings,
  type RegisterOptions,
} from '../facade/options.js';
import {
  createProjectionServer,
  registerCatalogTools,
  registerCodeModeTools,
  registerResources,
  type CatalogToolCopy,
} from '../facade/server.js';
import { createIntrospector, type Introspector } from '../introspector/index.js';
import {
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
} from '../mrtr/index.js';
import { assertApprovalsMode } from '../policy/index.js';
import { capLength, neutralizeControlChars } from '../text-safety.js';
import { MCP_SDK_VERSION } from '../blob/versions.js';
import { generateToolTypes, type ToolTypeText } from '../typegen/index.js';
import { isRecord, type ApprovalsMode, type StructuredError, type ToolCatalog } from '../types.js';
import type { ProjectionFacade } from '../wrap.js';
import {
  assertCatalogOptions,
  assertPolicyKeys,
  resolveSources,
  type ResolvedSource,
  type ServerSourceConfig,
  type WrapServersOptions,
} from './config.js';

/** A facade holds at most this many tools across all boxes (R48). */
export const MAX_FACADE_TOOLS = 4_000;

/**
 * A multi-server facade (R39): every {@link ProjectionFacade} member, with
 * `catalog` the alias-keyed catalog of the wrapped boxes (bare names),
 * `skipped` the optional sources that were skipped (R47), `searchTools`
 * taking an optional alias, and `describeTool` / `callTool` taking
 * qualified names.
 */
export interface MultiProjectionFacade extends Omit<ProjectionFacade, 'catalog' | 'searchTools'> {
  /** The wrapped boxes' catalogs, keyed by alias, with the servers' own tool names (R30). */
  readonly catalog: ToolCatalog;
  /**
   * Optional sources skipped at wrap time (R47). Always empty for now:
   * optional sources are not supported yet, so every source is wrapped or
   * the wrap fails.
   */
  readonly skipped: readonly { alias: string; error: StructuredError }[];
  /**
   * Run `search_<alias>` when `alias` is given, `search_tools` otherwise
   * (R43). A search tool the facade does not serve comes back as an R25
   * `validate` error result; the per-box tools are not served yet.
   */
  searchTools(args: { query?: string; cursor?: string }, alias?: string): CallToolResult;
}

/**
 * Wrap several MCP servers (in-process instances, connected clients, or
 * `{ source, … }` configurations) into one Projection facade, each under
 * its alias (R39). Configuration mistakes are `validate` errors raised
 * before anything connects; a source that fails to connect or introspect
 * fails the wrap and closes every connection Projection opened (R47).
 */
export async function wrapMcpServers(
  sources: Record<string, McpServer | Client | ServerSourceConfig>,
  options: WrapServersOptions,
): Promise<MultiProjectionFacade> {
  // R39: every configuration mistake fails here, before any connection.
  assertOptionsGiven(options);
  const resolved = resolveSources(sources);
  const aliases = new Set(resolved.map((source) => source.alias));
  assertPolicyKeys(options.policy, aliases);
  const approvals = assertApprovalsMode(options.approvals);
  assertCatalogOptions(options.catalog);
  const projections = resolveProjections(options.projections);

  const introspector = await introspect(resolved);
  // R47 fail-closed: anything that throws once the sources are connected
  // closes every connection Projection opened (caller-owned Clients stay open).
  try {
    const boxes = resolved.map((source): ToolBox => {
      const catalog = introspector.catalog.servers.get(source.alias);
      if (catalog === undefined) {
        throw new ProjectionError(
          'protocol',
          `introspection produced no catalog for source "${source.alias}"`,
          { hint: 'Check that the wrapped server initialized successfully.' },
        );
      }
      return {
        alias: source.alias,
        catalog,
        ...(source.description !== undefined ? { description: source.description } : {}),
      };
    });
    assertToolTotal(boxes);

    const view = buildBoxedCatalog(boxes);
    const sourceModes = new Map<string, ApprovalsMode>();
    for (const source of resolved) {
      if (source.approvals !== undefined) sourceModes.set(source.alias, source.approvals);
    }
    const policySettings = freezePolicySettings({
      policy: options.policy,
      approvals,
      toolApprovals: toolApprovalsFor(view, sourceModes),
    });

    // R45: one frozen policy snapshot feeds typegen and the gate, so the
    // postures in the .d.ts and the overview are the ones the gate decides.
    const { dts, bridgeSource, overview, toolTypes } = generateToolTypes(view, policySettings);

    return new MultiFacade({
      introspector,
      view,
      dts,
      bridgeSource,
      overview,
      toolTypes,
      resources: buildResources(view, dts),
      instructions: buildMultiInstructions(view, options.codeModePreamble, projections),
      options,
      policySettings,
      projections,
    });
  } catch (err) {
    await introspector.close();
    throw err;
  }
}

/**
 * R39: the options are required — `blob.key` seals every approval — and a
 * missing object would otherwise surface as a `TypeError` deep in the wrap.
 */
function assertOptionsGiven(options: unknown): asserts options is WrapServersOptions {
  const blob: unknown = isRecord(options) ? options['blob'] : undefined;
  if (!isRecord(blob) || blob['key'] === undefined) {
    throw new ProjectionError('validate', 'wrapMcpServers needs options with blob.key', {
      hint: 'Pass wrapMcpServers(sources, { blob: { key } }) with a 32-byte secret key: every approval is sealed with it (R22).',
    });
  }
}

/**
 * Connect and introspect every source (R47: all settle, then any failure
 * fails the wrap and closes what Projection opened). A duck-typed source —
 * not an `McpServer` or `Client` from Projection's SDK copy — that fails
 * with anything but a {@link ProjectionError} is reported as a pointed
 * `protocol` error naming it, not as the SDK's raw `TypeError`.
 */
async function introspect(resolved: readonly ResolvedSource[]): Promise<Introspector> {
  try {
    return await createIntrospector(
      Object.fromEntries(resolved.map((source) => [source.alias, source.source])),
    );
  } catch (err) {
    const foreign = resolved.filter((source) => !source.sdk).map((source) => source.alias);
    if (err instanceof ProjectionError || foreign.length === 0) throw err;
    const named = foreign.map((alias) => `"${alias}"`).join(', ');
    throw new ProjectionError(
      'protocol',
      foreign.length === 1
        ? `source ${named} failed to connect or introspect: it is not an McpServer or a Client from the MCP SDK Projection uses`
        : `a source failed to connect or introspect; ${named} are not McpServer or Client instances from the MCP SDK Projection uses`,
      {
        hint: `Pass an McpServer instance or a connected Client from @modelcontextprotocol/server / @modelcontextprotocol/client ${MCP_SDK_VERSION} (a single installed copy).`,
        cause: err,
      },
    );
  }
}

/** R48: the facade-wide tool bound, checked after introspection. */
function assertToolTotal(boxes: readonly ToolBox[]): void {
  const total = boxes.reduce((sum, box) => sum + box.catalog.tools.length, 0);
  if (total > MAX_FACADE_TOOLS) {
    throw new ProjectionError(
      'protocol',
      `the wrapped servers declare ${total} tools together, over the facade limit of ${MAX_FACADE_TOOLS}`,
      {
        hint: `Wrap fewer or smaller servers per facade: a facade holds at most ${MAX_FACADE_TOOLS} tools across all boxes.`,
      },
    );
  }
}

/** The multi-server preamble (R44) for the catalog projection, naming the served search tool. */
export const DEFAULT_MULTI_CATALOG_PREAMBLE = `This server fronts several toolboxes, each wrapping another server. Call search_tools to find a tool in any box, describe_tool to see its arguments, then call_tool to run it. Tools that change something may pause and ask the user to approve that specific action before it runs; each tool's listing says whether it runs immediately or asks for approval.`;

/** The multi-server preamble (R44) when only code mode is on (R29, R45). */
export const DEFAULT_MULTI_CODE_MODE_PREAMBLE = `This server fronts several toolboxes, each wrapping another server, and runs in code mode: instead of calling their tools directly, author an XState v5 state machine and run it with execute_machine, which orchestrates the tool calls for you, across boxes when the task needs it. Tools that change something may pause the machine and ask the user to approve that specific action before it runs; each tool's listing says whether it runs immediately or asks for approval. Call discover_apis first for every box's tool types, the authoring contract, and worked examples.`;

/** The multi-server preamble (R44) when both projections are on: the routing rule (R29, R45). */
export const DEFAULT_MULTI_ROUTING_PREAMBLE = `This server fronts several toolboxes, each wrapping another server, and offers two ways to use their tools. For a single action, call search_tools to find a tool in any box, describe_tool to see its arguments, then call_tool to run it. For several steps, branching on results, or a workflow worth saving, author an XState v5 state machine and run it with execute_machine (call discover_apis first for every box's tool types, the authoring contract, and worked examples). Either way, tools that change something may pause and ask the user to approve that specific action before it runs; each tool's listing says whether it runs immediately or asks for approval.`;

/** The R44 preamble variant for a projection selection. */
function defaultMultiPreamble(projections: ProjectionSelection): string {
  if (projections.codeMode && projections.catalog) return DEFAULT_MULTI_ROUTING_PREAMBLE;
  if (projections.catalog) return DEFAULT_MULTI_CATALOG_PREAMBLE;
  return DEFAULT_MULTI_CODE_MODE_PREAMBLE;
}

/**
 * The shelf header (R44): the qualified-name rule, worded for the tools the
 * facade serves. It belongs to the shelf, so a `codeModePreamble` override
 * never drops it.
 */
function shelfHeader(projections: ProjectionSelection): string {
  const takers =
    projections.codeMode && projections.catalog
      ? 'describe_tool, call_tool and toolCall'
      : projections.catalog
        ? 'describe_tool and call_tool'
        : 'toolCall in a machine';
  return `Toolboxes — tools are named <box>.<tool>; pass that full name to ${takers}:`;
}

/**
 * The facade's `instructions` (R44): Projection's preamble, then the shelf.
 * The wrapped servers' own instructions are not forwarded. `preamble`
 * replaces Projection's copy; the shelf, header included, is always kept.
 *
 * TODO(PR3): the full R44 shelf — a box without a description shows the
 * first sentence of its server's instructions, attributed, and the preamble
 * names the per-box search tools and the box overviews.
 */
export function buildMultiInstructions(
  view: BoxedCatalog,
  preamble?: string,
  projections: ProjectionSelection = { codeMode: true, catalog: true },
): string {
  const lines = [shelfHeader(projections)];
  for (const [alias, box] of view.boxes) {
    const count = view.counts.get(alias) ?? 0;
    const tools = `${count} ${count === 1 ? 'tool' : 'tools'}`;
    // The description is host-trusted, neutralized and capped at wrap time.
    lines.push(
      box.description !== undefined
        ? `- ${alias} — ${box.description} (${tools})`
        : `- ${alias} (${tools})`,
    );
  }
  return `${preamble ?? defaultMultiPreamble(projections)}\n\n${lines.join('\n')}`;
}

const SEARCH_TOOLS_DESCRIPTION = `Search the tools of every toolbox at once, one page at a time, optionally matched against a query: the query is split into words, a tool matches if any word appears in its name, title or description, and matches are ranked (name hits weigh more); a word that is a box's name boosts that box's tools. Each entry gives the tool's qualified name (<box>.<tool>), its box, a one-line purpose, whether it runs immediately, asks the user for approval, or is blocked by policy, and whether the server marks it destructive. Call describe_tool before calling a tool whose arguments you have not seen.`;

const DESCRIBE_TOOL_DESCRIPTION = `Return one tool's description, its input and output JSON Schemas, and its approval posture, by its qualified name (<box>.<tool>). Call this before call_tool.`;

const CALL_TOOL_DESCRIPTION = `Run one tool from any toolbox by its qualified name (<box>.<tool>) with a JSON object of arguments. Call describe_tool first to see the tool's arguments. A tool marked "asks for approval" first asks the user to approve this exact call; a result with status "declined" means the user said no — nothing ran, and you must not retry the same call unless the user asks for it. Status "denied_by_policy" means the server's policy blocks the tool.`;

/** The catalog tools point at execute_machine only when code mode is served (R29). */
const DESCRIBE_TOOL_TYPES_POINTER = ` Pass types: true to also get the tool's generated TypeScript when authoring a machine for execute_machine.`;

const CALL_TOOL_CODE_MODE_POINTER = ` For several steps, branching on results, or a workflow worth saving, author a machine and use execute_machine instead.`;

function catalogToolCopy(projections: ProjectionSelection): CatalogToolCopy {
  return {
    searchDescription: SEARCH_TOOLS_DESCRIPTION,
    searchQuery:
      "Words to match against tool names, titles and descriptions; any word matches, name hits weigh more, and a box's name boosts that box's tools.",
    describeDescription: projections.codeMode
      ? `${DESCRIBE_TOOL_DESCRIPTION}${DESCRIBE_TOOL_TYPES_POINTER}`
      : DESCRIBE_TOOL_DESCRIPTION,
    callDescription: projections.codeMode
      ? `${CALL_TOOL_DESCRIPTION}${CALL_TOOL_CODE_MODE_POINTER}`
      : CALL_TOOL_DESCRIPTION,
    toolName: 'Qualified tool name (<box>.<tool>) as listed by search_tools.',
    describeTypes:
      'Also return the generated TypeScript for this tool: its member of tools.<box> and its type aliases (for authoring a machine).',
  };
}

const EXECUTE_MACHINE_DESCRIPTION = `Run an LLM-authored XState v5 state machine that orchestrates the tools of this server's toolboxes.

Author a module that default-exports a machine built with XState v5 setup(...).createMachine(...), and request tools with the toolCall action from '@astral-mcp/tools' by qualified name: toolCall('<box>.<tool>', args). One machine may use tools from several boxes. A tool marked "asks for approval" pauses the machine until the user approves that exact call, so handle TOOL_RESULT, TOOL_ERROR and TOOL_DENIED. Machine context must stay JSON-serializable, and invoke/fromPromise is rejected.

Call discover_apis first for the tool types, the full authoring contract, and worked examples.`;

const DISCOVER_APIS_DESCRIPTION = `Return the tool type definitions of every toolbox (tools.<box>.<tool>), the machine authoring contract, and worked examples. Call this before authoring a machine for execute_machine.`;

const CODE_MODE_COPY = {
  executeMachine: EXECUTE_MACHINE_DESCRIPTION,
  discoverApis: DISCOVER_APIS_DESCRIPTION,
};

interface MultiFacadeDeps {
  introspector: Introspector;
  view: BoxedCatalog;
  /** Generated artifacts over the view (R45): `tools.<alias>` per box, qualified names. */
  dts: string;
  bridgeSource: string;
  overview: string;
  /** Per-tool type slices keyed by qualified name, for `describe_tool` (R34, R45). */
  toolTypes: Map<string, ToolTypeText>;
  resources: ProjectionResource[];
  instructions: string;
  options: WrapServersOptions;
  policySettings: PolicySettings;
  projections: Readonly<ProjectionSelection>;
}

class MultiFacade implements MultiProjectionFacade {
  readonly catalog: ToolCatalog;
  readonly skipped: readonly { alias: string; error: StructuredError }[] = Object.freeze([]);
  readonly instructions: string;
  readonly dts: string;
  readonly resources: ProjectionResource[];
  readonly serverFactory: McpServerFactory;
  readonly projections: Readonly<ProjectionSelection>;
  private readonly deps: MultiFacadeDeps;

  constructor(deps: MultiFacadeDeps) {
    this.deps = deps;
    this.catalog = deps.introspector.catalog;
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
    return executeMachine(args, {
      ...this.gateDeps(era, clientCanElicit),
      bridgeSource: this.deps.bridgeSource,
    });
  }

  discoverApis(): CallToolResult {
    const { catalogInlineThreshold } = this.deps.options;
    return discoverApis(this.deps.view, this.deps.overview, {
      catalog: this.projections.catalog,
      // TODO(multi-boxes): searchToolsPhrase(view) once #63 lands.
      searchPhrase: 'search_tools',
      resources: this.resources,
      ...(catalogInlineThreshold !== undefined ? { inlineThreshold: catalogInlineThreshold } : {}),
    });
  }

  searchTools(args: { query?: string; cursor?: string }, alias?: string): CallToolResult {
    try {
      if (alias !== undefined) {
        // TODO(PR3): serve search_<alias> (R43).
        throw new ProjectionError(
          'validate',
          `search_${capLength(neutralizeControlChars(alias), 64)} is not served by this facade`,
          { hint: 'Search every box with search_tools; per-box search tools are not served yet.' },
        );
      }
      return searchBoxes(this.deps.view, args, {
        ...this.deps.policySettings,
        tool: 'search_tools',
      });
    } catch (err) {
      return errorResult(toStructuredError(err));
    }
  }

  describeTool(args: { name: string; types?: boolean }): CallToolResult {
    try {
      return describeTool(this.deps.view, args, {
        ...this.deps.policySettings,
        toolTypes: this.deps.toolTypes,
      });
    } catch (err) {
      return errorResult(toStructuredError(err));
    }
  }

  callTool(
    args: CallToolArgs,
    era?: ProtocolEra,
    clientCanElicit?: boolean,
  ): Promise<ToolCallResult> {
    return callTool(args, this.gateDeps(era, clientCanElicit));
  }

  /**
   * The approval-gate dependencies both gated tools share (R35, R38, R45):
   * the merged view, the `multi` key domain (R41) — for machine blobs and
   * call blobs alike — and the frozen policy settings.
   */
  private gateDeps(
    era: ProtocolEra | undefined,
    clientCanElicit: boolean | undefined,
  ): ApprovalGateDeps {
    return approvalGateDeps({
      catalog: this.deps.view,
      blobDomain: 'multi',
      // Routed per call by qualified name (catalog/boxes.ts `routeCall`).
      executor: this.deps.introspector,
      options: this.deps.options,
      policySettings: this.deps.policySettings,
      era,
      clientCanElicit,
    });
  }

  createServer(ctx?: RegisterOptions): McpServer {
    const server = createProjectionServer(this.deps.options, 'projection-multi', this.instructions);
    this.registerOn(server, ctx);
    return server;
  }

  registerOn(server: McpServer, options?: RegisterOptions): void {
    const era = options?.era;
    if (this.projections.codeMode) {
      // The workflow prompts name the boxes by alias (R39): they read the view.
      registerCodeModeTools(server, era, this, CODE_MODE_COPY, this.deps.view);
    }
    if (this.projections.catalog) {
      registerCatalogTools(server, era, this, catalogToolCopy(this.projections));
    }
    registerResources(server, this.resources);
  }

  close(): Promise<void> {
    return this.deps.introspector.close();
  }
}
