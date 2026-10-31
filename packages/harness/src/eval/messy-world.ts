/**
 * The messy world (the held-out `summit-messy` tier): other people's badly
 * built MCP servers, each a box under an alias, each one a working server
 * behind {@link messify} with a defect profile real servers ship:
 *
 * - `tracker` — the workplace issue tracker, served **terse and generic**:
 *   tools renamed `search`, `get`, `create`, `list`; one-word
 *   descriptions; no parameter descriptions; JSON as one compact text
 *   block with no `structuredContent`; errors as ordinary results; no
 *   `readOnlyHint`; the next page only in a trailing sentence;
 * - `chat` — the workplace team chat, served **verbose and rambling**:
 *   several KB of usage docs per tool, several KB of README as
 *   `instructions`, no annotations, `list` for the channel list,
 *   camelCase arguments on two tools and snake_case on the rest, unknown
 *   arguments silently dropped, 100 KB+ channel history, slow reads;
 * - `mail` — the workplace mailbox, served **Pydantic-style**: `anyOf`
 *   nullables, `$ref`/`$defs`, `oneOf` enums, one schema with no types,
 *   unknown arguments silently dropped, `search`/`get`/`create` names, no
 *   `readOnlyHint`, Python-repr results, errors as ordinary results;
 * - `billing` — Northwind's billing-platform admin API, **generated from
 *   OpenAPI**: 315 operationId-named tools, HTML or empty descriptions, no
 *   annotations, three pagination styles (messy-billing.ts), plus output
 *   schemas that drifted from the payloads, 404s as ordinary text, slow
 *   lists.
 *
 * The same names collide across boxes: `search` (tracker, mail), `get`
 * (tracker, mail), `create` (tracker, mail), `list` (tracker, chat).
 *
 * A task opens only the boxes it names (`EvalTask.boxes`; default all),
 * so the 300+ tool catalog is in the tasks that are about it and in the
 * cross-server ones, not in every episode. Every box's state is seeded
 * fresh per episode (no clock, no I/O); calls are recorded as
 * `<alias>.<canonical name>` in one ordered log, and the live state is
 * `facts.messy` for `verify`.
 */

import type { SideEffect } from '../types.js';
import { createBillingBox, seedBilling, type BillingState } from './messy-billing.js';
import { messify, type MessyProfile } from './messify.js';
import { qualifiedName } from './multi-world.js';
import { createChatBox, seedChat, type ChatState } from './workplace-chat.js';
import type { FakeBox } from './workplace-fake.js';
import { createMailBox, seedMail, type MailState } from './workplace-mail.js';
import { WORLD_TODAY } from './workplace-people.js';
import { createTrackerBox, seedTracker, type TrackerState } from './workplace-tracker.js';
import type {
  MessyBoxAlias,
  MultiWorld,
  ServerWorld,
  WorldBox,
  WorldOptions,
  WorldTool,
} from './world.js';

/** The messy boxes in shelf (alias) order. */
export const MESSY_BOXES: readonly MessyBoxAlias[] = ['billing', 'chat', 'mail', 'tracker'];

export interface MessyState {
  billing: BillingState;
  chat: ChatState;
  mail: MailState;
  tracker: TrackerState;
}

export function seedMessy(): MessyState {
  return {
    billing: seedBilling(),
    chat: seedChat(),
    mail: seedMail(),
    tracker: seedTracker(),
  };
}

/** What each box is, in the host's words (as long as one another: none is favoured). */
export const MESSY_BOX_DESCRIPTIONS: Readonly<Record<MessyBoxAlias, string>> = {
  billing: 'Billing platform admin API: customers, invoices, charges, plans',
  chat: 'Team chat workspace: channels, threads, messages and people',
  mail: "The assistant's mailbox (assistant@northwind.dev): mail, drafts",
  tracker: 'Issue tracker for teams BE, WEB and OPS: issues and comments',
};

/** How the host framing names each box. */
const BOX_NOUNS: Readonly<Record<MessyBoxAlias, string>> = {
  billing: 'the billing platform',
  chat: "the team's chat",
  mail: 'the assistant mailbox (assistant@northwind.dev)',
  tracker: 'the issue tracker',
};

/** The host framing for an episode with `boxes`: who the assistant is, what it operates, and now. */
export function messySystemPrompt(boxes: readonly MessyBoxAlias[]): string {
  const nouns = boxes.map((b) => BOX_NOUNS[b]);
  const list =
    nouns.length <= 1
      ? (nouns[0] ?? 'nothing')
      : `${nouns.slice(0, -1).join(', ')} and ${nouns.at(-1) as string}`;
  return `You are Northwind's engineering assistant. You operate ${list} through the tools provided. It is now ${WORLD_TODAY} 12:00 UTC (a Wednesday). Complete the user's task, then stop.`;
}

/** Each box's defect profile. */
export const MESSY_PROFILES: Readonly<Record<MessyBoxAlias, MessyProfile>> = {
  tracker: {
    name: 'terse-generic',
    defects: [
      {
        kind: 'rename',
        names: {
          list_issues: 'search',
          get_issue: 'get',
          create_issue: 'create',
          list_comments: 'list',
        },
      },
      { kind: 'descriptions', style: 'one-word' },
      { kind: 'property-descriptions' },
      { kind: 'results', style: 'text-json' },
      { kind: 'errors-as-text' },
      { kind: 'annotations', style: 'no-read-only' },
      { kind: 'pagination-trailer', tools: ['list_issues'] },
    ],
  },
  chat: {
    name: 'verbose-rambling',
    defects: [
      {
        kind: 'instructions',
        style: 'rambling',
        product: 'Chat',
        tip: 'Tools take channel IDs (they start with C), never channel names.',
      },
      { kind: 'descriptions', style: 'verbose' },
      { kind: 'annotations', style: 'none' },
      { kind: 'rename', names: { list_channels: 'list' } },
      { kind: 'arg-case', style: 'camel', tools: ['get_channel_history', 'get_thread_replies'] },
      { kind: 'loose-args' },
      { kind: 'huge-results', bytes: 110_000, tools: ['get_channel_history'] },
      { kind: 'latency', ms: 300, tools: ['get_channel_history', 'get_thread_replies'] },
    ],
  },
  mail: {
    name: 'pydantic',
    defects: [
      {
        kind: 'rename',
        names: { search_emails: 'search', read_email: 'get', draft_email: 'create' },
      },
      {
        kind: 'schema',
        style: 'pydantic',
        tools: ['search_emails', 'read_email', 'send_email', 'draft_email'],
      },
      { kind: 'schema', style: 'untyped', tools: ['modify_email'] },
      { kind: 'loose-args' },
      { kind: 'annotations', style: 'no-read-only' },
      { kind: 'results', style: 'repr' },
      { kind: 'errors-as-text' },
    ],
  },
  billing: {
    name: 'openapi-generated',
    defects: [
      { kind: 'output-drift' },
      { kind: 'errors-as-text' },
      {
        kind: 'latency',
        ms: 150,
        tools: ['GetInvoices', 'GetCharges', 'GetSubscriptions', 'GetCustomers'],
      },
    ],
  },
};

const BOX_FACTORIES: Readonly<
  Record<MessyBoxAlias, (state: MessyState, onCall: (call: SideEffect) => void) => FakeBox>
> = {
  billing: (s, onCall) => createBillingBox(s.billing, onCall),
  chat: (s, onCall) => createChatBox(s.chat, onCall),
  mail: (s, onCall) => createMailBox(s.mail, onCall),
  tracker: (s, onCall) => createTrackerBox(s.tracker, onCall),
};

function boxWorld(alias: MessyBoxAlias, box: FakeBox, system: string): ServerWorld {
  return {
    name: alias,
    server: box.server,
    tools: box.tools,
    instructions: box.instructions,
    calls: box.calls,
    facts: {},
    hostSystemPrompt: system,
    close: async () => {},
  };
}

/** A fresh messy world with `options.boxes` (default: all four). */
export async function openMessyWorld(
  options: Pick<WorldOptions, 'onCall' | 'boxes'> = {},
): Promise<MultiWorld> {
  const aliases = MESSY_BOXES.filter(
    (alias) => options.boxes === undefined || options.boxes.includes(alias),
  );
  const calls: SideEffect[] = [];
  const recorder =
    (alias: MessyBoxAlias) =>
    (call: SideEffect): void => {
      const qualified = { tool: qualifiedName(alias, call.tool), args: call.args };
      calls.push(qualified);
      options.onCall?.(qualified);
    };
  const state = seedMessy();
  const system = messySystemPrompt(aliases);
  const boxes: WorldBox[] = [];
  for (const alias of aliases) {
    const inner = boxWorld(alias, BOX_FACTORIES[alias](state, recorder(alias)), system);
    boxes.push({
      alias,
      world: await messify(inner, MESSY_PROFILES[alias]),
      description: MESSY_BOX_DESCRIPTIONS[alias],
    });
  }
  const tools: WorldTool[] = boxes.flatMap((box) =>
    box.world.tools.map((tool) => ({ ...tool, name: qualifiedName(box.alias, tool.name) })),
  );
  return {
    name: 'messy',
    boxes,
    tools,
    instructions: undefined,
    calls,
    facts: { messy: state },
    hostSystemPrompt: system,
    close: async () => {
      await Promise.all(boxes.map((box) => box.world.close().catch(() => {})));
    },
  };
}
