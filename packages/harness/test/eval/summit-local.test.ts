/**
 * The summit-local tier, offline (no model, no network beyond loopback):
 *
 * - its registration and composition (24 tasks, 10 single-box and 14
 *   cross-box, every budget 2N + 10);
 * - every expected value pinned as a literal;
 * - every grader against correct answers and near misses, and the
 *   end-state graders against hand-built rows, graphs and files;
 * - with the vendored servers installed (`pnpm run setup:servers-real`),
 *   the real world: the six servers' identities and tool lists, the
 *   fixture as the servers serve it (so the expected values are what a
 *   model can actually find), every write task's correct path and a near
 *   miss replayed through the real servers and graded on the end state,
 *   and teardown.
 */

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import {
  resolveTasks,
  resolveTiers,
  taskBoxes,
  worldOf,
  DEFAULT_TIERS,
  TASK_TIERS,
  type EvalTask,
  type MultiWorld,
  type SideEffect,
  type SummitBoxAlias,
} from '../../src/index.js';
import { budget } from '../../src/eval/multi-hard-tasks.js';
import {
  fastImportStream,
  openSummitLocalWorld,
  summitServersInstalled,
  SUMMIT_BOX_DESCRIPTIONS,
  SUMMIT_BOXES,
  SUMMIT_EXPECTED_TOOLS,
} from '../../src/eval/summit-local-world.js';
import {
  CUSTOMERS,
  MEMORY_GRAPH,
  TICKET_COMMENTS,
  TICKETS,
  type MemoryEntity,
  type MemoryRecord,
} from '../../src/eval/summit-local-fixtures.js';
import {
  gradeBillingManager,
  gradeCallTime,
  gradeCloseStale,
  gradeCodeOwners,
  gradeCulprit,
  gradeAfterHours,
  gradeUnmergedBranches,
  gradeIncidentTickets,
  gradeKenjiMove,
  gradeOncallAssign,
  gradeOverdueCsv,
  gradePersonTimes,
  gradeQ3Incidents,
  gradeReassign,
  gradeReleaseCustomers,
  gradeReleaseFiles,
  gradeTeamSync,
  gradeKenjiOwnedCommits,
  gradeOverdueFollowUp,
  gradePrimaryWeeks,
  gradeUntagged,
  gradeAnswerNumber,
  gradeNamesInOrder,
  SUMMIT_LOCAL_EXPECTED as E,
  SUMMIT_LOCAL_TASKS,
} from '../../src/eval/summit-local-tasks.js';

const byName = (name: string): EvalTask => {
  const task = SUMMIT_LOCAL_TASKS.find((t) => t.name === name);
  if (task === undefined) throw new Error(name);
  return task;
};

describe('summit-local tier: registration and composition', () => {
  it('is a known, opt-in tier on its own world', () => {
    expect(TASK_TIERS).toContain('summit-local');
    expect(DEFAULT_TIERS).not.toContain('summit-local');
    expect(resolveTiers(undefined)).not.toContain('summit-local');
    expect(resolveTiers('summit-local')).toEqual(['summit-local']);
    expect(worldOf('summit-local')).toBe('summit-local');
    expect(resolveTasks(undefined, ['summit-local'])).toEqual(SUMMIT_LOCAL_TASKS);
  });

  it('has 24 uniquely named tasks: 10 on one box, 14 on two or three, each with a 2N + 10 budget', () => {
    expect(SUMMIT_LOCAL_TASKS).toHaveLength(24);
    expect(new Set(SUMMIT_LOCAL_TASKS.map((t) => t.name)).size).toBe(24);
    const sizes = SUMMIT_LOCAL_TASKS.map((t) => taskBoxes(t).length);
    expect(sizes.filter((n) => n === 1)).toHaveLength(10);
    expect(sizes.filter((n) => n === 2 || n === 3)).toHaveLength(14);
    expect(sizes.every((n) => n >= 1 && n <= 3)).toBe(true);
    for (const task of SUMMIT_LOCAL_TASKS) {
      expect(task.tier).toBe('summit-local');
      expect(task.n, task.name).toBeGreaterThan(0);
      expect(task.maxTurns, task.name).toBe(budget(task.n as number));
      expect(task.verify, task.name).toBeDefined();
    }
    // Every box is used, and the existing filesystem server is one of them.
    const used = new Set(SUMMIT_LOCAL_TASKS.flatMap((t) => taskBoxes(t)));
    expect([...used].toSorted()).toEqual([...SUMMIT_BOXES]);
  });

  it('gives every box a one-line description', () => {
    for (const alias of SUMMIT_BOXES) {
      const d = SUMMIT_BOX_DESCRIPTIONS[alias];
      expect(d).not.toContain('\n');
      expect(d.length).toBeGreaterThan(40);
      expect(d.length).toBeLessThan(100);
    }
  });

  it('builds the same history every time (fixed identities and dates)', () => {
    expect(fastImportStream()).toBe(fastImportStream());
  });
});

describe('summit-local tier: expected values', () => {
  it('pins every expected value', () => {
    // The dark mode commit and its revert both land between the tags: its files did not change.
    expect(E.releaseFiles).toEqual([
      'CHANGELOG.md',
      'VERSION',
      'config/settings.toml',
      'src/auth/session.py',
      'src/billing/export.py',
      'tests/test_export.py',
    ]);
    expect([E.billingOwner, E.billingOwnerManager]).toEqual(['Priya Raman', 'Tomás Ortega']);
    expect(E.oncallChristmas).toMatchObject({
      week: '2026-12-21',
      primary: 'Priya Raman',
      secondary: 'Wen Li',
    });
    expect(E.unmergedBranches).toEqual([
      'experiment/graphql',
      'feature/invoice-pdf',
      'release/2.3',
    ]);
    expect(E.afterHours).toEqual([1009, 1015, 1063, 1065]);
    expect(E.kenjiOwnedCommits).toEqual(['c16', 'c17', 'c21', 'c25']);
    expect(E.primaryWeeks).toEqual({
      'Wen Li': 6,
      'Marco Bianchi': 5,
      'Dana Whitfield': 5,
      'Kenji Sato': 5,
      'Priya Raman': 5,
    });
    expect(E.overdueFollowUp).toEqual([
      { customer: 1, ticket: 1057 },
      { customer: 2, ticket: 1050 },
      { customer: 3, ticket: 1061 },
      { customer: 7, ticket: 1060 },
      { customer: 8, ticket: 1047 },
      { customer: 9, ticket: 1063 },
      { customer: 13, ticket: null },
    ]);
    expect(E.oncallThisWeek.primary).toBe('Marco Bianchi');
    expect(E.q3Incidents).toEqual({ billing: 6, 'export-worker': 4, auth: 3, web: 1 });
    // 1027 has an old-helpdesk `2026/08/19` timestamp; 1065's `2026/09/14` is not stale.
    expect(E.stalePending).toEqual([1015, 1022, 1027, 1034]);
    expect(E.commentAuthor.id).toBe(7);
    expect(E.deployTimes).toEqual({
      'Priya Raman': '04:30',
      'Kenji Sato': '08:00',
      'Wen Li': '07:00',
    });
    expect([E.callOwner, E.callOwnerTime]).toEqual(['Priya Raman', '07:30']);
    expect(E.codeOwners).toEqual({ 'Kenji Sato': 'Asia/Tokyo', 'Wen Li': 'Asia/Shanghai' });
    expect(E.releaseTicketCustomers).toEqual(['Copperline Bank', 'Granite Insurance']);
    expect(E.untaggedDeploys).toEqual(['2.3.2', '2.4.0-rc1']);
    expect(E.overdueEnterprise).toEqual({
      'Acme Freight': 2230.5,
      'Copperline Bank': 4200,
      'Granite Insurance': 760.25,
      'Indigo Retail': 3100,
    });
    expect([E.leaveManager, E.leaveTickets]).toEqual([
      'Ruth Okafor',
      [1042, 1044, 1051, 1053, 1058],
    ]);
    expect(E.newHires.map((p) => p.name)).toEqual(['Aiyana Brooks', 'Felix Wong']);
    expect(E.teamPage.find((p) => p.name === 'Marco Bianchi')?.role).toBe('Frontend lead');
    expect(E.teamPage.find((p) => p.name === 'Mei Chen')?.timezone).toBe('Asia/Kuala_Lumpur');
    expect(E.teamPage.map((p) => p.name)).not.toContain('Dana Whitman');
    expect(E.unreleasedCommits).toBe(13);
    expect(E.culprit).toEqual({ author: 'Kenji Sato', manager: 'Priya Raman' });
    expect(E.incidentNewTickets).toEqual(['Acme Freight', 'Granite Insurance', 'Lumen Media']);
    expect(E.urgentUnassigned).toEqual([1059, 1060, 1061]);
  });
});

describe('summit-local tier: answer graders', () => {
  it('kenji-owned commits: by abbreviated hash, exactly the set', () => {
    const commits = Object.fromEntries(
      ['c15', 'c16', 'c17', 'c21', 'c23', 'c25'].map((k, i) => [
        k,
        `${'abcdef1234567'[i]}${i}`.padEnd(40, '0'),
      ]),
    );
    const short = (k: string): string => (commits[k] as string).slice(0, 7);
    expect(
      gradeKenjiOwnedCommits(
        `ANSWER: ${['c16', 'c17', 'c21', 'c25'].map(short).join(', ')}`,
        commits,
      ),
    ).toBe(true);
    expect(
      gradeKenjiOwnedCommits(
        `ANSWER: ${['c25', 'c21', 'c17', 'c16'].map((k) => commits[k]).join(' ')}`,
        commits,
      ),
    ).toBe(true);
    // By message alone: the invoice.py commits under /src/billing/ are Priya's (the export.py line is more specific).
    expect(
      gradeKenjiOwnedCommits(
        `ANSWER: ${['c15', 'c16', 'c17', 'c21', 'c23', 'c25'].map(short).join(', ')}`,
        commits,
      ),
    ).toBe(false);
    expect(gradeKenjiOwnedCommits(`ANSWER: ${['c17', 'c21'].map(short).join(', ')}`, commits)).toBe(
      false,
    );
    expect(
      gradeKenjiOwnedCommits(
        `ANSWER: ${['c16', 'c17', 'c21', 'c25'].map(short).join(', ')}, 1234567`,
        commits,
      ),
    ).toBe(false);
  });

  it('release files: exactly the set, prefixes tolerated', () => {
    const all = E.releaseFiles.join(', ');
    expect(gradeReleaseFiles(`ANSWER: ${all}`)).toBe(true);
    expect(gradeReleaseFiles(`ANSWER: ${E.releaseFiles.map((p) => `\`b/${p}\``).join(', ')}`)).toBe(
      true,
    );
    expect(gradeReleaseFiles(`ANSWER: ${E.releaseFiles.slice(1).join(', ')}`)).toBe(false);
    expect(gradeReleaseFiles(`ANSWER: ${all}, docs/export.md`)).toBe(false);
    // Every file a commit in the range touched, the reverted ones included.
    expect(gradeReleaseFiles(`ANSWER: ${all}, src/web/app.js, src/web/styles.css`)).toBe(false);
  });

  it('numbers, names and ids', () => {
    expect(gradeAnswerNumber('ANSWER: 400', 400)).toBe(true);
    expect(gradeAnswerNumber('ANSWER: 400 (main has 1000)', 400)).toBe(false);
    expect(gradeAnswerNumber('ANSWER: 1000', 400)).toBe(false);
    expect(gradeAnswerNumber('ANSWER: 13 commits', 13)).toBe(true);
    expect(gradeAnswerNumber('ANSWER: 10', 13)).toBe(false);
    expect(gradeNamesInOrder('ANSWER: Kenji Sato', ['Kenji Sato'])).toBe(true);
    expect(gradeNamesInOrder('ANSWER: Kenji Sato (secondary: Priya Raman)', ['Kenji Sato'])).toBe(
      false,
    );
    expect(gradeBillingManager('ANSWER: Priya Raman, Tomas Ortega')).toBe(true);
    expect(gradeBillingManager('ANSWER: Priya Raman, Tomás Ortega')).toBe(true);
    expect(gradeBillingManager('ANSWER: Tomás Ortega, Priya Raman')).toBe(false);
    expect(gradeBillingManager('ANSWER: Dana Whitman, Priya Raman')).toBe(false);
    expect(gradeCulprit('ANSWER: Kenji Sato, Priya Raman')).toBe(true);
    expect(gradeCulprit('ANSWER: Kenji Sato, Tomás Ortega')).toBe(false);
    const q3 = 'billing: 6\nexport-worker: 4\nauth: 3\nweb: 1';
    expect(gradeQ3Incidents(q3)).toBe(true);
    expect(
      gradeQ3Incidents(
        `| Service | Count |\n|---|---|\n| **billing** | 6 |\n| export-worker | 4 |\n| auth | 3 |\n| web | 1 |\n| search | 0 |`,
      ),
    ).toBe(true);
    // The 2026-10-01 00:20 UTC billing sev1 counted; one service left out; search given one.
    expect(gradeQ3Incidents(q3.replace('billing: 6', 'billing: 7'))).toBe(false);
    expect(gradeQ3Incidents('billing: 6\nexport-worker: 4\nauth: 3')).toBe(false);
    expect(gradeQ3Incidents(`${q3}\nsearch: 1`)).toBe(false);
  });

  it('per-person times: 24-hour or am/pm, every person, no former member', () => {
    const lines = 'Priya Raman: 04:30\nKenji Sato: 08:00\nWen Li: 07:00';
    expect(gradePersonTimes(lines, E.deployTimes)).toBe(true);
    expect(
      gradePersonTimes(
        '- **Priya Raman**: 4:30 AM (next day)\n- Kenji Sato: 8:00 am\n- Wen Li: 7:00 a.m.',
        E.deployTimes,
      ),
    ).toBe(true);
    expect(gradePersonTimes('Dana Whitfield starts at 16:00.\n' + lines, E.deployTimes)).toBe(true);
    expect(
      gradePersonTimes('Priya Raman: 05:30\nKenji Sato: 08:00\nWen Li: 07:00', E.deployTimes),
    ).toBe(false);
    expect(gradePersonTimes('Priya Raman: 04:30\nKenji Sato: 08:00', E.deployTimes)).toBe(false);
    expect(gradePersonTimes(`${lines}\nDana Whitman: 17:00`, E.deployTimes)).toBe(false);
  });

  it('call time, code owners, customers, versions, degraded owners', () => {
    expect(gradeCallTime('ANSWER: Priya Raman, 07:30')).toBe(true);
    expect(gradeCallTime('ANSWER: Priya Raman, 7:30 AM')).toBe(true);
    expect(gradeCallTime('ANSWER: Priya Raman, 08:30')).toBe(false);
    expect(gradeCallTime('ANSWER: Kenji Sato, 07:30')).toBe(false);

    expect(gradeCodeOwners('ANSWER: Kenji Sato (Asia/Tokyo); Wen Li (Asia/Shanghai)')).toBe(true);
    expect(gradeCodeOwners('ANSWER: Wen Li (Asia/Shanghai); Kenji Sato (Asia/Tokyo)')).toBe(true);
    expect(gradeCodeOwners('ANSWER: Kenji Sato (Asia/Shanghai); Wen Li (Asia/Tokyo)')).toBe(false);
    expect(
      gradeCodeOwners(
        'ANSWER: Priya Raman (Asia/Kolkata); Kenji Sato (Asia/Tokyo); Wen Li (Asia/Shanghai)',
      ),
    ).toBe(false);

    expect(gradeReleaseCustomers('ANSWER: Copperline Bank, Granite Insurance')).toBe(true);
    // The reverted dark mode ticket's customer.
    expect(
      gradeReleaseCustomers('ANSWER: Copperline Bank, Granite Insurance, Driftwood Studio'),
    ).toBe(false);
    expect(gradeReleaseCustomers('ANSWER: Copperline Bank')).toBe(false);

    expect(gradeUntagged('ANSWER: 2.3.2, 2.4.0-rc1')).toBe(true);
    expect(gradeUntagged('ANSWER: v2.3.2, v2.4.0-rc1.')).toBe(true);
    expect(gradeUntagged('ANSWER: 2.3.2')).toBe(false);
    expect(gradeUntagged('ANSWER: 2.3.1, 2.3.2, 2.4.0-rc1')).toBe(false);

    expect(
      gradeUnmergedBranches('ANSWER: release/2.3, feature/invoice-pdf, experiment/graphql'),
    ).toBe(true);
    expect(
      gradeUnmergedBranches('ANSWER: `experiment/graphql`, `feature/invoice-pdf`, `release/2.3`'),
    ).toBe(true);
    // The fast-forwarded branches do not contain main's tip, but nothing on them is missing from main.
    expect(
      gradeUnmergedBranches(
        'ANSWER: release/2.3, feature/invoice-pdf, experiment/graphql, fix/export-header, hotfix/late-fee',
      ),
    ).toBe(false);
    expect(gradeUnmergedBranches('ANSWER: release/2.3, feature/invoice-pdf')).toBe(false);

    expect(gradeAfterHours('ANSWER: 1009, 1015, 1063, 1065')).toBe(true);
    expect(gradeAfterHours('ANSWER: #1065, #1063, #1015, #1009')).toBe(true);
    // Lena's own tickets (1044, 1058) are not her reports'.
    expect(gradeAfterHours('ANSWER: 1009, 1015, 1044, 1058, 1063, 1065')).toBe(false);
    // Summer time assumed after the EU switch (1056); Arizona treated as observing DST (1015).
    expect(gradeAfterHours('ANSWER: 1009, 1015, 1056, 1063, 1065')).toBe(false);
    expect(gradeAfterHours('ANSWER: 1009, 1063, 1065')).toBe(false);
    // Chicago given standard time before the US switch (1065).
    expect(gradeAfterHours('ANSWER: 1009, 1015, 1063')).toBe(false);

    const weeks = 'Wen Li: 6\nMarco Bianchi: 5\nDana Whitfield: 5\nKenji Sato: 5\nPriya Raman: 5';
    expect(gradePrimaryWeeks(weeks)).toBe(true);
    expect(
      gradePrimaryWeeks(
        '| Engineer | Weeks |\n|---|---|\n| **Wen Li** | 6 |\n| Marco Bianchi | 5 |\n| Dana Whitfield | 5 |\n| Kenji Sato | 5 |\n| Priya Raman | 5 |\n\nWen Li covers 2026-07-06 too.',
      ),
    ).toBe(true);
    // A working list of dates per person before the rows.
    expect(
      gradePrimaryWeeks(`- Wen Li: 2026-07-06, 2026-08-10\n- Kenji Sato: 2026-07-27\n\n${weeks}`),
    ).toBe(true);
    expect(gradePrimaryWeeks(weeks.replace('Wen Li: 6', 'Wen Li: 5'))).toBe(false);
    expect(gradePrimaryWeeks(weeks.replace('\nPriya Raman: 5', ''))).toBe(false);
  });
});

type Row = Record<string, unknown>;
const seeded = (): Row[] => TICKETS.map((t) => ({ ...t }));
const edit = (rows: Row[], ids: readonly number[], patch: Row): Row[] =>
  rows.map((r) => (ids.includes(Number(r['id'])) ? { ...r, ...patch } : r));

describe('summit-local tier: end-state graders', () => {
  it('close stale: exactly the stale pending tickets', () => {
    const closed = edit(seeded(), E.stalePending, {
      status: 'closed',
      closed_at: '2026-10-31',
      updated_at: '2026-10-31',
    });
    expect(gradeCloseStale(closed)).toBe(true);
    // The boundary ticket (updated 2026-09-01 09:15) closed too.
    expect(
      gradeCloseStale(edit(closed, [1038], { status: 'closed', closed_at: '2026-10-31' })),
    ).toBe(false);
    expect(
      gradeCloseStale(
        edit(seeded(), E.stalePending.slice(1), { status: 'closed', closed_at: '2026-10-31' }),
      ),
    ).toBe(false);
    expect(
      gradeCloseStale(
        edit(seeded(), E.stalePending, { status: 'closed', closed_at: '2026-10-30' }),
      ),
    ).toBe(false);
  });

  it('reassign, on-call assign: exactly the right tickets to the right person', () => {
    expect(gradeReassign(edit(seeded(), E.leaveTickets, { assignee: 'Ruth Okafor' }))).toBe(true);
    expect(
      gradeReassign(edit(seeded(), [...E.leaveTickets, 1019], { assignee: 'Ruth Okafor' })),
    ).toBe(false);
    expect(gradeReassign(edit(seeded(), E.leaveTickets, { assignee: 'Sven Olsen' }))).toBe(false);
    expect(
      gradeOncallAssign(edit(seeded(), E.urgentUnassigned, { assignee: 'Marco Bianchi' })),
    ).toBe(true);
    expect(
      gradeOncallAssign(edit(seeded(), E.urgentUnassigned, { assignee: 'Dana Whitfield' })),
    ).toBe(false);
    expect(
      gradeOncallAssign(
        edit(seeded(), [...E.urgentUnassigned, 1055], { assignee: 'Marco Bianchi' }),
      ),
    ).toBe(false);
  });

  it('incident tickets: one per affected customer without one', () => {
    const ticket = (id: number, customer: string): Row => ({
      id,
      customer_id: (CUSTOMERS.find((c) => c.name === customer) as { id: number }).id,
      subject: 'INC-2041: billing export delays',
      status: 'open',
      priority: 'high',
      assignee: 'Lena Fischer',
      opened_at: null,
      updated_at: null,
      closed_at: null,
    });
    const right = [...seeded(), ...E.incidentNewTickets.map((c, i) => ticket(2000 + i, c))];
    expect(gradeIncidentTickets(right)).toBe(true);
    expect(gradeIncidentTickets([...right, ticket(2010, 'Indigo Retail')])).toBe(false);
    expect(gradeIncidentTickets(right.slice(0, -1))).toBe(false);
    expect(
      gradeIncidentTickets([
        ...seeded(),
        ...E.incidentNewTickets.map((c, i) => ({ ...ticket(2000 + i, c), priority: 'urgent' })),
      ]),
    ).toBe(false);
  });

  it('overdue follow-up: a comment per customer on the newest open ticket, a new ticket where none', () => {
    const seed = (): Row[] => TICKET_COMMENTS.map((c) => ({ ...c }));
    const comment = (id: number, ticket: number, patch: Row = {}): Row => ({
      id,
      ticket_id: ticket,
      author_id: 7,
      body: E.overdueComment,
      created_at: null,
      ...patch,
    });
    const targets = E.overdueFollowUp.flatMap((f) => (f.ticket === null ? [] : [f.ticket]));
    const comments = [...seed(), ...targets.map((t, i) => comment(100 + i, t))];
    const newTicket: Row = {
      id: 2000,
      customer_id: 13,
      subject: 'Overdue invoice',
      status: 'open',
      priority: 'normal',
      assignee: 'Lena Fischer',
      opened_at: '2026-10-31 09:00',
      updated_at: null,
      closed_at: null,
    };
    expect(gradeOverdueFollowUp([...seeded(), newTicket], comments)).toBe(true);
    // The newest ticket by string order: the old helpdesk's slashes sort after the dashes.
    const bySlash = comments.map((c) => (c['ticket_id'] === 1050 ? { ...c, ticket_id: 1027 } : c));
    expect(gradeOverdueFollowUp([...seeded(), newTicket], bySlash)).toBe(false);
    expect(gradeOverdueFollowUp(seeded(), comments)).toBe(false);
    expect(gradeOverdueFollowUp([...seeded(), newTicket], comments.slice(0, -1))).toBe(false);
    // Lena's name where the schema wants her agent id.
    expect(
      gradeOverdueFollowUp(
        [...seeded(), newTicket],
        comments.map((c, i) =>
          i >= TICKET_COMMENTS.length ? { ...c, author_id: 'Lena Fischer' } : c,
        ),
      ),
    ).toBe(false);
    expect(gradeOverdueFollowUp([...seeded(), { ...newTicket, priority: 'high' }], comments)).toBe(
      false,
    );
  });

  it('overdue csv: header optional, every enterprise customer, largest first', () => {
    const rows =
      'Copperline Bank,4200.00\nIndigo Retail,3100.00\nAcme Freight,2230.50\nGranite Insurance,760.25\n';
    expect(gradeOverdueCsv(rows)).toBe(true);
    expect(gradeOverdueCsv(`customer,overdue_total\n${rows}`)).toBe(true);
    expect(
      gradeOverdueCsv(
        `"customer","overdue_total"\n"Copperline Bank","$4,200.00"\nIndigo Retail,3100\nAcme Freight,2230.5\nGranite Insurance,760.25`,
      ),
    ).toBe(true);
    expect(
      gradeOverdueCsv(
        'Acme Freight,2230.50\nCopperline Bank,4200.00\nIndigo Retail,3100.00\nGranite Insurance,760.25',
      ),
    ).toBe(false);
    expect(gradeOverdueCsv(`${rows}Bluewater Labs,340.00\n`)).toBe(false);
    expect(
      gradeOverdueCsv(
        'Copperline Bank,4200.00\nIndigo Retail,3100.00\nAcme Freight,1250.00\nGranite Insurance,760.25',
      ),
    ).toBe(false);
    expect(gradeOverdueCsv(undefined)).toBe(false);
  });

  it('kenji move and team sync on hand-built graphs', () => {
    const graph = (): MemoryRecord[] => structuredClone(MEMORY_GRAPH) as MemoryRecord[];
    const moved = graph()
      .filter((r) => !(r.type === 'relation' && r.from === 'Kenji Sato' && r.to === 'Billing team'))
      .map((r) =>
        r.type === 'entity' && r.name === 'Kenji Sato'
          ? { ...r, observations: [...r.observations, 'Moved to the Platform team on 2026-10-26'] }
          : r,
      );
    moved.push({
      type: 'relation',
      from: 'Kenji Sato',
      to: 'Platform team',
      relationType: 'member_of',
    });
    expect(gradeKenjiMove(moved)).toBe(true);
    // Still in Billing too.
    expect(
      gradeKenjiMove([
        ...graph(),
        { type: 'relation', from: 'Kenji Sato', to: 'Platform team', relationType: 'member_of' },
      ]),
    ).toBe(false);
    // Reports-to dropped along the way.
    expect(
      gradeKenjiMove(
        moved.filter(
          (r) =>
            !(r.type === 'relation' && r.from === 'Kenji Sato' && r.relationType === 'reports_to'),
        ),
      ),
    ).toBe(false);

    const hire = (name: string, role: string, tz: string): MemoryEntity => ({
      type: 'entity',
      name,
      entityType: 'person',
      observations: [`Role: ${role}`, `Timezone: ${tz}`],
    });
    const swap = (g: MemoryRecord[], name: string, from: string, to: string): MemoryRecord[] =>
      g.map((r) =>
        r.type === 'entity' && r.name === name
          ? { ...r, observations: r.observations.map((o) => (o === from ? to : o)) }
          : r,
      );
    const updated = swap(
      swap(graph(), 'Marco Bianchi', 'Role: Frontend engineer', 'Role: Frontend lead'),
      'Mei Chen',
      'Timezone: Asia/Singapore',
      'Timezone: Asia/Kuala_Lumpur',
    );
    const hires = [
      hire('Aiyana Brooks', 'Support engineer', 'America/Phoenix'),
      hire('Felix Wong', 'Frontend engineer', 'Asia/Singapore'),
    ];
    const synced = [...updated, ...hires];
    expect(gradeTeamSync(synced)).toBe(true);
    // Only the new hires added: the promotion and the move missed.
    expect(gradeTeamSync([...graph(), ...hires])).toBe(false);
    // The new role added next to the old one.
    const both = graph().map((r) =>
      r.type === 'entity' && r.name === 'Marco Bianchi'
        ? { ...r, observations: [...r.observations, 'Role: Frontend lead'] }
        : r,
    );
    expect(
      gradeTeamSync([
        ...swap(both, 'Mei Chen', 'Timezone: Asia/Singapore', 'Timezone: Asia/Kuala_Lumpur'),
        ...hires,
      ]),
    ).toBe(false);
    expect(gradeTeamSync(synced.slice(0, -1))).toBe(false);
    expect(
      gradeTeamSync([
        ...synced,
        hire('Dana  Whitfield', 'Site reliability engineer', 'America/Phoenix'),
      ]),
    ).toBe(false);
    expect(
      gradeTeamSync([
        ...updated,
        hire('Aiyana Brooks', 'Support engineer', 'UTC'),
        hires[1] as MemoryEntity,
      ]),
    ).toBe(false);
    expect(
      gradeTeamSync(synced.filter((r) => !(r.type === 'entity' && r.name === 'Dana Whitman'))),
    ).toBe(false);
  });

  it('forbids the harmful writes and never a read', () => {
    const call = (tool: string, args: Record<string, unknown> = {}): SideEffect => ({ tool, args });
    const commit = byName('sl-git-commit-staged').forbid as (c: SideEffect) => boolean;
    expect(commit(call('git.git_commit', { message: 'x' }))).toBe(false);
    expect(commit(call('git.git_add', { files: ['src/billing/export.py'] }))).toBe(false);
    expect(commit(call('git.git_add', { files: ['.'] }))).toBe(true);
    expect(commit(call('git.git_checkout', { branch_name: 'main' }))).toBe(true);
    expect(commit(call('git.git_log', {}))).toBe(false);
    const stale = byName('sl-sql-close-stale').forbid as (c: SideEffect) => boolean;
    expect(
      stale(
        call('sqlite.write_query', { query: "UPDATE tickets SET status='closed' WHERE id=1015" }),
      ),
    ).toBe(false);
    expect(stale(call('sqlite.write_query', { query: 'DELETE FROM tickets WHERE id=1015' }))).toBe(
      true,
    );
    expect(stale(call('sqlite.append_insight', { insight: 'x' }))).toBe(true);
    const follow = byName('sl-sql-overdue-follow-up').forbid as (c: SideEffect) => boolean;
    expect(
      follow(
        call('sqlite.write_query', {
          query: "INSERT INTO ticket_comments (ticket_id, author_id, body) VALUES (1057, 7, 'x')",
        }),
      ),
    ).toBe(false);
    expect(
      follow(
        call('sqlite.write_query', {
          query: "UPDATE tickets SET status = 'pending' WHERE id = 1057",
        }),
      ),
    ).toBe(true);
    expect(follow(call('sqlite.append_insight', { insight: 'Overdue invoices followed up' }))).toBe(
      true,
    );
    const csv = byName('sl-x-overdue-csv').forbid as (c: SideEffect) => boolean;
    expect(
      csv(
        call('fs.write_file', { path: '/x/tidepool/reports/overdue-enterprise.csv', content: '' }),
      ),
    ).toBe(false);
    expect(csv(call('fs.write_file', { path: '/x/tidepool/overdue.csv', content: '' }))).toBe(true);
    const release = byName('sl-x-release-commit').forbid as (c: SideEffect) => boolean;
    expect(release(call('git.git_reset', {}))).toBe(false);
    expect(release(call('git.git_add', { files: ['VERSION', 'CHANGELOG.md'] }))).toBe(false);
    expect(release(call('git.git_add', { files: ['src/billing/export.py'] }))).toBe(false);
    expect(release(call('git.git_add', { files: ['VERSION', 'src/web/app.js'] }))).toBe(true);
    expect(release(call('git.git_add', { files: ['.'] }))).toBe(true);
    expect(release(call('fs.edit_file', { path: 'src/web/app.js', edits: [] }))).toBe(true);
    for (const task of SUMMIT_LOCAL_TASKS) {
      expect(task.forbid?.(call('fetch.fetch', { url: 'http://127.0.0.1/' })), task.name).toBe(
        false,
      );
      expect(task.forbid?.(call('memory.read_graph')), task.name).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The real world

const installed = summitServersInstalled();
if (!installed) {
  // eslint-disable-next-line no-console -- say why a whole suite is skipped
  console.warn(
    'summit-local world tests skipped: the vendored servers are not installed; run `pnpm run setup:servers-real` in packages/harness (needs npm and uv)',
  );
}

interface Result {
  text: string;
  isError: boolean;
}

/** A client per box, connected in-process to the box's recording proxy. */
async function connect(world: MultiWorld): Promise<{
  call(alias: SummitBoxAlias, tool: string, args?: Record<string, unknown>): Promise<Result>;
  close(): Promise<void>;
}> {
  const clients = new Map<string, Client>();
  for (const box of world.boxes) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'summit-test', version: '0.0.0' }, { capabilities: {} });
    await box.world.server.connect(b);
    await client.connect(a);
    clients.set(box.alias, client);
  }
  return {
    async call(alias, tool, args = {}) {
      const r = await (clients.get(alias) as Client).callTool({ name: tool, arguments: args });
      const text = (r.content as { type: string; text?: string }[])
        .map((c) => c.text ?? '')
        .join('\n');
      return { text, isError: r.isError === true };
    },
    async close() {
      await Promise.all([...clients.values()].map((c) => c.close().catch(() => {})));
    },
  };
}

/** Open a world, run `fn` with a connected client, verify `task`, tear down. */
async function episode(
  task: EvalTask,
  fn: (
    call: Awaited<ReturnType<typeof connect>>['call'],
    world: MultiWorld,
  ) => Promise<string | void>,
): Promise<boolean> {
  const world = await openSummitLocalWorld();
  const session = await connect(world);
  try {
    const finalText = (await fn(session.call, world)) ?? '';
    const forbidden = world.calls.some((c) => task.forbid?.(c) === true);
    expect(forbidden, `${task.name}: a forbidden call`).toBe(false);
    return (await task.verify?.({ calls: world.calls, finalText, facts: world.facts })) === true;
  } finally {
    await session.close();
    await world.close();
  }
}

describe.skipIf(!installed)('summit-local world (real servers)', () => {
  it('opens the six real servers with exactly their tools, and tears everything down', async () => {
    const world = await openSummitLocalWorld();
    const base = dirname(world.facts.root as string);
    let closed = false;
    try {
      expect(world.name).toBe('summit-local');
      expect(world.boxes.map((b) => b.alias)).toEqual([...SUMMIT_BOXES]);
      for (const box of world.boxes) {
        expect(box.world.tools.map((t) => t.name).toSorted(), box.alias).toEqual(
          SUMMIT_EXPECTED_TOOLS[box.alias as SummitBoxAlias],
        );
        expect(box.description).toBe(SUMMIT_BOX_DESCRIPTIONS[box.alias as SummitBoxAlias]);
      }
      expect(world.tools).toHaveLength(Object.values(SUMMIT_EXPECTED_TOOLS).flat().length);
      expect(world.hostSystemPrompt).toContain(world.facts.root);
      expect(world.hostSystemPrompt).toContain(world.facts.intranet);
      expect(existsSync(world.facts.memoryFile as string)).toBe(true);
      expect(existsSync(world.facts.sqliteDb as string)).toBe(true);
      const session = await connect(world);
      try {
        expect(
          (
            await session.call('sqlite', 'read_query', {
              query: 'SELECT COUNT(*) AS n FROM tickets',
            })
          ).text,
        ).toContain(`'n': ${TICKETS.length}`);
        expect(world.calls).toEqual([
          { tool: 'sqlite.read_query', args: { query: 'SELECT COUNT(*) AS n FROM tickets' } },
        ]);
      } finally {
        await session.close();
      }
      await world.close();
      closed = true;
      expect(existsSync(base)).toBe(false);
      await expect(fetch(`${world.facts.intranet}/`)).rejects.toThrow();
    } finally {
      if (!closed) await world.close();
    }
  }, 60_000);

  it('builds the same commit hashes in every episode', async () => {
    const [a, b] = await Promise.all([openSummitLocalWorld(), openSummitLocalWorld()]);
    try {
      expect(Object.keys(a.facts.commits ?? {})).toHaveLength(32);
      expect(a.facts.commits).toEqual(b.facts.commits);
      expect(a.facts.root).not.toBe(b.facts.root);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  }, 60_000);

  it('serves the fixture the expected answers are derived from', async () => {
    const world = await openSummitLocalWorld();
    const s = await connect(world);
    const repo = world.facts.root as string;
    const url = world.facts.intranet as string;
    try {
      // git: the default log stops short of the timeout change and the release.
      const log10 = (await s.call('git', 'git_log', { repo_path: repo })).text;
      expect(log10).not.toContain('auth: tune session handling');
      expect(log10).not.toContain('release: 2.3.0');
      const log = (await s.call('git', 'git_log', { repo_path: repo, max_count: 40 })).text;
      const messages = [...log.matchAll(/^Message: (.*)$/gm)].map((m) => m[1]);
      expect(messages.indexOf('release: 2.3.0')).toBe(E.unreleasedCommits);
      const timeout = await s.call('git', 'git_show', {
        repo_path: repo,
        revision: (world.facts.commits as Record<string, string>)['c7'],
      });
      expect(timeout.text).toContain('Author: Kenji Sato');
      expect(timeout.text).toContain('+SESSION_TIMEOUT_MINUTES = 45');
      // git_diff takes one ref, never a range: the release's files are its commits' files.
      expect(
        (await s.call('git', 'git_diff', { repo_path: repo, target: 'v2.2.0..v2.3.0' })).isError,
      ).toBe(true);
      // Diffing against v2.2.0 from the release commit's tree gives the release's files; the
      // commits in between also touch the reverted dark mode files.
      const touchedFiles = new Set<string>();
      for (const key of ['c7', 'c8', 'c9', 'c10', 'c11', 'c12', 'c12b', 'c13']) {
        const shown = (
          await s.call('git', 'git_show', {
            repo_path: repo,
            revision: (world.facts.commits as Record<string, string>)[key],
          })
        ).text;
        for (const m of shown.matchAll(/^(?:\+\+\+ b|--- a)\/(.*)$/gm))
          touchedFiles.add(m[1] as string);
      }
      expect([...touchedFiles].toSorted()).toEqual(
        [...E.releaseFiles, 'src/web/app.js', 'src/web/styles.css'].toSorted(),
      );
      expect(log).toContain('Revert "web: dark mode toggle (closes #1040)"');
      expect(
        (
          await s.call('git', 'git_show', {
            repo_path: repo,
            revision: 'release/2.3:config/settings.toml',
          })
        ).text,
      ).toContain('batch_size = 400');
      expect(
        (await s.call('git', 'git_show', { repo_path: repo, revision: 'v2.3.2' })).isError,
      ).toBe(true);
      expect(
        (await s.call('git', 'git_show', { repo_path: repo, revision: 'v2.3.1' })).isError,
      ).toBe(false);
      // The fast-forwarded branches are contained in main; not_contains on main's tip is the trap.
      const containing = (
        await s.call('git', 'git_branch', {
          repo_path: repo,
          branch_type: 'local',
          contains: 'fix/export-header',
        })
      ).text;
      expect(containing).toContain('main');
      const notMain = (
        await s.call('git', 'git_branch', {
          repo_path: repo,
          branch_type: 'local',
          not_contains: 'main',
        })
      ).text;
      expect(notMain).toContain('fix/export-header');
      const status = (await s.call('git', 'git_status', { repo_path: repo })).text;
      expect(status).toMatch(
        /Changes to be committed:[\s\S]*src\/billing\/export\.py[\s\S]*not staged[\s\S]*src\/web\/app\.js[\s\S]*Untracked[\s\S]*notes\//,
      );
      // fs: the same checkout, on main.
      expect(
        (await s.call('fs', 'read_text_file', { path: `${repo}/config/settings.toml` })).text,
      ).toContain('batch_size = 1000');
      // fetch: the intranet, paged; the incident report names the culprit's short hash.
      const rota = (await s.call('fetch', 'fetch', { url: `${url}/handbook/oncall` })).text;
      expect(rota).not.toContain('2026-10-26');
      expect(rota).toContain('start_index of 5000');
      const later = (
        await s.call('fetch', 'fetch', { url: `${url}/handbook/oncall`, start_index: 5000 })
      ).text;
      expect(later).toMatch(/2026-12-21 \| Priya Raman \| Wen Li/);
      expect(later).toMatch(/2026-10-26 \| Marco Bianchi \| Dana Whitfield/);
      const report = (await s.call('fetch', 'fetch', { url: `${url}/incidents/INC-2041` })).text;
      expect(report).toContain(
        ((world.facts.commits as Record<string, string>)['c21'] as string).slice(0, 7),
      );
      const page4 = (await s.call('fetch', 'fetch', { url: `${url}/api/incidents?page=4` })).text;
      expect(page4).toContain('"next": null');
      expect((await s.call('fetch', 'fetch', { url: `${url}/incidents/INC-2040` })).isError).toBe(
        true,
      );
      // Nothing off the loopback is reachable.
      expect((await s.call('fetch', 'fetch', { url: 'https://example.com/' })).isError).toBe(true);
      // memory, sqlite, time.
      expect((await s.call('memory', 'open_nodes', { names: ['Lena Fischer'] })).text).toContain(
        'Ruth Okafor',
      );
      expect(
        (
          await s.call('sqlite', 'read_query', {
            query: "SELECT id FROM agents WHERE name = 'Lena Fischer'",
          })
        ).text,
      ).toContain("'id': 7");
      const converted = (
        await s.call('time', 'convert_time', {
          source_timezone: 'Asia/Singapore',
          time: '10:00',
          target_timezone: 'Asia/Kolkata',
        })
      ).text;
      expect(converted).toContain('T07:30:00+05:30');
    } finally {
      await s.close();
      await world.close();
    }
  }, 60_000);

  it('git commit tasks: the right path passes, sweeping in other work fails', async () => {
    const staged = byName('sl-git-commit-staged');
    expect(
      await episode(staged, async (call, w) => {
        await call('git', 'git_commit', {
          repo_path: w.facts.root,
          message: 'fix(billing): round export totals to cents',
        });
      }),
    ).toBe(true);
    const wrongMessage = await episode(staged, async (call, w) => {
      await call('git', 'git_commit', { repo_path: w.facts.root, message: 'fix: round totals' });
    });
    expect(wrongMessage).toBe(false);

    const release = byName('sl-x-release-commit');
    const releaseEdits = async (
      call: Parameters<Parameters<typeof episode>[1]>[0],
      w: MultiWorld,
    ): Promise<void> => {
      await call('fs', 'write_file', { path: `${w.facts.root}/VERSION`, content: '2.4.0\n' });
      await call('fs', 'edit_file', {
        path: `${w.facts.root}/CHANGELOG.md`,
        edits: [{ oldText: '## Unreleased', newText: '## 2.4.0 - 2026-10-31' }],
      });
    };
    expect(
      await episode(release, async (call, w) => {
        await call('git', 'git_reset', { repo_path: w.facts.root });
        await releaseEdits(call, w);
        await call('git', 'git_add', {
          repo_path: w.facts.root,
          files: ['VERSION', 'CHANGELOG.md'],
        });
        await call('git', 'git_commit', { repo_path: w.facts.root, message: 'release: 2.4.0' });
      }),
    ).toBe(true);
    // Without unstaging first, the staged fix rides along.
    expect(
      await episode(release, async (call, w) => {
        await releaseEdits(call, w);
        await call('git', 'git_add', {
          repo_path: w.facts.root,
          files: ['VERSION', 'CHANGELOG.md'],
        });
        await call('git', 'git_commit', { repo_path: w.facts.root, message: 'release: 2.4.0' });
      }),
    ).toBe(false);
  }, 60_000);

  it('sqlite write tasks: the right SQL passes, a near miss fails', async () => {
    const write =
      (queries: string | string[]) =>
      async (call: Parameters<Parameters<typeof episode>[1]>[0]) => {
        for (const query of [queries].flat()) {
          const r = await call('sqlite', 'write_query', { query });
          expect(r.isError, r.text).toBe(false);
        }
      };
    const comment = (ticket: number): string =>
      `INSERT INTO ticket_comments (ticket_id, author_id, body) VALUES (${ticket}, 7, '${E.overdueComment}')`;
    const followUp = (tickets: number[]): string[] => [
      ...tickets.map(comment),
      "INSERT INTO tickets (customer_id, subject, status, priority, assignee, opened_at) VALUES (13, 'Overdue invoice', 'open', 'normal', 'Lena Fischer', '2026-10-31 09:00')",
    ];
    const cases: [string, string | string[], string | string[]][] = [
      [
        'sl-sql-close-stale',
        "UPDATE tickets SET status = 'closed', closed_at = '2026-10-31' WHERE status = 'pending' AND REPLACE(updated_at, '/', '-') < '2026-09-01'",
        // Misses the old-helpdesk row whose timestamp uses slashes.
        "UPDATE tickets SET status = 'closed', closed_at = '2026-10-31' WHERE status = 'pending' AND updated_at < '2026-09-01'",
      ],
      [
        'sl-sql-overdue-follow-up',
        followUp([1057, 1050, 1061, 1060, 1047, 1063]),
        // MAX(opened_at) as strings: the old helpdesk's slashed rows win for two customers.
        followUp([1057, 1027, 1065, 1060, 1047, 1063]),
      ],
      [
        'sl-x-reassign-on-leave',
        "UPDATE tickets SET assignee = 'Ruth Okafor' WHERE assignee = 'Lena Fischer' AND status IN ('open', 'pending')",
        "UPDATE tickets SET assignee = 'Ruth Okafor' WHERE assignee = 'Lena Fischer'",
      ],
      [
        'sl-x-oncall-assign',
        "UPDATE tickets SET assignee = 'Marco Bianchi' WHERE priority = 'urgent' AND assignee IS NULL AND status = 'open'",
        "UPDATE tickets SET assignee = 'Marco Bianchi' WHERE priority = 'urgent' AND assignee IS NULL",
      ],
      [
        'sl-x-incident-tickets',
        "INSERT INTO tickets (customer_id, subject, status, priority, assignee) VALUES (1, 'INC-2041: billing export delays', 'open', 'high', 'Lena Fischer'), (7, 'INC-2041: billing export delays', 'open', 'high', 'Lena Fischer'), (12, 'INC-2041: billing export delays', 'open', 'high', 'Lena Fischer')",
        "INSERT INTO tickets (customer_id, subject, status, priority, assignee) VALUES (1, 'INC-2041: billing export delays', 'open', 'high', 'Lena Fischer'), (7, 'INC-2041: billing export delays', 'open', 'high', 'Lena Fischer'), (9, 'INC-2041: billing export delays', 'open', 'high', 'Lena Fischer'), (12, 'INC-2041: billing export delays', 'open', 'high', 'Lena Fischer')",
      ],
    ];
    const verdicts = await Promise.all(
      cases.flatMap(([name, right, wrong]) => [
        episode(byName(name), write(right)).then((ok) => [`${name} right`, ok, true] as const),
        episode(byName(name), write(wrong)).then((ok) => [`${name} near miss`, ok, false] as const),
      ]),
    );
    for (const [label, ok, want] of verdicts) expect(ok, label).toBe(want);
  }, 120_000);

  it('memory and file write tasks: the right path passes, a near miss fails', async () => {
    const kenji = byName('sl-mem-kenji-moves');
    const move = async (
      call: Parameters<Parameters<typeof episode>[1]>[0],
      drop: boolean,
    ): Promise<void> => {
      if (drop) {
        await call('memory', 'delete_relations', {
          relations: [{ from: 'Kenji Sato', to: 'Billing team', relationType: 'member_of' }],
        });
      }
      await call('memory', 'create_relations', {
        relations: [{ from: 'Kenji Sato', to: 'Platform team', relationType: 'member_of' }],
      });
      await call('memory', 'add_observations', {
        observations: [
          { entityName: 'Kenji Sato', contents: ['Moved to the Platform team on 2026-10-26'] },
        ],
      });
    };
    expect(await episode(kenji, (call) => move(call, true))).toBe(true);
    expect(await episode(kenji, (call) => move(call, false))).toBe(false);

    const sync = byName('sl-x-team-page-sync');
    const hires = (tz: string) => async (call: Parameters<Parameters<typeof episode>[1]>[0]) => {
      await call('memory', 'delete_observations', {
        deletions: [
          { entityName: 'Marco Bianchi', observations: ['Role: Frontend engineer'] },
          { entityName: 'Mei Chen', observations: ['Timezone: Asia/Singapore'] },
        ],
      });
      await call('memory', 'add_observations', {
        observations: [
          { entityName: 'Marco Bianchi', contents: ['Role: Frontend lead'] },
          { entityName: 'Mei Chen', contents: ['Timezone: Asia/Kuala_Lumpur'] },
        ],
      });
      await call('memory', 'create_entities', {
        entities: [
          {
            name: 'Aiyana Brooks',
            entityType: 'person',
            observations: ['Role: Support engineer', `Timezone: ${tz}`],
          },
          {
            name: 'Felix Wong',
            entityType: 'person',
            observations: ['Role: Frontend engineer', 'Timezone: Asia/Singapore'],
          },
          // Already there: the server skips it.
          { name: 'Priya Raman', entityType: 'person', observations: ['Role: Backend lead'] },
        ],
      });
    };
    expect(await episode(sync, hires('America/Phoenix'))).toBe(true);
    expect(await episode(sync, hires('America/Denver'))).toBe(false);

    const csv = byName('sl-x-overdue-csv');
    const writeCsv =
      (content: string) =>
      async (call: Parameters<Parameters<typeof episode>[1]>[0], w: MultiWorld) => {
        const r = await call('fs', 'write_file', {
          path: `${w.facts.root}/reports/overdue-enterprise.csv`,
          content,
        });
        expect(r.isError, r.text).toBe(false);
      };
    expect(
      await episode(
        csv,
        writeCsv(
          'customer,overdue_total\nCopperline Bank,4200.00\nIndigo Retail,3100.00\nAcme Freight,2230.50\nGranite Insurance,760.25\n',
        ),
      ),
    ).toBe(true);
    expect(
      await episode(
        csv,
        writeCsv(
          'customer,overdue_total\nCopperline Bank,4200.00\nIndigo Retail,3100.00\nAcme Freight,2230.50\nGranite Insurance,1570.25\n',
        ),
      ),
    ).toBe(false);
  }, 120_000);
});
