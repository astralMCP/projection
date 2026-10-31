/**
 * The multi-hard world end to end, offline from the API but with the real
 * boxes: the hard data is there only when the multi world is opened as the
 * hard variant (the base multi world is unchanged), and a golden solution
 * of every multi-hard task runs clean against the real boxes and scores —
 * `expect`, no forbidden call, and `verify` on the real end state and a
 * correct answer — while a wrong answer or wrong end state does not.
 * Two goldens also run through Projection's `call_tool` to show the
 * approve-all client completes the gated writes there too. A multi-hard
 * episode, interactive and batched, runs to its own turn budget and
 * records per-turn usage and the standard host cost.
 *
 * Skipped when the vendored MongoDB server is not installed (`pnpm run
 * setup:mongodb`).
 */

import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  hostToolName,
  mongodbServerInstalled,
  openSession,
  openWorld,
  runToolChoiceEval,
  HARD_WORLD_BRANCHES,
  HARD_WORLD_ISSUES,
  HARD_WORLD_PULLS,
  MULTI_HARD_EXPECTED as E,
  MULTI_HARD_TASKS,
  VIP_EMAILS,
  type BatchesClient,
  type EvalMode,
  type EvalTask,
  type ModelCaller,
  type ModelPreset,
  type MultiWorld,
  type SideEffect,
} from '../../src/index.js';
import { jobIdOf, runIdOf } from '../../src/eval/multi-hard-github.js';

const installed = mongodbServerInstalled();
const C = 'preconfigured';
const ACME = { owner: 'acme', repo: 'widgets' };
const shop = (collection: string): Record<string, unknown> => ({
  connectionId: C,
  database: 'shop',
  collection,
});

async function openHard(variant: 'hard' | undefined): Promise<MultiWorld> {
  const world = await openWorld('multi', variant === undefined ? {} : { variant });
  if (world.name !== 'multi') throw new Error('expected the multi world');
  return world;
}

function asToolUse(
  mode: EvalMode,
  call: SideEffect,
): { name: string; input: Record<string, unknown> } {
  if (mode === 'direct') {
    const [alias, ...rest] = call.tool.split('.');
    return { name: hostToolName(alias as string, rest.join('.')), input: call.args };
  }
  return { name: 'call_tool', input: { name: call.tool, args: call.args } };
}

/** A golden: the calls (given the episode root), the answer, and a wrong one. */
interface HardGolden {
  calls: (root: string) => SideEffect[];
  answer?: string;
  wrongAnswer?: string;
  /** A call sequence that leaves the wrong end state (needsWorld tasks). */
  wrongEffect?: (root: string) => SideEffect[];
}

const gh = (tool: string, args: Record<string, unknown>): SideEffect => ({
  tool: `github.${tool}`,
  args: { ...ACME, ...args },
});
const mongo = (tool: string, collection: string, args: Record<string, unknown>): SideEffect => ({
  tool: `mongo.${tool}`,
  args: { ...shop(collection), ...args },
});
const fs = (tool: string, args: Record<string, unknown>): SideEffect => ({
  tool: `fs.${tool}`,
  args,
});

const openPrs = HARD_WORLD_PULLS.filter((p) => p.state === 'open').map((p) => p.number);
const LOG_FILES = Object.keys(E.errorCounts);
const exportBody = 'Please add a CHANGELOG entry for the export changes.';

const GOLDEN: Record<string, HardGolden> = {
  'hard-gold-order-totals': {
    calls: () => [
      mongo('find', 'customers', { filter: { tier: 'gold' }, limit: 100 }),
      mongo('aggregate', 'orders', {
        pipeline: [
          { $match: { status: { $ne: 'cancelled' } } },
          { $group: { _id: '$customerEmail', total: { $sum: '$total' } } },
        ],
      }),
    ],
    answer: Object.entries(E.goldTotals)
      .map(([email, total]) => `${email}: $${total.toFixed(2)}`)
      .join('\n'),
    wrongAnswer: 'alice@example.com: $572.15',
  },
  'hard-log-error-lines': {
    calls: (root) => [
      fs('read_multiple_files', { paths: LOG_FILES.map((f) => `${root}/logs/services/${f}`) }),
    ],
    answer: Object.entries(E.errorCounts)
      .map(([file, n]) => `${file}: ${n}`)
      .join('\n'),
    wrongAnswer: LOG_FILES.map((f) => `${f}: 1`).join('\n'),
  },
  'hard-issues-naming-files': {
    calls: (root) => [
      gh('list_issues', { state: 'OPEN', perPage: 100 }),
      fs('directory_tree', { path: root }),
    ],
    answer: `ANSWER: ${E.titleFileIssues.map((n) => `#${n}`).join(', ')}`,
    wrongAnswer: `ANSWER: ${E.titleFileIssues
      .filter((n) => n >= 80)
      .map((n) => `#${n}`)
      .join(', ')}`,
  },
  'hard-label-stale-issues': {
    calls: () => [
      gh('list_issues', { state: 'OPEN', orderBy: 'UPDATED_AT', direction: 'ASC', perPage: 30 }),
      ...Object.entries(E.staleIssues).map(([n, labels]) =>
        gh('issue_write', {
          method: 'update',
          issue_number: Number(n),
          labels: [...labels, 'stale'],
        }),
      ),
    ],
  },
  'hard-comment-export-prs': {
    calls: () => [
      gh('list_pull_requests', { state: 'open', perPage: 100 }),
      ...openPrs.map((n) => gh('pull_request_read', { method: 'get_files', pullNumber: n })),
      ...E.exportPrs.map((n) => gh('add_issue_comment', { issue_number: n, body: exportBody })),
    ],
  },
  'hard-audit-shipped-orders': {
    calls: () => [
      mongo('find', 'orders', { filter: { status: 'shipped' }, limit: 100 }),
      mongo('find', 'audit_log', { filter: { action: 'shipped' }, limit: 100 }),
      mongo('insert-many', 'audit_log', {
        documents: E.missingAudits.map((orderId) => ({ action: 'shipped', orderId })),
      }),
    ],
    wrongEffect: () => [
      mongo('insert-many', 'audit_log', {
        documents: [...E.missingAudits, E.missingAudits[0]].map((orderId) => ({
          action: 'shipped',
          orderId,
        })),
      }),
    ],
  },
  'hard-chain-release-reporter': {
    calls: (root) => [
      fs('read_text_file', { path: `${root}/package.json` }),
      gh('get_release_by_tag', { tag: 'v1.2.0' }),
      ...[41, 57, 63, 72].map((n) => gh('issue_read', { method: 'get', issue_number: n })),
      mongo('find', 'customers', { filter: { github: 'tkowal' } }),
      mongo('find', 'orders', { filter: { customerEmail: 'tomasz.kowal@example.com' } }),
    ],
    answer: `ANSWER: ${E.chainOrders.join(', ')}`,
    wrongAnswer: 'ANSWER: A-1061, A-1090',
  },
  'hard-chain-failing-owner': {
    calls: (root) => [
      gh('list_pull_requests', { state: 'open', perPage: 1 }),
      gh('pull_request_read', { method: 'get_check_runs', pullNumber: 146 }),
      // A check run has no output; the file is in its job's log.
      gh('get_job_logs', { job_id: jobIdOf(146, 2), return_content: true }),
      fs('read_text_file', { path: `${root}/CODEOWNERS` }),
      mongo('find', 'staff', { filter: { github: 'rhea-m' } }),
      gh('search_issues', { query: 'repo:acme/widgets is:open assignee:rhea-m' }),
    ],
    answer: `ANSWER: ${E.owner.email} ${E.owner.openAssigned}`,
    wrongAnswer: `ANSWER: dana.kim@acme.dev ${E.owner.openAssigned}`,
  },
  'hard-page-feature-branches': {
    calls: () => [gh('list_branches', { perPage: 100 })],
    answer: `ANSWER: ${E.featureBranches}`,
    wrongAnswer: 'ANSWER: 10',
  },
  'hard-page-first-2025-release': {
    calls: () => [
      gh('list_releases', { perPage: 30 }),
      gh('list_releases', { perPage: 30, page: 2 }),
    ],
    answer: `ANSWER: ${E.first2025Tag}`,
    wrongAnswer: 'ANSWER: v0.4.0',
  },
  'hard-branch-failing-checks': {
    calls: (root) => [
      gh('pull_request_read', { method: 'get_check_runs', pullNumber: 139 }),
      gh('get_job_logs', { run_id: runIdOf(139), failed_only: true, return_content: true }),
      fs('directory_tree', { path: root }),
      ...E.fixIssues.map((path) =>
        gh('issue_write', {
          method: 'create',
          title: `Fix ${path}`,
          body: 'Reported by a failing check on #139.',
        }),
      ),
      gh('add_issue_comment', {
        issue_number: 139,
        body: `These files do not exist in the project: ${E.missingFiles.join(', ')}`,
      }),
    ],
  },
  'hard-branch-vip-tiers': {
    calls: (root) => [
      fs('read_text_file', { path: `${root}/notes/vip.txt` }),
      mongo('find', 'customers', { filter: { email: { $in: [...VIP_EMAILS] } }, limit: 100 }),
      mongo('update-many', 'customers', {
        filter: { email: { $in: [...E.vipUpgrades] } },
        update: { $set: { tier: 'gold' } },
      }),
      fs('write_file', {
        path: `${root}/notes/missing-vips.txt`,
        content: `${E.vipMissing.join('\n')}\n`,
      }),
    ],
    wrongEffect: (root) => [
      // Every VIP's email upgraded is fine (the missing ones match nothing),
      // but the file also names a customer.
      mongo('update-many', 'customers', {
        filter: { email: { $in: [...VIP_EMAILS] } },
        update: { $set: { tier: 'gold' } },
      }),
      fs('write_file', {
        path: `${root}/notes/missing-vips.txt`,
        content: `${[...E.vipMissing, 'bob@example.com'].join('\n')}\n`,
      }),
    ],
  },
};

async function replay(world: MultiWorld, mode: EvalMode, calls: SideEffect[]): Promise<string[]> {
  const session = await openSession(mode, world);
  const texts: string[] = [];
  try {
    for (const call of calls) {
      const { name, input } = asToolUse(mode, call);
      const result = await session.runtime.call(name, input);
      expect(result.isError, `${mode} ${call.tool}: ${result.text}`).toBeUndefined();
      texts.push(result.text);
    }
  } finally {
    await session.close();
  }
  return texts;
}

/** A model that pages forever: list_branches on every turn. */
function pageForever(): Anthropic.Message {
  return {
    id: 'msg_scripted',
    type: 'message',
    role: 'assistant',
    model: 'scripted',
    content: [
      {
        type: 'tool_use',
        id: 'tu_page',
        name: hostToolName('github', 'list_branches'),
        input: { ...ACME, page: 2 },
      },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 300,
      output_tokens: 20,
      cache_read_input_tokens: 2_000,
      cache_creation_input_tokens: 0,
    },
  } as unknown as Anthropic.Message;
}

describe.skipIf(!installed)('multi-hard world', () => {
  it('holds the hard data only when opened as the hard variant', async () => {
    const base = await openHard(undefined);
    const hard = await openHard('hard');
    try {
      const [baseTexts, hardTexts] = await Promise.all(
        [base, hard].map((world) =>
          replay(world, 'direct', [
            fs('list_directory', { path: `${world.facts.root}/logs` }),
            mongo('count', 'customers', {}),
            { tool: 'mongo.list-collections', args: { connectionId: C, database: 'shop' } },
            gh('list_issues', {}),
            gh('list_branches', {}),
          ]),
        ),
      );
      const [baseLogs, baseCustomers, baseCollections, baseIssues, baseBranches] =
        baseTexts as string[];
      const [hardLogs, hardCustomers, hardCollections, hardIssues, hardBranches] =
        hardTexts as string[];
      expect(baseLogs).not.toContain('services');
      expect(hardLogs).toContain('services');
      expect(baseCustomers).toMatch(/\b8\b/);
      expect(hardCustomers).toMatch(/\b48\b/);
      expect(baseCollections).not.toContain('staff');
      expect(hardCollections).toContain('staff');
      // The base fake: four issues; the same 64 branches, 30 to a page.
      expect(JSON.parse(baseIssues as string).totalCount).toBe(4);
      expect(JSON.parse(baseBranches as string)).toHaveLength(30);
      // The hard fake: GitHub's default page of 30, a cursor to the next.
      const issues = JSON.parse(hardIssues as string);
      expect(issues.totalCount).toBe(HARD_WORLD_ISSUES.length);
      expect(issues.issues).toHaveLength(30);
      expect(issues.pageInfo.hasNextPage).toBe(true);
      expect(JSON.parse(hardBranches as string)).toHaveLength(30);
      expect(HARD_WORLD_BRANCHES).toHaveLength(64);
    } finally {
      await Promise.all([base.close(), hard.close()]);
    }
  }, 120_000);

  it('pages list_issues by cursor and labels by replacement', async () => {
    const world = await openHard('hard');
    try {
      const [first] = await replay(world, 'direct', [gh('list_issues', { state: 'OPEN' })]);
      const cursor = JSON.parse(first as string).pageInfo.endCursor;
      const [second, update] = await replay(world, 'direct', [
        gh('list_issues', { state: 'OPEN', after: cursor }),
        gh('issue_write', { method: 'update', issue_number: 43, labels: ['stale'] }),
      ]);
      const page2 = JSON.parse(second as string);
      expect(page2.issues).toHaveLength(30);
      expect(page2.pageInfo.hasNextPage).toBe(false);
      expect(JSON.parse(update as string)).toEqual({
        id: expect.any(String),
        url: 'https://github.com/acme/widgets/issues/43',
      });
      const [read] = await replay(world, 'direct', [
        gh('issue_read', { method: 'get', issue_number: 43 }),
      ]);
      expect(JSON.parse(read as string).labels).toEqual(['stale']);
    } finally {
      await world.close();
    }
  }, 120_000);

  it('shows an episode its own writes, and no other episode', async () => {
    const [first, second] = await Promise.all([openHard('hard'), openHard('hard')]);
    try {
      const [, , read, comments] = await replay(first, 'direct', [
        gh('issue_write', { method: 'update', issue_number: 43, labels: ['bug', 'stale'] }),
        gh('add_issue_comment', { issue_number: 139, body: 'src/cache/lru.ts is missing.' }),
        gh('issue_read', { method: 'get', issue_number: 43 }),
        gh('pull_request_read', { method: 'get_comments', pullNumber: 139 }),
      ]);
      expect(JSON.parse(read as string).labels).toEqual(['bug', 'stale']);
      expect(JSON.parse(comments as string).map((c: { body: string }) => c.body)).toEqual([
        'src/cache/lru.ts is missing.',
      ]);
      const [fresh] = await replay(second, 'direct', [
        gh('issue_read', { method: 'get', issue_number: 43 }),
      ]);
      expect(JSON.parse(fresh as string).labels).toEqual(['bug']);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  }, 120_000);

  describe('every golden runs clean against the real boxes and scores', () => {
    for (const task of MULTI_HARD_TASKS) {
      const golden = GOLDEN[task.name] as HardGolden;
      it(
        task.name,
        async () => {
          const world = await openHard('hard');
          try {
            const root = world.facts.root ?? '';
            const context = (finalText: string) => ({
              calls: world.calls,
              finalText,
              facts: world.facts,
            });
            await replay(world, 'direct', golden.calls(root));
            expect(task.expect(world.calls)).toBe(true);
            const forbid = task.forbid;
            if (forbid !== undefined) expect(world.calls.filter((c) => forbid(c))).toEqual([]);
            if (task.verify !== undefined) {
              expect(await task.verify(context(golden.answer ?? ''))).toBe(true);
              if (golden.wrongAnswer !== undefined) {
                expect(await task.verify(context(golden.wrongAnswer))).toBe(false);
              }
            }
          } finally {
            await world.close();
          }
        },
        120_000,
      );
    }
  });

  describe('wrong end states fail verify', () => {
    for (const task of MULTI_HARD_TASKS.filter((t) => GOLDEN[t.name]?.wrongEffect !== undefined)) {
      it(
        task.name,
        async () => {
          const world = await openHard('hard');
          try {
            const root = world.facts.root ?? '';
            await replay(
              world,
              'direct',
              (GOLDEN[task.name] as HardGolden).wrongEffect?.(root) ?? [],
            );
            expect(
              await (task as Required<Pick<EvalTask, 'verify'>>).verify({
                calls: world.calls,
                finalText: '',
                facts: world.facts,
              }),
            ).toBe(false);
          } finally {
            await world.close();
          }
        },
        120_000,
      );
    }
  });

  it('Projection completes approved bulk writes through call_tool', async () => {
    for (const name of ['hard-audit-shipped-orders', 'hard-label-stale-issues']) {
      const task = MULTI_HARD_TASKS.find((t) => t.name === name) as EvalTask;
      const world = await openHard('hard');
      try {
        await replay(
          world,
          'projection',
          (GOLDEN[name] as HardGolden).calls(world.facts.root ?? ''),
        );
        expect(task.expect(world.calls), name).toBe(true);
        if (task.verify !== undefined) {
          expect(await task.verify({ calls: world.calls, finalText: '', facts: world.facts })).toBe(
            true,
          );
        }
      } finally {
        await world.close();
      }
    }
  }, 120_000);

  it(
    'runs a multi-hard episode to its own budget, with per-turn usage and standardUsd',
    { timeout: 180_000 },
    async () => {
      const task = MULTI_HARD_TASKS.find(
        (t) => t.name === 'hard-page-feature-branches',
      ) as EvalTask;
      const budget = task.maxTurns as number;
      const caller: ModelCaller = async () => pageForever();
      // Answers every request at once; the batch has ended by the first poll.
      const created: Anthropic.Messages.BatchCreateParams[] = [];
      const client: BatchesClient = {
        create: async (params) => {
          created.push(params);
          return { id: `msgbatch_${created.length}` };
        },
        cancel: async (id) => ({ id }),
        retrieve: async (id) => ({
          id,
          processing_status: 'ended',
          request_counts: { processing: 0, succeeded: 0, errored: 0, expired: 0, canceled: 0 },
        }),
        results: async (id) => {
          const params = created[Number(id.split('_')[1]) - 1];
          return (async function* () {
            for (const r of params?.requests ?? []) {
              yield {
                custom_id: r.custom_id,
                result: { type: 'succeeded', message: pageForever() },
              };
            }
          })();
        },
      };
      const haiku: ModelPreset = { name: 'haiku45', model: 'claude-haiku-4-5', params: {} };
      const options = {
        models: [haiku],
        modes: ['direct' as const],
        tasks: [task],
        runs: 1,
        // The run's budget, which the task's own overrides.
        maxTurns: 3,
      };
      const [interactive] = await runToolChoiceEval({ ...options, caller });
      const [batched] = await runToolChoiceEval({
        ...options,
        batch: { client, sleep: async () => {} },
      });
      for (const record of [interactive, batched]) {
        expect(record?.harnessError).toBeUndefined();
        expect(record).toMatchObject({
          tier: 'multi-hard',
          turnCapped: true,
          apiTurns: budget,
          budgetTurns: budget,
          prefixSource: 'estimate',
        });
        expect(record?.turns).toHaveLength(budget);
        expect(record?.standardUsd).toBeGreaterThan(0);
        expect(record?.estimatedUsd).toBeGreaterThan(0);
      }
      expect(created).toHaveLength(budget);
      expect(batched?.batch).toBe(true);
      // The standard host cost does not depend on how the run was billed.
      expect(batched?.standardUsd).toBe(interactive?.standardUsd);
      expect(batched?.estimatedUsd).toBeCloseTo((interactive?.estimatedUsd ?? NaN) / 2, 12);
    },
  );
});
