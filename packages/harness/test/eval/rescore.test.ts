/**
 * The offline re-scorer: current graders applied to saved records, verify
 * re-run only where it does not need the live world.
 */

import { describe, expect, it } from 'vitest';
import {
  OFFLINE_FACTS,
  rescoreRecords,
  TOOL_CHOICE_TASKS,
  type EpisodeRecord,
  type EvalTask,
  type SideEffect,
} from '../../src/index.js';

function record(
  task: string,
  calls: SideEffect[],
  verdict: Pick<EpisodeRecord, 'success' | 'toolCorrect' | 'forbidden'>,
  extra: Partial<EpisodeRecord> = {},
): EpisodeRecord {
  return {
    model: 'm',
    modelId: 'model-id',
    mode: 'direct',
    task,
    tier: 'filesystem',
    world: 'filesystem',
    kind: 'single',
    run: 0,
    ...verdict,
    turnCapped: false,
    apiTurns: 2,
    budgetTurns: 2,
    toolUseCount: calls.length,
    toolUses: [],
    upstreamCalls: calls,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    wallMs: 1,
    finalText: '',
    ...extra,
  };
}

const read: SideEffect = { tool: 'read', args: { path: 'a' } };
const write: SideEffect = { tool: 'write', args: { path: 'a' } };

const TASKS: EvalTask[] = [
  {
    // Text-only verify: re-run offline.
    name: 'answer',
    tier: 'filesystem',
    kind: 'single',
    prompt: 'p',
    steps: [['read']],
    expect: (calls) => calls.some((c) => c.tool === 'read'),
    verify: ({ finalText }) => finalText.includes('right'),
  },
  {
    // World verify: the recorded verdict stands unless expect/forbid now fail.
    name: 'world',
    tier: 'filesystem',
    kind: 'single',
    needsWorld: true,
    prompt: 'p',
    steps: [['read']],
    expect: (calls) => calls.some((c) => c.tool === 'read'),
    forbid: (call) => call.tool === 'write',
    verify: () => {
      throw new Error('must not run offline');
    },
  },
];

describe('rescoreRecords', () => {
  it('re-runs expect, forbid, steps and a text-only verify; keeps world verdicts', async () => {
    const records = [
      // Upgraded: the answer is right under the current verify.
      record(
        'answer',
        [read],
        { success: false, toolCorrect: true, forbidden: false },
        {
          finalText: 'the right file',
        },
      ),
      // Downgraded: the answer no longer passes.
      record(
        'answer',
        [read],
        { success: true, toolCorrect: true, forbidden: false },
        {
          finalText: 'wrong',
          run: 1,
        },
      ),
      // World task, expect still holds: recorded success kept either way.
      record('world', [read], { success: true, toolCorrect: true, forbidden: false }),
      record('world', [read], { success: false, toolCorrect: true, forbidden: false }, { run: 1 }),
      // World task now forbidden: downgraded without running verify.
      record(
        'world',
        [read, write],
        { success: true, toolCorrect: true, forbidden: false },
        {
          run: 2,
        },
      ),
      // World task whose expect now fails: downgraded, and no longer tool-correct.
      record('world', [], { success: true, toolCorrect: true, forbidden: false }, { run: 3 }),
      // Harness errors and unknown tasks pass through untouched.
      record(
        'answer',
        [read],
        { success: false, toolCorrect: false, forbidden: false },
        {
          harnessError: 'harness: boom',
          finalText: 'right',
          run: 2,
        },
      ),
      record('gone', [], { success: true, toolCorrect: true, forbidden: false }),
    ];
    const {
      records: out,
      changed,
      errors,
      worldFailuresKept,
    } = await rescoreRecords(records, { tasks: TASKS });

    expect(out.map((r) => [r.success, r.toolCorrect, r.forbidden])).toEqual([
      [true, true, false],
      [false, true, false],
      [true, true, false],
      [false, true, false],
      [false, true, true],
      [false, false, false],
      [false, false, false],
      [true, true, false],
    ]);
    expect(out[6]).toBe(records[6]);
    expect(out[7]).toBe(records[7]);
    // Everything but the verdict is left alone.
    expect({ ...out[0], success: false }).toEqual(records[0]);
    expect(changed).toEqual([
      {
        task: 'answer',
        model: 'm',
        mode: 'direct',
        run: 0,
        before: { success: false, toolCorrect: true, forbidden: false },
        after: { success: true, toolCorrect: true, forbidden: false },
      },
      expect.objectContaining({ task: 'answer', run: 1 }),
      expect.objectContaining({
        task: 'world',
        run: 2,
        after: { success: false, toolCorrect: true, forbidden: true },
      }),
      expect.objectContaining({
        task: 'world',
        run: 3,
        after: { success: false, toolCorrect: false, forbidden: false },
      }),
    ]);
    expect(errors).toEqual([]);
    // world #1: recorded as failed, expect and forbid pass now, verify not re-run.
    expect(worldFailuresKept).toBe(1);
  });

  it('reports a grader that throws (or reads facts offline) and leaves the record as recorded', async () => {
    const tasks: EvalTask[] = [
      {
        // Reads facts without being marked needsWorld: caught, not graded.
        name: 'peeks',
        tier: 'filesystem',
        kind: 'single',
        prompt: 'p',
        steps: [['read']],
        expect: () => true,
        verify: ({ facts }) => facts.root !== undefined,
      },
      {
        name: 'broken',
        tier: 'filesystem',
        kind: 'single',
        prompt: 'p',
        steps: [['read']],
        expect: () => {
          throw new Error('expect blew up');
        },
      },
    ];
    const records = [
      record('peeks', [read], { success: true, toolCorrect: true, forbidden: false }),
      record('broken', [read], { success: false, toolCorrect: true, forbidden: false }, { run: 4 }),
    ];
    const { records: out, changed, errors } = await rescoreRecords(records, { tasks });
    expect(out[0]).toBe(records[0]);
    expect(out[1]).toBe(records[1]);
    expect(changed).toEqual([]);
    expect(errors).toEqual([
      {
        task: 'peeks',
        model: 'm',
        mode: 'direct',
        run: 0,
        message: expect.stringContaining('facts.root'),
      },
      { task: 'broken', model: 'm', mode: 'direct', run: 4, message: 'expect blew up' },
    ]);
  });

  it('defaults to the built-in tasks', async () => {
    const tree = '```\nsrc/\n├── index.js\n├── legacy/\n│   └── old.js\n└── util.js\n```';
    const { changed } = await rescoreRecords([
      record(
        'fs-src-tree',
        [{ tool: 'directory_tree', args: { path: '/root/src' } }],
        { success: false, toolCorrect: true, forbidden: false },
        { finalText: `${tree}\n\n(debug.log was excluded as it's a log file)` },
      ),
    ]);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.after.success).toBe(true);
  });

  it('needsWorld is set on exactly the built-in tasks whose verify needs the world', async () => {
    // On the re-scorer's facts (any read throws), a world-reading verify
    // throws; every other verify answers from the calls and text alone.
    for (const task of TOOL_CHOICE_TASKS) {
      if (task.verify === undefined) {
        expect(task.needsWorld, task.name).toBeUndefined();
        continue;
      }
      const offline = Promise.resolve().then(() =>
        task.verify?.({ calls: [], finalText: '', facts: OFFLINE_FACTS }),
      );
      if (task.needsWorld === true) await expect(offline, task.name).rejects.toThrow();
      else await expect(offline, task.name).resolves.toBeTypeOf('boolean');
    }
  });
});
