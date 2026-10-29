/**
 * Resolve a phase's scope exactly as the live test does (same resolvers, same
 * env knobs) and print it as JSON: tasks, models, modes, runs, episodes, and
 * prompts keyed by task name. Spends nothing; used by run-round.sh before the
 * paid pass and by export.mjs for the `prompt` field.
 *
 *   pnpm --filter @astral-mcp/harness exec unrun <abs>/scope.ts
 */
import {
  modeApplies,
  resolveModelPresets,
  resolveModes,
  resolveTasks,
  resolveTiers,
  worldOf,
} from '../../../packages/harness/src/index.js';

const models = resolveModelPresets(process.env['PROJ_EVAL_MODELS']);
const modes = resolveModes(process.env['PROJ_EVAL_MODES']);
const tiers = resolveTiers(process.env['PROJ_EVAL_TIERS']);
const tasks = resolveTasks(process.env['PROJ_EVAL_TASKS'], tiers);
const runsRaw = Number(process.env['PROJ_EVAL_RUNS']);
const runs = Number.isInteger(runsRaw) && runsRaw > 0 ? runsRaw : 3;

const cells: { model: string; modelId: string; mode: string; tasks: number }[] = [];
for (const m of models) {
  for (const mode of modes) {
    const n = tasks.filter((t) => modeApplies(mode, worldOf(t.tier))).length;
    if (n > 0) cells.push({ model: m.name, modelId: m.model, mode, tasks: n });
  }
}
const episodes = cells.reduce((s, c) => s + c.tasks * runs, 0);
process.stdout.write(
  JSON.stringify({
    tiers,
    runs,
    models: models.map((m) => ({ name: m.name, id: m.model })),
    modes,
    tasks: tasks.map((t) => ({ name: t.name, tier: t.tier })),
    cells,
    episodes,
  }) + '\n',
);
