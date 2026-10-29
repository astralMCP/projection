/**
 * The authoring contract (PRD R5–R8) — the exact surface an LLM-authored
 * machine module may use, and the in-VM code implementing it.
 *
 * The module source here is appended to the typegen-generated bridge and
 * mounted together at `@astral-mcp/tools`, so an authored module writes:
 *
 * ```ts
 * import { setup } from 'xstate';
 * import { toolCall } from '@astral-mcp/tools';
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
// --- Projection machine-host prelude -----------------------------------
// Bind the generated bridge's host hook to the sandbox env binding.
if (typeof globalThis.__projection_toolcall !== 'function') {
  globalThis.__projection_toolcall = function (name, args) {
    return env.__projection_toolCall(name, args);
  };
}

function __projQueue() {
  const state = globalThis.__projection.state;
  if (!state.queue) state.queue = [];
  return state.queue;
}

let __projSeq = 0;

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
  return function projectionToolCall(actionArgs) {
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
    __projSeq += 1;
    const id = options && options.id !== undefined ? String(options.id) : name + '#' + __projSeq;
    __projQueue().push({ id: id, name: name, args: resolved });
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
  return function projectionWhenCall(guardArgs) {
    const event = guardArgs && guardArgs.event;
    return Boolean(event) && event.callId === wanted;
  };
}
`;

/** One tool name a sample calls (R45), and whether the facade really serves it. */
export interface SampleTool {
  /** The qualified name: a real tool of the sample box, or a generic placeholder in it. */
  name: string;
  /** True when no suitable tool exists and `name` is a generic placeholder. */
  placeholder: boolean;
}

/**
 * The tool names a multi-server facade's samples call (R45), picked from
 * the first box's catalog (`mrtr/discover.ts` `toolSamples`).
 */
export interface ToolSamples {
  /** A tool that runs immediately: the happy path, and the denial example's follow-up. */
  read: SampleTool;
  /** A tool that asks for approval: the denial example. */
  gated: SampleTool;
  /** The denial example's follow-up listing call: `read`, or a placeholder. */
  list: SampleTool;
}

/** What the samples say about a name the facade does not serve. */
export const SAMPLE_NAMES_NOTE = '(sample names; use the names in tools.d.ts)';

/** The trailing comment a placeholder sample's `toolCall` line carries. */
export function sampleNote(sample: SampleTool): string {
  return sample.placeholder ? ` // ${SAMPLE_NAMES_NOTE}` : '';
}

/**
 * Human-readable authoring contract. `discover_apis` publishes this inline
 * (R3) so a model can author a valid machine without fetching resources.
 *
 * `samples` is set on a multi-server facade (R45): the samples call those
 * qualified names, a placeholder's line says so, and one rule is added —
 * tool names are qualified. Without it the text is the single-server
 * contract, byte for byte.
 */
export function authoringContract(samples?: ToolSamples): string {
  const read = samples?.read ?? { name: 'read_file', placeholder: false };
  const gated = samples?.gated ?? { name: 'write_file', placeholder: false };
  const qualifiedRule =
    samples === undefined
      ? ''
      : `10. Tool names on this server are qualified: <box>.<tool>. Each box's tools
    sit under tools.<box> in tools.d.ts; pass the qualified name to toolCall,
    e.g. toolCall('${read.name}', ...) ${SAMPLE_NAMES_NOTE}.
    An unqualified name is rejected. One machine may call tools in several
    boxes; every call that asks for approval is approved on its own.
`;
  return `Projection authoring contract (execute_machine)

Write ONE module whose only top-level statements are imports and a single
default-exported XState v5 machine. The module is re-evaluated on every
approval round trip, so top-level side effects are rejected.

  import { setup } from 'xstate';
  import { toolCall } from '@astral-mcp/tools';

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

     import { toolCall, whenCall } from '@astral-mcp/tools';
     entry: toolCall('${gated.name}', () => ({ path: '/a' }), { id: 'a' }),${sampleNote(gated)}
     on: { TOOL_RESULT: { guard: whenCall('a'), target: 'done' } },
5. Tools marked "asks for approval" pause the machine for user approval;
   tools marked "runs immediately" do not. The arguments captured at that
   moment are the arguments that execute.
6. Only 'xstate' and '@astral-mcp/tools' resolve as imports. There is no
   filesystem, no network, no fetch. All working state lives in context.
7. Finish by reaching a final state. Use the machine's output for the result.
8. TOOL_RESULT.result is the tool's structuredContent when the server returns
   one (see its Output type in tools.d.ts); otherwise the text of its single
   text block, null for an empty result, or the raw content array for
   anything else. A tool that returns isError arrives as TOOL_ERROR. Tools
   without an Output type are typed unknown — usually a string.
9. Tool inputs such as paths, ids and names are server-specific. Do not guess
   them: take them from the machine's input, or discover them first with a
   read-only call (a list/search tool) and keep what you learn in context.
${qualifiedRule}
Example — happy path with a read-only call (run with input: { path }):

  import { setup, assign } from 'xstate';
  import { toolCall } from '@astral-mcp/tools';

  export default setup({}).createMachine({
    id: 'readOne',
    context: ({ input }) => ({ path: input.path, result: null }),
    initial: 'reading',
    states: {
      reading: {
        entry: toolCall('${read.name}', ({ context }) => ({ path: context.path })),${sampleNote(read)}
        on: {
          TOOL_RESULT: { target: 'done', actions: assign({ result: ({ event }) => event.result }) },
          TOOL_ERROR: 'failed',
        },
      },
      done: { type: 'final' },
      failed: { type: 'final' },
    },
    output: ({ context }) => ({ result: context.result }),
  });

Example — handling a denied approval (run with input: { path }):

  import { setup, assign } from 'xstate';
  import { toolCall } from '@astral-mcp/tools';

  export default setup({}).createMachine({
    id: 'writeOne',
    context: ({ input }) => ({ path: input.path, status: 'pending' }),
    initial: 'writing',
    states: {
      writing: {
        entry: toolCall('${gated.name}', ({ context }) => ({ path: context.path, content: 'hello' })),${sampleNote(gated)}
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
}

/** The single-server authoring contract (R3). */
export const AUTHORING_CONTRACT = authoringContract();
