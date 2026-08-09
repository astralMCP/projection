/**
 * `.env` discovery for the CLI: walks up from cwd, loads via Node's
 * built-in parser, and never overrides variables already exported.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadNearestDotEnv } from '../src/env.js';

const VAR = 'MCC_TUI_ENV_TEST_VAR';
const cleanups: (() => void)[] = [];

afterEach(() => {
  delete process.env[VAR];
  while (cleanups.length > 0) cleanups.pop()?.();
});

function makeTree(): { root: string; nested: string } {
  const root = mkdtempSync(join(tmpdir(), 'mcc-tui-env-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const nested = join(root, 'packages', 'tui');
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
    const start = join(repo, 'packages', 'tui');
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

  it('never overrides a variable already exported in the environment', () => {
    const { root, nested } = makeTree();
    writeFileSync(join(root, '.env'), `${VAR}=from-file\n`);
    process.env[VAR] = 'from-shell';

    loadNearestDotEnv(nested);

    expect(process.env[VAR]).toBe('from-shell');
  });
});
