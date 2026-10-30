/**
 * Fixture data for the `multi-hard` tier: what the multi world's three
 * boxes hold on top of their base fixtures when opened with
 * `variant: 'hard'` (multi-world.ts). Every addition is gated behind that
 * variant, so the `multi` tier and the single-server tiers see exactly the
 * worlds they always did.
 *
 * - **fs**: 28 service logs under `logs/services/` (levels INFO, WARN,
 *   ERROR, with WARN/INFO lines whose message contains the word "ERROR" as
 *   decoys), a fuller `src/` tree, `docs/`, `scripts/`, a `CODEOWNERS`
 *   file and `notes/vip.txt`.
 * - **mongo**: 40 more customers (each with a `github` username), 110 more
 *   orders, 23 more audit documents, and a `staff` collection.
 * - **github**: acme/widgets grows to 84 issues, 40 pull requests with
 *   files and check runs, 64 branches and 62 releases, served by
 *   multi-hard-github.ts with GitHub's real default page size of 30.
 *
 * Everything is a literal or a pure function of a fixed seed, so every
 * episode sees the same world; the expected answers below are computed
 * from the data once, at module load, and pinned as literals in
 * test/eval/multi-hard-tasks.test.ts so a change to the data cannot move
 * an answer silently.
 */

/** A small deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Round to cents, the way the graders compare money. */
export function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

/** An ISO timestamp `days` (may be fractional) after `start`. */
function daysAfter(start: string, days: number): string {
  return new Date(Date.parse(start) + Math.round(days * 86_400) * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Filesystem

/** The services whose logs sit in `logs/services/<name>.log`; no name is a substring of another. */
export const SERVICE_NAMES: readonly string[] = [
  'api-gateway',
  'auth',
  'billing',
  'cart',
  'catalog',
  'checkout',
  'email',
  'fraud',
  'geo',
  'image',
  'inventory',
  'ledger',
  'loyalty',
  'media',
  'notify',
  'orders',
  'payments',
  'pricing',
  'profile',
  'queue',
  'ranking',
  'recs',
  'reviews',
  'search',
  'session',
  'shipping',
  'tax',
  'wishlist',
];

const INFO_MESSAGES = [
  'request ok',
  'cache hit',
  'cache miss',
  'health check passed',
  'config reloaded',
  'connection opened',
];
const WARN_MESSAGES = ['slow response', 'retrying request', 'pool nearly full', 'deprecated field'];
const ERROR_MESSAGES = [
  'request failed',
  'timeout talking to upstream',
  'unhandled exception',
  'database unavailable',
];
/** Lines that are not ERROR-level but contain the word ERROR. */
const DECOY_LINES = [
  ['WARN', 'upstream returned ERROR 502, retrying'],
  ['INFO', 'cleared ERROR state after recovery'],
] as const;

interface ServiceLog {
  name: string;
  text: string;
  errors: number;
  decoys: number;
}

/**
 * One service's log: 30–69 lines `<ts> <LEVEL> svc=<name> req=<n> msg="..."`,
 * a seeded number of ERROR lines (0–9; two services have none), and in
 * every third service one or two decoy lines that mention ERROR at another
 * level.
 */
function serviceLog(name: string, index: number): ServiceLog {
  const rand = prng(1000 + index);
  const lines = 30 + Math.floor(rand() * 40);
  const errors = index === 6 || index === 19 ? 0 : Math.floor(rand() * 10);
  const decoys = index % 3 === 0 ? 1 + (index % 2) : 0;
  // Positions of the ERROR and decoy lines, distinct.
  const slots = Array.from({ length: lines }, (_, i) => i);
  for (let i = slots.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [slots[i], slots[j]] = [slots[j] as number, slots[i] as number];
  }
  const errorAt = new Set(slots.slice(0, errors));
  const decoyAt = new Set(slots.slice(errors, errors + decoys));
  const out: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    const ts = `2026-10-${pad2(1 + (index % 9))}T${pad2(8 + Math.floor(i / 60))}:${pad2(i % 60)}:${pad2((i * 7) % 60)}Z`;
    let level: string;
    let msg: string;
    if (errorAt.has(i)) {
      level = 'ERROR';
      msg = ERROR_MESSAGES[Math.floor(rand() * ERROR_MESSAGES.length)] as string;
    } else if (decoyAt.has(i)) {
      const decoy = DECOY_LINES[i % 2] as (typeof DECOY_LINES)[number];
      level = decoy[0];
      msg = decoy[1];
    } else if (rand() < 0.2) {
      level = 'WARN';
      msg = WARN_MESSAGES[Math.floor(rand() * WARN_MESSAGES.length)] as string;
    } else {
      level = 'INFO';
      msg = INFO_MESSAGES[Math.floor(rand() * INFO_MESSAGES.length)] as string;
    }
    out.push(`${ts} ${level} svc=${name} req=${5000 + index * 100 + i} msg="${msg}"`);
  }
  return { name, text: `${out.join('\n')}\n`, errors, decoys };
}

const SERVICE_LOGS: readonly ServiceLog[] = SERVICE_NAMES.map(serviceLog);

/** ERROR-level line count per service log file name (`auth.log` → n). */
export const EXPECTED_ERROR_COUNTS: Readonly<Record<string, number>> = Object.fromEntries(
  SERVICE_LOGS.map((log) => [`${log.name}.log`, log.errors]),
);

/** Source and docs files the hard world adds to the project. */
const HARD_SOURCE_FILES: Readonly<Record<string, string>> = {
  'src/export/index.ts':
    "export * from './csv.js';\nexport * from './json.js';\nexport * from './xml.js';\n",
  'src/export/csv.ts':
    'export function toCsv(rows: string[][]): string {\n  return rows.map((r) => r.join(",")).join("\\n");\n}\n',
  'src/export/json.ts':
    'export function toJson(rows: unknown[]): string {\n  return JSON.stringify(rows);\n}\n',
  'src/export/xml.ts':
    'export function toXml(rows: unknown[]): string {\n  return `<rows count="${rows.length}"/>`;\n}\n',
  'src/exporter.ts':
    "// Old entry point, kept for compatibility.\nexport * from './export/index.js';\n",
  'src/api/routes.ts': "export const routes = ['/items', '/users'];\n",
  'src/api/auth.ts':
    'export function checkToken(token: string): boolean {\n  return token.length > 0;\n}\n',
  'src/api/users.ts': 'export interface User {\n  id: string;\n}\n',
  'src/db/pool.ts': 'export const POOL_SIZE = 10;\n',
  'src/db/migrate.ts': 'export async function migrate(): Promise<void> {}\n',
  'src/ui/table.tsx': 'export function Table() {\n  return null;\n}\n',
  'src/ui/chart.tsx': 'export function Chart() {\n  return null;\n}\n',
  'src/cli/main.ts':
    "import { parseArgs } from './args.js';\n\nparseArgs(process.argv.slice(2));\n",
  'src/cli/args.ts': 'export function parseArgs(argv: string[]): string[] {\n  return argv;\n}\n',
  'docs/setup.md': '# Setup\n\nRun `pnpm install`.\n',
  'docs/api.md': '# API\n\nSee src/api.\n',
  'scripts/release.sh': '#!/bin/sh\nset -e\npnpm publish\n',
  'test/export/csv.test.ts':
    "import { toCsv } from '../../src/export/csv.js';\n\nconsole.log(toCsv([['a']]));\n",
};

/**
 * CODEOWNERS: the last matching pattern wins, as on GitHub. src/db/pool.ts
 * is owned by @rhea-m (the `/src/db/migrate.ts` line names one file only).
 */
export const HARD_CODEOWNERS =
  '# Each line is a file pattern followed by one or more owners.\n' +
  '# The last matching pattern takes precedence.\n' +
  '*                    @vibdev\n' +
  '/docs/               @dana-k\n' +
  '/src/api/            @dana-k\n' +
  '/src/db/             @rhea-m\n' +
  '/src/db/migrate.ts   @dana-k\n' +
  '/src/export/         @omar-s\n' +
  '/src/ui/             @omar-s\n' +
  '/scripts/            @vibdev\n';

// ---------------------------------------------------------------------------
// MongoDB: customers

type Doc = Record<string, unknown>;

interface HardCustomer {
  name: string;
  email: string;
  city: string;
  tier: 'gold' | 'silver' | 'bronze';
  github: string;
}

/** 40 more customers: 26 gold, 8 silver, 6 bronze; each records a GitHub username. */
export const HARD_CUSTOMERS: readonly HardCustomer[] = (() => {
  const people: [string, string, HardCustomer['tier'], string][] = [
    ['Ines Duarte', 'Lisbon', 'gold', 'iduarte'],
    ['Jonas Weber', 'Berlin', 'gold', 'jweber'],
    ['Kemal Arslan', 'Izmir', 'silver', 'karslan'],
    ['Lena Fischer', 'Berlin', 'gold', 'lfischer'],
    ['Marco Rossi', 'Milan', 'gold', 'mrossi'],
    ['Nadia Haddad', 'Beirut', 'bronze', 'nhaddad'],
    ['Oscar Lind', 'Malmo', 'gold', 'olind'],
    ['Priya Nair', 'Pune', 'gold', 'pnair'],
    ['Quinn Avery', 'Denver', 'silver', 'qavery'],
    ['Rosa Vidal', 'Valencia', 'gold', 'rvidal'],
    ['Sam Okafor', 'Lagos', 'gold', 'sokafor'],
    ['Tomasz Kowal', 'Gdansk', 'gold', 'tkowal'],
    ['Uma Patel', 'Austin', 'bronze', 'upatel'],
    ['Viktor Hahn', 'Vienna', 'gold', 'vhahn'],
    ['Wen Zhao', 'Seattle', 'gold', 'wzhao'],
    ['Ximena Ortiz', 'Lima', 'silver', 'xortiz'],
    ['Yusuf Demir', 'Ankara', 'gold', 'ydemir'],
    ['Zara Malik', 'Leeds', 'gold', 'zmalik'],
    ['Aaron Cole', 'Boston', 'gold', 'acole'],
    ['Bianca Neri', 'Turin', 'silver', 'bneri'],
    ['Caleb Shaw', 'Austin', 'gold', 'cshaw'],
    ['Dalia Sousa', 'Porto', 'gold', 'dsousa'],
    ['Emil Berg', 'Oslo', 'bronze', 'eberg'],
    ['Fatima Zahra', 'Rabat', 'gold', 'fzahra'],
    ['Gustav Ek', 'Uppsala', 'gold', 'gek'],
    ['Hana Sato', 'Osaka', 'silver', 'hsato'],
    ['Ivan Petrov', 'Sofia', 'gold', 'ipetrov'],
    ['Julia Kraus', 'Graz', 'gold', 'jkraus'],
    ['Kofi Mensah', 'Accra', 'bronze', 'kmensah'],
    ['Lucia Romero', 'Seville', 'gold', 'lromero'],
    ['Mateo Silva', 'Santos', 'silver', 'msilva'],
    ['Nora Quinn', 'Dublin', 'gold', 'nquinn'],
    ['Omar Farouk', 'Cairo', 'gold', 'ofarouk'],
    ['Paula Mendes', 'Recife', 'bronze', 'pmendes'],
    ['Ravi Iyer', 'Chennai', 'gold', 'riyer'],
    ['Sofia Lund', 'Bergen', 'silver', 'slund'],
    ['Theo Marsh', 'Bristol', 'gold', 'tmarsh'],
    ['Ulla Koski', 'Turku', 'silver', 'ukoski'],
    ['Tom Kowalski', 'Krakow', 'bronze', 'tkowalski'],
    ['Wanda Novak', 'Brno', 'gold', 'wnovak'],
  ];
  return people.map(([name, city, tier, github]) => ({
    name,
    email: `${name.toLowerCase().replace(' ', '.')}@example.com`,
    city,
    tier,
    github,
  }));
})();

/** The base fixture's customers, as the hard world keeps them (no `github` field). */
const BASE_CUSTOMERS: readonly { name: string; email: string; tier: string }[] = [
  { name: 'Alice Ng', email: 'alice@example.com', tier: 'gold' },
  { name: 'Bob Lee', email: 'bob@example.com', tier: 'silver' },
  { name: 'Carol Diaz', email: 'carol@example.com', tier: 'gold' },
  { name: 'Dan Osei', email: 'dan@example.com', tier: 'bronze' },
  { name: 'Erin Kaur', email: 'erin@example.com', tier: 'gold' },
  { name: 'Frank Moss', email: 'frank@example.com', tier: 'bronze' },
  { name: 'Grace Lin', email: 'grace@example.com', tier: 'silver' },
  { name: 'Hugo Brandt', email: 'hugo@example.com', tier: 'gold' },
];

/** Every customer's email → tier in the hard world, base fixture included. */
export const HARD_TIER_BY_EMAIL: Readonly<Record<string, string>> = Object.fromEntries([
  ...BASE_CUSTOMERS.map((c) => [c.email, c.tier]),
  ...HARD_CUSTOMERS.map((c) => [c.email, c.tier]),
]);

// ---------------------------------------------------------------------------
// MongoDB: orders

type OrderStatus = 'pending' | 'shipped' | 'delivered' | 'cancelled';

export interface HardOrder {
  orderId: string;
  customerEmail: string;
  status: OrderStatus;
  total: number;
  placedAt: string;
}

/** The base fixture's 12 orders (A-1001..A-1012), as plain data for the graders. */
export const BASE_ORDERS: readonly HardOrder[] = [
  ['A-1001', 'alice@example.com', 'delivered', 139.98, '2026-07-02T10:00:00Z'],
  ['A-1002', 'bob@example.com', 'shipped', 24, '2026-07-15T09:30:00Z'],
  ['A-1003', 'carol@example.com', 'pending', 59.99, '2026-08-03T14:00:00Z'],
  ['A-1004', 'dan@example.com', 'delivered', 9.99, '2026-08-10T08:15:00Z'],
  ['A-1005', 'erin@example.com', 'shipped', 163.5, '2026-08-20T16:45:00Z'],
  ['A-1006', 'frank@example.com', 'cancelled', 19.99, '2026-08-21T11:00:00Z'],
  ['A-1007', 'grace@example.com', 'pending', 34.5, '2026-08-28T13:20:00Z'],
  ['A-1008', 'hugo@example.com', 'shipped', 129, '2026-09-05T10:10:00Z'],
  ['A-1009', 'alice@example.com', 'delivered', 44, '2026-09-12T17:00:00Z'],
  ['A-1010', 'bob@example.com', 'cancelled', 59.99, '2026-09-18T09:00:00Z'],
  ['A-1011', 'carol@example.com', 'pending', 19.99, '2026-09-20T12:00:00Z'],
  ['A-1012', 'erin@example.com', 'shipped', 83.99, '2026-09-28T15:30:00Z'],
].map(([orderId, customerEmail, status, total, placedAt]) => ({
  orderId: orderId as string,
  customerEmail: customerEmail as string,
  status: status as OrderStatus,
  total: total as number,
  placedAt: placedAt as string,
}));

/** Gold customers with no non-cancelled order: one has none at all, one only a cancelled one. */
export const GOLD_WITHOUT_ORDERS = 'theo.marsh@example.com';
export const GOLD_ONLY_CANCELLED = 'wanda.novak@example.com';
/** The chain task's customer and her orders: tkowal's three. */
export const CHAIN_CUSTOMER_EMAIL = 'tomasz.kowal@example.com';

/**
 * 110 more orders, A-1013..A-1122, placed Jan–Oct 2026, cycling through the
 * customers (new and base) with seeded statuses and totals. Fixed overrides
 * pin what the tasks depend on: Theo Marsh has no orders, Wanda Novak a
 * single cancelled one, Tomasz Kowal exactly three (A-1050 delivered,
 * A-1077 cancelled, A-1103 shipped) and his near-namesake Tom Kowalski two.
 */
export const HARD_ORDERS: readonly HardOrder[] = (() => {
  const rand = prng(42);
  const pool = [
    ...HARD_CUSTOMERS.map((c) => c.email),
    ...BASE_CUSTOMERS.map((c) => c.email),
  ].filter(
    (email) =>
      email !== GOLD_WITHOUT_ORDERS &&
      email !== GOLD_ONLY_CANCELLED &&
      email !== CHAIN_CUSTOMER_EMAIL &&
      email !== 'tom.kowalski@example.com',
  );
  const fixed: Readonly<Record<number, [string, OrderStatus]>> = {
    1033: [GOLD_ONLY_CANCELLED, 'cancelled'],
    1050: [CHAIN_CUSTOMER_EMAIL, 'delivered'],
    1061: ['tom.kowalski@example.com', 'shipped'],
    1077: [CHAIN_CUSTOMER_EMAIL, 'cancelled'],
    1090: ['tom.kowalski@example.com', 'delivered'],
    1103: [CHAIN_CUSTOMER_EMAIL, 'shipped'],
  };
  const statuses: OrderStatus[] = ['delivered', 'shipped', 'pending', 'cancelled'];
  const weights = [0.4, 0.3, 0.18, 0.12];
  const orders: HardOrder[] = [];
  for (let n = 1013; n <= 1122; n += 1) {
    const r = rand();
    let acc = 0;
    let status: OrderStatus = 'delivered';
    for (let s = 0; s < statuses.length; s += 1) {
      acc += weights[s] as number;
      if (r < acc) {
        status = statuses[s] as OrderStatus;
        break;
      }
    }
    const total = cents(5 + rand() * 245);
    let email = pool[(n * 7) % pool.length] as string;
    const pinned = fixed[n];
    if (pinned !== undefined) [email, status] = pinned;
    orders.push({
      orderId: `A-${n}`,
      customerEmail: email,
      status,
      total,
      placedAt: daysAfter('2026-01-03T09:00:00Z', (n - 1013) * 2.5 + rand()),
    });
  }
  return orders;
})();

/** Every order in the hard world. */
export const ALL_HARD_ORDERS: readonly HardOrder[] = [...BASE_ORDERS, ...HARD_ORDERS];

/** Gold customer email → total of their non-cancelled orders (cents). 30 customers. */
export const EXPECTED_GOLD_TOTALS: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(HARD_TIER_BY_EMAIL)
    .filter(([, tier]) => tier === 'gold')
    .map(([email]) => [
      email,
      cents(
        ALL_HARD_ORDERS.filter((o) => o.customerEmail === email && o.status !== 'cancelled').reduce(
          (sum, o) => sum + o.total,
          0,
        ),
      ),
    ]),
);

/** The chain task's answer: every order id of the GitHub user who filed the oldest issue in v1.2.0's notes. */
export const EXPECTED_CHAIN_ORDERS: readonly string[] = ALL_HARD_ORDERS.filter(
  (o) => o.customerEmail === CHAIN_CUSTOMER_EMAIL,
).map((o) => o.orderId);

// ---------------------------------------------------------------------------
// MongoDB: audit log

/** Shipped order ids, in id order. */
export const SHIPPED_ORDER_IDS: readonly string[] = ALL_HARD_ORDERS.filter(
  (o) => o.status === 'shipped',
).map((o) => o.orderId);

/**
 * Shipped orders that already have a `{ action: 'shipped', orderId }` audit
 * document: all but the 14 whose index in {@link SHIPPED_ORDER_IDS} is in
 * the missing set (every other one from the 4th, up to 14).
 */
export const EXPECTED_MISSING_AUDITS: readonly string[] = SHIPPED_ORDER_IDS.filter(
  (_, i) => i >= 3 && i % 2 === 1,
).slice(0, 14);

/**
 * Audit documents the hard world adds: one `shipped` entry per shipped
 * order not in {@link EXPECTED_MISSING_AUDITS}, plus decoys — a `shipped`
 * entry for an order that has since been delivered, and `delivered` entries.
 */
export const HARD_AUDIT_DOCS: readonly Doc[] = (() => {
  const docs: Doc[] = [];
  for (const id of SHIPPED_ORDER_IDS) {
    if (EXPECTED_MISSING_AUDITS.includes(id)) continue;
    const order = ALL_HARD_ORDERS.find((o) => o.orderId === id) as HardOrder;
    docs.push({
      at: new Date(daysAfter(order.placedAt, 1)),
      actor: 'system',
      action: 'shipped',
      orderId: id,
    });
  }
  const delivered = ALL_HARD_ORDERS.filter((o) => o.status === 'delivered').slice(0, 3);
  for (const order of delivered) {
    docs.push({
      at: new Date(daysAfter(order.placedAt, 1)),
      actor: 'system',
      action: 'shipped',
      orderId: order.orderId,
    });
    docs.push({
      at: new Date(daysAfter(order.placedAt, 4)),
      actor: 'system',
      action: 'delivered',
      orderId: order.orderId,
    });
  }
  return docs;
})();

// ---------------------------------------------------------------------------
// MongoDB: staff

export interface StaffMember {
  name: string;
  github: string;
  email: string;
  team: string;
}

/** Engineering staff, keyed by GitHub username; `rhea-mm` is a near-namesake decoy. */
export const HARD_STAFF: readonly StaffMember[] = [
  { name: 'Dana Kim', github: 'dana-k', email: 'dana.kim@acme.dev', team: 'api' },
  { name: 'Rhea Mor', github: 'rhea-m', email: 'rhea.mor@acme.dev', team: 'data' },
  { name: 'Rhea Martins', github: 'rhea-mm', email: 'rhea.martins@acme.dev', team: 'web' },
  { name: 'Omar Saleh', github: 'omar-s', email: 'omar.saleh@acme.dev', team: 'web' },
  { name: 'Vib Dev', github: 'vibdev', email: 'vib@acme.dev', team: 'platform' },
];

// ---------------------------------------------------------------------------
// The VIP list (fs → mongo branching)

/**
 * notes/vip.txt: 15 emails. 11 are customers (3 already gold), 4 are not
 * (one a near miss of grace@example.com).
 */
export const VIP_EMAILS: readonly string[] = [
  'bob@example.com',
  'ines.duarte@example.com',
  'kemal.arslan@example.com',
  'zoe.park@example.com',
  'nadia.haddad@example.com',
  'grace@example.org',
  'quinn.avery@example.com',
  'marco.rossi@example.com',
  'uma.patel@example.com',
  'liam.byrne@example.com',
  'bianca.neri@example.com',
  'emil.berg@example.com',
  'sofia.lund@example.com',
  'priya.nair@example.com',
  'oliver.grant@example.com',
];

export const HARD_VIP_TXT = `# VIP customers for the autumn campaign\n${VIP_EMAILS.join('\n')}\n`;

/** VIP emails that are customers: their tier must end up gold. */
export const EXPECTED_VIP_UPGRADES: readonly string[] = VIP_EMAILS.filter(
  (email) => HARD_TIER_BY_EMAIL[email] !== undefined,
);
/** VIP emails that are not customers: they belong in notes/missing-vips.txt. */
export const EXPECTED_VIP_MISSING: readonly string[] = VIP_EMAILS.filter(
  (email) => HARD_TIER_BY_EMAIL[email] === undefined,
);

// ---------------------------------------------------------------------------
// The project tree

/** Every file the hard world adds to the filesystem box (relative path → content). */
export const HARD_FILESYSTEM_FILES: Readonly<Record<string, string>> = {
  ...HARD_SOURCE_FILES,
  CODEOWNERS: HARD_CODEOWNERS,
  'notes/vip.txt': HARD_VIP_TXT,
  ...Object.fromEntries(SERVICE_LOGS.map((log) => [`logs/services/${log.name}.log`, log.text])),
};

/** Base fixture paths (filesystem-world.ts), for the issue-title task's "exists" check. */
const BASE_PROJECT_PATHS: readonly string[] = [
  'README.md',
  'package.json',
  'CHANGELOG.md',
  'notes/todo.txt',
  'notes/ideas.txt',
  'src/index.js',
  'src/util.js',
  'src/legacy/old.js',
  'src/legacy/debug.log',
  'config/dev.json',
  'config/prod.json',
  'logs/app.log',
  'logs/access.log',
  'logs/error.log',
  'assets/logo.png',
  'tmp/scratch.txt',
  'tmp/draft.md',
];

/** Every file in the hard world's project. */
export const HARD_PROJECT_PATHS: ReadonlySet<string> = new Set([
  ...BASE_PROJECT_PATHS,
  ...Object.keys(HARD_FILESYSTEM_FILES),
]);

/**
 * MongoDB documents the hard world adds, by collection of the shop database.
 * Dates are `Date`s, as in the base fixture.
 */
export function hardMongoSeed(): Record<string, Doc[]> {
  return {
    customers: HARD_CUSTOMERS.map((c) => ({ ...c })),
    orders: HARD_ORDERS.map((o) => ({ ...o, placedAt: new Date(o.placedAt) })),
    audit_log: HARD_AUDIT_DOCS.map((d) => ({ ...d })),
    staff: HARD_STAFF.map((s) => ({ ...s })),
  };
}
