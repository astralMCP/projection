/**
 * Snapshot the filesystem and MongoDB worlds' catalogs (tools + server
 * instructions) into `test/fixtures/`, in the shape of
 * `github-catalog.json`, so the offline search eval can load every world's
 * catalog without starting a server:
 *
 *   pnpm --filter @astral-mcp/harness run snapshot:catalogs
 *
 * Starts the real servers once (MongoDB needs `pnpm run setup:mongodb`).
 * No model calls. Re-run only when a server is upgraded.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openFilesystemWorld, openMongodbWorld, type ServerWorld } from '../src/index.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

async function snapshot(
  open: () => Promise<ServerWorld>,
  server: { name: string; version: string },
  file: string,
): Promise<void> {
  const world = await open();
  try {
    const tools = [...world.tools].toSorted((a, b) => (a.name < b.name ? -1 : 1));
    const fixture = { server, instructions: world.instructions ?? '', tools };
    writeFileSync(join(fixtures, file), `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`${file}: ${tools.length} tools`);
  } finally {
    await world.close();
  }
}

await snapshot(
  () => openFilesystemWorld(),
  { name: '@modelcontextprotocol/server-filesystem', version: '1.0.0' },
  'filesystem-catalog.json',
);
await snapshot(
  () => openMongodbWorld(),
  { name: 'mongodb-mcp-server', version: '3.2.1' },
  'mongodb-catalog.json',
);
