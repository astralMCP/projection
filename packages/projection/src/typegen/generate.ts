/**
 * Typegen — produces the `@astral-mcp/tools` artifacts from a ServerCatalog
 * (PRD G6, R3, R4, R30):
 *
 * 1. `.d.ts` text describing the namespaced `tools` API surface,
 * 2. the runtime bridge module source mounted at `@astral-mcp/tools` inside
 *    the QuickJS sandbox, and
 * 3. a compact human-readable overview block for `discover_apis`.
 */

import { boxesLabel, isBoxedCatalog, membersByBox, type BoxedCatalog } from '../catalog/boxes.js';
import { ProjectionError } from '../errors.js';
import { decidePolicy, policyContext, postureOf, type ToolPosture } from '../policy/decision.js';
import {
  capLength,
  inertIdentity,
  MAX_IDENTITY_CHARS,
  neutralizeControlChars,
  purposeSentence,
} from '../text-safety.js';
import {
  type PolicyContext,
  type PolicyOptions,
  dedupeTools,
  type ServerCatalog,
  type ToolCatalog,
  type ToolCatalogEntry,
} from '../types.js';
import { docComment, propertyKey, schemaRequiresArgs, schemaToTsType } from './json-schema.js';

/**
 * Module specifier authored machines import the tools surface from (R4).
 * The sandbox component mounts {@link GeneratedToolTypes.bridgeSource} here.
 */
export const TOOLS_MODULE_SPECIFIER = '@astral-mcp/tools';

/**
 * Name of the global the sandbox host MUST inject before authored code runs.
 *
 * Contract (for the sandbox / machine-host components):
 *
 * ```js
 * globalThis.__projection_toolcall = (name, args) => <host-defined value>
 * ```
 *
 * - `name` is the wrapped server's tool name exactly as catalogued.
 * - `args` is a plain JSON-serializable object (never `undefined`; the
 *   bridge substitutes `{}` for a missing argument).
 * - The bridge performs no I/O itself and returns the hook's value
 *   verbatim. Per R7, authored machines never consume that value as a
 *   promise inside invoked actors — the library-supplied `toolCall` action
 *   is the intended caller, and results come back as TOOL_RESULT /
 *   TOOL_ERROR / TOOL_DENIED events injected by the host.
 * - If the hook is missing, every tool function throws, keeping the bridge
 *   inert outside a properly initialized sandbox (S1).
 */
export const TOOL_CALL_HOST_GLOBAL = '__projection_toolcall';

/** Output of {@link generateToolTypes}. */
export interface GeneratedToolTypes {
  /** `.d.ts` text for the `@astral-mcp/tools` surface (serve via discover_apis, R3). */
  dts: string;
  /** ESM source of the runtime bridge to mount at `@astral-mcp/tools` in the sandbox. */
  bridgeSource: string;
  /** Compact per-tool overview block for inline embedding by discover_apis (R3). */
  overview: string;
  /**
   * Per-tool slice of `dts`, keyed by tool name (R34) — the qualified
   * `<alias>.<name>` on a multi-server view (R45): the alias declarations
   * and the `tools.<name>` (`tools.<alias>.<name>`) member signature exactly
   * as they appear in the full file, so `describe_tool` output type-checks
   * against the `projection://types/tools.d.ts` resource.
   */
  toolTypes: Map<string, ToolTypeText>;
}

/** The generated types for one tool, as served by `describe_tool` (R34). */
export interface ToolTypeText {
  /**
   * `<Pascal>Input` alias name, unique within the `.d.ts` —
   * `<alias>_<Pascal>Input` on a multi-server view (R45).
   */
  inputAlias: string;
  /** `<Pascal>Output` alias name, when the tool declares an `outputSchema`. */
  outputAlias?: string;
  /**
   * The alias declarations verbatim from the `.d.ts`, then the member
   * signature verbatim modulo indentation: the `tools` member is re-indented
   * to column 0 under a `// Member of the \`tools\` surface:` line
   * (`// Member of tools.<alias>:` on a multi-server view, R45).
   */
  dts: string;
}

const PASCAL_FALLBACK = 'Tool';

/**
 * Render the untrusted server identity for safe inclusion in a `//` line
 * comment of generated source.
 *
 * The bridge source is EVALUATED (mounted at `@astral-mcp/tools` and imported
 * by every machine that calls a tool), so a newline in a wrapped server's
 * name or version would terminate the comment and inject executable
 * statements into the bridge — a hostile server would then run code inside
 * the sandbox on every `execute_machine`, regardless of what the model
 * authored (S1/S5). The same string lands in the `.d.ts` header the model
 * reads as authoritative guidance.
 *
 * `inertIdentity` emits a JSON string literal: `JSON.stringify` escapes
 * newlines and quotes, the control/bidi pass covers the characters JSON
 * leaves raw (C1 controls, the U+2028/U+2029 LineTerminators that would
 * otherwise end the comment, bidi marks), and the length cap bounds the
 * artifact.
 */
function commentSafe(text: string): string {
  return inertIdentity(text);
}

/** Derive a unique PascalCase type-name base from a tool name. */
function pascalBase(toolName: string, taken: Set<string>): string {
  const joined = toolName
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => (segment[0] ?? '').toUpperCase() + segment.slice(1))
    .join('');
  let base = /^[A-Za-z]/.test(joined) ? joined : `${PASCAL_FALLBACK}${joined}`;
  if (base.length === 0) base = PASCAL_FALLBACK;
  if (taken.has(base)) {
    let counter = 2;
    while (taken.has(`${base}${counter}`)) counter += 1;
    base = `${base}${counter}`;
  }
  taken.add(base);
  return base;
}

interface ToolTypeNames {
  input: string;
  output: string | undefined;
}

/**
 * One posture vocabulary for every surface (R33): the same words
 * `search_tools` and `describe_tool` use, so a model never sees
 * "[read-only]" on one surface and "runs immediately" on another.
 */
function postureNote(posture: ToolPosture): string {
  switch (posture) {
    case 'runs immediately':
      return 'Runs immediately: no user approval required.';
    case 'asks for approval':
      return 'Asks for approval: pauses for the user to approve this exact call before it runs.';
    case 'blocked by policy':
      return 'Blocked by policy: calls to this tool are refused.';
  }
}

/**
 * The posture sentence plus, whatever the posture, the server's destructive
 * marker: an `auto` or `deny` override does not make a destructive tool any
 * less so, and `search_tools` / `describe_tool` show the flag on every
 * posture too.
 */
function approvalNote(tool: ToolCatalogEntry, context: PolicyContext): string {
  const note = postureNote(postureOf(decidePolicy(tool, context)));
  return tool.annotations?.destructiveHint === true
    ? `${note} The server marks this tool destructive.`
    : note;
}

function toolDoc(tool: ToolCatalogEntry, context: PolicyContext): string {
  const lines: string[] = [];
  if (tool.description !== undefined && tool.description.length > 0) {
    lines.push(tool.description.trim(), '');
  }
  lines.push(approvalNote(tool, context));
  return lines.join('\n');
}

/** The `.d.ts` header lines after its origin line: how to import the surface. */
const DTS_IMPORT_LINES = [
  '//',
  '// Import inside an authored machine module as:',
  `//   import { tools } from '${TOOLS_MODULE_SPECIFIER}';`,
];

/** The closing `.d.ts` header lines: the tool functions are transport only (R7). */
const DTS_TRANSPORT_LINES = [
  '//',
  '// Tool functions are the transport used by the library-supplied',
  '// `toolCall` action. Do NOT wrap them in fromPromise / invoked actors',
  '// (banned pattern R7) — emit toolCall(name, args) and handle the',
  '// TOOL_RESULT / TOOL_ERROR / TOOL_DENIED events instead.',
  '//',
  "// A TOOL_RESULT's `result` is the tool's structuredContent (its Output",
  "// type below), else its single text block's text, parsed when that text",
  '// is JSON for an object or array (the raw text is then `event.text`).',
  '// `event.notes`, when present, says the result looks partial.',
];

/** What {@link toolSection} renders one tool from. */
interface ToolSectionInput {
  /** The tool's own entry: its schemas and the member's property key. */
  tool: ToolCatalogEntry;
  /** The name the alias doc comments quote: the qualified name on a multi-server view. */
  docName: string;
  /** The unique type-name base: `<Pascal>`, or `<alias>_<Pascal>` (R45). */
  base: string;
  /** The member's doc comment text ({@link toolDoc}). */
  doc: string;
  /** Indentation of the member inside the `tools` object type. */
  indent: string;
  /** The `describe_tool` slice's line naming the member's place (R34). */
  memberOf: string;
}

/**
 * One tool's part of a `.d.ts`: its alias declarations (emitted into the
 * file in catalog order, and kept per tool for describe_tool, R34), its
 * member lines inside the `tools` object type, and its `describe_tool` slice.
 */
function toolSection(input: ToolSectionInput): {
  aliasSections: string[];
  memberLines: string[];
  types: ToolTypeText;
} {
  const { tool, docName, base, doc, indent } = input;
  const typeNames: ToolTypeNames = {
    input: `${base}Input`,
    output: tool.outputSchema !== undefined ? `${base}Output` : undefined,
  };
  const aliasSections = [
    `${docComment(`Input for tool "${docName}".`, '')}\n` +
      `export type ${typeNames.input} = ${schemaToTsType(tool.inputSchema)};`,
  ];
  if (typeNames.output !== undefined) {
    aliasSections.push(
      `${docComment(`Output of tool "${docName}".`, '')}\n` +
        `export type ${typeNames.output} = ${schemaToTsType(tool.outputSchema)};`,
    );
  }

  const optional = schemaRequiresArgs(tool.inputSchema) ? '' : '?';
  const returnType = typeNames.output ?? 'unknown';
  const signature = `${propertyKey(tool.name)}: (args${optional}: ${typeNames.input}) => Promise<${returnType}>;`;
  return {
    aliasSections,
    memberLines: [docComment(doc, indent), `${indent}${signature}`],
    types: {
      inputAlias: typeNames.input,
      ...(typeNames.output !== undefined ? { outputAlias: typeNames.output } : {}),
      dts: [...aliasSections, `// ${input.memberOf}\n${docComment(doc, '')}\n${signature}`].join(
        '\n\n',
      ),
    },
  };
}

function generateDts(
  server: ServerCatalog,
  context: PolicyContext,
): { dts: string; toolTypes: Map<string, ToolTypeText> } {
  const taken = new Set<string>();
  const sections: string[] = [];
  const memberLines: string[] = [];
  const toolTypes = new Map<string, ToolTypeText>();

  sections.push(
    [
      `// Generated by Projection from wrapped server ${commentSafe(server.identity)}. Do not edit.`,
      ...DTS_IMPORT_LINES,
      ...DTS_TRANSPORT_LINES,
    ].join('\n'),
  );

  for (const tool of server.tools) {
    const section = toolSection({
      tool,
      docName: tool.name,
      base: pascalBase(tool.name, taken),
      doc: toolDoc(tool, context),
      indent: '  ',
      memberOf: 'Member of the `tools` surface:',
    });
    sections.push(...section.aliasSections);
    memberLines.push(...section.memberLines);
    toolTypes.set(tool.name, section.types);
  }

  const surfaceDoc = docComment(
    `Namespaced tool surface of wrapped server ${commentSafe(server.identity)}.`,
    '',
  );
  const body =
    memberLines.length > 0
      ? `export declare const tools: {\n${memberLines.join('\n')}\n};`
      : 'export declare const tools: Record<string, never>;';
  sections.push(`${surfaceDoc}\n${body}\n\nexport default tools;`);

  return { dts: `${sections.join('\n\n')}\n`, toolTypes };
}

function generateBridgeSource(server: ServerCatalog): string {
  // Assigned imperatively rather than as object-literal keys: a tool named
  // `__proto__` in a literal is the prototype-setter form, which would make
  // `tools` unusable and hide the tool from enumeration while the .d.ts
  // still advertises it. Bracket assignment onto a null-prototype object
  // treats every tool name as ordinary data (S5).
  const memberLines = server.tools.map(
    (tool) => `tools[${JSON.stringify(tool.name)}] = bindTool(${JSON.stringify(tool.name)});`,
  );
  return bridgeModule(
    `// from wrapped server ${commentSafe(server.identity)}. Do not edit.`,
    memberLines,
  );
}

/** The bridge module around its `tools` assignments; `origin` is the second header line. */
function bridgeModule(origin: string, memberLines: string[]): string {
  return [
    `// ${TOOLS_MODULE_SPECIFIER} — runtime bridge generated by Projection`,
    origin,
    '//',
    '// Sandbox-host contract:',
    '//   Before authored code runs, the sandbox host MUST inject:',
    `//     globalThis.${TOOL_CALL_HOST_GLOBAL} = (name, args) => <host-defined>`,
    '//   `name` is the catalogued tool name, `args` a plain JSON-serializable',
    '//   object (the bridge substitutes {} when called without arguments).',
    '//   This module performs no I/O itself; the injected hook is the only',
    '//   channel out of the sandbox (S1), and its return value is handed back',
    '//   verbatim to the caller — the library-supplied `toolCall` action.',
    '',
    'function bindTool(name) {',
    '  return function (args) {',
    `    const hook = globalThis[${JSON.stringify(TOOL_CALL_HOST_GLOBAL)}];`,
    "    if (typeof hook !== 'function') {",
    '      throw new Error(',
    `        'Projection tools bridge: missing host hook globalThis.${TOOL_CALL_HOST_GLOBAL}. ' +`,
    "          'The sandbox host must inject it before authored code runs.',",
    '      );',
    '    }',
    '    return hook(name, args === undefined ? {} : args);',
    '  };',
    '}',
    '',
    'const tools = Object.create(null);',
    ...memberLines,
    'Object.freeze(tools);',
    '',
    'export { tools };',
    'export default tools;',
    '',
  ].join('\n');
}

function overviewFlags(tool: ToolCatalogEntry, context: PolicyContext): string {
  const posture = postureOf(decidePolicy(tool, context));
  return tool.annotations?.destructiveHint === true ? `[${posture}, destructive]` : `[${posture}]`;
}

/**
 * The one-line purpose shown per tool: the first sentence of the
 * description, neutralized and capped — the same rule `search_tools` uses
 * (R33), so both projections describe a tool identically.
 */
function purposeLine(text: string | undefined): string {
  return purposeSentence(text) ?? '(no description)';
}

function generateOverview(server: ServerCatalog, context: PolicyContext): string {
  // The overview is inlined into the discover_apis text the model reads as
  // guidance, so the S5-controlled identity renders inert and quoted.
  const lines = [`Tools (server: ${inertIdentity(server.identity)}):`];
  if (server.tools.length === 0) {
    lines.push('  (none)');
  }
  for (const tool of server.tools) lines.push(overviewLine(tool, context));
  return `${lines.join('\n')}\n`;
}

/**
 * One overview line, `- name [flags] — purpose`, for the entry policy is
 * decided on (the qualified entry on a multi-server view).
 *
 * Tool names and descriptions are S5-controlled: neutralize both so a
 * hostile name cannot forge extra overview lines (e.g. relabel a destructive
 * tool "[runs immediately]" on a line of its own) and no ESC/ANSI/bidi
 * characters reach the model's guidance. Plain neutralization — not JSON
 * quoting like the identity — keeps the `- name [flags] — description` shape
 * the model matches against readable; the flags stay trustworthy because any
 * injected copy is flattened into the (capped) name field of its single
 * line. `purposeLine` neutralizes and caps the description (first sentence,
 * at most 200 chars — see `purposeSentence`); names get the identity cap.
 */
function overviewLine(tool: ToolCatalogEntry, context: PolicyContext): string {
  const name = capLength(neutralizeControlChars(tool.name), MAX_IDENTITY_CHARS);
  return `- ${name} ${overviewFlags(tool, context)} — ${purposeLine(tool.description)}`;
}

// ---------------------------------------------------------------------------
// Multi-server views (R45): one `tools.<alias>` object type per box
// ---------------------------------------------------------------------------

/**
 * The `.d.ts` of a multi-server view (R45). Each box is a property of the
 * `tools` object type — an object type, never a TypeScript `namespace`, so a
 * reserved word (`delete`, `class`) is a valid alias — and its tools are
 * properties of that, quoted when they are not identifiers. Type aliases are
 * `<alias>_<Pascal>Input` / `<alias>_<Pascal>Output`: an alias contains no
 * `_` (R39), so a name maps back to exactly one box and no two boxes'
 * aliases can collide, whichever other boxes are wrapped. One section per
 * box, in sorted alias order. Postures are decided on the qualified entry,
 * so facade policy keyed by qualified names and per-box approvals modes
 * apply (R42, R49).
 */
function generateBoxedDts(
  view: BoxedCatalog,
  context: PolicyContext,
): { dts: string; toolTypes: Map<string, ToolTypeText> } {
  const label = boxesLabel(view);
  const sections: string[] = [
    [
      `// Generated by Projection from ${label}. Do not edit.`,
      ...DTS_IMPORT_LINES,
      '//',
      '// Tool names are qualified: each box is a property of `tools`, and its',
      '// tools are properties of that (tools.<box>.<tool>). Call a tool with',
      "// toolCall('<box>.<tool>', args).",
      ...DTS_TRANSPORT_LINES,
    ].join('\n'),
  ];
  const boxLines: string[] = [];
  const toolTypes = new Map<string, ToolTypeText>();

  for (const [alias, members] of membersByBox(view)) {
    // Pascal bases are unique per box; the alias prefix keeps boxes apart.
    const taken = new Set<string>();
    const memberLines: string[] = [];
    sections.push(
      `// Box ${alias}: tools.${alias}.<tool>, called as toolCall('${alias}.<tool>', args).`,
    );
    for (const member of members) {
      // The member's key and schemas are the box's own (bare) entry; its
      // doc and posture are the qualified entry's, never the bare one's,
      // whose name can spell another box's tool (boxes.ts).
      const section = toolSection({
        tool: member.entry,
        docName: member.qualified.name,
        base: `${alias}_${pascalBase(member.entry.name, taken)}`,
        doc: toolDoc(member.qualified, context),
        indent: '    ',
        memberOf: `Member of tools.${alias}:`,
      });
      sections.push(...section.aliasSections);
      memberLines.push(...section.memberLines);
      toolTypes.set(member.qualified.name, section.types);
    }
    const box = view.boxes.get(alias);
    // The description is host-trusted (R39), neutralized and capped at wrap
    // time; docComment neutralizes and escapes it again regardless.
    const boxDoc =
      box?.description !== undefined ? `The ${alias} box: ${box.description}` : `The ${alias} box.`;
    boxLines.push(
      docComment(boxDoc, '  '),
      memberLines.length > 0
        ? `  ${alias}: {\n${memberLines.join('\n')}\n  };`
        : `  ${alias}: Record<string, never>;`,
    );
  }

  const surfaceDoc = docComment(`Tool surface of ${label}, one property per box.`, '');
  sections.push(
    `${surfaceDoc}\nexport declare const tools: {\n${boxLines.join('\n')}\n};\n\nexport default tools;`,
  );
  return { dts: `${sections.join('\n\n')}\n`, toolTypes };
}

/**
 * The runtime bridge of a multi-server view: `tools.<alias>.<name>` binds
 * the qualified name, so a bridge call reaches the host exactly as
 * `toolCall('<alias>.<name>', …)` does and is routed by alias (R45). Same
 * imperative, null-prototype construction as the single-server bridge (S5).
 */
function generateBoxedBridgeSource(view: BoxedCatalog): string {
  const memberLines: string[] = [];
  for (const [alias, members] of membersByBox(view)) {
    const box = `tools[${JSON.stringify(alias)}]`;
    memberLines.push(`${box} = Object.create(null);`);
    for (const member of members) {
      memberLines.push(
        `${box}[${JSON.stringify(member.entry.name)}] = bindTool(${JSON.stringify(member.qualified.name)});`,
      );
    }
    memberLines.push(`Object.freeze(${box});`);
  }
  // Aliases are grammar-checked (buildBoxedCatalog), but this header is
  // evaluated source: render it inert like the single-server identity.
  return bridgeModule(`// from ${commentSafe(boxesLabel(view))}. Do not edit.`, memberLines);
}

/**
 * The `discover_apis` overview of a multi-server view (R45): the tool list
 * grouped per box under alias headings, each tool by its qualified name.
 * Box headings carry the host's description, never a server's identity.
 */
function generateBoxedOverview(view: BoxedCatalog, context: PolicyContext): string {
  const lines = ['Tools by box — call each by its qualified name, <box>.<tool>:'];
  for (const [alias, members] of membersByBox(view)) {
    const count = `${members.length} ${members.length === 1 ? 'tool' : 'tools'}`;
    const description = view.boxes.get(alias)?.description;
    lines.push(
      description !== undefined ? `${alias} — ${description} (${count}):` : `${alias} (${count}):`,
    );
    if (members.length === 0) lines.push('  (none)');
    // The qualified name carries the S5 bare name: neutralized and capped
    // exactly like a single-server overview line.
    for (const member of members) lines.push(overviewLine(member.qualified, context));
  }
  return `${lines.join('\n')}\n`;
}

function resolveSingleServer(catalog: ToolCatalog | ServerCatalog): ServerCatalog {
  if ('servers' in catalog) {
    if (catalog.servers.size !== 1) {
      throw new ProjectionError(
        'protocol',
        `Typegen requires exactly one wrapped server; catalog has ${catalog.servers.size}.`,
        {
          hint: 'Pass a single-entry catalog or a ServerCatalog, or, for several servers, use `wrapMcpServers` (its `facade.dts`).',
        },
      );
    }
    const server = catalog.servers.values().next().value;
    if (server === undefined) {
      throw new ProjectionError('protocol', 'Tool catalog contains no servers.', {
        hint: 'Build the catalog with createIntrospector before generating types.',
      });
    }
    return server;
  }
  return catalog;
}

/**
 * Generate the `@astral-mcp/tools` artifacts for a wrapped server.
 *
 * Accepts the full aliased {@link ToolCatalog} (exactly one server: R30's
 * single-instance instantiation), a {@link ServerCatalog} directly, or the
 * multi-server view of a `wrapMcpServers` facade, which gets one
 * `tools.<alias>` object type per box and qualified names throughout (R45).
 */
export function generateToolTypes(
  catalog: ToolCatalog | ServerCatalog,
  options: GenerateToolTypesOptions = {},
): GeneratedToolTypes {
  if (!('servers' in catalog) && isBoxedCatalog(catalog)) {
    const context = policyContext(options);
    const { dts, toolTypes } = generateBoxedDts(catalog, context);
    return {
      dts,
      bridgeSource: generateBoxedBridgeSource(catalog),
      overview: generateBoxedOverview(catalog, context),
      toolTypes,
    };
  }
  const server = dedupeToolNames(resolveSingleServer(catalog));
  const context = policyContext(options);
  const { dts, toolTypes } = generateDts(server, context);
  return {
    dts,
    bridgeSource: generateBridgeSource(server),
    overview: generateOverview(server, context),
    toolTypes,
  };
}

/**
 * The policy options (R14, R49) decide the posture wording in the doc
 * comments and the overview.
 */
export type GenerateToolTypesOptions = PolicyOptions;

/**
 * Drop tools whose name repeats an earlier one, first occurrence wins.
 *
 * A wrapped server may return the same tool name twice (S5: the catalog is
 * untrusted). Emitting it twice would produce a duplicate member in the
 * `.d.ts` object type — invalid TypeScript — and a silently last-wins
 * shadowed key in the bridge, so the types and the runtime would disagree
 * about which schema the tool takes. Collapsing to the first occurrence
 * (`dedupeTools`, shared with `findTool` and the catalog projection) matches
 * what `callTool` reaches on the wrapped server.
 */
function dedupeToolNames(server: ServerCatalog): ServerCatalog {
  const tools = dedupeTools(server.tools);
  return tools.length === server.tools.length ? server : { ...server, tools };
}
