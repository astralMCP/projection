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

/** A plain object (prototype `Object.prototype` or `null`): what a configuration value must be. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * One wrapped-server progress report (MCP `notifications/progress`), as the
 * upstream sent it: `message` is server-authored text (S5), not yet
 * neutralized.
 */
export interface UpstreamProgress {
  progress: number;
  total?: number;
  message?: string;
}

/**
 * Host-side options for one upstream call: never model-authored. `signal`
 * cancels the upstream request (MCP `notifications/cancelled`) when the
 * facade's own request is cancelled; `onProgress` receives the upstream's
 * progress reports, and its presence asks the upstream for them.
 */
export interface UpstreamCallOptions {
  signal?: AbortSignal;
  onProgress?: (progress: UpstreamProgress) => void;
  /**
   * Re-issue a call whose upstream asked for input (G1, DECISIONS D24): the
   * answers keyed by the upstream's own keys, and the upstream's own
   * `requestState` echoed verbatim. Read only from a verified blob and the
   * human's responses, never from tool arguments.
   */
  input?: UpstreamInputResume;
}

/**
 * What a wrapped server asked for when its tool answered `input_required`
 * (MCP 2026-07-28 MRTR), as received: untrusted server data (S5), not yet
 * sanitized. Present only for a box that forwards upstream elicitation.
 */
export interface UpstreamInputRequest {
  /** The upstream's embedded requests, keyed by its own keys. */
  requests: Record<string, unknown>;
  /** The upstream's opaque state, to be echoed back verbatim. */
  requestState?: string;
}

/**
 * Whether a box passes its server's own questions (MCP elicitation, form or
 * URL mode) on to the human (G1, DECISIONS D24). `'refuse'` (the default)
 * declares no elicitation capability to the server, and a question fails the
 * call with a result that says so. `'forward'` declares the capability and
 * relays each question over MRTR, attributed to the box and never shaped
 * like an approval. Sampling and roots are never forwarded.
 */
export type UpstreamElicitationMode = 'forward' | 'refuse';

/** The answers and state that re-issue a call whose upstream asked for input. */
export interface UpstreamInputResume {
  /** Bare `ElicitResult`s keyed by the upstream's own request keys. */
  responses: Record<string, unknown>;
  requestState?: string;
}

/** Executes a tool call against the wrapped server. Implemented by the introspector. */
export interface ToolExecutor {
  callTool(
    alias: ServerAlias,
    name: string,
    args: Record<string, unknown>,
    options?: UpstreamCallOptions,
  ): Promise<ToolCallOutcome>;
}

export type ToolCallOutcome =
  | {
      ok: true;
      result: unknown;
      /**
       * Set when `result` is the upstream's raw `content` array (no
       * `structuredContent`, not a single text block), so a renderer can
       * tell content blocks from structured data that happens to be an
       * array.
       */
      rawContent?: true;
      /**
       * Short text the server sent beside its `structuredContent` that is
       * not a JSON mirror of it (a warning such as "returning 10 of 40"),
       * raw but redacted like the result (S1). Shown to the model only as
       * a neutralized, quoted result note (D29, `catalog/result-notes.ts`).
       */
      serverNote?: string;
    }
  | {
      ok: false;
      error: { message: string; detail?: unknown };
      /**
       * Set when the call failed because upstream authorization failed (a
       * source given by URL, R51): `call_tool` reports it in the R25 `auth`
       * phase with this library-copy hint, not as an `upstream` failure.
       */
      auth?: { hint: string };
      /**
       * The upstream asked the user for input and its box forwards upstream
       * elicitation (G1): the gated entry points turn this into their own
       * `input_required`. A consumer that does not handle it sees an
       * ordinary failure, so nothing is ever forwarded by accident.
       */
      upstreamInput?: UpstreamInputRequest;
      /**
       * The upstream asked the user for input that is not forwarded (its
       * box refuses upstream elicitation, or it asked for sampling or
       * roots). `error.message` says so; the arguments were not the problem.
       */
      inputRefused?: true;
    };

// ---------------------------------------------------------------------------
// Policy engine (PRD R14)
// ---------------------------------------------------------------------------

export type PolicyDecision = 'auto' | 'ask' | 'deny';

export interface PolicyOverrides {
  /** Per-tool decision override, keyed by tool name (v1: single server). */
  [toolName: string]: PolicyDecision;
}

/**
 * Approvals mode (R49). `'every-write'` (the default) asks before every tool
 * that is not read-only; `'destructive-only'` also lets a non-read-only tool
 * run without approval when its annotations declare `destructiveHint: false`
 * exactly. That extends the trust placed in `readOnlyHint` to
 * `destructiveHint: false` (S5): enable it only for servers you trust.
 */
export type ApprovalsMode = 'every-write' | 'destructive-only';

/**
 * Everything a policy decision reads besides the tool itself (R14, R49):
 * the per-tool overrides and the resolved approvals mode, both frozen at
 * wrap time. Every surface decides through `decidePolicy` with one of these
 * (build it with `policyContext`), so the posture a model is shown is the
 * decision the gate makes.
 *
 * `approvals` is required — the context is *resolved* — so a bare
 * {@link PolicyOverrides} object cannot be passed where a context is
 * expected and silently lose its overrides. A multi-server facade adds its
 * per-source modes as `toolApprovals`, resolved per qualified tool (they
 * take precedence over `approvals`, R49), without changing `decidePolicy`'s
 * signature.
 */
export interface PolicyContext {
  /** Per-tool overrides (R14); an override always wins. */
  overrides?: PolicyOverrides | undefined;
  /** The approvals mode (R49) that applies when no override does. */
  approvals: ApprovalsMode;
  /**
   * A multi-server facade's per-source approvals modes (R49), resolved at
   * wrap time to one entry per qualified tool name (`fs.write_file`) from
   * the boxed view's members — so the box is never re-derived by splitting
   * a name. A tool with an entry decides with that mode instead of
   * `approvals`. Absent on single-server facades.
   */
  toolApprovals?: ReadonlyMap<string, ApprovalsMode> | undefined;
}

/**
 * The policy options every deciding surface takes (R14, R49) — the gate
 * deps, `searchTools`, `describeTool`, the machine host and typegen — in one
 * shape, turned into a {@link PolicyContext} by `policyContext`. Absent
 * options mean no overrides and `'every-write'`.
 */
export interface PolicyOptions {
  /** Per-tool policy overrides (R14). */
  policy?: PolicyOverrides | undefined;
  /** Approvals mode (R49), decided with `policy`. */
  approvals?: ApprovalsMode | undefined;
  /**
   * Per-source approvals modes of a multi-server facade, resolved per
   * qualified tool name (R49; see {@link PolicyContext.toolApprovals}).
   */
  toolApprovals?: ReadonlyMap<string, ApprovalsMode> | undefined;
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
  | {
      type: 'TOOL_RESULT';
      callId: string;
      result: unknown;
      /** The facade's notes on the result (R35.6, D29); absent when there are none. */
      notes?: string[];
    }
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
  /**
   * An upstream sign-in is required or could not complete (R25, R57):
   * library copy only, plus at most the OAuth `error` code.
   */
  | 'auth'
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
  // keep (see sandbox/session.ts, maximumPagesFor and acquireBoundedRuntime).
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

/**
 * Which tool minted a blob (R36): a blob opened by the other tool is
 * rejected. `upstream_input` is minted by `call_tool` when the wrapped
 * tool's own server asked the human a question (G1, D24); `call_tool`
 * opens both of its kinds.
 */
export type BlobKind = 'machine' | 'call' | 'upstream_input';

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
  /**
   * How this suspension was put to the person (R15): present, and
   * `'batched'`, only when it was one batched elicitation; absent means
   * one elicitation per pending call. Sealed so the resume answers the
   * prompt that was actually shown, whatever the resuming instance's
   * option (D25). Only on `machine` blobs with two or more pending calls;
   * never on `call` or `upstream_input` blobs (both minted by `call_tool`,
   * which never batches).
   */
  prompts?: 'batched';
  /** Round-trip counter (R18). */
  trip: number;
  /**
   * Calls that already ran under the gate and are waiting on their own
   * server's question (G1, D24), keyed by call id: the call, how it was
   * authorized, the server's sealed `requestState`, and the questions.
   * Never part of `pending` (S2): an answer re-issues the recorded call
   * and approves nothing. Exactly one entry keyed `call` for an
   * `upstream_input` blob; absent from `call` blobs.
   */
  upstreamInput?: Record<string, UpstreamHold>;
  /** Random nonce for replay scoping. */
  nonce: string;
  /** Issued-at, Unix ms. */
  iat: number;
  /** Expiry, Unix ms (default TTL 15 min). */
  exp: number;
}

/** A sanitized MCP elicitation schema: a flat object of primitive fields (G1). */
export interface ElicitationSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
}

/** One forwarded question as sealed: enough to map and check the answer (G1). */
export interface ForwardedQuestion {
  /** The server's own key for this request. */
  key: string;
  /**
   * `form`: the human filled the sanitized form in `schema`. `url`: the
   * human was shown a link (as URL mode, or as a form with the link as inert
   * text when the client cannot open links); accepting sends no content.
   */
  mode: 'form' | 'url';
  /** The sanitized schema the human answered (`form` only). */
  schema?: ElicitationSchema;
}

/**
 * A call that ran under the gate and is waiting on its server's question
 * (G1, D24), sealed in the blob's `upstreamInput` — never in the S2
 * `pending` map: an answer re-issues the recorded call, it approves nothing.
 */
export interface UpstreamHold extends PendingToolCall {
  /** How the call was authorized when it first ran. */
  decision: 'auto' | 'approved';
  /** The server's own opaque state, echoed verbatim on the re-issue. */
  requestState?: string;
  /** The questions, keyed by the facade's keys. */
  questions: Record<string, ForwardedQuestion>;
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
/** Most result notes a completed segment reports (D29). */
export const MAX_SEGMENT_NOTES = 10;

export type SegmentOutcome =
  | {
      status: 'completed';
      /** Final machine output/context to return to the client. */
      output: unknown;
      /** Per-call approval audit trail. */
      audit: AuditEntry[];
      logs: LogEntry[];
      /**
       * The result notes of this segment's tool calls (R35.6, D29), each
       * prefixed with its tool's name, at most {@link MAX_SEGMENT_NOTES};
       * absent when there are none.
       */
      notes?: string[];
    }
  | {
      status: 'suspended';
      /** Gated calls awaiting approval, keyed by inputRequest key. */
      pending: Record<string, PendingToolCall>;
      /**
       * Calls that ran and whose server asked the human a question (G1):
       * the adapter forwards each question and seals the hold.
       */
      held: HeldCall[];
      /** Actor snapshot to seal into the blob. */
      snapshot: unknown;
      trip: number;
      audit: AuditEntry[];
      logs: LogEntry[];
    }
  | {
      status: 'error';
      error: StructuredError;
      /**
       * The workflow's audit trail up to the failure (earlier segments'
       * included), so the result can say which approved calls already ran
       * and which were refused. Absent when nothing was audited.
       */
      audit?: AuditEntry[];
    };

/** A call whose server answered `input_required` on a box that forwards (G1). */
export interface HeldCall {
  call: PendingToolCall;
  decision: 'auto' | 'approved';
  input: UpstreamInputRequest;
}

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
   * (R16). Receives the tool name — qualified (`<alias>.<tool>`) on a
   * multi-server facade — and a copy of the resolved args; returns args to
   * display.
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
