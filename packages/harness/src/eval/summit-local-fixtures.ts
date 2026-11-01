/**
 * The `summit-local` world's seed data: one small company ("Tidepool", a
 * billing and export service) seen through six real servers. Everything is
 * deterministic, so every episode starts from the same world and the
 * graders know every value; the expected answers below are derived from
 * the data, never typed in twice (the tests pin them as literals).
 *
 * - **git / fs**: the `tidepool` checkout, built with `git fast-import`
 *   from {@link MAIN_COMMITS} and {@link BRANCHES} (fixed dates, so fixed
 *   hashes): 27 commits on `main` (one of them reverting an earlier one), a
 *   `release/2.3` maintenance branch, two unmerged feature branches, two
 *   branches already fast-forwarded into main, four tags (2.3.2 was deployed
 *   but never tagged), and a working tree with one staged edit, one unstaged
 *   edit and an untracked file. The filesystem server is rooted in the same
 *   checkout.
 * - **memory**: the team knowledge graph ({@link MEMORY_GRAPH}): people,
 *   teams and services, with a former contractor whose name is one letter
 *   group away from a current engineer's.
 * - **sqlite**: the support database ({@link SQLITE_SCHEMA},
 *   {@link SQLITE_SEED}): agents, customers, tickets, ticket comments,
 *   invoices and deploys; times are UTC, and three rows imported from an
 *   old helpdesk write them with slashes (`2026/08/19 14:45`).
 * - **fetch**: the team intranet ({@link intranetPages}): a status page, the
 *   team page (newer than the graph: one promotion, one move, two new
 *   hires), an on-call rota longer than the fetch server's 5000-character
 *   page, a releases list, a paged incidents API and one incident report
 *   (which names customers by their legal names, one of them not ours).
 */

// ---------------------------------------------------------------------------
// People

export interface Person {
  name: string;
  role: string;
  timezone: string;
  github?: string;
  email?: string;
}

/** The current team, as the memory graph and the intranet's team page list them. */
export const PEOPLE: readonly Person[] = [
  {
    name: 'Priya Raman',
    role: 'Backend lead',
    timezone: 'Asia/Kolkata',
    github: 'priya-r',
    email: 'priya@tidepool.dev',
  },
  {
    name: 'Kenji Sato',
    role: 'Backend engineer',
    timezone: 'Asia/Tokyo',
    github: 'kenji-s',
    email: 'kenji@tidepool.dev',
  },
  {
    name: 'Wen Li',
    role: 'Backend engineer',
    timezone: 'Asia/Shanghai',
    github: 'wen-l',
    email: 'wen@tidepool.dev',
  },
  {
    name: 'Marco Bianchi',
    role: 'Frontend engineer',
    timezone: 'Europe/Rome',
    github: 'marco-b',
    email: 'marco@tidepool.dev',
  },
  {
    name: 'Dana Whitfield',
    role: 'Site reliability engineer',
    timezone: 'America/Phoenix',
    github: 'dana-w',
    email: 'dana@tidepool.dev',
  },
  {
    name: 'Tomás Ortega',
    role: 'Engineering manager',
    timezone: 'America/Mexico_City',
    github: 'tomas-o',
    email: 'tomas@tidepool.dev',
  },
  {
    name: 'Lena Fischer',
    role: 'Support lead',
    timezone: 'Europe/Berlin',
    email: 'lena@tidepool.dev',
  },
  {
    name: 'Ruth Okafor',
    role: 'Head of customer success',
    timezone: 'Africa/Lagos',
    email: 'ruth@tidepool.dev',
  },
  {
    name: 'Sven Olsen',
    role: 'Support engineer',
    timezone: 'Europe/Oslo',
    email: 'sven@tidepool.dev',
  },
  {
    name: 'Mei Chen',
    role: 'Support engineer',
    timezone: 'Asia/Singapore',
    email: 'mei@tidepool.dev',
  },
];

/** On the team page but not yet in the memory graph. */
export const NEW_HIRES: readonly Person[] = [
  { name: 'Aiyana Brooks', role: 'Support engineer', timezone: 'America/Phoenix' },
  { name: 'Felix Wong', role: 'Frontend engineer', timezone: 'Asia/Singapore' },
];

/**
 * Where the intranet's team page is newer than the memory graph: a
 * promotion and a move. The graph keeps the {@link PEOPLE} values.
 */
export const TEAM_PAGE_CHANGES: Readonly<
  Record<string, Partial<Pick<Person, 'role' | 'timezone'>>>
> = {
  'Marco Bianchi': { role: 'Frontend lead' },
  'Mei Chen': { timezone: 'Asia/Kuala_Lumpur' },
};

/** The team page's people: everyone current, with the page's newer values. */
export function teamPage(): Person[] {
  return [...PEOPLE, ...NEW_HIRES]
    .map((p) => ({ ...p, ...TEAM_PAGE_CHANGES[p.name] }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/** A former contractor: in the memory graph, never on the team page. */
export const FORMER_CONTRACTOR = 'Dana Whitman';

function person(name: string): Person {
  const p = PEOPLE.find((x) => x.name === name);
  if (p === undefined) throw new Error(`unknown person ${name}`);
  return p;
}

// ---------------------------------------------------------------------------
// Memory graph (the server's JSONL format: one entity or relation per line)

export interface MemoryEntity {
  type: 'entity';
  name: string;
  entityType: string;
  observations: string[];
}
export interface MemoryRelation {
  type: 'relation';
  from: string;
  to: string;
  relationType: string;
}
export type MemoryRecord = MemoryEntity | MemoryRelation;

function personEntity(p: Person): MemoryEntity {
  return {
    type: 'entity',
    name: p.name,
    entityType: 'person',
    observations: [
      `Role: ${p.role}`,
      `Timezone: ${p.timezone}`,
      ...(p.github !== undefined ? [`GitHub: ${p.github}`] : []),
      ...(p.email !== undefined ? [`Email: ${p.email}`] : []),
    ],
  };
}

const rel = (from: string, relationType: string, to: string): MemoryRelation => ({
  type: 'relation',
  from,
  to,
  relationType,
});

/** Who reports to whom (the org chart the graph holds). */
export const REPORTS_TO: Readonly<Record<string, string>> = {
  'Priya Raman': 'Tomás Ortega',
  'Kenji Sato': 'Priya Raman',
  'Wen Li': 'Priya Raman',
  'Marco Bianchi': 'Tomás Ortega',
  'Dana Whitfield': 'Tomás Ortega',
  'Lena Fischer': 'Ruth Okafor',
  'Sven Olsen': 'Lena Fischer',
  'Mei Chen': 'Lena Fischer',
};

export const TEAM_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  'Billing team': ['Priya Raman', 'Kenji Sato', 'Wen Li'],
  'Platform team': ['Dana Whitfield'],
  'Web team': ['Marco Bianchi'],
  'Support team': ['Lena Fischer', 'Sven Olsen', 'Mei Chen'],
};

/** Service → current owner. */
export const SERVICE_OWNERS: Readonly<Record<string, string>> = {
  billing: 'Priya Raman',
  auth: 'Kenji Sato',
  web: 'Marco Bianchi',
  search: 'Marco Bianchi',
  'export-worker': 'Dana Whitfield',
};

const SERVICE_NOTES: Readonly<Record<string, string>> = {
  billing: 'Invoicing, late fees and invoice exports',
  auth: 'Sessions, sign-in and API keys',
  web: 'Customer dashboard',
  search: 'Invoice and customer search',
  'export-worker': 'Background worker that streams large exports',
};

export const MEMORY_GRAPH: readonly MemoryRecord[] = [
  ...PEOPLE.map(personEntity),
  {
    type: 'entity',
    name: FORMER_CONTRACTOR,
    entityType: 'person',
    observations: [
      'Role: Contract backend engineer',
      'Contract ended 2025-12-19',
      'Timezone: America/Denver',
      'GitHub: dana-wh',
      'Owned the billing service until December 2025',
    ],
  },
  ...Object.keys(TEAM_MEMBERS).map((team): MemoryEntity => ({
    type: 'entity',
    name: team,
    entityType: 'team',
    observations: [],
  })),
  ...Object.keys(SERVICE_OWNERS).map((service): MemoryEntity => ({
    type: 'entity',
    name: service,
    entityType: 'service',
    observations: [SERVICE_NOTES[service] as string],
  })),
  ...Object.entries(REPORTS_TO).map(([from, to]) => rel(from, 'reports_to', to)),
  ...Object.entries(TEAM_MEMBERS).flatMap(([team, members]) =>
    members.map((m) => rel(m, 'member_of', team)),
  ),
  rel(FORMER_CONTRACTOR, 'formerly_member_of', 'Billing team'),
  ...Object.entries(SERVICE_OWNERS).map(([service, owner]) => rel(owner, 'owns', service)),
  rel(FORMER_CONTRACTOR, 'previously_owned', 'billing'),
  rel(FORMER_CONTRACTOR, 'previously_owned', 'search'),
];

export function memoryJsonl(records: readonly MemoryRecord[] = MEMORY_GRAPH): string {
  return `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// SQLite support database

export const SQLITE_SCHEMA = `
CREATE TABLE agents (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  team TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('free', 'team', 'enterprise')),
  region TEXT NOT NULL,
  timezone TEXT NOT NULL,
  account_owner TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'pending', 'closed')),
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assignee TEXT,
  opened_at TEXT,
  updated_at TEXT,
  closed_at TEXT
);
CREATE TABLE ticket_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  author_id INTEGER NOT NULL REFERENCES agents(id),
  body TEXT NOT NULL,
  created_at TEXT
);
CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  period TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('paid', 'overdue', 'void')),
  due_date TEXT NOT NULL
);
CREATE TABLE deploys (
  id INTEGER PRIMARY KEY,
  service TEXT NOT NULL,
  version TEXT NOT NULL,
  environment TEXT NOT NULL,
  deployed_at TEXT NOT NULL,
  deployed_by TEXT NOT NULL
);
`;

export interface Agent {
  id: number;
  name: string;
  email: string;
  team: string;
  active: number;
}

export const AGENTS: readonly Agent[] = [
  { id: 1, name: 'Sven Olsen', email: 'sven@tidepool.dev', team: 'support', active: 1 },
  { id: 2, name: 'Mei Chen', email: 'mei@tidepool.dev', team: 'support', active: 1 },
  { id: 3, name: 'Ruth Okafor', email: 'ruth@tidepool.dev', team: 'customer success', active: 1 },
  { id: 4, name: 'Priya Raman', email: 'priya@tidepool.dev', team: 'engineering', active: 1 },
  { id: 5, name: 'Kenji Sato', email: 'kenji@tidepool.dev', team: 'engineering', active: 1 },
  {
    id: 6,
    name: FORMER_CONTRACTOR,
    email: 'dana.whitman@contractors.tidepool.dev',
    team: 'engineering',
    active: 0,
  },
  { id: 7, name: 'Lena Fischer', email: 'lena@tidepool.dev', team: 'support', active: 1 },
  { id: 8, name: 'Dana Whitfield', email: 'dana@tidepool.dev', team: 'engineering', active: 1 },
  { id: 9, name: 'Marco Bianchi', email: 'marco@tidepool.dev', team: 'engineering', active: 1 },
  { id: 10, name: 'Wen Li', email: 'wen@tidepool.dev', team: 'engineering', active: 1 },
];

export interface Customer {
  id: number;
  name: string;
  plan: 'free' | 'team' | 'enterprise';
  region: string;
  timezone: string;
  account_owner: string;
  created_at: string;
}

export const CUSTOMERS: readonly Customer[] = [
  {
    id: 1,
    name: 'Acme Freight',
    plan: 'enterprise',
    region: 'APAC',
    timezone: 'Asia/Singapore',
    account_owner: 'Priya Raman',
    created_at: '2024-03-11',
  },
  {
    id: 2,
    name: 'Bluewater Labs',
    plan: 'team',
    region: 'EU',
    timezone: 'Europe/Dublin',
    account_owner: 'Marco Bianchi',
    created_at: '2024-05-02',
  },
  {
    id: 3,
    name: 'Copperline Bank',
    plan: 'enterprise',
    region: 'AMER',
    timezone: 'America/Chicago',
    account_owner: 'Dana Whitfield',
    created_at: '2023-11-20',
  },
  {
    id: 4,
    name: 'Driftwood Studio',
    plan: 'free',
    region: 'AMER',
    timezone: 'America/Phoenix',
    account_owner: 'Marco Bianchi',
    created_at: '2025-01-15',
  },
  {
    id: 5,
    name: 'Evergreen Health',
    plan: 'enterprise',
    region: 'AMER',
    timezone: 'America/New_York',
    account_owner: 'Priya Raman',
    created_at: '2023-08-30',
  },
  {
    id: 6,
    name: 'Fjord Logistics',
    plan: 'team',
    region: 'EU',
    timezone: 'Europe/Oslo',
    account_owner: 'Kenji Sato',
    created_at: '2024-09-09',
  },
  {
    id: 7,
    name: 'Granite Insurance',
    plan: 'enterprise',
    region: 'EU',
    timezone: 'Europe/London',
    account_owner: 'Kenji Sato',
    created_at: '2024-02-14',
  },
  {
    id: 8,
    name: 'Harbor & Pine',
    plan: 'team',
    region: 'AMER',
    timezone: 'America/Denver',
    account_owner: 'Dana Whitfield',
    created_at: '2025-03-03',
  },
  {
    id: 9,
    name: 'Indigo Retail',
    plan: 'enterprise',
    region: 'APAC',
    timezone: 'Asia/Tokyo',
    account_owner: 'Kenji Sato',
    created_at: '2024-07-21',
  },
  {
    id: 10,
    name: 'Juniper Schools',
    plan: 'free',
    region: 'AMER',
    timezone: 'America/Chicago',
    account_owner: 'Marco Bianchi',
    created_at: '2025-06-01',
  },
  {
    id: 11,
    name: 'Kestrel Air',
    plan: 'enterprise',
    region: 'APAC',
    timezone: 'Asia/Kolkata',
    account_owner: 'Priya Raman',
    created_at: '2023-12-05',
  },
  {
    id: 12,
    name: 'Lumen Media',
    plan: 'team',
    region: 'EU',
    timezone: 'Europe/Berlin',
    account_owner: 'Priya Raman',
    created_at: '2024-10-18',
  },
  {
    id: 13,
    name: 'Moss & Fern Bakery',
    plan: 'team',
    region: 'EU',
    timezone: 'Europe/Dublin',
    account_owner: 'Marco Bianchi',
    created_at: '2025-09-12',
  },
];

export function customerName(id: number): string {
  const c = CUSTOMERS.find((x) => x.id === id);
  if (c === undefined) throw new Error(`unknown customer ${id}`);
  return c.name;
}

export interface Ticket {
  id: number;
  customer_id: number;
  subject: string;
  status: 'open' | 'pending' | 'closed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  assignee: string | null;
  opened_at: string;
  updated_at: string;
  closed_at: string | null;
}

function t(
  id: number,
  customer_id: number,
  subject: string,
  status: Ticket['status'],
  priority: Ticket['priority'],
  assignee: string | null,
  opened_at: string,
  updated_at: string,
  closed_at: string | null = null,
): Ticket {
  return { id, customer_id, subject, status, priority, assignee, opened_at, updated_at, closed_at };
}

export const TICKETS: readonly Ticket[] = [
  t(
    1003,
    2,
    'Cannot invite a second admin',
    'closed',
    'normal',
    'Sven Olsen',
    '2026-07-01 09:12',
    '2026-07-03 15:40',
    '2026-07-03 15:40',
  ),
  t(
    1006,
    10,
    'Password reset email never arrives',
    'closed',
    'high',
    'Mei Chen',
    '2026-07-04 11:02',
    '2026-07-05 08:30',
    '2026-07-05 08:30',
  ),
  t(
    1009,
    8,
    'Question about annual billing',
    'open',
    'low',
    'Sven Olsen',
    '2026-07-09 14:20',
    '2026-07-20 10:05',
  ),
  t(
    1012,
    6,
    'Invoice export times out for large accounts',
    'closed',
    'high',
    'Kenji Sato',
    '2026-07-14 07:45',
    '2026-08-08 09:00',
    '2026-08-08 09:00',
  ),
  t(
    1015,
    4,
    'Feature request: export to Google Sheets',
    'pending',
    'low',
    'Mei Chen',
    '2026-07-16 15:40',
    '2026-07-30 12:00',
  ),
  t(
    1018,
    5,
    'Void invoices still show as due',
    'closed',
    'normal',
    'Priya Raman',
    '2026-07-21 10:30',
    '2026-08-13 11:15',
    '2026-08-13 11:15',
  ),
  t(
    1019,
    3,
    'Update billing contact',
    'closed',
    'low',
    'Lena Fischer',
    '2026-07-22 13:00',
    '2026-07-23 09:10',
    '2026-07-23 09:10',
  ),
  t(
    1022,
    12,
    'Clarify VAT line on invoices',
    'pending',
    'normal',
    'Sven Olsen',
    '2026-07-28 08:40',
    '2026-08-11 17:25',
  ),
  t(
    1024,
    1,
    'SSO login loop on Safari',
    'closed',
    'high',
    'Kenji Sato',
    '2026-07-30 02:15',
    '2026-08-02 06:00',
    '2026-08-02 06:00',
  ),
  // Imported from the old helpdesk: its timestamps use slashes.
  t(
    1027,
    2,
    'Request copy of 2025 invoices',
    'pending',
    'low',
    'Mei Chen',
    '2026/08/05 10:00',
    '2026/08/19 14:45',
  ),
  t(
    1029,
    9,
    'Dashboard slow to load',
    'closed',
    'normal',
    'Marco Bianchi',
    '2026-08-07 01:30',
    '2026-08-26 03:20',
    '2026-08-26 03:20',
  ),
  t(
    1031,
    3,
    'Export totals off by one cent',
    'closed',
    'high',
    'Priya Raman',
    '2026-08-10 15:05',
    '2026-09-09 10:00',
    '2026-09-09 10:00',
  ),
  t(
    1033,
    7,
    'Add PO number to invoices',
    'closed',
    'normal',
    'Lena Fischer',
    '2026-08-12 09:50',
    '2026-08-20 16:30',
    '2026-08-20 16:30',
  ),
  t(
    1034,
    6,
    'Duplicate reminder emails',
    'pending',
    'normal',
    'Kenji Sato',
    '2026-08-14 07:15',
    '2026-08-28 09:40',
  ),
  t(
    1036,
    7,
    'Exports fail intermittently overnight',
    'closed',
    'urgent',
    'Kenji Sato',
    '2026-08-18 23:10',
    '2026-09-09 10:00',
    '2026-09-09 10:00',
  ),
  t(
    1038,
    10,
    'Teacher accounts cannot see invoices',
    'pending',
    'normal',
    'Sven Olsen',
    '2026-08-20 15:30',
    '2026-09-01 09:15',
  ),
  t(
    1040,
    4,
    'Please add a dark mode',
    'closed',
    'low',
    'Marco Bianchi',
    '2026-08-21 18:00',
    '2026-09-09 10:00',
    '2026-09-09 10:00',
  ),
  t(
    1041,
    5,
    'HIPAA BAA renewal',
    'open',
    'normal',
    'Ruth Okafor',
    '2026-08-25 13:00',
    '2026-10-02 10:00',
  ),
  t(
    1042,
    11,
    'Refund for duplicate charge',
    'pending',
    'normal',
    'Lena Fischer',
    '2026-09-02 05:20',
    '2026-10-28 08:00',
  ),
  t(
    1044,
    1,
    'Late fee applied in error',
    'open',
    'high',
    'Lena Fischer',
    '2026-09-08 00:30',
    '2026-10-27 07:30',
  ),
  t(
    1046,
    12,
    'Change invoice language to German',
    'closed',
    'low',
    'Lena Fischer',
    '2026-09-10 09:00',
    '2026-09-12 11:00',
    '2026-09-12 11:00',
  ),
  t(
    1047,
    8,
    'Webhook retries flood our endpoint',
    'open',
    'high',
    'Dana Whitfield',
    '2026-09-14 16:40',
    '2026-10-21 18:00',
  ),
  t(
    1049,
    5,
    'Wrong currency in export header',
    'closed',
    'high',
    'Kenji Sato',
    '2026-09-16 14:10',
    '2026-09-25 09:30',
    '2026-09-25 09:30',
  ),
  t(
    1050,
    2,
    'API rate limit too low',
    'open',
    'normal',
    'Sven Olsen',
    '2026-09-19 10:20',
    '2026-10-14 12:10',
  ),
  t(
    1051,
    7,
    'Invoice PDF missing logo',
    'open',
    'normal',
    'Lena Fischer',
    '2026-09-23 08:05',
    '2026-10-24 09:45',
  ),
  t(
    1052,
    9,
    'Bulk download of receipts',
    'open',
    'low',
    'Mei Chen',
    '2026-09-26 02:00',
    '2026-10-09 04:15',
  ),
  t(
    1053,
    3,
    'Statement does not match ledger',
    'pending',
    'high',
    'Lena Fischer',
    '2026-10-01 15:30',
    '2026-10-20 16:00',
  ),
  t(
    1054,
    10,
    'Bulk import of student accounts',
    'open',
    'normal',
    'Marco Bianchi',
    '2026-10-05 14:00',
    '2026-10-19 13:30',
  ),
  t(
    1055,
    6,
    'Exports returning HTTP 500',
    'closed',
    'urgent',
    null,
    '2026-10-08 06:10',
    '2026-10-08 09:40',
    '2026-10-08 09:40',
  ),
  t(
    1056,
    12,
    'Cannot change billing currency',
    'open',
    'normal',
    'Sven Olsen',
    '2026-10-27 15:30',
    '2026-10-28 08:50',
  ),
  t(
    1057,
    1,
    'Exports stuck since this morning',
    'open',
    'urgent',
    'Kenji Sato',
    '2026-10-30 01:50',
    '2026-10-30 04:10',
  ),
  t(
    1058,
    11,
    'Need invoices split by cost centre',
    'open',
    'normal',
    'Lena Fischer',
    '2026-10-15 11:45',
    '2026-10-26 07:00',
  ),
  t(
    1059,
    5,
    'All exports failing with timeout',
    'open',
    'urgent',
    null,
    '2026-10-30 14:30',
    '2026-10-30 14:30',
  ),
  t(
    1060,
    7,
    'Customers charged twice for October',
    'open',
    'urgent',
    null,
    '2026-10-30 15:05',
    '2026-10-30 15:05',
  ),
  t(
    1061,
    3,
    'Sign-in fails for all users',
    'open',
    'urgent',
    null,
    '2026-10-30 16:45',
    '2026-10-30 16:45',
  ),
  t(
    1062,
    4,
    'Dashboard charts empty',
    'open',
    'high',
    null,
    '2026-10-30 17:20',
    '2026-10-30 17:20',
  ),
  t(
    1063,
    9,
    'INC-2041: exports delayed for our account',
    'open',
    'high',
    'Mei Chen',
    '2026-10-30 09:30',
    '2026-10-30 11:00',
  ),
  t(
    1064,
    2,
    'Question about the export outage',
    'closed',
    'normal',
    'Sven Olsen',
    '2026-10-30 12:00',
    '2026-10-30 13:00',
    '2026-10-30 13:00',
  ),
  t(
    1065,
    3,
    'Old helpdesk import: duplicate statements',
    'pending',
    'normal',
    'Mei Chen',
    '2026/09/10 22:20',
    '2026/09/14 10:00',
  ),
  t(
    1066,
    13,
    'How do I add a second location?',
    'closed',
    'low',
    'Sven Olsen',
    '2026-09-03 08:15',
    '2026-09-04 10:00',
    '2026-09-04 10:00',
  ),
];

export interface TicketComment {
  id: number;
  ticket_id: number;
  author_id: number;
  body: string;
  created_at: string;
}

export const TICKET_COMMENTS: readonly TicketComment[] = [
  {
    id: 1,
    ticket_id: 1042,
    author_id: 7,
    body: 'Customer was charged twice for September; checking with billing.',
    created_at: '2026-09-02 08:00',
  },
  {
    id: 2,
    ticket_id: 1042,
    author_id: 4,
    body: 'Confirmed duplicate charge on INV-2207.',
    created_at: '2026-09-04 06:30',
  },
  {
    id: 3,
    ticket_id: 1044,
    author_id: 7,
    body: 'Late fee rule fired on a paid invoice; escalated.',
    created_at: '2026-09-09 10:00',
  },
  {
    id: 4,
    ticket_id: 1047,
    author_id: 8,
    body: 'Retry backoff is exponential, investigating their 429s.',
    created_at: '2026-09-15 17:00',
  },
  {
    id: 5,
    ticket_id: 1053,
    author_id: 7,
    body: 'Asked the customer for their ledger export.',
    created_at: '2026-10-02 09:00',
  },
  {
    id: 6,
    ticket_id: 1057,
    author_id: 5,
    body: 'Looks related to the export streaming change.',
    created_at: '2026-10-30 04:10',
  },
  {
    id: 7,
    ticket_id: 1063,
    author_id: 2,
    body: 'Linked to INC-2041.',
    created_at: '2026-10-30 11:00',
  },
];

export interface Invoice {
  id: string;
  customer_id: number;
  period: string;
  amount_cents: number;
  status: 'paid' | 'overdue' | 'void';
  due_date: string;
}

function inv(
  n: number,
  customer_id: number,
  period: string,
  amount_cents: number,
  status: Invoice['status'],
): Invoice {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const due = m === 12 ? `${y + 1}-01-15` : `${y}-${String(m + 1).padStart(2, '0')}-15`;
  return { id: `INV-${n}`, customer_id, period, amount_cents, status, due_date: due };
}

export const INVOICES: readonly Invoice[] = [
  inv(2201, 1, '2026-08', 125000, 'paid'),
  inv(2202, 2, '2026-08', 34000, 'paid'),
  inv(2203, 3, '2026-08', 420000, 'paid'),
  inv(2204, 5, '2026-08', 275000, 'paid'),
  inv(2205, 7, '2026-08', 76025, 'paid'),
  inv(2206, 9, '2026-08', 310000, 'paid'),
  inv(2207, 11, '2026-08', 198000, 'paid'),
  inv(2208, 12, '2026-08', 45000, 'paid'),
  inv(2209, 1, '2026-09', 125000, 'overdue'),
  inv(2210, 2, '2026-09', 34000, 'overdue'),
  inv(2211, 3, '2026-09', 420000, 'overdue'),
  inv(2212, 5, '2026-09', 275000, 'paid'),
  inv(2213, 6, '2026-09', 52000, 'paid'),
  inv(2214, 7, '2026-09', 76025, 'overdue'),
  inv(2215, 8, '2026-09', 12500, 'overdue'),
  inv(2216, 9, '2026-09', 310000, 'overdue'),
  inv(2217, 11, '2026-09', 198000, 'paid'),
  inv(2218, 12, '2026-09', 45000, 'paid'),
  inv(2219, 1, '2026-10', 98050, 'overdue'),
  inv(2220, 3, '2026-10', 420000, 'paid'),
  inv(2221, 5, '2026-10', 275000, 'paid'),
  inv(2222, 7, '2026-10', 81000, 'void'),
  inv(2223, 9, '2026-10', 310000, 'paid'),
  inv(2224, 11, '2026-10', 198000, 'paid'),
  inv(2225, 6, '2026-10', 52000, 'paid'),
  inv(2226, 13, '2026-09', 9900, 'overdue'),
];

export interface Deploy {
  id: number;
  service: string;
  version: string;
  environment: string;
  deployed_at: string;
  deployed_by: string;
}

export const DEPLOYS: readonly Deploy[] = [
  {
    id: 1,
    service: 'billing',
    version: '2.1.0',
    environment: 'production',
    deployed_at: '2026-08-04 16:00',
    deployed_by: 'Dana Whitfield',
  },
  {
    id: 2,
    service: 'billing',
    version: '2.2.0',
    environment: 'staging',
    deployed_at: '2026-08-14 15:00',
    deployed_by: 'Marco Bianchi',
  },
  {
    id: 3,
    service: 'billing',
    version: '2.2.0',
    environment: 'production',
    deployed_at: '2026-08-15 16:00',
    deployed_by: 'Dana Whitfield',
  },
  {
    id: 4,
    service: 'billing',
    version: '2.3.0',
    environment: 'staging',
    deployed_at: '2026-09-08 15:30',
    deployed_by: 'Marco Bianchi',
  },
  {
    id: 5,
    service: 'billing',
    version: '2.3.0',
    environment: 'production',
    deployed_at: '2026-09-09 16:00',
    deployed_by: 'Dana Whitfield',
  },
  {
    id: 6,
    service: 'billing',
    version: '2.3.1',
    environment: 'production',
    deployed_at: '2026-09-21 16:00',
    deployed_by: 'Dana Whitfield',
  },
  {
    id: 7,
    service: 'billing',
    version: '2.3.2',
    environment: 'production',
    deployed_at: '2026-09-25 16:00',
    deployed_by: 'Kenji Sato',
  },
  {
    id: 8,
    service: 'billing',
    version: '2.4.0-rc1',
    environment: 'staging',
    deployed_at: '2026-10-28 15:00',
    deployed_by: 'Priya Raman',
  },
];

function sqlValue(v: string | number | null): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${v.replace(/'/g, "''")}'`;
}

function insertRows(table: string, rows: readonly object[]): string {
  return rows
    .map((row) => {
      const entries = Object.entries(row) as [string, string | number | null][];
      return `INSERT INTO ${table} (${entries.map(([k]) => k).join(', ')}) VALUES (${entries
        .map(([, v]) => sqlValue(v))
        .join(', ')});`;
    })
    .join('\n');
}

/** The whole seed: schema, then every row. */
export const SQLITE_SEED = [
  SQLITE_SCHEMA,
  insertRows('agents', AGENTS),
  insertRows('customers', CUSTOMERS),
  insertRows('tickets', TICKETS),
  insertRows('ticket_comments', TICKET_COMMENTS),
  insertRows('invoices', INVOICES),
  insertRows('deploys', DEPLOYS),
].join('\n');

// ---------------------------------------------------------------------------
// Git history

export interface Author {
  name: string;
  email: string;
  tz: string;
}

const AUTHOR_TZ: Readonly<Record<string, string>> = {
  'Priya Raman': '+0530',
  'Kenji Sato': '+0900',
  'Wen Li': '+0800',
  'Marco Bianchi': '+0200',
  'Dana Whitfield': '-0700',
};

function author(name: string): Author {
  return { name, email: person(name).email as string, tz: AUTHOR_TZ[name] as string };
}

/** What the checkout's files are rendered from; each commit mutates a copy. */
export interface RepoState {
  version: string;
  batchSize: number;
  sessionTimeout: number;
  changelog: { heading: string; items: string[] }[];
  exportSteps: string[];
  invoiceRules: string[];
  sessionNotes: string[];
  sessionDoc: string;
  webRoutes: string[];
  deployChecklist: string[];
  styles: boolean;
  exportTests: boolean;
  exportDoc: boolean;
  invoicePdf: string[];
  graphql: boolean;
}

export const INITIAL_REPO_STATE: RepoState = {
  version: '2.1.0',
  batchSize: 250,
  sessionTimeout: 30,
  changelog: [
    { heading: '## 2.1.0 - 2026-08-03', items: ['First release of the invoice export API'] },
  ],
  exportSteps: ['rows = load_invoices(account_id)'],
  invoiceRules: ['due_in_days = 30'],
  sessionNotes: [],
  sessionDoc: 'Session helpers.',
  webRoutes: ["app.get('/', home);"],
  deployChecklist: ['Run the test suite'],
  styles: false,
  exportTests: false,
  exportDoc: false,
  invoicePdf: [],
  graphql: false,
};

export const CODEOWNERS = `# Code owners: the last matching pattern takes precedence.
*                         @tomas-o
/src/billing/             @priya-r
/src/billing/export.py    @kenji-s @wen-l
/src/auth/                @kenji-s
/src/web/                 @marco-b
/config/                  @dana-w
/docs/                    @dana-w @priya-r
`;

const README = `# tidepool

Billing and invoice exports for Tidepool customers.

- \`src/billing\`: invoices, late fees and the export pipeline
- \`src/auth\`: sessions and sign-in
- \`src/web\`: the customer dashboard
- \`config/settings.toml\`: runtime settings

Releases are tagged \`vX.Y.Z\`; maintenance releases are cut from \`release/X.Y\`.
`;

function indent(lines: readonly string[], pad = '    '): string {
  return lines.map((l) => `${pad}${l}`).join('\n');
}

/** Render every tracked file of the checkout from a state. */
export function renderRepo(s: RepoState): Record<string, string> {
  const files: Record<string, string> = {
    'README.md': README,
    CODEOWNERS,
    VERSION: `${s.version}\n`,
    'CHANGELOG.md': `# Changelog\n\n${s.changelog
      .map((sec) => `${sec.heading}\n\n${sec.items.map((i) => `- ${i}`).join('\n')}\n`)
      .join('\n')}`,
    'config/settings.toml': `[export]\nbatch_size = ${s.batchSize}\nformat = "csv"\n\n[web]\nport = 8080\n`,
    'src/billing/export.py': `"""Invoice exports."""\n\nfrom .invoice import load_invoices\n\n\ndef export_invoices(account_id, batch_size):\n${indent(
      s.exportSteps,
    )}\n    return rows\n`,
    'src/billing/invoice.py': `"""Invoices and billing rules."""\n\n${s.invoiceRules.join('\n')}\n${
      s.invoicePdf.length > 0 ? `\n\ndef render_pdf(invoice):\n${indent(s.invoicePdf)}\n` : ''
    }`,
    'src/auth/session.py': `"""${s.sessionDoc}"""\n\nSESSION_TIMEOUT_MINUTES = ${s.sessionTimeout}\n${
      s.sessionNotes.length > 0 ? `\n${s.sessionNotes.join('\n')}\n` : ''
    }`,
    'src/web/app.js': `import express from 'express';\n\nconst app = express();\n${s.webRoutes.join('\n')}\n\nexport default app;\n`,
    'docs/deploy.md': `# Deploying tidepool\n\n${s.deployChecklist.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n`,
    'reports/.gitkeep': '',
  };
  if (s.styles) files['src/web/styles.css'] = ':root { color-scheme: light dark; }\n';
  if (s.exportTests)
    files['tests/test_export.py'] = 'def test_export_retries():\n    assert True\n';
  if (s.exportDoc)
    files['docs/export.md'] =
      `# Export batching\n\nExports are read in batches of \`[export].batch_size\` rows.\n`;
  if (s.graphql)
    files['src/web/graphql.js'] =
      '// Prototype GraphQL endpoint.\nexport const schema = `type Query { invoices: [Invoice] }`;\n';
  return files;
}

export interface CommitSpec {
  /** A stable key the graders and tests use. */
  key: string;
  author: string;
  /** YYYY-MM-DD; the time is 10:00 in the author's own offset. */
  date: string;
  /** Subject line, then an optional body after a blank line. */
  message: string;
  /** The key of the commit this one reverts. */
  reverts?: string;
  change(s: RepoState): void;
}

export interface BranchSpec {
  name: string;
  /** The `key` of the commit it branches from. */
  from: string;
  commits: CommitSpec[];
}

const c = (
  key: string,
  authorName: string,
  date: string,
  message: string,
  change: (s: RepoState) => void,
): CommitSpec => ({ key, author: authorName, date, message, change });

/** `main`, oldest first. */
export const MAIN_COMMITS: readonly CommitSpec[] = [
  c('c1', 'Priya Raman', '2026-08-03', 'Initial import of tidepool', () => {}),
  c('c2', 'Marco Bianchi', '2026-08-05', 'web: add invoice list page', (s) => {
    s.webRoutes.push("app.get('/invoices', listInvoices);");
  }),
  c('c3', 'Kenji Sato', '2026-08-07', 'billing: paginate invoice export (fixes #1012)', (s) => {
    s.exportSteps.push('rows = paginate(rows, batch_size)');
  }),
  c('c4', 'Dana Whitfield', '2026-08-10', 'ops: document the deploy checklist', (s) => {
    s.deployChecklist.push('Deploy to staging and watch the export queue', 'Deploy to production');
  }),
  c('c5', 'Priya Raman', '2026-08-12', 'billing: handle void invoices (fixes #1018)', (s) => {
    s.invoiceRules.push("SKIP_STATUSES = {'void'}");
  }),
  c('c6', 'Marco Bianchi', '2026-08-14', 'release: 2.2.0', (s) => {
    s.version = '2.2.0';
    s.changelog.unshift({
      heading: '## 2.2.0 - 2026-08-14',
      items: ['Paginated invoice exports', 'Void invoices are no longer due'],
    });
  }),
  c('c7', 'Kenji Sato', '2026-08-19', 'auth: tune session handling', (s) => {
    s.sessionTimeout = 45;
    s.sessionNotes.push('REFRESH_BEFORE_EXPIRY_MINUTES = 5');
  }),
  c(
    'c8',
    'Priya Raman',
    '2026-08-21',
    'billing: round export totals per line (fixes #1031)',
    (s) => {
      s.exportSteps.push('rows = [round_line(r) for r in rows]');
    },
  ),
  c('c9', 'Marco Bianchi', '2026-08-25', 'web: dark mode toggle (closes #1040)', (s) => {
    s.webRoutes.push("app.post('/prefs/theme', setTheme);");
    s.styles = true;
  }),
  c('c10', 'Dana Whitfield', '2026-08-27', 'config: raise export batch size', (s) => {
    s.batchSize = 500;
  }),
  c('c11', 'Kenji Sato', '2026-09-01', 'billing: retry failed exports (fixes #1036)', (s) => {
    s.exportSteps.push('rows = with_retries(rows, attempts=3)');
    s.exportTests = true;
  }),
  c('c12', 'Priya Raman', '2026-09-03', 'auth: tidy session docstrings', (s) => {
    s.sessionDoc = 'Session helpers: expiry and refresh for signed-in users.';
  }),
  {
    ...c(
      'c12b',
      'Marco Bianchi',
      '2026-09-05',
      'Revert "web: dark mode toggle (closes #1040)"\n\nContrast problems in the invoice table; dark mode moves to a later release.',
      (s) => {
        s.webRoutes = s.webRoutes.filter((r) => !r.includes('/prefs/theme'));
        s.styles = false;
      },
    ),
    reverts: 'c9',
  },
  c('c13', 'Marco Bianchi', '2026-09-08', 'release: 2.3.0', (s) => {
    s.version = '2.3.0';
    s.changelog.unshift({
      heading: '## 2.3.0 - 2026-09-08',
      items: ['Longer sessions', 'Export totals rounded per line', 'Export retries'],
    });
  }),
  c('c14', 'Dana Whitfield', '2026-09-15', 'ops: add healthcheck endpoint', (s) => {
    s.webRoutes.push("app.get('/healthz', healthz);");
  }),
  c('c15', 'Priya Raman', '2026-09-18', 'billing: invoice PDF groundwork', (s) => {
    s.invoiceRules.push('PDF_TEMPLATE = "invoice.html"');
  }),
  c('c16', 'Marco Bianchi', '2026-09-22', 'auth: log session expiry', (s) => {
    s.sessionNotes.push('LOG_EXPIRED_SESSIONS = True');
  }),
  c(
    'c17',
    'Kenji Sato',
    '2026-09-24',
    'billing: fix currency in export header (fixes #1049)',
    (s) => {
      s.exportSteps.push('header = export_header(currency=account_currency(account_id))');
    },
  ),
  c('c18', 'Dana Whitfield', '2026-09-29', 'config: raise export batch size again', (s) => {
    s.batchSize = 1000;
  }),
  c('c19', 'Priya Raman', '2026-10-01', 'docs: explain export batching', (s) => {
    s.exportDoc = true;
  }),
  c('c20', 'Marco Bianchi', '2026-10-06', 'web: settings page', (s) => {
    s.webRoutes.push("app.get('/settings', settings);");
  }),
  c('c21', 'Kenji Sato', '2026-10-08', 'billing: stream large exports', (s) => {
    s.exportSteps.push('rows = stream_rows(rows, chunk=batch_size * 4)');
  }),
  c('c22', 'Dana Whitfield', '2026-10-13', 'ops: alert on export lag', (s) => {
    s.deployChecklist.push('Check the export lag alert is green');
  }),
  c('c23', 'Priya Raman', '2026-10-15', 'billing: late fee for overdue invoices', (s) => {
    s.invoiceRules.push('LATE_FEE_PERCENT = 1.5');
  }),
  c('c24', 'Marco Bianchi', '2026-10-20', 'web: show overdue badge', (s) => {
    s.webRoutes.push("app.get('/invoices/overdue', overdueBadge);");
  }),
  c('c25', 'Wen Li', '2026-10-22', 'auth: rotate session signing keys', (s) => {
    s.sessionNotes.push('SIGNING_KEY_ROTATION_DAYS = 30');
  }),
  c('c26', 'Priya Raman', '2026-10-27', 'chore: open the 2.4.0 changelog', (s) => {
    s.changelog.unshift({
      heading: '## Unreleased',
      items: [
        'Streamed exports for large accounts',
        'Late fees on overdue invoices',
        'Overdue badge',
      ],
    });
  }),
];

export const BRANCHES: readonly BranchSpec[] = [
  {
    name: 'release/2.3',
    from: 'c13',
    commits: [
      c('r1', 'Kenji Sato', '2026-09-20', 'billing: backport export retry backoff', (s) => {
        s.exportSteps.push('rows = with_backoff(rows)');
        s.version = '2.3.1';
      }),
      c('r2', 'Dana Whitfield', '2026-09-24', 'config: lower export batch size for 2.3.x', (s) => {
        s.batchSize = 400;
        s.version = '2.3.2';
      }),
    ],
  },
  {
    name: 'feature/invoice-pdf',
    from: 'c15',
    commits: [
      c('p1', 'Priya Raman', '2026-09-25', 'billing: render invoice PDFs', (s) => {
        s.invoicePdf.push('html = template(PDF_TEMPLATE, invoice)', 'return to_pdf(html)');
      }),
      c('p2', 'Priya Raman', '2026-10-02', 'billing: PDF footer with payment terms', (s) => {
        s.invoicePdf.unshift('footer = payment_terms(invoice)');
      }),
    ],
  },
  {
    name: 'experiment/graphql',
    from: 'c20',
    commits: [
      c('g1', 'Marco Bianchi', '2026-10-09', 'web: graphql prototype', (s) => {
        s.graphql = true;
      }),
    ],
  },
  // Fast-forwarded into main and never deleted: nothing on them is missing from main.
  { name: 'fix/export-header', from: 'c17', commits: [] },
  { name: 'hotfix/late-fee', from: 'c23', commits: [] },
];

/** Lightweight tags → the commit key they point at. */
export const TAGS: Readonly<Record<string, string>> = {
  'v2.1.0': 'c1',
  'v2.2.0': 'c6',
  'v2.3.0': 'c13',
  'v2.3.1': 'r1',
};

/** Who the checkout's own commits are by (repo-local config). */
export const CHECKOUT_USER = { name: 'Marco Bianchi', email: 'marco@tidepool.dev' };

export const COMMIT_AUTHORS: Readonly<Record<string, Author>> = Object.fromEntries(
  ['Priya Raman', 'Kenji Sato', 'Wen Li', 'Marco Bianchi', 'Dana Whitfield'].map((n) => [
    n,
    author(n),
  ]),
);

/** The repo state at the tip of `main`. */
export function mainState(): RepoState {
  const s = structuredClone(INITIAL_REPO_STATE);
  for (const commit of MAIN_COMMITS) commit.change(s);
  return s;
}

/** The repo state after `key` on whichever line holds it. */
export function stateAt(key: string): RepoState {
  const s = structuredClone(INITIAL_REPO_STATE);
  for (const commit of MAIN_COMMITS) {
    commit.change(s);
    if (commit.key === key) return s;
  }
  for (const branch of BRANCHES) {
    const b = stateAt(branch.from);
    for (const commit of branch.commits) {
      commit.change(b);
      if (commit.key === key) return b;
    }
  }
  throw new Error(`unknown commit ${key}`);
}

/** The working tree edits on top of `main`: staged, unstaged, untracked. */
export const STAGED_PATH = 'src/billing/export.py';
export const UNSTAGED_PATH = 'src/web/app.js';
export const UNTRACKED_PATH = 'notes/scratch.md';

export function workingTreeEdits(): { staged: string; unstaged: string; untracked: string } {
  const files = renderRepo(mainState());
  return {
    staged: (files[STAGED_PATH] as string).replace(
      '    return rows\n',
      '    rows = [round(r, 2) for r in rows]\n    return rows\n',
    ),
    unstaged: (files[UNSTAGED_PATH] as string).replace(
      '\nexport default app;',
      "app.get('/invoices/filters', invoiceFilters); // WIP\n\nexport default app;",
    ),
    untracked: '# scratch\n\n- ask Priya about the late fee rounding\n',
  };
}

// ---------------------------------------------------------------------------
// Intranet

export interface Incident {
  id: string;
  severity: 'sev1' | 'sev2' | 'sev3';
  title: string;
  service: string;
  opened_at: string;
  status: 'resolved' | 'investigating';
}

const INCIDENT_SEEDS: readonly [string, Incident['severity'], string, string][] = [
  ['2026-07-02T08:15:00Z', 'sev3', 'Dashboard fonts fail to load', 'web'],
  ['2026-07-06T13:40:00Z', 'sev2', 'Elevated export latency', 'export-worker'],
  ['2026-07-11T02:05:00Z', 'sev1', 'Sign-in unavailable in APAC', 'auth'],
  ['2026-07-15T19:30:00Z', 'sev3', 'Search results stale', 'search'],
  ['2026-07-19T07:50:00Z', 'sev2', 'Invoice emails delayed', 'billing'],
  ['2026-07-24T11:10:00Z', 'sev3', 'Settings page 404', 'web'],
  ['2026-07-29T22:45:00Z', 'sev2', 'Webhook retries spiking', 'billing'],
  ['2026-08-03T05:20:00Z', 'sev1', 'Invoices generated twice', 'billing'],
  ['2026-08-07T16:00:00Z', 'sev3', 'Slow customer search', 'search'],
  ['2026-08-12T09:35:00Z', 'sev2', 'Export queue backlog', 'export-worker'],
  ['2026-08-16T14:25:00Z', 'sev3', 'Broken link in invoice email', 'billing'],
  ['2026-08-21T03:55:00Z', 'sev2', 'Session refresh errors', 'auth'],
  ['2026-08-25T18:15:00Z', 'sev1', 'Exports failing for all accounts', 'export-worker'],
  ['2026-08-29T10:05:00Z', 'sev3', 'Dark mode contrast issue', 'web'],
  ['2026-09-02T21:30:00Z', 'sev2', 'Late fee job skipped', 'billing'],
  ['2026-09-06T06:40:00Z', 'sev3', 'Search index rebuild slow', 'search'],
  ['2026-09-10T12:20:00Z', 'sev2', 'Elevated 5xx on dashboard', 'web'],
  ['2026-09-14T01:15:00Z', 'sev1', 'Payment webhooks dropped', 'billing'],
  ['2026-09-18T15:45:00Z', 'sev3', 'Healthcheck flapping', 'web'],
  ['2026-09-21T08:30:00Z', 'sev2', 'Export retries exhausted', 'export-worker'],
  ['2026-09-24T20:10:00Z', 'sev3', 'Wrong currency label', 'billing'],
  ['2026-09-27T04:00:00Z', 'sev2', 'Sign-in latency in EU', 'auth'],
  ['2026-09-30T23:40:00Z', 'sev1', 'Invoice PDFs blank', 'billing'],
  ['2026-10-01T00:20:00Z', 'sev1', 'Billing database failover', 'billing'],
  ['2026-10-04T10:30:00Z', 'sev3', 'Search typo tolerance off', 'search'],
  ['2026-10-07T17:05:00Z', 'sev2', 'Export lag above 30 minutes', 'export-worker'],
  ['2026-10-09T09:50:00Z', 'sev3', 'Settings save button disabled', 'web'],
  ['2026-10-12T13:15:00Z', 'sev2', 'Late fees applied to paid invoices', 'billing'],
  ['2026-10-14T02:40:00Z', 'sev3', 'Session cookie warnings', 'auth'],
  ['2026-10-16T19:25:00Z', 'sev1', 'Dashboard down for all users', 'web'],
  ['2026-10-19T07:10:00Z', 'sev3', 'Search slow for large accounts', 'search'],
  ['2026-10-21T15:35:00Z', 'sev2', 'Webhook signature mismatch', 'billing'],
  ['2026-10-23T11:45:00Z', 'sev3', 'Overdue badge miscounts', 'web'],
  ['2026-10-25T05:55:00Z', 'sev2', 'Export worker memory pressure', 'export-worker'],
  ['2026-10-27T21:05:00Z', 'sev3', 'Search facets missing', 'search'],
  ['2026-10-29T03:30:00Z', 'sev2', 'Search indexing paused', 'search'],
  ['2026-10-30T08:05:00Z', 'sev1', 'Billing exports delayed for enterprise accounts', 'billing'],
];

/** Oldest first; ids INC-2005 … INC-2041. The last one is still being investigated. */
export const INCIDENTS: readonly Incident[] = INCIDENT_SEEDS.map(
  ([opened_at, severity, title, service], i) => ({
    id: `INC-${2005 + i}`,
    severity,
    title,
    service,
    opened_at,
    status: i === INCIDENT_SEEDS.length - 1 ? 'investigating' : 'resolved',
  }),
);

/** The incidents API's page size (newest first). */
export const INCIDENTS_PER_PAGE = 10;

export const REPORT_INCIDENT = 'INC-2041';
/** The commit the INC-2041 report blames (by key; the report carries its short hash). */
export const CULPRIT_COMMIT = 'c21';
/**
 * The customers the INC-2041 report lists as affected, as the report
 * writes them (legal names, and one that is not a customer of ours)…
 */
export const INCIDENT_AFFECTED_LISTED = [
  'Acme Freight Pte. Ltd.',
  'Granite Insurance Group',
  'Indigo Retail',
  'Lumen Media GmbH',
  'Northwind Travel',
];
/** …and the support database's customers among them. */
export const INCIDENT_AFFECTED = [
  'Acme Freight',
  'Granite Insurance',
  'Indigo Retail',
  'Lumen Media',
];

export interface OncallWeek {
  week: string;
  primary: string;
  secondary: string;
  note: string;
}

const ROTA = ['Dana Whitfield', 'Kenji Sato', 'Priya Raman', 'Wen Li', 'Marco Bianchi'];
const ROTA_NOTES = [
  'Quiet week expected; no releases scheduled.',
  'Release freeze ends Wednesday; watch the export queue after the deploy.',
  'Billing month-end close: late fee job runs Thursday 02:00 UTC.',
  'Primary covers the APAC morning; secondary covers the Americas afternoon.',
  'Search reindex planned for the weekend; expect elevated latency alerts.',
  'Holiday in one or more regions; confirm hand-off times in the channel.',
];

function isoWeek(start: Date, i: number): string {
  return new Date(start.getTime() + i * 7 * 86_400_000).toISOString().slice(0, 10);
}

/** 48 weeks from 2026-03-02; each week's primary and secondary are consecutive in {@link ROTA}. */
export const ONCALL: readonly OncallWeek[] = Array.from({ length: 48 }, (_, i) => ({
  week: isoWeek(new Date('2026-03-02T00:00:00Z'), i),
  primary: ROTA[i % ROTA.length] as string,
  secondary: ROTA[(i + 1) % ROTA.length] as string,
  note: ROTA_NOTES[i % ROTA_NOTES.length] as string,
}));

export function oncallFor(week: string): OncallWeek {
  const w = ONCALL.find((x) => x.week === week);
  if (w === undefined) throw new Error(`no rota week ${week}`);
  return w;
}

export interface Release {
  version: string;
  tag: string | null;
  branch: string;
  date: string;
}

export const RELEASES: readonly Release[] = [
  { version: '2.3.2', tag: null, branch: 'release/2.3', date: '2026-09-25' },
  { version: '2.3.1', tag: 'v2.3.1', branch: 'release/2.3', date: '2026-09-21' },
  { version: '2.3.0', tag: 'v2.3.0', branch: 'main', date: '2026-09-08' },
  { version: '2.2.0', tag: 'v2.2.0', branch: 'main', date: '2026-08-14' },
  { version: '2.1.0', tag: 'v2.1.0', branch: 'main', date: '2026-08-03' },
];

export interface ServiceStatus {
  service: string;
  state: 'Operational' | 'Degraded performance' | 'Partial outage';
  since?: string;
}

export const STATUS: readonly ServiceStatus[] = [
  { service: 'auth', state: 'Operational' },
  { service: 'billing', state: 'Degraded performance', since: '2026-10-30 08:05 UTC' },
  { service: 'export-worker', state: 'Operational' },
  { service: 'search', state: 'Partial outage', since: '2026-10-29 03:30 UTC' },
  { service: 'web', state: 'Operational' },
];

function html(title: string, body: string): string {
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title></head>\n<body>\n<nav><a href="/">Intranet home</a></nav>\n<main>\n${body}\n</main>\n<footer>Tidepool internal. Do not share outside the company.</footer>\n</body></html>\n`;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return `<table>\n<tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr>\n${rows
    .map((r) => `<tr>${r.map((v) => `<td>${v}</td>`).join('')}</tr>`)
    .join('\n')}\n</table>`;
}

/** A page the intranet serves: a static body, or a function of the query string. */
export interface IntranetPage {
  type: string;
  body: string | ((query: URLSearchParams) => { status: number; body: string });
}

const ONCALL_POLICY = `<h2>How the rota works</h2>
<p>Every week has a primary and a secondary on-call engineer. The primary takes every page first and owns
customer-facing incidents until they are resolved or handed over. The secondary is the escalation path when
the primary does not acknowledge a page within 15 minutes, and covers the primary during planned absences.
Weeks start on Monday at 09:00 in the primary's own time zone.</p>
<p>Swaps are fine as long as both people agree and the rota below is updated before the week starts. If you
cannot find a swap, ask your manager; never leave a week without a primary. Hand-offs happen in the
#oncall channel with a short summary of open incidents, the state of the export queue and anything unusual
in the billing jobs.</p>
<h2>Paging rules</h2>
<p>Sev1 pages the primary and the secondary at once and opens an incident report. Sev2 pages the primary
only. Sev3 creates a ticket for the next business day. Every sev1 needs a written report within five
business days, linked from the incidents API.</p>
<h2>Compensation</h2>
<p>On-call weeks are compensated with one day off in lieu, to be taken within the following month. Pages
outside working hours that take more than an hour add half a day.</p>`;

function incidentsPage(query: URLSearchParams): { status: number; body: string } {
  const newestFirst = [...INCIDENTS].reverse();
  const pages = Math.ceil(newestFirst.length / INCIDENTS_PER_PAGE);
  const raw = query.get('page') ?? '1';
  const page = Number(raw);
  if (!Number.isInteger(page) || page < 1) {
    return { status: 400, body: JSON.stringify({ error: `invalid page: ${raw}` }) };
  }
  const slice = newestFirst.slice((page - 1) * INCIDENTS_PER_PAGE, page * INCIDENTS_PER_PAGE);
  return {
    status: 200,
    body: JSON.stringify(
      {
        incidents: slice,
        page,
        per_page: INCIDENTS_PER_PAGE,
        next: page < pages ? `/api/incidents?page=${page + 1}` : null,
      },
      null,
      2,
    ),
  };
}

/**
 * Every page of the intranet, by path. `culpritShort` is the abbreviated
 * hash of {@link CULPRIT_COMMIT}, known once the checkout is built.
 */
export function intranetPages(culpritShort: string): Record<string, IntranetPage> {
  const team = teamPage().map((p) => [p.name, p.role, p.timezone]);
  return {
    '/': {
      type: 'text/html',
      body: html(
        'Tidepool intranet',
        `<h1>Tidepool intranet</h1>
<ul>
<li><a href="/status">Service status</a></li>
<li><a href="/team">Team directory</a></li>
<li><a href="/handbook/oncall">Handbook: on-call rota</a></li>
<li><a href="/releases.json">Releases (JSON)</a></li>
<li><a href="/api/incidents">Incidents API (JSON, newest first, paged)</a></li>
<li>Incident reports: /incidents/&lt;incident id&gt;</li>
</ul>`,
      ),
    },
    '/status': {
      type: 'text/html',
      body: html(
        'Service status',
        `<h1>Service status</h1>\n<p>Last updated 2026-10-30 18:00 UTC.</p>\n${table(
          ['Service', 'Status', 'Since'],
          STATUS.map((s) => [s.service, s.state, s.since ?? '']),
        )}\n<h2>Recently resolved</h2>\n<p>auth: sign-in latency in EU (resolved 2026-09-27).</p>`,
      ),
    },
    '/team': {
      type: 'text/html',
      body: html(
        'Team directory',
        `<h1>Team directory</h1>\n<p>Everyone currently on the Tidepool team.</p>\n${table(['Name', 'Role', 'Time zone'], team)}`,
      ),
    },
    '/handbook/oncall': {
      type: 'text/html',
      body: html(
        'On-call rota',
        `<h1>On-call rota</h1>\n${ONCALL_POLICY}\n<h2>Rota</h2>\n${table(
          ['Week of', 'Primary', 'Secondary', 'Notes'],
          ONCALL.map((w) => [w.week, w.primary, w.secondary, w.note]),
        )}`,
      ),
    },
    '/releases.json': {
      type: 'application/json',
      body: JSON.stringify(
        { service: 'billing', production: '2.3.2', staging: '2.4.0-rc1', releases: RELEASES },
        null,
        2,
      ),
    },
    '/api/incidents': { type: 'application/json', body: incidentsPage },
    [`/incidents/${REPORT_INCIDENT}`]: {
      type: 'text/html',
      body: html(
        `${REPORT_INCIDENT}: billing exports delayed`,
        `<h1>${REPORT_INCIDENT}: Billing exports delayed for enterprise accounts</h1>
<p><b>Severity:</b> sev1. <b>Status:</b> investigating. <b>Opened:</b> 2026-10-30 08:05 UTC.
<b>Incident commander:</b> Dana Whitfield. <b>Reported by:</b> Sven Olsen (support).</p>
<h2>Impact</h2>
<p>Invoice exports for large accounts queue for hours instead of minutes. Affected customers so far:</p>
<ul>${INCIDENT_AFFECTED_LISTED.map((n) => `<li>${n}</li>`).join('')}</ul>
<h2>Root cause</h2>
<p>The export pipeline change in commit <code>${culpritShort}</code> reads rows in chunks four times the
configured batch size; with <code>batch_size = 1000</code> on main the worker runs out of memory and restarts.</p>
<h2>Next steps</h2>
<ul><li>Lower the chunk size and backfill the delayed exports.</li><li>Open a support ticket for each affected customer.</li></ul>`,
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Expected answers, derived from the data above

/** Files whose content differs between two states (added, changed or removed). */
export function changedFiles(a: RepoState, b: RepoState): string[] {
  const fa = renderRepo(a);
  const fb = renderRepo(b);
  return [...new Set([...Object.keys(fa), ...Object.keys(fb)])]
    .filter((p) => fa[p] !== fb[p])
    .toSorted();
}

/** Main commits strictly after `from` up to and including `to` (by key). */
export function commitsBetween(from: string, to: string): CommitSpec[] {
  const i = MAIN_COMMITS.findIndex((x) => x.key === from);
  const j = MAIN_COMMITS.findIndex((x) => x.key === to);
  return MAIN_COMMITS.slice(i + 1, j + 1);
}

/** The owners CODEOWNERS gives `path` (the last matching pattern wins). */
export function codeOwnersOf(path: string): string[] {
  let owners: string[] = [];
  for (const line of CODEOWNERS.split('\n')) {
    const [pattern, ...handles] = line.trim().split(/\s+/);
    if (pattern === undefined || pattern === '' || pattern.startsWith('#')) continue;
    const match =
      pattern === '*' ||
      (pattern.endsWith('/') ? `/${path}`.startsWith(pattern) : `/${path}` === pattern);
    if (match) owners = handles.map((h) => h.replace(/^@/, ''));
  }
  return owners;
}

/** The comparable form of a support-database timestamp (old-helpdesk rows use slashes). */
export function sortableTime(t: string): string {
  return t.replace(/\//g, '-');
}

/** `HH:MM` on the wall clock in `timezone` for a UTC `YYYY-MM-DD HH:MM` (or `YYYY/MM/DD HH:MM`). */
export function localTime(utc: string, timezone: string): string {
  const date = new Date(`${utc.replace(/\//g, '-').replace(' ', 'T')}:00Z`);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function ticketRefs(message: string): number[] {
  return [...message.matchAll(/#(\d{4})/g)].map((m) => Number(m[1]));
}

/** Tickets referenced by commits in a range that shipped: reverted commits and the reverts themselves excluded. */
function shippedTicketRefs(commits: readonly CommitSpec[]): number[] {
  const reverted = new Set(commits.flatMap((x) => (x.reverts !== undefined ? [x.reverts] : [])));
  return commits
    .filter((x) => x.reverts === undefined && !reverted.has(x.key))
    .flatMap((x) => ticketRefs(x.message));
}

const tagged = (tag: string): string => TAGS[tag] as string;
const mainReleaseTag = (): string => {
  const r = RELEASES.find((x) => x.branch === 'main');
  return r?.tag as string;
};

export const EXPECTED = {
  releaseFiles: changedFiles(stateAt(tagged('v2.2.0')), stateAt(tagged('v2.3.0'))),
  billingOwner: SERVICE_OWNERS['billing'] as string,
  billingOwnerManager: REPORTS_TO[SERVICE_OWNERS['billing'] as string] as string,
  oncallThisWeek: oncallFor('2026-10-26'),
  /** Sev1 and sev2 incidents opened in Q3 2026 (UTC), per service with any. */
  q3Incidents: (() => {
    const counts: Record<string, number> = {};
    for (const i of INCIDENTS) {
      if (i.severity === 'sev3' || i.opened_at < '2026-07-01' || i.opened_at >= '2026-10-01')
        continue;
      counts[i.service] = (counts[i.service] ?? 0) + 1;
    }
    return counts;
  })(),
  /** Some rows came from the old helpdesk with `2026/08/19`-style timestamps. */
  stalePending: TICKETS.filter(
    (x) => x.status === 'pending' && x.updated_at.replace(/\//g, '-') < '2026-09-01',
  ).map((x) => x.id),
  /** Open or pending tickets of Lena Fischer's direct reports opened before 09:00 or after 17:00 in the customer's zone. */
  afterHours: TICKETS.filter(
    (x) =>
      x.status !== 'closed' && x.assignee !== null && REPORTS_TO[x.assignee] === 'Lena Fischer',
  )
    .filter((x) => {
      const local = localTime(
        x.opened_at,
        (CUSTOMERS.find((cu) => cu.id === x.customer_id) as Customer).timezone,
      );
      return local < '09:00' || local > '17:00';
    })
    .map((x) => x.id),
  /** Branches with commits main does not have. */
  unmergedBranches: BRANCHES.filter((b) => b.commits.length > 0)
    .map((b) => b.name)
    .toSorted(),
  /** Commits on main after v2.3.0 that change a file CODEOWNERS gives to @kenji-s. */
  kenjiOwnedCommits: (() => {
    const out: string[] = [];
    const st = structuredClone(INITIAL_REPO_STATE);
    let shipped = false;
    for (const commit of MAIN_COMMITS) {
      const before = structuredClone(st);
      commit.change(st);
      if (shipped && changedFiles(before, st).some((f) => codeOwnersOf(f).includes('kenji-s'))) {
        out.push(commit.key);
      }
      if (commit.key === TAGS['v2.3.0']) shipped = true;
    }
    return out;
  })(),
  /** Primary weeks per engineer for rota weeks starting 2026-07-01 … 2026-12-31. */
  primaryWeeks: ONCALL.filter((w) => w.week >= '2026-07-01' && w.week <= '2026-12-31').reduce<
    Record<string, number>
  >((acc, w) => ({ ...acc, [w.primary]: (acc[w.primary] ?? 0) + 1 }), {}),
  /**
   * Overdue follow-up: per customer with an overdue invoice, the most
   * recently opened open-or-pending ticket to comment on, or none (a new
   * ticket is due).
   */
  overdueFollowUp: [
    ...new Set(INVOICES.filter((i) => i.status === 'overdue').map((i) => i.customer_id)),
  ]
    .toSorted((a, b) => a - b)
    .map((customer) => {
      const open = TICKETS.filter(
        (x) => x.customer_id === customer && x.status !== 'closed',
      ).toSorted((a, b) => sortableTime(b.opened_at).localeCompare(sortableTime(a.opened_at)));
      return { customer, ticket: open[0]?.id ?? null };
    }),
  overdueComment: 'Reminder: you have an overdue invoice. Please arrange payment.',
  /** Christmas Day 2026 is a Friday: the rota week that holds it starts on Monday the 21st. */
  oncallChristmas: oncallFor('2026-12-21'),
  commentAuthor: AGENTS.find((a) => a.name === 'Lena Fischer') as Agent,
  /** Dana's 16:00 in Phoenix (UTC-7, no DST) is 23:00 UTC. */
  deployTimes: Object.fromEntries(
    (TEAM_MEMBERS['Billing team'] as string[]).map((n) => [
      n,
      { 'Asia/Kolkata': '04:30', 'Asia/Tokyo': '08:00', 'Asia/Shanghai': '07:00' }[
        person(n).timezone
      ] as string,
    ]),
  ) as Record<string, string>,
  callTicket: 1057,
  /** 10:00 in Singapore (UTC+8) is 07:30 in Kolkata (UTC+5:30). */
  callOwner: CUSTOMERS[0]?.account_owner as string,
  callOwnerTime: '07:30',
  codeOwners: { 'Kenji Sato': 'Asia/Tokyo', 'Wen Li': 'Asia/Shanghai' } as Record<string, string>,
  releaseTicketCustomers: [
    ...new Set(
      shippedTicketRefs(commitsBetween(tagged('v2.2.0'), tagged('v2.3.0'))).map((id) =>
        customerName((TICKETS.find((tk) => tk.id === id) as Ticket).customer_id),
      ),
    ),
  ].toSorted(),
  untaggedDeploys: [
    ...new Set(DEPLOYS.map((d) => d.version).filter((v) => !(`v${v}` in TAGS))),
  ].toSorted(),
  overdueEnterprise: (() => {
    const totals = new Map<string, number>();
    for (const i of INVOICES) {
      const cust = CUSTOMERS.find((x) => x.id === i.customer_id) as Customer;
      if (i.status !== 'overdue' || cust.plan !== 'enterprise') continue;
      totals.set(cust.name, (totals.get(cust.name) ?? 0) + i.amount_cents);
    }
    return Object.fromEntries([...totals].map(([n, cents]) => [n, cents / 100])) as Record<
      string,
      number
    >;
  })(),
  leaveManager: REPORTS_TO['Lena Fischer'] as string,
  leaveTickets: TICKETS.filter((x) => x.assignee === 'Lena Fischer' && x.status !== 'closed').map(
    (x) => x.id,
  ),
  newHires: NEW_HIRES,
  teamPage: teamPage(),
  unreleasedCommits: commitsBetween(tagged(mainReleaseTag()), 'c26').length,
  culprit: {
    author: (MAIN_COMMITS.find((x) => x.key === CULPRIT_COMMIT) as CommitSpec).author,
    manager: REPORTS_TO[
      (MAIN_COMMITS.find((x) => x.key === CULPRIT_COMMIT) as CommitSpec).author
    ] as string,
  },
  incidentNewTickets: INCIDENT_AFFECTED.filter(
    (name) =>
      !TICKETS.some(
        (tk) =>
          tk.status !== 'closed' &&
          tk.subject.includes(REPORT_INCIDENT) &&
          customerName(tk.customer_id) === name,
      ),
  ),
  urgentUnassigned: TICKETS.filter(
    (x) => x.priority === 'urgent' && x.assignee === null && x.status === 'open',
  ).map((x) => x.id),
} as const;
