/**
 * An in-process Projection facade over fixture catalogs, for the offline
 * evals: the real `wrapMcpServer` / `wrapMcpServers` around stub servers
 * (catalogs.ts), reached over the same 2026-07-28 wire the eval modes use.
 * Only the discovery tools are ever called, so nothing reaches a stub's
 * handler and nothing needs approving.
 */

import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { MRTR_PROTOCOL_REVISION, wrapMcpServer, wrapMcpServers } from '@astral-mcp/projection';
import { catalogServer, type CatalogFixture } from './catalogs.js';

const ENDPOINT = new URL('http://offline-eval.projection.test/mcp');

/** What a facade answered: its text (what the model reads) and structured content. */
export interface FacadeResult {
  text: string;
  structured: Record<string, unknown> | undefined;
  isError: boolean;
}

export interface OfflineFacade {
  /** Call one of the facade's tools. */
  call(name: string, args: Record<string, unknown>): Promise<FacadeResult>;
  /** The facade's tools as listed. */
  tools(): Promise<{ name: string; description: string; inputSchema: unknown }[]>;
  close(): Promise<void>;
}

export type FacadeSpec =
  | { kind: 'single'; catalog: CatalogFixture }
  | {
      kind: 'multi';
      boxes: readonly { alias: string; catalog: CatalogFixture }[];
      globalSearch?: boolean;
    };

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '',
    )
    .join('\n');
}

/** Wrap the spec's catalogs in a facade and connect a client to it. */
export async function openOfflineFacade(spec: FacadeSpec): Promise<OfflineFacade> {
  const blob = { key: randomBytes(32) };
  const facade =
    spec.kind === 'single'
      ? await wrapMcpServer(catalogServer(spec.catalog), { blob })
      : await wrapMcpServers(
          Object.fromEntries(spec.boxes.map((box) => [box.alias, catalogServer(box.catalog)])),
          { blob, ...(spec.globalSearch === false ? { catalog: { globalSearch: false } } : {}) },
        );
  const handler = createMcpHandler(facade.serverFactory);
  const client = new Client(
    { name: 'offline-eval', version: '0.0.0' },
    { capabilities: {}, versionNegotiation: { mode: { pin: MRTR_PROTOCOL_REVISION } } },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(ENDPOINT, {
        fetch: (url, init) => handler.fetch(new Request(url, init)),
      }),
    );
  } catch (err) {
    await client.close().catch(() => {});
    await facade.close().catch(() => {});
    throw err;
  }
  return {
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      return {
        text: textOf(result.content),
        structured: result.structuredContent as Record<string, unknown> | undefined,
        isError: result.isError === true,
      };
    },
    async tools() {
      const listed = await client.listTools();
      return listed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
      }));
    },
    async close() {
      await client.close();
      await facade.close();
    },
  };
}
