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
import { boxAbout, boxOverview, boxOverviewResources, toolCount } from '../catalog/box-guidance.js';
import {
  boxSearchTool,
  buildBoxedCatalog,
  splitQualified,
  toolApprovalsFor,
  type BoxedCatalog,
  type ToolBox,
} from '../catalog/boxes.js';
import { callTool, describeTool, searchBoxes, type CallToolArgs } from '../catalog/index.js';
import {
  aliasList,
  findToolsSentence,
  listedBoxesSentence,
  searchToolsPhrase,
} from '../catalog/search.js';
import { ProjectionError, toStructuredError } from '../errors.js';
import {
  batchToolListChanged,
  distrustCatalog,
  distrustOverrides,
  guardedExecutor,
  HeldServers,
  ListChangeTracker,
  resolveFollowSettings,
  type FollowSettings,
} from '../facade/follow.js';
import {
  approvalGateDeps,
  assertUpstreamElicitationMode,
  assertApprovalPrompts,
  freezePolicySettings,
  resolveDirectSetting,
  resolveIntrospectTimeout,
  resolveProjections,
  type DirectSetting,
  type PolicySettings,
  type RegisterOptions,
} from '../facade/options.js';
import {
  createProjectionServer,
  registerCatalogTools,
  registerCodeModeTools,
  registerDirectTools,
  registerResources,
  reconcileHeldServer,
  sameDirectTools,
  type CatalogToolCopy,
  type HeldRegistration,
  type SearchToolCopy,
} from '../facade/server.js';
import {
  DIRECT_BOX_SEPARATOR,
  planDirectTools,
  selectDirectBoxes,
  reservedToolNames,
  type DirectTool,
} from '../facade/direct.js';
import {
  createIntrospector,
  type IntrospectedServer,
  type Introspector,
} from '../introspector/index.js';
import {
  APPROVAL_SENTENCE_TAIL,
  DIRECT_LISTING_SENTENCE,
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
import {
  assertApprovalsMode,
  assertPolicyRules,
  resolvePolicyRules,
  toolPolicyOf,
  type ToolPolicy,
} from '../policy/index.js';
import { capLength, neutralizeControlChars } from '../text-safety.js';
import { MCP_SDK_RANGE } from '../blob/versions.js';
import { generateToolTypes, type ToolTypeText } from '../typegen/index.js';
import {
  clampCaps,
  isRecord,
  type ApprovalsMode,
  type PolicyRule,
  type StructuredError,
  type ToolCatalog,
} from '../types.js';
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
  const policyRules = assertPolicyRules(options.policyRules);
  const approvals = assertApprovalsMode(options.approvals);
  assertApprovalPrompts(options.approvalPrompts);
  const { globalSearch } = resolveCatalogOptions(options.catalog);
  const selected = resolveProjections(options.projections);
  const direct = resolveDirectSetting(options.projections, selected.catalog);
  const introspectTimeoutMs = resolveIntrospectTimeout(options.introspectTimeoutMs);
  const follow = resolveFollowSettings(options.followListChanged);
  const facadeElicitation = assertUpstreamElicitationMode(options.upstreamElicitation);
  // G1: a box forwards its server's questions when its own setting, else
  // the facade's, says `forward`.
  const forwarding = new Set(
    resolved
      .filter((source) => (source.upstreamElicitation ?? facadeElicitation) === 'forward')
      .map((source) => source.alias),
  );

  const introspector = await introspect(resolved, introspectTimeoutMs, forwarding, follow.follow);
  // R47 fail-closed: anything that throws once the sources are connected
  // closes every connection Projection opened (caller-owned Clients stay open).
  try {
    const sourceModes = new Map<string, ApprovalsMode>();
    for (const source of resolved) {
      if (source.approvals !== undefined) sourceModes.set(source.alias, source.approvals);
    }
    const upstreams = new Map<string, UpstreamConnector>();
    for (const source of resolved) {
      if (source.source instanceof UpstreamConnector) upstreams.set(source.alias, source.source);
    }
    const surface: MultiSurface = {
      resolved,
      options,
      policyRules,
      approvals,
      globalSearch,
      selected,
      direct,
      sourceModes,
    };
    const snapshot = buildMultiSnapshot(introspector.catalog, surface);
    return new MultiFacade({
      introspector,
      upstreams,
      options,
      snapshot,
      surface: { ...surface, directBoxes: snapshot.directBoxes },
      follow,
    });
  } catch (err) {
    await introspector.close();
    throw err;
  }
}

/**
 * What a multi-server snapshot is built from besides the boxes' catalogs:
 * the validated options, and — after the first build — the boxes listed
 * directly, which a refresh never re-decides (R65).
 */
interface MultiSurface {
  resolved: readonly ResolvedSource[];
  options: WrapServersOptions;
  policyRules: readonly PolicyRule[] | undefined;
  approvals: ApprovalsMode | undefined;
  globalSearch: boolean;
  selected: Readonly<ProjectionSelection>;
  direct: DirectSetting;
  sourceModes: ReadonlyMap<string, ApprovalsMode>;
  /** The boxes listed directly; decided by the first build when absent. */
  directBoxes?: ReadonlySet<string>;
}

/** Everything a multi-server facade serves, derived from one set of box catalogs (R65 swaps it whole). */
interface MultiSnapshot {
  /** The wrapped boxes' catalogs, keyed by alias, with the servers' own names. */
  catalog: ToolCatalog;
  boxes: readonly ToolBox[];
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
  policySettings: PolicySettings;
  projections: Readonly<ProjectionSelection>;
  copy: CatalogToolCopy;
  directBoxes: ReadonlySet<string>;
  /** The direct-listing plan over every box (only `directBoxes`' tools are listed). */
  plan: readonly DirectTool[];
  /** The mediated tools listed directly (`projections.direct`); empty when not listed. */
  directTools: readonly DirectTool[];
  /** What the approval gate decides with; distrusts the dirty boxes (R65). */
  gate: { catalog: BoxedCatalog; policySettings: PolicySettings };
  /** The boxes trusted at build time, and every box's generation (R65). */
  trust: { trusted: ReadonlySet<string>; generations: ReadonlyMap<string, number> };
}

function buildMultiSnapshot(
  catalogs: ToolCatalog,
  surface: MultiSurface,
  previous?: MultiSnapshot,
): MultiSnapshot {
  const { resolved, options, globalSearch, direct } = surface;
  const boxes = resolved.map((source): ToolBox => {
    const catalog = catalogs.servers.get(source.alias);
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

  const planned = buildBoxedCatalog(boxes, { globalSearch });
  // Rules resolve over the qualified names (R42, D36), under the
  // facade's exact-name overrides, into the one frozen snapshot.
  const policySettings = freezePolicySettings({
    policy: resolvePolicyRules(planned, surface.policyRules, options.policy),
    approvals: surface.approvals,
    toolApprovals: toolApprovalsFor(planned, surface.sourceModes),
  });

  // Direct listing, per box: `<alias>__<tool>` aliases of call_tool,
  // planned under the frozen policy, never shadowing a Projection tool or
  // a search_<alias>. 'auto' fills the budget smallest box first; a box
  // that does not fit keeps its search tool and the catalog path.
  const plan =
    direct.mode === 'off'
      ? []
      : planDirectTools(planned, {
          ...policySettings,
          reserved: reservedToolNames([...planned.boxes.keys()].map(boxSearchTool)),
          ...(previous !== undefined ? { previous: previous.plan } : {}),
        });
  const directBoxes = surface.directBoxes ?? selectDirectBoxes(direct, plan);
  const view = viewOf(boxes, planned, directBoxes, globalSearch);

  // R45: one frozen policy snapshot feeds typegen and the gate, so the
  // postures in the .d.ts and the overview are the ones the gate decides.
  const { dts, bridgeSource, overview, toolTypes } = generateToolTypes(view, policySettings);

  const projections: Readonly<ProjectionSelection> =
    previous?.projections ??
    (directBoxes.size > 0
      ? Object.freeze({
          ...surface.selected,
          direct: true,
          // A frozen copy: the facade's own copy keeps reading the view.
          directBoxes: Object.freeze([...view.directBoxes]),
        })
      : surface.selected);

  return {
    catalog: { servers: new Map(boxes.map((box) => [box.alias, box.catalog])) },
    boxes,
    view,
    dts,
    bridgeSource,
    overview,
    toolTypes,
    // The code-mode resources (R3, R45), then the box overviews (R43, R45).
    resources: [
      ...buildResources(view, dts, policySettings, clampCaps(options.caps ?? {}).maxRoundTrips),
      ...boxOverviewResources(view),
    ],
    instructions: buildMultiInstructions(view, projections, options.codeModePreamble),
    policySettings,
    projections,
    copy: catalogToolCopy(view, projections),
    directBoxes,
    plan,
    directTools: plan.filter((tool) => tool.alias !== undefined && directBoxes.has(tool.alias)),
    gate: { catalog: view, policySettings },
    trust: {
      trusted: new Set(boxes.map((box) => box.alias)),
      generations: new Map(boxes.map((box) => [box.alias, 0])),
    },
  };
}

/**
 * The served view (R43): under direct listing, the surface lives on the
 * view, so every piece of copy that names a search tool or a listed box
 * reads one source of truth: a listed box keeps its search tool only to
 * read its guidance, and the global search is served while some box is
 * still searched for.
 */
function viewOf(
  boxes: readonly ToolBox[],
  planned: BoxedCatalog,
  directBoxes: ReadonlySet<string>,
  globalSearch: boolean,
): BoxedCatalog {
  if (directBoxes.size === 0) return planned;
  return buildBoxedCatalog(boxes, {
    globalSearch: globalSearch && directBoxes.size < planned.boxes.size,
    directBoxes: new Set(directBoxes),
    searchBoxes: [...planned.boxes]
      .filter(
        ([alias, box]) =>
          !directBoxes.has(alias) || boxOverview(box.catalog.instructions) !== undefined,
      )
      .map(([alias]) => alias),
  });
}

/**
 * `snapshot` with its gate distrusting the annotations and rule outcomes
 * of the boxes not in `trusted`, for while their tools/list_changed is
 * outstanding (R65). Every other box is decided exactly as before.
 */
function distrustMulti(
  snapshot: MultiSnapshot,
  surface: MultiSurface,
  trusted: ReadonlySet<string>,
): MultiSnapshot {
  const dirty = snapshot.boxes.filter((box) => !trusted.has(box.alias));
  if (dirty.length === 0) return snapshot;
  const boxes = snapshot.boxes.map((box) =>
    trusted.has(box.alias) ? box : { ...box, catalog: distrustCatalog(box.catalog) },
  );
  const planned = buildBoxedCatalog(boxes, { globalSearch: surface.globalSearch });
  const catalog = viewOf(boxes, planned, snapshot.directBoxes, surface.globalSearch);
  const { policy, approvals, toolApprovals } = snapshot.policySettings;
  const exact = surface.options.policy !== undefined ? { ...surface.options.policy } : undefined;
  const dirtyAliases = new Set(dirty.map((box) => box.alias));
  return {
    ...snapshot,
    gate: {
      catalog,
      policySettings: freezePolicySettings({
        policy: distrustOverrides(policy, exact, (name) => {
          const split = splitQualified(name);
          return split !== undefined && dirtyAliases.has(split.alias);
        }),
        approvals,
        ...(toolApprovals !== undefined ? { toolApprovals } : {}),
      }),
    },
  };
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
  forwardElicitation: ReadonlySet<string>,
  followListChanged: boolean,
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
      {
        timeoutMs,
        describe: (alias) => where.get(alias) ?? `source "${alias}"`,
        forwardElicitation,
        followListChanged,
      },
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
        hint: `Pass an McpServer instance or a connected Client from @modelcontextprotocol/server / @modelcontextprotocol/client ${MCP_SDK_RANGE} (a single installed copy, which Projection takes as a peer dependency).`,
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
  /**
   * Direct listing: the boxes listed directly as `<box>__<tool>` (none when
   * absent), and the boxes whose `search_<alias>` is served (every box when
   * absent): every box not listed, plus a listed box that sends guidance.
   */
  directBoxes?: readonly string[];
  searchBoxes?: readonly string[];
}

/**
 * Where a found tool's arguments come from (D32): a query's top hits show
 * them, so call_tool can follow the search directly.
 */
const ARGS_SENTENCE = "A query's top hits show their args; describe_tool gives any other tool's.";

/**
 * The multi-server preamble (R29, R44, R45), one variant per projection
 * selection as the single-server `defaultPreamble`: the routing rule when
 * both projections are on, naming the search tools the facade serves (R43)
 * and that a box's own guidance is its overview.
 */
export function defaultMultiPreamble(options: MultiPreambleOptions): string {
  const { projections, globalSearch } = options;
  const listed = options.directBoxes ?? [];
  if (listed.length > 0 && projections.catalog) {
    const searched = options.searchBoxes ?? [];
    const unlisted = searched.filter((alias) => !listed.includes(alias));
    const guidance = searched.filter((alias) => listed.includes(alias));
    const which =
      unlisted.length === 0
        ? "Every box's tools are"
        : listed.length === 1
          ? `The ${listed[0] ?? ''} box's tools are`
          : `The tools of the ${aliasList(listed)} boxes are`;
    const direct = `${which} listed directly, named <box>${DIRECT_BOX_SEPARATOR}<tool>: call them by name like any other tool, with no need to search or describe them first.`;
    const read =
      guidance.length === 0
        ? ''
        : ` To read a listed box's own guidance, call ${guidance.map(boxSearchTool).join(' or ')} without a query.`;
    const others =
      unlisted.length === 0
        ? ''
        : ` ${unlisted.length === 1 ? `The ${unlisted[0] ?? ''} box is` : `The ${aliasList(unlisted)} boxes are`} not listed: call ${unlisted.map(boxSearchTool).join(' or ')}${globalSearch ? ' (or search_tools, which searches every box)' : ''} to find a tool there — without a query, a box's search lists the box and leads with its own guidance — then call_tool to run it, with the args its search hit shows or describe_tool gives.`;
    const head = `This server fronts several toolboxes, each wrapping another server. ${direct}${read}${others}`;
    if (!projections.codeMode) return `${head} ${DIRECT_LISTING_SENTENCE}`;
    return `${head} For a single action or a short chain where you look something up and then act on it, call the tools one at a time, reading each result before the next. Author an XState v5 state machine and run it with execute_machine only when the work loops or branches over results, computes over a list (counting, filtering, summing, comparing or checking every item), takes many steps, or is a workflow worth saving (call discover_apis first for every box's tool types, the authoring contract, and worked examples). ${DIRECT_LISTING_SENTENCE}`;
  }
  if (!projections.catalog) {
    return `This server fronts several toolboxes, each wrapping another server, and runs in code mode: instead of calling their tools directly, author an XState v5 state machine and run it with execute_machine, which orchestrates the tool calls for you, across boxes when the task needs it. Call discover_apis first for every box's tool types, the authoring contract, worked examples and each box's own guidance. Tools that change something may pause the machine ${APPROVAL_SENTENCE_TAIL}`;
  }
  // What to call, after a leading "call"/"Call".
  const find = globalSearch
    ? "search_tools to find a tool in any box, or a box's own search_<box> tool to look inside that box"
    : "a box's search_<box> tool to look inside that box";
  const listing = `${find}; without a query, a box's search lists the box and leads with its own guidance.`;
  const steps = `${listing} ${ARGS_SENTENCE} Then run it with call_tool.`;
  if (!projections.codeMode) {
    return `This server fronts several toolboxes, each wrapping another server. Call ${steps} Tools that change something may pause ${APPROVAL_SENTENCE_TAIL}`;
  }
  return `This server fronts several toolboxes, each wrapping another server, and offers two ways to use their tools. For a single action or a short chain where you look something up and then act on it, call ${listing} ${ARGS_SENTENCE} Then use call_tool for each step, reading each result before the next. Author an XState v5 state machine and run it with execute_machine only when the work loops or branches over results, computes over a list (counting, filtering, summing, comparing or checking every item), takes many steps, or is a workflow worth saving (call discover_apis first for every box's tool types, the authoring contract, and worked examples). Either way, tools that change something may pause ${APPROVAL_SENTENCE_TAIL}`;
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
export function shelfHeader(
  projections: Readonly<ProjectionSelection>,
  everyBoxListed = false,
): string {
  const listed = projections.directBoxes ?? [];
  if (listed.length > 0 && projections.catalog) {
    const takers = `describe_tool, call_tool${projections.codeMode ? ' and toolCall' : ''}`;
    if (everyBoxListed) {
      return `Toolboxes — tools are listed as <box>${DIRECT_BOX_SEPARATOR}<tool>; ${takers} take the qualified name <box>.<tool>:`;
    }
    return `Toolboxes — tools are named <box>.<tool>; a box marked "listed directly" has its tools listed as <box>${DIRECT_BOX_SEPARATOR}<tool>, any other box is searched with its search_<box> tool; ${takers} take the qualified name <box>.<tool>:`;
  }
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
  const lines = [shelfHeader(projections, view.directBoxes.length === view.boxes.size)];
  for (const [alias, box] of view.boxes) {
    const about = boxAbout(box);
    // Marked only on a mixed facade: when every box is listed the header says so.
    const mixed = view.directBoxes.length > 0 && view.directBoxes.length < view.boxes.size;
    const listed = mixed && view.directBoxes.includes(alias) ? ', listed directly' : '';
    const tools = `${toolCount(view.counts.get(alias) ?? 0)}${listed}`;
    // D34: shared arguments lead a box's search pages, not the shelf: on the
    // shelf they read as facts the model must have before it acts (v16).
    lines.push(about !== undefined ? `- ${alias} — ${about} (${tools})` : `- ${alias} (${tools})`);
  }
  const copy =
    preamble ??
    defaultMultiPreamble({
      projections,
      globalSearch: view.globalSearch,
      directBoxes: view.directBoxes,
      searchBoxes: view.searchBoxes,
    });
  return `${copy}\n\n${lines.join('\n')}`;
}

const SEARCH_TOOLS_DESCRIPTION = `Search the tools of every toolbox at once, one page at a time, optionally matched against a query: the query is split into words, a tool matches if any word appears in its name, title or description, and matches are ranked (name hits weigh more); a word that is a box's name boosts that box's tools. Each entry gives the tool's qualified name (<box>.<tool>), its box, a one-line purpose, whether it runs immediately, asks the user for approval, or is blocked by policy, and whether the server marks it destructive; a query's top hits also show their args, enough to call call_tool directly. Call describe_tool before calling any other tool.`;

const DESCRIBE_TOOL_DESCRIPTION = `Return one tool's description, its input and output JSON Schemas, and its approval posture, by its qualified name (<box>.<tool>). Call this before call_tool when no search hit showed the tool's args, or to learn what an argument means.`;

const CALL_TOOL_DESCRIPTION = `Run one tool from any toolbox by its qualified name (<box>.<tool>) with a JSON object of arguments: the args a search hit shows, or those describe_tool gives. A tool marked "asks for approval" first asks the user to approve this exact call; a result with status "declined" means the user said no — nothing ran, and you must not retry the same call unless the user asks for it. Status "denied_by_policy" means the server's policy blocks the tool. Chains of a few calls are best done as successive call_tool calls, reading each result before the next.`;

/** The catalog tools point at execute_machine only when code mode is served (R29). */
const DESCRIBE_TOOL_TYPES_POINTER = ` Pass types: true to also get the tool's generated TypeScript when authoring a machine for execute_machine.`;

const CALL_TOOL_CODE_MODE_POINTER = ` For loops or branching over results, computing over a list (counting, filtering, summing, comparing or checking every item), many steps, or a workflow worth saving, author a machine and use execute_machine instead.`;

const EXECUTE_MACHINE_BODY = `Author a module that default-exports a machine built with XState v5 setup(...).createMachine(...), and request tools with the toolCall action from '@astral-mcp/tools' by qualified name: toolCall('<box>.<tool>', args). One machine may use tools from several boxes. A tool marked "asks for approval" pauses the machine until the user approves that exact call, so handle TOOL_RESULT, TOOL_ERROR and TOOL_DENIED. Machine context must stay JSON-serializable, and invoke/fromPromise is rejected.

Call discover_apis first for the tool types, the full authoring contract, and worked examples.`;

const DISCOVER_APIS_DESCRIPTION = `Return the tool type definitions of every toolbox (tools.<box>.<tool>), the machine authoring contract, worked examples and each box's guidance. Call this before authoring a machine for execute_machine.`;

/** execute_machine when it is the only way to run a tool (code mode only). */
const EXECUTE_MACHINE_DESCRIPTION = `Run an LLM-authored XState v5 state machine that orchestrates the tools of this server's toolboxes.\n\n${EXECUTE_MACHINE_BODY}`;

/**
 * execute_machine beside the catalog (R29): leads with when a machine is
 * worth it and sends short lookup-then-act chains to call_tool, where the
 * model reads each result before the next step.
 */
const EXECUTE_MACHINE_ROUTED_DESCRIPTION = `Run a multi-step workflow — loops, branching over results, computing over a list (counting, filtering, summing, comparing or checking every item), many steps, or one worth saving — as an LLM-authored XState v5 state machine that orchestrates the tools of this server's toolboxes. For a short lookup-then-act chain, use call_tool for each step instead.\n\n${EXECUTE_MACHINE_BODY}`;

/** The code-mode tool copy for a projection selection (R29). */
function codeModeCopy(projections: Readonly<ProjectionSelection>): {
  executeMachine: string;
  discoverApis: string;
} {
  return {
    executeMachine: projections.catalog
      ? EXECUTE_MACHINE_ROUTED_DESCRIPTION
      : EXECUTE_MACHINE_DESCRIPTION,
    discoverApis: DISCOVER_APIS_DESCRIPTION,
  };
}

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
    description: `${head}\n\nLists this box's tools one page at a time, optionally matched against a query: the query is split into words, a tool matches if any word appears in its name, title or description, and matches are ranked (name hits weigh more). Each entry gives the tool's qualified name (${alias}.<tool>), a one-line purpose, whether it runs immediately, asks the user for approval, or is blocked by policy, and whether the server marks it destructive; a query's top hits also show their args, enough to call call_tool directly. Without a query, the first page leads with the box's own guidance, when its server gives any. Call describe_tool before calling any other tool.`,
    query: `Words to match against the ${alias} box's tool names, titles and descriptions; any word matches, name hits weigh more. Omit it to list the box, its guidance first.`,
  };
}

/**
 * describe_tool and call_tool under direct listing: what they are for when
 * some (or every) box is listed directly as `<box>__<tool>`.
 */
function directDescribeDescription(view: BoxedCatalog): string {
  const head = `Return one tool's description, its input and output JSON Schemas, and its approval posture, by its qualified name (<box>.<tool>).`;
  const unlisted = view.boxes.size - view.directBoxes.length;
  if (unlisted === 0) {
    return `${head} Every tool is already listed directly with its input schema; call this only to see a tool's output schema.`;
  }
  const others = [...view.boxes.keys()].filter((alias) => !view.directBoxes.includes(alias));
  const listed = view.directBoxes;
  return `${head} Call it before call_tool for a tool of the ${aliasList(others)} ${others.length === 1 ? 'box' : 'boxes'}. The ${aliasList(listed)} ${listed.length === 1 ? "box's tools are" : "boxes' tools are"} listed directly as <box>${DIRECT_BOX_SEPARATOR}<tool> with their input schemas: describe one of those only for its output schema.`;
}

function directCallDescription(view: BoxedCatalog, codeMode: boolean): string {
  const others = [...view.boxes.keys()].filter((alias) => !view.directBoxes.includes(alias));
  const listed =
    others.length === 0
      ? `Every tool is also listed directly as <box>${DIRECT_BOX_SEPARATOR}<tool>, taking the same arguments: prefer calling it that way.`
      : `${listedBoxesSentence(view) ?? ''} Call those that way, with the same arguments. For a tool of the ${aliasList(others)} ${others.length === 1 ? 'box' : 'boxes'}, call describe_tool first to see its arguments.`;
  const outcome = `A tool marked "asks for approval" first asks the user to approve this exact call; a result with status "declined" means the user said no — nothing ran, and you must not retry the same call unless the user asks for it. Status "denied_by_policy" means the server's policy blocks the tool.`;
  return `Run one tool from any toolbox by its qualified name (<box>.<tool>) with a JSON object of arguments. ${listed} ${outcome}${codeMode ? CALL_TOOL_CODE_MODE_POINTER : ''}`;
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
  if (view.directBoxes.length > 0) {
    // Listed boxes need no search: theirs survives only to read the box's
    // guidance. Unlisted boxes keep theirs, and the global search while any
    // box is unlisted — exactly the view's served set.
    const phrase = searchToolsPhrase(view);
    return {
      searches: [
        ...view.searchBoxes.map((alias) =>
          boxSearchCopy(view, alias, view.boxes.get(alias) as ToolBox),
        ),
        ...(view.globalSearch ? [GLOBAL_SEARCH_COPY] : []),
      ],
      describeDescription: projections.codeMode
        ? `${directDescribeDescription(view)}${DESCRIBE_TOOL_TYPES_POINTER}`
        : directDescribeDescription(view),
      callDescription: directCallDescription(view, projections.codeMode),
      toolName:
        view.directBoxes.length === view.boxes.size || phrase === undefined
          ? 'Qualified tool name (<box>.<tool>).'
          : `Qualified tool name (<box>.<tool>): a directly listed tool's, or one listed by ${phrase}.`,
      describeTypes:
        'Also return the generated TypeScript for this tool: its member of tools.<box> and its type aliases (for authoring a machine).',
    };
  }
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
  options: WrapServersOptions;
  snapshot: MultiSnapshot;
  surface: MultiSurface;
  follow: FollowSettings;
}

class MultiFacade implements MultiProjectionFacade {
  readonly skipped: readonly { alias: string; error: StructuredError }[] = Object.freeze([]);
  readonly serverFactory: McpServerFactory;
  readonly projections: Readonly<ProjectionSelection>;
  private readonly deps: MultiFacadeDeps;
  private snapshot: MultiSnapshot;
  readonly #tracker: ListChangeTracker<IntrospectedServer>;
  readonly #held = new HeldServers<HeldRegistration>();
  readonly #listeners = new Set<() => void>();

  constructor(deps: MultiFacadeDeps) {
    this.deps = deps;
    this.snapshot = deps.snapshot;
    this.projections = deps.snapshot.projections;
    // Bound so it can be handed to `createMcpHandler` detached.
    this.serverFactory = (ctx) => this.createServer(ctx);
    const aliases = deps.snapshot.boxes.map((box) => box.alias);
    this.#tracker = new ListChangeTracker(aliases, deps.follow, {
      relist: (alias) => deps.introspector.relist(alias),
      apply: (results, trusted) => {
        // Only the re-listed boxes change: every other box keeps the
        // catalog it has (R65 box isolation).
        const servers = new Map(this.snapshot.catalog.servers);
        for (const [alias, server] of results) servers.set(alias, server.catalog);
        const built = buildMultiSnapshot({ servers }, deps.surface, this.snapshot);
        const next = this.#withTrust(distrustMulti(built, deps.surface, trusted), trusted);
        for (const [alias, server] of results) deps.introspector.commit(alias, server);
        this.#swap(next);
      },
      distrust: (trusted) => {
        this.snapshot = this.#withTrust(
          distrustMulti(this.snapshot, deps.surface, trusted),
          trusted,
        );
      },
    });
    deps.introspector.onToolsChanged((alias) => this.#tracker.notify(alias));
  }

  /** The wrapped boxes' catalogs, keyed by alias, with the servers' own tool names (R30). */
  get catalog(): ToolCatalog {
    return this.snapshot.catalog;
  }

  get instructions(): string {
    return this.snapshot.instructions;
  }

  get dts(): string {
    return this.snapshot.dts;
  }

  /** The code-mode resources, then one box overview per box whose server sends instructions (R3, R45). */
  get resources(): ProjectionResource[] {
    return this.snapshot.resources;
  }

  #withTrust(snapshot: MultiSnapshot, trusted: ReadonlySet<string>): MultiSnapshot {
    return {
      ...snapshot,
      trust: {
        trusted: new Set(trusted),
        generations: new Map(
          snapshot.boxes.map((box) => [box.alias, this.#tracker.generation(box.alias)]),
        ),
      },
    };
  }

  /**
   * Swap in a rebuilt snapshot (R65): servers held open are brought up to
   * date — one tools/list_changed each when their listed tools changed —
   * and the facade's listeners hear of it when a server built now would
   * list different tool definitions.
   */
  #swap(next: MultiSnapshot): void {
    const before = this.snapshot;
    this.snapshot = next;
    const copy = this.projections.catalog ? next.copy : undefined;
    for (const [server, held] of this.#held.entries()) {
      batchToolListChanged(server, () =>
        reconcileHeldServer(server, held, this, copy, next.directTools),
      );
    }
    if (
      !sameDirectTools(before.directTools, next.directTools) ||
      (copy !== undefined && JSON.stringify(before.copy) !== JSON.stringify(next.copy))
    ) {
      for (const listener of this.#listeners) listener();
    }
  }

  executeMachine(
    args: ExecuteMachineArgs,
    era?: ProtocolEra,
    clientCanElicit?: boolean,
    clientUrlElicitation?: boolean,
  ): Promise<ToolCallResult> {
    const snapshot = this.snapshot;
    return executeMachine(args, {
      ...this.gateDeps(snapshot, era, clientCanElicit, clientUrlElicitation),
      bridgeSource: snapshot.bridgeSource,
    });
  }

  discoverApis(): CallToolResult {
    const snapshot = this.snapshot;
    const { catalogInlineThreshold } = this.deps.options;
    return discoverApis(snapshot.view, snapshot.overview, {
      catalog: this.projections.catalog,
      // R37 pointer: the search tools actually served (R43), and under
      // direct listing the boxes listed directly instead.
      ...(snapshot.view.directBoxes.length > 0
        ? {
            findTools: findToolsSentence(snapshot.view, 'to find tools by name or purpose'),
          }
        : { searchPhrase: searchToolsPhrase(snapshot.view) ?? 'search_tools' }),
      // Links every resource but the dashboard, box overviews included (R45).
      resources: snapshot.resources,
      // The samples are picked under the facade's policy (R45).
      policy: snapshot.policySettings,
      ...(catalogInlineThreshold !== undefined ? { inlineThreshold: catalogInlineThreshold } : {}),
      maxRoundTrips: clampCaps(this.deps.options.caps ?? {}).maxRoundTrips,
    });
  }

  searchTools(args: { query?: string; cursor?: string }, alias?: string): CallToolResult {
    const snapshot = this.snapshot;
    const view = snapshot.view;
    try {
      if (alias !== undefined ? !view.searchBoxes.includes(alias) : !view.globalSearch) {
        // Quoted either way: an unknown alias is caller input, rendered inert.
        const tool = JSON.stringify(
          alias !== undefined
            ? boxSearchTool(capLength(neutralizeControlChars(alias), 64))
            : 'search_tools',
        );
        throw new ProjectionError('validate', `${tool} is not served by this facade`, {
          hint: findToolsSentence(view, 'instead'),
        });
      }
      return searchBoxes(view, args, {
        ...snapshot.policySettings,
        ...(alias !== undefined ? { box: alias } : {}),
      });
    } catch (err) {
      return errorResult(toStructuredError(err));
    }
  }

  describeTool(args: { name: string; types?: boolean }): CallToolResult {
    const snapshot = this.snapshot;
    try {
      return describeTool(snapshot.view, args, {
        ...snapshot.policySettings,
        toolTypes: snapshot.toolTypes,
      });
    } catch (err) {
      return errorResult(toStructuredError(err));
    }
  }

  /** By qualified name, over the merged view the gate decides on (R45, R49). */
  policyOf(name: string): ToolPolicy | undefined {
    // What the gate decides now: while a box's tools/list_changed is
    // outstanding, its distrusted decision (R65).
    const { gate } = this.snapshot;
    return toolPolicyOf(gate.catalog, name, gate.policySettings);
  }

  callTool(
    args: CallToolArgs,
    era?: ProtocolEra,
    clientCanElicit?: boolean,
    clientUrlElicitation?: boolean,
  ): Promise<ToolCallResult> {
    return callTool(args, this.gateDeps(this.snapshot, era, clientCanElicit, clientUrlElicitation));
  }

  /**
   * The approval-gate dependencies both gated tools share (R35, R38, R45):
   * the merged view, the `multi` key domain (R41) — for machine blobs and
   * call blobs alike — and the frozen policy settings, all from the
   * snapshot the request started with (R65).
   */
  private gateDeps(
    snapshot: MultiSnapshot,
    era: ProtocolEra | undefined,
    clientCanElicit: boolean | undefined,
    clientUrlElicitation?: boolean,
  ): ApprovalGateDeps {
    return approvalGateDeps({
      catalog: snapshot.gate.catalog,
      blobDomain: 'multi',
      // Routed per call by qualified name (catalog/boxes.ts `routeCall`).
      executor: guardedExecutor(this.deps.introspector, this.#tracker, snapshot.trust),
      options: this.deps.options,
      policySettings: snapshot.gate.policySettings,
      era,
      clientCanElicit,
      clientUrlElicitation,
    });
  }

  createServer(ctx?: RegisterOptions): McpServer {
    const server = createProjectionServer(this.deps.options, 'projection-multi', this.instructions);
    this.registerOn(server, ctx);
    return server;
  }

  registerOn(server: McpServer, options?: RegisterOptions): void {
    const era = options?.era;
    const snapshot = this.snapshot;
    if (this.projections.codeMode) {
      // The workflow prompts name the boxes by alias (R39): they read the view.
      registerCodeModeTools(
        server,
        era,
        this,
        codeModeCopy(this.projections),
        () => this.snapshot.view,
      );
    }
    if (this.projections.catalog) {
      const catalogTools = registerCatalogTools(server, era, this, snapshot.copy);
      const direct = registerDirectTools(server, era, this, snapshot.directTools);
      // Kept (weakly) so a refresh can update what it lists (R65).
      this.#held.add(server, { era, catalogTools, direct });
    }
    registerResources(server, snapshot.resources, () => this.snapshot.resources);
  }

  onToolsChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async refreshTools(alias?: string): Promise<void> {
    const boxes = this.snapshot.view.boxes;
    if (alias === undefined) {
      await Promise.all([...boxes.keys()].map((box) => this.#tracker.refresh(box)));
      return;
    }
    if (typeof alias !== 'string' || !boxes.has(alias)) {
      const name = JSON.stringify(capLength(neutralizeControlChars(String(alias)), 64));
      throw new ProjectionError('validate', `refreshTools: no box ${name} on this facade`, {
        hint: `Boxes: ${[...boxes.keys()].join(', ')}.`,
      });
    }
    await this.#tracker.refresh(alias);
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
        this.snapshot.view.boxes.has(String(alias))
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
    this.#tracker.close();
    return this.deps.introspector.close();
  }
}
