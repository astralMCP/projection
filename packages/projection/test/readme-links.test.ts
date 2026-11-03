import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { micromark } from 'micromark';
import { describe, expect, it } from 'vitest';

// npm shows packages/projection/README.md, but `files: ['dist']` ships
// nothing else from the repo, so every reference to a repo file must be an
// absolute GitHub link.
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(pkgRoot, '..', '..');
const BLOB = 'https://github.com/astralMCP/projection/blob/main/';

const readme = readFileSync(join(pkgRoot, 'README.md'), 'utf8');
const html = micromark(readme, { allowDangerousHtml: true });

const unescape = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const urls = [...html.matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => unescape(m[1]!));
const codeSpans = [...html.matchAll(/<code>([^<]*)<\/code>/g)].map((m) => unescape(m[1]!));

/** GitHub's heading anchor: lowercase, drop punctuation, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function anchors(file: string): Set<string> {
  const text = readFileSync(file, 'utf8').replace(/^```[\s\S]*?^```/gm, '');
  return new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]!)));
}

describe('packages/projection/README.md links (npm readers)', () => {
  it('has no relative links', () => {
    const relative = urls.filter((u) => !/^(https?:|mailto:|#)/.test(u));
    expect(relative).toEqual([]);
  });

  it('names no repo file as a bare path', () => {
    const paths = codeSpans.filter(
      (c) =>
        /^[\w.@-]+(\/[\w.@-]+)*$/.test(c) &&
        (c.includes('/') || /\.\w+$/.test(c)) &&
        !c.startsWith('dist/') &&
        (existsSync(join(repoRoot, c)) || existsSync(join(pkgRoot, c))),
    );
    expect(paths).toEqual([]);
  });

  it('points every repo link at a file and heading that exist', () => {
    const repoLinks = urls.filter((u) => u.startsWith(BLOB));
    expect(repoLinks.length).toBeGreaterThan(0);
    for (const url of repoLinks) {
      const [path, anchor] = url.slice(BLOB.length).split('#');
      const file = join(repoRoot, decodeURIComponent(path!));
      expect(existsSync(file), url).toBe(true);
      if (anchor !== undefined) expect(anchors(file).has(anchor), url).toBe(true);
    }
  });
});
