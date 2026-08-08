/**
 * The authoring contract (PRD R5–R8) — the exact surface an LLM-authored
 * machine module may use, and the in-VM code implementing it.
 *
 * The module source here is appended to the typegen-generated bridge and
 * mounted together at `@mccircuit/tools`, so an authored module writes:
 *
 * ```ts
 * import { setup } from 'xstate';
 * import { toolCall } from '@mccircuit/tools';
 * ```
 *
 * `toolCall` is the ONLY supported way to reach a tool (R7). It returns an
 * ordinary XState action function, so the machine never models a tool call
 * as an invoked promise actor — restoring a snapshot restarts invoked
 * actors, which would re-execute an already-approved write.
 */

/**
 * Prelude + `toolCall` implementation, appended to the generated bridge.
 *
 * `toolCall` pushes a request onto an in-VM queue that the host drains after
 * the actor settles. It is deliberately synchronous and promise-free: the
 * machine records *that* it wants a call, and the host — never the machine —
 * performs the I/O and injects the result as an event (R7, S1).
 *
 * The generated bridge's `tools.<name>(args)` functions reach the host
 * through the sandbox's `env` binding; the shim below wires the global the
 * bridge expects to that binding. Calling `tools.<name>()` directly also
 * registers a gated request, but the returned promise is never resolved
 * within the segment — awaiting it is the banned pattern. Author with
 * `toolCall`.
 */
export const TOOL_CALL_MODULE_SOURCE = `
// --- McCircuit machine-host prelude -----------------------------------
// Bind the generated bridge's host hook to the sandbox env binding.
if (typeof globalThis.__mccircuit_toolcall !== 'function') {
  globalThis.__mccircuit_toolcall = function (name, args) {
    return env.__mccircuit_toolCall(name, args);
  };
}

function __mccQueue() {
  const state = globalThis.__mccircuit.state;
  if (!state.queue) state.queue = [];
  return state.queue;
}

let __mccSeq = 0;

/**
 * Request a tool call from a machine action.
 *
 *   entry: toolCall('write_file', ({ context }) => ({ path: context.path }))
 *
 * @param name  Tool name exactly as catalogued.
 * @param args  Plain object, or a function of the XState action arguments
 *              ({ context, event }) returning one.
 * @param options  Optional { id } to correlate the resulting event; a
 *              stable id is generated when omitted.
 */
export function toolCall(name, args, options) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('toolCall(name, args): name must be a non-empty tool name string');
  }
  return function mccircuitToolCall(actionArgs) {
    let resolved;
    try {
      resolved = typeof args === 'function' ? args(actionArgs) : args;
    } catch (err) {
      throw new Error('toolCall("' + name + '") argument function threw: ' + String(err));
    }
    if (resolved === undefined || resolved === null) resolved = {};
    if (typeof resolved !== 'object' || Array.isArray(resolved)) {
      throw new Error('toolCall("' + name + '") arguments must resolve to a plain object');
    }
    __mccSeq += 1;
    const id = options && options.id !== undefined ? String(options.id) : name + '#' + __mccSeq;
    __mccQueue().push({ id: id, name: name, args: resolved });
  };
}

/**
 * Guard matching the event for one specific call id.
 *
 * XState delivers an event to every region that can handle it, so a machine
 * with two calls outstanding at once (parallel regions) MUST guard each
 * waiting state — otherwise one region consumes the other's result and the
 * machine records an approved write against the wrong branch.
 *
 *   on: { TOOL_RESULT: { guard: whenCall('a'), target: 'done' } }
 */
export function whenCall(id) {
  const wanted = String(id);
  return function mccircuitWhenCall(guardArgs) {
    const event = guardArgs && guardArgs.event;
    return Boolean(event) && event.callId === wanted;
  };
}
`;

/**
 * Human-readable authoring contract. `discover_apis` publishes this inline
 * (R3) so a model can author a valid machine without fetching resources.
 */
export const AUTHORING_CONTRACT = `McCircuit authoring contract (execute_machine)

Write ONE module whose only top-level statements are imports and a single
default-exported XState v5 machine. The module is re-evaluated on every
approval round trip, so top-level side effects are rejected.

  import { setup } from 'xstate';
  import { toolCall } from '@mccircuit/tools';

  export default setup({}).createMachine({ /* ... */ });

Rules:
1. Default-export a machine built with XState v5 setup(...).createMachine(...).
   XState v4 Machine(...) is rejected.
2. Machine context must be JSON-serializable at all times. No Map, Set, Date,
   class instances, functions, undefined, bigint or symbols in context.
3. Request tools with the toolCall action. NEVER wrap a tool call in
   fromPromise/invoke — restored snapshots restart invoked actors, which
   would re-execute an approved write. Machines using invoke are rejected.
4. After a toolCall, wait in a state for one of these events:
     TOOL_RESULT { callId, result }   the call succeeded
     TOOL_ERROR  { callId, error }    the call failed
     TOOL_DENIED { callId, reason }   the user declined, or policy denies it
   Denial is not an abort: handle TOOL_DENIED and continue or finish.
   IMPORTANT: if your machine has more than one call outstanding at the same
   time (parallel regions), give each toolCall an explicit id and guard every
   waiting state with whenCall(id) — events reach every region that can
   handle them, so an unguarded region will consume another call's result:

     import { toolCall, whenCall } from '@mccircuit/tools';
     entry: toolCall('write_file', () => ({ path: '/a' }), { id: 'a' }),
     on: { TOOL_RESULT: { guard: whenCall('a'), target: 'done' } },
5. Read-only tools run immediately. Every other tool pauses the machine for
   user approval; the arguments captured at that moment are the arguments
   that execute.
6. Only 'xstate' and '@mccircuit/tools' resolve as imports. There is no
   filesystem, no network, no fetch. All working state lives in context.
7. Finish by reaching a final state. Use the machine's output for the result.

Example — happy path with a read-only call:

  import { setup, assign } from 'xstate';
  import { toolCall } from '@mccircuit/tools';

  export default setup({}).createMachine({
    id: 'readNotes',
    context: ({ input }) => ({ path: input?.path ?? '/notes.txt', text: null }),
    initial: 'reading',
    states: {
      reading: {
        entry: toolCall('read_file', ({ context }) => ({ path: context.path })),
        on: {
          TOOL_RESULT: { target: 'done', actions: assign({ text: ({ event }) => event.result }) },
          TOOL_ERROR: 'failed',
        },
      },
      done: { type: 'final' },
      failed: { type: 'final' },
    },
    output: ({ context }) => ({ text: context.text }),
  });

Example — handling a denied approval:

  import { setup, assign } from 'xstate';
  import { toolCall } from '@mccircuit/tools';

  export default setup({}).createMachine({
    id: 'writeNotes',
    context: { status: 'pending' },
    initial: 'writing',
    states: {
      writing: {
        entry: toolCall('write_file', () => ({ path: '/notes.txt', content: 'hello' })),
        on: {
          TOOL_RESULT: { target: 'done', actions: assign({ status: 'written' }) },
          TOOL_DENIED: { target: 'done', actions: assign({ status: 'skipped' }) },
          TOOL_ERROR: { target: 'done', actions: assign({ status: 'failed' }) },
        },
      },
      done: { type: 'final' },
    },
    output: ({ context }) => ({ status: context.status }),
  });
`;
