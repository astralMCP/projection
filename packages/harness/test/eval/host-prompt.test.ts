/**
 * PROJ_EVAL_HOST_PROMPT=realistic, offline: the generic host prompt is
 * host-sized, static, neutral between modes, and put before every mode's
 * own system prompt in the one cached system block.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  buildTurnRequest,
  hostPromptPrefix,
  openSession,
  openWorld,
  resolveHostPrompt,
  resolveTasks,
  runToolChoiceEval,
  REALISTIC_HOST_PROMPT,
  type EvalMode,
  type ModelCaller,
  type ModelPreset,
} from '../../src/index.js';

describe('the realistic host prompt', () => {
  it('resolves from the env value', () => {
    expect(resolveHostPrompt(undefined)).toBeUndefined();
    expect(resolveHostPrompt('')).toBeUndefined();
    expect(resolveHostPrompt('none')).toBeUndefined();
    expect(resolveHostPrompt('realistic')).toBe('realistic');
    expect(() => resolveHostPrompt('huge')).toThrow(/realistic/);
    expect(hostPromptPrefix('realistic')).toBe(REALISTIC_HOST_PROMPT);
  });

  it('is host-sized: ~12k tokens on Sonnet 5.5 (~9k on Haiku 4.5), ~40k characters', () => {
    // Counted with the token-counting endpoint when written: 12,109 tokens
    // on claude-sonnet-5-5 and 9,063 on claude-haiku-4-5 at 40,132
    // characters. Guarded by characters, as unit tests make no API calls.
    expect(REALISTIC_HOST_PROMPT.length).toBeGreaterThan(38_000);
    expect(REALISTIC_HOST_PROMPT.length).toBeLessThan(44_000);
  });

  it('is neutral: it names no eval tool, server or facade feature', () => {
    for (const word of [
      'search_tools',
      'describe_tool',
      'call_tool',
      'execute_machine',
      'discover_apis',
      'Projection',
      'XState',
      'tool search',
      'code execution',
      'GitHub',
      'MongoDB',
      'Slack',
    ]) {
      expect(REALISTIC_HOST_PROMPT).not.toContain(word);
    }
  });

  it('is static: the same bytes on every run, no clock', () => {
    expect(REALISTIC_HOST_PROMPT).not.toMatch(/20\d\d-\d\d-\d\d/);
    expect(hostPromptPrefix('realistic')).toBe(hostPromptPrefix('realistic'));
  });
});

describe('every mode gets the same host prompt first', () => {
  it('prepends it to direct, native and Projection system prompts alike', async () => {
    const systems: Partial<Record<EvalMode, string>> = {};
    for (const mode of ['direct', 'native-search', 'projection'] as EvalMode[]) {
      const plainWorld = await openWorld('github');
      const hostedWorld = await openWorld('github');
      const plain = await openSession(mode, plainWorld);
      const hosted = await openSession(mode, hostedWorld, { hostPrompt: REALISTIC_HOST_PROMPT });
      try {
        expect(hosted.runtime.system).toBe(`${REALISTIC_HOST_PROMPT}\n\n${plain.runtime.system}`);
        systems[mode] = hosted.runtime.system;
      } finally {
        await plain.close();
        await hosted.close();
        await plainWorld.close();
        await hostedWorld.close();
      }
    }
    expect(systems['native-search']).toBe(systems['direct']);
  });

  it('sits in the one cached system block, ahead of the mode prompt', () => {
    const preset: ModelPreset = { name: 's', model: 'claude-sonnet-5-5', params: {} };
    const request = buildTurnRequest(
      preset,
      `${REALISTIC_HOST_PROMPT}\n\nframing`,
      [],
      [{ role: 'user', content: 'hi' }],
    );
    expect(request.system).toEqual([
      {
        type: 'text',
        text: `${REALISTIC_HOST_PROMPT}\n\nframing`,
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(request.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('reaches the model in a run, for every mode', async () => {
    const seen: { system: string }[] = [];
    const caller: ModelCaller = async (params) => {
      const blocks = params.system as Anthropic.TextBlockParam[];
      seen.push({ system: blocks.map((b) => b.text).join('') });
      return {
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'scripted',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      } as unknown as Anthropic.Message;
    };
    await runToolChoiceEval({
      models: [{ name: 's', model: 'scripted', params: {} }],
      modes: ['direct', 'projection'],
      tasks: resolveTasks(undefined, ['basic']).slice(0, 1),
      runs: 1,
      caller,
      hostPrompt: 'realistic',
    });
    expect(seen).toHaveLength(2);
    for (const { system } of seen) {
      expect(system.startsWith(`${REALISTIC_HOST_PROMPT}\n\n`)).toBe(true);
    }
  });
});
