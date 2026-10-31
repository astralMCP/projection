/**
 * The `summit-local` world (the opt-in, held-out `summit-local` tier): six
 * REAL MCP servers, each spawned over stdio on a fresh per-episode fixture
 * and recorded behind a {@link createRecordingProxy}, as boxes under an
 * alias — none of them a fake:
 *
 * | alias    | server (pinned)                                   | runs on                              |
 * | -------- | ------------------------------------------------- | ------------------------------------ |
 * | `fs`     | `@modelcontextprotocol/server-filesystem` 1.0.0   | the tidepool checkout                |
 * | `git`    | `mcp-server-git` 2026.10.19 (Python)              | the same checkout                    |
 * | `memory` | `@modelcontextprotocol/server-memory` 2.0.0       | the team knowledge graph (JSONL)     |
 * | `sqlite` | `mcp-server-sqlite` 2025.4.25 (Python, reference) | the support database                 |
 * | `fetch`  | `mcp-server-fetch` 2026.10.19 (Python)            | a local HTTP intranet (127.0.0.1)    |
 * | `time`   | `mcp-server-time` 2026.10.19 (Python)             | IANA time zone data                  |
 *
 * The npm memory server and the Python servers are vendored in
 * `vendor/servers-real` (package.json + lock, and hash-pinned
 * requirements*.txt installed into two venvs) by `pnpm run
 * setup:servers-real`; the filesystem server is the workspace's pinned
 * devDependency. {@link summitServersInstalled} says whether the vendored
 * servers are there; the world throws a clear error, and its tests skip,
 * when they are not. Each server's reported name and version is checked
 * against {@link SUMMIT_SERVER_VERSIONS}, and its tool list against
 * {@link SUMMIT_EXPECTED_TOOLS}, so an upgrade or a changed environment
 * cannot silently change what the tier measures.
 *
 * Offline by construction: the fetch server runs with an unreachable proxy
 * for every host but the loopback intranet (it is started with
 * `--allow-private-ips` so it may reach 127.0.0.1 at all, and
 * `--ignore-robots-txt` since the intranet has none), and without Node on
 * its PATH so its HTML extraction uses readabilipy's pure-Python path
 * rather than running `npm install` on first use. The git server runs with
 * a private HOME and no system or global git config. The time server's
 * conversions use today's date, so the tasks only convert between zones
 * without daylight saving time.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { SideEffect } from '../types.js';
import { filesystemServerEntry } from './filesystem-world.js';
import { qualifiedName } from './multi-world.js';
import { createRecordingProxy } from './recording-proxy.js';
import {
  BRANCHES,
  CHECKOUT_USER,
  COMMIT_AUTHORS,
  CULPRIT_COMMIT,
  INITIAL_REPO_STATE,
  intranetPages,
  MAIN_COMMITS,
  memoryJsonl,
  renderRepo,
  SQLITE_SEED,
  STAGED_PATH,
  TAGS,
  UNSTAGED_PATH,
  UNTRACKED_PATH,
  workingTreeEdits,
  type CommitSpec,
  type RepoState,
} from './summit-local-fixtures.js';
import type {
  MultiWorld,
  ServerWorld,
  SummitBoxAlias,
  WorldBox,
  WorldFacts,
  WorldOptions,
  WorldTool,
} from './world.js';

/** The boxes in shelf (alias) order. */
export const SUMMIT_BOXES: readonly SummitBoxAlias[] = [
  'fetch',
  'fs',
  'git',
  'memory',
  'sqlite',
  'time',
];

/**
 * What each server reports in `initialize` (`serverInfo`), and the package
 * pin it comes from. The reference SQLite server reports its own internal
 * version (0.1.0), not the PyPI release's.
 */
export const SUMMIT_SERVER_VERSIONS: Readonly<
  Record<SummitBoxAlias, { package: string; name: string; version: string }>
> = {
  fs: {
    package: '@modelcontextprotocol/server-filesystem@1.0.0',
    name: 'secure-filesystem-server',
    version: '',
  },
  git: { package: 'mcp-server-git==2026.10.19', name: 'mcp-git', version: '2026.10.19' },
  memory: {
    package: '@modelcontextprotocol/server-memory@2.0.0',
    name: 'memory-server',
    version: '2.0.0',
  },
  sqlite: { package: 'mcp-server-sqlite==2025.4.25', name: 'sqlite', version: '0.1.0' },
  fetch: { package: 'mcp-server-fetch==2026.10.19', name: 'mcp-fetch', version: '2026.10.19' },
  time: { package: 'mcp-server-time==2026.10.19', name: 'mcp-time', version: '2026.10.19' },
};

/** Exactly the tools each server must list (sorted). */
export const SUMMIT_EXPECTED_TOOLS: Readonly<Record<SummitBoxAlias, readonly string[]>> = {
  fs: [
    'create_directory',
    'directory_tree',
    'edit_file',
    'get_file_info',
    'list_allowed_directories',
    'list_directory',
    'list_directory_with_sizes',
    'move_file',
    'read_file',
    'read_media_file',
    'read_multiple_files',
    'read_text_file',
    'search_files',
    'write_file',
  ],
  git: [
    'git_add',
    'git_branch',
    'git_checkout',
    'git_commit',
    'git_create_branch',
    'git_diff',
    'git_diff_staged',
    'git_diff_unstaged',
    'git_log',
    'git_reset',
    'git_show',
    'git_status',
  ],
  memory: [
    'add_observations',
    'create_entities',
    'create_relations',
    'delete_entities',
    'delete_observations',
    'delete_relations',
    'open_nodes',
    'read_graph',
    'search_nodes',
  ],
  sqlite: [
    'append_insight',
    'create_table',
    'describe_table',
    'list_tables',
    'read_query',
    'write_query',
  ],
  fetch: ['fetch'],
  time: ['convert_time', 'get_current_time'],
};

/** The tools that change a box's world, by box (`isBoxWrite`). */
export const SUMMIT_WRITE_TOOLS: Readonly<Record<SummitBoxAlias, readonly string[]>> = {
  fs: ['write_file', 'edit_file', 'move_file', 'create_directory'],
  git: ['git_add', 'git_commit', 'git_reset', 'git_checkout', 'git_create_branch'],
  memory: [
    'create_entities',
    'create_relations',
    'add_observations',
    'delete_entities',
    'delete_observations',
    'delete_relations',
  ],
  sqlite: ['write_query', 'create_table', 'append_insight'],
  fetch: [],
  time: [],
};

/** The user's own time zone (the time server's `--local-timezone`). */
export const SUMMIT_LOCAL_TIMEZONE = 'America/Phoenix';

/** Host box descriptions (PROJ_EVAL_BOX_DESCRIPTIONS=1): one line each, equally specific. */
export const SUMMIT_BOX_DESCRIPTIONS: Readonly<Record<SummitBoxAlias, string>> = {
  fs: "Files in the user's tidepool checkout: read, search and edit",
  git: "Git history, branches and commits of the user's tidepool checkout",
  memory: "The team's knowledge graph: people, teams, services and how they relate",
  sqlite: 'The support database: customers, tickets, comments, invoices and deploys',
  fetch: 'Web pages and JSON from the team intranet: status, team, on-call, releases, incidents',
  time: 'The current time in any time zone, and conversions between time zones',
};

/** The world's host framing: what the host connects and where. */
export function summitHostSystemPrompt(facts: { root: string; intranet: string }): string {
  return (
    `You operate the user's tidepool checkout at ${facts.root} (its files and its git repository), ` +
    `the team's knowledge graph, the support database, the team intranet at ${facts.intranet} ` +
    "and a time zone tool through the tools provided. Complete the user's task, then stop."
  );
}

// ---------------------------------------------------------------------------
// The vendored servers

const VENDOR = join('vendor', 'servers-real');

/** The harness package root, found by walking up from this module (src/eval/ or dist/). */
function harnessRoot(from: string = dirname(fileURLToPath(import.meta.url))): string | undefined {
  let dir = from;
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(resolve(dir, VENDOR, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return undefined;
}

export interface SummitServerPaths {
  memory: string;
  pythonBin: string;
  sqliteBin: string;
}

const NOT_INSTALLED =
  'summit-local world: the vendored MCP servers are not installed; run `pnpm run setup:servers-real` in packages/harness (needs npm and uv)';

/** Absolute paths of the vendored servers; throws {@link NOT_INSTALLED} when any is missing. */
export function summitServerPaths(): SummitServerPaths {
  const root = harnessRoot();
  if (root === undefined) throw new Error(NOT_INSTALLED);
  const vendor = resolve(root, VENDOR);
  const paths = {
    memory: join(
      vendor,
      'node_modules',
      '@modelcontextprotocol',
      'server-memory',
      'dist',
      'index.js',
    ),
    pythonBin: join(vendor, '.venv', 'bin'),
    sqliteBin: join(vendor, '.venv-sqlite', 'bin'),
  };
  const needed = [
    paths.memory,
    join(paths.pythonBin, 'mcp-server-git'),
    join(paths.pythonBin, 'mcp-server-fetch'),
    join(paths.pythonBin, 'mcp-server-time'),
    join(paths.sqliteBin, 'mcp-server-sqlite'),
  ];
  const missing = needed.filter((p) => !existsSync(p));
  if (missing.length > 0) throw new Error(`${NOT_INSTALLED}; missing: ${missing.join(', ')}`);
  return paths;
}

/** Whether {@link summitServerPaths} would succeed (and `git` is on PATH). */
export function summitServersInstalled(): boolean {
  try {
    summitServerPaths();
    gitBinary();
    return true;
  } catch {
    return false;
  }
}

/** The `git` executable on PATH. */
export function gitBinary(): string {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, 'git');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('summit-local world: `git` is not on PATH');
}

// ---------------------------------------------------------------------------
// Seeding

/** Environment for every git invocation: no user, system or global config. */
function gitEnv(home: string): Record<string, string> {
  return {
    PATH: [dirname(gitBinary()), '/usr/bin', '/bin'].join(delimiter),
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C',
  };
}

export function git(root: string, home: string, args: string[], input?: string): string {
  return execFileSync(gitBinary(), args, {
    cwd: root,
    env: gitEnv(home),
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function timestamp(date: string, tz: string): number {
  const sign = tz.startsWith('-') ? -1 : 1;
  const minutes = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  return Date.parse(`${date}T10:00:00Z`) / 1000 - minutes * 60;
}

function data(text: string): string {
  return `data ${Buffer.byteLength(text, 'utf8')}\n${text}\n`;
}

/**
 * The fast-import stream for the whole history: `main`, then each branch
 * from its base, then the tags. Fixed identities and dates, so the commit
 * hashes are the same on every machine and every episode.
 */
export function fastImportStream(): string {
  const out: string[] = [];
  const marks = new Map<string, number>();
  const states = new Map<string, RepoState>();
  let next = 1;
  const emit = (
    ref: string,
    commit: CommitSpec,
    parent: string | undefined,
    before: RepoState,
  ): RepoState => {
    const after = structuredClone(before);
    commit.change(after);
    const prev = parent === undefined ? {} : renderRepo(before);
    const files = renderRepo(after);
    const who = COMMIT_AUTHORS[commit.author];
    if (who === undefined) throw new Error(`no git identity for ${commit.author}`);
    const ident = `${who.name} <${who.email}> ${timestamp(commit.date, who.tz)} ${who.tz}`;
    const mark = next;
    next += 1;
    marks.set(commit.key, mark);
    out.push(
      `commit ${ref}\nmark :${mark}\nauthor ${ident}\ncommitter ${ident}\n${data(`${commit.message}\n`)}`,
    );
    if (parent !== undefined) out.push(`from :${marks.get(parent) as number}\n`);
    for (const path of Object.keys(prev)) if (!(path in files)) out.push(`D ${path}\n`);
    for (const [path, content] of Object.entries(files)) {
      if ((prev as Record<string, string>)[path] !== content)
        out.push(`M 100644 inline ${path}\n${data(content)}`);
    }
    out.push('\n');
    states.set(commit.key, after);
    return after;
  };
  let state = structuredClone(INITIAL_REPO_STATE);
  let parent: string | undefined;
  for (const commit of MAIN_COMMITS) {
    state = emit('refs/heads/main', commit, parent, state);
    parent = commit.key;
  }
  for (const branch of BRANCHES) {
    if (branch.commits.length === 0) {
      out.push(`reset refs/heads/${branch.name}\nfrom :${marks.get(branch.from) as number}\n\n`);
      continue;
    }
    let base = states.get(branch.from) as RepoState;
    let from: string = branch.from;
    for (const commit of branch.commits) {
      base = emit(`refs/heads/${branch.name}`, commit, from, base);
      from = commit.key;
    }
  }
  for (const [tag, key] of Object.entries(TAGS))
    out.push(`reset refs/tags/${tag}\nfrom :${marks.get(key) as number}\n\n`);
  return out.join('');
}

/** Every commit key's full hash. */
export type CommitHashes = Readonly<Record<string, string>>;

/**
 * Build the tidepool checkout in `root` (an empty directory): the history,
 * `main` checked out, the repo-local identity, then the working tree edits
 * (one staged, one unstaged, one untracked file).
 */
export function buildCheckout(root: string, home: string): CommitHashes {
  git(root, home, ['init', '-q', '-b', 'main']);
  git(root, home, ['fast-import', '--quiet'], fastImportStream());
  git(root, home, ['reset', '-q', '--hard', 'main']);
  git(root, home, ['config', 'user.name', CHECKOUT_USER.name]);
  git(root, home, ['config', 'user.email', CHECKOUT_USER.email]);
  const edits = workingTreeEdits();
  writeFileSync(join(root, STAGED_PATH), edits.staged);
  git(root, home, ['add', '--', STAGED_PATH]);
  writeFileSync(join(root, UNSTAGED_PATH), edits.unstaged);
  mkdirSync(join(root, dirname(UNTRACKED_PATH)), { recursive: true });
  writeFileSync(join(root, UNTRACKED_PATH), edits.untracked);
  const hashes: Record<string, string> = {};
  const refs = [
    ['main', MAIN_COMMITS.length],
    ...BRANCHES.filter((b) => b.commits.length > 0).map((b) => [b.name, b.commits.length] as const),
  ] as const;
  for (const [ref, length] of refs) {
    const shas = git(root, home, ['rev-list', '--first-parent', `-n${length}`, ref])
      .trim()
      .split('\n');
    const keys =
      ref === 'main'
        ? MAIN_COMMITS.map((x) => x.key)
        : (BRANCHES.find((b) => b.name === ref) as (typeof BRANCHES)[number]).commits.map(
            (x) => x.key,
          );
    keys.toReversed().forEach((key, i) => {
      hashes[key] = shas[i] as string;
    });
  }
  return hashes;
}

/**
 * Run SQL against the episode's database with the sqlite venv's Python
 * (whose `sqlite3` module is what the server itself uses): `script`
 * executes a script, `query` returns the rows as objects.
 */
const SQLITE_PY = `
import json, sqlite3, sys
mode, path = sys.argv[1], sys.argv[2]
sql = sys.stdin.read()
con = sqlite3.connect(path)
con.row_factory = sqlite3.Row
if mode == "script":
    con.executescript(sql)
    con.commit()
    print("[]")
else:
    print(json.dumps([dict(r) for r in con.execute(sql).fetchall()]))
con.close()
`;

export function sqliteRun(
  dbPath: string,
  mode: 'script' | 'query',
  sql: string,
): Record<string, unknown>[] {
  const python = join(summitServerPaths().sqliteBin, 'python');
  const out = execFileSync(python, ['-I', '-c', SQLITE_PY, mode, dbPath], {
    input: sql,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out) as Record<string, unknown>[];
}

/** The rows of `table` in the episode's database, ordered by their first column. */
export function sqliteTable(facts: WorldFacts, table: string): Record<string, unknown>[] {
  if (facts.sqliteDb === undefined)
    throw new Error('summit-local task verified without a database');
  if (!/^[a-z_]+$/.test(table)) throw new Error(`bad table name ${table}`);
  return sqliteRun(facts.sqliteDb, 'query', `SELECT * FROM ${table} ORDER BY 1`);
}

/** Serve the intranet on a free loopback port. */
export async function startIntranet(
  pages: ReturnType<typeof intranetPages>,
): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname;
    const page = pages[path];
    if (page === undefined || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><head><title>Not found</title></head><body><h1>404 Not found</h1></body></html>\n',
      );
      return;
    }
    const { status, body } =
      typeof page.body === 'string'
        ? { status: 200, body: page.body }
        : page.body(url.searchParams);
    res.writeHead(status, { 'content-type': `${page.type}; charset=utf-8` });
    res.end(body);
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

// ---------------------------------------------------------------------------
// The boxes

interface Spawn {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

/** One real server behind a recording proxy, its identity and tool list checked. */
async function openBox(
  alias: SummitBoxAlias,
  spawn: Spawn,
  facts: WorldFacts,
  hostSystemPrompt: string,
  onCall: (call: SideEffect) => void,
): Promise<ServerWorld> {
  const stderr: Buffer[] = [];
  let started = false;
  const client = new Client({ name: 'tool-choice-eval', version: '0.0.0' }, { capabilities: {} });
  const close = async (): Promise<void> => {
    await client.close().catch(() => {});
  };
  try {
    const transport = new StdioClientTransport({ ...spawn, stderr: 'pipe' });
    transport.stderr?.on('data', (chunk: Buffer) => {
      if (!started) stderr.push(chunk);
    });
    await client.connect(transport);
    started = true;
    const expected = SUMMIT_SERVER_VERSIONS[alias];
    const info = client.getServerVersion();
    if (
      info?.name !== expected.name ||
      (expected.version !== '' && info.version !== expected.version)
    ) {
      throw new Error(
        `summit-local world: box ${alias} reported ${info?.name}@${info?.version}, expected ${expected.name}@${expected.version} (${expected.package})`,
      );
    }
    const proxy = await createRecordingProxy(
      client,
      { name: `${alias}-eval`, version: '0.0.0' },
      { onCall },
    );
    const listed = proxy.tools.map((tool) => tool.name).toSorted();
    const want = SUMMIT_EXPECTED_TOOLS[alias];
    if (JSON.stringify(listed) !== JSON.stringify(want)) {
      throw new Error(
        `summit-local world: box ${alias} listed [${listed.join(', ')}], expected [${want.join(', ')}]`,
      );
    }
    return {
      name: alias === 'fs' ? 'filesystem' : alias,
      server: proxy.server,
      tools: proxy.tools,
      instructions: proxy.instructions,
      calls: proxy.calls,
      facts,
      hostSystemPrompt,
      close,
    };
  } catch (err) {
    await close();
    if (started) throw err;
    const log = Buffer.concat(stderr).toString('utf8').trim();
    throw new Error(
      `summit-local world: could not start box ${alias}${log === '' ? '' : `: ${log}`}`,
      {
        cause: err,
      },
    );
  }
}

function spawns(
  paths: SummitServerPaths,
  facts: Required<Pick<WorldFacts, 'root' | 'intranet' | 'memoryFile' | 'sqliteDb'>>,
  home: string,
): Record<SummitBoxAlias, Spawn> {
  const base = { HOME: home, LANG: 'C.UTF-8', TMPDIR: home };
  const py = { ...base, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' };
  return {
    fs: {
      command: process.execPath,
      args: [filesystemServerEntry(), facts.root],
      env: { ...base, PATH: dirname(process.execPath) },
    },
    memory: {
      command: process.execPath,
      args: [paths.memory],
      env: { ...base, PATH: dirname(process.execPath), MEMORY_FILE_PATH: facts.memoryFile },
    },
    git: {
      command: join(paths.pythonBin, 'mcp-server-git'),
      args: ['--repository', facts.root],
      env: { ...py, ...gitEnv(home), GIT_PYTHON_GIT_EXECUTABLE: gitBinary() },
    },
    sqlite: {
      command: join(paths.sqliteBin, 'mcp-server-sqlite'),
      args: ['--db-path', facts.sqliteDb],
      env: { ...py, PATH: paths.sqliteBin },
    },
    fetch: {
      command: join(paths.pythonBin, 'mcp-server-fetch'),
      args: ['--ignore-robots-txt', '--allow-private-ips'],
      env: {
        ...py,
        // No Node: readabilipy's pure-Python extractor, never an `npm install`.
        PATH: paths.pythonBin,
        // Nothing but the loopback intranet is reachable.
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        ALL_PROXY: 'http://127.0.0.1:9',
        NO_PROXY: '127.0.0.1,localhost',
      },
    },
    time: {
      command: join(paths.pythonBin, 'mcp-server-time'),
      args: ['--local-timezone', SUMMIT_LOCAL_TIMEZONE],
      env: { ...py, PATH: paths.pythonBin },
    },
  };
}

/**
 * A fresh summit-local world: a temp directory holding the checkout, the
 * graph file and the database, the intranet on a loopback port, and the six
 * servers spawned on them. `close` stops every server, the intranet, and
 * removes the directory. If any box fails to open, everything is torn down
 * and the first failure is thrown.
 */
export async function openSummitLocalWorld(
  options: Pick<WorldOptions, 'onCall'> = {},
): Promise<MultiWorld> {
  const paths = summitServerPaths();
  // A neutral prefix: the system prompt carries this path.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tidepool-')));
  const boxes: WorldBox[] = [];
  let intranet: Awaited<ReturnType<typeof startIntranet>> | undefined;
  const close = async (): Promise<void> => {
    await Promise.all(boxes.map((box) => box.world.close().catch(() => {})));
    await intranet?.close().catch(() => {});
    rmSync(base, { recursive: true, force: true });
  };
  try {
    const root = join(base, 'tidepool');
    const home = join(base, 'home');
    mkdirSync(root);
    mkdirSync(home);
    writeFileSync(join(home, '.gitconfig'), '');
    const hashes = buildCheckout(root, home);
    const memoryFile = join(base, 'memory.jsonl');
    writeFileSync(memoryFile, memoryJsonl());
    const sqliteDb = join(base, 'support.db');
    sqliteRun(sqliteDb, 'script', SQLITE_SEED);
    intranet = await startIntranet(intranetPages((hashes[CULPRIT_COMMIT] as string).slice(0, 7)));
    const facts: WorldFacts = {
      root,
      intranet: intranet.url,
      memoryFile,
      sqliteDb,
      gitHome: home,
      commits: hashes,
    };
    const hostSystemPrompt = summitHostSystemPrompt({ root, intranet: intranet.url });

    const calls: SideEffect[] = [];
    const recorder =
      (alias: SummitBoxAlias) =>
      (call: SideEffect): void => {
        const qualified = { tool: qualifiedName(alias, call.tool), args: call.args };
        calls.push(qualified);
        options.onCall?.(qualified);
      };
    const plan = spawns(paths, { root, intranet: intranet.url, memoryFile, sqliteDb }, home);
    const opened = await Promise.allSettled(
      SUMMIT_BOXES.map((alias) =>
        openBox(alias, plan[alias], facts, hostSystemPrompt, recorder(alias)),
      ),
    );
    const failures: unknown[] = [];
    opened.forEach((result, i) => {
      const alias = SUMMIT_BOXES[i] as SummitBoxAlias;
      if (result.status === 'fulfilled') {
        boxes.push({ alias, world: result.value, description: SUMMIT_BOX_DESCRIPTIONS[alias] });
      } else failures.push(result.reason);
    });
    if (failures.length > 0) throw failures[0];

    const tools: WorldTool[] = boxes.flatMap((box) =>
      box.world.tools.map((tool) => ({ ...tool, name: qualifiedName(box.alias, tool.name) })),
    );
    return {
      name: 'summit-local',
      boxes,
      tools,
      instructions: undefined,
      calls,
      facts,
      hostSystemPrompt,
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}
