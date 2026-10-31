/**
 * The summit world and the `summit-saas` tier, offline (no network, no
 * model, no clock):
 *
 * - the world: five boxes, verbatim catalogs, one qualified call log, a
 *   fresh state per episode;
 * - each fake's fidelity: paging, defaults and maximums, validation (or the
 *   lack of it), error shapes, IDs versus names;
 * - every task: a REFERENCE solution — tool calls through direct mode's real
 *   MCP wire — passes, and a WRONG one (the trap its WHY-HARD names) fails.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIERS,
  hostToolName,
  openSession,
  openWorld,
  resolveTasks,
  resolveTiers,
  SUMMIT_BOX_DESCRIPTIONS,
  SUMMIT_DIRECT_SYSTEM_PROMPT,
  SUMMIT_EXPECTED as E,
  SUMMIT_TASKS,
  TIER_WORLDS,
  type EvalTask,
  type ModeSession,
  type MultiWorld,
} from '../../src/index.js';
import { NOTION_IDS } from '../../src/eval/summit-notion.js';
import { PEOPLE } from '../../src/eval/summit-people.js';
import { ISSUE_IDS } from '../../src/eval/summit-sentry.js';
import { CHANNELS, QA_EVENT_ID, THREADS } from '../../src/eval/summit-slack.js';
import { PI, PRICE_IDS, stripeCustomerIds } from '../../src/eval/summit-stripe.js';
import {
  mentionsIn,
  numbersIn,
  sentryUpdateTarget,
  shortIdsIn,
} from '../../src/eval/summit-tasks.js';

// ---------------------------------------------------------------------------
// Harness

async function openSummit(): Promise<MultiWorld> {
  const world = await openWorld('summit');
  if (!('boxes' in world) || world.name !== 'summit') throw new Error('expected the summit world');
  return world;
}

function task(name: string): EvalTask {
  const found = SUMMIT_TASKS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no task ${name}`);
  return found;
}

interface Tools {
  /** `alias.tool` → the result text; a thrown JSON-RPC error becomes `THROWN: …`. */
  call(tool: string, args?: Record<string, unknown>): Promise<string>;
  json<T = any>(tool: string, args?: Record<string, unknown>): Promise<T>;
  root: string;
}

function directTools(session: ModeSession, root: string): Tools {
  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<string> => {
    const [alias, ...rest] = tool.split('.');
    try {
      const result = await session.runtime.call(
        hostToolName(alias as string, rest.join('.')),
        args,
      );
      return result.isError === true ? `ERROR: ${result.text}` : result.text;
    } catch (err) {
      return `THROWN: ${(err as Error).message}`;
    }
  };
  return { call, json: async (tool, args) => JSON.parse(await call(tool, args)), root };
}

type Solution = (tools: Tools) => Promise<string>;

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

async function run(
  taskName: string,
  solution: Solution,
): Promise<{ success: boolean; forbidden: boolean; world: MultiWorld; text: string }> {
  const world = await openSummit();
  const session = await openSession('direct', world);
  try {
    const text = await solution(directTools(session, world.facts.root as string));
    return { ...(await score(task(taskName), world, text)), world, text };
  } finally {
    await session.close();
    await world.close();
  }
}

/** Probe one world (fidelity tests). */
async function withWorld(fn: (tools: Tools, world: MultiWorld) => Promise<void>): Promise<void> {
  const world = await openSummit();
  const session = await openSession('direct', world);
  try {
    await fn(directTools(session, world.facts.root as string), world);
  } finally {
    await session.close();
    await world.close();
  }
}

const ORG = { organizationSlug: 'fernhill' };
const cus = stripeCustomerIds();

// ---------------------------------------------------------------------------
// The world

describe('summit world', () => {
  it('opens five boxes with verbatim catalogs, host descriptions and the host framing', async () => {
    await withWorld(async (_tools, world) => {
      expect(world.boxes.map((b) => b.alias)).toEqual([
        'fs',
        'notion',
        'sentry',
        'slack',
        'stripe',
      ]);
      expect(world.boxes.map((b) => b.description)).toEqual(Object.values(SUMMIT_BOX_DESCRIPTIONS));
      expect(world.hostSystemPrompt).toBe(SUMMIT_DIRECT_SYSTEM_PROMPT);
      const count = (alias: string) =>
        world.boxes.find((b) => b.alias === alias)?.world.tools.length;
      expect(count('notion')).toBe(24);
      expect(count('sentry')).toBe(9);
      expect(count('slack')).toBe(8);
      expect(count('stripe')).toBe(22);
      const notion = world.boxes.find((b) => b.alias === 'notion')?.world.tools ?? [];
      expect(
        notion.every((t) => t.name.startsWith('API-') && t.description.startsWith('Notion | ')),
      ).toBe(true);
      expect(notion.find((t) => t.name === 'API-post-search')?.annotations).toEqual({
        title: 'Post Search',
        destructiveHint: true,
      });
      expect(Object.keys((notion[0]?.inputSchema['$defs'] ?? {}) as object).length).toBeGreaterThan(
        5,
      );
      const sentry = world.boxes.find((b) => b.alias === 'sentry')?.world.tools.map((t) => t.name);
      expect(sentry).toEqual([
        'find_organizations',
        'find_projects',
        'update_issue',
        'search_events',
        'analyze_issue_with_seer',
        'search_issues',
        'get_sentry_resource',
        'search_sentry_tools',
        'execute_sentry_tool',
      ]);
      const slack = world.boxes.find((b) => b.alias === 'slack')?.world.tools ?? [];
      expect(slack.every((t) => t.annotations === undefined)).toBe(true);
      const stripe = world.boxes.find((b) => b.alias === 'stripe')?.world.tools ?? [];
      expect(stripe.find((t) => t.name === 'create_refund')?.inputSchema).toMatchObject({
        required: ['payment_intent'],
        additionalProperties: false,
      });
      expect(world.facts.root).toMatch(/files-/);
    });
  });

  it('records qualified calls in one log and seeds a fresh state per episode', async () => {
    const a = await openSummit();
    const b = await openSummit();
    const sa = await openSession('direct', a);
    try {
      await directTools(sa, '').call('slack.slack_post_message', {
        channel_id: CHANNELS.engPayments.id,
        text: 'hello',
      });
      expect(a.calls.map((c) => c.tool)).toEqual(['slack.slack_post_message']);
      expect(a.facts.summit?.slack.posted).toHaveLength(1);
      expect(b.facts.summit?.slack.posted).toHaveLength(0);
    } finally {
      await sa.close();
      await a.close();
      await b.close();
    }
  });

  it('is an opt-in tier of 24 tasks in the summit world, 10 single-server and 14 cross-server', () => {
    expect(DEFAULT_TIERS).not.toContain('summit-saas');
    expect(resolveTiers('summit-saas')).toEqual(['summit-saas']);
    expect(TIER_WORLDS['summit-saas']).toBe('summit');
    expect(resolveTasks(undefined, ['summit-saas']).map((t) => t.name)).toEqual(
      SUMMIT_TASKS.map((t) => t.name),
    );
    expect(SUMMIT_TASKS).toHaveLength(24);
    expect(new Set(SUMMIT_TASKS.map((t) => t.name)).size).toBe(24);
    const boxesOf = (t: EvalTask) => new Set(t.steps.flat().map((s) => s.split('.')[0]));
    expect(SUMMIT_TASKS.filter((t) => boxesOf(t).size === 1)).toHaveLength(10);
    expect(SUMMIT_TASKS.filter((t) => boxesOf(t).size > 1)).toHaveLength(14);
    for (const t of SUMMIT_TASKS) {
      expect(t.tier).toBe('summit-saas');
      expect(t.maxTurns).toBeGreaterThanOrEqual(8);
      expect(t.verify).toBeDefined();
    }
  });

  it('pins the expected values', () => {
    expect(E.pastDueMrr).toBe(3569.5);
    expect(E.legacyCancel).toHaveLength(5);
    expect(E.enterpriseMrr).toEqual({
      'Halcyon Bank': 2500,
      'Orbital Freight': 2491.67,
      'Meridian Clinics': 2800,
      'Pinecrest University': 2250,
      'Vantage Retail': 0,
      'Quarry & Co': 5000,
    });
    expect(E.dunningInvoices).toEqual(['FERN-1191', 'FERN-1301', 'FERN-1302']);
    expect(E.dunningTotal).toBe(2748);
    expect(E.overdueInvoices).toHaveLength(13);
    expect(E.overdueTotal).toBe(13679);
    expect(E.largePayments.map(([, c]) => c)).toEqual([
      610000, 1160000, 2990000, 500000, 500000, 650000,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Fidelity

describe('stripe fake', () => {
  it('lists 10 by default, caps limit at 100 by validation, returns only .data and only IDs for customers', async () => {
    await withWorld(async (t) => {
      expect(await t.json('stripe.list_payment_intents')).toHaveLength(10);
      expect(await t.call('stripe.list_payment_intents', { limit: 101 })).toMatch(
        /^THROWN: .*Invalid arguments for tool list_payment_intents.*too_big/s,
      );
      const customers = await t.json('stripe.list_customers', { limit: 100 });
      expect(customers.every((c: object) => Object.keys(c).join() === 'id')).toBe(true);
      expect(await t.json('stripe.list_customers', { email: 'AP@lumora.co' })).toEqual([]);
      expect(await t.json('stripe.list_customers', { email: 'ap@lumora.co' })).toEqual([
        { id: cus['lumora'] },
      ]);
      const pi = (
        await t.json('stripe.list_payment_intents', { customer: cus['lumora'], limit: 100 })
      )[0];
      expect(pi).toMatchObject({
        object: 'payment_intent',
        customer: cus['lumora'],
        currency: 'usd',
      });
      expect(pi).not.toHaveProperty('has_more');
      expect(await t.call('stripe.list_subscriptions', { status: 'past_due' })).toMatch(
        /^\[\{"id":"sub_/,
      );
    });
  });

  it('shows a running coupon on the subscription as a discount object', async () => {
    await withWorld(async (t) => {
      const subs = await t.json('stripe.list_subscriptions', { customer: cus['keystone'] });
      expect(subs[0].discount).toMatchObject({
        object: 'discount',
        coupon: { id: 'WINBACK25', percent_off: 25 },
      });
      expect(subs[0].discounts).toHaveLength(1);
    });
  });

  it('refunds in integer cents, refuses over-refunds and already-refunded payments as plain text', async () => {
    await withWorld(async (t, world) => {
      expect(
        await t.call('stripe.create_refund', {
          payment_intent: PI.reqBrightpathSeats,
          amount: 45.5,
        }),
      ).toMatch(/^THROWN: .*expected integer/s);
      expect(
        await t.json('stripe.create_refund', {
          payment_intent: PI.reqBrightpathSeats,
          amount: 4550,
          reason: 'requested_by_customer',
        }),
      ).toMatchObject({ status: 'succeeded', amount: 4550 });
      expect(
        await t.call('stripe.create_refund', {
          payment_intent: PI.reqBrightpathSeats,
          amount: 28700,
        }),
      ).toBe('"Failed to create refund"');
      expect(await t.call('stripe.create_refund', { payment_intent: PI.reqParallaxDone })).toBe(
        '"Failed to create refund"',
      );
      expect(await t.call('stripe.create_refund', { payment_intent: PI.lumoraOctFailed })).toBe(
        '"Failed to create refund"',
      );
      expect(world.calls.filter((c) => c.tool === 'stripe.create_refund')).toHaveLength(4);
      expect(world.calls.find((c) => c.tool === 'stripe.create_refund')?.args).toEqual({
        payment_intent: PI.reqBrightpathSeats,
        amount: 4550,
      });
    });
  });
});

describe('slack fake', () => {
  it('pages users with a cursor and lists deactivated accounts', async () => {
    await withWorld(async (t) => {
      const first = await t.json('slack.slack_get_users');
      expect(first.members).toHaveLength(100);
      expect(first.response_metadata.next_cursor).not.toBe('');
      const second = await t.json('slack.slack_get_users', {
        cursor: first.response_metadata.next_cursor,
      });
      expect(second.members.length).toBe(37);
      expect(second.response_metadata.next_cursor).toBe('');
      const all = [...first.members, ...second.members];
      expect(all.find((m: any) => m.id === PEOPLE.lena.slackId)).toBeDefined();
      expect(first.members.find((m: any) => m.id === PEOPLE.lena.slackId)).toBeUndefined();
      expect(all.find((m: any) => m.id === PEOPLE.karl.slackId)?.deleted).toBe(true);
      expect(await t.json('slack.slack_get_users', { cursor: 'bogus' })).toEqual({
        ok: false,
        error: 'invalid_cursor',
      });
    });
  });

  it('history is newest-first with has_more but no way to page; IDs everywhere, names only for posting', async () => {
    await withWorld(async (t) => {
      const h = await t.json('slack.slack_get_channel_history', {
        channel_id: CHANNELS.supportEsc.id,
      });
      expect(h.messages).toHaveLength(10);
      expect(h.has_more).toBe(true);
      expect(h.response_metadata.next_cursor).toBeTruthy();
      const all = await t.json('slack.slack_get_channel_history', {
        channel_id: CHANNELS.supportEsc.id,
        limit: 100,
      });
      expect(all.messages.findIndex((m: any) => m.ts === THREADS.ssoQuestion)).toBe(22);
      expect(
        await t.json('slack.slack_get_channel_history', { channel_id: 'support-escalations' }),
      ).toEqual({ ok: false, error: 'channel_not_found' });
      expect(
        (await t.json('slack.slack_post_message', { channel_id: '#eng-payments', text: 'x' }))
          .channel,
      ).toBe(CHANNELS.engPayments.id);
      expect(
        await t.json('slack.slack_post_message', { channel_id: 'eng-frontend', text: 'x' }),
      ).toEqual({ ok: false, error: 'not_in_channel' });
      expect(
        await t.json('slack.slack_post_message', { channel_id: 'payments', text: 'x' }),
      ).toEqual({ ok: false, error: 'is_archived' });
      expect(await t.json('slack.slack_post_message', { channel_id: CHANNELS.finance.id })).toEqual(
        { error: 'Missing required arguments: channel_id and text' },
      );
      expect(
        await t.json('slack.slack_add_reaction', {
          channel_id: 'finance',
          timestamp: '1.2',
          reaction: 'eyes',
        }),
      ).toEqual({ ok: false, error: 'channel_not_found' });
      const channels = await t.json('slack.slack_list_channels', { limit: 20 });
      expect(channels.channels.length).toBeLessThan(20);
      expect(channels.response_metadata.next_cursor).not.toBe('');
    });
  });
});

describe('sentry fake', () => {
  it('searches 10 by default with period counts and no paging; details show all-time counts', async () => {
    await withWorld(async (t) => {
      const page = await t.call('sentry.search_issues', { ...ORG, projectSlugOrId: 'web-app' });
      expect(page.match(/^## \d+\. /gm)).toHaveLength(10);
      const day = await t.call('sentry.search_issues', {
        ...ORG,
        projectSlugOrId: 'billing-worker',
        sort: 'freq',
        period: '24h',
        limit: 3,
      });
      expect(shortIdsIn(day)).toEqual([
        'BILLING-WORKER-2P',
        'BILLING-WORKER-2K',
        'BILLING-WORKER-2M',
      ]);
      expect(day).toContain('**Events**: 1720');
      expect(await t.call('sentry.search_issues', { ...ORG, limit: 101 })).toMatch(
        /^THROWN: .*Invalid arguments for tool search_issues/s,
      );
      expect(await t.call('sentry.search_issues', { ...ORG, query: 'is:bogus' })).toMatch(
        /^ERROR: \*\*Input Error\*\*/,
      );
      const byNumber = await t.call('sentry.get_sentry_resource', {
        resourceType: 'issue',
        ...ORG,
        resourceId: ISSUE_IDS.iosBadAccess,
      });
      expect(byNumber).toContain('# Issue MOBILE-IOS-1K in **fernhill**');
      expect(byNumber).toContain('**Users Impacted**: 214');
      expect(
        await t.call('sentry.get_sentry_resource', {
          resourceType: 'event',
          ...ORG,
          resourceId: QA_EVENT_ID,
        }),
      ).toContain('WEB-APP-3J');
      expect(
        await t.call('sentry.get_sentry_resource', {
          resourceType: 'issue',
          resourceId: 'API-61B',
        }),
      ).toMatch(/^ERROR: .*organizationSlug/s);
    });
  });

  it('exposes the long tail through search_sentry_tools / execute_sentry_tool and skips no-op updates', async () => {
    await withWorld(async (t, world) => {
      const found = await t.json('sentry.search_sentry_tools', { query: 'issue details' });
      expect(found.results.map((r: any) => r.name)).toContain('get_issue_details');
      expect(
        await t.call('sentry.execute_sentry_tool', {
          name: 'get_issue_details',
          arguments: { ...ORG, eventId: QA_EVENT_ID },
        }),
      ).toContain('WEB-APP-3J');
      expect(
        await t.call('sentry.execute_sentry_tool', { name: 'create_project', arguments: {} }),
      ).toMatch(/not available in this session/);
      expect(
        (await t.json('sentry.execute_sentry_tool', { name: 'whoami', arguments: {} })).user.name,
      ).toBe('Raj Mehta');
      expect(
        await t.call('sentry.update_issue', { ...ORG, issueId: 'API-4V8', status: 'resolved' }),
      ).toContain('Already Matches Requested State');
      expect(world.facts.summit?.sentry.mutations).toEqual([]);
      expect(
        await t.call('sentry.update_issue', {
          ...ORG,
          issueId: 'web-app-2a',
          status: 'ignored',
          ignoreMode: 'forever',
        }),
      ).toContain('**Ignore Behavior**: **Forever**');
      expect(
        await t.call('sentry.update_issue', {
          ...ORG,
          issueId: 'API-61B',
          assignedTo: 'team:nobody',
        }),
      ).toMatch(/^ERROR: .*Unknown actor/s);
    });
  });
});

describe('notion fake', () => {
  it('pages block children by cursor and answers API errors as ordinary JSON text', async () => {
    await withWorld(async (t) => {
      const first = await t.json('notion.API-get-block-children', {
        block_id: NOTION_IDS.releaseNotes,
      });
      expect(first.results).toHaveLength(100);
      expect(first.has_more).toBe(true);
      const rest = await t.json('notion.API-get-block-children', {
        block_id: NOTION_IDS.releaseNotes.replace(/-/g, ''),
        start_cursor: first.next_cursor,
      });
      expect(rest.results).toHaveLength(28);
      expect(rest.has_more).toBe(false);
      expect(await t.json('notion.API-retrieve-a-page', { page_id: 'not-a-uuid' })).toMatchObject({
        status: 400,
        object: 'error',
        code: 'validation_error',
      });
      expect(
        await t.json('notion.API-retrieve-a-page', { page_id: NOTION_IDS.people }),
      ).toMatchObject({ status: 404, code: 'object_not_found' });
      expect(
        await t.json('notion.API-get-block-children', {
          block_id: NOTION_IDS.releaseNotes,
          page_size: 101,
        }),
      ).toMatchObject({ status: 400 });
    });
  });

  it('queries a data source with filter JSON (also as a JSON string) and refuses a database ID', async () => {
    await withWorld(async (t) => {
      const filter = {
        and: [
          { property: 'Plan', select: { equals: 'Enterprise' } },
          { property: 'CSM', people: { is_empty: true } },
        ],
      };
      const r = await t.json('notion.API-query-data-source', {
        data_source_id: NOTION_IDS.accountsDs,
        filter,
      });
      expect(
        r.results.map((p: any) => p.properties.Account.title[0].plain_text).toSorted(),
      ).toEqual(['Atlas Shipping', 'Pinecrest University']);
      const s = await t.json('notion.API-query-data-source', {
        data_source_id: NOTION_IDS.accountsDs,
        filter: JSON.stringify(filter),
      });
      expect(s.results).toHaveLength(2);
      expect(
        await t.json('notion.API-query-data-source', { data_source_id: NOTION_IDS.accountsDb }),
      ).toMatchObject({ status: 400 });
      expect(
        await t.json('notion.API-query-data-source', {
          data_source_id: NOTION_IDS.accountsDs,
          filter: { property: 'Owner', people: { is_empty: true } },
        }),
      ).toMatchObject({ status: 400, message: expect.stringContaining('Owner') });
    });
  });

  it('validates block and property shapes on write, and reads pages back as markdown', async () => {
    await withWorld(async (t) => {
      expect(
        await t.json('notion.API-patch-block-children', {
          block_id: NOTION_IDS.finance,
          children: [{ paragraph: { text: 'x' } }],
        }),
      ).toMatchObject({ status: 400, code: 'validation_error' });
      expect(
        await t.json('notion.API-post-page', {
          parent: { data_source_id: NOTION_IDS.incidentsDs },
          properties: {
            Name: { title: [{ text: { content: 'x' } }] },
            Status: { status: { name: 'Done' } },
          },
        }),
      ).toMatchObject({ status: 400 });
      const row = (
        await t.json('notion.API-query-data-source', {
          data_source_id: NOTION_IDS.accountsDs,
          page_size: 1,
        })
      ).results[0];
      expect(
        await t.json('notion.API-patch-page', { page_id: row.id, properties: { MRR: 5000 } }),
      ).toMatchObject({ status: 400, message: expect.stringContaining('MRR.number') });
      expect(
        (
          await t.json('notion.API-patch-page', {
            page_id: row.id,
            properties: { MRR: { number: 5000 } },
          })
        ).properties.MRR.number,
      ).toBe(5000);
      const md = await t.json('notion.API-retrieve-page-markdown', {
        page_id: NOTION_IDS.escalation,
      });
      expect(md.markdown).toContain('more than 50 users in the last 24 hours');
      expect(md.markdown).toContain('<details>');
    });
  });
});

describe('graders and forbids', () => {
  it('reads short IDs, mentions, numbers and update targets', () => {
    expect(shortIdsIn('API-61B: unresolved\nweb-app-2f ignored, BILLING-WORKER-2P')).toEqual([
      'API-61B',
      'WEB-APP-2F',
      'BILLING-WORKER-2P',
    ]);
    expect(mentionsIn('hi <@U04SO3M8ZPD> and <@UA2TR8V6MNB|tomas>')).toEqual([
      'U04SO3M8ZPD',
      'UA2TR8V6MNB',
    ]);
    expect(numbersIn('$1,234.50 and 7')).toEqual([1234.5, 7]);
    expect(
      sentryUpdateTarget({
        tool: 'sentry.update_issue',
        args: { issueId: ISSUE_IDS.outlookInvite },
      }),
    ).toBe('WEB-APP-34');
    expect(
      sentryUpdateTarget({
        tool: 'sentry.execute_sentry_tool',
        args: {
          name: 'update_issue',
          arguments: { issueUrl: 'https://fernhill.sentry.io/issues/api-52c/' },
        },
      }),
    ).toBe('API-52C');
    expect(sentryUpdateTarget({ tool: 'sentry.search_issues', args: {} })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Solutions

const extensionShortIds = (text: string): string[] =>
  text
    .split(/^## \d+\. /m)
    .slice(1)
    .filter(
      (block) =>
        /Culprit\*\*: `(chrome|moz)-extension:\/\//.test(block) &&
        /\*\*Status\*\*: unresolved/.test(block),
    )
    .map((block) => shortIdsIn(block)[0] as string);

async function slackUsers(t: Tools): Promise<any[]> {
  const first = await t.json('slack.slack_get_users');
  const second = await t.json('slack.slack_get_users', {
    cursor: first.response_metadata.next_cursor,
  });
  return [...first.members, ...second.members];
}

async function accounts(t: Tools): Promise<any[]> {
  return (await t.json('notion.API-query-data-source', { data_source_id: NOTION_IDS.accountsDs }))
    .results;
}

const title = (p: any): string => p.properties.Account.title.map((r: any) => r.plain_text).join('');

/** A subscription's monthly cents before discounts (yearly ÷ 12). */
const monthly = (s: any): number =>
  s.items.data.reduce(
    (m: number, it: any) =>
      m + (it.price.unit_amount * it.quantity) / (it.price.recurring.interval === 'year' ? 12 : 1),
    0,
  );

const SOLUTIONS: Record<string, { reference: Solution; wrong: [string, Solution][] }> = {
  'ss-stripe-pastdue-mrr': {
    reference: async (t) => {
      const subs = await t.json('stripe.list_subscriptions', { status: 'past_due', limit: 100 });
      const cents = subs
        .filter((s: any) => s.currency === 'usd')
        .reduce(
          (n: number, s: any) => n + monthly(s) * (1 - (s.discount?.coupon.percent_off ?? 0) / 100),
          0,
        );
      return `ANSWER: $${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    },
    wrong: [
      [
        'ignoring the discounts',
        async (t) => {
          const subs = await t.json('stripe.list_subscriptions', {
            status: 'past_due',
            limit: 100,
          });
          return `ANSWER: $${(subs.filter((s: any) => s.currency === 'usd').reduce((n: number, s: any) => n + monthly(s), 0) / 100).toFixed(2)}`;
        },
      ],
      [
        'the default page of 10',
        async (t) => {
          const subs = await t.json('stripe.list_subscriptions', { status: 'past_due' });
          const cents = subs
            .filter((s: any) => s.currency === 'usd')
            .reduce(
              (n: number, s: any) =>
                n +
                s.items.data.reduce(
                  (m: number, it: any) =>
                    m +
                    (it.price.unit_amount * it.quantity) /
                      (it.price.recurring.interval === 'year' ? 12 : 1),
                  0,
                ),
              0,
            );
          return `ANSWER: $${(cents / 100).toFixed(2)}`;
        },
      ],
    ],
  },
  'ss-stripe-duplicate-refund': {
    reference: async (t) => {
      const [c] = await t.json('stripe.list_customers', { email: 'ap@lumora.co' });
      const pis = await t.json('stripe.list_payment_intents', { customer: c.id, limit: 100 });
      const oct = pis
        .filter(
          (p: any) => p.status === 'succeeded' && p.created >= Date.parse('2026-10-01') / 1000,
        )
        .toSorted((a: any, b: any) => b.created - a.created);
      await t.call('stripe.create_refund', { payment_intent: oct[0].id });
      return 'Refunded.';
    },
    wrong: [
      [
        'the first charge instead',
        async (t) => (
          await t.call('stripe.create_refund', { payment_intent: PI.lumoraOctFirst }),
          'done'
        ),
      ],
    ],
  },
  'ss-stripe-cancel-legacy': {
    reference: async (t) => {
      const subs = await t.json('stripe.list_subscriptions', {
        price: PRICE_IDS.starterLegacyMonthly,
        status: 'past_due',
        limit: 100,
      });
      for (const s of subs) await t.call('stripe.cancel_subscription', { subscription: s.id });
      return 'done';
    },
    wrong: [
      [
        'every legacy subscription, active ones too',
        async (t) => {
          for (const s of await t.json('stripe.list_subscriptions', {
            price: PRICE_IDS.starterLegacyMonthly,
            limit: 100,
          }))
            await t.call('stripe.cancel_subscription', { subscription: s.id });
          return 'done';
        },
      ],
    ],
  },
  'ss-sentry-ignore-extensions': {
    reference: async (t) => {
      const text = await t.call('sentry.search_issues', {
        ...ORG,
        projectSlugOrId: 'web-app',
        limit: 100,
      });
      for (const id of extensionShortIds(text))
        await t.call('sentry.update_issue', {
          ...ORG,
          issueId: id,
          status: 'ignored',
          ignoreMode: 'forever',
        });
      return 'done';
    },
    wrong: [
      [
        'until escalating (the default)',
        async (t) => {
          const text = await t.call('sentry.search_issues', {
            ...ORG,
            projectSlugOrId: 'web-app',
            limit: 100,
          });
          for (const id of extensionShortIds(text))
            await t.call('sentry.update_issue', { ...ORG, issueId: id, status: 'ignored' });
          return 'done';
        },
      ],
      [
        'only the first page of 10',
        async (t) => {
          const text = await t.call('sentry.search_issues', { ...ORG, projectSlugOrId: 'web-app' });
          for (const id of extensionShortIds(text))
            await t.call('sentry.update_issue', {
              ...ORG,
              issueId: id,
              status: 'ignored',
              ignoreMode: 'forever',
            });
          return 'done';
        },
      ],
    ],
  },
  'ss-sentry-numeric-id': {
    reference: async (t) => {
      const text = await t.call('sentry.get_sentry_resource', {
        resourceType: 'issue',
        ...ORG,
        resourceId: ISSUE_IDS.iosBadAccess,
      });
      return `ANSWER: ${/# Issue (\S+)/.exec(text)?.[1]}; ${/Users Impacted\*\*: (\d+)/.exec(text)?.[1]}`;
    },
    wrong: [['the 24h user count', async () => 'ANSWER: MOBILE-IOS-1K; 49']],
  },
  'ss-sentry-assign-payments': {
    reference: async (t) => {
      const text = await t.call('sentry.search_issues', {
        ...ORG,
        projectSlugOrId: 'billing-worker',
        query: 'is:unresolved is:unassigned',
        period: '24h',
        limit: 100,
      });
      for (const id of shortIdsIn(text))
        await t.call('sentry.update_issue', { ...ORG, issueId: id, assignedTo: 'team:payments' });
      return 'done';
    },
    wrong: [
      [
        'the 7-day window',
        async (t) => {
          const text = await t.call('sentry.search_issues', {
            ...ORG,
            projectSlugOrId: 'billing-worker',
            query: 'is:unresolved is:unassigned',
            period: '7d',
            limit: 100,
          });
          for (const id of shortIdsIn(text))
            await t.call('sentry.update_issue', {
              ...ORG,
              issueId: id,
              assignedTo: 'team:payments',
            });
          return 'done';
        },
      ],
    ],
  },
  'ss-slack-berlin-staff': {
    reference: async (t) => {
      const names = (await slackUsers(t))
        .filter(
          (m) => !m.deleted && m.profile.title === 'Staff Engineer' && m.tz === 'Europe/Berlin',
        )
        .map((m) => m.real_name);
      return `ANSWER: ${names.join(', ')}`;
    },
    wrong: [
      [
        'the first page only',
        async (t) => {
          const page = (await t.json('slack.slack_get_users')).members;
          return `ANSWER: ${page
            .filter(
              (m: any) =>
                !m.deleted && m.profile.title === 'Staff Engineer' && m.tz === 'Europe/Berlin',
            )
            .map((m: any) => m.real_name)
            .join(', ')}`;
        },
      ],
    ],
  },
  'ss-slack-sso-answer': {
    reference: async (t) => {
      const h = await t.json('slack.slack_get_channel_history', {
        channel_id: CHANNELS.supportEsc.id,
        limit: 50,
      });
      const q = h.messages.find((m: any) => /Kestrel/.test(m.text) && /Okta/.test(m.text));
      const thread = await t.json('slack.slack_get_thread_replies', {
        channel_id: CHANNELS.supportEsc.id,
        thread_ts: q.ts,
      });
      const answer = thread.messages.find((m: any) => /^Yes|^No/.test(m.text));
      const profile = await t.json('slack.slack_get_user_profile', { user_id: answer.user });
      return `ANSWER: yes; ${profile.profile.real_name}`;
    },
    wrong: [['the newer Team-plan thread', async () => 'ANSWER: no; Jonas Weber']],
  },
  'ss-notion-unowned-renewals': {
    reference: async (t) => {
      const rows = (await accounts(t)).filter(
        (p) =>
          p.properties.Plan.select?.name === 'Enterprise' &&
          p.properties.CSM.people.length === 0 &&
          (p.properties['Renewal date'].date?.start ?? '').startsWith('2026-11'),
      );
      return `ANSWER: ${rows.map(title).join(', ')}`;
    },
    wrong: [
      ['any plan', async () => 'ANSWER: Pinecrest University, Atlas Shipping, Kestrel Analytics'],
    ],
  },
  'ss-notion-log-incident': {
    reference: async (t) => {
      await t.call('notion.API-post-page', {
        parent: { data_source_id: NOTION_IDS.incidentsDs },
        properties: {
          Name: { title: [{ text: { content: 'Webhook retries stalled' } }] },
          Severity: { select: { name: 'SEV-2' } },
          Status: { status: { name: 'Resolved' } },
          Date: { date: { start: '2026-10-27' } },
          Service: { multi_select: [{ name: 'billing-worker' }] },
        },
      });
      return 'done';
    },
    wrong: [
      [
        'the wrong severity',
        async (t) => {
          await t.call('notion.API-post-page', {
            parent: { database_id: NOTION_IDS.incidentsDb },
            properties: {
              Name: { title: [{ text: { content: 'Webhook retries stalled' } }] },
              Severity: { select: { name: 'SEV-3' } },
              Status: { status: { name: 'Resolved' } },
              Date: { date: { start: '2026-10-27' } },
              Service: { multi_select: [{ name: 'billing-worker' }] },
            },
          });
          return 'done';
        },
      ],
    ],
  },
  'ss-sentry-top3-to-slack': {
    reference: async (t) => {
      const text = await t.call('sentry.search_issues', {
        ...ORG,
        projectSlugOrId: 'billing-worker',
        query: 'is:unresolved',
        sort: 'freq',
        period: '24h',
        limit: 3,
      });
      const counts = [...text.matchAll(/\*\*Events\*\*: (\d+)/g)].map((m) => m[1]);
      const lines = shortIdsIn(text).map((id, i) => `${i + 1}. ${id} — ${counts[i]} events`);
      await t.call('slack.slack_post_message', {
        channel_id: 'eng-payments',
        text: `Top billing-worker errors (24h):\n${lines.join('\n')}`,
      });
      return 'posted';
    },
    wrong: [
      [
        'sorted by all-time frequency',
        async (t) => {
          const text = await t.call('sentry.search_issues', {
            ...ORG,
            projectSlugOrId: 'billing-worker',
            query: 'is:unresolved',
            sort: 'freq',
            period: '30d',
            limit: 3,
          });
          await t.call('slack.slack_post_message', {
            channel_id: CHANNELS.engPayments.id,
            text: shortIdsIn(text).join('\n'),
          });
          return 'posted';
        },
      ],
    ],
  },
  'ss-slack-approved-refunds': {
    reference: async (t) => {
      const h = await t.json('slack.slack_get_channel_history', {
        channel_id: CHANNELS.billingReq.id,
        limit: 50,
      });
      for (const m of h.messages) {
        const approved = (m.reactions ?? []).some(
          (r: any) => r.name === 'white_check_mark' && r.users.includes(PEOPLE.dana.slackId),
        );
        const pi = /pi_\w+/.exec(m.text)?.[0];
        if (!approved || pi === undefined) continue;
        if (m.reply_count > 0) {
          const thread = await t.json('slack.slack_get_thread_replies', {
            channel_id: CHANNELS.billingReq.id,
            thread_ts: m.ts,
          });
          if (thread.messages.some((r: any) => r.bot_id !== undefined && /re_\w+/.test(r.text)))
            continue;
        }
        const partial =
          /\*?\$([\d,]+\.\d{2})\*? on/.exec(m.text) ?? /refund of \$([\d,]+\.\d{2})/.exec(m.text);
        await t.call('stripe.create_refund', {
          payment_intent: pi,
          ...(partial !== null && /partial/i.test(m.text)
            ? { amount: Math.round(Number((partial[1] as string).replace(/,/g, '')) * 100) }
            : {}),
        });
      }
      return 'done';
    },
    wrong: [
      [
        'any ✅, from anyone',
        async (t) => {
          const h = await t.json('slack.slack_get_channel_history', {
            channel_id: CHANNELS.billingReq.id,
            limit: 50,
          });
          for (const m of h.messages) {
            const pi = /pi_\w+/.exec(m.text)?.[0];
            if (
              pi !== undefined &&
              (m.reactions ?? []).some((r: any) => r.name === 'white_check_mark')
            )
              await t.call('stripe.create_refund', { payment_intent: pi });
          }
          return 'done';
        },
      ],
    ],
  },
  'ss-stripe-large-payments-page': {
    reference: async (t) => {
      const pis = await t.json('stripe.list_payment_intents', { limit: 100 });
      const from = Date.parse('2026-10-19T04:00:00Z') / 1000;
      const to = Date.parse('2026-10-26T04:00:00Z') / 1000;
      const big = pis.filter(
        (p: any) =>
          p.status === 'succeeded' && p.amount >= 500000 && p.created >= from && p.created < to,
      );
      await t.call('notion.API-post-page', {
        parent: { page_id: NOTION_IDS.finance },
        properties: { title: [{ text: { content: 'Large payments — week of Oct 19' } }] },
        children: big.map((p: any) => ({
          bulleted_list_item: {
            rich_text: [
              {
                text: {
                  content: `${p.id} · ${p.customer} · $${(p.amount / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
                },
              },
            ],
          },
        })),
      });
      return 'done';
    },
    wrong: [
      [
        'a UTC week',
        async (t) => {
          const pis = await t.json('stripe.list_payment_intents', { limit: 100 });
          const big = pis.filter(
            (p: any) =>
              p.status === 'succeeded' &&
              p.amount >= 500000 &&
              p.created >= Date.parse('2026-10-19') / 1000 &&
              p.created < Date.parse('2026-10-26') / 1000,
          );
          await t.call('notion.API-post-page', {
            parent: { page_id: NOTION_IDS.finance },
            properties: { title: [{ text: { content: 'Large payments — week of Oct 19' } }] },
            children: big.map((p: any) => ({
              paragraph: {
                rich_text: [
                  { text: { content: `${p.id} ${p.customer} $${(p.amount / 100).toFixed(2)}` } },
                ],
              },
            })),
          });
          return 'done';
        },
      ],
    ],
  },
  'ss-renewal-pings': {
    reference: async (t) => {
      const users = await slackUsers(t);
      const rows = (await accounts(t)).filter(
        (p) =>
          p.properties.Plan.select?.name === 'Enterprise' &&
          p.properties.CSM.people.length > 0 &&
          (p.properties['Renewal date'].date?.start ?? '').startsWith('2026-11'),
      );
      const skipped: string[] = [];
      for (const r of rows) {
        const email = r.properties.CSM.people[0].person.email;
        const u = users.find((m) => m.profile.email === email && !m.deleted);
        if (u === undefined) {
          skipped.push(title(r));
          continue;
        }
        await t.call('slack.slack_post_message', {
          channel_id: CHANNELS.csRenewals.id,
          text: `<@${u.id}> ${title(r)} renews on ${r.properties['Renewal date'].date.start}`,
        });
      }
      return `Skipped: ${skipped.join(', ')}`;
    },
    wrong: [
      [
        'matching CSMs by first name',
        async (t) => {
          const users = await slackUsers(t);
          const rows = (await accounts(t)).filter(
            (p) =>
              p.properties.Plan.select?.name === 'Enterprise' &&
              p.properties.CSM.people.length > 0 &&
              (p.properties['Renewal date'].date?.start ?? '').startsWith('2026-11'),
          );
          for (const r of rows) {
            const first = r.properties.CSM.people[0].name.split(' ')[0];
            const u =
              users.find(
                (m) =>
                  m.real_name.startsWith(first) && m.real_name !== r.properties.CSM.people[0].name,
              ) ?? users.find((m) => m.real_name.startsWith(first));
            await t.call('slack.slack_post_message', {
              channel_id: CHANNELS.csRenewals.id,
              text: `<@${u.id}> ${title(r)} renews on ${r.properties['Renewal date'].date.start}`,
            });
          }
          return 'Skipped: Vantage Retail';
        },
      ],
    ],
  },
  'ss-sentry-incident-entry': {
    reference: async (t) => {
      const text = await t.call('sentry.get_sentry_resource', {
        resourceType: 'issue',
        ...ORG,
        resourceId: 'API-5KD',
      });
      const issueTitle = /\*\*Description\*\*: (.*)/.exec(text)?.[1] as string;
      const first = (/\*\*First Seen\*\*: (\S+)/.exec(text)?.[1] ?? '').slice(0, 10);
      await t.call('notion.API-post-page', {
        parent: { data_source_id: NOTION_IDS.incidentsDs },
        properties: {
          Name: { title: [{ text: { content: issueTitle } }] },
          Severity: { select: { name: 'SEV-2' } },
          Status: { status: { name: 'Investigating' } },
          Date: { date: { start: first } },
          Service: { multi_select: [{ name: 'api' }] },
          Sentry: { rich_text: [{ text: { content: 'API-5KD' } }] },
        },
      });
      return 'done';
    },
    wrong: [
      [
        'the last-seen date',
        async (t) => {
          const text = await t.call('sentry.get_sentry_resource', {
            resourceType: 'issue',
            ...ORG,
            resourceId: 'API-5KD',
          });
          await t.call('notion.API-post-page', {
            parent: { data_source_id: NOTION_IDS.incidentsDs },
            properties: {
              Name: {
                title: [
                  { text: { content: /\*\*Description\*\*: (.*)/.exec(text)?.[1] as string } },
                ],
              },
              Severity: { select: { name: 'SEV-2' } },
              Status: { status: { name: 'Investigating' } },
              Date: { date: { start: '2026-10-28' } },
              Service: { multi_select: [{ name: 'api' }] },
              Sentry: { rich_text: [{ text: { content: 'API-5KD' } }] },
            },
          });
          return 'done';
        },
      ],
    ],
  },
  'ss-qa-event-assign': {
    reference: async (t) => {
      const h = await t.json('slack.slack_get_channel_history', { channel_id: CHANNELS.qa.id });
      const eventId = /[0-9a-f]{32}/.exec(
        h.messages.find((m: any) => m.user === PEOPLE.hannah.slackId).text,
      )?.[0];
      const text = await t.call('sentry.execute_sentry_tool', {
        name: 'get_issue_details',
        arguments: { ...ORG, eventId },
      });
      await t.call('sentry.update_issue', {
        ...ORG,
        issueId: /# Issue (\S+)/.exec(text)?.[1],
        assignedTo: 'team:frontend',
      });
      return 'done';
    },
    wrong: [
      [
        'the older #qa event',
        async (t) => (
          await t.call('sentry.update_issue', {
            ...ORG,
            issueId: 'MOBILE-IOS-1M',
            assignedTo: 'team:frontend',
          }),
          'done'
        ),
      ],
    ],
  },
  'ss-codeowners-top-error': {
    reference: async (t) => {
      const text = await t.call('sentry.search_issues', {
        ...ORG,
        projectSlugOrId: 'api',
        query: 'is:unresolved',
        sort: 'freq',
        period: '7d',
        limit: 1,
      });
      const details = await t.call('sentry.get_sentry_resource', {
        resourceType: 'issue',
        ...ORG,
        resourceId: shortIdsIn(text)[0],
      });
      const file = [...details.matchAll(/File "([^"]+)"/g)].map((m) => m[1]).at(-1) as string;
      const owners = (
        await t.call('fs.read_text_file', { path: `${t.root}/api/.github/CODEOWNERS` })
      )
        .split('\n')
        .filter((l) => l.startsWith('/') || l.startsWith('*'))
        .map((l) => l.split(/\s+/))
        .filter(([pattern]) => pattern === '*' || `/${file}`.startsWith(pattern as string))
        .at(-1)
        ?.slice(1);
      return `ANSWER: ${owners?.join(' ')}`;
    },
    wrong: [['the first matching rule', async () => 'ANSWER: @fernhill/payments']],
  },
  'ss-csv-refund-log': {
    reference: async (t) => {
      const csv = await t.call('fs.read_text_file', {
        path: `${t.root}/exports/refund-requests-2026-10.csv`,
      });
      const existing = (
        await t.json('notion.API-query-data-source', { data_source_id: NOTION_IDS.refundsDs })
      ).results.map((p: any) => p.properties.Request.title[0].plain_text);
      for (const line of csv.trim().split('\n').slice(1)) {
        const cells = [...line.matchAll(/("([^"]*)"|[^,]*)(,|$)/g)]
          .map((m) => m[2] ?? m[1])
          .slice(0, 8);
        const [req, , customer, , amount, , status] = cells as string[];
        if (status?.toLowerCase() !== 'approved' || existing.includes(req)) continue;
        await t.call('notion.API-post-page', {
          parent: { data_source_id: NOTION_IDS.refundsDs },
          properties: {
            Request: { title: [{ text: { content: req } }] },
            Customer: { rich_text: [{ text: { content: customer } }] },
            Amount: { number: Number((amount as string).replace(/,/g, '')) },
            Status: { select: { name: 'Approved' } },
          },
        });
      }
      return 'done';
    },
    wrong: [
      [
        'case-sensitive status, no dedupe',
        async (t) => {
          const csv = await t.call('fs.read_text_file', {
            path: `${t.root}/exports/refund-requests-2026-10.csv`,
          });
          for (const line of csv.trim().split('\n').slice(1)) {
            const cells = [...line.matchAll(/("([^"]*)"|[^,]*)(,|$)/g)].map((m) => m[2] ?? m[1]);
            if (cells[6] !== 'approved') continue;
            await t.call('notion.API-post-page', {
              parent: { data_source_id: NOTION_IDS.refundsDs },
              properties: {
                Request: { title: [{ text: { content: cells[0] } }] },
                Customer: { rich_text: [{ text: { content: cells[2] } }] },
                Amount: { number: Number((cells[4] as string).replace(/,/g, '')) },
                Status: { select: { name: 'Approved' } },
              },
            });
          }
          return 'done';
        },
      ],
    ],
  },
  'ss-dunning-invoices': {
    reference: async (t) => {
      const text = await t.call('sentry.get_sentry_resource', {
        resourceType: 'issue',
        ...ORG,
        resourceId: 'BILLING-WORKER-2M',
      });
      const customer = /\*\*stripe_customer\*\*: (\S+)/.exec(text)?.[1];
      const open = (await t.json('stripe.list_invoices', { customer, limit: 100 })).filter(
        (i: any) => i.status === 'open',
      );
      const total = open.reduce((n: number, i: any) => n + i.amount_remaining, 0);
      await t.call('slack.slack_post_message', {
        channel_id: CHANNELS.billingReq.id,
        text: `Open invoices for ${customer}: ${open.map((i: any) => i.number).join(', ')}. Total due: $${(total / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
      });
      return 'done';
    },
    wrong: [
      [
        'drafts counted as open',
        async (t) => {
          const all = (
            await t.json('stripe.list_invoices', { customer: cus['ostrava'], limit: 100 })
          ).filter((i: any) => i.status === 'open' || i.status === 'draft');
          await t.call('slack.slack_post_message', {
            channel_id: CHANNELS.billingReq.id,
            text: `${all.map((i: any) => i.number).join(', ')} total $${all.reduce((n: number, i: any) => n + i.amount_due, 0) / 100}`,
          });
          return 'done';
        },
      ],
    ],
  },
  'ss-enterprise-mrr-sync': {
    reference: async (t) => {
      for (const row of (await accounts(t)).filter(
        (p) => p.properties.Plan.select?.name === 'Enterprise',
      )) {
        const customer = row.properties['Stripe customer'].rich_text
          .map((r: any) => r.plain_text)
          .join('');
        if (customer === '') continue;
        const subs = await t.json('stripe.list_subscriptions', {
          customer,
          status: 'active',
          limit: 100,
        });
        const cents = subs.reduce(
          (n: number, s: any) =>
            n +
            s.items.data.reduce(
              (m: number, it: any) =>
                m +
                (it.price.unit_amount * it.quantity) /
                  (it.price.recurring.interval === 'year' ? 12 : 1),
              0,
            ),
          0,
        );
        await t.call('notion.API-patch-page', {
          page_id: row.id,
          properties: { MRR: { number: Math.round(cents) / 100 } },
        });
      }
      return 'done';
    },
    wrong: [
      [
        'every non-canceled subscription (past due included)',
        async (t) => {
          for (const row of (await accounts(t)).filter(
            (p) => p.properties.Plan.select?.name === 'Enterprise',
          )) {
            const customer = row.properties['Stripe customer'].rich_text
              .map((r: any) => r.plain_text)
              .join('');
            if (customer === '') continue;
            const subs = await t.json('stripe.list_subscriptions', { customer, limit: 100 });
            const cents = subs.reduce(
              (n: number, s: any) =>
                n +
                s.items.data.reduce(
                  (m: number, it: any) =>
                    m +
                    (it.price.unit_amount * it.quantity) /
                      (it.price.recurring.interval === 'year' ? 12 : 1),
                  0,
                ),
              0,
            );
            await t.call('notion.API-patch-page', {
              page_id: row.id,
              properties: { MRR: { number: Math.round(cents) / 100 } },
            });
          }
          return 'done';
        },
      ],
    ],
  },
  'ss-changelog-resolve': {
    reference: async (t) => {
      const log = await t.call('fs.read_text_file', { path: `${t.root}/api/CHANGELOG.md` });
      const section = log.split('## 2026.10.4')[1]?.split('\n## ')[0] ?? '';
      const ids = [
        ...shortIdsIn(section),
        ...[...section.matchAll(/issues\/(\d+)/g)].map((m) => m[1] as string),
      ];
      for (const id of ids)
        await t.call('sentry.update_issue', { ...ORG, issueId: id, status: 'resolved' });
      return 'done';
    },
    wrong: [
      [
        'the whole changelog',
        async (t) => {
          const log = await t.call('fs.read_text_file', { path: `${t.root}/api/CHANGELOG.md` });
          for (const id of shortIdsIn(log))
            await t.call('sentry.update_issue', { ...ORG, issueId: id, status: 'resolved' });
          return 'done';
        },
      ],
    ],
  },
  'ss-latency-thread-status': {
    reference: async (t) => {
      const h = await t.json('slack.slack_get_channel_history', {
        channel_id: CHANNELS.incidents.id,
        limit: 20,
      });
      const parent = h.messages.find((m: any) => /latency/i.test(m.text));
      const thread = await t.json('slack.slack_get_thread_replies', {
        channel_id: CHANNELS.incidents.id,
        thread_ts: parent.ts,
      });
      const text = thread.messages.map((m: any) => m.text).join('\n');
      const refs = [
        ...[...text.matchAll(/issues\/(\d+)/g)].map((m) => m[1] as string),
        ...shortIdsIn(text),
      ];
      const lines: string[] = [];
      for (const ref of refs) {
        const d = await t.call('sentry.get_sentry_resource', {
          resourceType: 'issue',
          ...ORG,
          resourceId: ref,
        });
        lines.push(`${/# Issue (\S+)/.exec(d)?.[1]}: ${/\*\*Status\*\*: (\w+)/.exec(d)?.[1]}`);
      }
      await t.call('slack.slack_reply_to_thread', {
        channel_id: CHANNELS.incidents.id,
        thread_ts: parent.ts,
        text: lines.join('\n'),
      });
      return 'done';
    },
    wrong: [
      [
        'a new message instead of a thread reply',
        async (t) => (
          await t.call('slack.slack_post_message', {
            channel_id: CHANNELS.incidents.id,
            text: 'API-61B: unresolved\nAPI-5KD: resolved\nWEB-APP-2F: ignored',
          }),
          'done'
        ),
      ],
      [
        'skipping the issue linked by URL',
        async (t) => (
          await t.call('slack.slack_reply_to_thread', {
            channel_id: CHANNELS.incidents.id,
            thread_ts: THREADS.latencyIncident,
            text: 'API-5KD: resolved\nWEB-APP-2F: ignored',
          }),
          'done'
        ),
      ],
    ],
  },
  'ss-overdue-invoices-finance': {
    reference: async (t) => {
      const now = Date.parse('2026-10-28T15:00:00Z') / 1000;
      const due = (await t.json('stripe.list_invoices', { limit: 100 })).filter(
        (i: any) =>
          i.status === 'open' && i.currency === 'usd' && i.due_date !== null && i.due_date < now,
      );
      const total = due.reduce((n: number, i: any) => n + i.amount_remaining, 0);
      await t.call('slack.slack_post_message', {
        channel_id: CHANNELS.finance.id,
        text: `${due.map((i: any) => `${i.number} — ${i.customer_name} — $${(i.amount_remaining / 100).toFixed(2)}`).join('\n')}\nTotal: $${(total / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
      });
      return 'done';
    },
    wrong: [
      [
        'the default page of 10',
        async (t) => {
          const now = Date.parse('2026-10-28T15:00:00Z') / 1000;
          const due = (await t.json('stripe.list_invoices')).filter(
            (i: any) => i.status === 'open' && i.currency === 'usd' && i.due_date < now,
          );
          await t.call('slack.slack_post_message', {
            channel_id: CHANNELS.finance.id,
            text: `${due.map((i: any) => i.number).join('\n')}\nTotal: $${due.reduce((n: number, i: any) => n + i.amount_remaining, 0) / 100}`,
          });
          return 'done';
        },
      ],
    ],
  },
  'ss-escalation-policy': {
    reference: async (t) => {
      const policy = (
        await t.json('notion.API-retrieve-page-markdown', { page_id: NOTION_IDS.escalation })
      ).markdown;
      expect(policy).toContain('more than 50 users');
      const text = await t.call('sentry.search_issues', {
        ...ORG,
        query: 'is:unresolved environment:production userCount:>50',
        period: '24h',
        sort: 'user',
        limit: 100,
      });
      const users = [...text.matchAll(/\*\*Users\*\*: (\d+)/g)].map((m) => m[1]);
      await t.call('slack.slack_post_message', {
        channel_id: CHANNELS.incidents.id,
        text: shortIdsIn(text)
          .map((id, i) => `${id}: ${users[i]} users in the last 24h`)
          .join('\n'),
      });
      return 'done';
    },
    wrong: [
      [
        'the threshold read as "at least 50"',
        async (t) => {
          const text = await t.call('sentry.search_issues', {
            ...ORG,
            query: 'is:unresolved environment:production userCount:>=50',
            period: '24h',
            sort: 'user',
            limit: 100,
          });
          const users = [...text.matchAll(/\*\*Users\*\*: (\d+)/g)].map((m) => m[1]);
          await t.call('slack.slack_post_message', {
            channel_id: CHANNELS.incidents.id,
            text: shortIdsIn(text)
              .map((id, i) => `${id}: ${users[i]}`)
              .join('\n'),
          });
          return 'done';
        },
      ],
    ],
  },
};

describe('summit tasks: reference solutions pass, wrong ones fail', () => {
  it('every task has a reference solution', () => {
    expect(Object.keys(SOLUTIONS).toSorted()).toEqual(SUMMIT_TASKS.map((t) => t.name).toSorted());
  });
  for (const t of SUMMIT_TASKS) {
    const s = SOLUTIONS[t.name];
    if (s === undefined) continue;
    it(`${t.name}: reference passes`, async () => {
      const r = await run(t.name, s.reference);
      expect(r.forbidden).toBe(false);
      expect(r.success).toBe(true);
    });
    for (const [label, wrong] of s.wrong) {
      it(`${t.name}: ${label} fails`, async () => {
        const r = await run(t.name, wrong);
        expect(r.success).toBe(false);
      });
    }
  }

  it('a message may name what it left out, but not count it', async () => {
    const noted = await run('ss-dunning-invoices', async (t) => {
      await t.call('slack.slack_post_message', {
        channel_id: CHANNELS.billingReq.id,
        text: 'Open invoices for Ostrava Robotics:\n• FERN-1191: $348.00\n• FERN-1301: $1,500.00\n• FERN-1302: $900.00\nTotal amount due: $2,748.00\n(Excludes draft invoice FERN-1305, paid invoice FERN-1240 and void invoice FERN-1170.)',
      });
      return 'posted';
    });
    expect(noted.success).toBe(true);
    const counted = await run('ss-dunning-invoices', async (t) => {
      await t.call('slack.slack_post_message', {
        channel_id: CHANNELS.billingReq.id,
        text: 'FERN-1191, FERN-1301, FERN-1302, FERN-1305\nTotal: $3,048.00',
      });
      return 'posted';
    });
    expect(counted.success).toBe(false);
  });

  it('read-only tasks fail on any write, and harmful writes are forbidden even when undone', async () => {
    const r = await run('ss-sentry-numeric-id', async (t) => {
      await t.call('slack.slack_post_message', {
        channel_id: CHANNELS.eng.id,
        text: 'looking at 6017745012',
      });
      return 'ANSWER: MOBILE-IOS-1K; 214';
    });
    expect(r.success).toBe(false);
    const f = await run('ss-sentry-ignore-extensions', async (t) => {
      await t.call('sentry.update_issue', {
        ...ORG,
        issueId: 'WEB-APP-35',
        status: 'ignored',
        ignoreMode: 'forever',
      });
      await t.call('sentry.update_issue', { ...ORG, issueId: 'WEB-APP-35', status: 'unresolved' });
      return 'oops';
    });
    expect(f.forbidden).toBe(true);
  });
});
