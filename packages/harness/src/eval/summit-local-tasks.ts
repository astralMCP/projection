/**
 * The `summit-local` tier: 24 tasks against the summit-local world
 * (summit-local-world.ts) — six real servers on one seeded company
 * (summit-local-fixtures.ts). Opt-in only (needs `pnpm run
 * setup:servers-real`) and held out: calibrated in `direct` mode only.
 *
 * Ten tasks need one box and fourteen need two or three. The kinds mix
 * lookups, bulk reads that count or aggregate, bulk writes, branching
 * writes, chains across boxes, paging (the git log's default 10 commits,
 * the fetch server's 5000-character pages, the incidents API's pages) and
 * tasks where the obvious tool or query is the wrong one: the git server's
 * `git_diff` takes no range and a commit in the range is reverted; it has
 * no tag listing; `git_branch` with `not_contains: main` also lists
 * branches already fast-forwarded into main; the time server converts on
 * today's date, not the ticket's; old-helpdesk rows sort wrong as strings;
 * `append_insight` is not a ticket comment.
 *
 * Answers that are a value or a set are read from a final `ANSWER: …`
 * line the prompt asks for; per-item tables are read row by row. Write
 * tasks are graded on the end state of the real world (the database, the
 * graph file, the repository, the checkout), never on which tool made the
 * change, and `forbid` the writes that would do harm. Every task's turn
 * budget is 2N + 10 action turns ({@link budget}) for its N per-item
 * calls.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SideEffect } from '../types.js';
import { answerLine, budget } from './multi-hard-tasks.js';
import { boxOf, isBoxWrite, unbox } from './multi-tasks.js';
import { qualifiedName } from './multi-world.js';
import { str, type EvalTask, type TaskKind, type VerifyContext } from './task-core.js';
import {
  AGENTS,
  CUSTOMERS,
  EXPECTED,
  FORMER_CONTRACTOR,
  MEMORY_GRAPH,
  NEW_HIRES,
  PEOPLE,
  REPORT_INCIDENT,
  STAGED_PATH,
  BRANCHES,
  STATUS,
  TEAM_PAGE_CHANGES,
  TICKET_COMMENTS,
  TICKETS,
  UNSTAGED_PATH,
  UNTRACKED_PATH,
  workingTreeEdits,
  INVOICES,
  DEPLOYS,
  type MemoryEntity,
  type MemoryRecord,
  type MemoryRelation,
} from './summit-local-fixtures.js';
import { git, sqliteTable } from './summit-local-world.js';
import type { SummitBoxAlias, WorldFacts } from './world.js';

const TIER = 'summit-local' as const;

function inBox(alias: SummitBoxAlias, names: readonly string[]): string[] {
  return names.map((name) => qualifiedName(alias, name));
}

/** Some call went to box `alias`. */
function touched(calls: SideEffect[], alias: SummitBoxAlias): boolean {
  return calls.some((call) => boxOf(call.tool) === alias);
}

/** Some call to box `alias` used one of `tools`. */
function used(calls: SideEffect[], alias: SummitBoxAlias, tools: readonly string[]): boolean {
  return unbox(calls, alias).calls.some((call) => tools.includes(call.tool));
}

const ANSWER = (what: string): string =>
  `End your reply with a line "ANSWER: " followed by ${what}.`;

// ---------------------------------------------------------------------------
// Text parsing

/** Lower-cased, accents dropped, markdown emphasis and code marks removed. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[*_`]/g, '')
    .toLowerCase();
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** A person's name as a whole phrase (accent- and case-insensitive). */
function nameToken(name: string): RegExp {
  return new RegExp(`(?<![\\w-])${escaped(fold(name))}(?![\\w-])`, 'g');
}

/** Positions of every whole-phrase occurrence of each candidate in `text`, earliest first. */
export function namesIn(text: string, candidates: readonly string[]): string[] {
  const folded = fold(text);
  const hits: { name: string; at: number }[] = [];
  for (const name of candidates) {
    for (const m of folded.matchAll(nameToken(name))) hits.push({ name, at: m.index });
  }
  return hits.toSorted((a, b) => a.at - b.at).map((h) => h.name);
}

/** Every person the world knows, current or not. */
const ALL_PEOPLE: readonly string[] = [
  ...PEOPLE.map((p) => p.name),
  ...NEW_HIRES.map((p) => p.name),
  FORMER_CONTRACTOR,
];

const SERVICES = STATUS.map((s) => s.service);

/** Distinct people named, in order of first mention. */
function peopleIn(text: string): string[] {
  return [...new Set(namesIn(text, ALL_PEOPLE))];
}

/** A clock time `H:MM` or `HH:MM`, optionally with am/pm, as 24-hour `HH:MM`. */
const TIME = /\b(\d{1,2}):(\d{2})(?:\s*([ap])\.?m\.?)?/i;

export function clock(match: RegExpExecArray): string {
  let h = Number(match[1]);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'p' && h < 12) h += 12;
  if (meridiem === 'a' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${match[2] as string}`;
}

/** For each line naming `name`, the first clock time after it on that line. */
export function timesAfter(text: string, name: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const folded = fold(line);
    const m = nameToken(name).exec(folded);
    if (m === null) continue;
    const rest = folded.slice(m.index + m[0].length);
    const t = TIME.exec(rest);
    if (t !== null) out.push(clock(t));
  }
  return out;
}

function sameSet<T>(actual: readonly T[], expected: readonly T[]): boolean {
  const a = new Set(actual);
  const e = new Set(expected);
  return a.size === e.size && [...e].every((x) => a.has(x));
}

/** Whole numbers on a line, ignoring dates, times and version strings. */
function plainNumbers(line: string): number[] {
  return [
    ...line.replace(/\d{4}-\d{2}-\d{2}/g, ' ').matchAll(/(?<![\w.:-])\d+(?![\w.:-]|\.\d)/g),
  ].map((m) => Number(m[0]));
}

// ---------------------------------------------------------------------------
// Answer graders (exported for the offline tests)

/** The ANSWER line names exactly `expected`, in that order, and no one else. */
export function gradeNamesInOrder(finalText: string, expected: readonly string[]): boolean {
  const line = answerLine(finalText);
  if (line === undefined) return false;
  const named = peopleIn(line);
  return named.length === expected.length && named.every((n, i) => n === expected[i]);
}

/** Version strings (`2.3.0`, `v2.4.0-rc1`) on a line, without the `v`. */
function versionsIn(line: string): string[] {
  return [...line.matchAll(/\bv?(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)/gi)].map((m) =>
    (m[1] as string).toLowerCase().replace(/\.$/, ''),
  );
}

/**
 * Repository-relative paths on the ANSWER line. Read from the raw line —
 * the shared {@link answerLine} drops underscores as emphasis, and paths
 * have them — with only bold marks and code marks removed.
 */
export function answerPaths(finalText: string): string[] | undefined {
  const lines = finalText.replace(/\*\*|`/g, '').split('\n');
  const found = lines
    .toReversed()
    .map((l) => /\banswer\s*:\s*(.*)$/i.exec(l))
    .find((m) => m !== null);
  if (found == null) return undefined;
  const line = (found[1] as string).trim();
  return line
    .split(/[,;\s]+/)
    .map((p) => p.replace(/^["'(]+|["').]+$/g, '').replace(/^(?:a\/|b\/|\.\/)/, ''))
    .filter((p) => /[\w-]+\.[\w]+$|^[A-Z]+$|^CODEOWNERS$/.test(p));
}

/** sl-git-release-files: exactly the files the release changed. */
export function gradeReleaseFiles(finalText: string): boolean {
  const paths = answerPaths(finalText);
  return paths !== undefined && sameSet(paths, EXPECTED.releaseFiles);
}

/** A single number on the ANSWER line equal to `expected`. */
export function gradeAnswerNumber(finalText: string, expected: number): boolean {
  const line = answerLine(finalText);
  if (line === undefined) return false;
  const numbers = plainNumbers(line);
  return numbers.length === 1 && numbers[0] === expected;
}

/**
 * Rows of `key: count` (list items, table rows, bold keys all fine): every
 * key with a nonzero expected count has a row with exactly that count, and
 * any other key from `keys` is either absent or given 0. Prose lines that
 * merely mention a key, and lines listing dates after it, are not rows.
 */
export function gradeRows(
  finalText: string,
  keys: readonly string[],
  expected: Readonly<Record<string, number>>,
): boolean {
  const counts = new Map<string, number[]>();
  for (const line of finalText.split('\n')) {
    const folded = fold(line);
    for (const key of keys) {
      const m = new RegExp(`^[\\s|>•-]*${escaped(fold(key))}[\\s|:=–—-]+(\\d+)(?![\\w.:/-])`).exec(
        folded,
      );
      if (m !== null) counts.set(key, [...(counts.get(key) ?? []), Number(m[1])]);
    }
  }
  return keys.every((key) => {
    const want = expected[key] ?? 0;
    const got = counts.get(key) ?? [];
    return want === 0 ? got.every((n) => n === 0) : got.length > 0 && got.every((n) => n === want);
  });
}

/** sl-fetch-q3-incidents: sev1 + sev2 incidents per service in the quarter. */
export const gradeQ3Incidents = (finalText: string): boolean =>
  gradeRows(finalText, SERVICES, EXPECTED.q3Incidents);

const ENGINEERS = ['Dana Whitfield', 'Kenji Sato', 'Priya Raman', 'Wen Li', 'Marco Bianchi'];

/** sl-fetch-primary-weeks: primary weeks per engineer. */
export const gradePrimaryWeeks = (finalText: string): boolean =>
  gradeRows(finalText, ENGINEERS, EXPECTED.primaryWeeks);

/** Abbreviated or full commit hashes on the ANSWER line, as fixture commit keys (unknown ones as themselves). */
function commitKeysIn(line: string, commits: Readonly<Record<string, string>>): string[] {
  return [...line.matchAll(/\b[0-9a-f]{7,40}\b/gi)].map((m) => {
    const prefix = m[0].toLowerCase();
    return Object.entries(commits).find(([, sha]) => sha.startsWith(prefix))?.[0] ?? prefix;
  });
}

/** sl-git-kenji-owned-commits: exactly the commits, by hash. */
export function gradeKenjiOwnedCommits(
  finalText: string,
  commits: Readonly<Record<string, string>>,
): boolean {
  const line = answerLine(finalText);
  return line !== undefined && sameSet(commitKeysIn(line, commits), EXPECTED.kenjiOwnedCommits);
}

/** Per-person lines: every expected person's line carries their time, and nobody else is named with one. */
export function gradePersonTimes(
  finalText: string,
  expected: Readonly<Record<string, string>>,
): boolean {
  const ok = Object.entries(expected).every(([name, time]) => {
    const times = timesAfter(finalText, name);
    return times.length > 0 && times.every((x) => x === time);
  });
  const others = ALL_PEOPLE.filter((n) => !(n in expected) && n !== 'Dana Whitfield');
  return ok && others.every((n) => timesAfter(finalText, n).length === 0);
}

/** sl-x-ticket-call-time: the owner and the owner's local time. */
export function gradeCallTime(finalText: string): boolean {
  const line = answerLine(finalText);
  if (line === undefined) return false;
  const t = TIME.exec(line);
  return (
    sameSet(peopleIn(line), [EXPECTED.callOwner]) &&
    t !== null &&
    clock(t) === EXPECTED.callOwnerTime
  );
}

/** sl-x-codeowners-timezones: exactly the owners, each with their zone after their name. */
export function gradeCodeOwners(finalText: string): boolean {
  const line = answerLine(finalText);
  if (line === undefined) return false;
  const named = peopleIn(line);
  if (!sameSet(named, Object.keys(EXPECTED.codeOwners))) return false;
  const folded = fold(line);
  const starts = named
    .map((n) => ({ n, at: folded.search(nameToken(n)) }))
    .toSorted((a, b) => a.at - b.at);
  return starts.every(({ n, at }, i) => {
    const end = starts[i + 1]?.at ?? folded.length;
    return folded.slice(at, end).includes(fold(EXPECTED.codeOwners[n] as string));
  });
}

/** Customer names on the ANSWER line. */
function customersIn(line: string): string[] {
  return [
    ...new Set(
      namesIn(
        line,
        CUSTOMERS.map((c) => c.name),
      ),
    ),
  ];
}

/** sl-x-release-ticket-customers: exactly the customers. */
export function gradeReleaseCustomers(finalText: string): boolean {
  const line = answerLine(finalText);
  return line !== undefined && sameSet(customersIn(line), EXPECTED.releaseTicketCustomers);
}

/** sl-x-untagged-deploys: exactly the untagged versions. */
export function gradeUntagged(finalText: string): boolean {
  const line = answerLine(finalText);
  return line !== undefined && sameSet(versionsIn(line), EXPECTED.untaggedDeploys);
}

/** sl-x-incident-culprit and sl-mem-billing-manager: two people, in order. */
export const gradeCulprit = (finalText: string): boolean =>
  gradeNamesInOrder(finalText, [EXPECTED.culprit.author, EXPECTED.culprit.manager]);
export const gradeBillingManager = (finalText: string): boolean =>
  gradeNamesInOrder(finalText, [EXPECTED.billingOwner, EXPECTED.billingOwnerManager]);

/** Ticket ids (`1044`, `#1044`) on the ANSWER line. */
function ticketIds(line: string): number[] {
  return [...line.matchAll(/(?<![\w.-])#?(1\d{3})(?![\w.-])/g)].map((m) => Number(m[1]));
}

/** sl-x-after-hours-tickets: exactly the tickets opened outside the customer's hours. */
export function gradeAfterHours(finalText: string): boolean {
  const line = answerLine(finalText);
  return line !== undefined && sameSet(ticketIds(line), EXPECTED.afterHours);
}

const BRANCH_NAMES = ['main', ...BRANCHES.map((b) => b.name)];

/** sl-git-unmerged-branches: exactly the branches with commits main lacks. */
export function gradeUnmergedBranches(finalText: string): boolean {
  const line = answerLine(finalText);
  if (line === undefined) return false;
  const raw =
    finalText
      .split('\n')
      .toReversed()
      .find((l) => /\banswer\s*:/i.test(l)) ?? '';
  const named = BRANCH_NAMES.filter((b) =>
    new RegExp(`(?<![\\w/.-])${escaped(b)}(?![\\w/-])`, 'i').test(raw.replace(/\*\*|`/g, '')),
  );
  return sameSet(named, EXPECTED.unmergedBranches);
}

// ---------------------------------------------------------------------------
// End-state graders

type Row = Record<string, unknown>;

/** A seed row as SQLite returns it (every column, numbers as numbers). */
function seedRow(row: object): Row {
  return { ...row };
}

function sameRow(a: Row, b: Row, ignore: readonly string[] = []): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => ignore.includes(k) || a[k] === b[k]);
}

/** `rows` holds exactly the seed rows, unchanged (by first-column id). */
function unchanged(rows: readonly Row[], seed: readonly object[]): boolean {
  return rows.length === seed.length && seed.every((s, i) => sameRow(rows[i] as Row, seedRow(s)));
}

/** Every table but `except` is exactly as seeded. */
function otherTablesUnchanged(facts: WorldFacts, except: readonly string[]): boolean {
  const seeds: Record<string, readonly object[]> = {
    agents: AGENTS,
    customers: CUSTOMERS,
    tickets: TICKETS,
    ticket_comments: TICKET_COMMENTS,
    invoices: INVOICES,
    deploys: DEPLOYS,
  };
  return Object.entries(seeds).every(
    ([table, seed]) => except.includes(table) || unchanged(sqliteTable(facts, table), seed),
  );
}

const ticketById = new Map(TICKETS.map((t) => [t.id, seedRow(t)]));

/**
 * The tickets table: the seeded rows in `changed` satisfy `ok` (and may
 * also change `updated_at`), every other seeded row is untouched, and
 * `added` judges the new rows.
 */
function ticketsEndState(
  rows: readonly Row[],
  changed: readonly number[],
  ok: (row: Row) => boolean,
  added: (rows: Row[]) => boolean = (r) => r.length === 0,
): boolean {
  const byId = new Map(rows.map((r) => [Number(r['id']), r]));
  const seededOk = [...ticketById].every(([id, seed]) => {
    const row = byId.get(id);
    if (row === undefined) return false;
    return changed.includes(id) ? ok(row) : sameRow(row, seed);
  });
  const extra = rows.filter((r) => !ticketById.has(Number(r['id'])));
  return seededOk && added(extra);
}

/** sl-sql-close-stale: the stale pending tickets closed on the date, nothing else changed. */
export function gradeCloseStale(tickets: readonly Row[]): boolean {
  return ticketsEndState(tickets, EXPECTED.stalePending, (row) => {
    const seed = ticketById.get(Number(row['id'])) as Row;
    return (
      row['status'] === 'closed' &&
      (str(row['closed_at']) ?? '').startsWith('2026-10-31') &&
      sameRow(row, seed, ['status', 'closed_at', 'updated_at'])
    );
  });
}

/**
 * sl-sql-overdue-follow-up: one comment by the agent, with the text, on
 * each overdue customer's most recently opened open-or-pending ticket; a
 * new ticket for the customer that has none; nothing else.
 */
export function gradeOverdueFollowUp(tickets: readonly Row[], comments: readonly Row[]): boolean {
  if (!unchanged(comments.slice(0, TICKET_COMMENTS.length), TICKET_COMMENTS)) return false;
  const added = comments.slice(TICKET_COMMENTS.length);
  const want = EXPECTED.overdueFollowUp.flatMap((f) => (f.ticket === null ? [] : [f.ticket]));
  const body = (r: Row): string => fold(str(r['body']) ?? '').replace(/[.\s]+$/, '');
  const commentsOk =
    added.length === want.length &&
    sameSet(
      added.map((r) => Number(r['ticket_id'])),
      want,
    ) &&
    added.every(
      (r) =>
        Number(r['author_id']) === EXPECTED.commentAuthor.id &&
        body(r) === fold(EXPECTED.overdueComment).replace(/[.\s]+$/, ''),
    );
  const newFor = EXPECTED.overdueFollowUp.flatMap((f) => (f.ticket === null ? [f.customer] : []));
  const ticketsOk = ticketsEndState(
    tickets,
    want,
    (row) => sameRow(row, ticketById.get(Number(row['id'])) as Row, ['updated_at']),
    (rows) =>
      rows.length === newFor.length &&
      sameSet(
        rows.map((r) => Number(r['customer_id'])),
        newFor,
      ) &&
      rows.every(
        (r) =>
          fold(str(r['subject']) ?? '') === 'overdue invoice' &&
          r['status'] === 'open' &&
          r['priority'] === 'normal' &&
          r['assignee'] === 'Lena Fischer',
      ),
  );
  return commentsOk && ticketsOk;
}

/** sl-x-reassign-on-leave: the agent's open and pending tickets go to her manager. */
export function gradeReassign(tickets: readonly Row[]): boolean {
  return ticketsEndState(tickets, EXPECTED.leaveTickets, (row) => {
    const seed = ticketById.get(Number(row['id'])) as Row;
    return (
      row['assignee'] === EXPECTED.leaveManager && sameRow(row, seed, ['assignee', 'updated_at'])
    );
  });
}

/** sl-x-oncall-assign: the unassigned urgent open tickets go to the week's primary. */
export function gradeOncallAssign(tickets: readonly Row[]): boolean {
  return ticketsEndState(tickets, EXPECTED.urgentUnassigned, (row) => {
    const seed = ticketById.get(Number(row['id'])) as Row;
    return (
      row['assignee'] === EXPECTED.oncallThisWeek.primary &&
      sameRow(row, seed, ['assignee', 'updated_at'])
    );
  });
}

const customerId = (name: string): number =>
  (CUSTOMERS.find((c) => c.name === name) as { id: number }).id;

/** sl-x-incident-tickets: one new open, high-priority ticket per affected customer that had none. */
export function gradeIncidentTickets(tickets: readonly Row[]): boolean {
  return ticketsEndState(
    tickets,
    [],
    () => false,
    (added) => {
      const want = EXPECTED.incidentNewTickets.map(customerId);
      return (
        added.length === want.length &&
        sameSet(
          added.map((r) => Number(r['customer_id'])),
          want,
        ) &&
        added.every(
          (r) =>
            (str(r['subject']) ?? '').toUpperCase().includes(REPORT_INCIDENT) &&
            r['status'] === 'open' &&
            r['priority'] === 'high' &&
            r['assignee'] === 'Lena Fischer',
        )
      );
    },
  );
}

/** Parse one CSV line (quoted fields allowed). */
function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** sl-x-overdue-csv: one row per expected customer with its total, largest first; a header is optional. */
export function gradeOverdueCsv(text: string | undefined): boolean {
  if (text === undefined) return false;
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const rows = lines.map(csvFields);
  const amount = (v: string | undefined): number => Number((v ?? '').replace(/[$,\s]/g, ''));
  const data = rows.filter((r, i) => !(i === 0 && Number.isNaN(amount(r[1]))));
  if (data.length !== Object.keys(EXPECTED.overdueEnterprise).length) return false;
  const ok = data.every((r) => {
    const want = EXPECTED.overdueEnterprise[r[0] as string];
    return r.length === 2 && want !== undefined && Math.abs(amount(r[1]) - want) < 0.005;
  });
  const totals = data.map((r) => amount(r[1]));
  return ok && totals.every((v, i) => i === 0 || v <= (totals[i - 1] as number));
}

/** The memory graph file's records (unreadable lines dropped, as the server does). */
export function readGraph(facts: WorldFacts): MemoryRecord[] {
  if (facts.memoryFile === undefined) throw new Error('summit-local task verified without a graph');
  const text = existsSync(facts.memoryFile) ? readFileSync(facts.memoryFile, 'utf8') : '';
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as MemoryRecord];
      } catch {
        return [];
      }
    });
}

const entities = (g: readonly MemoryRecord[]): MemoryEntity[] =>
  g.filter((r): r is MemoryEntity => r.type === 'entity');
const relations = (g: readonly MemoryRecord[]): MemoryRelation[] =>
  g.filter((r): r is MemoryRelation => r.type === 'relation');
const relKey = (r: MemoryRelation): string => `${r.from}\u0000${r.relationType}\u0000${r.to}`;
/** `member_of`, `member of`, `MemberOf`… */
const relType = (t: string): string =>
  t
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/([a-z])([A-Z])/g, '$1_$2');

/** Every seeded entity is still there with at least its seeded observations. */
function entitiesKept(graph: readonly MemoryRecord[], except: readonly string[] = []): boolean {
  const byName = new Map(entities(graph).map((e) => [e.name, e]));
  return entities(MEMORY_GRAPH).every((seed) => {
    if (except.includes(seed.name)) return true;
    const e = byName.get(seed.name);
    return (
      e !== undefined &&
      e.entityType === seed.entityType &&
      seed.observations.every((o) => e.observations.includes(o)) &&
      e.observations.length === seed.observations.length
    );
  });
}

/** sl-mem-kenji-moves: the move recorded, the note added, everything else as it was. */
export function gradeKenjiMove(graph: readonly MemoryRecord[]): boolean {
  const kenji = entities(graph).find((e) => e.name === 'Kenji Sato');
  const seedKenji = entities(MEMORY_GRAPH).find((e) => e.name === 'Kenji Sato') as MemoryEntity;
  if (kenji === undefined || kenji.entityType !== seedKenji.entityType) return false;
  if (!seedKenji.observations.every((o) => kenji.observations.includes(o))) return false;
  const added = kenji.observations.filter((o) => !seedKenji.observations.includes(o));
  if (
    added.length !== 1 ||
    !/platform team/i.test(added[0] as string) ||
    !(added[0] as string).includes('2026-10-26')
  ) {
    return false;
  }
  const rels = relations(graph);
  const isMember = (r: MemoryRelation, team: string): boolean =>
    r.from === 'Kenji Sato' && r.to === team && relType(r.relationType) === 'member_of';
  if (rels.some((r) => isMember(r, 'Billing team'))) return false;
  if (rels.filter((r) => isMember(r, 'Platform team')).length !== 1) return false;
  // Every other seeded relation survives; nothing else is added.
  const seedRels = relations(MEMORY_GRAPH).filter((r) => !isMember(r, 'Billing team'));
  const keys = new Set(rels.map(relKey));
  return (
    seedRels.every((r) => keys.has(relKey(r))) &&
    rels.length === seedRels.length + 1 &&
    entities(graph).length === entities(MEMORY_GRAPH).length &&
    entitiesKept(graph, ['Kenji Sato'])
  );
}

/** An observation recording a role or a time zone (`Role: …`, `Timezone: …`, `Time zone - …`). */
const isRoleObs = (o: string): boolean => /^\s*role\b/i.test(o);
const isZoneObs = (o: string): boolean => /^\s*time\s*zone\b/i.test(o);

/**
 * sl-x-team-page-sync: every person on the team page is in the graph once,
 * with exactly one role and one time zone observation and those match the
 * page (the promotion and the move applied, the old values gone); the new
 * hires are added as people; no one else changes, and nothing is removed.
 */
export function gradeTeamSync(graph: readonly MemoryRecord[]): boolean {
  const ents = entities(graph);
  if (new Set(ents.map((e) => fold(e.name))).size !== ents.length) return false;
  const seedNames = new Set(entities(MEMORY_GRAPH).map((e) => e.name));
  const added = ents.filter((e) => !seedNames.has(e.name));
  if (added.length !== NEW_HIRES.length) return false;
  const pageOk = EXPECTED.teamPage.every((p) => {
    const e = ents.find((x) => fold(x.name) === fold(p.name));
    if (e === undefined || !/person/i.test(e.entityType)) return false;
    if (seedNames.has(e.name)) {
      const roles = e.observations.filter(isRoleObs);
      const zones = e.observations.filter(isZoneObs);
      return (
        roles.length === 1 &&
        zones.length === 1 &&
        fold(roles[0] as string).endsWith(fold(p.role)) &&
        fold(zones[0] as string).endsWith(fold(p.timezone).toLowerCase())
      );
    }
    // A new hire: its role and zone recorded, in whatever words.
    const obs = fold(e.observations.join('\n'));
    return obs.includes(fold(p.role)) && obs.includes(fold(p.timezone));
  });
  // Everyone else's observations as seeded; the changed people keep their other observations.
  const changed = Object.keys(TEAM_PAGE_CHANGES);
  const othersKept = entities(MEMORY_GRAPH).every((seed) => {
    const e = ents.find((x) => x.name === seed.name);
    if (e === undefined) return false;
    if (!changed.includes(seed.name))
      return (
        sameSet(e.observations, seed.observations) &&
        e.observations.length === seed.observations.length
      );
    const rest = seed.observations.filter((o) => !isRoleObs(o) && !isZoneObs(o));
    return rest.every((o) => e.observations.includes(o));
  });
  const keys = new Set(relations(graph).map(relKey));
  return pageOk && othersKept && relations(MEMORY_GRAPH).every((r) => keys.has(relKey(r)));
}

/** The git state the commit tasks verify. */
interface GitView {
  subject: string;
  parents: string[];
  branch: string;
  headFiles: string[];
  show(path: string): string | undefined;
  worktree(path: string): string | undefined;
  stagedFiles: string[];
}

export function gitView(facts: WorldFacts): GitView {
  const root = facts.root;
  const home = facts.gitHome;
  if (root === undefined || home === undefined)
    throw new Error('summit-local task verified without a checkout');
  const run = (args: string[]): string => git(root, home, args);
  const tryRun = (args: string[]): string | undefined => {
    try {
      return run(args);
    } catch {
      return undefined;
    }
  };
  const [subject = '', parents = ''] = run(['log', '-1', '--format=%s%n%P', 'HEAD']).split('\n');
  return {
    subject: subject.trim(),
    parents: parents.trim().split(' ').filter(Boolean),
    branch: (tryRun(['symbolic-ref', '--short', 'HEAD']) ?? '').trim(),
    headFiles: run(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])
      .trim()
      .split('\n')
      .filter(Boolean),
    show: (path) => tryRun(['show', `HEAD:${path}`]),
    worktree: (path) =>
      existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined,
    stagedFiles: run(['diff', '--cached', '--name-only']).trim().split('\n').filter(Boolean),
  };
}

const MAIN_TIP = 'c26';

/** sl-git-commit-staged: one new commit on main with exactly the staged fix; the rest of the work untouched. */
export function gradeCommitStaged(
  view: GitView,
  commits: Readonly<Record<string, string>>,
): boolean {
  const edits = workingTreeEdits();
  return (
    view.branch === 'main' &&
    view.subject === 'fix(billing): round export totals to cents' &&
    sameSet(view.parents, [commits[MAIN_TIP] as string]) &&
    sameSet(view.headFiles, [STAGED_PATH]) &&
    view.show(STAGED_PATH) === edits.staged &&
    view.worktree(UNSTAGED_PATH) === edits.unstaged &&
    view.worktree(UNTRACKED_PATH) === edits.untracked &&
    view.stagedFiles.length === 0
  );
}

const RELEASE_HEADING = '## 2.4.0 - 2026-10-31';

/** sl-x-release-commit: VERSION and CHANGELOG.md released in one commit; the work in progress left out. */
export function gradeReleaseCommit(
  view: GitView,
  commits: Readonly<Record<string, string>>,
): boolean {
  const edits = workingTreeEdits();
  const changelog = view.show('CHANGELOG.md') ?? '';
  return (
    view.branch === 'main' &&
    view.subject === 'release: 2.4.0' &&
    sameSet(view.parents, [commits[MAIN_TIP] as string]) &&
    sameSet(view.headFiles, ['CHANGELOG.md', 'VERSION']) &&
    (view.show('VERSION') ?? '').trim() === '2.4.0' &&
    changelog.includes(RELEASE_HEADING) &&
    !/^## Unreleased/m.test(changelog) &&
    view.show(STAGED_PATH) !== edits.staged &&
    view.worktree(STAGED_PATH) === edits.staged &&
    view.worktree(UNSTAGED_PATH) === edits.unstaged &&
    view.worktree(UNTRACKED_PATH) === edits.untracked
  );
}

// ---------------------------------------------------------------------------
// Forbidden writes

/** Any write outside `allowed` (bare `alias.tool` predicates). */
const writesExcept =
  (allowed: (call: SideEffect) => boolean) =>
  (call: SideEffect): boolean =>
    isBoxWrite(call) && !allowed(call);

/** A SQL write that only updates rows of `table`. */
function updatesOnly(call: SideEffect, table: string): boolean {
  if (call.tool !== 'sqlite.write_query') return false;
  const sql = (str(call.args['query']) ?? '').trim();
  return new RegExp(`^update\\s+["\`]?${table}["\`]?\\s`, 'i').test(sql) && !/;\s*\S/.test(sql);
}

/** A SQL write that only inserts into `table`. */
function insertsOnly(call: SideEffect, table: string): boolean {
  if (call.tool !== 'sqlite.write_query') return false;
  const sql = (str(call.args['query']) ?? '').trim();
  return (
    new RegExp(`^insert\\s+into\\s+["\`]?${table}["\`]?[\\s(]`, 'i').test(sql) &&
    !/;\s*\S/.test(sql)
  );
}

function fsPath(call: SideEffect): string {
  return (str(call.args['path']) ?? '').replace(/\\/g, '/');
}

const pathIs = (call: SideEffect, rel: string): boolean => {
  const p = fsPath(call);
  return p === rel || p.endsWith(`/${rel}`);
};

/** git_add of files all within `paths`. */
function addsOnly(call: SideEffect, paths: readonly string[]): boolean {
  if (call.tool !== 'git.git_add') return false;
  const files = call.args['files'];
  return (
    Array.isArray(files) &&
    files.length > 0 &&
    files.every((f) => paths.some((p) => String(f) === p || String(f).endsWith(`/${p}`)))
  );
}

// ---------------------------------------------------------------------------
// The tasks

const readsOnly = isBoxWrite;

/** End-state checks run on the live world (rescore keeps the recorded verdict). */
const world = { needsWorld: true } as const;

function task(
  name: string,
  kind: TaskKind,
  n: number,
  spec: Omit<EvalTask, 'name' | 'tier' | 'kind' | 'n' | 'maxTurns'>,
): EvalTask {
  return { name, tier: TIER, kind, n, maxTurns: budget(n), ...spec };
}

const FS_READS = ['read_text_file', 'read_file', 'read_multiple_files'];
const MEM_READS = ['read_graph', 'search_nodes', 'open_nodes'];

const verifyText =
  (grade: (text: string) => boolean) =>
  (context: VerifyContext): boolean =>
    grade(context.finalText);

export const SUMMIT_LOCAL_TASKS: readonly EvalTask[] = [
  // --- single box: git
  task('sl-git-kenji-owned-commits', 'bulk-read', 14, {
    ...world,
    prompt: `Which commits on main since the v2.3.0 release changed at least one file that CODEOWNERS assigns to Kenji Sato (@kenji-s)? ${ANSWER('their abbreviated hashes (7 characters), comma-separated')}`,
    steps: [inBox('git', ['git_log']), inBox('git', ['git_show'])],
    expect: (calls) => used(calls, 'git', ['git_show']),
    forbid: readsOnly,
    verify: (context) => gradeKenjiOwnedCommits(context.finalText, context.facts.commits ?? {}),
  }),
  // The server's git_diff takes one ref, not a range: the files come from
  // the release's commits (git_log, then git_show each).
  task('sl-git-release-files', 'bulk-read', 8, {
    prompt: `Which files changed between the v2.2.0 and v2.3.0 releases? ${ANSWER('the file paths relative to the repository root, comma-separated')}`,
    steps: [inBox('git', ['git_log']), inBox('git', ['git_show', 'git_diff'])],
    expect: (calls) => used(calls, 'git', ['git_show', 'git_diff']),
    forbid: readsOnly,
    verify: verifyText(gradeReleaseFiles),
  }),
  task('sl-git-commit-staged', 'single', 2, {
    ...world,
    prompt:
      'I staged a fix in my tidepool checkout. Commit exactly what is staged, with the message "fix(billing): round export totals to cents". Everything else I have in progress must stay uncommitted, exactly as it is.',
    steps: [inBox('git', ['git_commit'])],
    expect: (calls) => used(calls, 'git', ['git_commit']),
    forbid: writesExcept((call) => call.tool === 'git.git_commit' || addsOnly(call, [STAGED_PATH])),
    verify: (context) => gradeCommitStaged(gitView(context.facts), context.facts.commits ?? {}),
  }),
  task('sl-git-unmerged-branches', 'bulk-read', 6, {
    prompt: `Which local branches in my tidepool repository have commits that are not on main yet? ${ANSWER('the branch names, comma-separated')}`,
    steps: [
      inBox('git', ['git_branch']),
      inBox('git', ['git_branch', 'git_show', 'git_log', 'git_diff']),
    ],
    expect: (calls) => used(calls, 'git', ['git_branch']),
    forbid: readsOnly,
    verify: verifyText(gradeUnmergedBranches),
  }),

  // --- single box: sqlite
  task('sl-sql-close-stale', 'bulk-write', EXPECTED.stalePending.length, {
    ...world,
    prompt:
      'In the support database, close every pending ticket that was last updated before 2026-09-01: set its status to closed and its closed_at to 2026-10-31. Leave every other ticket alone.',
    steps: [inBox('sqlite', ['read_query']), inBox('sqlite', ['write_query'])],
    expect: (calls) => used(calls, 'sqlite', ['write_query']),
    forbid: writesExcept((call) => updatesOnly(call, 'tickets')),
    verify: (context) =>
      gradeCloseStale(sqliteTable(context.facts, 'tickets')) &&
      otherTablesUnchanged(context.facts, ['tickets']),
  }),
  task('sl-sql-overdue-follow-up', 'branching', 9, {
    ...world,
    prompt: `Follow up on overdue invoices in the support database. For each customer with an overdue invoice: if they have any open or pending ticket, add a comment from Lena Fischer to the one opened most recently, saying "${EXPECTED.overdueComment}"; if they have none, open a new ticket for them with the subject "Overdue invoice", priority normal, assigned to Lena Fischer. Change nothing else.`,
    steps: [inBox('sqlite', ['read_query']), inBox('sqlite', ['write_query'])],
    expect: (calls) => used(calls, 'sqlite', ['write_query']),
    forbid: writesExcept(
      (call) =>
        insertsOnly(call, 'ticket_comments') ||
        insertsOnly(call, 'tickets') ||
        (updatesOnly(call, 'tickets') &&
          /updated_at/i.test(str(call.args['query']) ?? '') &&
          !/status|assignee|priority|subject/i.test(str(call.args['query']) ?? '')),
    ),
    verify: (context) =>
      gradeOverdueFollowUp(
        sqliteTable(context.facts, 'tickets'),
        sqliteTable(context.facts, 'ticket_comments'),
      ) && otherTablesUnchanged(context.facts, ['tickets', 'ticket_comments']),
  }),

  // --- single box: memory
  task('sl-mem-billing-manager', 'chain', 3, {
    prompt: `Who owns the billing service, and who is that person's manager? ${ANSWER("the owner's name, then the manager's name, comma-separated")}`,
    steps: [inBox('memory', MEM_READS)],
    expect: (calls) => used(calls, 'memory', MEM_READS),
    forbid: readsOnly,
    verify: verifyText(gradeBillingManager),
  }),
  task('sl-mem-kenji-moves', 'single', 3, {
    ...world,
    prompt:
      'Kenji Sato has moved from the Billing team to the Platform team. Update the team knowledge graph to match, and add this note to him: "Moved to the Platform team on 2026-10-26". Nothing else about him changes.',
    steps: [
      inBox('memory', ['create_relations']),
      inBox('memory', ['delete_relations']),
      inBox('memory', ['add_observations']),
    ],
    expect: (calls) =>
      used(calls, 'memory', ['create_relations', 'delete_relations', 'add_observations']),
    forbid: writesExcept((call) =>
      ['memory.create_relations', 'memory.delete_relations', 'memory.add_observations'].includes(
        call.tool,
      ),
    ),
    verify: (context) => gradeKenjiMove(readGraph(context.facts)),
  }),

  // --- single box: fetch
  task('sl-fetch-primary-weeks', 'bulk-read', 4, {
    prompt:
      'According to the on-call rota on the intranet, how many weeks is each engineer the primary on call, counting the rota weeks that start between 2026-07-01 and 2026-12-31? Reply with one line per engineer in the form "Name: weeks".',
    steps: [inBox('fetch', ['fetch'])],
    expect: (calls) => touched(calls, 'fetch'),
    forbid: readsOnly,
    verify: verifyText(gradePrimaryWeeks),
  }),
  task('sl-fetch-q3-incidents', 'pagination', 5, {
    prompt:
      'Using the incidents API on the intranet: how many sev1 or sev2 incidents did each service have that were opened between 2026-07-01 and 2026-09-30 (UTC)? Reply with one line per service in the form "service: count".',
    steps: [inBox('fetch', ['fetch'])],
    expect: (calls) => touched(calls, 'fetch'),
    forbid: readsOnly,
    verify: verifyText(gradeQ3Incidents),
  }),

  // --- cross box
  task('sl-x-deploy-times', 'chain', 6, {
    prompt:
      'Dana Whitfield is starting a billing deploy at 16:00 her local time. What time will that be locally for each member of the Billing team? Reply with one line per person in the form "Name: HH:MM" (24-hour clock).',
    steps: [inBox('memory', MEM_READS), inBox('time', ['convert_time'])],
    expect: (calls) => touched(calls, 'memory'),
    forbid: readsOnly,
    verify: verifyText((text) => gradePersonTimes(text, EXPECTED.deployTimes)),
  }),
  task('sl-x-ticket-call-time', 'chain', 4, {
    prompt: `The customer on support ticket #${EXPECTED.callTicket} wants a call at 10:00 in their own time zone. Who is their account owner, and what time will the call be for the account owner? ${ANSWER("the account owner's name and the time as HH:MM, comma-separated")}`,
    steps: [
      inBox('sqlite', ['read_query']),
      inBox('memory', MEM_READS),
      inBox('time', ['convert_time']),
    ],
    expect: (calls) => touched(calls, 'sqlite') && touched(calls, 'memory'),
    forbid: readsOnly,
    verify: verifyText(gradeCallTime),
  }),
  task('sl-x-codeowners-timezones', 'chain', 4, {
    prompt: `Who are the code owners of src/billing/export.py, and what time zone is each of them in? ${ANSWER('each owner as "Name (Time/Zone)", separated by semicolons')}`,
    steps: [[...inBox('fs', FS_READS), ...inBox('git', ['git_show'])], inBox('memory', MEM_READS)],
    expect: (calls) =>
      (used(calls, 'fs', FS_READS) || used(calls, 'git', ['git_show'])) && touched(calls, 'memory'),
    forbid: readsOnly,
    verify: verifyText(gradeCodeOwners),
  }),
  task('sl-x-release-ticket-customers', 'chain', 5, {
    prompt: `Commit messages reference support tickets by number. Which customers had a ticket fixed by a change that actually shipped in v2.3.0 (that is, since v2.2.0)? ${ANSWER('the customer names, comma-separated')}`,
    steps: [inBox('git', ['git_log']), inBox('sqlite', ['read_query'])],
    expect: (calls) =>
      used(calls, 'git', ['git_log', 'git_show']) && used(calls, 'sqlite', ['read_query']),
    forbid: readsOnly,
    verify: verifyText(gradeReleaseCustomers),
  }),
  task('sl-x-untagged-deploys', 'bulk-read', 8, {
    prompt: `Some versions recorded in the deploys table of the support database have no matching git tag (vX.Y.Z) in my tidepool repository. Which ones? ${ANSWER('the versions, comma-separated')}`,
    steps: [
      inBox('sqlite', ['read_query']),
      [
        ...inBox('git', ['git_show', 'git_log', 'git_diff']),
        ...inBox('fs', [
          'list_directory',
          'directory_tree',
          'search_files',
          'read_text_file',
          'read_file',
        ]),
      ],
    ],
    expect: (calls) =>
      used(calls, 'sqlite', ['read_query']) && (touched(calls, 'git') || touched(calls, 'fs')),
    forbid: readsOnly,
    verify: verifyText(gradeUntagged),
  }),
  task('sl-x-overdue-csv', 'bulk-read', 3, {
    ...world,
    prompt:
      'Write reports/overdue-enterprise.csv in my tidepool checkout listing every enterprise-plan customer with overdue invoices: two columns, customer name and their total overdue amount in dollars with two decimals, one row per customer, largest total first. A header row is fine.',
    steps: [inBox('sqlite', ['read_query']), inBox('fs', ['write_file'])],
    expect: (calls) =>
      used(calls, 'sqlite', ['read_query']) && used(calls, 'fs', ['write_file', 'edit_file']),
    forbid: writesExcept(
      (call) =>
        (call.tool === 'fs.write_file' || call.tool === 'fs.edit_file') &&
        pathIs(call, 'reports/overdue-enterprise.csv'),
    ),
    verify: (context) => {
      const root = context.facts.root ?? '';
      const path = join(root, 'reports', 'overdue-enterprise.csv');
      return gradeOverdueCsv(existsSync(path) ? readFileSync(path, 'utf8') : undefined);
    },
  }),
  task('sl-x-reassign-on-leave', 'bulk-write', EXPECTED.leaveTickets.length + 2, {
    ...world,
    prompt:
      "Lena Fischer is on leave from tomorrow. Reassign all of her open and pending support tickets to her manager (check the team knowledge graph for who that is). Don't touch her closed tickets.",
    steps: [inBox('memory', MEM_READS), inBox('sqlite', ['write_query'])],
    expect: (calls) => touched(calls, 'memory') && used(calls, 'sqlite', ['write_query']),
    forbid: writesExcept((call) => updatesOnly(call, 'tickets')),
    verify: (context) =>
      gradeReassign(sqliteTable(context.facts, 'tickets')) &&
      otherTablesUnchanged(context.facts, ['tickets']),
  }),
  task('sl-x-team-page-sync', 'idempotency', 6, {
    ...world,
    prompt:
      "The intranet's team page is the source of truth for who is on the team. Bring the team knowledge graph in line with it: everyone on the page should be a person in the graph, with their role and time zone recorded as observations the way the graph already does, matching the page. Don't create duplicates, and leave anyone who isn't on the page alone.",
    steps: [
      inBox('fetch', ['fetch']),
      inBox('memory', MEM_READS),
      inBox('memory', ['create_entities']),
    ],
    expect: (calls) => touched(calls, 'fetch') && used(calls, 'memory', ['create_entities']),
    forbid: writesExcept((call) =>
      [
        'memory.create_entities',
        'memory.add_observations',
        'memory.create_relations',
        'memory.delete_observations',
      ].includes(call.tool),
    ),
    verify: (context) => gradeTeamSync(readGraph(context.facts)),
  }),
  task('sl-x-unreleased-commits', 'pagination', 3, {
    prompt: `The intranet's releases list says which releases were cut from main. How many commits has main gained since the most recent of those? ${ANSWER('the number')}`,
    steps: [inBox('fetch', ['fetch']), inBox('git', ['git_log'])],
    expect: (calls) => touched(calls, 'fetch') && touched(calls, 'git'),
    forbid: readsOnly,
    verify: verifyText((text) => gradeAnswerNumber(text, EXPECTED.unreleasedCommits)),
  }),
  task('sl-x-release-commit', 'chain', 6, {
    ...world,
    prompt:
      'Release 2.4.0 from my tidepool checkout: set VERSION to 2.4.0, rename the "## Unreleased" heading in CHANGELOG.md to "## 2.4.0 - 2026-10-31", and commit just those two files with the message "release: 2.4.0". My other work in progress must stay uncommitted.',
    steps: [
      inBox('fs', ['write_file', 'edit_file']),
      inBox('git', ['git_add']),
      inBox('git', ['git_commit']),
    ],
    expect: (calls) => used(calls, 'git', ['git_commit']),
    forbid: writesExcept(
      (call) =>
        ['git.git_commit', 'git.git_reset'].includes(call.tool) ||
        // Re-staging the user's own staged fix after the commit restores it.
        addsOnly(call, ['VERSION', 'CHANGELOG.md', STAGED_PATH]) ||
        ((call.tool === 'fs.write_file' || call.tool === 'fs.edit_file') &&
          (pathIs(call, 'VERSION') || pathIs(call, 'CHANGELOG.md'))),
    ),
    verify: (context) => gradeReleaseCommit(gitView(context.facts), context.facts.commits ?? {}),
  }),
  task('sl-x-incident-culprit', 'chain', 4, {
    prompt: `The ${REPORT_INCIDENT} incident report on the intranet names the commit that caused it. Who wrote that commit, and who is their manager? ${ANSWER("the author's name, then the manager's name, comma-separated")}`,
    steps: [
      inBox('fetch', ['fetch']),
      inBox('git', ['git_show', 'git_log']),
      inBox('memory', MEM_READS),
    ],
    expect: (calls) => touched(calls, 'fetch') && touched(calls, 'git') && touched(calls, 'memory'),
    forbid: readsOnly,
    verify: verifyText(gradeCulprit),
  }),
  task('sl-x-after-hours-tickets', 'bulk-read', 8, {
    prompt: `Which open or pending tickets assigned to Lena Fischer's direct reports were opened before 09:00 or after 17:00 in the customer's own local time? The support database stores times in UTC. ${ANSWER('the ticket numbers, comma-separated')}`,
    steps: [inBox('memory', MEM_READS), inBox('sqlite', ['read_query'])],
    expect: (calls) => touched(calls, 'memory') && used(calls, 'sqlite', ['read_query']),
    forbid: readsOnly,
    verify: verifyText(gradeAfterHours),
  }),
  task('sl-x-incident-tickets', 'idempotency', 6, {
    ...world,
    prompt: `For every customer of ours that the ${REPORT_INCIDENT} incident report lists as affected, make sure the support database has an open ticket for them mentioning ${REPORT_INCIDENT}. Create any that are missing with the subject "${REPORT_INCIDENT}: billing export delays", priority high, assigned to Lena Fischer.`,
    steps: [
      inBox('fetch', ['fetch']),
      inBox('sqlite', ['read_query']),
      inBox('sqlite', ['write_query']),
    ],
    expect: (calls) => touched(calls, 'fetch') && used(calls, 'sqlite', ['write_query']),
    forbid: writesExcept((call) => insertsOnly(call, 'tickets')),
    verify: (context) =>
      gradeIncidentTickets(sqliteTable(context.facts, 'tickets')) &&
      otherTablesUnchanged(context.facts, ['tickets']),
  }),
  task('sl-x-oncall-assign', 'bulk-write', 5, {
    ...world,
    prompt:
      'Assign every open urgent support ticket that has no assignee to the primary on-call engineer for the week of 2026-10-26 (see the on-call rota on the intranet).',
    steps: [inBox('fetch', ['fetch']), inBox('sqlite', ['write_query'])],
    expect: (calls) => touched(calls, 'fetch') && used(calls, 'sqlite', ['write_query']),
    forbid: writesExcept((call) => updatesOnly(call, 'tickets')),
    verify: (context) =>
      gradeOncallAssign(sqliteTable(context.facts, 'tickets')) &&
      otherTablesUnchanged(context.facts, ['tickets']),
  }),
];

/** Expected values the tests pin as literals. */
export const SUMMIT_LOCAL_EXPECTED = EXPECTED;
