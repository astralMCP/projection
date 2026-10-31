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
  RedactionHook,
  ReplayCache,
  ResourceCaps,
  ServerCatalog,
  ToolExecutor,
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
   * person (R15 amendment; DECISIONS D22). `'per-call'` (default) sends one
   * elicitation per call. `'batched'` sends one elicitation listing every
   * call in its full approval copy, with one pre-ticked boolean per call:
   * each call still runs only if its own box comes back ticked, on the
   * arguments sealed for it (S2). A client that answers the form without
   * the booleans declines every call. Read once, at wrap time; any other
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
   * Bound, in milliseconds, on each wrapped source's connect and `tools/list`
   * introspection at wrap time (R47). A source that has not finished in time
   * fails the wrap with a `protocol` error, and every connection Projection
   * opened is closed (a `Client` you passed in stays open). Default 30 000.
   */
  introspectTimeoutMs?: number;
}

/** Per-projection on/off switches (R1, R32). */
export interface ProjectionsOptions {
  codeMode?: boolean;
  catalog?: boolean;
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
}): ApprovalGateDeps {
  const { options, era, clientCanElicit } = input;
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
    ...(options.replayCache !== undefined ? { replayCache: options.replayCache } : {}),
    ...(options.approvalPrompts !== undefined ? { approvalPrompts: options.approvalPrompts } : {}),
  };
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
