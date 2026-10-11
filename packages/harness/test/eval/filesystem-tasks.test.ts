/**
 * Filesystem-tier predicates: each task fires on its golden upstream calls
 * and stays quiet on nothing or on the right tool with empty arguments;
 * `forbid` catches the wrong write; and `verify` is exercised against a
 * real fixture tree — the golden effect applied by hand passes, the
 * untouched tree (or a wrong answer) fails. The goldens themselves live in
 * filesystem-goldens.ts; filesystem-world.test.ts runs them for real.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FILESYSTEM_TASKS,
  promptFor,
  worldOf,
  writeFilesystemFixture,
  type EvalTask,
  type SideEffect,
} from '../../src/index.js';
import { GOLDEN, GOLDEN_ROOT as R, type Golden } from './filesystem-goldens.js';

function task(name: string): EvalTask {
  const found = FILESYSTEM_TASKS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no task ${name}`);
  return found;
}

/** `success` before verify: expect holds and nothing forbidden was called. */
function scores(t: EvalTask, calls: SideEffect[]): boolean {
  const forbid = t.forbid;
  return t.expect(calls) && !(forbid !== undefined && calls.some((c) => forbid(c)));
}

describe('filesystem tasks', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fs-tasks-'));
    writeFilesystemFixture(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('has 15 tasks in the filesystem tier, each with a golden', () => {
    expect(FILESYSTEM_TASKS).toHaveLength(15);
    expect(FILESYSTEM_TASKS.every((t) => t.tier === 'filesystem')).toBe(true);
    expect(worldOf('filesystem')).toBe('filesystem');
    expect(Object.keys(GOLDEN).toSorted()).toEqual(FILESYSTEM_TASKS.map((t) => t.name).toSorted());
    for (const t of FILESYSTEM_TASKS) expect(promptFor(t, { root: R })).toContain(R);
  });

  for (const t of FILESYSTEM_TASKS) {
    const golden = GOLDEN[t.name] as Golden;

    it(`${t.name}: fires on the golden calls, not on nothing, not on the wrong sequence`, () => {
      expect(t.expect([])).toBe(false);
      expect(scores(t, golden.calls)).toBe(true);
      for (const group of t.steps) {
        expect(golden.calls.some((call) => group.includes(call.tool))).toBe(true);
      }
      expect(
        scores(
          t,
          golden.calls.map((call) => ({ tool: call.tool, args: {} })),
        ),
      ).toBe(false);
      if (golden.wrong !== undefined) expect(scores(t, golden.wrong)).toBe(false);
      // Relative paths match too.
      const relative = golden.calls.map((call) => ({
        tool: call.tool,
        args: Object.fromEntries(
          Object.entries(call.args).map(([k, v]) => [
            k,
            typeof v === 'string' ? v.replace(`${R}/`, '').replace(R, '.') : v,
          ]),
        ),
      }));
      expect(scores(t, relative)).toBe(true);
    });

    if (t.verify !== undefined) {
      const verify = t.verify.bind(t);
      it(`${t.name}: verify accepts the golden end state and rejects the untouched one`, async () => {
        const context = (finalText: string) => ({
          calls: golden.calls,
          finalText,
          facts: { root },
        });
        if (golden.apply !== undefined) {
          expect(await verify(context(golden.answer ?? ''))).toBe(false);
          golden.apply(root);
        }
        for (const answer of [golden.answer ?? '', ...(golden.answers ?? [])]) {
          expect(await verify(context(answer)), answer).toBe(true);
        }
        for (const wrong of [
          ...(golden.wrongAnswer !== undefined ? [golden.wrongAnswer] : []),
          ...(golden.wrongAnswers ?? []),
        ]) {
          expect(await verify(context(wrong)), wrong).toBe(false);
        }
      });
    }
  }

  it('fs-dry-run-colour and fs-create-unless-exists: verify rejects a mutated tree', async () => {
    writeFileSync(join(root, 'src/util.js'), 'export const defaultColor = "blue";\n');
    writeFileSync(join(root, 'notes/ideas.txt'), 'TBD');
    const facts = { root };
    expect(await task('fs-dry-run-colour').verify?.({ calls: [], finalText: '', facts })).toBe(
      false,
    );
    expect(
      await task('fs-create-unless-exists').verify?.({ calls: [], finalText: 'dark mode', facts }),
    ).toBe(false);
  });
});
