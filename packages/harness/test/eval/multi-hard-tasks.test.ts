/**
 * The multi-hard tier's graders, offline (no servers, no model): every
 * expected value pinned as a literal, and every grader against hand-built
 * call logs and answers — passing, failing, with extra writes, and
 * partial. The end-state graders (audit_log, customers, the missing-VIPs
 * file) are called on hand-built documents and text; multi-hard-world.test.ts
 * runs the same tasks against the real boxes.
 */

import { describe, expect, it } from 'vitest';
import {
  answerIssueNumbers,
  answerLine,
  budget,
  forbidAudit,
  forbidExportComments,
  forbidFailingChecks,
  forbidStaleLabels,
  forbidVip,
  gradeAuditDocs,
  gradeChainOrders,
  gradeErrorCounts,
  gradeExportComments,
  gradeFailingChecks,
  gradeFeatureBranches,
  gradeFirst2025,
  gradeGoldTotals,
  gradeMissingVips,
  gradeOwner,
  gradeStaleLabels,
  gradeTitleFiles,
  gradeVipTiers,
  isBoxWrite,
  promptFor,
  resolveTasks,
  resolveTiers,
  turnBudget,
  valuesAfter,
  worldOf,
  worldOptionsOf,
  DEFAULT_TIERS,
  HARD_AUDIT_DOCS,
  HARD_TIER_BY_EMAIL,
  MULTI_HARD_EXPECTED as E,
  MULTI_HARD_TASKS,
  SHIPPED_ORDER_IDS,
  type EvalTask,
  type SideEffect,
} from '../../src/index.js';

const ACME = { owner: 'acme', repo: 'widgets' };
const gh = (tool: string, args: Record<string, unknown>): SideEffect => ({
  tool: `github.${tool}`,
  args: { ...ACME, ...args },
});
const mongo = (tool: string, args: Record<string, unknown>): SideEffect => ({
  tool: `mongo.${tool}`,
  args: { connectionId: 'preconfigured', database: 'shop', ...args },
});
const fs = (tool: string, args: Record<string, unknown>): SideEffect => ({
  tool: `fs.${tool}`,
  args,
});

function task(name: string): EvalTask {
  const found = MULTI_HARD_TASKS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no task ${name}`);
  return found;
}

/** expect holds and nothing forbidden was called (verify not included). */
function scores(t: EvalTask, calls: SideEffect[]): boolean {
  const forbid = t.forbid;
  return t.expect(calls) && !(forbid !== undefined && calls.some((c) => forbid(c)));
}

describe('multi-hard tier', () => {
  it('has 12 tasks over five families, each with N and a 2N + 10 budget', () => {
    expect(MULTI_HARD_TASKS).toHaveLength(12);
    expect(MULTI_HARD_TASKS.every((t) => t.tier === 'multi-hard')).toBe(true);
    expect(MULTI_HARD_TASKS.map((t) => [t.name, t.kind, t.n, t.maxTurns])).toEqual([
      ['hard-gold-order-totals', 'bulk-read', 30, 70],
      ['hard-log-error-lines', 'bulk-read', 28, 66],
      ['hard-issues-naming-files', 'bulk-read', 40, 90],
      ['hard-label-stale-issues', 'bulk-write', 12, 34],
      ['hard-comment-export-prs', 'bulk-write', 35, 80],
      ['hard-audit-shipped-orders', 'bulk-write', 14, 38],
      ['hard-chain-release-reporter', 'chain', 6, 22],
      ['hard-chain-failing-owner', 'chain', 5, 20],
      ['hard-page-feature-branches', 'pagination', 3, 16],
      ['hard-page-first-2025-release', 'pagination', 3, 16],
      ['hard-branch-failing-checks', 'branching', 15, 40],
      ['hard-branch-vip-tiers', 'branching', 15, 40],
    ]);
    for (const t of MULTI_HARD_TASKS) expect(t.maxTurns).toBe(budget(t.n as number));
    for (const t of MULTI_HARD_TASKS) {
      for (const name of t.steps.flat()) expect(name).toMatch(/^(github|fs|mongo)\.[\w-]+$/);
    }
  });

  it('runs in the multi world opened as the hard variant, and only on request', () => {
    expect(worldOf('multi-hard')).toBe('multi');
    expect(worldOptionsOf('multi-hard')).toEqual({ variant: 'hard' });
    expect(worldOptionsOf('multi')).toEqual({});
    expect(DEFAULT_TIERS).not.toContain('multi-hard');
    expect(resolveTiers(undefined)).not.toContain('multi-hard');
    expect(resolveTiers('multi-hard')).toEqual(['multi-hard']);
    expect(resolveTasks(undefined, ['multi-hard'])).toEqual(MULTI_HARD_TASKS);
  });

  it("uses a task's own budget over the run's, with a ceiling of twice it", () => {
    expect(turnBudget({ maxTurns: 34 }, { maxTurns: 12, maxTotalTurns: 24 })).toEqual({
      maxTurns: 34,
      maxTotalTurns: 68,
    });
    expect(turnBudget({}, { maxTurns: 12, maxTotalTurns: 24 })).toEqual({
      maxTurns: 12,
      maxTotalTurns: 24,
    });
    expect(turnBudget({}, {})).toEqual({});
  });

  it('prompts name no tool and no path outside the project', () => {
    for (const t of MULTI_HARD_TASKS) {
      const prompt = promptFor(t, { root: '/home/me/project' });
      for (const word of [
        'find',
        'count',
        'aggregate',
        'explain',
        'call_tool',
        'execute_machine',
      ]) {
        expect(new RegExp(`\\b${word}\\b`, 'i').test(prompt), `${t.name}: ${word}`).toBe(false);
      }
      expect(prompt).not.toContain('/home/me/project');
    }
  });

  it('pins every expected value', () => {
    expect(E.goldTotals).toMatchInlineSnapshot(`
      {
        "aaron.cole@example.com": 192.03,
        "alice@example.com": 572.15,
        "caleb.shaw@example.com": 341.2,
        "carol@example.com": 560.88,
        "dalia.sousa@example.com": 126.26,
        "erin@example.com": 494.07,
        "fatima.zahra@example.com": 443.56,
        "gustav.ek@example.com": 421.76,
        "hugo@example.com": 426.38,
        "ines.duarte@example.com": 239.14,
        "ivan.petrov@example.com": 168.26,
        "jonas.weber@example.com": 348.7,
        "julia.kraus@example.com": 435.91,
        "lena.fischer@example.com": 213.15,
        "lucia.romero@example.com": 232.8,
        "marco.rossi@example.com": 214.79,
        "nora.quinn@example.com": 337.95,
        "omar.farouk@example.com": 296.87,
        "oscar.lind@example.com": 171.84,
        "priya.nair@example.com": 215.5,
        "ravi.iyer@example.com": 386.73,
        "rosa.vidal@example.com": 338.39,
        "sam.okafor@example.com": 383.29,
        "theo.marsh@example.com": 0,
        "tomasz.kowal@example.com": 361.27,
        "viktor.hahn@example.com": 498.09,
        "wanda.novak@example.com": 0,
        "wen.zhao@example.com": 146.72,
        "yusuf.demir@example.com": 240.55,
        "zara.malik@example.com": 254.64,
      }
    `);
    expect(E.errorCounts).toMatchInlineSnapshot(`
      {
        "api-gateway.log": 8,
        "auth.log": 2,
        "billing.log": 5,
        "cart.log": 2,
        "catalog.log": 2,
        "checkout.log": 6,
        "email.log": 0,
        "fraud.log": 2,
        "geo.log": 7,
        "image.log": 6,
        "inventory.log": 8,
        "ledger.log": 6,
        "loyalty.log": 5,
        "media.log": 1,
        "notify.log": 8,
        "orders.log": 9,
        "payments.log": 9,
        "pricing.log": 1,
        "profile.log": 8,
        "queue.log": 0,
        "ranking.log": 9,
        "recs.log": 8,
        "reviews.log": 3,
        "search.log": 9,
        "session.log": 2,
        "shipping.log": 5,
        "tax.log": 6,
        "wishlist.log": 8,
      }
    `);
    expect(E.titleFileIssues).toMatchInlineSnapshot(`
      [
        32,
        33,
        45,
        46,
        48,
        50,
        56,
        58,
        61,
        64,
        65,
        66,
        67,
        71,
        75,
        81,
        82,
        85,
        90,
        92,
        98,
        99,
        103,
        105,
        109,
        110,
      ]
    `);
    expect(E.staleIssues).toMatchInlineSnapshot(`
      {
        "32": [],
        "34": [],
        "39": [
          "enhancement",
        ],
        "43": [
          "bug",
        ],
        "45": [],
        "47": [
          "enhancement",
        ],
        "49": [],
        "51": [],
        "55": [],
        "58": [
          "bug",
        ],
        "60": [
          "enhancement",
        ],
        "64": [
          "documentation",
          "needs-triage",
        ],
      }
    `);
    expect(E.exportPrs).toMatchInlineSnapshot(`
      [
        113,
        116,
        120,
        124,
        127,
        131,
        135,
        140,
        144,
      ]
    `);
    expect(E.missingAudits).toMatchInlineSnapshot(`
      [
        "A-1012",
        "A-1014",
        "A-1018",
        "A-1030",
        "A-1034",
        "A-1039",
        "A-1042",
        "A-1046",
        "A-1055",
        "A-1061",
        "A-1064",
        "A-1074",
        "A-1080",
        "A-1087",
      ]
    `);
    expect(E.chainOrders).toMatchInlineSnapshot(`
      [
        "A-1050",
        "A-1077",
        "A-1103",
      ]
    `);
    expect(E.owner).toMatchInlineSnapshot(`
      {
        "email": "rhea.mor@acme.dev",
        "openAssigned": 7,
      }
    `);
    expect(E.featureBranches).toMatchInlineSnapshot(`23`);
    expect(E.first2025Tag).toMatchInlineSnapshot(`"v0.3.4"`);
    expect(E.fixIssues).toMatchInlineSnapshot(`
      [
        "src/api/routes.ts",
        "src/db/pool.ts",
        "src/export/xml.ts",
        "src/cli/args.ts",
        "src/ui/chart.tsx",
        "docs/api.md",
      ]
    `);
    expect(E.missingFiles).toMatchInlineSnapshot(`
      [
        "src/cache/lru.ts",
        "src/export/pdf.ts",
        "src/perf/bench.ts",
        "scripts/license.sh",
      ]
    `);
    expect(E.vipUpgrades).toMatchInlineSnapshot(`
      [
        "bob@example.com",
        "ines.duarte@example.com",
        "kemal.arslan@example.com",
        "nadia.haddad@example.com",
        "quinn.avery@example.com",
        "marco.rossi@example.com",
        "uma.patel@example.com",
        "bianca.neri@example.com",
        "emil.berg@example.com",
        "sofia.lund@example.com",
        "priya.nair@example.com",
      ]
    `);
    expect(E.vipMissing).toMatchInlineSnapshot(`
      [
        "zoe.park@example.com",
        "grace@example.org",
        "liam.byrne@example.com",
        "oliver.grant@example.com",
      ]
    `);
  });
});

describe('answer parsing', () => {
  it('reads the last ANSWER line, ignoring emphasis', () => {
    expect(answerLine('ANSWER: 1\nmore\n**Answer:** 2')).toBe('2');
    expect(answerLine('no marker here')).toBeUndefined();
    expect(answerIssueNumbers('Found these.\nANSWER: #12, #3, #12')).toEqual([3, 12]);
  });

  it('takes the first number after a whole-token id on each line', () => {
    expect(valuesAfter('- auth.log: 3\n- oauth.log: 9', 'auth.log')).toEqual([3]);
    expect(valuesAfter('| alice@example.com | $1,234.50 |', 'alice@example.com')).toEqual([1234.5]);
    expect(valuesAfter('xalice@example.com: 5', 'alice@example.com')).toEqual([]);
  });
});

describe('bulk-read graders', () => {
  const goldAnswer = Object.entries(E.goldTotals)
    .map(([email, total]) => `${email}: $${total.toFixed(2)}`)
    .join('\n');

  it('gold totals: passes on every exact total', () => {
    expect(gradeGoldTotals(goldAnswer)).toBe(true);
    // Mongo's float sums, unrounded, are still the same total.
    expect(gradeGoldTotals(goldAnswer.replace(': $572.15', ': 572.1500000000001'))).toBe(true);
    // A table works as well as lines.
    const table = Object.entries(E.goldTotals)
      .map(([email, total]) => `| ${email} | ${total.toFixed(2)} |`)
      .join('\n');
    expect(gradeGoldTotals(`| Email | Total |\n|---|---|\n${table}`)).toBe(true);
  });

  it('gold totals: fails on a wrong total, a missing customer, or a non-gold extra', () => {
    expect(gradeGoldTotals(goldAnswer.replace(': $572.15', ': $572.16'))).toBe(false);
    // Partial: the first ten (a find's default page).
    expect(gradeGoldTotals(goldAnswer.split('\n').slice(0, 10).join('\n'))).toBe(false);
    // The zero-total customers omitted.
    expect(
      gradeGoldTotals(
        goldAnswer
          .split('\n')
          .filter((l) => !l.includes('theo.marsh'))
          .join('\n'),
      ),
    ).toBe(false);
    // Cancelled orders included would change Wanda's 0.
    expect(
      gradeGoldTotals(
        goldAnswer.replace('wanda.novak@example.com: $0.00', 'wanda.novak@example.com: $12.00'),
      ),
    ).toBe(false);
    expect(gradeGoldTotals(`${goldAnswer}\nbob@example.com: $24.00`)).toBe(false);
  });

  const logAnswer = Object.entries(E.errorCounts)
    .map(([file, n]) => `${file}: ${n}`)
    .join('\n');

  it('error lines: exact tallies pass; an overcount of decoys, or a gap, fails', () => {
    expect(gradeErrorCounts(logAnswer)).toBe(true);
    expect(gradeErrorCounts(logAnswer.replace(/^logs/gm, 'logs/services/logs'))).toBe(true);
    // A naive includes('ERROR') counts the decoy lines in api-gateway.log.
    const naive = logAnswer.replace(
      `api-gateway.log: ${E.errorCounts['api-gateway.log']}`,
      `api-gateway.log: ${(E.errorCounts['api-gateway.log'] as number) + 1}`,
    );
    expect(gradeErrorCounts(naive)).toBe(false);
    expect(gradeErrorCounts(logAnswer.split('\n').slice(1).join('\n'))).toBe(false);
  });

  it('issue titles: exactly the expected numbers on the ANSWER line', () => {
    const hits = E.titleFileIssues.map((n) => `#${n}`).join(', ');
    expect(
      gradeTitleFiles(`#45 is about src/export/pdf.ts, which is absent.\nANSWER: ${hits}`),
    ).toBe(true);
    expect(gradeTitleFiles(`ANSWER: ${hits}, #107`)).toBe(false);
    expect(
      gradeTitleFiles(
        `ANSWER: ${E.titleFileIssues
          .slice(1)
          .map((n) => `#${n}`)
          .join(', ')}`,
      ),
    ).toBe(false);
    expect(gradeTitleFiles(hits)).toBe(false);
  });
});

describe('bulk-write graders', () => {
  const staleUpdates = Object.entries(E.staleIssues).map(([n, labels]) =>
    gh('issue_write', { method: 'update', issue_number: Number(n), labels: [...labels, 'stale'] }),
  );
  const t = task('hard-label-stale-issues');

  it('stale labels: every stale issue relabelled, labels kept', () => {
    const calls = [gh('list_issues', { state: 'OPEN' }), ...staleUpdates];
    expect(gradeStaleLabels(calls)).toBe(true);
    expect(scores(t, calls)).toBe(true);
  });

  it('stale labels: a dropped label, a partial run, or an extra issue fails', () => {
    const dropped = staleUpdates.map((call) => ({
      ...call,
      args: { ...call.args, labels: ['stale'] },
    }));
    expect(gradeStaleLabels(dropped)).toBe(false);
    // A later corrected update restores the labels: the end state is right.
    expect(gradeStaleLabels([...dropped, ...staleUpdates])).toBe(true);
    expect(gradeStaleLabels(staleUpdates.slice(0, 11))).toBe(false);
    const extra = gh('issue_write', {
      method: 'update',
      issue_number: 110,
      labels: ['bug', 'stale'],
    });
    expect(gradeStaleLabels([...staleUpdates, extra])).toBe(false);
    expect(forbidStaleLabels(extra)).toBe(true);
    expect(scores(t, [...staleUpdates, extra])).toBe(false);
  });

  it('stale labels: writes outside the set are forbidden', () => {
    const first = staleUpdates[0] as SideEffect;
    expect(forbidStaleLabels(first)).toBe(false);
    expect(forbidStaleLabels({ ...first, args: { ...first.args, state: 'closed' } })).toBe(true);
    expect(forbidStaleLabels(gh('label_write', { method: 'create', name: 'stale' }))).toBe(true);
    expect(forbidStaleLabels(gh('add_issue_comment', { issue_number: 32, body: 'stale' }))).toBe(
      true,
    );
    expect(forbidStaleLabels(gh('list_issues', {}))).toBe(false);
  });

  const body = 'Please add a CHANGELOG entry for the export changes.';
  const comments = E.exportPrs.map((n) => gh('add_issue_comment', { issue_number: n, body }));
  const exp = task('hard-comment-export-prs');

  it('export comments: one comment per expected PR', () => {
    const reads = [gh('list_pull_requests', { perPage: 100 })];
    expect(scores(exp, [...reads, ...comments])).toBe(true);
    // A review comment counts too.
    const viaReview = [
      ...comments.slice(1),
      gh('pull_request_review_write', {
        method: 'create',
        pullNumber: E.exportPrs[0],
        event: 'COMMENT',
        body,
      }),
    ];
    expect(gradeExportComments(viaReview)).toBe(true);
  });

  it('export comments: a missing PR, a duplicate, an extra PR or another write fails', () => {
    expect(gradeExportComments(comments.slice(1))).toBe(false);
    expect(gradeExportComments([...comments, comments[0] as SideEffect])).toBe(false);
    const decoy = gh('add_issue_comment', { issue_number: 114, body });
    expect(forbidExportComments(decoy)).toBe(true);
    expect(scores(exp, [...comments, decoy])).toBe(false);
    expect(forbidExportComments(gh('issue_write', { method: 'update', issue_number: 113 }))).toBe(
      true,
    );
    expect(
      gradeExportComments(comments.map((c) => ({ ...c, args: { ...c.args, body: 'LGTM' } }))),
    ).toBe(false);
  });

  // The audit_log as seeded: the base five, then the hard world's.
  const seeded = (): Record<string, unknown>[] => [
    ...Array.from({ length: 5 }, (_, i) => ({ action: 'login', actor: `u${i}` })),
    ...HARD_AUDIT_DOCS.map((d) => ({ ...d })),
  ];
  const inserted = E.missingAudits.map((orderId) => ({ action: 'shipped', orderId }));

  it('audit: exactly the missing documents', () => {
    expect(gradeAuditDocs(seeded())).toBe(false);
    expect(gradeAuditDocs([...seeded(), ...inserted])).toBe(true);
  });

  it('audit: a partial insert, a duplicate, or a document for every shipped order fails', () => {
    expect(gradeAuditDocs([...seeded(), ...inserted.slice(1)])).toBe(false);
    expect(gradeAuditDocs([...seeded(), ...inserted, inserted[0] as Record<string, unknown>])).toBe(
      false,
    );
    const all = SHIPPED_ORDER_IDS.map((orderId) => ({ action: 'shipped', orderId }));
    expect(gradeAuditDocs([...seeded(), ...all])).toBe(false);
  });

  it('audit: only inserts into audit_log are allowed', () => {
    expect(forbidAudit(mongo('insert-many', { collection: 'audit_log', documents: [] }))).toBe(
      false,
    );
    expect(forbidAudit(mongo('insert-many', { collection: 'orders', documents: [] }))).toBe(true);
    expect(
      forbidAudit(mongo('update-many', { collection: 'audit_log', filter: {}, update: {} })),
    ).toBe(true);
    expect(forbidAudit(mongo('delete-many', { collection: 'audit_log', filter: {} }))).toBe(true);
    expect(forbidAudit(mongo('find', { collection: 'audit_log' }))).toBe(false);
  });
});

describe('chain and pagination graders', () => {
  it('chain orders: exactly the customer’s order ids', () => {
    expect(gradeChainOrders(`ANSWER: ${E.chainOrders.join(', ')}`)).toBe(true);
    expect(gradeChainOrders(`ANSWER: ${E.chainOrders.slice(0, 2).join(', ')}`)).toBe(false);
    // tkowalski's orders (the near namesake) are wrong.
    expect(gradeChainOrders('ANSWER: A-1061, A-1090')).toBe(false);
    expect(gradeChainOrders(E.chainOrders.join(', '))).toBe(false);
  });

  it('owner: the email and the open-issue tally, nothing else', () => {
    expect(gradeOwner(`ANSWER: ${E.owner.email} ${E.owner.openAssigned}`)).toBe(true);
    expect(gradeOwner(`ANSWER: ${E.owner.email} 10`)).toBe(false);
    expect(gradeOwner(`ANSWER: rhea.martins@acme.dev ${E.owner.openAssigned}`)).toBe(false);
    expect(gradeOwner(`ANSWER: ${E.owner.email}`)).toBe(false);
  });

  it('feature branches: one number, the right one', () => {
    expect(gradeFeatureBranches(`ANSWER: ${E.featureBranches}`)).toBe(true);
    // Page one alone holds fewer.
    expect(gradeFeatureBranches('ANSWER: 10')).toBe(false);
    expect(gradeFeatureBranches(`ANSWER: ${E.featureBranches} or 26`)).toBe(false);
  });

  it('first 2025 release: exactly its tag', () => {
    expect(gradeFirst2025(`ANSWER: ${E.first2025Tag}`)).toBe(true);
    expect(gradeFirst2025('ANSWER: v0.3.3')).toBe(false);
    expect(gradeFirst2025(`ANSWER: ${E.first2025Tag} (after v0.3.3)`)).toBe(false);
  });
});

describe('branching graders', () => {
  const creates = E.fixIssues.map((path) =>
    gh('issue_write', { method: 'create', title: `Fix ${path}`, body: 'Failing check.' }),
  );
  const comment = gh('add_issue_comment', {
    issue_number: 139,
    body: `Missing files: ${E.missingFiles.join(', ')}`,
  });
  const checks = task('hard-branch-failing-checks');

  it('failing checks: one issue per existing file, a comment naming the missing ones', () => {
    expect(scores(checks, [...creates, comment])).toBe(true);
    // One comment per missing file is as good.
    const perFile = E.missingFiles.map((path) =>
      gh('add_issue_comment', { issue_number: 139, body: `${path} does not exist.` }),
    );
    expect(scores(checks, [...creates, ...perFile])).toBe(true);
  });

  it('failing checks: a duplicate issue, an issue for a missing file, or a gap fails', () => {
    // lint and typecheck report the same file: one issue, not two.
    expect(gradeFailingChecks([...creates, creates[0] as SideEffect, comment])).toBe(false);
    const wrong = gh('issue_write', { method: 'create', title: 'Fix src/cache/lru.ts' });
    expect(forbidFailingChecks(wrong)).toBe(true);
    expect(scores(checks, [...creates, wrong, comment])).toBe(false);
    expect(gradeFailingChecks(creates)).toBe(false);
    expect(gradeFailingChecks([...creates.slice(1), comment])).toBe(false);
    expect(
      forbidFailingChecks(gh('add_issue_comment', { issue_number: 146, body: 'src/cache/lru.ts' })),
    ).toBe(true);
  });

  it('VIP tiers: the VIPs who are customers become gold, nobody else changes', () => {
    const seeded = Object.entries(HARD_TIER_BY_EMAIL).map(([email, tier]) => ({ email, tier }));
    const done = seeded.map((c) => (E.vipUpgrades.includes(c.email) ? { ...c, tier: 'gold' } : c));
    expect(gradeVipTiers(seeded)).toBe(false);
    expect(gradeVipTiers(done)).toBe(true);
    // Partial, an extra upgrade, or the missing VIPs inserted as customers.
    expect(
      gradeVipTiers(
        done.map((c) => (c.email === 'bob@example.com' ? { ...c, tier: 'silver' } : c)),
      ),
    ).toBe(false);
    expect(
      gradeVipTiers(done.map((c) => (c.email === 'dan@example.com' ? { ...c, tier: 'gold' } : c))),
    ).toBe(false);
    expect(gradeVipTiers([...done, { email: 'zoe.park@example.com', tier: 'gold' }])).toBe(false);
  });

  it('VIP file: exactly the missing emails', () => {
    expect(gradeMissingVips(`${E.vipMissing.join('\n')}\n`)).toBe(true);
    expect(gradeMissingVips(E.vipMissing.slice(1).join('\n'))).toBe(false);
    expect(gradeMissingVips([...E.vipMissing, 'bob@example.com'].join('\n'))).toBe(false);
    expect(gradeMissingVips(undefined)).toBe(false);
  });

  it('VIP: only customer updates and the missing-VIPs file may be written', () => {
    expect(
      forbidVip(mongo('update-many', { collection: 'customers', filter: {}, update: {} })),
    ).toBe(false);
    expect(forbidVip(mongo('insert-many', { collection: 'customers', documents: [] }))).toBe(true);
    expect(
      forbidVip(fs('write_file', { path: '/tmp/x/notes/missing-vips.txt', content: '' })),
    ).toBe(false);
    expect(forbidVip(fs('write_file', { path: 'notes/vip.txt', content: '' }))).toBe(true);
    expect(forbidVip(fs('read_text_file', { path: 'notes/vip.txt' }))).toBe(false);
  });

  it('read-only tasks forbid every write', () => {
    for (const name of [
      'hard-gold-order-totals',
      'hard-log-error-lines',
      'hard-issues-naming-files',
      'hard-chain-release-reporter',
      'hard-chain-failing-owner',
      'hard-page-feature-branches',
      'hard-page-first-2025-release',
    ]) {
      expect(task(name).forbid).toBe(isBoxWrite);
    }
  });
});
