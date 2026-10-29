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
 * - The catalog projection is one `search_<alias>` per box, whose
 *   empty-query first page leads with the box overview, then the global
 *   `search_tools` (switchable, `catalog.globalSearch`), `describe_tool` and
 *   `call_tool` (R43). The instructions are the multi-server preamble plus
 *   the shelf (R44); each box overview is also a resource (R45).
 * - Fail-closed wrapping, each source bounded by `introspectTimeoutMs`
 *   (R47); `optional` sources come later.
 */

import type { Client } from '@modelcontextprotocol/client';
import type { McpServer, McpServerFactory } from '@modelcontextprotocol/server';
import { tokenStoreOption, UpstreamConnector, type UpstreamSpec } from '../auth/index.js';
import { boxAbout, boxOverviewResources, toolCount } from '../catalog/box-guidance.js';
import {
  boxSearchTool,
  buildBoxedCatalog,
  toolApprovalsFor,
  type BoxedCatalog,
  type ToolBox,
} from '../catalog/boxes.js';
import { callTool, describeTool, searchBoxes, type CallToolArgs } from '../catalog/index.js';
import { searchToolsPhrase } from '../catalog/search.js';
import { ProjectionError, toStructuredError } from '../errors.js';
import {
  approvalGateDeps,
  freezePolicySettings,
  resolveIntrospectTimeout,
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
  type SearchToolCopy,
} from '../facade/server.js';
import { createIntrospector, type Introspector } from '../introspector/index.js';
import {
  APPROVAL_SENTENCE_TAIL,
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
  assertPolicyKeys,
  resolveCatalogOptions,
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
   * (R43). A search tool the facade does not serve — an unknown alias, or
   * `search_tools` under `catalog.globalSearch: false` — comes back as an
   * R25 `validate` error result.
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
  sources: Record<string, McpServer | Client | UpstreamSpec | ServerSourceConfig>,
  options: WrapServersOptions,
): Promise<MultiProjectionFacade> {
  // R39: every configuration mistake fails here, before any connection.
  assertOptionsGiven(options);
  const resolved = resolveSources(sources, tokenStoreOption(options.tokenStore));
  const aliases = new Set(resolved.map((source) => source.alias));
  assertPolicyKeys(options.policy, aliases);
  const approvals = assertApprovalsMode(options.approvals);
  const { globalSearch } = resolveCatalogOptions(options.catalog);
  const projections = resolveProjections(options.projections);
  const introspectTimeoutMs = resolveIntrospectTimeout(options.introspectTimeoutMs);

  const introspector = await introspect(resolved, introspectTimeoutMs);
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

    const view = buildBoxedCatalog(boxes, { globalSearch });
    const sourceModes = new Map<string, ApprovalsMode>();
    for (const source of resolved) {
      if (source.approvals !== undefined) sourceModes.set(source.alias, source.approvals);
    }
    const policySettings = freezePolicySettings({
      policy: options.policy,
      approvals,
      toolApprovals: toolApprovalsFor(view, sourceModes),
    });

    const upstreams = new Map<string, UpstreamConnector>();
    for (const source of resolved) {
      if (source.source instanceof UpstreamConnector) upstreams.set(source.alias, source.source);
    }
    // R45: one frozen policy snapshot feeds typegen and the gate, so the
    // postures in the .d.ts and the overview are the ones the gate decides.
    const { dts, bridgeSource, overview, toolTypes } = generateToolTypes(view, policySettings);

    return new MultiFacade({
      introspector,
      upstreams,
      view,
      dts,
      bridgeSource,
      overview,
      toolTypes,
      // The code-mode resources (R3, R45), then the box overviews (R43, R45).
      resources: [...buildResources(view, dts, policySettings), ...boxOverviewResources(view)],
      instructions: buildMultiInstructions(view, projections, options.codeModePreamble),
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
async function introspect(
  resolved: readonly ResolvedSource[],
  timeoutMs: number,
): Promise<Introspector> {
  const where = new Map(
    resolved.map((source) => [
      source.alias,
      source.source instanceof UpstreamConnector ? source.source.where : `source "${source.alias}"`,
    ]),
  );
  try {
    return await createIntrospector(
      Object.fromEntries(resolved.map((source) => [source.alias, source.source])),
      { timeoutMs, describe: (alias) => where.get(alias) ?? `source "${alias}"` },
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

/** What the multi-server preamble depends on (R29, R44). */
export interface MultiPreambleOptions {
  /** The projections the facade serves (R1). */
  projections: Readonly<ProjectionSelection>;
  /** Whether the global `search_tools` is served (R43). */
  globalSearch: boolean;
}

/**
 * The multi-server preamble (R29, R44, R45), one variant per projection
 * selection as the single-server `defaultPreamble`: the routing rule when
 * both projections are on, naming the search tools the facade serves (R43)
 * and that a box's own guidance is its overview.
 */
export function defaultMultiPreamble(options: MultiPreambleOptions): string {
  const { projections, globalSearch } = options;
  if (!projections.catalog) {
    return `This server fronts several toolboxes, each wrapping another server, and runs in code mode: instead of calling their tools directly, author an XState v5 state machine and run it with execute_machine, which orchestrates the tool calls for you, across boxes when the task needs it. Call discover_apis first for every box's tool types, the authoring contract, worked examples and each box's own guidance. Tools that change something may pause the machine ${APPROVAL_SENTENCE_TAIL}`;
  }
  // What to call, after a leading "call"/"Call".
  const find = globalSearch
    ? "search_tools to find a tool in any box, or a box's own search_<box> tool to look inside that box"
    : "a box's search_<box> tool to look inside that box";
  const steps = `${find}; without a query, a box's search lists the box and leads with its own guidance. Then call describe_tool to see a tool's arguments and call_tool to run it.`;
  if (!projections.codeMode) {
    return `This server fronts several toolboxes, each wrapping another server. Call ${steps} Tools that change something may pause ${APPROVAL_SENTENCE_TAIL}`;
  }
  return `This server fronts several toolboxes, each wrapping another server, and offers two ways to use their tools. For a single action, call ${steps} For several steps, branching on results, or a workflow worth saving, author an XState v5 state machine and run it with execute_machine (call discover_apis first for every box's tool types, the authoring contract, and worked examples). Either way, tools that change something may pause ${APPROVAL_SENTENCE_TAIL}`;
}

/**
 * The shelf header (R44) of a catalog-only facade. It carries the
 * qualified-name rule and names the per-box search tools, so a preamble
 * override cannot drop either.
 */
export const SHELF_HEADER =
  'Toolboxes — tools are named <box>.<tool>; search a box with its search_<box> tool, then pass the full name to describe_tool and call_tool:';

/**
 * The shelf header for a projection selection (R44, R45): the
 * qualified-name rule, worded for the tools that take a qualified name.
 */
export function shelfHeader(projections: Readonly<ProjectionSelection>): string {
  if (!projections.catalog) {
    return 'Toolboxes — tools are named <box>.<tool>; pass the full name to toolCall in a machine:';
  }
  if (!projections.codeMode) return SHELF_HEADER;
  return 'Toolboxes — tools are named <box>.<tool>; search a box with its search_<box> tool, then pass the full name to describe_tool, call_tool and toolCall:';
}

/**
 * The facade's `instructions` (R44): Projection's preamble, then the shelf —
 * one line per box in sorted alias order, `<alias> — <about> (<n> tools)`,
 * where the about is the host's description, else the server's first
 * sentence quoted and attributed, else nothing (see `boxAbout`). The wrapped
 * servers' full instructions are not in the system prompt: each is its
 * box's overview. `preamble` (`codeModePreamble`) replaces Projection's
 * copy; the shelf, header included, is always kept.
 */
export function buildMultiInstructions(
  view: BoxedCatalog,
  projections: Readonly<ProjectionSelection>,
  preamble?: string,
): string {
  const lines = [shelfHeader(projections)];
  for (const [alias, box] of view.boxes) {
    const about = boxAbout(box);
    const tools = toolCount(view.counts.get(alias) ?? 0);
    lines.push(about !== undefined ? `- ${alias} — ${about} (${tools})` : `- ${alias} (${tools})`);
  }
  const copy = preamble ?? defaultMultiPreamble({ projections, globalSearch: view.globalSearch });
  return `${copy}\n\n${lines.join('\n')}`;
}

const SEARCH_TOOLS_DESCRIPTION = `Search the tools of every toolbox at once, one page at a time, optionally matched against a query: the query is split into words, a tool matches if any word appears in its name, title or description, and matches are ranked (name hits weigh more); a word that is a box's name boosts that box's tools. Each entry gives the tool's qualified name (<box>.<tool>), its box, a one-line purpose, whether it runs immediately, asks the user for approval, or is blocked by policy, and whether the server marks it destructive. Call describe_tool before calling a tool whose arguments you have not seen.`;

const DESCRIBE_TOOL_DESCRIPTION = `Return one tool's description, its input and output JSON Schemas, and its approval posture, by its qualified name (<box>.<tool>). Call this before call_tool.`;

const CALL_TOOL_DESCRIPTION = `Run one tool from any toolbox by its qualified name (<box>.<tool>) with a JSON object of arguments. Call describe_tool first to see the tool's arguments. A tool marked "asks for approval" first asks the user to approve this exact call; a result with status "declined" means the user said no — nothing ran, and you must not retry the same call unless the user asks for it. Status "denied_by_policy" means the server's policy blocks the tool.`;

/** The catalog tools point at execute_machine only when code mode is served (R29). */
const DESCRIBE_TOOL_TYPES_POINTER = ` Pass types: true to also get the tool's generated TypeScript when authoring a machine for execute_machine.`;

const CALL_TOOL_CODE_MODE_POINTER = ` For several steps, branching on results, or a workflow worth saving, author a machine and use execute_machine instead.`;

const EXECUTE_MACHINE_DESCRIPTION = `Run an LLM-authored XState v5 state machine that orchestrates the tools of this server's toolboxes.

Author a module that default-exports a machine built with XState v5 setup(...).createMachine(...), and request tools with the toolCall action from '@astral-mcp/tools' by qualified name: toolCall('<box>.<tool>', args). One machine may use tools from several boxes. A tool marked "asks for approval" pauses the machine until the user approves that exact call, so handle TOOL_RESULT, TOOL_ERROR and TOOL_DENIED. Machine context must stay JSON-serializable, and invoke/fromPromise is rejected.

Call discover_apis first for the tool types, the full authoring contract, and worked examples.`;

const DISCOVER_APIS_DESCRIPTION = `Return the tool type definitions of every toolbox (tools.<box>.<tool>), the machine authoring contract, worked examples and each box's guidance. Call this before authoring a machine for execute_machine.`;

const CODE_MODE_COPY = {
  executeMachine: EXECUTE_MACHINE_DESCRIPTION,
  discoverApis: DISCOVER_APIS_DESCRIPTION,
};

/**
 * The `search_<alias>` copy (R43): `Search the <alias> toolbox.`, the box's
 * about (host description, else the server's attributed first sentence),
 * its tool count, then how the search works.
 */
function boxSearchCopy(view: BoxedCatalog, alias: string, box: ToolBox): SearchToolCopy {
  const about = boxAbout(box);
  const head = [
    `Search the ${alias} toolbox.`,
    ...(about !== undefined ? [about] : []),
    `(${toolCount(view.counts.get(alias) ?? 0)})`,
  ].join(' ');
  return {
    alias,
    title: `Search the ${alias} toolbox`,
    description: `${head}\n\nLists this box's tools one page at a time, optionally matched against a query: the query is split into words, a tool matches if any word appears in its name, title or description, and matches are ranked (name hits weigh more). Each entry gives the tool's qualified name (${alias}.<tool>), a one-line purpose, whether it runs immediately, asks the user for approval, or is blocked by policy, and whether the server marks it destructive. Without a query, the first page leads with the box's own guidance, when its server gives any. Call describe_tool before calling a tool whose arguments you have not seen.`,
    query: `Words to match against the ${alias} box's tool names, titles and descriptions; any word matches, name hits weigh more. Omit it to list the box, its guidance first.`,
  };
}

/** The global `search_tools` copy (R43). */
const GLOBAL_SEARCH_COPY: SearchToolCopy = {
  title: 'Search the tool catalog',
  description: SEARCH_TOOLS_DESCRIPTION,
  query:
    "Words to match against tool names, titles and descriptions; any word matches, name hits weigh more, and a box's name boosts that box's tools.",
};

/**
 * The catalog tools' copy for a view (R43): a `search_<alias>` per box, then
 * `search_tools` when the view serves it — `view.globalSearch` is the one
 * source of truth — and every search tool the copy names is served.
 */
function catalogToolCopy(
  view: BoxedCatalog,
  projections: Readonly<ProjectionSelection>,
): CatalogToolCopy {
  return {
    searches: [
      ...[...view.boxes].map(([alias, box]) => boxSearchCopy(view, alias, box)),
      ...(view.globalSearch ? [GLOBAL_SEARCH_COPY] : []),
    ],
    describeDescription: projections.codeMode
      ? `${DESCRIBE_TOOL_DESCRIPTION}${DESCRIBE_TOOL_TYPES_POINTER}`
      : DESCRIBE_TOOL_DESCRIPTION,
    callDescription: projections.codeMode
      ? `${CALL_TOOL_DESCRIPTION}${CALL_TOOL_CODE_MODE_POINTER}`
      : CALL_TOOL_DESCRIPTION,
    toolName: view.globalSearch
      ? 'Qualified tool name (<box>.<tool>) as listed by search_tools or a search_<box> tool.'
      : 'Qualified tool name (<box>.<tool>) as listed by the search_<box> tool of its box.',
    describeTypes:
      'Also return the generated TypeScript for this tool: its member of tools.<box> and its type aliases (for authoring a machine).',
  };
}

interface MultiFacadeDeps {
  introspector: Introspector;
  /** The boxes given by URL (R51), by alias. */
  upstreams: ReadonlyMap<string, UpstreamConnector>;
  view: BoxedCatalog;
  /** Generated artifacts over the view (R45): `tools.<alias>` per box, qualified names. */
  dts: string;
  bridgeSource: string;
  overview: string;
  /** Per-tool type slices keyed by qualified name, for `describe_tool` (R34, R45). */
  toolTypes: Map<string, ToolTypeText>;
  /** The code-mode resources and the box overviews (R3, R45). */
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
  /** The code-mode resources, then one box overview per box whose server sends instructions (R3, R45). */
  readonly resources: ProjectionResource[];
  readonly serverFactory: McpServerFactory;
  readonly projections: Readonly<ProjectionSelection>;
  private readonly deps: MultiFacadeDeps;
  private readonly copy: CatalogToolCopy;

  constructor(deps: MultiFacadeDeps) {
    this.deps = deps;
    this.catalog = deps.introspector.catalog;
    this.dts = deps.dts;
    this.resources = deps.resources;
    this.copy = catalogToolCopy(deps.view, deps.projections);
    this.instructions = deps.instructions;
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
      // R37 pointer: the search tools actually served (R43).
      searchPhrase: searchToolsPhrase(this.deps.view),
      // Links every resource but the dashboard, box overviews included (R45).
      resources: this.resources,
      // The samples are picked under the facade's policy (R45).
      policy: this.deps.policySettings,
      ...(catalogInlineThreshold !== undefined ? { inlineThreshold: catalogInlineThreshold } : {}),
    });
  }

  searchTools(args: { query?: string; cursor?: string }, alias?: string): CallToolResult {
    const view = this.deps.view;
    try {
      if (alias !== undefined ? !view.boxes.has(alias) : !view.globalSearch) {
        // Quoted either way: an unknown alias is caller input, rendered inert.
        const tool = JSON.stringify(
          alias !== undefined
            ? boxSearchTool(capLength(neutralizeControlChars(alias), 64))
            : 'search_tools',
        );
        throw new ProjectionError('validate', `${tool} is not served by this facade`, {
          hint: `Call ${searchToolsPhrase(view)} instead.`,
        });
      }
      return searchBoxes(view, args, {
        ...this.deps.policySettings,
        ...(alias !== undefined ? { box: alias } : {}),
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
      registerCatalogTools(server, era, this, this.copy);
    }
    registerResources(server, this.resources);
  }

  async signOut(alias?: string): Promise<void> {
    const upstreams = this.deps.upstreams;
    if (alias === undefined) {
      if (upstreams.size === 0) {
        throw new ProjectionError('validate', 'signOut: no box on this facade is given by URL', {
          hint: 'signOut applies to sources given as { url }; pre-built McpServer and Client sources manage their own authorization.',
        });
      }
      // Every box, even when one fails; the first failure is reported.
      const settled = await Promise.allSettled([...upstreams.values()].map((box) => box.signOut()));
      const failed = settled.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failed !== undefined) throw failed.reason;
      return;
    }
    const connector = typeof alias === 'string' ? upstreams.get(alias) : undefined;
    if (connector === undefined) {
      const name = JSON.stringify(capLength(neutralizeControlChars(String(alias)), 64));
      throw new ProjectionError(
        'validate',
        this.deps.view.boxes.has(String(alias))
          ? `signOut: box ${name} is not given by URL`
          : `signOut: no box ${name} on this facade`,
        {
          hint:
            upstreams.size > 0
              ? `Boxes given by URL: ${[...upstreams.keys()].join(', ')}.`
              : 'No box on this facade is given by URL.',
        },
      );
    }
    await connector.signOut();
  }

  close(): Promise<void> {
    return this.deps.introspector.close();
  }
}
