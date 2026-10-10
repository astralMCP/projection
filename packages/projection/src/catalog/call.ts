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
 * cannot be attached to an unrelated `call_tool` request (R36).
 *
 * Reuses the machine path's approval copy (R16), redaction hook, blob sealer,
 * MRTR adapter helpers and legacy gate (R28); only the sandbox is bypassed.
 *
 * Statelessness (R27): everything a retry needs rides in `requestState`.
 */

import { buildBlobPayload, openBlob, sealBlob } from '../blob/index.js';
import { ProjectionError, toStructuredError } from '../errors.js';
import { assertNotReplayed, errorResult } from '../mrtr/adapter.js';
import { legacySuspendError } from '../mrtr/legacy-gate.js';
import {
  APPROVAL_SCHEMA,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type ProtocolEra,
  type RetryEnvelope,
  type ToolCallResult,
} from '../mrtr/protocol.js';
import { buildElicitationCopy, decidePolicy, policyDeniedReason } from '../policy/index.js';
import { capLength, neutralizeControlChars } from '../text-safety.js';
import {
  clampCaps,
  findTool,
  isRecord,
  type BlobSealerConfig,
  type PendingToolCall,
  type PolicyOverrides,
  type RedactionHook,
  type ReplayCache,
  type ResourceCaps,
  type ServerCatalog,
  type ToolExecutor,
} from '../types.js';
import { canonicalRequest } from './canonical.js';
import { validateArgsShape } from './validate-args.js';

export interface CallToolArgs extends RetryEnvelope {
  /** Tool name as listed by `search_tools`. */
  name: string;
  /** Arguments for the tool; absent means `{}`. */
  args?: unknown;
}

export interface CallToolDeps {
  catalog: ServerCatalog;
  executor: ToolExecutor;
  blob: BlobSealerConfig;
  caps?: Partial<ResourceCaps>;
  policy?: PolicyOverrides;
  redact?: RedactionHook;
  /** Protocol era this request is served on (R28). `undefined` is legacy. */
  protocolEra?: ProtocolEra;
  /** Opt-in legacy-client compatibility (R28 amendment, D6). */
  legacyElicitation?: boolean;
  /** Whether the client declared the `elicitation` capability (legacy only). */
  clientCanElicit?: boolean;
  /** Optional shared replay cache (R38). */
  replayCache?: ReplayCache;
}

/** `structuredContent` of a completed `call_tool` (R35.5). */
export type CallToolOutcome =
  | { status: 'ok'; tool: string; output: unknown }
  | { status: 'declined'; tool: string; reason?: string }
  | { status: 'denied_by_policy'; tool: string; reason: string };

/** The single inputRequest / pending key of a `call` blob (R36). */
export const CALL_KEY = 'call';
/** Default TTL for `call` blobs (R38): shorter than machine blobs, see D9. */
export const DEFAULT_CALL_TTL_MS = 5 * 60 * 1000;

const MAX_REASON_CHARS = 500;
const MAX_UPSTREAM_MESSAGE_CHARS = 2_000;

/** Run `call_tool` for one `tools/call`, first attempt or MRTR retry. */
export async function callTool(args: CallToolArgs, deps: CallToolDeps): Promise<ToolCallResult> {
  try {
    const caps = clampCaps(deps.caps ?? {});
    const toolArgs = normalizeArgs(args.args, caps);
    const entry = findTool(deps.catalog, args.name);
    if (entry === undefined) {
      throw new ProjectionError(
        'validate',
        `Unknown tool ${inert(args.name)}: the wrapped server does not declare it`,
        {
          hint: 'Call search_tools to list the tools this server declares, then call_tool with one of those names exactly.',
        },
      );
    }
    validateArgsShape(entry.name, toolArgs, entry.inputSchema);
    // The binding text (R36): also what the retry is checked against.
    const request = canonicalRequest(entry.name, toolArgs);

    if (args.requestState !== undefined) {
      return await resume(args, request, deps);
    }

    switch (decidePolicy(entry, deps.policy)) {
      case 'auto':
        return await execute(entry.name, toolArgs, deps);
      case 'deny':
        return outcome({
          status: 'denied_by_policy',
          tool: entry.name,
          reason: policyDeniedReason(entry.name),
        });
      case 'ask':
        return suspend(entry.name, toolArgs, request, deps);
    }
  } catch (err) {
    return errorResult(toStructuredError(err));
  }
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
  name: string,
  toolArgs: Record<string, unknown>,
  request: string,
  deps: CallToolDeps,
): ToolCallResult {
  // R28: refuse before minting anything a legacy client could not answer.
  const gate = legacySuspendError(deps, {
    subject: 'this call',
    readOnlyAdvice: 'Call only read-only tools',
  });
  if (gate !== undefined) return errorResult(gate.toStructured());

  const entry = findTool(deps.catalog, name);
  // Unreachable: the caller resolved the entry. Kept total for S2's sake.
  if (entry === undefined) {
    return errorResult(
      new ProjectionError('validate', `Unknown tool ${inert(name)}`, {
        hint: 'Call search_tools first.',
      }).toStructured(),
    );
  }

  const pending: PendingToolCall = { id: CALL_KEY, name, args: toolArgs, stateName: 'call_tool' };
  // S6: copy from catalog data and redacted args only.
  const copy = buildElicitationCopy(pending, entry, {
    origin: 'direct',
    ...(deps.redact !== undefined ? { redact: deps.redact } : {}),
  });

  const payload = buildBlobPayload({
    kind: 'call',
    code: request,
    serverIdentity: deps.catalog.identity,
    snapshot: null,
    pending: { [CALL_KEY]: pending },
    audit: [],
    trip: 1,
    ttlMs: deps.blob.callTtlMs ?? DEFAULT_CALL_TTL_MS,
  });
  const requestState = sealBlob(payload, deps.blob);

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

async function resume(
  args: CallToolArgs,
  request: string,
  deps: CallToolDeps,
): Promise<ToolCallResult> {
  // R21 + R36: authenticate, version, expiry, kind, binding hash, identity.
  const payload = openBlob(args.requestState as string, {
    expectedKind: 'call',
    code: request,
    serverIdentity: deps.catalog.identity,
    config: deps.blob,
  });
  await assertNotReplayed(payload, deps.replayCache);

  // The sealer guarantees exactly one entry keyed CALL_KEY for a call blob.
  const recorded = payload.pending[CALL_KEY] as PendingToolCall;

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
  return await execute(recorded.name, recorded.args, deps);
}

function readReason(content: Record<string, unknown> | undefined): string | undefined {
  const reason = content?.['reason'];
  if (typeof reason !== 'string' || reason.length === 0) return undefined;
  // Client-supplied free text shown back to the model: inert and bounded.
  return neutralizeControlChars(capLength(reason, MAX_REASON_CHARS));
}

// ---------------------------------------------------------------------------
// Execution and result shapes
// ---------------------------------------------------------------------------

async function execute(
  name: string,
  toolArgs: Record<string, unknown>,
  deps: CallToolDeps,
): Promise<CallToolResult> {
  const result = await deps.executor.callTool(deps.catalog.alias, name, toolArgs);
  if (result.ok) return outcome({ status: 'ok', tool: name, output: result.result });
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

function outcome(value: CallToolOutcome): CallToolResult {
  return {
    content: [{ type: 'text', text: renderOutcome(value) }],
    structuredContent: { ...value },
  };
}

function renderOutcome(value: CallToolOutcome): string {
  switch (value.status) {
    case 'ok':
      return JSON.stringify(value, null, 2);
    case 'declined':
      return `The user declined ${inert(value.tool)}${value.reason !== undefined ? ` — ${JSON.stringify(value.reason)}` : ''}. Nothing was executed. Do not retry this call unless the user asks for it.`;
    case 'denied_by_policy':
      return `${inert(value.tool)} is blocked by this server's policy. Nothing was executed; the policy is not something you can change.`;
  }
}

function inert(text: string): string {
  return JSON.stringify(neutralizeControlChars(capLength(text, 200)));
}
