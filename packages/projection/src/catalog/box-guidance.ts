/**
 * What a multi-server facade tells the model about each box (PRD R43, R44,
 * R45; S5): the one-phrase "about" that the shelf and the `search_<alias>`
 * description show, and the box overview — the server's full `instructions`,
 * served on the first look into the box rather than in the system prompt
 * (progressive disclosure, DECISIONS D16).
 *
 * Box aliases and descriptions are host-controlled (R39); a server's
 * `instructions` are S5-untrusted. Server text therefore reaches a box
 * surface only neutralized, capped and visibly attributed: the first
 * sentence as a quoted JSON string literal followed by `(server's words)`,
 * the overview as an indented block under a library header, so it can never
 * forge a shelf line, a tool line or the header itself.
 */

import type { ProjectionResource } from '../mrtr/discover.js';
import { indentBlock, neutralizeControlChars, purposeSentence } from '../text-safety.js';
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

/**
 * What the shelf and the `search_<alias>` description say a box is about
 * (R43, R44): the host's `description` unquoted (already neutralized and
 * capped at wrap time, R39), else the first sentence of the server's
 * `instructions` — neutralized and capped like a tool's purpose, then
 * rendered as a JSON string literal and attributed, so a quote or a forged
 * `(server's words)` inside it stays inside the literal — else `undefined`.
 */
export function boxAbout(box: ToolBox): string | undefined {
  if (box.description !== undefined) return box.description;
  const sentence = purposeSentence(box.catalog.instructions);
  return sentence !== undefined ? `${JSON.stringify(sentence)} (server's words)` : undefined;
}

/**
 * The box overview (R43): the server's full `instructions`, trimmed, line
 * endings normalized, neutralized (control and bidi characters; newlines
 * kept) and capped at {@link MAX_OVERVIEW_CHARS} with
 * {@link OVERVIEW_TRUNCATION_MARKER}. `undefined` when the server sends no
 * instructions, or only whitespace.
 */
export function boxOverview(instructions: string | undefined): string | undefined {
  if (instructions === undefined) return undefined;
  const start = instructions.trimStart();
  // Bound the work before any further pass runs over a hostile multi-MB
  // string: twice the cap still leaves the cap after CRLF normalization.
  const bound = MAX_OVERVIEW_CHARS * 2;
  const text = start.slice(0, bound).replace(/\r\n/g, '\n').trimEnd();
  if (text.length === 0) return undefined;
  if (text.length <= MAX_OVERVIEW_CHARS && start.length <= bound) {
    return neutralizeControlChars(text, { allowNewline: true });
  }
  let cut = text.slice(0, MAX_OVERVIEW_CHARS);
  // Never end on half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const kept = neutralizeControlChars(cut.trimEnd(), { allowNewline: true });
  return `${kept}\n${OVERVIEW_TRUNCATION_MARKER}`;
}

/** The header the overview block sits under (R43). Aliases are grammar-checked (R39). */
export function overviewHeader(alias: string): string {
  return `Guidance from the ${alias} box (the server's own words; it applies to ${alias} tools only):`;
}

/**
 * The overview block as the first page of an empty-query `search_<alias>`
 * renders it and the overview resource serves it: the header, then the
 * overview indented — as `describe_tool` renders a description — so no line
 * of it can pass for a tool line or a header.
 */
export function renderOverviewBlock(alias: string, overview: string): string {
  return `${overviewHeader(alias)}\n${indentBlock(overview)}`;
}

/** URI of a box's overview resource (R3, R45). */
export function boxOverviewUri(alias: string): string {
  return `projection://boxes/${alias}/overview.md`;
}

/**
 * One overview resource per box whose server sends `instructions` (R3,
 * R45), in sorted alias order. The description names the box by its alias
 * only — never by anything the server reported.
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
