/**
 * `call_tool` against a scripted executor (PRD R35, R36, R38; S2–S6).
 */

import { describe, expect, it } from 'vitest';
import { buildBlobPayload, sealBlob } from '../../src/blob/index.js';
import {
  callTool,
  canonicalRequest,
  CALL_KEY,
  type CallToolDeps,
  type CallToolOutcome,
} from '../../src/catalog/index.js';
import { executeMachine } from '../../src/mrtr/index.js';
import type { ReplayCache, ServerCatalog } from '../../src/types.js';
import { baseOptions, CATALOG, entry, FakeExecutor } from '../machine-host/fixtures.js';
import {
  ACCEPT,
  completed,
  decline,
  elicitation,
  isSuspended,
  requestKeys,
  sealedState,
  structured,
} from '../mrtr/helpers.js';

const KEY = new Uint8Array(32).fill(21);
const ESC = String.fromCharCode(0x1b);

/** A catalog whose write_file carries a real schema, for validation cases. */
const TYPED: ServerCatalog = {
  ...CATALOG,
  tools: [
    ...CATALOG.tools.filter((t) => t.name !== 'write_file'),
    entry({
      name: 'write_file',
      description: 'Write a file.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          mode: { type: 'string', enum: ['append', 'overwrite'] },
          retries: { type: ['integer', 'null'] },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    }),
  ],
};

function deps(overrides: Partial<CallToolDeps> = {}): CallToolDeps & { executor: FakeExecutor } {
  const executor =
    overrides.executor instanceof FakeExecutor ? overrides.executor : new FakeExecutor();
  return {
    catalog: CATALOG,
    blob: { key: KEY },
    protocolEra: 'modern',
    ...overrides,
    executor,
  };
}

function outcome(result: Awaited<ReturnType<typeof callTool>>): CallToolOutcome {
  return structured(result) as unknown as CallToolOutcome;
}

const WRITE = { path: '/notes.txt', content: 'hello' };

describe('call_tool: validation (R35.1)', () => {
  it('rejects an unknown tool with a validate error pointing at search_tools', async () => {
    const d = deps();
    const result = completed(await callTool({ name: `nope${ESC}` }, d));
    expect(result.isError).toBe(true);
    const err = structured(result);
    expect(err['phase']).toBe('validate');
    expect(String(err['hint'])).toContain('search_tools');
    expect(String(err['message'])).not.toContain(ESC);
    expect(d.executor.calls).toEqual([]);
  });

  it('rejects non-object args and non-JSON values', async () => {
    for (const args of [[1, 2], 'str', 42, null]) {
      const result = completed(await callTool({ name: 'read_file', args }, deps()));
      expect(result.isError).toBe(true);
      expect(structured(result)['phase']).toBe('validate');
    }
    const result = completed(
      await callTool({ name: 'read_file', args: { path: undefined } }, deps()),
    );
    expect(structured(result)['phase']).toBe('validate');
  });

  it('enforces the maxInputBytes cap on args (clamped at the 1 KB floor)', async () => {
    const result = completed(
      await callTool(
        { name: 'read_file', args: { blob: 'x'.repeat(2_000) } },
        deps({ caps: { maxInputBytes: 1024 } }),
      ),
    );
    expect(result.isError).toBe(true);
    expect(structured(result)['phase']).toBe('cap_exceeded');
  });

  it('checks required properties, top-level types, enum membership and unknown keys, naming the property', async () => {
    const d = deps({ catalog: TYPED });
    const cases: { args: Record<string, unknown>; property: string }[] = [
      { args: { path: '/x' }, property: 'content' },
      { args: { path: 1, content: 'c' }, property: 'path' },
      { args: { ...WRITE, mode: 'truncate' }, property: 'mode' },
      { args: { ...WRITE, retries: 1.5 }, property: 'retries' },
      { args: { ...WRITE, bogus: true }, property: 'bogus' },
    ];
    for (const { args, property } of cases) {
      const result = completed(await callTool({ name: 'write_file', args }, d));
      expect(result.isError, JSON.stringify(args)).toBe(true);
      const err = structured(result);
      expect(err['phase']).toBe('validate');
      expect(String(err['message'])).toContain(`"${property}"`);
      expect(String(err['hint'])).toContain('describe_tool');
    }
    // Nothing reached the executor or asked for approval.
    expect(d.executor.calls).toEqual([]);
    // Valid shapes pass: null is allowed by the type union, __proto__ is data.
    const ok = await callTool({ name: 'write_file', args: { ...WRITE, retries: null } }, d);
    expect(isSuspended(ok)).toBe(true);
  });
});

describe('call_tool: auto and deny (R35.2, R35.5)', () => {
  it('executes a read-only tool immediately and returns { status: "ok", tool, output }', async () => {
    const d = deps({
      executor: new FakeExecutor({ read_file: { ok: true, result: { content: 'hi' } } }),
    });
    const result = completed(await callTool({ name: 'read_file', args: { path: '/n' } }, d));
    expect(result.isError).toBeUndefined();
    expect(outcome(result)).toEqual({ status: 'ok', tool: 'read_file', output: { content: 'hi' } });
    expect(d.executor.calls).toEqual([{ name: 'read_file', args: { path: '/n' } }]);
  });

  it('absent args mean {}', async () => {
    const d = deps();
    await callTool({ name: 'list_dir' }, d);
    expect(d.executor.calls).toEqual([{ name: 'list_dir', args: {} }]);
  });

  it('a deny policy is a normal (non-error) denied_by_policy result and nothing executes', async () => {
    const d = deps({ policy: { read_file: 'deny' } });
    const result = completed(await callTool({ name: 'read_file', args: { path: '/n' } }, d));
    expect(result.isError).toBeUndefined();
    expect(outcome(result)).toMatchObject({ status: 'denied_by_policy', tool: 'read_file' });
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect((result.content[0] as { text: string }).text).toContain('blocked');
    expect(d.executor.calls).toEqual([]);
  });

  it('an upstream failure is an isError result with phase upstream, message inert', async () => {
    const d = deps({
      executor: new FakeExecutor({
        read_file: { ok: false, error: { message: `disk on fire${ESC}[31m`, detail: { code: 5 } } },
      }),
    });
    const result = completed(await callTool({ name: 'read_file', args: { path: '/n' } }, d));
    expect(result.isError).toBe(true);
    const err = structured(result);
    expect(err['phase']).toBe('upstream');
    expect(String(err['message'])).toContain('disk on fire');
    expect(String(err['message'])).not.toContain(ESC);
    expect(String(err['hint'])).toContain('describe_tool');
  });
});

describe('call_tool: suspend and resume (R35.3–4, R36, S2)', () => {
  it('suspends a gated call with one direct-call elicitation keyed "call" and executes nothing', async () => {
    const d = deps();
    const result = await callTool({ name: 'write_file', args: WRITE }, d);
    expect(isSuspended(result)).toBe(true);
    expect(requestKeys(result)).toEqual([CALL_KEY]);
    const prompt = elicitation(result, CALL_KEY);
    expect(prompt.message.startsWith('Approve: write file')).toBe(true);
    expect(prompt.message).toContain('requested directly by the model');
    expect(prompt.message).not.toContain('requested by step');
    expect(prompt.message).toContain('"path": "/notes.txt"');
    expect(d.executor.calls).toEqual([]);
  });

  it('an accepted retry executes the RECORDED args and reports ok', async () => {
    const d = deps({
      executor: new FakeExecutor({ write_file: { ok: true, result: 'wrote 5 bytes' } }),
    });
    const suspended = await callTool({ name: 'write_file', args: WRITE }, d);
    const result = completed(
      await callTool(
        {
          name: 'write_file',
          args: WRITE,
          requestState: sealedState(suspended),
          inputResponses: { [CALL_KEY]: ACCEPT },
        },
        d,
      ),
    );
    expect(result.isError).toBeUndefined();
    expect(outcome(result)).toEqual({ status: 'ok', tool: 'write_file', output: 'wrote 5 bytes' });
    expect(d.executor.calls).toEqual([{ name: 'write_file', args: WRITE }]);
  });

  it('the retry may spell the same request differently (key order, 1.0 vs 1): same binding', async () => {
    const d = deps();
    const suspended = await callTool(
      { name: 'write_file', args: { path: '/n', content: 'c', n: 1 } },
      d,
    );
    const result = completed(
      await callTool(
        {
          name: 'write_file',
          args: JSON.parse('{"n": 1.0, "content": "c", "path": "/n"}') as Record<string, unknown>,
          requestState: sealedState(suspended),
          inputResponses: { [CALL_KEY]: ACCEPT },
        },
        d,
      ),
    );
    expect(result.isError).toBeUndefined();
    expect(d.executor.calls).toHaveLength(1);
  });

  it('a retry with different args is a blob_verification error and nothing executes (R36)', async () => {
    const d = deps();
    const suspended = await callTool({ name: 'write_file', args: WRITE }, d);
    const result = completed(
      await callTool(
        {
          name: 'write_file',
          args: { path: '/etc/passwd', content: 'pwned' },
          requestState: sealedState(suspended),
          inputResponses: { [CALL_KEY]: ACCEPT },
        },
        d,
      ),
    );
    expect(result.isError).toBe(true);
    const err = structured(result);
    expect(err['phase']).toBe('blob_verification');
    expect(String(err['message'])).toContain('request mismatch');
    expect(d.executor.calls).toEqual([]);
  });

  it('a decline (with reason), a missing response and a non-elicitation response all mean declined (R17)', async () => {
    const d = deps();
    const state = sealedState(await callTool({ name: 'write_file', args: WRITE }, d));
    const retry = (inputResponses: Record<string, unknown> | undefined) =>
      callTool(
        {
          name: 'write_file',
          args: WRITE,
          requestState: state,
          ...(inputResponses !== undefined ? { inputResponses } : {}),
        },
        d,
      );

    const declined = completed(await retry({ [CALL_KEY]: decline(`busy${ESC}`) }));
    expect(declined.isError).toBeUndefined();
    expect(outcome(declined)).toEqual({ status: 'declined', tool: 'write_file', reason: 'busy�' });
    expect((declined.content[0] as { text: string }).text).toContain('Do not retry');

    expect(outcome(completed(await retry(undefined)))).toEqual({
      status: 'declined',
      tool: 'write_file',
    });
    expect(outcome(completed(await retry({ other: ACCEPT })))).toEqual({
      status: 'declined',
      tool: 'write_file',
    });
    expect(d.executor.calls).toEqual([]);
  });

  it('a machine blob cannot be opened by call_tool, nor a call blob by execute_machine (R36 kind)', async () => {
    const d = deps();
    const machineBlob = sealBlob(
      buildBlobPayload({
        code: canonicalRequest('write_file', WRITE),
        serverIdentity: CATALOG.identity,
        snapshot: { status: 'active' },
        pending: {
          [CALL_KEY]: { id: CALL_KEY, name: 'write_file', args: WRITE, stateName: 'call_tool' },
        },
        trip: 1,
      }),
      d.blob,
    );
    const viaCall = completed(
      await callTool(
        {
          name: 'write_file',
          args: WRITE,
          requestState: machineBlob,
          inputResponses: { [CALL_KEY]: ACCEPT },
        },
        d,
      ),
    );
    expect(viaCall.isError).toBe(true);
    expect(structured(viaCall)['phase']).toBe('blob_verification');
    expect(String(structured(viaCall)['message'])).toContain('kind');

    const callBlob = sealedState(await callTool({ name: 'write_file', args: WRITE }, d));
    const viaMachine = completed(
      await executeMachine(
        {
          code: canonicalRequest('write_file', WRITE),
          requestState: callBlob,
          inputResponses: { [CALL_KEY]: ACCEPT },
        },
        { ...baseOptions, executor: d.executor, blob: d.blob, protocolEra: 'modern' },
      ),
    );
    expect(viaMachine.isError).toBe(true);
    expect(structured(viaMachine)['phase']).toBe('blob_verification');
    expect(String(structured(viaMachine)['message'])).toContain('kind');
    expect(d.executor.calls).toEqual([]);
  });

  it('call blobs carry a shorter default TTL (R38)', async () => {
    const d = deps();
    const soon = sealedState(await callTool({ name: 'write_file', args: WRITE }, d));
    // 6 minutes later the 5-minute call blob is expired.
    const later = Date.now() + 6 * 60 * 1000;
    const { openBlob } = await import('../../src/blob/index.js');
    expect(() =>
      openBlob(soon, {
        expectedKind: 'call',
        code: canonicalRequest('write_file', WRITE),
        serverIdentity: CATALOG.identity,
        config: d.blob,
        now: later,
      }),
    ).toThrow(/expired/);
    const longer = deps({ blob: { key: KEY, callTtlMs: 10 * 60 * 1000 } });
    const kept = sealedState(await callTool({ name: 'write_file', args: WRITE }, longer));
    expect(() =>
      openBlob(kept, {
        expectedKind: 'call',
        code: canonicalRequest('write_file', WRITE),
        serverIdentity: CATALOG.identity,
        config: longer.blob,
        now: later,
      }),
    ).not.toThrow();
  });
});

describe('call_tool: replay (D4, R38)', () => {
  it('without a cache an approved retry re-executes within TTL (D4 known limitation)', async () => {
    const d = deps();
    const state = sealedState(await callTool({ name: 'write_file', args: WRITE }, d));
    const retry = {
      name: 'write_file',
      args: WRITE,
      requestState: state,
      inputResponses: { [CALL_KEY]: ACCEPT },
    };
    await callTool(retry, d);
    await callTool(retry, d);
    expect(d.executor.calls).toHaveLength(2);
  });

  it('with a replay cache the second use is a blob_verification error and executes exactly once', async () => {
    const seen = new Map<string, number>();
    const replayCache: ReplayCache = {
      seen(nonce, exp) {
        const was = seen.has(nonce);
        seen.set(nonce, exp);
        return Promise.resolve(was);
      },
    };
    const d = deps({ replayCache });
    const state = sealedState(await callTool({ name: 'write_file', args: WRITE }, d));
    const retry = {
      name: 'write_file',
      args: WRITE,
      requestState: state,
      inputResponses: { [CALL_KEY]: ACCEPT },
    };
    expect(completed(await callTool(retry, d)).isError).toBeUndefined();
    const second = completed(await callTool(retry, d));
    expect(second.isError).toBe(true);
    expect(structured(second)['phase']).toBe('blob_verification');
    expect(String(structured(second)['message'])).toContain('replayed');
    expect(d.executor.calls).toHaveLength(1);
  });
});

describe('call_tool: legacy connections (R28)', () => {
  it('an auto-policy call works on a legacy connection', async () => {
    const d = deps();
    delete (d as Partial<CallToolDeps>).protocolEra;
    const result = completed(await callTool({ name: 'read_file', args: { path: '/n' } }, d));
    expect(result.isError).toBeUndefined();
  });

  it('a gated call fails fast without the opt-in, and with the opt-in but no elicitation capability', async () => {
    const noOptIn = deps({ protocolEra: 'legacy' });
    const a = completed(await callTool({ name: 'write_file', args: WRITE }, noOptIn));
    expect(a.isError).toBe(true);
    expect(structured(a)['phase']).toBe('protocol');
    expect(String(structured(a)['message'])).toContain('2026-07-28');

    const noCapability = deps({
      protocolEra: 'legacy',
      legacyElicitation: true,
      clientCanElicit: false,
    });
    const b = completed(await callTool({ name: 'write_file', args: WRITE }, noCapability));
    expect(b.isError).toBe(true);
    expect(structured(b)['phase']).toBe('protocol');
    expect(String(structured(b)['message'])).toContain('elicitation capability');

    const shim = deps({ protocolEra: 'legacy', legacyElicitation: true });
    expect(isSuspended(await callTool({ name: 'write_file', args: WRITE }, shim))).toBe(true);
    expect(noOptIn.executor.calls).toEqual([]);
    expect(noCapability.executor.calls).toEqual([]);
  });
});
