/**
 * `discover_apis` — the tool that teaches the model to author a machine
 * (PRD G6, R3, R29).
 *
 * Returns a compact inline overview that is sufficient on its own, plus a
 * `resource_link` per artifact so a model can pull full contents only when
 * it wants them. Clients with weak resource support still function.
 */

import { authoringContract, sampleNote, type ToolSamples } from '../machine-host/index.js';
import { DASHBOARD_HTML, DASHBOARD_RESOURCE_URI, MCP_APP_MIME_TYPE } from '../apps/dashboard.js';
import {
  boxesLabel,
  firstAlias,
  isBoxedCatalog,
  membersByBox,
  type BoxedCatalog,
} from '../catalog/boxes.js';
import { decidePolicy, policyContext } from '../policy/decision.js';
import { inertIdentity } from '../text-safety.js';
import { XSTATE_VERSION } from '../blob/index.js';
import { dedupeTools, type PolicyOptions, type ServerCatalog } from '../types.js';
import type { CallToolResult, ContentBlock } from './protocol.js';

/** Stable URIs the server serves via `resources/read` (R3). */
export const RESOURCE_URIS = {
  toolTypes: 'projection://types/tools.d.ts',
  contract: 'projection://docs/authoring-contract.md',
  happyPath: 'projection://examples/happy-path.ts',
  denialFallback: 'projection://examples/denial-fallback.ts',
} as const;

/** One resource Projection serves, ready to register on the MCP server. */
export interface ProjectionResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  text: string;
  /** Resource-level metadata (e.g. the MCP Apps `ui` object). */
  _meta?: Record<string, unknown>;
}

/**
 * The happy-path example machine. `samples` names its tool on a
 * multi-server facade (R45, {@link toolSamples}); without it the text is
 * {@link EXAMPLE_HAPPY_PATH}.
 */
export function exampleHappyPath(samples?: ToolSamples): string {
  const read = samples?.read ?? { name: 'read_file', placeholder: false };
  return `import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

// Read a file and return the tool's result. Read-only calls run immediately,
// so this whole machine completes in one round trip.
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
        TOOL_RESULT: {
          target: 'done',
          // event.result is the tool's structuredContent when the server
          // returns one (see its Output type in tools.d.ts); otherwise the
          // text of its single text block, null when empty, or the raw
          // content array. isError results arrive as TOOL_ERROR instead.
          actions: assign({ result: ({ event }) => event.result }),
        },
        TOOL_ERROR: {
          target: 'failed',
          actions: assign({ error: ({ event }) => event.error.message }),
        },
      },
    },
    done: { type: 'final' },
    failed: { type: 'final' },
  },
  output: ({ context }) => ({ result: context.result, error: context.error }),
});
`;
}

export const EXAMPLE_HAPPY_PATH = exampleHappyPath();

/** The denial-fallback example machine; `samples` as for {@link exampleHappyPath}. */
export function exampleDenialFallback(samples?: ToolSamples): string {
  const gated = samples?.gated ?? { name: 'write_file', placeholder: false };
  const list = samples?.list ?? { name: 'list_dir', placeholder: false };
  return `import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

// Write a file, but keep going if the user declines. TOOL_DENIED is an
// ordinary transition — denial is never an automatic abort.
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
        TOOL_RESULT: {
          target: 'summarizing',
          actions: assign({ status: 'written' }),
        },
        TOOL_DENIED: {
          // The user said no: record it and carry on with the read-only
          // part of the work instead of failing the whole workflow.
          target: 'summarizing',
          actions: assign({
            status: 'skipped',
            note: ({ event }) => event.reason ?? 'declined by user',
          }),
        },
        TOOL_ERROR: {
          target: 'summarizing',
          actions: assign({ status: 'failed' }),
        },
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

export const EXAMPLE_DENIAL_FALLBACK = exampleDenialFallback();

/**
 * A bare tool name fit to print inside a sample's string literal: S5 names
 * are untrusted, so only plain undotted identifiers-with-dashes qualify (a
 * quote or newline could forge contract text; a dotted name reads as a box).
 */
const SAMPLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * The tool names a multi-server facade's samples call (R45): from the first
 * box in sorted alias order, its first tool that runs immediately under the
 * facade's policy for the happy path (and the denial example's follow-up
 * listing), and its first tool that asks for approval for the denial
 * example. Where the box has none, the sample keeps a generic name in that
 * box and is marked a placeholder.
 */
export function toolSamples(view: BoxedCatalog, policy: PolicyOptions = {}): ToolSamples {
  const box = firstAlias(view);
  const context = policyContext(policy);
  const pick = (decision: 'auto' | 'ask'): string | undefined =>
    membersByBox(view)
      .get(box)
      ?.find(
        (member) =>
          SAMPLE_NAME_PATTERN.test(member.entry.name) &&
          decidePolicy(member.qualified, context) === decision,
      )?.qualified.name;
  const sample = (name: string | undefined, fallback: string) =>
    name !== undefined
      ? { name, placeholder: false }
      : { name: `${box}.${fallback}`, placeholder: true };
  const read = sample(pick('auto'), 'read_file');
  return {
    read,
    gated: sample(pick('ask'), 'write_file'),
    list: read.placeholder ? sample(undefined, 'list_dir') : read,
  };
}

/**
 * What the code-mode copy says about the facade it serves (R39, R45): on a
 * multi-server view, the aliases — never a server-reported identity — and
 * the tool names the samples call; otherwise the S5-untrusted identity,
 * rendered inert (`inertIdentity` supplies its own quotes).
 */
function codeModeSubject(
  catalog: ServerCatalog,
  policy: PolicyOptions | undefined,
): {
  label: string;
  view?: BoxedCatalog;
  samples?: ToolSamples;
} {
  if (!isBoxedCatalog(catalog)) return { label: inertIdentity(catalog.identity) };
  return { label: boxesLabel(catalog), view: catalog, samples: toolSamples(catalog, policy) };
}

/**
 * Build the code-mode resources Projection serves for a wrapped server (R3).
 * On a multi-server view the descriptions name the boxes and the contract
 * and the examples call qualified names from its first box, picked under
 * `policy` (R45, {@link toolSamples}); the box overview resources are the
 * multi-server facade's own (`catalog/box-guidance.ts`).
 */
export function buildResources(
  catalog: ServerCatalog,
  dts: string,
  policy?: PolicyOptions,
): ProjectionResource[] {
  const subject = codeModeSubject(catalog, policy);
  return [
    {
      uri: RESOURCE_URIS.toolTypes,
      name: 'tools.d.ts',
      description: `TypeScript definitions for the tools of ${subject.label}.`,
      mimeType: 'text/plain',
      text: dts,
    },
    {
      uri: RESOURCE_URIS.contract,
      name: 'authoring-contract.md',
      description: 'Rules an authored machine must follow.',
      mimeType: 'text/markdown',
      text: authoringContract(subject.samples),
    },
    {
      uri: RESOURCE_URIS.happyPath,
      name: 'happy-path.ts',
      description: 'Example machine: read-only work, completes in one call.',
      mimeType: 'text/plain',
      text: exampleHappyPath(subject.samples),
    },
    {
      uri: RESOURCE_URIS.denialFallback,
      name: 'denial-fallback.ts',
      description: 'Example machine: continues gracefully when approval is declined.',
      mimeType: 'text/plain',
      text: exampleDenialFallback(subject.samples),
    },
    {
      // MCP Apps dashboard (PRD 12.1): rendered by app-capable hosts when
      // execute_machine completes. Served for hosts, not for models -- the
      // discover_apis links below exclude the ui:// scheme so the authoring
      // surface stays uncluttered.
      uri: DASHBOARD_RESOURCE_URI,
      name: 'dashboard.html',
      description: 'Workflow result dashboard rendered by MCP Apps hosts.',
      mimeType: MCP_APP_MIME_TYPE,
      text: DASHBOARD_HTML,
      _meta: { ui: { prefersBorder: true } },
    },
  ];
}

/** R37: above this many tools, `discover_apis` defers the per-tool list to the catalog tools. */
export const DEFAULT_INLINE_TOOL_THRESHOLD = 40;

export interface DiscoverApisOptions {
  /** Whether the catalog projection (`search_tools` / `describe_tool`) is served (R37). */
  catalog?: boolean;
  /**
   * Tool count above which the inline per-tool list is omitted. Default
   * {@link DEFAULT_INLINE_TOOL_THRESHOLD}; a finite value is floored and
   * clamped at 0, anything else falls back to the default.
   */
  inlineThreshold?: number;
  /**
   * How the R37 pointer names the search tools a multi-server facade serves
   * (R43, R45): `searchToolsPhrase` of the view. Default `search_tools`.
   */
  searchPhrase?: string;
  /**
   * The resources the facade serves, when they go beyond
   * {@link buildResources} (a multi-server facade's box overviews, R45):
   * every one but the `ui://` dashboard is linked.
   */
  resources?: readonly ProjectionResource[];
  /**
   * The facade's policy (R14, R49), which picks the sample tool names on a
   * multi-server view (R45, {@link toolSamples}).
   */
  policy?: PolicyOptions;
}

/** R37: a finite threshold is floored and clamped at 0; anything else is the default. */
function clampInlineThreshold(raw: number | undefined): number {
  return raw !== undefined && Number.isFinite(raw)
    ? Math.max(0, Math.floor(raw))
    : DEFAULT_INLINE_TOOL_THRESHOLD;
}

/**
 * The `discover_apis` result: an inline overview sufficient to author a
 * simple machine unaided, plus resource links for the full artifacts.
 *
 * R37: when the catalog projection is on and the catalog is large, the
 * per-tool overview is replaced by the tool count and a pointer to
 * `search_tools` / `describe_tool` — the `.d.ts` resource stays complete.
 */
export function discoverApis(
  catalog: ServerCatalog,
  overview: string,
  options: DiscoverApisOptions = {},
): CallToolResult {
  const threshold = clampInlineThreshold(options.inlineThreshold);
  const subject = codeModeSubject(catalog, options.policy);
  // Count what the model can reach: typegen and the catalog projection both
  // dedupe by name (S5), so a repeated name is one tool, not two. A
  // multi-server view is deduplicated per box already and counts across
  // every box (R45).
  const toolCount = dedupeTools(catalog.tools).length;
  const deferred = options.catalog === true && toolCount > threshold;
  let toolsSection = overview;
  if (deferred) {
    toolsSection =
      subject.view !== undefined
        ? deferredBoxesSection(subject.view, toolCount, options.searchPhrase ?? 'search_tools')
        : `Tools: ${toolCount} on this server — too many to list here. Call search_tools to find tools by name or purpose and describe_tool for a tool's arguments (types: true adds its TypeScript); the full definitions are in ${RESOURCE_URIS.toolTypes}.`;
  }
  const inline = [
    `Projection code mode over ${subject.label}.`,
    '',
    `XState version: ${XSTATE_VERSION} (pinned). Importable modules: 'xstate', '@astral-mcp/tools'. Nothing else resolves; there is no network and no filesystem.`,
    '',
    toolsSection,
    '',
    authoringContract(subject.samples),
  ].join('\n');

  const links: ContentBlock[] = (options.resources ?? buildResources(catalog, ''))
    .filter((resource) => !resource.uri.startsWith('ui://'))
    .map((resource) => ({
      type: 'resource_link',
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    }));

  return {
    content: [{ type: 'text', text: inline }, ...links],
  };
}

/**
 * R37 on a multi-server facade (R45): the count across every box, the
 * per-box counts, and a pointer at the search tools the facade serves.
 */
function deferredBoxesSection(view: BoxedCatalog, toolCount: number, search: string): string {
  const counts = [...view.counts].map(([alias, count]) => `${alias}: ${count}`).join(', ');
  return `Tools: ${toolCount} across ${boxesLabel(view)} — too many to list here (${counts}). Call ${search} to find tools by name or purpose and describe_tool for a tool's arguments by its qualified name, <box>.<tool> (types: true adds its TypeScript); the full definitions are in ${RESOURCE_URIS.toolTypes}, one tools.<box> property per box.`;
}

/** Which projections a facade serves (R1, R32). */
export interface ProjectionSelection {
  codeMode: boolean;
  catalog: boolean;
}

/**
 * The wrapped server's `instructions`, followed by the preamble for the
 * projections in service (R29). The preamble is library copy the
 * integrating developer can replace wholesale.
 */
export function buildInstructions(
  catalog: ServerCatalog,
  preamble?: string,
  projections: ProjectionSelection = { codeMode: true, catalog: true },
): string {
  const wrapped = catalog.instructions?.trim();
  const copy = preamble ?? defaultPreamble(projections);
  return wrapped !== undefined && wrapped.length > 0 ? `${wrapped}\n\n${copy}` : copy;
}

/**
 * The approval sentence every preamble carries (R29), after its subject —
 * `Tools that change something may pause` (`… may pause the machine` in
 * code mode) — so a wording change lands on every facade at once.
 */
export const APPROVAL_SENTENCE_TAIL = `and ask the user to approve that specific action before it runs; each tool's listing says whether it runs immediately or asks for approval.`;

/** Preamble when only code mode is on (R29). */
export const DEFAULT_CODE_MODE_PREAMBLE = `This server runs in code mode: instead of calling its tools directly, author an XState v5 state machine and run it with execute_machine, which orchestrates the tool calls for you. Tools that change something may pause the machine ${APPROVAL_SENTENCE_TAIL} Call discover_apis first for the tool types, the authoring contract, and worked examples.`;

/** Preamble when only the catalog projection is on (R29, R32). */
export const DEFAULT_CATALOG_PREAMBLE = `This server exposes its tools through a catalog: call search_tools to find a tool, describe_tool to see its arguments, then call_tool to run it. Tools that change something may pause ${APPROVAL_SENTENCE_TAIL}`;

/** Preamble when both projections are on: the routing rule (R29). */
export const DEFAULT_ROUTING_PREAMBLE = `This server offers two ways to use its tools. For a single action or a short chain where you look something up and then act on it, call search_tools to find each tool, describe_tool to see its arguments, and call_tool for each step, reading each result before the next. Author an XState v5 state machine and run it with execute_machine only when the work loops or branches over results, takes many steps, or is a workflow worth saving (call discover_apis first for the tool types, the authoring contract, and worked examples). Either way, tools that change something may pause ${APPROVAL_SENTENCE_TAIL}`;

/** The R29 preamble variant for a projection selection. */
export function defaultPreamble(projections: ProjectionSelection): string {
  if (projections.codeMode && projections.catalog) return DEFAULT_ROUTING_PREAMBLE;
  if (projections.catalog) return DEFAULT_CATALOG_PREAMBLE;
  return DEFAULT_CODE_MODE_PREAMBLE;
}
