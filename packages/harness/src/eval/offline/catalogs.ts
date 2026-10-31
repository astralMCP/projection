/**
 * Catalogs for the offline evals (no model, no network, no real server):
 * the three eval worlds' dumped catalogs, the synthetic large catalog, and
 * a stub MCP server that serves any of them so the real Projection facade
 * can be wrapped around it in process.
 *
 * - `github`: the 95-tool GitHub dump the github world serves
 *   (`test/fixtures/github-catalog.json`);
 * - `fs` / `mongo`: the filesystem reference server's 14 tools and the
 *   MongoDB MCP server's 21 tools, snapshotted once from the real servers
 *   by `scripts/snapshot-catalogs.ts`;
 * - `synthetic`: ~1,000 procedurally generated tools (synthetic.ts).
 */

import { fromJsonSchema, McpServer, type JsonSchemaType } from '@modelcontextprotocol/server';
import filesystemFixture from '../../../test/fixtures/filesystem-catalog.json' with { type: 'json' };
import githubFixture from '../../../test/fixtures/github-catalog.json' with { type: 'json' };
import mongodbFixture from '../../../test/fixtures/mongodb-catalog.json' with { type: 'json' };
import type { BoxAlias, WorldTool } from '../world.js';
import { syntheticCatalog } from './synthetic.js';

/** A catalog as a server lists it: its tools and its `instructions`. */
export interface CatalogFixture {
  server: { name: string; version: string };
  /** Empty when the server sends none. */
  instructions: string;
  tools: WorldTool[];
}

export type CatalogName = 'github' | 'fs' | 'mongo' | 'synthetic';
export const CATALOG_NAMES: readonly CatalogName[] = ['github', 'fs', 'mongo', 'synthetic'];

/** The multi world's boxes, alias → catalog, in alias order (multi-world.ts). */
export const MULTI_CATALOGS: readonly { alias: BoxAlias; catalog: CatalogName }[] = [
  { alias: 'fs', catalog: 'fs' },
  { alias: 'github', catalog: 'github' },
  { alias: 'mongo', catalog: 'mongo' },
];

let synthetic: CatalogFixture | undefined;

/** One catalog by name (the synthetic one is generated once, deterministically). */
export function loadCatalog(name: CatalogName): CatalogFixture {
  switch (name) {
    case 'github':
      return githubFixture as unknown as CatalogFixture;
    case 'fs':
      return filesystemFixture as unknown as CatalogFixture;
    case 'mongo':
      return mongodbFixture as unknown as CatalogFixture;
    case 'synthetic':
      synthetic ??= syntheticCatalog();
      return synthetic;
  }
}

/**
 * A fresh MCP server that lists `fixture`'s tools verbatim (schemas,
 * titles, annotations) and answers every call with `{"ok":true}`. Nothing
 * here is ever called by the offline evals; the stub only has to list.
 */
export function catalogServer(fixture: CatalogFixture): McpServer {
  const server = new McpServer(
    { name: fixture.server.name, version: `${fixture.server.version}-offline` },
    ...(fixture.instructions !== '' ? [{ instructions: fixture.instructions }] : []),
  );
  for (const tool of fixture.tools) {
    server.registerTool(
      tool.name,
      {
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema as JsonSchemaType),
        ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
      },
      () => ({ content: [{ type: 'text' as const, text: '{"ok":true}' }] }),
    );
  }
  return server;
}
