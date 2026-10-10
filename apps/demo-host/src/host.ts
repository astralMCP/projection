/**
 * Browser-side MCP Apps host (bundled to public/host.iife.js).
 *
 * A real SDK `Client` over StreamableHTTP to the Projection facade at /mcp,
 * pinned to the 2026-07-28 revision with `autoFulfill: false` so this page
 * drives the MRTR approval round trips itself (approve/deny buttons).
 *
 * The MCP Apps host side (AppBridge-lite): loads the ui:// dashboard
 * resource into a sandboxed iframe (allow-scripts only — the app gets no
 * same-origin access) and speaks the SEP-1865 postMessage dialect: answers
 * `ui/initialize`, waits for `ui/notifications/initialized`, then pushes
 * `ui/notifications/tool-input` and `ui/notifications/tool-result`.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const MRTR_REVISION = '2026-07-28';
const DASHBOARD_URI = 'ui://projection/dashboard.html';

/** The canned workflow: an inline read, then a gated (destructive) write. */
const MACHINE = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'readThenWrite',
  context: ({ input }) => ({ dir: input.dir, note: null, status: 'pending' }),
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('read_text_file', ({ context }) => ({ path: context.dir + '/notes.txt' })),
      on: {
        TOOL_RESULT: { target: 'writing', actions: assign({ note: ({ event }) => event.result }) },
        TOOL_ERROR: { target: 'done', actions: assign({ status: 'read failed' }) },
      },
    },
    writing: {
      entry: toolCall('write_file', ({ context }) => ({
        path: context.dir + '/dashboard-was-here.txt',
        content: 'written by an approved Projection workflow',
      })),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: 'written' }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'declined by the user' }) },
        TOOL_ERROR: { target: 'done', actions: assign({ status: 'write failed' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status, note: context.note }),
});
`;

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function log(direction: string, text: string): void {
  const line = document.createElement('div');
  line.className = 'wire-line';
  const tag = document.createElement('span');
  tag.className = 'wire-tag';
  tag.textContent = direction;
  line.appendChild(tag);
  line.appendChild(document.createTextNode(text));
  const wire = el('wire');
  wire.appendChild(line);
  wire.scrollTop = wire.scrollHeight;
}

// ---------------------------------------------------------------------------
// AppBridge-lite: host side of the SEP-1865 postMessage dialect
// ---------------------------------------------------------------------------

interface AppFrame {
  push(method: string, params: unknown): void;
  ready: Promise<void>;
}

function mountApp(html: string): AppFrame {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.id = 'app-frame';
  iframe.srcdoc = html;
  el('app-slot').replaceChildren(iframe);

  let markReady: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  window.addEventListener('message', (event) => {
    if (event.source !== iframe.contentWindow) return;
    const message = event.data as {
      jsonrpc?: string;
      id?: number;
      method?: string;
      params?: unknown;
    };
    if (message?.jsonrpc !== '2.0') return;

    if (message.method === 'ui/initialize' && message.id !== undefined) {
      log('app→host', 'ui/initialize');
      iframe.contentWindow?.postMessage(
        {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            hostInfo: { name: 'projection-demo-host', version: '0.1.0' },
            hostCapabilities: {},
            hostContext: {},
          },
        },
        '*',
      );
      return;
    }
    if (message.method === 'ui/notifications/initialized') {
      log('app→host', 'ui/notifications/initialized');
      markReady();
      return;
    }
    // Anything else from the app (size-changed etc.): acknowledge requests,
    // ignore notifications. The dashboard requests nothing by design.
    if (message.id !== undefined && message.method !== undefined) {
      iframe.contentWindow?.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, '*');
    }
  });

  return {
    ready,
    push(method, params) {
      log('host→app', method);
      iframe.contentWindow?.postMessage({ jsonrpc: '2.0', method, params }, '*');
    },
  };
}

// ---------------------------------------------------------------------------
// The demo flow
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const runButton = el<HTMLButtonElement>('run');
  runButton.disabled = true;
  el('approvals').replaceChildren();

  const client = new Client(
    { name: 'apps-demo-page', version: '0.1.0' },
    {
      capabilities: { elicitation: {} },
      versionNegotiation: { mode: { pin: MRTR_REVISION } },
      inputRequired: { autoFulfill: false },
    },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', location.href)));
  log('host→server', `initialize (pinned ${MRTR_REVISION})`);

  // Fetch the app HTML the way any MCP Apps host does: resources/read.
  const read = await client.readResource({ uri: DASHBOARD_URI });
  const appHtml = (read.contents[0] as { text?: string }).text ?? '';
  log('host→server', `resources/read ${DASHBOARD_URI} (${appHtml.length} bytes)`);
  const app = mountApp(appHtml);
  await app.ready;

  const dir = ((await (await fetch('/config')).json()) as { dir: string }).dir;
  el<HTMLInputElement>('dir').value = dir;
  app.push('ui/notifications/tool-input', { arguments: { code: MACHINE, input: { dir } } });

  // Drive execute_machine through however many MRTR round trips it needs.
  // The MRTR retry fields (requestState / inputResponses) are SIBLINGS of
  // `arguments` in the tools/call params, so the manual legs go through
  // client.request — callTool's typed sugar only models auto-fulfilment.
  let retry: { requestState: string; inputResponses: Record<string, unknown> } | undefined;
  for (;;) {
    log('host→server', 'tools/call execute_machine');
    const result = (await client.request(
      {
        method: 'tools/call',
        params: {
          name: 'execute_machine',
          arguments: { code: MACHINE, input: { dir } },
          ...(retry !== undefined ? retry : {}),
        },
      },
      { allowInputRequired: true },
    )) as {
      resultType?: string;
      inputRequests?: Record<string, { params?: { message?: string } }>;
      requestState?: string;
      isError?: boolean;
    };

    if (result.resultType !== 'input_required') {
      log(
        'server→host',
        result.isError === true ? 'tools/call result (error)' : 'tools/call result (completed)',
      );
      app.push('ui/notifications/tool-result', result);
      runButton.disabled = false;
      return;
    }

    log('server→host', 'input_required (workflow suspended, sealed blob echoed)');
    const responses: Record<string, { action: 'accept' | 'decline' }> = {};
    for (const [key, request] of Object.entries(result.inputRequests ?? {})) {
      const message = request.params?.message ?? '(no message)';
      const action = await askApproval(message);
      responses[key] = action ? { action: 'accept' } : { action: 'decline' };
      log('host→server', `${action ? 'approve' : 'decline'} ${key}`);
    }
    retry = { requestState: result.requestState as string, inputResponses: responses };
  }
}

/** Render one approval prompt and resolve with the human's verdict. */
function askApproval(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const card = document.createElement('div');
    card.className = 'approval';
    const text = document.createElement('pre');
    text.textContent = message;
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    const approve = document.createElement('button');
    approve.textContent = 'Approve';
    approve.className = 'approve';
    const decline = document.createElement('button');
    decline.textContent = 'Decline';
    decline.className = 'decline';
    const finish = (verdict: boolean) => {
      card.classList.add('decided');
      approve.disabled = decline.disabled = true;
      card.dataset['verdict'] = verdict ? 'approved' : 'declined';
      resolve(verdict);
    };
    approve.addEventListener('click', () => finish(true));
    decline.addEventListener('click', () => finish(false));
    buttons.appendChild(approve);
    buttons.appendChild(decline);
    card.appendChild(text);
    card.appendChild(buttons);
    el('approvals').appendChild(card);
    card.scrollIntoView({ behavior: 'smooth' });
  });
}

el<HTMLButtonElement>('run').addEventListener('click', () => {
  void run().catch((err: unknown) => {
    log('error', String(err));
    el<HTMLButtonElement>('run').disabled = false;
  });
});
