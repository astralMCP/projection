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
import { isBoxedCatalog, splitQualified, type BoxedCatalog, type BoxedTool } from './boxes.js';
import {
  dedupeTools,
  type PolicyContext,
  type PolicyOptions,
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

/** The policy options (R14, R49) decide the rendered posture. */
export interface SearchToolsOptions extends PolicyOptions {
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
  const context = policyContext(options);
  const { page, query, offset, queryTruncated } = paginate(
    args,
    options.pageSize,
    undefined,
    // First occurrence wins, as for `findTool` and typegen (S5).
    (q) => rankTools(dedupeTools(catalog.tools), q),
    (entry) => summarizeTool(entry, context),
  );
  return {
    content: [{ type: 'text', text: renderPage(catalog, page, query, offset, queryTruncated) }],
    structuredContent: { ...page },
  };
}

/** One page of a search, with the normalized query it answered. */
interface Paged<S> {
  page: { tools: S[]; total: number; nextCursor?: string };
  /** The query after truncation to {@link MAX_QUERY_CHARS}. */
  query: string;
  offset: number;
  queryTruncated: boolean;
}

/**
 * The paging every search tool shares (R33, R43): clamp the page size,
 * truncate the query, decode the cursor (bound to `tool` when given), rank
 * with `rank`, refuse an offset past the end, and assemble the page with its
 * next cursor. Cursors are unauthenticated paging hints, not a security
 * boundary: a forged one can only select another page of results the caller
 * may list anyway — every name it leads to is still resolved, gated and
 * approved by the call path.
 */
function paginate<T, S>(
  args: SearchToolsArgs,
  pageSizeOption: number | undefined,
  tool: string | undefined,
  rank: (query: string) => readonly T[],
  summarize: (item: T) => S,
): Paged<S> {
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, pageSizeOption ?? DEFAULT_SEARCH_PAGE_SIZE));
  // Slice, not capLength: an ellipsis would change what the filter matches.
  const rawQuery = args.query ?? '';
  const query = rawQuery.slice(0, MAX_QUERY_CHARS);
  const queryTruncated = rawQuery.length > MAX_QUERY_CHARS;
  const offset = decodeCursor(args.cursor, query, tool);

  const matches = rank(query);
  // A cursor is only ever issued while more results remain, so an offset at
  // or beyond the end was not issued by us (or not for this catalog): refuse
  // it rather than answer with an empty page that contradicts `total`.
  if (offset > 0 && offset >= matches.length) {
    throw cursorError('cursor is past the end of the results', tool);
  }
  const slice = matches.slice(offset, offset + pageSize);
  const end = offset + slice.length;
  return {
    page: {
      tools: slice.map(summarize),
      total: matches.length,
      ...(end < matches.length ? { nextCursor: encodeCursor(query, end, tool) } : {}),
    },
    query,
    offset,
    queryTruncated,
  };
}

// ---------------------------------------------------------------------------
// Multi-server facades: one search across every box (R43)
// ---------------------------------------------------------------------------

/** One entry of a multi-server search page (R43): the R33 entry plus its box. */
export interface BoxedToolSummary extends ToolSummary {
  /** The box (alias) the tool lives in; `name` is qualified with it. */
  box: string;
}

export interface BoxedSearchPage {
  tools: BoxedToolSummary[];
  /** Matching tools across all pages. */
  total: number;
  nextCursor?: string;
}

export interface SearchBoxesOptions extends SearchToolsOptions {
  /**
   * The search tool being served, which its cursors are bound to (R43).
   * Default `search_tools`.
   */
  tool?: string;
}

/**
 * Run `search_tools` on a multi-server facade (R43): R33 semantics over
 * every box, scored per tool against its bare name, title and description,
 * plus alias tokens (see {@link scoreBoxedTools}); ties in sorted alias
 * order, then catalog order. Entries are `{ name, box, purpose, posture,
 * destructive }` with `name` qualified; `posture` is decided on the
 * qualified entry, so it is the posture the gate applies (R42). Cursors
 * carry the issuing tool (`{ t, q, o }`) and are refused anywhere else. The
 * first page of an empty query leads with the per-box tool counts, so one
 * large box cannot hide the others.
 */
export function searchBoxes(
  catalog: BoxedCatalog,
  args: SearchToolsArgs,
  options: SearchBoxesOptions = {},
): CallToolResult {
  const tool = options.tool ?? 'search_tools';
  const context = policyContext(options);
  const members = [...catalog.members.values()];
  const aliases = new Set(catalog.boxes.keys());
  const { page, query, offset, queryTruncated } = paginate(
    args,
    options.pageSize,
    tool,
    (q) => (q.length === 0 ? members : scoreBoxedTools(members, q, aliases).map((i) => i.member)),
    (member): BoxedToolSummary => ({
      ...summarizeTool(member.qualified, context),
      box: member.alias,
    }),
  );
  const result: BoxedSearchPage = page;

  const lines: string[] = [];
  if (queryTruncated) {
    lines.push(`(query truncated to its first ${MAX_QUERY_CHARS} characters)`, '');
  }
  // Aliases are host-chosen and grammar-checked (R39): safe to print raw.
  const countsLine = query.length === 0 && offset === 0;
  if (countsLine) {
    const counts = [...catalog.counts].map(
      ([alias, count]) => `${alias} (${count} ${count === 1 ? 'tool' : 'tools'})`,
    );
    lines.push(`Boxes: ${counts.join(', ')}.`);
  }
  // R39: a surface that spans the facade names the sorted alias list (the
  // counts line already does on an empty query's first page).
  const scopeLabel = countsLine ? undefined : `in boxes ${[...aliases].join(', ')}`;
  lines.push(...renderEntries(result, query, offset, tool, 'in any box', scopeLabel));
  lines.push(
    '',
    'Tool names are qualified as <box>.<tool>. Call describe_tool with a name before calling a tool whose arguments you have not seen.',
  );
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: { ...result },
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
 *
 * On a multi-server view (R40) the suggestions are qualified names: when the
 * name's alias part is a wrapped box they come from that box only, ranked
 * on the rest of the name; an unqualified name or an unknown alias ranks
 * across every box, with R43's alias tokens. Either way each tool is scored
 * against its bare name, title and description, so a hostile server cannot
 * be suggested for a name qualified with another box's alias (S5).
 */
export function suggestTools(
  catalog: ServerCatalog,
  name: string,
  limit: number = SUGGESTION_LIMIT,
): string[] {
  if (isBoxedCatalog(catalog)) return suggestBoxedTools(catalog, name, limit);
  const query = name.slice(0, MAX_QUERY_CHARS);
  // An empty query lists the whole catalog for search_tools; an empty name
  // suggests nothing.
  if (tokenize(query).length === 0) return [];
  return scoreTools(dedupeTools(catalog.tools), query)
    .filter((item) => item.nameHits > 0)
    .slice(0, Math.max(0, limit))
    .map((item) => item.entry.name);
}

function suggestBoxedTools(catalog: BoxedCatalog, name: string, limit: number): string[] {
  const split = splitQualified(name);
  const scoped = split !== undefined && catalog.boxes.has(split.alias) ? split : undefined;
  const query = (scoped !== undefined ? scoped.rest : name).slice(0, MAX_QUERY_CHARS);
  if (tokenize(query).length === 0) return [];
  const members = [...catalog.members.values()].filter(
    (member) => scoped === undefined || member.alias === scoped.alias,
  );
  // Inside one box there is nothing for an alias token to select.
  const aliases = scoped !== undefined ? new Set<string>() : new Set(catalog.boxes.keys());
  return scoreBoxedTools(members, query, aliases)
    .filter((item) => item.nameHits > 0)
    .slice(0, Math.max(0, limit))
    .map((item) => item.member.qualified.name);
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
 * and quoted. On a multi-server view the message says which part of the
 * qualified name failed and the suggestions are qualified (R40).
 */
export function unknownToolError(
  catalog: ServerCatalog,
  name: string,
  via: 'call_tool' | 'describe_tool',
): ProjectionError {
  const suggestions = suggestTools(catalog, name).map(inertName);
  const didYouMean = suggestions.length === 0 ? '' : `Did you mean ${listNames(suggestions)}? `;
  if (isBoxedCatalog(catalog)) return unknownBoxedToolError(catalog, name, via, didYouMean);
  return new ProjectionError(
    'validate',
    `Unknown tool ${inertName(name)}: the wrapped server does not declare it`,
    {
      hint: `${didYouMean}Call search_tools to list the tools this server declares, then ${via} with one of those names exactly.`,
    },
  );
}

function unknownBoxedToolError(
  catalog: BoxedCatalog,
  name: string,
  via: 'call_tool' | 'describe_tool',
  didYouMean: string,
): ProjectionError {
  const split = splitQualified(name);
  // Aliases are host-chosen and grammar-checked (R39): safe to print raw.
  const boxes = [...catalog.boxes.keys()].join(', ');
  let why: string;
  if (split === undefined) {
    why = `tool names here are qualified as <box>.<tool> (boxes: ${boxes})`;
  } else if (catalog.boxes.has(split.alias)) {
    why = `the ${split.alias} box does not declare it`;
  } else {
    why = `there is no box ${inertName(split.alias)} (boxes: ${boxes})`;
  }
  return new ProjectionError('validate', `Unknown tool ${inertName(name)}: ${why}`, {
    // TODO(PR3): name the per-box search_<alias> tools once they are served (R43).
    hint: `${didYouMean}Call search_tools to list the tools every box declares, then ${via} with one of those qualified names exactly.`,
  });
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
  const tokens = splitWords(query).filter((token) => token.length >= 2);
  // Nothing survived (one-letter words, or punctuation only): fall back to
  // the whole query as the single token so `a b` still means the literal `a b`.
  if (tokens.length > 0) return tokens;
  const whole = lowered.trim();
  return whole.length > 0 ? [whole] : [];
}

/** A query's words, lowercased and NFC-normalized, of any length (empty strings dropped). */
function splitWords(query: string): string[] {
  return query
    .toLowerCase()
    .normalize('NFC')
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((word) => word.length > 0);
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
    const { score, nameHits } = scoreEntry(entry, tokens);
    if (score > 0) scored.push({ entry, score, nameHits });
  }
  return scored.sort((a, b) => b.score - a.score);
}

/** One tool's D10 score for a set of tokens (shared by every ranking). */
function scoreEntry(
  entry: ToolCatalogEntry,
  tokens: ReadonlySet<string>,
): { score: number; nameHits: number } {
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
  return { score, nameHits };
}

/** A boxed tool with its R43 score. */
interface ScoredBoxedTool {
  member: BoxedTool;
  score: number;
  nameHits: number;
}

/** Score an alias token adds to every tool of its box (R43). */
const ALIAS_TOKEN_SCORE = 2;

/**
 * R43 ranking across boxes: D10 against each tool's BARE name, title and
 * description, except that a token equal to a wrapped alias (in `aliases`)
 * is an alias token — it adds 2 to every tool in that box and is matched
 * against no tool's text, so a server cannot outrank another box's tools for
 * that box's alias by writing the alias into its own text (S5). The sort is
 * stable over `members`, which arrive in sorted-alias-then-catalog order:
 * that is the tie-break.
 */
function scoreBoxedTools(
  members: readonly BoxedTool[],
  query: string,
  aliases: ReadonlySet<string>,
): ScoredBoxedTool[] {
  // Alias tokens come from the raw split, before `tokenize` drops words
  // under two characters, so a one-letter alias still boosts its box in a
  // multi-word query ("a files").
  const aliasTokens = new Set(splitWords(query).filter((word) => aliases.has(word)));
  const textTokens = new Set(tokenize(query).filter((token) => !aliasTokens.has(token)));
  if (aliasTokens.size === 0 && textTokens.size === 0) return [];
  const scored: ScoredBoxedTool[] = [];
  for (const member of members) {
    const { score, nameHits } = scoreEntry(member.entry, textTokens);
    const boost = aliasTokens.has(member.alias) ? ALIAS_TOKEN_SCORE : 0;
    if (score + boost > 0) scored.push({ member, score: score + boost, nameHits });
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
  lines.push(
    ...renderEntries(
      page,
      query,
      offset,
      'search_tools',
      `on server ${inertIdentity(catalog.identity)}`,
      `server ${inertIdentity(catalog.identity)}`,
    ),
  );
  lines.push(
    '',
    'Call describe_tool with a name before calling a tool whose arguments you have not seen.',
  );
  return lines.join('\n');
}

/**
 * The page body every search tool shares: the header, one line per tool,
 * and the next-cursor pointer. `where` ends the empty-page line; `scopeLabel`
 * is the parenthesized scope of the header, when there is one.
 */
function renderEntries(
  page: { tools: ToolSummary[]; total: number; nextCursor?: string },
  query: string,
  offset: number,
  tool: string,
  where: string,
  scopeLabel?: string,
): string[] {
  const lines: string[] = [];
  const scope =
    query.length > 0 ? ` matching ${JSON.stringify(neutralizeControlChars(query))}` : '';
  if (page.tools.length === 0) {
    lines.push(`No tools${scope} ${where}.`);
  } else {
    const label = scopeLabel !== undefined ? ` (${scopeLabel})` : '';
    lines.push(
      `Tools ${offset + 1}–${offset + page.tools.length} of ${page.total}${scope}${label}:`,
    );
    for (const entry of page.tools) {
      // Names and purposes are S5-controlled: neutralize so a hostile value
      // cannot forge a line of its own (e.g. relabel a write as "runs
      // immediately"). The purpose is already inline-neutralized and capped
      // by `purposeSentence`; the posture is rendered by us, after the data.
      const name = capLength(neutralizeControlChars(entry.name), MAX_IDENTITY_CHARS);
      const flags = entry.destructive ? `${entry.posture}, destructive` : entry.posture;
      lines.push(`- ${name} — ${entry.purpose} [${flags}]`);
    }
  }
  if (page.nextCursor !== undefined) {
    lines.push(
      '',
      `More tools follow: call ${tool} again with cursor ${JSON.stringify(page.nextCursor)}.`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Cursor: opaque, bound to the query that produced it (R33)
// ---------------------------------------------------------------------------

interface CursorPayload {
  /** The search tool that issued the cursor; multi-server facades only (R43). */
  t?: string;
  q: string;
  o: number;
}

/**
 * Encode a page cursor. A multi-server search binds it to its issuing tool
 * (`t`, R43); a single-server `search_tools` cursor stays `{ q, o }`.
 */
function encodeCursor(query: string, offset: number, tool?: string): string {
  const payload: CursorPayload =
    tool !== undefined ? { t: tool, q: query, o: offset } : { q: query, o: offset };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function cursorError(why: string, tool = 'search_tools'): ProjectionError {
  return new ProjectionError('validate', `${tool} cursor is not usable: ${why}`, {
    hint: `Pass a cursor exactly as a previous ${tool} result returned it, with the same query; or omit it to start from the first page.`,
  });
}

/**
 * Decode a cursor to its offset. Only the fields read (`q`, `o`, and `t`
 * when `tool` is given) are validated: a payload carrying extra keys is
 * accepted, since the cursor is opaque data and nothing else in it is
 * consumed. The offset's upper bound is checked by the caller once the
 * match count is known. With `tool`, the cursor must have been issued by
 * that tool (R43): a cursor without `t`, or from another search tool, is
 * refused.
 */
function decodeCursor(cursor: string | undefined, query: string, tool?: string): number {
  if (cursor === undefined || cursor.length === 0) return 0;
  if (cursor.length > 1_024) throw cursorError('too long', tool);
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw cursorError('malformed', tool);
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as CursorPayload).q !== 'string' ||
    typeof (payload as CursorPayload).o !== 'number'
  ) {
    throw cursorError('malformed', tool);
  }
  const { t, q, o } = payload as CursorPayload;
  if (!Number.isInteger(o) || o < 0) throw cursorError('malformed', tool);
  if (tool !== undefined && t !== tool) {
    throw cursorError(
      typeof t === 'string' ? 'it was issued by another search tool' : 'malformed',
      tool,
    );
  }
  if (q !== query) throw cursorError('it was issued for a different query', tool);
  return o;
}
