/**
 * Metamorphic invariance checks for the search and describe surfaces: a
 * change to the catalog that should not change which tool serves a query —
 * a naming convention, the listing order, wording, unrelated extra tools —
 * should not move the gold tool's rank much.
 *
 * Transforms (each applied to every catalog, gold names mapped through it):
 *
 * - `camel`: every name to camelCase (`list_issues` → `listIssues`,
 *   `insert-many` → `insertMany`);
 * - `snake`: every name to snake_case (`listInvoices` → `list_invoices`,
 *   `insert-many` → `insert_many`);
 * - `prefix`: every name prefixed with its server (`github_list_issues`);
 * - `shuffle`: the catalog in a seeded random order;
 * - `synonyms`: descriptions and titles reworded with verb synonyms
 *   (get → retrieve, delete → remove, …); names untouched;
 * - `decoys`: 50 tools of an unrelated domain listed first (from the
 *   synthetic catalog; the synthetic catalog gets 50 GitHub tools).
 *
 * Search invariance of a transform = 1 − mean |RR_t − RR_0| over the cases
 * (1 = no case's reciprocal rank moved). Also reported: the share of cases
 * whose hit@5 flipped, and the mean |Δrank| (rank capped at depth + 1).
 *
 * Describe invariance: `describe_tool` on each gold tool. Under shuffle and
 * decoys its text must be byte-identical; under the renames, describing a
 * tool by the OTHER convention (the original name on the renamed catalog,
 * the renamed name on the original — what a model used to one convention
 * guesses) must come back with a did-you-mean that names the right tool.
 */

import type { CatalogFixture, CatalogName } from './catalogs.js';
import { loadCatalog, MULTI_CATALOGS } from './catalogs.js';
import { openOfflineFacade, type FacadeResult } from './facade.js';
import {
  defaultCatalogs,
  RANK_DEPTH,
  reciprocalRank,
  runSearchCases,
  type CaseResult,
  type CatalogSet,
  type SearchCase,
  type SearchSurface,
} from './search-eval.js';
import { seededRandom } from './synthetic.js';

export type TransformName = 'camel' | 'snake' | 'prefix' | 'shuffle' | 'synonyms' | 'decoys';
export const TRANSFORMS: readonly TransformName[] = [
  'camel',
  'snake',
  'prefix',
  'shuffle',
  'synonyms',
  'decoys',
];

const SEED = 7_777;

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}

function toCamel(name: string): string {
  const [first = '', ...rest] = nameWords(name);
  return first + rest.map((w) => (w[0] ?? '').toUpperCase() + w.slice(1)).join('');
}

function toSnake(name: string): string {
  return nameWords(name).join('_');
}

const PREFIX: Record<CatalogName, string> = {
  github: 'github',
  fs: 'fs',
  mongo: 'mongodb',
  synthetic: 'api',
};

/** Verb synonyms for `synonyms`: whole words, case kept on the first letter. */
const SYNONYMS: Readonly<Record<string, string>> = {
  get: 'retrieve',
  gets: 'retrieves',
  list: 'enumerate',
  lists: 'enumerates',
  create: 'make',
  creates: 'makes',
  delete: 'remove',
  deletes: 'removes',
  update: 'modify',
  updates: 'modifies',
  read: 'load',
  reads: 'loads',
  search: 'look up',
  find: 'locate',
  show: 'display',
  add: 'attach',
  run: 'execute',
  returns: 'gives back',
};

function reword(text: string): string {
  return text.replace(/\b[A-Za-z]+\b/g, (word) => {
    const swap = SYNONYMS[word.toLowerCase()];
    if (swap === undefined) return word;
    return word[0] === word[0]?.toUpperCase()
      ? (swap[0] ?? '').toUpperCase() + swap.slice(1)
      : swap;
  });
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function identity(name: string): string {
  return name;
}

function hitAt5(r: CaseResult): boolean {
  return r.rank !== undefined && r.rank <= 5;
}

/** A transformed catalog and the renaming it applied to tool names. */
interface Transformed {
  catalog: CatalogFixture;
  rename: (name: string) => string;
}

function transformCatalog(
  transform: TransformName,
  name: CatalogName,
  catalog: CatalogFixture,
): Transformed {
  const renameWith = (rename: (n: string) => string): Transformed => ({
    catalog: { ...catalog, tools: catalog.tools.map((t) => ({ ...t, name: rename(t.name) })) },
    rename,
  });
  switch (transform) {
    case 'camel':
      return renameWith(toCamel);
    case 'snake':
      return renameWith(toSnake);
    case 'prefix':
      return renameWith((n) => `${PREFIX[name]}_${n}`);
    case 'shuffle':
      return {
        catalog: { ...catalog, tools: shuffled(catalog.tools, seededRandom(SEED)) },
        rename: identity,
      };
    case 'synonyms':
      return {
        catalog: {
          ...catalog,
          tools: catalog.tools.map((t) => ({
            ...t,
            description: reword(t.description),
            ...(t.title !== undefined ? { title: reword(t.title) } : {}),
            ...(t.annotations?.title !== undefined
              ? { annotations: { ...t.annotations, title: reword(t.annotations.title) } }
              : {}),
          })),
        },
        rename: identity,
      };
    case 'decoys': {
      const pool = loadCatalog(name === 'synthetic' ? 'github' : 'synthetic').tools;
      const taken = new Set(catalog.tools.map((t) => t.name));
      const decoys = shuffled(pool, seededRandom(SEED))
        .filter((t) => !taken.has(t.name))
        .slice(0, 50);
      return { catalog: { ...catalog, tools: [...decoys, ...catalog.tools] }, rename: identity };
    }
  }
}

/** Every catalog under one transform, and the gold renaming per surface. */
export function transformAll(transform: TransformName): {
  catalogs: CatalogSet;
  renameGold: (surface: SearchSurface, name: string) => string;
} {
  const base = defaultCatalogs();
  const out = {} as Record<CatalogName, CatalogFixture>;
  const renames = {} as Record<CatalogName, (n: string) => string>;
  for (const name of Object.keys(base) as CatalogName[]) {
    const t = transformCatalog(transform, name, base[name]);
    out[name] = t.catalog;
    renames[name] = t.rename;
  }
  const aliasCatalog = new Map(MULTI_CATALOGS.map((b) => [b.alias as string, b.catalog]));
  return {
    catalogs: out,
    renameGold: (surface, gold) => {
      if (surface === 'multi') {
        const dot = gold.indexOf('.');
        const alias = gold.slice(0, dot);
        const catalog = aliasCatalog.get(alias);
        return catalog === undefined ? gold : `${alias}.${renames[catalog](gold.slice(dot + 1))}`;
      }
      const catalog = surface.startsWith('multi:')
        ? aliasCatalog.get(surface.slice('multi:'.length))
        : (surface as CatalogName);
      return catalog === undefined ? gold : renames[catalog](gold);
    },
  };
}

/** How much one transform moved the gold ranks. */
export interface Invariance {
  transform: TransformName;
  /** 1 − mean |ΔRR|. */
  score: number;
  /** Share of cases whose hit@5 flipped. */
  flips: number;
  /** Mean |Δrank|, ranks past the depth counted as depth + 1. */
  meanRankShift: number;
  /** Mean RR after the transform (before is the baseline's MRR). */
  mrr: number;
}

function cappedRank(r: CaseResult): number {
  return r.rank ?? RANK_DEPTH + 1;
}

export function compareRuns(
  transform: TransformName,
  before: readonly CaseResult[],
  after: readonly CaseResult[],
): Invariance {
  const n = before.length;
  let drr = 0;
  let flips = 0;
  let shift = 0;
  let mrr = 0;
  before.forEach((b, i) => {
    const a = after[i] as CaseResult;
    drr += Math.abs(reciprocalRank(a) - reciprocalRank(b));
    if (hitAt5(a) !== hitAt5(b)) flips += 1;
    shift += Math.abs(cappedRank(a) - cappedRank(b));
    mrr += reciprocalRank(a);
  });
  return {
    transform,
    score: n === 0 ? 1 : 1 - drr / n,
    flips: n === 0 ? 0 : flips / n,
    meanRankShift: n === 0 ? 0 : shift / n,
    mrr: n === 0 ? 0 : mrr / n,
  };
}

/** Search invariance for every transform, against a baseline run of the same cases. */
export async function searchInvariance(
  cases: readonly SearchCase[],
  baseline?: readonly CaseResult[],
): Promise<Invariance[]> {
  const before = baseline ?? (await runSearchCases(cases));
  const out: Invariance[] = [];
  for (const transform of TRANSFORMS) {
    const { catalogs, renameGold } = transformAll(transform);
    out.push(compareRuns(transform, before, await runSearchCases(cases, { catalogs, renameGold })));
  }
  return out;
}

/** The R25 error's hint (the did-you-mean lives there), or the text. */
function hintOf(result: FacadeResult): string {
  const hint = result.structured?.['hint'];
  return typeof hint === 'string' ? hint : result.text;
}

/** Describe-surface invariance for one transform. */
export interface DescribeInvariance {
  transform: TransformName;
  /** Tools checked. */
  tools: number;
  /**
   * shuffle/decoys: share of describe texts byte-identical to the baseline;
   * renames: share of guessed-convention describes (the original name on
   * the renamed catalog, and the renamed name on the original one) whose
   * did-you-mean names the right tool. Undefined for `synonyms` (the description changes by design).
   */
  score: number | undefined;
}

/**
 * Describe invariance on the three world catalogs (single-server facades),
 * over every gold tool the corpus names there.
 */
export async function describeInvariance(
  cases: readonly SearchCase[],
): Promise<DescribeInvariance[]> {
  const golds = new Map<CatalogName, Set<string>>();
  for (const c of cases) {
    if (c.surface === 'synthetic' || c.surface === 'multi') continue;
    const name = (c.surface.startsWith('multi:') ? c.surface.slice(6) : c.surface) as CatalogName;
    const set = golds.get(name) ?? new Set<string>();
    c.gold.forEach((g) => set.add(g));
    golds.set(name, set);
  }
  const base = defaultCatalogs();
  const baseline = new Map<string, string>();
  for (const [name, tools] of golds) {
    const facade = await openOfflineFacade({ kind: 'single', catalog: base[name] });
    try {
      for (const tool of tools) {
        baseline.set(`${name}\t${tool}`, (await facade.call('describe_tool', { name: tool })).text);
      }
    } finally {
      await facade.close();
    }
  }
  const out: DescribeInvariance[] = [];
  for (const transform of TRANSFORMS) {
    if (transform === 'synonyms') {
      out.push({ transform, tools: baseline.size, score: undefined });
      continue;
    }
    const { catalogs, renameGold } = transformAll(transform);
    let good = 0;
    let total = 0;
    for (const [name, tools] of golds) {
      const renamedFacade = await openOfflineFacade({ kind: 'single', catalog: catalogs[name] });
      const baseFacade = await openOfflineFacade({ kind: 'single', catalog: base[name] });
      try {
        for (const tool of tools) {
          const renamed = renameGold(name as SearchSurface, tool);
          if (renamed === tool) {
            total += 1;
            const result = await renamedFacade.call('describe_tool', { name: tool });
            if (result.text === baseline.get(`${name}\t${tool}`)) good += 1;
            continue;
          }
          // Both directions: the usual name guessed on the renamed catalog,
          // and the renamed convention guessed on the original one.
          for (const [facade, guess, want] of [
            [renamedFacade, tool, renamed],
            [baseFacade, renamed, tool],
          ] as const) {
            total += 1;
            const result = await facade.call('describe_tool', { name: guess });
            if (result.isError && hintOf(result).includes(JSON.stringify(want))) good += 1;
          }
        }
      } finally {
        await renamedFacade.close();
        await baseFacade.close();
      }
    }
    out.push({ transform, tools: total, score: total === 0 ? 1 : good / total });
  }
  return out;
}
