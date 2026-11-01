/**
 * Where a model preset is served from, when it is not the Anthropic API
 * (openai-compat.ts). Kept free of imports so the presets in agent.ts and
 * the caller in openai-compat.ts can both use it.
 */

/** An OpenAI-compatible endpoint a model preset is served from. */
export interface OpenAiCompatProvider {
  kind: 'openai-compatible';
  /** Label for messages, e.g. `openrouter`. */
  name: string;
  /** Base URL without the trailing `/chat/completions`. */
  baseURL: string;
  /** The env variable holding the API key (never logged). */
  apiKeyEnv: string;
  /** Extra request fields merged into every request (provider routing, reasoning). */
  extraBody?: Record<string, unknown>;
}

/** OpenRouter's OpenAI-compatible endpoint, keyed by OPENROUTER_API_KEY. */
export const OPENROUTER: OpenAiCompatProvider = {
  kind: 'openai-compatible',
  name: 'openrouter',
  baseURL: 'https://openrouter.ai/api/v1',
  apiKeyEnv: 'OPENROUTER_API_KEY',
};
