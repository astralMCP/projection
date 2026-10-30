/**
 * Surface-size meter: what each eval world × mode puts in front of the
 * model before and during discovery, in characters and approximate tokens
 * (chars / 4) — measured offline through the same sessions the eval modes
 * open (modes.ts), over the fixture catalogs.
 *
 * Columns: the system prompt as the session builds it (host framing +
 * instructions), the tool definitions as sent to the Messages API
 * (`{ name, description, input_schema }` JSON), one typical
 * `describe_tool` result and one typical search result page (Projection
 * modes only; direct mode has every definition inline).
 */

import { FILESYSTEM_DIRECT_SYSTEM_PROMPT } from '../filesystem-world.js';
import { GITHUB_DIRECT_SYSTEM_PROMPT } from '../github-world.js';
import {
  openDirectSession,
  openMultiProjectionSession,
  openProjectionSession,
  type EvalMode,
  type ModeSession,
} from '../modes.js';
import { MONGODB_DIRECT_SYSTEM_PROMPT } from '../mongodb-world.js';
import { MULTI_DIRECT_SYSTEM_PROMPT } from '../multi-world.js';
import type { EvalWorld, ServerWorld, ServerWorldName, WorldName } from '../world.js';
import { catalogServer, loadCatalog, MULTI_CATALOGS, type CatalogName } from './catalogs.js';
import { approxTokens } from './search-eval.js';

const WORLD_CATALOG: Record<ServerWorldName, CatalogName> = {
  github: 'github',
  filesystem: 'fs',
  mongodb: 'mongo',
};
const WORLD_PROMPT: Record<ServerWorldName, string> = {
  github: GITHUB_DIRECT_SYSTEM_PROMPT,
  filesystem: FILESYSTEM_DIRECT_SYSTEM_PROMPT,
  mongodb: MONGODB_DIRECT_SYSTEM_PROMPT,
};

/** A world over a fixture catalog: lists like the real one, executes nothing. */
function fixtureWorld(name: ServerWorldName): ServerWorld {
  const catalog = loadCatalog(WORLD_CATALOG[name]);
  return {
    name,
    server: catalogServer(catalog),
    tools: catalog.tools,
    instructions: catalog.instructions === '' ? undefined : catalog.instructions,
    calls: [],
    facts: {},
    hostSystemPrompt: WORLD_PROMPT[name],
    close: async () => {},
  };
}

function fixtureMultiWorld(): EvalWorld {
  const worldOf: Record<CatalogName, ServerWorldName | undefined> = {
    github: 'github',
    fs: 'filesystem',
    mongo: 'mongodb',
    synthetic: undefined,
  };
  const boxes = MULTI_CATALOGS.map((box) => ({
    alias: box.alias,
    world: fixtureWorld(worldOf[box.catalog] ?? 'github'),
  }));
  return {
    name: 'multi',
    boxes,
    tools: boxes.flatMap((b) => b.world.tools.map((t) => ({ ...t, name: `${b.alias}.${t.name}` }))),
    instructions: undefined,
    calls: [],
    facts: {},
    hostSystemPrompt: MULTI_DIRECT_SYSTEM_PROMPT,
    close: async () => {},
  };
}

/** The typical discovery calls measured per world: one describe, one search. */
const TYPICAL: Record<WorldName, { describe: string; search: string; boxSearch?: string }> = {
  github: { describe: 'list_issues', search: 'list issues' },
  filesystem: { describe: 'read_text_file', search: 'read file' },
  mongodb: { describe: 'find', search: 'find documents' },
  multi: { describe: 'github.list_issues', search: 'list issues', boxSearch: 'search_github' },
};

export interface SurfaceRow {
  world: WorldName;
  mode: EvalMode;
  tools: number;
  systemChars: number;
  toolDefChars: number;
  /** One `describe_tool` result; undefined in direct mode. */
  describeChars: number | undefined;
  /** One search result page; undefined in direct mode. */
  searchChars: number | undefined;
}

async function open(world: WorldName, mode: EvalMode): Promise<ModeSession> {
  const w = world === 'multi' ? fixtureMultiWorld() : fixtureWorld(world);
  if (mode === 'direct') return openDirectSession(w);
  if (w.name === 'multi') return openMultiProjectionSession(w, mode);
  return openProjectionSession(w);
}

/** Measure one world × mode. */
export async function measureSurface(world: WorldName, mode: EvalMode): Promise<SurfaceRow> {
  const session = await open(world, mode);
  try {
    const defs = session.runtime.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
    const row: SurfaceRow = {
      world,
      mode,
      tools: defs.length,
      systemChars: session.runtime.system.length,
      toolDefChars: JSON.stringify(defs).length,
      describeChars: undefined,
      searchChars: undefined,
    };
    if (mode !== 'direct') {
      const typical = TYPICAL[world];
      row.describeChars = (
        await session.runtime.call('describe_tool', { name: typical.describe })
      ).text.length;
      const searchTool =
        mode === 'projection-boxes' && typical.boxSearch !== undefined
          ? typical.boxSearch
          : 'search_tools';
      row.searchChars = (
        await session.runtime.call(searchTool, { query: typical.search })
      ).text.length;
    }
    return row;
  } finally {
    await session.close();
  }
}

/** Every world × applicable mode. */
export async function measureSurfaces(): Promise<SurfaceRow[]> {
  const plan: [WorldName, EvalMode][] = [
    ['github', 'direct'],
    ['github', 'projection'],
    ['filesystem', 'direct'],
    ['filesystem', 'projection'],
    ['mongodb', 'direct'],
    ['mongodb', 'projection'],
    ['multi', 'direct'],
    ['multi', 'projection'],
    ['multi', 'projection-boxes'],
  ];
  const rows: SurfaceRow[] = [];
  for (const [world, mode] of plan) rows.push(await measureSurface(world, mode));
  return rows;
}

/** chars and approximate tokens, for a table cell. */
export function charsAndTokens(chars: number | undefined): string {
  if (chars === undefined) return '—';
  return `${chars.toLocaleString('en-US')} (~${Math.round(approxTokens(chars)).toLocaleString('en-US')})`;
}
