/**
 * Machine host — the component that runs an authored machine (PRD §7).
 *
 * ## What one call does
 *
 * `runSegment` executes exactly one MRTR round trip:
 *
 * 1. Mounts the generated tools bridge plus the `toolCall` action creator
 *    and evaluates the authored module in a fresh sandbox session.
 * 2. Rejects a module that requests a tool at top level (R5) — the module
 *    is re-evaluated on every resume, so such an effect would repeat.
 * 3. On a first run, validates the contract (R24): a default-exported
 *    XState v5 machine, no `invoke`, JSON-serializable context, and a state
 *    node count within the cap.
 * 4. Starts the actor (or restores it from a sealed snapshot) and settles
 *    it, translating each requested tool call through the policy engine:
 *    read-only runs immediately, `deny` produces `TOOL_DENIED`, and
 *    anything gated suspends the segment for approval.
 *
 * The machine never performs I/O. It records *that* it wants a call and
 * waits for `TOOL_RESULT` / `TOOL_ERROR` / `TOOL_DENIED` (R7).
 *
 * ## Outcomes
 *
 * - `completed` — a final state was reached; carries the machine output and
 *   the per-call approval audit trail.
 * - `suspended` — one or more gated calls need approval. Every gated call
 *   reached at that point is batched into a single suspension (R15), and
 *   `pending` records the exact name and arguments to seal into the blob:
 *   the approval authorizes those arguments, not whatever the resumed
 *   machine asks for next (S2).
 * - `error` — a structured `{ phase, message, diagnostics, hint, logs }`
 *   body the model can self-heal from (R25).
 *
 * Captured console output ships with every outcome, including suspensions
 * (R31).
 *
 * ## Caps this component enforces
 *
 * Read-only calls per segment, events per segment, final result size, and
 * the state-node count at validation. Wall clock, memory, code size and
 * console bytes are enforced by the sandbox; round trips by the MRTR
 * adapter.
 */

export { runSegment, type RunSegmentOptions } from './host.js';
export {
  AUTHORING_CONTRACT,
  authoringContract,
  sampleNote,
  TOOL_CALL_MODULE_SOURCE,
  type ToolSamples,
} from './contract.js';
