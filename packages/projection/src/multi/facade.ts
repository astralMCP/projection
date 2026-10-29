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
 * Scope of this release, by design (the rest of §6.9 lands in follow-ups):
 *
 * - Catalog projection only. Code mode (typegen namespaces per box, R45) is
 *   not served yet, so `projections.codeMode` defaults to off here and
 *   `true` fails the wrap.
 * - One global `search_tools` across every box (R43). The per-box
 *   `search_<alias>` tools, box overviews and the full shelf (R43–R45) come
 *   later; the instructions carry a minimal shelf meanwhile.
 * - Fail-closed wrapping only; `optional` sources and `introspectTimeoutMs`
 *   (R47) come later.
 */

import type { Client } from '@modelcontextprotocol/client';
import type { McpServer, McpServerFactory } from '@modelcontextprotocol/server';
import { buildBoxedCatalog, type BoxedCatalog, type ToolBox } from '../catalog/boxes.js';
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
  registerResources,
  type CatalogToolCopy,
} from '../facade/server.js';
import { createIntrospector, type Introspector } from '../introspector/index.js';
import {
  errorResult,
  type CallToolResult,
  type ProjectionResource,
  type ProjectionSelection,
  type ProtocolEra,
  type ToolCallResult,
} from '../mrtr/index.js';
import { assertApprovalsMode } from '../policy/index.js';
import { capLength, neutralizeControlChars } from '../text-safety.js';
import type { ApprovalsMode, StructuredError, ToolCatalog } from '../types.js';
import type { ProjectionFacade } from '../wrap.js';
import {
  assertCatalogOptions,
  assertPolicyKeys,
  resolveSources,
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
  const resolved = resolveSources(sources);
  const aliases = new Set(resolved.map((source) => source.alias));
  assertPolicyKeys(options.policy, aliases);
  const approvals = assertApprovalsMode(options.approvals);
  assertCatalogOptions(options.catalog);
  const projections = resolveMultiProjections(options);

  const introspector = await createIntrospector(
    Object.fromEntries(resolved.map((source) => [source.alias, source.source])),
  );
  let boxes: ToolBox[];
  try {
    boxes = resolved.map((source) => {
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
  } catch (err) {
    await introspector.close();
    throw err;
  }

  const view = buildBoxedCatalog(boxes);
  const sourceApprovals = new Map<string, ApprovalsMode>();
  for (const source of resolved) {
    if (source.approvals !== undefined) sourceApprovals.set(source.alias, source.approvals);
  }
  const policySettings = freezePolicySettings({
    policy: options.policy,
    approvals,
    sourceApprovals,
  });

  return new MultiFacade({
    introspector,
    view,
    instructions: buildMultiInstructions(view, options.codeModePreamble),
    options,
    policySettings,
    projections,
  });
}

/**
 * R45: code mode on a multi-server facade needs per-box typegen, which is
 * not built yet — so it defaults off here and an explicit request fails the
 * wrap rather than serving a code mode whose types do not match its names.
 * TODO(R45): default code mode on once typegen emits `tools.<alias>`.
 */
function resolveMultiProjections(options: WrapServersOptions): Readonly<ProjectionSelection> {
  if (options.projections?.codeMode === true) {
    throw new ProjectionError(
      'validate',
      'code mode is not supported on multi-server facades yet',
      {
        hint: 'Omit projections.codeMode: a wrapMcpServers facade serves the catalog projection (search_tools, describe_tool, call_tool).',
      },
    );
  }
  return resolveProjections(options.projections, { codeMode: false, catalog: true });
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
export const DEFAULT_MULTI_CATALOG_PREAMBLE = `This server fronts several toolboxes, each wrapping another server. Call search_tools to find a tool in any box, describe_tool to see its arguments, then call_tool to run it. Any tool that is not read-only pauses and asks the user to approve that specific action before it runs.`;

/**
 * The facade's `instructions` (R44): Projection's preamble, then the shelf.
 * The wrapped servers' own instructions are not forwarded. `preamble`
 * replaces Projection's copy; the shelf, header included, is always kept.
 *
 * TODO(PR3): the full R44 shelf — a box without a description shows the
 * first sentence of its server's instructions, attributed, and the preamble
 * names the per-box search tools and the box overviews.
 */
export function buildMultiInstructions(view: BoxedCatalog, preamble?: string): string {
  const lines = [
    'Toolboxes — tools are named <box>.<tool>; pass that full name to describe_tool and call_tool:',
  ];
  for (const [alias, box] of view.boxes) {
    let count = 0;
    for (const member of view.members.values()) if (member.alias === alias) count += 1;
    const tools = `${count} ${count === 1 ? 'tool' : 'tools'}`;
    // The description is host-trusted, neutralized and capped at wrap time.
    lines.push(
      box.description !== undefined
        ? `- ${alias} — ${box.description} (${tools})`
        : `- ${alias} (${tools})`,
    );
  }
  return `${preamble ?? DEFAULT_MULTI_CATALOG_PREAMBLE}\n\n${lines.join('\n')}`;
}

const SEARCH_TOOLS_DESCRIPTION = `Search the tools of every toolbox at once, one page at a time, optionally matched against a query: the query is split into words, a tool matches if any word appears in its name, title or description, and matches are ranked (name hits weigh more); a word that is a box's name ranks that box's tools first. Each entry gives the tool's qualified name (<box>.<tool>), its box, a one-line purpose, whether it runs immediately, asks the user for approval, or is blocked by policy, and whether the server marks it destructive. Call describe_tool before calling a tool whose arguments you have not seen.`;

const DESCRIBE_TOOL_DESCRIPTION = `Return one tool's description, its input and output JSON Schemas, and its approval posture, by its qualified name (<box>.<tool>). Call this before call_tool.`;

// TODO(R45): point at execute_machine for multi-step work once code mode is served here.
const CALL_TOOL_DESCRIPTION = `Run one tool from any toolbox by its qualified name (<box>.<tool>) with a JSON object of arguments. Call describe_tool first to see the tool's arguments. Read-only tools run immediately. Any other tool first asks the user to approve this exact call; a result with status "declined" means the user said no — nothing ran, and you must not retry the same call unless the user asks for it. Status "denied_by_policy" means the server's policy blocks the tool.`;

const CATALOG_TOOL_COPY: CatalogToolCopy = {
  searchDescription: SEARCH_TOOLS_DESCRIPTION,
  searchQuery:
    "Words to match against tool names, titles and descriptions; any word matches, name hits weigh more, and a box's name ranks that box first.",
  describeDescription: DESCRIBE_TOOL_DESCRIPTION,
  callDescription: CALL_TOOL_DESCRIPTION,
  toolName: 'Qualified tool name (<box>.<tool>) as listed by search_tools.',
};

interface MultiFacadeDeps {
  introspector: Introspector;
  view: BoxedCatalog;
  instructions: string;
  options: WrapServersOptions;
  policySettings: PolicySettings;
  projections: Readonly<ProjectionSelection>;
}

class MultiFacade implements MultiProjectionFacade {
  readonly catalog: ToolCatalog;
  readonly skipped: readonly { alias: string; error: StructuredError }[] = Object.freeze([]);
  readonly instructions: string;
  /** TODO(R45): the per-box `.d.ts`, once typegen emits `tools.<alias>`. */
  readonly dts = '';
  /** TODO(R45): the code-mode resources and the box overviews (R3). */
  readonly resources: ProjectionResource[] = [];
  readonly serverFactory: McpServerFactory;
  readonly projections: Readonly<ProjectionSelection>;
  private readonly deps: MultiFacadeDeps;

  constructor(deps: MultiFacadeDeps) {
    this.deps = deps;
    this.catalog = deps.introspector.catalog;
    this.instructions = deps.instructions;
    this.projections = deps.projections;
    // Bound so it can be handed to `createMcpHandler` detached.
    this.serverFactory = (ctx) => this.createServer(ctx);
  }

  executeMachine(): Promise<ToolCallResult> {
    return Promise.resolve(codeModeUnavailable('execute_machine'));
  }

  discoverApis(): CallToolResult {
    return codeModeUnavailable('discover_apis');
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
      return describeTool(this.deps.view, args, this.deps.policySettings);
    } catch (err) {
      return errorResult(toStructuredError(err));
    }
  }

  callTool(
    args: CallToolArgs,
    era?: ProtocolEra,
    clientCanElicit?: boolean,
  ): Promise<ToolCallResult> {
    return callTool(
      args,
      approvalGateDeps({
        catalog: this.deps.view,
        // Routed per call by qualified name (catalog/boxes.ts `routeCall`).
        executor: this.deps.introspector,
        options: this.deps.options,
        policySettings: this.deps.policySettings,
        era,
        clientCanElicit,
      }),
    );
  }

  createServer(ctx?: RegisterOptions): McpServer {
    const server = createProjectionServer(this.deps.options, 'projection-multi', this.instructions);
    this.registerOn(server, ctx);
    return server;
  }

  registerOn(server: McpServer, options?: RegisterOptions): void {
    // Code mode is never on here yet (R45; see resolveMultiProjections).
    if (this.projections.catalog) {
      registerCatalogTools(server, options?.era, this, CATALOG_TOOL_COPY);
    }
    registerResources(server, this.resources);
  }

  close(): Promise<void> {
    return this.deps.introspector.close();
  }
}

/** R45: code mode is not served on a multi-server facade yet. */
function codeModeUnavailable(tool: string): CallToolResult {
  return errorResult(
    new ProjectionError(
      'validate',
      `${tool} is not available: code mode is not supported on multi-server facades yet`,
      { hint: 'Use search_tools, describe_tool and call_tool.' },
    ).toStructured(),
  );
}
