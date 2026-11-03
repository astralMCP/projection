/**
 * `.env` discovery for the harness's live tests: walks up from cwd, loads via Node's
 * built-in parser, and never overrides variables already exported.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadNearestDotEnv } from '../src/env.js';

const VAR = 'PROJ_ENV_TEST_VAR';
const cleanups: (() => void)[] = [];

afterEach(() => {
  delete process.env[VAR];
  while (cleanups.length > 0) cleanups.pop()?.();
});

function makeTree(): { root: string; nested: string } {
  const root = mkdtempSync(join(tmpdir(), 'proj-env-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const nested = join(root, 'packages', 'member');
  mkdirSync(nested, { recursive: true });
  return { root, nested };
}

describe('loadNearestDotEnv', () => {
  it('walks up from a nested cwd to the repo-root .env', () => {
    const { root, nested } = makeTree();
    writeFileSync(join(root, '.env'), `${VAR}=from-file\n`);

    const loaded = loadNearestDotEnv(nested);

    expect(loaded).toBe(join(root, '.env'));
    expect(process.env[VAR]).toBe('from-file');
  });

  it('does not load a .env above a repo-root marker (pnpm-workspace.yaml)', () => {
    const { root } = makeTree();
    const repo = join(root, 'repo');
    const start = join(repo, 'packages', 'member');
    mkdirSync(start, { recursive: true });
    writeFileSync(join(root, '.env'), `${VAR}=from-ancestor\n`);
    writeFileSync(join(repo, 'pnpm-workspace.yaml'), 'packages:\n');

    const loaded = loadNearestDotEnv(start);

    expect(loaded).toBeUndefined();
    expect(process.env[VAR]).toBeUndefined();
  });

  it('still reaches the repo-root .env past a workspace package.json', () => {
    const { root, nested } = makeTree();
    writeFileSync(join(root, '.env'), `${VAR}=from-file\n`);
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n');
    writeFileSync(join(nested, 'package.json'), '{"name":"member"}\n');

    const loaded = loadNearestDotEnv(nested);

    expect(loaded).toBe(join(root, '.env'));
    expect(process.env[VAR]).toBe('from-file');
  });

  it('walks past a linked git worktree (.git file) to the main repo root .env', () => {
    const { root } = makeTree();
    // Layout mirrors .claude/worktrees: main repo root (.git DIR) holds the
    // .env; the worktree checkout has a .git FILE plus the workspace
    // manifest, and its gitdir pointer derives a main-repo root that
    // CONTAINS the worktree, so the walk continues up to that root.
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.env'), `${VAR}=from-main-repo\n`);
    const worktree = join(root, '.claude', 'worktrees', 'wt');
    const start = join(worktree, 'packages', 'harness');
    mkdirSync(start, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(root, '.git', 'worktrees', 'wt')}\n`);
    writeFileSync(join(worktree, 'pnpm-workspace.yaml'), 'packages:\n');

    const loaded = loadNearestDotEnv(start);

    expect(loaded).toBe(join(root, '.env'));
    expect(process.env[VAR]).toBe('from-main-repo');
  });

  it('external worktree: never loads a .env from ancestors outside the main repo', () => {
    const { root: home } = makeTree();
    // `git worktree add ~/wt/proj` from a repo elsewhere: $HOME has its own
    // .git DIR and a stray .env. The derived main-repo root does not
    // contain the worktree, so the walk must terminate at the worktree and
    // never reach $HOME.
    mkdirSync(join(home, '.git'), { recursive: true });
    writeFileSync(join(home, '.env'), `${VAR}=from-home\n`);
    const mainRepo = join(home, 'repos', 'main');
    mkdirSync(mainRepo, { recursive: true });
    const worktree = join(home, 'wt', 'proj');
    const start = join(worktree, 'packages', 'harness');
    mkdirSync(start, { recursive: true });
    writeFileSync(
      join(worktree, '.git'),
      `gitdir: ${join(mainRepo, '.git', 'worktrees', 'proj')}\n`,
    );

    const loaded = loadNearestDotEnv(start);

    expect(loaded).toBeUndefined();
    expect(process.env[VAR]).toBeUndefined();
  });

  it('external worktree: the walk stops at the worktree root, whose own .env still loads', () => {
    const { root: home } = makeTree();
    mkdirSync(join(home, '.git'), { recursive: true });
    writeFileSync(join(home, '.env'), `${VAR}=from-home\n`);
    const mainRepo = join(home, 'repos', 'main');
    mkdirSync(mainRepo, { recursive: true });
    const worktree = join(home, 'wt', 'proj');
    const start = join(worktree, 'packages', 'harness');
    mkdirSync(start, { recursive: true });
    // Valid worktree-shaped gitdir, but mainRepo does not contain the
    // worktree: the fail-closed containment check makes the worktree root
    // the boundary — its own .env is checked, nothing above it.
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(mainRepo, '.git', 'worktrees', 'x')}\n`);
    writeFileSync(join(worktree, '.env'), `${VAR}=from-worktree\n`);

    const loaded = loadNearestDotEnv(start);

    expect(loaded).toBe(join(worktree, '.env'));
    expect(process.env[VAR]).toBe('from-worktree');
  });

  it('never overrides a variable already exported in the environment', () => {
    const { root, nested } = makeTree();
    writeFileSync(join(root, '.env'), `${VAR}=from-file\n`);
    process.env[VAR] = 'from-shell';

    loadNearestDotEnv(nested);

    expect(process.env[VAR]).toBe('from-shell');
  });
});
