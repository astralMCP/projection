/**
 * MCP Apps workflow dashboard (PRD §12.1, second fenced use case).
 *
 * A static, library-authored HTML app that renders an `execute_machine`
 * result — output, approval audit trail, console logs, or the structured
 * error — inside the host's sandboxed iframe, per the MCP Apps extension
 * (SEP-1865, spec 2026-01-26).
 *
 * Security posture (the §12.1 design constraint, satisfied by construction):
 * - The HTML is a compile-time constant. No model-authored code, no
 *   template interpolation, no VM: UI rendering can never reach the tools
 *   bridge because nothing dynamic executes server-side at all.
 * - Model-controlled data (outputs, audit args, log lines, error text)
 *   enters the DOM exclusively through `textContent` — the app never uses
 *   innerHTML — so hostile strings render inert (S6 extended to the app).
 * - The app requests no host capabilities: `appCapabilities: {}`. It cannot
 *   call tools, open links, or write context; it only listens.
 *
 * Wire contract implemented (app side):
 * - `ui/initialize` request → await result → `ui/notifications/initialized`.
 * - Listens for `ui/notifications/tool-input`, `ui/notifications/tool-result`
 *   and `ui/notifications/tool-cancelled`; ignores everything else.
 * - The result payload is the standard `CallToolResult` from
 *   `execute_machine`: `structuredContent` is either
 *   `{ output, approvals, logs }` or (with `isError`) the structured error
 *   `{ phase, message, hint, logs }`.
 */

/** URI the dashboard is served under. MCP Apps mandates the ui:// scheme. */
export const DASHBOARD_RESOURCE_URI = 'ui://projection/dashboard.html';

/** MIME type the MCP Apps spec mandates for app HTML resources. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Projection workflow dashboard</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #1a1a2e; --muted: #6b7280; --line: #e5e7eb;
    --ok: #047857; --ok-bg: #ecfdf5; --err: #b91c1c; --err-bg: #fef2f2;
    --chip: #eef2ff; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #111318; --fg: #e5e7eb; --muted: #9ca3af; --line: #2a2f3a;
      --ok: #34d399; --ok-bg: #06281f; --err: #f87171; --err-bg: #2d1215;
      --chip: #1e2433;
    }
  }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 system-ui, sans-serif; }
  main { padding: 16px; max-width: 720px; }
  h1 { font-size: 15px; margin: 0 0 12px; display: flex; gap: 8px; align-items: center; }
  .chip { font-size: 12px; padding: 2px 10px; border-radius: 999px; background: var(--chip); }
  .chip.ok { color: var(--ok); background: var(--ok-bg); }
  .chip.err { color: var(--err); background: var(--err-bg); }
  section { margin: 14px 0; }
  section > h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--muted); margin: 0 0 6px; }
  pre { margin: 0; padding: 10px; background: var(--chip); border-radius: 8px;
    font-family: var(--mono); font-size: 12px; overflow-x: auto; white-space: pre-wrap; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line);
    vertical-align: top; }
  th { color: var(--muted); font-weight: 500; }
  td.args { font-family: var(--mono); font-size: 12px; }
  .log { font-family: var(--mono); font-size: 12px; padding: 2px 0; }
  .log .level { color: var(--muted); margin-right: 6px; }
  .hint { color: var(--muted); font-size: 13px; margin-top: 6px; }
  .hidden { display: none; }
  #waiting { color: var(--muted); }
</style>
</head>
<body>
<main>
  <h1>Projection workflow <span id="status" class="chip">waiting…</span></h1>
  <p id="waiting">Waiting for the workflow result from the host…</p>
  <section id="output-section" class="hidden"><h2>Output</h2><pre id="output"></pre></section>
  <section id="error-section" class="hidden"><h2>Error</h2>
    <pre id="error"></pre><p id="error-hint" class="hint"></p></section>
  <section id="approvals-section" class="hidden"><h2>Approval audit trail</h2>
    <table><thead><tr><th>Tool</th><th>Decision</th><th>Arguments</th></tr></thead>
    <tbody id="approvals"></tbody></table></section>
  <section id="logs-section" class="hidden"><h2>Console</h2><div id="logs"></div></section>
</main>
<script>
'use strict';
(function () {
  var nextId = 1;
  var pending = new Map();

  function post(message) { window.parent.postMessage(message, '*'); }
  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending.set(id, { resolve: resolve, reject: reject });
      post({ jsonrpc: '2.0', id: id, method: method, params: params });
    });
  }
  function notify(method, params) {
    var message = { jsonrpc: '2.0', method: method };
    if (params !== undefined) message.params = params;
    post(message);
  }

  function byId(id) { return document.getElementById(id); }
  function show(id) { byId(id).classList.remove('hidden'); }
  function setStatus(text, cls) {
    var chip = byId('status');
    chip.textContent = text;
    chip.className = 'chip' + (cls ? ' ' + cls : '');
    byId('waiting').classList.add('hidden');
  }
  function pretty(value) {
    try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
  }

  // All model-controlled data enters the DOM via textContent only.
  function renderResult(result) {
    var structured = (result && result.structuredContent) || {};
    if (result && result.isError) {
      setStatus('failed: ' + String(structured.phase || 'error'), 'err');
      byId('error').textContent =
        String(structured.message || 'unknown error');
      byId('error-hint').textContent = String(structured.hint || '');
      show('error-section');
    } else {
      setStatus('completed', 'ok');
      byId('output').textContent = pretty(
        structured.output === undefined ? null : structured.output,
      );
      show('output-section');
    }
    var approvals = Array.isArray(structured.approvals) ? structured.approvals : [];
    if (approvals.length > 0) {
      var tbody = byId('approvals');
      approvals.forEach(function (entry) {
        var row = document.createElement('tr');
        var tool = document.createElement('td');
        tool.textContent = String(entry.tool || '');
        var decision = document.createElement('td');
        decision.textContent = String(entry.decision || '');
        var args = document.createElement('td');
        args.className = 'args';
        args.textContent = pretty(entry.args || {});
        row.appendChild(tool); row.appendChild(decision); row.appendChild(args);
        tbody.appendChild(row);
      });
      show('approvals-section');
    }
    var logs = Array.isArray(structured.logs) ? structured.logs : [];
    if (logs.length > 0) {
      var list = byId('logs');
      logs.forEach(function (entry) {
        var line = document.createElement('div');
        line.className = 'log';
        var level = document.createElement('span');
        level.className = 'level';
        level.textContent = '[' + String(entry.level || 'log') + ']';
        line.appendChild(level);
        line.appendChild(document.createTextNode(String(entry.message || '')));
        list.appendChild(line);
      });
      show('logs-section');
    }
  }

  window.addEventListener('message', function (event) {
    // Only the embedding host may speak: forged tool-results from a hostile
    // embedder could otherwise spoof the displayed audit trail.
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && message.method === undefined) {
      var waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error) waiter.reject(message.error);
        else waiter.resolve(message.result);
      }
      return;
    }
    if (message.method === 'ui/notifications/tool-input') {
      setStatus('running…');
      return;
    }
    if (message.method === 'ui/notifications/tool-result') {
      renderResult(message.params);
      return;
    }
    if (message.method === 'ui/notifications/tool-cancelled') {
      var reason = message.params && message.params.reason;
      setStatus('cancelled', 'err');
      byId('error').textContent = String(reason || 'cancelled by the host');
      show('error-section');
      return;
    }
    // Host -> app REQUESTS (id + method) get an empty result: answers ping
    // and ui/resource-teardown so hosts don't stall on their SHOULD-wait.
    if (message.id !== undefined && message.method !== undefined) {
      post({ jsonrpc: '2.0', id: message.id, result: {} });
    }
  });

  // Handshake: initialize, then signal readiness. The host MUST NOT push
  // tool data before ui/notifications/initialized.
  request('ui/initialize', { appCapabilities: {} }).then(function () {
    notify('ui/notifications/initialized');
  });
})();
</script>
</body>
</html>
`;
