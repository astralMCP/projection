import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalRequest } from '../../src/catalog/index.js';
import { ProjectionError } from '../../src/errors.js';

describe('canonical JSON for the call_tool binding hash (R36)', () => {
  it('sorts object keys recursively, keeps array order, emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson([{ b: 1, a: 2 }, 'x'])).toBe('[{"a":2,"b":1},"x"]');
  });

  it('is insensitive to key order, number spelling and string escaping of the parsed input', () => {
    const a = canonicalJson(
      JSON.parse('{"n": 1.0, "z": -0, "s": "\\u0041", "o": {"b": 1, "a": 2}}'),
    );
    const b = canonicalJson(JSON.parse('{"o": {"a": 2, "b": 1}, "s": "A", "z": 0, "n": 1}'));
    expect(a).toBe(b);
    // Duplicate keys: last wins at parse time, so both sides agree.
    expect(canonicalJson(JSON.parse('{"a": 1, "a": 2}'))).toBe('{"a":2}');
  });

  it('sorts by UTF-16 code unit order and applies no Unicode normalization', () => {
    expect(canonicalJson({ é: 1, z: 2, A: 3 })).toBe('{"A":3,"z":2,"é":1}');
    // NFC "é" vs NFD "é" are different strings: fail closed.
    expect(canonicalJson({ k: 'é' })).not.toBe(canonicalJson({ k: 'é' }));
  });

  it('treats __proto__ as an ordinary key', () => {
    const weird = JSON.parse('{"__proto__": {"x": 1}, "a": 1}') as Record<string, unknown>;
    expect(canonicalJson(weird)).toBe('{"__proto__":{"x":1},"a":1}');
  });

  it('throws validate on values JSON cannot carry', () => {
    for (const bad of [
      { a: undefined },
      { a: () => 1 },
      { a: 10n },
      { a: Number.NaN },
      { a: Number.POSITIVE_INFINITY },
      { a: Symbol('s') },
    ]) {
      try {
        canonicalJson(bad);
        expect.unreachable('expected a throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ProjectionError);
        expect((err as ProjectionError).phase).toBe('validate');
        expect((err as ProjectionError).message).toContain('$.a');
      }
    }
  });

  it('bounds nesting depth', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100; i += 1) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(ProjectionError);
  });

  it('canonicalRequest is domain-separated from code by construction', () => {
    expect(canonicalRequest('write_file', { path: '/x', content: 'c' })).toBe(
      '{"args":{"content":"c","path":"/x"},"kind":"call","name":"write_file"}',
    );
  });
});
