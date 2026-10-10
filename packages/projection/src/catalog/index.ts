/**
 * Catalog projection (PRD §6.8, R32–R34): the lazy-catalog shape —
 * `search_tools` → `describe_tool` → `call_tool` — served next to code mode
 * over the same introspected catalog and policy engine.
 *
 * Pure functions over a `ServerCatalog`; the facade (`wrap.ts`) registers
 * them as MCP tools and converts thrown `ProjectionError`s into R25
 * structured error results.
 */

export {
  callTool,
  CALL_KEY,
  DEFAULT_CALL_TTL_MS,
  type CallToolArgs,
  type CallToolDeps,
  type CallToolOutcome,
} from './call.js';
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
  postureOf,
  searchTools,
  summarizeTool,
  DEFAULT_SEARCH_PAGE_SIZE,
  MAX_QUERY_CHARS,
  type SearchToolsArgs,
  type SearchToolsOptions,
  type SearchToolsPage,
  type ToolPosture,
  type ToolSummary,
} from './search.js';
