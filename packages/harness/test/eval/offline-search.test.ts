/**
 * The offline discovery evals (src/eval/offline/): corpus integrity, the
 * catalogs, determinism, and regression floors on retrieval, invariance and
 * surface size. No model, no network: every number comes from the real
 * facade over fixture catalogs.
 */

import { describe, expect, it } from 'vitest';
import { CATALOG_NAMES, loadCatalog, MULTI_CATALOGS } from '../../src/eval/offline/catalogs.js';
import { describeInvariance, searchInvariance } from '../../src/eval/offline/metamorphic.js';
import {
  casesOf,
  loadSearchCorpus,
  runSearchCases,
  summarize,
  type SearchCase,
} from '../../src/eval/offline/search-eval.js';
import { measureSurfaces } from '../../src/eval/offline/surface.js';
import { syntheticCatalog, syntheticQueries } from '../../src/eval/offline/synthetic.js';

const corpus = loadSearchCorpus();

function catalogNames(c: SearchCase): Set<string> {
  if (c.surface === 'multi') {
    return new Set(
      MULTI_CATALOGS.flatMap((box) =>
        loadCatalog(box.catalog).tools.map((t) => `${box.alias}.${t.name}`),
      ),
    );
  }
  const alias = c.surface.startsWith('multi:') ? c.surface.slice('multi:'.length) : c.surface;
  const box = MULTI_CATALOGS.find((b) => b.alias === alias);
  return new Set(loadCatalog(box?.catalog ?? 'synthetic').tools.map((t) => t.name));
}

function tokenKey(query: string): string {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 0),
    ),
  ]
    .toSorted()
    .join(' ');
}

describe('offline search corpus', () => {
  it('has the catalogs it is labelled against', () => {
    expect(loadCatalog('github').tools).toHaveLength(95);
    expect(loadCatalog('fs').tools).toHaveLength(14);
    expect(loadCatalog('mongo').tools).toHaveLength(21);
    expect(loadCatalog('synthetic').tools.length).toBeGreaterThanOrEqual(1_000);
    for (const name of CATALOG_NAMES) {
      const names = loadCatalog(name).tools.map((t) => t.name);
      expect(new Set(names).size, name).toBe(names.length);
    }
  });

  it('labels every case with tools its surface declares', () => {
    expect(corpus.cases.length).toBeGreaterThan(1_000);
    for (const c of corpus.cases) {
      expect(c.gold.length, c.id).toBeGreaterThan(0);
      const names = catalogNames(c);
      for (const gold of c.gold) expect(names.has(gold), `${c.id} ${gold}`).toBe(true);
    }
  });

  it('draws on every source, with the content queries kept apart', () => {
    const sources = new Set(corpus.cases.map((c) => c.source));
    expect([...sources].toSorted()).toEqual([
      'generated',
      'handwritten',
      'recorded',
      'recorded-lifted',
    ]);
    expect(corpus.content.length).toBeGreaterThan(0);
    const scored = new Set(corpus.cases.map((c) => `${c.surface}\t${c.query}`));
    for (const q of corpus.content) expect(scored.has(`${q.surface}\t${q.query}`)).toBe(false);
  });

  it('stores a ~60/40 split that keeps a token set on one side', () => {
    const train = casesOf(corpus, 'train').length;
    expect(train / corpus.cases.length).toBeGreaterThan(0.55);
    expect(train / corpus.cases.length).toBeLessThan(0.65);
    const side = new Map<string, string>();
    for (const c of corpus.cases) {
      const key = tokenKey(c.query);
      expect(side.get(key) ?? c.split, c.id).toBe(c.split);
      side.set(key, c.split);
    }
  });

  it('generates the synthetic catalog and queries deterministically', () => {
    expect(syntheticCatalog()).toEqual(syntheticCatalog());
    expect(syntheticQueries(20, 1)).toEqual(syntheticQueries(20, 1));
    const generated = corpus.cases.filter((c) => c.source === 'generated');
    const names = new Set(syntheticCatalog().tools.map((t) => t.name));
    for (const c of generated) expect(names.has(c.gold[0] ?? '')).toBe(true);
  });
});

describe('offline search eval', () => {
  it('is deterministic', async () => {
    const sample = corpus.cases.filter((_, i) => i % 25 === 0);
    const a = await runSearchCases(sample);
    const b = await runSearchCases(sample);
    expect(a.map((r) => [r.rank, r.top, r.pageChars])).toEqual(
      b.map((r) => [r.rank, r.top, r.pageChars]),
    );
  });

  it('holds its retrieval floors on both splits', async () => {
    for (const split of ['train', 'test'] as const) {
      const m = summarize(await runSearchCases(casesOf(corpus, split)));
      expect(m.recallAt5, split).toBeGreaterThanOrEqual(0.91);
      expect(m.mrr, split).toBeGreaterThanOrEqual(0.81);
      // Cost guard: the mean first page stays under ~850 tokens (chars / 4).
      expect(m.pageTokens, split).toBeLessThan(850);
    }
  });

  it('is invariant enough to renames, order, wording and decoys', async () => {
    const cases = casesOf(corpus, 'train');
    const scores = await searchInvariance(cases);
    const mean = scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
    expect(mean).toBeGreaterThanOrEqual(0.98);
    const describes = await describeInvariance(cases);
    for (const d of describes) {
      if (d.transform === 'shuffle' || d.transform === 'decoys') expect(d.score).toBe(1);
    }
  });
});

describe('surface-size meter', () => {
  it('measures every world and mode, Projection under direct', async () => {
    const rows = await measureSurfaces();
    expect(rows).toHaveLength(11);
    for (const world of ['github', 'filesystem', 'mongodb', 'multi'] as const) {
      const direct = rows.find((r) => r.world === world && r.mode === 'direct');
      const projection = rows.find((r) => r.world === world && r.mode === 'projection');
      expect(direct?.describeChars).toBeUndefined();
      expect(projection?.describeChars).toBeGreaterThan(0);
      // filesystem fits the direct budget (D28): listed, so no search is offered.
      if (world === 'filesystem') expect(projection?.searchChars).toBeUndefined();
      else expect(projection?.searchChars).toBeGreaterThan(0);
      const projectionChars = (projection?.toolDefChars ?? 0) + (projection?.systemChars ?? 0);
      const directChars = (direct?.toolDefChars ?? 0) + (direct?.systemChars ?? 0);
      // A fully listed world carries the facade's own tools on top of the
      // listed ones, so it is larger than direct (a climb target, D28).
      if (world === 'filesystem') expect(projectionChars).toBeGreaterThan(directChars);
      else expect(projectionChars).toBeLessThan(directChars);
    }
    const multi = rows.find((r) => r.world === 'multi' && r.mode === 'direct');
    expect(multi?.tools).toBe(130);
  });
});
