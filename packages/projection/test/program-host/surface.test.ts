/**
 * The program runtime's model-facing surface (D48): on a facade wrapped with
 * `codeRuntime: 'psychoscript'`, nothing a model reads — tool descriptions
 * and schemas, the instructions, discover_apis, the resources, the prompts,
 * describe_tool — still talks about XState machines. And a program spans
 * boxes on a multi-server facade with one approval per gated call.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCodeRuntime } from '../../src/facade/options.js';
import {
  wrapMcpServer,
  wrapMcpServers,
  type MultiProjectionFacade,
  type ProjectionFacade,
} from '../../src/index.js';
import { MRTR_PROTOCOL_REVISION } from '../../src/mrtr/index.js';
import {
  ACCEPT,
  decline,
  elicitation,
  requestKeys,
  sealedState,
  structured,
} from '../mrtr/helpers.js';
import { fsServer, githubServer, KEY, type RecordedCall } from '../multi/helpers.js';

const ENDPOINT = new URL('http://program.projection.test/mcp');

/** Machine-runtime vocabulary that must not reach a model on a program facade. */
const MACHINE_WORDS =
  /XState|toolCall|createMachine|setup\(|TOOL_RESULT|TOOL_ERROR|TOOL_DENIED|fromPromise|whenCall|\bmachines?\b|\bstate machine/u;

const facades: (ProjectionFacade | MultiProjectionFacade)[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(facades.splice(0).map((facade) => facade.close()));
});

async function connect(facade: ProjectionFacade | MultiProjectionFacade): Promise<Client> {
  const handler = createMcpHandler(facade.serverFactory);
  const client = new Client(
    { name: 'program-surface-test', version: '1.0.0' },
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
  clients.push(client);
  return client;
}

/** Every text a model can read on the facade, labelled by where it came from. */
async function surface(client: Client, toolName: string): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  texts.set('instructions', client.getInstructions() ?? '');
  const { tools } = await client.listTools();
  for (const tool of tools) {
    texts.set(
      `tool ${tool.name}`,
      `${tool.title ?? ''}\n${tool.description ?? ''}\n${JSON.stringify(tool.inputSchema)}`,
    );
  }
  const discover = await client.callTool({ name: 'discover_apis', arguments: {} });
  texts.set('discover_apis', JSON.stringify(discover.content));
  const { resources } = await client.listResources();
  for (const resource of resources) {
    if (resource.uri.startsWith('ui://')) continue;
    const read = await client.readResource({ uri: resource.uri });
    texts.set(
      `resource ${resource.uri}`,
      `${resource.description ?? ''}\n${JSON.stringify(read.contents)}`,
    );
  }
  const { prompts } = await client.listPrompts();
  for (const prompt of prompts) {
    const got = await client.getPrompt({ name: prompt.name, arguments: {} });
    texts.set(
      `prompt ${prompt.name}`,
      `${prompt.description ?? ''}\n${JSON.stringify(got.messages)}`,
    );
  }
  if (tools.some((tool) => tool.name === 'describe_tool')) {
    const described = await client.callTool({
      name: 'describe_tool',
      arguments: { name: toolName, types: true },
    });
    texts.set('describe_tool', JSON.stringify(described.content));
  }
  return texts;
}

/** The contract's one deliberate mention: what a program is not. */
const NOT_A_MACHINE = /not an(?:\\n|\s)XState machine/gu;

function leftovers(texts: Map<string, string>): string[] {
  const found: string[] = [];
  for (const [where, raw] of texts) {
    const text = raw.replace(NOT_A_MACHINE, '');
    const match = MACHINE_WORDS.exec(text);
    if (match !== null) {
      found.push(`${where}: …${text.slice(Math.max(0, match.index - 60), match.index + 60)}…`);
    }
  }
  return found;
}

describe('program runtime surface: no machine vocabulary reaches the model', () => {
  for (const projections of [{}, { catalog: false }, { direct: false }] as const) {
    it(`single server, projections ${JSON.stringify(projections)}`, async () => {
      const facade = await wrapMcpServer(fsServer([]), {
        blob: { key: KEY },
        codeRuntime: 'psychoscript',
        projections,
      });
      facades.push(facade);
      const texts = await surface(await connect(facade), 'read_file');
      expect(leftovers(texts)).toEqual([]);
      expect(texts.get('discover_apis')).toContain('await tools.read_file(');
      expect(texts.get('tool execute_machine')).toContain('Run a program');
    });

    it(`multi server, projections ${JSON.stringify(projections)}`, async () => {
      const facade = await wrapMcpServers(
        { fs: fsServer([]), github: githubServer([]) },
        { blob: { key: KEY }, codeRuntime: 'psychoscript', projections },
      );
      facades.push(facade);
      const texts = await surface(await connect(facade), 'fs.read_file');
      expect(leftovers(texts)).toEqual([]);
      expect(texts.get('discover_apis')).toContain('tools.fs.read_file(');
    });
  }

  it('the XState facade keeps its machine copy (the rewrite is opt-in)', async () => {
    const facade = await wrapMcpServer(fsServer([]), { blob: { key: KEY } });
    facades.push(facade);
    const texts = await surface(await connect(facade), 'read_file');
    expect(texts.get('tool execute_machine')).toContain('XState v5');
  });

  it('codeRuntime is validated at wrap time', async () => {
    expect(assertCodeRuntime(undefined)).toBe('xstate');
    expect(assertCodeRuntime('psychoscript')).toBe('psychoscript');
    expect(() => assertCodeRuntime('quickjs')).toThrow(/codeRuntime must be/u);
    await expect(
      wrapMcpServer(fsServer([]), { blob: { key: KEY }, codeRuntime: 'v6' as never }),
    ).rejects.toThrow(/codeRuntime must be/u);
  });
});

describe('program runtime on a multi-server facade', () => {
  it('one program spans boxes; each gated call is approved on its own, in one round trip', async () => {
    const log: RecordedCall[] = [];
    const facade = await wrapMcpServers(
      { fs: fsServer(log), github: githubServer(log) },
      { blob: { key: KEY }, codeRuntime: 'psychoscript' },
    );
    facades.push(facade);
    const code = `
const file = await tools.fs.read_file({ path: '/notes.md' })
const [issue, copy] = await Promise.allSettled([
  tools.github.issue_write({ title: 'From notes' }),
  tools.fs.write_file({ path: '/copy.md', content: String(file) }),
])
return { issue: issue.status, copy: copy.status }
`;
    const first = await facade.executeMachine({ code }, 'modern');
    expect(requestKeys(first).toSorted()).toEqual(['fs.write_file#3', 'github.issue_write#2']);
    expect(elicitation(first, 'github.issue_write#2').message).toMatch(/\(github\)/u);
    expect(log.map((c) => `${c.server}:${c.tool}`)).toEqual(['files:read_file']);
    const done = await facade.executeMachine(
      {
        code,
        requestState: sealedState(first),
        inputResponses: { 'github.issue_write#2': ACCEPT, 'fs.write_file#3': decline() },
      },
      'modern',
    );
    expect(structured(done)['output']).toEqual({ issue: 'fulfilled', copy: 'rejected' });
    expect(log.map((c) => `${c.server}:${c.tool}`)).toEqual([
      'files:read_file',
      'gh-server:issue_write',
    ]);
  });
});
