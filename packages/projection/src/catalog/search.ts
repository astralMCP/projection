/**
 * `search_tools` — the catalog projection's discovery tool (PRD R33, S5).
 *
 * Returns one page of the wrapped server's tools — name, a one-line
 * purpose, the policy posture in plain words, and whether the server marks
 * the tool destructive — optionally matched against a query. It is the lazy
 * alternative to `discover_apis`' inline overview: O(tools the model looks
 * at), not O(tools the server has).
 *
 * Matching is token-based (DECISIONS D10): the query is split into words on
 * anything that is not a letter, combining mark, or digit, and a tool
 * matches when ANY word is a case-insensitive substring of its name, its
 * annotation title, or its full description. Each word scores +2 when it is
 * in the name and, independently, +1 when it is in the title or description
 * (a word in both scores 3); matches are ranked by score, ties in catalog
 * order, so a guessed name like `create_issue` finds `issue_write` instead
 * of nothing. A title hit counts like a description hit — it catches words
 * the description lacks — but never outweighs a name hit, so "pull request"
 * lists the `*pull_request*` tools before a tool whose title merely mentions
 * them. No regex is ever built from the query (S5: descriptions are hostile
 * input).
 *
 * Everything rendered comes from the S5-untrusted catalog, so names and
 * purposes are neutralized in the text rendering. `structuredContent.tools[].name`
 * stays verbatim: it is the key the model hands back to `describe_tool` and
 * `call_tool`, and JSON escaping already renders it inert there.
 */

import { ProjectionError } from '../errors.js';
import { decidePolicy, policyContext, postureOf, type ToolPosture } from '../policy/index.js';
import {
  capLength,
  inertIdentity,
  MAX_IDENTITY_CHARS,
  neutralizeControlChars,
  purposeSentence,
} from '../text-safety.js';
import type { CallToolResult } from '../mrtr/protocol.js';
import {
  dedupeTools,
  type ApprovalsMode,
  type PolicyContext,
  type PolicyOverrides,
  type ServerCatalog,
  type ToolCatalogEntry,
} from '../types.js';

export interface SearchToolsArgs {
  /**
   * Words to match against tool names, titles and descriptions; any word
   * matches, name hits weigh more (case-insensitive).
   */
  query?: string;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
}

export interface SearchToolsOptions {
  /** Per-tool policy overrides (R14); decides the rendered posture. */
  policy?: PolicyOverrides;
  /** Approvals mode (R49); decides the rendered posture with `policy`. */
  approvals?: ApprovalsMode;
  /** Tools per page. Default {@link DEFAULT_SEARCH_PAGE_SIZE}, clamped to [1, 200]. */
  pageSize?: number;
}

/** Page size — a transport bound, independent of the R37 inline threshold. */
export const DEFAULT_SEARCH_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
/** `query` is capped (R33): its words are matched as plain substrings, never a regex. */
export const MAX_QUERY_CHARS = 200;

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

/** Summarize one catalog entry (R33); `context` decides its posture (R14, R49). */
export function summarizeTool(entry: ToolCatalogEntry, context?: PolicyContext): ToolSummary {
  return {
    name: entry.name,
    purpose: purposeSentence(entry.description) ?? '(no description)',
    posture: postureOf(decidePolicy(entry, context)),
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
  const rawQuery = args.query ?? '';
  const query = rawQuery.slice(0, MAX_QUERY_CHARS);
  const queryTruncated = rawQuery.length > MAX_QUERY_CHARS;
  const offset = decodeCursor(args.cursor, query);

  // First occurrence wins, as for `findTool` and typegen (S5).
  const matches = rankTools(dedupeTools(catalog.tools), query);
  // A cursor is only ever issued while more results remain, so an offset at
  // or beyond the end was not issued by us (or not for this catalog): refuse
  // it rather than answer with an empty page that contradicts `total`.
  if (offset > 0 && offset >= matches.length) {
    throw cursorError('cursor is past the end of the results');
  }
  const slice = matches.slice(offset, offset + pageSize);
  const context = policyContext(options);
  const tools = slice.map((entry) => summarizeTool(entry, context));
  const end = offset + slice.length;
  const page: SearchToolsPage = {
    tools,
    total: matches.length,
    ...(end < matches.length ? { nextCursor: encodeCursor(query, end) } : {}),
  };

  return {
    content: [{ type: 'text', text: renderPage(catalog, page, query, offset, queryTruncated) }],
    structuredContent: { ...page },
  };
}

/** How many declared names an unknown-tool hint suggests. */
export const SUGGESTION_LIMIT = 3;

/**
 * The declared tools closest to a name the catalog does not have: the
 * name's tokens (`create_issue` → `create`, `issue`) ranked exactly as a
 * `search_tools` query is (D10), kept only when at least one token hit the
 * tool's NAME — a description-only hit (`directory` → `list_dir`) is too
 * loose to put in front of the model as "did you mean" — top `limit`.
 * Empty when nothing qualifies.
 *
 * The name is cut at `MAX_QUERY_CHARS` before ranking, the same R33 cap
 * `searchTools` applies to its query, so an unknown-name `call_tool` costs
 * what a `search_tools` call costs however long the guessed name is (the
 * catalog lookup it failed was an O(1) map miss; this is the first thing
 * that scans the catalog with the name).
 */
export function suggestTools(
  catalog: ServerCatalog,
  name: string,
  limit: number = SUGGESTION_LIMIT,
): string[] {
  const query = name.slice(0, MAX_QUERY_CHARS);
  // An empty query lists the whole catalog for search_tools; an empty name
  // suggests nothing.
  if (tokenize(query).length === 0) return [];
  return scoreTools(dedupeTools(catalog.tools), query)
    .filter((item) => item.nameHits > 0)
    .slice(0, Math.max(0, limit))
    .map((item) => item.entry.name);
}

/** A tool name — the caller's or the catalog's — quoted for an error (S5). */
function inertName(text: string): string {
  return JSON.stringify(capLength(neutralizeControlChars(text), MAX_IDENTITY_CHARS));
}

/** `"a"`, `"a" or "b"`, `"a", "b" or "c"`. */
function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1] ?? ''}`;
}

/**
 * The `validate` error for a tool name the catalog does not declare, from
 * `call_tool` or `describe_tool` (R34, R35): names the closest declared
 * tools when there are any, then points at `search_tools`. A model that
 * guessed `create_issue` learns `issue_write` in the same turn instead of
 * three turns later. Every name shown is S5-untrusted: neutralized, capped
 * and quoted.
 */
export function unknownToolError(
  catalog: ServerCatalog,
  name: string,
  via: 'call_tool' | 'describe_tool',
): ProjectionError {
  const suggestions = suggestTools(catalog, name).map(inertName);
  const didYouMean = suggestions.length === 0 ? '' : `Did you mean ${listNames(suggestions)}? `;
  return new ProjectionError(
    'validate',
    `Unknown tool ${inertName(name)}: the wrapped server does not declare it`,
    {
      hint: `${didYouMean}Call search_tools to list the tools this server declares, then ${via} with one of those names exactly.`,
    },
  );
}

/**
 * Tokens of a query: lowercased, NFC-normalized, split on anything that is
 * not a letter, combining mark, or digit — so a decomposed `é` stays inside
 * its word and matches a precomposed one in the catalog. Tokens under two
 * characters are dropped; when nothing survives, the whole trimmed query is
 * the one token.
 */
export function tokenize(query: string): string[] {
  const lowered = query.toLowerCase().normalize('NFC');
  const tokens = lowered.split(/[^\p{L}\p{M}\p{N}]+/u).filter((token) => token.length >= 2);
  // Nothing survived (one-letter words, or punctuation only): fall back to
  // the whole query as the single token so `a b` still means the literal `a b`.
  if (tokens.length > 0) return tokens;
  const whole = lowered.trim();
  return whole.length > 0 ? [whole] : [];
}

/**
 * Filter and rank the catalog for a query (D10). An empty query returns
 * every tool in catalog order; a query with no token at all (whitespace
 * only) matches nothing.
 */
function rankTools(tools: ToolCatalogEntry[], query: string): ToolCatalogEntry[] {
  if (query.length === 0) return tools;
  return scoreTools(tools, query).map((item) => item.entry);
}

/** One matching tool with the D10 score that ranked it. */
interface ScoredTool {
  entry: ToolCatalogEntry;
  /** `2 × nameHits + (tokens in the title or description)`. */
  score: number;
  /** Tokens that are substrings of the name (`suggestTools` requires one). */
  nameHits: number;
}

/**
 * The tools a query matches, best first (D10): a token scores +2 in the
 * name and, independently, +1 in the title or description. The sort is
 * stable, so equal scores keep catalog order and paging stays deterministic
 * for a given query. A query with no token matches nothing.
 */
function scoreTools(tools: ToolCatalogEntry[], query: string): ScoredTool[] {
  // Deduplicated: a repeated word must not count twice.
  const tokens = new Set(tokenize(query));
  if (tokens.size === 0) return [];
  const scored: ScoredTool[] = [];
  for (const entry of tools) {
    const name = entry.name.toLowerCase();
    const title = (entry.annotations?.title ?? '').toLowerCase();
    const description = (entry.description ?? '').toLowerCase();
    let nameHits = 0;
    let score = 0;
    for (const token of tokens) {
      // Additive: a token in both the name and the description scores 3.
      if (name.includes(token)) {
        nameHits += 1;
        score += 2;
      }
      if (title.includes(token) || description.includes(token)) score += 1;
    }
    if (score > 0) scored.push({ entry, score, nameHits });
  }
  return scored.sort((a, b) => b.score - a.score);
}

function renderPage(
  catalog: ServerCatalog,
  page: SearchToolsPage,
  query: string,
  offset: number,
  queryTruncated: boolean,
): string {
  const lines: string[] = [];
  if (queryTruncated) {
    lines.push(`(query truncated to its first ${MAX_QUERY_CHARS} characters)`, '');
  }
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
