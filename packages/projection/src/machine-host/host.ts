/**
 * Machine host — evaluates the authored module in the sandbox, enforces the
 * authoring contract, drives the actor, and turns tool requests into
 * host-side execution or an approval suspension (PRD §7 "Machine host").
 */

import { ProjectionError, toStructuredError } from '../errors.js';
import { createSandboxSession, type SandboxSession } from '../sandbox/index.js';
import { policyDeniedReason, resolveCallPolicy } from '../policy/index.js';
import {
  clampCaps,
  type ApprovalVerdict,
  type AuditEntry,
  type ErrorPhase,
  type HostEvent,
  type LogEntry,
  type PendingToolCall,
  type PolicyOverrides,
  type ResourceCaps,
  type SegmentOutcome,
  type ServerCatalog,
  type ToolExecutor,
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

export interface RunSegmentOptions {
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
  /** Per-tool policy overrides (R14). */
  policy?: PolicyOverrides;
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
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
      audit,
      hookRequests,
      trip: options.resume?.trip ?? 0,
    });

    return await runner.run(options);
  } catch (err) {
    return { status: 'error', error: toStructuredError(err, session?.getLogs() ?? []) };
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
  policy?: PolicyOverrides;
  audit: AuditEntry[];
  hookRequests: RawRequest[];
  trip: number;
}

class SegmentRunner {
  private readonly deps: RunnerDeps;
  private readCalls = 0;
  private eventsProcessed = 0;

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
      drained = await this.send(events);
    }

    // Gated calls accumulate across settle passes so that everything reached
    // before the machine goes quiet lands in ONE suspension (R15).
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
        if (gatedBatch.length > 0) {
          return await this.suspend(gatedBatch);
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
        // Only gated calls remain, so the machine cannot advance further
        // without a human. Snapshot now.
        return await this.suspend(gatedBatch);
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
      const call: PendingToolCall = {
        id: request.id,
        name: request.name,
        args: request.args,
        stateName,
      };
      // Single resolution path shared with the MRTR adapter: catalog lookup,
      // unknown-tool error, and policy decision in one place.
      const resolved = resolveCallPolicy(call, this.deps.catalog, this.deps.policy);
      if (!resolved.ok) throw resolved.error;

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
        gated.push(call);
        continue;
      }

      this.readCalls += 1;
      if (this.readCalls > this.deps.caps.maxReadCallsPerSegment) {
        throw new ProjectionError(
          'cap_exceeded',
          `the machine made more than ${this.deps.caps.maxReadCallsPerSegment} read-only tool calls in one segment`,
          {
            hint: `Batch the work or reduce the number of read-only calls to at most ${this.deps.caps.maxReadCallsPerSegment} per segment.`,
          },
        );
      }
      events.push(await this.execute(request, 'auto'));
    }

    return { events, gated };
  }

  /** Execute one call against the wrapped server and build its event. */
  private async execute(request: RawRequest, decision: 'auto' | 'approved'): Promise<HostEvent> {
    const outcome = await this.deps.executor.callTool(
      this.deps.catalog.alias,
      request.name,
      request.args,
    );
    if (outcome.ok) {
      this.deps.audit.push({
        callId: request.id,
        tool: request.name,
        args: request.args,
        decision,
      });
      return { type: 'TOOL_RESULT', callId: request.id, result: outcome.result };
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
   */
  private async applyVerdicts(
    pending: Record<string, PendingToolCall>,
    verdicts: Record<string, ApprovalVerdict>,
  ): Promise<HostEvent[]> {
    const events: HostEvent[] = [];
    for (const [key, call] of Object.entries(pending)) {
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
      events.push(
        await this.execute({ id: call.id, name: call.name, args: call.args }, 'approved'),
      );
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
      pending[call.id] = call;
    }
    return {
      status: 'suspended',
      pending,
      snapshot,
      trip: this.deps.trip + 1,
      audit: this.deps.audit,
      logs: this.logs(),
    };
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
    return {
      status: 'completed',
      output,
      audit: this.deps.audit,
      logs: this.logs(),
    };
  }

  private logs(): LogEntry[] {
    return this.deps.session.getLogs();
  }
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
