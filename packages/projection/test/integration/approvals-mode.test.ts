/**
 * Approvals mode (PRD R49, DECISIONS D17) end to end: a REAL McpServer
 * wrapped with `approvals: 'destructive-only'`, driven through `call_tool`,
 * `execute_machine`, `search_tools`, `describe_tool`, the `.d.ts` and the
 * `discover_apis` overview — every surface must show and enforce the one
 * resolved decision.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ProjectionError,
  wrapMcpServer,
  type ApprovalsMode,
  type ProjectionFacade,
  type WrapOptions,
} from '../../src/index.js';
import type { ToolCallResult } from '../../src/mrtr/index.js';
import {
  ACCEPT,
  completed,
  elicitation,
  isSuspended,
  requestKeys,
  sealedState,
  structured,
} from '../mrtr/helpers.js';

const KEY = new Uint8Array(32).fill(49);

let files: Record<string, string>;
let facade: ProjectionFacade | undefined;

function buildWrappedServer(): McpServer {
  const server = new McpServer({ name: 'approvals-files', version: '1.0.0' });
  server.registerTool(
    'read_file',
    {
      description: 'Read a file from disk.',
      inputSchema: z.object({ path: z.string() }),
      annotations: { readOnlyHint: true },
    },
    ({ path }) => ({ content: [{ type: 'text' as const, text: files[path] ?? '' }] }),
  );
  server.registerTool(
    'touch_file',
    {
      description: 'Append a marker to a file.',
      inputSchema: z.object({ path: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ path }) => {
      files[path] = `${files[path] ?? ''}+touched`;
      return { content: [{ type: 'text' as const, text: 'touched' }] };
    },
  );
  server.registerTool(
    'tag_file',
    {
      description: 'Tag a file.',
      inputSchema: z.object({ path: z.string() }),
      annotations: { destructiveHint: false },
    },
    ({ path }) => {
      files[path] = `${files[path] ?? ''}+tagged`;
      return { content: [{ type: 'text' as const, text: 'tagged' }] };
    },
  );
  server.registerTool(
    'write_file',
    {
      description: 'Write content to a file.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
    },
    ({ path, content }) => {
      files[path] = content;
      return { content: [{ type: 'text' as const, text: 'wrote' }] };
    },
  );
  server.registerTool(
    'delete_file',
    {
      description: 'Delete a file permanently.',
      inputSchema: z.object({ path: z.string() }),
      annotations: { destructiveHint: true },
    },
    ({ path }) => {
      delete files[path];
      return { content: [{ type: 'text' as const, text: 'deleted' }] };
    },
  );
  return server;
}

async function wrap(options: Partial<WrapOptions> = {}): Promise<ProjectionFacade> {
  facade = await wrapMcpServer(buildWrappedServer(), { blob: { key: KEY }, ...options });
  return facade;
}

function postures(f: ProjectionFacade): Record<string, unknown> {
  const tools = structured(f.searchTools({}))['tools'] as { name: string; posture: string }[];
  return Object.fromEntries(tools.map((t) => [t.name, t.posture]));
}

function overviewLine(f: ProjectionFacade, tool: string): string {
  const text = completed(f.discoverApis())
    .content.map((c) => ('text' in c ? c.text : ''))
    .join('');
  const line = text.split('\n').find((l) => l.startsWith(`- ${tool} `));
  if (line === undefined) throw new Error(`no overview line for ${tool}`);
  return line;
}

/** Everything a model or approver can read off a facade before any call. */
function surfaces(f: ProjectionFacade): Record<string, unknown> {
  return {
    dts: f.dts,
    instructions: f.instructions,
    resources: f.resources,
    overview: completed(f.discoverApis()),
    search: completed(f.searchTools({})),
    describe: completed(f.describeTool({ name: 'touch_file', types: true })),
  };
}

function machine(tool: string, args: string, id: string): string {
  return `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'one',
  context: { status: 'pending' },
  initial: 'calling',
  states: {
    calling: {
      entry: toolCall('${tool}', () => (${args}), { id: '${id}' }),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: ({ event }) => event.result }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'denied' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status }),
});
`;
}

function machineOutput(result: ToolCallResult): unknown {
  const done = completed(result);
  if (done.isError === true) {
    throw new Error(`unexpected error result: ${JSON.stringify(done.structuredContent)}`);
  }
  return structured(result)['output'];
}

beforeEach(() => {
  files = { '/a.txt': 'a' };
});

afterEach(async () => {
  await facade?.close();
  facade = undefined;
});

describe("approvals: 'destructive-only' through call_tool (R49, R35)", () => {
  it.each([
    ['touch_file', 'a+touched'],
    ['tag_file', 'a+tagged'],
  ])('runs %s (destructiveHint: false) with no elicitation', async (tool, after) => {
    const f = await wrap({ approvals: 'destructive-only' });
    const result = await f.callTool({ name: tool, args: { path: '/a.txt' } }, 'modern');
    expect(isSuspended(result)).toBe(false);
    expect(structured(result)['status']).toBe('ok');
    expect(files['/a.txt']).toBe(after);
  });

  it('still asks for an unannotated write and a destructiveHint: true one', async () => {
    const f = await wrap({ approvals: 'destructive-only' });
    const write = await f.callTool(
      { name: 'write_file', args: { path: '/a.txt', content: 'x' } },
      'modern',
    );
    expect(requestKeys(write)).toEqual(['call']);
    const del = await f.callTool({ name: 'delete_file', args: { path: '/a.txt' } }, 'modern');
    expect(requestKeys(del)).toEqual(['call']);
    expect(elicitation(del, 'call').message).toContain('⚠');
    expect(files['/a.txt']).toBe('a');
  });

  it('a per-tool ask or deny beats the mode; a per-tool auto still runs', async () => {
    const f = await wrap({
      approvals: 'destructive-only',
      policy: { touch_file: 'ask', tag_file: 'deny', write_file: 'auto' },
    });
    const touch = await f.callTool({ name: 'touch_file', args: { path: '/a.txt' } }, 'modern');
    expect(requestKeys(touch)).toEqual(['call']);
    const tag = await f.callTool({ name: 'tag_file', args: { path: '/a.txt' } }, 'modern');
    expect(structured(tag)['status']).toBe('denied_by_policy');
    const write = await f.callTool(
      { name: 'write_file', args: { path: '/a.txt', content: 'w' } },
      'modern',
    );
    expect(structured(write)['status']).toBe('ok');
    expect(files['/a.txt']).toBe('w');
  });

  it.each([undefined, 'every-write'] as const)(
    'approvals %s asks for a destructiveHint: false write, as before R49',
    async (approvals) => {
      const f = await wrap(approvals === undefined ? {} : { approvals });
      const result = await f.callTool({ name: 'touch_file', args: { path: '/a.txt' } }, 'modern');
      expect(requestKeys(result)).toEqual(['call']);
      expect(files['/a.txt']).toBe('a');
    },
  );
});

describe('every surface shows the resolved decision (R49, R33)', () => {
  it('search_tools, describe_tool, the .d.ts and the overview agree under destructive-only', async () => {
    const f = await wrap({ approvals: 'destructive-only', policy: { tag_file: 'ask' } });
    expect(postures(f)).toEqual({
      read_file: 'runs immediately',
      touch_file: 'runs immediately',
      tag_file: 'asks for approval',
      write_file: 'asks for approval',
      delete_file: 'asks for approval',
    });
    const touch = structured(f.describeTool({ name: 'touch_file', types: true }));
    expect(touch['posture']).toBe('runs immediately');
    expect(touch['destructive']).toBe(false);
    expect(String(touch['types'])).toContain('Runs immediately: no user approval required.');
    expect(structured(f.describeTool({ name: 'write_file' }))['posture']).toBe('asks for approval');
    expect(overviewLine(f, 'touch_file')).toContain('[runs immediately]');
    expect(overviewLine(f, 'tag_file')).toContain('[asks for approval]');
    expect(overviewLine(f, 'delete_file')).toContain('[asks for approval, destructive]');
    const touchDoc = f.dts.slice(f.dts.indexOf('Append a marker to a file.'));
    expect(touchDoc.slice(0, 200)).toContain('Runs immediately:');
  });

  it("'every-write' and the default produce byte-identical surfaces", async () => {
    const base = surfaces(await wrap());
    await facade?.close();
    const explicit = surfaces(await wrap({ approvals: 'every-write' }));
    expect(explicit).toEqual(base);
    expect(postures(facade as ProjectionFacade)['touch_file']).toBe('asks for approval');
  });
});

describe("approvals: 'destructive-only' through execute_machine (R49, R14)", () => {
  it('runs a destructiveHint: false call without suspending', async () => {
    const f = await wrap({ approvals: 'destructive-only' });
    const result = await f.executeMachine(
      { code: machine('touch_file', "{ path: '/a.txt' }", 't1') },
      'modern',
    );
    expect(machineOutput(result)).toEqual({ status: 'touched' });
    expect(files['/a.txt']).toBe('a+touched');
  });

  it.each([
    ['write_file', "{ path: '/a.txt', content: 'm' }", 'w1', 'wrote', 'm'],
    ['delete_file', "{ path: '/a.txt' }", 'd1', 'deleted', undefined],
  ])('suspends %s, and the approved resume runs it', async (tool, args, id, status, after) => {
    const f = await wrap({ approvals: 'destructive-only' });
    const code = machine(tool, args, id);
    const first = await f.executeMachine({ code }, 'modern');
    expect(requestKeys(first)).toEqual([id]);
    expect(files['/a.txt']).toBe('a');
    const retry = await f.executeMachine(
      { code, requestState: sealedState(first), inputResponses: { [id]: ACCEPT } },
      'modern',
    );
    expect(machineOutput(retry)).toEqual({ status });
    expect(files['/a.txt']).toBe(after);
  });

  it('a per-tool deny beats the mode on the machine path', async () => {
    const f = await wrap({ approvals: 'destructive-only', policy: { touch_file: 'deny' } });
    const result = await f.executeMachine(
      { code: machine('touch_file', "{ path: '/a.txt' }", 't1') },
      'modern',
    );
    expect(machineOutput(result)).toEqual({ status: 'denied' });
    expect(files['/a.txt']).toBe('a');
  });

  it('the default mode suspends the destructiveHint: false call', async () => {
    const f = await wrap();
    const result = await f.executeMachine(
      { code: machine('touch_file', "{ path: '/a.txt' }", 't1') },
      'modern',
    );
    expect(requestKeys(result)).toEqual(['t1']);
    expect(files['/a.txt']).toBe('a');
  });
});

describe('a malformed approvals value fails the wrap (R49)', () => {
  it.each([
    'destructive_only',
    'Every-Write',
    'none',
    '',
    null,
    true,
    0,
    { mode: 'destructive-only' },
  ])('%j is a validate-phase ProjectionError, raised before connecting', async (value) => {
    const server = buildWrappedServer();
    try {
      await wrapMcpServer(server, {
        blob: { key: KEY },
        approvals: value as unknown as ApprovalsMode,
      });
      expect.unreachable('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectionError);
      expect(err).toMatchObject({ phase: 'validate' });
    }
    expect(server.isConnected()).toBe(false);
  });
});
