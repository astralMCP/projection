/**
 * The messy world's `billing` box: Northwind's billing-platform admin API
 * as an OpenAPI-to-MCP generator serves it — one tool per operation, 300+
 * of them, the way auto-generated servers expose a payments-style REST API
 * (cloudflare/mcp lists 2,594 operations with code mode off; generated
 * servers over a payments OpenAPI document produce several hundred).
 *
 * What the generator does, and real ones do too:
 *
 * - tool names are the spec's operationIds (`GetCustomersCustomer`,
 *   `PostInvoicesInvoicePay`): a `Post…` on an item path is an update;
 * - descriptions are the spec's HTML descriptions (`<p>Retrieves …</p>`),
 *   empty where the spec has none; path parameters have no description;
 * - a request body is nested under one `requestBody` argument;
 * - query parameters keep the API's quirks: `expand`, `created` as an
 *   `anyOf` of a range object and an integer, `metadata` as an `anyOf` of
 *   an object and `""`;
 * - no annotations at all;
 * - pagination is whatever each endpoint does: cursor lists
 *   (`limit`/`starting_after`, `has_more`), page-numbered lists
 *   (`page`/`per_page`, no `has_more`, no total) and offset lists
 *   (`offset`/`limit`, with `total`), plus search endpoints with a query
 *   language and a `next_page` token;
 * - money in minor units, instants in epoch seconds;
 * - errors are the API's JSON error object, flagged `isError`.
 *
 * Seven resources hold data (customers, invoices, charges, refunds,
 * subscriptions, coupons, feature flags); every other operation answers
 * the way the API would for an empty account: an empty list, a
 * `resource_missing` 404, or — for a create — the created object.
 * Every write is recorded in `mutations`.
 *
 * Nothing reads the clock: "now" is WORLD_NOW (2026-10-14T12:00:00Z).
 */

import type { SideEffect } from '../types.js';
import {
  argNumber,
  argString,
  createFakeBox,
  epochSeconds,
  json,
  toolError,
  type FakeArgs,
  type FakeBox,
  type FakeReply,
  type FakeTool,
} from './workplace-fake.js';
import { WORLD_NOW } from './workplace-people.js';

// ---------------------------------------------------------------------------
// Fixture data

export interface BillingAddress {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
}

export interface BillingCustomer {
  id: string;
  object: 'customer';
  name: string;
  email: string;
  created: number;
  currency: 'usd';
  delinquent: boolean;
  address: BillingAddress;
  metadata: Record<string, string>;
}

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';

export interface BillingInvoice {
  id: string;
  object: 'invoice';
  number: string;
  customer: string;
  customer_name: string;
  status: InvoiceStatus;
  amount_due: number;
  amount_paid: number;
  currency: 'usd';
  created: number;
  due_date: number | null;
  charge: string | null;
}

export interface BillingCharge {
  id: string;
  object: 'charge';
  amount: number;
  amount_refunded: number;
  currency: 'usd';
  customer: string;
  invoice: string | null;
  created: number;
  status: 'succeeded' | 'failed';
  paid: boolean;
  refunded: boolean;
  description: string;
}

export interface BillingRefund {
  id: string;
  object: 'refund';
  charge: string;
  amount: number;
  reason: string | null;
  status: 'succeeded';
  created: number;
  metadata: Record<string, string>;
}

export interface BillingSubscription {
  id: string;
  object: 'subscription';
  customer: string;
  status: 'active' | 'canceled' | 'past_due' | 'trialing';
  price: string;
  current_period_end: number;
  created: number;
}

export interface BillingCoupon {
  id: string;
  object: 'coupon';
  name: string | null;
  percent_off: number | null;
  amount_off: number | null;
  currency: string | null;
  duration: 'once' | 'repeating' | 'forever';
  duration_in_months: number | null;
  max_redemptions: number | null;
  times_redeemed: number;
  valid: boolean;
  created: number;
}

export interface FeatureFlag {
  key: string;
  name: string;
  enabled: boolean;
  rollout_percentage: number;
  updated: number;
}

export interface FlagOverride {
  id: string;
  flag: string;
  customer: string;
  enabled: boolean;
  created: number;
}

export interface BillingMutation {
  tool: string;
  args: Record<string, unknown>;
}

export interface BillingState {
  customers: BillingCustomer[];
  invoices: BillingInvoice[];
  charges: BillingCharge[];
  refunds: BillingRefund[];
  subscriptions: BillingSubscription[];
  coupons: BillingCoupon[];
  flags: FeatureFlag[];
  overrides: FlagOverride[];
  /** Every write operation that succeeded, in order. */
  mutations: BillingMutation[];
}

function hashHex(text: string, length: number): string {
  let a = 2166136261;
  let b = 5381;
  for (let i = 0; i < text.length; i += 1) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619) >>> 0;
    b = (Math.imul(b, 33) + text.charCodeAt(i)) >>> 0;
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  let x = a;
  let y = b;
  while (out.length < length) {
    out += alphabet[((x ^ y) >>> 0) % alphabet.length];
    x = Math.imul(x, 1103515245) + 12345;
    x >>>= 0;
    y = (y >>> 3) | ((y & 7) << 29);
    y = (y + 0x9e3779b9) >>> 0;
  }
  return out;
}

/** A Stripe-looking ID for `key`. */
export function billingId(prefix: string, key: string): string {
  return `${prefix}_${hashHex(`${prefix}:${key}`, 14)}`;
}

const at = (iso: string): number => epochSeconds(iso);
export const NOW_EPOCH = at(WORLD_NOW);

/** Customer names in creation order; the named ones are referenced by the tasks. */
const CUSTOMER_SEEDS: readonly [
  name: string,
  email: string,
  ref: string,
  city: string,
  st: string,
][] = [
  ['Acme Retail', 'billing@acme-retail.example', 'acct_acme_0001', 'Denver', 'CO'],
  ['Initech', 'it@initech.example', 'acct_initech_0007', 'Austin', 'TX'],
  ['Hooli', 'ap@hooli.example', 'acct_hooli_0011', 'Palo Alto', 'CA'],
  ['Umbrella Health', 'finance@umbrella.example', 'acct_umbrella_0013', 'Raccoon City', 'MO'],
  ['Globex Corporation', 'ops@globex.example', 'acct_globex_0042', 'Cypress Creek', 'OR'],
  ['Soylent Foods', 'ap@soylent.example', 'acct_soylent_0051', 'Newark', 'NJ'],
  ['Wonka Industries', 'accounts@wonka.example', 'acct_wonka_0058', 'Chicago', 'IL'],
  ['Vandelay Imports', 'art@vandelay.example', 'acct_vandelay_0063', 'New York', 'NY'],
  ['Initrode', 'billing@initrode.example', 'acct_initrode_0070', 'Dallas', 'TX'],
  ['Stark Logistics', 'ap@starklog.example', 'acct_stark_0077', 'Long Island', 'NY'],
  ['Tyrell Systems', 'finance@tyrell.example', 'acct_tyrell_0081', 'Los Angeles', 'CA'],
  ['Cyberdyne', 'ap@cyberdyne.example', 'acct_cyberdyne_0089', 'Sunnyvale', 'CA'],
  ['Pied Piper', 'billing@piedpiper.example', 'acct_piedpiper_0094', 'Palo Alto', 'CA'],
  ['Massive Dynamic', 'ap@massive.example', 'acct_massive_0101', 'Boston', 'MA'],
  ['Oscorp', 'payables@oscorp.example', 'acct_oscorp_0108', 'New York', 'NY'],
  ['Duff Brewing', 'office@duff.example', 'acct_duff_0112', 'Springfield', 'IL'],
  ['Globex Holdings', 'treasury@globexholdings.example', 'acct_globex_0119', 'Portland', 'OR'],
  ['Aperture Labs', 'ap@aperture.example', 'acct_aperture_0123', 'Cleveland', 'OH'],
  ['Black Mesa', 'billing@blackmesa.example', 'acct_blackmesa_0130', 'Santa Fe', 'NM'],
  ['Nakatomi Trading', 'ap@nakatomi.example', 'acct_nakatomi_0137', 'Los Angeles', 'CA'],
  ['Dunder Mifflin', 'accounting@dundermifflin.example', 'acct_dunder_0141', 'Scranton', 'PA'],
  ['Bluth Company', 'finance@bluth.example', 'acct_bluth_0148', 'Newport Beach', 'CA'],
  ['Kramerica', 'kramer@kramerica.example', 'acct_kramerica_0150', 'New York', 'NY'],
  ['Sterling Cooper', 'ap@sterlingcooper.example', 'acct_sterling_0157', 'New York', 'NY'],
  ['Prestige Worldwide', 'billing@prestige.example', 'acct_prestige_0161', 'Los Angeles', 'CA'],
  ['Monarch Solutions', 'ap@monarch.example', 'acct_monarch_0168', 'Austin', 'TX'],
  ['Spacely Sprockets', 'billing@spacely.example', 'acct_spacely_0172', 'Orbit City', 'WA'],
  ['Cogswell Cogs', 'ap@cogswell.example', 'acct_cogswell_0179', 'Orbit City', 'WA'],
  ['Wernham Hogg', 'accounts@wernhamhogg.example', 'acct_wernham_0183', 'Seattle', 'WA'],
  ['Zorg Industries', 'finance@zorg.example', 'acct_zorg_0190', 'Phoenix', 'AZ'],
  ['Gringotts Capital', 'ap@gringotts.example', 'acct_gringotts_0194', 'Boston', 'MA'],
  ['Los Pollos Supply', 'ap@lospollos.example', 'acct_lospollos_0201', 'Albuquerque', 'NM'],
  ['Rekall', 'billing@rekall.example', 'acct_rekall_0207', 'Las Vegas', 'NV'],
  ['Sirius Cybernetics', 'ap@sirius.example', 'acct_sirius_0212', 'San Jose', 'CA'],
];

export const CUSTOMER_ID = (name: string): string => billingId('cus', name);

function seedCustomers(): BillingCustomer[] {
  return CUSTOMER_SEEDS.map(([name, email, ref, city, st], i) => ({
    id: CUSTOMER_ID(name),
    object: 'customer',
    name,
    email,
    created: at(`2025-0${1 + (i % 9)}-1${i % 10}T10:00:00Z`),
    currency: 'usd',
    delinquent: false,
    address: {
      line1: `${100 + i * 7} ${['Main', 'Market', 'Oak', 'Pine', 'Cedar'][i % 5]} Street`,
      line2: null,
      city,
      state: st,
      postal_code: String(10_000 + i * 2711).slice(0, 5),
      country: 'US',
    },
    metadata: { account_ref: ref },
  }));
}

/** The duplicate-charge invoice and its two charges (first, then the duplicate). */
export const DUPLICATE_INVOICE = 'INV-88213';
export const DUPLICATE_CHARGES = [
  billingId('ch', 'globex-88213-a'),
  billingId('ch', 'globex-88213-b'),
] as const;
export const DUPLICATE_AMOUNT = 129_900;

/** Open invoices past their due date, by customer (the past-due task). */
export const PAST_DUE_CUSTOMERS = [
  'Hooli',
  'Vandelay Imports',
  'Tyrell Systems',
  'Oscorp',
  'Bluth Company',
] as const;

interface InvoiceSeed {
  number: string;
  customer: string;
  status: InvoiceStatus;
  amount: number;
  created: string;
  due: string | null;
}

function invoiceSeeds(): InvoiceSeed[] {
  const out: InvoiceSeed[] = [];
  // Background: one paid September invoice per customer.
  CUSTOMER_SEEDS.forEach(([name], i) => {
    out.push({
      number: `INV-${88_100 + i * 2}`,
      customer: name,
      status: 'paid',
      amount: 4_900 + ((i * 3_700) % 90_000),
      created: `2026-09-${String(1 + (i % 27)).padStart(2, '0')}T08:00:00Z`,
      due: `2026-09-${String(1 + (i % 27)).padStart(2, '0')}T08:00:00Z`,
    });
  });
  const special: InvoiceSeed[] = [
    // Globex: the double-charged invoice, and its decoy siblings.
    {
      number: DUPLICATE_INVOICE,
      customer: 'Globex Corporation',
      status: 'paid',
      amount: DUPLICATE_AMOUNT,
      created: '2026-10-11T08:00:00Z',
      due: '2026-10-12T08:00:00Z',
    },
    {
      number: 'INV-88271',
      customer: 'Globex Holdings',
      status: 'paid',
      amount: 129_900,
      created: '2026-10-11T08:30:00Z',
      due: '2026-10-12T08:30:00Z',
    },
    // Open and past due.
    o('INV-88220', 'Hooli', 'open', 58_000, '2026-09-20', '2026-10-05'),
    o('INV-88224', 'Vandelay Imports', 'open', 12_500, '2026-09-22', '2026-10-07'),
    o('INV-88229', 'Tyrell Systems', 'open', 240_000, '2026-09-25', '2026-10-10'),
    o('INV-88233', 'Oscorp', 'open', 31_900, '2026-09-27', '2026-10-12'),
    o('INV-88236', 'Oscorp', 'open', 9_900, '2026-10-01', '2026-10-13'),
    o('INV-88241', 'Bluth Company', 'open', 77_700, '2026-09-29', '2026-10-14T06:00:00Z'),
    // Open, due later today or later (not past due yet).
    o('INV-88245', 'Acme Retail', 'open', 19_900, '2026-10-05', '2026-10-14T18:00:00Z'),
    o('INV-88250', 'Pied Piper', 'open', 49_900, '2026-10-08', '2026-10-23'),
    o('INV-88252', 'Dunder Mifflin', 'open', 14_900, '2026-10-09', '2026-11-08'),
    // Past the date, but not open.
    o('INV-88226', 'Kramerica', 'draft', 3_300, '2026-09-23', '2026-10-08'),
    o('INV-88231', 'Sterling Cooper', 'uncollectible', 88_000, '2026-09-26', '2026-10-06'),
    o('INV-88238', 'Duff Brewing', 'void', 4_400, '2026-09-28', '2026-10-09'),
    o('INV-88243', 'Monarch Solutions', 'paid', 15_000, '2026-10-02', '2026-10-09'),
  ];
  return [...out, ...special];
}

function o(
  number: string,
  customer: string,
  status: InvoiceStatus,
  amount: number,
  created: string,
  due: string,
): InvoiceSeed {
  return {
    number,
    customer,
    status,
    amount,
    created: `${created}T09:00:00Z`,
    due: due.includes('T') ? due : `${due}T09:00:00Z`,
  };
}

function seedInvoicesAndCharges(customers: readonly BillingCustomer[]): {
  invoices: BillingInvoice[];
  charges: BillingCharge[];
} {
  const byName = new Map(customers.map((c) => [c.name, c]));
  const invoices: BillingInvoice[] = [];
  const charges: BillingCharge[] = [];
  for (const seed of invoiceSeeds()) {
    const customer = byName.get(seed.customer) as BillingCustomer;
    const id = billingId('in', seed.number);
    let charge: string | null = null;
    if (seed.status === 'paid') {
      if (seed.number === DUPLICATE_INVOICE) {
        const times = ['2026-10-12T09:14:07Z', '2026-10-12T09:16:41Z'];
        DUPLICATE_CHARGES.forEach((chId, i) => {
          charges.push(chargeOf(chId, seed, customer.id, id, at(times[i] as string)));
        });
        charge = DUPLICATE_CHARGES[1];
      } else {
        charge = billingId('ch', seed.number);
        charges.push(chargeOf(charge, seed, customer.id, id, at(seed.created) + 3_600));
      }
    }
    invoices.push({
      id,
      object: 'invoice',
      number: seed.number,
      customer: customer.id,
      customer_name: customer.name,
      status: seed.status,
      amount_due: seed.amount,
      amount_paid: seed.status === 'paid' ? seed.amount : 0,
      currency: 'usd',
      created: at(seed.created),
      due_date: seed.due === null ? null : at(seed.due),
      charge,
    });
  }
  // Globex's October subscription renewal: a charge on the same day with no invoice.
  const globex = byName.get('Globex Corporation') as BillingCustomer;
  charges.push({
    id: billingId('ch', 'globex-addon'),
    object: 'charge',
    amount: 4_900,
    amount_refunded: 0,
    currency: 'usd',
    customer: globex.id,
    invoice: null,
    created: at('2026-10-12T11:02:00Z'),
    status: 'succeeded',
    paid: true,
    refunded: false,
    description: 'Seat add-on (3 seats)',
  });
  return {
    invoices: invoices.toSorted((a, b) => b.created - a.created || a.id.localeCompare(b.id)),
    charges: charges.toSorted((a, b) => b.created - a.created || a.id.localeCompare(b.id)),
  };
}

function chargeOf(
  id: string,
  seed: InvoiceSeed,
  customer: string,
  invoice: string,
  created: number,
): BillingCharge {
  return {
    id,
    object: 'charge',
    amount: seed.amount,
    amount_refunded: 0,
    currency: 'usd',
    customer,
    invoice,
    created,
    status: 'succeeded',
    paid: true,
    refunded: false,
    description: `Payment for invoice ${seed.number}`,
  };
}

export const PRICES = [
  { id: 'price_starter_m', nickname: 'Starter', unit_amount: 2_900, product: 'prod_starter' },
  { id: 'price_pro_m', nickname: 'Pro', unit_amount: 9_900, product: 'prod_pro' },
  { id: 'price_business_m', nickname: 'Business', unit_amount: 49_900, product: 'prod_business' },
] as const;

/** [price, status, count] in creation order, interleaved below. */
const SUBSCRIPTION_MIX: readonly [string, BillingSubscription['status'], number][] = [
  ['price_pro_m', 'active', 17],
  ['price_pro_m', 'canceled', 4],
  ['price_starter_m', 'active', 10],
  ['price_starter_m', 'trialing', 3],
  ['price_starter_m', 'canceled', 3],
  ['price_business_m', 'active', 6],
  ['price_business_m', 'past_due', 2],
];

export const ACTIVE_PRO_COUNT = 17;

function seedSubscriptions(customers: readonly BillingCustomer[]): BillingSubscription[] {
  const flat: [string, BillingSubscription['status']][] = [];
  const queues = SUBSCRIPTION_MIX.map(([p, s, n]) => ({ p, s, n }));
  while (queues.some((q) => q.n > 0)) {
    for (const q of queues) {
      if (q.n > 0) {
        flat.push([q.p, q.s]);
        q.n -= 1;
      }
    }
  }
  return flat.map(([price, status], i) => {
    const customer = customers[i % customers.length] as BillingCustomer;
    const created = at(`2025-${String(1 + (i % 12)).padStart(2, '0')}-0${1 + (i % 9)}T12:00:00Z`);
    return {
      id: billingId('sub', `${i}`),
      object: 'subscription',
      customer: customer.id,
      status,
      price,
      current_period_end: at(`2026-11-${String(1 + (i % 28)).padStart(2, '0')}T12:00:00Z`),
      created,
    };
  });
}

/** The flag the override task changes. */
export const CHECKOUT_FLAG = 'new-checkout-flow';

export function seedBilling(): BillingState {
  const customers = seedCustomers();
  const { invoices, charges } = seedInvoicesAndCharges(customers);
  const globex = CUSTOMER_ID('Globex Corporation');
  return {
    customers,
    invoices,
    charges,
    refunds: [],
    subscriptions: seedSubscriptions(customers),
    coupons: [
      coupon('SUMMER15', 'Summer 15', 15, 'repeating', 2, at('2026-06-01T00:00:00Z'), false),
      coupon('WELCOME10', 'Welcome 10%', 10, 'once', null, at('2025-01-10T00:00:00Z'), true),
      coupon('FALL2025', 'Fall 2025', 20, 'repeating', 3, at('2025-09-01T00:00:00Z'), false),
    ],
    flags: [
      flag(CHECKOUT_FLAG, 'New checkout flow', true, 100),
      flag('usage-based-billing', 'Usage-based billing beta', false, 0),
      flag('invoice-pdf-v2', 'Invoice PDF renderer v2', true, 50),
      flag('smart-retries', 'Smart payment retries', true, 100),
      flag('new-checkout-flow-eu', 'New checkout flow (EU)', false, 0),
    ],
    overrides: [
      {
        id: billingId('ffo', 'globex'),
        flag: 'usage-based-billing',
        customer: globex,
        enabled: true,
        created: at('2026-09-15T10:00:00Z'),
      },
    ],
    mutations: [],
  };
}

function coupon(
  id: string,
  name: string,
  pct: number,
  duration: BillingCoupon['duration'],
  months: number | null,
  created: number,
  valid: boolean,
): BillingCoupon {
  return {
    id,
    object: 'coupon',
    name,
    percent_off: pct,
    amount_off: null,
    currency: null,
    duration,
    duration_in_months: months,
    max_redemptions: null,
    times_redeemed: 3,
    valid,
    created,
  };
}

function flag(key: string, name: string, enabled: boolean, rollout: number): FeatureFlag {
  return { key, name, enabled, rollout_percentage: rollout, updated: at('2026-10-01T09:00:00Z') };
}

// ---------------------------------------------------------------------------
// The generated catalog

type Paging = 'cursor' | 'page' | 'offset';
type Op = 'list' | 'create' | 'get' | 'update' | 'delete';

interface Resource {
  /** URL segment(s) under /v1, e.g. `feature_flags` or `radar/value_lists`. */
  path: string;
  /** The path parameter for one item (`customer`, `flag_key`). */
  param: string;
  ops: readonly Op[];
  /** POST /v1/{path}/{param}/{action}. */
  actions?: readonly string[];
  /** GET /v1/{path}/{param}/{sub}. */
  subs?: readonly string[];
  /** GET /v1/{path}/search. */
  search?: boolean;
  paging?: Paging;
  /** The create/update body's properties. */
  body?: Record<string, Record<string, unknown>>;
  /** Spec has no description for this resource's operations. */
  bare?: boolean;
}

const STR = { type: 'string', maxLength: 5000 } as const;
const META = {
  anyOf: [
    { type: 'object', additionalProperties: { type: 'string' } },
    { type: 'string', enum: [''] },
  ],
} as const;
const ADDRESS = {
  type: 'object',
  title: 'optional_fields_customer_address',
  properties: {
    city: STR,
    country: STR,
    line1: STR,
    line2: STR,
    postal_code: STR,
    state: STR,
  },
} as const;

const CRUD: readonly Op[] = ['list', 'create', 'get', 'update', 'delete'];
const LCRU: readonly Op[] = ['list', 'create', 'get', 'update'];
const LR: readonly Op[] = ['list', 'get'];

/** The API's resources, in the spec's order. */
export const BILLING_RESOURCES: readonly Resource[] = [
  {
    path: 'accounts',
    param: 'account',
    ops: CRUD,
    actions: ['reject'],
    subs: ['capabilities', 'persons'],
  },
  { path: 'application_fees', param: 'id', ops: LR, subs: ['refunds'] },
  {
    path: 'apple_pay/domains',
    param: 'domain',
    ops: ['list', 'create', 'get', 'delete'],
    bare: true,
  },
  { path: 'balance_transactions', param: 'id', ops: LR },
  {
    path: 'billing_portal/configurations',
    param: 'configuration',
    ops: LCRU,
    bare: true,
  },
  {
    path: 'charges',
    param: 'charge',
    ops: LCRU,
    actions: ['capture'],
    subs: ['refunds'],
    search: true,
    body: { description: STR, metadata: META, receipt_email: STR },
  },
  {
    path: 'checkout/sessions',
    param: 'session',
    ops: ['list', 'create', 'get'],
    actions: ['expire'],
    subs: ['line_items'],
  },
  {
    path: 'coupons',
    param: 'coupon',
    ops: CRUD,
    body: {
      id: {
        ...STR,
        description:
          'Unique string of your choice that will be used to identify this coupon when applying it to a customer. If you don’t want to specify a particular code, you can leave the ID blank and we’ll generate a random code for you.',
      },
      name: {
        ...STR,
        description:
          'Name of the coupon displayed to customers on, for instance invoices, or receipts. By default the `id` is shown if `name` is not set.',
      },
      percent_off: {
        type: 'number',
        description:
          'A positive float larger than 0, and smaller or equal to 100, that represents the discount the coupon will apply (required if `amount_off` is not passed).',
      },
      amount_off: {
        type: 'integer',
        description:
          'A positive integer representing the amount to subtract from an invoice total (required if `percent_off` is not passed).',
      },
      currency: {
        type: 'string',
        description:
          'Three-letter ISO code for the currency of the `amount_off` parameter (required if `amount_off` is passed).',
      },
      duration: {
        type: 'string',
        enum: ['forever', 'once', 'repeating'],
        description:
          'Specifies how long the discount will be in effect if used on a subscription. Defaults to `once`.',
      },
      duration_in_months: {
        type: 'integer',
        description:
          'Required only if `duration` is `repeating`, in which case it must be a positive integer that specifies the number of months the discount will be in effect.',
      },
      max_redemptions: {
        type: 'integer',
        description:
          'A positive integer specifying the number of times the coupon can be redeemed before it’s no longer valid.',
      },
      redeem_by: {
        type: 'integer',
        description: 'Unix timestamp specifying the last time at which the coupon can be redeemed.',
      },
      metadata: META,
    },
  },
  { path: 'credit_notes', param: 'id', ops: LCRU, actions: ['void'], subs: ['lines'] },
  {
    path: 'customers',
    param: 'customer',
    ops: CRUD,
    subs: [
      'balance_transactions',
      'cash_balance',
      'payment_methods',
      'sources',
      'tax_ids',
      'discount',
    ],
    search: true,
    body: {
      address: {
        anyOf: [ADDRESS, { type: 'string', enum: [''] }],
        description: 'The customer’s address.',
      },
      description: STR,
      email: { ...STR, description: 'Customer’s email address.' },
      name: { ...STR, description: 'The customer’s full name or business name.' },
      phone: STR,
      metadata: META,
    },
  },
  { path: 'disputes', param: 'dispute', ops: ['list', 'get', 'update'], actions: ['close'] },
  { path: 'events', param: 'id', ops: LR },
  { path: 'exchange_rates', param: 'rate_id', ops: LR, bare: true },
  {
    path: 'feature_flags',
    param: 'flag_key',
    ops: CRUD,
    subs: ['overrides'],
    paging: 'offset',
    body: {
      enabled: {
        type: 'boolean',
        description: 'Whether the flag is on for accounts without an override.',
      },
      rollout_percentage: {
        type: 'integer',
        description: 'Share of accounts (0-100) that see the flag when it is enabled.',
      },
      name: STR,
    },
  },
  { path: 'file_links', param: 'link', ops: LCRU },
  { path: 'files', param: 'file', ops: ['list', 'create', 'get'] },
  { path: 'invoiceitems', param: 'invoiceitem', ops: CRUD },
  {
    path: 'invoices',
    param: 'invoice',
    ops: CRUD,
    actions: ['finalize', 'mark_uncollectible', 'pay', 'send', 'void'],
    subs: ['lines'],
    search: true,
    body: { description: STR, due_date: { type: 'integer' }, footer: STR, metadata: META },
  },
  { path: 'mandates', param: 'mandate', ops: ['get'], bare: true },
  {
    path: 'payment_intents',
    param: 'intent',
    ops: LCRU,
    actions: ['cancel', 'capture', 'confirm'],
    search: true,
  },
  { path: 'payment_links', param: 'payment_link', ops: LCRU, subs: ['line_items'] },
  { path: 'payment_methods', param: 'payment_method', ops: LCRU, actions: ['attach', 'detach'] },
  { path: 'payouts', param: 'payout', ops: LCRU, actions: ['cancel', 'reverse'] },
  { path: 'plans', param: 'plan', ops: CRUD },
  { path: 'prices', param: 'price', ops: LCRU, search: true },
  { path: 'products', param: 'id', ops: CRUD, search: true },
  { path: 'promotion_codes', param: 'promotion_code', ops: LCRU },
  {
    path: 'quotes',
    param: 'quote',
    ops: LCRU,
    actions: ['accept', 'cancel', 'finalize'],
    subs: ['line_items', 'pdf'],
  },
  { path: 'radar/early_fraud_warnings', param: 'early_fraud_warning', ops: LR, bare: true },
  { path: 'radar/value_lists', param: 'value_list', ops: CRUD, bare: true },
  {
    path: 'refunds',
    param: 'refund',
    ops: LCRU,
    actions: ['cancel'],
    body: {
      charge: { ...STR, description: 'The identifier of the charge to refund.' },
      amount: {
        type: 'integer',
        description:
          'A positive integer in cents representing how much of this charge to refund. Can refund only up to the remaining, unrefunded amount of the charge.',
      },
      reason: {
        type: 'string',
        enum: ['duplicate', 'fraudulent', 'requested_by_customer'],
        description: 'String indicating the reason for the refund.',
      },
      metadata: META,
    },
  },
  {
    path: 'reporting/report_runs',
    param: 'report_run',
    ops: ['list', 'create', 'get'],
    bare: true,
  },
  { path: 'reviews', param: 'review', ops: LR, actions: ['approve'] },
  { path: 'setup_intents', param: 'intent', ops: LCRU, actions: ['cancel', 'confirm'] },
  { path: 'shipping_rates', param: 'shipping_rate_token', ops: LCRU },
  { path: 'subscription_items', param: 'item', ops: CRUD, subs: ['usage_record_summaries'] },
  { path: 'subscription_schedules', param: 'schedule', ops: LCRU, actions: ['cancel', 'release'] },
  {
    path: 'subscriptions',
    param: 'subscription_exposed_id',
    ops: CRUD,
    actions: ['resume'],
    search: true,
    paging: 'page',
    body: { cancel_at_period_end: { type: 'boolean' }, metadata: META },
  },
  { path: 'tax_codes', param: 'id', ops: LR },
  { path: 'tax_ids', param: 'id', ops: ['list', 'create', 'get', 'delete'] },
  { path: 'tax_rates', param: 'tax_rate', ops: LCRU },
  { path: 'terminal/locations', param: 'location', ops: CRUD, bare: true },
  { path: 'terminal/readers', param: 'reader', ops: CRUD, actions: ['cancel_action'], bare: true },
  {
    path: 'test_helpers/test_clocks',
    param: 'test_clock',
    ops: ['list', 'create', 'get', 'delete'],
    actions: ['advance'],
    bare: true,
  },
  { path: 'topups', param: 'topup', ops: LCRU, actions: ['cancel'] },
  { path: 'transfers', param: 'transfer', ops: LCRU, subs: ['reversals'] },
  { path: 'webhook_endpoints', param: 'webhook_endpoint', ops: CRUD },
  {
    path: 'admin/api_keys',
    param: 'key_id',
    ops: ['list', 'create', 'get', 'delete'],
    actions: ['roll'],
    paging: 'page',
  },
  { path: 'admin/audit_logs', param: 'log_id', ops: LR, paging: 'page' },
  {
    path: 'admin/users',
    param: 'user_id',
    ops: CRUD,
    actions: ['invite', 'deactivate'],
    paging: 'page',
  },
  { path: 'admin/teams', param: 'team_id', ops: CRUD, subs: ['members'], paging: 'offset' },
  { path: 'admin/roles', param: 'role_id', ops: LR, paging: 'offset' },
  { path: 'admin/regions', param: 'region', ops: LR, bare: true },
  {
    path: 'billing/meters',
    param: 'id',
    ops: LCRU,
    actions: ['deactivate', 'reactivate'],
    subs: ['event_summaries'],
  },
  {
    path: 'billing/alerts',
    param: 'id',
    ops: ['list', 'create', 'get'],
    actions: ['activate', 'archive', 'deactivate'],
  },
  { path: 'entitlements/features', param: 'id', ops: LCRU },
  { path: 'exports', param: 'export_id', ops: ['list', 'create', 'get'], paging: 'offset' },
  { path: 'forwarding/requests', param: 'id', ops: ['list', 'create', 'get'], bare: true },
  { path: 'climate/orders', param: 'order', ops: LCRU, actions: ['cancel'], bare: true },
  {
    path: 'identity/verification_sessions',
    param: 'session',
    ops: LCRU,
    actions: ['cancel', 'redact'],
  },
  { path: 'issuing/cards', param: 'card', ops: LCRU },
  { path: 'issuing/cardholders', param: 'cardholder', ops: LCRU },
  { path: 'issuing/disputes', param: 'dispute', ops: LCRU, actions: ['submit'] },
  {
    path: 'treasury/financial_accounts',
    param: 'financial_account',
    ops: LCRU,
    subs: ['features'],
  },
];

function pascal(segment: string): string {
  return segment
    .split(/[_/-]/)
    .filter((w) => w !== '')
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join('');
}

/** The operationId of METHOD path, as the spec spells it (`GetCustomersCustomer`). */
export function operationId(method: string, segments: readonly string[]): string {
  return `${pascal(method.toLowerCase())}${segments.map((s) => pascal(s.replace(/[{}]/g, ''))).join('')}`;
}

function singular(path: string): string {
  const last = path.split('/').at(-1) as string;
  const s = last.endsWith('ies') ? `${last.slice(0, -3)}y` : last.replace(/s$/, '');
  return s.replace(/_/g, ' ');
}

function plural(path: string): string {
  return (path.split('/').at(-1) as string).replace(/_/g, ' ');
}

function pagingProps(paging: Paging): Record<string, unknown> {
  switch (paging) {
    case 'cursor':
      return {
        limit: { type: 'integer', description: 'Between 1 and 100, default 10.' },
        starting_after: { ...STR, description: 'An object ID: return objects after it.' },
        ending_before: STR,
      };
    case 'page':
      return {
        page: { type: 'integer', description: 'Page number, starting at 1.' },
        per_page: { type: 'integer', description: 'Results per page (default 10, max 50).' },
      };
    case 'offset':
      return {
        offset: { type: 'integer' },
        limit: { type: 'integer' },
      };
  }
}

const EXPAND = {
  type: 'array',
  items: STR,
} as const;
const CREATED = {
  anyOf: [
    {
      type: 'object',
      title: 'range_query_specs',
      properties: {
        gt: { type: 'integer' },
        gte: { type: 'integer' },
        lt: { type: 'integer' },
        lte: { type: 'integer' },
      },
    },
    { type: 'integer' },
  ],
  description: 'Only return objects that were created during the given date interval.',
} as const;

/** Extra list filters by resource, as the API has them. */
const LIST_FILTERS: Readonly<Record<string, Record<string, unknown>>> = {
  customers: {
    email: {
      ...STR,
      description:
        'A case-sensitive filter on the list based on the customer’s `email` field. The value must be a string.',
    },
  },
  invoices: {
    customer: {
      ...STR,
      description: 'Only return invoices for the customer specified by this customer ID.',
    },
    status: {
      type: 'string',
      enum: ['draft', 'open', 'paid', 'uncollectible', 'void'],
      description:
        'The status of the invoice, one of `draft`, `open`, `paid`, `uncollectible`, or `void`.',
    },
  },
  charges: {
    customer: {
      ...STR,
      description: 'Only return charges for the customer specified by this customer ID.',
    },
    payment_intent: STR,
  },
  refunds: {
    charge: {
      ...STR,
      description: 'Only return refunds for the charge specified by this charge ID.',
    },
  },
  subscriptions: {
    customer: STR,
    price: {
      ...STR,
      description: 'Filter for subscriptions that contain this recurring price ID.',
    },
    status: {
      type: 'string',
      enum: ['active', 'all', 'canceled', 'ended', 'incomplete', 'past_due', 'trialing', 'unpaid'],
    },
  },
};

const SEARCH_DOC = (path: string): string =>
  `<p>Search for ${plural(path)} you’ve previously created using the <a href="/docs/search#search-query-language">Search Query Language</a>. Don’t use search in read-after-write flows where strict consistency is necessary. Under normal operating conditions, data is searchable in less than a minute. Occasionally, propagation of new or updated data can be up to an hour behind during outages.</p>`;

interface Operation {
  name: string;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  resource: Resource;
  kind: Op | 'action' | 'sub' | 'search' | 'sub-create' | 'sub-delete';
  /** The action or sub-collection name. */
  extra?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

function objectSchema(resource: Resource): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      id: { type: 'string' },
      object: { type: 'string' },
      created: { type: 'integer' },
      livemode: { type: 'boolean' },
      ...Object.fromEntries(Object.keys(resource.body ?? {}).map((k) => [k, {}])),
    },
    required: ['id', 'object'],
  };
}

/** Every operation of the API, in spec order. */
export function billingOperations(): Operation[] {
  const ops: Operation[] = [];
  for (const r of BILLING_RESOURCES) {
    const segs = r.path.split('/');
    const item = [...segs, `{${r.param}}`];
    const paging = r.paging ?? 'cursor';
    const desc = (text: string): string => (r.bare === true ? '' : text);
    const body = r.body ?? { metadata: META };
    const bodyProp = (required: readonly string[] = []): Record<string, unknown> => ({
      requestBody: {
        type: 'object',
        properties: body,
        ...(required.length > 0 ? { required } : {}),
      },
    });
    const pathProp = { [r.param]: STR };
    for (const op of r.ops) {
      switch (op) {
        case 'list':
          ops.push({
            name: operationId('GET', segs),
            method: 'GET',
            path: `/v1/${r.path}`,
            resource: r,
            kind: 'list',
            description: desc(
              `<p>Returns a list of your ${plural(r.path)}, most recent first.</p>`,
            ),
            inputSchema: {
              type: 'object',
              properties: {
                ...(LIST_FILTERS[r.path] !== undefined ? { created: CREATED } : {}),
                ...LIST_FILTERS[r.path],
                ...pagingProps(paging),
              },
            },
          });
          break;
        case 'create':
          ops.push({
            name: operationId('POST', segs),
            method: 'POST',
            path: `/v1/${r.path}`,
            resource: r,
            kind: 'create',
            description: desc(`<p>Creates a new ${singular(r.path)} object.</p>`),
            inputSchema: { type: 'object', properties: bodyProp() },
          });
          break;
        case 'get':
          ops.push({
            name: operationId('GET', item),
            method: 'GET',
            path: `/v1/${r.path}/{${r.param}}`,
            resource: r,
            kind: 'get',
            description: desc(`<p>Retrieves the ${singular(r.path)} with the given ID.</p>`),
            inputSchema: {
              type: 'object',
              properties: { ...pathProp, expand: EXPAND },
              required: [r.param],
            },
            outputSchema: objectSchema(r),
          });
          break;
        case 'update':
          ops.push({
            name: operationId('POST', item),
            method: 'POST',
            path: `/v1/${r.path}/{${r.param}}`,
            resource: r,
            kind: 'update',
            description: desc(
              `<p>Updates the specified ${singular(r.path)} by setting the values of the parameters passed.</p>`,
            ),
            inputSchema: {
              type: 'object',
              properties: { ...pathProp, ...bodyProp() },
              required: [r.param],
            },
          });
          break;
        case 'delete':
          ops.push({
            name: operationId('DELETE', item),
            method: 'DELETE',
            path: `/v1/${r.path}/{${r.param}}`,
            resource: r,
            kind: 'delete',
            description: desc(`<p>Deletes the ${singular(r.path)}. This cannot be undone.</p>`),
            inputSchema: { type: 'object', properties: pathProp, required: [r.param] },
          });
          break;
      }
    }
    if (r.search === true) {
      ops.push({
        name: operationId('GET', [...segs, 'search']),
        method: 'GET',
        path: `/v1/${r.path}/search`,
        resource: r,
        kind: 'search',
        description: desc(SEARCH_DOC(r.path)),
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              maxLength: 5000,
              description:
                'The search query string. See [search query language](https://docs.northwind-pay.example/search#search-query-language).',
            },
            limit: {
              type: 'integer',
              description:
                'A limit on the number of objects to be returned. Limit can range between 1 and 100, and the default is 10.',
            },
            page: {
              type: 'string',
              maxLength: 5000,
              description:
                'A cursor for pagination across multiple pages of results. Don’t include this parameter on the first call. Use the next_page value returned in a previous response to request subsequent results.',
            },
            expand: EXPAND,
          },
          required: ['query'],
        },
      });
    }
    for (const action of r.actions ?? []) {
      ops.push({
        name: operationId('POST', [...item, action]),
        method: 'POST',
        path: `/v1/${r.path}/{${r.param}}/${action}`,
        resource: r,
        kind: 'action',
        extra: action,
        description: desc(
          `<p>${pascal(action).replace(/([a-z])([A-Z])/g, '$1 $2')} a ${singular(r.path)}.</p>`,
        ),
        inputSchema: { type: 'object', properties: pathProp, required: [r.param] },
      });
    }
    for (const sub of r.subs ?? []) {
      ops.push({
        name: operationId('GET', [...item, sub]),
        method: 'GET',
        path: `/v1/${r.path}/{${r.param}}/${sub}`,
        resource: r,
        kind: 'sub',
        extra: sub,
        description: desc(`<p>Returns the ${sub.replace(/_/g, ' ')} of a ${singular(r.path)}.</p>`),
        inputSchema: {
          type: 'object',
          properties: { ...pathProp, ...pagingProps(paging) },
          required: [r.param],
        },
      });
      if (r.path === 'feature_flags' && sub === 'overrides') {
        ops.push({
          name: operationId('POST', [...item, sub]),
          method: 'POST',
          path: `/v1/${r.path}/{${r.param}}/${sub}`,
          resource: r,
          kind: 'sub-create',
          extra: sub,
          description:
            '<p>Creates a per-customer override for a feature flag. An override takes precedence over the flag’s global <code>enabled</code> and <code>rollout_percentage</code> for that customer.</p>',
          inputSchema: {
            type: 'object',
            properties: {
              ...pathProp,
              requestBody: {
                type: 'object',
                properties: {
                  customer: {
                    ...STR,
                    description: 'The ID of the customer the override applies to.',
                  },
                  enabled: { type: 'boolean' },
                },
                required: ['customer', 'enabled'],
              },
            },
            required: [r.param, 'requestBody'],
          },
        });
        ops.push({
          name: operationId('DELETE', [...item, sub, '{override}']),
          method: 'DELETE',
          path: `/v1/${r.path}/{${r.param}}/${sub}/{override}`,
          resource: r,
          kind: 'sub-delete',
          extra: sub,
          description: '<p>Deletes a feature flag override.</p>',
          inputSchema: {
            type: 'object',
            properties: { ...pathProp, override: STR },
            required: [r.param, 'override'],
          },
        });
      }
    }
  }
  return ops;
}

/** Whether an operation changes state (any POST or DELETE but a search). */
export function isBillingWrite(name: string): boolean {
  return /^(Post|Delete)/.test(name);
}

// ---------------------------------------------------------------------------
// Handlers

function apiError(message: string, param?: string, code = 'resource_missing'): FakeReply {
  return toolError(
    JSON.stringify(
      {
        error: {
          code,
          doc_url: `https://docs.northwind-pay.example/error-codes/${code.replace(/_/g, '-')}`,
          message,
          ...(param !== undefined ? { param } : {}),
          type: 'invalid_request_error',
        },
      },
      null,
      2,
    ),
  );
}

function missing(r: Resource, id: string | undefined): FakeReply {
  return apiError(`No such ${singular(r.path).replace(/ /g, '_')}: '${id ?? ''}'`, r.param);
}

function bodyOf(args: FakeArgs): Record<string, unknown> {
  const b = args['requestBody'];
  return typeof b === 'object' && b !== null && !Array.isArray(b)
    ? (b as Record<string, unknown>)
    : {};
}

interface Listing<T> {
  items: readonly T[];
  url: string;
  id: (item: T) => string;
}

function listReply<T>(paging: Paging, listing: Listing<T>, args: FakeArgs): FakeReply {
  const all = listing.items;
  switch (paging) {
    case 'cursor': {
      const limit = argNumber(args, 'limit') ?? 10;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return apiError(
          'Invalid integer: limit must be between 1 and 100',
          'limit',
          'parameter_invalid_integer',
        );
      }
      const after = argString(args, 'starting_after');
      const before = argString(args, 'ending_before');
      let start = 0;
      let end = all.length;
      if (after !== undefined) {
        const i = all.findIndex((x) => listing.id(x) === after);
        if (i < 0) return apiError(`No such object: '${after}'`, 'starting_after');
        start = i + 1;
      }
      if (before !== undefined) {
        const i = all.findIndex((x) => listing.id(x) === before);
        if (i < 0) return apiError(`No such object: '${before}'`, 'ending_before');
        end = i;
        start = Math.max(start, end - limit);
      }
      const data = all.slice(start, Math.min(end, start + limit));
      return json({
        object: 'list',
        data,
        has_more: start + limit < end,
        url: listing.url,
      });
    }
    case 'page': {
      const pageNo = argNumber(args, 'page') ?? 1;
      const per = Math.min(argNumber(args, 'per_page') ?? 10, 50);
      if (!Number.isInteger(pageNo) || pageNo < 1) {
        return apiError('page must be a positive integer', 'page', 'parameter_invalid_integer');
      }
      const data = all.slice((pageNo - 1) * per, pageNo * per);
      return json({ object: 'list', data, page: pageNo, per_page: per, url: listing.url });
    }
    case 'offset': {
      const offset = argNumber(args, 'offset') ?? 0;
      const limit = Math.min(argNumber(args, 'limit') ?? 20, 100);
      return json({
        items: all.slice(offset, offset + limit),
        total: all.length,
        offset,
        limit,
      });
    }
  }
}

/** One clause of the search query language: `field:'v'`, `field~'v'`, `metadata['k']:'v'`. */
export function searchMatches(
  query: string,
  fields: (key: string) => string | undefined,
): boolean | string {
  const clauses = query
    .split(/\s+AND\s+/i)
    .map((c) => c.trim())
    .filter((c) => c !== '');
  if (clauses.length === 0) return 'Search query is empty.';
  for (const clause of clauses) {
    const m = /^([a-z_]+(?:\['[^']+'\])?)\s*(:|~)\s*(?:'([^']*)'|"([^"]*)"|(\S+))$/i.exec(clause);
    if (m === null) {
      return `Invalid search query: could not parse clause \`${clause}\`. Expected a field, a colon or tilde, and a quoted value, for example: email:'jenny@example.com'.`;
    }
    const key = m[1] as string;
    const value = (m[3] ?? m[4] ?? m[5] ?? '').toLowerCase();
    const actual = fields(key);
    if (actual === undefined) {
      return `Invalid search query: field \`${key}\` is not supported for this resource.`;
    }
    const a = actual.toLowerCase();
    if (m[2] === ':' ? a !== value : !a.includes(value)) return false;
  }
  return true;
}

function searchReply<T>(
  items: readonly T[],
  fields: (item: T, key: string) => string | undefined,
  args: FakeArgs,
  url: string,
): FakeReply {
  const query = argString(args, 'query') ?? '';
  const hits: T[] = [];
  for (const item of items) {
    const r = searchMatches(query, (key) => fields(item, key));
    if (typeof r === 'string') return apiError(r, 'query', 'parameter_invalid');
    if (r) hits.push(item);
  }
  const limit = Math.min(argNumber(args, 'limit') ?? 10, 100);
  const page = argString(args, 'page');
  const offset = page === undefined ? 0 : Number(Buffer.from(page, 'base64').toString('utf8'));
  const data = hits.slice(offset, offset + limit);
  const more = offset + limit < hits.length;
  return json({
    object: 'search_result',
    data,
    has_more: more,
    next_page: more ? Buffer.from(String(offset + limit)).toString('base64') : null,
    url,
  });
}

/** The billing box over `state`. */
export function createBillingBox(
  state: BillingState,
  onCall?: (call: SideEffect) => void,
): FakeBox {
  let seq = 0;
  const nextId = (prefix: string): string => {
    seq += 1;
    return billingId(prefix, `created-${seq}`);
  };
  const record = (tool: string, args: FakeArgs): void => {
    state.mutations.push({ tool, args: structuredClone(args) });
  };
  const customer = (id: string | undefined): BillingCustomer | undefined =>
    state.customers.find((c) => c.id === id);

  const custFields = (c: BillingCustomer, key: string): string | undefined => {
    if (key === 'name' || key === 'email') return c[key];
    const meta = /^metadata\['(.+)'\]$/.exec(key);
    if (meta !== null) return c.metadata[meta[1] as string] ?? '';
    return undefined;
  };
  const invoiceFields = (i: BillingInvoice, key: string): string | undefined => {
    switch (key) {
      case 'number':
      case 'customer':
      case 'status':
        return i[key];
      case 'total':
        return String(i.amount_due);
      default:
        return undefined;
    }
  };

  const special = (op: Operation): ((args: FakeArgs) => FakeReply) | undefined => {
    const r = op.resource;
    const id = (args: FakeArgs): string | undefined => argString(args, r.param);
    switch (`${op.method} ${op.path}`) {
      // customers
      case 'GET /v1/customers':
        return (args) => {
          const email = argString(args, 'email');
          return listReply(
            'cursor',
            {
              items: state.customers
                .filter((c) => email === undefined || c.email === email)
                .toSorted((a, b) => b.created - a.created),
              url: '/v1/customers',
              id: (c) => c.id,
            },
            args,
          );
        };
      case 'GET /v1/customers/search':
        return (args) => searchReply(state.customers, custFields, args, '/v1/customers/search');
      case 'GET /v1/customers/{customer}':
        return (args) => {
          const c = customer(id(args));
          return c === undefined ? missing(r, id(args)) : json(c);
        };
      case 'POST /v1/customers/{customer}':
        return (args) => {
          const c = customer(id(args));
          if (c === undefined) return missing(r, id(args));
          const body = bodyOf(args);
          const address = body['address'];
          if (address !== undefined) {
            if (address === '') {
              c.address = {
                line1: '',
                line2: null,
                city: '',
                state: '',
                postal_code: '',
                country: '',
              };
            } else if (typeof address === 'object' && address !== null) {
              const a = address as Record<string, unknown>;
              const s = (k: string): string | undefined =>
                typeof a[k] === 'string' ? (a[k] as string) : undefined;
              c.address = {
                line1: s('line1') ?? c.address.line1,
                line2: s('line2') ?? c.address.line2,
                city: s('city') ?? c.address.city,
                state: s('state') ?? c.address.state,
                postal_code: s('postal_code') ?? c.address.postal_code,
                country: s('country') ?? c.address.country,
              };
            } else {
              return apiError('Invalid object', 'address', 'parameter_invalid');
            }
          }
          for (const k of ['name', 'email'] as const) {
            if (typeof body[k] === 'string') c[k] = body[k] as string;
          }
          record(op.name, args);
          return json(c);
        };
      // invoices
      case 'GET /v1/invoices':
        return (args) => {
          const cust = argString(args, 'customer');
          const status = argString(args, 'status');
          return listReply(
            'cursor',
            {
              items: state.invoices.filter(
                (i) =>
                  (cust === undefined || i.customer === cust) &&
                  (status === undefined || i.status === status),
              ),
              url: '/v1/invoices',
              id: (i) => i.id,
            },
            args,
          );
        };
      case 'GET /v1/invoices/search':
        return (args) => searchReply(state.invoices, invoiceFields, args, '/v1/invoices/search');
      case 'GET /v1/invoices/{invoice}':
        return (args) => {
          const inv = state.invoices.find((i) => i.id === id(args));
          return inv === undefined ? missing(r, id(args)) : json(inv);
        };
      // charges
      case 'GET /v1/charges':
        return (args) => {
          const cust = argString(args, 'customer');
          return listReply(
            'cursor',
            {
              items: state.charges.filter((c) => cust === undefined || c.customer === cust),
              url: '/v1/charges',
              id: (c) => c.id,
            },
            args,
          );
        };
      case 'GET /v1/charges/search':
        return (args) =>
          searchReply(
            state.charges,
            (c, key) =>
              key === 'customer' || key === 'status' || key === 'invoice'
                ? String(c[key] ?? '')
                : key === 'amount'
                  ? String(c.amount)
                  : undefined,
            args,
            '/v1/charges/search',
          );
      case 'GET /v1/charges/{charge}':
        return (args) => {
          const c = state.charges.find((x) => x.id === id(args));
          return c === undefined ? missing(r, id(args)) : json(c);
        };
      case 'GET /v1/charges/{charge}/refunds':
        return (args) => {
          const c = state.charges.find((x) => x.id === id(args));
          if (c === undefined) return missing(r, id(args));
          return listReply(
            'cursor',
            {
              items: state.refunds.filter((f) => f.charge === c.id),
              url: `/v1/charges/${c.id}/refunds`,
              id: (f) => f.id,
            },
            args,
          );
        };
      // refunds
      case 'GET /v1/refunds':
        return (args) => {
          const ch = argString(args, 'charge');
          return listReply(
            'cursor',
            {
              items: state.refunds.filter((f) => ch === undefined || f.charge === ch).toReversed(),
              url: '/v1/refunds',
              id: (f) => f.id,
            },
            args,
          );
        };
      case 'POST /v1/refunds':
        return (args) => {
          const body = bodyOf(args);
          const chargeId = typeof body['charge'] === 'string' ? body['charge'] : undefined;
          if (chargeId === undefined) {
            return apiError(
              'One of the following params should be provided for this request: payment_intent or charge.',
              undefined,
              'parameter_missing',
            );
          }
          const c = state.charges.find((x) => x.id === chargeId);
          if (c === undefined) return apiError(`No such charge: '${chargeId}'`, 'charge');
          const remaining = c.amount - c.amount_refunded;
          if (remaining <= 0) {
            return apiError(
              `Charge ${c.id} has already been refunded.`,
              undefined,
              'charge_already_refunded',
            );
          }
          const amount = typeof body['amount'] === 'number' ? body['amount'] : remaining;
          if (!Number.isInteger(amount) || amount <= 0 || amount > remaining) {
            return apiError(
              `Refund amount ($${(amount / 100).toFixed(2)}) is greater than unrefunded amount on charge ($${(remaining / 100).toFixed(2)})`,
              'amount',
              'amount_too_large',
            );
          }
          const reason = typeof body['reason'] === 'string' ? body['reason'] : null;
          if (
            reason !== null &&
            !['duplicate', 'fraudulent', 'requested_by_customer'].includes(reason)
          ) {
            return apiError(
              `Invalid reason: must be one of duplicate, fraudulent, or requested_by_customer`,
              'reason',
              'parameter_invalid',
            );
          }
          const refund: BillingRefund = {
            id: nextId('re'),
            object: 'refund',
            charge: c.id,
            amount,
            reason,
            status: 'succeeded',
            created: NOW_EPOCH,
            metadata: {},
          };
          c.amount_refunded += amount;
          c.refunded = c.amount_refunded >= c.amount;
          state.refunds.push(refund);
          record(op.name, args);
          return json(refund);
        };
      // subscriptions (page-numbered)
      case 'GET /v1/subscriptions':
        return (args) => {
          const cust = argString(args, 'customer');
          const price = argString(args, 'price');
          const status = argString(args, 'status');
          return listReply(
            'page',
            {
              items: state.subscriptions
                .filter(
                  (s) =>
                    (cust === undefined || s.customer === cust) &&
                    (price === undefined || s.price === price) &&
                    // Like the API: the default hides canceled subscriptions.
                    (status === 'all'
                      ? true
                      : status === undefined
                        ? s.status !== 'canceled'
                        : s.status === status),
                )
                .toSorted((a, b) => b.created - a.created || a.id.localeCompare(b.id))
                .map((s) => ({
                  ...s,
                  items: {
                    object: 'list',
                    data: [
                      { object: 'subscription_item', price: PRICES.find((p) => p.id === s.price) },
                    ],
                  },
                })),
              url: '/v1/subscriptions',
              id: (s) => s.id,
            },
            args,
          );
        };
      case 'GET /v1/prices':
        return (args) =>
          listReply(
            'cursor',
            {
              items: PRICES.map((p) => ({
                object: 'price',
                active: true,
                currency: 'usd',
                recurring: { interval: 'month' },
                ...p,
              })),
              url: '/v1/prices',
              id: (p) => p.id,
            },
            args,
          );
      case 'GET /v1/products':
        return (args) =>
          listReply(
            'cursor',
            {
              items: PRICES.map((p) => ({
                id: p.product,
                object: 'product',
                name: p.nickname,
                active: true,
                default_price: p.id,
              })),
              url: '/v1/products',
              id: (p) => p.id,
            },
            args,
          );
      // coupons
      case 'GET /v1/coupons':
        return (args) =>
          listReply(
            'cursor',
            {
              items: state.coupons.toSorted((a, b) => b.created - a.created),
              url: '/v1/coupons',
              id: (c) => c.id,
            },
            args,
          );
      case 'GET /v1/coupons/{coupon}':
        return (args) => {
          const c = state.coupons.find((x) => x.id === id(args));
          return c === undefined ? missing(r, id(args)) : json(c);
        };
      case 'POST /v1/coupons':
        return (args) => {
          const body = bodyOf(args);
          const pct = typeof body['percent_off'] === 'number' ? body['percent_off'] : null;
          const amt = typeof body['amount_off'] === 'number' ? body['amount_off'] : null;
          if ((pct === null) === (amt === null)) {
            return apiError(
              'Must provide exactly one of `percent_off` or `amount_off`.',
              'percent_off',
              'parameter_missing',
            );
          }
          if (pct !== null && (pct <= 0 || pct > 100)) {
            return apiError(
              'Invalid percent_off: must be greater than 0 and at most 100',
              'percent_off',
              'parameter_invalid',
            );
          }
          const duration = (
            typeof body['duration'] === 'string' ? body['duration'] : 'once'
          ) as BillingCoupon['duration'];
          if (!['once', 'repeating', 'forever'].includes(duration)) {
            return apiError(
              'Invalid duration: must be one of forever, once, or repeating',
              'duration',
              'parameter_invalid',
            );
          }
          const months =
            typeof body['duration_in_months'] === 'number' ? body['duration_in_months'] : null;
          if (duration === 'repeating' && months === null) {
            return apiError(
              'duration_in_months is required when duration is repeating.',
              'duration_in_months',
              'parameter_missing',
            );
          }
          if (duration !== 'repeating' && months !== null) {
            return apiError(
              'duration_in_months can only be set when duration is repeating.',
              'duration_in_months',
              'parameter_invalid',
            );
          }
          const cid =
            typeof body['id'] === 'string' && body['id'] !== ''
              ? body['id']
              : hashHex(`coupon-${seq}`, 8);
          if (state.coupons.some((c) => c.id === cid)) {
            return apiError('Coupon already exists.', 'id', 'resource_already_exists');
          }
          seq += 1;
          const c: BillingCoupon = {
            id: cid,
            object: 'coupon',
            name: typeof body['name'] === 'string' ? body['name'] : null,
            percent_off: pct,
            amount_off: amt,
            currency: typeof body['currency'] === 'string' ? body['currency'] : null,
            duration,
            duration_in_months: months,
            max_redemptions:
              typeof body['max_redemptions'] === 'number' ? body['max_redemptions'] : null,
            times_redeemed: 0,
            valid: true,
            created: NOW_EPOCH,
          };
          state.coupons.push(c);
          record(op.name, args);
          return json(c);
        };
      // feature flags (offset-paged)
      case 'GET /v1/feature_flags':
        return (args) =>
          listReply(
            'offset',
            { items: state.flags, url: '/v1/feature_flags', id: (f) => f.key },
            args,
          );
      case 'GET /v1/feature_flags/{flag_key}':
        return (args) => {
          const f = state.flags.find((x) => x.key === id(args));
          return f === undefined
            ? missing(r, id(args))
            : json({
                id: f.key,
                object: 'feature_flag',
                ...f,
                overrides_count: state.overrides.filter((o2) => o2.flag === f.key).length,
              });
        };
      case 'POST /v1/feature_flags/{flag_key}':
        return (args) => {
          const f = state.flags.find((x) => x.key === id(args));
          if (f === undefined) return missing(r, id(args));
          const body = bodyOf(args);
          if (typeof body['enabled'] === 'boolean') f.enabled = body['enabled'];
          if (typeof body['rollout_percentage'] === 'number')
            f.rollout_percentage = body['rollout_percentage'];
          if (typeof body['name'] === 'string') f.name = body['name'];
          f.updated = NOW_EPOCH;
          record(op.name, args);
          return json(f);
        };
      case 'GET /v1/feature_flags/{flag_key}/overrides':
        return (args) => {
          const f = state.flags.find((x) => x.key === id(args));
          if (f === undefined) return missing(r, id(args));
          return listReply(
            'offset',
            { items: state.overrides.filter((x) => x.flag === f.key), url: '', id: (x) => x.id },
            args,
          );
        };
      case 'POST /v1/feature_flags/{flag_key}/overrides':
        return (args) => {
          const f = state.flags.find((x) => x.key === id(args));
          if (f === undefined) return missing(r, id(args));
          const body = bodyOf(args);
          const cust = typeof body['customer'] === 'string' ? body['customer'] : undefined;
          if (cust === undefined || typeof body['enabled'] !== 'boolean') {
            return apiError(
              'Missing required param: requestBody.customer and requestBody.enabled are required.',
              'customer',
              'parameter_missing',
            );
          }
          if (customer(cust) === undefined)
            return apiError(`No such customer: '${cust}'`, 'customer');
          if (state.overrides.some((x) => x.flag === f.key && x.customer === cust)) {
            return apiError(
              `An override for ${cust} already exists on ${f.key}.`,
              'customer',
              'resource_already_exists',
            );
          }
          const override: FlagOverride = {
            id: nextId('ffo'),
            flag: f.key,
            customer: cust,
            enabled: body['enabled'],
            created: NOW_EPOCH,
          };
          state.overrides.push(override);
          record(op.name, args);
          return json(override);
        };
      case 'DELETE /v1/feature_flags/{flag_key}/overrides/{override}':
        return (args) => {
          const i = state.overrides.findIndex(
            (x) => x.flag === id(args) && x.id === argString(args, 'override'),
          );
          if (i < 0)
            return apiError(`No such override: '${argString(args, 'override') ?? ''}'`, 'override');
          const [gone] = state.overrides.splice(i, 1);
          record(op.name, args);
          return json({ id: gone?.id, object: 'feature_flag_override', deleted: true });
        };
      default:
        return undefined;
    }
  };

  const generic = (op: Operation): ((args: FakeArgs) => FakeReply) => {
    const r = op.resource;
    const paging = r.paging ?? 'cursor';
    switch (op.kind) {
      case 'list':
      case 'sub':
        if (op.kind === 'sub' && op.path.startsWith('/v1/customers/')) {
          return (args) => {
            const c = customer(argString(args, r.param));
            if (c === undefined) return missing(r, argString(args, r.param));
            if (op.extra === 'discount')
              return apiError(`Customer ${c.id} has no discount.`, undefined);
            if (op.extra === 'cash_balance')
              return json({ object: 'cash_balance', available: null, customer: c.id });
            return listReply(
              paging,
              { items: [], url: op.path.replace(`{${r.param}}`, c.id), id: () => '' },
              args,
            );
          };
        }
        if (op.kind === 'sub') return (args) => missing(r, argString(args, r.param));
        return (args) => listReply(paging, { items: [], url: op.path, id: () => '' }, args);
      case 'search':
        return (args) => searchReply<never>([], () => undefined, args, op.path);
      case 'create':
        return (args) => {
          const created = {
            id: nextId(singular(r.path).slice(0, 3).replace(/ /g, '')),
            object: singular(r.path).replace(/ /g, '_'),
            created: NOW_EPOCH,
            livemode: false,
            ...bodyOf(args),
          };
          record(op.name, args);
          return json(created);
        };
      default:
        return (args) => missing(r, argString(args, r.param));
    }
  };

  const tools: FakeTool[] = billingOperations().map((op) => ({
    name: op.name,
    description: op.description,
    inputSchema: op.inputSchema,
    ...(op.outputSchema !== undefined ? { outputSchema: op.outputSchema } : {}),
    handler: special(op) ?? generic(op),
  }));
  return createFakeBox({ name: 'northwind-billing-openapi-mcp', version: '0.4.2' }, tools, onCall);
}
