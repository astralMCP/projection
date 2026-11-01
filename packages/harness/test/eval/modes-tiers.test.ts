/**
 * Every mode on every tier, offline: the planner plans every mode on every
 * boxed tier (the summit-* tiers included), and a session opens in every
 * mode on each summit world, with the tool surface that mode promises.
 */

import { describe, expect, it } from 'vitest';
import {
  isNativeMode,
  KNOWN_EVAL_MODES,
  modeApplies,
  openSession,
  openWorld,
  summitServersInstalled,
  TASK_TIERS,
  worldOf,
  type EvalMode,
  type WorldName,
} from '../../src/index.js';

const SUMMIT_TIERS = TASK_TIERS.filter((tier) => tier.startsWith('summit-'));

describe('tier × mode planning', () => {
  it('there are three summit tiers, each on a boxed world', () => {
    expect(SUMMIT_TIERS.toSorted()).toEqual(['summit-local', 'summit-messy', 'summit-saas']);
  });

  it('every mode applies to every boxed tier; only projection-boxes skips a single-server one', () => {
    for (const tier of TASK_TIERS) {
      const world = worldOf(tier);
      const boxed = !['github', 'filesystem', 'mongodb'].includes(world);
      for (const mode of KNOWN_EVAL_MODES) {
        expect(modeApplies(mode, world), `${tier}/${mode}`).toBe(
          boxed || mode !== 'projection-boxes',
        );
      }
    }
  });
});

async function surfaces(world: WorldName): Promise<void> {
  for (const mode of KNOWN_EVAL_MODES as readonly EvalMode[]) {
    const opened = await openWorld(world);
    try {
      expect('boxes' in opened, world).toBe(true);
      const session = await openSession(mode, opened, { hostPrompt: 'HOST' });
      try {
        const names = session.runtime.tools.map((t) => t.name);
        expect(session.mode).toBe(mode);
        expect(names.length, `${world}/${mode}`).toBeGreaterThan(0);
        expect(session.runtime.system.startsWith('HOST\n\n'), `${world}/${mode}`).toBe(true);
        expect(session.runtime.native !== undefined, `${world}/${mode}`).toBe(isNativeMode(mode));
        if (mode === 'projection-nocode') expect(names).not.toContain('execute_machine');
        if (mode === 'projection-codeonly') expect(names).not.toContain('call_tool');
        if (mode === 'projection-boxes') expect(names).not.toContain('search_tools');
      } finally {
        await session.close();
      }
    } finally {
      await opened.close();
    }
  }
}

describe('every mode opens on every summit world', () => {
  it('summit-saas', () => surfaces(worldOf('summit-saas')), 120_000);
  it('summit-messy', () => surfaces(worldOf('summit-messy')), 120_000);
  it.skipIf(!summitServersInstalled())(
    'summit-local (real servers)',
    () => surfaces(worldOf('summit-local')),
    300_000,
  );
});
