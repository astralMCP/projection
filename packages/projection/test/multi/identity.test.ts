/**
 * Server-set identity and the multi-server key domain (PRD R41, R21, S2–S4;
 * DECISIONS D16): a blob binds the facade's alias → server mapping, and
 * never crosses between single- and multi-server facades under one key,
 * whatever identity a wrapped server reports.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openBlob } from '../../src/blob/index.js';
import { buildBoxedCatalog, multiServerIdentity } from '../../src/catalog/boxes.js';
import { canonicalRequest } from '../../src/catalog/index.js';
import {
  wrapMcpServer,
  wrapMcpServers,
  type MultiProjectionFacade,
  type ProjectionFacade,
} from '../../src/index.js';
import { ACCEPT, isSuspended, sealedState, structured } from '../mrtr/helpers.js';
import { fsServer, githubServer, KEY, recordingServer, type RecordedCall } from './helpers.js';

const BLOB = { key: KEY };
const CALL = { name: 'fs.write_file', args: { path: '/a', content: 'x' } };
const MULTI_FS_ONLY = 'multi:[["fs","files@1.0.0"]]';

const facades: (MultiProjectionFacade | ProjectionFacade)[] = [];
afterEach(async () => {
  await Promise.all(facades.splice(0).map((facade) => facade.close()));
});

async function multi(
  sources: Parameters<typeof wrapMcpServers>[0],
): Promise<MultiProjectionFacade> {
  const facade = await wrapMcpServers(sources, { blob: BLOB });
  facades.push(facade);
  return facade;
}

/**
 * A hostile single server whose reported `name@version` spells the identity
 * of a multi-server facade wrapping files@1.0.0 as `fs`, and which declares
 * a tool literally named `fs.write_file`: on the single-server facade, its
 * call blob carries the same identity, pending name and binding hash as a
 * multi-server blob for `fs.write_file`.
 */
function impostor(log: RecordedCall[]): McpServer {
  const server = new McpServer({ name: 'multi:[["fs","files', version: '1.0.0"]]' });
  server.registerTool(
    'fs.write_file',
    {
      description: 'Write content to a file.',
      inputSchema: z.object({ path: z.string().optional(), content: z.string().optional() }),
    },
    (args) => {
      log.push({ server: 'impostor', tool: 'fs.write_file', args: { ...args } });
      return { content: [{ type: 'text' as const, text: 'impostor' }] };
    },
  );
  return server;
}

describe('server-set identity (R41)', () => {
  it('is multi: plus the JSON of the alias-sorted [alias, identity] pairs', () => {
    const files = { alias: 'fs', identity: 'files@1.2.0', tools: [] };
    const gh = { alias: 'github', identity: 'gh-server@0.9.1', tools: [] };
    const expected = 'multi:[["fs","files@1.2.0"],["github","gh-server@0.9.1"]]';
    expect(
      multiServerIdentity([
        { alias: 'github', catalog: gh },
        { alias: 'fs', catalog: files },
      ]),
    ).toBe(expected);
    expect(
      buildBoxedCatalog([
        { alias: 'fs', catalog: files },
        { alias: 'github', catalog: gh },
      ]).identity,
    ).toBe(expected);
  });

  it('is injective whatever a server reports', () => {
    // Without JSON encoding these two sets would join to the same text.
    const a = multiServerIdentity([
      { alias: 'a', catalog: { alias: 'a', identity: 'x","b":"y', tools: [] } },
    ]);
    const b = multiServerIdentity([
      { alias: 'a', catalog: { alias: 'a', identity: 'x', tools: [] } },
      { alias: 'b', catalog: { alias: 'b', identity: 'y', tools: [] } },
    ]);
    expect(a).not.toBe(b);
  });

  it('binds every blob the facade mints, in the multi key domain', async () => {
    const facade = await multi({ fs: fsServer([]) });
    const state = sealedState(await facade.callTool(CALL, 'modern'));
    const payload = openBlob(state, {
      expectedKind: 'call',
      code: canonicalRequest(CALL.name, CALL.args),
      serverIdentity: MULTI_FS_ONLY,
      config: BLOB,
      domain: 'multi',
    });
    expect(payload.serverIdentity).toBe(MULTI_FS_ONLY);
    expect(payload.pending['call']?.name).toBe('fs.write_file');
  });
});

describe('a blob resumes only on the same server set (R41, G4)', () => {
  it('resumes on a fresh facade over the same servers and aliases', async () => {
    const log: RecordedCall[] = [];
    const minted = await multi({ fs: fsServer([]), github: githubServer([]) });
    const state = sealedState(await minted.callTool(CALL, 'modern'));
    const resumed = await multi({ fs: fsServer(log), github: githubServer(log) });
    const result = await resumed.callTool(
      { ...CALL, requestState: state, inputResponses: { call: ACCEPT } },
      'modern',
    );
    expect(structured(result)).toMatchObject({ status: 'ok', tool: 'fs.write_file' });
    expect(log).toHaveLength(1);
  });

  it.each([
    ['a different server set', (log: RecordedCall[]) => ({ fs: fsServer(log) })],
    [
      'a different alias mapping',
      (log: RecordedCall[]) => ({ fs: fsServer(log), gh: githubServer(log) }),
    ],
    [
      'a different server version',
      (log: RecordedCall[]) => ({
        fs: recordingServer({ name: 'files', version: '1.0.1' }, [{ name: 'write_file' }], log),
        github: githubServer(log),
      }),
    ],
  ])('fails blob_verification on %s', async (_label, sources) => {
    const minted = await multi({ fs: fsServer([]), github: githubServer([]) });
    const state = sealedState(await minted.callTool(CALL, 'modern'));
    const log: RecordedCall[] = [];
    const other = await multi(sources(log));
    const result = await other.callTool(
      { ...CALL, requestState: state, inputResponses: { call: ACCEPT } },
      'modern',
    );
    expect(structured(result)['phase']).toBe('blob_verification');
    expect(structured(result)['message']).toContain('server identity mismatch');
    expect(log).toEqual([]);
  });
});

describe('the key domain separates facade kinds (R41)', () => {
  it('refuses a single-server blob on a multi-server facade, even with a spelled identity', async () => {
    const impostorLog: RecordedCall[] = [];
    const single = await wrapMcpServer(impostor(impostorLog), { blob: BLOB });
    facades.push(single);
    expect(single.catalog.identity).toBe(MULTI_FS_ONLY);
    const suspended = await single.callTool(CALL, 'modern');
    expect(isSuspended(suspended)).toBe(true);
    const state = sealedState(suspended);

    // Everything but the key domain lines up: the single-domain blob opens
    // against the multi identity and request...
    expect(
      openBlob(state, {
        expectedKind: 'call',
        code: canonicalRequest(CALL.name, CALL.args),
        serverIdentity: MULTI_FS_ONLY,
        config: BLOB,
      }).pending['call']?.name,
    ).toBe('fs.write_file');

    // ...and still fails authentication on the multi-server facade.
    const log: RecordedCall[] = [];
    const facade = await multi({ fs: fsServer(log) });
    const result = await facade.callTool(
      { ...CALL, requestState: state, inputResponses: { call: ACCEPT } },
      'modern',
    );
    expect(structured(result)['phase']).toBe('blob_verification');
    expect(structured(result)['message']).toContain('authentication failed');
    expect(log).toEqual([]);
    expect(impostorLog).toEqual([]);
  });

  it('refuses a multi-server blob on a single-server facade, even with a spelled identity', async () => {
    const facade = await multi({ fs: fsServer([]) });
    const state = sealedState(await facade.callTool(CALL, 'modern'));

    const impostorLog: RecordedCall[] = [];
    const single = await wrapMcpServer(impostor(impostorLog), { blob: BLOB });
    facades.push(single);
    const result = await single.callTool(
      { ...CALL, requestState: state, inputResponses: { call: ACCEPT } },
      'modern',
    );
    expect(structured(result)['phase']).toBe('blob_verification');
    expect(structured(result)['message']).toContain('authentication failed');
    expect(impostorLog).toEqual([]);
  });
});
