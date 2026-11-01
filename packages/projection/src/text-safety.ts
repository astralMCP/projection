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
// Same class minus `\n` and `\t`, for text printed verbatim inside a fence.
// prettier-ignore
// eslint-disable-next-line no-control-regex
const HOSTILE_VERBATIM = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;

/**
 * Replace control and bidi characters with the replacement character.
 * `allowNewline` keeps `\n` (for multi-line blocks whose formatting newlines
 * are part of the rendering, e.g. a pretty-printed JSON block); `allowTab`
 * also keeps `\t`, for text printed verbatim between fences (D35), where a
 * tab is the text's own (a Makefile recipe, a TSV row) and cannot start a
 * line. `allowTab` takes effect only with `allowNewline`.
 */
export function neutralizeControlChars(
  text: string,
  options: { allowNewline?: boolean; allowTab?: boolean } = {},
): string {
  const pattern =
    options.allowNewline !== true
      ? HOSTILE_INLINE
      : options.allowTab === true
        ? HOSTILE_VERBATIM
        : HOSTILE_BLOCK;
  return text.replace(pattern, '\ufffd');
}

// Invisible characters a name or a literal can hide behind: zero-width
// space, joiners and directional marks (U+200B–U+200F), word joiner and
// invisible operators (U+2060–U+2064), BOM (U+FEFF) and the tag block
// (U+E0000–U+E007F).
const INVISIBLE_IN_NAME = /[\u200b-\u200f\u2060-\u2064\ufeff\u{E0000}-\u{E007F}]/gu;

/**
 * Show the invisible characters of a schema name or literal as visible
 * `\u{…}` escapes rather than stripping them: the model must send the
 * name the server declared, so it has to see that it differs from the
 * plain-looking one (S5).
 */
export function escapeInvisible(text: string): string {
  return text.replace(
    INVISIBLE_IN_NAME,
    (ch) => `\\u{${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`,
  );
}

// Characters a reader cannot see: Unicode format characters (`\p{Cf}`:
// zero-width space, joiners, word joiner and invisible operators, BOM, soft
// hyphen, Mongolian vowel separator, interlinear annotation marks, …) and
// the whole tag block U+E0000–E007F, whose tag characters spell hidden
// ASCII ("ASCII smuggling"). The bidi controls among them are left to
// `neutralizeControlChars`, which shows them as `�` like every other S5
// surface does.
const INVISIBLE = /[\p{Cf}\u{E0000}-\u{E007F}]/gu;
const BIDI_CONTROL = /^[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]$/;

/**
 * Strip invisible characters from server text (S5); bidi controls stay for
 * the neutralizer. Box surfaces show server text through this, so credential
 * redaction checks the stripped text too (`auth/secrets.ts`).
 */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, (ch) => (BIDI_CONTROL.test(ch) ? ch : ''));
}

/** Truncate to `maxChars`, appending an ellipsis when shortened. */
export function capLength(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/**
 * An integrator-supplied key, alias or value, inert and bounded (64
 * characters) and JSON-quoted, for a configuration error message.
 */
export function quoted(text: string): string {
  return JSON.stringify(capLength(neutralizeControlChars(text), 64));
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

/** Longest one-line tool purpose rendered anywhere (approval copy, overview, `search_tools`). */
const MAX_PURPOSE_CHARS = 200;
// The catalog stores the S5 server's description verbatim and uncapped, so
// bound the raw text before the extraction passes run over it (a hostile
// multi-MB description would otherwise cost CPU proportional to its length).
const MAX_RAW_DESCRIPTION_CHARS = 2_000;

/**
 * The one-line human purpose: the first sentence of the server's
 * description, neutralized and capped. Runs of replacement characters
 * (neutralized control bytes) are collapsed so a hostile or malformed
 * description does not render as a wall of `�`. Undefined when the server
 * gave no usable description.
 *
 * One rule, three consumers — the approval copy (R16), the `discover_apis`
 * overview and `search_tools` (R33) — so every projection describes a tool
 * identically.
 */
export function purposeSentence(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  description = capLength(description, MAX_RAW_DESCRIPTION_CHARS);
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
