/**
 * MRTR adapter — maps segment outcomes to `tools/call` results and parses
 * retries back into verdicts (PRD §7 "MRTR adapter"; R15, R17, R18, R27,
 * R28, S2).
 */

import { hashCode, openBlob, sealBlob, buildBlobPayload } from '../blob/index.js';
import { ProjectionError, toStructuredError } from '../errors.js';
import { runSegment } from '../machine-host/index.js';
import { buildElicitationCopy } from '../policy/index.js';
import {
  clampCaps,
  findTool,
  type ApprovalVerdict,
  type AuditEntry,
  type BlobSealerConfig,
  type LogEntry,
  type PendingToolCall,
  type PolicyOverrides,
  type RedactionHook,
  type ErrorPhase,
  type ResourceCaps,
  type SegmentOutcome,
  type ServerCatalog,
  type StructuredError,
  type ToolExecutor,
} from '../types.js';
import {
  APPROVAL_SCHEMA,
  MRTR_PROTOCOL_REVISION,
  inputRequired,
  inputResponse,
  supportsMrtr,
  type CallToolResult,
  type ContentBlock,
  type InputRequests,
  type ProtocolEra,
  type RetryEnvelope,
  type ToolCallResult,
} from './protocol.js';

export interface ExecuteMachineArgs extends RetryEnvelope {
  /** The authored module source (R2). */
  code: string;
  lang?: 'ts' | 'js';
  /** Passed to the machine as its input. */
  input?: unknown;
}

export interface ExecuteMachineDeps {
  catalog: ServerCatalog;
  bridgeSource: string;
  executor: ToolExecutor;
  blob: BlobSealerConfig;
  caps?: Partial<ResourceCaps>;
  policy?: PolicyOverrides;
  redact?: RedactionHook;
  /**
   * Protocol era this request is being served on, for down-negotiation
   * (R28). The SDK hands it to the server factory as
   * `McpRequestContext.era`; `undefined` is treated as legacy.
   */
  protocolEra?: ProtocolEra;
  /**
   * Opt-in legacy-client compatibility (R28 amendment): when true, a
   * suspension on a pre-2026-07-28 connection is returned as a normal
   * `input_required` result and the SDK's serving layer fulfils it through
   * old-style server→client `elicitation/create` requests, re-invoking this
   * adapter with a byte-exact `requestState` echo and the collected
   * `inputResponses` — the same retry envelope as a real MRTR retry, so
   * every sealing/verification invariant runs unchanged. Cost: the
   * `tools/call` stays open on this instance while the human answers, so
   * statelessness (R27) is suspended for that call (free over stdio; needs
   * session affinity over legacy HTTP). Default false: fail fast per R28.
   */
  legacyElicitation?: boolean;
}

/**
 * Run `execute_machine` for one `tools/call`, whether it is a first attempt
 * or an MRTR retry.
 *
 * Statelessness (R27): everything needed to resume rides in `requestState`,
 * so any instance can serve any retry. Nothing is held between calls.
 */
export async function executeMachine(
  args: ExecuteMachineArgs,
  deps: ExecuteMachineDeps,
): Promise<ToolCallResult> {
  const caps = clampCaps(deps.caps ?? {});

  try {
    assertCodeSize(args.code, caps);
    assertInputSize(args.input, caps);

    const resume = args.requestState !== undefined ? openResume(args, deps, caps) : undefined;

    const outcome = await runSegment({
      code: args.code,
      ...(args.lang !== undefined ? { lang: args.lang } : {}),
      ...(args.input !== undefined ? { input: args.input } : {}),
      catalog: deps.catalog,
      bridgeSource: deps.bridgeSource,
      executor: deps.executor,
      caps,
      ...(deps.policy !== undefined ? { policy: deps.policy } : {}),
      segment: resume?.trip ?? 0,
      ...(resume !== undefined ? { resume } : {}),
    });

    return toToolCallResult(outcome, args, deps, caps);
  } catch (err) {
    return errorResult(toStructuredError(err));
  }
}

// ---------------------------------------------------------------------------
// Retry handling
// ---------------------------------------------------------------------------

interface ResumeState {
  snapshot: unknown;
  pending: Record<string, PendingToolCall>;
  verdicts: Record<string, ApprovalVerdict>;
  audit: AuditEntry[];
  trip: number;
}

/**
 * Verify the echoed blob and turn `inputResponses` into verdicts.
 *
 * The blob sealer performs the full R21 check chain (authenticate, version,
 * expiry, codeHash, server identity) and throws on any failure, so nothing
 * gated executes from an unverified blob.
 */
function openResume(
  args: ExecuteMachineArgs,
  deps: ExecuteMachineDeps,
  caps: ResourceCaps,
): ResumeState {
  const payload = openBlob(args.requestState as string, {
    code: args.code,
    serverIdentity: deps.catalog.identity,
    config: deps.blob,
  });

  // R18: the trip cap bounds a workflow's total round trips. The counter is
  // authenticated inside the blob, so a client cannot wind it back.
  //
  // `trip` is 1 on the first suspension, so a blob carrying trip === N is
  // the Nth round trip and must be allowed; only N+1 is over the cap. The
  // cap is also enforced at suspension time, which is what actually refuses
  // the workflow — this arm only catches a blob minted before a cap change.
  if (payload.trip > caps.maxRoundTrips) {
    throw new ProjectionError(
      'terminal',
      `this workflow reached the limit of ${caps.maxRoundTrips} approval round trips`,
      {
        hint: `Restructure the machine to need at most ${caps.maxRoundTrips} approval round trips, for example by batching writes into fewer states.`,
      },
    );
  }

  const verdicts: Record<string, ApprovalVerdict> = {};
  for (const key of Object.keys(payload.pending)) {
    // The SDK's discriminated reader covers every non-approval outcome in
    // one place: a missing key, a response of another kind (sampling,
    // roots), and the decline/cancel actions. R17 treats all of them as a
    // decline, so only an accepted elicitation approves the call.
    const view = inputResponse(args.inputResponses, key);
    if (view.kind !== 'elicit' || view.action !== 'accept') {
      const reason = view.kind === 'elicit' ? readReason(view.content) : undefined;
      verdicts[key] = reason !== undefined ? { kind: 'declined', reason } : { kind: 'declined' };
      continue;
    }
    verdicts[key] = { kind: 'approved' };
  }

  return {
    snapshot: payload.snapshot,
    pending: payload.pending,
    verdicts,
    // PRD §8: the audit trail spans the whole workflow, so it rides in the
    // blob — the library keeps no state between round trips (R27).
    audit: payload.audit,
    trip: payload.trip,
  };
}

function readReason(content: Record<string, unknown> | undefined): string | undefined {
  const reason = content?.['reason'];
  return typeof reason === 'string' && reason.length > 0 ? reason : undefined;
}

// ---------------------------------------------------------------------------
// Outcome mapping
// ---------------------------------------------------------------------------

function toToolCallResult(
  outcome: SegmentOutcome,
  args: ExecuteMachineArgs,
  deps: ExecuteMachineDeps,
  caps: ResourceCaps,
): ToolCallResult {
  switch (outcome.status) {
    case 'completed':
      // A finished result is a plain `CallToolResult`: the `resultType`
      // discriminator only ever appears on the input-required branch, and
      // the SDK lifts complete results before the client sees them.
      return {
        content: [
          { type: 'text', text: JSON.stringify(outcome.output ?? null, null, 2) },
          ...logBlocks(outcome.logs),
        ],
        structuredContent: {
          output: outcome.output ?? null,
          approvals: outcome.audit,
          logs: outcome.logs,
        },
      };

    case 'suspended':
      return suspendResult(outcome, args, deps, caps);

    case 'error':
      return errorResult(outcome.error);
  }
}

function suspendResult(
  outcome: Extract<SegmentOutcome, { status: 'suspended' }>,
  args: ExecuteMachineArgs,
  deps: ExecuteMachineDeps,
  caps: ResourceCaps,
): ToolCallResult {
  // This segment's console output rides on every failure below (R31).
  const fail = (phase: ErrorPhase, message: string, hint: string): ToolCallResult =>
    errorResult({ phase, message, diagnostics: [], hint, logs: outcome.logs });

  // R28: a client that cannot carry MRTR must fail here rather than silently
  // executing an unapproved write or hanging.
  //
  // The SDK would otherwise fulfil an `input_required` return on a legacy
  // connection through its server→client elicitation shim. By default
  // Projection refuses that path: R28 mandates a fail-fast error naming the
  // required revision, and the shim's push-style round trips hold a
  // connection open, which is exactly the statelessness (R27) the MRTR
  // design buys us. `legacyElicitation` opts in per facade (DECISIONS D6):
  // the shim's re-invocation carries the same requestState echo and
  // inputResponses as a real retry, so S2–S4 verification runs unchanged —
  // only the transport of the question differs.
  if (!supportsMrtr(deps.protocolEra) && deps.legacyElicitation !== true) {
    return fail(
      'protocol',
      `this machine needs approval for a non-read-only tool call, which requires MCP protocol revision ${MRTR_PROTOCOL_REVISION} or later (this request is being served on the ${deps.protocolEra ?? 'legacy'} protocol era)`,
      'Author a machine that only calls read-only tools, or connect with a client that negotiates the 2026-07-28 revision (SDK v2: `versionNegotiation: { mode: "auto" }`).',
    );
  }

  // R18: refuse to suspend again once the cap is reached, rather than
  // minting a blob the retry would reject.
  if (outcome.trip > caps.maxRoundTrips) {
    return fail(
      'terminal',
      `this workflow reached the limit of ${caps.maxRoundTrips} approval round trips`,
      `Restructure the machine to need at most ${caps.maxRoundTrips} approval round trips.`,
    );
  }

  const inputRequests: InputRequests = {};
  for (const [key, call] of Object.entries(outcome.pending)) {
    const entry = findTool(deps.catalog, call.name);
    if (entry === undefined) {
      return fail(
        'validate',
        `the machine requested approval for unknown tool "${call.name}"`,
        'Call only tools listed by discover_apis.',
      );
    }
    // S6: copy is built from catalog data and redacted args only — never
    // from model-authored free text.
    const copy = buildElicitationCopy(
      call,
      entry,
      deps.redact !== undefined ? { redact: deps.redact } : {},
    );
    // The 2026-07-28 elicitation params dropped `title` (the revision carries
    // `message` and `requestedSchema` only), so the summary line becomes the
    // first line of the message rather than being silently lost.
    inputRequests[key] = inputRequired.elicit({
      message: `${copy.title}\n\n${copy.message}`,
      requestedSchema: APPROVAL_SCHEMA,
    });
  }

  const payload = buildBlobPayload({
    code: args.code,
    serverIdentity: deps.catalog.identity,
    snapshot: outcome.snapshot,
    pending: outcome.pending,
    audit: outcome.audit,
    trip: outcome.trip,
    ...(deps.blob.ttlMs !== undefined ? { ttlMs: deps.blob.ttlMs } : {}),
  });

  let requestState: string;
  try {
    requestState = sealBlob(payload, deps.blob);
  } catch (err) {
    // R23 (blob over the size ceiling) is a failure the model can act on, so
    // it must keep this segment's console output (R31) rather than losing it
    // to the generic catch in executeMachine.
    const structured = toStructuredError(err, outcome.logs);
    return errorResult({ ...structured, logs: outcome.logs });
  }

  // The SDK's builder enforces the spec's at-least-one rule and stamps the
  // `resultType` discriminator, so the suspension is never hand-assembled.
  //
  // R31 caveat, verified against the SDK's wire codec: an `InputRequiredResult`
  // carries `resultType`, `inputRequests` and `requestState` and nothing else
  // — the 2026-07-28 encode seam drops `content` and `_meta` alike. So the
  // suspending segment's console output cannot ride this leg. It is not
  // smuggled into the elicitation prompt either: that copy is server-derived
  // by S6, and logs are model-authored. Every other response (completion,
  // `isError`, and each resumed segment) still carries its own logs.
  return inputRequired({ inputRequests, requestState });
}

/** Every failure is a normal result with `isError: true` and a structured body (R25). */
function errorResult(error: StructuredError): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(error, null, 2) }],
    structuredContent: { ...error },
  };
}

function logBlocks(logs: LogEntry[]): ContentBlock[] {
  if (logs.length === 0) return [];
  const text = logs.map((log) => `[${log.level}] ${log.message}`).join('\n');
  return [{ type: 'text', text: `Console output:\n${text}` }];
}

function assertCodeSize(code: string, caps: ResourceCaps): void {
  const size = Buffer.byteLength(code, 'utf8');
  if (size > caps.maxCodeBytes) {
    throw new ProjectionError(
      'cap_exceeded',
      `submitted code is ${size} bytes, exceeding the limit of ${caps.maxCodeBytes}`,
      {
        hint: `Shorten the machine to at most ${caps.maxCodeBytes} bytes.`,
      },
    );
  }
}

/**
 * The input is interpolated into the validation and bootstrap driver sources
 * as a JSON literal, so its serialized size — not the wire size of the raw
 * value — is what the sandbox actually pays for. Bounding it here yields a
 * structured cap_exceeded error instead of an opaque WASM memory failure.
 */
function assertInputSize(input: unknown, caps: ResourceCaps): void {
  if (input === undefined) return;
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch (err) {
    throw new ProjectionError('validate', 'machine input is not JSON-serializable', {
      hint: 'Remove circular references from the input; it must serialize to plain JSON.',
      cause: err,
    });
  }
  // A top-level function or symbol stringifies to undefined. Unreachable over
  // the wire (JSON transport); leave it to downstream handling as before.
  if (json === undefined) return;
  const size = Buffer.byteLength(json, 'utf8');
  if (size > caps.maxInputBytes) {
    throw new ProjectionError(
      'cap_exceeded',
      `submitted input serializes to ${size} bytes, exceeding the limit of ${caps.maxInputBytes}`,
      {
        hint: `Shrink the machine input to at most ${caps.maxInputBytes} bytes of JSON.`,
      },
    );
  }
}

/** Re-exported so callers can bind a blob to code without importing the sealer. */
export { hashCode };
