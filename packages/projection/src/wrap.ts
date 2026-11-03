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
import { markDirectListed } from './catalog/search.js';
import { ProjectionError, toStructuredError } from './errors.js';
import {
  batchToolListChanged,
  distrustCatalog,
  distrustOverrides,
  guardedExecutor,
  HeldServers,
  ListChangeTracker,
  resolveFollowSettings,
  type FollowSettings,
} from './facade/follow.js';
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
  type WrapOptions,
} from './facade/options.js';
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
} from './facade/server.js';
import {
  decideDirect,
  planDirectTools,
  reservedToolNames,
  type DirectTool,
} from './facade/direct.js';
import {
  createIntrospector,
  type IntrospectedServer,
  type Introspector,
} from './introspector/index.js';
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
import {
  assertApprovalsMode,
  assertPolicyRules,
  resolvePolicyRules,
  toolPolicyOf,
  type ToolPolicy,
} from './policy/index.js';
import {
  clampCaps,
  DEFAULT_SERVER_ALIAS,
  type ApprovalsMode,
  type PolicyOverrides,
  type PolicyRule,
  type ServerCatalog,
} from './types.js';

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
  /**
   * The resolved policy of the tool `name` (R14, R49): the decision the
   * approval gate makes for it and the posture `search_tools` and
   * `describe_tool` show, computed from the same frozen policy settings and
   * the same lookup the gate uses, so it cannot disagree with them. After a
   * followed `tools/list_changed` (R65) it reads the current snapshot; while
   * the re-listing is outstanding it returns the gate's distrusted decision,
   * which may ask where `search_tools` still shows the last listed posture. `name` is the server's catalog tool name — on a multi-server
   * facade the qualified `<box>.<tool>` — never a name read from
   * `tools/list`: direct listing lists a tool whose name is not a legal tool
   * name under a cleaned-up or hash-suffixed name, which can equal another
   * tool's catalog name, so take names from `catalog`. A name the facade
   * does not declare (a direct listing's `<box>__<tool>` alias included)
   * returns `undefined`. For the
   * integrator only: no model-facing surface carries it.
   */
  policyOf(name: string): ToolPolicy | undefined;
  /** The projections this facade serves (R32). Frozen: fixed at wrap time. */
  readonly projections: Readonly<ProjectionSelection>;
  /** Build an `McpServer` carrying the instructions, the enabled projections' tools and the resources. */
  createServer(ctx?: RegisterOptions): McpServer;
  /** Register the enabled projections' tools and the resources on an `McpServer` the caller built. */
  registerOn(server: McpServer, options?: RegisterOptions): void;
  /**
   * Hear when the tool definitions a server built now would list differ
   * from before, after a wrapped server's `tools/list_changed` was followed
   * (R65): the directly listed tools changed. Servers this facade built that
   * are still connected (stdio) are sent `notifications/tools/list_changed`
   * themselves; behind `createMcpHandler`, publish it to open
   * `subscriptions/listen` streams from here:
   * `facade.onToolsChanged(() => handler.notify.toolsChanged())`.
   * Returns the unsubscribe function.
   */
  onToolsChanged(listener: () => void): () => void;
  /**
   * Re-list a wrapped server's tools now, as if it had sent
   * `tools/list_changed` (R65) — debounced and rate-capped the same way —
   * for a `Client` you passed in (which Projection never subscribes) or a
   * server that changes without notifying. On a multi-server facade,
   * `alias` names the box, or every box without one. Resolves once the
   * refreshed catalog is in place; rejects with the error that kept it
   * out (the box stays distrusted and is retried).
   */
  refreshTools(alias?: string): Promise<void>;
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

const SEARCH_TOOLS_DESCRIPTION = `List this server's tools, one page at a time, optionally matched against a query: the query is split into words, a tool matches if any word appears in its name, title or description, and matches are ranked (name hits weigh more), so a guessed name like create_issue or a phrase like "comment on a pull request" works. Each entry gives the tool's name, a one-line purpose, whether it runs immediately, asks the user for approval, or is blocked by policy, and whether the server marks it destructive; a query's top hits also show their args, enough to call call_tool directly. Call describe_tool before calling any other tool.`;

const CALL_TOOL_DESCRIPTION = `Run one of this server's tools by name with a JSON object of arguments: the args a search hit shows, or those describe_tool gives. A tool marked "asks for approval" first asks the user to approve this exact call; a result with status "declined" means the user said no — nothing ran, and you must not retry the same call unless the user asks for it. Status "denied_by_policy" means the server's policy blocks the tool. For several steps, branching on results, computing over a list (counting, filtering, summing, comparing or checking every item), or a workflow worth saving, author a machine and use execute_machine instead.`;

const DESCRIBE_TOOL_DESCRIPTION = `Return one tool's description, its input and output JSON Schemas, and its approval posture. Call this before call_tool when no search hit showed the tool's args, or to learn what an argument means. Pass types: true to also get the tool's generated TypeScript when authoring a machine for execute_machine.`;

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

/**
 * The catalog tools' copy under direct listing: no search tool (every tool
 * is listed), and describe_tool / call_tool point at the listed tools.
 */
const DIRECT_CATALOG_TOOL_COPY: CatalogToolCopy = {
  searches: [],
  describeDescription: `Return one tool's description, its input and output JSON Schemas, and its approval posture. Every tool is already listed directly with its input schema; call this only to see a tool's output schema, or pass types: true for its generated TypeScript when authoring a machine for execute_machine.`,
  callDescription: `Run one of this server's tools by name with a JSON object of arguments. Every tool is also listed directly, taking the same arguments: prefer calling it that way. Approvals, "declined" and "denied_by_policy" results work the same either way.`,
  toolName: 'Tool name as the server declares it.',
  describeTypes: CATALOG_TOOL_COPY.describeTypes,
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
  const selected = resolveProjections(options.projections);
  const direct = resolveDirectSetting(options.projections, selected.catalog);
  const approvals = assertApprovalsMode(options.approvals);
  const policyRules = assertPolicyRules(options.policyRules);
  assertApprovalPrompts(options.approvalPrompts);
  const introspectTimeoutMs = resolveIntrospectTimeout(options.introspectTimeoutMs);
  const upstreamElicitation = assertUpstreamElicitationMode(options.upstreamElicitation);
  const follow = resolveFollowSettings(options.followListChanged);
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
      followListChanged: follow.follow,
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

  let snapshot: SingleSnapshot;
  try {
    snapshot = buildSingleSnapshot(catalog, { options, policyRules, approvals, direct, selected });
  } catch (err) {
    // A rule that throws fails the wrap: close what Projection opened.
    await introspector.close();
    throw err;
  }

  return new Facade({
    introspector,
    options,
    snapshot,
    surface: { options, policyRules, approvals, direct, selected, listed: snapshot.listed },
    follow,
    ...(connector !== undefined ? { connector } : {}),
  });
}

/**
 * What a single-server snapshot is built from besides the catalog: the
 * validated options, and — after the first build — the surface decided at
 * wrap time, which a refresh never re-decides (R65).
 */
interface SingleSurface {
  options: WrapOptions;
  policyRules: readonly PolicyRule[] | undefined;
  approvals: ApprovalsMode | undefined;
  direct: DirectSetting;
  selected: Readonly<ProjectionSelection>;
  /** Whether the tools are listed directly; decided by the first build when absent. */
  listed?: boolean;
}

/**
 * Everything a single-server facade serves, derived from one catalog: what
 * a request reads, all of it from the same snapshot (R65 swaps it whole).
 */
interface SingleSnapshot {
  catalog: ServerCatalog;
  dts: string;
  bridgeSource: string;
  overview: string;
  toolTypes: Map<string, ToolTypeText>;
  resources: ProjectionResource[];
  instructions: string;
  /**
   * The snapshot of `options.policy` and `options.approvals` (see
   * `WrapOptions`), rules resolved: the one context every surface decides
   * policy with.
   */
  policySettings: PolicySettings;
  /** Whether the tools are listed directly (`projections.direct`). */
  listed: boolean;
  projections: Readonly<ProjectionSelection>;
  /** The direct-listing plan; listed only when `listed`. */
  plan: readonly DirectTool[];
  /**
   * What the approval gate decides with: the catalog and policy above,
   * or — while the server's tools/list_changed is outstanding — the same
   * with its annotations and rule outcomes distrusted (R65).
   */
  gate: { catalog: ServerCatalog; policySettings: PolicySettings };
  /** Whether the box was trusted at build time, and its generation (R65). */
  trust: { trusted: ReadonlySet<string>; generations: ReadonlyMap<string, number> };
}

function buildSingleSnapshot(
  catalog: ServerCatalog,
  surface: SingleSurface,
  previous?: SingleSnapshot,
): SingleSnapshot {
  const { options, direct, selected } = surface;
  // The policy settings (overrides + approvals mode) are snapshotted once
  // per catalog, and that one frozen copy feeds typegen AND the gate /
  // catalog tools: the posture baked into the `.d.ts` resource and the
  // overview must be the posture `describe_tool` and the approval gate
  // decide with. Policy rules are resolved into per-tool overrides first
  // (D36), so the snapshot carries their outcome and no surface ever calls
  // a rule.
  const policy = resolvePolicyRules(catalog, surface.policyRules, options.policy);
  const policySettings = freezePolicySettings({ policy, approvals: surface.approvals });

  // Direct listing: planned under the same frozen policy, so each mediated
  // tool's posture line is the posture call_tool decides with.
  const plan =
    direct.mode === 'off'
      ? []
      : planDirectTools(catalog, {
          ...policySettings,
          reserved: reservedToolNames([]),
          ...(previous !== undefined ? { previous: previous.plan } : {}),
        });
  const listed = surface.listed ?? decideDirect(direct, plan);
  // The unknown-name hint must not point at search_tools, which direct
  // listing does not serve.
  if (listed) markDirectListed(catalog);
  const projections: Readonly<ProjectionSelection> =
    previous?.projections ?? (listed ? Object.freeze({ ...selected, direct: true }) : selected);

  const { dts, bridgeSource, overview, toolTypes } = generateToolTypes(catalog, policySettings);
  const resources = buildResources(
    catalog,
    dts,
    undefined,
    clampCaps(options.caps ?? {}).maxRoundTrips,
  );
  const instructions = buildInstructions(catalog, options.codeModePreamble, projections);
  return {
    catalog,
    dts,
    bridgeSource,
    overview,
    toolTypes,
    resources,
    instructions,
    policySettings,
    listed,
    projections,
    plan,
    gate: { catalog, policySettings },
    trust: {
      trusted: new Set([DEFAULT_SERVER_ALIAS]),
      generations: new Map([[DEFAULT_SERVER_ALIAS, 0]]),
    },
  };
}

/**
 * `snapshot` with its gate distrusting the server's annotations and rule
 * outcomes, for while its tools/list_changed is outstanding (R65).
 */
function distrustSingle(
  snapshot: SingleSnapshot,
  exact: PolicyOverrides | undefined,
): SingleSnapshot {
  const catalog = distrustCatalog(snapshot.catalog);
  if (snapshot.listed) markDirectListed(catalog);
  const { approvals, policy } = snapshot.policySettings;
  return {
    ...snapshot,
    gate: {
      catalog,
      policySettings: freezePolicySettings({
        policy: distrustOverrides(policy, exact, () => true),
        approvals,
      }),
    },
  };
}

interface FacadeDeps {
  introspector: Introspector;
  options: WrapOptions;
  snapshot: SingleSnapshot;
  surface: SingleSurface;
  follow: FollowSettings;
  /** The source given by URL, when the facade wraps one (R51). */
  connector?: UpstreamConnector;
}

class Facade implements ProjectionFacade {
  readonly serverFactory: McpServerFactory;
  readonly projections: Readonly<ProjectionSelection>;
  private readonly deps: FacadeDeps;
  private snapshot: SingleSnapshot;
  readonly #tracker: ListChangeTracker<IntrospectedServer>;
  readonly #held = new HeldServers<HeldRegistration>();
  readonly #listeners = new Set<() => void>();

  constructor(deps: FacadeDeps) {
    this.deps = deps;
    this.snapshot = deps.snapshot;
    this.projections = deps.snapshot.projections;
    // Bound so it can be handed to `createMcpHandler` detached.
    this.serverFactory = (ctx) => this.createServer(ctx);
    const exact = deps.options.policy !== undefined ? { ...deps.options.policy } : undefined;
    this.#tracker = new ListChangeTracker([DEFAULT_SERVER_ALIAS], deps.follow, {
      relist: (alias) => deps.introspector.relist(alias),
      apply: (results, trusted) => {
        const server = results.get(DEFAULT_SERVER_ALIAS);
        if (server === undefined) return;
        const built = buildSingleSnapshot(server.catalog, deps.surface, this.snapshot);
        const next = this.#withTrust(
          trusted.has(DEFAULT_SERVER_ALIAS) ? built : distrustSingle(built, exact),
          trusted,
        );
        deps.introspector.commit(DEFAULT_SERVER_ALIAS, server);
        this.#swap(next);
      },
      distrust: (trusted) => {
        this.snapshot = this.#withTrust(distrustSingle(this.snapshot, exact), trusted);
      },
    });
    deps.introspector.onToolsChanged((alias) => this.#tracker.notify(alias));
  }

  get catalog(): ServerCatalog {
    return this.snapshot.catalog;
  }

  get instructions(): string {
    return this.snapshot.instructions;
  }

  get dts(): string {
    return this.snapshot.dts;
  }

  get resources(): ProjectionResource[] {
    return this.snapshot.resources;
  }

  #withTrust(snapshot: SingleSnapshot, trusted: ReadonlySet<string>): SingleSnapshot {
    return {
      ...snapshot,
      trust: {
        trusted: new Set(trusted),
        generations: new Map([
          [DEFAULT_SERVER_ALIAS, this.#tracker.generation(DEFAULT_SERVER_ALIAS)],
        ]),
      },
    };
  }

  /**
   * Swap in a rebuilt snapshot (R65): servers held open are brought up to
   * date — one tools/list_changed each when their listed tools changed —
   * and the facade's listeners hear of it when a server built now would
   * list different tool definitions.
   */
  #swap(next: SingleSnapshot): void {
    const before = this.snapshot;
    this.snapshot = next;
    const copy = this.#catalogCopy();
    const directTools = next.listed ? next.plan : [];
    for (const [server, held] of this.#held.entries()) {
      batchToolListChanged(server, () =>
        reconcileHeldServer(server, held, this, copy, directTools),
      );
    }
    const listedBefore = before.listed ? before.plan : [];
    if (!sameDirectTools(listedBefore, directTools)) {
      for (const listener of this.#listeners) listener();
    }
  }

  #catalogCopy(): CatalogToolCopy | undefined {
    if (!this.projections.catalog) return undefined;
    return this.projections.direct === true ? DIRECT_CATALOG_TOOL_COPY : CATALOG_TOOL_COPY;
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

  callTool(
    args: CallToolArgs,
    era?: ProtocolEra,
    clientCanElicit?: boolean,
    clientUrlElicitation?: boolean,
  ): Promise<ToolCallResult> {
    return callTool(args, this.gateDeps(this.snapshot, era, clientCanElicit, clientUrlElicitation));
  }

  /**
   * The approval-gate dependencies both gated tools share (R35, R38): one
   * place to wire the facade's options, so `execute_machine` and `call_tool`
   * can never drift on policy, redaction, caps or replay protection. A
   * request decides with the snapshot it started with (R65).
   */
  private gateDeps(
    snapshot: SingleSnapshot,
    era: ProtocolEra | undefined,
    clientCanElicit: boolean | undefined,
    clientUrlElicitation?: boolean,
  ): ApprovalGateDeps {
    return approvalGateDeps({
      catalog: snapshot.gate.catalog,
      blobDomain: 'single',
      executor: guardedExecutor(this.deps.introspector, this.#tracker, snapshot.trust),
      options: this.deps.options,
      policySettings: snapshot.gate.policySettings,
      era,
      clientCanElicit,
      clientUrlElicitation,
    });
  }

  discoverApis(): CallToolResult {
    const snapshot = this.snapshot;
    const { catalogInlineThreshold } = this.deps.options;
    return discoverApis(snapshot.catalog, snapshot.overview, {
      catalog: this.projections.catalog,
      // R37 pointer: direct listing serves no search_tools.
      ...(this.projections.direct === true
        ? { findTools: "This server's tools are listed directly as tools of their own." }
        : {}),
      ...(catalogInlineThreshold !== undefined ? { inlineThreshold: catalogInlineThreshold } : {}),
      maxRoundTrips: clampCaps(this.deps.options.caps ?? {}).maxRoundTrips,
    });
  }

  searchTools(args: { query?: string; cursor?: string }): CallToolResult {
    const snapshot = this.snapshot;
    try {
      return searchTools(snapshot.catalog, args, snapshot.policySettings);
    } catch (err) {
      return errorResult(toStructuredError(err));
    }
  }

  describeTool(args: { name: string; types?: boolean }): CallToolResult {
    const snapshot = this.snapshot;
    try {
      return describeTool(snapshot.catalog, args, {
        ...snapshot.policySettings,
        toolTypes: snapshot.toolTypes,
      });
    } catch (err) {
      return errorResult(toStructuredError(err));
    }
  }

  policyOf(name: string): ToolPolicy | undefined {
    // What the gate decides now: while the server's tools/list_changed is
    // outstanding, its distrusted decision (R65).
    const { gate } = this.snapshot;
    return toolPolicyOf(gate.catalog, name, gate.policySettings);
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
      `projection-${this.snapshot.catalog.alias}`,
      this.instructions,
    );
    this.registerOn(server, ctx);
    return server;
  }

  registerOn(server: McpServer, options?: RegisterOptions): void {
    const era = options?.era;
    const snapshot = this.snapshot;
    if (this.projections.codeMode) {
      registerCodeModeTools(server, era, this, CODE_MODE_COPY, () => this.snapshot.catalog);
    }
    const copy = this.#catalogCopy();
    if (copy !== undefined) {
      const catalogTools = registerCatalogTools(server, era, this, copy);
      const direct = registerDirectTools(server, era, this, snapshot.listed ? snapshot.plan : []);
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

  refreshTools(alias?: string): Promise<void> {
    if (alias !== undefined) {
      return Promise.reject(
        new ProjectionError('validate', 'refreshTools on a single-server facade takes no alias', {
          hint: 'Call refreshTools() without arguments.',
        }),
      );
    }
    return this.#tracker.refresh(DEFAULT_SERVER_ALIAS);
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
    this.#tracker.close();
    return this.deps.introspector.close();
  }
}
