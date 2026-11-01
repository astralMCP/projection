/**
 * Driver module sources evaluated inside the sandbox (PRD R24, R5–R7).
 *
 * The sandbox evaluates an ESM module and marshals its default export back
 * to the host, so each host↔VM step is a small module built here. Values
 * interpolated into these templates are always `JSON.stringify`d — never
 * raw text — so nothing from the model or the wrapped server can extend the
 * driver's own code.
 */

/**
 * Static validation of the default-exported machine (R24).
 *
 * Runs without starting an actor: entry actions must not fire during
 * validation, or a `toolCall` in the initial state would register a request
 * before policy has been consulted. `createActor(m).getSnapshot()` yields
 * the initial snapshot with actions resolved but not executed.
 *
 * The caller's `input` is passed to the probe actor exactly as the
 * bootstrap will pass it: a machine whose context factory dereferences
 * `input` (`context: ({ input }) => ({ path: input.path })`) must validate
 * against the input it will actually run with, not against `undefined`.
 */
export function validationDriver(maxStateNodes: number, input: unknown): string {
  const probeActor =
    input === undefined
      ? 'createActor(machine)'
      : `createActor(machine, { input: ${JSON.stringify(input)} })`;
  return `
import { createActor } from 'xstate';

const g = globalThis.__projection;
const machine = g.module ? g.module.default : undefined;
const fail = (code, detail) => ({ ok: false, code: code, detail: detail === undefined ? null : detail });

function run() {
  if (machine === undefined || machine === null) {
    return fail('no_default_export');
  }
  if (typeof machine !== 'object' && typeof machine !== 'function') {
    return fail('default_export_not_machine', typeof machine);
  }
  // XState v5 machines carry __xstatenode and a root state node; a v4
  // Machine(...) result and every non-machine value lack one or the other.
  const isV5 =
    machine.__xstatenode === true &&
    machine.root !== undefined &&
    typeof machine.getPersistedSnapshot === 'function';
  if (!isV5) {
    const looksV4 =
      machine.__xstatenode === true ||
      typeof machine.withConfig === 'function' ||
      typeof machine.withContext === 'function';
    return fail(looksV4 ? 'xstate_v4_machine' : 'default_export_not_machine');
  }

  // (a) State-node count: a tree walk of the instantiated definition (R12).
  let nodes = 0;
  const walkNodes = (node) => {
    nodes += 1;
    if (nodes > ${JSON.stringify(maxStateNodes)}) return;
    const states = node.states;
    if (states) for (const key of Object.keys(states)) walkNodes(states[key]);
  };
  walkNodes(machine.root);
  if (nodes > ${JSON.stringify(maxStateNodes)}) {
    return fail('too_many_state_nodes', nodes);
  }

  // (b) Banned invoked actors (R7). Any invoke at all is rejected: a
  // restored snapshot restarts invoked actors, so an invoked tool call
  // would re-execute an approved write. Walk the raw config, which is the
  // authored shape before XState normalizes it.
  const seen = new Set();
  let invokeAt = null;
  const walkConfig = (value, path) => {
    if (invokeAt !== null) return;
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (!Array.isArray(value) && value.invoke !== undefined) {
      invokeAt = path.length > 0 ? path : '(root)';
      return;
    }
    for (const key of Object.keys(value)) {
      walkConfig(value[key], path.length > 0 ? path + '.' + key : key);
    }
  };
  walkConfig(machine.config, '');
  if (invokeAt !== null) {
    return fail('invoke_banned', invokeAt);
  }

  // (c) Serializability probe (R6). JSON.stringify silently drops functions
  // and flattens Map/Set, so walk for non-JSON values instead of relying on
  // a throw, then round-trip to catch anything left (e.g. cycles).
  let snapshot;
  try {
    snapshot = ${probeActor}.getSnapshot();
  } catch (err) {
    return fail('machine_init_threw', String(err && err.message ? err.message : err));
  }
  // XState v5 catches a throwing context factory (e.g. input.path with no
  // input) and reports it as an error-status snapshot with an undefined
  // context rather than throwing, so check the status before probing the
  // context — otherwise the author sees a misleading serializability error.
  if (snapshot.status === 'error') {
    const cause = snapshot.error;
    return fail('machine_init_threw', String(cause && cause.message ? cause.message : cause));
  }
  const badPath = findNonSerializable(snapshot.context, 'context', new Set());
  if (badPath !== null) {
    return fail('context_not_serializable', badPath);
  }
  try {
    JSON.parse(JSON.stringify(snapshot.context));
  } catch (err) {
    return fail('context_not_serializable', 'context (' + String(err && err.message ? err.message : err) + ')');
  }
  return { ok: true, stateNodes: nodes };
}

function findNonSerializable(value, path, seen) {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return t === 'number' && !Number.isFinite(value) ? path + ' (' + String(value) + ')' : null;
  }
  if (t === 'undefined') return path + ' (undefined)';
  if (t === 'function') return path + ' (function)';
  if (t === 'symbol') return path + ' (symbol)';
  if (t === 'bigint') return path + ' (bigint)';
  if (t !== 'object') return path + ' (' + t + ')';
  if (seen.has(value)) return path + ' (circular reference)';
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const bad = findNonSerializable(value[i], path + '[' + i + ']', seen);
      if (bad !== null) return bad;
    }
    return null;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const name = value.constructor && value.constructor.name ? value.constructor.name : 'non-plain object';
    return path + ' (' + name + ')';
  }
  for (const key of Object.keys(value)) {
    const bad = findNonSerializable(value[key], path + '.' + key, seen);
    if (bad !== null) return bad;
  }
  return null;
}

export default run();
`;
}

/** Read the request queue without starting the actor (top-level effects, R5). */
export const TOP_LEVEL_EFFECT_PROBE = `
const state = globalThis.__projection.state;
export default { queued: state.queue ? state.queue.length : 0 };
`;

/**
 * Create (or restore) the actor and settle it, returning the drained state.
 *
 * `input` and `snapshot` are interpolated as JSON literals. A restored
 * actor resumes exactly where the snapshot left off (R21).
 */
export function bootstrapDriver(input: unknown, snapshot: unknown): string {
  const hasSnapshot = snapshot !== undefined;
  return `
import { createActor } from 'xstate';

const g = globalThis.__projection;
const machine = g.module.default;
if (!g.state.queue) g.state.queue = [];

${DRAIN_HELPER}

const actor = ${
    hasSnapshot
      ? `createActor(machine, { snapshot: ${JSON.stringify(snapshot)} })`
      : input === undefined
        ? 'createActor(machine)'
        : `createActor(machine, { input: ${JSON.stringify(input)} })`
  };
g.state.actor = actor;
g.state.drain = drain;
actor.start();

export default drain();
`;
}

/**
 * Send host events into the running actor and return the drained state.
 * The events go in as a JSON string the VM parses, not as a literal: in an
 * object literal a `__proto__` key sets the prototype, so a tool result
 * holding one (server data) would reach the machine as inherited fields
 * (`event.result.approved` true) instead of an own key.
 */
export function sendDriver(events: unknown[]): string {
  return `
const g = globalThis.__projection;
const events = JSON.parse(${JSON.stringify(JSON.stringify(events))});
for (const event of events) {
  g.state.actor.send(event);
}
export default g.state.drain();
`;
}

/** Return the persisted snapshot for sealing into the blob (R20). */
export const SNAPSHOT_DRIVER = `
const g = globalThis.__projection;
export default { snapshot: g.state.actor.getPersistedSnapshot() };
`;

/**
 * Collect everything the host needs after the actor settles: the queued
 * tool requests (cleared as they are read), the machine status, and the
 * final output when it has reached a final state.
 */
const DRAIN_HELPER = `
function drain() {
  const snapshot = g.state.actor.getSnapshot();
  const queue = g.state.queue;
  const requests = queue.splice(0, queue.length);
  return {
    status: snapshot.status,
    value: snapshot.value === undefined ? null : snapshot.value,
    output: snapshot.output === undefined ? null : snapshot.output,
    error: snapshot.error === undefined ? null : String(snapshot.error),
    requests: requests,
  };
}
`;
