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
  AFTER_REFUSAL,
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
  supportsMrtr,
  type CallToolResult,
  type RetryEnvelope,
  type ToolCallResult,
} from '../mrtr/protocol.js';
import { answersFor, forwardQuestions } from '../mrtr/upstream-input.js';
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
  type UpstreamCallOptions,
  type UpstreamInputRequest,
} from '../types.js';
import { approvalSubject, blobKeyDomain, isBoxedCatalog, routeCall } from './boxes.js';
import { canonicalRequest } from './canonical.js';
import { resultNotes } from './result-notes.js';
import {
  argGlosses,
  callSignature,
  glossLine,
  MAX_HINT_GLOSS_CHARS,
  signatureLine,
} from './signature.js';
import { unknownToolError } from './search.js';
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
  /**
   * Host-side options for the upstream call this request runs, if it runs
   * one: the facade request's cancellation signal and a progress sink.
   * Never populated from tool arguments.
   */
  upstream?: UpstreamCallOptions;
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
      /**
       * The facade's remarks on the result, when it looks partial or the
       * server sent a note beside its structured result (R35.6, D29):
       * single neutralized lines, at most three, printed under the head.
       */
      notes?: string[];
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
    const toolArgs = normalizeArgs(args.args, caps);

    if (args.requestState !== undefined) {
      return await resume(args, toolArgs, deps, caps);
    }

    const entry = findTool(deps.catalog, args.name);
    if (entry === undefined) throw unknownToolError(deps.catalog, args.name, 'call_tool');
    validateArgsShape(entry.name, toolArgs, entry.inputSchema);
    // The binding text (R36), computed up front so values JSON cannot carry
    // (`undefined`, functions) are refused on every path, not only `ask`.
    const request = canonicalRequest(entry.name, toolArgs);

    switch (decidePolicy(entry, policyContext(deps))) {
      case 'auto':
        return await execute(
          { call: callOf(entry.name, toolArgs), decision: 'auto', request, trip: 0 },
          deps,
          caps,
          args.upstream,
        );
      case 'deny':
        return denied(entry);
      case 'ask':
        return suspend(entry, toolArgs, request, deps);
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

  const pending = callOf(entry.name, toolArgs);
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
  // call_tool opens its two kinds: an approval (`call`) and a call waiting
  // on its server's question (`upstream_input`, G1).
  const request = canonicalRequest(args.name, toolArgs);
  const payload = openBlob(args.requestState as string, {
    expectedKind: ['call', 'upstream_input'],
    code: request,
    serverIdentity: deps.catalog.identity,
    config: deps.blob,
    domain: blobKeyDomain(deps.catalog, deps.blobDomain),
  });
  await assertNotReplayed(payload, deps.replayCache);

  if (payload.kind === 'upstream_input') {
    return await resumeQuestion(args, request, payload, deps, caps, policy);
  }

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
  return await execute(
    {
      call: callOf(recorded.name, recorded.args),
      decision: 'approved',
      request,
      trip: payload.trip,
      exp: payload.exp,
    },
    deps,
    caps,
    args.upstream,
  );
}

/**
 * G1: the retry of a call whose server asked the human a question. The call
 * already ran under the gate (read-only, or approved); the answers go back
 * to the server by re-issuing the RECORDED call — never the retry's own
 * args (S2) — with the server's sealed `requestState`. Every answer is
 * passed on, a decline or a cancel included: the server decides what it
 * means. Nothing here approves anything.
 */
async function resumeQuestion(
  args: CallToolArgs,
  request: string,
  payload: ReturnType<typeof openBlob>,
  deps: CallToolDeps,
  caps: ResourceCaps,
  policy: ReturnType<typeof policyContext>,
): Promise<ToolCallResult> {
  // The sealer guarantees exactly one hold keyed CALL_KEY.
  const hold = payload.upstreamInput?.[CALL_KEY];
  if (hold === undefined) throw new ProjectionError('blob_verification', 'malformed hold');
  const entry = findTool(deps.catalog, hold.name);
  if (entry === undefined) throw unknownToolError(deps.catalog, hold.name, 'call_tool');
  // Policy outranks the call's earlier authorization (D9): a tool now
  // `deny` is not re-issued, whatever the human answered; nor is a call that
  // ran without approval and now needs one.
  const decision = decidePolicy(entry, policy);
  if (decision === 'deny') return denied(entry);
  if (decision === 'ask' && hold.decision === 'auto') {
    return errorResult({
      phase: 'blob_verification',
      message: `${inert(hold.name)} now needs approval under this server's policy, so it was not re-issued with the user's answer`,
      diagnostics: [],
      hint: 'Call it again: the user will be asked to approve it first.',
      logs: [],
    });
  }
  const responses = answersFor(hold, args.inputResponses);
  return await execute(
    {
      call: callOf(hold.name, hold.args),
      decision: hold.decision,
      request,
      trip: payload.trip,
      exp: payload.exp,
    },
    deps,
    caps,
    {
      ...args.upstream,
      input: {
        responses,
        ...(hold.requestState !== undefined ? { requestState: hold.requestState } : {}),
      },
    },
  );
}

function callOf(name: string, toolArgs: Record<string, unknown>): PendingToolCall {
  return { id: CALL_KEY, name, args: toolArgs, stateName: 'call_tool' };
}

/** One run of a call that passed the gate. */
interface GatedRun {
  /** The call as recorded: what executes, and what a question's blob holds. */
  call: PendingToolCall;
  /** How the gate authorized it. */
  decision: 'auto' | 'approved';
  /** The R36 canonical request: the binding text of any blob this run mints. */
  request: string;
  /** Round trips taken so far: an approval, then each forwarded question (R18). */
  trip: number;
  /**
   * The `exp` of the blob this run resumed (`call` or `upstream_input`): a
   * question's blob inherits it and is never given a fresh TTL, so an
   * approval lives at most one `callTtlMs` across all its round trips (R38).
   * Absent for a call that ran without a blob (`auto`, first leg).
   */
  exp?: number;
}

// ---------------------------------------------------------------------------
// Execution and result shapes
// ---------------------------------------------------------------------------

async function execute(
  run: GatedRun,
  deps: CallToolDeps,
  caps: ResourceCaps,
  upstream: UpstreamCallOptions | undefined,
): Promise<ToolCallResult> {
  const name = run.call.name;
  // A multi-server facade routes the qualified name to its box (R40).
  const target = routeCall(deps.catalog, name);
  const result = await deps.executor.callTool(target.alias, target.name, run.call.args, upstream);
  if (!result.ok && result.upstreamInput !== undefined) {
    return askQuestion(run, result.upstreamInput, target.alias, deps, caps);
  }
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
      hint:
        result.inputRefused === true ? INPUT_REFUSED_HINT : rejectedHint(deps, name, run.call.args),
      logs: [],
    });
  }

  // R12 `maxResultBytes`: the same cap a machine's final result is held to,
  // so a wrapped tool cannot flood the model through `call_tool` either. The
  // side effect has already happened, so this stays a normal `ok` result (an
  // error would read as "retry") carrying a bounded preview of the output.
  const json = jsonText(result.result);
  // The cap holds the rendered body, not the compact JSON: pretty-printing
  // indents by depth, so a small deeply nested result renders to a very
  // large one (quadratic in its depth).
  const outputBytes =
    json === undefined
      ? 0
      : Math.max(
          Buffer.byteLength(json, 'utf8'),
          renderedSize(result.result, caps.maxResultBytes + 1) +
            (result.rawContent === true ? contentFenceSize(result.result) : 0),
        );
  // R35.6: computed on the full result, so a preview carries them too.
  const notes = resultNotes({
    value: result.result,
    args: run.call.args,
    inputSchema: findTool(deps.catalog, name)?.inputSchema ?? {},
    ...(result.serverNote !== undefined ? { serverNote: result.serverNote } : {}),
  });
  const noted = notes.length > 0 ? { notes } : {};
  if (json === undefined || outputBytes <= caps.maxResultBytes) {
    const value: CallToolOutcome = { status: 'ok', tool: name, output: result.result, ...noted };
    return result.rawContent === true && Array.isArray(result.result)
      ? contentOutcome(value, name, result.result)
      : outcome(value);
  }
  return outcome({
    status: 'ok',
    tool: name,
    output: json.slice(0, RESULT_PREVIEW_CHARS),
    truncated: true,
    outputBytes,
    ...noted,
  });
}

/**
 * The head line of an `ok` result, then the facade's notes on it, one per
 * line (R35.6). They sit in a fixed place the server's body cannot reach:
 * between the head and the blank line that opens the body.
 */
function okHead(tool: string, notes: string[] | undefined, suffix = ''): string {
  return [`call_tool ${inert(tool)}: ok${suffix}`, ...(notes ?? [])].join('\n');
}

/**
 * The interim fix of G1: a server that asked the user for input this box
 * does not pass on is not a bad-arguments failure, and retrying asks again.
 */
const INPUT_REFUSED_HINT =
  'Nothing is wrong with the arguments, and retrying asks again: the tool needs input from the user that this server does not pass on. Tell the user it has to be run another way.';

/**
 * G1: the call ran and its server asked the human a question. Suspend with
 * Projection's own prompt — attributed to the box, never shaped like an
 * approval (S6) — and an `upstream_input` blob holding the recorded call,
 * its authorization and the server's own `requestState` (R27: the resume
 * needs nothing else). The blob is bound to the same canonical request as
 * the call (R36) and to the facade's identity, under the usual envelope.
 */
function askQuestion(
  run: GatedRun,
  input: UpstreamInputRequest,
  alias: string,
  deps: CallToolDeps,
  caps: ResourceCaps,
): ToolCallResult {
  // R28: a 2025-era client cannot carry the question (unless the legacy
  // shim was opted into); fail in Projection's own shape.
  const gate = legacySuspendError(deps, {
    subject: 'this call',
    need: "to pass on a question the tool's server asked the user",
    readOnlyAdvice: 'Run the tool another way',
  });
  if (gate !== undefined) return errorResult(gate.toStructured());
  const trip = run.trip + 1;
  if (trip > caps.maxRoundTrips) {
    return errorResult({
      phase: 'terminal',
      message: `${inert(run.call.name)} asked the user a question, but this call already reached the limit of ${caps.maxRoundTrips} round trips (its approval and the server's questions count)`,
      diagnostics: [],
      hint: 'Tell the user the tool could not finish here and has to be run another way; retrying asks again.',
      logs: [],
    });
  }
  // URL mode only to a 2026-07-28 client that declared it; the legacy shim
  // and form-only clients get the link as inert text in a form.
  const clientUrl = supportsMrtr(deps.protocolEra) && deps.clientUrlElicitation === true;
  const { hold, inputRequests } = forwardQuestions(run.call, run.decision, input, {
    ...(isBoxedCatalog(deps.catalog) ? { box: alias } : {}),
    tool: run.call.name,
    clientUrl,
  });
  const payload = buildBlobPayload({
    kind: 'upstream_input',
    code: run.request,
    serverIdentity: deps.catalog.identity,
    snapshot: null,
    pending: {},
    audit: [],
    trip,
    upstreamInput: { [CALL_KEY]: hold },
    ttlMs: deps.blob.callTtlMs ?? DEFAULT_CALL_TTL_MS,
    // A continuation never outlives the blob it continues (R38).
    ...(run.exp !== undefined ? { notAfter: run.exp } : {}),
  });
  const requestState = sealBlob(payload, deps.blob, blobKeyDomain(deps.catalog, deps.blobDomain));
  return inputRequired({ inputRequests, requestState });
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

/** A content block the facade hands on natively: media and embedded resources. */
type NativeBlock = CallToolResult['content'][number];

/**
 * An `ok` result whose output is the upstream's raw content array (no
 * structured content, not a single text block). The text rendering reads
 * block by block — text as text, an embedded text resource under its URI —
 * instead of a JSON dump, so base64 never lands in the model's text. Image
 * and audio blocks and embedded resources are handed on as native content
 * blocks after the text, for hosts that render them. A `resource_link` is
 * described, not passed on: its URI names the wrapped server's resource,
 * which this facade does not serve. Everything server-authored stays S5
 * text: neutralized, and `structuredContent.output` still carries the
 * array verbatim (R35.5).
 */
function contentOutcome(value: CallToolOutcome, tool: string, blocks: unknown[]): CallToolResult {
  const lines: string[] = [];
  const native: NativeBlock[] = [];
  for (const block of blocks) {
    const rendered = renderBlock(block);
    lines.push(rendered.text);
    if (rendered.native !== undefined) native.push(rendered.native);
  }
  const head = okHead(tool, value.status === 'ok' ? value.notes : undefined);
  const body = lines.join('\n\n');
  return {
    content: [{ type: 'text', text: `${head}\n\n${body}` }, ...native],
    structuredContent: { ...value },
  };
}

/**
 * One content block as inert text (S5). A text block and an embedded text
 * resource are printed verbatim inside a fence, like a text field (D35):
 * printed raw at column 0, a block could forge a facade line such as
 * another call's `call_tool "…": ok` head.
 */
function renderBlock(block: unknown): { text: string; native?: NativeBlock } {
  if (!isRecord(block)) return { text: inertBlock(JSON.stringify(block) ?? 'null') };
  const mime = typeof block['mimeType'] === 'string' ? block['mimeType'] : 'unknown type';
  switch (block['type']) {
    case 'text':
      if (typeof block['text'] === 'string')
        return {
          text: fenced(block['text'], (fence) => `[text, verbatim between the ${fence} lines]`),
        };
      break;
    case 'image':
    case 'audio':
      if (typeof block['data'] === 'string' && typeof block['mimeType'] === 'string') {
        return {
          text: `[${block['type']} ${inert(mime)}, attached as a content block]`,
          native: { type: block['type'], data: block['data'], mimeType: block['mimeType'] },
        };
      }
      break;
    case 'resource': {
      const resource = block['resource'];
      if (!isRecord(resource) || typeof resource['uri'] !== 'string') break;
      const rmime = typeof resource['mimeType'] === 'string' ? resource['mimeType'] : undefined;
      const label = `[embedded resource ${inert(resource['uri'])}${rmime !== undefined ? ` (${inert(rmime)})` : ''}`;
      if (typeof resource['text'] === 'string') {
        const text = resource['text'];
        return {
          text: fenced(text, (fence) => `${label}, text verbatim between the ${fence} lines]`),
        };
      }
      if (typeof resource['blob'] === 'string') {
        return {
          text: `${label}, binary, attached as a content block]`,
          native: {
            type: 'resource',
            resource: {
              uri: resource['uri'],
              blob: resource['blob'],
              ...(rmime !== undefined ? { mimeType: rmime } : {}),
            },
          },
        };
      }
      break;
    }
    case 'resource_link':
      if (typeof block['uri'] === 'string') {
        const named = typeof block['name'] === 'string' ? ` ${inert(block['name'])}` : '';
        return {
          text: `[resource link${named} ${inert(block['uri'])} (${inert(mime)}) — a resource of the wrapped server, not readable through this facade]`,
        };
      }
      break;
  }
  return { text: inertBlock(JSON.stringify(block, null, 2) ?? 'null') };
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
      const head = okHead(
        value.tool,
        value.notes,
        value.truncated === true ? ' (result truncated)' : '',
      );
      const body =
        typeof value.output === 'string' ? inertBlock(value.output) : structuredBody(value.output);
      if (value.truncated === true) {
        return `${head}\n\n${body}\n\nThe call ran, but its result is ${value.outputBytes} bytes, over this server's result limit; the output above is the first ${RESULT_PREVIEW_CHARS} characters of its JSON. Retrying returns the same preview — work from it, or call the tool with arguments that return less.`;
      }
      return `${head}\n\n${body}`;
    }
    case 'declined':
      return declinedText(value.tool, value.reason);
    case 'denied_by_policy':
      return `${inert(value.tool)} is blocked by this server's policy. Nothing was executed; the policy is not something you can change.`;
  }
}

/**
 * An upper estimate, in characters, of {@link structuredBody}'s rendering of
 * `value` (a string result is printed as-is), walked without recursion and
 * abandoned once it reaches `stopAt` — so a hostile deeply nested result is
 * measured, never pretty-printed, and costs at most `stopAt` steps.
 *
 * Every string costs its JSON-escaped length, except where `structuredBody`
 * prints one fenced (D35): a top-level field of a record with at least
 * {@link MIN_TEXT_FIELD_LINES} lines, the first {@link MAX_TEXT_FIELDS} of
 * them. Only those pay for the fence, the header and the marker. Charging
 * every string for a fence counted about 100 characters per short id and
 * truncated ordinary results far under the limit.
 */
export function renderedSize(value: unknown, stopAt: number): number {
  if (typeof value === 'string') return value.length;
  let size = 0;
  const stack: [unknown, number][] = [];
  if (isRecord(value)) {
    // The top-level record: `{`, `}` and their newlines, then its fields in
    // the order `structuredBody` reads them.
    size += 4;
    let texts = 0;
    for (const key of Object.keys(value)) {
      if (size >= stopAt) return size;
      const field = value[key];
      size += escapedLength(key, stopAt) + 2;
      if (typeof field === 'string' && texts < MAX_TEXT_FIELDS && isTextField(field)) {
        texts += 1;
        // The marker on its line in the JSON, then the block: a header
        // naming the fence and quoting the key (cut at 200), the fence
        // above and below, and the text with its lines unchanged or shorter.
        size +=
          4 +
          escapedLength(field, stopAt) +
          3 * fenceFor(field).length +
          escapedLength(key.slice(0, TEXT_FIELD_KEY_CHARS + 1), stopAt) +
          TEXT_FIELD_MARGIN;
      } else {
        stack.push([field, 1]);
      }
    }
  } else {
    stack.push([value, 0]);
  }
  while (stack.length > 0 && size < stopAt) {
    const [item, depth] = stack.pop() as [unknown, number];
    // A line of its own: indent, then the trailing comma and newline.
    size += 2 * depth + 2;
    if (Array.isArray(item)) {
      // The brackets, and the closing one's own indented line.
      size += 2 * depth + 4;
      for (const element of item) stack.push([element, depth + 1]);
    } else if (isRecord(item)) {
      size += 2 * depth + 4;
      for (const [key, field] of Object.entries(item)) {
        size += escapedLength(key, stopAt) + 2;
        stack.push([field, depth + 1]);
      }
    } else if (typeof item === 'string') {
      size += escapedLength(item, stopAt);
    } else {
      // `NaN` and `Infinity` print as `null`.
      size += Math.max(4, String(item).length);
    }
  }
  return size;
}

/** Longest key a text field's header quotes (`capLength` adds the ellipsis). */
const TEXT_FIELD_KEY_CHARS = 200;
/**
 * A text field's fixed copy: the JSON marker (`[string: N lines, shown as
 * text below]`, quoted) and the block's header (`(string, N lines,
 * verbatim between the  lines):`), the line counts, the separators and
 * newlines. About 100 characters; charged generously.
 */
const TEXT_FIELD_MARGIN = 160;

/**
 * An upper bound, in UTF-8 bytes, of `text` as a JSON string, quotes
 * included, counted without building it; once it reaches `stopAt` the rest
 * is not walked. `maxResultBytes` is a byte cap, so a character past ASCII
 * counts its bytes: 3 for any BMP one (a C1 control the neutralizer turns
 * into U+FFFD grows from 2 to 3), 4 for a surrogate pair.
 */
function escapedLength(text: string, stopAt: number): number {
  let length = text.length + 2;
  if (length >= stopAt) return length;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x0c) length += 1;
    else if (code === 0x0a || code === 0x0d || code === 0x09) length += 1;
    else if (code < 0x20) length += 5;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // A pair passes through as 4 bytes; a lone surrogate is escaped as `\udXXX`.
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        length += 2;
      } else length += 5;
    } else if (code >= 0xdc00 && code <= 0xdfff) length += 5;
    else if (code >= 0x80) length += 2;
    if (length >= stopAt) return length;
  }
  return length;
}

/**
 * Whether `structuredBody` would print `text` as a text field: at least
 * {@link MIN_TEXT_FIELD_LINES} lines, where `\r\n`, `\r` and `\n` each
 * end one. Stops counting there.
 */
function isTextField(text: string): boolean {
  let lines = 1;
  for (let i = 0; i < text.length && lines < MIN_TEXT_FIELD_LINES; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a) lines += 1;
    else if (code === 0x0d) {
      lines += 1;
      if (text.charCodeAt(i + 1) === 0x0a) i += 1;
    }
  }
  return lines >= MIN_TEXT_FIELD_LINES;
}

/**
 * What {@link contentOutcome} prints beyond a content array's JSON: the
 * fences and the header of each text block and embedded text resource.
 */
function contentFenceSize(blocks: unknown): number {
  if (!Array.isArray(blocks)) return 0;
  let size = 0;
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const resource = block['resource'];
    const text =
      block['type'] === 'text'
        ? block['text']
        : block['type'] === 'resource' && isRecord(resource)
          ? resource['text']
          : undefined;
    if (typeof text !== 'string') continue;
    // The JSON already holds the text; a C1 control it carries as 2 bytes
    // is printed as U+FFFD, 3 bytes.
    let c1 = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0x80 && code <= 0x9f) c1 += 1;
    }
    size += 3 * fenceFor(text).length + TEXT_FIELD_MARGIN + c1;
  }
  return size;
}

/** A top-level string with at least this many lines is printed as text, not JSON (D29). */
const MIN_TEXT_FIELD_LINES = 3;
/** Most top-level fields printed as text blocks. */
const MAX_TEXT_FIELDS = 5;

/**
 * A structured result as pretty JSON — except that a top-level string of
 * several lines (a file's contents, a document body) is printed below the
 * JSON as its own lines, verbatim between backtick fences under its
 * quoted key, with a marker in its place in the JSON. Marker and
 * header both say "string": a model that read only "N lines" took the
 * field for an array of lines or content blocks (D30). As a JSON
 * string it is one line of `\n` escapes the model has to unescape to read,
 * count or quote. `structuredContent.output` still carries the value
 * verbatim, and the caller neutralizes the whole body (S5).
 */
function structuredBody(output: unknown): string {
  if (!isRecord(output)) return inertBlock(JSON.stringify(output, null, 2) ?? 'null');
  const texts: [string, string[]][] = [];
  const shown: [string, unknown][] = [];
  for (const key of Object.keys(output)) {
    const field = output[key];
    const lines = typeof field === 'string' ? field.replace(/\r\n?/g, '\n').split('\n') : [];
    if (lines.length >= MIN_TEXT_FIELD_LINES && texts.length < MAX_TEXT_FIELDS) {
      texts.push([key, lines]);
      shown.push([key, `[string: ${lines.length} lines, shown as text below]`]);
    } else {
      shown.push([key, field]);
    }
  }
  // `Object.fromEntries` defines each key as an own property: keys are
  // server data, and `__proto__` must stay a key, not a prototype.
  const json = inertBlock(JSON.stringify(Object.fromEntries(shown), null, 2) ?? 'null');
  if (texts.length === 0) return json;
  const blocks = texts.map(([key, lines]) =>
    fenced(
      lines.join('\n'),
      (fence) =>
        `${inertBlock(JSON.stringify(capLength(key, TEXT_FIELD_KEY_CHARS)))} (string, ${lines.length} lines, verbatim between the ${fence} lines):`,
    ),
  );
  return [json, ...blocks].join('\n\n');
}

/** Server text as one inert block: newlines kept, other control and bidi characters neutralized (S5). */
function inertBlock(text: string): string {
  return neutralizeControlChars(text, { allowNewline: true });
}

/**
 * Server text printed verbatim between two backtick fences it cannot close,
 * under a header that names the fence (`header(fence)`, facade copy with
 * any server value in it already inert). Tabs are kept with the newlines —
 * the text is the server's own, and a model writes it back (D35) — and
 * every other control or bidi character is neutralized (S5).
 */
function fenced(text: string, header: (fence: string) => string): string {
  const fence = fenceFor(text);
  const body = neutralizeControlChars(text, { allowNewline: true, allowTab: true });
  return `${header(fence)}\n${fence}\n${body}\n${fence}`;
}

/**
 * A backtick fence longer than any backtick run in `text` (at least three),
 * so the server's text cannot close it early (S5). The block used to be
 * indented instead, and models copied the indent into what they wrote
 * back: Haiku rewrote todo.txt as `    - buy milk` in 4–7 episodes a round
 * (v13–v16b), so a text field is now printed verbatim inside a fence.
 */
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * What the model reads after a decline. The bare "do not retry" this
 * replaced left the next step open, and models filled it by abandoning the
 * whole task — independent writes included — or by asking the user to
 * confirm a change the user had just asked for in the decline note (the
 * `hitl` eval tier). So it says what the refusal covers (this call only),
 * what not to do (repeat it, or reach its result another way), what to do
 * (carry on with the independent rest, act on a note that asks for a
 * change — the changed call asks for approval again) and what to tell the
 * user. The reason is the approver's own text: quoted and inert, as before.
 */
export function declinedText(tool: string, reason: string | undefined): string {
  const head =
    reason !== undefined
      ? `The user declined ${inert(tool)} with this note: ${JSON.stringify(reason)}. Nothing was executed.`
      : `The user declined ${inert(tool)}. Nothing was executed.`;
  const next =
    reason !== undefined
      ? 'The refusal covers only this call. If the note asks for a change, make the changed call instead (it asks for approval again); otherwise do not make this call again or reach its result another way.'
      : 'The refusal covers only this call: do not make it again or reach its result another way.';
  return `${head} ${next} ${AFTER_REFUSAL}`;
}

/**
 * The hint of an `upstream` failure (R25): the server's own validation is
 * the authority on what the shallow R35.1 check let through (nested
 * fields, formats, unknown names the schema does not forbid), so the hint
 * restates the tool's call signature (D32) — one retry instead of a
 * describe_tool turn and a retry when the arguments were the problem.
 * It also glosses the arguments the call sent (D33): a value the server
 * refused is most often one whose meaning the name did not give
 * (`connectionId`, `sha`, `cursor`).
 */
function rejectedHint(deps: CallToolDeps, name: string, args: unknown): string {
  const entry = findTool(deps.catalog, name);
  if (entry === undefined) {
    return 'The wrapped server rejected this call. Check the arguments against describe_tool and try again, or report the error to the user.';
  }
  const takes = signatureLine(callSignature(entry.inputSchema));
  const sent = isRecord(args) ? Object.keys(args) : [];
  const glosses = argGlosses(name, entry.inputSchema, {
    names: sent,
    maxChars: MAX_HINT_GLOSS_CHARS,
  });
  const meaning = glosses.length > 0 ? `, ${glossLine(glosses)}` : '';
  return `The wrapped server rejected this call. If the arguments were wrong: ${inert(name)} takes ${takes}${meaning}. Fix them and try again, or report the error to the user.`;
}

function inert(text: string): string {
  return JSON.stringify(neutralizeControlChars(capLength(text, 200)));
}
