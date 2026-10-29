/**
 * Print the system prompt and the search_<box> description heads each
 * projection mode presents on the multi world, as the eval sees them.
 * Spends nothing (no model call).
 *
 *   pnpm --filter @astral-mcp/harness exec unrun <abs>/render-instructions.ts
 */
import { openMultiWorld, openSession } from '../../../packages/harness/src/index.js';

for (const mode of ['projection', 'projection-boxes'] as const) {
  const world = await openMultiWorld();
  const session = await openSession(mode, world);
  try {
    console.log(`===== ${mode}: system prompt =====\n${session.runtime.system}\n`);
    console.log(`===== ${mode}: search_<box> description heads =====`);
    for (const tool of session.runtime.tools.filter((t) => t.name.startsWith('search_'))) {
      console.log(`${tool.name}: ${tool.description.split('\n')[0]}`);
    }
    console.log();
  } finally {
    await session.close();
    await world.close();
  }
}
