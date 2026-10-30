/**
 * The MongoDB world: the official MongoDB MCP server (`mongodb-mcp-server`,
 * pinned in `vendor/mongodb-mcp-server` — its dependency tree needs a newer
 * `@modelcontextprotocol/server` than the workspace pins, so it is installed
 * in isolation with `pnpm run setup:mongodb`) spawned over stdio against a
 * throwaway `mongod` (`mongodb-memory-server`, one process per episode)
 * seeded with {@link MONGODB_FIXTURE}, behind a recording proxy.
 *
 * What makes it a good eval target: 21 tools after the ones that reach
 * outside the deployment are disabled (`connect`, `disconnect`, `export`,
 * the knowledge-base search tools, `mongodb-logs`, and the `atlas` and
 * `atlas-local` categories), every one of which requires an opaque
 * `connectionId` argument whose only valid value here is the string
 * `"preconfigured"` (the schema says so; a model that guesses gets a
 * validation error); near-duplicates (`count` vs `find` vs `aggregate`;
 * `update-many` vs `delete-many` vs `drop-collection`; `collection-schema`
 * vs `find`); and JSON filters, sorts and pipelines as arguments. Writes
 * carry `readOnlyHint: false` (drop/delete/rename/update also
 * `destructiveHint: true`), so under Projection they ask for approval and
 * the eval's approve-all client answers. The server's own confirmation
 * prompts (`confirmationRequiredTools`) need a client with elicitation,
 * which neither mode advertises upstream, so they never fire; Projection is
 * the only gate, as in a real deployment.
 *
 * The server is spawned with a minimal environment — `PATH`, `HOME`,
 * `TMPDIR` and the connection string — never the inherited `MDB_MCP_*`
 * variables: a stray `MDB_MCP_READ_ONLY=true` would silently yield a
 * 12-tool read-only server, and Atlas credentials would enable Atlas tools
 * under approve-all. The tool set is then asserted to be exactly
 * {@link MONGODB_EXPECTED_TOOLS}, so configuration drift can never run the
 * eval against a different surface.
 *
 * The `mongod` binary (MongoDB {@link MONGODB_VERSION}, ~80 MB) is
 * downloaded once into `MONGOMS_DOWNLOAD_DIR` (default
 * `~/.cache/mongodb-binaries`) and reused.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createRecordingProxy } from './recording-proxy.js';
import type { ServerWorld, WorldFacts, WorldOptions } from './world.js';

/**
 * The MongoDB server version `mongodb-memory-server` downloads and runs.
 * The CI cache key in `.github/workflows/ci.yml` must name the same version.
 */
export const MONGODB_VERSION = '8.2.6';

/** Where the `mongod` binary is cached (shared across checkouts). */
export function mongodbBinaryDir(): string {
  return process.env['MONGOMS_DOWNLOAD_DIR'] ?? join(homedir(), '.cache', 'mongodb-binaries');
}

const VENDOR_ENTRY = join(
  'vendor',
  'mongodb-mcp-server',
  'node_modules',
  'mongodb-mcp-server',
  'dist',
  'esm',
  'index.js',
);

/**
 * The vendored server's entry point: found by walking up from `from` (this
 * module's directory by default: src/eval/ in development, dist/ when built)
 * to the harness package root.
 */
export function mongodbServerEntry(from: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = resolve(dir, VENDOR_ENTRY);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(
    'mongodb world: the MongoDB MCP server is not installed; run `pnpm run setup:mongodb` in packages/harness',
  );
}

/** Whether {@link mongodbServerEntry} would succeed. */
export function mongodbServerInstalled(): boolean {
  try {
    mongodbServerEntry();
    return true;
  } catch {
    return false;
  }
}

/**
 * Tools (and tool categories — the server's `--disabledTools` takes both)
 * that reach outside the throwaway deployment: network, disk, Atlas.
 */
export const MONGODB_DISABLED_TOOLS = [
  'connect',
  'disconnect',
  'export',
  'search-knowledge',
  'list-knowledge-sources',
  'mongodb-logs',
  'atlas',
  'atlas-local',
];

/**
 * Exactly the tools the spawned server must list (sorted). `openMongodbWorld`
 * throws when the proxy sees anything else, so a changed environment or a
 * server upgrade cannot silently change the surface the eval measures.
 */
export const MONGODB_EXPECTED_TOOLS: readonly string[] = [
  'aggregate',
  'aggregate-db',
  'collection-indexes',
  'collection-schema',
  'collection-storage-size',
  'count',
  'create-collection',
  'create-index',
  'db-stats',
  'delete-many',
  'drop-collection',
  'drop-database',
  'drop-index',
  'explain',
  'find',
  'insert-many',
  'list-collections',
  'list-connections',
  'list-databases',
  'rename-collection',
  'update-many',
];

export const MONGODB_DIRECT_SYSTEM_PROMPT =
  "You operate the user's MongoDB deployment through the tools provided. Complete the user's task, then stop.";

type Doc = Record<string, unknown>;

/** The seeded deployment: database → collection → documents. */
export type MongodbFixture = Readonly<Record<string, Readonly<Record<string, readonly Doc[]>>>>;

/** The main database every task names. */
export const SHOP_DB = 'shop';

export const FIXTURE_CUSTOMERS: readonly Doc[] = [
  { name: 'Alice Ng', email: 'alice@example.com', city: 'Austin', tier: 'gold' },
  { name: 'Bob Lee', email: 'bob@example.com', city: 'Denver', tier: 'silver' },
  { name: 'Carol Diaz', email: 'carol@example.com', city: 'Austin', tier: 'gold' },
  { name: 'Dan Osei', email: 'dan@example.com', city: 'Austin', tier: 'bronze' },
  { name: 'Erin Kaur', email: 'erin@example.com', city: 'Seattle', tier: 'gold' },
  { name: 'Frank Moss', email: 'frank@example.com', city: 'Denver', tier: 'bronze' },
  { name: 'Grace Lin', email: 'grace@example.com', city: 'Austin', tier: 'silver' },
  { name: 'Hugo Brandt', email: 'hugo@example.com', city: 'Boston', tier: 'gold' },
];

/** The six products the tasks name; the three most expensive are the gadgets and the dock. */
export const NAMED_PRODUCTS: readonly Doc[] = [
  { sku: 'WID-1', name: 'Widget Basic', price: 9.99, category: 'widgets', stock: 120 },
  { sku: 'WID-2', name: 'Widget Plus', price: 19.99, category: 'widgets', stock: 80 },
  { sku: 'GAD-1', name: 'Gadget Mini', price: 34.5, category: 'gadgets', stock: 40 },
  { sku: 'ACC-1', name: 'Carry Case', price: 24, category: 'accessories', stock: 200 },
  { sku: 'ACC-2', name: 'Charging Dock', price: 59.99, category: 'accessories', stock: 35 },
  { sku: 'GAD-2', name: 'Gadget Max', price: 129, category: 'gadgets', stock: 12 },
];

/** How many documents a `find`/`aggregate` returns at most (the server's `maxDocumentsPerQuery` default). */
export const MONGODB_QUERY_CAP = 100;

/**
 * Deterministic filler: "Part NNN", category `parts`, every price strictly
 * below the cheapest named top-three product (Gadget Mini, 34.5).
 */
function part(n: number): Doc {
  const id = String(n).padStart(3, '0');
  return {
    sku: `PRT-${id}`,
    name: `Part ${id}`,
    price: Math.round((1 + ((n * 37) % 300) / 10) * 100) / 100,
    category: 'parts',
    stock: (n * 13) % 500,
  };
}

/**
 * 120 products: the six named ones spread through 114 filler parts, with
 * the most expensive (Gadget Max) past the server's {@link MONGODB_QUERY_CAP}
 * in insertion order. An unsorted, unlimited `find` therefore cannot read
 * off the top three, which is what justifies the strict sort + limit
 * expectation of `db-top3-expensive`.
 */
export const FIXTURE_PRODUCTS: readonly Doc[] = (() => {
  const products: Doc[] = [];
  let parts = 0;
  for (let i = 0; i < 120; i += 1) {
    // Named products at 3, 23, 43, 63, 83, 103 — the last one over the cap.
    const named = i % 20 === 3 ? NAMED_PRODUCTS[(i - 3) / 20] : undefined;
    if (named !== undefined) products.push(named);
    else {
      parts += 1;
      products.push(part(parts));
    }
  }
  return products;
})();

/** The cut-off the stale-pending task names; two pending orders are older, one is newer. */
export const STALE_CUTOFF = new Date('2026-09-01T00:00:00Z');

function order(
  orderId: string,
  customerEmail: string,
  status: 'pending' | 'shipped' | 'delivered' | 'cancelled',
  total: number,
  placedAt: string,
): Doc {
  return { orderId, customerEmail, status, total, placedAt: new Date(placedAt) };
}

/** 12 orders: 4 shipped, 3 delivered, 3 pending (2 before the cut-off), 2 cancelled. */
export const FIXTURE_ORDERS: readonly Doc[] = [
  order('A-1001', 'alice@example.com', 'delivered', 139.98, '2026-07-02T10:00:00Z'),
  order('A-1002', 'bob@example.com', 'shipped', 24, '2026-07-15T09:30:00Z'),
  order('A-1003', 'carol@example.com', 'pending', 59.99, '2026-08-03T14:00:00Z'),
  order('A-1004', 'dan@example.com', 'delivered', 9.99, '2026-08-10T08:15:00Z'),
  order('A-1005', 'erin@example.com', 'shipped', 163.5, '2026-08-20T16:45:00Z'),
  order('A-1006', 'frank@example.com', 'cancelled', 19.99, '2026-08-21T11:00:00Z'),
  order('A-1007', 'grace@example.com', 'pending', 34.5, '2026-08-28T13:20:00Z'),
  order('A-1008', 'hugo@example.com', 'shipped', 129, '2026-09-05T10:10:00Z'),
  order('A-1009', 'alice@example.com', 'delivered', 44, '2026-09-12T17:00:00Z'),
  order('A-1010', 'bob@example.com', 'cancelled', 59.99, '2026-09-18T09:00:00Z'),
  order('A-1011', 'carol@example.com', 'pending', 19.99, '2026-09-20T12:00:00Z'),
  order('A-1012', 'erin@example.com', 'shipped', 83.99, '2026-09-28T15:30:00Z'),
];

export const ORDER_STATUS_COUNTS: Readonly<Record<string, number>> = {
  shipped: 4,
  delivered: 3,
  pending: 3,
  cancelled: 2,
};

/**
 * Three databases: the shop every task names, `analytics` (the one with the
 * `daily` collection), and `reports` — a decoy whose `daily_summary` is
 * there so `db-which-db-has-daily` genuinely needs a listing rather than a
 * guess at the only other database.
 */
export const MONGODB_FIXTURE: MongodbFixture = {
  [SHOP_DB]: {
    customers: FIXTURE_CUSTOMERS,
    products: FIXTURE_PRODUCTS,
    orders: FIXTURE_ORDERS,
    sessions_tmp: [
      { token: 's-1', expires: new Date('2026-01-01T00:00:00Z') },
      { token: 's-2', expires: new Date('2026-01-02T00:00:00Z') },
      { token: 's-3', expires: new Date('2026-01-03T00:00:00Z') },
    ],
    audit_log: [
      { at: new Date('2026-09-01T00:00:00Z'), actor: 'alice@example.com', action: 'login' },
      { at: new Date('2026-09-02T00:00:00Z'), actor: 'bob@example.com', action: 'login' },
      { at: new Date('2026-09-03T00:00:00Z'), actor: 'alice@example.com', action: 'order' },
      { at: new Date('2026-09-04T00:00:00Z'), actor: 'carol@example.com', action: 'login' },
      { at: new Date('2026-09-05T00:00:00Z'), actor: 'carol@example.com', action: 'refund' },
    ],
  },
  analytics: {
    daily: [
      { day: '2026-09-28', visits: 1200, orders: 1 },
      { day: '2026-09-29', visits: 1310, orders: 0 },
      { day: '2026-09-30', visits: 990, orders: 0 },
    ],
  },
  reports: {
    daily_summary: [
      { day: '2026-09-28', revenue: 83.99, refunds: 0 },
      { day: '2026-09-29', revenue: 0, refunds: 1 },
      { day: '2026-09-30', revenue: 0, refunds: 0 },
    ],
  },
};

/** Collections the shop database starts with (sorted). */
export const SHOP_COLLECTIONS: readonly string[] = Object.keys(
  MONGODB_FIXTURE[SHOP_DB] ?? {},
).toSorted();

/**
 * Seed the fixture into the deployment at `uri`, then `extraShop`: more
 * documents for the shop database's collections (the multi-hard world's),
 * inserted after the fixture's so insertion order keeps the base documents
 * first.
 */
export async function seedMongodbFixture(
  uri: string,
  extraShop: Readonly<Record<string, readonly Doc[]>> = {},
): Promise<void> {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    for (const [database, collections] of Object.entries(MONGODB_FIXTURE)) {
      for (const [collection, docs] of Object.entries(collections)) {
        // Fresh copies: the driver adds `_id` to the documents it inserts.
        await client
          .db(database)
          .collection(collection)
          .insertMany(docs.map((doc) => ({ ...doc })));
      }
    }
    for (const [collection, docs] of Object.entries(extraShop)) {
      if (docs.length === 0) continue;
      await client
        .db(SHOP_DB)
        .collection(collection)
        .insertMany(docs.map((doc) => ({ ...doc })));
    }
  } finally {
    await client.close();
  }
}

/** Run `fn` against the episode's deployment with a short-lived driver connection. */
export async function withMongodb<T>(
  facts: WorldFacts,
  fn: (client: MongoClient) => Promise<T>,
): Promise<T> {
  const uri = facts.mongoUri;
  if (uri === undefined) throw new Error('mongodb task verified without a deployment');
  const client = new MongoClient(uri);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.close();
  }
}

/**
 * The child's environment: what Node and the server need to start, plus the
 * connection string. Nothing else is inherited (see the module doc).
 */
function serverEnv(uri: string): Record<string, string> {
  const env: Record<string, string> = { MDB_MCP_CONNECTION_STRING: uri };
  for (const key of ['PATH', 'HOME', 'TMPDIR']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * A fresh MongoDB world: a `mongod` seeded with the fixture, the MongoDB MCP
 * server spawned on it, a recording proxy in front. `close` kills the
 * server and the `mongod`.
 */
export async function openMongodbWorld(
  options: Pick<WorldOptions, 'onCall'> & {
    /** More shop documents seeded after the fixture (the multi-hard world's). */
    extraShop?: Readonly<Record<string, readonly Doc[]>>;
  } = {},
): Promise<ServerWorld> {
  const entry = mongodbServerEntry();
  const mongod = await MongoMemoryServer.create({
    binary: { version: MONGODB_VERSION, downloadDir: mongodbBinaryDir() },
  });
  const uri = mongod.getUri();
  let client: Client | undefined;
  // Set once the server answered `initialize`: errors after that (the
  // tool-set assertion) are reported as they are, not as a startup failure.
  let started = false;
  // Only a startup failure reads the server's stderr; once connected, the
  // stream keeps flowing but nothing is kept, so a chatty server cannot grow
  // a buffer for the life of the episode.
  const stderr: Buffer[] = [];
  const collect = (chunk: Buffer): void => {
    if (!started) stderr.push(chunk);
  };
  const close = async (): Promise<void> => {
    await client?.close().catch(() => {});
    await mongod.stop().catch(() => {});
  };
  try {
    await seedMongodbFixture(uri, options.extraShop);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        entry,
        '--telemetry',
        'disabled',
        '--loggers',
        'stderr',
        '--disabledTools',
        MONGODB_DISABLED_TOOLS.join(','),
      ],
      env: serverEnv(uri),
      stderr: 'pipe',
    });
    transport.stderr?.on('data', collect);
    client = new Client({ name: 'tool-choice-eval', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
    started = true;
    const proxy = await createRecordingProxy(
      client,
      { name: 'mongodb-eval', version: '0.0.0' },
      options.onCall !== undefined ? { onCall: options.onCall } : {},
    );
    const listed = proxy.tools.map((t) => t.name).toSorted();
    if (JSON.stringify(listed) !== JSON.stringify(MONGODB_EXPECTED_TOOLS)) {
      const missing = MONGODB_EXPECTED_TOOLS.filter((n) => !listed.includes(n));
      const extra = listed.filter((n) => !MONGODB_EXPECTED_TOOLS.includes(n));
      throw new Error(
        `mongodb world: the MongoDB MCP server listed ${listed.length} tools, expected exactly the ${MONGODB_EXPECTED_TOOLS.length} known ones` +
          `${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}` +
          `${extra.length > 0 ? `; unexpected: ${extra.join(', ')}` : ''}`,
      );
    }
    return {
      name: 'mongodb',
      server: proxy.server,
      tools: proxy.tools,
      instructions: proxy.instructions,
      calls: proxy.calls,
      facts: { mongoUri: uri },
      hostSystemPrompt: MONGODB_DIRECT_SYSTEM_PROMPT,
      close,
    };
  } catch (err) {
    await close();
    if (started) throw err;
    const log = Buffer.concat(stderr).toString('utf8').trim();
    throw new Error(
      `mongodb world: could not start the MongoDB MCP server${log === '' ? '' : `: ${log}`}`,
      { cause: err },
    );
  }
}
