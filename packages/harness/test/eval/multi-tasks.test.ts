/**
 * Multi-tier predicates, offline (no servers): each task fires on its
 * golden calls and variants, stays quiet on nothing, on the right tools
 * with empty arguments, and on every plausible wrong sequence; a call to
 * the wrong box is forbidden where the task says so; text-only verifies
 * accept the right answer and reject the wrong one. The goldens' fidelity
 * against the real boxes, and every world-reading verify, are checked in
 * multi-world.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  FILESYSTEM_TASKS,
  HARD_TASKS,
  MONGODB_TASKS,
  MULTI_TASKS,
  promptFor,
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
  it('has 13 tasks in the multi tier: 6 cross-box, 4 box-choice, 3 controls, each with a golden', () => {
    expect(MULTI_TASKS).toHaveLength(13);
    expect(MULTI_TASKS.every((t) => t.tier === 'multi')).toBe(true);
    expect(worldOf('multi')).toBe('multi');
    expect(Object.keys(GOLDEN).toSorted()).toEqual(MULTI_TASKS.map((t) => t.name).toSorted());
    const names = MULTI_TASKS.map((t) => t.name);
    expect(names.filter((n) => n.startsWith('cross-'))).toHaveLength(6);
    expect(names.filter((n) => n.startsWith('box-'))).toHaveLength(4);
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

  it('box choice: the wrong box is forbidden even when the right box was also used', () => {
    const readme = {
      tool: 'github.get_file_contents',
      args: { owner: 'acme', repo: 'widgets', path: 'readme.md' },
    };
    const localReadme = { tool: 'fs.read_text_file', args: { path: '/p/README.md' } };
    expect(forbidden(task('box-readme-fs'), [localReadme, readme])).toBe(true);
    expect(forbidden(task('box-readme-github'), [localReadme, readme])).toBe(true);
    expect(forbidden(task('box-readme-fs'), [localReadme])).toBe(false);
    expect(forbidden(task('box-readme-github'), [readme])).toBe(false);
    // Looking up where the project is, or other fs reads, is not the wrong box's readme.
    expect(
      forbidden(task('box-readme-github'), [
        { tool: 'fs.list_allowed_directories', args: {} },
        { tool: 'fs.read_text_file', args: { path: '/p/package.json' } },
      ]),
    ).toBe(false);
    const src = {
      tool: 'github.get_file_contents',
      args: { owner: 'acme', repo: 'widgets', path: 'src' },
    };
    const localSrc = { tool: 'fs.list_directory', args: { path: '/p/src' } };
    expect(forbidden(task('box-src-fs'), [src])).toBe(true);
    expect(forbidden(task('box-src-github'), [localSrc])).toBe(true);
    expect(
      forbidden(task('box-src-github'), [{ tool: 'fs.list_allowed_directories', args: {} }]),
    ).toBe(false);
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
    expect(t.expect(say('4'))).toBe(true);
    expect(t.expect(say('There are 4 shipped orders.'))).toBe(true);
    expect(t.expect(say('There are 14 shipped orders.'))).toBe(false);
    expect(t.expect(say('Shipped as of 2026-10-29: four'))).toBe(false);
  });
});
