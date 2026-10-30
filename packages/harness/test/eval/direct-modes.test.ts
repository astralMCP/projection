/**
 * The direct-listing eval modes (`projection-direct`, `projection-auto`):
 * Projection with `projections.direct`, so every wrapped tool is also a
 * mediated `call_tool` alias. Offline: the in-process workplace world and
 * the GitHub fake.
 */

import { describe, expect, it } from 'vitest';
import {
  directSettingOf,
  openSession,
  openWorld,
  resolveModes,
  EVAL_MODES,
  KNOWN_EVAL_MODES,
  PROJECTION_DISCOVERY_TOOLS,
} from '../../src/index.js';

describe('direct-listing eval modes', () => {
  it('are opt-in: accepted by name, not planned by default', () => {
    expect(EVAL_MODES).not.toContain('projection-direct');
    expect(KNOWN_EVAL_MODES).toContain('projection-direct');
    expect(resolveModes('projection,projection-direct,projection-auto')).toEqual([
      'projection',
      'projection-direct',
      'projection-auto',
    ]);
    expect(resolveModes(undefined)).toEqual([...EVAL_MODES]);
    expect(directSettingOf('projection-direct')).toBe(true);
    expect(directSettingOf('projection-auto')).toBe('auto');
    expect(directSettingOf('projection')).toBe(false);
  });

  it('projection-direct on the workplace world: <box>__<tool> mediated tools, gated, and not budget-free', async () => {
    const world = await openWorld('workplace');
    const session = await openSession('projection-direct', world, { boxDescriptions: true });
    try {
      const names = session.runtime.tools.map((tool) => tool.name);
      expect(names).toContain('call_tool');
      // No box sends guidance, so no search tool is served.
      expect(names.filter((name) => name.startsWith('search_'))).toEqual([]);
      expect(names).toContain('tracker__create_issue');
      expect(names).toContain('docs__API-post-search');
      expect(names.length).toBe(4 + 37);
      expect(session.runtime.system).toContain('listed directly');
      // Mediated tools are action tools under the turn budget.
      expect(session.budgetFreeTools.has('tracker__list_teams')).toBe(false);
      for (const tool of PROJECTION_DISCOVERY_TOOLS) {
        expect(session.budgetFreeTools.has(tool)).toBe(true);
      }

      const read = await session.runtime.call('tracker__list_teams', {});
      expect(read.isError).toBeUndefined();
      expect(read.text).toContain('Backend');
      expect(session.approvals).toBe(0);

      const created = await session.runtime.call('tracker__create_issue', {
        team: 'WEB',
        title: 'Direct listing smoke',
      });
      expect(created.isError).toBeUndefined();
      // The write asked for approval, exactly as call_tool would.
      expect(session.approvals).toBe(1);
      expect(world.calls.map((call) => call.tool)).toEqual([
        'tracker.list_teams',
        'tracker.create_issue',
      ]);
    } finally {
      await session.close();
      await world.close();
    }
  });

  it('projection-auto lists the workplace world directly and leaves the 95-tool GitHub fake as a catalog', async () => {
    const workplace = await openWorld('workplace');
    const small = await openSession('projection-auto', workplace);
    try {
      expect(small.runtime.tools.map((tool) => tool.name)).toContain('mail__send_email');
    } finally {
      await small.close();
      await workplace.close();
    }
    const github = await openWorld('github');
    const large = await openSession('projection-auto', github);
    try {
      expect(large.runtime.tools.map((tool) => tool.name)).toEqual([
        'execute_machine',
        'discover_apis',
        'search_tools',
        'describe_tool',
        'call_tool',
      ]);
    } finally {
      await large.close();
      await github.close();
    }
  });
});
