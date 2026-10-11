/**
 * The MongoDB world end to end, offline from the API but with a real
 * `mongod` and the real MongoDB MCP server: the proxy mirrors the server's
 * tools, a scripted model drives both modes through the runner (the drop
 * lands in the database, Projection asks once), and every task's golden
 * runs clean against the server with `verify` flipping from false to true.
 *
 * Skipped when the vendored server is not installed (`pnpm run
 * setup:mongodb`); the `mongod` binary is downloaded on first use.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  mongodbServerEntry,
  mongodbServerInstalled,
  openDirectSession,
  openProjectionSession,
  openWorld,
  resolveModes,
  resolveTasks,
  runToolChoiceEval,
  withMongodb,
  FIXTURE_PRODUCTS,
  MONGODB_EXPECTED_TOOLS,
  MONGODB_QUERY_CAP,
  MONGODB_TASKS,
  type ModelCaller,
  type ModelPreset,
} from '../../src/index.js';
import { GOLDEN, type Golden } from './mongodb-goldens.js';

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

/** The golden calls in one assistant turn (through call_tool under Projection), then the answer. */
/**
 * Names of the tools offered to the model. The harness only ever passes
 * named `Anthropic.Tool`s; the SDK's toolset members (no `name`) are
 * narrowed away so the union type-checks.
 */
function toolNames(tools: Anthropic.ToolUnion[] | undefined): string[] {
  return (tools ?? []).flatMap((t) => ('name' in t ? [t.name] : []));
}

function scripted(golden: Golden): ModelCaller {
  return async (params) => {
    const last = params.messages.at(-1);
    if (last === undefined) throw new Error('no messages');
    if (Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')) {
      return message([{ type: 'text', text: golden.answer ?? 'Done.' }], 'end_turn');
    }
    const viaProjection = toolNames(params.tools).includes('call_tool');
    return message(
      golden.calls.map((call, i) => ({
        type: 'tool_use',
        id: `tu_${i}`,
        ...(viaProjection
          ? { name: 'call_tool', input: { name: call.tool, args: call.args } }
          : { name: call.tool, input: call.args }),
      })),
      'tool_use',
    );
  };
}

const preset: ModelPreset = { name: 'scripted', model: 'scripted-model', params: {} };
const installed = mongodbServerInstalled();

describe.skipIf(!installed)('mongodb world', () => {
  it('spawns the real server behind a recording proxy with exactly its 21 local tools', async () => {
    const world = await openWorld('mongodb');
    try {
      expect(world.name).toBe('mongodb');
      const names = world.tools.map((t) => t.name);
      expect(MONGODB_EXPECTED_TOOLS).toHaveLength(21);
      expect(names.toSorted()).toEqual(MONGODB_EXPECTED_TOOLS);
      for (const disabled of ['connect', 'export', 'search-knowledge', 'mongodb-logs']) {
        expect(names).not.toContain(disabled);
      }
      const byName = new Map(world.tools.map((t) => [t.name, t]));
      expect(byName.get('find')?.annotations?.readOnlyHint).toBe(true);
      expect(byName.get('drop-collection')?.annotations?.destructiveHint).toBe(true);
      expect(JSON.stringify(byName.get('find')?.inputSchema)).toContain('preconfigured');
      expect(world.facts.mongoUri).toMatch(/^mongodb:\/\/127\.0\.0\.1:\d+/);
      expect(
        await withMongodb(world.facts, (c) => c.db('shop').collection('orders').countDocuments({})),
      ).toBe(12);
      // More products than one query returns, and the decoy database.
      expect(FIXTURE_PRODUCTS.length).toBeGreaterThan(MONGODB_QUERY_CAP);
      expect(
        await withMongodb(world.facts, (c) =>
          c.db('shop').collection('products').countDocuments({}),
        ),
      ).toBe(FIXTURE_PRODUCTS.length);
      expect(
        await withMongodb(world.facts, async (c) =>
          (await c.db('reports').listCollections().toArray()).map((col) => col.name),
        ),
      ).toEqual(['daily_summary']);
    } finally {
      await world.close();
    }
  }, 120_000);

  it('spawns the server with a minimal environment: an inherited MDB_MCP_READ_ONLY does not shrink the tool set', async () => {
    process.env['MDB_MCP_READ_ONLY'] = 'true';
    try {
      const world = await openWorld('mongodb');
      try {
        expect(world.tools.map((t) => t.name).toSorted()).toEqual(MONGODB_EXPECTED_TOOLS);
      } finally {
        await world.close();
      }
    } finally {
      delete process.env['MDB_MCP_READ_ONLY'];
    }
  }, 120_000);

  it('forwards structuredContent: direct mode sees the content blocks, Projection renders the structured result', async () => {
    const world = await openWorld('mongodb');
    const find = {
      tool: 'find',
      args: {
        connectionId: 'preconfigured',
        database: 'shop',
        collection: 'products',
        filter: {},
        sort: { price: -1 },
        limit: 3,
      },
    };
    try {
      const direct = await openDirectSession(world);
      try {
        const result = await direct.runtime.call(find.tool, find.args);
        expect(result.isError).toBeUndefined();
        // The server's own text blocks, joined: the summary line and the
        // untrusted-data section holding the documents array.
        expect(result.text).toMatch(/resulted in 120 documents\. Returning 3 documents/);
        expect(result.text).toContain('<untrusted-user-data-');
        expect(result.text).toContain('"name":"Gadget Max"');
        expect(result.text).not.toContain('"documents"');
      } finally {
        await direct.close();
      }
      const projection = await openProjectionSession(world);
      try {
        const result = await projection.runtime.call('call_tool', {
          name: find.tool,
          args: find.args,
        });
        expect(result.isError).toBeUndefined();
        expect(result.text).toMatch(/^call_tool "find": ok\n/);
        // The structured value, pretty-printed — not a JSON-escaped copy of
        // the content array.
        expect(result.text).toContain('"documents": [');
        expect(result.text).toContain('"queryResultsCount": 120');
        expect(result.text).toContain('"name": "Gadget Max"');
        expect(result.text).not.toMatch(/"type":\s*"text"/);
        expect(result.text).not.toContain('untrusted-user-data');
      } finally {
        await projection.close();
      }
      expect(world.calls.map((c) => c.tool)).toEqual(['find', 'find']);
    } finally {
      await world.close();
    }
  }, 120_000);

  it('runs the drop in both modes: the collection goes, the call is recorded, Projection asks once', async () => {
    const records = await runToolChoiceEval({
      models: [preset],
      modes: resolveModes(undefined),
      tasks: resolveTasks('db-drop-tmp'),
      runs: 1,
      caller: scripted(GOLDEN['db-drop-tmp'] as Golden),
    });
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.harnessError).toBeUndefined();
      expect(record.world).toBe('mongodb');
      expect(record.success).toBe(true);
      expect(record.upstreamCalls.map((c) => c.tool)).toEqual(['drop-collection']);
    }
    expect(records.find((r) => r.mode === 'projection')?.projection).toMatchObject({
      route: 'call_tool',
      approvals: 1,
    });
  }, 120_000);

  it('a forbidden insert fails the conditional task even though the lookup happened', async () => {
    const golden = GOLDEN['db-add-customer-unless-exists'] as Golden;
    const [record] = await runToolChoiceEval({
      models: [preset],
      modes: ['direct'],
      tasks: resolveTasks('db-add-customer-unless-exists'),
      runs: 1,
      caller: scripted({ calls: golden.wrong ?? [], answer: 'Added Alice.' }),
    });
    expect(record).toMatchObject({ success: false, forbidden: true, toolCorrect: true });
  }, 120_000);

  describe('golden fidelity: every golden runs clean against the real server and scores', () => {
    for (const task of MONGODB_TASKS) {
      const golden = GOLDEN[task.name] as Golden;
      it(
        task.name,
        async () => {
          const world = await openWorld('mongodb');
          try {
            const context = (finalText: string) => ({
              calls: world.calls,
              finalText,
              facts: world.facts,
            });
            if (golden.mutates === true && task.verify !== undefined) {
              expect(await task.verify(context(golden.answer ?? ''))).toBe(false);
            }
            const session = await openDirectSession(world);
            try {
              for (const call of golden.calls) {
                const result = await session.runtime.call(call.tool, call.args);
                expect(result.isError, `${call.tool}: ${result.text}`).toBeUndefined();
              }
            } finally {
              await session.close();
            }
            expect(world.calls.map((c) => c.tool)).toEqual(golden.calls.map((c) => c.tool));
            expect(task.expect(world.calls)).toBe(true);
            const forbid = task.forbid;
            if (forbid !== undefined) expect(world.calls.some((c) => forbid(c))).toBe(false);
            if (task.verify !== undefined) {
              for (const answer of [golden.answer ?? '', ...(golden.answers ?? [])]) {
                expect(await task.verify(context(answer)), answer).toBe(true);
              }
              for (const wrong of [
                ...(golden.wrongAnswer !== undefined ? [golden.wrongAnswer] : []),
                ...(golden.wrongAnswers ?? []),
              ]) {
                expect(await task.verify(context(wrong)), wrong).toBe(false);
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
});

describe('mongodb server lookup', () => {
  it('points at the setup script when no vendor install is found above the start directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'projection-no-vendor-'));
    try {
      expect(() => mongodbServerEntry(dir)).toThrow(/pnpm run setup:mongodb/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
