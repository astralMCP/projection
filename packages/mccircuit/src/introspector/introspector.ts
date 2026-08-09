/**
 * Introspector — connects to the wrapped server(s), reads `tools/list`,
 * annotations, and `instructions`, and maintains the tool catalog (PRD §7,
 * G1, R29, R30). Also implements {@link ToolExecutor}: all tool calls the
 * machine host performs against a wrapped server go through here.
 *
 * Two source kinds are supported (R4):
 *
 * - **In-process instance**: an `McpServer` from `@modelcontextprotocol/server`.
 *   The introspector connects it to an in-memory transport pair and talks to
 *   it with a real MCP client, so introspection and execution exercise the
 *   exact same code path as a remote server. The instance must be dedicated
 *   to McCircuit (not already connected to another transport) — McCircuit is
 *   the facade; the wrapped server is never exposed directly (R1).
 * - **Remote connection**: an already-connected SDK `Client`. The caller owns
 *   its lifecycle; `close()` will not touch it.
 */

import { Client } from '@modelcontextprotocol/client';
import {
  InMemoryTransport,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type Tool,
} from '@modelcontextprotocol/server';
import { McCircuitError } from '../errors.js';
import type {
  ServerAlias,
  ServerCatalog,
  ToolAnnotations,
  ToolCallOutcome,
  ToolCatalog,
  ToolCatalogEntry,
  ToolExecutor,
} from '../types.js';

/** A wrapped-server source: an in-process instance or a connected client. */
export type ServerSource = McpServer | Client;

/**
 * Aliased server sources (R30). v1 instantiates exactly one entry, but the
 * interface accepts a set so the multi-server stretch goal (PRD §12.2) needs
 * no signature break.
 */
export type IntrospectorSources = Record<ServerAlias, ServerSource>;

interface Connection {
  client: Client;
  /** True when the introspector created the client (in-process source). */
  owned: boolean;
}

const CLIENT_INFO = { name: 'mccircuit-introspector', version: '0.1.0' };

function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'text' &&
    typeof (block as { text?: unknown }).text === 'string'
  );
}

function mapAnnotations(annotations: Tool['annotations']): ToolAnnotations | undefined {
  if (annotations === undefined) return undefined;
  const mapped: ToolAnnotations = {};
  if (annotations.title !== undefined) mapped.title = annotations.title;
  if (annotations.readOnlyHint !== undefined) mapped.readOnlyHint = annotations.readOnlyHint;
  if (annotations.destructiveHint !== undefined) {
    mapped.destructiveHint = annotations.destructiveHint;
  }
  if (annotations.idempotentHint !== undefined) {
    mapped.idempotentHint = annotations.idempotentHint;
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function toCatalogEntry(tool: Tool): ToolCatalogEntry {
  const entry: ToolCatalogEntry = {
    name: tool.name,
    inputSchema: tool.inputSchema as Record<string, unknown>,
  };
  if (tool.description !== undefined) entry.description = tool.description;
  if (tool.outputSchema !== undefined) {
    entry.outputSchema = tool.outputSchema as Record<string, unknown>;
  }
  const annotations = mapAnnotations(tool.annotations);
  if (annotations !== undefined) entry.annotations = annotations;
  return entry;
}

/**
 * Bounds on `tools/list` introspection. A wrapped server is untrusted (S5)
 * and could return an endless chain of `nextCursor` pages, or a tool count
 * large enough to blow up the generated artifacts; either would hang or
 * exhaust the process before any workflow runs.
 */
const MAX_TOOL_LIST_PAGES = 100;
const MAX_TOOLS = 2_000;

async function listAllTools(client: Client, alias: ServerAlias): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  let pages = 0;
  try {
    do {
      const page = await client.listTools(cursor !== undefined ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
      pages += 1;
      if (pages >= MAX_TOOL_LIST_PAGES || tools.length >= MAX_TOOLS) {
        if (cursor !== undefined) {
          throw new McCircuitError(
            'protocol',
            `wrapped server "${alias}" exceeded introspection limits (${pages} pages, ${tools.length} tools)`,
            {
              hint: `McCircuit reads at most ${MAX_TOOL_LIST_PAGES} tools/list pages and ${MAX_TOOLS} tools. Wrap a server with a bounded tool surface.`,
            },
          );
        }
        break;
      }
    } while (cursor !== undefined);
  } catch (err) {
    // Our own limit breach already carries the right phase and hint.
    if (err instanceof McCircuitError) throw err;
    // A server with zero registered tools never declares the `tools`
    // capability (client-side assertion) and answers tools/list with
    // Method not found; treat both as an empty catalog, not a failure.
    if (err instanceof ProtocolError && err.code === ProtocolErrorCode.MethodNotFound) {
      return [];
    }
    if (err instanceof Error && /does not support tools/i.test(err.message)) {
      return [];
    }
    throw new McCircuitError(
      'protocol',
      `tools/list failed for wrapped server "${alias}": ${err instanceof Error ? err.message : String(err)}`,
      {
        hint: 'Check that the wrapped server is running, connected, and supports the tools capability.',
        cause: err,
      },
    );
  }
  return tools;
}

async function buildServerCatalog(alias: ServerAlias, client: Client): Promise<ServerCatalog> {
  const tools = await listAllTools(client, alias);
  const info = client.getServerVersion();
  const catalog: ServerCatalog = {
    alias,
    // Stable identity recorded into blobs (R30): server name + version.
    identity: info !== undefined ? `${info.name}@${info.version}` : alias,
    tools: tools.map(toCatalogEntry),
  };
  const instructions = client.getInstructions();
  if (instructions !== undefined) catalog.instructions = instructions;
  return catalog;
}

/** Extract a one-line error message from an `isError` tool result's content. */
function errorTextFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('\n')
    .trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Pick the value delivered to the machine as `TOOL_RESULT` payload:
 * `structuredContent` when the tool declares one, otherwise the text of a
 * single text block, otherwise the raw content array (`null` when empty).
 */
function pickResultValue(result: { structuredContent?: unknown; content?: unknown }): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content[0];
  if (content.length === 1 && isTextBlock(first)) return first.text;
  if (content.length === 0) return null;
  return content;
}

/**
 * Holds one MCP client per wrapped-server alias, exposes the aggregated
 * {@link ToolCatalog}, and executes tool calls (implements
 * {@link ToolExecutor}). Construct with {@link createIntrospector}.
 */
export class Introspector implements ToolExecutor {
  readonly #connections: Map<ServerAlias, Connection>;
  #catalog: ToolCatalog;

  private constructor(connections: Map<ServerAlias, Connection>, catalog: ToolCatalog) {
    this.#connections = connections;
    this.#catalog = catalog;
  }

  static async create(sources: IntrospectorSources): Promise<Introspector> {
    const aliases = Object.keys(sources);
    if (aliases.length === 0) {
      throw new McCircuitError('protocol', 'No wrapped server was provided.', {
        hint: 'Pass at least one server source, e.g. { default: myMcpServer }.',
      });
    }
    const connections = new Map<ServerAlias, Connection>();
    const servers = new Map<ServerAlias, ServerCatalog>();
    // Each server is an independent host-side connection, so introspect
    // them concurrently (v1 has one; the fan-out matters for R30 multi-server).
    //
    // `allSettled`, not `all`: a fast-rejecting alias must not sweep cleanup
    // while a sibling's #connect is still in flight — that sibling would
    // register its connection after the sweep and leak it. Waiting for every
    // task to settle guarantees the sweep sees all opened connections.
    const settled = await Promise.allSettled(
      aliases.map(async (alias) => {
        const source = sources[alias];
        if (source === undefined) return;
        const connection = await Introspector.#connect(alias, source);
        connections.set(alias, connection);
        servers.set(alias, await buildServerCatalog(alias, connection.client));
      }),
    );
    const failed = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed !== undefined) {
      await Introspector.#closeConnections(connections);
      throw failed.reason;
    }
    return new Introspector(connections, { servers });
  }

  static async #connect(alias: ServerAlias, source: ServerSource): Promise<Connection> {
    if (source instanceof McpServer) {
      if (source.isConnected()) {
        throw new McCircuitError(
          'protocol',
          `Wrapped server "${alias}" is already connected to a transport.`,
          {
            hint: "Pass a dedicated McpServer instance — McCircuit owns the wrapped server's transport and exposes it only through the code-mode facade.",
          },
        );
      }
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client(CLIENT_INFO, { capabilities: {} });
      await source.connect(serverTransport);
      await client.connect(clientTransport);
      return { client, owned: true };
    }
    return { client: source, owned: false };
  }

  static async #closeConnections(connections: Map<ServerAlias, Connection>): Promise<void> {
    await Promise.all(
      [...connections.values()]
        .filter((connection) => connection.owned)
        .map((connection) => connection.client.close().catch(() => undefined)),
    );
  }

  /** The aggregated tool catalog, keyed by server alias (R30). */
  get catalog(): ToolCatalog {
    return this.#catalog;
  }

  /** Re-read `tools/list` from every wrapped server and rebuild the catalog. */
  async refresh(): Promise<ToolCatalog> {
    const rebuilt = await Promise.all(
      [...this.#connections].map(
        async ([alias, connection]) =>
          [alias, await buildServerCatalog(alias, connection.client)] as const,
      ),
    );
    this.#catalog = { servers: new Map(rebuilt) };
    return this.#catalog;
  }

  /**
   * Execute a tool call against the wrapped server identified by `alias`,
   * mapping the MCP result to a {@link ToolCallOutcome}:
   *
   * - success → `{ ok: true, result }` where `result` is the tool's
   *   `structuredContent` when present, else a single text block's text,
   *   else the raw content array.
   * - `isError` result or transport/protocol failure → `{ ok: false, error }`.
   *
   * An unknown alias is a wiring bug, not a tool failure, and throws.
   */
  async callTool(
    alias: ServerAlias,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallOutcome> {
    const connection = this.#connections.get(alias);
    if (connection === undefined) {
      throw new McCircuitError('protocol', `Unknown wrapped-server alias "${alias}".`, {
        hint: `Known aliases: ${[...this.#connections.keys()].join(', ')}. v1 wraps exactly one server under the "default" alias.`,
      });
    }
    try {
      // The SDK's return type is a union that includes a legacy
      // `{ toolResult }` compatibility shape; narrow to the modern fields.
      const result = (await connection.client.callTool({ name, arguments: args })) as {
        content?: unknown;
        structuredContent?: unknown;
        isError?: unknown;
      };
      if (result.isError === true) {
        return {
          ok: false,
          error: {
            message:
              errorTextFromContent(result.content) ?? `Tool "${name}" returned an error result.`,
            detail: result.structuredContent ?? result.content,
          },
        };
      }
      return { ok: true, result: pickResultValue(result) };
    } catch (err) {
      return {
        ok: false,
        error: {
          message: `Tool call "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          detail: err instanceof Error ? { name: err.name } : err,
        },
      };
    }
  }

  /**
   * Close connections the introspector created (in-process sources).
   * Caller-provided remote clients are left untouched.
   */
  async close(): Promise<void> {
    await Introspector.#closeConnections(this.#connections);
    this.#connections.clear();
  }
}

/**
 * Connect to the given wrapped servers and build their tool catalog.
 *
 * v1 usage: `createIntrospector({ [DEFAULT_SERVER_ALIAS]: serverOrClient })`.
 */
export async function createIntrospector(sources: IntrospectorSources): Promise<Introspector> {
  return Introspector.create(sources);
}
