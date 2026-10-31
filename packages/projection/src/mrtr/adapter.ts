/**
 * MRTR adapter — maps segment outcomes to `tools/call` results and parses
 * retries back into verdicts (PRD §7 "MRTR adapter"; R15, R17, R18, R27,
 * R28, S2).
 */

import {
  hashCode,
  openBlob,
  sealBlob,
  buildBlobPayload,
  type BlobKeyDomain,
} from '../blob/index.js';
import { approvalSubject, blobKeyDomain, isBoxedCatalog, routeCall } from '../catalog/boxes.js';
import { ProjectionError, toStructuredError } from '../errors.js';
import { runSegment } from '../machine-host/index.js';
import { buildElicitationCopy } from '../policy/index.js';
import { capLength, neutralizeControlChars } from '../text-safety.js';
import {
  batchedInputRequests,
  batchedVerdicts,
  batchOrder,
  chooseLayout,
  type ApprovalPrompts,
} from './batch.js';
import { legacySuspendError } from './legacy-gate.js';
import {
  clampCaps,
  findTool,
  type ApprovalVerdict,
  type AuditEntry,
  type BlobSealerConfig,
  type LogEntry,
  type PendingToolCall,
  type RedactionHook,
  type ReplayCache,
  type ErrorPhase,
  type ResourceCaps,
  type SegmentOutcome,
  type ServerCatalog,
  type PolicyOptions,
  type StructuredError,
  type ToolExecutor,
  type UpstreamHold,
} from '../types.js';
import { answersFor, forwardQuestions } from './upstream-input.js';
import {
  APPROVAL_SCHEMA,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type ContentBlock,
  type InputRequests,
  type ProtocolEra,
  type RetryEnvelope,
  type ToolCallResult,
  supportsMrtr,
} from './protocol.js';

/**
 * `execute_machine` arguments plus the MRTR retry envelope.
 *
 * **Security (S2):** `requestState` and `inputResponses` are the retry
 * envelope — siblings of `arguments` in a `tools/call` that the SDK lifts off
 * the request params onto the handler context. They are NOT tool arguments.
 * A direct caller of `executeMachine` MUST populate them only from the
 * transport's retry fields, never from model-authored tool arguments: a
 * model that has seen a `requestState` could otherwise echo it back with a
 * fabricated `accept` and approve its own gated call.
 */
export interface ExecuteMachineArgs extends RetryEnvelope {
  /** The authored module source (R2). */
  code: string;
  lang?: 'ts' | 'js';
  /** Passed to the machine as its input. */
  input?: unknown;
}

/**
 * What every gated entry point needs: the catalog and executor of the wrapped
 * server, the blob sealer, and the per-facade policy, redaction, caps,
 * protocol-era and replay settings. `execute_machine` adds the sandbox
 * bridge; `call_tool` needs nothing more (R35, R38).
 */
export interface ApprovalGateDeps extends PolicyOptions {
  catalog: ServerCatalog;
  executor: ToolExecutor;
  blob: BlobSealerConfig;
  /**
   * The key domain of the facade kind serving this gate (R41): `single` for
   * `wrapMcpServer`, `multi` for `wrapMcpServers`. Checked against the
   * catalog, failing closed on a mismatch (`blobKeyDomain`). Omitted, it is
   * derived from the catalog alone.
   */
  blobDomain?: BlobKeyDomain;
  caps?: Partial<ResourceCaps>;
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
  /**
   * Whether the connected client declared the MCP `elicitation` capability.
   * Only consulted on the legacy path with `legacyElicitation` on: the SDK
   * shim cannot deliver an approval to a client without it, and its own
   * failure surfaces as an unstructured error. `undefined` (the caller does
   * not know) leaves the shim to decide.
   */
  clientCanElicit?: boolean;
  /**
   * Whether the connected client declared URL-mode elicitation. A forwarded
   * server question that is a link (G1) is sent in URL mode only then;
   * otherwise the link is shown as inert text in a form.
   */
  clientUrlElicitation?: boolean;
  /** Optional shared replay cache (R38); consulted after verification, before execution. */
  replayCache?: ReplayCache;
  /**
   * How a suspension holding several gated calls is put to the person
   * (`WrapOptions.approvalPrompts`, batch.ts): one elicitation per call
   * (default) or one batched elicitation for all of them. Only machine
   * suspensions can hold several; a `call_tool` suspension holds one.
   */
  approvalPrompts?: ApprovalPrompts;
}

export interface ExecuteMachineDeps extends ApprovalGateDeps {
  /** The `@astral-mcp/tools` bridge module source the sandbox loads (R2). */
  bridgeSource: string;
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

    const resume = args.requestState !== undefined ? await openResume(args, deps, caps) : undefined;

    const outcome = await runSegment({
      code: args.code,
      ...(args.lang !== undefined ? { lang: args.lang } : {}),
      ...(args.input !== undefined ? { input: args.input } : {}),
      catalog: deps.catalog,
      bridgeSource: deps.bridgeSource,
      executor: deps.executor,
      caps,
      ...(deps.policy !== undefined ? { policy: deps.policy } : {}),
      ...(deps.approvals !== undefined ? { approvals: deps.approvals } : {}),
      ...(deps.toolApprovals !== undefined ? { toolApprovals: deps.toolApprovals } : {}),
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
  /** Calls held on their server's question, with the answers to send back (G1). */
  held: Record<string, { hold: UpstreamHold; responses: Record<string, unknown> }>;
}

/**
 * Verify the echoed blob and turn `inputResponses` into verdicts.
 *
 * The blob sealer performs the full R21 check chain (authenticate, version,
 * expiry, codeHash, server identity) and throws on any failure, so nothing
 * gated executes from an unverified blob.
 */
async function openResume(
  args: ExecuteMachineArgs,
  deps: ExecuteMachineDeps,
  caps: ResourceCaps,
): Promise<ResumeState> {
  const payload = openBlob(args.requestState as string, {
    expectedKind: 'machine',
    code: args.code,
    serverIdentity: deps.catalog.identity,
    config: deps.blob,
    domain: blobKeyDomain(deps.catalog, deps.blobDomain),
  });
  await assertNotReplayed(payload, deps.replayCache);

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
      `this workflow reached the limit of ${caps.maxRoundTrips} round trips (approvals and forwarded server questions)`,
      {
        hint: `Restructure the machine to need at most ${caps.maxRoundTrips} round trips, for example by batching writes into fewer states.`,
      },
    );
  }

  // A batched prompt (batch.ts) is answered by the layout SEALED in the
  // blob, never by this instance's option or anything the client sends:
  // one answer, one boolean per call, and only an exact `true` in an
  // accepted answer runs. Forwarded server questions in the same round trip
  // are keyed apart and read below either way.
  const verdicts =
    payload.prompts === 'batched'
      ? batchedVerdicts(args.inputResponses, payload.pending, readReason)
      : perCallVerdicts(args.inputResponses, payload.pending);

  // G1: a held call's answers go back to its server, whatever they are; an
  // unanswered question is a cancel. No answer approves anything.
  const held: ResumeState['held'] = {};
  for (const [id, hold] of Object.entries(payload.upstreamInput ?? {})) {
    held[id] = { hold, responses: answersFor(hold, args.inputResponses) };
  }

  return {
    snapshot: payload.snapshot,
    pending: payload.pending,
    held,
    verdicts,
    // PRD §8: the audit trail spans the whole workflow, so it rides in the
    // blob — the library keeps no state between round trips (R27).
    audit: payload.audit,
    trip: payload.trip,
  };
}

/**
 * One verdict per pending call from per-call prompts, each keyed by its call
 * id. The SDK's discriminated reader covers every non-approval outcome in
 * one place: a missing key, a response of another kind (sampling, roots),
 * and the decline/cancel actions. R17 treats all of them as a decline, so
 * only an accepted elicitation approves the call.
 */
function perCallVerdicts(
  responses: ExecuteMachineArgs['inputResponses'],
  pending: Record<string, PendingToolCall>,
): Record<string, ApprovalVerdict> {
  const verdicts: Record<string, ApprovalVerdict> = {};
  for (const key of Object.keys(pending)) {
    const view = inputResponse(responses, key);
    if (view.kind !== 'elicit' || view.action !== 'accept') {
      const reason = view.kind === 'elicit' ? readReason(view.content) : undefined;
      verdicts[key] = reason !== undefined ? { kind: 'declined', reason } : { kind: 'declined' };
      continue;
    }
    verdicts[key] = { kind: 'approved' };
  }
  return verdicts;
}

const MAX_REASON_CHARS = 500;

/**
 * The optional decline reason from an elicitation's `content`, shared by
 * `execute_machine` and `call_tool`. Client-supplied free text that is shown
 * back to the model (as `TOOL_DENIED.reason` or the `declined` outcome) and
 * recorded in the audit trail, so it is rendered inert and bounded.
 */
export function readReason(content: Record<string, unknown> | undefined): string | undefined {
  const reason = content?.['reason'];
  if (typeof reason !== 'string' || reason.length === 0) return undefined;
  return neutralizeControlChars(capLength(reason, MAX_REASON_CHARS));
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
          ...refusalBlocks(outcome.audit, deps.redact),
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

    case 'error': {
      // A workflow that fails after earlier round trips may already have run
      // approved writes: say so (and what was refused), or the model, seeing
      // only the error, asks the person to approve the same write again.
      const failed = errorResult(outcome.error);
      const extra = approvalOutcomeBlocks(outcome.audit ?? [], deps.redact);
      return extra.length === 0 ? failed : { ...failed, content: [...failed.content, ...extra] };
    }
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
  // executing an unapproved write or hanging (see legacy-gate.ts).
  const onlyQuestions = Object.keys(outcome.pending).length === 0;
  const gate = legacySuspendError(deps, {
    subject: 'this machine',
    readOnlyAdvice: onlyQuestions
      ? 'Author a machine that avoids the tool whose server asks the user questions'
      : 'Author a machine that only calls tools that run without approval',
    ...(onlyQuestions ? { need: "to pass on a question a tool's server asked the user" } : {}),
  });
  if (gate !== undefined) return fail(gate.phase, gate.message, gate.hint);

  // R18: refuse to suspend again once the cap is reached, rather than
  // minting a blob the retry would reject.
  if (outcome.trip > caps.maxRoundTrips) {
    return fail(
      'terminal',
      `this workflow reached the limit of ${caps.maxRoundTrips} round trips (approvals and forwarded server questions)`,
      `Restructure the machine to need at most ${caps.maxRoundTrips} round trips.`,
    );
  }

  const keys = batchOrder(outcome.pending);
  const copies = [];
  let inputRequests: InputRequests = {};
  for (const key of keys) {
    const call = outcome.pending[key] as PendingToolCall;
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
    // On a multi-server facade the copy is built from the box's own entry
    // and names the box (R46).
    const subject = approvalSubject(deps.catalog, entry);
    const copy = buildElicitationCopy(call, subject.entry, {
      ...(subject.box !== undefined ? { box: subject.box } : {}),
      ...(deps.redact !== undefined ? { redact: deps.redact } : {}),
    });
    copies.push(copy);
    // The 2026-07-28 elicitation params dropped `title` (the revision carries
    // `message` and `requestedSchema` only), so the summary line becomes the
    // first line of the message rather than being silently lost.
    inputRequests[key] = inputRequired.elicit({
      message: `${copy.title}\n\n${copy.message}`,
      requestedSchema: APPROVAL_SCHEMA,
    });
  }
  const layout = chooseLayout(deps.approvalPrompts, outcome.pending, copies);
  if (layout === 'batched') inputRequests = batchedInputRequests(copies);

  // G1: forward each held call's server question in the same round trip,
  // keyed apart from the approvals (whose keys are the machine's call ids).
  const upstreamInput: Record<string, UpstreamHold> = {};
  const clientUrl = supportsMrtr(deps.protocolEra) && deps.clientUrlElicitation === true;
  let next = 1;
  for (const held of outcome.held) {
    const target = routeCall(deps.catalog, held.call.name);
    let round: ReturnType<typeof forwardQuestions>;
    try {
      round = forwardQuestions(
        held.call,
        held.decision,
        held.input,
        {
          ...(isBoxedCatalog(deps.catalog) ? { box: target.alias } : {}),
          tool: held.call.name,
          clientUrl,
        },
        { first: next, taken: new Set(Object.keys(inputRequests)) },
      );
    } catch (err) {
      const structured = toStructuredError(err, outcome.logs);
      return errorResult({ ...structured, logs: outcome.logs });
    }
    next += Object.keys(round.inputRequests).length;
    Object.assign(inputRequests, round.inputRequests);
    upstreamInput[held.call.id] = round.hold;
  }

  const payload = buildBlobPayload({
    code: args.code,
    serverIdentity: deps.catalog.identity,
    snapshot: outcome.snapshot,
    pending: outcome.pending,
    audit: outcome.audit,
    ...(layout === 'batched' ? { prompts: 'batched' as const } : {}),
    trip: outcome.trip,
    upstreamInput,
    ...(deps.blob.ttlMs !== undefined ? { ttlMs: deps.blob.ttlMs } : {}),
  });

  let requestState: string;
  try {
    requestState = sealBlob(payload, deps.blob, blobKeyDomain(deps.catalog, deps.blobDomain));
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

/**
 * R38: with a replay cache configured, a verified blob whose nonce was
 * already recorded is a replayed approval and must not execute again.
 */
export async function assertNotReplayed(
  payload: { nonce: string; exp: number },
  cache: ReplayCache | undefined,
): Promise<void> {
  if (cache === undefined) return;
  if (await cache.seen(payload.nonce, payload.exp)) {
    throw new ProjectionError(
      'blob_verification',
      'this approval was already used: the requestState has been replayed',
      { hint: 'Each approval is single-use; start the call again to request a fresh approval.' },
    );
  }
}

/** Every failure is a normal result with `isError: true` and a structured body (R25). */
export function errorResult(error: StructuredError): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(error, null, 2) }],
    structuredContent: { ...error },
  };
}

/**
 * What to do after any refusal, shared by a declined `call_tool` and the
 * refusals restated on a completed machine. "Carry on" alone was read as
 * licence to announce the refused step as done (the `hitl` tier's cancel
 * task), so it names the steps that depend on the refused call.
 */
export const AFTER_REFUSAL =
  'Carry on with any part of the task that does not depend on it, but skip anything that only makes sense if it had run (such as announcing it as done), and say in your final answer what was not done.';

const MAX_REFUSAL_ARGS_CHARS = 300;
const MAX_REFUSALS_LISTED = 20;

/**
 * A completed workflow's refused calls, as a text block after its output.
 * The output is model-authored, so a machine that drops TOOL_DENIED (or
 * returns null) used to hide the refusal: the model read "completed",
 * believed the write ran, and retried it or announced it (the `hitl` eval
 * tier). The audit trail already rides in `structuredContent`, which many
 * hosts never show the model, so the refusals are restated here with the
 * same guidance a declined `call_tool` gets. Tool names come from the
 * catalog the call was resolved against; the arguments are the machine's
 * own (model-authored) and the reason is the approver's note, already
 * neutralized and capped — both rendered as inert JSON.
 */
function refusalBlocks(audit: AuditEntry[], redact?: RedactionHook): ContentBlock[] {
  const refused = audit.filter(
    (e) => e.decision === 'declined' || e.decision === 'denied_by_policy',
  );
  if (refused.length === 0) return [];
  const line = (e: AuditEntry): string => {
    if (e.decision === 'denied_by_policy') {
      return `- ${auditCall(e, redact)}: blocked by this server's policy`;
    }
    return `- ${auditCall(e, redact)}: declined by the user${e.reason !== undefined ? ` with this note: ${JSON.stringify(e.reason)}` : ''}`;
  };
  const listed = refused.slice(0, MAX_REFUSALS_LISTED).map(line);
  if (refused.length > listed.length) {
    listed.push(`- … and ${refused.length - listed.length} more (see the approvals audit)`);
  }
  const noted = refused.some((e) => e.decision === 'declined' && e.reason !== undefined);
  return [
    {
      type: 'text',
      text: [
        `Not executed: ${refused.length === 1 ? 'this call was' : `these ${refused.length} calls were`} refused, so nothing ran for ${refused.length === 1 ? 'it' : 'them'}, whatever the output above says.`,
        ...listed,
        `Each refusal covers only that call: do not make it again or reach its result another way${noted ? ' (if a note asks for a change, make the changed call instead; it asks for approval again)' : ''}. ${AFTER_REFUSAL}`,
      ].join('\n'),
    },
  ];
}

/**
 * For a failed workflow: the approved calls that already ran before the
 * failure (so they are not asked for again) and the refused ones, after the
 * structured error. Nothing when no gated call was decided. Same inert
 * rendering as {@link refusalBlocks}.
 */
function approvalOutcomeBlocks(audit: AuditEntry[], redact?: RedactionHook): ContentBlock[] {
  const ran = audit.filter((e) => e.decision === 'approved');
  const refused = refusalBlocks(audit, redact);
  if (ran.length === 0) return refused;
  const listed = ran.slice(0, MAX_REFUSALS_LISTED).map((e) => `- ${auditCall(e, redact)}`);
  if (ran.length > listed.length) {
    listed.push(`- … and ${ran.length - listed.length} more (see the approvals audit)`);
  }
  return [
    {
      type: 'text',
      text: [
        `Already done before this error: ${ran.length === 1 ? 'this call was' : `these ${ran.length} calls were`} approved and ran. Do not request ${ran.length === 1 ? 'it' : 'them'} again; continue from the state ${ran.length === 1 ? 'it' : 'they'} left.`,
        ...listed,
      ].join('\n'),
    },
    ...refused,
  ];
}

/**
 * `"tool" {args}` for an audit entry, inert and bounded. The audit holds
 * the SEALED arguments, so they go through the integrator's redaction hook
 * first (R16: a copy, under the name the hook knows), failing closed to
 * `[redaction failed]`; then control, C1, line/paragraph-separator and
 * bidi characters are neutralized (S5) and the text is cut on a code-point
 * boundary.
 */
function auditCall(e: AuditEntry, redact: RedactionHook | undefined): string {
  let args: string;
  try {
    const shownArgs = redact !== undefined ? redact(e.tool, structuredClone(e.args)) : e.args;
    args = JSON.stringify(shownArgs) ?? '{}';
  } catch {
    args = '[redaction failed]';
  }
  const safe = neutralizeControlChars(args);
  return `${JSON.stringify(neutralizeControlChars(capLength(e.tool, 200)))} ${cutAtCodePoint(safe, MAX_REFUSAL_ARGS_CHARS)}`;
}

/** `text` cut to at most `max` UTF-16 units without splitting a surrogate pair, `…` when cut. */
export function cutAtCodePoint(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
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
