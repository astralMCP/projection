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
 *   (filesystem-world.ts);
 * - **mongodb**: the official MongoDB MCP server on a seeded throwaway
 *   `mongod`, likewise behind a recording proxy (mongodb-world.ts);
 * - **multi**: all three at once, each a box under an alias (`github`,
 *   `fs`, `mongo`), with one call log across the boxes (multi-world.ts);
 * - **workplace**: five in-process fakes of other popular servers (chat,
 *   docs, errors, mail, tracker) as boxes, stateful per episode
 *   (workplace-world.ts) — the opt-in `workplace` tier's world;
 * - **messy**: badly built servers — three workplace fakes and a 315-tool
 *   generated billing API, each behind `messify` with a defect profile
 *   (messy-world.ts) — the held-out `summit-messy` tier's world.
 *
 * Real-server effects land for real; tasks verify the end state (on disk,
 * in the database) as well as the recorded calls.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { SideEffect } from '../types.js';
import { openFilesystemWorld } from './filesystem-world.js';
import { githubWorld } from './github-world.js';
import { openMongodbWorld } from './mongodb-world.js';
import { openMessyWorld, type MessyState } from './messy-world.js';
import { openMultiWorld } from './multi-world.js';
import { openWorkplaceWorld, type WorkplaceState } from './workplace-world.js';

export type WorldName = 'github' | 'filesystem' | 'mongodb' | 'multi' | 'workplace' | 'messy';
/** The worlds made of several boxes. */
export type BoxedWorldName = 'multi' | 'workplace' | 'messy';
/** The workplace world's boxes (each a server world named by its alias). */
export type WorkplaceBoxAlias = 'chat' | 'docs' | 'errors' | 'mail' | 'tracker';
/** The messy world's boxes: three workplace fakes and the generated billing API. */
export type MessyBoxAlias = 'billing' | 'chat' | 'mail' | 'tracker';
/** The worlds that are one upstream server (a workplace or messy box is one too, though never opened alone). */
export type ServerWorldName =
  Exclude<WorldName, BoxedWorldName> | WorkplaceBoxAlias | MessyBoxAlias;

/** Whether a world name is a boxed (multi-server) world. */
export function isBoxedWorldName(name: WorldName): name is BoxedWorldName {
  return name === 'multi' || name === 'workplace' || name === 'messy';
}

/** One tool as a world serves it (the model sees name, description, schema). */
export interface WorldTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * The output JSON Schema the upstream declares, when it declares one. The
   * recording proxy re-registers it; direct mode never shows it to the model
   * (the Messages API tool definition has no output schema).
   */
  outputSchema?: Record<string, unknown>;
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
  /** mongodb: the episode's deployment, for `verify` to query through the driver. */
  mongoUri?: string;
  /** workplace: every box's live state, for `verify` to read the end state. */
  workplace?: WorkplaceState;
  /** messy: every box's live state, for `verify` to read the end state. */
  messy?: MessyState;
}

interface WorldBase {
  /** A world's name; a workplace box (never opened alone) is named by its alias. */
  name: WorldName | WorkplaceBoxAlias | MessyBoxAlias;
  readonly tools: readonly WorldTool[];
  /** The `instructions` the upstream advertises (undefined when none). */
  readonly instructions: string | undefined;
  /** Every tool call the upstream executed, in order — what the tasks score. */
  readonly calls: SideEffect[];
  readonly facts: WorldFacts;
  /**
   * The one-line host framing every mode's system prompt starts with (a
   * real host has its own system prompt whatever it connects): direct mode
   * follows it with the upstream's instructions, the Projection modes with
   * the facade's.
   */
  hostSystemPrompt: string;
  /** Tear the episode's upstream down (kill the child, remove the sandbox). */
  close(): Promise<void>;
}

/** A world that is one upstream server. */
export interface ServerWorld extends WorldBase {
  name: ServerWorldName;
  /** The upstream, not yet connected: hand it to `wrapMcpServer` or a transport. */
  server: McpServer;
}

/** The aliases of the multi world's boxes. */
export type MultiBoxAlias = 'github' | 'fs' | 'mongo';
/** Any box alias, multi or workplace. */
export type BoxAlias = MultiBoxAlias | WorkplaceBoxAlias | MessyBoxAlias;
export const BOX_ALIASES: readonly BoxAlias[] = [
  'billing',
  'github',
  'fs',
  'mongo',
  'chat',
  'docs',
  'errors',
  'mail',
  'tracker',
];

/** One box of a boxed world: a single-server world under its alias. */
export interface WorldBox {
  alias: BoxAlias;
  world: ServerWorld;
  /** The host's description of the box (passed to Projection only with PROJ_EVAL_BOX_DESCRIPTIONS=1). */
  description?: string;
}

/**
 * Several single-server worlds in one episode. `calls` records every box's
 * calls in the order they ran, each named `<alias>.<name>`; `tools` lists
 * every box's tools under the same qualified names; `instructions` is
 * undefined (each box keeps its own); `facts` merges the boxes' facts.
 */
export interface MultiWorld extends WorldBase {
  name: BoxedWorldName;
  readonly boxes: readonly WorldBox[];
}

export type EvalWorld = ServerWorld | MultiWorld;

export { githubWorld, GITHUB_DIRECT_SYSTEM_PROMPT } from './github-world.js';

export interface WorldOptions {
  /** github: whether the fake advertises the real server's instructions. Default true. */
  instructions?: boolean;
  /**
   * Called with every call the upstream executes, as it is recorded (after
   * schema validation, before the result). The multi world uses it to keep
   * one ordered log across its boxes.
   */
  onCall?: (call: SideEffect) => void;
  /**
   * multi only: `'hard'` opens the boxes with the `multi-hard` tier's
   * additional fixture data (multi-hard-fixtures.ts, multi-hard-github.ts).
   * Absent: the base fixtures, exactly as every other tier sees them.
   */
  variant?: 'hard';
  /** messy only: the boxes to open (default all). */
  boxes?: readonly MessyBoxAlias[];
}

/** A fresh world for one episode. */
export function openWorld(name: WorldName, options: WorldOptions = {}): Promise<EvalWorld> {
  switch (name) {
    case 'github':
      return Promise.resolve(githubWorld(options));
    case 'filesystem':
      return openFilesystemWorld(options);
    case 'mongodb':
      return openMongodbWorld(options);
    case 'multi':
      return openMultiWorld(options);
    case 'workplace':
      return Promise.resolve(openWorkplaceWorld(options));
    case 'messy':
      return openMessyWorld(options);
  }
}
