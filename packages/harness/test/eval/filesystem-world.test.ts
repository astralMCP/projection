/**
 * The filesystem world end to end, offline: the real reference server is
 * spawned on a fresh fixture tree behind the recording proxy, and a scripted
 * model drives both modes through the runner — the effect lands on disk, the
 * proxy records the call, Projection's approve-all client fulfils the
 * destructive-write prompt, and `verify` reads the end state before the
 * world is torn down. A scripted wrong move trips `forbid`.
 */

import { existsSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  openWorld,
  resolveModes,
  resolveTasks,
  runToolChoiceEval,
  type ModelCaller,
  type ModelPreset,
} from '../../src/index.js';

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
  const match = /(\/[^\s,]*projection-eval-fs-[^\s,/]+)/.exec(prompt);
  if (match?.[1] === undefined) throw new Error(`no root in prompt: ${prompt}`);
  return match[1];
}

/** One upstream call per task, through call_tool when Projection is on offer, then an answer. */
function scripted(
  plan: (root: string, prompt: string) => { name: string; args: Record<string, unknown> },
  answer: string,
): ModelCaller {
  return async (params) => {
    const last = params.messages.at(-1);
    if (last === undefined) throw new Error('no messages');
    if (Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')) {
      return message([{ type: 'text', text: answer }], 'end_turn');
    }
    const prompt = typeof last.content === 'string' ? last.content : '';
    const upstream = plan(rootIn(prompt), prompt);
    const viaProjection = (params.tools ?? []).some((t) => t.name === 'call_tool');
    return message(
      [
        {
          type: 'tool_use',
          id: 'tu_1',
          ...(viaProjection
            ? { name: 'call_tool', input: { name: upstream.name, args: upstream.args } }
            : { name: upstream.name, input: upstream.args }),
        },
      ],
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

  it('runs a rename in both modes: the file moves, the call is recorded, Projection asks once', async () => {
    const records = await runToolChoiceEval({
      models: [preset],
      modes: resolveModes(undefined),
      tasks: resolveTasks('fs-rename-todo'),
      runs: 1,
      caller: scripted(
        (root) => ({
          name: 'move_file',
          args: { source: `${root}/notes/todo.txt`, destination: `${root}/notes/tasks.txt` },
        }),
        'Renamed.',
      ),
    });
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.harnessError).toBeUndefined();
      expect(record.world).toBe('filesystem');
      expect(record.success).toBe(true);
      expect(record.toolCorrect).toBe(true);
      expect(record.upstreamCalls.map((c) => c.tool)).toEqual(['move_file']);
    }
    expect(records.find((r) => r.mode === 'projection')?.projection).toMatchObject({
      route: 'call_tool',
      approvals: 1,
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
          (root) => ({
            name: 'edit_file',
            args: {
              path: `${root}/package.json`,
              edits: [{ oldText: '"private": true', newText: '"private": false' }],
            },
          }),
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
    expect(wrongEdit[0]?.upstreamCalls[0]?.tool).toBe('edit_file');
    expect(forbiddenWrite[0]).toMatchObject({ success: false, forbidden: true });
    expect(forbiddenWrite[0]?.projection?.approvals).toBe(1);
  }, 60_000);
});
