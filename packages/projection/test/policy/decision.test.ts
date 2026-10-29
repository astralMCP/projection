import { describe, expect, it } from 'vitest';
import { ProjectionError } from '../../src/errors.js';
import {
  assertApprovalsMode,
  decidePolicy,
  policyContext,
  POLICY_DENIED_REASON,
  policyDeniedReason,
  resolveCallPolicy,
} from '../../src/policy/index.js';
import type {
  ApprovalsMode,
  PendingToolCall,
  PolicyContext,
  PolicyDecision,
  PolicyOverrides,
  ServerCatalog,
  ToolCatalogEntry,
} from '../../src/types.js';

function entry(overrides: Partial<ToolCatalogEntry> = {}): ToolCatalogEntry {
  return { name: 'demo_tool', inputSchema: { type: 'object' }, ...overrides };
}

describe('decidePolicy', () => {
  it('readOnlyHint true -> auto', () => {
    expect(decidePolicy(entry({ annotations: { readOnlyHint: true } }))).toBe('auto');
  });

  it('unannotated -> ask (S5 default posture)', () => {
    expect(decidePolicy(entry())).toBe('ask');
    expect(decidePolicy(entry({ annotations: {} }))).toBe('ask');
  });

  it('readOnlyHint false -> ask', () => {
    expect(decidePolicy(entry({ annotations: { readOnlyHint: false } }))).toBe('ask');
  });

  it('destructiveHint alone does not change the decision', () => {
    expect(decidePolicy(entry({ annotations: { destructiveHint: true } }))).toBe('ask');
  });

  it('overrides beat annotations in every combination', () => {
    const annotationVariants: (ToolCatalogEntry['annotations'] | undefined)[] = [
      undefined,
      { readOnlyHint: true },
      { readOnlyHint: false },
      { readOnlyHint: true, destructiveHint: true },
    ];
    const overrideVariants: PolicyDecision[] = ['auto', 'ask', 'deny'];
    for (const annotations of annotationVariants) {
      for (const override of overrideVariants) {
        const e = annotations === undefined ? entry() : entry({ annotations });
        expect(decidePolicy(e, policyContext({ policy: { demo_tool: override } }))).toBe(override);
      }
    }
  });

  it('deny override wins even over readOnlyHint true', () => {
    const e = entry({ annotations: { readOnlyHint: true } });
    expect(decidePolicy(e, policyContext({ policy: { demo_tool: 'deny' } }))).toBe('deny');
  });

  it('override for a different tool does not apply', () => {
    const e = entry({ annotations: { readOnlyHint: true } });
    expect(decidePolicy(e, policyContext({ policy: { other_tool: 'deny' } }))).toBe('auto');
  });

  it('does not inherit decisions from Object.prototype for tools named like its members', () => {
    const e = entry({ name: 'toString' });
    expect(decidePolicy(e, policyContext({ policy: {} }))).toBe('ask');
    const readOnly = entry({ name: 'constructor', annotations: { readOnlyHint: true } });
    expect(decidePolicy(readOnly, policyContext({ policy: {} }))).toBe('auto');
  });

  it('malformed override values fail safe to ask, never auto', () => {
    const e = entry({ annotations: { readOnlyHint: true } });
    const garbage = { demo_tool: 'yolo' } as unknown as Record<string, PolicyDecision>;
    expect(decidePolicy(e, policyContext({ policy: garbage }))).toBe('ask');
  });

  it('refuses a bare overrides object instead of silently dropping its deny (fail closed)', () => {
    // A pre-R49 caller (untyped JS, or a cast) passing the old second
    // argument must not have its `deny` ignored.
    const legacy = { demo_tool: 'deny' } as unknown as PolicyContext;
    expect(() => decidePolicy(entry(), legacy)).toThrow(TypeError);
  });
});

describe('decidePolicy truth table (R14, R49)', () => {
  type Hint = boolean | undefined | 'garbage';
  const readOnlyHints: Hint[] = [true, false, undefined];
  const destructiveHints: Hint[] = [true, false, undefined, 'garbage'];
  const modes: (ApprovalsMode | undefined)[] = [undefined, 'every-write', 'destructive-only'];
  const overrides: (PolicyDecision | 'garbage' | undefined)[] = [
    undefined,
    'auto',
    'ask',
    'deny',
    'garbage',
  ];

  function annotated(readOnlyHint: Hint, destructiveHint: Hint): ToolCatalogEntry {
    const annotations: Record<string, unknown> = {};
    if (readOnlyHint !== undefined) annotations['readOnlyHint'] = readOnlyHint;
    if (destructiveHint === 'garbage') annotations['destructiveHint'] = 'false';
    else if (destructiveHint !== undefined) annotations['destructiveHint'] = destructiveHint;
    return entry({ annotations: annotations as NonNullable<ToolCatalogEntry['annotations']> });
  }

  /** The spec, restated independently of the implementation. */
  function expected(
    readOnlyHint: Hint,
    destructiveHint: Hint,
    mode: ApprovalsMode | undefined,
    override: PolicyDecision | 'garbage' | undefined,
  ): PolicyDecision {
    if (override === 'garbage') return 'ask';
    if (override !== undefined) return override;
    if (readOnlyHint === true) return 'auto';
    if (mode === 'destructive-only' && destructiveHint === false) return 'auto';
    return 'ask';
  }

  for (const readOnlyHint of readOnlyHints) {
    for (const destructiveHint of destructiveHints) {
      for (const mode of modes) {
        for (const override of overrides) {
          const want = expected(readOnlyHint, destructiveHint, mode, override);
          const label = `readOnly=${String(readOnlyHint)} destructive=${String(destructiveHint)} mode=${String(mode)} override=${String(override)} -> ${want}`;
          it(label, () => {
            const policy =
              override === undefined
                ? undefined
                : ({ demo_tool: override } as unknown as PolicyOverrides);
            const context = policyContext({
              ...(policy !== undefined ? { policy } : {}),
              ...(mode !== undefined ? { approvals: mode } : {}),
            });
            expect(decidePolicy(annotated(readOnlyHint, destructiveHint), context)).toBe(want);
          });
        }
      }
    }
  }

  it('without a context decides as every-write', () => {
    expect(decidePolicy(entry({ annotations: { destructiveHint: false } }))).toBe('ask');
  });

  it('an unrecognized mode string reaching decidePolicy relaxes nothing', () => {
    const context = { approvals: 'destructive_only' } as unknown as PolicyContext;
    expect(decidePolicy(entry({ annotations: { destructiveHint: false } }), context)).toBe('ask');
  });

  it('a destructiveHint: false read-only tool stays auto, and readOnlyHint: false + destructiveHint: false is auto only under destructive-only', () => {
    const tool = entry({ annotations: { readOnlyHint: false, destructiveHint: false } });
    expect(decidePolicy(tool, policyContext({ approvals: 'every-write' }))).toBe('ask');
    expect(decidePolicy(tool, policyContext({ approvals: 'destructive-only' }))).toBe('auto');
  });
});

describe('policyContext', () => {
  it('resolves an absent mode to every-write and carries the overrides', () => {
    expect(policyContext()).toEqual({ approvals: 'every-write' });
    const policy: PolicyOverrides = { demo_tool: 'deny' };
    expect(policyContext({ policy, approvals: 'destructive-only' })).toEqual({
      overrides: policy,
      approvals: 'destructive-only',
    });
  });
});

describe('assertApprovalsMode', () => {
  it('accepts the two modes and absence', () => {
    expect(assertApprovalsMode(undefined)).toBeUndefined();
    expect(assertApprovalsMode('every-write')).toBe('every-write');
    expect(assertApprovalsMode('destructive-only')).toBe('destructive-only');
  });

  it.each([null, '', 'Destructive-Only', 'destructive_only', 'none', true, 1, {}, ['every-write']])(
    'rejects %j with a validate-phase ProjectionError',
    (value) => {
      try {
        assertApprovalsMode(value);
        expect.unreachable('expected a throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ProjectionError);
        expect(err).toMatchObject({ phase: 'validate' });
      }
    },
  );
});

function call(name: string): PendingToolCall {
  return { id: 'call-1', name, args: { path: '/tmp/x' }, stateName: 'deleting' };
}

describe('resolveCallPolicy', () => {
  const catalog: ServerCatalog = {
    alias: 'default',
    identity: 'test-server',
    tools: [
      entry({ name: 'read_file', annotations: { readOnlyHint: true } }),
      entry({ name: 'delete_file', annotations: { destructiveHint: true } }),
    ],
  };

  it('resolves a known tool to its decision and catalog entry', () => {
    const resolved = resolveCallPolicy(call('read_file'), catalog);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.decision).toBe('auto');
      expect(resolved.entry.name).toBe('read_file');
    }
  });

  it('applies overrides during resolution', () => {
    const resolved = resolveCallPolicy(
      call('read_file'),
      catalog,
      policyContext({ policy: { read_file: 'deny' } }),
    );
    expect(resolved.ok && resolved.decision).toBe('deny');
  });

  it('resolves duplicate tool names to the FIRST catalog entry (S5)', () => {
    // A hostile server can declare the same name twice; the gate must see the
    // same entry typegen exposed (first occurrence), so a later copy with
    // readOnlyHint: true cannot flip an approval-gated tool to auto.
    const duped: ServerCatalog = {
      alias: 'default',
      identity: 'hostile-server',
      tools: [
        entry({ name: 'send', annotations: { readOnlyHint: false } }),
        entry({ name: 'send', annotations: { readOnlyHint: true } }),
      ],
    };
    const resolved = resolveCallPolicy(call('send'), duped);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.decision).toBe('ask');
      expect(resolved.entry.annotations?.readOnlyHint).toBe(false);
    }
  });

  it('returns a validate-phase ProjectionError for an unknown tool', () => {
    const resolved = resolveCallPolicy(call('drop_database'), catalog);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error).toBeInstanceOf(ProjectionError);
      expect(resolved.error.phase).toBe('validate');
      expect(resolved.error.message).toContain('drop_database');
      expect(resolved.error.hint).toContain('discover_apis');
    }
  });
});

describe('policyDeniedReason', () => {
  it('exposes the canonical reason', () => {
    expect(POLICY_DENIED_REASON).toBe('denied by server policy');
    expect(policyDeniedReason()).toBe('denied by server policy');
  });

  it('names the denied tool when given', () => {
    const reason = policyDeniedReason('delete_file');
    expect(reason).toContain('denied by server policy');
    expect(reason).toContain('delete_file');
  });

  it('renders a hostile tool name inert and bounded (S5)', () => {
    const ESC = String.fromCharCode(0x1b);
    const reason = policyDeniedReason(`rm${ESC}[31m\n${'z'.repeat(5_000)}`);
    expect(reason).not.toContain(ESC);
    expect(reason).not.toContain('\n');
    expect(reason.length).toBeLessThan(300);
  });
});
