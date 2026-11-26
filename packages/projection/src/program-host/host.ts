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
 * - "asks for approval" calls block in `wait`. Once nothing else is running,
 *   the run is suspended and its state sealed into the blob with the pending
 *   calls; every gated call outstanding at that moment goes to the human in
 *   one round trip (R15).
 * - On resume, a pending call's `wait` runs again and applies its verdict:
 *   approved runs the SEALED arguments (S2) once; declined throws a
 *   `ToolDenied` error into the program.
 *
 * Suspension is only attempted while no tool call is executing, so no
 * executed call is ever interrupted and run again on resume.
 *
 * Known gap (D48): psychoscript has no memory limit and runs in this
 * process; a program can allocate until the per-segment wall clock stops
 * it. The QuickJS runtime's WebAssembly memory cap (D15) does not apply here.
 */

import { Host, Runtime, parseProgram, toBytes, type Json } from 'psychoscript';

type Result = Runtime.Result;
import { isBoxedCatalog, routeCall } from '../catalog/boxes.js';
import { parseJsonContainer, resultNotes } from '../catalog/result-notes.js';
import { didYouMeanHint } from '../catalog/search.js';
import { validateArgsShape } from '../catalog/validate-args.js';
import { ProjectionError, toStructuredError } from '../errors.js';
import { RESERVED_ID_PREFIX } from '../mrtr/batch.js';
import { policyContext, policyDeniedReason, resolveCallPolicy } from '../policy/index.js';
import { capLength, neutralizeControlChars } from '../text-safety.js';
import {
  clampCaps,
  findTool,
  MAX_SEGMENT_NOTES,
  type AuditEntry,
  type LogEntry,
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
  /** Gated calls blocked on a verdict right now, in the order they asked. */
  private readonly waiting = new Map<string, PendingToolCall>();
  /** Tool calls executing against the wrapped server right now. */
  private executing = 0;
  private readCalls = 0;
  /** A failure that ends the whole workflow (unknown tool, a cap): the run is aborted with it. */
  private fatal: ProjectionError | undefined;
  private readonly notes: string[] = [];
  private notesDropped = 0;
  private captured: LogEntry[] = [];
  private quiet: (() => void) | undefined;
  private quietTimer: ReturnType<typeof setTimeout> | undefined;

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
    const runtime = Runtime.make({
      globals: () => ({ tools: this.toolsNamespace() }),
      limits: {
        // The per-segment wall clock below is the real cap; this backstop
        // bounds a run's active time summed across every resume.
        timeoutMs: this.caps.segmentWallClockMs * (this.caps.maxRoundTrips + 1),
        maxOutputBytes: this.caps.maxResultBytes + this.caps.maxConsoleBytes,
      },
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
      program = runtime.resume(snapshotBytes(resume.snapshot));
    }

    const timer = setTimeout(() => this.controller.abort(), this.caps.segmentWallClockMs);
    try {
      // `run()` re-enters the pending calls' `wait` synchronously on a
      // resume, so everything `wait` reads is set up before this line.
      const running = program.run({ signal: this.controller.signal });
      for (;;) {
        const quiet = new Promise<'quiet'>((resolve) => {
          this.quiet = () => resolve('quiet');
        });
        this.changed();
        // eslint-disable-next-line no-await-in-loop -- each wait follows the previous suspend attempt
        const first = await Promise.race([running, quiet]).catch((err: unknown) => {
          if (isAbort(err)) return 'aborted' as const;
          throw err;
        });
        if (first === 'aborted') throw this.abortError();
        if (first !== 'quiet') {
          if (first.ok === 'suspended') {
            throw new ProjectionError('runtime', 'the program was suspended unexpectedly', {});
          }
          return this.finish(first);
        }
        // Rejects while a call that cannot be suspended is running (one
        // started after the quiet check): wait for the next quiet moment.
        // eslint-disable-next-line no-await-in-loop -- one suspend attempt per quiet moment
        const outcome = await program.suspend().catch(() => undefined);
        if (outcome === undefined) continue;
        if (outcome.ok !== 'suspended') return this.finish(outcome);
        return this.suspended(toBytes(outcome.state));
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(this.quietTimer);
      this.controller.abort();
    }
  }

  /** The error an aborted run reports: the fatal failure that aborted it, else the wall clock. */
  private abortError(): ProjectionError {
    if (this.fatal !== undefined) return this.fatal;
    return new ProjectionError(
      'cap_exceeded',
      `the program ran longer than ${this.caps.segmentWallClockMs} ms in one segment`,
      {
        hint: `Each segment (the run up to an approval, or after it) may take at most ${this.caps.segmentWallClockMs} ms. Look for a loop that never ends, or do less work per run.`,
      },
    );
  }

  /** End the run with a failure the program cannot catch. */
  private failRun(error: ProjectionError): never {
    this.fatal ??= error;
    this.controller.abort();
    throw error;
  }

  /**
   * Suspend once the program has nothing to do but wait for verdicts: some
   * gated call is waiting and nothing is executing. Checked a macrotask
   * later, so work the last settled call released runs first.
   */
  private changed(): void {
    clearTimeout(this.quietTimer);
    if (this.waiting.size === 0 || this.executing > 0) return;
    this.quietTimer = setTimeout(() => {
      if (this.waiting.size > 0 && this.executing === 0) this.quiet?.();
    }, 0);
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
      wait: (data) => this.wait(data),
      cancel: () => {},
    });
  }

  /** Record a call and decide its policy (R14). Runs once per call, in the segment that made it. */
  private start(name: string, rawArgs: ReadonlyArray<unknown>, key: string): CallData {
    const args = callArgs(name, rawArgs);
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
    const call: PendingToolCall = { id, name, args, stateName: PROGRAM_STEP };
    const resolved = resolveCallPolicy(call, this.options.catalog, this.policy);
    if (!resolved.ok) this.failRun(unknownTool(resolved.error, this.options.catalog, name));
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
      this.changed();
      return await new Promise(() => {});
    }
    const resolved = resolveCallPolicy(sealed, this.options.catalog, this.policy);
    if (!resolved.ok) throw resolved.error;
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

  /** Execute one call against the wrapped server; the program gets its result or a `ToolError`. */
  private async execute(
    id: string,
    name: string,
    args: Record<string, unknown>,
    decision: 'auto' | 'approved',
  ): Promise<unknown> {
    this.executing += 1;
    this.changed();
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
      this.noteResult(name, notes);
      // D29: JSON text for an object or array arrives parsed.
      const parsed =
        typeof outcome.result === 'string' && outcome.rawContent !== true
          ? parseJsonContainer(outcome.result)
          : undefined;
      return parsed !== undefined ? parsed.value : outcome.result;
    } finally {
      this.executing -= 1;
      this.changed();
    }
  }

  private noteResult(tool: string, notes: string[]): void {
    for (const note of notes) {
      if (this.notes.length >= MAX_SEGMENT_NOTES) {
        this.notesDropped += 1;
        continue;
      }
      this.notes.push(`${inertText(tool, 200)}: ${note}`);
    }
  }

  // -------------------------------------------------------------------------
  // Outcomes
  // -------------------------------------------------------------------------

  private suspended(bytes: Uint8Array): SegmentOutcome {
    const pending: Record<string, PendingToolCall> = {};
    for (const [id, call] of this.waiting) pending[id] = call;
    return {
      status: 'suspended',
      pending,
      held: [],
      snapshot: Buffer.from(bytes).toString('base64'),
      trip: (this.options.resume?.trip ?? 0) + 1,
      audit: this.audit,
      logs: this.captured,
    };
  }

  private finish(result: Result): SegmentOutcome {
    this.captured = toLogEntries(result.logs ?? [], this.segmentIndex);
    if (this.fatal !== undefined) throw this.fatal;
    if (!result.ok) throw programFailure(result.error);
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
    const notes =
      this.notesDropped > 0
        ? [...this.notes, `… and ${this.notesDropped} more notes like these`]
        : this.notes;
    return {
      status: 'completed',
      output,
      audit: this.audit,
      logs: this.captured,
      ...(notes.length > 0 ? { notes } : {}),
    };
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

/** The sealed snapshot (base64 of psychoscript's bytes) back as bytes. */
function snapshotBytes(snapshot: unknown): Uint8Array {
  if (typeof snapshot !== 'string') {
    throw new ProjectionError(
      'blob_verification',
      'the program snapshot in the blob is malformed',
      {
        hint: 'Re-run execute_machine to start a new workflow.',
      },
    );
  }
  return new Uint8Array(Buffer.from(snapshot, 'base64'));
}

/**
 * A tool function's arguments: none, or one plain object, normalized to
 * plain JSON (a Date becomes its ISO string, a Map `{}`), so the arguments
 * sealed for approval are exactly the ones the server receives (S2).
 */
function callArgs(name: string, args: ReadonlyArray<unknown>): { [key: string]: Json } {
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
  return JSON.parse(JSON.stringify(first)) as { [key: string]: Json };
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

function unknownTool(
  error: ProjectionError,
  catalog: ServerCatalog,
  name: string,
): ProjectionError {
  const didYouMean = didYouMeanHint(catalog, name);
  return new ProjectionError('validate', error.message, {
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
  if (error.kind === 'TimeoutExceeded') {
    return new ProjectionError('cap_exceeded', `the program ran out of time: ${error.message}`, {
      diagnostics,
      hint: 'Look for a loop that never ends, or do less work per run.',
    });
  }
  const at = error.location !== undefined ? ` (line ${error.location.line})` : '';
  return new ProjectionError('runtime', `the program threw${at}: ${error.message}`, {
    diagnostics,
    hint: 'A declined or policy-denied call throws an error named ToolDenied, and a failed call one named ToolError: catch them with try/catch to carry on without that call.',
  });
}

const LOG_LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug']);

/** psychoscript's console lines as Projection log entries. */
function toLogEntries(lines: ReadonlyArray<string>, segment: number): LogEntry[] {
  return lines.map((line) => {
    const match = /^\[(\w+)\]\s?([\s\S]*)$/.exec(line);
    const level = match?.[1] !== undefined && LOG_LEVELS.has(match[1]) ? match[1] : 'log';
    return {
      level: level as LogEntry['level'],
      message: match?.[2] ?? line,
      ts: 0,
      segment,
    };
  });
}

/** Untrusted text as one inert, bounded, JSON-quoted line (S5). */
function inertText(text: string, max: number): string {
  return JSON.stringify(neutralizeControlChars(capLength(text, max)));
}
