/**
 * A manual Anthropic tool-use loop for the tool-choice eval.
 *
 * Deliberately plain: the eval measures which tool a model picks and with
 * what arguments, so the loop must not steer — no forced `tool_choice`, no
 * schema coaching, every `tool_use` block executed and every result returned
 * in one user message. Streaming (`messages.stream(...).finalMessage()`)
 * avoids request timeouts on thinking turns; a top-level `cache_control`
 * caches the tool list and system prompt (direct mode carries ~95 schemas
 * per call).
 *
 * Not exercised against the API in CI: the live test skips without
 * PROJ_LIVE_EVAL=1 and ANTHROPIC_API_KEY, and the offline tests inject a
 * scripted {@link ModelCaller}.
 */

import Anthropic from '@anthropic-ai/sdk';

/** A model configuration the eval runs under. */
export interface ModelPreset {
  /** Preset name, as given to PROJ_EVAL_MODELS. */
  name: string;
  model: string;
  /** Request fields merged into every call (thinking / effort). */
  params: Pick<Anthropic.MessageCreateParams, 'thinking' | 'output_config'>;
}

/**
 * Built-in presets. The defaults are deliberately the weaker/cheaper pair —
 * Haiku 4.5 with no extended thinking and Sonnet 5.5 at low effort — because
 * Haiku 5.5 (low) and Sonnet 5.5 (medium) scored 100% in every cell of the
 * basic and hard tiers against the GitHub fake. Haiku 4.5 takes neither
 * adaptive thinking nor `effort` (both are 4.6+ features), so it gets no
 * params at all; Haiku 5.5 runs adaptive thinking by default and takes only
 * `effort` (never `budget_tokens`).
 */
export const MODEL_PRESETS: Record<string, ModelPreset> = {
  haiku45: {
    name: 'haiku45',
    model: 'claude-haiku-4-5',
    params: {},
  },
  'sonnet-low': {
    name: 'sonnet-low',
    model: 'claude-sonnet-5-5',
    params: { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } },
  },
  'haiku-low': {
    name: 'haiku-low',
    model: 'claude-haiku-5-5',
    params: { output_config: { effort: 'low' } },
  },
  'sonnet-medium': {
    name: 'sonnet-medium',
    model: 'claude-sonnet-5-5',
    params: { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } },
  },
};

export const DEFAULT_MODEL_PRESETS = ['haiku45', 'sonnet-low'];

/**
 * Resolve a comma list of preset names (PROJ_EVAL_MODELS) to presets.
 * Unknown names throw rather than silently shrinking the matrix.
 */
export function resolveModelPresets(spec: string | undefined): ModelPreset[] {
  const names =
    spec === undefined || spec.trim() === ''
      ? DEFAULT_MODEL_PRESETS
      : spec
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '');
  return names.map((name) => {
    const preset = MODEL_PRESETS[name];
    if (preset === undefined) {
      throw new Error(
        `unknown model preset "${name}"; known: ${Object.keys(MODEL_PRESETS).join(', ')}`,
      );
    }
    return preset;
  });
}

/** One tool as offered to the model. */
export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema with `type: 'object'`. */
  inputSchema: Record<string, unknown>;
}

export interface AgentToolResult {
  /** What the model sees as the tool result. */
  text: string;
  isError?: boolean;
}

/** The tool surface and executor an episode runs against (one per mode). */
export interface AgentRuntime {
  system: string;
  tools: AgentTool[];
  call(name: string, input: Record<string, unknown>): Promise<AgentToolResult>;
}

/**
 * One model call. The default talks to the Anthropic API; tests inject a
 * script. Takes the stream params so the loop's request shape is identical
 * either way.
 */
export type ModelCaller = (params: Anthropic.MessageStreamParams) => Promise<Anthropic.Message>;

/** The live caller: streaming, final message only. */
export function anthropicCaller(client: Anthropic = new Anthropic()): ModelCaller {
  return (params) => client.messages.stream(params).finalMessage();
}

export interface ToolUseRecord {
  name: string;
  input: Record<string, unknown>;
  isError: boolean;
}

export interface EpisodeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface AgentEpisode {
  /** Messages API calls made. */
  apiTurns: number;
  /** Every `tool_use` block the model emitted, in order. */
  toolUses: ToolUseRecord[];
  usage: EpisodeUsage;
  wallMs: number;
  /** The last stop_reason seen, if any call completed. */
  stopReason?: string;
  /** Text blocks of the final assistant message, joined. */
  finalText: string;
  /**
   * True when the loop stopped because `maxTurns` Messages API calls had
   * been made while the model was still calling tools. Not a harness error:
   * every upstream call up to the cap was recorded, so the episode is scored
   * on them like any other — a model that loops gets its loops counted, not
   * dropped.
   */
  turnCapped: boolean;
  /**
   * Set when the episode did not end on the model's own `end_turn` for a
   * reason that is not the model's tool choice: a refusal, a `max_tokens`
   * cut, a context-window overflow, or a thrown API error. Such episodes are
   * reported separately and excluded from success rates.
   */
  harnessError?: string;
}

export interface AgentEpisodeOptions {
  /** Cap on Messages API calls. Default 12. */
  maxTurns?: number;
  maxTokens?: number;
}

export const DEFAULT_MAX_TURNS = 12;
export const DEFAULT_MAX_TOKENS = 16000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Run one task prompt to completion under a preset and runtime. */
export async function runAgentEpisode(
  caller: ModelCaller,
  preset: ModelPreset,
  runtime: AgentRuntime,
  prompt: string,
  options: AgentEpisodeOptions = {},
): Promise<AgentEpisode> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const tools: Anthropic.Tool[] = runtime.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];
  const started = performance.now();
  const toolUses: ToolUseRecord[] = [];
  const usage: EpisodeUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  let apiTurns = 0;
  let stopReason: string | undefined;
  let finalText = '';

  const finish = (harnessError?: string, turnCapped = false): AgentEpisode => ({
    apiTurns,
    toolUses,
    usage,
    wallMs: Math.round(performance.now() - started),
    ...(stopReason !== undefined ? { stopReason } : {}),
    finalText,
    turnCapped,
    ...(harnessError !== undefined ? { harnessError } : {}),
  });

  for (let turn = 0; turn < maxTurns; turn += 1) {
    let message: Anthropic.Message;
    try {
      message = await caller({
        model: preset.model,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        cache_control: { type: 'ephemeral' },
        system: runtime.system,
        tools,
        messages,
        ...preset.params,
      });
    } catch (err) {
      return finish(`api error: ${errorMessage(err)}`);
    }
    apiTurns += 1;
    usage.inputTokens += message.usage.input_tokens;
    usage.outputTokens += message.usage.output_tokens;
    usage.cacheReadInputTokens += message.usage.cache_read_input_tokens ?? 0;
    usage.cacheCreationInputTokens += message.usage.cache_creation_input_tokens ?? 0;
    stopReason = message.stop_reason ?? undefined;
    finalText = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');

    if (message.stop_reason === 'tool_use') {
      // Echo the whole assistant turn (thinking blocks included), then
      // answer every tool_use block in ONE user message.
      messages.push({ role: 'assistant', content: message.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of message.content) {
        if (block.type !== 'tool_use') continue;
        const input = isRecord(block.input) ? block.input : {};
        let result: AgentToolResult;
        try {
          result = await runtime.call(block.name, input);
        } catch (err) {
          result = { text: `Tool error: ${errorMessage(err)}`, isError: true };
        }
        toolUses.push({ name: block.name, input, isError: result.isError === true });
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.text,
          ...(result.isError === true ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }

    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }

    if (message.stop_reason === 'end_turn' || message.stop_reason === 'stop_sequence') {
      return finish();
    }

    // refusal, max_tokens, model_context_window_exceeded, or null.
    return finish(`stop_reason ${String(message.stop_reason)}`);
  }

  return finish(undefined, true);
}
