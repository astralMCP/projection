/**
 * Program host (EXPERIMENTAL, DECISIONS D48) — runs an LLM-authored plain
 * JavaScript program on psychoscript, a confined interpreter whose runs
 * suspend to bytes and resume, and maps it onto the same
 * {@link SegmentOutcome} contract as the XState machine host, so the MRTR
 * adapter (sealing, approvals, batching, audit) is shared unchanged.
 *
 * A program reaches tools only through the `tools` namespace
 * (`await tools.read_file({ path })`, `tools.<box>.<tool>(args)` on a
 * multi-server facade). Every tool function is a psychoscript durable host
 * function: `start` records the call and decides its policy, `wait` runs it.
 *
 * - "runs immediately" calls execute in `wait` and resolve with the result.
 * - "asks for approval" calls block in `wait`. Once the interpreter has
 *   nothing left to run but those blocked calls (see {@link parkListeners}),
 *   the run is suspended and its state sealed into the blob with the pending
 *   calls; every gated call outstanding at that moment goes to the human in
 *   one round trip (R15).
 * - On resume, a pending call's `wait` runs again and applies its verdict:
 *   approved runs the SEALED arguments (S2) once; declined throws a
 *   `ToolDenied` error into the program.
 * - A gated call the program started but never awaited, when the run ends
 *   without needing it, is not run and nobody is asked; the result says so.
 *
 * Suspension is only attempted while no tool call is executing, so no
 * executed call is ever interrupted and run again on resume. Every outcome
 * is built only after every call still executing has settled, so the audit
 * lists every call that ran (R15b).
 *
 * Known gaps (D48): psychoscript runs on this thread, with no memory limit;
 * a native regular-expression match or a large `Buffer.alloc` is not bounded
 * by the per-segment wall clock. The QuickJS runtime's caps (D15) do not
 * apply here.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Host, Runtime, fromBytes, parseProgram, toBytes, type Json } from 'psychoscript';

type Result = Runtime.Result;
import { DEFAULT_MAX_BLOB_BYTES } from '../blob/sealer.js';
import { PSYCHOSCRIPT_VERSION } from '../blob/versions.js';
import { isBoxedCatalog, routeCall } from '../catalog/boxes.js';
import { parseJsonContainer, resultNotes } from '../catalog/result-notes.js';
import { didYouMeanHint } from '../catalog/search.js';
import { validateArgsShape } from '../catalog/validate-args.js';
import { ProjectionError, toStructuredError } from '../errors.js';
import { RESERVED_ID_PREFIX } from '../mrtr/batch.js';
import { policyContext, policyDeniedReason, resolveCallPolicy } from '../policy/index.js';
import { LogCollector } from '../sandbox/logs.js';
import { capLength, neutralizeControlChars } from '../text-safety.js';
import {
  clampCaps,
  findTool,
  isRecord,
  MAX_SEGMENT_NOTES,
  type AuditEntry,
  type LogEntry,
  type LogLevel,
  type PendingToolCall,
  type PolicyContext,
  type ResourceCaps,
  type SegmentOutcome,
  type ServerCatalog,
} from '../types.js';
import type { RunSegmentOptions } from '../machine-host/host.js';

/** The `stateName` a program's calls carry into elicitation copy (R16). */
export const PROGRAM_STEP = 'program';

/** The `runId` every program run uses: call keys are `p:<n>`, stable across resumes. */
const RUN_ID = 'p';

/**
 * How many raw snapshot bytes a suspend may produce per byte of the blob
 * ceiling. The snapshot is base64'd (4/3) into the payload, which is then
 * deflated: the VM's JSON state compresses several-fold, so this is generous.
 * It exists to refuse a hoarding program before its state is encoded and
 * sealed, not to predict the sealed size: the sealer still enforces the
 * ceiling exactly.
 */
const SNAPSHOT_BYTES_PER_BLOB_BYTE = 8;

/**
 * psychoscript's own timeout (`limits.timeoutMs`) is the per-segment wall
 * clock: it ends the run with a result that keeps the console output. This
 * abort timer is a backstop past it, should that result never come.
 */
const BACKSTOP_GRACE_MS = 2_000;

/** Unhandled-rejection warnings (and the like) turned into notes, at most. */
const MAX_WARNING_NOTES = 3;

/** Gated calls a note names by id when the run ended without awaiting them. */
const MAX_UNAWAITED_LISTED = 10;

/**
 * The idle signal (item: when to suspend). A run may be suspended for
 * approval only when the interpreter has nothing left to run but calls
 * waiting on the host — otherwise gated calls the program is about to start
 * would miss this round trip. A timer is not that signal: psychoscript
 * slices long computations and continues each slice on `setImmediate`, so
 * any "nothing happened for a macrotask" test fires mid-computation.
 *
 * psychoscript 0.3.0 has exactly the signal, but only as a test hook:
 * `parking.onPark` in `dist/runtime/driver.js`, called synchronously each
 * time a run's driver has no runnable job, no queued host call, and parks to
 * wait for one in flight. The package's `exports` map does not expose that
 * module, so it is loaded by file URL next to the resolved entry (the same
 * module instance psychoscript itself uses), and the version is pinned
 * exactly. The hook is process-wide and takes no arguments; the driver calls
 * it inside the async context of `program.run()`, so an AsyncLocalStorage
 * entered around each segment's `run()` tells which segment parked. A
 * missing hook (a psychoscript upgrade that moved it) fails every run with a
 * clear error instead of silently splitting batches.
 */
const parkListeners = new AsyncLocalStorage<() => void>();
let parkHook: Promise<void> | undefined;

function installParkHook(): Promise<void> {
  parkHook ??= (async () => {
    const entry = createRequire(import.meta.url).resolve('psychoscript');
    const url = pathToFileURL(join(dirname(entry), 'runtime', 'driver.js')).href;
    const driver = (await import(url)) as { parking?: { onPark?: () => void } };
    const parking = driver.parking;
    if (typeof parking !== 'object' || parking === null) {
      throw new ProjectionError(
        'runtime',
        `psychoscript ${PSYCHOSCRIPT_VERSION}'s idle signal (parking.onPark) was not found, so programs cannot be suspended for approval safely`,
        { hint: 'This is a Projection installation problem: reinstall the pinned psychoscript.' },
      );
    }
    const previous = parking.onPark;
    parking.onPark = () => {
      previous?.();
      parkListeners.getStore()?.();
    };
  })();
  return parkHook;
}

/** What a tool call's durable `start` records, kept as JSON in the snapshot. */
interface CallData {
  [key: string]: Json;
  id: string;
  name: string;
  /** Plain JSON: arguments cross into the host as copies of program data. */
  args: { [key: string]: Json };
  /** `auto` runs now; `ask` waits for a verdict; `deny` and `invalid` fail in `wait`. */
  kind: 'auto' | 'ask' | 'deny' | 'invalid';
  /** Why a `deny` or `invalid` call fails. */
  reason: string;
}

/**
 * Run one segment of a program: fresh runtime, fresh wall-clock budget,
 * fresh logs. The first segment compiles the program and runs it with
 * `input`; a resume restores the run from the sealed snapshot.
 */
export async function runProgramSegment(options: RunSegmentOptions): Promise<SegmentOutcome> {
  const caps = clampCaps(options.caps ?? {});
  const audit: AuditEntry[] = [...(options.resume?.audit ?? [])];
  const segment = new ProgramSegment(options, caps, audit);
  try {
    return await segment.run();
  } catch (err) {
    // The run is stopped; calls still executing land in the audit first.
    await segment.settle();
    return {
      status: 'error',
      error: toStructuredError(err, segment.logs()),
      ...(audit.length > 0 ? { audit } : {}),
    };
  }
}

class ProgramSegment {
  private readonly options: RunSegmentOptions;
  private readonly caps: ResourceCaps;
  private readonly audit: AuditEntry[];
  private readonly policy: PolicyContext;
  private readonly segmentIndex: number;
  private readonly controller = new AbortController();
  /** Calls that started in this segment, so `wait` never runs one it did not start. */
  private readonly startedHere = new Set<string>();
  /** Gated calls started in this segment (none has a verdict yet), in the order they asked. */
  private readonly asked = new Map<string, string>();
  /** Gated calls blocked on a verdict right now, in the order they asked. */
  private readonly waiting = new Map<string, PendingToolCall>();
  /** Executions against the wrapped server still running, awaited before any outcome. */
  private readonly inflight = new Set<Promise<unknown>>();
  /** Tool calls executing against the wrapped server right now. */
  private executing = 0;
  /** `wait` calls not yet settled, the blocked gated ones included. */
  private unsettled = 0;
  private readCalls = 0;
  /** A failure that ends the whole workflow (unknown tool, a cap): the run is aborted with it. */
  private fatal: ProjectionError | undefined;
  /** Set once this segment is over: later calls are refused, never run. */
  private ended = false;
  private readonly notes: string[] = [];
  private notesDropped = 0;
  private captured: LogEntry[] = [];
  /** Console lines earlier segments produced: psychoscript keeps a run's lines across resumes. */
  private priorLines = 0;
  private running: Promise<unknown> | undefined;
  // The idle signal: parked since the last progress, and the resolver of the current quiet wait.
  private parked = false;
  private progress = 0;
  private onQuiet: (() => void) | undefined;

  constructor(options: RunSegmentOptions, caps: ResourceCaps, audit: AuditEntry[]) {
    this.options = options;
    this.caps = caps;
    this.audit = audit;
    this.policy = policyContext(options);
    this.segmentIndex = options.segment ?? 0;
  }

  logs(): LogEntry[] {
    return this.captured;
  }

  async run(): Promise<SegmentOutcome> {
    await installParkHook();
    const wallClock = this.caps.segmentWallClockMs;
    const runtime = Runtime.make({
      globals: () => ({ tools: this.toolsNamespace() }),
      // No maxOutputBytes: psychoscript would cut the console lines of every
      // segment so far as one budget. The result is checked against
      // maxResultBytes below, and this segment's lines against maxConsoleBytes.
      limits: { timeoutMs: wallClock },
    });

    const resume = this.options.resume;
    let program: ReturnType<typeof runtime.program>;
    if (resume === undefined) {
      const source = await programSource(this.options.code, this.options.lang);
      const parsed = parseProgram(source);
      if (!parsed.ok) throw compileError(parsed.error);
      program = runtime.program(source, {
        runId: RUN_ID,
        bindings: { input: (this.options.input ?? null) as Json },
      });
    } else {
      const state = resumeState(resume.snapshot, wallClock);
      this.priorLines = snapshotLogLines(state)?.length ?? 0;
      program = runtime.resume(state as Parameters<typeof runtime.resume>[0]);
    }

    const backstop = setTimeout(() => this.controller.abort(), wallClock + BACKSTOP_GRACE_MS);
    try {
      // `run()` re-enters the pending calls' `wait` synchronously on a
      // resume, so everything `wait` reads is set up before this line.
      const running = parkListeners.run(
        () => this.onPark(),
        () => program.run({ signal: this.controller.signal }),
      );
      this.running = running;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- each wait follows the previous suspend attempt
        const first = await Promise.race([running, this.untilQuiet()]).catch((err: unknown) => {
          if (isAbort(err)) return 'aborted' as const;
          throw err;
        });
        if (first === 'aborted') throw this.abortError();
        if (first !== 'quiet') {
          if (first.ok === 'suspended') {
            throw new ProjectionError('runtime', 'the program was suspended unexpectedly', {});
          }
          // eslint-disable-next-line no-await-in-loop -- once, before the outcome
          await this.drain();
          return this.finish(first);
        }
        if (this.fatal !== undefined) throw this.fatal;
        // eslint-disable-next-line no-await-in-loop -- one suspend attempt per quiet moment
        const outcome = await program
          .suspend({ maxBytes: this.maxSnapshotBytes() })
          .catch((err: unknown) => err);
        if (outcome instanceof Runtime.SuspendError) {
          // A host call that cannot be suspended is running: try again at
          // the next quiet moment. Otherwise the state cannot be saved.
          if (outcome.running.length > 0) continue;
          throw this.cannotSuspend(outcome);
        }
        if (!isOutcome(outcome)) throw outcome;
        if (outcome.ok !== 'suspended') {
          // eslint-disable-next-line no-await-in-loop -- once, before the outcome
          await this.drain();
          return this.finish(outcome);
        }
        return this.suspended(outcome.state);
      }
    } finally {
      clearTimeout(backstop);
      this.ended = true;
      this.onQuiet = undefined;
      this.controller.abort();
    }
  }

  /** After a failure: let the stopped run end, then wait for every call still executing. */
  async settle(): Promise<void> {
    this.ended = true;
    this.controller.abort();
    await this.running?.catch(() => undefined);
    await this.drain();
  }

  /** Wait until no call is executing (R15b): an outcome lists every call that ran. */
  private async drain(): Promise<void> {
    while (this.inflight.size > 0) {
      // eslint-disable-next-line no-await-in-loop -- a settling call may not start another, but be sure
      await Promise.allSettled(this.inflight);
    }
  }

  /** The error an aborted run reports: the fatal failure that aborted it, else the wall clock. */
  private abortError(): ProjectionError {
    return this.fatal ?? this.wallClockError();
  }

  private wallClockError(diagnostics: { message: string }[] = []): ProjectionError {
    const ms = this.caps.segmentWallClockMs;
    return new ProjectionError(
      'cap_exceeded',
      `the program ran longer than ${ms} ms in one segment`,
      {
        diagnostics,
        hint: `Each segment (the run up to an approval, or after it) may take at most ${ms} ms. Look for a loop that never ends, or do less work per run.`,
      },
    );
  }

  private maxSnapshotBytes(): number {
    return (this.options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES) * SNAPSHOT_BYTES_PER_BLOB_BYTE;
  }

  private cannotSuspend(error: Error): ProjectionError {
    if (/limit/u.test(error.message)) {
      return new ProjectionError(
        'cap_exceeded',
        `the program's state is too large to suspend for an approval (more than ${this.maxSnapshotBytes()} bytes)`,
        {
          hint: 'Keep less data in variables across an approval: store or summarize large values before the gated call, and read them again after it.',
        },
      );
    }
    return new ProjectionError(
      'runtime',
      `the program's state could not be saved for an approval: ${inertText(error.message, 500)}`,
      {
        hint: 'Keep only plain data (objects, arrays, strings, numbers) in variables across an approval.',
      },
    );
  }

  /** End the run with a failure the program cannot catch. */
  private failRun(error: ProjectionError): never {
    this.fatal ??= error;
    this.controller.abort();
    throw error;
  }

  /** Why a new call is refused outright: the run already failed, or the segment is over. */
  private refusal(): Error | undefined {
    if (this.fatal !== undefined) return this.fatal;
    if (this.ended) return programError('ToolError', 'the run has ended; the call was not run', {});
    return undefined;
  }

  // -------------------------------------------------------------------------
  // The idle signal
  // -------------------------------------------------------------------------

  /** psychoscript's driver parked this run: nothing runs until a host call settles. */
  private onPark(): void {
    this.parked = true;
    this.checkQuiet();
  }

  /** A host call settled (or one is about to run): the interpreter has work again. */
  private progressed(): void {
    this.parked = false;
    this.progress += 1;
  }

  private untilQuiet(): Promise<'quiet'> {
    return new Promise((resolve) => {
      this.onQuiet = () => resolve('quiet');
      this.checkQuiet();
    });
  }

  /**
   * Quiet: parked, some gated call waiting, and every unsettled `wait` is a
   * blocked gated call (nothing executing, no denial still to deliver).
   * Checked a macrotask later, after the microtasks that report settled
   * calls, and only if no progress happened in between.
   */
  private checkQuiet(): void {
    if (!this.parked) return;
    const progress = this.progress;
    setImmediate(() => {
      if (!this.parked || this.progress !== progress) return;
      if (this.waiting.size === 0 || this.executing > 0) return;
      if (this.unsettled !== this.waiting.size) return;
      this.onQuiet?.();
    });
  }

  // -------------------------------------------------------------------------
  // The `tools` namespace
  // -------------------------------------------------------------------------

  private toolsNamespace(): ReturnType<typeof Host.namespace> {
    const names = this.options.catalog.tools.map((tool) => tool.name);
    return Host.namespace({
      keys: (path) => {
        const prefix = path.length === 0 ? '' : `${path.join('.')}.`;
        const children = new Set<string>();
        for (const name of names) {
          if (!name.startsWith(prefix)) continue;
          const rest = name.slice(prefix.length);
          children.add(rest.split('.')[0] ?? rest);
        }
        return [...children];
      },
      resolve: (path) => this.toolFunction(path.join('.')),
    });
  }

  private toolFunction(name: string): ReturnType<typeof Host.durableFn> {
    return Host.durableFn<CallData>({
      start: (args, call) => this.start(name, args, call.key),
      wait: (data) => this.tracked(data),
      cancel: () => {},
    });
  }

  /** `wait`, counted while unsettled; settling is progress for the idle signal. */
  private async tracked(data: CallData): Promise<unknown> {
    this.unsettled += 1;
    try {
      return await this.wait(data);
    } finally {
      this.unsettled -= 1;
      this.progressed();
    }
  }

  /** Record a call and decide its policy (R14). Runs once per call, in the segment that made it. */
  private start(name: string, rawArgs: ReadonlyArray<unknown>, key: string): CallData {
    this.progressed();
    const refused = this.refusal();
    if (refused !== undefined) throw refused;
    // `<name>#<n>`, n counting the run's calls from 1 like a machine's toolCall ids.
    const id = `${name}#${Number(key.slice(key.lastIndexOf(':') + 1)) + 1}`;
    if (id.startsWith(RESERVED_ID_PREFIX)) {
      this.failRun(
        new ProjectionError(
          'validate',
          `tool call id ${inertText(id, 200)} uses a reserved prefix`,
          {
            hint: `Tool names starting with "${RESERVED_ID_PREFIX}" cannot be called from a program.`,
          },
        ),
      );
    }
    // Policy depends on the tool, not its arguments: an unknown tool fails
    // the workflow before its arguments are even copied.
    const known = resolveCallPolicy(
      { id, name, args: {}, stateName: PROGRAM_STEP },
      this.options.catalog,
      this.policy,
    );
    if (!known.ok) this.failRun(unknownTool(known.error, this.options.catalog, name));
    const args = callArgs(name, rawArgs, this.caps.maxInputBytes);
    const resolved = known;
    this.startedHere.add(id);

    if (resolved.decision === 'deny') {
      const reason = policyDeniedReason(name);
      this.audit.push({ callId: id, tool: name, args, decision: 'denied_by_policy', reason });
      return { id, name, args, kind: 'deny', reason };
    }
    if (resolved.decision === 'ask') {
      // Never ask a person to approve a call that cannot run (R35.1).
      const invalid = invalidArgs(name, args, resolved.entry.inputSchema);
      if (invalid !== undefined) {
        this.audit.push({ callId: id, tool: name, args, decision: 'error', reason: invalid });
        return { id, name, args, kind: 'invalid', reason: invalid };
      }
      this.asked.set(id, name);
      return { id, name, args, kind: 'ask', reason: '' };
    }
    this.readCalls += 1;
    if (this.readCalls > this.caps.maxReadCallsPerSegment) {
      const max = this.caps.maxReadCallsPerSegment;
      this.failRun(
        new ProjectionError(
          'cap_exceeded',
          `the program made more than ${max} tool calls that run without approval in one segment`,
          { hint: `Make at most ${max} calls that run without approval per segment.` },
        ),
      );
    }
    return { id, name, args, kind: 'auto', reason: '' };
  }

  /** Run, refuse or hold a call. Runs right after `start`, and again after a resume. */
  private async wait(data: CallData): Promise<unknown> {
    const refused = this.refusal();
    if (refused !== undefined) throw refused;
    switch (data.kind) {
      case 'deny':
        throw programError('ToolDenied', `${data.name} was not run: ${data.reason}`, {
          tool: data.name,
          reason: data.reason,
          byPolicy: true,
        });
      case 'invalid':
        throw programError('ToolError', data.reason, { tool: data.name });
      case 'auto':
        if (!this.startedHere.has(data.id)) {
          // Unreachable by construction (a run is never suspended while a
          // call executes); fail closed rather than run a call twice.
          throw programError('ToolError', `${data.name} was interrupted and not run again`, {
            tool: data.name,
          });
        }
        return await this.execute(data.id, data.name, data.args, 'auto');
      case 'ask':
        return await this.gated(data);
    }
  }

  /**
   * A gated call: apply its verdict when this segment resumes it, else wait
   * for one. The arguments that run are the ones sealed in `pending`, not
   * the program's (S2); policy outranks a stale approval (D9).
   */
  private async gated(data: CallData): Promise<unknown> {
    const resume = this.options.resume;
    const sealed =
      resume !== undefined && Object.hasOwn(resume.pending, data.id)
        ? resume.pending[data.id]
        : undefined;
    if (resume === undefined || sealed === undefined) {
      this.waiting.set(data.id, {
        id: data.id,
        name: data.name,
        args: data.args,
        stateName: PROGRAM_STEP,
      });
      return await new Promise(() => {});
    }
    const resolved = resolveCallPolicy(sealed, this.options.catalog, this.policy);
    // The tool left the catalog while the approval was out: as at start,
    // that ends the workflow rather than reaching the program's catch.
    if (!resolved.ok) this.failRun(unknownTool(resolved.error, this.options.catalog, sealed.name));
    if (resolved.decision === 'deny') {
      const reason = policyDeniedReason(sealed.name);
      this.audit.push({
        callId: sealed.id,
        tool: sealed.name,
        args: sealed.args,
        decision: 'denied_by_policy',
        reason,
      });
      throw programError('ToolDenied', `${sealed.name} was not run: ${reason}`, {
        tool: sealed.name,
        reason,
        byPolicy: true,
      });
    }
    const verdict = Object.hasOwn(resume.verdicts, data.id) ? resume.verdicts[data.id] : undefined;
    if (verdict === undefined || verdict.kind === 'declined') {
      // R17: a call missing from inputResponses is declined.
      const reason = verdict?.kind === 'declined' ? verdict.reason : undefined;
      this.audit.push({
        callId: sealed.id,
        tool: sealed.name,
        args: sealed.args,
        decision: 'declined',
        ...(reason !== undefined ? { reason } : {}),
      });
      throw programError(
        'ToolDenied',
        `the user declined ${sealed.name}${reason !== undefined ? ` with this note: ${JSON.stringify(reason)}` : ''}`,
        { tool: sealed.name, ...(reason !== undefined ? { reason } : {}), byPolicy: false },
      );
    }
    return await this.execute(sealed.id, sealed.name, sealed.args, 'approved');
  }

  /** Execute one call, tracked so every outcome waits for it. */
  private execute(
    id: string,
    name: string,
    args: Record<string, unknown>,
    decision: 'auto' | 'approved',
  ): Promise<unknown> {
    const refused = this.refusal();
    if (refused !== undefined) return Promise.reject(refused);
    const running = this.executeNow(id, name, args, decision);
    this.inflight.add(running);
    running
      .finally(() => {
        this.inflight.delete(running);
      })
      .catch(() => {});
    return running;
  }

  /** Execute one call against the wrapped server; the program gets its result or a `ToolError`. */
  private async executeNow(
    id: string,
    name: string,
    args: Record<string, unknown>,
    decision: 'auto' | 'approved',
  ): Promise<unknown> {
    this.executing += 1;
    try {
      const target = routeCall(this.options.catalog, name);
      const outcome = await this.options.executor.callTool(target.alias, target.name, args);
      if (!outcome.ok) {
        const message =
          outcome.upstreamInput !== undefined
            ? `${name} asked the user a question, which programs cannot pass on yet; the call did not complete`
            : outcome.error.message;
        this.audit.push({ callId: id, tool: name, args, decision: 'error', reason: message });
        throw programError('ToolError', message, { tool: name });
      }
      this.audit.push({ callId: id, tool: name, args, decision });
      const notes = resultNotes({
        value: outcome.result,
        args,
        inputSchema: findTool(this.options.catalog, name)?.inputSchema ?? {},
        ...(outcome.serverNote !== undefined ? { serverNote: outcome.serverNote } : {}),
      });
      for (const note of notes) this.addNote(`${inertText(name, 200)}: ${note}`);
      // D29: JSON text for an object or array arrives parsed.
      const parsed =
        typeof outcome.result === 'string' && outcome.rawContent !== true
          ? parseJsonContainer(outcome.result)
          : undefined;
      return parsed !== undefined ? parsed.value : outcome.result;
    } finally {
      this.executing -= 1;
    }
  }

  private addNote(note: string): void {
    if (this.notes.length >= MAX_SEGMENT_NOTES) {
      this.notesDropped += 1;
      return;
    }
    this.notes.push(note);
  }

  // -------------------------------------------------------------------------
  // Outcomes
  // -------------------------------------------------------------------------

  /** This segment's console lines, capped at maxConsoleBytes like the machine host's. */
  private segmentLogs(lines: ReadonlyArray<string>): LogEntry[] {
    const collector = new LogCollector(this.caps.maxConsoleBytes, this.segmentIndex);
    for (const line of lines.slice(this.priorLines)) {
      const match = /^\[(\w+)\]\s?([\s\S]*)$/u.exec(line);
      const level = match?.[1] !== undefined && LOG_LEVELS.has(match[1]) ? match[1] : undefined;
      if (level !== undefined) collector.push(level as LogLevel, [match?.[2] ?? '']);
      else collector.push('log', [line]);
    }
    return collector.snapshot();
  }

  private suspended(state: Runtime.Suspended['state']): SegmentOutcome {
    this.captured = this.segmentLogs(snapshotLogLines(state) ?? []);
    const pending: Record<string, PendingToolCall> = {};
    for (const [id, call] of this.waiting) pending[id] = call;
    return {
      status: 'suspended',
      pending,
      held: [],
      snapshot: Buffer.from(toBytes(state)).toString('base64'),
      trip: (this.options.resume?.trip ?? 0) + 1,
      audit: this.audit,
      logs: this.captured,
    };
  }

  private finish(result: Result): SegmentOutcome {
    this.captured = this.segmentLogs(result.logs ?? []);
    if (this.fatal !== undefined) throw this.fatal;
    if (!result.ok) {
      if (result.error.kind === 'TimeoutExceeded') {
        throw this.wallClockError([{ message: result.error.message }]);
      }
      throw programFailure(result.error);
    }
    const output = result.value;
    const size = Buffer.byteLength(JSON.stringify(output ?? null), 'utf8');
    if (size > this.caps.maxResultBytes) {
      throw new ProjectionError(
        'cap_exceeded',
        `the final result is ${size} bytes, exceeding the limit of ${this.caps.maxResultBytes}`,
        {
          hint: `Return a summary instead of the full data: the result must be at most ${this.caps.maxResultBytes} bytes.`,
        },
      );
    }
    // Notes about the run itself lead; the tool-result notes fill the rest.
    const lead = [
      ...this.unawaitedNote(),
      ...(result.warnings ?? [])
        .slice(0, MAX_WARNING_NOTES)
        .map(
          (warning) => `program warning: ${inertText(`${warning.kind}: ${warning.message}`, 300)}`,
        ),
    ];
    const all = [...lead, ...this.notes];
    const kept = all.slice(0, MAX_SEGMENT_NOTES);
    const dropped = all.length - kept.length + this.notesDropped;
    const notes = dropped > 0 ? [...kept, `… and ${dropped} more notes like these`] : kept;
    return {
      status: 'completed',
      output,
      audit: this.audit,
      logs: this.captured,
      ...(notes.length > 0 ? { notes } : {}),
    };
  }

  /**
   * The gated calls the program started but never awaited before it ended:
   * not run, and nobody was asked. Said in the result so neither the model
   * nor the user takes them for done.
   */
  private unawaitedNote(): string[] {
    if (this.asked.size === 0) return [];
    const ids = [...this.asked.keys()];
    const listed = ids.slice(0, MAX_UNAWAITED_LISTED).map((id) => inertText(id, 200));
    const more = ids.length > listed.length ? ` and ${ids.length - listed.length} more` : '';
    const one = ids.length === 1;
    return [
      `${one ? 'this call that asks' : 'these calls that ask'} for approval ${one ? 'was' : 'were'} started but never awaited, so ${one ? 'it was' : 'they were'} not run and the user was not asked: ${listed.join(', ')}${more}. Await gated calls (Promise.allSettled for several) to run them.`,
    ];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The program's source as psychoscript runs it: TypeScript types stripped unless `lang` is `js`. */
async function programSource(code: string, lang: 'ts' | 'js' | undefined): Promise<string> {
  if (lang === 'js') return code;
  const ts = await import('typescript');
  return ts.transpile(code, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.Preserve,
  });
}

function malformedSnapshot(): ProjectionError {
  return new ProjectionError('blob_verification', 'the program snapshot in the blob is malformed', {
    hint: 'Re-run execute_machine to start a new workflow.',
  });
}

/**
 * The sealed snapshot (base64 of psychoscript's bytes) as the state to
 * resume, with this segment's time budget: psychoscript's `timeoutMs` counts
 * active time across every resume, so the header's budget is reset and its
 * limit set to one segment's wall clock. The header is plain JSON that
 * psychoscript reads on resume; the snapshot itself is authenticated by the
 * blob seal, so only this host writes it.
 */
function resumeState(snapshot: unknown, wallClockMs: number): unknown {
  if (typeof snapshot !== 'string') throw malformedSnapshot();
  let state: unknown;
  try {
    state = fromBytes(new Uint8Array(Buffer.from(snapshot, 'base64')));
  } catch {
    throw malformedSnapshot();
  }
  const header = isRecord(state) ? state['header'] : undefined;
  if (!isRecord(header) || !isRecord(header['limits']) || !isRecord(header['budget'])) {
    throw malformedSnapshot();
  }
  header['limits']['timeoutMs'] = wallClockMs;
  header['limits']['maxOutputBytes'] = null;
  header['budget']['activeMs'] = 0;
  return state;
}

/**
 * The console lines a saved run holds, read from the snapshot's data:
 * psychoscript keeps them on the interpreter record's first field (`logs`)
 * as an array of strings. That layout is psychoscript's (format 3, pinned);
 * `undefined` when it does not match, and the caller degrades to reporting
 * every line rather than failing the run.
 */
function snapshotLogLines(state: unknown): string[] | undefined {
  if (!isRecord(state) || !Array.isArray(state['records'])) return undefined;
  const records = state['records'] as unknown[];
  const interpreter = records.find((record) => isRecord(record) && record['t'] === 'Interpreter');
  if (!isRecord(interpreter) || !Array.isArray(interpreter['f'])) return undefined;
  const ref: unknown = interpreter['f'][0];
  if (!Array.isArray(ref) || ref[0] !== 'r' || typeof ref[1] !== 'number') return undefined;
  const logs = records[ref[1]];
  if (!isRecord(logs) || logs['t'] !== 'Array' || !Array.isArray(logs['v'])) return undefined;
  return (logs['v'] as unknown[]).filter((line): line is string => typeof line === 'string');
}

function isOutcome(value: unknown): value is Runtime.Outcome {
  return isRecord(value) && 'ok' in value;
}

/**
 * A tool function's arguments: none, or one plain object, normalized to
 * plain JSON (a Date becomes its ISO string, a Map `{}`), so the arguments
 * sealed for approval are exactly the ones the server receives (S2). At most
 * `maxBytes` of JSON (`caps.maxInputBytes`): a larger call fails with a
 * `ToolError` the program can catch, before it is recorded or run.
 */
function callArgs(
  name: string,
  args: ReadonlyArray<unknown>,
  maxBytes: number,
): { [key: string]: Json } {
  const first = args[0];
  if (args.length > 1) {
    throw new TypeError(
      `tools.${name}(args) takes one object of arguments, got ${args.length} arguments`,
    );
  }
  if (first === undefined || first === null) return {};
  if (typeof first !== 'object' || Array.isArray(first)) {
    throw new TypeError(`tools.${name}(args): args must be a plain object, like { path: "a.txt" }`);
  }
  const json = JSON.stringify(first);
  const size = Buffer.byteLength(json, 'utf8');
  if (size > maxBytes) {
    throw programError(
      'ToolError',
      `the arguments of ${name} are ${size} bytes of JSON, over the limit of ${maxBytes} bytes per tool call; the call was not run`,
      { tool: name },
    );
  }
  return JSON.parse(json) as { [key: string]: Json };
}

/** An Error for the program to catch: its `name` and own fields cross the boundary. */
function programError(name: string, message: string, data: Record<string, unknown>): Error {
  const error = new Error(message);
  error.name = name;
  Object.assign(error, data);
  return error;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** Projection's own MCP tools, which a program may try to call through `tools`. */
const FACADE_TOOL =
  /^(?:search_tools|search_[A-Za-z0-9_-]+|describe_tool|call_tool|discover_apis|execute_machine)$/u;

function unknownTool(
  error: ProjectionError,
  catalog: ServerCatalog,
  name: string,
): ProjectionError {
  const message = error.message;
  // Projection's own MCP tools are not functions inside a program: in the
  // thread eval, models wrote tools.search_tools(...) after discover_apis
  // pointed them at search_tools, and got a misleading did-you-mean.
  if (FACADE_TOOL.test(name)) {
    return new ProjectionError(
      'validate',
      `${name} is a tool of this MCP server, not a function inside programs`,
      {
        hint: `Call ${name} directly (outside execute_machine) to find the tool you need, then call that tool's name in the program as tools.<name>(args)${isBoxedCatalog(catalog) ? ', or tools.<box>.<tool>(args)' : ''}. The tools object holds only the wrapped server's tools.`,
      },
    );
  }
  const didYouMean = didYouMeanHint(catalog, name);
  return new ProjectionError('validate', message, {
    hint: `${didYouMean}Call tools by the names in tools.d.ts${isBoxedCatalog(catalog) ? ', as tools.<box>.<tool>(args)' : ''}; see discover_apis.`,
  });
}

function invalidArgs(
  name: string,
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): string | undefined {
  try {
    validateArgsShape(name, args, schema, 'toolCall');
    return undefined;
  } catch (err) {
    if (err instanceof ProjectionError) return err.message;
    throw err;
  }
}

/** A compile failure (parse error, unsupported syntax) as a `validate` error with its location. */
function compileError(error: {
  kind: string;
  message: string;
  location?: { line: number; column: number };
  suggestions?: ReadonlyArray<string>;
}): ProjectionError {
  return new ProjectionError('validate', `the program does not compile: ${error.message}`, {
    diagnostics: [
      {
        message: error.message,
        ...(error.location !== undefined
          ? { line: error.location.line, column: error.location.column }
          : {}),
      },
    ],
    hint:
      error.suggestions !== undefined && error.suggestions.length > 0
        ? error.suggestions.join(' ')
        : 'Write plain JavaScript: top-level await and return are allowed; import, export, eval and classes with private members are not. See discover_apis.',
  });
}

/** An uncaught failure of the program, as the error the model sees. */
function programFailure(error: {
  kind: string;
  message: string;
  location?: { line: number; column: number };
}): ProjectionError {
  const diagnostics = [
    {
      message: error.message,
      ...(error.location !== undefined
        ? { line: error.location.line, column: error.location.column }
        : {}),
    },
  ];
  const at = error.location !== undefined ? ` (line ${error.location.line})` : '';
  return new ProjectionError('runtime', `the program threw${at}: ${error.message}`, {
    diagnostics,
    hint: 'A declined or policy-denied call throws an error named ToolDenied, and a failed call one named ToolError: catch them with try/catch to carry on without that call.',
  });
}

const LOG_LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug']);

/** Untrusted text as one inert, bounded, JSON-quoted line (S5). */
function inertText(text: string, max: number): string {
  return JSON.stringify(neutralizeControlChars(capLength(text, max)));
}
