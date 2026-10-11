/**
 * The filesystem world: the official filesystem reference server
 * (`@modelcontextprotocol/server-filesystem`, a pinned devDependency)
 * spawned over stdio with one allowed directory — a fresh copy of
 * {@link FILESYSTEM_FIXTURE} per episode — behind a recording proxy.
 *
 * The server's 14 tools include the near-duplicates a model must tell
 * apart: `read_file` (deprecated) vs `read_text_file` vs `read_media_file`
 * vs `read_multiple_files`; `edit_file` (line edits, `dryRun`) vs
 * `write_file` (overwrite); `list_directory` vs `list_directory_with_sizes`
 * vs `directory_tree` vs `search_files`; `move_file` for renames. Writes
 * carry `destructiveHint: true` (`create_directory` does not), so under
 * Projection they ask for approval and the eval's approve-all client
 * answers — the effects then land on the real throwaway tree.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createRecordingProxy } from './recording-proxy.js';
import type { EvalWorld } from './world.js';

const require = createRequire(import.meta.url);

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `count` log lines of about 90 bytes each. */
function logLines(count: number, level: string, path: string): string {
  return (
    Array.from(
      { length: count },
      (_, i) =>
        `2026-10-01T08:${pad2(Math.floor(i / 60))}:${pad2(i % 60)}Z ${level} request id=${1000 + i} ` +
        `path=${path} method=GET status=200 ms=${((i * 7) % 90) + 5}`,
    ).join('\n') + '\n'
  );
}

/** A 1x1 transparent PNG. */
const LOGO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export const FIXTURE_PACKAGE_JSON =
  '{\n  "name": "widgets",\n  "version": "1.2.0",\n  "private": true,\n  "scripts": {\n    "test": "node --test"\n  }\n}\n';
export const FIXTURE_CHANGELOG =
  '# Changelog\n\n## Unreleased\n\n- Add CSV export\n\n## 1.2.0\n\n- Initial public release\n';
export const FIXTURE_TODO = '- buy milk\n- call bob\n- ship v1.2\n';
export const FIXTURE_IDEAS = 'Ideas\n- dark mode\n- plugins\n';
export const FIXTURE_README = '# Widgets\n\nA small demo project.\n\nCurrent version: 1.2.0\n';
export const FIXTURE_UTIL_JS =
  '// Shared helpers.\nexport function greet(name) {\n  return `Hello, ${name}!`;\n}\n\n' +
  "export const defaultColour = 'blue';\nexport function colourOf(item) {\n  return item.colour ?? defaultColour;\n}\n";
export const FIXTURE_APP_LOG = logLines(400, 'info', '/api/items');

/**
 * The fixture tree, relative paths to contents. Deterministic, so every
 * episode starts from the same world and the graders know every byte.
 */
export const FILESYSTEM_FIXTURE: Readonly<Record<string, string | Uint8Array>> = {
  'README.md': FIXTURE_README,
  'package.json': FIXTURE_PACKAGE_JSON,
  'CHANGELOG.md': FIXTURE_CHANGELOG,
  'notes/todo.txt': FIXTURE_TODO,
  'notes/ideas.txt': FIXTURE_IDEAS,
  'src/index.js': "import { greet } from './util.js';\n\nconsole.log(greet('world'));\n",
  'src/util.js': FIXTURE_UTIL_JS,
  'src/legacy/old.js': '// Legacy code, do not touch.\nmodule.exports = {};\n',
  'src/legacy/debug.log': 'legacy debug log\n',
  'config/dev.json': '{\n  "debug": true,\n  "port": 3000\n}\n',
  'config/prod.json': '{\n  "debug": false,\n  "port": 80\n}\n',
  'logs/app.log': FIXTURE_APP_LOG,
  'logs/access.log': logLines(40, 'info', '/'),
  'logs/error.log': logLines(5, 'error', '/api/items'),
  'assets/logo.png': LOGO_PNG,
  'tmp/scratch.txt': 'scratch\n',
  'tmp/draft.md': '# Draft\n',
};

/** Write the fixture tree under `root`. */
export function writeFilesystemFixture(root: string): void {
  for (const [relative, content] of Object.entries(FILESYSTEM_FIXTURE)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

export const FILESYSTEM_DIRECT_SYSTEM_PROMPT =
  "You operate the user's files through the tools provided. Complete the user's task, then stop.";

/** The server's entry point, resolved from the pinned devDependency. */
export function filesystemServerEntry(): string {
  return join(
    dirname(require.resolve('@modelcontextprotocol/server-filesystem/package.json')),
    'dist',
    'index.js',
  );
}

/**
 * A fresh filesystem world: fixture tree in a temp directory, the reference
 * server spawned on it, a recording proxy in front. `close` kills the
 * server and removes the tree.
 */
export async function openFilesystemWorld(): Promise<EvalWorld> {
  // realpath: macOS puts tmpdir under a symlink, and the server compares
  // resolved paths against its allowed directories.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'projection-eval-fs-')));
  writeFilesystemFixture(root);

  const stderr: Buffer[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [filesystemServerEntry(), root],
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  const client = new Client({ name: 'tool-choice-eval', version: '0.0.0' }, { capabilities: {} });
  const close = async (): Promise<void> => {
    await client.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  };
  try {
    await client.connect(transport);
    const proxy = await createRecordingProxy(client, { name: 'filesystem-eval', version: '0.0.0' });
    return {
      name: 'filesystem',
      server: proxy.server,
      tools: proxy.tools,
      instructions: proxy.instructions,
      calls: proxy.calls,
      facts: { root },
      directSystemPrompt: FILESYSTEM_DIRECT_SYSTEM_PROMPT,
      close,
    };
  } catch (err) {
    await close();
    const log = Buffer.concat(stderr).toString('utf8').trim();
    throw new Error(
      `filesystem world: could not start the reference server${log === '' ? '' : `: ${log}`}`,
      { cause: err },
    );
  }
}
