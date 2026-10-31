/**
 * The summit world's `sentry` box: a fake of Sentry's official MCP server,
 * `@sentry/mcp-server` 0.42.0 (getsentry/sentry-mcp tag 0.42.0, commit
 * 54f66d8d77bdee0d036d4754806d782b58217ef7, 2026-09-25), run over stdio
 * with skills `inspect,seer,triage` (the default `inspect,seer` plus
 * `triage`, without which `update_issue` is not exposed) and no embedded
 * AI agent (no provider key — the stdio default).
 *
 * Definitions: `packages/mcp-core/src/toolDefinitions.json` at that tag,
 * verbatim (test/fixtures/summit/sentry-tools.json), with each tool's
 * annotations read from its module. `tools/list` serves the nine
 * TOP_LEVEL_TOOL_NAMES (tools/surfaces.ts); every other tool of the enabled
 * skills is reachable only through `search_sentry_tools` (the catalog's
 * scorer from tools/catalog-runtime/search.ts, ported) and
 * `execute_sentry_tool`.
 *
 * Behaviour kept from the handlers:
 *
 * - markdown answers for most tools; `structuredContent` plus a two-space
 *   JSON text mirror for the tools that declare an output schema;
 * - errors are `isError` results in the server's templates (`**Input
 *   Error**` …); a bad argument is a zod `-32602` error before the handler;
 * - `search_issues` passes `query` to Sentry unchanged (no agent): Sentry's
 *   issue-search syntax works, natural language is free-text search over
 *   title and culprit; `limit` 1–100, default 10; `period` default `30d`;
 *   no cursor. Listed issues are those with activity in the period, and
 *   their **Events** and **Users** are counts within the period (Sentry's
 *   stats-period counts), while issue details show all-time counts;
 * - dates in search results are relative to now ("3 hours ago");
 * - issue IDs: the numeric ID and the short ID (`API-61B`) both resolve;
 *   `get_sentry_resource` upper-cases the resource ID; an event ID resolves
 *   to its issue through issue search;
 * - `update_issue` reads the issue first and reports "Already Matches
 *   Requested State" without writing when nothing would change.
 */

import catalogFixture from '../../test/fixtures/summit/sentry-tools.json' with { type: 'json' };
import type { SideEffect } from '../types.js';
import {
  createSummitBox,
  hoursAgo,
  num,
  RpcError,
  str,
  structuredResult,
  textResult,
  SUMMIT_NOW_MS,
  type Args,
  type BoxResult,
  type SummitBox,
  type SummitTool,
} from './summit-core.js';
import { PEOPLE, type Person } from './summit-people.js';
import { QA_EVENT_ID, QA_OLD_EVENT_ID } from './summit-slack.js';
import { stripeCustomerIds } from './summit-stripe.js';
import type { WorldTool } from './world.js';

interface CatalogTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: NonNullable<WorldTool['annotations']>;
  skills: string[];
  surface: string;
}

const CATALOG = catalogFixture as unknown as {
  source: string;
  directTools: string[];
  tools: CatalogTool[];
};
export const SENTRY_SKILLS = ['inspect', 'seer', 'triage'] as const;
/** The tools of the enabled skills (the catalog `search_sentry_tools` searches). */
export const SENTRY_AVAILABLE: readonly CatalogTool[] = CATALOG.tools.filter((t) =>
  t.skills.some((s) => (SENTRY_SKILLS as readonly string[]).includes(s)),
);
export const SENTRY_DIRECT_TOOLS: readonly string[] = CATALOG.directTools;
export const SENTRY_WRITE_TOOLS: readonly string[] = [
  'update_issue',
  'execute_sentry_tool',
  'analyze_issue_with_seer',
];

export const SENTRY_ORG = 'fernhill';
const WEB = `https://${SENTRY_ORG}.sentry.io`;

// ---------------------------------------------------------------------------
// Fixture

export interface SentryProject {
  slug: string;
  id: string;
  name: string;
  platform: string;
  team: string;
}

export const PROJECTS: readonly SentryProject[] = [
  {
    slug: 'web-app',
    id: '4508811000000101',
    name: 'web-app',
    platform: 'javascript-react',
    team: 'frontend',
  },
  { slug: 'api', id: '4508811000000102', name: 'api', platform: 'python-django', team: 'backend' },
  {
    slug: 'billing-worker',
    id: '4508811000000103',
    name: 'billing-worker',
    platform: 'python',
    team: 'payments',
  },
  {
    slug: 'mobile-ios',
    id: '4508811000000104',
    name: 'mobile-ios',
    platform: 'apple-ios',
    team: 'mobile',
  },
  {
    slug: 'marketing-site',
    id: '4508811000000105',
    name: 'marketing-site',
    platform: 'javascript-nextjs',
    team: 'frontend',
  },
];

export const TEAMS: readonly { slug: string; id: string; name: string }[] = [
  { slug: 'backend', id: '4508811000500012', name: 'Backend' },
  { slug: 'frontend', id: '4508811000500011', name: 'Frontend' },
  { slug: 'mobile', id: '4508811000500014', name: 'Mobile' },
  { slug: 'payments', id: '4508811000500013', name: 'Payments' },
  { slug: 'sre', id: '4508811000500015', name: 'SRE' },
];

export interface Frame {
  filename: string;
  function: string;
  lineNo: number;
  colNo?: number;
  inApp: boolean;
  context?: [number, string][];
}

export type Assignee =
  | { type: 'user'; id: string; name: string; email: string }
  | { type: 'team'; id: string; name: string };

export interface SentryIssue {
  id: string;
  shortId: string;
  project: string;
  title: string;
  culprit: string;
  level: 'error' | 'warning' | 'fatal';
  status: 'unresolved' | 'resolved' | 'ignored';
  substatus: string | null;
  firstSeen: string;
  lastSeen: string;
  count: number;
  userCount: number;
  /** Events and users in the last 24 hours and 7 days. */
  h24: [number, number];
  d7: [number, number];
  assignedTo: Assignee | null;
  environment: 'production' | 'staging';
  release: string;
  priority: 'high' | 'medium' | 'low';
  exception: { type: string; value: string; frames: Frame[] };
  tags: Record<string, string>;
  eventId: string;
  otherEventIds?: string[];
  user?: { id: string; email?: string; ip_address?: string };
  notes: { text: string; author: string; date: string }[];
}

const userAssignee = (p: Person): Assignee => ({
  type: 'user',
  id: p.sentryId,
  name: p.name,
  email: p.email,
});
const teamAssignee = (slug: string): Assignee => {
  const t = TEAMS.find((x) => x.slug === slug) as { id: string; name: string; slug: string };
  return { type: 'team', id: t.id, name: t.slug };
};

const py = (filename: string, fn: string, line: number, code: string, inApp = true): Frame => ({
  filename,
  function: fn,
  lineNo: line,
  inApp,
  context: [
    [line - 1, '    try:'],
    [line, code],
    [line + 1, '    except Exception:'],
  ],
});
const js = (
  filename: string,
  fn: string,
  line: number,
  col: number,
  code: string,
  inApp = true,
): Frame => ({
  filename,
  function: fn,
  lineNo: line,
  colNo: col,
  inApp,
  context: [[line, code]],
});

function hex32(seed: string): string {
  let h = 2166136261;
  let out = '';
  for (let i = 0; out.length < 32; i++) {
    for (const ch of `${seed}#${i}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 32);
}

type Seed = Omit<
  SentryIssue,
  'substatus' | 'notes' | 'eventId' | 'priority' | 'environment' | 'release' | 'tags'
> &
  Partial<
    Pick<
      SentryIssue,
      'substatus' | 'eventId' | 'priority' | 'environment' | 'release' | 'tags' | 'notes'
    >
  >;

function issue(seed: Seed): SentryIssue {
  const project = PROJECTS.find((p) => p.slug === seed.project) as SentryProject;
  const release =
    seed.release ??
    (project.slug === 'mobile-ios' ? 'ios@5.12.1+812' : `${project.slug}@2026.10.4`);
  const environment = seed.environment ?? 'production';
  const substatus =
    seed.substatus !== undefined
      ? seed.substatus
      : seed.status === 'unresolved'
        ? Date.parse(seed.firstSeen) > SUMMIT_NOW_MS - 7 * 86_400_000
          ? 'new'
          : 'ongoing'
        : seed.status === 'ignored'
          ? 'archived_until_escalating'
          : null;
  return {
    ...seed,
    substatus,
    eventId: seed.eventId ?? hex32(`event:${seed.id}`),
    priority: seed.priority ?? (seed.level === 'warning' ? 'low' : 'medium'),
    environment,
    release,
    notes: seed.notes ?? [],
    tags: {
      environment,
      level: seed.level,
      release,
      ...(project.platform.startsWith('javascript')
        ? { browser: 'Chrome 130.0.0', 'browser.name': 'Chrome', 'os.name': 'Windows' }
        : {}),
      ...(project.platform.startsWith('python')
        ? {
            'runtime.name': 'CPython',
            runtime: 'CPython 3.12.7',
            server_name: `${project.slug}-7f9c8d6b5-x2k4q`,
          }
        : {}),
      ...(project.platform === 'apple-ios'
        ? { device: 'iPhone15,3', 'os.name': 'iOS', os: 'iOS 18.0.1' }
        : {}),
      ...seed.tags,
    },
  };
}

const H = hoursAgo;

export const ISSUE_IDS = {
  taxTimeout: '6021834477',
  queuePool: '6021840021',
  creditExceeds: '6015530198',
  proration: '6018204466',
  webhook502: '6016601873',
  googleQuota: '6013377710',
  checkoutStuck: '6021851130',
  teamCalendar: '6022107734',
  outlookInvite: '6019922310',
  iosBadAccess: '6017745012',
} as const;

/** The seven browser-extension issues in web-app (ss-sentry-ignore-extensions). */
export const EXTENSION_ISSUES = [
  'WEB-APP-2A',
  'WEB-APP-2C',
  'WEB-APP-2N',
  'WEB-APP-2W',
  'WEB-APP-31',
  'WEB-APP-37',
  'WEB-APP-3E',
] as const;

export function seedSentryIssues(): SentryIssue[] {
  const P = PEOPLE;
  const ostrava = stripeCustomerIds()['ostrava'] as string;
  const issues: SentryIssue[] = [
    // ---------------- api
    issue({
      id: ISSUE_IDS.taxTimeout,
      shortId: 'API-61B',
      project: 'api',
      level: 'error',
      status: 'unresolved',
      title:
        "ReadTimeout: HTTPSConnectionPool(host='api.taxjar.com', port=443): Read timed out. (read timeout=5)",
      culprit: 'fernhill.billing.tax.client in calculate',
      firstSeen: '2026-10-27T17:28:00Z',
      lastSeen: H(0.3),
      count: 3980,
      userCount: 1240,
      h24: [3410, 312],
      d7: [3980, 1240],
      assignedTo: null,
      priority: 'high',
      exception: {
        type: 'ReadTimeout',
        value:
          "HTTPSConnectionPool(host='api.taxjar.com', port=443): Read timed out. (read timeout=5)",
        frames: [
          py('fernhill/api/checkout/views.py', 'post', 88, '        quote = checkout.quote(cart)'),
          py(
            'fernhill/billing/checkout.py',
            'quote',
            142,
            '    tax = tax_client.calculate(cart.lines, address=cart.billing_address)',
          ),
          py(
            'fernhill/billing/tax/client.py',
            'calculate',
            57,
            '        resp = self.session.post(url, json=payload, timeout=5)',
          ),
          py(
            'requests/sessions.py',
            'post',
            637,
            '        return self.request("POST", url, data=data, json=json, **kwargs)',
            false,
          ),
        ],
      },
      tags: {
        url: 'https://app.fernhill.io/api/checkout/quote',
        transaction: '/api/checkout/quote',
      },
    }),
    issue({
      id: ISSUE_IDS.queuePool,
      shortId: 'API-5KD',
      project: 'api',
      level: 'error',
      status: 'resolved',
      substatus: null,
      title:
        'OperationalError: QueuePool limit of size 20 overflow 10 reached, connection timed out, timeout 30.00',
      culprit: 'fernhill.db.session in get_session',
      firstSeen: '2026-10-27T17:31:00Z',
      lastSeen: '2026-10-27T19:38:00Z',
      count: 860,
      userCount: 120,
      h24: [860, 120],
      d7: [860, 120],
      assignedTo: teamAssignee('backend'),
      exception: {
        type: 'OperationalError',
        value:
          'QueuePool limit of size 20 overflow 10 reached, connection timed out, timeout 30.00',
        frames: [
          py('fernhill/api/middleware.py', '__call__', 31, '        with db.session() as session:'),
          py('fernhill/db/session.py', 'get_session', 22, '    conn = engine.connect()'),
          py(
            'sqlalchemy/pool/impl.py',
            '_do_get',
            168,
            '            raise exc.TimeoutError(',
            false,
          ),
        ],
      },
    }),
    issue({
      id: ISSUE_IDS.creditExceeds,
      shortId: 'API-4ZT',
      project: 'api',
      level: 'error',
      status: 'unresolved',
      title: 'ValueError: credit amount 4500 exceeds invoice balance 3900',
      culprit: 'fernhill.billing.invoices in apply_credit',
      firstSeen: '2026-10-09T11:12:00Z',
      lastSeen: H(1),
      count: 9120,
      userCount: 380,
      h24: [610, 41],
      d7: [4410, 233],
      assignedTo: null,
      exception: {
        type: 'ValueError',
        value: 'credit amount 4500 exceeds invoice balance 3900',
        frames: [
          py(
            'fernhill/api/billing/views.py',
            'apply_credit_view',
            203,
            '    invoices.apply_credit(invoice, credit)',
          ),
          py(
            'fernhill/billing/invoices.py',
            'apply_credit',
            118,
            '        raise ValueError(f"credit amount {credit.amount} exceeds invoice balance {invoice.balance}")',
          ),
        ],
      },
    }),
    issue({
      id: ISSUE_IDS.proration,
      shortId: 'API-52C',
      project: 'api',
      level: 'error',
      status: 'unresolved',
      title: 'AssertionError: prorated amount mismatch (expected 1450, got 1449)',
      culprit: 'fernhill.billing.proration in prorate_seats',
      firstSeen: '2026-10-15T09:40:00Z',
      lastSeen: H(30),
      count: 212,
      userCount: 17,
      h24: [0, 0],
      d7: [98, 9],
      assignedTo: userAssignee(P.priya),
      release: 'api@2026.10.3',
      exception: {
        type: 'AssertionError',
        value: 'prorated amount mismatch (expected 1450, got 1449)',
        frames: [
          py(
            'fernhill/billing/proration.py',
            'prorate_seats',
            64,
            '    assert total == expected, f"prorated amount mismatch (expected {expected}, got {total})"',
          ),
        ],
      },
    }),
    issue({
      id: ISSUE_IDS.webhook502,
      shortId: 'API-4V8',
      project: 'api',
      level: 'error',
      status: 'resolved',
      substatus: null,
      title: 'HTTPError: 502 Server Error: Bad Gateway for url: https://hooks.fernhill.io/deliver',
      culprit: 'fernhill.webhooks.delivery in deliver',
      firstSeen: '2026-10-11T02:00:00Z',
      lastSeen: '2026-10-20T06:12:00Z',
      count: 1410,
      userCount: 0,
      h24: [0, 0],
      d7: [0, 0],
      assignedTo: teamAssignee('backend'),
      release: 'api@2026.10.3',
      exception: {
        type: 'HTTPError',
        value: '502 Server Error: Bad Gateway for url: https://hooks.fernhill.io/deliver',
        frames: [py('fernhill/webhooks/delivery.py', 'deliver', 71, '    resp.raise_for_status()')],
      },
    }),
    issue({
      id: ISSUE_IDS.googleQuota,
      shortId: 'API-4QX',
      project: 'api',
      level: 'error',
      status: 'resolved',
      substatus: null,
      title:
        "HttpError 403: Quota exceeded for quota metric 'Queries' and limit 'Queries per minute'",
      culprit: 'fernhill.calendar.google.sync in fetch_events',
      firstSeen: '2026-10-01T07:00:00Z',
      lastSeen: '2026-10-22T08:20:00Z',
      count: 22004,
      userCount: 3100,
      h24: [0, 0],
      d7: [1880, 640],
      assignedTo: userAssignee(P.jonas),
      release: 'api@2026.10.2',
      exception: {
        type: 'HttpError',
        value: "403 Quota exceeded for quota metric 'Queries'",
        frames: [
          py(
            'fernhill/calendar/google/sync.py',
            'fetch_events',
            93,
            '        page = service.events().list(**params).execute()',
          ),
        ],
      },
    }),
    issue({
      id: '6009981202',
      shortId: 'API-4Y2',
      project: 'api',
      level: 'error',
      status: 'ignored',
      substatus: 'archived_forever',
      title:
        "DisallowedHost: Invalid HTTP_HOST header: '203.0.113.7'. You may need to add '203.0.113.7' to ALLOWED_HOSTS.",
      culprit: 'django.http.request in get_host',
      firstSeen: '2026-09-02T00:00:00Z',
      lastSeen: H(2),
      count: 61022,
      userCount: 0,
      h24: [1300, 0],
      d7: [9040, 0],
      assignedTo: null,
      priority: 'low',
      exception: {
        type: 'DisallowedHost',
        value: "Invalid HTTP_HOST header: '203.0.113.7'.",
        frames: [
          py('django/http/request.py', 'get_host', 151, '        raise DisallowedHost(msg)', false),
        ],
      },
    }),
    issue({
      id: '6022011876',
      shortId: 'API-63A',
      project: 'api',
      level: 'error',
      status: 'unresolved',
      environment: 'staging',
      title: "KeyError: 'timezone'",
      culprit: 'fernhill.calendar.ics in parse_vevent',
      firstSeen: '2026-10-28T06:00:00Z',
      lastSeen: H(1.5),
      count: 450,
      userCount: 200,
      h24: [450, 200],
      d7: [450, 200],
      assignedTo: null,
      release: 'api@2026.10.5-rc1',
      exception: {
        type: 'KeyError',
        value: "'timezone'",
        frames: [py('fernhill/calendar/ics.py', 'parse_vevent', 48, "    tz = vevent['timezone']")],
      },
    }),
    issue({
      id: '6019015544',
      shortId: 'API-5Z1',
      project: 'api',
      level: 'error',
      status: 'unresolved',
      title: 'IntegrityError: duplicate key value violates unique constraint "booking_slot_uniq"',
      culprit: 'fernhill.bookings.service in reserve_slot',
      firstSeen: '2026-10-17T12:00:00Z',
      lastSeen: H(4),
      count: 2650,
      userCount: 140,
      h24: [140, 12],
      d7: [1200, 88],
      assignedTo: teamAssignee('backend'),
      exception: {
        type: 'IntegrityError',
        value: 'duplicate key value violates unique constraint "booking_slot_uniq"',
        frames: [py('fernhill/bookings/service.py', 'reserve_slot', 77, '        session.flush()')],
      },
    }),
    issue({
      id: '6020402290',
      shortId: 'API-5R4',
      project: 'api',
      level: 'warning',
      status: 'unresolved',
      title: 'PermissionDenied: workspace admin required',
      culprit: 'fernhill.api.permissions in require_admin',
      firstSeen: '2026-10-20T10:00:00Z',
      lastSeen: H(6),
      count: 510,
      userCount: 66,
      h24: [30, 7],
      d7: [300, 41],
      assignedTo: null,
      exception: {
        type: 'PermissionDenied',
        value: 'workspace admin required',
        frames: [
          py(
            'fernhill/api/permissions.py',
            'require_admin',
            19,
            '        raise PermissionDenied("workspace admin required")',
          ),
        ],
      },
    }),
    // ---------------- web-app
    issue({
      id: ISSUE_IDS.checkoutStuck,
      shortId: 'WEB-APP-2F',
      project: 'web-app',
      level: 'error',
      status: 'ignored',
      title: 'Error: Checkout button stuck in loading state (timeout 15000ms)',
      culprit: 'src/checkout/useCheckout.ts',
      firstSeen: '2026-10-27T17:35:00Z',
      lastSeen: H(1),
      count: 2200,
      userCount: 400,
      h24: [2200, 400],
      d7: [2200, 400],
      assignedTo: null,
      exception: {
        type: 'Error',
        value: 'Checkout button stuck in loading state (timeout 15000ms)',
        frames: [
          js(
            'src/checkout/CheckoutButton.tsx',
            'onClick',
            41,
            9,
            '    await submitCheckout(cart);',
          ),
          js(
            'src/checkout/useCheckout.ts',
            'submitCheckout',
            88,
            13,
            '      throw new Error(`Checkout button stuck in loading state (timeout ${TIMEOUT}ms)`);',
          ),
        ],
      },
      tags: { url: 'https://app.fernhill.io/billing/checkout' },
    }),
    issue({
      id: ISSUE_IDS.teamCalendar,
      shortId: 'WEB-APP-3J',
      project: 'web-app',
      level: 'error',
      status: 'unresolved',
      title: "TypeError: Cannot read properties of undefined (reading 'slots')",
      culprit: 'src/calendar/TeamCalendar.tsx',
      firstSeen: '2026-10-28T08:55:00Z',
      lastSeen: H(0.5),
      count: 380,
      userCount: 64,
      h24: [380, 64],
      d7: [380, 64],
      assignedTo: null,
      eventId: hex32('event:latest:3J'),
      otherEventIds: [QA_EVENT_ID],
      exception: {
        type: 'TypeError',
        value: "Cannot read properties of undefined (reading 'slots')",
        frames: [
          js(
            'src/calendar/TeamCalendar.tsx',
            'renderMemberRow',
            212,
            37,
            '  const free = availability[member.id].slots.filter(isFree);',
          ),
          js(
            'src/calendar/TeamCalendar.tsx',
            'TeamCalendar',
            96,
            18,
            '        {members.map(renderMemberRow)}',
          ),
        ],
      },
      tags: { url: 'https://app.fernhill.io/calendar/team' },
      user: { id: '88412', email: 'hannah.cole@fernhill.io' },
    }),
    issue({
      id: ISSUE_IDS.outlookInvite,
      shortId: 'WEB-APP-34',
      project: 'web-app',
      level: 'error',
      status: 'unresolved',
      title: "TypeError: Cannot read properties of null (reading 'organizer')",
      culprit: 'src/invites/parseOutlookInvite.ts',
      firstSeen: '2026-10-18T13:00:00Z',
      lastSeen: H(50),
      count: 640,
      userCount: 90,
      h24: [0, 0],
      d7: [210, 33],
      assignedTo: userAssignee(P.hannah),
      release: 'web-app@2026.10.3',
      exception: {
        type: 'TypeError',
        value: "Cannot read properties of null (reading 'organizer')",
        frames: [
          js(
            'src/invites/parseOutlookInvite.ts',
            'parseOutlookInvite',
            33,
            25,
            '  const organizer = vcal.organizer.email;',
          ),
        ],
      },
    }),
    // ---------------- billing-worker
    issue({
      id: '6020551901',
      shortId: 'BILLING-WORKER-2K',
      project: 'billing-worker',
      level: 'error',
      status: 'unresolved',
      title: 'CardError: Your card was declined. (decline_code=insufficient_funds)',
      culprit: 'billing_worker.retries in retry_failed_payment',
      firstSeen: '2026-10-19T03:00:00Z',
      lastSeen: H(1),
      count: 5100,
      userCount: 210,
      h24: [940, 50],
      d7: [5100, 210],
      assignedTo: userAssignee(P.priya),
      exception: {
        type: 'CardError',
        value: 'Your card was declined.',
        frames: [
          py(
            'billing_worker/retries.py',
            'retry_failed_payment',
            54,
            '        stripe.Invoice.pay(invoice_id, off_session=True)',
          ),
        ],
      },
    }),
    issue({
      id: '6020883310',
      shortId: 'BILLING-WORKER-2M',
      project: 'billing-worker',
      level: 'error',
      status: 'unresolved',
      title:
        'DunningError: invoice has amount_remaining but customer has no default payment method',
      culprit: 'billing_worker.dunning in send_dunning_email',
      firstSeen: '2026-10-21T08:00:00Z',
      lastSeen: H(2),
      count: 3000,
      userCount: 60,
      h24: [610, 23],
      d7: [3000, 60],
      assignedTo: null,
      exception: {
        type: 'DunningError',
        value: 'invoice has amount_remaining but customer has no default payment method',
        frames: [
          py(
            'billing_worker/dunning.py',
            'run_dunning_cycle',
            31,
            '        send_dunning_email(invoice)',
          ),
          py(
            'billing_worker/dunning.py',
            'send_dunning_email',
            72,
            '        raise DunningError("invoice has amount_remaining but customer has no default payment method")',
          ),
        ],
      },
      tags: { stripe_customer: ostrava, task: 'billing_worker.dunning.run_dunning_cycle' },
    }),
    issue({
      id: '6021002417',
      shortId: 'BILLING-WORKER-2P',
      project: 'billing-worker',
      level: 'error',
      status: 'unresolved',
      title: 'Timeout: Request to Stripe timed out after 80s (POST /v1/invoices/{id}/pay)',
      culprit: 'billing_worker.stripe_client in pay_invoice',
      firstSeen: '2026-10-22T14:00:00Z',
      lastSeen: H(5),
      count: 2300,
      userCount: 75,
      h24: [1720, 51],
      d7: [2300, 75],
      assignedTo: null,
      exception: {
        type: 'Timeout',
        value: 'Request to Stripe timed out after 80s',
        frames: [
          py(
            'billing_worker/stripe_client.py',
            'pay_invoice',
            40,
            '    return stripe.Invoice.pay(invoice_id, **kwargs)',
          ),
        ],
      },
    }),
    issue({
      id: '6021226005',
      shortId: 'BILLING-WORKER-2R',
      project: 'billing-worker',
      level: 'error',
      status: 'unresolved',
      title: "KeyError: 'proration_date'",
      culprit: 'billing_worker.seats in sync_seat_count',
      firstSeen: '2026-10-25T09:00:00Z',
      lastSeen: H(20),
      count: 210,
      userCount: 14,
      h24: [85, 6],
      d7: [210, 14],
      assignedTo: null,
      exception: {
        type: 'KeyError',
        value: "'proration_date'",
        frames: [
          py(
            'billing_worker/seats.py',
            'sync_seat_count',
            88,
            "    ts = event['data']['proration_date']",
          ),
        ],
      },
    }),
    issue({
      id: '6021530772',
      shortId: 'BILLING-WORKER-31',
      project: 'billing-worker',
      level: 'error',
      status: 'unresolved',
      title: 'ZeroDivisionError: division by zero',
      culprit: 'billing_worker.usage in seats_utilization',
      firstSeen: '2026-10-27T15:05:00Z',
      lastSeen: H(23.83),
      count: 12,
      userCount: 2,
      h24: [12, 2],
      d7: [12, 2],
      assignedTo: null,
      exception: {
        type: 'ZeroDivisionError',
        value: 'division by zero',
        frames: [
          py('billing_worker/usage.py', 'seats_utilization', 17, '    return active / total'),
        ],
      },
    }),
    issue({
      id: '6019700233',
      shortId: 'BILLING-WORKER-2Q',
      project: 'billing-worker',
      level: 'error',
      status: 'unresolved',
      title: 'ConnectionResetError: [Errno 104] Connection reset by peer',
      culprit: 'billing_worker.queue in consume',
      firstSeen: '2026-10-16T00:00:00Z',
      lastSeen: H(25),
      count: 30000,
      userCount: 0,
      h24: [0, 0],
      d7: [8800, 0],
      assignedTo: null,
      exception: {
        type: 'ConnectionResetError',
        value: '[Errno 104] Connection reset by peer',
        frames: [
          py('billing_worker/queue.py', 'consume', 29, '        msg = channel.basic_get(queue)'),
        ],
      },
    }),
    issue({
      id: '6021400128',
      shortId: 'BILLING-WORKER-2T',
      project: 'billing-worker',
      level: 'error',
      status: 'resolved',
      substatus: null,
      title: 'StripeAuthenticationError: Expired API key provided: rk_live_****Xq2',
      culprit: 'billing_worker.stripe_client in client',
      firstSeen: '2026-10-28T09:00:00Z',
      lastSeen: H(3),
      count: 44,
      userCount: 3,
      h24: [44, 3],
      d7: [44, 3],
      assignedTo: userAssignee(P.raj),
      exception: {
        type: 'AuthenticationError',
        value: 'Expired API key provided',
        frames: [
          py(
            'billing_worker/stripe_client.py',
            'client',
            12,
            '    return stripe.StripeClient(settings.STRIPE_KEY)',
          ),
        ],
      },
    }),
    issue({
      id: '6020009871',
      shortId: 'BILLING-WORKER-2V',
      project: 'billing-worker',
      level: 'warning',
      status: 'ignored',
      title: 'RetryLimitWarning: invoice retry scheduled beyond dunning window',
      culprit: 'billing_worker.retries in schedule_retry',
      firstSeen: '2026-10-18T00:00:00Z',
      lastSeen: H(2),
      count: 31000,
      userCount: 3,
      h24: [5000, 3],
      d7: [21000, 3],
      assignedTo: null,
      exception: {
        type: 'RetryLimitWarning',
        value: 'invoice retry scheduled beyond dunning window',
        frames: [
          py(
            'billing_worker/retries.py',
            'schedule_retry',
            90,
            '    warnings.warn(RetryLimitWarning(msg))',
          ),
        ],
      },
    }),
    issue({
      id: '6019381147',
      shortId: 'BILLING-WORKER-2H',
      project: 'billing-worker',
      level: 'error',
      status: 'unresolved',
      title:
        'IdempotencyError: Keys for idempotent requests can only be used with the same parameters they were first used with',
      culprit: 'billing_worker.retries in retry_failed_payment',
      firstSeen: '2026-10-14T00:00:00Z',
      lastSeen: H(52),
      count: 77,
      userCount: 9,
      h24: [0, 0],
      d7: [20, 4],
      assignedTo: userAssignee(P.priya),
      release: 'billing-worker@2026.10.3',
      exception: {
        type: 'IdempotencyError',
        value: 'Keys for idempotent requests can only be used with the same parameters',
        frames: [
          py(
            'billing_worker/retries.py',
            'retry_failed_payment',
            49,
            '        idem = f"retry-{invoice_id}"',
          ),
        ],
      },
    }),
    // ---------------- mobile-ios
    issue({
      id: ISSUE_IDS.iosBadAccess,
      shortId: 'MOBILE-IOS-1K',
      project: 'mobile-ios',
      level: 'fatal',
      status: 'unresolved',
      title: 'EXC_BAD_ACCESS: Attempted to dereference garbage pointer 0x10.',
      culprit: 'CalendarSyncManager.mergeRecurring(_:)',
      firstSeen: '2026-10-12T05:00:00Z',
      lastSeen: H(3),
      count: 1830,
      userCount: 214,
      h24: [160, 49],
      d7: [700, 120],
      assignedTo: teamAssignee('mobile'),
      exception: {
        type: 'EXC_BAD_ACCESS',
        value: 'Attempted to dereference garbage pointer 0x10.',
        frames: [
          {
            filename: 'CalendarSyncManager.swift',
            function: 'CalendarSyncManager.mergeRecurring(_:)',
            lineNo: 214,
            inApp: true,
          },
          {
            filename: 'SyncCoordinator.swift',
            function: 'SyncCoordinator.run()',
            lineNo: 88,
            inApp: true,
          },
        ],
      },
    }),
    issue({
      id: '6018870054',
      shortId: 'MOBILE-IOS-1M',
      project: 'mobile-ios',
      level: 'fatal',
      status: 'unresolved',
      title:
        'NSInvalidArgumentException: -[__NSCFNumber length]: unrecognized selector sent to instance',
      culprit: 'NotificationRouter.open(eventID:)',
      firstSeen: '2026-10-21T16:00:00Z',
      lastSeen: H(26),
      count: 96,
      userCount: 31,
      h24: [0, 0],
      d7: [96, 31],
      assignedTo: null,
      eventId: QA_OLD_EVENT_ID,
      exception: {
        type: 'NSInvalidArgumentException',
        value: '-[__NSCFNumber length]: unrecognized selector sent to instance',
        frames: [
          {
            filename: 'NotificationRouter.swift',
            function: 'NotificationRouter.open(eventID:)',
            lineNo: 51,
            inApp: true,
          },
        ],
      },
    }),
  ];

  // Browser-extension noise in web-app: seven unresolved, one ignored, one resolved, one app-code look-alike.
  const ext: [string, string, string, string][] = [
    [
      'WEB-APP-2A',
      "TypeError: Cannot read properties of null (reading 'postMessage')",
      'chrome-extension://hdokiejnpimakedhajhdlcegeplioahd/onloadwff.js',
      '6018120044',
    ],
    [
      'WEB-APP-2C',
      'Error: Could not establish connection. Receiving end does not exist.',
      'chrome-extension://bfnaelmomeimhlpmgjnjophhpkkoljpa/inpage.js',
      '6018222375',
    ],
    [
      'WEB-APP-2N',
      'SecurityError: Failed to read a named property from Window: Blocked a frame from accessing a cross-origin frame.',
      'moz-extension://1c9a7d2e-4f0b-4a7e-9c35-0d4e8b2f6a11/content.js',
      '6019044521',
    ],
    [
      'WEB-APP-2W',
      'TypeError: Cannot redefine property: ethereum',
      'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/contentscript.js',
      '6019570312',
    ],
    [
      'WEB-APP-31',
      'ResizeObserver loop completed with undelivered notifications.',
      'chrome-extension://fheoggkfdfchfphceeifdbepaooicaho/content_script.js',
      '6020118876',
    ],
    [
      'WEB-APP-37',
      'TypeError: e.getAttribute is not a function',
      'chrome-extension://nngceckbapebfimnlniiiahkandclblb/content/bootstrap.js',
      '6020871249',
    ],
    [
      'WEB-APP-3E',
      'Error: Extension context invalidated.',
      'moz-extension://8e2f0b7c-3a91-4d55-b2e6-71c9f04a3d18/inject.js',
      '6021733390',
    ],
  ];
  ext.forEach(([shortId, title, culprit, id], i) =>
    issues.push(
      issue({
        id,
        shortId,
        project: 'web-app',
        level: 'error',
        status: 'unresolved',
        title,
        culprit,
        firstSeen: `2026-10-${(5 + i * 3).toString().padStart(2, '0')}T0${i}:00:00Z`,
        lastSeen: H(3 + i * 7),
        count: 400 + i * 233,
        userCount: 30 + i * 11,
        h24: i < 4 ? [20 + i * 9, 4 + i] : [0, 0],
        d7: [150 + i * 40, 12 + i * 3],
        assignedTo: null,
        priority: 'low',
        exception: {
          type: title.split(':')[0] as string,
          value: title.split(': ').slice(1).join(': ') || title,
          frames: [js(culprit, 'n', 1, 4021 + i * 13, '/* minified */', false)],
        },
      }),
    ),
  );
  issues.push(
    issue({
      id: '6017004412',
      shortId: 'WEB-APP-1V',
      project: 'web-app',
      level: 'error',
      status: 'ignored',
      title: 'TypeError: Failed to fetch (chrome-extension)',
      culprit: 'chrome-extension://gighmmpiobklfepjocnamgkkbiglidom/content.js',
      firstSeen: '2026-09-28T00:00:00Z',
      lastSeen: H(9),
      count: 2900,
      userCount: 310,
      h24: [33, 9],
      d7: [480, 70],
      assignedTo: null,
      priority: 'low',
      exception: {
        type: 'TypeError',
        value: 'Failed to fetch',
        frames: [
          js(
            'chrome-extension://gighmmpiobklfepjocnamgkkbiglidom/content.js',
            'n',
            1,
            900,
            '',
            false,
          ),
        ],
      },
    }),
    issue({
      id: '6016330981',
      shortId: 'WEB-APP-1R',
      project: 'web-app',
      level: 'error',
      status: 'resolved',
      substatus: null,
      title: "TypeError: Cannot read properties of undefined (reading 'sendMessage')",
      culprit: 'chrome-extension://aapbdbdomjkkjkaonfhkkikfgjllcleb/translate.js',
      firstSeen: '2026-09-20T00:00:00Z',
      lastSeen: '2026-10-19T00:00:00Z',
      count: 120,
      userCount: 40,
      h24: [0, 0],
      d7: [0, 0],
      assignedTo: null,
      exception: {
        type: 'TypeError',
        value: "Cannot read properties of undefined (reading 'sendMessage')",
        frames: [
          js(
            'chrome-extension://aapbdbdomjkkjkaonfhkkikfgjllcleb/translate.js',
            'n',
            1,
            77,
            '',
            false,
          ),
        ],
      },
    }),
    issue({
      id: '6020766123',
      shortId: 'WEB-APP-35',
      project: 'web-app',
      level: 'error',
      status: 'unresolved',
      title: "Error: Calendar extension field 'x-fernhill-room' missing",
      culprit: 'src/calendar/fields/extensionFields.ts',
      firstSeen: '2026-10-24T10:00:00Z',
      lastSeen: H(8),
      count: 95,
      userCount: 21,
      h24: [12, 4],
      d7: [95, 21],
      assignedTo: null,
      exception: {
        type: 'Error',
        value: "Calendar extension field 'x-fernhill-room' missing",
        frames: [
          js(
            'src/calendar/fields/extensionFields.ts',
            'readExtensionField',
            27,
            11,
            "  if (!value) throw new Error(`Calendar extension field '${key}' missing`);",
          ),
        ],
      },
    }),
  );
  // Ordinary web-app, mobile and marketing-site issues (filler).
  const fillers: [string, string, string, string][] = [
    [
      'web-app',
      "TypeError: Cannot read properties of undefined (reading 'length')",
      'src/booking/SlotPicker.tsx',
      'WEB-APP-2B',
    ],
    ['web-app', 'ChunkLoadError: Loading chunk 812 failed.', 'src/router/lazy.ts', 'WEB-APP-2D'],
    ['web-app', 'AbortError: The user aborted a request.', 'src/api/client.ts', 'WEB-APP-2H'],
    ['web-app', 'RangeError: Invalid time value', 'src/utils/formatDate.ts', 'WEB-APP-2J'],
    [
      'web-app',
      'Error: Request failed with status code 409',
      'src/booking/useReschedule.ts',
      'WEB-APP-2M',
    ],
    [
      'web-app',
      "TypeError: Cannot destructure property 'id' of 'workspace' as it is null.",
      'src/settings/WorkspaceSettings.tsx',
      'WEB-APP-2Q',
    ],
    ['web-app', 'NotAllowedError: Write permission denied.', 'src/share/copyLink.ts', 'WEB-APP-2S'],
    ['web-app', 'Error: Minified React error #418', 'src/app/root.tsx', 'WEB-APP-2V'],
    [
      'web-app',
      'UnhandledRejection: Non-Error promise rejection captured with value: undefined',
      'src/analytics/track.ts',
      'WEB-APP-2Y',
    ],
    [
      'web-app',
      'TypeError: NetworkError when attempting to fetch resource.',
      'src/api/client.ts',
      'WEB-APP-32',
    ],
    ['web-app', "SyntaxError: Unexpected token '<'", 'src/api/client.ts', 'WEB-APP-33'],
    [
      'web-app',
      'Error: Timezone "America/Ciudad_Juarez" is not supported',
      'src/utils/timezones.ts',
      'WEB-APP-36',
    ],
    [
      'web-app',
      "TypeError: Cannot read properties of undefined (reading 'map')",
      'src/admin/AuditLog.tsx',
      'WEB-APP-38',
    ],
    [
      'web-app',
      'Error: Invariant failed: slot must belong to calendar',
      'src/booking/reducer.ts',
      'WEB-APP-3A',
    ],
    [
      'web-app',
      'QuotaExceededError: The quota has been exceeded.',
      'src/storage/draft.ts',
      'WEB-APP-3C',
    ],
    [
      'web-app',
      'Error: ResizeObserver loop limit exceeded',
      'src/calendar/WeekGrid.tsx',
      'WEB-APP-3G',
    ],
    [
      'mobile-ios',
      'NSRangeException: index 7 beyond bounds [0 .. 6]',
      'WeekView.layoutDays()',
      'MOBILE-IOS-1F',
    ],
    ['mobile-ios', 'URLError: The request timed out.', 'APIClient.send(_:)', 'MOBILE-IOS-1H'],
    [
      'marketing-site',
      "TypeError: Cannot read properties of null (reading 'addEventListener')",
      'components/PricingToggle.tsx',
      'MARKETING-SITE-9',
    ],
    [
      'marketing-site',
      'Error: Hydration failed because the initial UI does not match',
      'app/layout.tsx',
      'MARKETING-SITE-B',
    ],
  ];
  fillers.forEach(([project, title, culprit, shortId], i) =>
    issues.push(
      issue({
        id: String(6014000000 + i * 271_113),
        shortId,
        project,
        level: i % 5 === 3 ? 'warning' : 'error',
        status: 'unresolved',
        title,
        culprit,
        firstSeen: `2026-${i % 3 === 0 ? '09' : '10'}-${(3 + i).toString().padStart(2, '0')}T12:00:00Z`,
        lastSeen: H(4 + i * 5.5),
        count: 60 + ((i * 397) % 2400),
        userCount: 5 + ((i * 53) % 160),
        h24: 4 + i * 5.5 < 24 ? [3 + i * 2, 1 + (i % 4)] : [0, 0],
        d7: [30 + i * 17, 4 + (i % 9) * 3],
        assignedTo:
          i % 4 === 0 ? teamAssignee(project === 'mobile-ios' ? 'mobile' : 'frontend') : null,
        exception: {
          type: title.split(':')[0] as string,
          value: title.split(': ').slice(1).join(': ') || title,
          frames: [js(culprit, 'anonymous', 10 + i, 7, '')],
        },
      }),
    ),
  );
  return issues;
}

export interface SentryState {
  issues: SentryIssue[];
  /** Every successful write: `{ kind, issue (short ID), detail }`. */
  mutations: { kind: 'update' | 'note'; issue: string; detail: Record<string, unknown> }[];
}

export function seedSentry(): SentryState {
  return { issues: seedSentryIssues(), mutations: [] };
}

export const RELEASES: readonly {
  version: string;
  project: string;
  dateCreated: string;
  newIssues: number;
  commit: string;
  author: string;
}[] = [
  {
    version: 'api@2026.10.4',
    project: 'api',
    dateCreated: '2026-10-27T08:40:00Z',
    newIssues: 3,
    commit: 'Raise tax client pool size',
    author: 'Priya Raman',
  },
  {
    version: 'api@2026.10.3',
    project: 'api',
    dateCreated: '2026-10-20T09:10:00Z',
    newIssues: 2,
    commit: 'Fix Google calendar quota handling',
    author: 'Jonas Weber',
  },
  {
    version: 'api@2026.10.2',
    project: 'api',
    dateCreated: '2026-10-13T09:00:00Z',
    newIssues: 4,
    commit: 'Invoice credits v2',
    author: 'Priya Raman',
  },
  {
    version: 'billing-worker@2026.10.4',
    project: 'billing-worker',
    dateCreated: '2026-10-27T09:05:00Z',
    newIssues: 2,
    commit: 'Retry webhooks on 502',
    author: 'Priya Raman',
  },
  {
    version: 'billing-worker@2026.10.3',
    project: 'billing-worker',
    dateCreated: '2026-10-20T09:30:00Z',
    newIssues: 1,
    commit: 'Dunning: skip customers without payment method',
    author: 'Raj Mehta',
  },
  {
    version: 'web-app@2026.10.4',
    project: 'web-app',
    dateCreated: '2026-10-27T10:00:00Z',
    newIssues: 5,
    commit: 'Team calendar availability rows',
    author: 'Hannah Cole',
  },
  {
    version: 'web-app@2026.10.3',
    project: 'web-app',
    dateCreated: '2026-10-20T10:00:00Z',
    newIssues: 3,
    commit: 'Outlook invite parser',
    author: 'Hannah Cole',
  },
  {
    version: 'ios@5.12.1+812',
    project: 'mobile-ios',
    dateCreated: '2026-10-10T07:00:00Z',
    newIssues: 2,
    commit: 'Recurring event merge',
    author: 'Kenji Watanabe',
  },
];

// ---------------------------------------------------------------------------
// Rendering

function relative(iso: string): string {
  const diff = SUMMIT_NOW_MS - Date.parse(iso);
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 1) {
    const m = Math.floor(diff / 60_000);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return iso.slice(0, 10);
}

const issueUrl = (shortId: string): string => `${WEB}/issues/${shortId}`;
const projectOf = (issueRow: SentryIssue): SentryProject =>
  PROJECTS.find((p) => p.slug === issueRow.project) as SentryProject;

function windowCounts(row: SentryIssue, period: string): [number, number] {
  if (period === '24h') return row.h24;
  if (period === '7d') return row.d7;
  const days = period === '14d' ? 14 : period === '30d' ? 30 : 90;
  if (Date.parse(row.firstSeen) >= SUMMIT_NOW_MS - days * 86_400_000)
    return [row.count, row.userCount];
  const age = (Date.parse(row.lastSeen) - Date.parse(row.firstSeen)) / 86_400_000;
  const share = Math.min(1, days / Math.max(age, 1));
  return [
    Math.max(row.d7[0], Math.round(row.count * share)),
    Math.max(row.d7[1], Math.round(row.userCount * share)),
  ];
}

function statusDisplay(row: SentryIssue): string {
  return row.status;
}

function assignedName(a: Assignee | null): string {
  return a === null ? 'Unassigned' : a.name;
}

function formatIssueResults(
  rows: { row: SentryIssue; events: number; users: number }[],
  inputQuery: string,
  query: string,
  projectSlug: string | undefined,
): string {
  let out = `# Search Results for "${inputQuery}"\n\n`;
  out +=
    '**Suggested presentation:** Cards work well for these issues, with status, assignee, and issue ID links visible.\n\n';
  if (rows.length === 0) {
    out += 'No issues found matching your search criteria.\n\n';
    out += 'Try adjusting your search criteria or time range.';
    return out;
  }
  const project =
    projectSlug !== undefined
      ? PROJECTS.find((p) => p.slug === projectSlug || p.id === projectSlug)
      : undefined;
  out += `**View these results in Sentry**:\n${WEB}/issues/?${project !== undefined ? `project=${project.id}&` : ''}query=${encodeURIComponent(query)}\n`;
  out +=
    'Please tell the user this dashboard link is available if they want to open the results in Sentry.\n\n';
  out += `Found **${rows.length}** issue${rows.length === 1 ? '' : 's'}:\n\n`;
  rows.forEach(({ row, events, users }, i) => {
    out += `## ${i + 1}. [${row.shortId}](${issueUrl(row.shortId)})\n\n`;
    out += `**${row.title}**\n\n`;
    out += `- **Status**: ${row.status}\n`;
    out += `- **Users**: ${users}\n`;
    out += `- **Events**: ${events}\n`;
    if (row.assignedTo !== null) out += `- **Assigned to**: ${row.assignedTo.name}\n`;
    out += `- **First seen**: ${relative(row.firstSeen)}\n`;
    out += `- **Last seen**: ${relative(row.lastSeen)}\n`;
    out += `- **Culprit**: \`${row.culprit}\`\n`;
    out += '\n';
  });
  out += '## Next Steps\n\n';
  out +=
    '- Get more details about a specific issue: Use get_sentry_resource with the issue ID or issue URL\n';
  out += '- Update issue status: Use the Sentry tool `update_issue` to resolve or assign issues\n';
  out += '- View event counts: Use search_events for aggregated statistics\n';
  return out;
}

function frameHeader(f: Frame, platform: string): string {
  if (platform.startsWith('python'))
    return `  File "${f.filename}", line ${f.lineNo}, in ${f.function}`;
  if (platform.startsWith('javascript'))
    return `${[f.filename, f.lineNo, f.colNo].filter((x) => x !== undefined).join(':')} (${f.function})`;
  return `    at ${f.function} (${f.filename}:${f.lineNo})`;
}

function formatIssueDetails(row: SentryIssue, eventId?: string): string {
  const project = projectOf(row);
  let out = `# Issue ${row.shortId} in **${SENTRY_ORG}**\n\n`;
  out += `**Description**: ${row.title}\n`;
  out += `**Culprit**: ${row.culprit}\n`;
  out += `**First Seen**: ${new Date(row.firstSeen).toISOString()}\n`;
  out += `**Last Seen**: ${new Date(row.lastSeen).toISOString()}\n`;
  out += `**Occurrences**: ${row.count}\n`;
  out += `**Users Impacted**: ${row.userCount}\n`;
  out += `**Status**: ${row.status}\n`;
  if (row.substatus !== null) out += `**Substatus**: ${row.substatus}\n`;
  if (row.assignedTo !== null)
    out += `**Assigned To**: ${row.assignedTo.name} (${row.assignedTo.type === 'team' ? 'Team' : 'User'})\n`;
  out += '**Issue Type**: error\n';
  out += '**Issue Category**: error\n';
  out += `**Platform**: ${project.platform.split('-')[0]}\n`;
  out += `**Project**: ${project.name}\n`;
  out += `**URL**: ${issueUrl(row.shortId)}\n\n`;
  out += '## Event Details\n\n';
  out += `**Event ID**: ${eventId ?? row.eventId}\n`;
  out += '**Type**: error\n';
  out += `**Occurred At**: ${new Date(row.lastSeen).toISOString()}\n`;
  out += `**Message**:\n${row.exception.type}: ${row.exception.value}\n\n`;
  out += `### Error\n\n\`\`\`\n${row.exception.type}: ${row.exception.value}\n\`\`\`\n\n`;
  out += '**Stacktrace:**\n```\n';
  for (const f of row.exception.frames) {
    out += `${frameHeader(f, project.platform)}\n`;
    for (const [n, code] of f.context ?? [])
      out += `${n === f.lineNo ? '  -->' : '     '} ${n} | ${code}\n`;
  }
  out += '```\n\n';
  if (row.user !== undefined) {
    out += `### User\n\n**user**: ${Object.entries(row.user)
      .map(([k, v]) => `${k === 'ip_address' ? 'ip' : k}:${v}`)
      .join(', ')}\n\n`;
  }
  out += `### Tags\n\n${Object.entries(row.tags)
    .map(([k, v]) => `**${k}**: ${v}`)
    .join('\n')}\n\n`;
  out +=
    "### Additional Context\n\nThese are additional context provided by the user when they're instrumenting their application.\n\n";
  out += project.platform.startsWith('python')
    ? '**runtime**\nname: "CPython"\nversion: "3.12.7"\n\n'
    : project.platform === 'apple-ios'
      ? '**device**\nmodel: "iPhone15,3"\nfamily: "iOS"\n\n**os**\nname: "iOS"\nversion: "18.0.1"\n\n'
      : '**browser**\nname: "Chrome"\nversion: "130.0.0"\n\n**os**\nname: "Windows"\nversion: "10"\n\n';
  out += '## Response Notes\n\n';
  out += `- Commit message issue reference: \`Fixes ${row.shortId}\` automatically closes the issue when the commit is merged.\n`;
  out +=
    '- The stacktrace includes first-party application code and third-party code. First-party frames are usually the best starting point for triage.\n';
  out += '- Issue event search: Use the Sentry tool `search_issue_events`\n';
  return out;
}

function inputError(message: string): BoxResult {
  return textResult(
    [
      '**Input Error**',
      'It looks like there was a problem with the input you provided.',
      message,
      'You may be able to resolve the issue by addressing the concern and trying again.',
    ].join('\n\n'),
    true,
  );
}

function apiError(status: number, detail: string): BoxResult {
  return textResult(
    [
      '**Input Error**',
      `There was an HTTP ${status} error with your request to the Sentry API.`,
      detail,
      'You may be able to resolve the issue by addressing the concern and trying again.',
    ].join('\n\n'),
    true,
  );
}

// ---------------------------------------------------------------------------
// Issue search (Sentry's issue-search syntax, the parts a model reaches for)

function tokenize(query: string): string[] {
  return [...query.matchAll(/(!?[\w.]+:"[^"]*"|"[^"]*"|\S+)/g)].map((m) => m[0] as string);
}

function parseRelative(value: string): number | undefined {
  const m = /^-(\d+)([mhdw])$/.exec(value);
  if (m === null) return undefined;
  const n = Number(m[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[
    m[2] as 'm' | 'h' | 'd' | 'w'
  ];
  return SUMMIT_NOW_MS - n * unit;
}

function compareDate(value: string): ((t: number) => boolean) | undefined {
  const rel = parseRelative(value);
  if (rel !== undefined) return (t) => t >= rel;
  const m = /^(>=|<=|>|<)?(\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?)$/.exec(value);
  if (m === null) return undefined;
  const at = Date.parse(m[2]?.includes('T') === true ? (m[2] as string) : `${m[2]}T00:00:00Z`);
  switch (m[1]) {
    case '>':
      return (t) => t > at;
    case '>=':
      return (t) => t >= at;
    case '<':
      return (t) => t < at;
    case '<=':
      return (t) => t <= at;
    default:
      return (t) => t >= at && t < at + 86_400_000;
  }
}

function compareNumber(value: string): ((n: number) => boolean) | undefined {
  const m = /^(>=|<=|>|<)?(\d+)$/.exec(value);
  if (m === null) return undefined;
  const v = Number(m[2]);
  return {
    '>': (n: number) => n > v,
    '>=': (n: number) => n >= v,
    '<': (n: number) => n < v,
    '<=': (n: number) => n <= v,
    '': (n: number) => n === v,
  }[m[1] ?? ''];
}

type Matcher = (row: SentryIssue, events: number, users: number) => boolean;

/** Compile an issue query; a string is a 400 detail from Sentry. */
export function compileIssueQuery(query: string): Matcher | string {
  const matchers: Matcher[] = [];
  for (const raw of tokenize(query)) {
    const negate = raw.startsWith('!');
    const token = negate ? raw.slice(1) : raw;
    const colon = token.indexOf(':');
    let m: Matcher;
    if (colon <= 0 || token.startsWith('"')) {
      const text = token.replace(/^"|"$/g, '').toLowerCase();
      m = (row) => `${row.title} ${row.culprit}`.toLowerCase().includes(text);
    } else {
      const key = token.slice(0, colon);
      const value = token.slice(colon + 1).replace(/^"|"$/g, '');
      switch (key) {
        case 'is': {
          const v = value.toLowerCase();
          const fn: Matcher | undefined = {
            unresolved: (r: SentryIssue) => r.status === 'unresolved',
            resolved: (r: SentryIssue) => r.status === 'resolved',
            ignored: (r: SentryIssue) => r.status === 'ignored',
            archived: (r: SentryIssue) => r.status === 'ignored',
            assigned: (r: SentryIssue) => r.assignedTo !== null,
            unassigned: (r: SentryIssue) => r.assignedTo === null,
            new: (r: SentryIssue) => r.substatus === 'new',
            ongoing: (r: SentryIssue) => r.substatus === 'ongoing',
            regressed: (r: SentryIssue) => r.substatus === 'regressed',
            escalating: (r: SentryIssue) => r.substatus === 'escalating',
            for_review: (r: SentryIssue) => r.status === 'unresolved' && r.substatus === 'new',
            linked: () => false,
            unlinked: () => true,
          }[v];
          if (fn === undefined) return `Invalid value for "is" search: ${value}`;
          m = fn;
          break;
        }
        case 'level':
          m = (r) => r.level === value.toLowerCase();
          break;
        case 'project':
          m = (r) => r.project === value;
          break;
        case 'environment':
          m = (r) => r.environment === value;
          break;
        case 'release':
          m = (r) =>
            value === 'latest'
              ? r.release.endsWith('2026.10.4') || r.release === 'ios@5.12.1+812'
              : r.release === value || r.release.endsWith(`@${value}`);
          break;
        case 'assigned':
        case 'assigned_or_suggested': {
          const v = value.toLowerCase();
          m = (r) => {
            const a = r.assignedTo;
            if (a === null) return v === 'none' || v === '[]';
            if (v === 'me') return a.type === 'user' && a.id === PEOPLE.raj.sentryId;
            if (v.startsWith('#')) return a.type === 'team' && a.name === v.slice(1);
            return a.type === 'user' ? a.email === v || a.id === v : a.name === v;
          };
          break;
        }
        case 'has':
          m = (r) => (value === 'assignee' ? r.assignedTo !== null : value in r.tags);
          break;
        case 'firstSeen':
        case 'lastSeen':
        case 'age': {
          const cmp = compareDate(value);
          if (cmp === undefined) return `Invalid date: ${value}`;
          m = (r) => cmp(Date.parse(key === 'lastSeen' ? r.lastSeen : r.firstSeen));
          break;
        }
        case 'userCount':
        case 'times_seen':
        case 'timesSeen': {
          const cmp = compareNumber(value);
          if (cmp === undefined) return `Invalid number: ${value}`;
          m = key === 'userCount' ? (_r, _e, u) => cmp(u) : (_r, e) => cmp(e);
          break;
        }
        case 'issue.priority':
          m = (r) => value.split(',').includes(r.priority);
          break;
        case 'issue.category':
          m = () => value === 'error';
          break;
        case 'issue':
        case 'issue.id':
          m = (r) => r.shortId === value.toUpperCase() || r.id === value;
          break;
        case 'error.type':
          m = (r) => r.exception.type === value;
          break;
        case 'error.value':
        case 'message':
          m = (r) =>
            `${r.title} ${r.exception.value}`
              .toLowerCase()
              .includes(value.toLowerCase().replace(/\*/g, ''));
          break;
        case 'title':
          m = (r) => r.title.toLowerCase().includes(value.toLowerCase().replace(/\*/g, ''));
          break;
        case 'culprit':
        case 'transaction':
          m = (r) => r.culprit.toLowerCase().includes(value.toLowerCase().replace(/\*/g, ''));
          break;
        case 'event.id':
        case 'id':
          m = (r) => r.eventId === value || (r.otherEventIds ?? []).includes(value);
          break;
        default:
          // Unknown keys are tag searches in Sentry.
          m = (r) => {
            const tag = r.tags[key];
            if (tag === undefined) return false;
            if (value.includes('*'))
              return new RegExp(
                `^${value
                  .split('*')
                  .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
                  .join('.*')}$`,
                'i',
              ).test(tag);
            return tag === value;
          };
      }
    }
    matchers.push(negate ? (r, e, u) => !m(r, e, u) : m);
  }
  return (r, e, u) => matchers.every((fn) => fn(r, e, u));
}

// ---------------------------------------------------------------------------
// Tools

const byName = new Map(CATALOG.tools.map((t) => [t.name, t]));

function def(name: string): Omit<SummitTool, 'handler'> {
  const t = byName.get(name) as CatalogTool;
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema } : {}),
    annotations: t.annotations,
  };
}

/** An empty value that satisfies `schema` (for catalog tools with no data in this org). */
function emptyFor(schema: Record<string, unknown> | undefined): unknown {
  if (schema === undefined) return {};
  if (schema['anyOf'] !== undefined) {
    const opts = schema['anyOf'] as Record<string, unknown>[];
    return opts.some((o) => o['type'] === 'null') ? null : emptyFor(opts[0]);
  }
  switch (schema['type']) {
    case 'array':
      return [];
    case 'boolean':
      return false;
    case 'number':
    case 'integer':
      return 0;
    case 'string':
      return '';
    case 'null':
      return null;
    case 'object': {
      const props = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
      const required = (schema['required'] ?? []) as string[];
      return Object.fromEntries(required.map((k) => [k, emptyFor(props[k])]));
    }
    default:
      return null;
  }
}

/** Port of tools/catalog-runtime/search.ts `scoreTool`. */
function scoreTool(t: CatalogTool, query: string): number {
  const q = query.toLowerCase();
  const tokens = q
    .split(/[^a-z0-9_]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const name = t.name.toLowerCase();
  const description = t.description.toLowerCase();
  let score = `${name} ${description}`.includes(q) ? 20 : 0;
  for (const token of tokens) {
    if (name === token) score += 12;
    else if (name.includes(token)) score += 8;
    if (description.includes(token)) score += 2;
  }
  return score;
}

const CATALOG_INFRA = new Set(['search_sentry_tools', 'execute_sentry_tool']);

function handlers(state: SentryState): Record<string, (args: Args) => BoxResult> {
  const findIssue = (id: string): SentryIssue | undefined => {
    const key = id.trim();
    return state.issues.find((r) => r.id === key || r.shortId === key.toUpperCase());
  };
  const checkOrg = (args: Args): BoxResult | undefined => {
    const org = str(args, 'organizationSlug');
    if (org === undefined) return undefined;
    if (org !== SENTRY_ORG) return apiError(404, 'The requested resource does not exist');
    return undefined;
  };
  const parseIssueUrl = (url: string): { org: string; id: string } | undefined => {
    const m =
      /^https?:\/\/(?:([\w-]+)\.)?sentry\.io\/(?:organizations\/([\w-]+)\/)?issues\/([\w-]+)/.exec(
        url,
      );
    if (m === null) return undefined;
    return { org: (m[2] ?? m[1] ?? '') as string, id: m[3] as string };
  };

  const issueDetails = (args: Args): BoxResult => {
    let org = str(args, 'organizationSlug');
    let issueId = str(args, 'issueId');
    const eventId = str(args, 'eventId');
    const url = str(args, 'issueUrl');
    if (url !== undefined) {
      const parsed = parseIssueUrl(url);
      if (parsed === undefined)
        return inputError('Invalid Sentry issue URL. URL must be a non-empty string.');
      org = parsed.org;
      issueId = parsed.id;
    }
    if (issueId === undefined && eventId === undefined)
      return inputError('Either `issueId` or `issueUrl` must be provided');
    if (org === undefined)
      return inputError(
        `\`organizationSlug\` is required when providing \`${eventId !== undefined ? 'eventId' : 'issueId'}\``,
      );
    if (org !== SENTRY_ORG) return apiError(404, 'The requested resource does not exist');
    if (issueId === undefined && eventId !== undefined) {
      const row = state.issues.find(
        (r) => r.eventId === eventId || (r.otherEventIds ?? []).includes(eventId),
      );
      if (row === undefined) return inputError(`No issue found for Event ID: ${eventId}`);
      return textResult(formatIssueDetails(row, eventId));
    }
    const row = findIssue(issueId as string);
    if (row === undefined) return apiError(404, 'The requested resource does not exist');
    return textResult(formatIssueDetails(row, eventId));
  };

  const updateIssue = (args: Args): BoxResult => {
    let org = str(args, 'organizationSlug');
    let issueId = str(args, 'issueId');
    const url = str(args, 'issueUrl');
    if (url === undefined && issueId === undefined)
      return inputError('Either `issueId` or `issueUrl` must be provided');
    if (url === undefined && org === undefined)
      return inputError('`organizationSlug` is required when providing `issueId`');
    const status = str(args, 'status');
    const hasAssigned = 'assignedTo' in args;
    if (status === undefined && !hasAssigned)
      return inputError(
        'At least one of `status` or `assignedTo` must be provided to update the issue',
      );
    if (url !== undefined) {
      const parsed = parseIssueUrl(url);
      if (parsed === undefined)
        return inputError('Invalid Sentry issue URL. URL must be a non-empty string.');
      org = parsed.org;
      issueId = parsed.id;
    }
    if (org !== SENTRY_ORG) return apiError(404, 'The requested resource does not exist');
    const row = findIssue(issueId as string);
    if (row === undefined) return apiError(404, 'The requested resource does not exist');

    // Resolve the assignee the way the API does: user:ID, team:ID or team slug, an email, a username, "me".
    let newAssignee: Assignee | null | undefined;
    if (hasAssigned) {
      const raw = args['assignedTo'];
      if (raw === null) newAssignee = null;
      else {
        const v = String(raw).trim();
        const users = Object.values(PEOPLE).filter((p) => p.deleted !== true);
        let found: Assignee | undefined;
        if (v === 'me') found = userAssignee(PEOPLE.raj);
        else if (v.startsWith('user:')) {
          const p = users.find((u) => u.sentryId === v.slice(5));
          if (p !== undefined) found = userAssignee(p);
        } else if (v.startsWith('team:') || v.startsWith('#')) {
          const t = TEAMS.find(
            (x) => x.id === v.replace(/^team:|^#/, '') || x.slug === v.replace(/^team:|^#/, ''),
          );
          if (t !== undefined) found = teamAssignee(t.slug);
        } else {
          const p = users.find(
            (u) => u.email === v.toLowerCase() || u.slackName === v.toLowerCase(),
          );
          if (p !== undefined) found = userAssignee(p);
        }
        if (found === undefined)
          return apiError(400, `API error (400): {"assignedTo":["Unknown actor input"]}`);
        newAssignee = found;
      }
    }

    const ignoreMode = str(args, 'ignoreMode');
    const wantSub =
      status === 'ignored'
        ? ignoreMode === 'forever'
          ? 'archived_forever'
          : ignoreMode === undefined || ignoreMode === 'untilEscalating'
            ? 'archived_until_escalating'
            : 'archived_until_condition_met'
        : undefined;
    const before = {
      status: row.status,
      substatus: row.substatus,
      assignee: assignedName(row.assignedTo),
    };
    const statusSame =
      status === undefined ||
      (status === 'ignored'
        ? row.status === 'ignored' && (ignoreMode === undefined || row.substatus === wantSub)
        : row.status === (status === 'resolvedInNextRelease' ? 'resolved' : status));
    if (
      status === 'ignored' &&
      row.status === 'ignored' &&
      ignoreMode !== undefined &&
      row.substatus !== wantSub
    ) {
      const fam = (s: string | null): string =>
        s === 'archived_forever' ? 'forever' : s === 'archived_until_escalating' ? 'esc' : 'cond';
      if (fam(row.substatus) !== fam(wantSub ?? null))
        return inputError(
          'Changing ignore behavior on an already ignored issue between `untilEscalating`, `forever`, and condition-based modes is not supported. First set `status` to `unresolved`, then ignore it again with the new rule.',
        );
    }
    const assigneeSame =
      newAssignee === undefined ||
      (newAssignee === null
        ? row.assignedTo === null
        : row.assignedTo !== null &&
          row.assignedTo.type === newAssignee.type &&
          row.assignedTo.id === newAssignee.id);
    if (statusSame && assigneeSame) {
      let out = `# Issue ${row.shortId} Already Matches Requested State in **${SENTRY_ORG}**\n\n`;
      out += `**Issue**: ${row.title}\n**URL**: ${issueUrl(row.shortId)}\n\n## Changes Made\n\nNo changes were needed.\n\n## Current Status\n\n`;
      out += `**Status**: ${statusDisplay(row)}\n`;
      if (row.status === 'ignored')
        out += `**Ignore Behavior**: ${row.substatus === 'archived_forever' ? 'Forever' : 'Until escalating'}\n`;
      out += `**Assigned To**: ${assignedName(row.assignedTo)}\n\n## Response Notes\n\n- The issue already matched the requested state.\n`;
      out += `- Full issue details: \`get_sentry_resource(resourceType="issue", organizationSlug="${SENTRY_ORG}", resourceId="${row.shortId}")\`\n`;
      return textResult(out);
    }
    if (!statusSame && status !== undefined) {
      row.status =
        status === 'resolvedInNextRelease' ? 'resolved' : (status as SentryIssue['status']);
      row.substatus =
        status === 'ignored' ? (wantSub as string) : status === 'unresolved' ? 'ongoing' : null;
    }
    if (!assigneeSame && newAssignee !== undefined) row.assignedTo = newAssignee;
    const reason = str(args, 'reason');
    if (reason !== undefined)
      row.notes.push({ text: reason, author: PEOPLE.raj.name, date: '2026-10-28T15:00:00Z' });
    state.mutations.push({
      kind: 'update',
      issue: row.shortId,
      detail: { status: row.status, substatus: row.substatus, assignedTo: row.assignedTo },
    });
    let out = `# Issue ${row.shortId} Updated in **${SENTRY_ORG}**\n\n`;
    out += `**Issue**: ${row.title}\n**URL**: ${issueUrl(row.shortId)}\n\n## Changes Made\n\n`;
    if (before.status !== row.status) out += `**Status**: ${before.status} → **${row.status}**\n`;
    if (
      row.status === 'ignored' &&
      (before.status !== row.status || before.substatus !== row.substatus)
    )
      out += `**Ignore Behavior**: **${row.substatus === 'archived_forever' ? 'Forever' : row.substatus === 'archived_until_escalating' ? 'Until escalating' : 'Until the ignore condition is met'}**\n`;
    if (before.assignee !== assignedName(row.assignedTo))
      out += `**Assigned To**: ${before.assignee} → **${args['assignedTo'] === 'me' ? 'You' : assignedName(row.assignedTo)}**\n`;
    out += `\n## Current Status\n\n**Status**: ${row.status}\n`;
    if (row.status === 'ignored')
      out += `**Ignore Behavior**: ${row.substatus === 'archived_forever' ? 'Forever' : row.substatus === 'archived_until_escalating' ? 'Until escalating' : 'Until the ignore condition is met'}\n`;
    out += `**Assigned To**: ${assignedName(row.assignedTo)}\n\n## Response Notes\n\n- The issue has been updated in Sentry.\n`;
    out += `- Full issue details: \`get_sentry_resource(resourceType="issue", organizationSlug="${SENTRY_ORG}", resourceId="${row.shortId}")\`\n`;
    if (before.status !== row.status && row.status === 'resolved')
      out += '- The issue is now marked as resolved and will no longer generate alerts\n';
    else if (row.status === 'ignored' && before.substatus !== row.substatus)
      out += `- ${row.substatus === 'archived_forever' ? 'The issue is now ignored indefinitely' : 'The issue is now ignored until it escalates'}\n`;
    if (reason !== undefined) out += '- Reason comment: posted to the issue activity feed.\n';
    return textResult(out);
  };

  const searchIssues = (args: Args): BoxResult => {
    const bad = checkOrg(args);
    if (bad !== undefined) return bad;
    const query = (str(args, 'query') ?? 'is:unresolved').trim();
    const sort = str(args, 'sort') ?? 'date';
    const period = str(args, 'period') ?? '30d';
    const limit = num(args, 'limit') ?? 10;
    const projectRaw = args['projectSlugOrId'];
    let project: SentryProject | undefined;
    if (typeof projectRaw === 'string' && projectRaw.trim() !== '') {
      project = PROJECTS.find((p) => p.slug === projectRaw.trim() || p.id === projectRaw.trim());
      if (project === undefined) return apiError(404, 'The requested resource does not exist');
    }
    const matcher = compileIssueQuery(query);
    if (typeof matcher === 'string') return apiError(400, `API error (400): ${matcher}`);
    const days = { '24h': 1, '7d': 7, '14d': 14, '30d': 30, '90d': 90 }[period] ?? 30;
    const since = SUMMIT_NOW_MS - days * 86_400_000;
    const rows = state.issues
      .filter((r) => project === undefined || r.project === project.slug)
      .filter((r) => Date.parse(r.lastSeen) >= since)
      .map((row) => {
        const [events, users] = windowCounts(row, period);
        return { row, events, users };
      })
      .filter(({ row, events, users }) => matcher(row, events, users));
    const key = {
      date: (x: (typeof rows)[number]) => Date.parse(x.row.lastSeen),
      new: (x: (typeof rows)[number]) => Date.parse(x.row.firstSeen),
      freq: (x: (typeof rows)[number]) => x.events,
      user: (x: (typeof rows)[number]) => x.users,
      recommended: (x: (typeof rows)[number]) => x.events + x.users * 10,
    }[sort as 'date'];
    const sorted = rows
      .toSorted((a, b) => key(b) - key(a) || Number(b.row.id) - Number(a.row.id))
      .slice(0, limit);
    return textResult(formatIssueResults(sorted, query, query, project?.slug));
  };

  const searchEvents = (args: Args): BoxResult => {
    const bad = checkOrg(args);
    if (bad !== undefined) return bad;
    const dataset = str(args, 'dataset') ?? 'errors';
    const query = str(args, 'query') ?? '';
    const period = str(args, 'period') ?? '14d';
    const limit = num(args, 'limit') ?? 10;
    const fields = Array.isArray(args['fields'])
      ? (args['fields'] as string[])
      : ['issue', 'title', 'project', 'timestamp', 'level', 'message', 'error.type', 'culprit'];
    const sortRaw = str(args, 'sort') ?? '-timestamp';
    let out = `# Search Results for "${query}"\n\n`;
    const aggregate = fields.some((f) => f.includes('('));
    out += aggregate
      ? '**Suggested presentation:** A compact table works well for these aggregate results.\n\n'
      : '**Suggested presentation:** Useful details to surface include severity, event IDs, and links.\n\n';
    out += `## Executed Search\n- Dataset: \`${dataset}\`\n- Query: \`${query || '(empty)'}\`\n- Fields: ${fields.map((f) => `\`${f}\``).join(', ')}\n- Sort: \`${sortRaw}\`\n- Time range: \`${period}\`\n\n`;
    out += `**View these results in Sentry**:\n${WEB}/explore/discover/results/?dataset=${dataset}&query=${encodeURIComponent(query)}&statsPeriod=${period}\n\n`;
    const projectSlug = str(args, 'projectSlug');
    const matcher =
      dataset === 'errors'
        ? compileIssueQuery(query.replace(/\bproject:([\w-]+)/g, 'project:$1'))
        : undefined;
    if (typeof matcher === 'string') return apiError(400, `API error (400): ${matcher}`);
    const days = { '1h': 1 / 24, '24h': 1, '7d': 7, '14d': 14, '30d': 30, '90d': 90 }[period] ?? 14;
    const statsKey =
      days <= 1 ? '24h' : days <= 7 ? '7d' : days <= 14 ? '14d' : days <= 30 ? '30d' : '90d';
    const rows =
      matcher === undefined
        ? []
        : state.issues
            .filter(
              (r) =>
                (projectSlug === undefined || r.project === projectSlug) &&
                Date.parse(r.lastSeen) >= SUMMIT_NOW_MS - days * 86_400_000,
            )
            .map((row) => ({ row, w: windowCounts(row, statsKey) }))
            .filter(({ row, w }) => w[0] > 0 && matcher(row, w[0], w[1]));
    if (rows.length === 0)
      return textResult(
        `${out}No results found.\n\nTry being more specific or using different terms in your search.\n`,
      );
    if (aggregate) {
      const groupBy = fields.filter((f) => !f.includes('('));
      const groups = new Map<string, Record<string, unknown>>();
      for (const { row, w } of rows) {
        const vals: Record<string, unknown> = {};
        for (const g of groupBy)
          vals[g] =
            g === 'issue'
              ? row.shortId
              : g === 'project'
                ? row.project
                : g === 'title'
                  ? row.title
                  : g === 'release'
                    ? row.release
                    : g === 'environment'
                      ? row.environment
                      : g === 'level'
                        ? row.level
                        : g === 'culprit'
                          ? row.culprit
                          : g === 'error.type'
                            ? row.exception.type
                            : (row.tags[g] ?? null);
        const k = JSON.stringify(vals);
        const cur = groups.get(k) ?? { ...vals };
        for (const f of fields.filter((x) => x.includes('('))) {
          const add = f.startsWith('count_unique(user')
            ? w[1]
            : f.startsWith('count(')
              ? w[0]
              : f.startsWith('last_seen')
                ? row.lastSeen
                : 0;
          cur[f] = typeof add === 'number' ? ((cur[f] as number | undefined) ?? 0) + add : add;
        }
        groups.set(k, cur);
      }
      const desc = sortRaw.startsWith('-');
      const sortField = sortRaw.replace(/^-/, '');
      const data = [...groups.values()]
        .toSorted((a, b) => {
          const x = a[sortField];
          const y = b[sortField];
          const cmp =
            typeof x === 'number' && typeof y === 'number'
              ? x - y
              : String(x).localeCompare(String(y));
          return desc ? -cmp : cmp;
        })
        .slice(0, limit);
      out += `Found ${data.length} aggregate result${data.length === 1 ? '' : 's'}:\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n\n`;
    } else {
      const data = rows
        .toSorted((a, b) => Date.parse(b.row.lastSeen) - Date.parse(a.row.lastSeen))
        .slice(0, limit);
      out += `Found ${data.length} error${data.length === 1 ? '' : 's'}:\n\n`;
      for (const { row } of data) {
        out += `## ${row.title}\n\n**Issue ID**: ${row.shortId}\n**Issue URL**: ${issueUrl(row.shortId)}\n**project**: ${row.project}\n**level**: ${row.level}\n**error.type**: ${row.exception.type}\n**message**: ${row.exception.value}\n**culprit**: ${row.culprit}\n**timestamp**: ${new Date(row.lastSeen).toISOString()}\n\n`;
      }
    }
    out +=
      '## Next Steps\n\n- Get more details about a specific error: Use the Issue ID\n- View error groups: Navigate to the Issues page in Sentry\n- Set up alerts: Configure alert rules for these error patterns\n';
    return textResult(out);
  };

  const catalog: Record<string, (args: Args) => BoxResult> = {
    whoami: () =>
      structuredResult({
        user: { id: PEOPLE.raj.sentryId, name: PEOPLE.raj.name, email: PEOPLE.raj.email },
        sessionConstraints: null,
      }),
    find_organizations: (args) => {
      const q = (str(args, 'query') ?? '').toLowerCase();
      const orgs = [
        { slug: SENTRY_ORG, webUrl: WEB, regionUrl: 'https://us.sentry.io' },
        {
          slug: 'fernhill-sandbox',
          webUrl: 'https://fernhill-sandbox.sentry.io',
          regionUrl: 'https://us.sentry.io',
        },
      ].filter((o) => o.slug.includes(q));
      return structuredResult({ organizations: orgs, hasMore: false });
    },
    find_projects: (args) => {
      const bad = checkOrg(args);
      if (bad !== undefined) return bad;
      const q = (str(args, 'query') ?? '').toLowerCase();
      return structuredResult({
        projects: PROJECTS.filter((p) => p.slug.includes(q)).map((p) => ({ slug: p.slug })),
        hasMore: false,
      });
    },
    find_teams: (args) => {
      const bad = checkOrg(args);
      if (bad !== undefined) return bad;
      const q = (str(args, 'query') ?? '').toLowerCase();
      return structuredResult({
        teams: TEAMS.filter((t) => t.slug.includes(q)).map((t) => ({ slug: t.slug, id: t.id })),
        hasMore: false,
      });
    },
    find_releases: (args) => {
      const bad = checkOrg(args);
      if (bad !== undefined) return bad;
      const project = str(args, 'projectSlug');
      const q = str(args, 'query') ?? '';
      const list = RELEASES.filter(
        (r) => (project === undefined || r.project === project) && r.version.includes(q),
      );
      return structuredResult({
        releases: list.map((r) => ({
          version: r.version,
          dateCreated: new Date(r.dateCreated).toISOString(),
          dateReleased: new Date(Date.parse(r.dateCreated) + 900_000).toISOString(),
          firstEvent: new Date(Date.parse(r.dateCreated) + 1_200_000).toISOString(),
          lastEvent: new Date(SUMMIT_NOW_MS - 600_000).toISOString(),
          newIssues: r.newIssues,
          projects: [r.project],
          lastCommit: {
            id: hex32(`commit:${r.version}`).slice(0, 40),
            message: r.commit,
            author: r.author,
            dateCreated: new Date(Date.parse(r.dateCreated) - 3_600_000).toISOString(),
          },
          lastDeploy: {
            id: String(Date.parse(r.dateCreated) / 1000),
            environment: 'production',
            dateStarted: new Date(r.dateCreated).toISOString(),
            dateFinished: new Date(Date.parse(r.dateCreated) + 600_000).toISOString(),
          },
        })),
        hasMore: false,
      });
    },
    get_issue_details: issueDetails,
    get_issue_tag_values: (args) => {
      const bad = checkOrg(args);
      if (bad !== undefined) return bad;
      const id = str(args, 'issueId') ?? parseIssueUrl(str(args, 'issueUrl') ?? '')?.id;
      const row = id === undefined ? undefined : findIssue(id);
      if (row === undefined) return apiError(404, 'The requested resource does not exist');
      const key = str(args, 'tagKey') ?? '';
      const value = row.tags[key];
      if (value === undefined) return apiError(404, 'The requested resource does not exist');
      return structuredResult({
        tag: {
          key,
          name: key.replace(/^\w/, (c) => c.toUpperCase()),
          totalValues: row.count,
          topValues: [
            {
              value,
              count: row.count,
              firstSeen: new Date(row.firstSeen).toISOString(),
              lastSeen: new Date(row.lastSeen).toISOString(),
            },
          ],
        },
      });
    },
    search_issue_events: (args) => {
      const bad = checkOrg(args);
      if (bad !== undefined) return bad;
      const id = str(args, 'issueId') ?? parseIssueUrl(str(args, 'issueUrl') ?? '')?.id;
      const row = id === undefined ? undefined : findIssue(id);
      if (row === undefined) return apiError(404, 'The requested resource does not exist');
      const ids = [row.eventId, ...(row.otherEventIds ?? [])];
      let out = `# Events for Issue ${row.shortId}\n\nFound ${ids.length} event${ids.length === 1 ? '' : 's'}:\n\n`;
      ids.forEach((e, i) => {
        out += `## ${row.title}\n\n**id**: ${e}\n**timestamp**: ${new Date(Date.parse(row.lastSeen) - i * 3_600_000).toISOString()}\n**release**: ${row.release}\n**environment**: ${row.environment}\n\n`;
      });
      return textResult(out);
    },
    get_issue_activity: (args) => {
      const bad = checkOrg(args);
      if (bad !== undefined) return bad;
      const id = str(args, 'issueId') ?? parseIssueUrl(str(args, 'issueUrl') ?? '')?.id;
      const row = id === undefined ? undefined : findIssue(id);
      if (row === undefined) return apiError(404, 'The requested resource does not exist');
      let out = `# Activity for Issue ${row.shortId}\n\n`;
      out += `- ${new Date(row.firstSeen).toISOString()} — First seen\n`;
      for (const n of row.notes) out += `- ${n.date} — Note by ${n.author}: ${n.text}\n`;
      return textResult(out);
    },
    add_issue_note: (args) => {
      const bad = checkOrg(args);
      if (bad !== undefined) return bad;
      const id = str(args, 'issueId') ?? parseIssueUrl(str(args, 'issueUrl') ?? '')?.id;
      const row = id === undefined ? undefined : findIssue(id);
      if (row === undefined) return apiError(404, 'The requested resource does not exist');
      const text = str(args, 'note') ?? str(args, 'text') ?? '';
      row.notes.push({ text, author: PEOPLE.raj.name, date: '2026-10-28T15:00:00Z' });
      state.mutations.push({ kind: 'note', issue: row.shortId, detail: { text } });
      return textResult(`# Note added to ${row.shortId}\n\n${text}\n`);
    },
    analyze_issue_with_seer: (args) => {
      const bad = checkOrg(args);
      if (bad !== undefined) return bad;
      return apiError(
        403,
        'API error (403): Seer is not enabled for this organization. An owner can enable it in Settings → Seer.',
      );
    },
    get_sentry_resource: (args) => {
      const url = str(args, 'url');
      if (url !== undefined) {
        const parsed = parseIssueUrl(url);
        if (parsed === undefined)
          return inputError(
            'Unsupported Sentry URL. Pass an issue, event, trace, replay, monitor or snapshot URL.',
          );
        return issueDetails({ organizationSlug: parsed.org, issueId: parsed.id.toUpperCase() });
      }
      const type = str(args, 'resourceType');
      if (type === undefined)
        return inputError(
          'Either `url` or `resourceType` must be provided. Pass a `url` to auto-detect the resource type, or specify `resourceType` with `resourceId`.',
        );
      const org = str(args, 'organizationSlug');
      if (org === undefined)
        return inputError('`organizationSlug` is required when not using a URL.');
      const id = str(args, 'resourceId');
      if (id === undefined) return inputError('`resourceId` is required when not using a URL.');
      if (type === 'issue')
        return issueDetails({ organizationSlug: org, issueId: id.toUpperCase() });
      if (type === 'event') return issueDetails({ organizationSlug: org, eventId: id });
      return apiError(404, 'The requested resource does not exist');
    },
    search_issues: searchIssues,
    search_events: searchEvents,
    update_issue: updateIssue,
    search_docs: () =>
      textResult('# Documentation Search Results\n\nNo matching documentation found.\n'),
    get_doc: () => apiError(404, 'The requested resource does not exist'),
  };

  const executeCatalog = (name: string, params: Args): BoxResult => {
    const tool = SENTRY_AVAILABLE.find((t) => t.name === name);
    if (tool === undefined || CATALOG_INFRA.has(name))
      return inputError(
        `Tool "${name}" is not available in this session. Use search_sentry_tools to find an executable tool.`,
      );
    const handler = catalog[name];
    if (handler !== undefined) return handler(params);
    if (tool.outputSchema !== undefined)
      return structuredResult(emptyFor(tool.outputSchema) as Record<string, unknown>);
    return apiError(404, 'The requested resource does not exist');
  };

  return {
    ...catalog,
    search_sentry_tools: (args) => {
      const query = str(args, 'query') ?? '';
      const limit = num(args, 'limit') ?? 8;
      const results = SENTRY_AVAILABLE.filter((t) => !CATALOG_INFRA.has(t.name))
        .map((t) => ({ t, score: scoreTool(t, query) }))
        .filter((x) => x.score > 0)
        .toSorted((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
        .slice(0, limit)
        .map(({ t }) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        }));
      return structuredResult({ query, results });
    },
    execute_sentry_tool: (args) => {
      const name = str(args, 'name') ?? '';
      const params = (args['arguments'] ?? {}) as Args;
      const tool = SENTRY_AVAILABLE.find((t) => t.name === name);
      if (tool !== undefined && !CATALOG_INFRA.has(name)) {
        // "Arguments are validated against the target tool's schema before execution."
        const required = (tool.inputSchema['required'] as string[] | undefined) ?? [];
        const missing = required.filter((k) => params[k] === undefined);
        if (missing.length > 0)
          return inputError(
            `Invalid arguments for ${name}: ${missing.map((k) => `\`${k}\`: Invalid input: expected string, received undefined`).join('; ')}`,
          );
      }
      return executeCatalog(name, params);
    },
  };
}

export function createSentryBox(
  state: SentryState,
  onCall?: (call: SideEffect) => void,
): SummitBox {
  const h = handlers(state);
  const tools: SummitTool[] = SENTRY_DIRECT_TOOLS.map((name) => ({
    ...def(name),
    handler: (args: Args) => {
      const fn = h[name];
      if (fn === undefined) throw new RpcError(-32601, `Tool ${name} not implemented`);
      return fn(args);
    },
  }));
  return createSummitBox({ name: 'Sentry MCP', version: '0.42.0' }, tools, onCall, {
    validate: true,
  });
}

/** An issue by short ID (graders, tests). */
export function sentryIssue(state: SentryState, shortId: string): SentryIssue | undefined {
  return state.issues.find((r) => r.shortId === shortId);
}
