/**
 * The summit world's `stripe` box: a fake of Stripe's official MCP server,
 * `@stripe/mcp` 0.2.5 / `@stripe/agent-toolkit` 0.8.1, the last release
 * whose tools ran locally against the Stripe API (stripe/agent-toolkit
 * commit 72d20b9aa5dc515ac79ebfb76784ff035d2f0929, 2026-02-04, files
 * `tools/typescript/src/shared/<resource>/*.ts` and
 * `tools/typescript/src/modelcontextprotocol/toolkit.ts`). Later releases
 * proxy to the closed remote server at mcp.stripe.com.
 *
 * Definitions: the 22 tools' names (the toolkit's `method`), descriptions
 * (the `…Prompt()` strings, leading newline and all), annotations, and
 * input schemas — zod objects that SDK 1.17 lists through
 * zod-to-json-schema (`additionalProperties: false`, draft-07 `$schema`).
 * No output schemas.
 *
 * Behaviour, read from the handlers:
 *
 * - every result is ONE text block holding `JSON.stringify(result)` —
 *   compact JSON, never `isError`; a failed API call is the JSON string
 *   `"Failed to <verb> <object>"` as an ordinary result (only
 *   `create_coupon` appends the API's message);
 * - list tools pass `limit` (1–100, Stripe's default 10) and their filters
 *   to the API and return only `.data`: no `has_more`, no cursor, no
 *   `starting_after` — past 100 objects a listing cannot be paged at all;
 * - `list_customers` returns only `{ id }` per customer, and
 *   `list_disputes` only `{ id }` per dispute; `list_coupons` a subset;
 * - objects follow the API version stripe-node 17.5 pins
 *   (2024-12-18.acacia): a PaymentIntent carries `latest_charge` as an ID
 *   and nothing about refunds; amounts are integers in the currency's
 *   minor unit (cents);
 * - `create_refund` takes `payment_intent` and an optional integer
 *   `amount` (the prompt mentions a `reason`, the schema drops it); the
 *   API refuses a refund of a PaymentIntent that is not `succeeded` or
 *   whose remaining refundable amount is smaller; the tool returns
 *   `{ id, status, amount }`;
 * - arguments are validated by zod before the handler (a `-32602` error,
 *   nothing reaches the API), unknown keys are stripped;
 * - `search_stripe_documentation` calls ai.stripe.com; offline it answers
 *   as the endpoint does for a question it has no sources for (`[]`).
 */

import type { SideEffect } from '../types.js';
import {
  compactJson,
  createSummitBox,
  epoch,
  num,
  prng,
  str,
  ALNUM,
  idFrom,
  type Args,
  type BoxResult,
  type SummitBox,
  type SummitTool,
} from './summit-core.js';

// ---------------------------------------------------------------------------
// State

export interface StripeCustomer {
  id: string;
  name: string;
  email: string;
  created: number;
  currency: 'usd' | 'eur';
}

export interface StripePrice {
  id: string;
  product: string;
  unit_amount: number;
  currency: 'usd' | 'eur';
  interval: 'month' | 'year' | null;
  nickname: string | null;
  active: boolean;
  created: number;
  lookup_key: string | null;
}

export interface StripeProduct {
  id: string;
  name: string;
  description: string | null;
  created: number;
  active: boolean;
}

export interface StripeSubscription {
  id: string;
  customer: string;
  status: 'active' | 'past_due' | 'unpaid' | 'canceled' | 'trialing' | 'incomplete';
  items: { id: string; price: string; quantity: number }[];
  created: number;
  current_period_start: number;
  current_period_end: number;
  canceled_at: number | null;
  latest_invoice: string | null;
}

export interface StripePaymentIntent {
  id: string;
  customer: string | null;
  amount: number;
  currency: 'usd' | 'eur';
  status: 'succeeded' | 'requires_payment_method' | 'canceled' | 'processing';
  created: number;
  description: string | null;
  invoice: string | null;
  latest_charge: string | null;
  payment_method: string;
  receipt_email: string | null;
  metadata: Record<string, string>;
  /** Amount already refunded (not visible on the PaymentIntent object). */
  refunded: number;
  decline_code?: string;
}

export interface StripeInvoice {
  id: string;
  number: string | null;
  customer: string;
  subscription: string | null;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  amount_due: number;
  amount_paid: number;
  created: number;
  due_date: number | null;
  period_start: number;
  period_end: number;
  lines: { price: string; quantity: number; amount: number; description: string }[];
  collection_method: 'charge_automatically' | 'send_invoice';
  payment_intent: string | null;
  attempt_count: number;
}

export interface StripeRefund {
  id: string;
  payment_intent: string;
  amount: number;
  created: number;
}

export interface StripeState {
  customers: StripeCustomer[];
  products: StripeProduct[];
  prices: StripePrice[];
  subscriptions: StripeSubscription[];
  paymentIntents: StripePaymentIntent[];
  invoices: StripeInvoice[];
  refunds: StripeRefund[];
  coupons: {
    id: string;
    name: string;
    percent_off: number | null;
    amount_off: number | null;
    duration: string;
    created: number;
  }[];
  disputes: {
    id: string;
    payment_intent: string;
    status: string;
    evidence: Record<string, string>;
    created: number;
  }[];
  /** Every successful write, in order (the graders' view of the end state). */
  mutations: { kind: string; id: string; detail: Record<string, unknown> }[];
  /** Counter for created IDs. */
  seq: number;
}

// ---------------------------------------------------------------------------
// Fixture: products and prices

const T = (iso: string): number => epoch(iso);

export const PRODUCT_IDS = {
  starterLegacy: 'prod_NqT4bZr8LmW2xK',
  team: 'prod_PbV7cX2nQe9sLd',
  business: 'prod_PbV8hJ4tYw1mRf',
  enterprise: 'prod_PbV9kM6uZx3pTg',
  onboarding: 'prod_Q2aLw5eRt7yUiO',
  storage: 'prod_Q8fGh2jKl4zXcV',
} as const;

export const PRICE_IDS = {
  starterLegacyMonthly: 'price_1N3qT4bZr8LmW2xKa9Qd0sRt',
  teamMonthly: 'price_1PbV7cX2nQe9sLdF3hJ8kLm2',
  teamYearly: 'price_1PbV7cX2nQe9sLdG5jK1mNp4',
  businessMonthly: 'price_1PbV8hJ4tYw1mRfH7kL3nPq6',
  businessYearly: 'price_1PbV8hJ4tYw1mRfJ9mN5pRs8',
  enterpriseMonthly: 'price_1PbV9kM6uZx3pTgK2nP7qSt0',
  enterpriseYearly: 'price_1PbV9kM6uZx3pTgL4pQ9rTu2',
  onboarding: 'price_1Q2aLw5eRt7yUiOM6qR1sUv4',
  teamMonthlyEur: 'price_1Q5tYu8iOp2aSdFN8rS3tVw6',
  storage: 'price_1Q8fGh2jKl4zXcVP0sT5uWx8',
  teamMonthly2024: 'price_1OaB3cD5eF7gH9iJ1kL3mN5o',
  businessMonthly2024: 'price_1OaB4dE6fG8hI0jK2lM4nO6p',
} as const;

function products(): StripeProduct[] {
  return [
    {
      id: PRODUCT_IDS.starterLegacy,
      name: 'Fernhill Starter (legacy)',
      description: 'Single-calendar plan, no longer sold.',
      created: T('2023-04-11T10:00:00Z'),
      active: true,
    },
    {
      id: PRODUCT_IDS.team,
      name: 'Fernhill Team',
      description: 'Shared scheduling for teams. Billed per seat.',
      created: T('2024-01-08T10:00:00Z'),
      active: true,
    },
    {
      id: PRODUCT_IDS.business,
      name: 'Fernhill Business',
      description: 'SAML SSO, routing rules and audit log. Billed per seat.',
      created: T('2024-01-08T10:05:00Z'),
      active: true,
    },
    {
      id: PRODUCT_IDS.enterprise,
      name: 'Fernhill Enterprise',
      description: 'Custom contract: SCIM, data residency, dedicated CSM.',
      created: T('2024-01-08T10:10:00Z'),
      active: true,
    },
    {
      id: PRODUCT_IDS.onboarding,
      name: 'Onboarding package',
      description: 'One-time guided rollout (up to 500 seats).',
      created: T('2024-06-20T09:00:00Z'),
      active: true,
    },
    {
      id: PRODUCT_IDS.storage,
      name: 'Extra recording storage',
      description: '100 GB of meeting-recording storage.',
      created: T('2024-09-02T09:00:00Z'),
      active: true,
    },
  ];
}

function prices(): StripePrice[] {
  const p = (
    id: string,
    product: string,
    unit_amount: number,
    interval: 'month' | 'year' | null,
    nickname: string,
    created: string,
    extra: Partial<StripePrice> = {},
  ): StripePrice => ({
    id,
    product,
    unit_amount,
    currency: 'usd',
    interval,
    nickname,
    active: true,
    created: T(created),
    lookup_key: null,
    ...extra,
  });
  return [
    p(
      PRICE_IDS.starterLegacyMonthly,
      PRODUCT_IDS.starterLegacy,
      1900,
      'month',
      'Starter legacy monthly',
      '2023-04-11T10:01:00Z',
    ),
    p(
      PRICE_IDS.teamMonthly2024,
      PRODUCT_IDS.team,
      1000,
      'month',
      'Team monthly (2024)',
      '2024-01-08T10:01:00Z',
      { active: false },
    ),
    p(
      PRICE_IDS.businessMonthly2024,
      PRODUCT_IDS.business,
      2500,
      'month',
      'Business monthly (2024)',
      '2024-01-08T10:06:00Z',
      { active: false },
    ),
    p(
      PRICE_IDS.onboarding,
      PRODUCT_IDS.onboarding,
      150000,
      null,
      'Onboarding',
      '2024-06-20T09:01:00Z',
    ),
    p(
      PRICE_IDS.storage,
      PRODUCT_IDS.storage,
      900,
      'month',
      'Storage 100GB',
      '2024-09-02T09:01:00Z',
    ),
    p(
      PRICE_IDS.teamMonthly,
      PRODUCT_IDS.team,
      1200,
      'month',
      'Team monthly',
      '2025-02-01T09:00:00Z',
      { lookup_key: 'team_monthly' },
    ),
    p(
      PRICE_IDS.teamYearly,
      PRODUCT_IDS.team,
      12000,
      'year',
      'Team yearly',
      '2025-02-01T09:01:00Z',
      { lookup_key: 'team_yearly' },
    ),
    p(
      PRICE_IDS.businessMonthly,
      PRODUCT_IDS.business,
      2900,
      'month',
      'Business monthly',
      '2025-02-01T09:02:00Z',
      { lookup_key: 'business_monthly' },
    ),
    p(
      PRICE_IDS.businessYearly,
      PRODUCT_IDS.business,
      29000,
      'year',
      'Business yearly',
      '2025-02-01T09:03:00Z',
      { lookup_key: 'business_yearly' },
    ),
    p(
      PRICE_IDS.enterpriseMonthly,
      PRODUCT_IDS.enterprise,
      250000,
      'month',
      'Enterprise monthly',
      '2025-02-01T09:04:00Z',
    ),
    p(
      PRICE_IDS.enterpriseYearly,
      PRODUCT_IDS.enterprise,
      2700000,
      'year',
      'Enterprise yearly',
      '2025-02-01T09:05:00Z',
    ),
    p(
      PRICE_IDS.teamMonthlyEur,
      PRODUCT_IDS.team,
      1100,
      'month',
      'Team monthly EUR',
      '2025-05-12T09:00:00Z',
      { currency: 'eur' },
    ),
  ];
}

// ---------------------------------------------------------------------------
// Fixture: customers and subscriptions

interface AccountSeed {
  key: string;
  name: string;
  domain: string;
  /** Subscriptions: price, quantity, status, created (ISO). */
  subs: {
    price: string;
    qty: number;
    status: StripeSubscription['status'];
    created: string;
    extra?: { price: string; qty: number };
  }[];
  currency?: 'usd' | 'eur';
  email?: string;
}

/**
 * The customers. Keys are referenced by the tasks; the order is creation
 * order. Every subscription status a task depends on is spelled out here.
 */
export const ACCOUNTS: readonly AccountSeed[] = [
  {
    key: 'halcyon',
    name: 'Halcyon Bank',
    domain: 'halcyonbank.com',
    subs: [
      {
        price: PRICE_IDS.enterpriseMonthly,
        qty: 1,
        status: 'active',
        created: '2025-03-19T00:04:00Z',
      },
    ],
  },
  {
    key: 'orbital',
    name: 'Orbital Freight',
    domain: 'orbitalfreight.io',
    subs: [
      {
        price: PRICE_IDS.enterpriseYearly,
        qty: 1,
        status: 'active',
        created: '2025-10-21T14:00:00Z',
        extra: { price: PRICE_IDS.businessYearly, qty: 10 },
      },
    ],
  },
  {
    key: 'meridian',
    name: 'Meridian Clinics',
    domain: 'meridianclinics.org',
    subs: [
      {
        price: PRICE_IDS.enterpriseMonthly,
        qty: 1,
        status: 'active',
        created: '2025-04-07T09:00:00Z',
        extra: { price: PRICE_IDS.teamMonthly, qty: 25 },
      },
    ],
  },
  {
    key: 'pinecrest',
    name: 'Pinecrest University',
    domain: 'pinecrest.edu',
    subs: [
      {
        price: PRICE_IDS.businessMonthly,
        qty: 60,
        status: 'canceled',
        created: '2024-08-15T09:00:00Z',
      },
      {
        price: PRICE_IDS.enterpriseYearly,
        qty: 1,
        status: 'active',
        created: '2025-08-15T09:00:00Z',
      },
    ],
  },
  {
    key: 'vantage',
    name: 'Vantage Retail',
    domain: 'vantageretail.com',
    subs: [
      {
        price: PRICE_IDS.enterpriseMonthly,
        qty: 1,
        status: 'past_due',
        created: '2025-06-02T09:00:00Z',
      },
    ],
  },
  {
    key: 'quarry',
    name: 'Quarry & Co',
    domain: 'quarryco.com',
    subs: [
      {
        price: PRICE_IDS.enterpriseMonthly,
        qty: 2,
        status: 'active',
        created: '2025-05-11T09:00:00Z',
      },
    ],
  },
  {
    key: 'lumora',
    name: 'Lumora Health',
    domain: 'lumora.co',
    email: 'ap@lumora.co',
    subs: [
      { price: PRICE_IDS.teamMonthly, qty: 29, status: 'active', created: '2025-07-01T09:00:00Z' },
    ],
  },
  {
    key: 'lumoraDecoy',
    name: 'Lumora Labs',
    domain: 'lumora.com',
    email: 'ap@lumora.com',
    subs: [
      { price: PRICE_IDS.teamMonthly, qty: 6, status: 'active', created: '2025-09-14T09:00:00Z' },
    ],
  },
  {
    key: 'brightpath',
    name: 'Brightpath Logistics',
    domain: 'brightpath.co',
    subs: [
      {
        price: PRICE_IDS.businessMonthly,
        qty: 10,
        status: 'active',
        created: '2025-04-23T09:00:00Z',
      },
    ],
  },
  {
    key: 'kestrel',
    name: 'Kestrel Analytics',
    domain: 'kestrel.ai',
    subs: [
      {
        price: PRICE_IDS.businessMonthly,
        qty: 18,
        status: 'active',
        created: '2025-03-03T09:00:00Z',
      },
    ],
  },
  {
    key: 'ostrava',
    name: 'Ostrava Robotics',
    domain: 'ostravarobotics.cz',
    subs: [
      {
        price: PRICE_IDS.teamMonthly,
        qty: 29,
        status: 'past_due',
        created: '2025-05-20T09:00:00Z',
      },
    ],
  },
  // the legacy-Starter customers
  {
    key: 'acornDental',
    name: 'Acorn Dental',
    domain: 'acorndental.com',
    subs: [
      {
        price: PRICE_IDS.starterLegacyMonthly,
        qty: 1,
        status: 'past_due',
        created: '2023-06-02T09:00:00Z',
      },
    ],
  },
  {
    key: 'bluefin',
    name: 'Bluefin Tutoring',
    domain: 'bluefintutoring.com',
    subs: [
      {
        price: PRICE_IDS.starterLegacyMonthly,
        qty: 1,
        status: 'past_due',
        created: '2023-07-19T09:00:00Z',
      },
    ],
  },
  {
    key: 'cobalt',
    name: 'Cobalt Yoga Studio',
    domain: 'cobaltyoga.com',
    subs: [
      {
        price: PRICE_IDS.starterLegacyMonthly,
        qty: 1,
        status: 'active',
        created: '2023-08-30T09:00:00Z',
      },
    ],
  },
  {
    key: 'dahlia',
    name: 'Dahlia Florists',
    domain: 'dahliaflorists.com',
    subs: [
      {
        price: PRICE_IDS.starterLegacyMonthly,
        qty: 1,
        status: 'past_due',
        created: '2023-09-12T09:00:00Z',
      },
    ],
  },
  {
    key: 'ember',
    name: 'Ember Physio',
    domain: 'emberphysio.com',
    subs: [
      {
        price: PRICE_IDS.starterLegacyMonthly,
        qty: 1,
        status: 'canceled',
        created: '2023-10-05T09:00:00Z',
      },
    ],
  },
  {
    key: 'fjord',
    name: 'Fjord Legal',
    domain: 'fjordlegal.no',
    subs: [
      {
        price: PRICE_IDS.starterLegacyMonthly,
        qty: 1,
        status: 'past_due',
        created: '2023-11-21T09:00:00Z',
      },
    ],
  },
  {
    key: 'granite',
    name: 'Granite Coaching',
    domain: 'granitecoaching.com',
    subs: [
      {
        price: PRICE_IDS.starterLegacyMonthly,
        qty: 1,
        status: 'past_due',
        created: '2024-01-15T09:00:00Z',
      },
    ],
  },
  // the other past-due subscriptions
  {
    key: 'harbor',
    name: 'Harbor Labs',
    domain: 'harborlabs.dev',
    subs: [
      {
        price: PRICE_IDS.businessYearly,
        qty: 3,
        status: 'past_due',
        created: '2024-10-20T09:00:00Z',
      },
    ],
  },
  {
    key: 'ironwood',
    name: 'Ironwood Partners',
    domain: 'ironwood.partners',
    subs: [
      { price: PRICE_IDS.teamYearly, qty: 10, status: 'past_due', created: '2024-10-25T09:00:00Z' },
    ],
  },
  {
    key: 'juniper',
    name: 'Juniper Studios',
    domain: 'juniperstudios.tv',
    subs: [
      { price: PRICE_IDS.teamMonthly, qty: 8, status: 'past_due', created: '2025-06-17T09:00:00Z' },
    ],
  },
  {
    key: 'keystone',
    name: 'Keystone Realty',
    domain: 'keystonerealty.com',
    subs: [
      {
        price: PRICE_IDS.businessMonthly,
        qty: 12,
        status: 'past_due',
        created: '2025-07-22T09:00:00Z',
      },
    ],
  },
  {
    key: 'larch',
    name: 'Larch & Finch',
    domain: 'larchfinch.co.uk',
    subs: [
      {
        price: PRICE_IDS.businessMonthly,
        qty: 5,
        status: 'past_due',
        created: '2025-08-08T09:00:00Z',
      },
    ],
  },
  // noise: other statuses
  {
    key: 'mosaic',
    name: 'Mosaic Events',
    domain: 'mosaicevents.com',
    subs: [
      {
        price: PRICE_IDS.businessMonthly,
        qty: 7,
        status: 'unpaid',
        created: '2025-02-26T09:00:00Z',
      },
    ],
  },
  {
    key: 'nimbus',
    name: 'Nimbus Health',
    domain: 'nimbushealth.io',
    subs: [
      {
        price: PRICE_IDS.teamMonthly,
        qty: 40,
        status: 'trialing',
        created: '2026-10-20T09:00:00Z',
      },
    ],
  },
  {
    key: 'onyx',
    name: 'Onyx Architects',
    domain: 'onyxarch.com',
    subs: [
      {
        price: PRICE_IDS.teamMonthlyEur,
        qty: 9,
        status: 'past_due',
        created: '2025-09-30T09:00:00Z',
      },
    ],
    currency: 'eur',
  },
  {
    key: 'parallax',
    name: 'Parallax Media',
    domain: 'parallaxmedia.com',
    subs: [
      { price: PRICE_IDS.teamMonthly, qty: 22, status: 'active', created: '2025-01-13T09:00:00Z' },
    ],
  },
  {
    key: 'quill',
    name: 'Quill Publishing',
    domain: 'quillpub.com',
    subs: [
      {
        price: PRICE_IDS.businessYearly,
        qty: 40,
        status: 'active',
        created: '2024-10-20T09:00:00Z',
      },
    ],
  },
  {
    key: 'riverbend',
    name: 'Riverbend Schools',
    domain: 'riverbend.k12.us',
    subs: [
      { price: PRICE_IDS.teamYearly, qty: 120, status: 'active', created: '2025-08-28T09:00:00Z' },
    ],
  },
  {
    key: 'sable',
    name: 'Sable Security',
    domain: 'sablesec.com',
    subs: [
      {
        price: PRICE_IDS.businessMonthly,
        qty: 33,
        status: 'active',
        created: '2025-03-28T09:00:00Z',
      },
    ],
  },
  {
    key: 'tidal',
    name: 'Tidal Energy',
    domain: 'tidalenergy.co',
    subs: [
      { price: PRICE_IDS.teamMonthly, qty: 14, status: 'active', created: '2025-04-12T09:00:00Z' },
    ],
  },
  {
    key: 'umber',
    name: 'Umber Coffee',
    domain: 'umbercoffee.com',
    subs: [
      { price: PRICE_IDS.teamMonthly, qty: 4, status: 'canceled', created: '2025-05-09T09:00:00Z' },
    ],
  },
  {
    key: 'velvet',
    name: 'Velvet Hotels',
    domain: 'velvethotels.com',
    subs: [
      {
        price: PRICE_IDS.businessMonthly,
        qty: 48,
        status: 'active',
        created: '2025-06-25T09:00:00Z',
      },
    ],
  },
  {
    key: 'willow',
    name: 'Willow Care',
    domain: 'willowcare.org',
    subs: [
      { price: PRICE_IDS.teamMonthly, qty: 11, status: 'active', created: '2025-07-15T09:00:00Z' },
    ],
  },
  {
    key: 'xylo',
    name: 'Xylo Games',
    domain: 'xylogames.gg',
    subs: [
      { price: PRICE_IDS.teamMonthly, qty: 17, status: 'active', created: '2025-08-19T09:00:00Z' },
    ],
  },
  {
    key: 'yarrow',
    name: 'Yarrow Foods',
    domain: 'yarrowfoods.com',
    subs: [
      {
        price: PRICE_IDS.businessMonthly,
        qty: 21,
        status: 'active',
        created: '2025-09-03T09:00:00Z',
      },
    ],
  },
  {
    key: 'zenith',
    name: 'Zenith Aerospace',
    domain: 'zenithaero.com',
    subs: [
      {
        price: PRICE_IDS.enterpriseYearly,
        qty: 1,
        status: 'canceled',
        created: '2024-05-14T09:00:00Z',
      },
    ],
  },
  {
    key: 'aurora',
    name: 'Aurora Dance Co',
    domain: 'auroradance.co',
    subs: [
      { price: PRICE_IDS.teamMonthly, qty: 3, status: 'active', created: '2026-02-10T09:00:00Z' },
    ],
  },
  {
    key: 'beacon',
    name: 'Beacon Credit Union',
    domain: 'beaconcu.org',
    subs: [
      {
        price: PRICE_IDS.businessMonthly,
        qty: 26,
        status: 'active',
        created: '2026-03-17T09:00:00Z',
      },
    ],
  },
  { key: 'cedar', name: 'Cedar & Stone', domain: 'cedarstone.com', subs: [] },
];

export interface StripeFixtureIds {
  customers: Record<string, string>;
  subscriptions: Record<string, string[]>;
}

function stripeId(prefix: string, rand: () => number, length: number): string {
  return `${prefix}${idFrom(rand, length, ALNUM)}`;
}

/** Anchor-day timestamps for a subscription's current period. */
function periodFor(created: number, interval: 'month' | 'year' | null): [number, number] {
  const c = new Date(created * 1000);
  const now = new Date(Date.UTC(2026, 9, 28, 15));
  const start = new Date(c);
  if (interval === 'year') {
    start.setUTCFullYear(now.getUTCFullYear());
    if (start > now) start.setUTCFullYear(now.getUTCFullYear() - 1);
    const end = new Date(start);
    end.setUTCFullYear(start.getUTCFullYear() + 1);
    return [Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000)];
  }
  start.setUTCFullYear(now.getUTCFullYear(), now.getUTCMonth());
  if (start > now) start.setUTCMonth(start.getUTCMonth() - 1);
  const end = new Date(start);
  end.setUTCMonth(start.getUTCMonth() + 1);
  return [Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000)];
}

// ---------------------------------------------------------------------------
// Fixture: the payment intents the tasks are about (IDs pinned)

export const PI = {
  // ss-stripe-refund-duplicate: Lumora Health's October renewal, charged twice
  lumoraSep: 'pi_3Q0nYbLkdIwHu7ix0Fd2KQ1a',
  lumoraOctFailed: 'pi_3QAbcDLkdIwHu7ix1Hn4LS2b',
  lumoraOctFirst: 'pi_3QAbcfLkdIwHu7ix1rT7MU3c',
  lumoraOctDuplicate: 'pi_3QAbcpLkdIwHu7ix0Yk2NV4d',
  lumoraDecoyOct: 'pi_3QAbd1LkdIwHu7ix1Wq9PW5e',
  // ss-slack-refunds-to-stripe: the #billing-requests requests
  reqBrightpathSeats: 'pi_3QHk2aLkdIwHu7ix0Bp4Rr6f',
  reqKestrelChurn: 'pi_3QHk3bLkdIwHu7ix1Cq5Ss7g',
  reqParallaxDone: 'pi_3QHk4cLkdIwHu7ix0Dr6Tt8h',
  reqTidalOnboarding: 'pi_3QHk5dLkdIwHu7ix1Es7Uu9i',
  reqWillowNoApproval: 'pi_3QHk6eLkdIwHu7ix0Ft8Vv0j',
  reqSableCredit: 'pi_3QHk7fLkdIwHu7ix1Gu9Ww1k',
  // ss-stripe-to-notion-large-payments: week of 2026-10-19
  bigHalcyonOct19: 'pi_3QJa1ALkdIwHu7ix0Ha1Xx2l',
  bigOrbitalAnnual: 'pi_3QJa2BLkdIwHu7ix1Ib2Yy3m',
  bigQuillAnnual: 'pi_3QJa3CLkdIwHu7ix0Jc3Zz4n',
  bigExactly5000: 'pi_3QJa4DLkdIwHu7ix1Kd4Aa5o',
  bigJustUnder: 'pi_3QJa5ELkdIwHu7ix0Le5Bb6p',
  bigFailed: 'pi_3QJa6FLkdIwHu7ix1Mf6Cc7q',
  bigQuarryOct25: 'pi_3QJa7GLkdIwHu7ix0Ng7Dd8r',
  bigAfterWeek: 'pi_3QJa8HLkdIwHu7ix1Oh8Ee9s',
  bigBeforeWeek: 'pi_3QJa9ILkdIwHu7ix0Pi9Ff0t',
} as const;

export const REFUND_IDS = {
  parallaxDone: 're_3QHk4cLkdIwHu7ix0kR2mNo1',
} as const;

// ---------------------------------------------------------------------------
// Seeding

export function seedStripe(): StripeState {
  const rand = prng(2026_1028);
  const customers: StripeCustomer[] = [];
  const subscriptions: StripeSubscription[] = [];
  const paymentIntents: StripePaymentIntent[] = [];
  const invoices: StripeInvoice[] = [];
  const priceList = prices();
  const priceById = new Map(priceList.map((p) => [p.id, p]));
  const custIds: Record<string, string> = {};

  ACCOUNTS.forEach((acct, i) => {
    const firstSub = acct.subs[0];
    const created =
      firstSub !== undefined ? T(firstSub.created) - 3600 : T('2026-01-05T09:00:00Z') + i * 86400;
    const id = `cus_${idFrom(prng(9000 + i), 14, ALNUM)}`;
    custIds[acct.key] = id;
    customers.push({
      id,
      name: acct.name,
      email: acct.email ?? `billing@${acct.domain}`,
      created,
      currency: acct.currency ?? 'usd',
    });
  });

  let invoiceNo = 1180;
  const invoiceFor = (
    sub: StripeSubscription,
    customer: string,
    at: number,
    status: StripeInvoice['status'],
    pi: string | null,
  ): StripeInvoice => {
    const lines = sub.items.map((item) => {
      const price = priceById.get(item.price) as StripePrice;
      return {
        price: item.price,
        quantity: item.quantity,
        amount: price.unit_amount * item.quantity,
        description: `${item.quantity} × ${productName(price.product)} (at ${money(price.unit_amount, price.currency)} / ${price.interval ?? 'one-time'})`,
      };
    });
    const total = lines.reduce((n, l) => n + l.amount, 0);
    const [ps, pe] = periodFor(
      at,
      (priceById.get(sub.items[0]?.price ?? '')?.interval ?? 'month') as 'month',
    );
    invoiceNo += 1;
    return {
      id: stripeId('in_1Q', rand, 22),
      number: `FERN-${invoiceNo.toString().padStart(4, '0')}`,
      customer,
      subscription: sub.id,
      status,
      amount_due: total,
      amount_paid: status === 'paid' ? total : 0,
      created: at,
      due_date: null,
      period_start: ps,
      period_end: pe,
      lines,
      collection_method: 'charge_automatically',
      payment_intent: pi,
      attempt_count: status === 'paid' ? 1 : status === 'open' ? 3 : 0,
    };
  };

  const subIds: Record<string, string[]> = {};
  ACCOUNTS.forEach((acct) => {
    const customer = custIds[acct.key] as string;
    subIds[acct.key] = [];
    for (const s of acct.subs) {
      const items = [{ id: stripeId('si_', rand, 14), price: s.price, quantity: s.qty }];
      if (s.extra !== undefined)
        items.push({ id: stripeId('si_', rand, 14), price: s.extra.price, quantity: s.extra.qty });
      const interval = priceById.get(s.price)?.interval ?? 'month';
      const [ps, pe] = periodFor(T(s.created), interval);
      const sub: StripeSubscription = {
        id: stripeId('sub_1Q', rand, 20),
        customer,
        status: s.status,
        items,
        created: T(s.created),
        current_period_start: ps,
        current_period_end: pe,
        canceled_at: s.status === 'canceled' ? T('2026-06-30T12:00:00Z') : null,
        latest_invoice: null,
      };
      subIds[acct.key]?.push(sub.id);
      subscriptions.push(sub);
      // The current period's invoice and its payment.
      if (s.status === 'canceled' || s.status === 'trialing') continue;
      const total = items.reduce(
        (n, it) => n + (priceById.get(it.price)?.unit_amount ?? 0) * it.quantity,
        0,
      );
      const currency = priceById.get(s.price)?.currency ?? 'usd';
      const failed = s.status === 'past_due' || s.status === 'unpaid';
      const piId = stripeId('pi_3Q', rand, 22);
      const inv = invoiceFor(sub, customer, ps, failed ? 'open' : 'paid', piId);
      if (failed) inv.due_date = ps + 7 * 86400;
      sub.latest_invoice = inv.id;
      invoices.push(inv);
      paymentIntents.push({
        id: piId,
        customer,
        amount: total,
        currency,
        status: failed ? 'requires_payment_method' : 'succeeded',
        created: ps + 300,
        description: ps === T(s.created) ? 'Subscription creation' : 'Subscription update',
        invoice: inv.id,
        latest_charge: stripeId('ch_3Q', rand, 22),
        payment_method: stripeId('pm_1Q', rand, 22),
        receipt_email: null,
        metadata: {},
        refunded: 0,
        ...(failed ? { decline_code: 'insufficient_funds' } : {}),
      });
    }
  });

  const C = (key: string): string => custIds[key] as string;
  const extraPi = (
    id: string,
    customer: string,
    amount: number,
    created: string,
    status: StripePaymentIntent['status'],
    description: string,
    extra: Partial<StripePaymentIntent> = {},
  ): void => {
    paymentIntents.push({
      id,
      customer,
      amount,
      currency: 'usd',
      status,
      created: T(created),
      description,
      invoice: null,
      latest_charge:
        status === 'succeeded' || status === 'requires_payment_method'
          ? stripeId('ch_3Q', rand, 22)
          : null,
      payment_method: stripeId('pm_1Q', rand, 22),
      receipt_email: null,
      metadata: {},
      refunded: 0,
      ...extra,
    });
  };

  // Some subscription payments are referenced by the tasks: pin their IDs.
  const pinGenerated = (key: string, id: string, created?: string): void => {
    const custId = C(key);
    const pi = paymentIntents.find((p) => p.customer === custId && p.invoice !== null);
    if (pi === undefined) throw new Error(`no generated payment for ${key}`);
    for (const inv of invoices) if (inv.payment_intent === pi.id) inv.payment_intent = id;
    pi.id = id;
    if (created !== undefined) pi.created = T(created);
  };

  // Lumora Health: September renewal, a declined first try in October, then two identical charges.
  pinGenerated('lumora', PI.lumoraOctFirst, '2026-10-01T09:00:12Z');
  extraPi(
    PI.lumoraSep,
    C('lumora'),
    34800,
    '2026-09-01T09:00:31Z',
    'succeeded',
    'Subscription update',
  );
  extraPi(
    PI.lumoraOctFailed,
    C('lumora'),
    34800,
    '2026-10-01T08:59:02Z',
    'requires_payment_method',
    'Subscription update',
    { decline_code: 'card_declined' },
  );
  extraPi(
    PI.lumoraOctDuplicate,
    C('lumora'),
    34800,
    '2026-10-01T09:03:47Z',
    'succeeded',
    'Subscription update',
  );
  pinGenerated('lumoraDecoy', PI.lumoraDecoyOct);

  // #billing-requests
  extraPi(
    PI.reqBrightpathSeats,
    C('brightpath'),
    28700,
    '2026-10-23T16:12:00Z',
    'succeeded',
    'Invoice FERN-1288 (extra seats)',
  );
  pinGenerated('kestrel', PI.reqKestrelChurn);
  extraPi(
    PI.reqParallaxDone,
    C('parallax'),
    21000,
    '2026-10-13T11:20:09Z',
    'succeeded',
    'Invoice FERN-1252 (onsite workshop)',
    { refunded: 21000 },
  );
  extraPi(
    PI.reqTidalOnboarding,
    C('tidal'),
    150000,
    '2026-10-20T11:40:00Z',
    'succeeded',
    'Onboarding package',
  );
  pinGenerated('willow', PI.reqWillowNoApproval);
  extraPi(
    PI.reqSableCredit,
    C('sable'),
    95700,
    '2026-09-28T09:05:52Z',
    'succeeded',
    'Subscription update',
  );

  // Large payments around the week of 2026-10-19 … 2026-10-25 (UTC).
  extraPi(
    PI.bigBeforeWeek,
    C('meridian'),
    600000,
    '2026-10-18T23:40:00Z',
    'succeeded',
    'Invoice FERN-1271 (custom reporting)',
  );
  pinGenerated('halcyon', PI.bigHalcyonOct19);
  pinGenerated('quill', PI.bigQuillAnnual);
  pinGenerated('orbital', PI.bigOrbitalAnnual);
  extraPi(
    PI.bigExactly5000,
    C('riverbend'),
    500000,
    '2026-10-22T17:25:00Z',
    'succeeded',
    'Professional services: SIS integration',
  );
  extraPi(
    PI.bigJustUnder,
    C('velvet'),
    499999,
    '2026-10-23T10:10:00Z',
    'succeeded',
    'Invoice FERN-1290',
  );
  extraPi(
    PI.bigFailed,
    C('beacon'),
    800000,
    '2026-10-24T13:30:00Z',
    'requires_payment_method',
    'Invoice FERN-1293',
    { decline_code: 'do_not_honor' },
  );
  extraPi(
    PI.bigQuarryOct25,
    C('quarry'),
    500000,
    '2026-10-25T23:50:30Z',
    'succeeded',
    'Invoice FERN-1295 (second workspace setup)',
  );
  extraPi(
    PI.bigAfterWeek,
    C('halcyon'),
    650000,
    '2026-10-26T00:20:00Z',
    'succeeded',
    'Invoice FERN-1296 (sandbox workspace)',
  );

  // A few older one-off and canceled intents (noise, beyond the 100 most recent).
  for (let i = 0; i < 30; i++) {
    const acct = ACCOUNTS[(i * 7) % ACCOUNTS.length] as AccountSeed;
    const day = 1 + (i % 28);
    extraPi(
      stripeId('pi_3P', rand, 22),
      C(acct.key),
      900 * (1 + (i % 5)),
      `2026-0${7 + (i % 2)}-${day.toString().padStart(2, '0')}T1${i % 10}:00:00Z`,
      i % 9 === 4 ? 'canceled' : 'succeeded',
      'Extra recording storage',
    );
  }

  // Invoices sent manually (send_invoice), some overdue.
  const manual = (
    key: string,
    number: string,
    amount: number,
    created: string,
    due: string,
    status: StripeInvoice['status'],
    desc: string,
  ): void => {
    invoices.push({
      id: stripeId('in_1Q', rand, 22),
      number,
      customer: C(key),
      subscription: null,
      status,
      amount_due: amount,
      amount_paid: status === 'paid' ? amount : 0,
      created: T(created),
      due_date: T(due),
      period_start: T(created),
      period_end: T(created),
      lines: [{ price: PRICE_IDS.onboarding, quantity: 1, amount, description: desc }],
      collection_method: 'send_invoice',
      payment_intent: status === 'draft' ? null : stripeId('pi_3Q', rand, 22),
      attempt_count: 0,
    });
  };
  manual(
    'ostrava',
    'FERN-1301',
    150000,
    '2026-10-02T10:00:00Z',
    '2026-10-16T10:00:00Z',
    'open',
    'Onboarding package',
  );
  manual(
    'ostrava',
    'FERN-1302',
    90000,
    '2026-10-26T10:00:00Z',
    '2026-11-09T10:00:00Z',
    'open',
    'Onsite training (2 days)',
  );
  manual(
    'ostrava',
    'FERN-1240',
    45000,
    '2026-08-11T10:00:00Z',
    '2026-08-25T10:00:00Z',
    'paid',
    'Data migration',
  );
  manual(
    'ostrava',
    'FERN-1305',
    30000,
    '2026-10-27T10:00:00Z',
    '2026-11-10T10:00:00Z',
    'draft',
    'Additional admin training',
  );
  manual(
    'ostrava',
    'FERN-1170',
    60000,
    '2026-06-02T10:00:00Z',
    '2026-06-16T10:00:00Z',
    'void',
    'Onboarding package (re-issued)',
  );
  manual(
    'beacon',
    'FERN-1293',
    800000,
    '2026-10-10T10:00:00Z',
    '2026-10-24T10:00:00Z',
    'open',
    'Professional services: SSO + SCIM rollout',
  );
  manual(
    'velvet',
    'FERN-1290',
    499999,
    '2026-10-09T10:00:00Z',
    '2026-10-23T10:00:00Z',
    'paid',
    'Custom integration',
  );
  manual(
    'cedar',
    'FERN-1281',
    150000,
    '2026-09-21T10:00:00Z',
    '2026-10-05T10:00:00Z',
    'uncollectible',
    'Onboarding package',
  );
  manual(
    'aurora',
    'FERN-1304',
    12500,
    '2026-10-20T10:00:00Z',
    '2026-10-27T10:00:00Z',
    'open',
    'Workshop seat',
  );
  manual(
    'riverbend',
    'FERN-1310',
    75000,
    '2026-10-21T10:00:00Z',
    '2026-11-04T10:00:00Z',
    'open',
    'Summer term onboarding',
  );

  return {
    customers,
    products: products(),
    prices: priceList,
    subscriptions,
    paymentIntents,
    invoices,
    refunds: [
      {
        id: REFUND_IDS.parallaxDone,
        payment_intent: PI.reqParallaxDone,
        amount: 21000,
        created: T('2026-10-21T15:02:00Z'),
      },
    ],
    coupons: [
      {
        id: 'WINBACK25',
        name: 'Win-back 25%',
        percent_off: 25,
        amount_off: null,
        duration: 'repeating',
        created: T('2026-03-02T10:00:00Z'),
      },
      {
        id: 'EDU50',
        name: 'Education 50%',
        percent_off: 50,
        amount_off: null,
        duration: 'forever',
        created: T('2025-08-01T10:00:00Z'),
      },
      {
        id: 'ONB500',
        name: '$500 off onboarding',
        percent_off: null,
        amount_off: 50000,
        duration: 'once',
        created: T('2025-11-12T10:00:00Z'),
      },
      {
        id: 'q3lEtW2x',
        name: 'Outage credit Sept',
        percent_off: null,
        amount_off: 2000,
        duration: 'once',
        created: T('2026-09-18T10:00:00Z'),
      },
    ],
    disputes: [
      {
        id: 'dp_1QGm7rLkdIwHu7ix0aZ8bC1d',
        payment_intent: PI.reqKestrelChurn,
        status: 'needs_response',
        evidence: {},
        created: T('2026-10-17T08:00:00Z'),
      },
      {
        id: 'dp_1Q9xP2LkdIwHu7ix1bY7cD2e',
        payment_intent: PI.lumoraSep,
        status: 'won',
        evidence: {},
        created: T('2026-09-20T08:00:00Z'),
      },
    ],
    mutations: [],
    seq: 0,
  };
}

/** Customer IDs by account key (stable across seeds). */
export function stripeCustomerIds(): Record<string, string> {
  const out: Record<string, string> = {};
  ACCOUNTS.forEach((acct, i) => {
    out[acct.key] = `cus_${idFrom(prng(9000 + i), 14, ALNUM)}`;
  });
  return out;
}

function productName(id: string): string {
  return products().find((p) => p.id === id)?.name ?? id;
}

export function money(cents: number, currency: string): string {
  const sym = currency === 'eur' ? '€' : '$';
  return `${sym}${(cents / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// API object renderers (2024-12-18.acacia shapes)

function renderPrice(p: StripePrice): Record<string, unknown> {
  return {
    id: p.id,
    object: 'price',
    active: p.active,
    billing_scheme: 'per_unit',
    created: p.created,
    currency: p.currency,
    custom_unit_amount: null,
    livemode: true,
    lookup_key: p.lookup_key,
    metadata: {},
    nickname: p.nickname,
    product: p.product,
    recurring:
      p.interval === null
        ? null
        : {
            aggregate_usage: null,
            interval: p.interval,
            interval_count: 1,
            meter: null,
            trial_period_days: null,
            usage_type: 'licensed',
          },
    tax_behavior: 'exclusive',
    tiers_mode: null,
    transform_quantity: null,
    type: p.interval === null ? 'one_time' : 'recurring',
    unit_amount: p.unit_amount,
    unit_amount_decimal: String(p.unit_amount),
  };
}

function renderProduct(p: StripeProduct): Record<string, unknown> {
  return {
    id: p.id,
    object: 'product',
    active: p.active,
    attributes: [],
    created: p.created,
    default_price: null,
    description: p.description,
    images: [],
    livemode: true,
    marketing_features: [],
    metadata: {},
    name: p.name,
    package_dimensions: null,
    shippable: null,
    statement_descriptor: null,
    tax_code: null,
    type: 'service',
    unit_label: null,
    updated: p.created,
    url: null,
  };
}

function renderPlan(p: StripePrice): Record<string, unknown> {
  return {
    id: p.id,
    object: 'plan',
    active: p.active,
    aggregate_usage: null,
    amount: p.unit_amount,
    amount_decimal: String(p.unit_amount),
    billing_scheme: 'per_unit',
    created: p.created,
    currency: p.currency,
    interval: p.interval,
    interval_count: 1,
    livemode: true,
    metadata: {},
    meter: null,
    nickname: p.nickname,
    product: p.product,
    tiers_mode: null,
    transform_usage: null,
    trial_period_days: null,
    usage_type: 'licensed',
  };
}

function renderSubscription(state: StripeState, s: StripeSubscription): Record<string, unknown> {
  const priceOf = (id: string): StripePrice => state.prices.find((p) => p.id === id) as StripePrice;
  const first = s.items[0];
  const firstPrice = first !== undefined ? priceOf(first.price) : undefined;
  return {
    id: s.id,
    object: 'subscription',
    application: null,
    application_fee_percent: null,
    automatic_tax: { disabled_reason: null, enabled: false, liability: null },
    billing_cycle_anchor: s.created,
    billing_cycle_anchor_config: null,
    billing_thresholds: null,
    cancel_at: null,
    cancel_at_period_end: false,
    canceled_at: s.canceled_at,
    cancellation_details: {
      comment: null,
      feedback: null,
      reason: s.canceled_at !== null ? 'cancellation_requested' : null,
    },
    collection_method: 'charge_automatically',
    created: s.created,
    currency: firstPrice?.currency ?? 'usd',
    current_period_end: s.current_period_end,
    current_period_start: s.current_period_start,
    customer: s.customer,
    days_until_due: null,
    default_payment_method: null,
    default_source: null,
    default_tax_rates: [],
    description: null,
    discount: null,
    discounts: [],
    ended_at: s.status === 'canceled' ? s.canceled_at : null,
    invoice_settings: { account_tax_ids: null, issuer: { type: 'self' } },
    items: {
      object: 'list',
      data: s.items.map((it) => ({
        id: it.id,
        object: 'subscription_item',
        billing_thresholds: null,
        created: s.created,
        discounts: [],
        metadata: {},
        plan: renderPlan(priceOf(it.price)),
        price: renderPrice(priceOf(it.price)),
        quantity: it.quantity,
        subscription: s.id,
        tax_rates: [],
      })),
      has_more: false,
      total_count: s.items.length,
      url: `/v1/subscription_items?subscription=${s.id}`,
    },
    latest_invoice: s.latest_invoice,
    livemode: true,
    metadata: {},
    next_pending_invoice_item_invoice: null,
    on_behalf_of: null,
    pause_collection: null,
    payment_settings: {
      payment_method_options: null,
      payment_method_types: null,
      save_default_payment_method: 'off',
    },
    pending_invoice_item_interval: null,
    pending_setup_intent: null,
    pending_update: null,
    plan: s.items.length === 1 && firstPrice !== undefined ? renderPlan(firstPrice) : null,
    quantity: s.items.length === 1 ? (first?.quantity ?? null) : null,
    schedule: null,
    start_date: s.created,
    status: s.status,
    test_clock: null,
    transfer_data: null,
    trial_end: s.status === 'trialing' ? s.created + 14 * 86400 : null,
    trial_settings: { end_behavior: { missing_payment_method: 'create_invoice' } },
    trial_start: s.status === 'trialing' ? s.created : null,
  };
}

function renderPaymentIntent(pi: StripePaymentIntent): Record<string, unknown> {
  const failed = pi.status === 'requires_payment_method';
  return {
    id: pi.id,
    object: 'payment_intent',
    amount: pi.amount,
    amount_capturable: 0,
    amount_details: { tip: {} },
    amount_received: pi.status === 'succeeded' ? pi.amount : 0,
    application: null,
    application_fee_amount: null,
    automatic_payment_methods: null,
    canceled_at: pi.status === 'canceled' ? pi.created + 3600 : null,
    cancellation_reason: pi.status === 'canceled' ? 'abandoned' : null,
    capture_method: 'automatic',
    client_secret: `${pi.id}_secret_${pi.id.slice(5, 25).split('').reverse().join('')}`,
    confirmation_method: 'automatic',
    created: pi.created,
    currency: pi.currency,
    customer: pi.customer,
    description: pi.description,
    invoice: pi.invoice,
    last_payment_error: failed
      ? {
          charge: pi.latest_charge,
          code: 'card_declined',
          decline_code: pi.decline_code ?? 'generic_decline',
          doc_url: 'https://stripe.com/docs/error-codes/card-declined',
          message: 'Your card was declined.',
          payment_method: { id: pi.payment_method, object: 'payment_method', type: 'card' },
          type: 'card_error',
        }
      : null,
    latest_charge: pi.latest_charge,
    livemode: true,
    metadata: pi.metadata,
    next_action: null,
    on_behalf_of: null,
    payment_method: failed ? null : pi.payment_method,
    payment_method_configuration_details: null,
    payment_method_options: {
      card: {
        installments: null,
        mandate_options: null,
        network: null,
        request_three_d_secure: 'automatic',
      },
    },
    payment_method_types: ['card'],
    processing: null,
    receipt_email: pi.receipt_email,
    review: null,
    setup_future_usage: 'off_session',
    shipping: null,
    source: null,
    statement_descriptor: null,
    statement_descriptor_suffix: null,
    status: pi.status,
    transfer_data: null,
    transfer_group: null,
  };
}

function renderInvoice(state: StripeState, inv: StripeInvoice): Record<string, unknown> {
  const cust = state.customers.find((c) => c.id === inv.customer);
  const total = inv.lines.reduce((n, l) => n + l.amount, 0);
  const open = inv.status === 'open';
  return {
    id: inv.id,
    object: 'invoice',
    account_country: 'US',
    account_name: 'Fernhill, Inc.',
    account_tax_ids: null,
    amount_due: inv.amount_due,
    amount_paid: inv.amount_paid,
    amount_remaining: inv.amount_due - inv.amount_paid,
    amount_shipping: 0,
    application: null,
    application_fee_amount: null,
    attempt_count: inv.attempt_count,
    attempted: inv.attempt_count > 0,
    auto_advance: inv.status === 'draft' || open,
    automatic_tax: { disabled_reason: null, enabled: false, liability: null, status: null },
    billing_reason: inv.subscription !== null ? 'subscription_cycle' : 'manual',
    charge: inv.status === 'paid' ? `ch_${inv.id.slice(3)}` : null,
    collection_method: inv.collection_method,
    created: inv.created,
    currency: cust?.currency ?? 'usd',
    custom_fields: null,
    customer: inv.customer,
    customer_address: null,
    customer_email: cust?.email ?? null,
    customer_name: cust?.name ?? null,
    customer_phone: null,
    customer_shipping: null,
    customer_tax_exempt: 'none',
    customer_tax_ids: [],
    default_payment_method: null,
    default_source: null,
    default_tax_rates: [],
    description: null,
    discount: null,
    discounts: [],
    due_date: inv.due_date,
    effective_at: inv.status === 'draft' ? null : inv.created,
    ending_balance: inv.status === 'draft' ? null : 0,
    footer: null,
    hosted_invoice_url:
      inv.status === 'draft'
        ? null
        : `https://invoice.stripe.com/i/acct_1Fh2nLkdIwHu7ix/live_${inv.id.slice(3, 20)}`,
    invoice_pdf:
      inv.status === 'draft'
        ? null
        : `https://pay.stripe.com/invoice/acct_1Fh2nLkdIwHu7ix/live_${inv.id.slice(3, 20)}/pdf`,
    issuer: { type: 'self' },
    last_finalization_error: null,
    latest_revision: null,
    lines: {
      object: 'list',
      data: inv.lines.map((l, i) => ({
        id: `il_${inv.id.slice(5, 19)}${i}`,
        object: 'line_item',
        amount: l.amount,
        currency: cust?.currency ?? 'usd',
        description: l.description,
        discountable: true,
        discounts: [],
        invoice: inv.id,
        livemode: true,
        metadata: {},
        period: { end: inv.period_end, start: inv.period_start },
        price: renderPrice(state.prices.find((p) => p.id === l.price) as StripePrice),
        proration: false,
        quantity: l.quantity,
        type: inv.subscription !== null ? 'subscription' : 'invoiceitem',
      })),
      has_more: false,
      total_count: inv.lines.length,
      url: `/v1/invoices/${inv.id}/lines`,
    },
    livemode: true,
    metadata: {},
    next_payment_attempt:
      open && inv.collection_method === 'charge_automatically' ? inv.created + 10 * 86400 : null,
    number: inv.number,
    on_behalf_of: null,
    paid: inv.status === 'paid',
    paid_out_of_band: false,
    payment_intent: inv.payment_intent,
    payment_settings: {
      default_mandate: null,
      payment_method_options: null,
      payment_method_types: null,
    },
    period_end: inv.period_end,
    period_start: inv.period_start,
    post_payment_credit_notes_amount: 0,
    pre_payment_credit_notes_amount: 0,
    receipt_number: null,
    starting_balance: 0,
    statement_descriptor: null,
    status: inv.status,
    status_transitions: {
      finalized_at: inv.status === 'draft' ? null : inv.created,
      marked_uncollectible_at: inv.status === 'uncollectible' ? inv.created + 30 * 86400 : null,
      paid_at: inv.status === 'paid' ? inv.created + 600 : null,
      voided_at: inv.status === 'void' ? inv.created + 86400 : null,
    },
    subscription: inv.subscription,
    subtotal: total,
    subtotal_excluding_tax: total,
    tax: null,
    test_clock: null,
    total,
    total_discount_amounts: [],
    total_excluding_tax: total,
    total_tax_amounts: [],
    transfer_data: null,
    webhooks_delivered_at: inv.created,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions (verbatim; see the header)

const SCHEMA = 'http://json-schema.org/draft-07/schema#';

function zobj(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
    $schema: SCHEMA,
  };
}

const LIMIT_10 =
  'A limit on the number of objects to be returned. Limit can range between 1 and 100, and the default is 10.';
const LIMIT_PLAIN =
  'A limit on the number of objects to be returned. Limit can range between 1 and 100.';
const limit = (description: string): Record<string, unknown> => ({
  type: 'integer',
  minimum: 1,
  maximum: 100,
  description,
});

type Ann = NonNullable<SummitTool['annotations']>;
const ann = (title: string, readOnly: boolean, idempotent: boolean, destructive = false): Ann => ({
  destructiveHint: destructive,
  idempotentHint: idempotent,
  openWorldHint: true,
  readOnlyHint: readOnly,
  title,
});

interface Def {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Ann;
}

export const STRIPE_TOOL_DEFS: readonly Def[] = [
  {
    name: 'create_customer',
    description:
      '\nThis tool will create a customer in Stripe.\n\nIt takes two arguments:\n- name (str): The name of the customer.\n- email (str, optional): The email of the customer.\n',
    inputSchema: zobj(
      {
        name: { type: 'string', description: 'The name of the customer' },
        email: { type: 'string', format: 'email', description: 'The email of the customer' },
      },
      ['name'],
    ),
    annotations: ann('Create customer', false, false),
  },
  {
    name: 'list_customers',
    description:
      "\nThis tool will fetch a list of Customers from Stripe.\n\nIt takes two arguments:\n- limit (int, optional): The number of customers to return.\n- email (str, optional): A case-sensitive filter on the list based on the customer's email field.\n",
    inputSchema: zobj({
      limit: limit(LIMIT_PLAIN),
      email: {
        type: 'string',
        description:
          "A case-sensitive filter on the list based on the customer's email field. The value must be a string.",
      },
    }),
    annotations: ann('List customers', true, true),
  },
  {
    name: 'create_product',
    description:
      '\nThis tool will create a product in Stripe.\n\nIt takes two arguments:\n- name (str): The name of the product.\n- description (str, optional): The description of the product.\n',
    inputSchema: zobj(
      {
        name: { type: 'string', description: 'The name of the product.' },
        description: { type: 'string', description: 'The description of the product.' },
      },
      ['name'],
    ),
    annotations: ann('Create product', false, false),
  },
  {
    name: 'list_products',
    description:
      '\nThis tool will fetch a list of Products from Stripe.\n\nIt takes one optional argument:\n- limit (int, optional): The number of products to return.\n',
    inputSchema: zobj({ limit: limit(LIMIT_10) }),
    annotations: ann('List products', true, true),
  },
  {
    name: 'create_price',
    description:
      '\nThis tool will create a price in Stripe. If a product has not already been specified, a product should be created first.\n\nIt takes three arguments:\n- product (str): The ID of the product to create the price for.\n- unit_amount (int): The unit amount of the price in cents.\n- currency (str): The currency of the price.\n',
    inputSchema: zobj(
      {
        product: { type: 'string', description: 'The ID of the product to create the price for.' },
        unit_amount: { type: 'integer', description: 'The unit amount of the price in cents.' },
        currency: { type: 'string', description: 'The currency of the price.' },
      },
      ['product', 'unit_amount', 'currency'],
    ),
    annotations: ann('Create price', false, false),
  },
  {
    name: 'list_prices',
    description:
      '\nThis tool will fetch a list of Prices from Stripe.\n\nIt takes two arguments.\n- product (str, optional): The ID of the product to list prices for.\n- limit (int, optional): The number of prices to return.\n',
    inputSchema: zobj({
      product: { type: 'string', description: 'The ID of the product to list prices for.' },
      limit: limit(LIMIT_10),
    }),
    annotations: ann('List prices', true, true),
  },
  {
    name: 'create_payment_link',
    description:
      '\nThis tool will create a payment link in Stripe.\n\nIt takes two arguments:\n- price (str): The ID of the price to create the payment link for.\n- quantity (int): The quantity of the product to include in the payment link.\n- redirect_url (str, optional): The URL to redirect to after the payment is completed.\n',
    inputSchema: zobj(
      {
        price: {
          type: 'string',
          description: 'The ID of the price to create the payment link for.',
        },
        quantity: { type: 'integer', description: 'The quantity of the product to include.' },
        redirect_url: {
          type: 'string',
          description: 'The URL to redirect to after the payment is completed.',
        },
      },
      ['price', 'quantity'],
    ),
    annotations: ann('Create payment link', false, false),
  },
  {
    name: 'create_invoice',
    description:
      '\n  This tool will create an invoice in Stripe.\n  \n  It takes two arguments:\n  - customer (str): The ID of the customer to create the invoice for.\n\n  - days_until_due (int, optional): The number of days until the invoice is due.\n  ',
    inputSchema: zobj(
      {
        customer: {
          type: 'string',
          description: 'The ID of the customer to create the invoice for.',
        },
        days_until_due: {
          type: 'integer',
          description: 'The number of days until the invoice is due.',
        },
      },
      ['customer'],
    ),
    annotations: ann('Create invoice', false, false),
  },
  {
    name: 'list_invoices',
    description:
      '\nThis tool will fetch a list of Invoices from Stripe.\n\nIt takes two arguments:\n- customer (str, optional): The ID of the customer to list invoices for.\n\n- limit (int, optional): The number of invoices to return.\n',
    inputSchema: zobj({
      customer: { type: 'string', description: 'The ID of the customer to list invoices for.' },
      limit: limit(LIMIT_10),
    }),
    annotations: ann('List invoices', true, true),
  },
  {
    name: 'create_invoice_item',
    description:
      "\nThis tool will create an invoice item in Stripe.\n\nIt takes three arguments'}:\n- customer (str): The ID of the customer to create the invoice item for.\n\n- price (str): The ID of the price to create the invoice item for.\n- invoice (str): The ID of the invoice to create the invoice item for.\n",
    inputSchema: zobj(
      {
        customer: {
          type: 'string',
          description: 'The ID of the customer to create the invoice item for.',
        },
        price: { type: 'string', description: 'The ID of the price for the item.' },
        invoice: { type: 'string', description: 'The ID of the invoice to create the item for.' },
      },
      ['customer', 'price', 'invoice'],
    ),
    annotations: ann('Create invoice item', false, false),
  },
  {
    name: 'finalize_invoice',
    description:
      '\nThis tool will finalize an invoice in Stripe.\n\nIt takes one argument:\n- invoice (str): The ID of the invoice to finalize.\n',
    inputSchema: zobj(
      { invoice: { type: 'string', description: 'The ID of the invoice to finalize.' } },
      ['invoice'],
    ),
    annotations: ann('Finalize invoice', false, true),
  },
  {
    name: 'retrieve_balance',
    description: '\nThis tool will retrieve the balance from Stripe. It takes no input.\n',
    inputSchema: zobj({}),
    annotations: ann('Retrieve balance', true, true),
  },
  {
    name: 'create_refund',
    description:
      '\nThis tool will refund a payment intent in Stripe.\n\nIt takes three arguments:\n- payment_intent (str): The ID of the payment intent to refund.\n- amount (int, optional): The amount to refund in cents.\n- reason (str, optional): The reason for the refund.\n',
    inputSchema: zobj(
      {
        payment_intent: { type: 'string', description: 'The ID of the PaymentIntent to refund.' },
        amount: { type: 'integer', description: 'The amount to refund in cents.' },
      },
      ['payment_intent'],
    ),
    annotations: ann('Create refund', false, false),
  },
  {
    name: 'list_payment_intents',
    description:
      '\nThis tool will list payment intents in Stripe.\n\nIt takes two arguments:\n- customer (str, optional): The ID of the customer to list payment intents for.\n\n- limit (int, optional): The number of payment intents to return.\n',
    inputSchema: zobj({
      customer: {
        type: 'string',
        description: 'The ID of the customer to list payment intents for.',
      },
      limit: limit(LIMIT_PLAIN),
    }),
    annotations: ann('List payment intents', true, true),
  },
  {
    name: 'list_subscriptions',
    description:
      '\nThis tool will list all subscriptions in Stripe.\n\nIt takes four arguments:\n- customer (str, optional): The ID of the customer to list subscriptions for.\n\n- price (str, optional): The ID of the price to list subscriptions for.\n- status (str, optional): The status of the subscriptions to list.\n- limit (int, optional): The number of subscriptions to return.\n',
    inputSchema: zobj({
      customer: {
        type: 'string',
        description: 'The ID of the customer to list subscriptions for.',
      },
      price: { type: 'string', description: 'The ID of the price to list subscriptions for.' },
      status: {
        type: 'string',
        enum: [
          'active',
          'past_due',
          'unpaid',
          'canceled',
          'incomplete',
          'incomplete_expired',
          'trialing',
          'all',
        ],
        description: 'The status of the subscriptions to retrieve.',
      },
      limit: limit(LIMIT_PLAIN),
    }),
    annotations: ann('List subscriptions', true, true),
  },
  {
    name: 'cancel_subscription',
    description:
      '\nThis tool will cancel a subscription in Stripe.\n\nIt takes the following arguments:\n- subscription (str, required): The ID of the subscription to cancel.\n',
    inputSchema: zobj(
      { subscription: { type: 'string', description: 'The ID of the subscription to cancel.' } },
      ['subscription'],
    ),
    annotations: ann('Cancel subscription', false, true, true),
  },
  {
    name: 'update_subscription',
    description:
      "This tool will update an existing subscription in Stripe. If changing an existing subscription item, the existing subscription item has to be set to deleted and the new one has to be added.\n  \n  It takes the following arguments:\n  - subscription (str, required): The ID of the subscription to update.\n  - proration_behavior (str, optional): Determines how to handle prorations when the subscription items change. Options: 'create_prorations', 'none', 'always_invoice', 'none_implicit'.\n  - items (array, optional): A list of subscription items to update, add, or remove. Each item can have the following properties:\n    - id (str, optional): The ID of the subscription item to modify.\n    - price (str, optional): The ID of the price to switch to.\n    - quantity (int, optional): The quantity of the plan to subscribe to.\n    - deleted (bool, optional): Whether to delete this item.\n  ",
    inputSchema: zobj(
      {
        subscription: { type: 'string', description: 'The ID of the subscription to update.' },
        proration_behavior: {
          type: 'string',
          enum: ['create_prorations', 'none', 'always_invoice', 'none_implicit'],
          description: 'Determines how to handle prorations when the subscription items change.',
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'The ID of the subscription item to modify.' },
              price: { type: 'string', description: 'The ID of the price to switch to.' },
              quantity: {
                type: 'integer',
                minimum: 1,
                description: 'The quantity of the plan to subscribe to.',
              },
              deleted: { type: 'boolean', description: 'Whether to delete this item.' },
            },
            additionalProperties: false,
          },
          description: 'A list of subscription items to update, add, or remove.',
        },
      },
      ['subscription'],
    ),
    annotations: ann('Update subscription', false, false),
  },
  {
    name: 'search_stripe_documentation',
    description:
      '\nThis tool will take in a user question about integrating with Stripe in their application, then search and retrieve relevant Stripe documentation to answer the question.\n\nIt takes two arguments:\n- question (str): The user question to search an answer for in the Stripe documentation.\n- language (str, optional): The programming language to search for in the the documentation.\n',
    inputSchema: zobj(
      {
        question: {
          type: 'string',
          description:
            'The user question about integrating with Stripe will be used to search the documentation.',
        },
        language: {
          type: 'string',
          enum: ['dotnet', 'go', 'java', 'node', 'php', 'ruby', 'python', 'curl'],
          description: 'The programming language to search for in the the documentation.',
        },
      },
      ['question'],
    ),
    annotations: ann('Search Stripe documentation', true, true),
  },
  {
    name: 'list_coupons',
    description:
      '\nThis tool will fetch a list of Coupons from Stripe.\n\nIt takes one optional argument:\n- limit (int, optional): The number of coupons to return.\n',
    inputSchema: zobj({ limit: limit(LIMIT_PLAIN) }),
    annotations: ann('List coupons', true, true),
  },
  {
    name: 'create_coupon',
    description:
      "\nThis tool will create a coupon in Stripe.\n\nIt takes several arguments:\n- name (str): The name of the coupon.\n\nOnly use one of percent_off or amount_off, not both:\n- percent_off (number, optional): The percentage discount to apply (between 0 and 100).\n- amount_off (number, optional): The amount to subtract from an invoice (in cents).\n\nOptional arguments for duration. Use if specific duration is desired, otherwise default to 'once'.\n- duration (str, optional): How long the discount will last ('once', 'repeating', or 'forever'). Defaults to 'once'.\n- duration_in_months (number, optional): The number of months the discount will last if duration is repeating.\n",
    inputSchema: zobj(
      {
        name: {
          type: 'string',
          description: 'Name of the coupon displayed to customers on invoices or receipts',
        },
        percent_off: {
          type: 'number',
          minimum: 0,
          maximum: 100,
          description:
            'A positive float larger than 0, and smaller or equal to 100, that represents the discount the coupon will apply (required if amount_off is not passed)',
        },
        amount_off: {
          type: 'number',
          description:
            'A positive integer representing the amount to subtract from an invoice total (required if percent_off is not passed)',
        },
        currency: {
          type: 'string',
          default: 'USD',
          description:
            'Three-letter ISO code for the currency of the amount_off parameter (required if amount_off is passed). Infer based on the amount_off. For example, if a coupon is $2 off, set currency to be USD.',
        },
        duration: {
          type: 'string',
          enum: ['once', 'repeating', 'forever'],
          default: 'once',
          description: 'How long the discount will last. Defaults to "once"',
        },
        duration_in_months: {
          type: 'number',
          description: 'The number of months the discount will last if duration is repeating',
        },
      },
      ['name', 'amount_off'],
    ),
    annotations: ann('Create coupon', false, false),
  },
  {
    name: 'update_dispute',
    description:
      "\nWhen you receive a dispute, contacting your customer is always the best first step. If that doesn't work, you can submit evidence to help resolve the dispute in your favor. This tool helps.\n\nIt takes the following arguments:\n- dispute (string): The ID of the dispute to update\n- evidence (object, optional): Evidence to upload for the dispute.\n    - cancellation_policy_disclosure (string)\n    - cancellation_rebuttal (string)\n    - duplicate_charge_explanation (string)\n    - uncategorized_text (string, optional): Any additional evidence or statements.\n- submit (boolean, optional): Whether to immediately submit evidence to the bank. If false, evidence is staged on the dispute.\n",
    inputSchema: zobj(
      {
        dispute: { type: 'string', description: 'The ID of the dispute to update' },
        evidence: {
          type: 'object',
          properties: {
            cancellation_policy_disclosure: {
              type: 'string',
              maxLength: 20000,
              description:
                'An explanation of how and when the customer was shown your refund policy prior to purchase.',
            },
            duplicate_charge_explanation: {
              type: 'string',
              maxLength: 20000,
              description:
                'An explanation of the difference between the disputed charge versus the prior charge that appears to be a duplicate.',
            },
            uncategorized_text: {
              type: 'string',
              maxLength: 20000,
              description: 'Any additional evidence or statements.',
            },
          },
          additionalProperties: false,
          description:
            'Evidence to upload, to respond to a dispute. Updating any field in the hash will submit all fields in the hash for review.',
        },
        submit: {
          type: 'boolean',
          description:
            'Whether to immediately submit evidence to the bank. If false, evidence is staged on the dispute.',
        },
      },
      ['dispute'],
    ),
    annotations: ann('Update dispute', false, false),
  },
  {
    name: 'list_disputes',
    description:
      '\nThis tool will fetch a list of disputes in Stripe.\n\nIt takes the following arguments:\n- charge (string, optional): Only return disputes associated to the charge specified by this charge ID.\n- payment_intent (string, optional): Only return disputes associated to the PaymentIntent specified by this PaymentIntent ID.\n',
    inputSchema: zobj({
      charge: {
        type: 'string',
        description: 'Only return disputes associated to the charge specified by this charge ID.',
      },
      payment_intent: {
        type: 'string',
        description:
          'Only return disputes associated to the PaymentIntent specified by this PaymentIntent ID.',
      },
      limit: { ...limit(LIMIT_10), default: 10 },
    }),
    annotations: ann('List disputes', true, true),
  },
];

/** The tool names that change the account. */
export const STRIPE_WRITE_TOOLS: readonly string[] = STRIPE_TOOL_DEFS.filter(
  (d) => d.annotations?.readOnlyHint === false,
).map((d) => d.name);

// ---------------------------------------------------------------------------
// Handlers

const fail = (message: string): BoxResult => compactJson(message);

function take<T extends { created: number }>(items: readonly T[], args: Args): T[] {
  const n = num(args, 'limit') ?? 10;
  return items.toSorted((a, b) => b.created - a.created || 0).slice(0, n);
}

function newId(state: StripeState, prefix: string): string {
  state.seq += 1;
  return `${prefix}${idFrom(prng(77_000 + state.seq), prefix.startsWith('re_') ? 22 : 20, ALNUM)}`;
}

const NOW = epoch('2026-10-28T15:00:00Z');

function handlers(state: StripeState): Record<string, (args: Args) => BoxResult> {
  const sub = (id: string | undefined): StripeSubscription | undefined =>
    state.subscriptions.find((s) => s.id === id);
  return {
    create_customer: (args) => {
      const id = newId(state, 'cus_');
      state.customers.push({
        id,
        name: str(args, 'name') ?? '',
        email: str(args, 'email') ?? '',
        created: NOW,
        currency: 'usd',
      });
      state.mutations.push({ kind: 'create_customer', id, detail: args });
      return compactJson({ id });
    },
    list_customers: (args) => {
      const email = str(args, 'email');
      const list = state.customers.filter((c) => email === undefined || c.email === email);
      return compactJson(take(list, args).map((c) => ({ id: c.id })));
    },
    create_product: (args) => {
      const p: StripeProduct = {
        id: newId(state, 'prod_'),
        name: str(args, 'name') ?? '',
        description: str(args, 'description') ?? null,
        created: NOW,
        active: true,
      };
      state.products.push(p);
      state.mutations.push({ kind: 'create_product', id: p.id, detail: args });
      return compactJson(renderProduct(p));
    },
    list_products: (args) =>
      compactJson(
        take(
          state.products.filter((p) => p.active),
          args,
        ).map(renderProduct),
      ),
    create_price: (args) => {
      const product = str(args, 'product') ?? '';
      if (!state.products.some((p) => p.id === product)) return fail('Failed to create price');
      const currency = (str(args, 'currency') ?? '').toLowerCase();
      if (currency !== 'usd' && currency !== 'eur') return fail('Failed to create price');
      const p: StripePrice = {
        id: newId(state, 'price_1Q'),
        product,
        unit_amount: num(args, 'unit_amount') ?? 0,
        currency,
        interval: null,
        nickname: null,
        active: true,
        created: NOW,
        lookup_key: null,
      };
      state.prices.push(p);
      state.mutations.push({ kind: 'create_price', id: p.id, detail: args });
      return compactJson(renderPrice(p));
    },
    list_prices: (args) => {
      const product = str(args, 'product');
      return compactJson(
        take(
          state.prices.filter((p) => p.active && (product === undefined || p.product === product)),
          args,
        ).map(renderPrice),
      );
    },
    create_payment_link: (args) => {
      const price = state.prices.find((p) => p.id === str(args, 'price'));
      if (price === undefined || (num(args, 'quantity') ?? 0) < 1)
        return fail('Failed to create payment link');
      const id = newId(state, 'plink_1Q');
      state.mutations.push({ kind: 'create_payment_link', id, detail: args });
      return compactJson({ id, url: `https://buy.stripe.com/${id.slice(8, 20).toLowerCase()}` });
    },
    create_invoice: (args) => {
      const customer = state.customers.find((c) => c.id === str(args, 'customer'));
      if (customer === undefined) return fail('Failed to create invoice');
      const inv: StripeInvoice = {
        id: newId(state, 'in_1Q'),
        number: null,
        customer: customer.id,
        subscription: null,
        status: 'draft',
        amount_due: 0,
        amount_paid: 0,
        created: NOW,
        due_date: NOW + (num(args, 'days_until_due') ?? 30) * 86400,
        period_start: NOW,
        period_end: NOW,
        lines: [],
        collection_method: 'send_invoice',
        payment_intent: null,
        attempt_count: 0,
      };
      state.invoices.push(inv);
      state.mutations.push({ kind: 'create_invoice', id: inv.id, detail: args });
      return compactJson({ id: inv.id, url: null, customer: inv.customer, status: inv.status });
    },
    list_invoices: (args) => {
      const customer = str(args, 'customer');
      return compactJson(
        take(
          state.invoices.filter((i) => customer === undefined || i.customer === customer),
          args,
        ).map((i) => renderInvoice(state, i)),
      );
    },
    create_invoice_item: (args) => {
      const inv = state.invoices.find((i) => i.id === str(args, 'invoice'));
      const price = state.prices.find((p) => p.id === str(args, 'price'));
      if (
        inv === undefined ||
        price === undefined ||
        inv.status !== 'draft' ||
        inv.customer !== str(args, 'customer')
      )
        return fail('Failed to create invoice item');
      inv.lines.push({
        price: price.id,
        quantity: 1,
        amount: price.unit_amount,
        description: productName(price.product),
      });
      inv.amount_due += price.unit_amount;
      const id = newId(state, 'ii_1Q');
      state.mutations.push({ kind: 'create_invoice_item', id, detail: args });
      return compactJson({ id, invoice: inv.id });
    },
    finalize_invoice: (args) => {
      const inv = state.invoices.find((i) => i.id === str(args, 'invoice'));
      if (inv === undefined || inv.status !== 'draft') return fail('Failed to finalize invoice');
      inv.status = 'open';
      inv.number = `FERN-${1311 + state.seq}`;
      state.mutations.push({ kind: 'finalize_invoice', id: inv.id, detail: args });
      const r = renderInvoice(state, inv);
      return compactJson({
        id: inv.id,
        url: r['hosted_invoice_url'],
        customer: inv.customer,
        status: inv.status,
      });
    },
    retrieve_balance: () =>
      compactJson({
        object: 'balance',
        available: [
          { amount: 18_422_317, currency: 'usd', source_types: { card: 18_422_317 } },
          { amount: 412_090, currency: 'eur', source_types: { card: 412_090 } },
        ],
        connect_reserved: [{ amount: 0, currency: 'usd' }],
        livemode: true,
        pending: [
          { amount: 3_118_650, currency: 'usd', source_types: { card: 3_118_650 } },
          { amount: 29_700, currency: 'eur', source_types: { card: 29_700 } },
        ],
        refund_and_dispute_prefunding: {
          available: [{ amount: 0, currency: 'usd' }],
          pending: [{ amount: 0, currency: 'usd' }],
        },
      }),
    create_refund: (args) => {
      const pi = state.paymentIntents.find((p) => p.id === str(args, 'payment_intent'));
      if (pi === undefined || pi.status !== 'succeeded') return fail('Failed to create refund');
      const remaining = pi.amount - pi.refunded;
      const amount = num(args, 'amount') ?? remaining;
      if (remaining <= 0 || amount <= 0 || amount > remaining)
        return fail('Failed to create refund');
      pi.refunded += amount;
      const id = newId(state, 're_3Q');
      state.refunds.push({ id, payment_intent: pi.id, amount, created: NOW });
      state.mutations.push({
        kind: 'create_refund',
        id,
        detail: { payment_intent: pi.id, amount },
      });
      return compactJson({ id, status: 'succeeded', amount });
    },
    list_payment_intents: (args) => {
      const customer = str(args, 'customer');
      return compactJson(
        take(
          state.paymentIntents.filter((p) => customer === undefined || p.customer === customer),
          args,
        ).map(renderPaymentIntent),
      );
    },
    list_subscriptions: (args) => {
      const customer = str(args, 'customer');
      const price = str(args, 'price');
      const status = str(args, 'status');
      const list = state.subscriptions.filter(
        (s) =>
          (customer === undefined || s.customer === customer) &&
          (price === undefined || s.items.some((i) => i.price === price)) &&
          (status === 'all' ||
            (status === undefined ? s.status !== 'canceled' : s.status === status)),
      );
      return compactJson(take(list, args).map((s) => renderSubscription(state, s)));
    },
    cancel_subscription: (args) => {
      const s = sub(str(args, 'subscription'));
      if (s === undefined || s.status === 'canceled') return fail('Failed to cancel subscription');
      s.status = 'canceled';
      s.canceled_at = NOW;
      state.mutations.push({ kind: 'cancel_subscription', id: s.id, detail: {} });
      return compactJson(renderSubscription(state, s));
    },
    update_subscription: (args) => {
      const s = sub(str(args, 'subscription'));
      if (s === undefined || s.status === 'canceled') return fail('Failed to update subscription');
      const items = Array.isArray(args['items']) ? (args['items'] as Args[]) : [];
      for (const it of items) {
        const id = str(it, 'id');
        const existing = s.items.find((x) => x.id === id);
        if (id !== undefined && existing === undefined)
          return fail('Failed to update subscription');
        if (existing !== undefined) {
          if (it['deleted'] === true) s.items = s.items.filter((x) => x !== existing);
          else {
            const price = str(it, 'price');
            if (price !== undefined) {
              if (!state.prices.some((p) => p.id === price))
                return fail('Failed to update subscription');
              existing.price = price;
            }
            const q = num(it, 'quantity');
            if (q !== undefined) existing.quantity = q;
          }
        } else {
          const price = str(it, 'price');
          if (price === undefined || !state.prices.some((p) => p.id === price))
            return fail('Failed to update subscription');
          s.items.push({ id: newId(state, 'si_'), price, quantity: num(it, 'quantity') ?? 1 });
        }
      }
      state.mutations.push({ kind: 'update_subscription', id: s.id, detail: args });
      return compactJson(renderSubscription(state, s));
    },
    search_stripe_documentation: () => compactJson([]),
    list_coupons: (args) =>
      compactJson(
        take(state.coupons, args).map((c) => ({
          id: c.id,
          name: c.name,
          percent_off: c.percent_off,
          amount_off: c.amount_off,
          duration: c.duration,
        })),
      ),
    create_coupon: (args) => {
      const pct = num(args, 'percent_off');
      const amt = num(args, 'amount_off');
      if (pct !== undefined && amt !== undefined)
        return fail(
          'Failed to create coupon: You may only specify one of these parameters: amount_off, percent_off.',
        );
      if (amt !== undefined && (!Number.isInteger(amt) || amt <= 0))
        return fail('Failed to create coupon: Invalid positive integer');
      const id = idFrom(prng(31_000 + state.seq++), 8, ALNUM);
      state.coupons.push({
        id,
        name: str(args, 'name') ?? '',
        percent_off: pct ?? null,
        amount_off: amt ?? null,
        duration: str(args, 'duration') ?? 'once',
        created: NOW,
      });
      state.mutations.push({ kind: 'create_coupon', id, detail: args });
      return compactJson({ id });
    },
    update_dispute: (args) => {
      const d = state.disputes.find((x) => x.id === str(args, 'dispute'));
      if (d === undefined || d.status !== 'needs_response') return fail('Failed to update dispute');
      Object.assign(d.evidence, (args['evidence'] as Record<string, string> | undefined) ?? {});
      if (args['submit'] === true) d.status = 'under_review';
      state.mutations.push({ kind: 'update_dispute', id: d.id, detail: args });
      return compactJson({ id: d.id });
    },
    list_disputes: (args) => {
      const pi = str(args, 'payment_intent');
      const charge = str(args, 'charge');
      const list = state.disputes.filter(
        (d) =>
          (pi === undefined || d.payment_intent === pi) &&
          (charge === undefined ||
            state.paymentIntents.find((p) => p.id === d.payment_intent)?.latest_charge === charge),
      );
      return compactJson(take(list, args).map((d) => ({ id: d.id })));
    },
  };
}

export function createStripeBox(
  state: StripeState,
  onCall?: (call: SideEffect) => void,
): SummitBox {
  const h = handlers(state);
  const tools: SummitTool[] = STRIPE_TOOL_DEFS.map((def) => ({
    ...def,
    handler: h[def.name] as (args: Args) => BoxResult,
  }));
  return createSummitBox({ name: 'Stripe', version: '0.4.0' }, tools, onCall, { validate: true });
}

// ---------------------------------------------------------------------------
// Derived facts (for the tasks and tests)

/** Monthly amount (cents, unrounded) of a subscription: Σ unit × qty, yearly ÷ 12. */
export function monthlyCents(state: StripeState, s: StripeSubscription): number {
  return s.items.reduce((n, it) => {
    const p = state.prices.find((x) => x.id === it.price) as StripePrice;
    return n + (p.unit_amount * it.quantity) / (p.interval === 'year' ? 12 : 1);
  }, 0);
}
