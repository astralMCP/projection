/**
 * Eval worlds: the upstream a tool-choice episode runs against.
 *
 * A world is one fresh MCP server per episode whose tool executions are
 * observable (`calls`), so a task scores identically whether the model
 * reached a tool directly or through Projection. Two kinds:
 *
 * - **github**: the offline fake — 95 real schemas, canned and scripted
 *   answers, no I/O (github-fake.ts);
 * - **filesystem**: the official filesystem reference server, spawned over
 *   stdio against a throwaway fixture tree, behind a recording proxy
 *   (filesystem-world.ts). Effects land for real; tasks verify the end
 *   state on disk as well as the recorded calls.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { SideEffect } from '../types.js';
import { openFilesystemWorld } from './filesystem-world.js';
import { createGithubFake, type GithubFakeOptions } from './github-fake.js';

export type WorldName = 'github' | 'filesystem';
export const WORLD_NAMES: readonly WorldName[] = ['github', 'filesystem'];

/** One tool as a world serves it (the model sees name, description, schema). */
export interface WorldTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** Per-episode facts a task's prompt and `verify` may depend on. */
export interface WorldFacts {
  /** filesystem: the server's one allowed directory (a realpath), fresh per episode. */
  root?: string;
}

export interface EvalWorld {
  name: WorldName;
  /** The upstream, not yet connected: hand it to `wrapMcpServer` or a transport. */
  server: McpServer;
  readonly tools: readonly WorldTool[];
  /** The `instructions` the upstream advertises (undefined when none). */
  readonly instructions: string | undefined;
  /** Every tool call the upstream executed, in order — what the tasks score. */
  readonly calls: SideEffect[];
  readonly facts: WorldFacts;
  /**
   * The one-line host framing direct mode puts before the upstream's
   * instructions. Projection mode uses the facade's instructions instead.
   */
  directSystemPrompt: string;
  /** Tear the episode's upstream down (kill the child, remove the sandbox). */
  close(): Promise<void>;
}

export interface WorldOptions {
  /** github: whether the fake advertises the real server's instructions. Default true. */
  instructions?: boolean;
}

export const GITHUB_DIRECT_SYSTEM_PROMPT =
  "You operate GitHub through the tools provided. Complete the user's task, then stop.";

/** The GitHub fake as a world. */
export function githubWorld(options: WorldOptions = {}): EvalWorld {
  const fakeOptions: GithubFakeOptions =
    options.instructions === false ? { instructions: false } : {};
  const fake = createGithubFake(fakeOptions);
  return {
    name: 'github',
    server: fake.server,
    tools: fake.tools,
    instructions: fake.instructions,
    calls: fake.calls,
    facts: {},
    directSystemPrompt: GITHUB_DIRECT_SYSTEM_PROMPT,
    close: async () => {},
  };
}

/** A fresh world for one episode. */
export function openWorld(name: WorldName, options: WorldOptions = {}): Promise<EvalWorld> {
  switch (name) {
    case 'github':
      return Promise.resolve(githubWorld(options));
    case 'filesystem':
      return openFilesystemWorld();
  }
}
