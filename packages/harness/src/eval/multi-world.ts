/**
 * The multi world: the three single-server worlds in one episode, each a
 * **box** under an alias, as a multi-server host (or Projection's
 * `wrapMcpServers`) would present them:
 *
 * - `github` — the offline GitHub fake (95 tools, the real instructions);
 * - `fs` — the real filesystem reference server on a fresh fixture tree;
 * - `mongo` — the real MongoDB MCP server on a seeded throwaway `mongod`.
 *
 * Every call any box executes is recorded once, in the order the calls
 * ran, as `{ tool: '<alias>.<name>', args }` — the qualified name
 * Projection uses — so a task can tell the boxes apart (GitHub's
 * `get_file_contents` vs the filesystem's `read_text_file`) and can assert
 * that a write in one box follows the read in another that justified it.
 * Each box's own `calls` keeps its bare names, as in its single-server tier.
 *
 * Facts merge: `root` (the filesystem box's directory) and `mongoUri` (the
 * deployment), so prompts and `verify` read them as in the single-server
 * tiers. `close` tears down all three.
 */

import type { SideEffect } from '../types.js';
import { openFilesystemWorld } from './filesystem-world.js';
import { githubWorld } from './github-world.js';
import { openMongodbWorld } from './mongodb-world.js';
import type {
  BoxAlias,
  MultiWorld,
  ServerWorld,
  WorldBox,
  WorldOptions,
  WorldTool,
} from './world.js';

/** The boxes, in shelf (alias) order, and the single-server world each wraps. */
export const MULTI_BOXES: readonly { alias: BoxAlias; world: ServerWorld['name'] }[] = [
  { alias: 'fs', world: 'filesystem' },
  { alias: 'github', world: 'github' },
  { alias: 'mongo', world: 'mongodb' },
];

/** The multi world's host framing (every mode's system prompt starts with it). */
export const MULTI_DIRECT_SYSTEM_PROMPT =
  "You operate the user's GitHub account, project files and MongoDB deployment through the tools provided. Complete the user's task, then stop.";

/**
 * Host-written box descriptions, passed to `wrapMcpServers` only when the
 * `boxDescriptions` variant is on (PROJ_EVAL_BOX_DESCRIPTIONS=1); by
 * default the boxes carry none.
 */
export const MULTI_BOX_DESCRIPTIONS: Readonly<Record<BoxAlias, string>> = {
  github: 'GitHub: issues, PRs and repos for acme/widgets',
  fs: "The user's project files",
  mongo: 'The shop MongoDB deployment',
};

/** `<alias>.<name>`: how the multi world records (and Projection names) a box's tool. */
export function qualifiedName(alias: string, name: string): string {
  return `${alias}.${name}`;
}

/**
 * A fresh multi world: the three boxes opened together. If any box fails to
 * open, the ones that did are closed and the first failure is thrown.
 */
export async function openMultiWorld(options: WorldOptions = {}): Promise<MultiWorld> {
  const calls: SideEffect[] = [];
  const recorder =
    (alias: BoxAlias) =>
    (call: SideEffect): void => {
      const qualified = { tool: qualifiedName(alias, call.tool), args: call.args };
      calls.push(qualified);
      options.onCall?.(qualified);
    };

  const opened = await Promise.allSettled(
    MULTI_BOXES.map(({ alias, world }): Promise<ServerWorld> => {
      const onCall = recorder(alias);
      switch (world) {
        case 'github':
          return Promise.resolve(
            githubWorld({
              onCall,
              ...(options.instructions === false ? { instructions: false } : {}),
            }),
          );
        case 'filesystem':
          return openFilesystemWorld({ onCall });
        case 'mongodb':
          return openMongodbWorld({ onCall });
      }
    }),
  );
  const boxes: WorldBox[] = [];
  const failures: unknown[] = [];
  opened.forEach((result, i) => {
    const box = MULTI_BOXES[i] as (typeof MULTI_BOXES)[number];
    if (result.status === 'fulfilled') boxes.push({ alias: box.alias, world: result.value });
    else failures.push(result.reason);
  });
  const close = async (): Promise<void> => {
    await Promise.all(boxes.map((box) => box.world.close().catch(() => {})));
  };
  if (failures.length > 0) {
    await close();
    throw failures[0];
  }

  const tools: WorldTool[] = boxes.flatMap((box) =>
    box.world.tools.map((tool) => ({ ...tool, name: qualifiedName(box.alias, tool.name) })),
  );
  return {
    name: 'multi',
    boxes,
    tools,
    instructions: undefined,
    calls,
    facts: Object.assign({}, ...boxes.map((box) => box.world.facts)),
    hostSystemPrompt: MULTI_DIRECT_SYSTEM_PROMPT,
    close,
  };
}
