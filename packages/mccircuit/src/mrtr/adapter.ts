/**
 * MRTR adapter — maps segment outcomes to `tools/call` results and parses
 * retries back into verdicts (PRD §7 "MRTR adapter"; R15, R17, R18, R27,
 * R28, S2).
 */

import { hashCode, openBlob, sealBlob, buildBlobPayload } from '../blob/index.js';
import { McCircuitError, toStructuredError } from '../errors.js';
import { runSegment } from '../machine-host/index.js';
import { buildElicitationCopy } from '../policy/index.js';
import {
  clampCaps,
  type ApprovalVerdict,
  type AuditEntry,
  type BlobSealerConfig,
  type LogEntry,
  type PendingToolCall,
  type PolicyOverrides,
  type RedactionHook,
  type ResourceCaps,
  type SegmentOutcome,
  type ServerCatalog,
  type StructuredError,
  type ToolExecutor,
} from '../types.js';
import {
  APPROVAL_SCHEMA,
  MRTR_PROTOCOL_REVISION,
  supportsMrtr,
  type CompleteResult,
  type ContentBlock,
  type ElicitationRequest,
  type InputRequiredResult,
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
  /** Protocol revision the client negotiated, for down-negotiation (R28). */
  protocolVersion?: string;
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
    throw new McCircuitError(
      'terminal',
      `this workflow reached the limit of ${caps.maxRoundTrips} approval round trips`,
      {
        hint: `Restructure the machine to need at most ${caps.maxRoundTrips} approval round trips, for example by batching writes into fewer states.`,
      },
    );
  }

  const verdicts: Record<string, ApprovalVerdict> = {};
  for (const key of Object.keys(payload.pending)) {
    const response = args.inputResponses?.[key];
    // R17: absent, declined and cancelled all count as declined.
    if (response === undefined || response.action !== 'accept') {
      const reason = readReason(response?.content);
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
      return {
        resultType: 'complete',
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
  // R28: a client that cannot carry MRTR must fail here rather than silently
  // executing an unapproved write or hanging.
  if (!supportsMrtr(deps.protocolVersion)) {
    return errorResult({
      phase: 'protocol',
      message: `this machine needs approval for a non-read-only tool call, which requires MCP protocol revision ${MRTR_PROTOCOL_REVISION} or later (the client negotiated ${deps.protocolVersion ?? 'an earlier revision'})`,
      diagnostics: [],
      hint: 'Author a machine that only calls read-only tools, or connect with a client supporting Multi Round-Trip Requests.',
      logs: outcome.logs,
    });
  }

  // R18: refuse to suspend again once the cap is reached, rather than
  // minting a blob the retry would reject.
  if (outcome.trip > caps.maxRoundTrips) {
    return errorResult({
      phase: 'terminal',
      message: `this workflow reached the limit of ${caps.maxRoundTrips} approval round trips`,
      diagnostics: [],
      hint: `Restructure the machine to need at most ${caps.maxRoundTrips} approval round trips.`,
      logs: outcome.logs,
    });
  }

  const inputRequests: Record<string, ElicitationRequest> = {};
  for (const [key, call] of Object.entries(outcome.pending)) {
    const entry = deps.catalog.tools.find((tool) => tool.name === call.name);
    if (entry === undefined) {
      return errorResult({
        phase: 'validate',
        message: `the machine requested approval for unknown tool "${call.name}"`,
        diagnostics: [],
        hint: 'Call only tools listed by discover_apis.',
        logs: outcome.logs,
      });
    }
    // S6: copy is built from catalog data and redacted args only — never
    // from model-authored free text.
    const copy = buildElicitationCopy(
      call,
      entry,
      deps.redact !== undefined ? { redact: deps.redact } : {},
    );
    inputRequests[key] = {
      type: 'elicitation',
      title: copy.title,
      message: copy.message,
      requestedSchema: APPROVAL_SCHEMA,
    };
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

  const result: InputRequiredResult = {
    resultType: 'input_required',
    inputRequests,
    requestState,
  };
  const logs = logBlocks(outcome.logs);
  // R31: logs ship alongside suspensions too.
  return logs.length > 0 ? { ...result, content: logs } : result;
}

/** Every failure is a normal result with `isError: true` and a structured body (R25). */
function errorResult(error: StructuredError): CompleteResult {
  return {
    resultType: 'complete',
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
    throw new McCircuitError(
      'cap_exceeded',
      `submitted code is ${size} bytes, exceeding the limit of ${caps.maxCodeBytes}`,
      {
        hint: `Shorten the machine to at most ${caps.maxCodeBytes} bytes.`,
      },
    );
  }
}

/** Re-exported so callers can bind a blob to code without importing the sealer. */
export { hashCode };
