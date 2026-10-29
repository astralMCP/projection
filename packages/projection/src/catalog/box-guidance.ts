/**
 * What a multi-server facade tells the model about each box (PRD R43, R44,
 * R45; S5): the one-phrase "about" that the shelf and the `search_<alias>`
 * description show, and the box overview — the server's full `instructions`,
 * served on the first look into the box rather than in the system prompt
 * (progressive disclosure, DECISIONS D16).
 *
 * Box aliases and descriptions are host-controlled (R39); a server's
 * `instructions` are S5-untrusted. Server text therefore reaches a box
 * surface only stripped of invisible characters, neutralized, capped and
 * visibly attributed: the first sentence as a quoted JSON string literal
 * followed by `(server's words)`, the overview as an indented block under a
 * library header — a Markdown indented code block, so it renders as inert
 * text — so it can never forge a shelf line, a tool line or the header
 * itself.
 *
 * Stable exports, shared with the code-mode projection (R45):
 * {@link boxOverview}, {@link renderOverviewBlock}, {@link boxOverviewUri}
 * and {@link boxOverviewResources}; {@link boxAbout} for any surface that
 * names what a box is about.
 */

import type { ProjectionResource } from '../mrtr/discover.js';
import {
  capLength,
  indentBlock,
  neutralizeControlChars,
  purposeSentence,
  stripInvisible,
} from '../text-safety.js';
import { dedupeTools } from '../types.js';
import type { BoxedCatalog, ToolBox } from './boxes.js';

/** Longest box overview served (R43): 8 KB of the server's instructions. */
export const MAX_OVERVIEW_CHARS = 8_192;

/** Appended, on a line of its own, to an overview cut at {@link MAX_OVERVIEW_CHARS}. */
export const OVERVIEW_TRUNCATION_MARKER =
  "[… truncated: the server's guidance continues past 8 KB; the rest is not shown]";

/** `1 tool`, `3 tools`. */
export function toolCount(count: number): string {
  return `${count} ${count === 1 ? 'tool' : 'tools'}`;
}

/** Nothing a reader could use: only whitespace and replacement characters. */
function isBlank(text: string): boolean {
  return /^[\s\ufffd]*$/u.test(text);
}

// Bound the raw `instructions` before any pass runs over a hostile multi-MB
// string: twice the overview cap still leaves the cap after CRLF
// normalization and stripping.
const MAX_RAW_INSTRUCTIONS_CHARS = 16_384;

// What the shelf appends after a quotation — an attribution or a tool count
// — removed from inside it, so one line never shows two of either.
const FORGED_SUFFIX = /\s*\(\s*(?:server['\u2019]s\s+words|\d+\s+tools?)\s*\)/gi;

/** A Markdown ATX heading line (`# Title`), skipped when choosing the first line. */
const HEADING_LINE = /^#{1,6}(\s|$)/;

/**
 * What the shelf and the `search_<alias>` description say a box is about
 * (R43, R44): the host's `description` unquoted (already neutralized and
 * capped at wrap time, R39), else the first sentence of the server's
 * `instructions` — invisible characters stripped, leading blank and
 * Markdown heading lines skipped, then neutralized and capped like a tool's
 * purpose, rendered as a JSON string literal and attributed — else
 * `undefined`, also when nothing but whitespace or `�` would remain.
 *
 * A quotation cannot forge a second attribution or tool count: ASCII `"`
 * inside it becomes `”`, so it cannot seem to close, and a literal
 * `(server's words)` or `(<n> tools)` is removed.
 */
export function boxAbout(box: ToolBox): string | undefined {
  if (box.description !== undefined) return box.description;
  const instructions = box.catalog.instructions;
  if (instructions === undefined) return undefined;
  const lines = stripInvisible(instructions.slice(0, MAX_RAW_INSTRUCTIONS_CHARS))
    .trimStart()
    .split(/\r?\n/);
  const first = lines.find((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !HEADING_LINE.test(trimmed);
  });
  const sentence = purposeSentence(first)
    ?.replace(/"/g, '\u201d')
    .replace(FORGED_SUFFIX, '')
    .trim();
  if (sentence === undefined || isBlank(sentence)) return undefined;
  return `${JSON.stringify(sentence)} (server's words)`;
}

/** How many tool names {@link boxToolSample} shows. */
export const TOOL_SAMPLE_SIZE = 5;

/** Longest sampled tool name, so one hostile name cannot flood the shelf. */
const MAX_SAMPLE_NAME_CHARS = 64;

/**
 * A sample of a box's tool names for the shelf and the `search_<alias>`
 * description (R43, R44), for a box that says nothing else about itself
 * ({@link boxAbout} is `undefined`): `e.g. a, b, c, d, e, …` — the first
 * {@link TOOL_SAMPLE_SIZE} bare names in the box's catalog order after the
 * per-box dedupe, the trailing `, …` only when the box has more. Names are
 * S5 server text: invisible characters stripped, neutralized, capped, and a
 * literal `(server's words)` or `(<n> tools)` removed, so a name can forge
 * neither a line nor a second count. `undefined` when the box has an about
 * or no nameable tool.
 */
export function boxToolSample(box: ToolBox): string | undefined {
  if (boxAbout(box) !== undefined) return undefined;
  const tools = dedupeTools(box.catalog.tools);
  const names = tools
    .slice(0, TOOL_SAMPLE_SIZE)
    .map((tool) =>
      capLength(
        neutralizeControlChars(stripInvisible(tool.name)).replace(FORGED_SUFFIX, '').trim(),
        MAX_SAMPLE_NAME_CHARS,
      ),
    )
    .filter((name) => !isBlank(name));
  if (names.length === 0) return undefined;
  const more = tools.length > TOOL_SAMPLE_SIZE ? ', …' : '';
  return `e.g. ${names.join(', ')}${more}`;
}

/** A box's tool count with its {@link boxToolSample}, when it has one: `14 tools, e.g. a, b, …`. */
export function boxToolsLabel(box: ToolBox, count: number): string {
  const sample = boxToolSample(box);
  return sample === undefined ? toolCount(count) : `${toolCount(count)}, ${sample}`;
}

/**
 * The box overview (R43): the server's full `instructions`, trimmed, line
 * endings normalized, invisible characters stripped, neutralized (control
 * and bidi characters; newlines kept) and capped at
 * {@link MAX_OVERVIEW_CHARS} with {@link OVERVIEW_TRUNCATION_MARKER} on a
 * line of its own. A cut lands on a line break, else a space, when one lies
 * in the last tenth of the window, and never inside a grapheme cluster.
 * `undefined` when the server sends no instructions, or nothing but
 * whitespace and `�` remains.
 *
 * Shared with the code-mode projection (R45: `discover_apis` links the
 * overview resources), so the overview reads the same on every surface.
 */
export function boxOverview(instructions: string | undefined): string | undefined {
  if (instructions === undefined) return undefined;
  const start = instructions.trimStart();
  const bounded = start.length > MAX_RAW_INSTRUCTIONS_CHARS;
  const text = stripInvisible(start.slice(0, MAX_RAW_INSTRUCTIONS_CHARS))
    .replace(/\r\n/g, '\n')
    .trim();
  if (text.length <= MAX_OVERVIEW_CHARS && !bounded) {
    const whole = neutralizeControlChars(text, { allowNewline: true });
    return isBlank(whole) ? undefined : whole;
  }
  const kept = neutralizeControlChars(cutOverview(text).trimEnd(), { allowNewline: true });
  return isBlank(kept) ? undefined : `${kept}\n${OVERVIEW_TRUNCATION_MARKER}`;
}

/**
 * The first {@link MAX_OVERVIEW_CHARS} of `text`, cut at the last line break
 * (else space) in the window's last tenth, then shortened to a grapheme
 * boundary so no surrogate pair, combining mark or joined sequence is split.
 */
function cutOverview(text: string): string {
  if (text.length <= MAX_OVERVIEW_CHARS) return text;
  const window = text.slice(0, MAX_OVERVIEW_CHARS);
  const floor = Math.floor(MAX_OVERVIEW_CHARS * 0.9);
  const newline = window.lastIndexOf('\n');
  const space = window.lastIndexOf(' ');
  let end = newline >= floor ? newline : space >= floor ? space : MAX_OVERVIEW_CHARS;
  // Segment a little past the cut, so the cluster straddling it is whole.
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
    text.slice(0, end + 32),
  );
  const straddling = segments.containing(end);
  if (straddling !== undefined && straddling.index < end) end = straddling.index;
  return text.slice(0, end);
}

/** The header the overview block sits under (R43). Aliases are grammar-checked (R39). */
export function overviewHeader(alias: string): string {
  return `Guidance from the ${alias} box (the server's own words; it applies to ${alias} tools only):`;
}

/**
 * The overview block as the first page of an empty-query `search_<alias>`
 * renders it and the overview resource serves it: the header, a blank line,
 * then the overview indented — as `describe_tool` renders a description —
 * so no line of it can pass for a tool line or a header. The blank line
 * makes the indented lines a CommonMark indented code block (an indented
 * line directly under a paragraph would continue that paragraph), so in the
 * `.md` resource no link, image, HTML, heading or fence in the server's
 * text renders as anything but literal text.
 */
export function renderOverviewBlock(alias: string, overview: string): string {
  return `${overviewHeader(alias)}\n\n${indentBlock(overview)}`;
}

/** URI of a box's overview resource (R3, R45). */
export function boxOverviewUri(alias: string): string {
  return `projection://boxes/${alias}/overview.md`;
}

/**
 * One overview resource per box whose server sends `instructions` (R3,
 * R45), in sorted alias order. The description names the box by its alias
 * only — never by anything the server reported. The catalog projection
 * registers these; code mode links them from `discover_apis` (R45), so a
 * box's guidance is reachable with either projection alone.
 */
export function boxOverviewResources(catalog: BoxedCatalog): ProjectionResource[] {
  const resources: ProjectionResource[] = [];
  for (const [alias, box] of catalog.boxes) {
    const overview = boxOverview(box.catalog.instructions);
    if (overview === undefined) continue;
    resources.push({
      uri: boxOverviewUri(alias),
      name: `${alias}-overview.md`,
      description: `Guidance for the ${alias} box, in its server's own words.`,
      mimeType: 'text/markdown',
      text: renderOverviewBlock(alias, overview),
    });
  }
  return resources;
}
