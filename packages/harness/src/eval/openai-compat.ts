/**
 * An OpenAI-compatible model provider for the eval (non-Anthropic models).
 *
 * The agent loop speaks the Anthropic Messages shape end to end (agent.ts),
 * so a provider plugs in at the one seam it already has: the
 * {@link ModelCaller}. This caller takes the exact request the loop builds
 * (`buildTurnRequest`), translates it to a Chat Completions request, posts
 * it, and translates the answer back into an `Anthropic.Message`. Nothing
 * upstream of the caller changes, so every mode, task, grader and report
 * runs unmodified on the other models.
 *
 * Translation, from the OpenAI Chat Completions tool-calling shape as
 * OpenRouter documents it (openrouter.ai/docs/guides/features/tool-calling,
 * read 2026-10-31):
 *
 * - system blocks → one `system` message (cache breakpoints dropped);
 * - client tools → `{ type: 'function', function: { name, description,
 *   parameters } }`; Anthropic server tools and their fields
 *   (`defer_loading`, `allowed_callers`, the search / code execution tools)
 *   have no equivalent and are rejected — the native modes are
 *   Anthropic-only;
 * - an assistant turn's text → `content`, its `tool_use` blocks →
 *   `tool_calls` (input as a JSON string), its thinking → `reasoning` and
 *   `reasoning_details` (OpenRouter's documented way to preserve reasoning
 *   across tool calls; the details ride in the thinking block's
 *   `signature`, opaque to the loop);
 * - a user turn's `tool_result` blocks → one `role: 'tool'` message each (in
 *   order), then any text as a `user` message;
 * - the response's `content` / `reasoning` / `tool_calls` → text, thinking
 *   and `tool_use` blocks; `finish_reason` → `stop_reason` (`tool_calls` →
 *   `tool_use`, `stop` → `end_turn` unless tool calls are present,
 *   `length` → `max_tokens`, `content_filter` → `refusal`);
 * - usage (openrouter.ai/docs/use-cases/usage-accounting, read
 *   2026-10-31): `prompt_tokens` includes cached tokens, so uncached input
 *   = `prompt_tokens − cached_tokens − cache_write_tokens`;
 *   `cached_tokens` → cache read, `cache_write_tokens` → cache write;
 *   `usage.cost` (USD credits, always present on OpenRouter) is kept on
 *   the message as `usage.provider_cost_usd`.
 *
 * Prompt caching: OpenRouter's Moonshot (Kimi) endpoints cache prefixes
 * automatically with no request changes and no write fee (their prompt
 * caching guide); OpenRouter lists a cache-read price for Muse Spark but
 * documents no Meta-specific caching mechanism, so its hit rate is
 * whatever the provider's automatic caching gives. No `cache_control` is
 * sent: the Anthropic-style breakpoints the loop places mean nothing to
 * these providers, so the comparison with Anthropic models is "each
 * provider's own default caching", read from the reported usage.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { ContextOverflowError, isContextOverflowMessage, type ModelCaller } from './agent.js';
import type { OpenAiCompatProvider } from './providers.js';

export { OPENROUTER, type OpenAiCompatProvider } from './providers.js';

// ---------------------------------------------------------------------------
// Wire types (the subset of Chat Completions the eval uses)

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type OpenAiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAiToolCall[];
      reasoning?: string;
      reasoning_details?: unknown[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface OpenAiRequest {
  model: string;
  max_tokens: number;
  messages: OpenAiMessage[];
  tools?: OpenAiTool[];
  [extra: string]: unknown;
}

export interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
  cost?: number;
}

export interface OpenAiResponse {
  id?: string;
  model?: string;
  choices?: {
    finish_reason?: string | null;
    native_finish_reason?: string | null;
    message?: {
      role?: string;
      content?: string | null;
      reasoning?: string | null;
      reasoning_details?: unknown[] | null;
      tool_calls?: OpenAiToolCall[] | null;
      refusal?: string | null;
    };
  }[];
  usage?: OpenAiUsage;
  error?: { message?: string; code?: number | string };
}

// ---------------------------------------------------------------------------
// Request translation

function textOf(content: string | Anthropic.ContentBlockParam[] | undefined): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

/** A tool_result's content as the text the model sees. */
function toolResultText(block: Anthropic.ToolResultBlockParam): string {
  const content = block.content;
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

/** The Anthropic tool list as functions; server tools and their fields throw. */
export function toOpenAiTools(tools: readonly Anthropic.ToolUnion[] | undefined): OpenAiTool[] {
  return (tools ?? []).map((tool) => {
    const plain = tool as Partial<Anthropic.Tool> & { type?: string };
    if (
      plain.input_schema === undefined ||
      (plain.type !== undefined && plain.type !== 'custom') ||
      plain.defer_loading === true ||
      plain.allowed_callers !== undefined
    ) {
      throw new Error(
        `tool ${String(plain.name ?? plain.type)} is an Anthropic server tool or uses a server-tool field; ` +
          'the native modes are Anthropic-only',
      );
    }
    return {
      type: 'function',
      function: {
        name: plain.name as string,
        description: plain.description ?? '',
        parameters: plain.input_schema as Record<string, unknown>,
      },
    };
  });
}

/** One Anthropic message as zero or more Chat Completions messages. */
function toOpenAiMessages(message: Anthropic.MessageParam): OpenAiMessage[] {
  if (typeof message.content === 'string') {
    return [{ role: message.role, content: message.content }] as OpenAiMessage[];
  }
  if (message.role === 'user') {
    const out: OpenAiMessage[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: toolResultText(block) });
      }
    }
    const text = textOf(message.content);
    if (text !== '') out.push({ role: 'user', content: text });
    return out;
  }
  // Assistant.
  const blocks = message.content as Anthropic.ContentBlockParam[];
  const text = textOf(blocks);
  const toolCalls: OpenAiToolCall[] = blocks.flatMap((block) =>
    block.type === 'tool_use'
      ? [
          {
            id: block.id,
            type: 'function' as const,
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          },
        ]
      : [],
  );
  const thinking = blocks.flatMap((block) => (block.type === 'thinking' ? [block] : []));
  const reasoning = thinking.map((block) => block.thinking).join('\n');
  const details = thinking.flatMap((block) => restoreDetails(block.signature));
  return [
    {
      role: 'assistant',
      content: text === '' ? null : text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(reasoning !== '' ? { reasoning } : {}),
      ...(details.length > 0 ? { reasoning_details: details } : {}),
    },
  ];
}

/** `reasoning_details` stashed in a thinking block's signature ({@link fromOpenAiResponse}). */
function restoreDetails(signature: string): unknown[] {
  if (!signature.startsWith(DETAILS_PREFIX)) return [];
  try {
    const parsed: unknown = JSON.parse(signature.slice(DETAILS_PREFIX.length));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const DETAILS_PREFIX = 'openai-compat:reasoning_details:';

/** The loop's request as a Chat Completions request. */
export function toOpenAiRequest(
  params: Pick<
    Anthropic.MessageStreamParams,
    'model' | 'max_tokens' | 'system' | 'messages' | 'tools'
  >,
  extraBody: Record<string, unknown> = {},
): OpenAiRequest {
  const system =
    typeof params.system === 'string'
      ? params.system
      : (params.system ?? []).map((block) => block.text).join('\n');
  const messages: OpenAiMessage[] = [
    ...(system !== '' ? [{ role: 'system' as const, content: system }] : []),
    ...params.messages.flatMap(toOpenAiMessages),
  ];
  const tools = toOpenAiTools(params.tools);
  return {
    model: params.model,
    max_tokens: params.max_tokens,
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...extraBody,
  };
}

// ---------------------------------------------------------------------------
// Response translation

const STOP_REASONS: Record<string, Anthropic.StopReason> = {
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  stop: 'end_turn',
  length: 'max_tokens',
  content_filter: 'refusal',
};

/** Parse a tool call's arguments; unparseable ones are kept raw so the tool rejects them visibly. */
function parseArguments(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { _arguments: parsed };
  } catch {
    return { _unparseable_arguments: raw };
  }
}

/** A Chat Completions response as the `Anthropic.Message` the loop reads. */
export function fromOpenAiResponse(
  body: OpenAiResponse,
  requestedModel: string,
): Anthropic.Message {
  const choice = body.choices?.[0];
  if (choice === undefined) {
    throw new Error(
      `no choices in response${body.error?.message ? `: ${body.error.message}` : ''}`,
    );
  }
  const reply = choice.message ?? {};
  const content: unknown[] = [];
  const reasoning = reply.reasoning ?? '';
  const details = reply.reasoning_details ?? [];
  if (reasoning !== '' || details.length > 0) {
    content.push({
      type: 'thinking',
      thinking: reasoning,
      signature: details.length > 0 ? `${DETAILS_PREFIX}${JSON.stringify(details)}` : '',
    });
  }
  const text = reply.content ?? '';
  if (text !== '') content.push({ type: 'text', text, citations: null });
  const calls = reply.tool_calls ?? [];
  for (const call of calls) {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseArguments(call.function.arguments),
      caller: { type: 'direct' },
    });
  }
  const finish = choice.finish_reason ?? '';
  const stop: Anthropic.StopReason =
    calls.length > 0
      ? 'tool_use'
      : (STOP_REASONS[finish] ?? (reply.refusal ? 'refusal' : 'end_turn'));
  const usage = body.usage ?? {};
  const prompt = usage.prompt_tokens ?? 0;
  const read = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const write = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
  return {
    id: body.id ?? 'openai-compat',
    type: 'message',
    role: 'assistant',
    model: body.model ?? requestedModel,
    content,
    stop_reason: stop,
    stop_sequence: null,
    container: null,
    usage: {
      input_tokens: Math.max(0, prompt - read - write),
      output_tokens: usage.completion_tokens ?? 0,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: write,
      ...(typeof usage.cost === 'number' ? { provider_cost_usd: usage.cost } : {}),
    },
  } as unknown as Anthropic.Message;
}

// ---------------------------------------------------------------------------
// The caller

/** Thrown for a non-retryable HTTP failure; carries the status like the SDK's errors do. */
export class OpenAiCompatError extends Error {
  override name = 'OpenAiCompatError';
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface OpenAiCompatCallerOptions {
  /** Injected for tests; default the global fetch. */
  fetch?: typeof fetch;
  /** The key; default `process.env[provider.apiKeyEnv]`. */
  apiKey?: string;
  /** Attempts per request on 429 / 5xx / network errors / an error body. Default 4. */
  maxAttempts?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-attempt timeout. Default 10 minutes. */
  timeoutMs?: number;
}

/** The provider's key from the environment, or undefined when unset or empty. */
export function providerKey(provider: OpenAiCompatProvider): string | undefined {
  const key = process.env[provider.apiKeyEnv];
  return key !== undefined && key !== '' ? key : undefined;
}

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A {@link ModelCaller} for an OpenAI-compatible endpoint. Retries 429, 5xx,
 * network failures and 200-with-error bodies with exponential backoff
 * (honouring `retry-after`); a 400 about context length becomes a
 * {@link ContextOverflowError} (a scored failure, as on the Anthropic path);
 * any other 4xx throws.
 */
export function openAiCompatCaller(
  provider: OpenAiCompatProvider,
  options: OpenAiCompatCallerOptions = {},
): ModelCaller {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? sleepFor;
  const attempts = Math.max(1, options.maxAttempts ?? 4);
  const timeoutMs = options.timeoutMs ?? 600_000;
  return async (params) => {
    const key = options.apiKey ?? providerKey(provider);
    if (key === undefined) {
      throw new Error(`${provider.apiKeyEnv} is not set; cannot call ${provider.name}`);
    }
    const request = toOpenAiRequest(params, provider.extraBody);
    let lastError = '';
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      try {
        response = await doFetch(`${provider.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
            'x-title': 'projection tool-choice eval',
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < attempts) await sleep(backoff(attempt));
        continue;
      }
      const raw = await response.text();
      let body: OpenAiResponse = {};
      try {
        body = JSON.parse(raw) as OpenAiResponse;
      } catch {
        // Leave the body empty: the status decides.
      }
      const message = body.error?.message ?? raw.slice(0, 500);
      if (response.ok && body.error === undefined && body.choices !== undefined) {
        return fromOpenAiResponse(body, params.model);
      }
      const status = response.ok ? Number(body.error?.code ?? 502) || 502 : response.status;
      if (status === 400 && isContextOverflowMessage(message)) {
        throw new ContextOverflowError(message);
      }
      lastError = `${provider.name} ${status}: ${message}`;
      const retryable = status === 408 || status === 429 || status >= 500 || response.ok;
      if (!retryable) throw new OpenAiCompatError(lastError, status);
      if (attempt < attempts) {
        const after = Number(response.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : backoff(attempt));
      }
    }
    throw new Error(`${provider.name}: gave up after ${attempts} attempts: ${lastError}`);
  };
}

function backoff(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** (attempt - 1));
}
