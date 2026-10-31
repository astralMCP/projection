/**
 * Machine host — evaluates the authored module in the sandbox, enforces the
 * authoring contract, drives the actor, and turns tool requests into
 * host-side execution or an approval suspension (PRD §7 "Machine host").
 */

import { ProjectionError, toStructuredError } from '../errors.js';
import { createSandboxSession, type SandboxSession } from '../sandbox/index.js';
import { isBoxedCatalog, routeCall } from '../catalog/boxes.js';
import { assertForwardable, MAX_FORWARDED_QUESTIONS } from '../mrtr/upstream-input.js';
import { didYouMeanHint } from '../catalog/search.js';
import { parseJsonContainer, resultNotes } from '../catalog/result-notes.js';
import { validateArgsShape } from '../catalog/validate-args.js';
import { RESERVED_ID_PREFIX } from '../mrtr/batch.js';
import { capLength, neutralizeControlChars } from '../text-safety.js';
import { policyContext, policyDeniedReason, resolveCallPolicy } from '../policy/index.js';
import {
  clampCaps,
  findTool,
  MAX_SEGMENT_NOTES,
  type ApprovalVerdict,
  type AuditEntry,
  type ErrorPhase,
  type HeldCall,
  type HostEvent,
  type LogEntry,
  type PendingToolCall,
  type PolicyContext,
  type PolicyOptions,
  type ResourceCaps,
  type SegmentOutcome,
  type ServerCatalog,
  type ToolExecutor,
  type UpstreamHold,
  type UpstreamInputRequest,
} from '../types.js';
import { TOOL_CALL_MODULE_SOURCE } from './contract.js';
import {
  bootstrapDriver,
  sendDriver,
  SNAPSHOT_DRIVER,
  TOP_LEVEL_EFFECT_PROBE,
  validationDriver,
} from './drivers.js';

/** A tool request as it comes out of the VM queue. */
interface RawRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface DrainResult {
  status: 'active' | 'done' | 'error' | 'stopped';
  value: unknown;
  output: unknown;
  error: string | null;
  requests: RawRequest[];
}

/** The policy options (R14, R49) are decided at the gate and on resume. */
export interface RunSegmentOptions extends PolicyOptions {
  /** Submitted module source (R2). */
  code: string;
  lang?: 'ts' | 'js';
  /** Machine input, passed as the machine's `input` on a fresh run. */
  input?: unknown;
  /** Catalog of the wrapped server whose tools the machine may call. */
  catalog: ServerCatalog;
  /** Generated `@astral-mcp/tools` bridge source (from typegen). */
  bridgeSource: string;
  /** Executes approved/auto tool calls against the wrapped server. */
  executor: ToolExecutor;
  /** Resource caps; clamped at the hard maxima (R12). */
  caps?: Partial<ResourceCaps>;
  /** Zero-based MRTR segment index — stamps logs (R31). */
  segment?: number;
  /**
   * Resume state. Present on every segment after the first: the verified
   * snapshot and the pending calls sealed alongside it, plus the verdicts
   * the client returned for those calls.
   */
  resume?: {
    snapshot: unknown;
    /** Gated calls as sealed into the blob — the approved name+args (S2). */
    pending: Record<string, PendingToolCall>;
    /** Verdict per pending key; a missing entry counts as declined (R17). */
    verdicts: Record<string, ApprovalVerdict>;
    /** Audit entries accumulated in earlier segments. */
    audit?: AuditEntry[];
    /** Round-trip counter carried in the blob (R18). */
    trip: number;
    /**
     * Calls held on their server's question (G1), keyed by call id, with
     * the server's answers to send back, keyed like the hold's questions'
     * own keys. Re-issued as recorded; no verdict applies to them.
     */
    held?: Record<string, { hold: UpstreamHold; responses: Record<string, unknown> }>;
  };
}

/**
 * Run one execution segment to completion, suspension, or error.
 *
 * A segment is one MRTR round trip: fresh sandbox, fresh wall-clock budget,
 * fresh logs. On the first segment the module is validated (R24) before the
 * actor starts; on a resume the module is re-evaluated from the re-sent code
 * and the actor is restored from the sealed snapshot.
 *
 * Note: `runSegment` interpolates `input` into driver source without a size
 * check of its own — `executeMachine` enforces `maxInputBytes` before calling
 * it. Callers invoking `runSegment` directly must bound `input` themselves.
 */
export async function runSegment(options: RunSegmentOptions): Promise<SegmentOutcome> {
  const caps = clampCaps(options.caps ?? {});
  const segment = options.segment ?? 0;
  const audit: AuditEntry[] = [...(options.resume?.audit ?? [])];

  let session: SandboxSession | undefined;
  // Requests that arrive through the generated bridge's host hook rather
  // than the `toolCall` action. Same gate, collected the same way.
  const hookRequests: RawRequest[] = [];
  let hookSeq = 0;

  try {
    session = await createSandboxSession({
      code: options.code,
      ...(options.lang !== undefined ? { lang: options.lang } : {}),
      caps,
      bridgeSource: `${options.bridgeSource}\n${TOOL_CALL_MODULE_SOURCE}`,
      segment,
      onToolCall: (call) => {
        hookSeq += 1;
        hookRequests.push({ id: `${call.name}@${hookSeq}`, name: call.name, args: call.args });
        // The machine must not consume this as a promise (R7); the result
        // is delivered as an event to the (possibly rehydrated) actor.
        return null;
      },
    });

    // R5: the module is re-evaluated on every resume, so a tool call fired
    // at module top level would repeat on each round trip.
    const probe = (await session.evaluate(TOP_LEVEL_EFFECT_PROBE)) as { queued?: number };
    if ((probe.queued ?? 0) > 0 || hookRequests.length > 0) {
      throw new ProjectionError(
        'validate',
        'the submitted module requests a tool call at top level',
        {
          hint: 'Move tool calls into machine states: the module is re-evaluated on every approval round trip, so top-level effects would repeat. Use toolCall(...) as a state entry action.',
        },
      );
    }

    if (options.resume === undefined) {
      await validate(session, caps, options.input);
    }

    const runner = new SegmentRunner({
      session,
      caps,
      segment,
      catalog: options.catalog,
      executor: options.executor,
      policy: policyContext(options),
      audit,
      hookRequests,
      trip: options.resume?.trip ?? 0,
    });

    return await runner.run(options);
  } catch (err) {
    return {
      status: 'error',
      error: toStructuredError(err, session?.getLogs() ?? []),
      ...(audit.length > 0 ? { audit } : {}),
    };
  } finally {
    await session?.dispose();
  }
}

// ---------------------------------------------------------------------------
// Validation (R24)
// ---------------------------------------------------------------------------

interface ValidationFailure {
  ok: false;
  code: string;
  detail: unknown;
}
type ValidationResult = { ok: true; stateNodes: number } | ValidationFailure;

async function validate(
  session: SandboxSession,
  caps: ResourceCaps,
  input: unknown,
): Promise<void> {
  const result = (await session.evaluate(
    validationDriver(caps.maxStateNodes, input),
  )) as ValidationResult;
  if (result.ok) return;
  throw validationError(result, caps);
}

/** Each validation failure code maps to a phase, a message, and a fix hint. */
interface ValidationSpec {
  phase: ErrorPhase;
  message: (detail: string, caps: ResourceCaps) => string;
  hint: (caps: ResourceCaps) => string;
}

const VALIDATION_SPECS: Record<string, ValidationSpec> = {
  no_default_export: {
    phase: 'validate',
    message: () => 'the submitted module has no default export',
    hint: () =>
      'Default-export a machine: `export default setup({}).createMachine({ ... })`. See discover_apis.',
  },
  xstate_v4_machine: {
    phase: 'validate',
    message: () => 'the default export is an XState v4 machine, not a v5 machine',
    hint: () =>
      'Rewrite for XState v5: `import { setup } from "xstate"` then `setup({}).createMachine({ ... })` — v4 Machine(...) is not supported.',
  },
  default_export_not_machine: {
    phase: 'validate',
    message: (detail) =>
      `the default export is not an XState v5 machine${detail ? ` (got ${detail})` : ''}`,
    hint: () =>
      'Default-export the machine itself, not an actor or a factory: `export default setup({}).createMachine({ ... })`.',
  },
  too_many_state_nodes: {
    phase: 'cap_exceeded',
    message: (detail, caps) =>
      `the machine has ${detail} state nodes, exceeding the limit of ${caps.maxStateNodes}`,
    hint: (caps) =>
      `Simplify the machine to at most ${caps.maxStateNodes} state nodes, or split the work across separate execute_machine calls.`,
  },
  invoke_banned: {
    phase: 'validate',
    message: (detail) =>
      `the machine uses invoke (at ${detail || 'the machine root'}), which is not allowed`,
    hint: () =>
      'Tool calls must use the toolCall action, not fromPromise/invoke: restored snapshots restart invoked actors and would re-execute approved writes. See discover_apis.',
  },
  context_not_serializable: {
    phase: 'validate',
    message: (detail) => `machine context is not JSON-serializable at ${detail}`,
    hint: () =>
      'Keep context to plain JSON values — no Map, Set, Date, class instances, functions or undefined. Store a string or number instead.',
  },
  machine_init_threw: {
    phase: 'validate',
    message: (detail) => `creating the machine actor threw: ${detail}`,
    hint: () =>
      'Fix the error thrown while building the machine context or initial state. If the context factory reads `input`, pass the matching `input` argument to execute_machine (the examples expect `{ path }`).',
  },
};

function validationError(result: ValidationFailure, caps: ResourceCaps): ProjectionError {
  const detail = result.detail === null ? '' : String(result.detail);
  const spec = VALIDATION_SPECS[result.code];
  if (spec === undefined) {
    return new ProjectionError('validate', `machine validation failed: ${result.code}`, {
      hint: 'Review the authoring contract from discover_apis and resubmit.',
    });
  }
  return new ProjectionError(spec.phase, spec.message(detail, caps), { hint: spec.hint(caps) });
}

// ---------------------------------------------------------------------------
// Segment execution
// ---------------------------------------------------------------------------

interface RunnerDeps {
  session: SandboxSession;
  caps: ResourceCaps;
  segment: number;
  catalog: ServerCatalog;
  executor: ToolExecutor;
  /** Resolved once per segment from the options' `policy` and `approvals`. */
  policy: PolicyContext;
  audit: AuditEntry[];
  hookRequests: RawRequest[];
  trip: number;
}

class SegmentRunner {
  private readonly deps: RunnerDeps;
  private readCalls = 0;
  private eventsProcessed = 0;
  /** Calls that ran and are waiting on their server's question (G1). */
  private readonly heldBatch: HeldCall[] = [];
  /** Per tool, this segment's executed calls: how many, how many failed, the first error (D29). */
  private readonly outcomes = new Map<string, { calls: number; failed: number; first?: string }>();
  /** This segment's result notes, tool-prefixed, for the completed output (D29). */
  private readonly notes: string[] = [];
  private notesDropped = 0;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  async run(options: RunSegmentOptions): Promise<SegmentOutcome> {
    const { session } = this.deps;
    const resume = options.resume;

    let drained: DrainResult;
    if (resume === undefined) {
      drained = (await session.evaluate(bootstrapDriver(options.input, undefined))) as DrainResult;
    } else {
      drained = (await session.evaluate(
        bootstrapDriver(undefined, resume.snapshot),
      )) as DrainResult;
      // Deliver verdicts for the calls sealed alongside the snapshot. The
      // args come from the sealed map, never from the restored machine (S2).
      const events = await this.applyVerdicts(resume.pending, resume.verdicts);
      // G1: calls held on their server's question go back with the answers.
      events.push(...(await this.reissueHeld(resume.held ?? {})));
      drained = await this.send(events);
    }

    // Gated calls accumulate across settle passes so that everything reached
    // before the machine goes quiet lands in ONE suspension (R15); so do
    // calls whose server asked the human a question (G1).
    const gatedBatch: PendingToolCall[] = [];

    // Settle: process requests until the machine either finishes, errors,
    // or is waiting on gated calls that need approval.
    for (;;) {
      if (drained.status === 'error') {
        throw new ProjectionError('runtime', `the machine errored: ${drained.error ?? 'unknown'}`, {
          hint: 'Handle the failure in the machine (e.g. a TOOL_ERROR transition) or fix the action that threw.',
        });
      }

      const requests = this.collectRequests(drained);
      if (requests.length === 0) {
        // Nothing more to run: suspend on whatever accumulated, if anything.
        if (gatedBatch.length > 0 || this.heldBatch.length > 0) {
          return await this.suspendOrFinish(gatedBatch, drained);
        }
        if (drained.status === 'done' || drained.status === 'stopped') {
          return this.complete(drained);
        }
        // Quiescent, nothing pending, not final: the machine is waiting for
        // an event that will never arrive.
        throw new ProjectionError(
          'runtime',
          `the machine is stuck in state ${JSON.stringify(drained.value)} with no pending tool call and no final state`,
          {
            hint: 'Every non-final state must either request a tool call or transition on an event the host sends. Reach a final state to return a result.',
          },
        );
      }

      const { events, gated } = await this.classify(requests, drained.value);
      gatedBatch.push(...gated);

      if (events.length === 0) {
        // Only gated (or held) calls remain, so the machine cannot advance
        // further without a human. Snapshot now.
        return await this.suspendOrFinish(gatedBatch, drained);
      }

      // Deliver auto/denied results before snapshotting. This must go
      // through the settle loop rather than a send-and-forget inside
      // `suspend`: `drain()` splices the in-VM request queue, so any call
      // the machine queues in response to these events would be consumed
      // and lost — and an already-approved write could then execute against
      // a workflow that resumes with nowhere to go.
      drained = await this.send(events);
    }
  }

  /** Merge queued `toolCall` requests with any that came via the bridge hook. */
  private collectRequests(drained: DrainResult): RawRequest[] {
    const hook = this.deps.hookRequests.splice(0, this.deps.hookRequests.length);
    return [...drained.requests, ...hook];
  }

  /**
   * Apply the policy to each request: run read-only calls now, deny denied
   * ones now, and set gated ones aside for approval.
   */
  private async classify(
    requests: RawRequest[],
    stateValue: unknown,
  ): Promise<{ events: HostEvent[]; gated: PendingToolCall[] }> {
    const events: HostEvent[] = [];
    const gated: PendingToolCall[] = [];
    const stateName = describeState(stateValue);

    for (const request of requests) {
      // The `projection:` namespace keys Projection's own inputRequests (the
      // batched approval, D25): a call id there could be answered by them.
      if (request.id.startsWith(RESERVED_ID_PREFIX)) {
        throw new ProjectionError(
          'validate',
          `toolCall id ${JSON.stringify(neutralizeControlChars(capLength(request.id, 200)))} uses the reserved prefix "${RESERVED_ID_PREFIX}"`,
          { hint: `Give the toolCall an id that does not start with "${RESERVED_ID_PREFIX}".` },
        );
      }
      const call: PendingToolCall = {
        id: request.id,
        name: request.name,
        args: request.args,
        stateName,
      };
      // Single resolution path shared with the MRTR adapter: catalog lookup,
      // unknown-tool error, and policy decision in one place.
      const resolved = resolveCallPolicy(call, this.deps.catalog, this.deps.policy);
      if (!resolved.ok) throw withSuggestions(resolved.error, this.deps.catalog, request.name);

      if (resolved.decision === 'deny') {
        const reason = policyDeniedReason(request.name);
        events.push({ type: 'TOOL_DENIED', callId: request.id, reason });
        this.deps.audit.push({
          callId: request.id,
          tool: request.name,
          args: request.args,
          decision: 'denied_by_policy',
          reason,
        });
        continue;
      }

      if (resolved.decision === 'ask') {
        // Never ask a person to approve a call that cannot run: arguments
        // that miss a required property, have the wrong top-level type or
        // name one the schema forbids (the same structural check call_tool
        // makes before it suspends, R35.1) fail here as TOOL_ERROR, with the
        // fix in the message, and no prompt is shown. Nothing executes
        // either way; the wrapped server stays the authority on the rest.
        const invalid = invalidArgs(request.name, request.args, resolved.entry.inputSchema);
        if (invalid !== undefined) {
          events.push({
            type: 'TOOL_ERROR',
            callId: request.id,
            error: { message: invalid.message, detail: { phase: 'validate', hint: invalid.hint } },
          });
          this.deps.audit.push({
            callId: request.id,
            tool: request.name,
            args: request.args,
            decision: 'error',
            reason: invalid.message,
          });
          continue;
        }
        gated.push(call);
        continue;
      }

      this.readCalls += 1;
      if (this.readCalls > this.deps.caps.maxReadCallsPerSegment) {
        const max = this.deps.caps.maxReadCallsPerSegment;
        const tally = this.tallyText();
        const stuck = this.allFailed();
        throw new ProjectionError(
          'cap_exceeded',
          `the machine made more than ${max} tool calls that run without approval in one segment${tally}`,
          {
            hint: `Batch the work or reduce the number of calls that run without approval to at most ${max} per segment.${stuck !== undefined ? ` Every call to ${stuck} failed, so repeating it will not get further: fix its arguments (see the first error) before looping.` : ''}`,
          },
        );
      }
      const event = await this.execute({ ...call }, 'auto');
      if (event !== undefined) events.push(event);
    }

    return { events, gated };
  }

  /**
   * Execute one call against the wrapped server and build its event, or
   * hold it (no event) when its server asked the human a question on a box
   * that forwards (G1): the machine keeps waiting for that call's event,
   * and the segment suspends once nothing else can run.
   */
  private async execute(
    call: PendingToolCall,
    decision: 'auto' | 'approved',
    input?: { responses: Record<string, unknown>; requestState?: string },
  ): Promise<HostEvent | undefined> {
    const request: RawRequest = { id: call.id, name: call.name, args: call.args };
    // A multi-server facade routes the qualified name to its box (R40, R45);
    // a single-server catalog sends it to its one alias unchanged.
    const target = routeCall(this.deps.catalog, request.name);
    const outcome = await this.deps.executor.callTool(
      target.alias,
      target.name,
      request.args,
      input !== undefined ? { input } : {},
    );
    if (!outcome.ok && outcome.upstreamInput !== undefined) {
      const refused = this.holdRefusal(call, target.alias, outcome.upstreamInput);
      if (refused === undefined) {
        this.heldBatch.push({ call, decision, input: outcome.upstreamInput });
        return undefined;
      }
      // R64.1, R64.8: a question that cannot be passed on fails this step
      // like a refused one, now, so the machine's own TOOL_ERROR handling runs.
      this.deps.audit.push({
        callId: request.id,
        tool: request.name,
        args: request.args,
        decision: 'error',
        reason: refused,
      });
      return { type: 'TOOL_ERROR', callId: request.id, error: { message: refused } };
    }
    this.tally(request.name, outcome.ok ? undefined : outcome.error.message);
    if (outcome.ok) {
      this.deps.audit.push({
        callId: request.id,
        tool: request.name,
        args: request.args,
        decision,
      });
      const notes = resultNotes({
        value: outcome.result,
        args: request.args,
        inputSchema: findTool(this.deps.catalog, request.name)?.inputSchema ?? {},
        ...(outcome.serverNote !== undefined ? { serverNote: outcome.serverNote } : {}),
      });
      this.noteResult(request.name, notes);
      // D29: a text result that is JSON for an object or an array arrives
      // parsed, so a machine can loop over it; the text stays on `text`.
      const parsed =
        typeof outcome.result === 'string' && outcome.rawContent !== true
          ? parseJsonContainer(outcome.result)
          : undefined;
      return {
        type: 'TOOL_RESULT',
        callId: request.id,
        result: parsed !== undefined ? parsed.value : outcome.result,
        ...(parsed !== undefined ? { text: outcome.result as string } : {}),
        ...(notes.length > 0 ? { notes } : {}),
      };
    }
    this.deps.audit.push({
      callId: request.id,
      tool: request.name,
      args: request.args,
      decision: 'error',
      reason: outcome.error.message,
    });
    return { type: 'TOOL_ERROR', callId: request.id, error: outcome.error };
  }

  /**
   * Turn the client's verdicts into events (R17).
   *
   * The arguments executed are the ones sealed in `pending` — the approval
   * authorized those exact arguments, not whatever the restored machine
   * might ask for now (S2).
   *
   * Policy outranks a stale approval (D9): a tool flipped to `deny` while
   * its blob was outstanding is denied here even if the human approved it —
   * "flip to deny" is the incident-response move, and the integrator's
   * policy must win over an approval minted under the old one.
   */
  private async applyVerdicts(
    pending: Record<string, PendingToolCall>,
    verdicts: Record<string, ApprovalVerdict>,
  ): Promise<HostEvent[]> {
    const events: HostEvent[] = [];
    for (const [key, call] of Object.entries(pending)) {
      const resolved = resolveCallPolicy(call, this.deps.catalog, this.deps.policy);
      // A sealed entry naming a tool this catalog does not declare can only
      // have come from another deployment sharing the identity string (the
      // same reasoning as `catalog/call.ts`): refuse it before anything
      // reaches the executor.
      if (!resolved.ok) throw resolved.error;
      if (resolved.decision === 'deny') {
        const reason = policyDeniedReason(call.name);
        events.push({ type: 'TOOL_DENIED', callId: call.id, reason });
        this.deps.audit.push({
          callId: call.id,
          tool: call.name,
          args: call.args,
          decision: 'denied_by_policy',
          reason,
        });
        continue;
      }
      const verdict = Object.hasOwn(verdicts, key) ? verdicts[key] : undefined;
      // R17: a request missing from inputResponses is treated as declined.
      if (verdict === undefined || verdict.kind === 'declined') {
        const reason = verdict?.kind === 'declined' ? verdict.reason : undefined;
        events.push({
          type: 'TOOL_DENIED',
          callId: call.id,
          ...(reason !== undefined ? { reason } : {}),
        });
        this.deps.audit.push({
          callId: call.id,
          tool: call.name,
          args: call.args,
          decision: 'declined',
          ...(reason !== undefined ? { reason } : {}),
        });
        continue;
      }
      const event = await this.execute(call, 'approved');
      if (event !== undefined) events.push(event);
    }
    return events;
  }

  /**
   * Why a call whose server asked a question cannot be held, or undefined
   * when it can: the question is not forwardable (R64.8), or holding it
   * would put more than {@link MAX_FORWARDED_QUESTIONS} questions in front
   * of the human in one round trip. A second in-flight call with the same
   * id would lose an answer, so it is an authoring error.
   */
  private holdRefusal(
    call: PendingToolCall,
    alias: string,
    input: UpstreamInputRequest,
  ): string | undefined {
    if (this.heldBatch.some((held) => held.call.id === call.id)) {
      throw new ProjectionError(
        'validate',
        `two tool calls in flight share the id ${JSON.stringify(call.id)}`,
        {
          hint: 'Give each toolCall that can be waiting at the same time its own id.',
        },
      );
    }
    const context = {
      ...(isBoxedCatalog(this.deps.catalog) ? { box: alias } : {}),
      tool: call.name,
      clientUrl: false,
    };
    try {
      assertForwardable(input, context);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    const asked = this.heldBatch.reduce(
      (total, held) => total + Object.keys(held.input.requests).length,
      0,
    );
    if (asked + Object.keys(input.requests).length > MAX_FORWARDED_QUESTIONS) {
      return `${JSON.stringify(call.name)} asked the user a question, but this workflow step already has ${asked} waiting, and at most ${MAX_FORWARDED_QUESTIONS} are passed on at once. The call did not complete.`;
    }
    return undefined;
  }

  /**
   * G1: re-issue each held call exactly as recorded, with the human's
   * answers and its server's own state. The call already passed the gate
   * when it first ran; only a policy now `deny` stops it (D9). Its server
   * may ask again, which holds it again.
   */
  private async reissueHeld(
    held: Record<string, { hold: UpstreamHold; responses: Record<string, unknown> }>,
  ): Promise<HostEvent[]> {
    const events: HostEvent[] = [];
    for (const { hold, responses } of Object.values(held)) {
      const call: PendingToolCall = {
        id: hold.id,
        name: hold.name,
        args: hold.args,
        stateName: hold.stateName,
      };
      const resolved = resolveCallPolicy(call, this.deps.catalog, this.deps.policy);
      if (!resolved.ok) throw resolved.error;
      // D9: policy outranks the call's earlier authorization. A call that
      // ran without approval and now needs one is not re-issued either.
      const regated = resolved.decision === 'ask' && hold.decision === 'auto';
      if (resolved.decision === 'deny' || regated) {
        const reason = regated
          ? `${call.name} now needs approval under this server's policy; run it again to ask for it.`
          : policyDeniedReason(call.name);
        events.push({ type: 'TOOL_DENIED', callId: call.id, reason });
        this.deps.audit.push({
          callId: call.id,
          tool: call.name,
          args: call.args,
          decision: 'denied_by_policy',
          reason,
        });
        continue;
      }
      const event = await this.execute(call, hold.decision, {
        responses,
        ...(hold.requestState !== undefined ? { requestState: hold.requestState } : {}),
      });
      if (event !== undefined) events.push(event);
    }
    return events;
  }

  /** Send events into the actor, counting them against the segment cap. */
  private async send(events: HostEvent[]): Promise<DrainResult> {
    this.eventsProcessed += events.length;
    if (this.eventsProcessed > this.deps.caps.maxEventsPerSegment) {
      throw new ProjectionError(
        'cap_exceeded',
        `the machine processed more than ${this.deps.caps.maxEventsPerSegment} events in one segment`,
        {
          hint: `Reduce the number of transitions; at most ${this.deps.caps.maxEventsPerSegment} events run per segment.`,
        },
      );
    }
    return (await this.deps.session.evaluate(sendDriver(events))) as DrainResult;
  }

  /**
   * Suspend on the gated and held calls — unless only held calls remain and
   * the machine already finished (say, a sibling region reached the final
   * state): nobody needs the server's answer then, so the machine completes
   * and the held calls are recorded as unfinished instead of asking.
   */
  private async suspendOrFinish(
    gated: PendingToolCall[],
    drained: DrainResult,
  ): Promise<SegmentOutcome> {
    if (
      gated.length === 0 &&
      this.heldBatch.length > 0 &&
      (drained.status === 'done' || drained.status === 'stopped')
    ) {
      this.abandonHeld();
      return this.complete(drained);
    }
    return await this.suspend(gated);
  }

  /** Audit held calls the finished machine no longer waits on. */
  private abandonHeld(): void {
    for (const { call, decision } of this.heldBatch.splice(0)) {
      this.deps.audit.push({
        callId: call.id,
        tool: call.name,
        args: call.args,
        decision,
        reason: "the workflow finished before the server's question was answered",
      });
    }
  }

  /**
   * Suspend for approval, sealing the exact calls that were requested.
   *
   * Every event the machine could act on has already been delivered by the
   * settle loop, so the in-VM request queue is empty and the snapshot taken
   * here is complete.
   */
  private async suspend(gated: PendingToolCall[]): Promise<SegmentOutcome> {
    const { snapshot } = (await this.deps.session.evaluate(SNAPSHOT_DRIVER)) as {
      snapshot: unknown;
    };
    const pending: Record<string, PendingToolCall> = {};
    for (const call of gated) {
      // Two gated calls under one id would seal as one entry: one approval
      // lost, and both answered by the other's verdict (S2).
      if (Object.hasOwn(pending, call.id)) {
        throw new ProjectionError(
          'validate',
          `two tool calls in flight share the id ${JSON.stringify(neutralizeControlChars(capLength(call.id, 200)))}`,
          {
            hint: "Give each toolCall that can be waiting at the same time its own id; toolCalls(name, list, { id }) uses '<id>#0', '<id>#1', …",
          },
        );
      }
      pending[call.id] = call;
    }
    // A held call and a gated call sharing an id would both answer to it.
    const clash = this.heldBatch.find((held) => Object.hasOwn(pending, held.call.id));
    if (clash !== undefined) {
      throw new ProjectionError(
        'validate',
        `two tool calls in flight share the id ${JSON.stringify(clash.call.id)}`,
        { hint: 'Give each toolCall that can be waiting at the same time its own id.' },
      );
    }
    return {
      status: 'suspended',
      pending,
      held: this.heldBatch,
      snapshot,
      trip: this.deps.trip + 1,
      audit: this.deps.audit,
      logs: this.logs(),
    };
  }

  /** Count one executed call's outcome for the call-cap error (D29). */
  private tally(tool: string, error: string | undefined): void {
    const entry = this.outcomes.get(tool) ?? { calls: 0, failed: 0 };
    entry.calls += 1;
    if (error !== undefined) {
      entry.failed += 1;
      entry.first ??= error;
    }
    this.outcomes.set(tool, entry);
  }

  /**
   * The call-cap error's breakdown (D29): per tool, most-called first, how
   * many calls ran and how many failed, with the first error — the reason
   * a loop never finished is usually a call that fails every time. Tool
   * names are catalog names; the error is the server's text (S5), so it is
   * neutralized, capped and quoted. At most {@link MAX_TALLY_TOOLS} tools.
   */
  private tallyText(): string {
    const rows = [...this.outcomes.entries()].toSorted((a, b) => b[1].calls - a[1].calls);
    if (rows.length === 0) return '';
    const listed = rows.slice(0, MAX_TALLY_TOOLS).map(([tool, { calls, failed, first }]) => {
      const outcome =
        failed === 0
          ? 'all succeeded'
          : `${failed === calls ? 'all' : failed} failed, first error: ${inertText(first ?? '', MAX_TALLY_ERROR_CHARS)}`;
      return `${calls} ${calls === 1 ? 'call' : 'calls'} to ${inertText(tool, 200)} (${outcome})`;
    });
    const more =
      rows.length > listed.length ? `; and ${rows.length - listed.length} more tools` : '';
    return ` — so far: ${listed.join('; ')}${more}`;
  }

  /** The most-called tool when every one of its calls failed (quoted), else undefined. */
  private allFailed(): string | undefined {
    const top = [...this.outcomes.entries()].toSorted((a, b) => b[1].calls - a[1].calls)[0];
    return top !== undefined && top[1].calls > 1 && top[1].failed === top[1].calls
      ? inertText(top[0], 200)
      : undefined;
  }

  /**
   * Keep a result's notes for the completed output, prefixed with the tool
   * (a catalog name, quoted inert) — the machine may drop `event.notes`,
   * and the model reads its output, not the events. Bounded: past
   * {@link MAX_SEGMENT_NOTES}, only a count is kept.
   */
  private noteResult(tool: string, notes: string[]): void {
    for (const note of notes) {
      if (this.notes.length >= MAX_SEGMENT_NOTES) {
        this.notesDropped += 1;
        continue;
      }
      this.notes.push(`${inertText(tool, 200)}: ${note}`);
    }
  }

  private complete(drained: DrainResult): SegmentOutcome {
    const output = drained.output;
    const size = Buffer.byteLength(JSON.stringify(output ?? null), 'utf8');
    if (size > this.deps.caps.maxResultBytes) {
      throw new ProjectionError(
        'cap_exceeded',
        `the final result is ${size} bytes, exceeding the limit of ${this.deps.caps.maxResultBytes}`,
        {
          hint: `Return a summary instead of the full data: the result must be at most ${this.deps.caps.maxResultBytes} bytes.`,
        },
      );
    }
    const notes =
      this.notesDropped > 0
        ? [...this.notes, `… and ${this.notesDropped} more notes like these`]
        : this.notes;
    return {
      status: 'completed',
      output,
      audit: this.deps.audit,
      logs: this.logs(),
      ...(notes.length > 0 ? { notes } : {}),
    };
  }

  private logs(): LogEntry[] {
    return this.deps.session.getLogs();
  }
}

/**
 * On a multi-server view, lead an unknown-tool error's hint with the
 * box-aware did-you-mean suggestions (R40): qualified names, from the named
 * box only when the name's alias is a wrapped box. The single-server error
 * is returned unchanged.
 */
function withSuggestions(
  error: ProjectionError,
  catalog: ServerCatalog,
  name: string,
): ProjectionError {
  if (!isBoxedCatalog(catalog)) return error;
  const didYouMean = didYouMeanHint(catalog, name);
  if (didYouMean.length === 0) return error;
  return new ProjectionError(error.phase, error.message, {
    diagnostics: error.diagnostics,
    hint: `${didYouMean}${error.hint}`,
  });
}

/** Tools listed in the call-cap breakdown. */
const MAX_TALLY_TOOLS = 5;
/** Characters of a tool's first error quoted in the call-cap breakdown. */
const MAX_TALLY_ERROR_CHARS = 200;

/** Untrusted text as one inert, bounded, JSON-quoted line (S5). */
function inertText(text: string, max: number): string {
  return JSON.stringify(neutralizeControlChars(capLength(text, max)));
}

/** Render an XState state value as a readable path for elicitation copy (R16). */
function describeState(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '(unknown)';
  const parts: string[] = [];
  const walk = (node: unknown, prefix: string): void => {
    if (typeof node === 'string') {
      parts.push(prefix.length > 0 ? `${prefix}.${node}` : node);
      return;
    }
    if (typeof node === 'object' && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        walk(child, prefix.length > 0 ? `${prefix}.${key}` : key);
      }
    }
  };
  walk(value, '');
  return parts.length > 0 ? parts.join(' | ') : JSON.stringify(value);
}

/** The structural argument error for a gated call, or undefined when its arguments fit the schema. */
function invalidArgs(
  name: string,
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): { message: string; hint: string } | undefined {
  try {
    validateArgsShape(name, args, schema, 'toolCall');
    return undefined;
  } catch (err) {
    if (err instanceof ProjectionError) return { message: err.message, hint: err.hint ?? '' };
    throw err;
  }
}
