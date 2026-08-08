/**
 * `wrapMcpServer` — the integrating developer's entry point (PRD G1, R1).
 *
 * Introspects a wrapped MCP server, generates its `@mccircuit/tools`
 * artifacts, and returns a facade exposing exactly two tools —
 * `execute_machine` and `discover_apis` — plus the resources backing
 * discovery. The wrapped server's own tools are never exposed (R1).
 *
 * ```ts
 * const facade = await wrapMcpServer(myServer, { blob: { key } });
 * facade.registerOn(codeModeServer);           // registers the two tools
 * ```
 *
 * `registerOn` is a convenience for the common `McpServer` case. Anything
 * more exotic (a custom transport, a hand-rolled handler) can drive
 * `facade.executeMachine` / `facade.discoverApis` directly — the facade is
 * plain data and functions, holding no cross-request state (R27).
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createIntrospector, type Introspector } from './introspector/index.js';
import {
  buildInstructions,
  buildResources,
  discoverApis,
  executeMachine,
  type ExecuteMachineArgs,
  type McCircuitResource,
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

  /** Run `execute_machine` for one `tools/call`, first attempt or retry. */
  executeMachine(args: ExecuteMachineArgs, protocolVersion?: string): Promise<ToolCallResult>;
  /** Run `discover_apis`. */
  discoverApis(): ToolCallResult;
  /** Register both tools and the resources on an `McpServer`. */
  registerOn(server: McpServer): void;
  /** Close the connection to the wrapped server. */
  close(): Promise<void>;
}

const EXECUTE_MACHINE_DESCRIPTION = `Run an LLM-authored XState v5 state machine that orchestrates this server's tools.

Author a module that default-exports a machine built with XState v5 setup(...).createMachine(...), and request tools with the toolCall action from '@mccircuit/tools'. Read-only tools run immediately; every other tool pauses the machine and asks the user to approve that exact call before it runs, so handle TOOL_RESULT, TOOL_ERROR and TOOL_DENIED. Machine context must stay JSON-serializable, and invoke/fromPromise is rejected.

Call discover_apis first for the tool types, the full authoring contract, and worked examples.`;

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
  private readonly deps: FacadeDeps;

  constructor(deps: FacadeDeps) {
    this.deps = deps;
    this.catalog = deps.catalog;
    this.instructions = deps.instructions;
    this.dts = deps.dts;
    this.resources = deps.resources;
  }

  executeMachine(args: ExecuteMachineArgs, protocolVersion?: string): Promise<ToolCallResult> {
    const { options } = this.deps;
    return executeMachine(args, {
      catalog: this.deps.catalog,
      bridgeSource: this.deps.bridgeSource,
      executor: this.deps.introspector,
      blob: options.blob,
      ...(options.caps !== undefined ? { caps: options.caps } : {}),
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
      ...(options.redact !== undefined ? { redact: options.redact } : {}),
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    });
  }

  discoverApis(): ToolCallResult {
    return discoverApis(this.deps.catalog, this.deps.overview);
  }

  registerOn(server: McpServer): void {
    server.registerTool(
      'execute_machine',
      {
        title: 'Execute a state machine',
        description: EXECUTE_MACHINE_DESCRIPTION,
        inputSchema: EXECUTE_MACHINE_INPUT_SCHEMA,
      },
      // The SDK's tool-callback types are built around its own result shape;
      // MRTR's input_required result is not in that union yet (D1), so the
      // handler is registered through a structural cast.
      (async (args: ExecuteMachineArgs, extra: { protocolVersion?: string }) =>
        await this.executeMachine(args, extra?.protocolVersion)) as never,
    );

    server.registerTool(
      'discover_apis',
      {
        title: 'Discover the tool API',
        description:
          "Return this server's tool type definitions, the machine authoring contract, and worked examples. Call this before authoring a machine for execute_machine.",
        inputSchema: {},
      },
      (() => this.discoverApis()) as never,
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
 * `execute_machine` arguments (R2), as the Zod raw shape the SDK expects.
 *
 * The MRTR retry fields (`requestState`, `inputResponses`) are declared
 * here too: the spec re-sends the original arguments on retry, and the
 * client adds these alongside them.
 */
const EXECUTE_MACHINE_INPUT_SCHEMA = {
  code: z.string().describe('The machine module source: a default-exported XState v5 machine.'),
  lang: z
    .enum(['ts', 'js'])
    .optional()
    .describe('Language of `code`. Defaults to TypeScript-compatible parsing.'),
  input: z.unknown().optional().describe('Passed to the machine as its `input`.'),
  requestState: z
    .string()
    .optional()
    .describe('MRTR: the opaque state echoed back verbatim when retrying after approval.'),
  inputResponses: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('MRTR: the answers collected for the elicitations of the previous call.'),
};
