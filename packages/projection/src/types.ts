/**
 * Shared core types for Projection.
 *
 * These types are the contract between the seven components (introspector,
 * typegen, sandbox runtime, machine host, policy engine, blob sealer, MRTR
 * adapter). Component implementations depend on this module; it depends on
 * nothing inside the package.
 */

// ---------------------------------------------------------------------------
// Tool catalog (Introspector output — PRD R14, R30)
// ---------------------------------------------------------------------------

/** Alias identifying a wrapped server. v1 instantiates exactly one. */
export type ServerAlias = string;

export const DEFAULT_SERVER_ALIAS: ServerAlias = 'default';

/** MCP tool annotations we care about (untrusted hints — S5). */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  title?: string;
}

export interface ToolCatalogEntry {
  /** Tool name as declared by the wrapped server. */
  name: string;
  description?: string;
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>;
  /** JSON Schema for the tool's output, when declared. */
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

export interface ToolCatalog {
  /** Keyed by server alias (R30). v1 has exactly one entry. */
  servers: Map<ServerAlias, ServerCatalog>;
}

export interface ServerCatalog {
  alias: ServerAlias;
  /** Stable identity string recorded into blobs (R30). */
  identity: string;
  /** The wrapped server's `instructions` field, verbatim (R29). */
  instructions?: string;
  tools: ToolCatalogEntry[];
}

/**
 * Name → entry index, built lazily and cached per catalog object. The
 * catalog is immutable once introspected, so a `WeakMap` keyed on identity
 * lets every consumer look a tool up in O(1) without the catalog having to
 * carry (and every construction site having to build) the index itself.
 */
const catalogIndex = new WeakMap<ServerCatalog, Map<string, ToolCatalogEntry>>();

/**
 * Look up a tool by name in a catalog, O(1) after the first call.
 *
 * Duplicate names resolve to the FIRST occurrence, matching `Array#find` and
 * {@link dedupeTools} (S5): a hostile server declaring the same name twice
 * must not be able to make the policy gate see a different entry (e.g. a
 * later `readOnlyHint: true` copy) than the one typegen exposed.
 */
export function findTool(catalog: ServerCatalog, name: string): ToolCatalogEntry | undefined {
  let index = catalogIndex.get(catalog);
  if (index === undefined) {
    index = new Map();
    for (const tool of catalog.tools) {
      if (!index.has(tool.name)) index.set(tool.name, tool);
    }
    catalogIndex.set(catalog, index);
  }
  return index.get(name);
}

/**
 * Drop tools whose name repeats an earlier one; the first occurrence wins.
 *
 * The single dedupe rule for every consumer of the catalog (typegen, the
 * catalog projection), so they all agree with {@link findTool} on which
 * entry a name denotes (S5).
 */
export function dedupeTools(tools: ToolCatalogEntry[]): ToolCatalogEntry[] {
  const seen = new Set<string>();
  return tools.filter((tool) => {
    if (seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });
}

/** Narrow to a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Executes a tool call against the wrapped server. Implemented by the introspector. */
export interface ToolExecutor {
  callTool(
    alias: ServerAlias,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallOutcome>;
}

export type ToolCallOutcome =
  { ok: true; result: unknown } | { ok: false; error: { message: string; detail?: unknown } };

// ---------------------------------------------------------------------------
// Policy engine (PRD R14)
// ---------------------------------------------------------------------------

export type PolicyDecision = 'auto' | 'ask' | 'deny';

export interface PolicyOverrides {
  /** Per-tool decision override, keyed by tool name (v1: single server). */
  [toolName: string]: PolicyDecision;
}

// ---------------------------------------------------------------------------
// Machine <-> host event protocol (PRD R7)
// ---------------------------------------------------------------------------

/** A tool call requested by the machine via the `toolCall` action creator. */
export interface PendingToolCall {
  /** Unique id for this call within the workflow (also the inputRequest key). */
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Machine state path that requested the call (for elicitation copy — R16). */
  stateName: string;
}

/** Events the host injects into the machine. The machine never performs I/O itself. */
export type HostEvent =
  | { type: 'TOOL_RESULT'; callId: string; result: unknown }
  | { type: 'TOOL_ERROR'; callId: string; error: { message: string; detail?: unknown } }
  | { type: 'TOOL_DENIED'; callId: string; reason?: string };

// ---------------------------------------------------------------------------
// Structured errors and logs (PRD R25, R31)
// ---------------------------------------------------------------------------

export type ErrorPhase =
  | 'transpile'
  | 'validate'
  | 'runtime'
  | 'cap_exceeded'
  | 'blob_verification'
  | 'protocol'
  /** An `isError` result or transport failure from the wrapped tool, surfaced by `call_tool` (R25). */
  | 'upstream'
  | 'terminal';

export interface Diagnostic {
  message: string;
  /** Optional source location within the submitted code. */
  line?: number;
  column?: number;
}

export interface StructuredError {
  phase: ErrorPhase;
  message: string;
  diagnostics: Diagnostic[];
  /** One-line actionable fix (R25). */
  hint: string;
  logs: LogEntry[];
}

export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  level: LogLevel;
  message: string;
  /** Milliseconds since segment start. */
  ts: number;
  /** Zero-based MRTR segment index this entry was captured in. */
  segment: number;
}

// ---------------------------------------------------------------------------
// Resource caps (PRD R12)
// ---------------------------------------------------------------------------

export interface ResourceCaps {
  /** Wall-clock per execution segment, ms. */
  segmentWallClockMs: number;
  /** WASM memory, bytes. */
  wasmMemoryBytes: number;
  /** Submitted code size, bytes. */
  maxCodeBytes: number;
  /** Submitted machine input, bytes of its JSON serialization. */
  maxInputBytes: number;
  /** Read-only tool calls per segment. */
  maxReadCallsPerSegment: number;
  /** MRTR round trips per workflow. */
  maxRoundTrips: number;
  /** Machine events processed per segment. */
  maxEventsPerSegment: number;
  /** Final result payload, bytes. */
  maxResultBytes: number;
  /** Machine state nodes (static count at validation). */
  maxStateNodes: number;
  /** Captured console output per segment, bytes. */
  maxConsoleBytes: number;
}

export const DEFAULT_CAPS: ResourceCaps = {
  segmentWallClockMs: 30_000,
  wasmMemoryBytes: 128 * 1024 * 1024,
  maxCodeBytes: 128 * 1024,
  maxInputBytes: 128 * 1024,
  maxReadCallsPerSegment: 50,
  maxRoundTrips: 8,
  maxEventsPerSegment: 10_000,
  maxResultBytes: 256 * 1024,
  maxStateNodes: 100,
  maxConsoleBytes: 64 * 1024,
};

export const MAX_CAPS: ResourceCaps = {
  segmentWallClockMs: 60_000,
  wasmMemoryBytes: 256 * 1024 * 1024,
  maxCodeBytes: 256 * 1024,
  maxInputBytes: 256 * 1024,
  maxReadCallsPerSegment: 200,
  maxRoundTrips: 16,
  maxEventsPerSegment: 50_000,
  maxResultBytes: 1024 * 1024,
  maxStateNodes: 1_000,
  maxConsoleBytes: 256 * 1024,
};

/**
 * Smallest value each cap may be configured down to.
 *
 * Caps are "configurable downward" (R12), but zero or negative would brick
 * the flow rather than restrict it — a `maxRoundTrips` of 0 makes every
 * gated workflow terminal, and a `segmentWallClockMs` of 0 fails every
 * execution. Misconfiguration should not look like a library bug.
 */
const MIN_CAPS: ResourceCaps = {
  segmentWallClockMs: 100,
  // The QuickJS WASM module starts with a 16 MB linear memory that cannot
  // be lowered, so a smaller cap would promise a bound the engine cannot
  // keep (see sandbox/session.ts, boundedWasmMemory).
  wasmMemoryBytes: 16 * 1024 * 1024,
  maxCodeBytes: 1024,
  maxInputBytes: 1024,
  maxReadCallsPerSegment: 1,
  maxRoundTrips: 1,
  maxEventsPerSegment: 1,
  maxResultBytes: 1024,
  maxStateNodes: 1,
  maxConsoleBytes: 1024,
};

/** Clamp requested caps into [MIN_CAPS, MAX_CAPS] (R12). */
export function clampCaps(requested: Partial<ResourceCaps>): ResourceCaps {
  const caps = { ...DEFAULT_CAPS };
  for (const key of Object.keys(caps) as (keyof ResourceCaps)[]) {
    const value = requested[key];
    if (value !== undefined && Number.isFinite(value)) {
      caps[key] = Math.max(MIN_CAPS[key], Math.min(value, MAX_CAPS[key]));
    }
  }
  return caps;
}

// ---------------------------------------------------------------------------
// Suspension blob (PRD R19–R23)
// ---------------------------------------------------------------------------

export const BLOB_SCHEMA_VERSION = 1;

/** Which tool minted a blob (R36): a blob opened by the other tool is rejected. */
export type BlobKind = 'machine' | 'call';

export interface BlobPayload {
  /** Blob schema version; unknown versions are rejected. */
  v: number;
  /** Minting tool (R36). */
  kind: BlobKind;
  /** Library version that produced the snapshot. */
  libv: string;
  /** Exact XState version that produced the snapshot. */
  xstatev: string;
  /**
   * Binding hash (S4): SHA-256 (hex) of the original `code` for `machine`
   * blobs, of the canonical `{ kind: "call", name, args }` request for
   * `call` blobs (R36).
   */
  codeHash: string;
  /** Server identity the blob was minted against (R30). */
  serverIdentity: string;
  /** `getPersistedSnapshot()` output of the machine actor. */
  snapshot: unknown;
  /** inputRequest key -> gated tool call awaiting a verdict (S2). */
  pending: Record<string, PendingToolCall>;
  /**
   * Approval audit accumulated in earlier segments (PRD §8).
   *
   * Carried in the blob because the library holds no cross-request state
   * (R27): without it a completed workflow would report only the approvals
   * of its final segment.
   */
  audit: AuditEntry[];
  /** Round-trip counter (R18). */
  trip: number;
  /** Random nonce for replay scoping. */
  nonce: string;
  /** Issued-at, Unix ms. */
  iat: number;
  /** Expiry, Unix ms (default TTL 15 min). */
  exp: number;
}

export interface BlobSealerConfig {
  /** Current encryption key (32 bytes). */
  key: Uint8Array;
  /** Previous keys accepted for decryption during rotation (R22). */
  previousKeys?: Uint8Array[];
  /** Blob TTL in ms for `machine` blobs. Default 15 minutes. */
  ttlMs?: number;
  /**
   * Blob TTL in ms for `call` blobs (R38). Default 5 minutes: an approved
   * `call` blob has no forward step, so it is a standing capability until
   * it expires (D4, D9).
   */
  callTtlMs?: number;
  /** Sealed+compressed size ceiling in bytes. Default 128 KB (R23). */
  maxBlobBytes?: number;
}

/**
 * Optional shared replay cache (R38). When configured, the adapter consults
 * it after blob verification and before executing any gated call, for both
 * blob kinds. No default ships: an in-memory one would silently break
 * horizontal scaling (G4), so the integrator supplies a shared store.
 */
export interface ReplayCache {
  /**
   * Record `nonce` until `exp` (Unix ms) and resolve `true` when it had
   * already been recorded — i.e. this approval is being replayed.
   *
   * Contract: this MUST be an atomic test-and-set across every instance that
   * can serve a retry (a SETNX-style primitive, not a read followed by a
   * write), or two concurrent replays of one approval both execute. The
   * nonce is recorded on FIRST SIGHT, before the verdict is read and
   * regardless of what follows — a decline, a policy denial, an upstream
   * failure — so a blob is single-use whatever happens to the call it
   * carried. A retry that fails verification never reaches this method.
   */
  seen(nonce: string, exp: number): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Execution results (what the machine host / MRTR adapter exchange)
// ---------------------------------------------------------------------------

/** Verdict delivered on retry for a pending gated call. */
export type ApprovalVerdict = { kind: 'approved' } | { kind: 'declined'; reason?: string };

/** Outcome of running one execution segment. */
export type SegmentOutcome =
  | {
      status: 'completed';
      /** Final machine output/context to return to the client. */
      output: unknown;
      /** Per-call approval audit trail. */
      audit: AuditEntry[];
      logs: LogEntry[];
    }
  | {
      status: 'suspended';
      /** Gated calls awaiting approval, keyed by inputRequest key. */
      pending: Record<string, PendingToolCall>;
      /** Actor snapshot to seal into the blob. */
      snapshot: unknown;
      trip: number;
      audit: AuditEntry[];
      logs: LogEntry[];
    }
  | {
      status: 'error';
      error: StructuredError;
    };

export interface AuditEntry {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  decision: 'auto' | 'approved' | 'declined' | 'denied_by_policy' | 'error';
  reason?: string;
}

// ---------------------------------------------------------------------------
// Top-level configuration (integrating developer surface)
// ---------------------------------------------------------------------------

export interface RedactionHook {
  /**
   * Mask sensitive argument fields before they appear in elicitation copy
   * (R16). Receives the tool name and resolved args; returns args to display.
   */
  (toolName: string, args: Record<string, unknown>): Record<string, unknown>;
}

export interface ProjectionConfig {
  /** Resource cap overrides, clamped at maxima (R12). */
  caps?: Partial<ResourceCaps>;
  /** Per-tool policy overrides (R14). */
  policy?: PolicyOverrides;
  /** Blob sealing configuration (required for any gated flow). */
  blob: BlobSealerConfig;
  /** Redaction hook for elicitation copy (R16). */
  redact?: RedactionHook;
  /**
   * Replaces the whole R29 preamble appended to `instructions`, whichever
   * projections are on (code mode, catalog, or the routing copy for both).
   */
  codeModePreamble?: string;
}
