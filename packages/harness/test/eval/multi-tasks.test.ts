/**
 * Multi-tier predicates, offline (no servers): each task fires on its
 * golden calls and variants, stays quiet on nothing, on the right tools
 * with empty arguments, and on every plausible wrong sequence; a write
 * into the wrong box is forbidden where the task says so (a read of it is
 * a detour, not a failure); text-only verifies accept the right answer and
 * reject the wrong one. The goldens' fidelity against the real boxes, and
 * every world-reading verify, are checked in multi-world.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  FILESYSTEM_TASKS,
  HARD_TASKS,
  isBoxWrite,
  MONGODB_TASKS,
  MULTI_TASKS,
  promptFor,
  shippedCounts,
  taskBoxes,
  unbox,
  unboxCall,
  worldOf,
  type EvalTask,
  type SideEffect,
} from '../../src/index.js';
import { GOLDEN, type Golden } from './multi-goldens.js';

/** `success` before verify: expect holds and nothing forbidden was called. */
function scores(t: EvalTask, calls: SideEffect[]): boolean {
  const forbid = t.forbid;
  return t.expect(calls) && !(forbid !== undefined && calls.some((c) => forbid(c)));
}

function task(name: string): EvalTask {
  return MULTI_TASKS.find((t) => t.name === name) as EvalTask;
}

const forbidden = (t: EvalTask, calls: SideEffect[]): boolean =>
  t.forbid !== undefined && calls.some((c) => (t.forbid as NonNullable<EvalTask['forbid']>)(c));

describe('multi tasks', () => {
  it('has 17 tasks in the multi tier: 6 cross-box, 4 box-choice, 4 global, 3 controls, each with a golden', () => {
    expect(MULTI_TASKS).toHaveLength(17);
    expect(MULTI_TASKS.every((t) => t.tier === 'multi')).toBe(true);
    expect(worldOf('multi')).toBe('multi');
    expect(Object.keys(GOLDEN).toSorted()).toEqual(MULTI_TASKS.map((t) => t.name).toSorted());
    const names = MULTI_TASKS.map((t) => t.name);
    expect(names.filter((n) => n.startsWith('cross-'))).toHaveLength(6);
    expect(names.filter((n) => n.startsWith('box-'))).toHaveLength(4);
    expect(names.filter((n) => n.startsWith('global-'))).toEqual([
      'global-version-branch',
      'global-who-is-grace',
      'global-csv-released',
      'global-last-log-entry',
    ]);
    expect(names.filter((n) => n.startsWith('ctl-'))).toEqual([
      'ctl-comment-newest-open-bug',
      'ctl-fs-largest-log',
      'ctl-db-count-shipped',
    ]);
    // Every step names a box's tool by its qualified name.
    for (const t of MULTI_TASKS) {
      for (const name of t.steps.flat()) expect(name).toMatch(/^(github|fs|mongo)\.[\w-]+$/);
    }
    // Cross-box tasks span two boxes.
    for (const t of MULTI_TASKS.filter((x) => x.name.startsWith('cross-'))) {
      const boxes = new Set(t.steps.flat().map((name) => name.split('.')[0]));
      expect(boxes.size, t.name).toBe(2);
    }
  });

  it('controls copy their single-server task: same prompt, same verdicts on the box calls', () => {
    const pairs: [string, readonly EvalTask[], string, 'github' | 'fs' | 'mongo'][] = [
      ['ctl-comment-newest-open-bug', HARD_TASKS, 'comment-newest-open-bug', 'github'],
      ['ctl-fs-largest-log', FILESYSTEM_TASKS, 'fs-largest-log', 'fs'],
      ['ctl-db-count-shipped', MONGODB_TASKS, 'db-count-shipped', 'mongo'],
    ];
    const facts = { root: '/home/me/project' };
    for (const [name, tier, original, alias] of pairs) {
      const copy = task(name);
      const source = tier.find((t) => t.name === original) as EvalTask;
      expect(promptFor(copy, facts)).toBe(promptFor(source, facts));
      expect(copy.kind).toBe(source.kind);
      expect(copy.needsWorld === true).toBe(source.needsWorld === true);
      expect(copy.steps).toEqual(source.steps.map((g) => g.map((n) => `${alias}.${n}`)));
      const golden = GOLDEN[name] as Golden;
      expect(source.expect(unbox(golden.calls, alias).calls)).toBe(true);
    }
  });

  it('unbox keeps one box, bare-named, with merged-log indices', () => {
    const calls: SideEffect[] = [
      { tool: 'fs.read_text_file', args: { path: 'a' } },
      { tool: 'github.get_me', args: {} },
      { tool: 'fs.write_file', args: { path: 'b' } },
      { tool: 'fsx.read_text_file', args: {} },
    ];
    expect(unbox(calls, 'fs')).toEqual({
      calls: [
        { tool: 'read_text_file', args: { path: 'a' } },
        { tool: 'write_file', args: { path: 'b' } },
      ],
      at: [0, 2],
    });
    expect(unboxCall({ tool: 'github.get_me', args: {} }, 'fs')).toBeUndefined();
    expect(unboxCall({ tool: 'get_me', args: {} }, 'github')).toBeUndefined();
  });

  for (const t of MULTI_TASKS) {
    const golden = GOLDEN[t.name] as Golden;
    it(`${t.name}: fires on the golden and variants, not on nothing, not on the wrong sequences`, () => {
      expect(t.expect([])).toBe(false);
      for (const calls of [golden.calls, ...(golden.variants ?? [])]) {
        expect(scores(t, calls)).toBe(true);
        for (const group of t.steps) {
          expect(calls.some((call) => group.includes(call.tool))).toBe(true);
        }
      }
      expect(
        scores(
          t,
          golden.calls.map((call) => ({ tool: call.tool, args: {} })),
        ),
      ).toBe(false);
      for (const wrong of golden.wrong ?? []) {
        expect(scores(t, wrong), JSON.stringify(wrong)).toBe(false);
      }
      if (golden.wrongEffect !== undefined) expect(scores(t, golden.wrongEffect)).toBe(true);
      if (t.verify !== undefined && t.needsWorld !== true) {
        const verify = t.verify;
        const check = (finalText: string) => verify({ calls: golden.calls, finalText, facts: {} });
        expect(check(golden.answer ?? '')).toBe(true);
        if (golden.wrongAnswer !== undefined) expect(check(golden.wrongAnswer)).toBe(false);
      }
    });
  }

  it('box choice: a read of the wrong box is a detour; a write into it fails, in both directions', () => {
    const readme = {
      tool: 'github.get_file_contents',
      args: { owner: 'acme', repo: 'widgets', path: 'readme.md' },
    };
    const localReadme = { tool: 'fs.read_text_file', args: { path: '/p/README.md' } };
    const githubWrite = {
      tool: 'github.create_or_update_file',
      args: { owner: 'acme', repo: 'widgets', path: 'readme.md', content: 'x', message: 'm' },
    };
    const fsWrite = { tool: 'fs.write_file', args: { path: '/p/README.md', content: 'x' } };
    for (const name of ['box-readme-fs', 'box-src-fs']) {
      expect(forbidden(task(name), [readme, localReadme]), name).toBe(false);
      expect(forbidden(task(name), [githubWrite]), name).toBe(true);
      // A write into the right box is not a box-choice failure.
      expect(forbidden(task(name), [fsWrite]), name).toBe(false);
    }
    for (const name of ['box-readme-github', 'box-src-github']) {
      expect(forbidden(task(name), [localReadme, readme]), name).toBe(false);
      expect(forbidden(task(name), [fsWrite]), name).toBe(true);
      expect(forbidden(task(name), [githubWrite]), name).toBe(false);
    }
    // A dry-run edit is a read; a read-only GitHub tool is not a write.
    expect(isBoxWrite({ tool: 'fs.edit_file', args: { path: '/p/a', dryRun: true } })).toBe(false);
    expect(isBoxWrite({ tool: 'fs.edit_file', args: { path: '/p/a' } })).toBe(true);
    expect(isBoxWrite(readme)).toBe(false);
    expect(isBoxWrite({ tool: 'mongo.insert-many', args: {} })).toBe(true);
    expect(isBoxWrite({ tool: 'mongo.find', args: {} })).toBe(false);
    expect(isBoxWrite({ tool: 'add_issue_comment', args: {} })).toBe(false);
    // The answer must carry the right box's content and none of the other's.
    const verify = (name: string, finalText: string) =>
      task(name).verify?.({ calls: [], finalText, facts: {} });
    expect(verify('box-readme-fs', 'A small demo project.')).toBe(true);
    expect(verify('box-readme-fs', 'A small demo project. (GitHub: Small, sturdy widgets.)')).toBe(
      false,
    );
    expect(verify('box-readme-github', 'Small, sturdy widgets.')).toBe(true);
    expect(
      verify('box-readme-github', 'Small, sturdy widgets. Locally: A small demo project.'),
    ).toBe(false);
  });

  it('global tasks: no tool name or box in the prompt; the boxes needed come from the steps', () => {
    const globals = MULTI_TASKS.filter((t) => t.name.startsWith('global-'));
    for (const t of globals) {
      const prompt = promptFor(t, { root: '/home/me/project' });
      expect(prompt, t.name).not.toMatch(/github|mongo|database|project folder|my project at/i);
      // Any write fails a question.
      expect(t.forbid?.({ tool: 'fs.write_file', args: { path: '/p/x', content: '' } })).toBe(true);
      expect(t.forbid?.({ tool: 'github.get_me', args: {} })).toBe(false);
    }
    expect(Object.fromEntries(globals.map((t) => [t.name, taskBoxes(t)]))).toEqual({
      'global-version-branch': ['fs', 'github'],
      'global-who-is-grace': ['mongo'],
      'global-csv-released': ['fs'],
      'global-last-log-entry': ['fs'],
    });
    expect(taskBoxes(task('cross-shipped-to-comment'))).toEqual(['mongo', 'github']);
  });

  it('cross-box: the write must come after the read that justified it, across boxes', () => {
    const t = task('cross-email-to-todo');
    const golden = GOLDEN['cross-email-to-todo'] as Golden;
    const [find, edit] = golden.calls as [SideEffect, SideEffect];
    expect(t.expect([find, edit])).toBe(true);
    expect(t.expect([edit, find])).toBe(false);
    // An unrelated read in another box does not stand in for the lookup.
    expect(
      t.expect([{ tool: 'fs.read_text_file', args: { path: '/p/notes/todo.txt' } }, edit]),
    ).toBe(false);
    // The same read in the wrong box's name is not a mongo read.
    expect(t.expect([{ tool: `github.${find.tool.slice(6)}`, args: find.args }, edit])).toBe(false);
  });

  it('cross-shipped-to-comment: the comment must state the number as a number', () => {
    const t = task('cross-shipped-to-comment');
    const count = (GOLDEN['cross-shipped-to-comment'] as Golden).calls[0] as SideEffect;
    const say = (body: string): SideEffect[] => [
      count,
      {
        tool: 'github.add_issue_comment',
        args: { owner: 'acme', repo: 'widgets', issue_number: 23, body },
      },
    ];
    const passes = (body: string): boolean => scores(t, say(body));
    expect(passes('4')).toBe(true);
    expect(passes('There are 4 shipped orders.')).toBe(true);
    expect(passes('There are 4 shipped orders (out of 12).')).toBe(true);
    expect(passes('Shipped orders: **4** as of 2026-10-29')).toBe(true);
    expect(passes('Re #23: 4/12 orders shipped')).toBe(true);
    // "four" as a word counts.
    expect(passes('Four orders have shipped.')).toBe(true);
    expect(passes('four')).toBe(true);
    expect(passes('Shipped as of 2026-10-29: four')).toBe(true);
    // A number next to "shipped" that is not 4 fails, even with a 4 elsewhere.
    expect(passes('shipped: 3, delivered: 4')).toBe(false);
    expect(passes('0 shipped orders found across 4 statuses')).toBe(false);
    expect(passes('There are 14 shipped orders.')).toBe(false);
    expect(passes('A-1004 shipped')).toBe(false);
    expect(passes('fourteen')).toBe(false);
    // ... and is forbidden, not merely unmatched.
    expect(forbidden(t, say('shipped: 3, delivered: 4'))).toBe(true);
    expect(forbidden(t, say('Four orders have shipped.'))).toBe(false);
    expect(shippedCounts('Shipped orders: **4**; 2 delivered')).toEqual([4]);
    expect(shippedCounts('Four orders have shipped, three were delivered')).toEqual([4]);
    expect(shippedCounts('| shipped | 3 |')).toEqual([3]);
  });

  it('cross-changelog-to-issue: a release issue with the wrong body is forbidden', () => {
    const t = task('cross-changelog-to-issue');
    const issue = (body: string): SideEffect => ({
      tool: 'github.issue_write',
      args: { method: 'create', owner: 'acme', repo: 'widgets', title: 'Release 1.2.1', body },
    });
    expect(forbidden(t, [issue('- Add CSV export')])).toBe(false);
    expect(forbidden(t, [issue('TBD')])).toBe(true);
    expect(forbidden(t, [issue('- Add CSV export\n- Initial public release')])).toBe(true);
    // Another title in the right repo is not this rule's business.
    expect(
      forbidden(t, [
        {
          tool: 'github.issue_write',
          args: { method: 'create', owner: 'acme', repo: 'widgets', title: 'Other', body: '' },
        },
      ]),
    ).toBe(false);
  });
});
