# Changelog

All notable changes to `@astral-mcp/projection` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html): while the version is `0.x`, a minor
bump may break the public API. Each release lists those breaks under **Breaking** first.

Every release also changes `LIB_VERSION`, and `openBlob` requires an exact `libv` match. A
continuation blob sealed by one version is rejected by another, so in-flight approvals do not
survive an upgrade.

## [Unreleased]

### Added

- `WrapOptions.policyRules` sets a policy for many tools at once, by name pattern
  (`{ match: '*send*', decision: 'ask' }`, case-insensitive, `*` matches any run of characters) or
  by a function of the catalog entry. Rules are resolved once, at wrap time. An exact-name
  `policy` override wins over every rule, and rules win over the approvals mode. A matching
  pattern rule with a missing decision resolves to `ask`. New exports: `PolicyRule`,
  `assertPolicyRules()` and `resolvePolicyRules()` (#69, D36).
- `KeyringTokenStore` (the default OS credential store) and `TokenStoreError` are exported from the
  package root, with the `KeyringTokenStoreOptions`, `KeyringModule` and `KeyringEntry` types.
  A `load` that throws synchronously is caught, and `timeoutMs` is bounded (#71, D37).
- The package now ships this `CHANGELOG.md` (#74).

### Changed

- The docs say `destructiveHint: false` means a tool is additive, not harmless (#69).
- The npm README links to repository docs with absolute GitHub URLs, so they resolve on npm
  (#70).

## [0.9.0] - 2026-10-31

Multi-server facades, an approvals mode, sign-in for servers given by URL, upstream elicitation,
and the prompt hill climb recorded in DECISIONS D28–D35 (#57–#67).

### Breaking

Public API signatures, from a diff of the 0.8.0 and 0.9.0 `dist/index.d.mts`. No export was
removed.

- `decidePolicy(entry, overrides?: PolicyOverrides)` is now
  `decidePolicy(entry, context?: PolicyContext)`. Build the context with `policyContext()`:
  `decidePolicy(entry, policyContext({ policy: overrides }))`. Passing a bare overrides map
  throws a `TypeError` at runtime instead of being silently ignored (#59).
- `resolveCallPolicy(call, catalog, overrides?: PolicyOverrides)` is now
  `resolveCallPolicy(call, catalog, context?: PolicyContext)`. Migrate the same way (#59).
- `summarizeTool(entry, policy?: PolicyOverrides)` is now
  `summarizeTool(entry, context?: PolicyContext, withSignature?: boolean, withGlosses?: boolean)`.
  Migrate the same way (#59, #67).
- `HostEvent`: `TOOL_RESULT`, `TOOL_ERROR` and `TOOL_DENIED` each carry a required
  `args: Record<string, unknown>`, the arguments of the call they answer. `TOOL_RESULT` also gains
  optional `text` and `notes` (#67, D29, D31).
- `SegmentOutcome`: the `suspended` variant has a required `held: HeldCall[]`. The `completed`
  variant gains optional `notes`, and the `error` variant gains optional `audit` (#67).
- `ErrorPhase` adds `'auth'` (#65), and `BlobKind` adds `'upstream_input'` (#67). Exhaustive
  switches over either type need a new case.
- `ProjectionFacade` gains a required `signOut(alias?)` method (#65). Its `executeMachine` and
  `callTool` methods take an optional fourth argument, `clientUrlElicitation` (#67).

Behaviour that changes for existing callers:

- `projections.direct` defaults to `'auto'`. A facade over a small catalog (estimated tool
  definitions within `directBudgetTokens`, default 8 000) also lists each wrapped tool as a
  mediated `call_tool` alias, and drops `search_tools`. Set `projections: { direct: false }` to
  restore the five-tool surface (#67, D28).
- In machines, a tool result that is a single text block holding a JSON object or array arrives
  parsed on `TOOL_RESULT.result`, with the raw text on `TOOL_RESULT.text`. JSON scalars stay text.
  A machine that called `JSON.parse(event.result)` on such a result must stop (#67, D29).
- `call_tool` prints a multi-line top-level string field as text inside a code fence instead of as
  an escaped one-liner (#67, D29, D35).
- A machine with two gated calls in flight under one id now fails with a `validate` error instead of
  one call silently replacing the other (#67, D30).
- Machine `toolCall` ids starting with `projection:` are refused with a `validate` error (#67, D25).
- A machine's gated `toolCall` whose arguments fail the schema's structural check (required,
  top-level types, enum, unknown keys) now gets `TOOL_ERROR` before any approval prompt (#67, D25).
- Each source's connect and `tools/list` at wrap time is bounded by `introspectTimeoutMs` (default
  30 000); a slower source, including a pre-built `McpServer` or `Client`, now fails the wrap with a
  `protocol` error (#65).

### Added

- `wrapMcpServers(sources, options)` builds a multi-server facade (`MultiProjectionFacade`). Tool
  names are qualified as `<alias>.<name>`, and each box gets a `search_<alias>` tool, a box
  overview and a shelf in the instructions. `catalog.globalSearch` controls the global
  `search_tools`. Code mode is on by default, with per-box `tools.<alias>` type namespaces and
  qualified `toolCall('<alias>.<name>')` (#58, #63, #64).
- `WrapOptions.approvals`: `'every-write'` (default) or `'destructive-only'`. In
  `'destructive-only'` mode, a tool whose annotations set `destructiveHint: false` runs without
  approval. `policyContext()`, `assertApprovalsMode()`, `PolicyContext` and `PolicyOptions` are
  exported (#59).
- Wrap by URL: `wrapMcpServer` and `wrapMcpServers` accept `UpstreamSpec` (`{ url, oauth? }`). A
  `TokenStore` interface comes with `MemoryTokenStore`. The default store is the OS credential
  store through the optional dependency `@napi-rs/keyring`, and falls back to memory. Also adds
  `WrapOptions.tokenStore`, `WrapOptions.introspectTimeoutMs` (default 30 000) and
  `facade.signOut()`. A source that still needs sign-in fails the wrap with an `auth`-phase error
  (#65).
- `WrapOptions.upstreamElicitation`: `'refuse'` (default) or `'forward'`. With `'forward'`, a
  wrapped server's own questions are relayed to the human over MRTR, labelled as not an approval
  (#67).
- `WrapOptions.approvalPrompts`: `'per-call'` (default) or `'batched'`, which asks for several gated
  calls of one suspension in one elicitation. Each call still needs its own checkbox (#67).
- `projections.direct` and `projections.directBudgetTokens`, the direct listing described above
  (#67, D28).
- In machines, `toolCalls` and `whenCallIn` make many gated calls in one round trip (#67, D30).
- Search hits show call signatures and glosses of their required arguments, and search pages show a
  box's shared arguments once. `search_tools` weights rare query words. Also adds the
  `CallSignature`, `ArgGloss` and `SharedArg` types and the `callSignature()`, `argGlosses()` and
  `sharedArgs()` helpers (#67, D22, D32–D34).
- `call_tool` relays upstream content blocks natively, relays progress, and passes cancellation
  through to the upstream call. It also adds notes when a result looks like one page of a larger
  set (#67, D23, D29).
- New optional parameters: `sealBlob(…, domain?)`, `OpenBlobOptions.domain`,
  `createIntrospector(sources, options?)`, `ToolExecutor.callTool(…, options?)`,
  `buildResources(…, policy?, maxRoundTrips?)`, `validateArgsShape(…, caller?)` and
  `neutralizeControlChars` `allowTab` (#58, #64, #65, #67).

### Changed

- Machine results and `describe_tool` say that an undeclared output schema may be an object or JSON
  text. `describe_tool` and generated types keep scalar schema defaults (#67, D29).
- A workflow that hits `maxRoundTrips` is reported as stopped unfinished (#67, D30).
- Approval and decline copy is scoped to the call, and completed or failed workflow results restate
  refused calls and calls that already ran (#67).

### Security

- Batched approval prompts seal their layout in the blob and have no form defaults, so an empty
  accept approves nothing. Look-alike detection stops a forwarded question from mimicking an
  approval form. `upstream_input` blobs keep the expiry of the blob they continue (#67, D27).
- Credentials of URL sources are redacted from errors, results, the catalog and instructions (#65).

### Dependencies

- `@modelcontextprotocol/client` and `@modelcontextprotocol/server` 2.3.1 to 2.4.0 (exact pins),
  and `zod` ^4.6.7 (#62).
- New optional dependency `@napi-rs/keyring` 2.1.2 (#65).

## [0.8.0] - 2026-10-10

Search, approval copy and robustness fixes found by the first live tool-choice eval (#38–#56).

### Breaking

Public API signatures, from a diff of the 0.7.0 and 0.8.0 `dist/index.d.mts`, are additive only:
`DescribeToolArgs.types?`, `ProjectionFacade.describeTool({ name, types? })` and
`generateToolTypes(catalog, options?)`. Behaviour that changes for existing callers:

- `describe_tool` omits TypeScript types by default. Pass `types: true` to get them (#39).
- A server that declares more than 2000 tools fails to wrap. A `tools/list` cursor that repeats, or
  that still returns `nextCursor` after 100 pages, fails with a `protocol` error (#51).
- A second copy of `@modelcontextprotocol/server` in the install fails with an error naming the
  pinned version (#51).
- Through SDK 2.3.1, `createMcpHandler` answers request bodies over 4 MiB with 413 (raise the limit
  with `maxRequestBodySize`), and `StreamableHTTPClientTransport` defaults to
  `redirectPolicy: 'same-origin'` (#51).
- The `caps.wasmMemoryBytes` floor rose from 1 MB to 16 MB. A smaller configured value is clamped up
  without error (#56, D14).

### Added

- `call_tool` and `describe_tool` answer an unknown tool name with a "Did you mean" hint listing the
  closest tools (#48).

### Changed

- `search_tools` matches tokens across the tool name, annotation title and description, and ranks
  the hits (#40, D10).
- Approval prompts use one warning glyph, put the method or action enum value in the title, end
  with a `Tool: <name>` footer (#39).
- `call_tool` prints a string result as raw text under a one-line head, and an object
  pretty-printed (#39).
- The `discover_apis` overview uses the same purpose sentence as `search_tools` (#38).
- Output-schema validation uses the tool recorded at introspection, so it still holds after
  `notifications/tools/list_changed` (#51).

### Security

- A tool that policy has switched to `deny` is refused on resume even when an earlier approval
  exists, in machines as well as `call_tool`. A pending blob naming a tool the catalog does not
  declare fails closed (#38).

- The sandbox memory cap bounds real bytes: each session runs on its own QuickJS WASM instance whose
  `WebAssembly.Memory` maximum is the cap, and the cap's floor is 16 MB (#55, #56, D14, D15).

### Dependencies

- `@modelcontextprotocol/client` and `@modelcontextprotocol/server` 2.0.0 to 2.3.1 (exact pins),
  and `zod` ^4.6.5 (#51).
- New dependency `quickjs-emscripten-core` 0.32.0 (#56).

## [0.7.0] - 2026-10-09

The catalog projection: `search_tools`, `describe_tool` and `call_tool` alongside code mode
(#34–#37).

### Breaking

From a diff of the 0.6.0 and 0.7.0 `dist/index.d.mts`:

- `BlobPayload` has a required `kind: BlobKind` (`'machine' | 'call'`) (#36).
- `ErrorPhase` adds `'upstream'` (#36). Exhaustive switches need a new case.
- `ProjectionFacade` gains required `searchTools`, `describeTool`, `callTool` and `projections`
  members (#35, #36).
- `GeneratedToolTypes` has a required `toolTypes` map (#35); code that builds one must add it.
- `ExecuteMachineDeps` now extends `ApprovalGateDeps`. Its fields are unchanged apart from the new
  optional `replayCache` (#36).

Behaviour that changes for existing callers:

- The catalog projection is on by default, so a facade serves five tools instead of two, and its
  instructions use the routing preamble. Set `projections: { catalog: false }` to keep the code
  mode surface only (#36).

### Added

- `search_tools`, `describe_tool` and `call_tool`. `call_tool` runs one tool under the same
  approval gate as a machine step and seals a `call` blob with a shorter default TTL,
  `blob.callTtlMs` (5 minutes) (#35, #36).
- `WrapOptions.projections` (`{ codeMode?, catalog? }`). Turning both off is a wrap-time error
  (#35).
- `WrapOptions.replayCache`, an optional replay store for both blob kinds (#36, R38).
- `WrapOptions.catalogInlineThreshold` (default 40). Above it, `discover_apis` replaces the
  per-tool list with a tool count. It applies only when the catalog projection is on (#37, R37).
- Exports for the catalog surface, including `searchTools`, `describeTool`, `callTool`,
  `summarizeTool`, `sanitizeSchema`, `validateArgsShape` and their option and result types (#35,
  #36).
- New optional parameters: `buildInstructions(…, projections?)`, `discoverApis(…, options?)`,
  `OpenBlobOptions.expectedKind` and `ElicitationCopyOptions.origin` (#35, #36).

### Security

- Approval copy caps each string argument at 512 characters inline and names the arguments that
  were cut off. The redaction hook receives a clone of the arguments. `call_tool` applies
  `caps.maxResultBytes` to results (#36).

## [0.6.0] - 2026-09-15

### Breaking

From a diff of the 0.5.1 and 0.6.0 `dist/index.d.mts`, additive only:
`ProjectionFacade.executeMachine(args, era?, clientCanElicit?)` and
`ExecuteMachineDeps.clientCanElicit?` (#31). Behaviour that changes for existing callers:

- `/visualize-workflow` is outcome-first: it describes what the workflow did for the person, not
  the approval trail and logs (#32).

### Changed

- Approval prompts lead with a plain-language action title and a one-line purpose quoted from the
  server, and move the tool id and requesting step to a compact footer (#30).
- With `compat.legacyElicitation`, a legacy client that never declared the elicitation capability
  gets Projection's structured `protocol` error at suspend time (#31).
- `discover_apis` examples and the authoring contract no longer hard-code `/notes.txt`. Contract
  rule 8 states what `TOOL_RESULT.result` holds (#31).

### Fixed

- An XState error snapshot during validation is reported as `machine_init_threw` instead of
  `context_not_serializable` (#31).

## [0.5.1] - 2026-09-12

Hardening only. The public API is unchanged.

### Security

- The wrapped server's identity, which is untrusted (S5), is rendered inert in the `discover_apis`
  overview, the typegen overview header and the `tools.d.ts` resource description. U+2028, U+2029
  and U+061C are neutralized too, and tool names in the overview are neutralized and capped (#28).

[Unreleased]: https://github.com/astralMCP/projection/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/astralMCP/projection/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/astralMCP/projection/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/astralMCP/projection/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/astralMCP/projection/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/astralMCP/projection/compare/v0.5.0...v0.5.1
