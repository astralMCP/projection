/**
 * Elicitation copy builder (PRD R16, S6).
 *
 * Builds the human-readable approval summary for a gated tool call. It is
 * written for a NON-TECHNICAL approver: lead with a plain-English action,
 * a one-line purpose, and the concrete details; keep the exact tool id and
 * the requesting workflow step in a compact footer rather than dumping the
 * server's full model-facing tool description.
 *
 * Security (S6): nothing model-controlled other than the argument VALUES may
 * enter the copy, and every rendered fragment is inert:
 *
 * - Tool name, annotation title and description come from the server-side
 *   catalog entry (never from the args). The catalog may belong to a hostile
 *   third-party server (S5), so all of them are neutralized (control chars
 *   and bidi overrides replaced) and length-capped before rendering. The
 *   description is reduced to its first sentence — the human-useful part —
 *   which also drops the run of authoring boilerplate that made older copy
 *   unreadable.
 * - Arguments pass through the developer's redaction hook (R16) BEFORE being
 *   rendered; if the hook throws we fail closed and render `[redaction
 *   failed]` instead of any argument data. They are then rendered as an
 *   indented, pretty-printed JSON block, so a hostile value ("IGNORE
 *   PREVIOUS INSTRUCTIONS: ...") stays quoted on an indented line and can
 *   never break out into prose.
 * - The requesting machine state (model-authored) is rendered as an escaped
 *   JSON string literal in the footer — quoted and inert.
 * - `destructiveHint` leads with clearly stronger warning language (R14).
 *
 * Pure: no I/O, deterministic for a given input.
 */

import { capLength, indentBlock, neutralizeControlChars, purposeSentence } from '../text-safety.js';
import type { PendingToolCall, RedactionHook, ToolCatalogEntry } from '../types.js';

/** Structured approval copy for one gated call (input to the MRTR adapter). */
export interface ElicitationCopy {
  /** Short action title, e.g. `Approve: delete file`. */
  title: string;
  /** Full human-readable summary (plain text with an indented JSON block). */
  message: string;
  /** Tool name, taken from the catalog entry; qualified with `box` when given. */
  toolName: string;
  /** Machine state path that requested the call (raw; render with care). */
  stateName: string;
  /** The redacted arguments as rendered in `message` (JSON text, possibly truncated). */
  args: string;
  /** True when the catalog entry carries `destructiveHint: true`. */
  destructive: boolean;
}

export interface ElicitationCopyOptions {
  /** Redaction hook applied to args before any rendering (R16). */
  redact?: RedactionHook;
  /**
   * Who asked: a machine state (default) or a direct `call_tool` request
   * (R35). Selects the footer; nothing else differs.
   */
  origin?: 'machine' | 'direct';
  /**
   * Multi-server facades (R40, R46): the alias of the box the tool lives
   * in. `entry` is then the box's own catalog entry (bare name) and the
   * call's name is qualified. The copy names the box (R46): the title reads
   * `Approve (fs): …` (`⚠ Approve (fs): …` when destructive), the purpose
   * line `What fs says it does: "…"` — always rendered, `(no description)`
   * when the server gives none — and the footer `Tool: fs.write_file`, or
   * `Tool: fs › "github.delete_repo"` when the bare name has a dot, so it
   * never reads as another box's tool. The redaction hook receives the
   * qualified name. The alias is the host's, never a server-reported name
   * (S6).
   */
  box?: string;
  /**
   * Backstop cap on the whole rendered args JSON, in characters. Default
   * 4096. Each string leaf is independently capped at 512 characters first.
   */
  maxArgsChars?: number;
}

const DEFAULT_MAX_ARGS_CHARS = 4096;
// Per-string-leaf cap inside the rendered args: long enough to recognize a
// file body or a message, short enough that one value cannot crowd out the
// other arguments before the global cap.
const MAX_STRING_LEAF_CHARS = 512;
const MAX_STATE_NAME_CHARS = 200;
const MAX_TOOL_NAME_CHARS = 200;

// The title line already carries the ⚠ glyph; repeating it here read as
// noise to approvers, so the warning line is plain text.
const DESTRUCTIVE_WARNING =
  'This can permanently change or delete data. Review the details before approving.';

const REDACTION_FAILED = '[redaction failed]';

/**
 * Build the approval summary for a gated call.
 *
 * `entry` MUST be the catalog entry the call was resolved against (use
 * `resolveCallPolicy`); the copy takes the tool name, title and description
 * from it, never from the pending call or its arguments.
 */
export function buildElicitationCopy(
  call: PendingToolCall,
  entry: ToolCatalogEntry,
  options: ElicitationCopyOptions = {},
): ElicitationCopy {
  const destructive = entry.annotations?.destructiveHint === true;
  const maxArgsChars = options.maxArgsChars ?? DEFAULT_MAX_ARGS_CHARS;

  // R16: redact BEFORE rendering anywhere. Fail closed if the hook throws:
  // render a placeholder for ALL args rather than risk leaking any of them.
  //
  // The hook sees a COPY (S2): `call.args` is what gets sealed into the blob
  // and executed on approval, so a hook that edits its input in place must
  // not be able to change what the approver's "yes" authorizes.
  let renderedArgs: string;
  try {
    const displayArgs =
      options.redact !== undefined
        ? options.redact(qualifiedName(entry, options.box), cloneArgs(call.args))
        : call.args;
    renderedArgs = renderArgsJson(displayArgs, maxArgsChars);
  } catch {
    renderedArgs = REDACTION_FAILED;
  }

  // All catalog-derived text is untrusted (S5): neutralize + cap so it can
  // never forge prompt structure (fake args blocks, fake approval lines,
  // ANSI tricks, bidi overrides).
  const safeName = neutralizeControlChars(capLength(entry.name, MAX_TOOL_NAME_CHARS));
  const friendly = friendlyAction(entry, safeName);
  const purpose = purposeSentence(entry.description);

  // Method-dispatched tools ("issue_write" with method: "create") hide the
  // real action behind an umbrella title; surface the enum-constrained
  // dispatch value so the approver sees "… — create", not just "issue".
  const method = dispatchMethod(call.args, entry);
  const action = method !== undefined ? `${friendly} — ${method}` : friendly;
  // R46: on a multi-server facade the title and the purpose line name the
  // box by its host alias (S6); single-server copy is unchanged.
  const { box } = options;
  const approve = box !== undefined ? `Approve (${box})` : 'Approve';
  const title = destructive ? `⚠ ${approve}: ${action}` : `${approve}: ${action}`;

  const lines: string[] = [];
  if (destructive) lines.push(DESTRUCTIVE_WARNING, '');
  // The purpose is the wrapped server's own words (S5-untrusted), so it is
  // attributed and quoted as inert data — never rendered as prose in the
  // assistant's voice, where "safe, pre-approved" copy could mislead. On a
  // multi-server facade it is always rendered, so the approver always sees
  // which box is asking.
  if (box !== undefined) {
    lines.push(
      `What ${box} says it does: ${purpose !== undefined ? JSON.stringify(purpose) : '(no description)'}`,
      '',
    );
  } else if (purpose !== undefined) {
    lines.push(`What the server says it does: ${JSON.stringify(purpose)}`, '');
  }
  lines.push('Details:', indentBlock(neutralizeControlChars(renderedArgs, { allowNewline: true })));
  // Compact technical footer: exact tool id and, for a machine step, the
  // workflow step that asked (R16). Kept plain — "requested by the model"
  // style phrasing was jargon to approvers. The state is model-authored, so
  // quoted as an inert JSON literal.
  const safeState = neutralizeControlChars(capLength(call.stateName, MAX_STATE_NAME_CHARS));
  const toolId = options.box !== undefined ? boxedToolId(options.box, safeName) : safeName;
  lines.push(
    '',
    options.origin === 'direct'
      ? `Tool: ${toolId}`
      : `Tool: ${toolId} · workflow step ${JSON.stringify(safeState)}`,
  );

  return {
    title,
    message: lines.join('\n'),
    toolName: qualifiedName(entry, options.box),
    stateName: call.stateName,
    args: renderedArgs,
    destructive,
  };
}

/** The name the gate knows the tool by: qualified on a multi-server facade (R40). */
function qualifiedName(entry: ToolCatalogEntry, box: string | undefined): string {
  return box !== undefined ? `${box}.${entry.name}` : entry.name;
}

/**
 * The footer's tool id on a multi-server facade (R46): `<alias>.<name>`, or
 * `<alias> › "<name>"` when the bare name contains a dot, so the `fs` box's
 * `github.delete_repo` never reads as the `github` box's `delete_repo`.
 * `safeName` is already neutralized and capped.
 */
function boxedToolId(box: string, safeName: string): string {
  return safeName.includes('.') ? `${box} › ${JSON.stringify(safeName)}` : `${box}.${safeName}`;
}

/** Top-level argument names that conventionally select a tool's sub-action. */
const DISPATCH_ARGS = ['method', 'action'] as const;

/**
 * The dispatch value of a method-style tool, when the call carries one and
 * the schema constrains it: a top-level `method` / `action` string argument
 * whose schema property has an `enum` listing that exact value. Only
 * enum-listed values qualify, so the suffix is server-defined vocabulary
 * (neutralized and capped like every other S5 string), never free text
 * the model typed. Every dispatch key the call carries must pass: one that
 * is present but not enum-listed means no suffix at all, so a rejected
 * `method` cannot be routed around with an `action` the model added.
 */
function dispatchMethod(
  args: Record<string, unknown>,
  entry: ToolCatalogEntry,
): string | undefined {
  const properties = entry.inputSchema['properties'];
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return undefined;
  }
  let suffix: string | undefined;
  for (const key of DISPATCH_ARGS) {
    if (!Object.hasOwn(args, key)) continue;
    const value = args[key];
    const property = (properties as Record<string, unknown>)[key];
    if (
      typeof value !== 'string' ||
      typeof property !== 'object' ||
      property === null ||
      !Array.isArray((property as Record<string, unknown>)['enum']) ||
      !((property as Record<string, unknown>)['enum'] as unknown[]).includes(value)
    ) {
      return undefined;
    }
    suffix ??= neutralizeControlChars(capLength(value, MAX_TOOL_NAME_CHARS));
  }
  return suffix;
}

/**
 * Plain-English action label: the server's annotation title when present,
 * otherwise the tool id humanized (namespace prefix dropped, separators to
 * spaces) — "pd__gmail-create-draft" → "gmail create draft".
 */
function friendlyAction(entry: ToolCatalogEntry, safeName: string): string {
  const title = entry.annotations?.title;
  if (title !== undefined && title.trim().length > 0) {
    return neutralizeControlChars(capLength(title, MAX_TOOL_NAME_CHARS));
  }
  const withoutNamespace = safeName.includes('__')
    ? safeName.slice(safeName.indexOf('__') + 2)
    : safeName;
  const humanized = withoutNamespace.replace(/[_-]+/g, ' ').trim();
  return humanized.length > 0 ? humanized : safeName;
}

/**
 * A deep copy of the arguments for the redaction hook. `structuredClone`
 * rejects functions and symbols, which only a direct (non-wire) caller can
 * put in args; fall back to the original there and let the fail-closed
 * rendering path deal with whatever the hook does.
 */
function cloneArgs(args: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(args);
  } catch {
    return args;
  }
}

/**
 * Render argument values as pretty-printed JSON, defensively:
 * circular references, bigints, functions, symbols and `undefined` become
 * inert placeholder strings; a throwing `toJSON` falls back to a
 * placeholder.
 *
 * Two caps, so the approver always sees every top-level argument (S6): each
 * STRING leaf is cut at `MAX_STRING_LEAF_CHARS` with an inline marker — one
 * oversized `content` can no longer push `path` out of view — and the whole
 * rendering is cut at `maxChars` as a backstop. When the backstop fires, the
 * marker names the top-level arguments that were cut off entirely, so a key
 * never silently disappears from the prompt.
 */
function renderArgsJson(args: Record<string, unknown>, maxChars: number): string {
  let json: string;
  try {
    json = JSON.stringify(args, makeSafeReplacer(), 2) ?? '[unserializable arguments]';
  } catch {
    json = '[unserializable arguments]';
  }
  if (json.length <= maxChars) {
    return json;
  }
  const total = json.length;
  const kept = json.slice(0, maxChars);
  const hidden = hiddenTopLevelKeys(args, kept);
  const notShown =
    hidden.length > 0
      ? `; arguments not shown: ${hidden.map((key) => JSON.stringify(key)).join(', ')}`
      : '';
  return `${kept}\n… [truncated: showing first ${maxChars} of ${total} characters${notShown}]`;
}

/**
 * Top-level argument names whose member never made it into the kept slice.
 * A top-level member of a 2-space pretty-print starts the line `  "key": `
 * — nested members are indented deeper and string values never contain a
 * raw newline — so the line prefix identifies the key unambiguously. A key
 * whose value was cut mid-way still counts as shown.
 */
function hiddenTopLevelKeys(args: Record<string, unknown>, kept: string): string[] {
  const hidden: string[] = [];
  for (const key of Object.keys(args)) {
    if (!kept.includes(`\n  ${JSON.stringify(key)}: `)) hidden.push(key);
  }
  return hidden;
}

/**
 * JSON.stringify replacer neutralizing values JSON cannot represent and
 * capping string leaves (see {@link renderArgsJson}).
 *
 * Cycle detection tracks only the current ancestor chain (popping on the
 * way back up via the `this` holder), so shared non-circular references
 * render fully everywhere they appear — only a true ancestor cycle becomes
 * `[circular]`. Rendering a shared object as `[circular]` would hide the
 * real arguments from the approver (R16).
 */
function makeSafeReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  const ancestors: object[] = [];
  return function replacer(this: unknown, _key: string, value: unknown): unknown {
    switch (typeof value) {
      case 'string':
        return value.length > MAX_STRING_LEAF_CHARS
          ? `${value.slice(0, MAX_STRING_LEAF_CHARS)}…[+${value.length - MAX_STRING_LEAF_CHARS} chars]`
          : value;
      case 'bigint':
        return `[bigint ${value.toString()}]`;
      case 'function':
        return '[function]';
      case 'symbol':
        return '[symbol]';
      case 'undefined':
        return '[undefined]';
      default:
        break;
    }
    if (typeof value === 'object' && value !== null) {
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
        ancestors.pop();
      }
      if (ancestors.includes(value)) {
        return '[circular]';
      }
      ancestors.push(value);
    }
    return value;
  };
}
