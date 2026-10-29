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
import type { ApprovalGateDeps, ProjectionSelection, ProtocolEra } from '../mrtr/index.js';
import type {
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
  /** Masks sensitive argument fields before they reach an approval prompt (R16). */
  redact?: RedactionHook;
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
 * The wrap-time snapshot of `options.policy` (see {@link WrapOptions.policy}):
 * one frozen copy feeds typegen AND the gate and catalog tools, so the
 * posture every surface shows is the posture the gate decides with.
 */
export function freezePolicy(policy: PolicyOverrides | undefined): PolicyOverrides | undefined {
  return policy !== undefined ? Object.freeze({ ...policy }) : undefined;
}

/**
 * The approval-gate dependencies both gated tools share (R35, R38).
 * `exactOptionalPropertyTypes`: absent options stay absent.
 */
export function approvalGateDeps(input: {
  catalog: ServerCatalog;
  executor: ToolExecutor;
  options: WrapOptions;
  policy: PolicyOverrides | undefined;
  era: ProtocolEra | undefined;
  clientCanElicit: boolean | undefined;
}): ApprovalGateDeps {
  const { options, policy, era, clientCanElicit } = input;
  return {
    catalog: input.catalog,
    executor: input.executor,
    blob: options.blob,
    ...(options.caps !== undefined ? { caps: options.caps } : {}),
    ...(policy !== undefined ? { policy } : {}),
    ...(options.redact !== undefined ? { redact: options.redact } : {}),
    ...(era !== undefined ? { protocolEra: era } : {}),
    ...(options.compat?.legacyElicitation === true ? { legacyElicitation: true } : {}),
    ...(clientCanElicit !== undefined ? { clientCanElicit } : {}),
    ...(options.replayCache !== undefined ? { replayCache: options.replayCache } : {}),
  };
}
