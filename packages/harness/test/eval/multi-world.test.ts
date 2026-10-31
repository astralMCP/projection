/**
 * The multi world end to end, offline from the API but with the real
 * boxes: the GitHub fake, the filesystem reference server and the MongoDB
 * MCP server on a throwaway `mongod`. Checks the world (one qualified call
 * log, merged facts, teardown), each mode's tool surface (direct's
 * `<alias>__<name>` tools and instructions; Projection's per-box search
 * tools with and without `search_tools`), every golden through every
 * mode's surface (runs clean, scores, `verify` flips where the golden has
 * an effect), and a scripted model through the runner in all three modes.
 *
 * Skipped when the vendored MongoDB server is not installed (`pnpm run
 * setup:mongodb`).
 */

import type Anthropic from '@anthropic-ai/sdk';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  formatToolChoiceReport,
  hostToolName,
  mongodbServerInstalled,
  openSession,
  openWorld,
  resolveModes,
  resolveTasks,
  runToolChoiceEval,
  summarizeToolChoice,
  EVAL_MODES,
  GITHUB_CATALOG,
  HOST_TOOL_NAME_MAX,
  HOST_TOOL_NAME_PATTERN,
  MONGODB_EXPECTED_TOOLS,
  MULTI_BOX_DESCRIPTIONS,
  MULTI_DIRECT_SYSTEM_PROMPT,
  MULTI_INSTRUCTIONS_HEADER,
  MULTI_TASKS,
  type EvalMode,
  type ModelCaller,
  type ModelPreset,
  type ModeSession,
  type MultiWorld,
  type SideEffect,
} from '../../src/index.js';
import { GOLDEN, rebase, type Golden } from './multi-goldens.js';
import { toolNames } from './tool-names.js';

const installed = mongodbServerInstalled();
const preset: ModelPreset = { name: 'scripted', model: 'scripted-model', params: {} };

function message(content: unknown[], stop: Anthropic.StopReason): Anthropic.Message {
  return {
    id: 'msg_scripted',
    type: 'message',
    role: 'assistant',
    model: 'scripted',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  } as unknown as Anthropic.Message;
}

/** A qualified call as the given mode's model would make it. */
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

async function openMulti(): Promise<MultiWorld> {
  const world = await openWorld('multi');
  if (world.name !== 'multi') throw new Error('expected the multi world');
  return world;
}

/** Run `calls` through `session`, one tool call each; every result must be clean. */
async function replay(session: ModeSession, calls: SideEffect[]): Promise<string[]> {
  const texts: string[] = [];
  for (const call of calls) {
    const { name, input } = asToolUse(session.mode, call);
    const result = await session.runtime.call(name, input);
    expect(result.isError, `${session.mode} ${call.tool}: ${result.text}`).toBeUndefined();
    texts.push(result.text);
  }
  return texts;
}

describe.skipIf(!installed)('multi world', () => {
  it('opens all three boxes, records one qualified call log, merges facts, tears down', async () => {
    const world = await openMulti();
    let root: string | undefined;
    try {
      expect(world.boxes.map((b) => [b.alias, b.world.name])).toEqual([
        ['fs', 'filesystem'],
        ['github', 'github'],
        ['mongo', 'mongodb'],
      ]);
      root = world.facts.root;
      expect(root).toBeDefined();
      expect(world.facts.mongoUri).toMatch(/^mongodb:\/\//);
      expect(world.tools).toHaveLength(
        14 + GITHUB_CATALOG.tools.length + MONGODB_EXPECTED_TOOLS.length,
      );
      expect(world.tools.map((t) => t.name)).toContain('mongo.insert-many');
      expect(world.instructions).toBeUndefined();

      const session = await openSession('direct', world);
      try {
        await replay(session, [
          { tool: 'github.get_me', args: {} },
          { tool: 'fs.read_text_file', args: { path: `${root}/package.json` } },
          { tool: 'mongo.list-databases', args: { connectionId: 'preconfigured' } },
          { tool: 'github.list_notifications', args: {} },
        ]);
      } finally {
        await session.close();
      }
      expect(world.calls.map((c) => c.tool)).toEqual([
        'github.get_me',
        'fs.read_text_file',
        'mongo.list-databases',
        'github.list_notifications',
      ]);
      // Each box keeps its own bare-named log.
      const github = world.boxes.find((b) => b.alias === 'github');
      expect(github?.world.calls.map((c) => c.tool)).toEqual(['get_me', 'list_notifications']);
    } finally {
      await world.close();
    }
    expect(existsSync(root ?? '')).toBe(false);
  }, 120_000);

  it('direct: every tool as <alias>__<name> within the API name rule, instructions under alias headings', async () => {
    const world = await openMulti();
    try {
      const session = await openSession('direct', world);
      try {
        const names = session.runtime.tools.map((t) => t.name);
        expect(names).toHaveLength(world.tools.length);
        expect(new Set(names).size).toBe(names.length);
        for (const box of world.boxes) {
          for (const tool of box.world.tools) {
            // No current name needs truncating or rewriting.
            expect(names).toContain(`${box.alias}__${tool.name}`);
          }
        }
        for (const name of names) expect(name).toMatch(HOST_TOOL_NAME_PATTERN);
        expect(Math.max(...names.map((n) => n.length))).toBeLessThanOrEqual(HOST_TOOL_NAME_MAX);
        expect(names).toContain('github__get_file_contents');
        expect(names).toContain('fs__read_text_file');
        expect(names).toContain('mongo__insert-many');
        expect(session.budgetFreeTools.size).toBe(0);

        const system = session.runtime.system;
        expect(system.startsWith(MULTI_DIRECT_SYSTEM_PROMPT)).toBe(true);
        expect(system).toContain(MULTI_INSTRUCTIONS_HEADER);
        for (const box of world.boxes) {
          const heading = `## ${box.alias}\n\n`;
          if (box.world.instructions === undefined) expect(system).not.toContain(heading);
          else expect(system).toContain(`${heading}${box.world.instructions}`);
        }
        expect(system).toContain(GITHUB_CATALOG.instructions);
        // An unknown name is an error result, not a throw.
        expect(await session.runtime.call('github__nope', {})).toMatchObject({ isError: true });
      } finally {
        await session.close();
      }
    } finally {
      await world.close();
    }
  }, 120_000);

  it('projection: per-box search tools plus search_tools; projection-boxes drops search_tools', async () => {
    const surfaces: Partial<Record<EvalMode, ModeSession>> = {};
    for (const mode of ['projection', 'projection-boxes'] as const) {
      const world = await openMulti();
      try {
        const session = await openSession(mode, world);
        try {
          surfaces[mode] = session;
          const all = session.runtime.tools.map((t) => t.name).toSorted();
          // The fs box fits the direct budget (D28): its tools are listed as
          // mediated `fs__<tool>` aliases instead of a search_fs.
          const listed = all.filter((n) => n.startsWith('fs__'));
          expect(listed).toContain('fs__read_text_file');
          const names = all.filter((n) => !n.startsWith('fs__'));
          const boxSearches = ['search_github', 'search_mongo'];
          expect(names).toEqual(
            [
              'call_tool',
              'describe_tool',
              'discover_apis',
              'execute_machine',
              ...boxSearches,
              ...(mode === 'projection' ? ['search_tools'] : []),
            ].toSorted(),
          );
          expect([...session.budgetFreeTools].toSorted()).toEqual(
            ['describe_tool', 'discover_apis', 'search_tools', ...boxSearches].toSorted(),
          );
          const system = session.runtime.system;
          // The host's framing first, as in direct mode; then the facade's instructions.
          expect(system.startsWith(`${MULTI_DIRECT_SYSTEM_PROMPT}\n\n`)).toBe(true);
          for (const alias of ['fs', 'github', 'mongo'])
            expect(system).toMatch(new RegExp(`^- ${alias}\\b`, 'm'));
          // No host descriptions unless the variant asks for them.
          for (const description of Object.values(MULTI_BOX_DESCRIPTIONS)) {
            expect(system).not.toContain(description);
          }
          if (mode === 'projection') expect(system).toContain('search_tools');
          else expect(system).not.toContain('search_tools');
          // A box search answers with that box's qualified names only.
          const found = await session.runtime.call('search_mongo', { query: 'find documents' });
          expect(found.isError).toBeUndefined();
          expect(found.text).toContain('mongo.find');
          expect(found.text).not.toContain('github.');
        } finally {
          await session.close();
        }
      } finally {
        await world.close();
      }
    }
    expect(Object.keys(surfaces).toSorted()).toEqual(['projection', 'projection-boxes']);
  }, 120_000);

  it('the box-descriptions variant puts the host descriptions on the shelf', async () => {
    const world = await openMulti();
    try {
      const session = await openSession('projection', world, { boxDescriptions: true });
      try {
        const system = session.runtime.system;
        expect(system.startsWith(MULTI_DIRECT_SYSTEM_PROMPT)).toBe(true);
        for (const description of Object.values(MULTI_BOX_DESCRIPTIONS)) {
          expect(system).toContain(description);
        }
      } finally {
        await session.close();
      }
    } finally {
      await world.close();
    }
  }, 120_000);

  describe('golden fidelity: every golden runs clean through every mode and scores', () => {
    for (const task of MULTI_TASKS) {
      const golden = GOLDEN[task.name] as Golden;
      for (const mode of EVAL_MODES) {
        it(`${task.name} via ${mode}`, async () => {
          const world = await openMulti();
          try {
            const root = world.facts.root ?? '';
            const calls = rebase(golden.calls, root);
            const context = (finalText: string) => ({
              calls: world.calls,
              finalText,
              facts: world.facts,
            });
            if (golden.mutates === true && task.verify !== undefined) {
              expect(await task.verify(context(golden.answer ?? ''))).toBe(false);
            }
            const session = await openSession(mode, world);
            try {
              await replay(session, calls);
            } finally {
              await session.close();
            }
            expect(world.calls.map((c) => c.tool)).toEqual(golden.calls.map((c) => c.tool));
            expect(task.expect(world.calls)).toBe(true);
            const forbid = task.forbid;
            if (forbid !== undefined) expect(world.calls.some((c) => forbid(c))).toBe(false);
            if (task.verify !== undefined) {
              expect(await task.verify(context(golden.answer ?? ''))).toBe(true);
              if (golden.wrongAnswer !== undefined) {
                expect(await task.verify(context(golden.wrongAnswer))).toBe(false);
              }
            }
          } finally {
            await world.close();
          }
        }, 120_000);
      }
    }
  });

  describe('golden variants and wrong effects run clean against the real boxes', () => {
    for (const task of MULTI_TASKS) {
      const golden = GOLDEN[task.name] as Golden;
      const cases: [string, SideEffect[], boolean][] = [
        ...(golden.variants ?? []).map((v, i): [string, SideEffect[], boolean] => [
          `variant ${i + 1}`,
          v,
          true,
        ]),
        ...(golden.wrongEffect !== undefined
          ? [['wrong effect', golden.wrongEffect, false] as [string, SideEffect[], boolean]]
          : []),
      ];
      for (const [label, variant, verifies] of cases) {
        it(`${task.name} ${label}`, async () => {
          const world = await openMulti();
          try {
            const session = await openSession('direct', world);
            try {
              const calls = rebase(variant, world.facts.root ?? '');
              for (const call of calls) {
                const { name, input } = asToolUse('direct', call);
                // A variant may include a first attempt the world rejects
                // (create_branch from main): only the last call must be clean.
                const result = await session.runtime.call(name, input);
                if (call === calls.at(-1)) expect(result.isError, result.text).toBeUndefined();
              }
            } finally {
              await session.close();
            }
            expect(task.expect(world.calls)).toBe(true);
            if (task.verify !== undefined) {
              const finalText = golden.answer ?? '';
              expect(await task.verify({ calls: world.calls, finalText, facts: world.facts })).toBe(
                verifies,
              );
            }
          } finally {
            await world.close();
          }
        }, 120_000);
      }
    }
  });

  it(
    'runs a cross-box task end to end in all three modes with a scripted model',
    { timeout: 180_000 },
    async () => {
      const golden = GOLDEN['cross-email-to-todo'] as Golden;
      // Projection modes: a box search first (a free discovery turn), then
      // the golden calls through call_tool; direct: the host-named tools.
      const caller: ModelCaller = async (params) => {
        const tools = toolNames(params.tools);
        const mode: EvalMode = tools.includes('call_tool')
          ? tools.includes('search_tools')
            ? 'projection'
            : 'projection-boxes'
          : 'direct';
        const turns = params.messages.filter((m) => m.role === 'assistant').length;
        const root = /at (\/\S+)\.$/.exec(String(params.messages[0]?.content))?.[1] ?? '';
        if (mode !== 'direct' && turns === 0) {
          return message(
            [
              {
                type: 'tool_use',
                id: 'tu_search',
                name: 'search_mongo',
                input: { query: 'find documents' },
              },
            ],
            'tool_use',
          );
        }
        if (turns === (mode === 'direct' ? 0 : 1)) {
          return message(
            rebase(golden.calls, root).map((call, i) => ({
              type: 'tool_use',
              id: `tu_${i}`,
              ...asToolUse(mode, call),
            })),
            'tool_use',
          );
        }
        return message([{ type: 'text', text: 'Added grace@example.com.' }], 'end_turn');
      };
      const records = await runToolChoiceEval({
        models: [preset],
        modes: resolveModes(undefined),
        tasks: resolveTasks('cross-email-to-todo', ['multi']),
        runs: 1,
        caller,
      });
      expect(records.map((r) => r.mode)).toEqual(['direct', 'projection', 'projection-boxes']);
      for (const record of records) {
        expect(record.harnessError, record.mode).toBeUndefined();
        expect(record.world).toBe('multi');
        expect(record.success, record.mode).toBe(true);
        expect(record.upstreamCalls.map((c) => c.tool)).toEqual(['mongo.find', 'fs.edit_file']);
        expect(record.boxes).toEqual({
          needed: ['mongo', 'fs'],
          usedGlobalSearch: false,
          firstCallRightBox: true,
          wrongBoxCalls: 0,
        });
        expect(record.transcript?.system.startsWith(MULTI_DIRECT_SYSTEM_PROMPT)).toBe(true);
        expect(record.servedModel).toBe('scripted');
      }
      const [direct, projection, boxes] = records;
      expect(direct?.projection).toBeUndefined();
      expect(direct?.budgetTurns).toBe(direct?.apiTurns);
      for (const record of [projection, boxes]) {
        expect(record?.projection).toMatchObject({
          route: 'call_tool',
          searchTools: 0,
          searchBoxes: { fs: 0, github: 0, mongo: 1 },
          approvals: 1,
        });
        // The search turn was free.
        expect(record?.budgetTurns).toBe((record?.apiTurns ?? 0) - 1);
      }

      const summary = summarizeToolChoice(records);
      expect(summary.tiers.map((t) => [t.tier, t.mode])).toEqual([
        ['multi', 'direct'],
        ['multi', 'projection'],
        ['multi', 'projection-boxes'],
      ]);
      const report = formatToolChoiceReport(records);
      expect(report).toContain('multi task (successes/scored)');
      expect(report).toMatch(
        /scripted\/projection: call_tool 1, .*search_tools 0\.0, search_fs 0\.0, search_github 0\.0, search_mongo 1\.0,/,
      );
      expect(report).toMatch(/scripted\/projection-boxes: call_tool 1, /);
    },
  );

  it("describe_tool on the multi facade shows the real servers' output schemas; the GitHub fake declares none", async () => {
    const world = await openMulti();
    try {
      const session = await openSession('projection', world);
      try {
        for (const name of ['fs.read_text_file', 'mongo.count']) {
          const described = await session.runtime.call('describe_tool', { name });
          expect(described.isError, name).toBeUndefined();
          expect(described.text, name).toContain('Output schema (JSON Schema):');
        }
        const github = await session.runtime.call('describe_tool', { name: 'github.get_me' });
        expect(github.isError).toBeUndefined();
        expect(github.text).toContain('Output schema: none declared');
      } finally {
        await session.close();
      }
    } finally {
      await world.close();
    }
  }, 120_000);

  it(
    'passes boxDescriptions from runToolChoiceEval through to wrapMcpServers',
    { timeout: 120_000 },
    async () => {
      const caller: ModelCaller = async () =>
        message([{ type: 'text', text: 'Done.' }], 'end_turn');
      for (const boxDescriptions of [true, false]) {
        const records = await runToolChoiceEval({
          models: [preset],
          modes: ['projection', 'projection-boxes'],
          tasks: resolveTasks('box-src-github'),
          runs: 1,
          caller,
          boxDescriptions,
        });
        expect(records.map((r) => r.mode)).toEqual(['projection', 'projection-boxes']);
        for (const record of records) {
          const system = record.transcript?.system ?? '';
          expect(system.startsWith(MULTI_DIRECT_SYSTEM_PROMPT)).toBe(true);
          for (const description of Object.values(MULTI_BOX_DESCRIPTIONS)) {
            expect(system.includes(description), `${record.mode} ${description}`).toBe(
              boxDescriptions,
            );
          }
        }
      }
    },
  );

  it('runs projection-boxes on the multi tier only', { timeout: 120_000 }, async () => {
    const caller: ModelCaller = async () => message([{ type: 'text', text: 'Done.' }], 'end_turn');
    const records = await runToolChoiceEval({
      models: [preset],
      modes: ['projection-boxes'],
      tasks: resolveTasks('who-am-i,box-src-github'),
      runs: 1,
      caller,
    });
    expect(records.map((r) => [r.task, r.mode])).toEqual([['box-src-github', 'projection-boxes']]);
  });
});
