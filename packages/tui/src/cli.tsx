/**
 * `mccircuit-tui` entry point — wraps the demo file server and drives it
 * with a live Anthropic author. Doubles as the team demo surface (PRD §13).
 *
 * Needs ANTHROPIC_API_KEY. Set MCC_BENCH_MODEL to change the model.
 */

import { randomBytes } from 'node:crypto';
import { render } from 'ink';
import { buildApiDocs, createAnthropicAuthor, createFileServer } from '@mccircuit/harness';
import { wrapMcpServer } from 'mccircuit';
import { App } from './app.js';

async function main(): Promise<void> {
  if ((process.env['ANTHROPIC_API_KEY'] ?? '') === '') {
    console.error('mccircuit-tui needs ANTHROPIC_API_KEY set (the model authors the machines).');
    process.exitCode = 1;
    return;
  }

  const recording = createFileServer({
    '/notes.txt': 'welcome to the McCircuit demo',
    '/todo.txt': '- try the TUI',
  });
  const facade = await wrapMcpServer(recording.server, { blob: { key: randomBytes(32) } });
  const model = process.env['MCC_BENCH_MODEL'];
  const author = createAnthropicAuthor(model !== undefined ? { model } : {});

  const { waitUntilExit } = render(
    <App
      facade={facade}
      author={author}
      apiDocs={buildApiDocs(facade)}
      serverLabel="demo-files (in-memory)"
    />,
  );
  try {
    await waitUntilExit();
  } finally {
    await facade.close();
  }
}

await main();
