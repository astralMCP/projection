/**
 * `call_tool` — one wrapped tool under the same gate as a machine step
 * (PRD R35, R36, R38; S2–S6).
 *
 * The degenerate one-call machine, without the machine: validate the
 * request, decide policy, and either execute (auto), refuse (deny), or
 * suspend over MRTR with one elicitation and a sealed `call` blob (ask).
 * The retry re-sends `{ name, args }` plus the echoed `requestState`; after
 * R21 verification an accepted elicitation executes the args recorded in
 * the blob's `pending` entry — never the retry's own (S2). The blob is
 * additionally bound to the canonical request so a stale approved blob
 * cannot be attached to an unrelated `call_tool` request (R36). Policy
 * outranks a stale approval: a `deny` set after the blob was minted wins on
 * the retry, before the blob is even opened (D9).
 *
 * Reuses the machine path's approval copy (R16), redaction hook, blob sealer,
 * MRTR adapter helpers and legacy gate (R28); only the sandbox is bypassed.
 *
 * Statelessness (R27): everything a retry needs rides in `requestState`.
 */

import { buildBlobPayload, DEFAULT_CALL_TTL_MS, openBlob, sealBlob } from '../blob/index.js';
import { ProjectionError, toStructuredError } from '../errors.js';
import {
  assertNotReplayed,
  errorResult,
  readReason,
  type ApprovalGateDeps,
} from '../mrtr/adapter.js';
import { legacySuspendError } from '../mrtr/legacy-gate.js';
import {
  APPROVAL_SCHEMA,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type RetryEnvelope,
  type ToolCallResult,
} from '../mrtr/protocol.js';
import {
  buildElicitationCopy,
  decidePolicy,
  policyContext,
  policyDeniedReason,
} from '../policy/index.js';
import { capLength, neutralizeControlChars } from '../text-safety.js';
import {
  clampCaps,
  findTool,
  isRecord,
  type PendingToolCall,
  type ResourceCaps,
  type ToolCatalogEntry,
} from '../types.js';
import { approvalSubject, blobKeyDomain, routeCall } from './boxes.js';
import { canonicalRequest } from './canonical.js';
import { unknownToolError } from './search.js';
import { sanitizeSchema } from './schema-safety.js';
import { validateArgsShape } from './validate-args.js';

/**
 * `call_tool` arguments plus the MRTR retry envelope.
 *
 * **Security (S2):** `requestState` and `inputResponses` are the retry
 * envelope — siblings of `arguments` in a `tools/call` that the SDK lifts off
 * the request params onto the handler context. They are NOT tool arguments.
 * A direct caller of `callTool` MUST populate them only from the transport's
 * retry fields, never from model-authored tool arguments: a model that has
 * seen a `requestState` could otherwise echo it back with a fabricated
 * `accept` and approve its own write.
 */
export interface CallToolArgs extends RetryEnvelope {
  /** Tool name as listed by `search_tools`. */
  name: string;
  /** Arguments for the tool; absent means `{}`. */
  args?: unknown;
}

/** `call_tool` needs exactly the dependencies every gated tool shares (R35, R38). */
export type CallToolDeps = ApprovalGateDeps;

/** `structuredContent` of a completed `call_tool` (R35.5). */
export type CallToolOutcome =
  | {
      status: 'ok';
      tool: string;
      /**
       * The wrapped tool's result — or, when its JSON exceeded
       * `caps.maxResultBytes`, a string preview of that JSON. The call ran
       * either way; see `truncated`.
       */
      output: unknown;
      /** Present and `true` when `output` is a preview, not the full result. */
      truncated?: true;
      /** Byte length of the full result's JSON, when truncated. */
      outputBytes?: number;
    }
  | { status: 'declined'; tool: string; reason?: string }
  | { status: 'denied_by_policy'; tool: string; reason: string };

/** The single inputRequest / pending key of a `call` blob (R36). */
export const CALL_KEY = 'call';

const MAX_UPSTREAM_MESSAGE_CHARS = 2_000;
/** Characters of a result's JSON kept when it is over `maxResultBytes`. */
const RESULT_PREVIEW_CHARS = 1_000;

/** Run `call_tool` for one `tools/call`, first attempt or MRTR retry. */
export async function callTool(args: CallToolArgs, deps: CallToolDeps): Promise<ToolCallResult> {
  try {
    const caps = clampCaps(deps.caps ?? {});
    // First attempt only: a retry is checked against its blob, not the catalog.
    const named = args.requestState === undefined ? findTool(deps.catalog, args.name) : undefined;
    let toolArgs: Record<string, unknown>;
    try {
      toolArgs = normalizeArgs(args.args, caps);
    } catch (err) {
      if (named === undefined || !isArgsError(err)) throw err;
      return argsErrorResult(
        err,
        named,
        'Pass args as a JSON object (not a JSON string) that matches the input schema below.',
      );
    }

    if (args.requestState !== undefined) {
      return await resume(args, toolArgs, deps, caps);
    }

    const entry = named;
    if (entry === undefined) throw unknownToolError(deps.catalog, args.name, 'call_tool');
    try {
      validateArgsShape(entry.name, toolArgs, entry.inputSchema);
    } catch (err) {
      if (!isArgsError(err)) throw err;
      return argsErrorResult(
        err,
        entry,
        'Fix the arguments to match the input schema below and call again; no describe_tool needed.',
      );
    }
    // The binding text (R36), computed up front so values JSON cannot carry
    // (`undefined`, functions) are refused on every path, not only `ask`.
    const request = canonicalRequest(entry.name, toolArgs);

    switch (decidePolicy(entry, policyContext(deps))) {
      case 'auto':
        return await execute(entry.name, toolArgs, deps, caps);
      case 'deny':
        return denied(entry);
      case 'ask':
        return suspend(entry, toolArgs, request, deps);
    }
  } catch (err) {
    return errorResult(toStructuredError(err));
  }
}

/** A `validate` error about the arguments themselves (not a cap). */
function isArgsError(err: unknown): err is ProjectionError {
  return err instanceof ProjectionError && err.phase === 'validate';
}

/**
 * The `validate` error for arguments that do not fit the tool, with the
 * tool's input schema attached in compact form, so the model can fix the
 * call without a describe_tool turn. The schema goes through the same S5
 * sanitizer and neutralization as describe_tool's; it is a second text
 * block, so it is not JSON-escaped inside the error.
 */
function argsErrorResult(
  err: ProjectionError,
  entry: ToolCatalogEntry,
  hint: string,
): CallToolResult {
  const result = errorResult({ ...err.toStructured(), hint });
  const schema = sanitizeSchema(entry.inputSchema);
  const label = schema.truncated ? 'JSON Schema, truncated to fit the size cap' : 'JSON Schema';
  const text = `Input schema of ${inert(entry.name)} (${label}): ${neutralizeControlChars(JSON.stringify(schema.schema))}`;
  return { ...result, content: [...result.content, { type: 'text', text }] };
}

/** R35.1: `args` is a JSON object within `maxInputBytes`. */
function normalizeArgs(raw: unknown, caps: ResourceCaps): Record<string, unknown> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    throw new ProjectionError('validate', 'call_tool args must be a JSON object', {
      hint: "Pass args as an object keyed by the argument names in the tool's input schema (see describe_tool).",
    });
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(raw);
  } catch (err) {
    throw new ProjectionError('validate', 'call_tool args are not JSON-serializable', {
      hint: 'Remove circular references from args; they must serialize to plain JSON.',
      cause: err,
    });
  }
  const size = Buffer.byteLength(json ?? '', 'utf8');
  if (size > caps.maxInputBytes) {
    throw new ProjectionError(
      'cap_exceeded',
      `call_tool args serialize to ${size} bytes, exceeding the limit of ${caps.maxInputBytes}`,
      { hint: `Shrink the arguments to at most ${caps.maxInputBytes} bytes of JSON.` },
    );
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Suspend (ask) and resume
// ---------------------------------------------------------------------------

function suspend(
  entry: ToolCatalogEntry,
  toolArgs: Record<string, unknown>,
  request: string,
  deps: CallToolDeps,
): ToolCallResult {
  // R28: refuse before minting anything a legacy client could not answer.
  const gate = legacySuspendError(deps, {
    subject: 'this call',
    readOnlyAdvice: 'Call only tools that run without approval',
  });
  if (gate !== undefined) return errorResult(gate.toStructured());

  const pending: PendingToolCall = {
    id: CALL_KEY,
    name: entry.name,
    args: toolArgs,
    stateName: 'call_tool',
  };
  // S6: copy from catalog data and redacted args only. On a multi-server
  // facade it is built from the box's own entry and names the box (R46).
  const subject = approvalSubject(deps.catalog, entry);
  const copy = buildElicitationCopy(pending, subject.entry, {
    origin: 'direct',
    ...(subject.box !== undefined ? { box: subject.box } : {}),
    ...(deps.redact !== undefined ? { redact: deps.redact } : {}),
  });

  const payload = buildBlobPayload({
    kind: 'call',
    // The binding text (R36): what the retry is checked against.
    code: request,
    serverIdentity: deps.catalog.identity,
    snapshot: null,
    pending: { [CALL_KEY]: pending },
    audit: [],
    trip: 1,
    ttlMs: deps.blob.callTtlMs ?? DEFAULT_CALL_TTL_MS,
  });
  const requestState = sealBlob(payload, deps.blob, blobKeyDomain(deps.catalog, deps.blobDomain));

  return inputRequired({
    inputRequests: {
      [CALL_KEY]: inputRequired.elicit({
        message: `${copy.title}\n\n${copy.message}`,
        requestedSchema: APPROVAL_SCHEMA,
      }),
    },
    requestState,
  });
}

/**
 * The retry leg. The retry's own `{ name, args }` is deliberately NOT
 * checked against the catalog before the blob is opened: a stale or tampered
 * pairing must surface as the R36 binding failure ("request mismatch"), not
 * as a `validate` verdict on a request nobody is going to run. What executes
 * is the RECORDED call (S2).
 */
async function resume(
  args: CallToolArgs,
  toolArgs: Record<string, unknown>,
  deps: CallToolDeps,
  caps: ResourceCaps,
): Promise<ToolCallResult> {
  // Policy outranks a stale approval: a `deny` configured after this blob
  // was minted wins, and it wins BEFORE the blob is opened — nothing about
  // the retry is trusted, and no replay nonce is spent, on a call that is
  // blocked anyway. A retry naming a tool the catalog does not declare is
  // left to the binding hash below.
  const policy = policyContext(deps);
  const named = findTool(deps.catalog, args.name);
  if (named !== undefined && decidePolicy(named, policy) === 'deny') return denied(named);

  // R21 + R36: authenticate, version, expiry, kind, binding hash, identity.
  const payload = openBlob(args.requestState as string, {
    expectedKind: 'call',
    code: canonicalRequest(args.name, toolArgs),
    serverIdentity: deps.catalog.identity,
    config: deps.blob,
    domain: blobKeyDomain(deps.catalog, deps.blobDomain),
  });
  await assertNotReplayed(payload, deps.replayCache);

  // The sealer guarantees exactly one entry keyed CALL_KEY for a call blob,
  // and the binding hash that its name is the retry's name.
  const recorded = payload.pending[CALL_KEY] as PendingToolCall;
  // The recorded name is what executes, so it is what policy is decided on.
  // A blob for a tool this catalog does not declare can only have come from
  // another deployment sharing the identity string: refuse it.
  const entry = findTool(deps.catalog, recorded.name);
  if (entry === undefined) throw unknownToolError(deps.catalog, recorded.name, 'call_tool');
  if (decidePolicy(entry, policy) === 'deny') return denied(entry);

  // R17: anything but an accepted elicitation is a decline.
  const view = inputResponse(args.inputResponses, CALL_KEY);
  if (view.kind !== 'elicit' || view.action !== 'accept') {
    const reason = view.kind === 'elicit' ? readReason(view.content) : undefined;
    return outcome({
      status: 'declined',
      tool: recorded.name,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  // S2: the approval authorized the RECORDED args.
  return await execute(recorded.name, recorded.args, deps, caps);
}

// ---------------------------------------------------------------------------
// Execution and result shapes
// ---------------------------------------------------------------------------

async function execute(
  name: string,
  toolArgs: Record<string, unknown>,
  deps: CallToolDeps,
  caps: ResourceCaps,
): Promise<CallToolResult> {
  // A multi-server facade routes the qualified name to its box (R40).
  const target = routeCall(deps.catalog, name);
  const result = await deps.executor.callTool(target.alias, target.name, toolArgs);
  if (!result.ok && result.auth !== undefined) {
    // R25 `auth`: upstream authorization failed (a source given by URL).
    // Library copy throughout; the model cannot fix this by rewriting the call.
    return errorResult({
      phase: 'auth',
      message: result.error.message,
      diagnostics: [],
      hint: result.auth.hint,
      logs: [],
    });
  }
  if (!result.ok) {
    // R25 `upstream`: the wrapped tool failed. Its message is S5 text headed
    // straight for the model — inert and bounded; the hint is library copy.
    return errorResult({
      phase: 'upstream',
      message: neutralizeControlChars(capLength(result.error.message, MAX_UPSTREAM_MESSAGE_CHARS)),
      diagnostics: [],
      hint: 'The wrapped server rejected this call. Check the arguments against describe_tool and try again, or report the error to the user.',
      logs: [],
    });
  }

  // R12 `maxResultBytes`: the same cap a machine's final result is held to,
  // so a wrapped tool cannot flood the model through `call_tool` either. The
  // side effect has already happened, so this stays a normal `ok` result (an
  // error would read as "retry") carrying a bounded preview of the output.
  const json = jsonText(result.result);
  const outputBytes = json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
  if (json === undefined || outputBytes <= caps.maxResultBytes) {
    return outcome({ status: 'ok', tool: name, output: result.result });
  }
  return outcome({
    status: 'ok',
    tool: name,
    output: json.slice(0, RESULT_PREVIEW_CHARS),
    truncated: true,
    outputBytes,
  });
}

/** `JSON.stringify`, or `undefined` for values it cannot serialize (circular, function). */
function jsonText(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function denied(entry: ToolCatalogEntry): CallToolResult {
  return outcome({
    status: 'denied_by_policy',
    tool: entry.name,
    reason: policyDeniedReason(entry.name),
  });
}

function outcome(value: CallToolOutcome): CallToolResult {
  return {
    content: [{ type: 'text', text: renderOutcome(value) }],
    structuredContent: { ...value },
  };
}

function renderOutcome(value: CallToolOutcome): string {
  switch (value.status) {
    case 'ok': {
      // Text-only upstream results arrive as a string (TOOL_RESULT rule);
      // print them raw rather than JSON-in-JSON so the model reads what
      // the wrapped tool returned, not an escaped copy of it. Structured
      // results are pretty-printed. Either way the body is the wrapped
      // server's own text (S5): control and bidi characters are neutralized
      // — newlines kept, they are the result's own lines, and the head
      // above is line 1 regardless — while `structuredContent.output`
      // carries the result verbatim.
      const head = `call_tool ${inert(value.tool)}: ok`;
      const body = neutralizeControlChars(
        typeof value.output === 'string'
          ? value.output
          : (JSON.stringify(value.output, null, 2) ?? 'null'),
        { allowNewline: true },
      );
      if (value.truncated === true) {
        return `${head} (result truncated)\n\n${body}\n\nThe call ran, but its result is ${value.outputBytes} bytes, over this server's result limit; the output above is the first ${RESULT_PREVIEW_CHARS} characters of its JSON. Retrying returns the same preview — work from it, or call the tool with arguments that return less.`;
      }
      return `${head}\n\n${body}`;
    }
    case 'declined':
      return `The user declined ${inert(value.tool)}${value.reason !== undefined ? ` — ${JSON.stringify(value.reason)}` : ''}. Nothing was executed. Do not retry this call unless the user asks for it.`;
    case 'denied_by_policy':
      return `${inert(value.tool)} is blocked by this server's policy. Nothing was executed; the policy is not something you can change.`;
  }
}

function inert(text: string): string {
  return JSON.stringify(neutralizeControlChars(capLength(text, 200)));
}
