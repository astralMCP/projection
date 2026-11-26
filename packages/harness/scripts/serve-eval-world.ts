/**
 * Serve one eval episode's surface over stdio, for agent-host runs (a T3
 * thread, Claude Code) instead of the API-driven agent loop:
 *
 *   unrun scripts/serve-eval-world.ts --world github --mode projection-psychoscript \
 *     --log-dir /abs/logs [--force-code-mode]
 *
 * Each process opens a fresh world and the mode's session over it (the same
 * `openSession` the live eval uses, so approvals are answered by the default
 * approve-all persona and the facade's instructions become this server's),
 * then lists exactly the session's tools and forwards each call. After every
 * call it rewrites `<log-dir>/<basename(cwd)>-<pid>.json` with what reached
 * the world (`calls`, what the tasks score), the tool calls the agent made,
 * and the approval and round-trip counts. The agent host starts the server
 * in its working directory, so a per-episode worktree names the log.
 *
 * No API calls: the model is the host's.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  FORCE_CODE_MODE_LINE,
  openSession,
  openWorld,
  resolveModes,
  type WorldName,
} from '../src/index.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const MAX_PREVIEW = 2_000;

async function main(): Promise<void> {
  const worldName = (arg('world') ?? 'github') as WorldName;
  const [mode] = resolveModes(arg('mode') ?? 'projection');
  const logDir = arg('log-dir');
  if (mode === undefined || logDir === undefined) {
    throw new Error('usage: serve-eval-world --world <name> --mode <mode> --log-dir <dir>');
  }
  mkdirSync(logDir, { recursive: true });
  // The host starts the server in the episode's worktree; a wrapper that
  // has to run from the harness directory passes that name in EVAL_EPISODE.
  const episode = process.env['EVAL_EPISODE'] ?? basename(process.cwd());
  const logPath = join(logDir, `${episode}-${process.pid}.json`);

  const world = await openWorld(worldName);
  const session = await openSession(
    mode,
    world,
    process.argv.includes('--force-code-mode') ? { systemSuffix: FORCE_CODE_MODE_LINE } : {},
  );
  const toolCalls: { name: string; args: unknown; isError: boolean; text: string }[] = [];
  const startedAt = new Date().toISOString();
  const writeLog = (): void => {
    writeFileSync(
      logPath,
      JSON.stringify(
        {
          world: worldName,
          mode,
          episode,
          startedAt,
          updatedAt: new Date().toISOString(),
          facts: world.facts,
          calls: world.calls,
          toolCalls,
          approvals: session.approvals,
          roundTrips: session.roundTrips ?? 0,
        },
        null,
        2,
      ),
    );
  };
  writeLog();

  const server = new McpServer(
    { name: 'eval', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: session.runtime.system },
  );
  server.server.setRequestHandler('tools/list', () => ({
    tools: session.runtime.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })) as never,
  }));
  server.server.setRequestHandler('tools/call', async (request) => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = await session.runtime.call(name, args);
    toolCalls.push({
      name,
      args,
      isError: result.isError === true,
      text: result.text.slice(0, MAX_PREVIEW),
    });
    writeLog();
    return {
      content: [{ type: 'text' as const, text: result.text }],
      ...(result.isError === true ? { isError: true } : {}),
    } as never;
  });

  serveStdio(() => server);
  // The log is current after every call; not rewritten here, so moving a
  // finished batch's logs aside is not undone when its servers exit.
  const close = async (): Promise<void> => {
    await session.close();
    await world.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void close());
  process.on('SIGINT', () => void close());
  process.stdin.on('end', () => void close());
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
