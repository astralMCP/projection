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
 *   to Projection (not already connected to another transport) — Projection is
 *   the facade; the wrapped server is never exposed directly (R1).
 * - **Remote connection**: an already-connected SDK `Client`. The caller owns
 *   its lifecycle; `close()` will not touch it.
 */

import { Client, type Progress } from '@modelcontextprotocol/client';
import {
  InMemoryTransport,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type Tool,
} from '@modelcontextprotocol/server';
import { UpstreamConnector } from '../auth/connect.js';
import { MCP_SDK_VERSION } from '../blob/versions.js';
import { ProjectionError } from '../errors.js';
import { DEFAULT_INTROSPECT_TIMEOUT_MS, INTROSPECTOR_CLIENT_INFO } from './constants.js';
import type {
  ServerAlias,
  ServerCatalog,
  ToolAnnotations,
  ToolCallOutcome,
  ToolCatalog,
  ToolCatalogEntry,
  ToolExecutor,
  UpstreamCallOptions,
  UpstreamProgress,
} from '../types.js';

/** A wrapped-server source: an in-process instance or a connected client. */
export type ServerSource = McpServer | Client;

/**
 * Aliased server sources (R30): one per alias. An {@link UpstreamConnector}
 * is a source given by URL (R51), validated by the facade: the introspector
 * opens it, owns the resulting client, and records its `url:` identity
 * (R60).
 */
export type IntrospectorSources = Record<ServerAlias, ServerSource | UpstreamConnector>;

interface Connection {
  client: Client;
  /** True when the introspector created the client (in-process source, or a source given by URL). */
  owned: boolean;
  /**
   * The source given by URL behind this connection (R51): its `url:`
   * identity (R60), and the redaction and error mapping of everything it
   * returns (S1).
   */
  connector?: UpstreamConnector;
}

/** How {@link Introspector.create} connects. */
export interface IntrospectOptions {
  /**
   * Bound on each source's connect and introspection (R47). A source that
   * has not finished in time fails the whole introspection with a
   * `protocol` error. Default {@link DEFAULT_INTROSPECT_TIMEOUT_MS}.
   */
  timeoutMs?: number;
  /** How the timeout error names a source. Default: `wrapped server "<alias>"`. */
  describe?: (alias: ServerAlias) => string;
}

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
 * and could return an endless chain of `nextCursor` pages, a cursor that
 * repeats, or a tool count large enough to blow up the generated artifacts;
 * any of these would hang or exhaust the process before any workflow runs.
 *
 * Projection walks the pages itself and enforces these bounds as each page
 * arrives (D12). It does not use the SDK's no-cursor `listTools()`, which
 * aggregates every page before returning and is bounded only by the
 * caller's `listMaxPages` client option (0 = unlimited).
 */
const MAX_TOOL_LIST_PAGES = 100;
const MAX_TOOLS = 2_000;

function limitError(alias: ServerAlias, detail: string): ProjectionError {
  return new ProjectionError(
    'protocol',
    `wrapped server "${alias}" exceeded introspection limits (${detail})`,
    {
      hint: `Projection reads at most ${MAX_TOOL_LIST_PAGES} tools/list pages and ${MAX_TOOLS} tools, and rejects a repeated cursor. Wrap a server with a bounded tool surface whose tools/list pagination terminates.`,
    },
  );
}

/**
 * A server-sent cursor quoted in an error, at most 64 characters: redacted
 * first for a source given by URL (S1), so a cut cannot leave the prefix of
 * a credential that straddles it.
 */
function redactThenCut(cursor: string, connector: UpstreamConnector | undefined): string {
  return (connector !== undefined ? connector.redact(cursor) : cursor).slice(0, 64);
}

async function fetchToolsPage(
  client: Client,
  cursor: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ tools: Tool[]; nextCursor?: string | undefined }> {
  // Page 1 goes through request(): listTools() without a cursor would walk
  // every page itself before we could count anything. For the spec method
  // `tools/list`, request() validates the result against the SDK's
  // ListToolsResult schema, exactly as listTools() does internally. Later
  // pages use listTools({ cursor }), which fetches exactly one page.
  const options = signal !== undefined ? { signal } : undefined;
  if (cursor === undefined) return client.request({ method: 'tools/list', params: {} }, options);
  return client.listTools({ cursor }, options);
}

async function listAllTools(
  client: Client,
  alias: ServerAlias,
  signal: AbortSignal | undefined,
  connector: UpstreamConnector | undefined,
): Promise<Tool[]> {
  // A server with zero registered tools never declares the `tools`
  // capability; that is an empty catalog, not a failure.
  if (client.getServerCapabilities()?.tools === undefined) return [];
  const tools: Tool[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    let page: { tools: Tool[]; nextCursor?: string | undefined };
    try {
      // eslint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
      page = await fetchToolsPage(client, cursor, signal);
    } catch (err) {
      // A server that declares the capability yet answers Method not found
      // on the first page still has no tools to offer.
      if (
        pages === 0 &&
        err instanceof ProtocolError &&
        err.code === ProtocolErrorCode.MethodNotFound
      ) {
        return [];
      }
      throw new ProjectionError(
        'protocol',
        `tools/list failed for wrapped server "${alias}": ${err instanceof Error ? err.message : String(err)}`,
        {
          hint: 'Check that the wrapped server is running, connected, and supports the tools capability.',
          cause: err,
        },
      );
    }
    pages += 1;
    tools.push(...page.tools);
    if (tools.length > MAX_TOOLS) {
      throw limitError(
        alias,
        `declares at least ${tools.length} tools, over the cap of ${MAX_TOOLS}`,
      );
    }
    cursor = page.nextCursor;
    if (cursor === undefined) break;
    if (cursors.has(cursor)) {
      throw limitError(
        alias,
        `tools/list pagination loops: page ${pages} returned cursor ${JSON.stringify(redactThenCut(cursor, connector))} a second time`,
      );
    }
    if (pages >= MAX_TOOL_LIST_PAGES) {
      throw limitError(
        alias,
        `tools/list still returns nextCursor after ${pages} pages, over the cap of ${MAX_TOOL_LIST_PAGES}`,
      );
    }
    cursors.add(cursor);
  } while (cursor !== undefined);
  return tools;
}

/**
 * True when `source` is shaped like an `McpServer` (a `server` property plus
 * `connect`/`registerTool`, and no `listTools`, which a `Client` has) yet
 * failed the `instanceof McpServer` check: the caller's project resolved a
 * second copy of `@modelcontextprotocol/server`.
 */
function looksLikeForeignMcpServer(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return false;
  const candidate = source as Record<string, unknown>;
  return (
    'server' in candidate &&
    (typeof candidate['connect'] === 'function' ||
      typeof candidate['registerTool'] === 'function') &&
    typeof candidate['listTools'] !== 'function'
  );
}

/**
 * One wrapped server's introspection result: the public catalog plus the raw
 * `Tool` definitions by name, which {@link Introspector.callTool} hands to the
 * SDK as `toolDefinition` so output-schema validation never depends on the
 * SDK's internal `tools/list` cache (manual paging never fills it, and a
 * `notifications/tools/list_changed` clears it).
 */
interface IntrospectedServer {
  catalog: ServerCatalog;
  definitions: Map<string, Tool>;
}

async function introspectServer(
  alias: ServerAlias,
  client: Client,
  connector: UpstreamConnector | undefined,
  signal?: AbortSignal,
): Promise<IntrospectedServer> {
  let tools = await listAllTools(client, alias, signal, connector);
  let instructions = client.getInstructions();
  if (connector !== undefined) {
    // S1: a server given by URL saw the token on every request; nothing it
    // declares may carry it on to the model.
    tools = connector.redact(tools);
    if (instructions !== undefined) instructions = connector.redact(instructions);
  }
  const info = client.getServerVersion();
  const catalog: ServerCatalog = {
    alias,
    // Stable identity recorded into blobs (R30): server name + version; for
    // a source given by URL, its host-chosen `url:<canonical url>` (R60).
    identity: connector?.identity ?? (info !== undefined ? `${info.name}@${info.version}` : alias),
    tools: tools.map(toCatalogEntry),
  };
  if (instructions !== undefined) catalog.instructions = instructions;
  return { catalog, definitions: new Map(tools.map((tool) => [tool.name, tool])) };
}

/**
 * `run`, rejected with `onTimeout()` when it has not settled within
 * `timeoutMs`; the signal it gets is aborted then, so it can let go of
 * what it opened.
 */
function withDeadline<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  onTimeout: () => Error,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(onTimeout());
    }, timeoutMs);
    run(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
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
 * The SDK request options that forward an upstream's progress reports to
 * `onProgress` (none without one: no progress token is sent). A report
 * also resets the request timeout, as a long call that keeps reporting is
 * alive.
 */
function progressOptions(
  onProgress: ((progress: UpstreamProgress) => void) | undefined,
  connector: UpstreamConnector | undefined,
): { onprogress?: (progress: Progress) => void; resetTimeoutOnProgress?: boolean } {
  if (onProgress === undefined) return {};
  return {
    resetTimeoutOnProgress: true,
    onprogress: (report) => {
      const forwarded: UpstreamProgress = { progress: report.progress };
      if (report.total !== undefined) forwarded.total = report.total;
      if (report.message !== undefined) {
        forwarded.message =
          connector !== undefined ? connector.redact(report.message) : report.message;
      }
      onProgress(forwarded);
    },
  };
}

/**
 * Holds one MCP client per wrapped-server alias, exposes the aggregated
 * {@link ToolCatalog}, and executes tool calls (implements
 * {@link ToolExecutor}). Construct with {@link createIntrospector}.
 */
export class Introspector implements ToolExecutor {
  readonly #connections: Map<ServerAlias, Connection>;
  #catalog: ToolCatalog;
  #definitions: Map<ServerAlias, Map<string, Tool>>;

  private constructor(
    connections: Map<ServerAlias, Connection>,
    introspected: Map<ServerAlias, IntrospectedServer>,
  ) {
    this.#connections = connections;
    this.#catalog = Introspector.#catalogOf(introspected);
    this.#definitions = Introspector.#definitionsOf(introspected);
  }

  static #catalogOf(introspected: Map<ServerAlias, IntrospectedServer>): ToolCatalog {
    return {
      servers: new Map([...introspected].map(([alias, server]) => [alias, server.catalog])),
    };
  }

  static #definitionsOf(
    introspected: Map<ServerAlias, IntrospectedServer>,
  ): Map<ServerAlias, Map<string, Tool>> {
    return new Map([...introspected].map(([alias, server]) => [alias, server.definitions]));
  }

  static async create(
    sources: IntrospectorSources,
    options: IntrospectOptions = {},
  ): Promise<Introspector> {
    const aliases = Object.keys(sources);
    if (aliases.length === 0) {
      throw new ProjectionError('protocol', 'No wrapped server was provided.', {
        hint: 'Pass at least one server source, e.g. { default: myMcpServer }.',
      });
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_INTROSPECT_TIMEOUT_MS;
    const describe = options.describe ?? ((alias: ServerAlias) => `wrapped server "${alias}"`);
    const connections = new Map<ServerAlias, Connection>();
    const servers = new Map<ServerAlias, IntrospectedServer>();
    // Each server is an independent host-side connection, so introspect
    // them concurrently (v1 has one; the fan-out matters for R30 multi-server).
    //
    // `allSettled`, not `all`: a fast-rejecting alias must not sweep cleanup
    // while a sibling's #connect is still in flight — that sibling would
    // register its connection after the sweep and leak it. Waiting for every
    // task to settle guarantees the sweep sees all opened connections.
    //
    // R47: each source's connect and introspection is bounded by the
    // timeout. A task that times out is aborted: a source given by URL
    // closes its half-open connection, a pending tools/list is cancelled,
    // and a connection that still completes after the sweep is closed by
    // its own task instead of being registered.
    const settled = await Promise.allSettled(
      aliases.map((alias) =>
        withDeadline(
          timeoutMs,
          async (signal) => {
            const source = sources[alias];
            if (source === undefined) return;
            const connection = await Introspector.#connect(alias, source, signal);
            if (signal.aborted) {
              if (connection.owned) await connection.client.close().catch(() => undefined);
              return;
            }
            connections.set(alias, connection);
            try {
              servers.set(
                alias,
                await introspectServer(alias, connection.client, connection.connector, signal),
              );
            } catch (err) {
              // A 401 during introspection is an auth failure, not a protocol
              // one; and nothing a URL source says reaches the error unredacted.
              throw connection.connector !== undefined ? connection.connector.toError(err) : err;
            }
          },
          () =>
            new ProjectionError(
              'protocol',
              `${describe(alias)} did not finish connecting and listing its tools within ${timeoutMs} ms`,
              {
                hint: 'Check that the server is reachable and answering MCP, or raise introspectTimeoutMs.',
              },
            ),
        ),
      ),
    );
    const failed = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed !== undefined) {
      await Introspector.#closeConnections(connections);
      throw failed.reason;
    }
    return new Introspector(connections, servers);
  }

  static async #connect(
    alias: ServerAlias,
    source: ServerSource | UpstreamConnector,
    signal: AbortSignal,
  ): Promise<Connection> {
    if (source instanceof UpstreamConnector) {
      return { client: await source.open(signal), owned: true, connector: source };
    }
    if (source instanceof McpServer) {
      if (source.isConnected()) {
        throw new ProjectionError(
          'protocol',
          `Wrapped server "${alias}" is already connected to a transport.`,
          {
            hint: "Pass a dedicated McpServer instance — Projection owns the wrapped server's transport and exposes it only through the code-mode facade.",
          },
        );
      }
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client(INTROSPECTOR_CLIENT_INFO, { capabilities: {} });
      await source.connect(serverTransport);
      try {
        await client.connect(clientTransport);
      } catch (err) {
        // The server side is attached and nothing would ever close it:
        // release it so a failed wrap leaves the McpServer reusable.
        await serverTransport.close().catch(() => undefined);
        throw err;
      }
      return { client, owned: true };
    }
    if (looksLikeForeignMcpServer(source)) {
      throw new ProjectionError(
        'protocol',
        `Wrapped server "${alias}" looks like an McpServer from a second copy of @modelcontextprotocol/server, not the one Projection uses.`,
        {
          hint: `Projection pins @modelcontextprotocol/server ${MCP_SDK_VERSION} exactly. Depend on that exact version so your package manager installs a single copy (check with \`npm ls @modelcontextprotocol/server\` or \`pnpm why @modelcontextprotocol/server\`).`,
        },
      );
    }
    return { client: source, owned: false };
  }

  static async #closeConnections(connections: Map<ServerAlias, Connection>): Promise<void> {
    await Promise.all(
      [...connections.values()]
        .filter((connection) => connection.owned)
        .map((connection) => {
          // Auth requests in flight (a refresh) end with the facade (R58).
          connection.connector?.close();
          return connection.client.close().catch(() => undefined);
        }),
    );
  }

  /** The aggregated tool catalog, keyed by server alias (R30). */
  get catalog(): ToolCatalog {
    return this.#catalog;
  }

  /** Re-read `tools/list` from every wrapped server and rebuild the catalog. */
  async refresh(): Promise<ToolCatalog> {
    const rebuilt = new Map(
      await Promise.all(
        [...this.#connections].map(
          async ([alias, connection]) =>
            [
              alias,
              await introspectServer(alias, connection.client, connection.connector),
            ] as const,
        ),
      ),
    );
    this.#catalog = Introspector.#catalogOf(rebuilt);
    this.#definitions = Introspector.#definitionsOf(rebuilt);
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
   *
   * `options` are host-side: `signal` cancels the upstream request, and
   * `onProgress` asks the upstream for progress and receives each report
   * (redacted first for a source given by URL, S1).
   */
  async callTool(
    alias: ServerAlias,
    name: string,
    args: Record<string, unknown>,
    options: UpstreamCallOptions = {},
  ): Promise<ToolCallOutcome> {
    const connection = this.#connections.get(alias);
    if (connection === undefined) {
      throw new ProjectionError('protocol', `Unknown wrapped-server alias "${alias}".`, {
        hint: `Known aliases: ${[...this.#connections.keys()].join(', ')}. A single-server facade wraps its server under the "default" alias; a multi-server facade routes each qualified <alias>.<tool> name to its box's alias (routeCall).`,
      });
    }
    // Validate against the definition recorded at introspection, not the
    // SDK's tools/list cache (see IntrospectedServer). A name the catalog
    // does not know has no definition; the server rejects it anyway.
    const toolDefinition = this.#definitions.get(alias)?.get(name);
    const connector = connection.connector;
    try {
      // The SDK's return type is a union that includes a legacy
      // `{ toolResult }` compatibility shape; narrow to the modern fields.
      const result = (await connection.client.callTool(
        { name, arguments: args },
        {
          ...(toolDefinition !== undefined ? { toolDefinition } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          ...progressOptions(options.onProgress, connector),
        },
      )) as {
        content?: unknown;
        structuredContent?: unknown;
        isError?: unknown;
      };
      if (result.isError === true) {
        const message =
          errorTextFromContent(result.content) ?? `Tool "${name}" returned an error result.`;
        const detail = result.structuredContent ?? result.content;
        return {
          ok: false,
          error:
            connector !== undefined
              ? { message: connector.redact(message), detail: connector.redact(detail) }
              : { message, detail },
        };
      }
      const value = pickResultValue(result);
      // S1: a server given by URL must not hand the model the token it saw.
      const redacted = connector !== undefined ? connector.redact(value) : value;
      return value === result.content && Array.isArray(value)
        ? { ok: true, result: redacted, rawContent: true }
        : { ok: true, result: redacted };
    } catch (err) {
      // A source given by URL: an auth failure is its own outcome (R25
      // `auth`), and no error text reaches the model unredacted.
      if (connector !== undefined) return connector.callFailure(name, err);
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
export async function createIntrospector(
  sources: IntrospectorSources,
  options?: IntrospectOptions,
): Promise<Introspector> {
  return Introspector.create(sources, options);
}
