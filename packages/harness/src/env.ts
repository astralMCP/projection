/**
 * Zero-dependency `.env` loading, via Node's built-in `process.loadEnvFile`
 * (22+). Used by the live (opt-in) smoke/benchmark tests so
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
 * A `.git` FILE (linked worktree or submodule) does not simply terminate
 * the walk: its `gitdir:` pointer is parsed to derive the main repository
 * root (`<root>/.git/worktrees/<name>` for worktrees,
 * `<root>/.git/modules/<path>` for submodules), and the walk continues —
 * bounded at that derived root — ONLY when the derived root actually
 * contains the worktree. This keeps in-repo worktrees (e.g.
 * `.claude/worktrees/*`) reaching the main repo's `.env` while failing
 * CLOSED for everything else: if the pointer is missing, unreadable, or
 * unparseable, or the derived root does not contain the current directory
 * (a worktree created outside the main repo), the `.git` file terminates
 * the walk right there, so ancestors like `$HOME` are never consulted.
 *
 * `loadEnvFile` never overrides variables already present in the process
 * environment, so an exported variable always wins over the file.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when `child` equals `root` or lies strictly inside it. */
function isInside(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Derive the MAIN repository root from a `.git` FILE's `gitdir:` pointer.
 *
 * The file holds a single line `gitdir: <path>` (possibly relative to the
 * file's directory). For a linked worktree the target looks like
 * `<root>/.git/worktrees/<name>`; for a submodule,
 * `<root>/.git/modules/<path>`. The directory before that `.git` segment
 * is the main repository root. Returns undefined — the caller fails
 * closed — when the file cannot be read, the pointer cannot be parsed, or
 * the target does not match either shape.
 */
function mainRepoRootFromGitFile(gitFilePath: string, containingDir: string): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(gitFilePath, 'utf8');
  } catch {
    return undefined;
  }
  const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(contents);
  const target = match?.[1];
  if (target === undefined || target.length === 0) return undefined;
  const segments = resolve(containingDir, target).split(sep);
  for (let i = segments.length - 2; i >= 1; i -= 1) {
    const next = segments[i + 1];
    if (segments[i] === '.git' && (next === 'worktrees' || next === 'modules')) {
      const root = segments.slice(0, i).join(sep);
      return root.length > 0 ? root : sep;
    }
  }
  return undefined;
}

/**
 * Nearest ancestor of `startDir` (inclusive) that marks the repo root: the
 * first directory containing a `.git` DIRECTORY or `pnpm-workspace.yaml`,
 * falling back to the first containing `package.json` when neither appears
 * all the way up. `package.json` alone cannot cut the walk short: every
 * workspace package has one, and stopping there would hide the repo-root
 * `.env`. Returns undefined when no marker exists at all.
 *
 * A `.git` FILE marks a linked git worktree (or submodule), not the
 * repository top. When its `gitdir:` pointer resolves to a main repository
 * root that CONTAINS the worktree — the in-repo `.claude/worktrees/*`
 * layout — that derived root is the boundary, so the main repo's `.env`
 * stays reachable. Otherwise the walk fails closed and the worktree
 * directory itself is the boundary: an externally created worktree must
 * never let the walk continue through unrelated ancestors (e.g. `$HOME`),
 * which would reopen the ANTHROPIC_BASE_URL-redirect hole the bound exists
 * to close.
 */
function findRepoRoot(startDir: string): string | undefined {
  let packageJsonDir: string | undefined;
  let dir = startDir;
  for (;;) {
    const gitPath = join(dir, '.git');
    const gitIsDir = isDirectory(gitPath);
    if (gitIsDir) return dir;
    if (existsSync(gitPath)) {
      // .git FILE: linked worktree or submodule. Bound the walk at the
      // derived main-repo root when it contains us; otherwise fail closed
      // and terminate here.
      const mainRoot = mainRepoRootFromGitFile(gitPath, dir);
      return mainRoot !== undefined && isInside(dir, mainRoot) ? mainRoot : dir;
    }
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
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
