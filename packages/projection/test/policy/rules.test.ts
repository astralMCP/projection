/**
 * Policy rules (R14 amendment, DECISIONS D36): validation, name patterns,
 * precedence and fail-safe resolution into per-tool overrides.
 */

import { describe, expect, it } from 'vitest';
import {
  assertPolicyRules,
  decidePolicy,
  policyContext,
  ProjectionError,
  resolvePolicyRules,
  type PolicyDecision,
  type PolicyRule,
  type ServerCatalog,
  type ToolCatalogEntry,
} from '../../src/index.js';
import { globMatches } from '../../src/policy/rules.js';

function tool(name: string, annotations?: ToolCatalogEntry['annotations']): ToolCatalogEntry {
  return {
    name,
    inputSchema: { type: 'object' },
    ...(annotations !== undefined ? { annotations } : {}),
  };
}

function catalog(...tools: ToolCatalogEntry[]): ServerCatalog {
  return { alias: 'default', identity: 'test@1', tools };
}

const SERVER = catalog(
  tool('gmail-send-email', { readOnlyHint: false, destructiveHint: false }),
  tool('gdocs-insert-text', { readOnlyHint: false, destructiveHint: false }),
  tool('slack-send-message', { destructiveHint: false }),
  tool('gmail-list-labels', { readOnlyHint: true }),
);

describe('globMatches', () => {
  it.each([
    ['*send*', 'gmail-send-email', true],
    ['*send*', 'send', true],
    ['*send*', 'gmail-list-labels', false],
    ['*SEND*', 'Gmail-Send-Email', true],
    ['gmail-*', 'gmail-send-email', true],
    ['gmail-*', 'xgmail-send', false],
    ['*-email', 'gmail-send-email', true],
    ['*-email', 'gmail-send-email-x', false],
    ['a*b*c', 'abc', true],
    ['a*b*c', 'aXbYc', true],
    ['a*b*c', 'acb', false],
    ['ab*ba', 'aba', false],
    ['send', 'send', true],
    ['send', 'gmail-send', false],
    ['*', '', true],
    ['', '', true],
    ['', 'x', false],
    ['a.b', 'axb', false],
    ['gmail.*', 'gmail.send', true],
    ['gmail.*', 'fs.gmail.send', false],
    // A literal `*` in a tool name is matched by a `*` in the pattern.
    ['star*', 'star*name', true],
  ])('%j vs %j → %s', (pattern, name, expected) => {
    expect(globMatches(pattern, name)).toBe(expected);
  });
});

describe('assertPolicyRules', () => {
  it('accepts undefined, an empty array, patterns and functions', () => {
    expect(assertPolicyRules(undefined)).toBeUndefined();
    expect(assertPolicyRules([])).toEqual([]);
    const rules: PolicyRule[] = [{ match: '*send*', decision: 'ask' }, () => undefined];
    expect(assertPolicyRules(rules)).toBe(rules);
  });

  it.each([
    { match: '*' },
    'nope',
    null,
    { '*send*': 'ask' },
    [{ decision: 'ask' }],
    [{ match: 3, decision: 'ask' }],
    [null],
    ['*send*'],
  ])('%j is a validate error', (value) => {
    expect(() => assertPolicyRules(value)).toThrow(ProjectionError);
    try {
      assertPolicyRules(value);
    } catch (err) {
      expect(err).toMatchObject({ phase: 'validate' });
    }
  });
});

function decisions(
  rules: PolicyRule[],
  policy?: Record<string, PolicyDecision>,
  approvals?: 'every-write' | 'destructive-only',
): Record<string, PolicyDecision> {
  const overrides = resolvePolicyRules(SERVER, rules, policy);
  const context = policyContext({
    ...(overrides !== undefined ? { policy: overrides } : {}),
    ...(approvals !== undefined ? { approvals } : {}),
  });
  return Object.fromEntries(SERVER.tools.map((t) => [t.name, decidePolicy(t, context)]));
}

describe('resolvePolicyRules precedence', () => {
  it('returns the overrides object itself when there are no rules', () => {
    const policy = { 'gmail-send-email': 'deny' as const };
    expect(resolvePolicyRules(SERVER, undefined, policy)).toBe(policy);
    expect(resolvePolicyRules(SERVER, [], policy)).toBe(policy);
    expect(resolvePolicyRules(SERVER, [], undefined)).toBeUndefined();
    expect(resolvePolicyRules(SERVER, [() => undefined], undefined)).toBeUndefined();
  });

  it('a rule pins non-destructive sends to ask under destructive-only', () => {
    expect(
      decisions([{ match: '*send*', decision: 'ask' }], undefined, 'destructive-only'),
    ).toEqual({
      'gmail-send-email': 'ask',
      'gdocs-insert-text': 'auto',
      'slack-send-message': 'ask',
      'gmail-list-labels': 'auto',
    });
  });

  it('an exact-name override beats every rule', () => {
    expect(
      decisions(
        [{ match: '*send*', decision: 'deny' }],
        { 'slack-send-message': 'auto' },
        'every-write',
      ),
    ).toMatchObject({ 'gmail-send-email': 'deny', 'slack-send-message': 'auto' });
  });

  it('a malformed exact override still fails safe to ask, a rule cannot rescue it', () => {
    const policy = { 'gmail-send-email': 'yes' } as unknown as Record<string, PolicyDecision>;
    expect(decisions([() => 'auto'], policy)['gmail-send-email']).toBe('ask');
  });

  it('the first rule with an opinion wins; undefined defers to the next', () => {
    const rules: PolicyRule[] = [
      (t) => (t.name.startsWith('gmail') ? undefined : 'deny'),
      { match: 'gmail-*', decision: 'auto' },
      { match: '*', decision: 'deny' },
    ];
    expect(decisions(rules)).toEqual({
      'gmail-send-email': 'auto',
      'gdocs-insert-text': 'deny',
      'slack-send-message': 'deny',
      'gmail-list-labels': 'auto',
    });
  });

  it('a rule beats the annotations: ask on a read-only tool asks', () => {
    expect(decisions([{ match: '*list*', decision: 'ask' }])['gmail-list-labels']).toBe('ask');
  });

  it('a predicate sees the annotations', () => {
    const rule: PolicyRule = (t) =>
      t.annotations?.destructiveHint === false && t.annotations.readOnlyHint !== true
        ? 'ask'
        : undefined;
    expect(decisions([rule], undefined, 'destructive-only')).toMatchObject({
      'gdocs-insert-text': 'ask',
      'gmail-list-labels': 'auto',
    });
  });
});

describe('resolvePolicyRules fails safe', () => {
  it.each([null, 'allow', 'AUTO', true, 1, {}, ['auto']])(
    'a predicate returning %j decides ask, never auto',
    (value) => {
      const rule = (() => value) as unknown as PolicyRule;
      const d = decisions([rule], undefined, 'destructive-only');
      expect(Object.values(d)).toEqual(['ask', 'ask', 'ask', 'ask']);
    },
  );

  it('a pattern with a malformed decision decides ask on its matches', () => {
    const rule = { match: '*send*', decision: 'allow' } as unknown as PolicyRule;
    expect(decisions([rule], undefined, 'destructive-only')).toMatchObject({
      'gmail-send-email': 'ask',
      'gdocs-insert-text': 'auto',
    });
  });

  it('a throwing rule is a validate error naming the tool', () => {
    const boom = new Error('boom');
    try {
      resolvePolicyRules(
        SERVER,
        [
          () => {
            throw boom;
          },
        ],
        undefined,
      );
      expect.unreachable('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectionError);
      expect(err).toMatchObject({ phase: 'validate', cause: boom });
      expect((err as Error).message).toContain('"gmail-send-email"');
    }
  });

  it('an async rule is a validate error, not a silent decision', () => {
    const rule = (async () => 'auto') as unknown as PolicyRule;
    expect(() => resolvePolicyRules(SERVER, [rule], undefined)).toThrow(/promise/);
  });

  it('a predicate gets a copy: mutating it cannot relax the catalog', () => {
    const local = catalog(tool('write', { destructiveHint: true }));
    resolvePolicyRules(
      local,
      [
        (t) => {
          t.name = 'other';
          (t.annotations as Record<string, unknown>)['readOnlyHint'] = true;
          return undefined;
        },
      ],
      undefined,
    );
    expect(local.tools[0]).toEqual(tool('write', { destructiveHint: true }));
  });

  it('a tool named __proto__ gets an own override, not a prototype', () => {
    const local = catalog(tool('__proto__'), tool('toString'));
    const overrides = resolvePolicyRules(local, [{ match: '*', decision: 'deny' }], undefined);
    expect(Object.getPrototypeOf(overrides)).toBe(Object.prototype);
    expect(Object.hasOwn(overrides as object, '__proto__')).toBe(true);
    const context = policyContext({ policy: overrides });
    expect(local.tools.map((t) => decidePolicy(t, context))).toEqual(['deny', 'deny']);
  });

  it('a duplicated name is decided on its first occurrence (S5)', () => {
    const local = catalog(
      tool('dup', { destructiveHint: true }),
      tool('dup', { readOnlyHint: true }),
    );
    const seen: unknown[] = [];
    const overrides = resolvePolicyRules(
      local,
      [
        (t) => {
          seen.push(t.annotations);
          return t.annotations?.readOnlyHint === true ? 'auto' : 'ask';
        },
      ],
      undefined,
    );
    expect(seen).toEqual([{ destructiveHint: true }]);
    expect(overrides).toEqual({ dup: 'ask' });
  });
});
