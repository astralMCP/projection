/**
 * The workplace fakes against the real kinds of API they imitate, offline
 * (no network, no model, no clock): each case pins one behaviour a real
 * server has and an earlier fake lacked — no totals the real API never
 * returns, no silently ignored filters or parameters, realistic not-found
 * and validation errors, required-input rules the real server enforces.
 */

import { describe, expect, it } from 'vitest';
import { hostToolName, openSession, openWorld, type MultiWorld } from '../../src/index.js';
import { CHANNELS, THREAD_INC2041_TS } from '../../src/eval/workplace-chat.js';
import { childrenOf, DOC_IDS } from '../../src/eval/workplace-docs.js';
import { PEOPLE } from '../../src/eval/workplace-people.js';

const ORG = { organizationSlug: 'northwind' };

type Call = (tool: string, args?: Record<string, unknown>) => Promise<string>;

/** Run `body` against a fresh workplace world over the direct mode's MCP wire. */
async function withWorld(body: (call: Call, world: MultiWorld) => Promise<void>): Promise<void> {
  const world = await openWorld('workplace');
  if (!('boxes' in world)) throw new Error('expected the workplace world');
  const session = await openSession('direct', world);
  try {
    await body(async (tool, args = {}) => {
      const [alias, ...rest] = tool.split('.');
      const result = await session.runtime.call(
        hostToolName(alias as string, rest.join('.')),
        args,
      );
      return result.isError === true ? `ERROR: ${result.text}` : result.text;
    }, world);
  } finally {
    await session.close();
    await world.close();
  }
}

const json = <T = Record<string, unknown>>(text: string): T => JSON.parse(text) as T;

describe('chat fidelity', () => {
  it('get_thread_replies given a reply ts returns the whole thread, as conversations.replies does', async () => {
    await withWorld(async (call) => {
      const full = json<{ messages: { ts: string }[] }>(
        await call('chat.get_thread_replies', {
          channel_id: CHANNELS.incidents.id,
          thread_ts: THREAD_INC2041_TS,
        }),
      );
      const reply = full.messages[2]?.ts as string;
      const viaReply = json<{ messages: { ts: string }[] }>(
        await call('chat.get_thread_replies', {
          channel_id: CHANNELS.incidents.id,
          thread_ts: reply,
        }),
      );
      expect(viaReply.messages.map((m) => m.ts)).toEqual(full.messages.map((m) => m.ts));
    });
  });

  it('get_user_profile carries no `deleted` flag (users.profile.get has none)', async () => {
    await withWorld(async (call) => {
      const r = json<{ ok: boolean; profile: Record<string, unknown> }>(
        await call('chat.get_user_profile', { user_id: PEOPLE.lena.chatId }),
      );
      expect(r.ok).toBe(true);
      expect(r.profile).not.toHaveProperty('deleted');
      // The users list still says so.
      const users = json<{ members: { id: string; deleted: boolean }[] }>(
        await call('chat.get_users'),
      );
      expect(users.members.find((u) => u.id === PEOPLE.lena.chatId)?.deleted).toBe(true);
    });
  });
});

describe('tracker fidelity', () => {
  it('list_issues takes an assignee by ID, name or email, and refuses an unknown one', async () => {
    await withWorld(async (call) => {
      const ids = async (assignee: string): Promise<string[]> =>
        json<{ issues: { identifier: string }[] }>(
          await call('tracker.list_issues', { assignee, first: 50 }),
        )
          .issues.map((i) => i.identifier)
          .toSorted();
      const byEmail = await ids(PEOPLE.priya.email);
      expect(byEmail.length).toBeGreaterThan(0);
      expect(await ids(PEOPLE.priya.trackerId)).toEqual(byEmail);
      expect(await ids('Priya Raman')).toEqual(byEmail);
      expect(await ids('me')).toEqual([]);
      expect(await call('tracker.list_issues', { assignee: 'nobody@northwind.dev' })).toMatch(
        /^ERROR: Entity not found: User/,
      );
    });
  });
});

describe('errors fidelity', () => {
  it('search_issues reports how many issues it returned, not a total across pages', async () => {
    await withWorld(async (call) => {
      const r = await call('errors.search_issues', {
        ...ORG,
        projectSlug: 'billing-worker',
        limit: 2,
      });
      expect(r).toMatch(/Found 2 issues/);
      expect(r).not.toMatch(/matching issue/);
      expect(r).toMatch(/Next page cursor/);
    });
  });

  it('update_issue needs a status or an assignee, and refuses an unknown assignee', async () => {
    await withWorld(async (call, world) => {
      expect(await call('errors.update_issue', { ...ORG, issueId: 'CHECKOUT-API-3B' })).toMatch(
        /^ERROR: At least one of `status` or `assignedTo`/,
      );
      expect(
        await call('errors.update_issue', {
          ...ORG,
          issueId: 'CHECKOUT-API-3B',
          assignedTo: 'user:nobody@northwind.dev',
        }),
      ).toMatch(/^ERROR: .*Unknown actor/);
      expect(world.facts.workplace?.errors.mutations).toEqual([]);
      expect(
        await call('errors.update_issue', {
          ...ORG,
          issueId: 'CHECKOUT-API-3B',
          assignedTo: `user:${PEOPLE.priya.email}`,
        }),
      ).toMatch(/assignedTo=priya\.raman@northwind\.dev/);
    });
  });
});

describe('mail fidelity', () => {
  const ids = (text: string): string[] =>
    [...text.matchAll(/^ID: (\S+)/gm)].map((m) => m[1] as string);

  it('search_emails honours is:read, date operators and negation instead of ignoring them', async () => {
    await withWorld(async (call) => {
      const all = ids(await call('mail.search_emails', { query: '', maxResults: 50 }));
      const unread = ids(await call('mail.search_emails', { query: 'is:unread', maxResults: 50 }));
      const read = ids(await call('mail.search_emails', { query: 'is:read', maxResults: 50 }));
      expect(unread).toHaveLength(2);
      expect(read).toHaveLength(all.length - 2);
      expect(read.some((id) => unread.includes(id))).toBe(false);
      const recent = ids(
        await call('mail.search_emails', { query: 'newer_than:2d', maxResults: 50 }),
      );
      expect(recent).toHaveLength(4); // 10-12 18:30 onwards
      const after = ids(await call('mail.search_emails', { query: 'after:2026/10/13' }));
      expect(after).toHaveLength(3);
      const before = ids(await call('mail.search_emails', { query: 'before:2026-10-09' }));
      expect(before).toHaveLength(1);
      const notGlobex = ids(
        await call('mail.search_emails', { query: '-from:globex', maxResults: 50 }),
      );
      expect(notGlobex).toHaveLength(all.length - 2);
      expect(await call('mail.search_emails', { query: 'is:starred' })).toBe('No messages found.');
    });
  });

  it('modify_email refuses a label ID that does not exist', async () => {
    await withWorld(async (call, world) => {
      const [id] = ids(await call('mail.search_emails', { query: 'is:unread' }));
      expect(await call('mail.modify_email', { messageId: id, addLabelIds: ['Archive'] })).toMatch(
        /^ERROR: .*Invalid label: Archive/,
      );
      expect(world.facts.workplace?.mail.relabels).toEqual([]);
      expect(
        await call('mail.modify_email', { messageId: id, removeLabelIds: ['UNREAD'] }),
      ).not.toMatch(/^ERROR/);
    });
  });
});

describe('docs fidelity', () => {
  interface Rows {
    results: { properties: { Name: { title: { plain_text: string }[] } } }[];
  }
  const names = (text: string): string[] =>
    json<Rows>(text)
      .results.map((r) => r.properties.Name.title.map((t) => t.plain_text).join(''))
      .toSorted();

  it('database query applies select, people, date and compound filters, and sorts', async () => {
    await withWorld(async (call) => {
      const query = (args: Record<string, unknown>): Promise<string> =>
        call('docs.API-post-database-query', { database_id: DOC_IDS.services, ...args });
      expect(
        names(await query({ filter: { property: 'Tier', select: { equals: 'Tier 2' } } })),
      ).toEqual(['notify-svc', 'storefront']);
      expect(
        names(
          await query({ filter: { property: 'Owner', people: { contains: PEOPLE.marco.docsId } } }),
        ),
      ).toEqual(['payments-api']);
      expect(
        names(
          await query({
            filter: {
              and: [
                { property: 'Tier', select: { equals: 'Tier 1' } },
                { property: 'Name', title: { starts_with: 'b' } },
              ],
            },
          }),
        ),
      ).toEqual(['billing-worker']);
      expect(
        names(await query({ filter: { property: 'Name', title: { equals: 'payments-api' } } })),
      ).toEqual(['payments-api']);
      const pm = await call('docs.API-post-database-query', {
        database_id: DOC_IDS.postmortems,
        filter: { property: 'Date', date: { on_or_after: '2026-10-01' } },
      });
      expect(json<{ results: unknown[] }>(pm).results).toHaveLength(1);
      const sorted = json<Rows>(
        await query({ sorts: [{ property: 'Name', direction: 'descending' }] }),
      ).results.map((r) => r.properties.Name.title[0]?.plain_text);
      expect(sorted[0]).toBe('storefront');
      expect(sorted.at(-1)).toBe('billing-worker');
      // An unknown property is an error, not a silently unfiltered list.
      expect(await query({ filter: { property: 'Team', select: { equals: 'Backend' } } })).toMatch(
        /^ERROR: .*Could not find property with name or id: Team/,
      );
    });
  });

  it('answers a non-UUID with a 400 and a missing page with a page-shaped 404', async () => {
    await withWorld(async (call) => {
      expect(await call('docs.API-retrieve-a-page', { page_id: 'On-call rotation' })).toMatch(
        /"status":400.*path\.page_id should be a valid uuid/,
      );
      expect(
        await call('docs.API-retrieve-a-page', { page_id: '00000000-0000-4000-8000-000000000000' }),
      ).toMatch(/Could not find page with ID/);
      expect(
        await call('docs.API-post-database-query', {
          database_id: '00000000-0000-4000-8000-000000000000',
        }),
      ).toMatch(/Could not find database with ID/);
    });
  });

  it('appends after the given block when `after` is passed', async () => {
    await withWorld(async (call, world) => {
      const state = world.facts.workplace?.docs;
      if (state === undefined) throw new Error('no docs state');
      const [first, second] = childrenOf(state, DOC_IDS.inc2041Actions);
      const r = await call('docs.API-patch-block-children', {
        block_id: DOC_IDS.inc2041Actions,
        after: first?.id,
        children: [
          { type: 'to_do', to_do: { rich_text: [{ type: 'text', text: { content: 'new' } }] } },
        ],
      });
      expect(r).not.toMatch(/^ERROR/);
      const order = childrenOf(state, DOC_IDS.inc2041Actions).map((b) => b.id);
      expect(order[0]).toBe(first?.id);
      expect(order[2]).toBe(second?.id);
      expect(order).toHaveLength(3);
      // `after` must be one of block_id's children.
      expect(
        await call('docs.API-patch-block-children', {
          block_id: DOC_IDS.inc2041Actions,
          after: DOC_IDS.inc2033Actions,
          children: [
            { type: 'to_do', to_do: { rich_text: [{ type: 'text', text: { content: 'x' } }] } },
          ],
        }),
      ).toMatch(/validation_error/);
    });
  });
});
