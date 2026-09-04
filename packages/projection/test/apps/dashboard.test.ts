/**
 * MCP Apps wire-format conformance (PRD §12.1, SEP-1865 spec 2026-01-26),
 * asserted through a real client against a served facade:
 *
 * - execute_machine declares `_meta.ui.resourceUri` pointing at a `ui://`
 *   resource;
 * - that resource serves the dashboard with the mandated
 *   `text/html;profile=mcp-app` MIME type;
 * - the app HTML implements the mandated handshake methods and renders
 *   model data inertly (no innerHTML — the §12.1/S6 posture);
 * - models are not distracted: discover_apis resource links exclude ui://.
 */

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  DASHBOARD_HTML,
  DASHBOARD_RESOURCE_URI,
  MCP_APP_MIME_TYPE,
  wrapMcpServer,
  type ProjectionFacade,
} from '../../src/index.js';

let facade: ProjectionFacade;
let client: Client;

beforeAll(async () => {
  const upstream = new McpServer({ name: 'apps-fixture', version: '1.0.0' });
  upstream.registerTool(
    'read_file',
    {
      description: 'read',
      inputSchema: z.object({ path: z.string() }),
      annotations: { readOnlyHint: true },
    },
    ({ path }) => ({ content: [{ type: 'text', text: `content of ${path}` }] }),
  );
  facade = await wrapMcpServer(upstream, { blob: { key: randomBytes(32) } });

  const handler = createMcpHandler(facade.serverFactory);
  client = new Client({ name: 'apps-probe', version: '0.0.0' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://projection.internal/mcp'), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
});

afterAll(async () => {
  await client?.close();
  await facade?.close();
});

describe('MCP Apps declaration (SEP-1865)', () => {
  it('execute_machine declares _meta.ui.resourceUri at a ui:// URI', async () => {
    const { tools } = await client.listTools();
    const executeMachine = tools.find((t) => t.name === 'execute_machine');
    const ui = (executeMachine?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui;
    expect(ui?.resourceUri).toBe(DASHBOARD_RESOURCE_URI);
    expect(DASHBOARD_RESOURCE_URI.startsWith('ui://')).toBe(true);
  });

  it('serves the dashboard resource with the mandated app MIME type', async () => {
    const { resources } = await client.listResources();
    const dashboard = resources.find((r) => r.uri === DASHBOARD_RESOURCE_URI);
    expect(dashboard?.mimeType).toBe(MCP_APP_MIME_TYPE);
    expect(MCP_APP_MIME_TYPE).toBe('text/html;profile=mcp-app');

    const read = await client.readResource({ uri: DASHBOARD_RESOURCE_URI });
    const content = read.contents[0] as { mimeType?: string; text?: string };
    expect(content.mimeType).toBe(MCP_APP_MIME_TYPE);
    expect(content.text).toBe(DASHBOARD_HTML);
  });

  it('discover_apis resource links exclude the ui:// app (models never see it)', () => {
    const links = facade
      .discoverApis()
      .content.flatMap((block) => (block.type === 'resource_link' ? [block.uri] : []));
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((uri) => !uri.startsWith('ui://'))).toBe(true);
    // But the facade's own resource list (what registerOn serves) has it.
    expect(facade.resources.some((r) => r.uri === DASHBOARD_RESOURCE_URI)).toBe(true);
  });
});

describe('dashboard app source (the §12.1 security posture)', () => {
  it('implements the mandated handshake methods', () => {
    expect(DASHBOARD_HTML).toContain("'ui/initialize'");
    expect(DASHBOARD_HTML).toContain("'ui/notifications/initialized'");
    expect(DASHBOARD_HTML).toContain("'ui/notifications/tool-result'");
    expect(DASHBOARD_HTML).toContain("'ui/notifications/tool-cancelled'");
  });

  it('requests no host capabilities', () => {
    expect(DASHBOARD_HTML).toContain('appCapabilities: {}');
    // The app only listens: it never asks the host to run tools or open links.
    expect(DASHBOARD_HTML).not.toContain("'tools/call'");
    expect(DASHBOARD_HTML).not.toContain('ui/open-link');
  });

  it('never uses innerHTML: model data enters the DOM as text only', () => {
    expect(DASHBOARD_HTML).not.toContain('innerHTML');
    expect(DASHBOARD_HTML).not.toContain('outerHTML');
    expect(DASHBOARD_HTML).not.toContain('document.write');
    expect(DASHBOARD_HTML).not.toContain('insertAdjacentHTML');
    expect(DASHBOARD_HTML).toContain('textContent');
  });
});
