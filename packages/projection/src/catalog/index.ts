/**
 * Catalog projection (PRD §6.8, R32–R38): the lazy-catalog shape —
 * `search_tools` → `describe_tool` → `call_tool` — served next to code mode
 * over the same introspected catalog and policy engine. `search_tools` and
 * `describe_tool` are pure reads; `call_tool` runs one wrapped tool under
 * the same approval gate as a machine step (R35–R38).
 *
 * Pure functions over a `ServerCatalog`; the facade (`wrap.ts`) registers
 * them as MCP tools and converts thrown `ProjectionError`s into R25
 * structured error results.
 */

export {
  callTool,
  CALL_KEY,
  type CallToolArgs,
  type CallToolDeps,
  type CallToolOutcome,
} from './call.js';
// The `call` blob TTL lives with the other blob defaults; re-exported here so
// the catalog surface keeps naming it.
export { DEFAULT_CALL_TTL_MS } from '../blob/index.js';
export { canonicalJson, canonicalRequest } from './canonical.js';
export { validateArgsShape } from './validate-args.js';
export {
  describeTool,
  type DescribeToolArgs,
  type DescribeToolOptions,
  type ToolDescription,
} from './describe.js';
export {
  sanitizeSchema,
  MAX_SCHEMA_CHARS,
  SCHEMA_KEY_ALLOWLIST,
  type SanitizedSchema,
} from './schema-safety.js';
export {
  searchTools,
  summarizeTool,
  tokenize,
  DEFAULT_SEARCH_PAGE_SIZE,
  MAX_QUERY_CHARS,
  type SearchToolsArgs,
  type SearchToolsOptions,
  type SearchToolsPage,
  type ToolSummary,
} from './search.js';
// The posture vocabulary (R33) belongs to the policy engine; re-exported
// here because `search_tools` and `describe_tool` results are typed with it.
export { postureOf, type ToolPosture } from '../policy/index.js';
