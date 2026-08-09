/**
 * Sandbox session implementation. See ./index.ts for the boundary contract
 * the machine host builds against.
 */

import {
  getTypescriptSupport,
  loadQuickJs,
  type ErrorResponse,
  type SandboxEvalCode,
  type SandboxOptions,
} from '@sebastianwessel/quickjs';
import type TS from 'typescript';
import { ProjectionError } from '../errors.js';
import { clampCaps, type LogEntry, type ResourceCaps } from '../types.js';
import { LogCollector, utf8Length } from './logs.js';
import {
  buildNodeModulesMount,
  DENIED_IMPORT_MARKER,
  getSandboxModuleLoader,
  modulePathNormalizer,
  TOOLS_SPECIFIER,
  XSTATE_SPECIFIER,
} from './mounts.js';

// ---------------------------------------------------------------------------
// Public option/handle types
// ---------------------------------------------------------------------------

/** A tool call surfaced from the `@astral-mcp/tools` bridge inside the VM. */
export interface SandboxToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Host callback invoked for every bridge tool call made inside the VM.
 *
 * The returned value (or resolved promise value) is marshaled back into the
 * VM as the bridge call's result; a thrown error / rejected promise rejects
 * the in-VM promise. Values must be JSON-serializable. The sandbox attaches
 * no semantics to the payload — result/error/denial encoding is the machine
 * host's protocol.
 */
export type SandboxToolCallHandler = (call: SandboxToolCall) => unknown | Promise<unknown>;

export interface SandboxSessionOptions {
  /** The submitted module source (R2). */
  code: string;
  /** Language of `code`. TypeScript is transpiled without type checking (R10). */
  lang?: 'ts' | 'js';
  /** Resource cap overrides; clamped at the hard maxima via `clampCaps` (R12). */
  caps?: Partial<ResourceCaps>;
  /**
   * Source text of the module mounted at `@astral-mcp/tools` (R8). Generated
   * by the typegen component. May be TypeScript or JavaScript; must be a
   * single module (relative imports do not resolve outside the mount).
   */
  bridgeSource: string;
  /** Host callback for bridge tool calls. */
  onToolCall: SandboxToolCallHandler;
  /** Zero-based MRTR segment index, recorded on every log entry (R31). */
  segment?: number;
}

/**
 * A live sandbox holding the evaluated authored module. One session is one
 * execution segment: it owns a fresh wall-clock budget (R13) and a fresh log
 * collector (R31). Sessions are single-threaded — `evaluate` calls are
 * serialized internally.
 */
export interface SandboxSession {
  /** The effective (clamped) caps this session enforces. */
  readonly caps: ResourceCaps;
  /** Zero-based MRTR segment index this session was created for. */
  readonly segment: number;
  /**
   * Evaluate an ESM driver module inside the VM and return its default
   * export marshaled to the host (promises are awaited). Rejects with
   * {@link ProjectionError} on failure. See ./index.ts for the contract.
   */
  evaluate(source: string): Promise<unknown>;
  /** Logs captured so far this segment, truncated per `maxConsoleBytes`. */
  getLogs(): LogEntry[];
  /** Tear down the VM. Idempotent. Pending bridge promises are rejected. */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-VM binding points (also part of the boundary contract)
// ---------------------------------------------------------------------------

/** Global object the boot script installs inside the VM. */
export const SANDBOX_GLOBAL = '__projection';

/**
 * Name of the host bridge function on the in-VM `env` object. The bridge
 * module calls `env.__projection_toolCall(name, args)` and receives a promise.
 */
export const TOOL_CALL_BINDING = '__projection_toolCall';

// ---------------------------------------------------------------------------
// Lazy singletons: QuickJS WASM runtime and TypeScript transpiler
// ---------------------------------------------------------------------------

type QuickJsRuntime = Awaited<ReturnType<typeof loadQuickJs>>;
type TsSupport = Awaited<ReturnType<typeof getTypescriptSupport>>;

let quickJsPromise: Promise<QuickJsRuntime> | undefined;
let tsSupportPromise: Promise<TsSupport> | undefined;

const QUICKJS_VARIANT = '@jitl/quickjs-ng-wasmfile-release-sync';

function getQuickJs(): Promise<QuickJsRuntime> {
  quickJsPromise ??= (async () => {
    let variant: { default: Parameters<typeof loadQuickJs>[0] };
    try {
      variant = await import(QUICKJS_VARIANT);
    } catch (cause) {
      quickJsPromise = undefined;
      throw new ProjectionError(
        'runtime',
        `QuickJS WASM variant '${QUICKJS_VARIANT}' is not installed`,
        {
          hint: `Add ${QUICKJS_VARIANT} to the @astral-mcp/projection package dependencies`,
          cause,
        },
      );
    }
    return loadQuickJs(variant.default);
  })();
  return quickJsPromise;
}

/**
 * Environment-class transpile failure: the TypeScript transpiler itself is
 * missing or incompatible, as opposed to a syntax error in the source being
 * transpiled. `createSandboxSession` lets these pass through unrewrapped so
 * the environment diagnostics (and their hints) reach the consumer instead
 * of being misreported as an invalid-bridgeSource integration bug.
 */
class TranspilerUnavailableError extends ProjectionError {}

function getTsSupport(): Promise<TsSupport> {
  tsSupportPromise ??= (async () => {
    // `typescript` is a real dependency (the generated tools bridge is
    // always TypeScript), but guard against a consumer force-resolving an
    // incompatible major: TS 7 removed the `ts.transpile` API the QuickJS
    // support layer calls, which would otherwise surface as an opaque
    // "ts.transpile is not a function" at machine run time.
    const ts = (await import('typescript')) as { transpile?: unknown; version?: string };
    if (typeof ts.transpile !== 'function') {
      throw new TranspilerUnavailableError(
        'transpile',
        `the installed typescript@${ts.version ?? 'unknown'} does not provide ts.transpile`,
        {
          hint: '@astral-mcp/projection requires typescript ^5 (TS 6+/7+ removed the transpile API). Pin typescript to ^5.7.0.',
        },
      );
    }
    // quickjs's getTypescriptSupport performs its own `import('typescript')`,
    // which under flat/hoisted node_modules layouts can resolve a DIFFERENT
    // copy than the one validated above (e.g. a hoisted root typescript@7
    // next to @astral-mcp/projection's own nested 5.x). Pass our resolved specifier so
    // the support layer loads the exact copy we just checked. Falls back to
    // quickjs's own resolution where import.meta.resolve is unavailable
    // (e.g. bundler-transformed environments).
    const typescriptImportFile =
      typeof import.meta.resolve === 'function' ? import.meta.resolve('typescript') : undefined;
    return getTypescriptSupport(true, typescriptImportFile);
  })().catch((cause: unknown) => {
    tsSupportPromise = undefined;
    if (cause instanceof ProjectionError) throw cause;
    throw new TranspilerUnavailableError('transpile', 'TypeScript transpiler is not available', {
      hint: 'Reinstall dependencies: @astral-mcp/projection depends on typescript ^5 for machine and bridge transpilation.',
      cause,
    });
  });
  return tsSupportPromise;
}

// ---------------------------------------------------------------------------
// TypeScript transpilation (in-sandbox toolchain, no type checking — R10)
// ---------------------------------------------------------------------------

function flattenDiagnosticMessage(messageText: string | TS.DiagnosticMessageChain): string {
  if (typeof messageText === 'string') {
    return messageText;
  }
  const parts = [messageText.messageText];
  for (const next of messageText.next ?? []) {
    parts.push(flattenDiagnosticMessage(next.messageText));
  }
  return parts.join(' ');
}

/**
 * Transpile the (invariant) tools bridge, memoized by source. Bounded so a
 * process that wraps many distinct servers can't grow the cache unbounded.
 */
const bridgeCache = new Map<string, string>();
const BRIDGE_CACHE_MAX = 32;

async function transpileBridge(source: string): Promise<string> {
  const cached = bridgeCache.get(source);
  if (cached !== undefined) return cached;
  const js = await transpileTs(source, '/bridge/index.ts');
  if (bridgeCache.size >= BRIDGE_CACHE_MAX) {
    const oldest = bridgeCache.keys().next().value;
    if (oldest !== undefined) bridgeCache.delete(oldest);
  }
  bridgeCache.set(source, js);
  return js;
}

async function transpileTs(source: string, fileName: string): Promise<string> {
  const support = await getTsSupport();
  const diagnostics: TS.Diagnostic[] = [];
  const js = support.transpileFile(source, undefined, fileName, diagnostics);
  const errors = diagnostics.filter((d) => d.category === 1 /* ts.DiagnosticCategory.Error */);
  if (errors.length > 0) {
    throw new ProjectionError('transpile', 'TypeScript transpilation failed', {
      diagnostics: errors.map((d) => {
        const message = flattenDiagnosticMessage(d.messageText);
        if (d.file !== undefined && d.start !== undefined) {
          const pos = d.file.getLineAndCharacterOfPosition(d.start);
          return { message, line: pos.line + 1, column: pos.character + 1 };
        }
        return { message };
      }),
      hint: 'Fix the syntax error; TypeScript is transpiled without type checking, so only syntax matters',
    });
  }
  return js;
}

// ---------------------------------------------------------------------------
// Error classification (R25 phases)
// ---------------------------------------------------------------------------

function classifyEvalError(
  response: ErrorResponse,
  caps: ResourceCaps,
  logs: LogEntry[],
): ProjectionError {
  const { name, message, stack } = response.error;
  const diagnostics = stack !== undefined && stack.length > 0 ? [{ message: stack }] : [];
  if (
    name === 'ExecutionTimeout' ||
    message === 'interrupted' ||
    message.includes('maximum allowed time limit')
  ) {
    return new ProjectionError(
      'cap_exceeded',
      `Execution exceeded the wall-clock budget of ${caps.segmentWallClockMs} ms for this segment`,
      {
        diagnostics,
        hint: 'Remove long or unbounded loops; heavy work must happen through tool calls, not in-machine computation',
        logs,
      },
    );
  }
  if (/out of memory/i.test(message)) {
    return new ProjectionError(
      'cap_exceeded',
      `Execution exceeded the memory limit of ${caps.wasmMemoryBytes} bytes`,
      {
        diagnostics,
        hint: 'Keep machine context small; avoid accumulating large arrays or strings in the sandbox',
        logs,
      },
    );
  }
  if (message.includes(DENIED_IMPORT_MARKER) || message.includes('not installed or available')) {
    return new ProjectionError('validate', message, {
      diagnostics,
      hint: `Only '${XSTATE_SPECIFIER}' and '${TOOLS_SPECIFIER}' can be imported; there is no filesystem or network access`,
      logs,
    });
  }
  if (response.isSyntaxError === true || name === 'SyntaxError') {
    return new ProjectionError('validate', `${name}: ${message}`, {
      diagnostics,
      hint: 'Fix the JavaScript syntax error shown in diagnostics',
      logs,
    });
  }
  return new ProjectionError('runtime', `${name}: ${message}`, {
    diagnostics,
    hint: 'Uncaught error inside the sandbox; see diagnostics and logs, correct the code, and retry',
    logs,
  });
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** No-op sink for console methods that are captured nowhere (R31 covers five levels). */
const silent = (): void => {};

/**
 * Create a sandbox session: boot a fresh QuickJS VM, mount xstate and the
 * bridge, evaluate the authored module, and return a handle for driving it.
 * See ./index.ts for the full boundary contract.
 */
export async function createSandboxSession(
  options: SandboxSessionOptions,
): Promise<SandboxSession> {
  const caps = clampCaps(options.caps ?? {});
  const segment = options.segment ?? 0;
  const lang = options.lang ?? 'js';

  const codeBytes = utf8Length(options.code);
  if (codeBytes > caps.maxCodeBytes) {
    throw new ProjectionError(
      'cap_exceeded',
      `Submitted code is ${codeBytes} bytes; the maximum is ${caps.maxCodeBytes} bytes`,
      {
        hint: 'Shrink the machine: remove comments and dead states, and keep large data out of the source',
      },
    );
  }

  const machineJs =
    lang === 'ts' ? await transpileTs(options.code, '/src/machine.ts') : options.code;
  // The bridge is library/typegen-supplied and invariant across every segment
  // of a workflow, so its transpile output is cached by source (a plain-JS
  // bridge passes through unchanged). Only the machine code varies per call.
  let bridgeJs: string;
  try {
    bridgeJs = await transpileBridge(options.bridgeSource);
  } catch (error) {
    // Transpiler-availability failures (typescript missing or incompatible)
    // are environment diagnostics, not a bad bridgeSource — pass them
    // through so the consumer sees the real cause and its fix hint.
    if (error instanceof TranspilerUnavailableError) throw error;
    if (error instanceof ProjectionError && error.phase === 'transpile') {
      throw new ProjectionError(
        'runtime',
        'The @astral-mcp/tools bridge module failed to transpile',
        {
          diagnostics: error.diagnostics,
          hint: 'The bridgeSource passed to createSandboxSession is invalid; this is an integration bug, not a model error',
          cause: error,
        },
      );
    }
    throw error;
  }

  const logs = new LogCollector(caps.maxConsoleBytes, segment);
  const capture =
    (level: 'log' | 'info' | 'warn' | 'error' | 'debug') =>
    (...params: unknown[]) => {
      logs.push(level, params);
    };

  const onToolCall = options.onToolCall;
  const sandboxOptions: SandboxOptions = {
    // Hard caps (R12/R13). The wall-clock budget is enforced by a QuickJS
    // interrupt handler installed by the runtime, with an absolute deadline
    // of `now + segmentWallClockMs` at session creation.
    executionTimeout: caps.segmentWallClockMs,
    memoryLimit: caps.wasmMemoryBytes,
    // N3/R11 invariant: `allowFetch` and `allowFs` are never set — they
    // default to disabled and this options object is built here, never from
    // caller input. The boot script below additionally deletes the `fetch`
    // global stub.
    mountFs: { src: { 'machine.js': machineJs } },
    nodeModules: buildNodeModulesMount(bridgeJs),
    modulePathNormalizer,
    getModuleLoader: getSandboxModuleLoader,
    env: {
      [TOOL_CALL_BINDING]: (name: unknown, args: unknown) => {
        const call: SandboxToolCall = {
          name: typeof name === 'string' ? name : String(name),
          args:
            typeof args === 'object' && args !== null && !Array.isArray(args)
              ? (args as Record<string, unknown>)
              : {},
        };
        return Promise.resolve(onToolCall(call));
      },
    },
    console: {
      log: capture('log'),
      info: capture('info'),
      warn: capture('warn'),
      error: capture('error'),
      debug: capture('debug'),
      trace: capture('debug'),
      assert: (condition?: boolean, ...data: unknown[]) => {
        if (condition !== true) {
          logs.push('error', ['Assertion failed:', ...data]);
        }
      },
      dir: capture('log'),
      table: capture('log'),
      count: silent,
      countReset: silent,
      dirxml: silent,
      group: silent,
      groupCollapsed: silent,
      groupEnd: silent,
      time: silent,
      timeEnd: silent,
      timeLog: silent,
      clear: silent,
    },
  };

  const runtime = await getQuickJs();

  // Absolute segment deadline (R13). The QuickJS interrupt handler enforces
  // it inside the VM; this host-side copy makes post-deadline `evaluate`
  // calls fail deterministically even when a script is too short to hit an
  // interrupt check.
  const deadlineAt = Date.now() + caps.segmentWallClockMs;

  const ready = deferred<{ evalCode: SandboxEvalCode }>();
  const hold = deferred<void>();
  let disposed = false;

  const runPromise = runtime.runSandboxed(async ({ evalCode }) => {
    ready.resolve({ evalCode });
    await hold.promise;
  }, sandboxOptions);
  // The run promise is also awaited in dispose(); avoid unhandled rejections.
  runPromise.catch(() => {});

  const { evalCode } = await Promise.race([
    ready.promise,
    runPromise.then(() => {
      throw new ProjectionError('runtime', 'QuickJS sandbox terminated during startup', {
        hint: 'This is a sandbox runtime bug; check the host logs',
        logs: logs.snapshot(),
      });
    }),
  ]);

  const dispose = async (): Promise<void> => {
    if (!disposed) {
      disposed = true;
      hold.resolve();
      await runPromise.catch(() => {});
    }
  };

  // Serialize all VM entries: QuickJS contexts are single-threaded and the
  // eval helper is not reentrant.
  let queue: Promise<unknown> = Promise.resolve();
  let evalCounter = 0;
  const runInVm = (source: string): Promise<unknown> => {
    const task = async (): Promise<unknown> => {
      if (disposed) {
        throw new ProjectionError('runtime', 'Sandbox session already disposed', {
          hint: 'Create a new session for each execution segment',
        });
      }
      if (Date.now() >= deadlineAt) {
        throw new ProjectionError(
          'cap_exceeded',
          `Execution exceeded the wall-clock budget of ${caps.segmentWallClockMs} ms for this segment`,
          {
            hint: 'The segment budget is spent; a fresh session (MRTR resume) gets a fresh budget',
            logs: logs.snapshot(),
          },
        );
      }
      const filename = `/src/__projection_eval_${evalCounter++}__.js`;
      const result = await evalCode(source, filename);
      if (!result.ok) {
        throw classifyEvalError(result, caps, logs.snapshot());
      }
      return result.data;
    };
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // Boot: harden globals first (N3) — a separate eval, because ESM imports
  // are hoisted and would otherwise run the authored module before the
  // hardening statements. Then evaluate the authored module (R10) and publish
  // its namespace at `globalThis.__projection.module`.
  //
  // S1 note on `process`: the QuickJS provider injects a `process` global
  // whose `process.env` is the `env` binding object built at `env:` above —
  // it holds ONLY `__projection_toolCall` and never any host environment
  // variable (verified: PATH/HOME and planted canaries are absent in-VM). It
  // is deliberately not deleted here because that same object is how the
  // tools bridge reaches the host (the sole I/O channel). Any change to the
  // `env:` option below MUST keep it to the tool-call binding alone; adding
  // host-derived entries would leak them into authored code through
  // `process.env`.
  try {
    await runInVm(`delete globalThis.fetch; export default null;`);
    await runInVm(
      `import * as mod from './machine.js';
       globalThis.${SANDBOX_GLOBAL} = { module: mod, state: {} };
       export default null;`,
    );
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    caps,
    segment,
    evaluate: runInVm,
    getLogs: () => logs.snapshot(),
    dispose,
  };
}
