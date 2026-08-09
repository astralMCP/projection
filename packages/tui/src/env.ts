/**
 * Zero-dependency `.env` loading for the CLI, via Node's built-in
 * `process.loadEnvFile` (22+). `pnpm --filter @mccircuit/tui start` runs
 * with cwd `packages/tui`, so the loader walks up from cwd until it finds a
 * `.env` (the repo root, for a checkout) or hits the filesystem root.
 *
 * `loadEnvFile` never overrides variables already present in the process
 * environment, so an exported ANTHROPIC_API_KEY always wins over the file.
 */

import { dirname, join } from 'node:path';

/**
 * Load the nearest `.env` at or above `startDir`. Returns the path loaded,
 * or undefined when none was found. Quietly skips unreadable candidates.
 */
export function loadNearestDotEnv(startDir: string = process.cwd()): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, '.env');
    try {
      process.loadEnvFile(candidate);
      return candidate;
    } catch {
      // Missing or unreadable: keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
