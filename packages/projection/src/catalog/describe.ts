/**
 * `describe_tool` — everything the model needs to call one tool (PRD R34).
 *
 * Returns the sanitized description, the input/output JSON Schemas (through
 * the S5 allowlist sanitizer), the annotations as hints, the resolved policy
 * posture, and the generated TypeScript for the tool — the same alias
 * declarations and member signature that appear in
 * `projection://types/tools.d.ts`, so a machine authored from this output
 * type-checks against the full resource.
 *
 * This is the injection surface of the catalog projection: the wrapped
 * server's own words reach the model here. The description is rendered as
 * an indented block so a hostile value cannot forge a top-level line such
 * as `Posture: runs immediately`; every other string passes through the
 * schema sanitizer or `neutralizeControlChars`.
 */

import { ProjectionError } from '../errors.js';
import { decidePolicy } from '../policy/index.js';
import {
  capLength,
  indentBlock,
  inertIdentity,
  MAX_IDENTITY_CHARS,
  neutralizeControlChars,
} from '../text-safety.js';
import type { CallToolResult } from '../mrtr/protocol.js';
import type { ToolTypeText } from '../typegen/index.js';
import {
  findTool,
  type PolicyOverrides,
  type ServerCatalog,
  type ToolAnnotations,
} from '../types.js';
import { sanitizeSchema } from './schema-safety.js';
import { postureOf, type ToolPosture } from './search.js';

export interface DescribeToolArgs {
  name: string;
}

export interface DescribeToolOptions {
  /** Per-tool policy overrides (R14); decides the rendered posture. */
  policy?: PolicyOverrides;
  /** Per-tool generated types from typegen (R34). */
  toolTypes?: ReadonlyMap<string, ToolTypeText>;
}

/** `structuredContent` of a `describe_tool` result (R34). */
export interface ToolDescription {
  name: string;
  /** Neutralized, capped description; `undefined` when the server gave none. */
  description?: string;
  posture: ToolPosture;
  destructive: boolean;
  /** The server's annotations, as untrusted hints (S5); `title` neutralized. */
  annotations: ToolAnnotations;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** True when either schema had to be reduced to fit the R34 cap. */
  schemaTruncated: boolean;
  /** Generated TypeScript for this tool, as in `projection://types/tools.d.ts`. */
  types?: string;
}

const MAX_DESCRIPTION_CHARS = 2_000;

/**
 * Run `describe_tool`. Throws a `validate`-phase {@link ProjectionError}
 * when the wrapped server declares no such tool (R34).
 */
export function describeTool(
  catalog: ServerCatalog,
  args: DescribeToolArgs,
  options: DescribeToolOptions = {},
): CallToolResult {
  const entry = findTool(catalog, args.name);
  if (entry === undefined) {
    const shown = JSON.stringify(capLength(neutralizeControlChars(args.name), MAX_IDENTITY_CHARS));
    throw new ProjectionError(
      'validate',
      `Unknown tool ${shown}: the wrapped server does not declare it`,
      {
        hint: 'Call search_tools to list the tools this server declares, then describe_tool with one of those names exactly.',
      },
    );
  }

  const input = sanitizeSchema(entry.inputSchema);
  const output = entry.outputSchema !== undefined ? sanitizeSchema(entry.outputSchema) : undefined;
  const annotations = sanitizeAnnotations(entry.annotations);
  const description =
    entry.description !== undefined && entry.description.trim().length > 0
      ? neutralizeControlChars(capLength(entry.description.trim(), MAX_DESCRIPTION_CHARS), {
          allowNewline: true,
        })
      : undefined;
  const types = options.toolTypes?.get(entry.name)?.dts;

  const described: ToolDescription = {
    name: entry.name,
    ...(description !== undefined ? { description } : {}),
    posture: postureOf(decidePolicy(entry, options.policy)),
    destructive: entry.annotations?.destructiveHint === true,
    annotations,
    inputSchema: input.schema,
    ...(output !== undefined ? { outputSchema: output.schema } : {}),
    schemaTruncated: input.truncated || (output?.truncated ?? false),
    ...(types !== undefined ? { types } : {}),
  };

  return {
    content: [{ type: 'text', text: render(catalog, described) }],
    structuredContent: { ...described },
  };
}

function sanitizeAnnotations(annotations: ToolAnnotations | undefined): ToolAnnotations {
  if (annotations === undefined) return {};
  const out: ToolAnnotations = {};
  if (typeof annotations.readOnlyHint === 'boolean') out.readOnlyHint = annotations.readOnlyHint;
  if (typeof annotations.destructiveHint === 'boolean') {
    out.destructiveHint = annotations.destructiveHint;
  }
  if (typeof annotations.idempotentHint === 'boolean')
    out.idempotentHint = annotations.idempotentHint;
  if (typeof annotations.title === 'string') {
    out.title = neutralizeControlChars(capLength(annotations.title, MAX_IDENTITY_CHARS));
  }
  return out;
}

function render(catalog: ServerCatalog, tool: ToolDescription): string {
  const name = capLength(neutralizeControlChars(tool.name), MAX_IDENTITY_CHARS);
  const lines: string[] = [
    `Tool ${JSON.stringify(name)} on server ${inertIdentity(catalog.identity)}`,
  ];
  lines.push(
    `Posture: ${tool.posture}${tool.destructive ? ' (the server marks this tool destructive)' : ''}`,
  );
  if (tool.annotations.title !== undefined) {
    lines.push(`Title (server-provided): ${JSON.stringify(tool.annotations.title)}`);
  }
  // The description is the server's own words (S5): indented as a block so
  // it reads as data and cannot forge one of the labelled lines above.
  lines.push('What the server says it does:', indentBlock(tool.description ?? '(no description)'));
  lines.push('', 'Input schema (JSON Schema):', jsonBlock(tool.inputSchema));
  if (tool.outputSchema !== undefined) {
    lines.push('', 'Output schema (JSON Schema):', jsonBlock(tool.outputSchema));
  } else {
    lines.push('', 'Output schema: none declared — results arrive as text.');
  }
  if (tool.schemaTruncated) {
    lines.push(
      '',
      '[schema truncated to fit the size cap — the wrapped server enforces the full schema]',
    );
  }
  if (tool.types !== undefined) {
    // Typegen neutralizes its doc comments, but the slice is rendered here as
    // prose for the model, so it gets the block treatment regardless.
    lines.push(
      '',
      'TypeScript (as in projection://types/tools.d.ts):',
      indentBlock(neutralizeControlChars(tool.types, { allowNewline: true })),
    );
  }
  return lines.join('\n');
}

/**
 * A sanitized schema as an indented JSON block. The sanitizer neutralizes
 * every string VALUE but keeps property names verbatim, and `JSON.stringify`
 * leaves C1 controls, U+2028/U+2029 and bidi marks raw — so the rendered text
 * is neutralized again as a whole (newlines kept: they are the pretty-print).
 * `structuredContent` carries the schema verbatim; this is the text copy.
 */
function jsonBlock(schema: Record<string, unknown>): string {
  return indentBlock(
    neutralizeControlChars(JSON.stringify(schema, null, 2), { allowNewline: true }),
  );
}
