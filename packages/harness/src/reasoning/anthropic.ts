/**
 * Anthropic-SDK machine author — the live half of the reasoning loop
 * (PRD §13: "using the Anthropic TypeScript SDK as the reasoning loop").
 *
 * Not exercised in CI: live benchmark tests skip without ANTHROPIC_API_KEY.
 */

import Anthropic from '@anthropic-ai/sdk';
import { extractModuleSource, type AuthoringContext, type MachineAuthor } from './author.js';

export interface AnthropicAuthorOptions {
  /** Model id. Default: `claude-opus-5`. */
  model?: string;
  /**
   * Max output tokens per attempt. Default: 64000 — adaptive thinking
   * spends from the same budget, so a low ceiling truncates code mid-fence.
   */
  maxTokens?: number;
  /** Injected client (tests); defaults to `new Anthropic()` reading the env key. */
  client?: Anthropic;
}

const SYSTEM_PROMPT = `You author XState v5 state machine modules for Projection's execute_machine tool.

Reply with exactly one fenced TypeScript code block containing the complete module and nothing else after it. The module must follow the authoring contract in the API documentation below: default-export a machine built with setup(...).createMachine(...), request tools only via the toolCall action from '@astral-mcp/tools', handle TOOL_RESULT / TOOL_ERROR / TOOL_DENIED, keep context JSON-serializable, and never use invoke or fromPromise.

When you receive a structured error from a previous attempt, fix exactly what it describes and return the corrected complete module.`;

function attemptPrompt(ctx: AuthoringContext): string {
  if (ctx.previous === undefined) {
    return `# API documentation\n\n${ctx.apiDocs}\n\n# Task\n\n${ctx.task}`;
  }
  const { code, error } = ctx.previous;
  return [
    `Your previous machine for the task "${ctx.task}" failed.`,
    `Previous module:\n\n\`\`\`ts\n${code}\n\`\`\``,
    `Structured error:\n\n\`\`\`json\n${JSON.stringify(error, null, 2)}\n\`\`\``,
    'Return the corrected complete module.',
  ].join('\n\n');
}

/** Create a live author backed by the Anthropic API. */
export function createAnthropicAuthor(options: AnthropicAuthorOptions = {}): MachineAuthor {
  const model = options.model ?? 'claude-opus-5';
  const client = options.client ?? new Anthropic();
  return {
    name: model,
    async author(ctx) {
      // Streaming avoids request timeouts on long thinking turns; the loop
      // only needs the final message.
      const message = await client.messages
        .stream({
          model,
          max_tokens: options.maxTokens ?? 64000,
          thinking: { type: 'adaptive' },
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: attemptPrompt(ctx) }],
        })
        .finalMessage();
      // A truncated or refused reply is a harness failure, not an authoring
      // failure — booking it as an invalid machine would corrupt the §10
      // valid-machine metric, so fail the run loudly instead.
      if (message.stop_reason !== 'end_turn') {
        throw new Error(
          `authoring reply ended with stop_reason "${message.stop_reason}" (model ${model}); ` +
            'raise maxTokens or inspect the refusal before trusting benchmark numbers',
        );
      }
      const reply = message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n');
      return extractModuleSource(reply);
    },
  };
}
