/**
 * Version constants recorded into every blob (R20) and strict-matched on
 * open (R21, Q3: no migration — mismatches are rejected).
 *
 * Hardcoded rather than imported from package.json at runtime: JSON import
 * attributes complicate the tsdown/dist story for zero benefit, and both
 * stamped versions are pinned exactly (DECISIONS.md D2). A test in
 * `test/blob/versions.test.ts` asserts these constants match the installed
 * package.json versions, so a version bump that forgets to update them fails
 * CI instead of silently minting blobs with a stale version stamp.
 */

/** `@astral-mcp/projection` package version (must match packages/projection/package.json). */
export const LIB_VERSION = '0.10.0';

/** Pinned XState version (must match the exact pin in package.json — D2). */
export const XSTATE_VERSION = '5.32.5';

/**
 * Pinned psychoscript version for the experimental program runtime
 * (`WrapOptions.codeRuntime: 'psychoscript'`; must match the exact pin in
 * package.json). A psychoscript snapshot resumes only in the build that
 * wrote it, so a program blob is stamped with this instead of the XState
 * version.
 */
export const PSYCHOSCRIPT_VERSION = '0.3.0';

/**
 * What runs the code `execute_machine` is given: an XState v5 machine
 * (`xstate`, the default) or a plain JavaScript program on psychoscript
 * (`psychoscript`, experimental).
 */
export type CodeRuntime = 'xstate' | 'psychoscript';

/**
 * The runtime stamp an `execute_machine` blob carries in its `xstatev` field
 * and is strict-matched on open (Q3): the XState version for a machine,
 * `psychoscript@<version>` for a program. Distinct values, so a blob never
 * resumes under the other runtime.
 */
export function runtimeStampFor(runtime: CodeRuntime): string {
  return runtime === 'psychoscript' ? `psychoscript@${PSYCHOSCRIPT_VERSION}` : XSTATE_VERSION;
}

/**
 * The `@modelcontextprotocol/server` and `@modelcontextprotocol/client` version
 * Projection is built and tested against: the exact devDependency pin (must
 * match package.json). Not a blob stamp.
 */
export const MCP_SDK_VERSION = '2.4.0';

/**
 * The peerDependencies range for both SDK packages (must match package.json;
 * DECISIONS D40). The consumer installs the SDK; the introspector names this
 * range when a wrapped `McpServer` comes from a second, different copy.
 */
export const MCP_SDK_RANGE = '~2.4.0';
