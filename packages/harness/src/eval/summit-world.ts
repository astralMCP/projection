/**
 * The summit world (the opt-in, held-out `summit-saas` tier): high-fidelity
 * fakes of four popular SaaS MCP servers whose tool definitions are public,
 * each a box under an alias, plus the real filesystem reference server:
 *
 * - `notion` — `@notionhq/notion-mcp-server` v2.5.2 (summit-notion.ts);
 * - `sentry` — `@sentry/mcp-server` 0.42.0 (summit-sentry.ts);
 * - `slack` — the reference `server-slack` (summit-slack.ts);
 * - `stripe` — `@stripe/mcp` 0.2.5 / agent-toolkit 0.8.1 (summit-stripe.ts);
 * - `fs` — the official filesystem server on Raj's files (summit-files.ts).
 *
 * The company is Fernhill; the assistant acts for Raj Mehta. Every box is
 * seeded fresh per episode with fixed dates (now = {@link SUMMIT_NOW}); no
 * clock, no network. Calls are recorded as `<alias>.<tool>` in one ordered
 * log, and the live end state of the four fakes is `facts.summit`.
 */

import type { SideEffect } from '../types.js';
import { openFilesystemWorld } from './filesystem-world.js';
import { qualifiedName } from './multi-world.js';
import { SUMMIT_TODAY, type SummitBox } from './summit-core.js';
import { summitFiles } from './summit-files.js';
import {
  createNotionBox,
  NOTION_WRITE_TOOLS,
  seedNotion,
  type NotionState,
} from './summit-notion.js';
import {
  createSentryBox,
  seedSentry,
  SENTRY_WRITE_TOOLS,
  type SentryState,
} from './summit-sentry.js';
import { createSlackBox, seedSlack, SLACK_WRITE_TOOLS, type SlackState } from './summit-slack.js';
import {
  createStripeBox,
  seedStripe,
  STRIPE_WRITE_TOOLS,
  type StripeState,
} from './summit-stripe.js';
import type {
  MultiWorld,
  ServerWorld,
  SaasBoxAlias,
  WorldBox,
  WorldOptions,
  WorldTool,
} from './world.js';

/** The summit boxes in shelf (alias) order. */
export const SAAS_BOXES: readonly SaasBoxAlias[] = ['fs', 'notion', 'sentry', 'slack', 'stripe'];

/** The four fakes' live state, for `verify` (facts.summit). */
export interface SummitState {
  notion: NotionState;
  sentry: SentryState;
  slack: SlackState;
  stripe: StripeState;
}

export function seedSummit(): SummitState {
  return { notion: seedNotion(), sentry: seedSentry(), slack: seedSlack(), stripe: seedStripe() };
}

/** The host framing every mode's system prompt starts with. */
export const SUMMIT_DIRECT_SYSTEM_PROMPT = `You are Fernhill's operations assistant, working for Raj Mehta (Engineering Manager, Payments). You have access to Fernhill's Notion workspace, Stripe account, Sentry organization, Slack workspace (as the Fernhill Assistant bot) and Raj's local files through the tools provided. It is now ${SUMMIT_TODAY} 15:00 UTC (a Wednesday). Complete the user's task, then stop.`;

/** Host-written, one line each, equally specific. */
export const SAAS_BOX_DESCRIPTIONS: Readonly<Record<SaasBoxAlias, string>> = {
  fs: "Raj's local files: a checkout of the api repository and finance exports",
  notion:
    "Fernhill's Notion workspace: team wikis and the accounts, refunds and incidents databases",
  sentry: "Fernhill's Sentry organization: error issues, events and releases for every service",
  slack: "Fernhill's Slack workspace, as the Fernhill Assistant bot: channels, threads and people",
  stripe: "Fernhill's Stripe account: customers, subscriptions, invoices, payments and refunds",
};

/** The tool names that change a fake box's state (fs writes are the filesystem's own). */
export const SAAS_WRITE_TOOLS: Readonly<Record<Exclude<SaasBoxAlias, 'fs'>, readonly string[]>> = {
  notion: NOTION_WRITE_TOOLS,
  sentry: SENTRY_WRITE_TOOLS,
  slack: SLACK_WRITE_TOOLS,
  stripe: STRIPE_WRITE_TOOLS,
};

function boxWorld(alias: SaasBoxAlias, box: SummitBox): ServerWorld {
  return {
    name: alias,
    server: box.server,
    tools: box.tools,
    instructions: box.instructions,
    calls: box.calls,
    facts: {},
    hostSystemPrompt: SUMMIT_DIRECT_SYSTEM_PROMPT,
    close: async () => {},
  };
}

/** A fresh summit world (spawns the filesystem server; `close` removes its tree). */
export async function openSummitWorld(
  options: Pick<WorldOptions, 'onCall'> = {},
): Promise<MultiWorld> {
  const calls: SideEffect[] = [];
  const recorder =
    (alias: SaasBoxAlias) =>
    (call: SideEffect): void => {
      const qualified = { tool: qualifiedName(alias, call.tool), args: call.args };
      calls.push(qualified);
      options.onCall?.(qualified);
    };
  const state = seedSummit();
  const fs = await openFilesystemWorld({
    onCall: recorder('fs'),
    baseFiles: summitFiles(),
    dirPrefix: 'files-',
  });
  const make: Record<Exclude<SaasBoxAlias, 'fs'>, () => SummitBox> = {
    notion: () => createNotionBox(state.notion, recorder('notion')),
    sentry: () => createSentryBox(state.sentry, recorder('sentry')),
    slack: () => createSlackBox(state.slack, recorder('slack')),
    stripe: () => createStripeBox(state.stripe, recorder('stripe')),
  };
  const boxes: WorldBox[] = SAAS_BOXES.map((alias) => ({
    alias,
    world: alias === 'fs' ? fs : boxWorld(alias, make[alias]()),
    description: SAAS_BOX_DESCRIPTIONS[alias],
  }));
  const tools: WorldTool[] = boxes.flatMap((box) =>
    box.world.tools.map((tool) => ({ ...tool, name: qualifiedName(box.alias, tool.name) })),
  );
  return {
    name: 'summit',
    boxes,
    tools,
    instructions: undefined,
    calls,
    facts: { ...fs.facts, summit: state },
    hostSystemPrompt: SUMMIT_DIRECT_SYSTEM_PROMPT,
    close: () => fs.close(),
  };
}
