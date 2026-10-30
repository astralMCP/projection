/**
 * The workplace world's `tracker` box: an issue tracker shaped like the
 * popular hosted trackers' MCP servers — issues keyed `BE-142`, teams,
 * labels, assignees by email, comments — with the workflow rules of the
 * stricter ones:
 *
 * - the workflow state changes only through `transition_issue`, and only
 *   along the transitions valid from the current state
 *   ({@link TRANSITIONS}; `get_transitions` lists them) — Todo → Done takes
 *   three steps; `update_issue` refuses a `state`;
 * - `create_issue` requires `team` and `title`, and the Backend team's
 *   workflow also requires a `priority` (a validation error otherwise);
 * - labels must already exist in the team;
 * - `list_issues` has no priority filter and pages ten at a time
 *   (`first`/`after`, newest update first).
 *
 * Reads declare output schemas and return `structuredContent`; refusals are
 * `isError` results.
 */

import type { SideEffect } from '../types.js';
import {
  argNumber,
  argString,
  createFakeBox,
  decodeCursor,
  encodeCursor,
  json,
  toolError,
  type FakeArgs,
  type FakeBox,
  type FakeTool,
} from './workplace-fake.js';
import { ALL_PEOPLE, PEOPLE, WORLD_NOW, type PersonKey } from './workplace-people.js';

export type WorkflowState = 'Backlog' | 'Todo' | 'In Progress' | 'In Review' | 'Done' | 'Canceled';

export const WORKFLOW_STATES: readonly WorkflowState[] = [
  'Backlog',
  'Todo',
  'In Progress',
  'In Review',
  'Done',
  'Canceled',
];

/** Every transition, by ID: valid only from `from`. */
export const TRANSITIONS: readonly {
  id: string;
  name: string;
  from: WorkflowState;
  to: WorkflowState;
}[] = [
  { id: '11', name: 'Plan', from: 'Backlog', to: 'Todo' },
  { id: '12', name: 'Cancel', from: 'Backlog', to: 'Canceled' },
  { id: '21', name: 'Start progress', from: 'Todo', to: 'In Progress' },
  { id: '22', name: 'Move to backlog', from: 'Todo', to: 'Backlog' },
  { id: '23', name: 'Cancel', from: 'Todo', to: 'Canceled' },
  { id: '31', name: 'Submit for review', from: 'In Progress', to: 'In Review' },
  { id: '32', name: 'Stop progress', from: 'In Progress', to: 'Todo' },
  { id: '41', name: 'Approve', from: 'In Review', to: 'Done' },
  { id: '42', name: 'Request changes', from: 'In Review', to: 'In Progress' },
  { id: '51', name: 'Reopen', from: 'Done', to: 'Todo' },
  { id: '61', name: 'Restore', from: 'Canceled', to: 'Backlog' },
];

export const PRIORITY_NAMES = ['No priority', 'Urgent', 'High', 'Medium', 'Low'] as const;

export const TEAMS = [
  { id: 'team_9f2c', key: 'BE', name: 'Backend' },
  { id: 'team_4a7e', key: 'WEB', name: 'Web' },
  { id: 'team_1d3b', key: 'OPS', name: 'Operations' },
] as const;

export const LABELS: Readonly<Record<string, readonly string[]>> = {
  BE: ['bug', 'feature', 'chore', 'sentry', 'on-call', 'tech-debt', 'security'],
  WEB: ['bug', 'feature', 'sentry', 'design'],
  OPS: ['infra', 'sentry', 'on-call', 'security'],
};

export interface TrackerIssue {
  id: string;
  identifier: string;
  team: string;
  title: string;
  description: string;
  state: WorkflowState;
  /** 0 none, 1 Urgent, 2 High, 3 Medium, 4 Low. */
  priority: number;
  assignee: string | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TrackerComment {
  id: string;
  issue: string;
  body: string;
  author: string;
  createdAt: string;
}

/** One change the episode made, in order. */
export interface TrackerMutation {
  kind: 'create' | 'update' | 'transition' | 'comment';
  identifier: string;
  detail: Record<string, unknown>;
}

export interface TrackerState {
  issues: TrackerIssue[];
  comments: TrackerComment[];
  mutations: TrackerMutation[];
}

type Seed = [
  identifier: string,
  title: string,
  state: WorkflowState,
  priority: number,
  assignee: PersonKey | null,
  labels: string[],
  updated: string,
];

const BACKEND: Seed[] = [
  ['BE-100', 'Ledger service: structured logging', 'Done', 3, 'omar', ['chore'], '2026-09-02'],
  [
    'BE-101',
    'Remove deprecated v1 invoices endpoint',
    'Done',
    3,
    'jonas',
    ['tech-debt'],
    '2026-09-04',
  ],
  ['BE-102', 'Ledger: drop unused columns', 'Done', 3, 'priya', ['tech-debt'], '2026-09-09'],
  ['BE-103', 'Evaluate queue backpressure options', 'Backlog', 4, null, ['feature'], '2026-09-10'],
  ['BE-104', 'Rotate leaked staging DB credentials', 'Todo', 1, 'omar', ['security'], '2026-10-13'],
  [
    'BE-105',
    'Tax service client: retries with jitter',
    'Todo',
    3,
    'jonas',
    ['feature'],
    '2026-09-18',
  ],
  ['BE-106', 'Upgrade runtime to the current LTS', 'Done', 2, 'omar', ['chore'], '2026-09-20'],
  [
    'BE-107',
    'Hotfix: refund webhook signature check',
    'Done',
    1,
    'jonas',
    ['bug', 'security'],
    '2026-09-22',
  ],
  ['BE-108', 'Ledger export to warehouse', 'Backlog', 3, null, ['feature'], '2026-09-23'],
  [
    'BE-109',
    'Spike: GraphQL gateway for internal APIs',
    'Canceled',
    4,
    'priya',
    ['feature'],
    '2026-09-24',
  ],
  ['BE-110', 'Rate-limit admin API', 'Todo', 2, 'sam', ['security'], '2026-09-25'],
  ['BE-111', 'Emergency: disable legacy coupons', 'Canceled', 1, 'sam', ['bug'], '2026-09-26'],
  ['BE-112', 'Billing: currency rounding docs', 'Done', 4, 'jonas', ['chore'], '2026-09-27'],
  ['BE-113', 'Ledger lock contention under load', 'In Progress', 1, 'jonas', ['bug'], '2026-10-12'],
  ['BE-114', 'Notification preferences API', 'Backlog', 3, 'sam', ['feature'], '2026-09-29'],
  ['BE-115', 'Flaky integration test: refunds', 'Todo', 3, 'omar', ['bug'], '2026-09-30'],
  ['BE-116', 'Cache warmup on deploy', 'Backlog', 0, null, ['feature'], '2026-10-01'],
  [
    'BE-118',
    'Cart totals: support display currency',
    'In Progress',
    2,
    'priya',
    ['feature'],
    '2026-10-12',
  ],
  ['BE-119', 'Dead-letter queue replay tool', 'Todo', 3, 'omar', ['feature'], '2026-10-02'],
  [
    'BE-121',
    '[Sentry] CHECKOUT-API-1F: TimeoutError: inventory service did not respond within 5000ms',
    'In Review',
    2,
    'omar',
    ['sentry', 'bug'],
    '2026-10-11',
  ],
  [
    'BE-124',
    '[Sentry] CHECKOUT-API-5H: RangeError: Maximum call stack size exceeded',
    'Done',
    3,
    'aiko',
    ['sentry', 'bug'],
    '2026-10-06',
  ],
  [
    'BE-127',
    '[Sentry] CHECKOUT-API-7Q: SyntaxError: Unexpected token < in JSON at position 0',
    'Todo',
    3,
    'sam',
    ['sentry', 'bug'],
    '2026-10-10',
  ],
  ['BE-131', 'Remove legacy tax tables', 'Todo', 3, 'priya', ['tech-debt'], '2026-10-07'],
  [
    'BE-133',
    '[Sentry] CHECKOUT-API-2K: PaymentDeclinedError: card_declined not handled',
    'In Progress',
    2,
    'aiko',
    ['sentry', 'on-call', 'bug'],
    '2026-10-12',
  ],
  [
    'BE-136',
    'Follow-up to CHECKOUT-API-7Q: add JSON content-type guard',
    'Todo',
    4,
    'sam',
    ['tech-debt'],
    '2026-10-12',
  ],
  ['BE-138', 'Audit log gaps for admin refunds', 'Backlog', 1, null, ['security'], '2026-10-09'],
  ['BE-140', 'Proration rounding tests', 'Done', 3, 'jonas', ['chore'], '2026-10-12'],
  ['BE-142', 'payments-api: idempotent refunds', 'In Review', 2, 'sam', ['feature'], '2026-10-13'],
  [
    'BE-144',
    'Migrate invoice PDFs to the new renderer',
    'In Review',
    3,
    'lena',
    ['tech-debt'],
    '2026-10-03',
  ],
  ['BE-146', 'Ledger read replicas', 'Backlog', 3, null, ['feature'], '2026-10-04'],
  ['BE-147', 'Retry budget for ledger writes', 'In Review', 2, 'priya', ['feature'], '2026-10-13'],
  [
    'BE-148',
    '[Sentry] BILLING-WORKER-17: InvoiceRenderError: template dunning_v2 missing',
    'Todo',
    3,
    'jonas',
    ['sentry', 'bug'],
    '2026-10-11',
  ],
  ['BE-149', 'Bump ledger client to 3.x', 'In Review', 3, null, ['chore'], '2026-10-08'],
  ['BE-150', 'Investigate notification delivery failures', 'Todo', 2, 'sam', ['bug'], '2026-10-13'],
  ['BE-151', 'Dunning emails: template v2', 'In Review', 2, 'jonas', ['feature'], '2026-10-13'],
  [
    'BE-152',
    '[Sentry] BILLING-WORKER-18: DuplicateChargeDetected: account acct_globex_0042 charged twice',
    'In Progress',
    2,
    'jonas',
    ['sentry', 'bug'],
    '2026-10-13',
  ],
  [
    'BE-153',
    'payments-api: PCI scope review findings',
    'Todo',
    1,
    'marco',
    ['security'],
    '2026-10-14',
  ],
];

const WEB: Seed[] = [
  [
    'WEB-52',
    'Storefront: lazy-load product images',
    'Done',
    3,
    'marcoB',
    ['feature'],
    '2026-09-15',
  ],
  [
    'WEB-55',
    'Checkout page: currency selector',
    'In Progress',
    2,
    'marcoB',
    ['feature', 'design'],
    '2026-10-09',
  ],
  [
    'WEB-58',
    '[Sentry] CHECKOUT-API-1F: TimeoutError surfaced in storefront cart',
    'In Progress',
    2,
    'aiko',
    ['sentry', 'bug'],
    '2026-10-11',
  ],
  [
    'WEB-61',
    'Storefront: checkout button disabled on some browsers',
    'Todo',
    1,
    'marcoB',
    ['bug'],
    '2026-10-13',
  ],
  ['WEB-63', 'Dashboard: dark mode tokens', 'In Review', 3, 'aiko', ['design'], '2026-10-12'],
];

const OPS: Seed[] = [
  ['OPS-17', 'Rotate TLS certificates', 'Done', 2, 'omar', ['infra', 'security'], '2026-10-13'],
  [
    'OPS-19',
    '[Sentry] BILLING-WORKER-12: RateLimitError: payment gateway returned 429',
    'Canceled',
    3,
    'aiko',
    ['sentry'],
    '2026-10-12',
  ],
  ['OPS-22', 'Alert routing for billing-worker', 'Todo', 2, 'aiko', ['on-call'], '2026-10-10'],
];

/** The tracker issue IDs: a stable hash-looking string per identifier. */
function issueId(identifier: string): string {
  let h = 0;
  for (const ch of identifier) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `iss_${h.toString(16).padStart(8, '0')}`;
}

function fromSeed([
  identifier,
  title,
  state,
  priority,
  assignee,
  labels,
  updated,
]: Seed): TrackerIssue {
  const team = identifier.split('-')[0] as string;
  return {
    id: issueId(identifier),
    identifier,
    team,
    title,
    description: title.startsWith('[Sentry]')
      ? `Created from the error-monitoring alert. ${title.slice('[Sentry] '.length)}`
      : `${title}.`,
    state,
    priority,
    assignee: assignee === null ? null : PEOPLE[assignee].email,
    labels: [...labels],
    createdAt: `${updated.slice(0, 8)}01T09:00:00.000Z`,
    updatedAt: `${updated}T10:00:00.000Z`,
  };
}

/** A fresh tracker state (deterministic). */
export function seedTracker(): TrackerState {
  return {
    issues: [...BACKEND, ...WEB, ...OPS].map(fromSeed),
    comments: [
      {
        id: 'cmt_0001',
        issue: 'BE-152',
        body: 'Globex reported this one too. Fix is in review upstream.',
        author: PEOPLE.jonas.email,
        createdAt: '2026-10-13T15:00:00.000Z',
      },
    ],
    mutations: [],
  };
}

// ---------------------------------------------------------------------------
// The server

function teamOf(value: string | undefined): (typeof TEAMS)[number] | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  return TEAMS.find((t) => t.key.toLowerCase() === v || t.name.toLowerCase() === v || t.id === v);
}

function userView(email: string | null): Record<string, unknown> | null {
  if (email === null) return null;
  const p = ALL_PEOPLE.find((x) => x.email === email);
  return { id: p?.trackerId ?? 'usr_unknown', name: p?.name ?? email, email };
}

function issueSummary(issue: TrackerIssue): Record<string, unknown> {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    state: issue.state,
    priority: { value: issue.priority, name: PRIORITY_NAMES[issue.priority] },
    assignee: userView(issue.assignee),
    labels: issue.labels,
    team: issue.team,
    updatedAt: issue.updatedAt,
  };
}

const USER_SCHEMA = {
  type: ['object', 'null'],
  properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' } },
} as const;

const ISSUE_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    identifier: { type: 'string' },
    title: { type: 'string' },
    state: { type: 'string' },
    priority: {
      type: 'object',
      properties: { value: { type: 'number' }, name: { type: 'string' } },
    },
    assignee: USER_SCHEMA,
    labels: { type: 'array', items: { type: 'string' } },
    team: { type: 'string' },
    updatedAt: { type: 'string' },
  },
  required: ['id', 'identifier', 'title', 'state', 'priority', 'assignee', 'labels', 'team'],
} as const;

const ISSUE_DETAIL_SCHEMA = {
  type: 'object',
  properties: {
    ...ISSUE_SUMMARY_SCHEMA.properties,
    description: { type: 'string' },
    createdAt: { type: 'string' },
    url: { type: 'string' },
    commentCount: { type: 'number' },
  },
  required: ISSUE_SUMMARY_SCHEMA.required,
} as const;

const ISSUE_ID = {
  type: 'string',
  description: 'The issue identifier (e.g. BE-123) or its ID',
} as const;

const PRIORITY = {
  type: 'number',
  description: 'Priority: 0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low',
} as const;

/** The tracker box over `state`. */
export function createTrackerBox(
  state: TrackerState,
  onCall?: (call: SideEffect) => void,
): FakeBox {
  let seq = 0;
  const find = (args: FakeArgs, key = 'id'): TrackerIssue | undefined => {
    const v = argString(args, key)?.trim();
    if (v === undefined) return undefined;
    return state.issues.find((i) => i.identifier.toLowerCase() === v.toLowerCase() || i.id === v);
  };
  const notFound = (args: FakeArgs, key = 'id'): ReturnType<typeof toolError> =>
    toolError(
      `Entity not found: Issue - Could not find referenced Issue "${argString(args, key) ?? ''}".`,
    );
  const touch = (issue: TrackerIssue): void => {
    seq += 1;
    issue.updatedAt = `2026-10-14T12:${String(seq).padStart(2, '0')}:00.000Z`;
  };
  const resolveAssignee = (
    value: string | undefined,
  ): { email: string | null } | { error: string } => {
    if (value === undefined) return { error: 'no assignee' };
    const v = value.trim().toLowerCase();
    if (v === '' || v === 'none' || v === 'null') return { email: null };
    const p = ALL_PEOPLE.find(
      (x) => x.email === v || x.trackerId === v || x.name.toLowerCase() === v,
    );
    if (p === undefined)
      return { error: `Entity not found: User - Could not find user "${value}".` };
    return { email: p.email };
  };
  const checkLabels = (team: string, labels: readonly string[]): string | undefined => {
    const known = LABELS[team] ?? [];
    const missing = labels.filter((l) => !known.includes(l));
    return missing.length > 0
      ? `Label(s) not found in team ${team}: ${missing.join(', ')}. Use list_issue_labels.`
      : undefined;
  };
  const labelArgs = (args: FakeArgs, key: string): string[] | undefined => {
    const v = args[key];
    if (!Array.isArray(v)) return undefined;
    return v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase());
  };

  const tools: FakeTool[] = [
    {
      name: 'list_teams',
      description: 'List teams in the workspace, with their keys and workflow states',
      inputSchema: { type: 'object', properties: {} },
      annotations: { title: 'List teams', readOnlyHint: true },
      handler: () => json({ teams: TEAMS.map((t) => ({ ...t, states: WORKFLOW_STATES })) }),
    },
    {
      name: 'list_users',
      description: 'List users in the workspace. Optionally filter by a name or email substring.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Name or email substring' } },
      },
      annotations: { title: 'List users', readOnlyHint: true },
      handler: (args) => {
        const q = argString(args, 'query')?.toLowerCase() ?? '';
        return json({
          users: ALL_PEOPLE.filter(
            (p) => p.name.toLowerCase().includes(q) || p.email.includes(q),
          ).map((p) => ({ id: p.trackerId, name: p.name, email: p.email, active: true })),
        });
      },
    },
    {
      name: 'list_issue_labels',
      description: 'List the labels defined in a team',
      inputSchema: {
        type: 'object',
        properties: { team: { type: 'string', description: 'Team key, name or ID' } },
        required: ['team'],
      },
      annotations: { title: 'List labels', readOnlyHint: true },
      handler: (args) => {
        const team = teamOf(argString(args, 'team'));
        if (team === undefined)
          return toolError(`Entity not found: Team "${argString(args, 'team') ?? ''}".`);
        return json({ labels: (LABELS[team.key] ?? []).map((name) => ({ name })) });
      },
    },
    {
      name: 'list_issues',
      description:
        'List issues, most recently updated first. Filters combine with AND. Returns at most `first` issues (default 10, max 50); pass pageInfo.endCursor as `after` for the next page.',
      inputSchema: {
        type: 'object',
        properties: {
          team: { type: 'string', description: 'Team key, name or ID' },
          assignee: { type: 'string', description: 'Assignee email, or "me"' },
          state: { type: 'string', description: 'Workflow state name (e.g. "In Review")' },
          label: { type: 'string', description: 'Label name' },
          query: {
            type: 'string',
            description: 'Search text matched against title and description',
          },
          first: { type: 'number', description: 'Page size (default 10, max 50)' },
          after: { type: 'string', description: 'Cursor from pageInfo.endCursor' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          issues: { type: 'array', items: ISSUE_SUMMARY_SCHEMA },
          pageInfo: {
            type: 'object',
            properties: {
              hasNextPage: { type: 'boolean' },
              endCursor: { type: ['string', 'null'] },
            },
            required: ['hasNextPage', 'endCursor'],
          },
        },
        required: ['issues', 'pageInfo'],
      },
      annotations: { title: 'List issues', readOnlyHint: true },
      handler: (args) => {
        const teamArg = argString(args, 'team');
        const team = teamArg === undefined ? undefined : teamOf(teamArg);
        if (teamArg !== undefined && team === undefined) {
          return toolError(`Entity not found: Team "${teamArg}".`);
        }
        const assignee = argString(args, 'assignee')?.trim().toLowerCase();
        const stateName = argString(args, 'state')?.trim().toLowerCase();
        const label = argString(args, 'label')?.trim().toLowerCase();
        const query = argString(args, 'query')?.trim().toLowerCase();
        const matches = state.issues
          .filter(
            (i) =>
              (team === undefined || i.team === team.key) &&
              (assignee === undefined || (i.assignee ?? '') === assignee) &&
              (stateName === undefined || i.state.toLowerCase() === stateName) &&
              (label === undefined || i.labels.includes(label)) &&
              (query === undefined ||
                i.title.toLowerCase().includes(query) ||
                i.description.toLowerCase().includes(query) ||
                i.identifier.toLowerCase() === query),
          )
          .toSorted(
            (a, b) =>
              b.updatedAt.localeCompare(a.updatedAt) || a.identifier.localeCompare(b.identifier),
          );
        const first = Math.min(Math.max(argNumber(args, 'first') ?? 10, 1), 50);
        const scope = `issues:${JSON.stringify([team?.key, assignee, stateName, label, query])}`;
        const after = argString(args, 'after');
        let offset = 0;
        if (after !== undefined && after !== '') {
          const decoded = decodeCursor(scope, after);
          if (decoded === undefined)
            return toolError('Invalid cursor: it belongs to a different query.');
          offset = decoded;
        }
        const slice = matches.slice(offset, offset + first);
        const hasNextPage = offset + first < matches.length;
        return json({
          issues: slice.map(issueSummary),
          pageInfo: {
            hasNextPage,
            endCursor: hasNextPage ? encodeCursor(scope, offset + first) : null,
          },
        });
      },
    },
    {
      name: 'get_issue',
      description: 'Retrieve an issue by identifier or ID, with its description',
      inputSchema: { type: 'object', properties: { id: ISSUE_ID }, required: ['id'] },
      outputSchema: ISSUE_DETAIL_SCHEMA,
      annotations: { title: 'Get issue', readOnlyHint: true },
      handler: (args) => {
        const issue = find(args);
        if (issue === undefined) return notFound(args);
        return json({
          ...issueSummary(issue),
          description: issue.description,
          createdAt: issue.createdAt,
          url: `https://tracker.northwind.dev/issue/${issue.identifier}`,
          commentCount: state.comments.filter((c) => c.issue === issue.identifier).length,
        });
      },
    },
    {
      name: 'create_issue',
      description: 'Create a new issue in a team',
      inputSchema: {
        type: 'object',
        properties: {
          team: { type: 'string', description: 'Team key, name or ID' },
          title: { type: 'string', description: 'Issue title' },
          description: { type: 'string', description: 'Markdown description' },
          priority: PRIORITY,
          assignee: { type: 'string', description: 'Assignee email' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Label names' },
        },
        required: ['team', 'title'],
      },
      outputSchema: ISSUE_DETAIL_SCHEMA,
      annotations: {
        title: 'Create issue',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      handler: (args) => {
        const team = teamOf(argString(args, 'team'));
        if (team === undefined)
          return toolError(`Entity not found: Team "${argString(args, 'team') ?? ''}".`);
        const title = argString(args, 'title')?.trim() ?? '';
        if (title === '') return toolError('Argument Validation Error: title must not be empty.');
        const priority = argNumber(args, 'priority');
        if (team.key === 'BE' && (priority === undefined || priority === 0)) {
          return toolError(
            'Validation failed: the Backend (BE) workflow requires a priority (1 Urgent, 2 High, 3 Medium, 4 Low) on new issues.',
          );
        }
        if (
          priority !== undefined &&
          !(Number.isInteger(priority) && priority >= 0 && priority <= 4)
        ) {
          return toolError('Argument Validation Error: priority must be an integer from 0 to 4.');
        }
        const labels = labelArgs(args, 'labels') ?? [];
        const labelError = checkLabels(team.key, labels);
        if (labelError !== undefined) return toolError(labelError);
        let assignee: string | null = null;
        const assigneeArg = argString(args, 'assignee');
        if (assigneeArg !== undefined) {
          const r = resolveAssignee(assigneeArg);
          if ('error' in r) return toolError(r.error);
          assignee = r.email;
        }
        const numbers = state.issues
          .filter((i) => i.team === team.key)
          .map((i) => Number(i.identifier.split('-')[1]));
        const identifier = `${team.key}-${Math.max(...numbers) + 1}`;
        seq += 1;
        const issue: TrackerIssue = {
          id: issueId(identifier),
          identifier,
          team: team.key,
          title,
          description: argString(args, 'description') ?? '',
          state: 'Todo',
          priority: priority ?? 0,
          assignee,
          labels: [...new Set(labels)],
          createdAt: WORLD_NOW.replace('Z', '.000Z'),
          updatedAt: `2026-10-14T12:${String(seq).padStart(2, '0')}:00.000Z`,
        };
        state.issues.push(issue);
        state.mutations.push({ kind: 'create', identifier, detail: { ...args } });
        return json({
          ...issueSummary(issue),
          description: issue.description,
          createdAt: issue.createdAt,
          url: `https://tracker.northwind.dev/issue/${identifier}`,
          commentCount: 0,
        });
      },
    },
    {
      name: 'update_issue',
      description:
        'Update fields of an existing issue. `labels` replaces the label set. The workflow state cannot be changed here; use transition_issue.',
      inputSchema: {
        type: 'object',
        properties: {
          id: ISSUE_ID,
          title: { type: 'string' },
          description: { type: 'string' },
          priority: PRIORITY,
          assignee: { type: 'string', description: 'Assignee email; empty string to unassign' },
          labels: {
            type: 'array',
            items: { type: 'string' },
            description: 'The full new label set',
          },
          state: { type: 'string', description: 'Not supported: use transition_issue' },
        },
        required: ['id'],
      },
      outputSchema: ISSUE_DETAIL_SCHEMA,
      annotations: {
        title: 'Update issue',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      handler: (args) => {
        const issue = find(args);
        if (issue === undefined) return notFound(args);
        if (args['state'] !== undefined) {
          return toolError(
            `Workflow state cannot be set directly. Call get_transitions for ${issue.identifier} and then transition_issue.`,
          );
        }
        const next = { ...issue, labels: [...issue.labels] };
        const title = argString(args, 'title');
        if (title !== undefined) next.title = title;
        const description = argString(args, 'description');
        if (description !== undefined) next.description = description;
        const priority = argNumber(args, 'priority');
        if (priority !== undefined) {
          if (!(Number.isInteger(priority) && priority >= 0 && priority <= 4)) {
            return toolError('Argument Validation Error: priority must be an integer from 0 to 4.');
          }
          next.priority = priority;
        }
        const assigneeArg = argString(args, 'assignee');
        if (assigneeArg !== undefined) {
          const r = resolveAssignee(assigneeArg);
          if ('error' in r) return toolError(r.error);
          next.assignee = r.email;
        }
        const labels = labelArgs(args, 'labels');
        if (labels !== undefined) {
          const labelError = checkLabels(issue.team, labels);
          if (labelError !== undefined) return toolError(labelError);
          next.labels = [...new Set(labels)];
        }
        Object.assign(issue, next);
        touch(issue);
        state.mutations.push({ kind: 'update', identifier: issue.identifier, detail: { ...args } });
        return json({
          ...issueSummary(issue),
          description: issue.description,
          createdAt: issue.createdAt,
          url: `https://tracker.northwind.dev/issue/${issue.identifier}`,
          commentCount: state.comments.filter((c) => c.issue === issue.identifier).length,
        });
      },
    },
    {
      name: 'get_transitions',
      description: "List the workflow transitions available from an issue's current state",
      inputSchema: { type: 'object', properties: { id: ISSUE_ID }, required: ['id'] },
      outputSchema: {
        type: 'object',
        properties: {
          identifier: { type: 'string' },
          state: { type: 'string' },
          transitions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                to: { type: 'string' },
              },
              required: ['id', 'name', 'to'],
            },
          },
        },
        required: ['identifier', 'state', 'transitions'],
      },
      annotations: { title: 'Get transitions', readOnlyHint: true },
      handler: (args) => {
        const issue = find(args);
        if (issue === undefined) return notFound(args);
        return json({
          identifier: issue.identifier,
          state: issue.state,
          transitions: TRANSITIONS.filter((t) => t.from === issue.state).map(
            ({ id, name, to }) => ({ id, name, to }),
          ),
        });
      },
    },
    {
      name: 'transition_issue',
      description:
        'Move an issue along one workflow transition. Only the transitions get_transitions lists for the current state are valid.',
      inputSchema: {
        type: 'object',
        properties: {
          id: ISSUE_ID,
          transitionId: { type: 'string', description: 'A transition ID from get_transitions' },
        },
        required: ['id', 'transitionId'],
      },
      annotations: {
        title: 'Transition issue',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      handler: (args) => {
        const issue = find(args);
        if (issue === undefined) return notFound(args);
        const tid = argString(args, 'transitionId')?.trim();
        const transition = TRANSITIONS.find((t) => t.id === tid && t.from === issue.state);
        if (transition === undefined) {
          const valid = TRANSITIONS.filter((t) => t.from === issue.state)
            .map((t) => `${t.id} ${t.name} (→ ${t.to})`)
            .join(', ');
          return toolError(
            `Transition ${tid ?? '(none)'} is not valid for ${issue.identifier} in state "${issue.state}". Valid transitions: ${valid}.`,
          );
        }
        const from = issue.state;
        issue.state = transition.to;
        touch(issue);
        state.mutations.push({
          kind: 'transition',
          identifier: issue.identifier,
          detail: { from, to: transition.to, transitionId: transition.id },
        });
        return json({ identifier: issue.identifier, from, state: issue.state });
      },
    },
    {
      name: 'list_comments',
      description: 'List the comments on an issue, oldest first',
      inputSchema: { type: 'object', properties: { issueId: ISSUE_ID }, required: ['issueId'] },
      annotations: { title: 'List comments', readOnlyHint: true },
      handler: (args) => {
        const issue = find(args, 'issueId');
        if (issue === undefined) return notFound(args, 'issueId');
        return json({
          comments: state.comments
            .filter((c) => c.issue === issue.identifier)
            .map((c) => ({
              id: c.id,
              body: c.body,
              user: userView(c.author),
              createdAt: c.createdAt,
            })),
        });
      },
    },
    {
      name: 'create_comment',
      description: 'Add a markdown comment to an issue',
      inputSchema: {
        type: 'object',
        properties: {
          issueId: ISSUE_ID,
          body: { type: 'string', description: 'Comment body (markdown)' },
        },
        required: ['issueId', 'body'],
      },
      annotations: {
        title: 'Create comment',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      handler: (args) => {
        const issue = find(args, 'issueId');
        if (issue === undefined) return notFound(args, 'issueId');
        const body = argString(args, 'body') ?? '';
        if (body.trim() === '')
          return toolError('Argument Validation Error: body must not be empty.');
        seq += 1;
        const comment: TrackerComment = {
          id: `cmt_${String(1000 + seq)}`,
          issue: issue.identifier,
          body,
          author: 'assistant@northwind.dev',
          createdAt: WORLD_NOW.replace('Z', '.000Z'),
        };
        state.comments.push(comment);
        state.mutations.push({ kind: 'comment', identifier: issue.identifier, detail: { body } });
        return json({
          id: comment.id,
          issue: issue.identifier,
          body,
          createdAt: comment.createdAt,
        });
      },
    },
  ];
  return createFakeBox({ name: 'tracker-mcp', version: '2.3.0' }, tools, onCall);
}
