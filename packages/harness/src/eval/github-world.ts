/** The GitHub fake as a single-server world (re-exported from world.ts). */

import { createGithubFake, type GithubFakeOptions } from './github-fake.js';
import type { ServerWorld, WorldOptions } from './world.js';

export const GITHUB_DIRECT_SYSTEM_PROMPT =
  "You operate GitHub through the tools provided. Complete the user's task, then stop.";

/** The GitHub fake as a world. */
export function githubWorld(options: WorldOptions = {}): ServerWorld {
  const fakeOptions: GithubFakeOptions = {
    ...(options.instructions === false ? { instructions: false as const } : {}),
    ...(options.onCall !== undefined ? { onCall: options.onCall } : {}),
  };
  const fake = createGithubFake(fakeOptions);
  return {
    name: 'github',
    server: fake.server,
    tools: fake.tools,
    instructions: fake.instructions,
    calls: fake.calls,
    facts: {},
    hostSystemPrompt: GITHUB_DIRECT_SYSTEM_PROMPT,
    close: async () => {},
  };
}
