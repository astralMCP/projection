/**
 * Rendering untrusted strings inertly (S5, S6).
 *
 * Tool names, descriptions, the wrapped server's identity, and machine state
 * names all flow from a possibly third-party server or a model-authored
 * machine. Wherever they are rendered into human-facing prompt copy or into
 * generated source, they must not be able to forge structure with control
 * characters (newlines, ESC for ANSI sequences) or reorder text with Unicode
 * bidi overrides. Centralizing the character class here keeps every call site
 * on the same, complete definition — an earlier divergence let generated
 * `.d.ts`/bridge comments miss the directional-isolate range that the
 * elicitation copy already stripped.
 */

/**
 * C0 control characters (incl. ESC and, unless `allowNewline`, `\n`), DEL, C1
 * controls (which `JSON.stringify` does NOT escape), U+2028/U+2029
 * (LINE/PARAGRAPH SEPARATOR — ECMAScript LineTerminators that
 * `JSON.stringify` also leaves raw, so unescaped they would terminate a `//`
 * comment in evaluated generated source), the bidi format/override marks
 * (ALM, LRM/RLM, LRE/RLE/PDF/LRO/RLO), and the directional isolates
 * (LRI/RLI/FSI/PDI).
 */
// prettier-ignore
// eslint-disable-next-line no-control-regex
const HOSTILE_INLINE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;
// Same class minus `\n`, for blocks whose pretty-print newlines are legitimate.
// prettier-ignore
// eslint-disable-next-line no-control-regex
const HOSTILE_BLOCK = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;

/**
 * Replace control and bidi characters with the replacement character.
 * `allowNewline` keeps `\n` (for multi-line blocks whose formatting newlines
 * are part of the rendering, e.g. a pretty-printed JSON block).
 */
export function neutralizeControlChars(
  text: string,
  options: { allowNewline?: boolean } = {},
): string {
  return text.replace(options.allowNewline === true ? HOSTILE_BLOCK : HOSTILE_INLINE, '\ufffd');
}

/** Truncate to `maxChars`, appending an ellipsis when shortened. */
export function capLength(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/** Indent used for untrusted blocks embedded in prompt copy. */
const BLOCK_INDENT = '    ';

/**
 * Prefix every line of an untrusted block so it reads as data, not prose:
 * an indented line can never forge one of the labelled top-level lines the
 * surrounding copy is built from (approval details, `Posture:`, …).
 */
export function indentBlock(text: string, indent: string = BLOCK_INDENT): string {
  return text
    .split('\n')
    .map((line) => indent + line)
    .join('\n');
}

/**
 * Longest wrapped-server identity rendered into prompt copy or generated
 * artifacts (S5: a hostile wrapped server controls the string).
 */
export const MAX_IDENTITY_CHARS = 200;

/**
 * Render an untrusted server identity inert for single-line embedding:
 * neutralized, length-capped, and emitted as a JSON string literal — the
 * literal supplies its own quotes, so surrounding copy reads it as
 * unambiguous quoted data.
 */
export function inertIdentity(identity: string): string {
  return JSON.stringify(neutralizeControlChars(capLength(identity, MAX_IDENTITY_CHARS)));
}
