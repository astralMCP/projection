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

/**
 * Counts a request's static prefix in tokens: the tool definitions (with the
 * API's tool-use preamble) plus the system prompt. Rejects when it cannot.
 */
export type PrefixCounter = (
  model: string,
  system: string,
  tools: Anthropic.Tool[],
) => Promise<number>;

/** The one-message probe both counts share, so it cancels out. */
const PREFIX_PROBE: Anthropic.MessageParam[] = [{ role: 'user', content: '.' }];

/**
 * The live counter: the token-counting endpoint (free, no model call), as
 * `count(system + tools + probe) - count(probe)`. The probe-only count is
 * taken once per model; a failed one is forgotten so the next call retries.
 */
export function anthropicPrefixCounter(client: Anthropic = new Anthropic()): PrefixCounter {
  const baselines = new Map<string, Promise<number>>();
  const count = (params: Anthropic.MessageCountTokensParams): Promise<number> =>
    client.messages.countTokens(params).then((r) => r.input_tokens);
  return async (model, system, tools) => {
    let baseline = baselines.get(model);
    if (baseline === undefined) {
      baseline = count({ model, messages: PREFIX_PROBE });
      baselines.set(model, baseline);
      baseline.catch(() => baselines.delete(model));
    }
    const [full, probe] = await Promise.all([
      count({ model, system, tools, messages: PREFIX_PROBE }),
      baseline,
    ]);
    return Math.max(0, full - probe);
  };
}

/** Characters per token assumed for the task prompt by {@link estimatePrefixTokens}. */
export const PROMPT_CHARS_PER_TOKEN = 4;

/**
 * The static prefix when it was not counted: turn 1's whole prompt, as the
 * API billed it (uncached + cache read + cache write), less the task prompt
 * at {@link PROMPT_CHARS_PER_TOKEN} characters a token. Off by the error in
 * that one estimate (tens of tokens on a few-hundred-character prompt).
 */
export function estimatePrefixTokens(firstTurnPromptTokens: number, prompt: string): number {
  return Math.max(0, firstTurnPromptTokens - Math.ceil(prompt.length / PROMPT_CHARS_PER_TOKEN));
}

/**
 * Thrown by a {@link ModelCaller} when the request could not be served for a
 * reason that is neither the model's nor the harness's — the batch runner's
 * per-request `errored` / `expired` results, after its retries. The episode
 * ends with `infraFailure` set (and a `batch infra:` harness error), so it is
 * excluded from success rates and told apart from a model failure. The
 * interactive caller never throws it.
 */
export class InfraError extends Error {
  override name = 'InfraError';
}

/**
 * Thrown by a {@link ModelCaller} when the request did not fit the model's
 * context window — the batch runner's `invalid_request_error` result about
 * prompt length. The interactive caller throws the SDK's 400 instead;
 * {@link isContextOverflow} recognises both. Either way the episode ends as
 * a scored failure (`contextOverflow`), never an API or infra exclusion:
 * running out of context is the strategy's cost, not the harness's fault.
 */
export class ContextOverflowError extends Error {
  override name = 'ContextOverflowError';
}

/**
 * An API error message saying the prompt does not fit the context window
 * ("prompt is too long: 215000 tokens > 200000 maximum", or one naming the
 * context length or window).
 */
export function isContextOverflowMessage(text: string): boolean {
  return /prompt is too long|input is too long|context (?:length|window)|maximum context|exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context/i.test(
    text,
  );
}

/**
 * Whether a thrown model-call error is a context overflow: a
 * {@link ContextOverflowError}, or a 400 / `invalid_request_error` (the
 * SDK's `BadRequestError`) whose message is about the prompt's length.
 */
export function isContextOverflow(err: unknown): boolean {
  if (err instanceof ContextOverflowError) return true;
  if (!(err instanceof Error)) return false;
  const status = (err as { status?: unknown }).status;
  const type = (err as { error?: { error?: { type?: unknown } } }).error?.error?.type;
  const invalid =
    status === 400 || type === 'invalid_request_error' || /invalid_request_error/.test(err.message);
  return invalid && isContextOverflowMessage(err.message);
}

/** The stop reason the API gives when a response ran out of context window. */
export const CONTEXT_WINDOW_STOP = 'model_context_window_exceeded';

/** The tools as the Messages API takes them. */
export function agentTools(runtime: Pick<AgentRuntime, 'tools'>): Anthropic.Tool[] {
  return runtime.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

/**
 * One turn's request, as both the interactive caller (streamed) and the
 * batch runner (as a batch request's `params`) send it: the same object,
 * built in one place, so the two paths cannot drift. Key order is part of
 * the contract (it fixes the serialized bytes).
 */
export function buildTurnRequest(
  preset: ModelPreset,
  system: string,
  tools: Anthropic.Tool[],
  messages: Anthropic.MessageParam[],
  maxTokens: number = DEFAULT_MAX_TOKENS,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: preset.model,
    max_tokens: maxTokens,
    cache_control: { type: 'ephemeral' },
    system,
    tools,
    messages,
    ...preset.params,
  };
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

/** One Messages API call's usage as the response reported it, and the static prefix it carried. */
export interface TurnUsage {
  /** Uncached input tokens. */
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  /**
   * Tokens in the request's static prefix: the tool definitions (with the
   * API's tool-use preamble) plus the system prompt. How it was obtained is
   * the episode's `prefixSource`.
   */
  prefixTokens: number;
}

/**
 * `count_tokens`: the token-counting endpoint, once per distinct prefix per
 * run ({@link anthropicPrefixCounter}). `estimate`: not counted (no counter,
 * or the count failed), so {@link estimatePrefixTokens} from turn 1.
 */
export type PrefixSource = 'count_tokens' | 'estimate';

/**
 * One content block of the recorded transcript, as the model produced or
 * saw it: text, a tool call, its thinking (text only — the signature is
 * dropped), or a tool result's text exactly as it was returned to the model.
 * Any other block keeps only its type.
 */
export type TranscriptBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'thinking'; thinking: string }
  | { type: 'redacted_thinking' }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: true }
  | { type: string };

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  /** A string for the task prompt; blocks for everything after it. */
  content: string | TranscriptBlock[];
  /** Assistant messages: the usage of the call that produced it. */
  usage?: TurnUsage;
}

/** What the model saw and said in one episode, in order. */
export interface Transcript {
  /** The system prompt every turn was sent with. */
  system: string;
  /**
   * The task prompt, every assistant turn (the last one included, whatever
   * its stop reason) and every tool-result message.
   */
  messages: TranscriptMessage[];
}

/** An assistant block as the transcript records it. */
function transcriptBlock(block: Anthropic.ContentBlock): TranscriptBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'thinking':
      return { type: 'thinking', thinking: block.thinking };
    case 'redacted_thinking':
      return { type: 'redacted_thinking' };
    default:
      return { type: block.type };
  }
}

export interface AgentEpisode {
  /** Messages API calls made. */
  apiTurns: number;
  /** Of those, the turns that consumed the budget (not purely discovery). */
  budgetTurns: number;
  /** Every `tool_use` block the model emitted, in order. */
  toolUses: ToolUseRecord[];
  /** Totals over every turn. */
  usage: EpisodeUsage;
  /** Per Messages API call, in order (one per `apiTurns`). */
  turns: TurnUsage[];
  /** How `turns[].prefixTokens` was obtained; absent when no call completed. */
  prefixSource?: PrefixSource;
  wallMs: number;
  /** The last stop_reason seen, if any call completed. */
  stopReason?: string;
  /** Text blocks of the final assistant message, joined. */
  finalText: string;
  /** The model the API reported serving (the last response's `model`), if any call completed. */
  servedModel?: string;
  /** The full conversation, for reading what the model saw. */
  transcript: Transcript;
  /**
   * True when the loop stopped because the turn budget (`maxTurns` counting
   * turns, or `maxTotalTurns` in all) was spent while the model was still
   * calling tools. Not a harness error:
   * every upstream call up to the cap was recorded, so the episode is scored
   * on them like any other — a model that loops gets its loops counted, not
   * dropped.
   */
  turnCapped: boolean;
  /**
   * Set when the episode did not end on the model's own `end_turn` for a
   * reason that is not the model's tool choice: a refusal, a `max_tokens`
   * cut, or a thrown API error. Such episodes are reported separately and
   * excluded from success rates. A context-window overflow is not one of
   * them (see `contextOverflow`).
   */
  harnessError?: string;
  /**
   * Set (with `harnessError`) when the caller gave up with an
   * {@link InfraError}: the infrastructure failed, not the model.
   */
  infraFailure?: true;
  /**
   * Set when the episode ran out of context window: a request rejected as
   * too long (400 `invalid_request_error`, or {@link ContextOverflowError}
   * from the batch runner) or a response that stopped with
   * `model_context_window_exceeded`. Not a harness error: the episode is
   * scored, and scored as a failure.
   */
  contextOverflow?: true;
}

export interface AgentEpisodeOptions {
  /**
   * The turn budget: Messages API calls that count. Default 12. A turn
   * counts unless it stopped for `tool_use`, called at least one tool, and
   * every tool it called is in `budgetFreeTools`.
   */
  maxTurns?: number;
  /**
   * Tools whose turns do not consume the budget — Projection's discovery
   * surface (`search_tools`, `describe_tool`, `discover_apis`), which direct
   * mode gets for free in its inline schemas. Free is by tool NAME, not by
   * outcome: a turn that mixes a free tool with any other tool counts, and a
   * failed `call_tool` (unknown name, bad arguments) counts exactly like a
   * direct-mode call with bad arguments; a failed `describe_tool`, or
   * endless `search_tools` paging, does not count and is bounded only by
   * `maxTotalTurns`. Default: none.
   */
  budgetFreeTools?: ReadonlySet<string>;
  /**
   * Absolute ceiling on Messages API calls, free turns included, so a model
   * that loops on discovery still stops. Default: twice `maxTurns`. Never
   * below `maxTurns`.
   */
  maxTotalTurns?: number;
  maxTokens?: number;
  /**
   * The static prefix (tools + system) in tokens, counted by the caller
   * ({@link PrefixCounter}). Absent: estimated from turn 1
   * ({@link estimatePrefixTokens}).
   */
  prefixTokens?: number;
}

export const DEFAULT_MAX_TURNS = 12;
/** The default ceiling is twice the default budget; see `maxTotalTurns`. */
export const DEFAULT_MAX_TOTAL_TURNS = 2 * DEFAULT_MAX_TURNS;
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
  // A ceiling below the budget would make the budget unreachable.
  const maxTotalTurns = Math.max(maxTurns, options.maxTotalTurns ?? 2 * maxTurns);
  const free = options.budgetFreeTools ?? new Set<string>();
  const tools = agentTools(runtime);
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];
  const started = performance.now();
  const toolUses: ToolUseRecord[] = [];
  const usage: EpisodeUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  const turns: TurnUsage[] = [];
  let prefixTokens = options.prefixTokens;
  const prefixSource: PrefixSource = prefixTokens === undefined ? 'estimate' : 'count_tokens';
  let apiTurns = 0;
  let budgetTurns = 0;
  let stopReason: string | undefined;
  let finalText = '';
  let servedModel: string | undefined;
  const transcript: Transcript = {
    system: runtime.system,
    messages: [{ role: 'user', content: prompt }],
  };

  let contextOverflow = false;
  const finish = (harnessError?: string, turnCapped = false, infra = false): AgentEpisode => ({
    apiTurns,
    budgetTurns,
    toolUses,
    usage,
    turns,
    ...(turns.length > 0 ? { prefixSource } : {}),
    wallMs: Math.round(performance.now() - started),
    ...(stopReason !== undefined ? { stopReason } : {}),
    finalText,
    ...(servedModel !== undefined ? { servedModel } : {}),
    transcript,
    turnCapped,
    ...(harnessError !== undefined ? { harnessError } : {}),
    ...(infra ? { infraFailure: true as const } : {}),
    ...(contextOverflow ? { contextOverflow: true as const } : {}),
  });

  while (budgetTurns < maxTurns && apiTurns < maxTotalTurns) {
    let message: Anthropic.Message;
    try {
      message = await caller(
        buildTurnRequest(preset, runtime.system, tools, messages, options.maxTokens),
      );
    } catch (err) {
      if (err instanceof InfraError) return finish(`batch infra: ${err.message}`, false, true);
      if (isContextOverflow(err)) {
        // The conversation outgrew the window: a scored failure.
        contextOverflow = true;
        stopReason = CONTEXT_WINDOW_STOP;
        return finish();
      }
      return finish(`api error: ${errorMessage(err)}`);
    }
    apiTurns += 1;
    servedModel = message.model;
    const turnInput = message.usage.input_tokens;
    const turnRead = message.usage.cache_read_input_tokens ?? 0;
    const turnWrite = message.usage.cache_creation_input_tokens ?? 0;
    prefixTokens ??= estimatePrefixTokens(turnInput + turnRead + turnWrite, prompt);
    const turn: TurnUsage = {
      inputTokens: turnInput,
      cacheCreationInputTokens: turnWrite,
      cacheReadInputTokens: turnRead,
      outputTokens: message.usage.output_tokens,
      prefixTokens,
    };
    turns.push(turn);
    transcript.messages.push({
      role: 'assistant',
      content: message.content.map(transcriptBlock),
      usage: turn,
    });
    usage.inputTokens += turnInput;
    usage.outputTokens += message.usage.output_tokens;
    usage.cacheReadInputTokens += turnRead;
    usage.cacheCreationInputTokens += turnWrite;
    stopReason = message.stop_reason ?? undefined;
    finalText = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    // The one place the budget is charged. A turn is free only when it is
    // pure discovery: it stopped to call tools, called at least one (an
    // empty tool_use turn is not discovery), and every one is a free tool.
    // Every other stop reason — end_turn, pause_turn, refusal, max_tokens,
    // null — counts, so without free tools budgetTurns === apiTurns.
    const called = message.content.flatMap((block) =>
      block.type === 'tool_use' ? [block.name] : [],
    );
    const isDiscovery =
      message.stop_reason === 'tool_use' &&
      called.length > 0 &&
      called.every((name) => free.has(name));
    if (!isDiscovery) budgetTurns += 1;

    if (message.stop_reason === 'tool_use') {
      // Echo the whole assistant turn (thinking blocks included), then
      // answer every tool_use block in ONE user message.
      messages.push({ role: 'assistant', content: message.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      const seen: TranscriptBlock[] = [];
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
        seen.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.text,
          ...(result.isError === true ? { is_error: true as const } : {}),
        });
      }
      messages.push({ role: 'user', content: results });
      transcript.messages.push({ role: 'user', content: seen });
      continue;
    }

    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }

    if (message.stop_reason === 'end_turn' || message.stop_reason === 'stop_sequence') {
      return finish();
    }

    if (message.stop_reason === CONTEXT_WINDOW_STOP) {
      contextOverflow = true;
      return finish();
    }

    // refusal, max_tokens, or null.
    return finish(`stop_reason ${String(message.stop_reason)}`);
  }

  return finish(undefined, true);
}
