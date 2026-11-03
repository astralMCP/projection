/**
 * Facade options and the wiring every facade kind shares (PRD R1, R12, R14,
 * R16, R28, R38). `wrapMcpServer` and `wrapMcpServers` take the same
 * {@link WrapOptions}; this module turns them into the per-request
 * dependencies of the approval gate, in one place, so the two facade kinds
 * and the two gated tools can never drift on policy, redaction, caps or
 * replay protection.
 */

import type { Implementation } from '@modelcontextprotocol/server';
import { ProjectionError } from '../errors.js';
import type { TokenStore } from '../auth/token-store.js';
import { DEFAULT_INTROSPECT_TIMEOUT_MS } from '../introspector/constants.js';
import type { BlobKeyDomain } from '../blob/index.js';
import type { ApprovalGateDeps, ProjectionSelection, ProtocolEra } from '../mrtr/index.js';
import type { ApprovalPrompts } from '../mrtr/batch.js';
import type {
  ApprovalsMode,
  PolicyOptions,
  BlobSealerConfig,
  PolicyOverrides,
  PolicyRule,
  RedactionHook,
  ReplayCache,
  ResourceCaps,
  ServerCatalog,
  ToolExecutor,
  UpstreamElicitationMode,
} from '../types.js';

export interface WrapOptions {
  /** Blob sealing configuration; required for any gated flow (R22). */
  blob: BlobSealerConfig;
  /** Resource cap overrides, clamped at the hard maxima (R12). */
  caps?: Partial<ResourceCaps>;
  /**
   * Per-tool policy overrides (R14). Read once, at wrap time: the facade
   * keeps its own frozen copy, so later changes to this object are not seen.
   */
  policy?: PolicyOverrides;
  /**
   * Policy rules (R14 amendment, DECISIONS D36): decide many tools at once,
   * by name pattern (`{ match: '*send*', decision: 'ask' }`, whole name,
   * case-insensitive, `*` = any run of characters) or by a function of the
   * tool's catalog entry returning `'auto'` | `'ask'` | `'deny'`, or
   * `undefined` for no opinion. On `wrapMcpServers` a rule sees the
   * qualified name (`gmail.send_email`). Resolved once, at wrap time, over
   * the introspected catalog: the first rule with an opinion decides a
   * tool; an exact `policy` entry beats every rule, and a rule beats the
   * approvals mode and the annotations. A malformed decision — on a
   * matching pattern, a missing one included — fails safe to `'ask'`; a
   * rule that throws fails the wrap (`validate`). A function rule must be
   * deterministic — every instance must decide alike (R27). The entry a
   * function receives (description, annotations, schema) comes from the
   * wrapped server and may be hostile: base `'auto'` only on facts you
   * trust, such as a tool name you vouch for; basing `'ask'` or `'deny'` on
   * them is fine. Read once, at wrap time: the rules are copied, so later
   * changes to the array or its pattern objects are not seen.
   */
  policyRules?: readonly PolicyRule[];
  /**
   * Approvals mode (R49). `'every-write'` (default) asks before every tool
   * that is not read-only. `'destructive-only'` also runs, without approval,
   * a non-read-only tool whose annotations declare `destructiveHint: false`
   * exactly; a missing or any other `destructiveHint` still asks. A per-tool
   * `policy` override wins over the mode. This extends the trust placed in
   * `readOnlyHint` to `destructiveHint: false` — a hostile server can
   * mislabel a damaging tool, so enable it only for servers you trust.
   * Read once, at wrap time; any other value fails the wrap (`validate`).
   */
  approvals?: ApprovalsMode;
  /**
   * Masks sensitive argument fields before they reach an approval prompt
   * (R16). It receives the tool name and a copy of the arguments. On a
   * `wrapMcpServers` facade the name is the qualified `<alias>.<tool>`
   * (`fs.write_file`), so one hook can tell the boxes' same-named tools
   * apart; on `wrapMcpServer` it is the server's own tool name.
   */
  redact?: RedactionHook;
  /**
   * How a machine suspension holding several gated calls is put to the
   * person (R15 amendment; DECISIONS D25). `'per-call'` (default) sends one
   * elicitation per call. `'batched'` sends one elicitation listing every
   * call in its full approval copy, with one unticked boolean per call (no
   * default): each call still runs only if its own box comes back ticked,
   * on the arguments sealed for it (S2). A client that answers the form
   * without the booleans declines every call. The layout is sealed in the
   * blob; a batch is capped at 10 calls and 20 000 characters, falling back
   * to per-call prompts above that. Read once, at wrap time; any other
   * value fails the wrap (`validate`).
   */
  approvalPrompts?: ApprovalPrompts;
  /**
   * Replaces the whole R29 preamble, whichever projections are on (the
   * code-mode, catalog or routing copy).
   */
  codeModePreamble?: string;
  /** Compatibility switches for pre-2026-07-28 clients. */
  compat?: {
    /**
     * Serve approval suspensions to legacy clients through the SDK's
     * server→client `elicitation/create` shim instead of failing fast
     * (R28 amendment; DECISIONS D6). The client must declare the
     * `elicitation` capability. Statelessness is suspended for the open
     * call — free over stdio, needs session affinity over legacy HTTP.
     */
    legacyElicitation?: boolean;
  };
  /** Identity the servers built by `createServer` advertise. */
  serverInfo?: Implementation;
  /**
   * R37: above this many tools, `discover_apis` omits the per-tool list and
   * points at `search_tools` / `describe_tool` (only when the catalog
   * projection is on). Default 40.
   */
  catalogInlineThreshold?: number;
  /**
   * Shared replay cache (R38). Consulted after blob verification and before
   * any gated execution, for both `execute_machine` and `call_tool`. None
   * ships by default; supply a store shared across instances.
   */
  replayCache?: ReplayCache;
  /**
   * Which projections the facade serves (R1, R32): code mode
   * (`execute_machine`, `discover_apis`) and the catalog projection
   * (`search_tools`, `describe_tool`, `call_tool`). Both default on;
   * disabling both is an error at wrap time.
   */
  projections?: ProjectionsOptions;
  /**
   * Where upstream tokens for sources given by URL live (R59). Default: the
   * OS credential store through the optional `@napi-rs/keyring` dependency,
   * falling back to memory (with one stderr warning) when it is absent or
   * the store is unavailable. A horizontally scaled deployment supplies a
   * shared store (R27). Unused by pre-built `McpServer` / `Client` sources.
   */
  tokenStore?: TokenStore;
  /**
   * Whether the wrapped server's own questions reach the human (G1,
   * DECISIONS D24). `'refuse'` (default): Projection declares no
   * elicitation capability to the server, and a tool that asks anyway fails
   * with a result saying it needs the user's input. `'forward'`: the
   * capability is declared, and each question — a form, or a link to open —
   * is relayed to the human over MRTR in Projection's own prompt, headed
   * `Question from <box> (not an approval)` with the server's words quoted,
   * after the call itself passed the approval gate. Enable it only for
   * servers you trust to ask your users things: a hostile server can still
   * word a phishing question. On `wrapMcpServers` this is the default for
   * every box, and a source configuration can override it per box.
   * Read once, at wrap time; any other value fails the wrap (`validate`).
   */
  upstreamElicitation?: UpstreamElicitationMode;
  /**
   * Bound, in milliseconds, on each wrapped source's connect and `tools/list`
   * introspection at wrap time (R47). A source that has not finished in time
   * fails the wrap with a `protocol` error, and every connection Projection
   * opened is closed (a `Client` you passed in stays open). Default 30 000.
   * It also bounds each re-listing after a `tools/list_changed` (R65).
   */
  introspectTimeoutMs?: number;
  /**
   * Follow the wrapped servers' `notifications/tools/list_changed` (R65,
   * DECISIONS D43). Default `true`: when a server Projection connected to
   * itself (an `McpServer` instance, or a server given by URL) advertises
   * `tools.listChanged`, Projection subscribes, and on a notification
   * re-lists that server — debounced, at most once per `minIntervalMs`,
   * bounded by `introspectTimeoutMs` — then swaps in the rebuilt catalog,
   * types, overview, resources and policy (`policyRules` included) at
   * once. Until the re-listing lands, the box's annotations are distrusted,
   * so nothing it declares runs without approval on a stale read-only hint.
   * Which surface the facade serves (`projections.direct`, the search
   * tools) stays as decided at wrap time. A `Client` you passed in is never
   * subscribed: call `facade.refreshTools()` from its own handler instead.
   * `false` keeps every catalog exactly as wrapped. An object tunes the
   * timing: `debounceMs` (default 250, 0–60 000) and `minIntervalMs`
   * (default 2 000, 100–3 600 000). Any other value fails the wrap
   * (`validate`).
   */
  followListChanged?: boolean | { debounceMs?: number; minIntervalMs?: number };
}

/** Per-projection on/off switches (R1, R32). */
export interface ProjectionsOptions {
  codeMode?: boolean;
  catalog?: boolean;
  /**
   * Direct listing (see `facade/direct.ts`): also register one
   * **mediated** facade tool per wrapped tool, a thin alias of
   * `call_tool({ name, args })` under exactly the same gate, so the model
   * sees every tool's name, description and schema without searching.
   * `true` always lists them; `'auto'` lists them when their estimated
   * definitions fit `directBudgetTokens` (on a multi-server facade box by
   * box, smallest box first; the other boxes keep the catalog path);
   * `false` never. Default `'auto'` (DECISIONS D28). Needs the
   * catalog projection: `true` with `catalog: false` fails the wrap
   * (`validate`); `'auto'` then stays off.
   */
  direct?: 'auto' | boolean;
  /**
   * `direct: 'auto'`: the largest estimated size, in tokens, of all mediated
   * tool definitions (name, description, input schema; characters / 3.5)
   * that is still listed directly. Default {@link DEFAULT_DIRECT_BUDGET_TOKENS}.
   */
  directBudgetTokens?: number;
}

/**
 * Default `projections.directBudgetTokens`: about 8k estimated tokens of
 * tool definitions. Measured (explore/adaptive-surface.md): listing wins
 * clearly at 2k and 5.4k estimated tokens and breaks even on Sonnet 5.5 at
 * about 11k, whose tokenizer counts ~1.3–1.4× the estimate.
 */
export const DEFAULT_DIRECT_BUDGET_TOKENS = 8_000;

/** The validated direct-listing settings (see {@link ProjectionsOptions.direct}). */
export interface DirectSetting {
  mode: 'auto' | 'on' | 'off';
  budgetTokens: number;
}

/**
 * `projections.direct` / `directBudgetTokens`, validated at wrap time;
 * `catalog` is the resolved catalog switch. Anything malformed is a
 * `validate` error, before any source is connected.
 */
export function resolveDirectSetting(
  options: ProjectionsOptions | undefined,
  catalog: boolean,
): DirectSetting {
  const direct: unknown = options?.direct;
  const budget: unknown = options?.directBudgetTokens;
  if (direct !== undefined && typeof direct !== 'boolean' && direct !== 'auto') {
    throw new ProjectionError('validate', "projections.direct must be true, false or 'auto'", {
      hint: 'Pass projections: { direct: false } to always search, or omit it to list small catalogs directly.',
    });
  }
  if (
    budget !== undefined &&
    (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 0)
  ) {
    throw new ProjectionError(
      'validate',
      'projections.directBudgetTokens must be a whole number of tokens',
      {
        hint: `Pass e.g. directBudgetTokens: ${DEFAULT_DIRECT_BUDGET_TOKENS}, or omit it for the default.`,
      },
    );
  }
  if (direct === true && !catalog) {
    throw new ProjectionError('validate', 'projections.direct needs the catalog projection', {
      hint: 'Directly listed tools are aliases of call_tool: keep projections.catalog on, or drop direct.',
    });
  }
  const mode = direct === true ? 'on' : direct !== false && catalog ? 'auto' : 'off';
  return { mode, budgetTokens: (budget as number | undefined) ?? DEFAULT_DIRECT_BUDGET_TOKENS };
}

/** Options for registering the projections on a server the caller built. */
export interface RegisterOptions {
  /**
   * The protocol era this server instance serves (R28). Omitted means
   * `'legacy'`: a hand-connected `McpServer` never negotiates 2026-07-28, so
   * defaulting to legacy is the honest — and fail-safe — reading.
   */
  era?: ProtocolEra;
}

/**
 * R1: at least one projection must be on, or the facade serves nothing. The
 * selection is frozen: it is exposed on the facade and read per request.
 * `defaults` is what an absent switch means for this facade kind.
 */
export function resolveProjections(
  options: ProjectionsOptions | undefined,
  defaults: ProjectionSelection = { codeMode: true, catalog: true },
): Readonly<ProjectionSelection> {
  const selection: ProjectionSelection = {
    codeMode: options?.codeMode ?? defaults.codeMode,
    catalog: options?.catalog ?? defaults.catalog,
  };
  if (!selection.codeMode && !selection.catalog) {
    throw new ProjectionError('terminal', 'at least one projection must be enabled', {
      hint: 'Set projections.codeMode and/or projections.catalog to true (both default to on).',
    });
  }
  return Object.freeze(selection);
}

/**
 * The policy options every surface decides with (R14, R49), frozen at wrap
 * time; absent ones stay absent (`exactOptionalPropertyTypes`).
 */
export type PolicySettings = Readonly<PolicyOptions>;

/**
 * The wrap-time snapshot of the policy settings (see {@link WrapOptions}):
 * one frozen copy feeds typegen AND the gate and catalog tools, so the
 * posture every surface shows is the posture the gate decides with, which a
 * caller mutating their options after wrap could otherwise drift apart.
 */
/** Longest `introspectTimeoutMs` accepted: the largest delay a timer can hold. */
const MAX_INTROSPECT_TIMEOUT_MS = 2_147_483_647;

/**
 * `WrapOptions.introspectTimeoutMs`, validated (R47): a positive integer
 * number of milliseconds, default {@link DEFAULT_INTROSPECT_TIMEOUT_MS};
 * anything else is a `validate` error at wrap time.
 */
export function resolveIntrospectTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_INTROSPECT_TIMEOUT_MS;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_INTROSPECT_TIMEOUT_MS
  ) {
    throw new ProjectionError(
      'validate',
      'introspectTimeoutMs must be a positive whole number of milliseconds',
      {
        hint: `Pass e.g. introspectTimeoutMs: 30000, or omit it for the default (${DEFAULT_INTROSPECT_TIMEOUT_MS} ms).`,
      },
    );
  }
  return value;
}

export function freezePolicySettings(settings: PolicyOptions): PolicySettings {
  return Object.freeze({
    ...(settings.policy !== undefined ? { policy: Object.freeze({ ...settings.policy }) } : {}),
    ...(settings.approvals !== undefined ? { approvals: settings.approvals } : {}),
    ...(settings.toolApprovals !== undefined && settings.toolApprovals.size > 0
      ? { toolApprovals: settings.toolApprovals }
      : {}),
  });
}

/**
 * The approval-gate dependencies both gated tools share (R35, R38).
 * `exactOptionalPropertyTypes`: absent options stay absent.
 */
export function approvalGateDeps(input: {
  catalog: ServerCatalog;
  /** The facade kind's key domain (R41), checked against the catalog. */
  blobDomain: BlobKeyDomain;
  executor: ToolExecutor;
  options: WrapOptions;
  policySettings: PolicySettings;
  era: ProtocolEra | undefined;
  clientCanElicit: boolean | undefined;
  /** Whether the client declared URL-mode elicitation (G1); omit when unknown. */
  clientUrlElicitation?: boolean | undefined;
}): ApprovalGateDeps {
  const { options, era, clientCanElicit, clientUrlElicitation } = input;
  return {
    catalog: input.catalog,
    blobDomain: input.blobDomain,
    executor: input.executor,
    blob: options.blob,
    ...(options.caps !== undefined ? { caps: options.caps } : {}),
    ...input.policySettings,
    ...(options.redact !== undefined ? { redact: options.redact } : {}),
    ...(era !== undefined ? { protocolEra: era } : {}),
    ...(options.compat?.legacyElicitation === true ? { legacyElicitation: true } : {}),
    ...(clientCanElicit !== undefined ? { clientCanElicit } : {}),
    ...(clientUrlElicitation !== undefined ? { clientUrlElicitation } : {}),
    ...(options.replayCache !== undefined ? { replayCache: options.replayCache } : {}),
    ...(options.approvalPrompts !== undefined ? { approvalPrompts: options.approvalPrompts } : {}),
  };
}

/**
 * `upstreamElicitation` (G1), validated: `'forward'`, `'refuse'`, or absent
 * (the default, `'refuse'`); anything else is a `validate` error at wrap time.
 */
export function assertUpstreamElicitationMode(
  value: unknown,
  label = 'upstreamElicitation',
): UpstreamElicitationMode | undefined {
  if (value === undefined || value === 'forward' || value === 'refuse') return value;
  throw new ProjectionError('validate', `${label} must be "forward" or "refuse"`, {
    hint: "Pass upstreamElicitation: 'forward' to pass a trusted server's own questions on to the user, or omit it to refuse them (the default).",
  });
}

/** Validate `WrapOptions.approvalPrompts` at wrap time: absent, or one of the two layouts. */
export function assertApprovalPrompts(value: unknown): ApprovalPrompts | undefined {
  if (value === undefined || value === 'per-call' || value === 'batched') return value;
  throw new ProjectionError(
    'validate',
    `approvalPrompts must be 'per-call' or 'batched', got ${JSON.stringify(value) ?? String(value)}`,
    { hint: "Set approvalPrompts to 'per-call' (the default) or 'batched', or leave it out." },
  );
}
