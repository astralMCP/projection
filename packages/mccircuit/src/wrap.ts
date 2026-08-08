/**
 * `wrapMcpServer` — the integrating developer's entry point (PRD G1, R1).
 *
 * Introspects a wrapped MCP server, generates its `@mccircuit/tools`
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
import {
  McpServer,
  type Implementation,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createIntrospector, type Introspector } from './introspector/index.js';
import {
  buildInstructions,
  buildResources,
  discoverApis,
  executeMachine,
  type CallToolResult,
  type ExecuteMachineArgs,
  type McCircuitResource,
  type ProtocolEra,
  type ToolCallResult,
} from './mrtr/index.js';
import { generateToolTypes } from './typegen/index.js';
import {
  DEFAULT_SERVER_ALIAS,
  type BlobSealerConfig,
  type PolicyOverrides,
  type RedactionHook,
  type ResourceCaps,
  type ServerCatalog,
} from './types.js';
import { McCircuitError } from './errors.js';

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
  /** Identity the servers built by `createServer` advertise. */
  serverInfo?: Implementation;
}

/** Options for registering the code-mode surface on a server the caller built. */
export interface RegisterOptions {
  /**
   * The protocol era this server instance serves (R28). Omitted means
   * `'legacy'`: a hand-connected `McpServer` never negotiates 2026-07-28, so
   * defaulting to legacy is the honest — and fail-safe — reading.
   */
  era?: ProtocolEra;
}

export interface McCircuitFacade {
  /** Catalog of the wrapped server. */
  readonly catalog: ServerCatalog;
  /** Instructions to advertise: the wrapped server's, then the preamble (R29). */
  readonly instructions: string;
  /** Generated `.d.ts` for the wrapped server's tools. */
  readonly dts: string;
  /** Resources served at stable `mccircuit://` URIs (R3). */
  readonly resources: McCircuitResource[];
  /**
   * Server factory to hand to `createMcpHandler` or `serveStdio` (R28, R29).
   * Every instance it builds carries the code-mode `instructions` and knows
   * the era it is serving.
   */
  readonly serverFactory: McpServerFactory;

  /** Run `execute_machine` for one `tools/call`, first attempt or retry. */
  executeMachine(args: ExecuteMachineArgs, era?: ProtocolEra): Promise<ToolCallResult>;
  /** Run `discover_apis`. */
  discoverApis(): CallToolResult;
  /** Build an `McpServer` carrying the instructions, both tools and the resources. */
  createServer(ctx?: RegisterOptions): McpServer;
  /** Register both tools and the resources on an `McpServer` the caller built. */
  registerOn(server: McpServer, options?: RegisterOptions): void;
  /** Close the connection to the wrapped server. */
  close(): Promise<void>;
}

const EXECUTE_MACHINE_DESCRIPTION = `Run an LLM-authored XState v5 state machine that orchestrates this server's tools.

Author a module that default-exports a machine built with XState v5 setup(...).createMachine(...), and request tools with the toolCall action from '@mccircuit/tools'. Read-only tools run immediately; every other tool pauses the machine and asks the user to approve that exact call before it runs, so handle TOOL_RESULT, TOOL_ERROR and TOOL_DENIED. Machine context must stay JSON-serializable, and invoke/fromPromise is rejected.

Call discover_apis first for the tool types, the full authoring contract, and worked examples.`;

const DISCOVER_APIS_DESCRIPTION = `Return this server's tool type definitions, the machine authoring contract, and worked examples. Call this before authoring a machine for execute_machine.`;

/**
 * Wrap an MCP server (an in-process instance or a connected client) into a
 * code-mode facade.
 */
export async function wrapMcpServer(
  source: McpServer | Client,
  options: WrapOptions,
): Promise<McCircuitFacade> {
  const introspector = await createIntrospector({ [DEFAULT_SERVER_ALIAS]: source });
  const catalog = introspector.catalog.servers.get(DEFAULT_SERVER_ALIAS);
  if (catalog === undefined) {
    throw new McCircuitError(
      'protocol',
      'introspection produced no catalog for the wrapped server',
      {
        hint: 'Check that the wrapped server initialized successfully.',
      },
    );
  }

  const { dts, bridgeSource, overview } = generateToolTypes(catalog);
  const resources = buildResources(catalog, dts);
  const instructions = buildInstructions(catalog, options.codeModePreamble);

  return new Facade({
    introspector,
    catalog,
    dts,
    bridgeSource,
    overview,
    resources,
    instructions,
    options,
  });
}

interface FacadeDeps {
  introspector: Introspector;
  catalog: ServerCatalog;
  dts: string;
  bridgeSource: string;
  overview: string;
  resources: McCircuitResource[];
  instructions: string;
  options: WrapOptions;
}

class Facade implements McCircuitFacade {
  readonly catalog: ServerCatalog;
  readonly instructions: string;
  readonly dts: string;
  readonly resources: McCircuitResource[];
  readonly serverFactory: McpServerFactory;
  private readonly deps: FacadeDeps;

  constructor(deps: FacadeDeps) {
    this.deps = deps;
    this.catalog = deps.catalog;
    this.instructions = deps.instructions;
    this.dts = deps.dts;
    this.resources = deps.resources;
    // Bound so it can be handed to `createMcpHandler` detached.
    this.serverFactory = (ctx) => this.createServer(ctx);
  }

  executeMachine(args: ExecuteMachineArgs, era?: ProtocolEra): Promise<ToolCallResult> {
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
    });
  }

  discoverApis(): CallToolResult {
    return discoverApis(this.deps.catalog, this.deps.overview);
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
        name: `mccircuit-${this.deps.catalog.alias}`,
        version: '0.1.0',
      },
      { instructions: this.instructions },
    );
    this.registerOn(server, ctx);
    return server;
  }

  registerOn(server: McpServer, options?: RegisterOptions): void {
    const era = options?.era;

    server.registerTool(
      'execute_machine',
      {
        title: 'Execute a state machine',
        description: EXECUTE_MACHINE_DESCRIPTION,
        inputSchema: EXECUTE_MACHINE_INPUT_SCHEMA,
      },
      async (args, ctx) =>
        await this.executeMachine(
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
        ),
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

    for (const resource of this.resources) {
      server.registerResource(
        resource.name,
        resource.uri,
        { description: resource.description, mimeType: resource.mimeType },
        () => ({
          contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }],
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
 * string, and anything else means someone wired a decoding hook McCircuit
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
