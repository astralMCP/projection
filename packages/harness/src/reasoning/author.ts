/**
 * Machine authors — the pluggable "model" side of the reasoning loop
 * (PRD §13 "Automated harness").
 *
 * An author turns a task prompt (plus the API docs and any previous
 * attempt's structured error) into machine module source. Two authors ship:
 * a deterministic scripted author for CI, and an Anthropic-SDK author for
 * live benchmark runs (see `anthropic.ts`).
 */

import type { ProjectionFacade } from '@astral-mcp/projection';

/** The structured error fed back for self-healing (R25). */
export interface AttemptErrorView {
  phase: string;
  message: string;
  hint: string;
}

/** Everything an author sees when producing one attempt. */
export interface AuthoringContext {
  /** The benchmark task prompt (what the "user" asked for). */
  task: string;
  /** API docs: discover_apis overview plus every projection:// resource. */
  apiDocs: string;
  /** 1-based attempt number. */
  attempt: number;
  /** The previous attempt and why it failed (absent on attempt 1). */
  previous?: { code: string; error: AttemptErrorView };
}

/** Produces machine module source for a task. */
export interface MachineAuthor {
  /** Reported in benchmark results (e.g. a model id). */
  name: string;
  author(ctx: AuthoringContext): Promise<string>;
}

/**
 * Build the API documentation string handed to authors: the same content a
 * real MCP client reads — the discover_apis overview plus the full text of
 * every `projection://` resource (tool types, authoring contract, examples).
 * `ui://` app resources are host-render surfaces, not authoring docs, and
 * are excluded (DECISIONS.md D5: models never see the app surface).
 */
export function buildApiDocs(facade: ProjectionFacade): string {
  const overview = facade
    .discoverApis()
    .content.filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text',
    )
    .map((block) => block.text)
    .join('\n\n');
  const resources = facade.resources
    .filter((resource) => !resource.uri.startsWith('ui://'))
    .map((resource) => `## ${resource.name} (${resource.uri})\n\n${resource.text}`);
  return [overview, ...resources].join('\n\n---\n\n');
}

/**
 * A deterministic author that replays a scripted sequence of sources, one
 * per attempt — the CI stand-in for a model. Attempts beyond the script
 * replay the last entry.
 */
export function createScriptedAuthor(name: string, attempts: readonly string[]): MachineAuthor {
  if (attempts.length === 0) {
    throw new Error('scripted author needs at least one attempt source');
  }
  return {
    name,
    author: (ctx) =>
      Promise.resolve(attempts[Math.min(ctx.attempt, attempts.length) - 1] as string),
  };
}

/**
 * Extract machine module source from a model reply: the LAST fenced code
 * block (models often restate the docs' examples first), else the whole
 * reply trimmed.
 *
 * Both fences are anchored to line start so an inline ``` in prose can
 * never pair with a real block's opener, and the info string accepts any
 * tag (tsx, mjs, ...) rather than an allow-list.
 */
export function extractModuleSource(reply: string): string {
  const fences = [...reply.matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gm)];
  const last = fences[fences.length - 1];
  if (last?.[1] !== undefined) return last[1].trim();
  return reply.trim();
}
