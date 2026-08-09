/**
 * Zero-dependency `.env` loading for the CLI, via Node's built-in
 * `process.loadEnvFile` (22+). `pnpm --filter @mccircuit/tui start` runs
 * with cwd `packages/tui`, so the loader walks up from cwd until it finds a
 * `.env` (the repo root, for a checkout).
 *
 * The walk is bounded at the repo root: the first ancestor containing
 * `.git` or `pnpm-workspace.yaml`, or — when neither exists anywhere
 * above — the nearest `package.json` (a standalone, non-workspace
 * checkout). That directory's own `.env` is still checked, but nothing
 * above it. Without the bound, a stray `.env` in an ancestor directory
 * (e.g. `$HOME`) would load silently — and since the Anthropic SDK also
 * reads ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN from the environment, a
 * stale ancestor file could silently redirect API traffic (carrying the
 * key) to another endpoint.
 *
 * `loadEnvFile` never overrides variables already present in the process
 * environment, so an exported ANTHROPIC_API_KEY always wins over the file.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Nearest ancestor of `startDir` (inclusive) that marks the repo root: the
 * first directory containing `.git` or `pnpm-workspace.yaml`, falling back
 * to the first containing `package.json` when neither appears all the way
 * up. `package.json` alone cannot cut the walk short: every workspace
 * package has one, and stopping there would hide the repo-root `.env`.
 * Returns undefined when no marker exists at all.
 */
function findRepoRoot(startDir: string): string | undefined {
  let packageJsonDir: string | undefined;
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    if (packageJsonDir === undefined && existsSync(join(dir, 'package.json'))) {
      packageJsonDir = dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return packageJsonDir;
    dir = parent;
  }
}

/**
 * Load the nearest `.env` at or above `startDir`, never above the repo
 * root (see module docs). Returns the path loaded, or undefined when none
 * was found within the boundary. Quietly skips unreadable candidates.
 */
export function loadNearestDotEnv(startDir: string = process.cwd()): string | undefined {
  const repoRoot = findRepoRoot(startDir);
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, '.env');
    try {
      process.loadEnvFile(candidate);
      return candidate;
    } catch {
      // Missing or unreadable: keep walking up, within the boundary.
    }
    if (dir === repoRoot) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
