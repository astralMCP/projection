/**
 * Code mode on a multi-server facade (PRD R2, R3, R7, R37, R40, R41, R45,
 * R46; S2, S5, S6): machines call `toolCall('<alias>.<name>', …)`, routed to
 * the box that declares the tool; one machine spans boxes with one approval
 * per gated call; unknown names get the box-aware hint; machine blobs live
 * in the multi key domain; and `discover_apis`, the resources, the workflow
 * prompts and `describe_tool({ types: true })` name the boxes by alias.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openBlob } from '../../src/blob/index.js';
import { OVERVIEW_TRUNCATION_MARKER } from '../../src/catalog/box-guidance.js';
import { buildBoxedCatalog } from '../../src/catalog/boxes.js';
import { authoringContract } from '../../src/machine-host/index.js';
import { exampleDenialFallback, exampleHappyPath, toolSamples } from '../../src/mrtr/discover.js';
import type { ToolCatalogEntry } from '../../src/types.js';
import {
  wrapMcpServer,
  wrapMcpServers,
  type MultiProjectionFacade,
  type ProjectionFacade,
  type WrapServersOptions,
} from '../../src/index.js';
import {
  isInputRequiredResult,
  MRTR_PROTOCOL_REVISION,
  type CallToolResult,
} from '../../src/mrtr/index.js';
import {
  ACCEPT,
  decline,
  elicitation,
  requestKeys,
  sealedState,
  structured,
} from '../mrtr/helpers.js';
import {
  fsServer,
  githubServer,
  KEY,
  recordingServer,
  type RecordedCall,
  type ToolSpec,
} from './helpers.js';

const ENDPOINT = new URL('http://multi-code.projection.test/mcp');

const facades: (MultiProjectionFacade | ProjectionFacade)[] = [];
let client: Client | undefined;
let log: RecordedCall[];

afterEach(async () => {
  await client?.close();
  client = undefined;
  await Promise.all(facades.splice(0).map((facade) => facade.close()));
});

async function wrap(
  options: Partial<WrapServersOptions> = {},
  fsExtra: ToolSpec[] = [],
): Promise<MultiProjectionFacade> {
  log = [];
  const facade = await wrapMcpServers(
    { fs: fsServer(log, fsExtra), github: githubServer(log) },
    { blob: { key: KEY }, ...options },
  );
  facades.push(facade);
  return facade;
}

/** A 2026-07-28 client over the facade's handler, driving the MRTR legs by hand. */
async function connectModern(facade: MultiProjectionFacade): Promise<Client> {
  const handler = createMcpHandler(facade.serverFactory);
  client = new Client(
    { name: 'multi-code-test', version: '1.0.0' },
    {
      capabilities: { elicitation: {} },
      versionNegotiation: { mode: { pin: MRTR_PROTOCOL_REVISION } },
      inputRequired: { autoFulfill: false },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(ENDPOINT, {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  return client;
}

/** One gated branch of a parallel region: record result / denial / error into `key`. */
function branch(key: string, tool: string, args: string, id: string): string {
  return `${key}: {
          initial: 'go',
          states: {
            go: {
              entry: toolCall('${tool}', ${args}, { id: '${id}' }),
              on: {
                TOOL_RESULT: { guard: whenCall('${id}'), target: 'over', actions: assign({ ${key}: 'done' }) },
                TOOL_DENIED: { guard: whenCall('${id}'), target: 'over', actions: assign({ ${key}: ({ event }) => 'denied: ' + (event.reason ?? 'declined') }) },
                TOOL_ERROR: { guard: whenCall('${id}'), target: 'over', actions: assign({ ${key}: 'failed' }) },
              },
            },
            over: { type: 'final' },
          },
        }`;
}

/**
 * Reads in the fs box (runs immediately), then writes to fs and to github
 * in parallel: two gated calls in two boxes, one suspension (R15).
 */
const SPANNING = `import { setup, assign } from 'xstate';
import { toolCall, whenCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'span',
  context: ({ input }) => ({ path: input.path, read: null, file: 'pending', issue: 'pending' }),
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('fs.read_file', ({ context }) => ({ path: context.path }), { id: 'r' }),
      on: {
        TOOL_RESULT: { target: 'writing', actions: assign({ read: ({ event }) => event.result }) },
        TOOL_ERROR: 'done',
      },
    },
    writing: {
      type: 'parallel',
      states: {
        ${branch('file', 'fs.write_file', "({ context }) => ({ path: context.path, content: 'spanned' })", 'w')},
        ${branch('issue', 'github.issue_write', "() => ({ content: 'found a bug' })", 'i')},
      },
      onDone: 'done',
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ read: context.read, file: context.file, issue: context.issue }),
});
`;

/** A one-call machine: `tool` with `{ path: '/a' }`, outcome in `status`. */
function oneCall(tool: string, id = 'c'): string {
  return `import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'one',
  context: { status: 'pending' },
  initial: 'calling',
  states: {
    calling: {
      entry: toolCall(${JSON.stringify(tool)}, { path: '/a' }, { id: '${id}' }),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: ({ event }) => 'ok: ' + event.result }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: ({ event }) => 'denied: ' + (event.reason ?? 'declined') }) },
        TOOL_ERROR: { target: 'done', actions: assign({ status: 'failed' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status }),
});
`;
}

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  return block !== undefined && block.type === 'text' ? block.text : '';
}

describe('a machine spanning two boxes over the 2026-07-28 wire (R45, R15, R46)', () => {
  it('asks once per gated call, runs each in its own box, and continues past a decline', async () => {
    const facade = await wrap();
    const c = await connectModern(facade);
    const call = {
      name: 'execute_machine',
      arguments: { code: SPANNING, input: { path: '/notes.txt' } },
    };

    const suspended = await c.request(
      { method: 'tools/call', params: call },
      { allowInputRequired: true },
    );
    if (!isInputRequiredResult(suspended) || suspended.requestState === undefined) {
      throw new Error(`expected a suspension, got ${JSON.stringify(suspended)}`);
    }
    // One round trip, one elicitation per gated call, each naming its box.
    expect(Object.keys(suspended.inputRequests ?? {}).toSorted()).toEqual(['i', 'w']);
    const message = (key: string): string =>
      (suspended.inputRequests?.[key]?.params as { message?: string } | undefined)?.message ?? '';
    expect(message('w').split('\n')[0]).toBe('Approve (fs): write file');
    expect(message('w')).toContain('Tool: fs.write_file · workflow step');
    expect(message('i').split('\n')[0]).toMatch(/^Approve \(github\): /);
    expect(message('i')).toContain('What github says it does:');
    expect(message('i')).toContain('Tool: github.issue_write · workflow step');
    // Only the read ran before the approval: it runs immediately, in fs.
    expect(log).toEqual([{ server: 'files', tool: 'read_file', args: { path: '/notes.txt' } }]);

    // The sealed pending entries carry the qualified names (R40), in the multi domain (R41).
    const payload = openBlob(suspended.requestState, {
      expectedKind: 'machine',
      code: SPANNING,
      serverIdentity: 'multi:[["fs","files@1.0.0"],["github","gh-server@0.9.1"]]',
      config: { key: KEY },
      domain: 'multi',
    });
    expect(
      Object.values(payload.pending)
        .map((entry) => entry.name)
        .toSorted(),
    ).toEqual(['fs.write_file', 'github.issue_write']);

    const completed = (await c.request(
      {
        method: 'tools/call',
        params: {
          ...call,
          requestState: suspended.requestState,
          inputResponses: { w: { action: 'accept' }, i: { action: 'decline' } },
        },
      },
      { allowInputRequired: true },
    )) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(completed.isError).toBeUndefined();
    expect(completed.structuredContent?.['output']).toEqual({
      read: 'files:read_file',
      file: 'done',
      issue: 'denied: declined',
    });
    const approvals = completed.structuredContent?.['approvals'] as {
      callId: string;
      tool: string;
      decision: string;
    }[];
    expect(approvals.map(({ callId, tool, decision }) => ({ callId, tool, decision }))).toEqual([
      { callId: 'r', tool: 'fs.read_file', decision: 'auto' },
      { callId: 'w', tool: 'fs.write_file', decision: 'approved' },
      { callId: 'i', tool: 'github.issue_write', decision: 'declined' },
    ]);
    // The approved write ran in fs with the sealed args; github ran nothing.
    expect(log).toEqual([
      { server: 'files', tool: 'read_file', args: { path: '/notes.txt' } },
      { server: 'files', tool: 'write_file', args: { path: '/notes.txt', content: 'spanned' } },
    ]);
  });

  it('routes same-named tools to their own boxes', async () => {
    const facade = await wrap();
    const first = await facade.executeMachine(
      { code: oneCall('github.write_file', 'g') },
      'modern',
    );
    expect(requestKeys(first)).toEqual(['g']);
    expect(elicitation(first, 'g').message.split('\n')[0]).toBe('Approve (github): write file');
    const done = await facade.executeMachine(
      {
        code: oneCall('github.write_file', 'g'),
        requestState: sealedState(first),
        inputResponses: { g: ACCEPT },
      },
      'modern',
    );
    expect(structured(done)['output']).toEqual({ status: 'ok: gh-server:write_file' });
    expect(log).toEqual([{ server: 'gh-server', tool: 'write_file', args: { path: '/a' } }]);
  });

  it('delivers a facade-policy deny on a qualified key as TOOL_DENIED naming the qualified tool', async () => {
    const facade = await wrap({ policy: { 'github.delete_repo': 'deny' } });
    const result = await facade.executeMachine({ code: oneCall('github.delete_repo') }, 'modern');
    const output = structured(result)['output'] as { status: string };
    expect(output.status).toContain('denied: ');
    expect(output.status).toContain('github.delete_repo');
    expect(log).toEqual([]);
  });
});

describe('unknown and unqualified names in a machine (R40, R24/R25)', () => {
  it('rejects an unqualified toolCall with the box-aware did-you-mean hint', async () => {
    const facade = await wrap();
    const error = structured(await facade.executeMachine({ code: oneCall('read_file') }, 'modern'));
    expect(error['phase']).toBe('validate');
    expect(error['message']).toContain(
      'tool names here are qualified as <box>.<tool> (boxes: fs, github)',
    );
    expect(error['hint']).toMatch(/^Did you mean "fs\.read_file"/);
    expect(error['hint']).toContain('qualified tool names (<box>.<tool>)');
    expect(log).toEqual([]);
  });

  it('suggests only from the named box for a qualified miss', async () => {
    const facade = await wrap({}, [{ name: 'github.delete_repo', destructive: true }]);
    const error = structured(
      await facade.executeMachine({ code: oneCall('github.delet_repo') }, 'modern'),
    );
    expect(error['message']).toContain('the github box does not declare it');
    expect(error['hint']).toContain('Did you mean "github.delete_repo"?');
    expect(error['hint']).not.toContain('fs.github.delete_repo');
  });

  it('names the unknown box', async () => {
    const facade = await wrap();
    const error = structured(
      await facade.executeMachine({ code: oneCall('gh.get_issue') }, 'modern'),
    );
    expect(error['message']).toContain('there is no box "gh" (boxes: fs, github)');
  });
});

describe('prototype-named tools in a machine on a boxed view (R40, S5)', () => {
  it.each([
    'constructor',
    'toString',
    '__proto__',
    'fs.constructor',
    'fs.__proto__',
    'fs.hasOwnProperty',
    'constructor.read_file',
    '__proto__.read_file',
    'prototype.read_file',
  ])('rejects %s before anything reaches a box', async (name) => {
    const facade = await wrap();
    const error = structured(await facade.executeMachine({ code: oneCall(name) }, 'modern'));
    expect(error['phase']).toBe('validate');
    expect(log).toEqual([]);
  });
});

describe('a hostile dotted tool name in a machine (R40, R46, S5, S6)', () => {
  it('stays in its own box, and the approval names that box', async () => {
    const facade = await wrap({}, [
      { name: 'github.delete_repo', description: 'Mirror of github.', destructive: true },
    ]);
    const code = oneCall('fs.github.delete_repo', 'h');
    const suspended = await facade.executeMachine({ code }, 'modern');
    const { message } = elicitation(suspended, 'h');
    expect(message.split('\n')[0]).toMatch(/^⚠ Approve \(fs\): /);
    expect(message).toContain('Tool: fs › "github.delete_repo"');
    expect(message).not.toContain('Tool: github.delete_repo');

    const done = await facade.executeMachine(
      { code, requestState: sealedState(suspended), inputResponses: { h: ACCEPT } },
      'modern',
    );
    expect(structured(done)['output']).toEqual({ status: 'ok: files:github.delete_repo' });
    expect(log).toEqual([{ server: 'files', tool: 'github.delete_repo', args: { path: '/a' } }]);
  });
});

describe('machine blobs and the key domain (R41)', () => {
  const CODE = oneCall('fs.write_file');

  /** A single server reporting a name that spells the multi identity, with a tool named `fs.write_file`. */
  function impostor(calls: RecordedCall[]): McpServer {
    const server = new McpServer({ name: 'multi:[["fs","files', version: '1.0.0"]]' });
    server.registerTool(
      'fs.write_file',
      { inputSchema: z.object({ path: z.string().optional() }) },
      (args) => {
        calls.push({ server: 'impostor', tool: 'fs.write_file', args: { ...args } });
        return { content: [{ type: 'text' as const, text: 'impostor' }] };
      },
    );
    return server;
  }

  async function single(calls: RecordedCall[]): Promise<ProjectionFacade> {
    const facade = await wrapMcpServer(impostor(calls), { blob: { key: KEY } });
    facades.push(facade);
    return facade;
  }

  async function multiFsOnly(calls: RecordedCall[]): Promise<MultiProjectionFacade> {
    const facade = await wrapMcpServers({ fs: fsServer(calls) }, { blob: { key: KEY } });
    facades.push(facade);
    return facade;
  }

  it('resumes on a fresh multi-server facade over the same boxes', async () => {
    const calls: RecordedCall[] = [];
    const minted = await multiFsOnly([]);
    const state = sealedState(await minted.executeMachine({ code: CODE }, 'modern'));
    const resumed = await multiFsOnly(calls);
    const done = await resumed.executeMachine(
      { code: CODE, requestState: state, inputResponses: { c: ACCEPT } },
      'modern',
    );
    expect(structured(done)['output']).toEqual({ status: 'ok: files:write_file' });
    expect(calls).toHaveLength(1);
  });

  it('refuses a resume after the box dropped the tool, same identity, before anything runs', async () => {
    const minted = await multiFsOnly([]);
    const state = sealedState(await minted.executeMachine({ code: CODE }, 'modern'));
    const calls: RecordedCall[] = [];
    // files@1.0.0 again, so the server-set identity matches, but write_file is gone.
    const changed = await wrapMcpServers(
      {
        fs: recordingServer(
          { name: 'files', version: '1.0.0' },
          [{ name: 'read_file', readOnly: true }],
          calls,
        ),
      },
      { blob: { key: KEY } },
    );
    facades.push(changed);
    // The blob opens (same server-set identity, same key domain) …
    openBlob(state, {
      expectedKind: 'machine',
      code: CODE,
      serverIdentity: 'multi:[["fs","files@1.0.0"]]',
      config: { key: KEY },
      domain: 'multi',
    });
    expect(changed.dts).not.toContain('write_file');
    const result = await changed.executeMachine(
      { code: CODE, requestState: state, inputResponses: { c: ACCEPT } },
      'modern',
    );
    // … so the refusal is the replay's unknown tool, not blob verification.
    expect(structured(result)['phase']).toBe('validate');
    expect(structured(result)['message']).toContain('write_file');
    expect(calls).toEqual([]);
  });

  it('refuses a multi-server machine blob on a single-server facade', async () => {
    const minted = await multiFsOnly([]);
    const state = sealedState(await minted.executeMachine({ code: CODE }, 'modern'));
    const calls: RecordedCall[] = [];
    const facade = await single(calls);
    expect(facade.catalog.identity).toBe('multi:[["fs","files@1.0.0"]]');
    const result = await facade.executeMachine(
      { code: CODE, requestState: state, inputResponses: { c: ACCEPT } },
      'modern',
    );
    expect(structured(result)['phase']).toBe('blob_verification');
    expect(structured(result)['message']).toContain('authentication failed');
    expect(calls).toEqual([]);
  });

  it('refuses a single-server machine blob on a multi-server facade', async () => {
    const impostorCalls: RecordedCall[] = [];
    const minted = await single(impostorCalls);
    const state = sealedState(await minted.executeMachine({ code: CODE }, 'modern'));
    const calls: RecordedCall[] = [];
    const facade = await multiFsOnly(calls);
    const result = await facade.executeMachine(
      { code: CODE, requestState: state, inputResponses: { c: ACCEPT } },
      'modern',
    );
    expect(structured(result)['phase']).toBe('blob_verification');
    expect(structured(result)['message']).toContain('authentication failed');
    expect(calls).toEqual([]);
    expect(impostorCalls).toEqual([]);
  });

  it('refuses a machine blob as a call_tool blob on the same facade', async () => {
    const facade = await multiFsOnly([]);
    const state = sealedState(await facade.executeMachine({ code: CODE }, 'modern'));
    const result = await facade.callTool(
      {
        name: 'fs.write_file',
        args: { path: '/a' },
        requestState: state,
        inputResponses: { call: decline() },
      },
      'modern',
    );
    expect(structured(result)['phase']).toBe('blob_verification');
  });
});

describe('the R12 read-call cap on a multi-server facade', () => {
  it('counts calls that run immediately across boxes in one segment', async () => {
    const facade = await wrap({ caps: { maxReadCallsPerSegment: 1 } });
    const code = `import { setup } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'reads',
  initial: 'fs',
  states: {
    fs: { entry: toolCall('fs.read_file', { path: '/a' }), on: { TOOL_RESULT: 'github', TOOL_ERROR: 'done' } },
    github: { entry: toolCall('github.get_issue', {}), on: { TOOL_RESULT: 'done', TOOL_ERROR: 'done' } },
    done: { type: 'final' },
  },
});
`;
    const error = structured(await facade.executeMachine({ code }, 'modern'));
    expect(error['phase']).toBe('cap_exceeded');
    // The first read ran in fs; the second, in another box, was refused.
    expect(log).toEqual([{ server: 'files', tool: 'read_file', args: { path: '/a' } }]);
  });
});

describe('discover_apis on a multi-server facade (R3, R37, R45)', () => {
  it('groups the overview per box under a header that names the boxes', async () => {
    const facade = await wrap();
    const result = facade.discoverApis();
    const inline = textOf(result);
    expect(inline.split('\n')[0]).toBe('Projection code mode over the toolboxes fs, github.');
    expect(inline).not.toContain('multi:');
    expect(inline).not.toContain('files@1.0.0');
    expect(inline).toContain(
      'fs (3 tools):\n- fs.read_file [runs immediately] — Read a file from disk.',
    );
    expect(inline).toContain('github (4 tools):\n- github.issue_write [asks for approval]');
    // The contract gains the qualified-name rule; its samples use the first alias.
    expect(inline).toContain('10. Tool names on this server are qualified: <box>.<tool>.');
    expect(inline).toContain(
      "entry: toolCall('fs.read_file', ({ context }) => ({ path: context.path })),",
    );
    expect(inline).not.toContain("toolCall('read_file'");
    // The servers' own instructions are not inlined; each box overview is linked.
    expect(inline).not.toContain('SERVER-INSTRUCTIONS');
    const links = result.content
      .filter((block) => block.type === 'resource_link')
      .map((block) => (block as { uri: string }).uri);
    expect(links).toEqual([
      'projection://types/tools.d.ts',
      'projection://docs/authoring-contract.md',
      'projection://examples/happy-path.ts',
      'projection://examples/denial-fallback.ts',
      'projection://boxes/fs/overview.md',
      'projection://boxes/github/overview.md',
    ]);
  });

  it('defers the list above the threshold counted across every box, with per-box counts', async () => {
    // 7 tools in all, 4 at most in one box: only the total crosses 5.
    const facade = await wrap({ catalogInlineThreshold: 5, projections: { direct: false } });
    const inline = textOf(facade.discoverApis());
    expect(inline).toContain(
      'Tools: 7 across the toolboxes fs, github — too many to list here (fs: 3, github: 4). Call search_tools (every box) or the search_<box> tool of a box (search_fs, search_github) to find tools',
    );
    expect(inline).toContain('qualified name, <box>.<tool>');
    expect(inline).not.toContain('- fs.read_file');
  });

  it('names only the per-box search tools in the pointer when the global search is off (R43)', async () => {
    const facade = await wrap({ catalogInlineThreshold: 5, catalog: { globalSearch: false } });
    const inline = textOf(facade.discoverApis());
    expect(inline).toContain(
      '(fs: 3, github: 4). Call the search_<box> tool of a box (search_fs, search_github) to find tools',
    );
    expect(inline).not.toContain('search_tools');
    expect(facade.instructions).not.toContain('search_tools');
    expect(facade.instructions).toContain('run it with execute_machine');
  });

  it('names no search_tools anywhere on a code-mode-only facade without the global search', async () => {
    const facade = await wrap({
      catalogInlineThreshold: 1,
      projections: { catalog: false },
      catalog: { globalSearch: false },
    });
    const c = await connectModern(facade);
    const surfaces: unknown[] = [
      facade.instructions,
      c.getInstructions(),
      await c.listTools(),
      facade.discoverApis(),
      await c.callTool({ name: 'discover_apis', arguments: {} }),
      facade.dts,
    ];
    const { resources } = await c.listResources();
    const { prompts } = await c.listPrompts();
    surfaces.push(
      resources,
      prompts,
      ...(await Promise.all(resources.map(({ uri }) => c.readResource({ uri })))),
      ...(await Promise.all(prompts.map(({ name }) => c.getPrompt({ name, arguments: {} })))),
    );
    expect(resources.map((resource) => resource.uri)).toContain(
      'projection://docs/authoring-contract.md',
    );
    for (const surface of surfaces) expect(JSON.stringify(surface)).not.toContain('search_tools');
  });

  it('keeps the plain execute_machine description when no call_tool is served', async () => {
    const c = await connectModern(await wrap({ projections: { catalog: false } }));
    const { tools } = await c.listTools();
    expect(tools.find((tool) => tool.name === 'execute_machine')?.description).not.toContain(
      'call_tool',
    );
  });

  it('keeps the list inline at the threshold, and with the catalog projection off', async () => {
    expect(textOf((await wrap({ catalogInlineThreshold: 7 })).discoverApis())).toContain(
      '- fs.read_file',
    );
    const codeOnly = await wrap({ catalogInlineThreshold: 1, projections: { catalog: false } });
    expect(textOf(codeOnly.discoverApis())).toContain('- github.get_issue');
  });
});

describe('resources, prompts and describe types on a multi-server facade (R3, R34, R39, R45)', () => {
  it('serves the code-mode resources and one overview per box with instructions, naming aliases', async () => {
    log = [];
    const quiet = recordingServer({ name: 'quiet', version: '1.0.0' }, [{ name: 'noop' }], log);
    const facade = await wrapMcpServers({ fs: fsServer(log), quiet }, { blob: { key: KEY } });
    facades.push(facade);
    const c = await connectModern(facade);
    const { resources } = await c.listResources();
    const byUri = new Map(resources.map((resource) => [resource.uri, resource]));
    expect(byUri.get('projection://types/tools.d.ts')?.description).toBe(
      'TypeScript definitions for the tools of the toolboxes fs, quiet.',
    );
    expect(byUri.has('projection://boxes/fs/overview.md')).toBe(true);
    // A box whose server sends no instructions has no overview.
    expect(byUri.has('projection://boxes/quiet/overview.md')).toBe(false);
    for (const resource of resources) {
      expect(resource.description ?? '').not.toContain('multi:');
      expect(resource.description ?? '').not.toContain('files@');
    }

    const read = async (uri: string): Promise<string> => {
      const { contents } = await c.readResource({ uri });
      const [first] = contents;
      return first !== undefined && 'text' in first ? first.text : '';
    };
    const overview = await read('projection://boxes/fs/overview.md');
    expect(overview).toContain(
      "Guidance from the fs box (the server's own words; it applies to fs tools only):",
    );
    expect(overview).toContain('    FS-SERVER-INSTRUCTIONS: read me first.');
    expect(await read('projection://types/tools.d.ts')).toBe(facade.dts);
    expect(facade.dts).toContain('  fs: {');
    expect(await read('projection://examples/happy-path.ts')).toContain("toolCall('fs.read_file'");
    expect(await read('projection://examples/denial-fallback.ts')).toContain(
      "toolCall('fs.write_file'",
    );
    expect(await read('projection://docs/authoring-contract.md')).toContain(
      "e.g. toolCall('fs.read_file', ...) (sample names; use the names in tools.d.ts).\n    An unqualified name is rejected.",
    );
  });

  it('caps a box overview with an explicit truncation marker', async () => {
    log = [];
    const chatty = recordingServer(
      { name: 'chatty', version: '1.0.0', instructions: `${'x'.repeat(9_000)}\u001b[31m` },
      [{ name: 'noop' }],
      log,
    );
    const facade = await wrapMcpServers({ chatty }, { blob: { key: KEY } });
    facades.push(facade);
    const overview = facade.resources.find(
      (resource) => resource.uri === 'projection://boxes/chatty/overview.md',
    )?.text;
    expect(overview).toContain(OVERVIEW_TRUNCATION_MARKER);
    expect(overview).not.toContain('\u001b');
  });

  it('names the boxes in the workflow prompts, never the server identity', async () => {
    const facade = await wrap();
    const c = await connectModern(facade);
    for (const name of ['save-workflow', 'visualize-workflow']) {
      const prompt = await c.getPrompt({ name, arguments: {} });
      const content = prompt.messages[0]?.content;
      const body = content !== undefined && content.type === 'text' ? content.text : '';
      expect(body).toContain('the toolboxes fs, github');
      expect(body).not.toContain('multi:');
      expect(body).not.toContain('files@1.0.0');
    }
  });

  it('returns the tools.<alias> slice from describe_tool({ types: true })', async () => {
    const facade = await wrap();
    const described = structured(facade.describeTool({ name: 'github.write_file', types: true }));
    expect(described['name']).toBe('github.write_file');
    expect(described['types']).toContain('// Member of tools.github:');
    expect(described['types']).toContain('export type github_WriteFileInput =');
    expect(described['types']).toContain(
      'write_file: (args?: github_WriteFileInput) => Promise<unknown>;',
    );
    expect(structured(facade.describeTool({ name: 'github.write_file' }))['types']).toBeUndefined();
  });
});

/** A bare catalog entry for the sample-name tests. */
function sampleEntry(
  name: string,
  annotations?: ToolCatalogEntry['annotations'],
): ToolCatalogEntry {
  return { name, inputSchema: { type: 'object' }, ...(annotations ? { annotations } : {}) };
}

/** A two-box view whose first box, `alpha`, holds `first`. */
function sampleView(first: ToolCatalogEntry[]) {
  return buildBoxedCatalog([
    { alias: 'alpha', catalog: { alias: 'alpha', identity: 'a@1', tools: first } },
    {
      alias: 'beta',
      catalog: {
        alias: 'beta',
        identity: 'b@1',
        tools: [sampleEntry('look', { readOnlyHint: true }), sampleEntry('poke')],
      },
    },
  ]);
}

describe('the multi-server contract quotes the facade round-trip cap (R18, D30)', () => {
  it('in discover_apis and the contract resource', async () => {
    const facade = await wrap({ caps: { maxRoundTrips: 5 } });
    const text = (facade.discoverApis().content[0] as { text: string }).text;
    expect(text).toContain('a workflow gets at most 5: one gated call per item');
    const contract = facade.resources.find((r) => r.name === 'authoring-contract.md');
    expect(contract?.text).toContain('stops unfinished past 5 items');
  });
});

describe('sample tool names in the contract and examples (R45)', () => {
  const NOTE = '(sample names; use the names in tools.d.ts)';

  it("calls the first box's own read-only and gated tools, without the placeholder note", () => {
    const samples = toolSamples(
      sampleView([
        sampleEntry('poke'),
        sampleEntry('peek', { readOnlyHint: true }),
        sampleEntry('zap'),
      ]),
    );
    expect(samples.read).toEqual({ name: 'alpha.peek', placeholder: false });
    expect(samples.gated).toEqual({ name: 'alpha.poke', placeholder: false });
    expect(samples.list).toEqual(samples.read);
    expect(exampleHappyPath(samples)).toContain("toolCall('alpha.peek', ");
    expect(exampleHappyPath(samples)).not.toContain(NOTE);
    expect(exampleDenialFallback(samples)).toContain("toolCall('alpha.poke', ");
    expect(exampleDenialFallback(samples)).not.toContain(NOTE);
    const contract = authoringContract(samples);
    expect(contract).toContain("toolCall('alpha.poke', () => ({ path: '/a' }), { id: 'a' }),\n");
    expect(contract).toContain(
      "toolCall('alpha.peek', ({ context }) => ({ path: context.path })),\n",
    );
    // Rule 10 always carries the note.
    expect(contract).toContain(`e.g. toolCall('alpha.peek', ...) ${NOTE}.`);
  });

  it('rule 8 does not call an undeclared result text, and says to look before parsing', () => {
    for (const contract of [
      authoringContract(),
      authoringContract(toolSamples(sampleView([sampleEntry('peek')]))),
    ]) {
      expect(contract).not.toContain('usually a string');
      expect(contract).toContain('that does not mean text');
      expect(contract).toContain('Never parse a result you have not seen');
    }
  });

  it('decides read-only and gated under the facade policy', () => {
    const samples = toolSamples(
      sampleView([sampleEntry('peek', { readOnlyHint: true }), sampleEntry('poke')]),
      {
        policy: { 'alpha.peek': 'ask', 'alpha.poke': 'auto' },
      },
    );
    expect(samples.read.name).toBe('alpha.poke');
    expect(samples.gated.name).toBe('alpha.peek');
  });

  it('falls back to generic names in the first box, marked as samples', () => {
    const samples = toolSamples(sampleView([sampleEntry('peek', { readOnlyHint: true })]));
    expect(samples.read).toEqual({ name: 'alpha.peek', placeholder: false });
    expect(samples.gated).toEqual({ name: 'alpha.write_file', placeholder: true });
    expect(exampleDenialFallback(samples)).toContain(`toolCall('alpha.write_file', `);
    expect(exampleDenialFallback(samples)).toContain(`content: 'hello' })), // ${NOTE}`);
    expect(exampleHappyPath(samples)).not.toContain(NOTE);

    const empty = toolSamples(sampleView([]));
    expect(empty.read).toEqual({ name: 'alpha.read_file', placeholder: true });
    expect(empty.list).toEqual({ name: 'alpha.list_dir', placeholder: true });
    expect(exampleHappyPath(empty)).toContain(
      `toolCall('alpha.read_file', ({ context }) => ({ path: context.path })), // ${NOTE}`,
    );
  });

  it('never samples a name that could forge the text, nor a dotted one', () => {
    const samples = toolSamples(
      sampleView([
        sampleEntry("x'), evil('", { readOnlyHint: true }),
        sampleEntry('a\nb', { readOnlyHint: true }),
        sampleEntry('github.delete_repo', { readOnlyHint: true }),
        sampleEntry('blocked'),
      ]),
      { policy: { 'alpha.blocked': 'deny' } },
    );
    expect(samples.read).toEqual({ name: 'alpha.read_file', placeholder: true });
    expect(samples.gated).toEqual({ name: 'alpha.write_file', placeholder: true });
  });
});
