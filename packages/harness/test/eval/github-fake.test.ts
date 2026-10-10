/**
 * The offline GitHub fake: serves the dumped 95-tool catalog verbatim,
 * records calls, answers from the canned table, and rejects schema-invalid
 * arguments before anything is recorded.
 */

import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { wrapMcpServer } from '@astral-mcp/projection';
import { describe, expect, it } from 'vitest';
import {
  createGithubFake,
  GITHUB_CATALOG,
  toolResultText,
  type GithubFake,
} from '../../src/index.js';

async function connect(fake: GithubFake): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fake-test', version: '0.0.0' }, { capabilities: {} });
  await fake.server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('github fake', () => {
  it('lists exactly the dumped catalog, schemas and annotations intact', async () => {
    expect(GITHUB_CATALOG.tools).toHaveLength(95);
    const fake = createGithubFake();
    const client = await connect(fake);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).toSorted()).toEqual(GITHUB_CATALOG.tools.map((t) => t.name));
      for (const expected of GITHUB_CATALOG.tools) {
        const served = tools.find((t) => t.name === expected.name);
        expect(served?.description).toBe(expected.description);
        expect(served?.inputSchema).toEqual(expected.inputSchema);
        expect(served?.annotations).toEqual(expected.annotations);
      }
      expect(client.getInstructions()).toContain('Tool selection guidance');
    } finally {
      await client.close();
    }
  });

  it('wraps under Projection with the full catalog and the server instructions', async () => {
    const fake = createGithubFake();
    const facade = await wrapMcpServer(fake.server, { blob: { key: randomBytes(32) } });
    try {
      expect(facade.catalog.tools).toHaveLength(95);
      expect(facade.instructions).toContain('Tool selection guidance');
      expect(facade.dts).toContain('issue_write');
    } finally {
      await facade.close();
    }
  });

  it('records calls and answers from the canned table, defaulting to ok', async () => {
    const fake = createGithubFake();
    const client = await connect(fake);
    try {
      const me = toolResultText(await client.callTool({ name: 'get_me', arguments: {} }));
      expect(me).toEqual({ text: '{"login":"vibdev"}' });
      const star = toolResultText(
        await client.callTool({ name: 'star_repository', arguments: { owner: 'a', repo: 'b' } }),
      );
      expect(star).toEqual({ text: '{"ok":true}' });
      expect(fake.calls).toEqual([
        { tool: 'get_me', args: {} },
        { tool: 'star_repository', args: { owner: 'a', repo: 'b' } },
      ]);
    } finally {
      await client.close();
    }
  });

  it('rejects schema-invalid arguments without recording a call', async () => {
    const fake = createGithubFake();
    const client = await connect(fake);
    try {
      let rejected = false;
      try {
        const result = await client.callTool({
          name: 'star_repository',
          arguments: { owner: 'a' }, // repo is required
        });
        rejected = result.isError === true;
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
      expect(fake.calls).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('can drop the instructions and narrow the catalog', async () => {
    const fake = createGithubFake({
      tools: GITHUB_CATALOG.tools.filter((t) => t.name === 'get_me'),
      instructions: false,
      answers: { get_me: { login: 'someone-else' } },
    });
    const client = await connect(fake);
    try {
      expect((await client.listTools()).tools).toHaveLength(1);
      expect(client.getInstructions()).toBeUndefined();
      const me = toolResultText(await client.callTool({ name: 'get_me', arguments: {} }));
      expect(me.text).toBe('{"login":"someone-else"}');
    } finally {
      await client.close();
    }
  });
});
