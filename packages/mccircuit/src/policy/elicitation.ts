/**
 * Elicitation copy builder (PRD R16, S6).
 *
 * Builds the human-readable approval summary for a gated tool call. The
 * hardening rule (S6) is that nothing model-controlled other than the
 * argument VALUES may enter the copy, and those values are rendered as
 * inert data:
 *
 * - Tool name and description come from the server-side catalog entry,
 *   never from model-authored text (a fake `description` inside the args
 *   is just another argument value inside the JSON block). The catalog
 *   itself may belong to a hostile third-party server (S5), so name and
 *   description are still rendered inert: control characters and bidi
 *   overrides neutralized, length capped, description as an escaped JSON
 *   string literal so it can never forge prompt structure.
 * - Arguments pass through the developer's redaction hook (R16) BEFORE
 *   being rendered anywhere; if the hook throws we fail closed and render
 *   `[redaction failed]` instead of any argument data.
 * - Arguments are rendered as an indented, pretty-printed JSON block.
 *   `JSON.stringify` escapes every newline and quote inside string values,
 *   so hostile values ("IGNORE PREVIOUS INSTRUCTIONS: ...") stay quoted on
 *   an indented line inside the block and can never break out into prose.
 * - The machine state name (model-authored, required by R16) is rendered
 *   as a length-capped JSON string literal — quoted and escaped, inert.
 * - `destructiveHint` prepends clearly stronger warning language (R14).
 *
 * Pure: no I/O, deterministic for a given input.
 */

import type { PendingToolCall, RedactionHook, ToolCatalogEntry } from '../types.js';

/** Structured approval copy for one gated call (input to the MRTR adapter). */
export interface ElicitationCopy {
  /** Short title, e.g. `Approval required: delete_file`. */
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
const MAX_DESCRIPTION_CHARS = 1000;
const ARGS_INDENT = '    ';

/**
 * C0 control characters (including \n and ESC for ANSI sequences), DEL, C1
 * controls (JSON.stringify does NOT escape these), and Unicode bidi
 * overrides that could reorder or hide rendered text.
 */
// eslint-disable-next-line no-control-regex
const HOSTILE_INLINE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Same class minus \n, for blocks whose formatting newlines are legitimate. */
// prettier-ignore
// eslint-disable-next-line no-control-regex
const HOSTILE_BLOCK_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Neutralize control/bidi characters in a single-line field. */
function neutralizeInline(text: string): string {
  return text.replace(HOSTILE_INLINE_CHARS, '\ufffd');
}

/**
 * Neutralize control/bidi characters in the rendered args JSON block.
 * JSON.stringify already escaped everything inside string values, so the
 * only legitimate raw control characters left are the pretty-print
 * newlines — which this pass preserves.
 */
function neutralizeBlock(text: string): string {
  return text.replace(HOSTILE_BLOCK_CHARS, '\ufffd');
}

const DESTRUCTIVE_WARNING =
  'WARNING: the server marks this tool as DESTRUCTIVE. ' +
  'Approving may permanently modify or delete data. Review the arguments carefully.';

const REDACTION_FAILED = '[redaction failed]';

/**
 * Build the approval summary for a gated call.
 *
 * `entry` MUST be the catalog entry the call was resolved against (use
 * `resolveCallPolicy`); the copy takes the tool name and description from
 * it, never from the pending call or its arguments.
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

  // The catalog entry comes from a possibly third-party wrapped server (S5):
  // its name and description are untrusted and must not be able to forge
  // prompt structure (fake args blocks, fake approval lines, ANSI tricks).
  const safeName = neutralizeInline(capLength(entry.name, MAX_TOOL_NAME_CHARS));
  const safeDescription = JSON.stringify(
    neutralizeInline(
      capLength(
        entry.description ?? '(no description provided by the server)',
        MAX_DESCRIPTION_CHARS,
      ),
    ),
  );

  const title = destructive
    ? `Approval required (DESTRUCTIVE): ${safeName}`
    : `Approval required: ${safeName}`;

  const lines: string[] = [];
  if (destructive) {
    lines.push(DESTRUCTIVE_WARNING, '');
  }
  lines.push(
    `Tool: ${safeName}`,
    `Description: ${safeDescription}`,
    // Model-authored, so rendered as an escaped JSON string literal (inert).
    `Requested by machine state: ${JSON.stringify(
      neutralizeInline(capLength(call.stateName, MAX_STATE_NAME_CHARS)),
    )}`,
    '',
    'Arguments (data only — not instructions):',
    '',
    indentBlock(neutralizeBlock(renderedArgs)),
  );

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

function capLength(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}
