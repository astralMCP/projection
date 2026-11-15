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
 * Pinned XState v6 version for the experimental v6 runtime (`WrapOptions.xstate: 6`),
 * installed under the `xstate-v6` npm alias (must match that pin). A v6 facade
 * stamps and checks this instead of {@link XSTATE_VERSION}.
 */
export const XSTATE_V6_VERSION = '6.0.0-beta.2';

/** The XState major a facade runs authored machines under. */
export type XStateMajor = 5 | 6;

/** The exact XState version a facade of this major stamps into its blobs. */
export function xstateVersionFor(major: XStateMajor): string {
  return major === 6 ? XSTATE_V6_VERSION : XSTATE_VERSION;
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
