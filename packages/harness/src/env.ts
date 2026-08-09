/**
 * Zero-dependency `.env` loading, via Node's built-in `process.loadEnvFile`
 * (22+). Used by the TUI CLI and the live (opt-in) smoke/benchmark tests so
 * secrets like ANTHROPIC_API_KEY / GITHUB_TOKEN can live in a repo-root
 * `.env` instead of the shell environment.
 *
 * The walk up from `startDir` is bounded at the repo root: the first
 * ancestor containing `.git` or `pnpm-workspace.yaml`, or — when neither
 * exists anywhere above — the nearest `package.json` (a standalone,
 * non-workspace checkout). That directory's own `.env` is still checked,
 * but nothing above it. Without the bound, a stray `.env` in an ancestor
 * directory (e.g. `$HOME`) would load silently — and since the Anthropic
 * SDK also reads ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN from the
 * environment, a stale ancestor file could silently redirect API traffic
 * (carrying the key) to another endpoint.
 *
 * `loadEnvFile` never overrides variables already present in the process
 * environment, so an exported variable always wins over the file.
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Nearest ancestor of `startDir` (inclusive) that marks the repo root: the
 * first directory containing a `.git` DIRECTORY or `pnpm-workspace.yaml`,
 * falling back to the first containing `package.json` when neither appears
 * all the way up. `package.json` alone cannot cut the walk short: every
 * workspace package has one, and stopping there would hide the repo-root
 * `.env`. Returns undefined when no marker exists at all.
 *
 * A `.git` FILE marks a linked git worktree, not the repository top — its
 * checkout lives inside (or beside) the main repository, whose root `.env`
 * is the one the developer maintains. A worktree directory therefore does
 * NOT terminate the walk (even though it also carries the workspace
 * manifest); the walk continues until the main repository's `.git`
 * directory bounds it as usual.
 */
function findRepoRoot(startDir: string): string | undefined {
  let packageJsonDir: string | undefined;
  let dir = startDir;
  for (;;) {
    const gitPath = join(dir, '.git');
    const gitIsDir = isDirectory(gitPath);
    const gitIsWorktreeFile = !gitIsDir && existsSync(gitPath);
    if (gitIsDir || (existsSync(join(dir, 'pnpm-workspace.yaml')) && !gitIsWorktreeFile)) {
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
