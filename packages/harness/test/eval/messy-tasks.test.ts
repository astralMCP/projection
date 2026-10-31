/**
 * The `summit-messy` tier, offline (no network, no model, no clock):
 *
 * - registration: the tier is opt-in, its 20 tasks each name their boxes,
 *   a forbid and a turn budget;
 * - every task: a REFERENCE solution — scripted calls through the direct
 *   mode's real MCP wire, against the messy (degraded) surface, reading
 *   its facts from the tools' own outputs — scores a pass, and a WRONG
 *   solution (the slip the messy server invites) scores a fail;
 * - the graders on hand-written answers, including other correct phrasings.
 */

import { describe, expect, it } from 'vitest';
import {
  hostToolName,
  openSession,
  openWorld,
  resolveTasks,
  resolveTiers,
  taskWorldOptions,
  DEFAULT_TIERS,
  MESSY_EXPECTED as E,
  MESSY_TASKS,
  type EvalTask,
  type ModeSession,
  type MultiWorld,
} from '../../src/index.js';
import {
  gradeActionItems,
  gradeActivePro,
  gradeFreeze29,
  gradeInvoiceFromEmail,
  gradeJonasHigh,
  gradeMustShip,
  gradePastDue,
  gradeReviewState,
  gradeUnreadCustomers,
} from '../../src/eval/messy-tasks.js';
import { NOW_EPOCH } from '../../src/eval/messy-billing.js';

// ---------------------------------------------------------------------------
// Harness

function task(name: string): EvalTask {
  const found = MESSY_TASKS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no task ${name}`);
  return found;
}

async function score(
  t: EvalTask,
  world: MultiWorld,
  finalText: string,
): Promise<{ success: boolean; forbidden: boolean }> {
  const calls = world.calls.slice();
  const forbid = t.forbid;
  const forbidden = forbid !== undefined && calls.some((c) => forbid(c));
  const expected = !forbidden && t.expect(calls);
  const success =
    expected && t.verify !== undefined
      ? await t.verify({ calls, finalText, facts: world.facts })
      : expected;
  return { success, forbidden };
}

interface Tools {
  /** `alias.servedName` → result text (`ERROR: …` when flagged). */
  call(tool: string, args?: Record<string, unknown>): Promise<string>;
  json<T = Record<string, unknown>>(tool: string, args?: Record<string, unknown>): Promise<T>;
}

function directTools(session: ModeSession): Tools {
  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<string> => {
    const [alias, ...rest] = tool.split('.');
    const r = await session.runtime.call(hostToolName(alias as string, rest.join('.')), args);
    return r.isError === true ? `ERROR: ${r.text}` : r.text;
  };
  return {
    call,
    json: async (tool, args) => {
      const text = await call(tool, args);
      // Tolerate a prose trailer after the JSON (the tracker's next-page line).
      return JSON.parse(text.slice(0, text.lastIndexOf('}') + 1));
    },
  };
}

type Solution = (tools: Tools) => Promise<string>;

async function run(
  name: string,
  solution: Solution,
): Promise<{ success: boolean; forbidden: boolean }> {
  const t = task(name);
  const world = (await openWorld('messy', taskWorldOptions(t))) as MultiWorld;
  const session = await openSession('direct', world);
  try {
    const finalText = await solution(directTools(session));
    return await score(t, world, finalText);
  } finally {
    await session.close();
    await world.close();
  }
}

interface Invoice {
  id: string;
  number: string;
  customer: string;
  customer_name: string;
  status: string;
  amount_due: number;
  due_date: number | null;
}
interface Charge {
  id: string;
  invoice: string | null;
  created: number;
}
interface Issue {
  identifier: string;
  title: string;
  state: string;
  priority: { value: number; name: string };
  assignee: { name: string; email: string } | null;
  labels: string[];
}

async function globexInvoice(t: Tools): Promise<Invoice> {
  const r = await t.json<{ data: Invoice[] }>('billing.GetInvoicesSearch', {
    query: "number:'INV-88213'",
  });
  return r.data[0] as Invoice;
}

/** The invoice's charges, oldest first. */
async function invoiceCharges(t: Tools, inv: Invoice): Promise<Charge[]> {
  const r = await t.json<{ data: Charge[] }>('billing.GetCharges', {
    customer: inv.customer,
    limit: 100,
  });
  return r.data.filter((c) => c.invoice === inv.id).toSorted((a, b) => a.created - b.created);
}

async function channelId(t: Tools, name: string): Promise<string> {
  const r = await t.json<{ channels: { id: string; name: string }[] }>('chat.list', {});
  return r.channels.find((c) => c.name === name)?.id as string;
}

/** A tracker search, every page (the next-page token is only in a prose trailer). */
async function allIssues(t: Tools, args: Record<string, unknown>): Promise<Issue[]> {
  const out: Issue[] = [];
  let after: string | undefined;
  do {
    const text = await t.call('tracker.search', {
      ...args,
      ...(after !== undefined ? { after } : {}),
    });
    out.push(
      ...(JSON.parse(text.slice(0, text.lastIndexOf('}') + 1)) as { issues: Issue[] }).issues,
    );
    after = /Next page token: (\S+)/.exec(text)?.[1];
  } while (after !== undefined);
  return out;
}

/** Mail search hits (`ID:` lines), and one message's text. */
async function mailIds(t: Tools, query: string): Promise<string[]> {
  return [...(await t.call('mail.search', { query })).matchAll(/ID: (\S+)/g)].map(
    (m) => m[1] as string,
  );
}

// ---------------------------------------------------------------------------
// Registration

describe('summit-messy registration', () => {
  it('is opt-in and has 20 tasks over the messy world', () => {
    expect(DEFAULT_TIERS).not.toContain('summit-messy');
    expect(resolveTiers('summit-messy')).toEqual(['summit-messy']);
    const tasks = resolveTasks(undefined, ['summit-messy']);
    expect(tasks.map((t) => t.name)).toEqual(MESSY_TASKS.map((t) => t.name));
    expect(tasks).toHaveLength(20);
  });

  it('every task names its boxes, a forbid and its own turn budget', () => {
    for (const t of MESSY_TASKS) {
      expect(t.boxes?.length, t.name).toBeGreaterThan(0);
      expect(t.forbid, t.name).toBeDefined();
      expect(t.maxTurns, t.name).toBeGreaterThanOrEqual(8);
      for (const step of t.steps.flat())
        expect(t.boxes, `${t.name} ${step}`).toContain(step.split('.')[0]);
    }
  });

  it('puts the 300+ tool catalog in several tasks and colliding names in cross-server ones', () => {
    expect(MESSY_TASKS.filter((t) => t.boxes?.includes('billing')).length).toBeGreaterThanOrEqual(
      5,
    );
    const cross = MESSY_TASKS.filter((t) => (t.boxes?.length ?? 0) > 1);
    expect(cross.length).toBeGreaterThanOrEqual(5);
    // tracker+mail share search/get/create; tracker+chat share list.
    expect(cross.some((t) => t.boxes?.includes('tracker') && t.boxes.includes('mail'))).toBe(true);
    expect(cross.some((t) => t.boxes?.includes('tracker') && t.boxes.includes('chat'))).toBe(true);
  });

  it('pins the expected values', () => {
    expect(E.activePro).toBe(17);
    expect(E.pastDue.toSorted()).toEqual([
      'Bluth Company',
      'Hooli',
      'Oscorp',
      'Tyrell Systems',
      'Vandelay Imports',
    ]);
    expect(E.jonasHigh).toEqual(['BE-151', 'BE-152']);
    expect(E.mustShip).toEqual(['BE-142', 'BE-147']);
    expect(E.freeze29).toBe('2026-11-19');
  });
});

// ---------------------------------------------------------------------------
// Reference and wrong solutions

describe('billing tasks', () => {
  it('messy-refund-duplicate: refund the later charge; the earlier one is forbidden', async () => {
    const ok = await run('messy-refund-duplicate', async (t) => {
      const charges = await invoiceCharges(t, await globexInvoice(t));
      await t.call('billing.PostRefunds', {
        requestBody: { charge: charges[1]?.id, reason: 'duplicate' },
      });
      return 'Done.';
    });
    expect(ok).toEqual({ success: true, forbidden: false });
    // The charges list is newest first: taking the first one listed is the slip.
    const wrong = await run('messy-refund-duplicate', async (t) => {
      const inv = await globexInvoice(t);
      const r = await t.json<{ data: Charge[] }>('billing.GetCharges', { customer: inv.customer });
      const listed = r.data.filter((c) => c.invoice === inv.id);
      await t.call('billing.PostRefunds', {
        requestBody: { charge: listed.at(-1)?.id, reason: 'duplicate' },
      });
      return 'Done.';
    });
    expect(wrong).toEqual({ success: false, forbidden: true });
  });

  it('messy-active-pro: every page counts; one default page does not', async () => {
    const ok = await run('messy-active-pro', async (t) => {
      let n = 0;
      for (let page = 1; ; page += 1) {
        const r = await t.json<{ data: unknown[] }>('billing.GetSubscriptions', {
          status: 'active',
          price: 'price_pro_m',
          page,
        });
        n += r.data.length;
        if (r.data.length < 10) break;
      }
      return `ANSWER: ${n}`;
    });
    expect(ok.success).toBe(true);
    const wrong = await run('messy-active-pro', async (t) => {
      const r = await t.json<{ data: unknown[] }>('billing.GetSubscriptions', {
        status: 'active',
        price: 'price_pro_m',
      });
      return `ANSWER: ${r.data.length}`;
    });
    expect(wrong.success).toBe(false);
  });

  it('messy-past-due: open and due before now; all open invoices is wrong', async () => {
    const answer = async (t: Tools, pastOnly: boolean): Promise<string> => {
      const r = await t.json<{ data: Invoice[] }>('billing.GetInvoices', {
        status: 'open',
        limit: 100,
      });
      const names = r.data
        .filter((i) => !pastOnly || (i.due_date !== null && i.due_date < NOW_EPOCH))
        .map((i) => i.customer_name);
      return `ANSWER: ${[...new Set(names)].join(', ')}`;
    };
    expect((await run('messy-past-due', (t) => answer(t, true))).success).toBe(true);
    expect((await run('messy-past-due', (t) => answer(t, false))).success).toBe(false);
  });

  it('messy-coupon: repeating for 3 months; once is wrong', async () => {
    const make = (duration: string) => async (t: Tools) => {
      const body: Record<string, unknown> = { id: 'FALL20', percent_off: 20, duration };
      if (duration === 'repeating') body['duration_in_months'] = 3;
      await t.call('billing.PostCoupons', { requestBody: body });
      return 'Created.';
    };
    expect((await run('messy-coupon', make('repeating'))).success).toBe(true);
    expect((await run('messy-coupon', make('once'))).success).toBe(false);
  });

  it('messy-flag-override: a per-customer override; turning the flag off is forbidden', async () => {
    const ok = await run('messy-flag-override', async (t) => {
      const r = await t.json<{ data: { id: string; name: string }[] }>(
        'billing.GetCustomersSearch',
        { query: "name:'Initech'" },
      );
      await t.call('billing.PostFeatureFlagsFlagKeyOverrides', {
        flag_key: 'new-checkout-flow',
        requestBody: { customer: r.data[0]?.id, enabled: false },
      });
      return 'Done.';
    });
    expect(ok.success).toBe(true);
    const wrong = await run('messy-flag-override', async (t) => {
      await t.call('billing.PostFeatureFlagsFlagKey', {
        flag_key: 'new-checkout-flow',
        requestBody: { enabled: false },
      });
      return 'Done.';
    });
    expect(wrong).toEqual({ success: false, forbidden: true });
  });
});

describe('tracker tasks', () => {
  it('messy-tracker-done: three transitions; one is not enough', async () => {
    const steps = (n: number) => async (t: Tools) => {
      for (let i = 0; i < n; i += 1) {
        const r = await t.json<{ transitions: { id: string; to: string }[] }>(
          'tracker.get_transitions',
          { id: 'BE-127' },
        );
        const next = ['In Progress', 'In Review', 'Done'][i];
        await t.call('tracker.transition_issue', {
          id: 'BE-127',
          transitionId: r.transitions.find((x) => x.to === next)?.id,
        });
      }
      return 'Done.';
    };
    expect((await run('messy-tracker-done', steps(3))).success).toBe(true);
    expect((await run('messy-tracker-done', steps(1))).success).toBe(false);
    // Asking for Done directly is refused as an ordinary result (errors as text).
    const direct = await run('messy-tracker-done', async (t) => {
      const text = await t.call('tracker.transition_issue', { id: 'BE-127', transitionId: '41' });
      expect(text).toMatch(/^Error: Transition 41 is not valid/);
      return 'Done.';
    });
    expect(direct.success).toBe(false);
  });

  it('messy-tracker-label: keep the existing labels; replacing them is wrong', async () => {
    const ok = await run('messy-tracker-label', async (t) => {
      const issue = await t.json<Issue>('tracker.get', { id: 'BE-131' });
      await t.call('tracker.update_issue', { id: 'BE-131', labels: [...issue.labels, 'security'] });
      return 'Done.';
    });
    expect(ok.success).toBe(true);
    const wrong = await run('messy-tracker-label', async (t) => {
      await t.call('tracker.update_issue', { id: 'BE-131', labels: ['security'] });
      return 'Done.';
    });
    expect(wrong.success).toBe(false);
  });

  it('messy-tracker-jonas: open and exactly High', async () => {
    const answer = (strict: boolean) => async (t: Tools) => {
      const issues = await allIssues(t, { assignee: 'jonas.weber@northwind.dev' });
      const hits = issues.filter(
        (i) =>
          !['Done', 'Canceled'].includes(i.state) &&
          (strict ? i.priority.value === 2 : i.priority.value <= 2),
      );
      return `ANSWER: ${hits.map((i) => i.identifier).join(', ')}`;
    };
    expect((await run('messy-tracker-jonas', answer(true))).success).toBe(true);
    // Urgent is not High.
    expect((await run('messy-tracker-jonas', answer(false))).success).toBe(false);
  });

  it('messy-tracker-bug: team, priority and assignee; a missing priority is refused as text', async () => {
    const ok = await run('messy-tracker-bug', async (t) => {
      const refused = await t.call('tracker.create', {
        team: 'BE',
        title: 'Refund webhook retries flood the DLQ',
      });
      expect(refused).toMatch(/^Error: Validation failed/);
      await t.call('tracker.create', {
        team: 'BE',
        title: 'Refund webhook retries flood the DLQ',
        priority: 2,
        assignee: 'omar.haddad@northwind.dev',
        labels: ['bug'],
      });
      return 'Filed.';
    });
    expect(ok.success).toBe(true);
    const wrong = await run('messy-tracker-bug', async (t) => {
      await t.call('tracker.create', {
        team: 'BE',
        title: 'Refund webhook retries flood the DLQ',
        priority: 1,
        assignee: 'omar.haddad@northwind.dev',
      });
      return 'Filed.';
    });
    expect(wrong.success).toBe(false);
  });
});

describe('chat tasks', () => {
  it('messy-chat-migration: one post in #eng-backend; a channel name gets ok:false', async () => {
    const ok = await run('messy-chat-migration', async (t) => {
      const named = await t.call('chat.post_message', { channel_id: 'eng-backend', text: 'x' });
      expect(named).toContain('channel_not_found');
      await t.call('chat.post_message', {
        channel_id: await channelId(t, 'eng-backend'),
        text: "Heads-up: tonight's schema migration window moves to 23:00 UTC.",
      });
      return 'Posted.';
    });
    expect(ok.success).toBe(true);
    const wrong = await run('messy-chat-migration', async (t) => {
      await t.call('chat.post_message', {
        channel_id: await channelId(t, 'general'),
        text: 'Migration at 23:00 UTC.',
      });
      return 'Posted.';
    });
    expect(wrong).toEqual({ success: false, forbidden: true });
  });

  it('messy-chat-action-items: thread replies via camelCase args; snake_case is refused', async () => {
    const ok = await run('messy-chat-action-items', async (t) => {
      const ch = await channelId(t, 'incidents');
      const snake = await t.call('chat.get_channel_history', { channel_id: ch });
      expect(snake).toMatch(/^ERROR: .*channelId/);
      const history = await t.json<{ messages: { text: string; ts: string }[] }>(
        'chat.get_channel_history',
        { channelId: ch, limit: 100 },
      );
      const parent = history.messages.find((m) => m.text.startsWith('INC-2041'));
      const replies = await t.json<{ messages: { text: string }[] }>('chat.get_thread_replies', {
        channelId: ch,
        threadTs: parent?.ts,
      });
      return `ANSWER: ${replies.messages.filter((m) => m.text.startsWith('AI:')).length}`;
    });
    expect(ok.success).toBe(true);
    // Counting every reply (chatter included) is wrong.
    const wrong = await run('messy-chat-action-items', async (t) => {
      const ch = await channelId(t, 'incidents');
      const history = await t.json<{ messages: { text: string; ts: string }[] }>(
        'chat.get_channel_history',
        { channelId: ch, limit: 100 },
      );
      const parent = history.messages.find((m) => m.text.startsWith('INC-2041'));
      const replies = await t.json<{ messages: unknown[] }>('chat.get_thread_replies', {
        channelId: ch,
        threadTs: parent?.ts,
      });
      return `ANSWER: ${replies.messages.length - 1}`;
    });
    expect(wrong.success).toBe(false);
  });

  it('messy-chat-freeze: the 2.9 announcement, out of a 110 KB page', async () => {
    const ok = await run('messy-chat-freeze', async (t) => {
      const text = await t.call('chat.get_channel_history', {
        channelId: await channelId(t, 'release-train'),
      });
      expect(text.length).toBeGreaterThan(100_000);
      const page = JSON.parse(text) as { messages: { text: string }[] };
      const msg = page.messages.find((m) => m.text.includes('*2.9*'));
      return `ANSWER: ${/\d{4}-\d{2}-\d{2}/.exec(msg?.text ?? '')?.[0] ?? ''}`;
    });
    expect(ok.success).toBe(true);
    // The 2.8 freeze is not the answer.
    expect((await run('messy-chat-freeze', async () => 'ANSWER: 2026-10-22')).success).toBe(false);
  });
});

describe('mail tasks', () => {
  it('messy-mail-draft: one draft to Grace; sending is forbidden', async () => {
    const reply = (tool: string) => async (t: Tools) => {
      const [id] = await mailIds(t, 'from:grace subject:"QA sign-off"');
      await t.call(tool, {
        to: ['grace.liu@northwind.dev'],
        subject: 'Re: QA sign-off 2.7.3',
        body: 'Hi Grace, the currency fix is now in review.',
        inReplyTo: id,
        cc: null,
      });
      return 'Drafted.';
    };
    expect((await run('messy-mail-draft', reply('mail.create'))).success).toBe(true);
    expect(await run('messy-mail-draft', reply('mail.send_email'))).toEqual({
      success: false,
      forbidden: true,
    });
  });

  it('messy-mail-unread: external unread senders only', async () => {
    const answer = (externalOnly: boolean) => async (t: Tools) => {
      const text = await t.call('mail.search', { query: 'is:unread' });
      const senders = [...text.matchAll(/From: .*<(.+)>/g)].map((m) => m[1] as string);
      return `ANSWER: ${senders.filter((s) => !externalOnly || !s.endsWith('@northwind.dev')).join(', ')}`;
    };
    expect((await run('messy-mail-unread', answer(true))).success).toBe(true);
    expect((await run('messy-mail-unread', answer(false))).success).toBe(false);
  });
});

describe('cross-server tasks', () => {
  it('messy-x-invoice-total: the email names the invoice; billing has its total and status', async () => {
    const ok = await run('messy-x-invoice-total', async (t) => {
      const [id] = await mailIds(t, 'from:globex charged');
      const body = await t.call('mail.get', { messageId: id });
      const number = /INV-\d+/.exec(body)?.[0];
      const r = await t.json<{ data: Invoice[] }>('billing.GetInvoicesSearch', {
        query: `number:'${number}'`,
      });
      const inv = r.data[0] as Invoice;
      return `ANSWER: $${(inv.amount_due / 100).toFixed(2)}; ${inv.status}`;
    });
    expect(ok.success).toBe(true);
    expect(
      (await run('messy-x-invoice-total', async () => 'ANSWER: $1,299.00; open')).success,
    ).toBe(false);
  });

  it('messy-x-initech-address: the new address on Initech, not Initrode', async () => {
    const update = (name: string) => async (t: Tools) => {
      const [id] = await mailIds(t, 'from:initech');
      const body = await t.call('mail.get', { messageId: id });
      expect(body).toContain('4120 Freidrich Lane');
      const r = await t.json<{ data: { id: string }[] }>('billing.GetCustomersSearch', {
        query: `name:'${name}'`,
      });
      await t.call('billing.PostCustomersCustomer', {
        customer: r.data[0]?.id,
        requestBody: { address: { line1: '4120 Freidrich Lane', city: 'Austin', state: 'TX' } },
      });
      return 'Updated.';
    };
    expect((await run('messy-x-initech-address', update('Initech'))).success).toBe(true);
    expect(await run('messy-x-initech-address', update('Initrode'))).toEqual({
      success: false,
      forbidden: true,
    });
  });

  it('messy-x-charge-comment: both charge IDs on BE-152', async () => {
    const comment = (ids: (charges: Charge[]) => string[]) => async (t: Tools) => {
      const charges = await invoiceCharges(t, await globexInvoice(t));
      const issues = await allIssues(t, { query: 'globex' });
      const issue = issues.find((i) => i.title.includes('charged twice'));
      await t.call('tracker.create_comment', {
        issueId: issue?.identifier,
        body: `Charges on INV-88213: ${ids(charges).join(', ')}`,
      });
      return 'Commented.';
    };
    expect(
      (
        await run(
          'messy-x-charge-comment',
          comment((c) => c.map((x) => x.id)),
        )
      ).success,
    ).toBe(true);
    expect(
      (
        await run(
          'messy-x-charge-comment',
          comment((c) => [c[1]?.id ?? '']),
        )
      ).success,
    ).toBe(false);
  });

  it('messy-x-must-ship: Dana’s two must-ship items, not the nice-to-have', async () => {
    const answer = (withNice: boolean) => async (t: Tools) => {
      const [id] = await mailIds(t, 'from:dana');
      const body = await t.call('mail.get', { messageId: id });
      expect(body).toContain('Must ship');
      const queries = [
        'idempotent refunds',
        'retry budget',
        ...(withNice ? ['dark mode tokens'] : []),
      ];
      const parts: string[] = [];
      for (const query of queries) {
        const [hit] = await allIssues(t, { query });
        parts.push(`${hit?.identifier}=${hit?.state}`);
      }
      return `ANSWER: ${parts.join('; ')}`;
    };
    expect((await run('messy-x-must-ship', answer(false))).success).toBe(true);
    expect((await run('messy-x-must-ship', answer(true))).success).toBe(false);
  });

  it('messy-x-review-state: yesterday’s ask, not the day before', async () => {
    const answer = (day: string) => async (t: Tools) => {
      const ch = await channelId(t, 'eng-backend');
      const history = await t.json<{ messages: { text: string; ts: string }[] }>(
        'chat.get_channel_history',
        { channelId: ch, limit: 100 },
      );
      const parent = history.messages.find((m) => m.text === `Review queue — ${day}`);
      const replies = await t.json<{ messages: { text: string }[] }>('chat.get_thread_replies', {
        channelId: ch,
        threadTs: parent?.ts,
      });
      const id = /BE-\d+/.exec(replies.messages.at(-1)?.text ?? '')?.[0];
      const issue = await t.json<Issue>('tracker.get', { id });
      return `ANSWER: ${id}; ${issue.state}; ${issue.assignee?.name}`;
    };
    expect((await run('messy-x-review-state', answer('2026-10-13'))).success).toBe(true);
    expect((await run('messy-x-review-state', answer('2026-10-12'))).success).toBe(false);
  });

  it('messy-x-globex-reply: a draft naming the duplicate charge and BE-152; refunding is forbidden', async () => {
    const draft = (refund: boolean) => async (t: Tools) => {
      const charges = await invoiceCharges(t, await globexInvoice(t));
      const dup = charges[1]?.id as string;
      if (refund)
        await t.call('billing.PostRefunds', { requestBody: { charge: dup, reason: 'duplicate' } });
      const [hit] = await allIssues(t, { query: 'acct_globex_0042' });
      await t.call('mail.create', {
        to: ['ops@globex.example'],
        subject: 'Re: Charged twice again??',
        body: `Charge ${dup} is the duplicate and will be refunded. We are tracking it as ${hit?.identifier}.`,
      });
      return 'Drafted.';
    };
    expect((await run('messy-x-globex-reply', draft(false))).success).toBe(true);
    expect(await run('messy-x-globex-reply', draft(true))).toEqual({
      success: false,
      forbidden: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Graders on hand-written answers

describe('graders accept every correct phrasing and nothing else', () => {
  it('reads only the last ANSWER line, emphasis ignored', () => {
    expect(gradeActivePro('There are 17.\n**ANSWER:** 17')).toBe(true);
    expect(gradeActivePro('ANSWER: 10\n...\nANSWER: 17 active')).toBe(true);
    expect(gradeActivePro('ANSWER: 17 of 21')).toBe(false);
    expect(gradeActivePro('17')).toBe(false);
  });

  it('past due: names in any order, with parentheticals', () => {
    expect(
      gradePastDue(
        'ANSWER: Oscorp (2 invoices), Hooli, Vandelay Imports, Tyrell Systems and Bluth Company',
      ),
    ).toBe(true);
    expect(gradePastDue('ANSWER: Hooli, Vandelay Imports, Tyrell Systems, Oscorp')).toBe(false);
    expect(
      gradePastDue(
        'ANSWER: Hooli, Vandelay Imports, Tyrell Systems, Oscorp, Bluth Company, Acme Retail',
      ),
    ).toBe(false);
  });

  it('invoice total: dollars or cents, exactly one status', () => {
    expect(gradeInvoiceFromEmail('ANSWER: $1,299.00; paid')).toBe(true);
    expect(gradeInvoiceFromEmail('ANSWER: 1299 USD; Paid')).toBe(true);
    expect(gradeInvoiceFromEmail('ANSWER: 129900 cents; paid')).toBe(true);
    expect(gradeInvoiceFromEmail('ANSWER: $1,299.00; paid (was open)')).toBe(false);
    expect(gradeInvoiceFromEmail('ANSWER: $2,598.00; paid')).toBe(false);
  });

  it('identifier sets, states and names', () => {
    expect(gradeJonasHigh('ANSWER: BE-152, BE-151')).toBe(true);
    expect(gradeJonasHigh('ANSWER: BE-151')).toBe(false);
    expect(gradeMustShip('ANSWER: BE-142=In Review; BE-147=In Review')).toBe(true);
    expect(gradeMustShip('ANSWER: BE-147 (In Review), BE-142 (in review)')).toBe(true);
    expect(gradeMustShip('ANSWER: BE-142=In Review; BE-147=In Progress')).toBe(false);
    expect(gradeReviewState('ANSWER: BE-142; In Review; Sam Rivera')).toBe(true);
    expect(gradeReviewState('ANSWER: BE-140; Done; Jonas Weber')).toBe(false);
  });

  it('counts, dates and senders', () => {
    expect(gradeActionItems('ANSWER: 4')).toBe(true);
    expect(gradeActionItems('ANSWER: 4 action items in INC-2041')).toBe(true);
    expect(gradeActionItems('ANSWER: 5')).toBe(false);
    expect(gradeFreeze29('ANSWER: 2026-11-19 (tentative)')).toBe(true);
    expect(gradeFreeze29('ANSWER: 2026-11-19 or 2026-10-22')).toBe(false);
    expect(gradeUnreadCustomers('ANSWER: ops@globex.example')).toBe(true);
    expect(gradeUnreadCustomers('ANSWER: ops@globex.example, grace.liu@northwind.dev')).toBe(false);
    expect(gradeUnreadCustomers('ANSWER: NONE')).toBe(false);
  });
});
