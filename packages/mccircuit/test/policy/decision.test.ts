import { describe, expect, it } from 'vitest';
import { McCircuitError } from '../../src/errors.js';
import {
  decidePolicy,
  POLICY_DENIED_REASON,
  policyDeniedReason,
  resolveCallPolicy,
} from '../../src/policy/index.js';
import type {
  PendingToolCall,
  PolicyDecision,
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
        expect(decidePolicy(e, { demo_tool: override })).toBe(override);
      }
    }
  });

  it('deny override wins even over readOnlyHint true', () => {
    const e = entry({ annotations: { readOnlyHint: true } });
    expect(decidePolicy(e, { demo_tool: 'deny' })).toBe('deny');
  });

  it('override for a different tool does not apply', () => {
    const e = entry({ annotations: { readOnlyHint: true } });
    expect(decidePolicy(e, { other_tool: 'deny' })).toBe('auto');
  });

  it('does not inherit decisions from Object.prototype for tools named like its members', () => {
    const e = entry({ name: 'toString' });
    expect(decidePolicy(e, {})).toBe('ask');
    const readOnly = entry({ name: 'constructor', annotations: { readOnlyHint: true } });
    expect(decidePolicy(readOnly, {})).toBe('auto');
  });

  it('malformed override values fail safe to ask, never auto', () => {
    const e = entry({ annotations: { readOnlyHint: true } });
    const garbage = { demo_tool: 'yolo' } as unknown as Record<string, PolicyDecision>;
    expect(decidePolicy(e, garbage)).toBe('ask');
  });
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
    const resolved = resolveCallPolicy(call('read_file'), catalog, { read_file: 'deny' });
    expect(resolved.ok && resolved.decision).toBe('deny');
  });

  it('returns a validate-phase McCircuitError for an unknown tool', () => {
    const resolved = resolveCallPolicy(call('drop_database'), catalog);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error).toBeInstanceOf(McCircuitError);
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
});
