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

import { capLength, neutralizeControlChars } from '../text-safety.js';
import type { PendingToolCall, RedactionHook, ToolCatalogEntry } from '../types.js';

/** Structured approval copy for one gated call (input to the MRTR adapter). */
export interface ElicitationCopy {
  /** Short action title, e.g. `Approve: delete file`. */
  title: string;
  /** Full human-readable summary (plain text with an indented JSON block). */
  message: string;
  /** Tool name, taken from the catalog entry. */
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
  /** Cap on the rendered args JSON, in characters. Default 4096. */
  maxArgsChars?: number;
}

const DEFAULT_MAX_ARGS_CHARS = 4096;
const MAX_STATE_NAME_CHARS = 200;
const MAX_TOOL_NAME_CHARS = 200;
const MAX_PURPOSE_CHARS = 200;
const ARGS_INDENT = '    ';

const DESTRUCTIVE_WARNING =
  '⚠ This can permanently change or delete data. Review the details before approving.';

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
  let renderedArgs: string;
  try {
    const displayArgs =
      options.redact !== undefined ? options.redact(entry.name, call.args) : call.args;
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

  const title = destructive ? `⚠ Approve: ${friendly}` : `Approve: ${friendly}`;

  const lines: string[] = [];
  if (destructive) lines.push(DESTRUCTIVE_WARNING, '');
  if (purpose !== undefined) lines.push(purpose, '');
  lines.push('Details:', indentBlock(neutralizeControlChars(renderedArgs, { allowNewline: true })));
  // Compact technical footer: exact tool id + the workflow step that asked
  // (R16). The state is model-authored, so quoted as an inert JSON literal.
  const safeState = neutralizeControlChars(capLength(call.stateName, MAX_STATE_NAME_CHARS));
  lines.push('', `Tool ${safeName} · requested by step ${JSON.stringify(safeState)}`);

  return {
    title,
    message: lines.join('\n'),
    toolName: entry.name,
    stateName: call.stateName,
    args: renderedArgs,
    destructive,
  };
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
 * The one-line human purpose: the first sentence of the server's
 * description, neutralized and capped. Runs of replacement characters
 * (neutralized control bytes) are collapsed so a hostile or malformed
 * description does not render as a wall of `�`. Undefined when the server
 * gave no usable description.
 */
function purposeSentence(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  // Work on the RAW first line: a newline is a hard boundary, so a hostile
  // description cannot smuggle a forged block past the first sentence. Then
  // trim to the first sentence, and only then neutralize — collapsing runs
  // of replacement characters so a malformed byte run does not render as a
  // wall of `�`.
  const firstLine = description.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (firstLine.length === 0) return undefined;
  const match = /^.*?[.!?](\s|$)/.exec(firstLine);
  const sentence = (match ? match[0] : firstLine).trim();
  const neutralized = neutralizeControlChars(sentence).replace(/�{2,}/g, '�').trim();
  return neutralized.length > 0 ? capLength(neutralized, MAX_PURPOSE_CHARS) : undefined;
}

/**
 * Render argument values as pretty-printed JSON, defensively:
 * circular references, bigints, functions, symbols and `undefined` become
 * inert placeholder strings; a throwing `toJSON` falls back to a
 * placeholder; output beyond `maxChars` is cut with a truncation marker.
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
  return `${json.slice(0, maxChars)}\n… [truncated: showing first ${maxChars} of ${total} characters]`;
}

/**
 * JSON.stringify replacer neutralizing values JSON cannot represent.
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

/** Prefix every line so the block reads as data, not prose. */
function indentBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => ARGS_INDENT + line)
    .join('\n');
}
