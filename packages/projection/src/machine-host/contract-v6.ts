/**
 * The authoring contract for the EXPERIMENTAL XState v6 runtime
 * (`WrapOptions.xstate: 6`): the in-VM `toolCall` family and the text a
 * model reads. The v5 contract (`contract.ts`) is unchanged and remains the
 * default.
 *
 * v6 makes transitions pure: entry, exit and transition functions compute a
 * result, and side effects go through the `enq` queue XState passes them.
 * XState may run those functions more than once (a probe snapshot, a
 * rejected transition), so a v6 `toolCall` resolves its arguments while the
 * function runs but only *registers* the request from an `enq`'d effect,
 * which XState runs exactly once, when the transition is taken. The v5
 * `toolCall` pushes immediately and would be wrong here.
 *
 * Routing a result to the state waiting for it uses v6's declarative
 * `matches` (a shallow payload pattern on any event) instead of guard
 * functions: `{ matches: { callId: 'a' }, target: 'done' }` keeps the
 * transition a plain object, so its target stays visible to static
 * analysis. Calls made by `toolCalls(…, { id })` carry `batch: id` on their
 * events (added by the v6 send driver) so a batch is matched the same way.
 */

import type { XStateMajor } from '../blob/versions.js';
import { DEFAULT_CAPS } from '../types.js';
import { SAMPLE_NAMES_NOTE, sampleNote, type ToolSamples } from './contract.js';

/** Prelude + v6 `toolCall` family, appended to the generated bridge. */
export const TOOL_CALL_MODULE_SOURCE_V6 = `
// --- Projection machine-host prelude (XState v6) -----------------------
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

function __projArgs(label, args, actionArgs) {
  let resolved;
  if (typeof args === 'function') {
    if (actionArgs === undefined) {
      throw new Error(label + ': inside enq(...) pass the arguments as a plain object, e.g. enq(toolCall(name, { path: context.path })); a function of { context, event } only works when toolCall(...) is itself the entry or transition');
    }
    try {
      resolved = args(actionArgs);
    } catch (err) {
      throw new Error(label + ' argument function threw: ' + String(err));
    }
  } else {
    resolved = args;
  }
  return resolved;
}

function __projPlain(label, value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' arguments must resolve to a plain object');
  }
  return value;
}

/**
 * Request a tool call.
 *
 *   entry: toolCall('write_file', ({ context }) => ({ path: context.path }))
 *   // or, inside your own entry/transition function:
 *   (args, enq) => { enq(toolCall('write_file', { path: args.context.path })); return { target: 'saving' }; }
 *
 * @param name  Tool name exactly as catalogued.
 * @param args  Plain object, or (as an entry/transition only) a function of
 *              { context, event } returning one.
 * @param options  Optional { id }: the callId of the resulting event, matched
 *              with matches: { callId: id }. Default '<name>#<n>'.
 */
export function toolCall(name, args, options) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('toolCall(name, args): name must be a non-empty tool name string');
  }
  const label = 'toolCall("' + name + '")';
  const id = options && options.id !== undefined ? String(options.id) : undefined;
  if (id !== undefined && id.indexOf('*') !== -1) {
    throw new Error(label + ': the id ' + JSON.stringify(id) + ' contains "*", which is reserved for toolCalls batches');
  }
  const register = function (resolved) {
    __projSeq += 1;
    __projQueue().push({ id: id !== undefined ? id : name + '#' + __projSeq, name: name, args: resolved });
  };
  return function projectionToolCall(actionArgs, enq) {
    const resolved = __projPlain(label, __projArgs(label, args, actionArgs));
    if (typeof enq === 'function') {
      // Used as an entry or transition: register when XState runs the effect.
      enq(function () { register(resolved); });
      return undefined;
    }
    // Queued by the author with enq(toolCall(...)): this IS the effect.
    register(resolved);
    return undefined;
  };
}

/**
 * Request one call of the same tool per item, all at once: the gated ones
 * share ONE approval round trip. Every event of the batch carries
 * batch: id (default: the tool name); select them with matches: { batch: id }
 * and tell the items apart by event.args. An empty list requests nothing.
 *
 *   entry: toolCalls('write_file', ({ context }) => context.paths.map((path) => ({ path })), { id: 'w' })
 */
export function toolCalls(name, argsList, options) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('toolCalls(name, argsList): name must be a non-empty tool name string');
  }
  const label = 'toolCalls("' + name + '")';
  const prefix = options && options.id !== undefined ? String(options.id) : name;
  if (prefix.indexOf('*') !== -1) {
    throw new Error(label + ': the id ' + JSON.stringify(prefix) + ' must not contain "*"');
  }
  const register = function (calls) {
    const queue = __projQueue();
    for (const call of calls) queue.push(call);
  };
  return function projectionToolCalls(actionArgs, enq) {
    const list = __projArgs(label, argsList, actionArgs);
    if (!Array.isArray(list)) {
      throw new Error(label + ' argsList must resolve to an array of plain objects');
    }
    const calls = [];
    for (let i = 0; i < list.length; i += 1) {
      calls.push({ id: prefix + '*' + i, name: name, args: __projPlain(label + ' item ' + i, list[i]) });
    }
    if (typeof enq === 'function') {
      enq(function () { register(calls); });
      return undefined;
    }
    register(calls);
    return undefined;
  };
}

/**
 * Predicate for use INSIDE a transition function, when matches: { callId }
 * is not enough: whenCall('a')({ event }) is true for call 'a's events.
 */
export function whenCall(id) {
  const wanted = String(id);
  return function projectionWhenCall(args) {
    const event = args && args.event;
    return Boolean(event) && event.callId === wanted;
  };
}

/** Predicate: true for the events of toolCalls(name, list, { id }). Prefer matches: { batch: id }. */
export function whenCallIn(id) {
  const wanted = String(id);
  return function projectionWhenCallIn(args) {
    const event = args && args.event;
    return Boolean(event) && event.batch === wanted;
  };
}
`;

/**
 * The v6 authoring contract a model reads (R3): same rules and events as
 * v5, written for v6, and led by the v5 habits that fail under v6 — the
 * models writing these machines have seen far more v5 than v6.
 */
export function authoringContractV6(
  samples?: ToolSamples,
  maxRoundTrips: number = DEFAULT_CAPS.maxRoundTrips,
): string {
  const read = samples?.read ?? { name: 'read_file', placeholder: false };
  const gated = samples?.gated ?? { name: 'write_file', placeholder: false };
  const qualifiedRule =
    samples === undefined
      ? ''
      : `11. Tool names on this server are qualified: <box>.<tool>. Each box's tools
    sit under tools.<box> in tools.d.ts; pass the qualified name to toolCall,
    e.g. toolCall('${read.name}', ...) ${SAMPLE_NAMES_NOTE}.
    An unqualified name is rejected. One machine may call tools in several
    boxes; every call that asks for approval is approved on its own.
`;
  return `Projection authoring contract (execute_machine) — XState v6

Write ONE module whose only top-level statements are imports and a single
default-exported XState v6 machine. The module is re-evaluated on every
approval round trip, so top-level side effects are rejected.

  import { setup } from 'xstate';
  import { toolCall } from '@astral-mcp/tools';

  export default setup({}).createMachine({ /* ... */ });

This server runs XState v6, NOT v5. These v5 habits throw here:
  v5 (rejected)                          v6 (write this)
  on: { GO: 'next' }                     on: { GO: { target: 'next' } }
  actions: assign({ n: ... })            context: ({ context, event }) => ({ n: ... })
  guard: ...  or  GO: [ {...}, {...} ]   GO: ({ context, event }) => cond ? { target: 'a' } : { target: 'b' }
  entry: [a, b]  or  entry: 'name'       entry: ({ context }, enq) => { ... }   (one function)
  assign raise sendTo enqueueActions     not exported: return { context }, use enq.raise(...)
  and() or() not() stateIn()             plain && || ! inside the function
  context.items.push(x)                  return { context: { items: [...context.items, x] } }

Rules:
1. Default-export a machine built with setup({}).createMachine({ ... }).
2. Context must be JSON-serializable at all times. No Map, Set, Date, class
   instances, functions, undefined, bigint or symbols in context. Context is
   frozen: never modify it in place; return a patch.
3. A transition is an object or one function:
     { target?, context?, matches? }
       context: a patch object, or ({ context, event }) => patch. A patch is
       merged shallowly: { ...context, ...patch }.
       matches: an event-payload pattern, e.g. { callId: 'a' }; the
       transition only applies to events whose fields equal it.
     ({ context, event }, enq) => ({ target?, context? }) or undefined
       Return undefined (before calling enq) to ignore the event.
   One transition per event; there is no guard key. always (eventless) takes
   the same object or function.
4. Request tools with toolCall. Make it the state's entry —
     entry: toolCall('${read.name}', ({ context }) => ({ path: context.path })),${sampleNote(read)}
   — or queue it from your own entry/transition function with a plain object:
     ({ context }, enq) => { enq(toolCall('${read.name}', { path: context.path })); return { target: 'reading' }; }${sampleNote(read)}
   NEVER wrap a tool call in createAsyncLogic/invoke — restored snapshots
   restart invoked actors, which would re-execute an approved write.
   Machines using invoke are rejected.
5. After a toolCall, wait in a state for one of these events:
     TOOL_RESULT { callId, args, result, notes? }  succeeded
     TOOL_ERROR  { callId, args, error }           failed
     TOOL_DENIED { callId, args, reason }          the user declined, or policy denies it
   args: the call's own arguments — match a result to its item by them, not
   by order or id. notes, if any, say the result looks partial.
   Denial is not an abort: handle TOOL_DENIED and continue or finish.
   IMPORTANT: if your machine has more than one call outstanding at the same
   time (parallel regions), give each toolCall an explicit id and select its
   events with matches — events reach every region that can handle them, so
   an unmatched region will consume another call's result:

     entry: toolCall('${gated.name}', () => ({ path: '/a' }), { id: 'a' }),${sampleNote(gated)}
     on: { TOOL_RESULT: { matches: { callId: 'a' }, target: 'done' } },
6. Tools marked "asks for approval" pause the machine for user approval;
   tools marked "runs immediately" do not. The arguments captured at that
   moment are the arguments that execute. Each pause is one approval round
   trip and a workflow gets at most ${maxRoundTrips}: one gated call per item, each in
   its own state, stops unfinished past ${maxRoundTrips} items. Make them together with
   toolCalls (one round trip for all); every event of the batch carries
   batch: <id>. An empty list makes no calls; always leaves at once:

     import { toolCalls } from '@astral-mcp/tools';
     // context: ({ input }) => ({ paths: input.paths, seen: [] })
     writing: {
       entry: toolCalls('${gated.name}', ({ context }) => context.paths.map((path) => ({ path, content: 'hello' })), { id: 'w' }),${sampleNote(gated)}
       always: ({ context }) => (context.seen.length === context.paths.length ? { target: 'done' } : undefined),
       on: {
         TOOL_RESULT: { matches: { batch: 'w' }, context: ({ context, event }) => ({ seen: [...context.seen, [event.args.path, event.type]] }) },
         TOOL_DENIED: { matches: { batch: 'w' }, context: ({ context, event }) => ({ seen: [...context.seen, [event.args.path, event.type]] }) },
         TOOL_ERROR: { matches: { batch: 'w' }, context: ({ context, event }) => ({ seen: [...context.seen, [event.args.path, event.type]] }) },
       },
     },
7. Only 'xstate' and '@astral-mcp/tools' resolve as imports. There is no
   filesystem, no network, no fetch. All working state lives in context.
8. Finish by reaching a final state. Use the machine's output for the result.
9. TOOL_RESULT.result is the tool's structuredContent when the server returns
   one (see its Output type in tools.d.ts); otherwise the text of its single
   text block — already parsed when that text is JSON for an object or an
   array (the raw text is then event.text) — null for an empty result, or
   the raw content array for anything else. A tool that returns isError
   arrives as TOOL_ERROR. Tools without an Output type are typed unknown,
   and that does not mean text: many servers return an object without
   declaring it. Never parse a result you have not seen: run the read on
   its own first (call_tool, or a machine whose output is event.result)
   and write the machine against the shape it returns.
10. Tool inputs such as paths, ids and names are server-specific. Do not guess
   them: take them from the machine's input, or discover them first with a
   read-only call (a list/search tool) and keep what you learn in context.
${qualifiedRule}
Example — happy path with a read-only call (run with input: { path }):

  import { setup } from 'xstate';
  import { toolCall } from '@astral-mcp/tools';

  export default setup({}).createMachine({
    id: 'readOne',
    context: ({ input }) => ({ path: input.path, result: null }),
    initial: 'reading',
    states: {
      reading: {
        entry: toolCall('${read.name}', ({ context }) => ({ path: context.path })),${sampleNote(read)}
        on: {
          TOOL_RESULT: { target: 'done', context: ({ event }) => ({ result: event.result }) },
          TOOL_ERROR: { target: 'failed' },
        },
      },
      done: { type: 'final' },
      failed: { type: 'final' },
    },
    output: ({ context }) => ({ result: context.result }),
  });

Example — handling a denied approval (run with input: { path }):

  import { setup } from 'xstate';
  import { toolCall } from '@astral-mcp/tools';

  export default setup({}).createMachine({
    id: 'writeOne',
    context: ({ input }) => ({ path: input.path, status: 'pending' }),
    initial: 'writing',
    states: {
      writing: {
        entry: toolCall('${gated.name}', ({ context }) => ({ path: context.path, content: 'hello' })),${sampleNote(gated)}
        on: {
          TOOL_RESULT: { target: 'done', context: { status: 'written' } },
          TOOL_DENIED: { target: 'done', context: { status: 'skipped' } },
          TOOL_ERROR: { target: 'done', context: { status: 'failed' } },
        },
      },
      done: { type: 'final' },
    },
    output: ({ context }) => ({ status: context.status }),
  });
`;
}

/** The v6 happy-path example resource (`happy-path.ts`). */
export function exampleHappyPathV6(samples?: ToolSamples): string {
  const read = samples?.read ?? { name: 'read_file', placeholder: false };
  return `import { setup } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

// XState v6. Read a file and return the tool's result. Read-only calls run
// immediately, so this whole machine completes in one round trip.
//
// Run it with input: { path } — paths are server-specific, so take them
// from the input or from an earlier read-only listing call, never guess.
export default setup({}).createMachine({
  id: 'readOne',
  context: ({ input }) => ({ path: input.path, result: null, error: null }),
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('${read.name}', ({ context }) => ({ path: context.path })),${sampleNote(read)}
      on: {
        // event.result is the tool's structuredContent when the server
        // returns one (see its Output type in tools.d.ts); otherwise the
        // text of its single text block (parsed when it is JSON for an
        // object or array), null when empty, or the raw content array.
        // isError results arrive as TOOL_ERROR instead.
        TOOL_RESULT: { target: 'done', context: ({ event }) => ({ result: event.result }) },
        TOOL_ERROR: { target: 'failed', context: ({ event }) => ({ error: event.error.message }) },
      },
    },
    done: { type: 'final' },
    failed: { type: 'final' },
  },
  output: ({ context }) => ({ result: context.result, error: context.error }),
});
`;
}

/** The v6 denial-fallback example resource (`denial-fallback.ts`). */
export function exampleDenialFallbackV6(samples?: ToolSamples): string {
  const gated = samples?.gated ?? { name: 'write_file', placeholder: false };
  const list = samples?.list ?? { name: 'list_dir', placeholder: false };
  return `import { setup } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

// XState v6. Write a file, but keep going if the user declines. TOOL_DENIED
// is an ordinary transition — denial is never an automatic abort.
//
// Run it with input: { path, dir } — both are server-specific.
export default setup({}).createMachine({
  id: 'writeWithFallback',
  context: ({ input }) => ({ path: input.path, dir: input.dir, status: 'pending', note: null }),
  initial: 'writing',
  states: {
    writing: {
      entry: toolCall('${gated.name}', ({ context }) => ({ path: context.path, content: 'hello' })),${sampleNote(gated)}
      on: {
        TOOL_RESULT: { target: 'summarizing', context: { status: 'written' } },
        // The user said no: record it and carry on with the read-only part
        // of the work instead of failing the whole workflow.
        TOOL_DENIED: {
          target: 'summarizing',
          context: ({ event }) => ({ status: 'skipped', note: event.reason ?? 'declined by user' }),
        },
        TOOL_ERROR: { target: 'summarizing', context: { status: 'failed' } },
      },
    },
    summarizing: {
      entry: toolCall('${list.name}', ({ context }) => ({ path: context.dir })),${sampleNote(list)}
      on: {
        TOOL_RESULT: { target: 'done' },
        TOOL_ERROR: { target: 'done' },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status, note: context.note }),
});
`;
}

/** What to write instead of each v5 export a model is likely to import. */
const V5_EXPORTS: Readonly<Record<string, string>> = {
  assign:
    "Return a context patch instead: TOOL_RESULT: { target: 'done', context: ({ context, event }) => ({ result: event.result }) }.",
  enqueueActions:
    'Write one function instead: (args, enq) => { ...; return { target, context }; }.',
  raise: 'Use enq.raise(event) inside a function (args, enq) => { ... }.',
  sendTo: 'Use enq.sendTo(ref, event) inside a function (args, enq) => { ... }.',
  sendParent: 'Use enq.sendTo(parent, event) inside a function (args, enq) => { ... }.',
  forwardTo: 'Use enq.sendTo(ref, event) inside a function (args, enq) => { ... }.',
  emit: 'Use enq.emit(event) inside a function (args, enq) => { ... }.',
  log: 'Use enq.log(...) inside a function (args, enq) => { ... }, or console.log.',
  cancel: 'Use enq.cancel(id) inside a function (args, enq) => { ... }.',
  spawnChild: 'Use enq.spawn(logic, options) inside a function (args, enq) => { ... }.',
  stopChild: 'Use enq.stop(ref) inside a function (args, enq) => { ... }.',
  and: 'Write the condition with && inside a transition function, returning undefined to ignore the event.',
  or: 'Write the condition with || inside a transition function, returning undefined to ignore the event.',
  not: 'Write the condition with ! inside a transition function, returning undefined to ignore the event.',
  stateIn: "Use self.getSnapshot().matches('state') inside a transition function.",
  fromPromise:
    'Machines here never run promises: request tools with toolCall from @astral-mcp/tools and wait for TOOL_RESULT.',
  interpret: 'You do not create actors: default-export the machine and execute_machine runs it.',
};

/**
 * A fix hint for an error the v6 development build raises at an authored
 * machine, or undefined when the message is not one of them. v6 states the
 * problem precisely; the hint adds where this server's rules differ from v5.
 */
export function v6AuthoringHint(message: string): string | undefined {
  // `import { assign } from 'xstate'`: QuickJS reports the missing export
  // as a SyntaxError, which would otherwise be hinted as a syntax error.
  const missing =
    /Could not find export '([A-Za-z_$][\w$]*)' in module '[^']*\/xstate\/index\.js'/.exec(message);
  if (missing !== null) {
    const name = missing[1]!;
    const replacement = V5_EXPORTS[name];
    return replacement !== undefined
      ? `'${name}' is XState v5; this server runs XState v6, which does not export it. ${replacement} See the v5 → v6 table at the top of the authoring contract (discover_apis).`
      : `XState v6 does not export '${name}'. Import only setup (or createMachine) from 'xstate'; everything else a machine needs is in the transition shapes of the authoring contract (discover_apis).`;
  }
  if (
    /not extensible|read[- ]only property|Cannot assign to read only|object is frozen/i.test(
      message,
    )
  ) {
    return 'Context is frozen in XState v6: never modify it (push, splice, obj.x = ...). Return a patch instead, e.g. context: ({ context, event }) => ({ items: [...context.items, event.result] }).';
  }
  if (
    /which was removed|is not supported|is not exported|Use \{ target|codemod|does not provide an export named/i.test(
      message,
    )
  ) {
    return 'This server runs XState v6, not v5: transitions are objects { target, context, matches } or one function returning them; there is no assign, guard or actions. See the v5 → v6 table at the top of the authoring contract (discover_apis).';
  }
  return undefined;
}

/**
 * Library copy a model reads outside the contract (tool descriptions,
 * preambles, prompts) names XState v5 and its APIs; on a v6 facade it names
 * v6. The v5 text is returned unchanged, byte for byte.
 */
export function forXState(text: string, major: XStateMajor): string {
  if (major === 5) return text;
  return text
    .replaceAll('XState v5', 'XState v6')
    .replaceAll('invoke/fromPromise', 'invoke/createAsyncLogic')
    .replaceAll('fromPromise/invoke', 'createAsyncLogic/invoke');
}
