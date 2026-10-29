/**
 * Multi-server facade lifecycle (PRD R39, R47): wrapping is fail-closed —
 * a failing source closes every connection Projection opened, while a
 * caller-owned `Client` stays open after a failed wrap and after `close()`
 * — and a connected `Client` works as a box, its calls routed by alias.
 */

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectionError, wrapMcpServers, type MultiProjectionFacade } from '../../src/index.js';
import { ACCEPT, isSuspended, sealedState, structured } from '../mrtr/helpers.js';
import { fsServer, githubServer, KEY, type RecordedCall, type ToolSpec } from './helpers.js';

const OPTIONS = { blob: { key: KEY } };

/** Over the per-server bound of 2000 tools (D12): introspection fails with `protocol`. */
const TOO_MANY: ToolSpec[] = Array.from({ length: 2_001 }, (_, i) => ({
  name: `t_${i}`,
  readOnly: true,
}));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

/** A caller-owned Client connected to `server`. */
async function ownedClient(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'caller', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(() => client.close());
  return client;
}

async function wrapError(run: () => Promise<MultiProjectionFacade>): Promise<ProjectionError> {
  let caught: unknown;
  try {
    const facade = await run();
    cleanup.push(() => facade.close());
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ProjectionError);
  return caught as ProjectionError;
}

describe('fail-closed wrapping (R47)', () => {
  it('disconnects the other in-process servers when one source fails', async () => {
    const log: RecordedCall[] = [];
    const good = fsServer(log);
    const other = githubServer(log);
    const bad = fsServer(log, TOO_MANY);
    const error = await wrapError(() => wrapMcpServers({ a: good, b: bad, c: other }, OPTIONS));
    expect(error.phase).toBe('protocol');
    expect(good.isConnected()).toBe(false);
    expect(other.isConnected()).toBe(false);
    expect(bad.isConnected()).toBe(false);
  });

  it('leaves a caller-owned Client open after a failed wrap', async () => {
    const log: RecordedCall[] = [];
    const upstream = githubServer(log);
    const client = await ownedClient(upstream);
    const sibling = fsServer(log);
    await wrapError(() =>
      wrapMcpServers({ fs: sibling, github: client, bad: fsServer(log, TOO_MANY) }, OPTIONS),
    );
    expect(sibling.isConnected()).toBe(false);
    expect(upstream.isConnected()).toBe(true);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  it('leaves a caller-owned Client open after close(), closing only what it opened', async () => {
    const log: RecordedCall[] = [];
    const upstream = githubServer(log);
    const client = await ownedClient(upstream);
    const inProcess = fsServer(log);
    const facade = await wrapMcpServers({ fs: inProcess, github: client }, OPTIONS);
    expect(inProcess.isConnected()).toBe(true);
    await facade.close();
    expect(inProcess.isConnected()).toBe(false);
    expect(upstream.isConnected()).toBe(true);
    const result = await client.callTool({ name: 'get_issue', arguments: {} });
    expect(result.isError).not.toBe(true);
  });

  it('refuses an already-connected McpServer before any sibling connects (R39)', async () => {
    const log: RecordedCall[] = [];
    const connected = fsServer(log);
    await ownedClient(connected);
    const sibling = githubServer(log);
    const error = await wrapError(() =>
      wrapMcpServers({ fs: connected, github: sibling }, OPTIONS),
    );
    expect(error.phase).toBe('validate');
    expect(error.message).toContain('source "fs" is an McpServer that is already connected');
    expect(sibling.isConnected()).toBe(false);
  });

  it('reports a duck-typed source that fails as a pointed protocol error, not a TypeError', async () => {
    const log: RecordedCall[] = [];
    const sibling = fsServer(log);
    const error = await wrapError(() =>
      wrapMcpServers(
        {
          fs: sibling,
          odd: {
            connect() {
              return Promise.resolve();
            },
          } as unknown as McpServer,
        },
        OPTIONS,
      ),
    );
    expect(error.phase).toBe('protocol');
    expect(error.message).toContain('source "odd" failed to connect or introspect');
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(sibling.isConnected()).toBe(false);
  });
});

describe('a connected Client as a box (R39, R40)', () => {
  it('routes read-only and approved calls to the Client’s server by alias', async () => {
    const log: RecordedCall[] = [];
    const client = await ownedClient(githubServer(log));
    const facade = await wrapMcpServers({ fs: fsServer(log), gh: client }, OPTIONS);
    cleanup.push(() => facade.close());

    const read = await facade.callTool({ name: 'gh.get_issue', args: {} }, 'modern');
    expect(structured(read)).toEqual({
      status: 'ok',
      tool: 'gh.get_issue',
      output: 'gh-server:get_issue',
    });

    const call = { name: 'gh.write_file', args: { path: 'README.md', content: 'hi' } };
    const suspended = await facade.callTool(call, 'modern');
    expect(isSuspended(suspended)).toBe(true);
    const approved = await facade.callTool(
      { ...call, requestState: sealedState(suspended), inputResponses: { call: ACCEPT } },
      'modern',
    );
    expect(structured(approved)).toMatchObject({ status: 'ok', tool: 'gh.write_file' });
    expect(log.map((entry) => `${entry.server}:${entry.tool}`)).toEqual([
      'gh-server:get_issue',
      'gh-server:write_file',
    ]);
  });
});
