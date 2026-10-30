/**
 * The filesystem world end to end, offline: the real reference server is
 * spawned on a fresh fixture tree behind the recording proxy, and a scripted
 * model drives both modes through the runner — the effect lands on disk, the
 * proxy records the call, Projection's approve-all client fulfils the
 * destructive-write prompt, and `verify` reads the end state before the
 * world is torn down. A scripted wrong move trips `forbid`. Finally every
 * task's golden call sequence is replayed against a real world: the server
 * accepts each call and the task scores the result, so a golden can never
 * be an argument shape the server would reject.
 */

import { existsSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import {
  FILESYSTEM_TASKS,
  openDirectSession,
  openProjectionSession,
  openWorld,
  resolveModes,
  resolveTasks,
  runToolChoiceEval,
  toolResultText,
  type ModelCaller,
  type ModelPreset,
} from '../../src/index.js';
import { GOLDEN, rebase, type Golden } from './filesystem-goldens.js';
import { toolNames } from './tool-names.js';

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

/** The root the prompt names (the one absolute path in it). */
function rootIn(prompt: string): string {
  const match = /(\/[^\s,]*\/widgets-[^\s,/]+)/.exec(prompt);
  if (match?.[1] === undefined) throw new Error(`no root in prompt: ${prompt}`);
  return match[1];
}

type Upstream = { name: string; args: Record<string, unknown> };

/**
 * The planned upstream calls as tool_use blocks in one assistant turn —
 * through call_tool when Projection is on offer — then an answer once the
 * results come back.
 */
function scripted(
  plan: (root: string, prompt: string) => Upstream | Upstream[],
  answer: string,
): ModelCaller {
  return async (params) => {
    const last = params.messages.at(-1);
    if (last === undefined) throw new Error('no messages');
    if (Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')) {
      return message([{ type: 'text', text: answer }], 'end_turn');
    }
    const prompt = typeof last.content === 'string' ? last.content : '';
    const planned = plan(rootIn(prompt), prompt);
    const upstreams = Array.isArray(planned) ? planned : [planned];
    const viaProjection = toolNames(params.tools).includes('call_tool');
    return message(
      upstreams.map((upstream, i) => ({
        type: 'tool_use',
        id: `tu_${i + 1}`,
        ...(viaProjection
          ? { name: 'call_tool', input: { name: upstream.name, args: upstream.args } }
          : { name: upstream.name, input: upstream.args }),
      })),
      'tool_use',
    );
  };
}

const preset: ModelPreset = { name: 'scripted', model: 'scripted-model', params: {} };

describe('filesystem world', () => {
  it('spawns the real server behind a recording proxy with its 14 tools and annotations', async () => {
    const world = await openWorld('filesystem');
    try {
      expect(world.name).toBe('filesystem');
      expect(world.tools.map((t) => t.name).toSorted()).toEqual([
        'create_directory',
        'directory_tree',
        'edit_file',
        'get_file_info',
        'list_allowed_directories',
        'list_directory',
        'list_directory_with_sizes',
        'move_file',
        'read_file',
        'read_media_file',
        'read_multiple_files',
        'read_text_file',
        'search_files',
        'write_file',
      ]);
      const byName = new Map(world.tools.map((t) => [t.name, t]));
      expect(byName.get('read_text_file')?.annotations?.readOnlyHint).toBe(true);
      expect(byName.get('move_file')?.annotations?.destructiveHint).toBe(true);
      expect(byName.get('create_directory')?.annotations?.destructiveHint).toBe(false);
      expect(byName.get('edit_file')?.inputSchema).toMatchObject({ type: 'object' });
      expect(world.facts.root).toBeDefined();
      expect(existsSync(`${world.facts.root}/notes/todo.txt`)).toBe(true);
      expect(world.calls).toEqual([]);
    } finally {
      await world.close();
    }
    expect(existsSync(world.facts.root ?? '')).toBe(false);
  }, 30_000);

  it('mirrors the real output schemas: served verbatim, and describe_tool through Projection shows them', async () => {
    const listed = await openWorld('filesystem');
    try {
      if ('boxes' in listed) throw new Error('expected a single-server world');
      // The reference server declares an output schema on every tool.
      expect(listed.tools.filter((t) => t.outputSchema !== undefined)).toHaveLength(14);
      const client = new Client({ name: 'proxy-listing', version: '0.0.0' }, { capabilities: {} });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await listed.server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const served = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
        for (const tool of listed.tools) {
          expect(served.get(tool.name)?.outputSchema, tool.name).toEqual(tool.outputSchema);
        }
      } finally {
        await client.close();
      }
    } finally {
      await listed.close();
    }

    const world = await openWorld('filesystem');
    try {
      const session = await openProjectionSession(world);
      try {
        const described = await session.runtime.call('describe_tool', { name: 'read_text_file' });
        expect(described.isError).toBeUndefined();
        expect(described.text).toContain('Output schema (JSON Schema):');
        expect(described.text).not.toContain('Output schema: none declared');
        // A structured result still conforms after the proxy validates it.
        const read = await session.runtime.call('call_tool', {
          name: 'read_text_file',
          args: { path: `${world.facts.root}/notes/todo.txt` },
        });
        expect(read.isError).toBeUndefined();
        expect(read.text).not.toMatch(/validation error/i);
      } finally {
        await session.close();
      }
    } finally {
      await world.close();
    }
  }, 60_000);

  it('runs a move into a new directory in both modes: the file moves, both calls are recorded, Projection asks once', async () => {
    const records = await runToolChoiceEval({
      models: [preset],
      modes: resolveModes(undefined),
      tasks: resolveTasks('fs-move-todo-into-archive'),
      runs: 1,
      caller: scripted(
        (root) => [
          { name: 'create_directory', args: { path: `${root}/notes/archive` } },
          {
            name: 'move_file',
            args: {
              source: `${root}/notes/todo.txt`,
              destination: `${root}/notes/archive/tasks.txt`,
            },
          },
        ],
        'Moved.',
      ),
    });
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.harnessError).toBeUndefined();
      expect(record.world).toBe('filesystem');
      expect(record.success).toBe(true);
      expect(record.toolCorrect).toBe(true);
      expect(record.upstreamCalls.map((c) => c.tool)).toEqual(['create_directory', 'move_file']);
    }
    // Both calls ask: create_directory is not destructive, but it is not
    // read-only either, and Projection gates every non-read-only call.
    expect(records.find((r) => r.mode === 'projection')?.projection).toMatchObject({
      route: 'call_tool',
      approvals: 2,
    });
  }, 60_000);

  it('verify fails a write that did not do what was asked, and forbid catches the wrong write', async () => {
    const [wrongEdit, forbiddenWrite] = await Promise.all([
      // Right tool, wrong edit: the version is not bumped.
      runToolChoiceEval({
        models: [preset],
        modes: ['direct'],
        tasks: resolveTasks('fs-bump-version'),
        runs: 1,
        caller: scripted(
          (root) => [
            { name: 'read_text_file', args: { path: `${root}/package.json` } },
            {
              name: 'edit_file',
              args: {
                path: `${root}/package.json`,
                edits: [{ oldText: '"private": true', newText: '"private": false' }],
              },
            },
          ],
          'Done.',
        ),
      }),
      // The conditional create: writing the existing file is forbidden.
      runToolChoiceEval({
        models: [preset],
        modes: ['projection'],
        tasks: resolveTasks('fs-create-unless-exists'),
        runs: 1,
        caller: scripted(
          (root) => ({
            name: 'write_file',
            args: { path: `${root}/notes/ideas.txt`, content: 'TBD' },
          }),
          'Created it.',
        ),
      }),
    ]);
    expect(wrongEdit[0]).toMatchObject({ success: false, toolCorrect: true, forbidden: false });
    expect(wrongEdit[0]?.upstreamCalls.map((c) => c.tool)).toEqual(['read_text_file', 'edit_file']);
    expect(forbiddenWrite[0]).toMatchObject({ success: false, forbidden: true });
    expect(forbiddenWrite[0]?.projection?.approvals).toBe(1);
  }, 60_000);

  it('renders non-text result blocks as placeholders, in order with the text', () => {
    expect(
      toolResultText({
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', data: 'abcd', mimeType: 'image/png' },
          { type: 'audio', data: 'abcdefgh', mimeType: 'audio/wav' },
          { type: 'resource', resource: { uri: 'file:///x', mimeType: 'text/plain', text: '' } },
          { type: 'mystery' },
          { type: 'text', text: 'last' },
        ],
      }),
    ).toEqual({
      text: [
        'first',
        '[image image/png, 4 bytes]',
        '[audio audio/wav, 8 bytes]',
        '[resource file:///x text/plain]',
        '[mystery block]',
        'last',
      ].join('\n'),
    });
    expect(toolResultText({ content: [], structuredContent: { a: 1 } })).toEqual({
      text: '{"a":1}',
    });
  });

  describe('golden fidelity: every golden runs clean against the real server and scores', () => {
    for (const task of FILESYSTEM_TASKS) {
      const golden = GOLDEN[task.name] as Golden;
      it(
        task.name,
        async () => {
          const world = await openWorld('filesystem');
          try {
            const session = await openDirectSession(world);
            try {
              const root = world.facts.root ?? '';
              for (const call of rebase(golden.calls, root)) {
                const result = await session.runtime.call(call.tool, call.args);
                expect(result.isError, `${call.tool}: ${result.text}`).toBeUndefined();
                if (call.tool === 'read_media_file') {
                  expect(result.text).toMatch(/^\[image image\/png, \d+ bytes\]$/);
                }
              }
            } finally {
              await session.close();
            }
            expect(world.calls.map((c) => c.tool)).toEqual(golden.calls.map((c) => c.tool));
            expect(task.expect(world.calls)).toBe(true);
            const forbid = task.forbid;
            if (forbid !== undefined) expect(world.calls.some((c) => forbid(c))).toBe(false);
            if (task.verify !== undefined) {
              expect(
                await task.verify({
                  calls: world.calls,
                  finalText: golden.answer ?? '',
                  facts: world.facts,
                }),
              ).toBe(true);
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
