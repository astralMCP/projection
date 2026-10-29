/**
 * `wrapMcpServers` configuration: source discrimination, aliases, per-source
 * settings and facade policy keys (PRD R39, R42, R48, R49).
 *
 * Every mistake here is a `validate` {@link ProjectionError} raised at wrap
 * time, before any source is connected (R39), so a misconfigured facade
 * never leaves an in-process server attached to a transport nobody closes,
 * and a typo never silently drops a setting — least of all a `deny`.
 */

import { Client } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { ProjectionError } from '../errors.js';
import type { WrapOptions } from '../facade/options.js';
import type { ServerSource } from '../introspector/index.js';
import { assertApprovalsMode } from '../policy/index.js';
import { capLength, neutralizeControlChars } from '../text-safety.js';
import { DEFAULT_SERVER_ALIAS, isRecord, type ApprovalsMode } from '../types.js';
import { splitQualified } from '../catalog/boxes.js';

/** One source with its per-box settings (R39). */
export interface ServerSourceConfig {
  /** The server to wrap: an in-process `McpServer` or a connected `Client`. */
  source: McpServer | Client;
  /**
   * Host-trusted text naming the box's purpose, shown to the model on the
   * shelf (R44). Neutralized (control and bidi characters) and capped at 200
   * characters.
   */
  description?: string;
  /**
   * Approvals mode for this box (R49); takes precedence over
   * `WrapServersOptions.approvals`. A per-tool `policy` override still wins.
   */
  approvals?: ApprovalsMode;
  /**
   * R47 (skip this source instead of failing the wrap) is not supported yet:
   * `true` fails the wrap with a `validate` error. Wrapping is fail-closed.
   */
  optional?: boolean;
}

/** Options of a multi-server facade (R39). */
export interface WrapServersOptions extends WrapOptions {
  catalog?: {
    /**
     * Serve the global `search_tools` across every box (R43). Default
     * `true`. `false` is not supported yet: the per-box `search_<alias>`
     * tools it would leave as the only search tools are not served yet.
     */
    globalSearch?: boolean;
  };
}

/** A validated source, ready to introspect. */
export interface ResolvedSource {
  alias: string;
  source: ServerSource;
  /**
   * False for a duck-typed source — anything with a `connect` or `callTool`
   * function that is not an `McpServer` or `Client` from Projection's SDK
   * copy. Its connect or introspection failure is reported as a pointed
   * {@link ProjectionError} naming the alias, never a raw `TypeError`.
   */
  sdk: boolean;
  description?: string;
  approvals?: ApprovalsMode;
}

/** At most this many sources per facade (R48). */
export const MAX_SOURCES = 16;

/** Alias grammar (R39): dot-free and underscore-free, short enough for `search_<alias>`. */
export const ALIAS_PATTERN = /^[a-z][a-z0-9]{0,23}$/;

/**
 * Aliases a facade refuses (R39): the single-server alias, and every suffix
 * Projection registers after `search_` (only `search_tools` today), so a
 * `search_<alias>` tool can never collide with one of Projection's own.
 */
export const RESERVED_ALIASES: ReadonlySet<string> = new Set([DEFAULT_SERVER_ALIAS, 'tools']);

/** Longest box description (R39). */
export const MAX_BOX_DESCRIPTION_CHARS = 200;

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'source',
  'description',
  'approvals',
  'optional',
]);

function invalid(message: string, hint: string): ProjectionError {
  return new ProjectionError('validate', message, { hint });
}

/** An integrator-supplied key or alias, quoted and bounded for an error message. */
function quoted(text: string): string {
  return JSON.stringify(capLength(neutralizeControlChars(text), 64));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A wrapped-server source as the introspector takes it: an `McpServer` or
 * `Client` from Projection's SDK copy, or anything with a `connect` or
 * `callTool` function — a server or client from a second SDK copy, which
 * the introspector diagnoses with a pointed error of its own. Any other
 * duck-typed object (`{ connect() {…} }`) passes here too, but if it then
 * fails to connect or introspect, `wrapMcpServers` reports a `protocol`
 * {@link ProjectionError} naming its alias instead of the raw `TypeError`
 * the SDK would surface (see {@link ResolvedSource.sdk}).
 */
function asSource(value: unknown): ServerSource | undefined {
  if (value instanceof McpServer || value instanceof Client) return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['connect'] === 'function' || typeof candidate['callTool'] === 'function'
    ? (value as ServerSource)
    : undefined;
}

/**
 * R39: a value is a {@link ServerSourceConfig} when it is a plain object
 * with an own `source` property and neither a `callTool` nor a `connect`
 * function.
 */
function isSourceConfig(value: unknown): value is Record<string, unknown> {
  return (
    isPlainObject(value) &&
    Object.hasOwn(value, 'source') &&
    typeof value['callTool'] !== 'function' &&
    typeof value['connect'] !== 'function'
  );
}

function isSdkSource(source: ServerSource): boolean {
  return source instanceof McpServer || source instanceof Client;
}

/**
 * An `McpServer` already attached to a transport cannot be wrapped: the
 * introspector would refuse it after its siblings had connected. Refuse it
 * here, before anything connects (R39).
 */
function assertNotConnected(alias: string, source: ServerSource): ServerSource {
  if (source instanceof McpServer && source.isConnected()) {
    throw invalid(
      `source ${quoted(alias)} is an McpServer that is already connected to a transport`,
      "Pass a dedicated, unconnected McpServer instance: Projection owns the wrapped server's transport. To share a running server, connect a Client to it and pass the Client.",
    );
  }
  return source;
}

function assertAlias(alias: string): void {
  if (!ALIAS_PATTERN.test(alias)) {
    throw invalid(
      `source alias ${quoted(alias)} is not valid`,
      'Aliases are 1–24 characters: a lowercase letter, then lowercase letters or digits (no dots, dashes or underscores), e.g. "fs" or "github2".',
    );
  }
  if (RESERVED_ALIASES.has(alias)) {
    throw invalid(
      `source alias ${quoted(alias)} is reserved`,
      `Pick another alias: ${[...RESERVED_ALIASES].map((name) => `"${name}"`).join(' and ')} are reserved by Projection.`,
    );
  }
}

function resolveSource(alias: string, value: unknown): ResolvedSource {
  if (!isSourceConfig(value)) {
    const source = asSource(value);
    if (source === undefined) {
      throw invalid(
        `source ${quoted(alias)} is not an McpServer, a Client or a { source } configuration`,
        'Pass an McpServer instance, a connected Client, or { source, description?, approvals? }.',
      );
    }
    return { alias, source: assertNotConnected(alias, source), sdk: isSdkSource(source) };
  }

  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) {
      throw invalid(
        `source ${quoted(alias)} has an unknown setting ${quoted(key)}`,
        `A source configuration takes only ${[...CONFIG_KEYS].join(', ')}.`,
      );
    }
  }
  const source = isSourceConfig(value['source']) ? undefined : asSource(value['source']);
  if (source === undefined) {
    throw invalid(
      `source ${quoted(alias)}: "source" is not an McpServer or a Client`,
      'Set source to an McpServer instance or a connected Client.',
    );
  }

  const resolved: ResolvedSource = {
    alias,
    source: assertNotConnected(alias, source),
    sdk: isSdkSource(source),
  };
  const description = value['description'];
  if (description !== undefined) {
    if (typeof description !== 'string') {
      throw invalid(
        `source ${quoted(alias)}: "description" must be a string`,
        'Describe the box in one short sentence, or omit description.',
      );
    }
    // Host-trusted, but still neutralized and capped (R39): it reaches the
    // model's system prompt.
    const safe = capLength(neutralizeControlChars(description.trim()), MAX_BOX_DESCRIPTION_CHARS);
    if (safe.length > 0) resolved.description = safe;
  }

  if (value['approvals'] !== undefined) {
    try {
      const approvals = assertApprovalsMode(value['approvals']);
      if (approvals !== undefined) resolved.approvals = approvals;
    } catch (err) {
      if (!(err instanceof ProjectionError)) throw err;
      throw invalid(`source ${quoted(alias)}: ${err.message}`, err.hint);
    }
  }

  // `optional: false` is accepted: it is the fail-closed default.
  const optional = value['optional'];
  if (optional !== undefined && optional !== false) {
    // TODO(R47): skip an optional source that fails to connect or introspect.
    throw invalid(
      optional === true
        ? `source ${quoted(alias)}: optional sources are not supported yet`
        : `source ${quoted(alias)}: "optional" must be a boolean`,
      'Remove optional: wrapping is fail-closed, so every source must connect and introspect.',
    );
  }
  return resolved;
}

/**
 * Validate the `sources` record (R39, R48): 1–16 entries, each alias valid
 * and unreserved, each value a source or a source configuration, and no
 * source object under two aliases. Returns the sources in alias order.
 */
export function resolveSources(sources: unknown): ResolvedSource[] {
  if (!isPlainObject(sources)) {
    throw invalid(
      'wrapMcpServers takes a record of sources keyed by alias',
      'Pass an object such as { fs: fsServer, github: { source: githubClient } }.',
    );
  }
  const aliases = Object.keys(sources).toSorted();
  if (aliases.length === 0) {
    throw invalid('wrapMcpServers needs at least one source', 'Pass at least one aliased source.');
  }
  if (aliases.length > MAX_SOURCES) {
    throw invalid(
      `wrapMcpServers takes at most ${MAX_SOURCES} sources (got ${aliases.length})`,
      `Split the servers across facades of at most ${MAX_SOURCES} sources each.`,
    );
  }

  const seen = new Map<ServerSource, string>();
  return aliases.map((alias) => {
    assertAlias(alias);
    const resolved = resolveSource(alias, sources[alias]);
    const earlier = seen.get(resolved.source);
    if (earlier !== undefined) {
      throw invalid(
        `the same source is wrapped under two aliases, ${quoted(earlier)} and ${quoted(alias)}`,
        'Wrap each server once; one server cannot be two boxes.',
      );
    }
    seen.set(resolved.source, alias);
    return resolved;
  });
}

/**
 * R42: facade policy keys are qualified names, and the alias of each must
 * name a configured source. A key naming an unknown tool in a known box is
 * left alone (as on a single-server facade): the tool list is only known
 * after introspection, and a stale key there is harmless.
 */
export function assertPolicyKeys(policy: unknown, aliases: ReadonlySet<string>): void {
  if (policy === undefined) return;
  if (!isRecord(policy)) {
    throw invalid(
      'policy must be an object keyed by qualified tool names',
      'Pass e.g. { "fs.write_file": "ask", "github.delete_repository": "deny" }.',
    );
  }
  for (const key of Object.keys(policy)) {
    const split = splitQualified(key);
    if (split === undefined) {
      throw invalid(
        `policy key ${quoted(key)} is not a qualified tool name`,
        'On a multi-server facade policy keys are <alias>.<tool>, e.g. "fs.write_file".',
      );
    }
    if (!aliases.has(split.alias)) {
      throw invalid(
        `policy key ${quoted(key)} names no configured source ${quoted(split.alias)}`,
        `Configured aliases: ${[...aliases].join(', ')}. Fix the alias so the setting is not silently dropped.`,
      );
    }
  }
}

/** The `catalog` option (R43): validated, then reduced to what this release serves. */
export function assertCatalogOptions(catalog: unknown): void {
  if (catalog === undefined) return;
  if (!isPlainObject(catalog)) {
    throw invalid('catalog must be an object', 'Pass e.g. { globalSearch: true }, or omit it.');
  }
  for (const key of Object.keys(catalog)) {
    if (key !== 'globalSearch') {
      throw invalid(
        `catalog has an unknown setting ${quoted(key)}`,
        'catalog takes only globalSearch.',
      );
    }
  }
  const globalSearch = catalog['globalSearch'];
  if (globalSearch !== undefined && typeof globalSearch !== 'boolean') {
    throw invalid('catalog.globalSearch must be a boolean', 'Omit it for the default (true).');
  }
  if (globalSearch === false) {
    // TODO(PR3): serve the per-box search_<alias> tools, then honour false (R43).
    throw invalid(
      'catalog.globalSearch: false is not supported yet',
      'Omit catalog.globalSearch: the per-box search tools it would leave are not served yet.',
    );
  }
}
