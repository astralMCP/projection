/**
 * Version constants recorded into every blob (R20) and strict-matched on
 * open (R21, Q3: no migration — mismatches are rejected).
 *
 * Hardcoded rather than imported from package.json at runtime: JSON import
 * attributes complicate the tsdown/dist story for zero benefit, and both
 * versions are pinned exactly (DECISIONS.md D2). A test in
 * `test/blob/versions.test.ts` asserts these constants match the installed
 * package.json versions, so a version bump that forgets to update them fails
 * CI instead of silently minting blobs with a stale version stamp.
 */

/** `@astral-mcp/projection` package version (must match packages/projection/package.json). */
export const LIB_VERSION = '0.8.0';

/** Pinned XState version (must match the exact pin in package.json — D2). */
export const XSTATE_VERSION = '5.32.5';

/**
 * Exact pin of `@modelcontextprotocol/server` and `@modelcontextprotocol/client`
 * (must match package.json). Not a blob stamp: the introspector names it when
 * a wrapped `McpServer` comes from a second, different copy of the SDK.
 */
export const MCP_SDK_VERSION = '2.3.1';
