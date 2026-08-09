/**
 * Transpiler-availability diagnostics. When the installed `typescript` is
 * incompatible (or missing), the environment-class error thrown while
 * preparing TS support must reach the consumer as-is — NOT rewrapped by
 * `createSandboxSession`'s bridge-transpile catch as a runtime-phase
 * "bridgeSource is invalid; integration bug" error, which would bury the
 * actual diagnosis and its fix hint.
 *
 * The incompatible-install scenario is simulated by mocking the `typescript`
 * module to one without `ts.transpile` (what a hoisted TS 7 looks like).
 * This file gets its own module registry, so the mock cannot leak into the
 * other sandbox tests and the session module's memoized TS support starts
 * cold.
 */

import { describe, expect, it, vi } from 'vitest';
import { ProjectionError } from '../../src/errors.js';
import { createSandboxSession } from '../../src/sandbox/index.js';

// `transpile: undefined` must be listed explicitly: vitest's mock namespace
// throws on access to exports the factory does not define.
vi.mock('typescript', () => ({
  default: { version: '7.0.0' },
  version: '7.0.0',
  transpile: undefined,
}));

describe('transpiler availability (environment errors pass through)', () => {
  it('surfaces an incompatible typescript install unrewrapped, with its hint', async () => {
    const err: unknown = await createSandboxSession({
      code: 'export default {};',
      bridgeSource: 'export const toolCall = (): void => {};',
      onToolCall: () => undefined,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ProjectionError);
    const projError = err as ProjectionError;
    // The environment diagnosis, not the bridge-integration rewrap:
    expect(projError.phase).toBe('transpile');
    expect(projError.message).toContain('typescript@7.0.0 does not provide ts.transpile');
    expect(projError.message).not.toContain('bridge module failed to transpile');
    expect(projError.hint).toContain('typescript ^5');
  });
});
