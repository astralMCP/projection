/**
 * Sandbox runtime — QuickJS WASM execution of LLM-authored machine modules
 * (PRD §7 "Sandbox runtime"; R8–R13, R31, N3, S1).
 *
 * This module is the boundary the **machine host** builds against. The
 * sandbox knows nothing about XState actors, validation rules, or the MRTR
 * flow — it provides an isolated VM with the authored module evaluated in it,
 * hard resource caps, structured logs, and a single host↔VM I/O channel for
 * tool calls.
 *
 * ## Boundary contract
 *
 * ### Creating a session
 *
 * ```ts
 * const session = await createSandboxSession({
 *   code,               // submitted module source (R2)
 *   lang: 'ts',         // 'ts' | 'js'; TS is transpiled, never type checked (R10)
 *   caps,               // Partial<ResourceCaps>, clamped via clampCaps (R12)
 *   bridgeSource,       // module source mounted at '@mccircuit/tools' (R8)
 *   onToolCall,         // host callback for bridge calls (S1)
 *   segment,            // zero-based MRTR segment index, stamped on logs (R31)
 * });
 * ```
 *
 * One session == one execution segment (R13): the wall-clock budget is an
 * absolute deadline of `segmentWallClockMs` from session creation, enforced
 * by a QuickJS interrupt handler *inside* the VM, so tight loops die at the
 * budget. Once the deadline passes, every further `evaluate` fails fast with
 * phase `cap_exceeded`. For an MRTR resume, create a fresh session (fresh
 * budget, fresh logs) and re-evaluate the re-sent code.
 *
 * `createSandboxSession` itself evaluates the authored module. It rejects
 * with {@link McCircuitError} (logs attached) when the code is oversized
 * (`cap_exceeded`), fails TS transpilation (`transpile`), has a syntax error
 * or a disallowed import (`validate`), or throws at module top level
 * (`runtime`).
 *
 * ### What the VM looks like from inside
 *
 * - The authored module is mounted at `/src/machine.js` (TS already
 *   transpiled) and evaluated once at session creation. Its module namespace
 *   is published at `globalThis.__mccircuit.module` (so the default export —
 *   the machine — is `globalThis.__mccircuit.module.default`).
 * - `globalThis.__mccircuit.state` is an empty object reserved for driver
 *   code to persist values across `evaluate` calls (e.g. the running actor).
 * - Imports resolve for exactly `xstate` (pinned v5 build) and
 *   `@mccircuit/tools` (the caller-supplied bridge). Anything else —
 *   `node:fs`, `http`, arbitrary packages — fails with a structured
 *   `validate` error (R8, R9).
 * - There is no `fetch` global and no configuration that can introduce one
 *   (R11/N3), and no filesystem or environment access from authored code.
 *   The only I/O channel is the tool-call binding below (S1).
 * - `console.log/info/warn/error/debug` (plus `trace`→debug, `assert`→error,
 *   `dir`/`table`→log) are captured as {@link LogEntry} structures; nothing
 *   reaches the host console (R31).
 *
 * ### Driving the VM: `session.evaluate(source)`
 *
 * `evaluate` runs `source` as an ESM module inside the VM and resolves with
 * the module's **default export**, marshaled to the host (a promise default
 * export is awaited; values must be JSON-serializable). Driver modules can
 * import `xstate`, read `globalThis.__mccircuit`, and stash state:
 *
 * ```ts
 * const snapshot = await session.evaluate(`
 *   import { createActor } from 'xstate';
 *   const actor = createActor(globalThis.__mccircuit.module.default);
 *   actor.start();
 *   globalThis.__mccircuit.state.actor = actor;
 *   export default actor.getPersistedSnapshot();
 * `);
 * ```
 *
 * Calls are serialized internally (the VM is single-threaded); issue them
 * sequentially. Failures reject with {@link McCircuitError}: phase
 * `cap_exceeded` for wall-clock/memory, `validate` for syntax/denied imports,
 * `runtime` for everything else — always with `hint` and current `logs`.
 *
 * ### Tool-call bridging (host ↔ VM)
 *
 * The bridge module mounted at `@mccircuit/tools` reaches the host through
 * one binding: `env.__mccircuit_toolCall(name, args)` (see
 * {@link TOOL_CALL_BINDING}) which returns a promise. Every such call invokes
 * the session's `onToolCall({ name, args })`; the handler's (awaited) return
 * value resolves the in-VM promise, and a thrown/rejected error rejects it.
 * The sandbox imposes no protocol on the payload — encoding results, errors,
 * and denials as `TOOL_RESULT`/`TOOL_ERROR`/`TOOL_DENIED` events is the
 * machine host's job (R7/R17). A minimal bridge therefore looks like:
 *
 * ```js
 * export async function callTool(name, args) {
 *   return await env.__mccircuit_toolCall(name, args ?? {});
 * }
 * ```
 *
 * Bridge promises still pending when the session is disposed (e.g. a gated
 * call that suspended the workflow) are rejected inside the VM during
 * teardown; the machine host should not resolve them across segments —
 * verdict events are delivered to a *new* session after rehydration.
 *
 * ### Logs and teardown
 *
 * `getLogs()` returns the entries captured so far this segment (available
 * after dispose too), truncated to `maxConsoleBytes` with a drop-middle
 * marker entry (R31/R12). `dispose()` tears the VM down and is idempotent;
 * call it exactly when the segment ends (completion, suspension, or error).
 *
 * ### Caps enforced here vs. elsewhere
 *
 * Enforced by this module: `segmentWallClockMs` (in-VM interrupt),
 * `wasmMemoryBytes` (QuickJS memory limit), `maxCodeBytes` (pre-eval check),
 * `maxConsoleBytes` (log truncation). The remaining R12 caps (tool-call
 * counts, event counts, round trips, result size, state-node count) are the
 * machine host / MRTR adapter's responsibility.
 */

export {
  createSandboxSession,
  SANDBOX_GLOBAL,
  TOOL_CALL_BINDING,
  type SandboxSession,
  type SandboxSessionOptions,
  type SandboxToolCall,
  type SandboxToolCallHandler,
} from './session.js';
export { AUTHORED_MODULE_PATH, TOOLS_SPECIFIER, XSTATE_SPECIFIER } from './mounts.js';
export { TRUNCATION_MARKER_PREFIX } from './logs.js';
