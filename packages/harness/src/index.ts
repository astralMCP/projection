/**
 * @astral-mcp/harness — a scenario-driven test harness for Projection.
 *
 * Drives `execute_machine` through the full MRTR round-trip loop under a
 * scripted answer policy, records the side effects that actually reached the
 * wrapped server, and reports enough to assert the approval invariants and
 * the Section 10 budgets (blob size, round-trip counts). The bundled tests
 * cover S1 (only Projection's five tools are exposed, never the wrapped
 * server's own), S2 (approval binds the sealed call),
 * S3/S4 (tampered blobs execute nothing), S5 (annotation-driven policy) and
 * S6 (server-derived prompt copy).
 *
 * The `reasoning/` layer builds the Anthropic-SDK-driven reasoning loop on
 * top (PRD §13): an author (a model, or a deterministic script in CI)
 * writes machines, executes them through the scenario runner, and self-heals
 * from structured errors; `summarizeSelfHeal` computes the §10 metrics.
 */

export { runScenario, type SideEffectLog } from './runner.js';
export { loadNearestDotEnv } from './env.js';
export {
  createRecordingServer,
  createFileServer,
  type RecordingServer,
  type RecordingTool,
} from './recording-server.js';
export {
  approveAll,
  declineAll,
  denyKeys,
  ignoreKeys,
  tamperCiphertext,
  truncateState,
} from './scenarios.js';
export type {
  PromptView,
  RoundRecord,
  RunStatus,
  Scenario,
  ScenarioResult,
  SideEffect,
  StateMutator,
  VerdictPolicy,
} from './types.js';

export {
  buildApiDocs,
  createScriptedAuthor,
  extractModuleSource,
  type AttemptErrorView,
  type AuthoringContext,
  type MachineAuthor,
} from './reasoning/author.js';
export { createAnthropicAuthor, type AnthropicAuthorOptions } from './reasoning/anthropic.js';
export {
  runReasoningTask,
  type AttemptRecord,
  type BenchmarkTask,
  type ReasoningOptions,
  type ReasoningResult,
} from './reasoning/loop.js';
export {
  formatSelfHealReport,
  summarizeSelfHeal,
  type SelfHealSummary,
} from './reasoning/metrics.js';
export { FILE_SERVER_TASKS, FILE_SERVER_FIXTURE } from './reasoning/tasks.js';

// Tool-choice eval: direct tools vs Projection, against the offline GitHub fake
// or a real server behind a recording proxy.
export {
  answerFor,
  branchesListed,
  createGithubFake,
  fakeError,
  FakeError,
  pageOf,
  queryTerms,
  textMatches,
  BASIC_REPO,
  FAKE_PAGE_SIZE,
  FAKE_USER,
  GITHUB_CATALOG,
  GITHUB_FAKE_ANSWERS,
  HARD_BRANCHES,
  HARD_DEFAULT_BRANCH,
  HARD_ISSUES,
  HARD_LABELS,
  HARD_PULLS,
  HARD_README_TEXT,
  HARD_REPO,
  HARD_REVIEW_COMMENTS,
  HARD_ROOT_FILES,
  HARD_SRC_FILES,
  CREATED_ISSUE_NUMBER,
  USER_DEPENDABOT_ALERTS,
  USER_REPOS,
  USER_STARRED,
  type FakeAnswer,
  type FakeAnswerFn,
  type FakeArgs,
  type FakeIssue,
  type FakePage,
  type FakePullRequest,
  type FakeReviewComment,
  type GithubCatalogFixture,
  type GithubCatalogTool,
  type GithubFake,
  type GithubFakeOptions,
} from './eval/github-fake.js';
export {
  anthropicCaller,
  resolveModelPresets,
  runAgentEpisode,
  DEFAULT_MAX_TOTAL_TURNS,
  DEFAULT_MAX_TURNS,
  DEFAULT_MODEL_PRESETS,
  MODEL_PRESETS,
  type AgentEpisode,
  type AgentEpisodeOptions,
  type AgentRuntime,
  type AgentTool,
  type AgentToolResult,
  type EpisodeUsage,
  type ModelCaller,
  type ModelPreset,
  type ToolUseRecord,
} from './eval/agent.js';
export {
  promptFor,
  resolveTasks,
  resolveTiers,
  worldOf,
  BASIC_TASKS,
  HARD_TASKS,
  TASK_TIERS,
  TIER_WORLDS,
  TOOL_CHOICE_TASKS,
  type EvalTask,
  type TaskKind,
  type TaskTier,
  type VerifyContext,
} from './eval/tasks.js';
export { FILESYSTEM_TASKS } from './eval/filesystem-tasks.js';
export { MONGODB_TASKS } from './eval/mongodb-tasks.js';
export {
  githubWorld,
  openWorld,
  GITHUB_DIRECT_SYSTEM_PROMPT,
  type EvalWorld,
  type WorldFacts,
  type WorldName,
  type WorldOptions,
  type WorldTool,
} from './eval/world.js';
export {
  filesystemServerEntry,
  openFilesystemWorld,
  writeFilesystemFixture,
  FILESYSTEM_DIRECT_SYSTEM_PROMPT,
  FILESYSTEM_FIXTURE,
  FIXTURE_CHANGELOG,
  FIXTURE_IDEAS,
  FIXTURE_PACKAGE_JSON,
  FIXTURE_README,
  FIXTURE_TODO,
  FIXTURE_UTIL_JS,
} from './eval/filesystem-world.js';
export {
  mongodbBinaryDir,
  mongodbServerEntry,
  mongodbServerInstalled,
  openMongodbWorld,
  seedMongodbFixture,
  withMongodb,
  FIXTURE_CUSTOMERS,
  FIXTURE_ORDERS,
  FIXTURE_PRODUCTS,
  MONGODB_DIRECT_SYSTEM_PROMPT,
  MONGODB_DISABLED_TOOLS,
  MONGODB_EXPECTED_TOOLS,
  MONGODB_FIXTURE,
  MONGODB_QUERY_CAP,
  MONGODB_VERSION,
  NAMED_PRODUCTS,
  ORDER_STATUS_COUNTS,
  SHOP_COLLECTIONS,
  SHOP_DB,
  STALE_CUTOFF,
  type MongodbFixture,
} from './eval/mongodb-world.js';
export { createRecordingProxy, type RecordingProxy } from './eval/recording-proxy.js';
export {
  openDirectSession,
  openProjectionSession,
  openSession,
  resolveModes,
  toolResultText,
  EVAL_MODES,
  PROJECTION_DISCOVERY_TOOLS,
  type EvalMode,
  type ModeSession,
} from './eval/modes.js';
export {
  createResultsWriter,
  estimateUsd,
  formatEpisodeLine,
  formatToolChoiceReport,
  runToolChoiceEval,
  summarizeToolChoice,
  writeToolChoiceResults,
  MODEL_PRICES,
  type CellSummary,
  type EpisodeRecord,
  type ProjectionRoute,
  type ProjectionUse,
  type ResultsMeta,
  type ResultsWriter,
  type TaskCellSummary,
  type TierCellSummary,
  type ToolChoiceEvalOptions,
  type ToolChoiceSummary,
} from './eval/run.js';
export {
  rescoreRecords,
  type RescoreChange,
  type RescoreOptions,
  type RescoreResult,
  type RescoreVerdict,
} from './eval/rescore.js';
