/**
 * The /save-workflow and /visualize-workflow MCP prompts, driven by a real
 * client over the HTTP handler: discoverable via prompts/list, correct
 * argument declarations, guidance content present, and client-supplied
 * arguments rendered inert (S6 posture — an arg cannot forge structure in
 * the returned guidance).
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { wrapMcpServer, WORKFLOW_PROMPTS, type ProjectionFacade } from '../../src/index.js';

const KEY = new Uint8Array(32).fill(7);
const ENDPOINT = new URL('http://prompts.projection.test/mcp');

let facade: ProjectionFacade;
let client: Client;

beforeAll(async () => {
  const upstream = new McpServer({ name: 'prompt-fixture', version: '3.2.1' });
  upstream.registerTool(
    'read_file',
    {
      description: 'read',
      inputSchema: z.object({ path: z.string() }),
      annotations: { readOnlyHint: true },
    },
    ({ path }) => ({ content: [{ type: 'text', text: `content of ${path}` }] }),
  );
  facade = await wrapMcpServer(upstream, { blob: { key: KEY } });
  const handler = createMcpHandler(facade.serverFactory);
  client = new Client({ name: 'prompt-probe', version: '0.0.0' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(ENDPOINT, {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
});

afterAll(async () => {
  await client?.close();
  await facade?.close();
});

describe('workflow prompts (/save-workflow, /visualize-workflow)', () => {
  it('both prompts are listed with their argument declarations', async () => {
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name);
    for (const definition of WORKFLOW_PROMPTS) {
      expect(names).toContain(definition.name);
    }
    const save = prompts.find((p) => p.name === 'save-workflow');
    expect(save?.description).toContain('reusable');
    const nameArg = save?.arguments?.find((a) => a.name === 'name');
    expect(nameArg).toBeDefined();
    expect(nameArg?.required ?? false).toBe(false);
  });

  it('save-workflow guidance covers generalize, verify, save, and the server binding', async () => {
    const result = await client.getPrompt({
      name: 'save-workflow',
      arguments: { name: 'sync-notes' },
    });
    const text = (result.messages[0]?.content as { text?: string } | undefined)?.text ?? '';
    expect(result.messages[0]?.role).toBe('user');
    expect(text).toContain('sync-notes');
    expect(text).toContain('execute_machine');
    expect(text).toContain('input');
    expect(text).toContain('projection://docs/authoring-contract.md');
    // The machine is bound to the wrapped server's identity (R30).
    expect(text).toContain('prompt-fixture@3.2.1');
  });

  it('visualize-workflow guidance covers status, output, audit trail, logs, and inert rendering', async () => {
    const result = await client.getPrompt({ name: 'visualize-workflow', arguments: {} });
    const text = (result.messages[0]?.content as { text?: string } | undefined)?.text ?? '';
    expect(text).toContain('structuredContent');
    expect(text).toContain('approval audit trail');
    expect(text).toContain('logs');
    expect(text).toContain('DATA');
    expect(text).toContain('prompt-fixture@3.2.1');
    // No focus supplied: the balanced default stands in.
    expect(text).toContain('a balanced overview');
  });

  it('client-supplied arguments are neutralized and capped before interpolation', async () => {
    // U+202E (RTL override) and U+0007 (BEL): both must render inert.
    const hostile = 'evil\u202e\u0007name' + 'x'.repeat(500);
    const result = await client.getPrompt({
      name: 'save-workflow',
      arguments: { name: hostile },
    });
    const text = (result.messages[0]?.content as { text?: string } | undefined)?.text ?? '';
    expect(text).not.toContain('\u202e');
    expect(text).not.toContain('\u0007');
    expect(text).toContain('evil\ufffd\ufffdname');
    // capLength(200) truncated the x-run.
    expect(text).not.toContain('x'.repeat(300));
  });
});
