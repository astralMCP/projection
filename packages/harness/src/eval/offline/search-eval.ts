/**
 * Offline search-retrieval eval: how well the facade's search tools rank
 * the tool a query is after, measured on fixture catalogs through the real
 * facade, with no model and no network — deterministic and free.
 *
 * Corpus (`test/fixtures/search-corpus.json`, built by
 * `.claude/hillclimb/multi-server/explore/offline-search/build-corpus.ts`):
 * (surface, query, gold tools) cases from four sources —
 *
 * - `recorded`: distinct queries models actually sent to `search_tools` /
 *   `search_<alias>` in recorded eval episodes, labelled with the tools the
 *   model went on to use (filtered by intent) — see the builder;
 * - `recorded-lifted`: the same queries against the 130-tool global
 *   `search_tools` of the three-box facade;
 * - `handwritten`: user-style queries for each catalog and the global search;
 * - `generated`: seeded queries over the ~1,000-tool synthetic catalog,
 *   half of them paraphrases.
 *
 * Plus `content`: queries for DATA ("CSV export", "widgets") that no tool
 * ranking can satisfy; counted, never scored.
 *
 * A surface is where the query is sent: `github` / `fs` / `mongo` /
 * `synthetic` (a single-server facade's `search_tools`), `multi` (the
 * three-box facade's `search_tools`), `multi:<alias>` (its
 * `search_<alias>`). Cases are split train/test by a fixed seed, stored in
 * the fixture.
 *
 * Metrics per case, against the facade's ranking (pages followed to
 * {@link RANK_DEPTH}): `hit@k` — any gold tool in the top k (the corpus
 * reports it as recall@k: a case's gold is a set of acceptable tools, any
 * one of which serves the query) — and the reciprocal rank of the first
 * gold tool (0 past the depth). Cost: the characters of the first result
 * page's text, which is what the model reads; tokens ≈ chars / 4 (an
 * approximation, not a tokenizer).
 */

import corpusFixture from '../../../test/fixtures/search-corpus.json' with { type: 'json' };
import { loadCatalog, MULTI_CATALOGS, type CatalogFixture, type CatalogName } from './catalogs.js';
import { openOfflineFacade, type OfflineFacade } from './facade.js';

export type SearchSurface =
  | 'github'
  | 'fs'
  | 'mongo'
  | 'synthetic'
  | 'multi'
  | 'multi:github'
  | 'multi:fs'
  | 'multi:mongo';

export type CaseSource = 'recorded' | 'recorded-lifted' | 'handwritten' | 'generated';
export type Split = 'train' | 'test';

export interface SearchCase {
  id: string;
  surface: SearchSurface;
  query: string;
  /**
   * Acceptable tools: bare names, except on `multi` where they are
   * qualified (`github.list_issues`); `multi:<alias>` results come back
   * qualified and are matched against `<alias>.<gold>`.
   */
  gold: string[];
  source: CaseSource;
  split: Split;
  seen?: number;
  label?: 'used' | 'intent';
  paraphrase?: boolean;
}

export interface SearchCorpus {
  seed: number;
  trainFraction: number;
  recordedEpisodes: number;
  cases: SearchCase[];
  content: { surface: SearchSurface; query: string; seen: number }[];
}

export function loadSearchCorpus(): SearchCorpus {
  return corpusFixture as unknown as SearchCorpus;
}

/** How deep a ranking is followed (two default pages); a gold tool past it scores 0. */
export const RANK_DEPTH = 100;
/** The cost proxy: approximate tokens of a text. */
export function approxTokens(chars: number): number {
  return chars / 4;
}

/** The catalogs a run uses: the fixtures, or transformed copies (metamorphic.ts). */
export type CatalogSet = Readonly<Record<CatalogName, CatalogFixture>>;

export function defaultCatalogs(): CatalogSet {
  return {
    github: loadCatalog('github'),
    fs: loadCatalog('fs'),
    mongo: loadCatalog('mongo'),
    synthetic: loadCatalog('synthetic'),
  };
}

/** One case's outcome. */
export interface CaseResult {
  case: SearchCase;
  /** 1-based rank of the first gold tool, undefined past {@link RANK_DEPTH} or unmatched. */
  rank: number | undefined;
  /** The top five names returned. */
  top: string[];
  /** Characters of the first page's text. */
  pageChars: number;
  /** Matching tools in total (the page's `total`). */
  total: number;
}

/** Facades for each surface family, opened lazily and shared by a run. */
class Facades {
  private readonly open = new Map<string, Promise<OfflineFacade>>();
  constructor(private readonly catalogs: CatalogSet) {}

  /** The facade and search tool that serve `surface`. */
  async for(surface: SearchSurface): Promise<{ facade: OfflineFacade; tool: string }> {
    if (surface.startsWith('multi')) {
      const facade = await this.get('multi', () =>
        openOfflineFacade({
          kind: 'multi',
          boxes: MULTI_CATALOGS.map((box) => ({
            alias: box.alias,
            catalog: this.catalogs[box.catalog],
          })),
        }),
      );
      const box = surface.split(':')[1];
      return { facade, tool: box === undefined ? 'search_tools' : `search_${box}` };
    }
    const name = surface as CatalogName;
    const facade = await this.get(name, () =>
      openOfflineFacade({ kind: 'single', catalog: this.catalogs[name] }),
    );
    return { facade, tool: 'search_tools' };
  }

  private get(key: string, make: () => Promise<OfflineFacade>): Promise<OfflineFacade> {
    let facade = this.open.get(key);
    if (facade === undefined) {
      facade = make();
      this.open.set(key, facade);
    }
    return facade;
  }

  async close(): Promise<void> {
    await Promise.all([...this.open.values()].map(async (f) => (await f).close()));
  }
}

interface PageView {
  tools?: { name?: unknown }[];
  total?: unknown;
  nextCursor?: unknown;
}

/** Run a search to {@link RANK_DEPTH}: the ranked names, the first page's text and the total. */
async function rankFor(
  facade: OfflineFacade,
  tool: string,
  query: string,
): Promise<{ names: string[]; firstText: string; total: number }> {
  const names: string[] = [];
  let firstText = '';
  let total = 0;
  let cursor: string | undefined;
  do {
    const result = await facade.call(tool, cursor !== undefined ? { query, cursor } : { query });
    if (result.isError) throw new Error(`${tool} ${JSON.stringify(query)}: ${result.text}`);
    const page = (result.structured ?? {}) as PageView;
    if (cursor === undefined) {
      firstText = result.text;
      total = typeof page.total === 'number' ? page.total : 0;
    }
    for (const entry of page.tools ?? [])
      if (typeof entry.name === 'string') names.push(entry.name);
    cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
  } while (cursor !== undefined && names.length < RANK_DEPTH);
  return { names: names.slice(0, RANK_DEPTH), firstText, total };
}

export interface RunOptions {
  catalogs?: CatalogSet;
  /** Rename gold tools for transformed catalogs (metamorphic renames). */
  renameGold?: (surface: SearchSurface, name: string) => string;
}

/** A gold name as `surface`'s results name it. */
function qualified(surface: SearchSurface, gold: string): string {
  return surface.startsWith('multi:') ? `${surface.slice('multi:'.length)}.${gold}` : gold;
}

/** Run every case through its surface's search tool. */
export async function runSearchCases(
  cases: readonly SearchCase[],
  options: RunOptions = {},
): Promise<CaseResult[]> {
  const facades = new Facades(options.catalogs ?? defaultCatalogs());
  try {
    const results: CaseResult[] = [];
    for (const c of cases) {
      const { facade, tool } = await facades.for(c.surface);
      const { names, firstText, total } = await rankFor(facade, tool, c.query);
      const gold = new Set(
        c.gold
          .map((g) => (options.renameGold !== undefined ? options.renameGold(c.surface, g) : g))
          .map((g) => qualified(c.surface, g)),
      );
      const index = names.findIndex((name) => gold.has(name));
      results.push({
        case: c,
        rank: index === -1 ? undefined : index + 1,
        top: names.slice(0, 5),
        pageChars: firstText.length,
        total,
      });
    }
    return results;
  } finally {
    await facades.close();
  }
}

/** Aggregate metrics over a set of case results. */
export interface SearchMetrics {
  cases: number;
  recallAt1: number;
  recallAt5: number;
  mrr: number;
  /** Mean characters of the first result page. */
  pageChars: number;
  /** {@link pageChars} / 4. */
  pageTokens: number;
}

export function reciprocalRank(result: CaseResult): number {
  return result.rank === undefined ? 0 : 1 / result.rank;
}

export function summarize(results: readonly CaseResult[]): SearchMetrics {
  const n = results.length;
  const mean = (f: (r: CaseResult) => number): number =>
    n === 0 ? 0 : results.reduce((sum, r) => sum + f(r), 0) / n;
  const pageChars = mean((r) => r.pageChars);
  return {
    cases: n,
    recallAt1: mean((r) => (r.rank === 1 ? 1 : 0)),
    recallAt5: mean((r) => (r.rank !== undefined && r.rank <= 5 ? 1 : 0)),
    mrr: mean(reciprocalRank),
    pageChars,
    pageTokens: approxTokens(pageChars),
  };
}

/** Group results by a key and summarize each group, in first-seen key order. */
export function summarizeBy(
  results: readonly CaseResult[],
  key: (r: CaseResult) => string,
): Map<string, SearchMetrics> {
  const groups = new Map<string, CaseResult[]>();
  for (const r of results) {
    const k = key(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return new Map([...groups].map(([k, rs]) => [k, summarize(rs)]));
}

/** The cases of one split, or all. */
export function casesOf(corpus: SearchCorpus, split: Split | 'all'): SearchCase[] {
  return split === 'all' ? corpus.cases : corpus.cases.filter((c) => c.split === split);
}
