/**
 * `search_tools` — the catalog projection's discovery tool (PRD R33, S5).
 *
 * Returns one page of the wrapped server's tools in catalog order — name,
 * a one-line purpose, the policy posture in plain words, and whether the
 * server marks the tool destructive — optionally filtered by a plain
 * substring. It is the lazy alternative to `discover_apis`' inline
 * overview: O(tools the model looks at), not O(tools the server has).
 *
 * Everything rendered comes from the S5-untrusted catalog, so names and
 * purposes are neutralized in the text rendering. `structuredContent.tools[].name`
 * stays verbatim: it is the key the model hands back to `describe_tool` and
 * `call_tool`, and JSON escaping already renders it inert there.
 */

import { ProjectionError } from '../errors.js';
import { decidePolicy, purposeSentence } from '../policy/index.js';
import {
  capLength,
  inertIdentity,
  MAX_IDENTITY_CHARS,
  neutralizeControlChars,
} from '../text-safety.js';
import type { CallToolResult } from '../mrtr/protocol.js';
import {
  dedupeTools,
  type PolicyDecision,
  type PolicyOverrides,
  type ServerCatalog,
  type ToolCatalogEntry,
} from '../types.js';

export interface SearchToolsArgs {
  /** Plain substring filter over name and description (case-insensitive). */
  query?: string;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
}

export interface SearchToolsOptions {
  /** Per-tool policy overrides (R14); decides the rendered posture. */
  policy?: PolicyOverrides;
  /** Tools per page. Default {@link DEFAULT_SEARCH_PAGE_SIZE}, clamped to [1, 200]. */
  pageSize?: number;
}

/** Page size — a transport bound, independent of the R37 inline threshold. */
export const DEFAULT_SEARCH_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
/** `query` is capped (R33): it is matched as a plain substring, never a regex. */
export const MAX_QUERY_CHARS = 200;

/** The three normative posture strings (R33) — models match on these. */
export type ToolPosture = 'runs immediately' | 'asks for approval' | 'blocked by policy';

/** One entry of a `search_tools` page (R33). */
export interface ToolSummary {
  name: string;
  purpose: string;
  posture: ToolPosture;
  destructive: boolean;
}

export interface SearchToolsPage {
  tools: ToolSummary[];
  /** Matching tools across all pages. */
  total: number;
  nextCursor?: string;
}

/** Map a policy decision to its plain-words posture (R33). */
export function postureOf(decision: PolicyDecision): ToolPosture {
  switch (decision) {
    case 'auto':
      return 'runs immediately';
    case 'ask':
      return 'asks for approval';
    case 'deny':
      return 'blocked by policy';
  }
}

/** Summarize one catalog entry (R33). */
export function summarizeTool(entry: ToolCatalogEntry, policy?: PolicyOverrides): ToolSummary {
  return {
    name: entry.name,
    purpose: purposeSentence(entry.description) ?? '(no description)',
    posture: postureOf(decidePolicy(entry, policy)),
    destructive: entry.annotations?.destructiveHint === true,
  };
}

/**
 * Run `search_tools`. Throws a `validate`-phase {@link ProjectionError} for a
 * malformed cursor, one issued for a different query, or one pointing past
 * the end of the results (R33).
 */
export function searchTools(
  catalog: ServerCatalog,
  args: SearchToolsArgs,
  options: SearchToolsOptions = {},
): CallToolResult {
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, options.pageSize ?? DEFAULT_SEARCH_PAGE_SIZE),
  );
  // Slice, not capLength: an ellipsis would change what the filter matches.
  const query = (args.query ?? '').slice(0, MAX_QUERY_CHARS);
  const offset = decodeCursor(args.cursor, query);

  const needle = query.toLowerCase();
  // First occurrence wins, as for `findTool` and typegen (S5).
  const matches = dedupeTools(catalog.tools).filter(
    (entry) =>
      needle.length === 0 ||
      entry.name.toLowerCase().includes(needle) ||
      (entry.description ?? '').toLowerCase().includes(needle),
  );
  // A cursor is only ever issued while more results remain, so an offset at
  // or beyond the end was not issued by us (or not for this catalog): refuse
  // it rather than answer with an empty page that contradicts `total`.
  if (offset > 0 && offset >= matches.length) {
    throw cursorError('cursor is past the end of the results');
  }
  const slice = matches.slice(offset, offset + pageSize);
  const tools = slice.map((entry) => summarizeTool(entry, options.policy));
  const end = offset + slice.length;
  const page: SearchToolsPage = {
    tools,
    total: matches.length,
    ...(end < matches.length ? { nextCursor: encodeCursor(query, end) } : {}),
  };

  return {
    content: [{ type: 'text', text: renderPage(catalog, page, query, offset) }],
    structuredContent: { ...page },
  };
}

function renderPage(
  catalog: ServerCatalog,
  page: SearchToolsPage,
  query: string,
  offset: number,
): string {
  const lines: string[] = [];
  const scope =
    query.length > 0 ? ` matching ${JSON.stringify(neutralizeControlChars(query))}` : '';
  if (page.tools.length === 0) {
    lines.push(`No tools${scope} on server ${inertIdentity(catalog.identity)}.`);
  } else {
    lines.push(
      `Tools ${offset + 1}–${offset + page.tools.length} of ${page.total}${scope} (server ${inertIdentity(catalog.identity)}):`,
    );
    for (const tool of page.tools) {
      // Names and purposes are S5-controlled: neutralize so a hostile value
      // cannot forge a line of its own (e.g. relabel a write as "runs
      // immediately"). The purpose is already inline-neutralized and capped
      // by `purposeSentence`; the posture is rendered by us, after the data.
      const name = capLength(neutralizeControlChars(tool.name), MAX_IDENTITY_CHARS);
      const flags = tool.destructive ? `${tool.posture}, destructive` : tool.posture;
      lines.push(`- ${name} — ${tool.purpose} [${flags}]`);
    }
  }
  if (page.nextCursor !== undefined) {
    lines.push(
      '',
      `More tools follow: call search_tools again with cursor ${JSON.stringify(page.nextCursor)}.`,
    );
  }
  lines.push(
    '',
    'Call describe_tool with a name before calling a tool whose arguments you have not seen.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Cursor: opaque, bound to the query that produced it (R33)
// ---------------------------------------------------------------------------

interface CursorPayload {
  q: string;
  o: number;
}

function encodeCursor(query: string, offset: number): string {
  const payload: CursorPayload = { q: query, o: offset };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function cursorError(why: string): ProjectionError {
  return new ProjectionError('validate', `search_tools cursor is not usable: ${why}`, {
    hint: 'Pass a cursor exactly as a previous search_tools result returned it, with the same query; or omit it to start from the first page.',
  });
}

/**
 * Decode a cursor to its offset. Only the fields read (`q`, `o`) are
 * validated: a payload carrying extra keys is accepted, since the cursor is
 * opaque data and nothing else in it is consumed. The offset's upper bound
 * is checked by the caller once the match count is known.
 */
function decodeCursor(cursor: string | undefined, query: string): number {
  if (cursor === undefined || cursor.length === 0) return 0;
  if (cursor.length > 1_024) throw cursorError('too long');
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw cursorError('malformed');
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as CursorPayload).q !== 'string' ||
    typeof (payload as CursorPayload).o !== 'number'
  ) {
    throw cursorError('malformed');
  }
  const { q, o } = payload as CursorPayload;
  if (!Number.isInteger(o) || o < 0) throw cursorError('malformed');
  if (q !== query) throw cursorError('it was issued for a different query');
  return o;
}
