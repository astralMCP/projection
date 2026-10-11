import type Anthropic from '@anthropic-ai/sdk';

/**
 * Names of the tools offered to the model. The harness only ever passes
 * named `Anthropic.Tool`s; the SDK's toolset members (no `name`) are
 * narrowed away so the union type-checks.
 */
export function toolNames(tools: Anthropic.ToolUnion[] | undefined): string[] {
  return (tools ?? []).flatMap((t) => ('name' in t ? [t.name] : []));
}
