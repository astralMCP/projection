# Engineering decisions

## D1 — Use the SDK's MRTR types; keep our own AEAD requestState sealer (2026-08-08)

The PRD targets MCP 2026-07-28 MRTR (SEP-2322): `tools/call` may return
`resultType: "input_required"` with an `inputRequests` map and an opaque
`requestState`; the client retries the original call with `inputResponses`
plus the echoed state.

**Types.** `@modelcontextprotocol/server@2.x` ships the full MRTR surface as
stable (`InputRequiredResult`, `inputRequired()`, `inputResponse()`,
`ProtocolEra`, …). We adopt it (exact pins: `server` and `client` 2.0.0;
`zod ^4.2.0`) rather than hand-roll a parallel definition of a stable wire
format. `src/mrtr/protocol.ts` re-exports the SDK types and keeps only what
the SDK lacks: `APPROVAL_SCHEMA`, `MRTR_PROTOCOL_REVISION`, `supportsMrtr`.

**Sealer stays.** The SDK's `createRequestStateCodec` is signed, not
encrypted. R19 requires encryption because machine context may hold data
from read-only calls that would otherwise never reach the client. So
`src/blob/` stays: AES-256-GCM under a per-blob HKDF key, plus the fields
MRTR does not model (`codeHash` S4, `serverIdentity` R30, `pending` S2,
`trip` R18) and key rotation (R22). The SDK's `bind` concept is the model
for principal binding (PRD §12.4).

**Era is instance state.** SDK 2.x models the protocol era per serving instance:
`createMcpHandler`/`serveStdio` call a server factory with
`McpRequestContext.era`. So the facade's primary shape is
`facade.serverFactory`; `createServer(ctx)` closes over the era;
`supportsMrtr(era)` is `era === 'modern'`; a hand-built `McpServer` is
legacy by construction (`registerOn` defaults to legacy — fail-safe).
`Server` accepts `instructions` only in its constructor, so `createServer`
also delivers the R29 preamble.

**R28.** A modern client suspends; a legacy client gets the fail-fast
`protocol` error. SDK 2.x would otherwise fulfil `input_required` on a legacy
connection through its own elicitation shim; we refuse by default because
the shim holds the connection open (R27). D6 makes it opt-in.

**Forced behaviour changes.** (1) 2026-07-28 elicitation params have no
`title`; `ElicitationCopy.title` becomes the first line of the message.
(2) An `InputRequiredResult` carries only `resultType`, `inputRequests`,
`requestState` — the encode seam strips `content` and `_meta`. R31's logs
therefore cannot ride a suspension; they ship with every completion,
`isError` result and resumed segment. They are not smuggled into the prompt
(S6: copy is server-derived, logs are model-authored). Locked by
`test/mrtr/e2e.test.ts`.

**Testing.** The SDK has no in-memory serving entry for the modern era.
`test/integration/code-mode-server.test.ts` drives a real `Client` against
`createMcpHandler(facade.serverFactory)` over a
`StreamableHTTPClientTransport` whose `fetch` is the handler itself.

## D2 — Toolchain (2026-08-08)

pnpm workspaces + Turborepo; tsdown (rolldown) build, ESM-only, `.d.mts`
declarations; oxlint (correctness=error) + prettier; vitest; strict TS with
`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. XState pinned
exactly at 5.32.5, `@sebastianwessel/quickjs` at 3.1.0 and
`@jitl/quickjs-ng-wasmfile-release-sync` at 0.32.0 per PRD §7 dependency
notes.

**Addendum (2026-10-31), after 0.9.0.** oxfmt replaces prettier, so lint
and format are both on the oxc stack. `.oxfmtrc.json` keeps the prettier
options (width 100, single quotes, trailing commas, semicolons) and carries
the old `.prettierignore` lines as `ignorePatterns`; oxfmt also honours
`.gitignore`. Format-suppression comments are `// oxfmt-ignore`.

## D3 — Parallel-agent conventions (2026-08-08)

Component code lives under `src/<component>/` with a local `index.ts`.
`src/types.ts` is the shared contract; top-level exports are wired through
`src/index.ts` deliberately, not by component code.

## D4 — In-TTL replay is an MRTR-adapter obligation (2026-08-08)

The blob sealer is stateless (R27/N4): the same sealed blob opens any number
of times within its TTL, and the authenticated `trip` counter cannot advance
under replay. Security review conclusion: a client replaying a captured
approved retry re-executes the gated call once per replay. Without
server-side state this cannot be prevented, so it is a documented limitation
of the stateless default (`harness/test/replay.test.ts` pins it).
Deployments that need hard replay prevention supply
`WrapOptions.replayCache` (R38, D9): a shared atomic test-and-set on the blob
nonce, consulted after R21 verification and before any gated call executes.
A machine workflow also moves forward on approval (fresh blob, nonce,
incremented trip); a `call_tool` approval has no forward step, hence its
shorter TTL (D9).

## D5 — MCP Apps attach to completed results, not suspensions (2026-09-04)

PRD §12.1 fences two Apps use cases: approval previews (priority) and
result dashboards. The wire decides for us, for now: the 2026-07-28
`InputRequiredResult` encode seam strips `content` AND `_meta` (verified in
D1), so a suspension cannot carry an app reference, and the elicitation
params have no vehicle for one either. Approval previews therefore need a
spec extension before they are implementable. What ships: a static,
library-authored workflow dashboard (`ui://projection/dashboard.html`,
`text/html;profile=mcp-app`, declared via `execute_machine`'s
`_meta.ui.resourceUri` per SEP-1865) rendering output, audit trail, logs
and structured errors. The §12.1 security constraint is satisfied by
construction: the app is a compile-time constant with zero model-authored
code (no VM at all), requests no host capabilities, and renders all
model-controlled data via `textContent` only — locked by tests. The
`discover_apis` resource links exclude `ui://` so models never see the app
surface (the harness's `buildApiDocs` authoring docs filter `ui://`
resources too). The demo host (`apps/demo-host`) renders the dashboard in a
sandboxed iframe against the filesystem server.

## D6 — Opt-in legacy elicitation via the SDK shim (2026-09-12)

R28's fail-fast on legacy connections was chosen because the SDK's
server→client elicitation shim holds the `tools/call` open, suspending the
statelessness (R27) MRTR buys. But as of this decision, popular clients had
not adopted 2026-07-28, and the cost analysis is transport-dependent: over
stdio — how those clients actually run servers — the connection is held by
nature and there is no statelessness to lose.

Decision: `compat.legacyElicitation` opts in per facade; default stays
fail-fast. Verified empirically before building: on a held legacy
connection the SDK converts a returned `input_required` into old-style
`elicitation/create` pushes and re-invokes the handler with a byte-exact
`requestState` echo plus the collected `inputResponses` — the same retry
envelope as a real MRTR retry — so blob sealing/verification (S2–S4), the
audit trail, trip counting, and R17's missing-answer-is-decline all run
unchanged. Only the transport of the question differs. `createServer` sets
the SDK's `inputRequired.maxRounds` to the clamped `maxRoundTrips` cap, so
the shim's round limit and R18's trip cap agree.

Limitation, locked by test: per-request legacy HTTP serving
(`createMcpHandler`'s stateless legacy mode) has no server→client channel;
the SDK refuses with a named error and nothing executes (S2 holds). The
opt-in is therefore effective for stdio/held-connection deployments only.
The client must also declare the `elicitation` capability (form mode);
otherwise gated calls get Projection's structured `protocol` error at
suspend time, while read-only machines still run.

## D7 — Wrapped-tool elicitations fail closed; forwarding is MRTR-only if ever (2026-09-12)

What happens when a WRAPPED tool raises its own elicitation mid-call?
Verified empirically: the introspector's client declares no `elicitation`
capability, so the upstream's request is refused with a named error and the
machine receives an ordinary `TOOL_ERROR` event it can handle — fail
closed, no hang, no silent approval surface. Through `call_tool` the same
failure is an `upstream`-phase error (R25), not a `TOOL_ERROR` event.
Caveat: this guarantee covers introspector-OWNED clients (in-process wraps);
a caller-provided connected `Client` answers upstream elicitations with
whatever handlers the integrator registered on it — that is the integrator's
choice.

Decision: keep fail-closed as the posture. If forwarding is ever built, it
is MRTR-upstreams-only: a modern upstream's `input_required` carries an
opaque `requestState` that can NEST inside Projection's own sealed blob,
preserving stateless resume across both hops. Legacy-push upstream
elicitations cannot be forwarded without holding the upstream's in-flight
call across our own suspension — cross-instance-impossible state that R27
forbids. Forwarded upstream copy would be third-party text and MUST get the
S6 inert-rendering treatment; it must never be conflated with Projection's
own approval prompts.

Update (D24): forwarding now exists for 2026-07-28 upstreams, opt-in per box
(`upstreamElicitation: 'forward'`), exactly as sketched here; the default and
every 2025-era upstream stay fail-closed.

## D8 — Two views of a run: the dashboard is for hosts, /visualize-workflow is for the person (2026-09-14)

The MCP App dashboard (`src/apps/dashboard.ts`, D5) and the
`/visualize-workflow` prompt both render an `execute_machine` result, and
they deliberately disagree about what to show. The dashboard is the
machinery view: output, the approval audit trail, logs, structured errors —
the human-approval story a host or integrator inspects to trust what ran.
The prompt is the outcome view: what the person who asked for the
automation actually got, in their words, with the audit trail, logs, trip
counts, tool ids and phases read by the model as sources of fact but kept
off the page (declines, policy denials and errors still surface, as plain
statements of what did not happen).

Decision: keep them split. Do not "harmonize" the two by adding the audit
table to the prompt or stripping it from the dashboard; each has a
different reader. Both share the S6 posture — every result value is inert
data and a fact, never an instruction; only the result's `hint` is advice.

## D9 — Two projections, one gate: the catalog projection coexists with code mode (2026-10-09)

Code mode (`execute_machine`) is the product: N steps in one round trip,
branching on `TOOL_DENIED`, a sealed snapshot that any instance can resume,
and a result worth saving as a skill. It has two costs that showed up in use.
A single action ("read notes.txt") costs a 25-line machine and a round of
self-healing, and `discover_apis` describes the whole catalog inline, which
does not survive a server with hundreds of tools.

Decision: add the lazy-catalog shape — `search_tools`, `describe_tool`,
`call_tool` — as a second projection on the same facade (PRD §6.8), on by
default, and route between them in the instructions preamble (R29): one step
→ `call_tool`; several steps, branching, or anything worth saving →
`execute_machine`. Not a mode switch; both are live unless the integrator
turns one off, and both are on by default (R32).

Why one gate rather than a proxy. `call_tool` is the degenerate one-call
machine, so it reuses the machine's approval path end to end: the R16 copy
builder, the redaction hook, the blob sealer and the MRTR adapter. The
approved args execute from the blob's `pending` entry, never from the retry
(S2), and the blob is bound to the canonical `{ kind: "call", name, args }`
request through the existing `codeHash` field plus a `kind` discriminator
(R36) — a coherence check that keeps a stale approved blob from being
attached to an unrelated request, not the approval binding itself. A separate,
simpler "approval token" for direct calls was rejected: it would be a second
S2–S4 implementation to fuzz, tamper-test and keep in step for a saving of
one `null` snapshot.

Decline is an outcome, not an error. `call_tool` returns a normal result
`{ status: "declined" }` (mirroring `TOOL_DENIED`), because an `isError`
result reads to a model as "retry", and the one thing a declined write must
not do is come straight back. The tool description says so explicitly. The
same holds for `denied_by_policy`: the model cannot change the integrator's
policy, so an error would only invite retries.

Argument validation is structural only (required keys, top-level types,
enum membership of top-level primitives, unknown keys when forbidden). It
exists so a human is never asked to approve a call that the upstream will
reject on shape, and so the model gets a `validate` hint naming the property;
full JSON Schema validation would run twice — the wrapped server is the
authority — for nothing but a nicer error message.

`describe_tool` is the injection surface of this projection — it hands the
wrapped server's own words to the model, and not only in the description:
`inputSchema` and `outputSchema` carry server-controlled free text too.
Both get the S5 treatment `discover_apis` gets: description neutralized and
capped, schemas rendered through a key allowlist (R34 lists the keys) with
every string neutralized and the rendering capped per tool, annotations
presented as hints, identity inert. Typegen's `docComment` applies the same
neutralization, so the `.d.ts` resource and the `describe_tool` slice of it
are clean too.

`call_tool` also changes the S5 effort calculus. A mislabelled
`readOnlyHint: true` tool used to be a machine away; now it is one model call
away. The mitigation is unchanged — the R14 override forces such tools to
`ask`, and the §13 SQLite case (`mcp-sqlite`) exercises exactly this — but the catalog
projection turns it from a setting an integrator could defer into one they
should set before enabling the projection on a server they do not control.

Policy outranks a stale approval. A `deny` configured after a `call` blob was
minted wins on the retry: `call_tool` decides policy on the retried name
before it opens the blob, so nothing executes and no replay nonce is spent.
The machine host's `applyVerdicts` applies the same rule: a pending call
whose tool is `deny` at resume time is `TOOL_DENIED` with the policy reason,
whatever the verdict says (here the blob is opened first — the machine has to
continue with `TOOL_DENIED` — so the replay nonce is spent; the conservative
side).

`call_tool` makes the D4 window more consequential: an approved `call` blob
has no forward step, so a captured approved retry is a standing write
capability until `exp` — hence the shorter `call` TTL and the replay-cache
hook, both specified in R38.

## D10 — `search_tools` matches tokens and ranks; no regex, no fuzzy, no synonyms (2026-10-10)

The first `search_tools` was `grep -iF`: the whole query as a case-insensitive
substring of the name or description, catalog order, no ranking. Measured
on the 95-tool remote GitHub MCP catalog with 45 hand-labelled queries of
the kind a model types before it has seen the catalog (snake_case guesses
such as `create_issue`, intents such as `comment on a pull request`, single
keywords; ad hoc eval, not committed), it returned nothing for 29 of them:
hit@1 31%, hit@5 33%. Each miss costs the model a round trip and usually a
two-page browse of the whole catalog.

Decision: token match with additive ranking, exactly as R33 specifies. The
title counts like the description rather than like the name: it catches
words the description lacks (`issue_write`'s title says "Create"), but a
tool whose title merely mentions "pull request" must not tie the
`*pull_request*` tools for that query — which it did when titles were
weighted like names. Same eval,
final algorithm: hit@1 76% (34 of 45), hit@5 89%, on the first page 98%,
one miss (`who am I`), and no regression — every match set is a superset
of the substring matcher's and ranking never pushed a target off the page.
Filesystem catalog: misses 5 of 10 → 1 (`mkdir`). The title term's one
measured cost: `get_user` drops from #1 to #2 — `get_copilot_space`'s title
supplies the `get` its description lacks, it ties `get_me` at 4, and catalog
order breaks the tie.

S5: a hostile title stuffed with query words scores +1 per token, exactly
what a stuffed description already scored, and per token can never outweigh
a name hit (+2); the posture column is computed from policy, not from
catalog text. The title term adds no exposure beyond what description
stuffing already had.

Rejected, with the numbers: requiring ALL tokens (hit@1 67%, 12 misses —
filler words and inflection kill it); ALL-then-ANY fallback (shorter pages,
median 4 vs 22, but two confidently wrong short lists, a worse failure than
a long page); name-first ranking (identical ordering on every query — the
2× weight already does it); trailing-`s` stemming (net negative on ties);
regex from the query (a hostile description plus a model-authored pattern
is a ReDoS surface, and models predict a word better than a pattern).

Known cost: filler words match most descriptions, so a natural-language
query can return a full page with the answer at #1, and an unanswerable
query (`who am I`) returns wrong rows instead of none. Still missed: queries
that need synonyms (`mkdir` → `create_directory`); that is a vocabulary
problem, not a matching one, and not worth a thesaurus. CJK runs are one
token (no segmentation): a query of several ideographs matches only as that
exact run.

**Addendum (2026-10-10): the same ranking powers the unknown-name hint.** When `call_tool` or `describe_tool` is given a name the catalog does not declare, the hint names the top three tools that `search_tools` would rank for the name's tokens (`create_issue` → `issue_write`, …) before pointing at `search_tools` — keeping only tools a token hit by _name_: a description-only match (`directory` → `list_dir`) is a search result, not a near miss, and without that filter a stopword or one-letter name would always produce three suggestions. The name is cut at the R33 query cap before ranking, so a long guessed name costs what a `search_tools` query costs. The tool-choice eval (Haiku 4.5 through Projection, 94% vs 100% direct) showed the dominant failure was a guessed name costing a `search_tools` → `describe_tool` → `call_tool` detour; this folds the first hop into the error. No new matching logic: same tokens, same scores, same S5 treatment of every name shown.

## D11 — The eval turn budget counts action turns; Projection discovery is free up to a 2× ceiling (2026-10-10)

The tool-choice eval (`packages/harness/src/eval/`) runs the same task in
both modes under one cap on Messages API calls. On the filesystem tier that
cap bit Projection and not direct mode: `search_tools` returns only the
first sentence of each description, so a parameter such as `head` is visible
only after `describe_tool`, and a model that reads carefully spent most of a
12-turn cap on `search_tools` / `describe_tool` before it made its first
real call. Direct mode never pays that: its tool list, schemas included, is
in the prompt.

Decision: the cap is a budget of _action_ turns. In the agent loop a turn is
free only when it stopped for `tool_use`, called at least one tool, and
every tool it called is on the mode's free list — Projection's discovery
surface (`search_tools`, `describe_tool`, `discover_apis`); direct mode's
list is empty. An absolute ceiling of twice the budget bounds every call,
free or not. Both modes get the same budget and the same ceiling; records
carry `budgetTurns` beside `apiTurns`, the report has a `budget` column, and
the results file records `maxTurns` and `maxTotalTurns`.

Rationale. Direct mode's tool list _is_ the discovery result, delivered
for free; charging Projection a turn for reading the same information would
measure prompt size, not tool choice, which is what the eval is for. The
cost of discovery is not hidden: every call still shows in `turns`,
`in-tok`, `out-tok` and `$`, and each extra turn resends the growing
context (softened by cache reads). Free is by tool name, not outcome: a
failed `call_tool` — unknown name, bad arguments — counts exactly like a
direct-mode call with bad arguments, because that is the tool-choice error
the eval exists to catch; a failed `describe_tool` or endless `search_tools`
paging does not count and is bounded only by the ceiling. An empty
`tool_use` turn, a refusal, `max_tokens` or a null stop reason all count,
so with no free tools `budgetTurns === apiTurns` on every record. The
ceiling bounds calls, not tokens, and is never below the budget (a lower
ceiling would make the budget unreachable).

Alternatives rejected: a larger cap for Projection only — a thumb on the
scale, and a number to argue about per tier; a cap on upstream calls
instead of API turns — a model that loops on discovery makes no upstream
calls and never ends; charging discovery at a fraction of a turn — a
weight with no principled value, and a column nobody can read at a glance.

## D12 — Dependency updates: what moves, what holds, and why (2026-10-10)

The pre-0.8.0 dependency pass settled these rules:

- **TypeScript stays on 5.x.** `typescript` is a runtime dependency: the
  sandbox transpiles authored machines with `ts.transpile` (R10). TypeScript
  7 (the native compiler) ships `tsc` and `unstable/*` APIs only and drops
  `ts.transpile`; `src/sandbox/session.ts` already fails closed on such an
  install. Nothing in the workspace moves to 7 until the transpile path has
  a TS 7 story.
- **Fresh releases wait out the pnpm release-age gate.**
  `@modelcontextprotocol/server-filesystem` resumed semver at 1.0.0 (the
  date-based 2026.x line is deprecated with a pointer to it). 1.0.0 passes
  the filesystem suites apart from its self-reported identity string, but
  was published hours before this pass and pnpm rejected it. The gate is
  pnpm 11's built-in `minimumReleaseAge` default (24 hours); the workspace
  does not configure it. pnpm offered to add a `minimumReleaseAgeExclude`
  entry and we declined: we do not take releases early, and the bump lands
  once the gate clears.
- **The pack-install smoke installs the SDK version Projection pins.**
  Projection pins `@modelcontextprotocol/{client,server}` exactly; a
  consumer that installs a different SDK version gets a second copy whose
  `McpServer` fails the introspector's `instanceof` check (the smoke
  reproduced this with a hard-coded 2.0.0). The test now reads the pin from
  the manifest. Such an `McpServer` used to fall through to the `Client`
  path and fail with an unrelated error; the introspector now recognises
  the shape (a `server` property and `connect`/`registerTool`, no
  `listTools`) and fails with a `protocol` error naming the pinned version.
  It still refuses the instance rather than accepting it by shape. Whether
  the SDK should become a peer dependency is open for a later release.
- **Projection pages `tools/list` itself; the bounds are its own.** Since
  SDK 2.0.0, `Client.listTools()` called without a cursor follows
  `nextCursor` to the end before returning (capped by the client option
  `listMaxPages`, default 64, `0` = unbounded). The pre-0.8.0 introspector
  passed no cursor on its first call, so it always received the whole
  aggregate in one result: its in-loop 100-page and 2000-tool checks never
  fired, and the only real bound was whatever `listMaxPages` the `Client`
  carried. 0.8.0 pages explicitly: page 1 through `client.request` (the SDK
  validates it against its `ListToolsResult` schema, as `listTools()` does
  internally) and later pages through `listTools({ cursor })`, which fetches
  exactly one page and is never capped by the SDK. The introspector stops as
  soon as the running total exceeds 2000 tools, when a 100th page still
  returns `nextCursor`, or when a cursor repeats, each a `protocol` error.
  The bounds no longer depend on the caller's `Client` options. Explicit
  paging skips the SDK's `tools/list` cache, which `callTool` used for
  output-schema validation (and which a `notifications/tools/list_changed`
  clears), so every call now passes the `Tool` recorded at introspection
  as `toolDefinition`. User-visible: a server that returns more than 2000
  tools, even on a single page, now fails to wrap; a cursor that repeats
  now fails instead of ending the walk quietly. One gap remains: the SDK's
  SEP-2243 exclusion of tools with invalid `x-mcp-header` declarations runs
  inside `listTools()`, so it applies to pages 2 onward but not to page 1;
  such a tool's calls are sent without mirrored headers.
- **vitest 5 turns `clearMocks` on by default.** Mock call history resets
  between tests. The repo does not rely on it either way: the only mock is
  a `vi.mock` module factory, and there are no `vi.fn` spies.
- **Turbo's agent guidance is off.** turbo ≥ 2.11 writes an `AGENTS.md`
  block on agent-driven runs; `CLAUDE.md` and the skills are this repo's
  agent instructions, so `turbo.json` sets `"agentGuidance": false`.

**Addendum (2026-10-29), the post-0.8.0 pass.** Moved: the MCP SDK
(`client`/`server`) 2.3.1 → 2.4.0, `server-filesystem` 2026.7.10 → 1.0.0,
`mongodb` 7.5.0 → 7.7.0, the vendored `mongodb-mcp-server` 3.0.5 → 3.2.1,
`@anthropic-ai/sdk` 0.133.0 → 1.3.0 (harness), and patch/minor tooling
(vitest, zod, prettier, turbo, oxlint, tsdown, react). Held, as before:
`xstate` (blob stamp), `typescript` (7 drops `ts.transpile`), `@types/node`
(22.x, the lowest supported Node), `server-github` (live smoke).

- **The release-age rule covers the npm-installed vendor tree too.** pnpm's
  gate does not reach `vendor/mongodb-mcp-server`, which npm installs.
  `mongodb-mcp-server` 3.2.2 was nine hours old, so the pin is 3.2.1, and
  the lockfile was generated with `npm install --before` set 24 hours back,
  which applies the same cutoff to every transitive package. 3.2.2 passes
  the MongoDB suites and can follow once it is a day old. 3.0.5 → 3.2.1
  leaves the 21-tool surface unchanged (names, schemas, annotations and
  descriptions). Since 3.1.0 the server rejects unrecognised tool arguments
  and asks for confirmation before aggregation write stages; Projection's
  upstream client advertises no elicitation, so that prompt never fires.
- **The vendor directory is no longer needed for the SDK.** Its packages
  require `@modelcontextprotocol/server` `^2.3.1` and
  `@modelcontextprotocol/node` 2.1.2 requires `^2.4.0`. The workspace pin
  satisfies both now, so the server could move into the pnpm workspace. The
  vendor directory stays for now; removing it is a separate change.
- **`server-filesystem` 1.0.0 reports its package version.** The tool
  surface (14 tools, annotations) is unchanged; `serverInfo.version` is now
  the package version (`0.2.0` throughout the date line), so the recorded
  identity is `secure-filesystem-server@1.0.0`, and blobs bound to the old
  identity no longer open against it. 2.x exists and is not evaluated here.
- **MCP SDK 2.4.0 does not change what Projection uses.** A diff of the
  shipped `dist` shows no change to `listTools`/`callTool`/`request`, the
  `listMaxPages` page walk (refactored into `_walkPages` for the new
  `SkillsClient`, same body), elicitation (form and URL mode),
  `UrlElicitationRequiredError`, the transports' request-size handling, or
  `InMemoryTransport`. New: the Skills extension (SEP-2640, `ext/skills`
  subpaths, root exports unchanged). OAuth client: only an opt-in
  `OAuthClientProvider.scopeForRefresh(tokens)` and a `scope` option on
  `refreshAuthorization()` (Entra ID rejects a refresh without `scope`);
  there is still no device-authorization grant. Behaviour changes that
  could reach a wrapped upstream: an `outputSchema` whose root `$ref`s an
  object in its own `$defs` is no longer wrapped in `{ result }` on
  2025-era connections; the bundled Ajv rejects a `$id`/`$ref` with an
  invalid URI scheme (`my_tool:output`). SDK 2.4.0 removed `number` from
  the allowed `x-mcp-header` parameter types; the 2.4.0 client then drops
  such a tool from `listTools` with only a `console.warn` on modern-era
  connections over any transport except stdio (in-process
  `InMemoryTransport` included), and `createMcpHandler` rejects a
  `tools/call` whose headers mismatch (-32020) for `number` declarations
  too. Consequence: a wrapped in-process or HTTP upstream with a header on
  a `number` parameter silently disappears from Projection's catalog; stdio
  upstreams are unaffected. No fixture or eval world uses `x-mcp-header`.
- **`@anthropic-ai/sdk` 1.x sends `anthropic-version: 2026-10-21`.** That
  API version rejects `temperature`/`top_p`/`top_k`, `document` blocks in
  assistant turns and `citations` on user text, and renames Admin API
  fields; the harness sends none of them. The client now sends the API key
  as `Authorization: Bearer` rather than `X-Api-Key`, which matters only
  behind a proxy that reads the old header. The SDK creates OpenTelemetry
  spans if a global tracer provider is registered (the harness registers
  none).
- With both `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` set, a 1.x client
  uses the API key (and warns once); an `ANTHROPIC_PROFILE` naming a missing
  profile throws on the first request. The live eval relies on the API key.

## D13 — Saved eval runs are re-scored offline; world-reading verifies keep their verdict (2026-10-10)

Grader fixes are applied to saved results with `rescoreRecords` (script:
`pnpm --filter @astral-mcp/harness run rescore <results.json>`) instead of
a new paid run. A record keeps the upstream calls and the final text, so
`expect`, `forbid`, the step groups and any verify that reads only the
answer are re-run exactly. A verify that reads the live world (files on
disk, documents in the deployment) is marked `needsWorld` on its task and
cannot be re-run: the recorded verdict stands while `expect` and `forbid`
still pass, and is downgraded when they do not. Such an episode can never
be upgraded offline — upgrading would assert an end state nobody checked.
A test keeps the flag honest: every `needsWorld` verify throws on facts
whose every read throws, and every other verify answers from the calls and
text alone — the re-scorer hands non-`needsWorld` verifies the same
throwing facts and reports any throw instead of keeping the old verdict.

Alternatives rejected: replaying the recorded calls against a fresh world
to re-run world verifies — the replay would not reproduce the model's
reactions to errors, and a mongod/filesystem per record makes a quick
re-score slow; treating world verifies as passing — silently inflates the
success rate.

## D14 — The memory-cap tests assert a per-request bound; the byte bound is a follow-up (2026-10-10)

In the emscripten QuickJS build, the `memoryLimit` check is
`accounted + request > limit`, but a live allocation is accounted only as
~8 bytes of bookkeeping (`malloc_usable_size` is 0), not its payload. So
`wasmMemoryBytes` bounds the size of a single allocation request, not total
sandbox memory: any number of sub-cap allocations adds up to WASM linear
memory (~2 GB) at any cap setting, and ends in the same out-of-memory
error. A test that hoards small allocations therefore cannot tell a working
cap from a missing one. The memory-cap tests in
`test/sandbox/caps.test.ts` instead assert (1) that one request above the
cap and below the 256 MB hard max is refused, and (2) that a doubling
sequence stops at an iteration count only the configured cap explains
(logged from inside the VM, so it is independent of machine load). Both
fail if the limit is deleted or hardcoded high.

Enforcing the documented byte bound on total memory is a tracked
follow-up; meanwhile `docs/server-authors.md` carries a caveat under the
caps table. `docs/PRD.md` R12 is unchanged and states the intended bound.

Alternatives rejected: keeping a hoard test with a wall-clock bound — it
passes with no limit at all and races the segment budget under CI load;
asserting the cap value in the error message — the message is formatted
from `caps.wasmMemoryBytes` on the host side, not reported by QuickJS.

## D15 — The memory cap is the WebAssembly memory's `maximum`; one module instance per session (2026-10-10)

This closes the follow-up D14 left open. `wasmMemoryBytes` (R12) used to be
passed to QuickJS's `setMemoryLimit` and nothing else. That limit never bounded real bytes: QuickJS charges each
allocation `malloc_usable_size + overhead`, and the emscripten build returns
0 for `malloc_usable_size`, so the running total counted bookkeeping only.
Only a single request larger than the cap was refused. Measured in this
repo: a loop pushing `'x'.repeat(4096)` under an 8 MB cap ran ~466k
iterations (~2 GB of linear memory, 6-7 s) before "out of memory", the same
count under 64 MB, and a loop of `new Uint8Array(1 << 20)` reached 2 GB in
2041 iterations. A hostile or sloppy machine could grow the host process by
~2 GB per sandbox, and WebAssembly memories never shrink.

The fix: every session runs on its own QuickJS WASM module instance
(`newVariant(variant, { wasmMemory, wasmModule })`) with a
`WebAssembly.Memory` whose `maximum` is the cap in pages. The binary is
compiled once per process and shared (`wasmModule`); where it cannot be
located the glue's loader is the fallback. Instances are pooled: after a
session ends, an instance whose heap is still at its 16 MB initial size is
kept (up to eight, keyed by `maximum`) for the next session with the same
cap, and an instance that grew is dropped so its memory is reclaimed.
Reusing a disposed-runtime instance in sequence is what the old shared
singleton did for every session; the pool keeps that cost profile while
giving each instance its own bound. The engine enforces `maximum` on every
`grow`; the emscripten glue catches the failed grow, `malloc` returns NULL,
QuickJS throws its ordinary "out of memory" InternalError, and the session
reports the memory `cap_exceeded`. All hoard shapes — small strings, 1 MB
typed arrays, a doubling array — now fail in under 100 ms with the heap at
most the cap, the VM survives the failure, a neighbouring session is
untouched, and disposing the session releases the whole heap. The
emscripten glue grows the heap in steps (the larger of the request and
~5-20% of the current size), so near the cap a request that would fit can
be refused, leaving up to a few percent of the cap unusable. QuickJS's own
`memoryLimit` is still set; it is cheap and refuses a single oversize
request before the heap has to grow, and D14's per-request tests remain
alongside the hoard tests this change adds. The caveat D14 placed under the
caps table in `server-authors.md` is removed.

Consequences: the floor rises from 1 MB to 16 MB, the module's
`INITIAL_MEMORY`, because an imported memory cannot be smaller than the
import declares — a lower cap would be a promise the engine cannot keep.
The cap is per session, so concurrency multiplies it (documented in
`server-authors.md`); 20 idle sessions cost ~29 MB of RSS, since the
memory's pages are committed only when touched. Cost, measured on the §10
resume leg: solo, p95 12.5 ms / median 11.3 ms against 12-14 / 11-12 on
main; under the package's parallel test load, alternating runs gave p95
35-47 ms / median 18-21 ms against 35-40 / 20-29 on main. Without the pool
the loaded figures were p95 61-65 / median 38-42 — instantiating per
session doubled the leg under contention and would have turned the known
p95 flake into a regular CI failure. (Under the full `pnpm run check` load
on the development machine both main and this change exceed the 100 ms
p95; that is the flake the contributing skill documents.) An instance is
reused only after its run promise settled cleanly and every evaluate of its
session, the boot evaluates included, returned ok; any failure drops it
(re-instantiation costs ~3-5 ms, and at the 16 MB floor `maximum` equals
`initial`, so an exhausted heap does not show in its size). The
instance's `_malloc` export is wrapped to throw "out of memory" instead of
returning NULL: quickjs-emscripten copies evaluate sources, and so tool
results the machine host embeds in them, through `_malloc` unchecked and
would otherwise write at address 0 when the heap is full, corrupting the
instance; thrown, it is the ordinary memory `cap_exceeded`. `quickjs-emscripten-core` becomes a direct, exactly
pinned dependency for `newVariant`, and `src/sandbox/webassembly.d.ts`
declares the slice of the WebAssembly API the package uses, since TypeScript
ships those types only in its DOM lib.

Alternatives rejected:

- **A composite interrupt handler** that keeps the wall-clock deadline and
  periodically compares `runtime.computeMemoryUsage().memory_used_size`
  (accurate: it sums payload sizes) against the cap. The walk is O(live
  values) (~5 ms per 500k) and so needs throttling, but the real problem is
  cadence: QuickJS polls the handler every ~10 000 bytecode back-edges,
  which was every ~2 500 iterations (10 MB) of the 4 KB-string loop and
  never once during 300 MB of 1 MB typed-array pushes (8 ms). A check that
  runs only when the machine happens to loop cannot bound allocation.
- **A hook on heap growth** (wrapping `wasmMemory.grow` on a shared memory
  and attributing growth to the running sandbox): with one process-wide
  memory the allocator cannot be identified from JavaScript, an idle
  over-cap session would get its neighbour's allocation refused, and the
  heap read goes through `getFFI()`, which quickjs-emscripten marks
  experimental.
- **Another QuickJS variant or library option.** Every emscripten variant
  shares the `malloc_usable_size` stub, and `@sebastianwessel/quickjs`
  exposes no accounting hook; `newVariant` is the public seam.
- **Documenting the gap** and leaving the limit as advisory. The PRD states
  the cap as a bound, and the §9 threat model assumes a hostile machine.

## D16 — Multi-server facades are tool boxes with qualified names (2026-10-29)

PRD §12.2 held "one facade over N servers" as a stretch goal, and R30 laid
the groundwork: an alias-keyed catalog, a blob that records the server
identity it was minted against, and a reserved `tools.<alias>.<name>`
namespace. The maintainer's framing for the model-facing side is the **tool
box**: each wrapped server is a box the model can see on a shelf, open and
search, without the whole of every box in the system prompt.

Decision (PRD §6.9, R39–R48):

- `wrapMcpServers(sources, options)`; aliases are integrator-chosen
  (`^[a-z][a-z0-9]{0,23}$`; `default` and every `search_*` suffix
  Projection registers, `tools` today, reserved; 1–16 sources) and are the
  only server names any model or approver sees. `wrapMcpServer` is not a
  one-source special case of the new entry, and its outputs (goldens, blobs,
  copy) stay byte-identical.
- Every tool on a multi-server facade is `<alias>.<name>`, split at the
  first dot, on every surface: search, describe, call, types, `toolCall`,
  approval copy, audit, `pending`, binding hash. A bare name that itself
  contains a dot renders in the approval footer as `Tool: <alias> › "<name>"`,
  so `fs`'s `github.delete_repo` never reads as the `github` box's tool.
- `serverIdentity` is `multi:` plus the JSON of the alias-sorted
  `[alias, identity]` pairs, so blobs bind the server set, the alias mapping
  and the server versions. Multi-server facades also derive their blob keys
  under their own HKDF info string (`@astral-mcp/projection/blob/v1/multi`).
- Policy: per-tool overrides only on the facade, keyed by qualified names;
  an unqualified key or one naming an unconfigured alias fails the wrap.
- Catalog: one `search_<alias>` per box plus a global `search_tools`
  (switchable, `catalog.globalSearch`), one `describe_tool`, one
  `call_tool`. In `search_tools`, a query token equal to a box's alias is an
  alias token: it boosts every tool in that box and matches no tool's text.
  An empty-query first page of `search_<alias>` leads with the server's full
  instructions (the box overview).
- System-prompt `instructions`: Projection's preamble plus a one-line-per-box
  shelf; the servers' own instructions are not concatenated.
- Code mode: `tools.<alias>` object-type properties, `toolCall('<alias>.<name>')`,
  overview grouped per box; one gated call, one approval, as today.
- Approval copy names the box: `Approve (<alias>): …`,
  `What <alias> says it does`, `Tool: <alias>.<name>`.
- Wrap is fail-closed; `optional: true` sources are skipped and reported on
  `facade.skipped`; `introspectTimeoutMs` bounds each source.

Why qualified names over host-style `alias__name` tool names. The obvious
alternative — what multi-server hosts do today — exposes every wrapped tool
as its own MCP tool named `<alias>__<name>`. R1 already rules out exposing
wrapped tools, and the naming has its own costs: model-API tool-name limits
(commonly around 64 characters from a restricted set without dots) truncate
or reject long tool names once a prefix is added, and the facade's tool list
grows by one per wrapped tool again, which is what the catalog projection
exists to avoid. A qualified name is an argument to `call_tool`, not a tool
name, so it has no length budget to share, and the dot cannot appear in an
alias, so the split is unambiguous even for tool names that contain dots.

The cost of this choice: the facade's tool list still grows by one per box.
With the global search on, the catalog projection is N + 3 tools — 19 at the
16-box limit, 21 with code mode. That is bounded and independent of how many
tools the boxes hold, but it is not the flat five of a single-server facade.

Why the alias rides in the name. `pending`, the audit trail and the R36
binding hash already record a tool name. Putting the alias inside that
string makes every one of them box-aware for free — an approval for
`fs.write_file` cannot be replayed as `github.write_file` — and leaves the
blob schema at version 1. A separate `alias` field would have been a
format change, a second field to keep consistent with the name, and a new
tamper case to test.

Why a key domain, not just an identity format. A single-server identity is
`name@version` as the server reports it, and it must stay byte-identical so
existing blobs keep resuming. A server can therefore report a name that
spells any multi-server identity string, and no choice of format can rule
that out. Deriving multi-server blob keys under a separate HKDF info string
makes the two facade kinds cryptographically disjoint under one key: a blob
from one fails authentication on the other, whatever the identity strings
say. The identity itself is JSON so that, within multi-server facades, no
reported name can make two different server sets produce the same string.

Why alias tokens. `search_tools` ranks by text the servers control. Without
the rule, a hostile `fs` server could write `github` into every description
and push its own tools above the `github` box's for any query naming
`github`. Treating the alias as a box selector rather than as text removes
that lever; the did-you-mean hint follows the same rule, suggesting only
from the box a qualified name names.

Why progressive instructions. Prompt size grows per server: GitHub's
instructions alone are ~2 KB, and a facade over a handful of real servers
would put most of its system prompt into guidance for boxes the task never
opens. The shelf costs one line per box; the full text arrives with the
first look into a box, which is when the model needs it. It also keeps each
server's text attributed to its box rather than merged into one voice.

Why fail-closed with opt-in optional. A facade that silently loses a
server changes what the model can do, what the shelf says and which blobs
resume, with nothing in the integrator's logs at the moment of the change.
Failing the wrap makes a missing dependency a deployment error; `optional`
lets an integrator say a box is a nice-to-have, and `facade.skipped` makes
the skip observable. Behind a load balancer, instances can disagree on which
boxes they skipped; that limitation is stated in R47 rather than designed
around.

Why per-box and global search, with the default left to the eval. Per-box
search is what makes a box a box: scoped results, a description the host
writes, a natural place for the overview. A global search serves the task
that does not know which box holds the tool. Whether the extra tool helps
or only adds a choice for the model is an empirical question, so the switch
ships and the default is decided by the multi-server eval.

Alternatives rejected:

- **One `search_tools({ server })` with the shelf in the instructions.**
  Fewer tools, but the box has no tool description of its own to carry the
  host's `description`. A hypothesis for the eval to test: models often omit
  optional filter arguments, which would make it a global search with an
  unused parameter.
- **Per-box search only.** Cross-box tasks and "which box has this?" would
  cost one search per box before the first call.
- **Merged system-prompt instructions.** The prompt-size argument above, and
  third-party text from N servers would share one undifferentiated block.
- **Skip-and-warn as the default.** See fail-closed above; the warning goes
  to a log nobody reads at wrap time.
- **Per-source policy keyed by bare names** (in an earlier draft). It gave
  two places to say the same thing and needed a conflict rule; qualified keys
  on the facade say everything once.

Follow-up: the multi-server eval (PRD §13) — offline GitHub fake, filesystem
reference server and MongoDB MCP server; direct mode with `<alias>__<name>`
tools and concatenated instructions against Projection with the global
search on and off. Its results set the `globalSearch` default and get their
own entry here.

Implementation (multi-server core, 2026-10-29): the first `wrapMcpServers`
slice (R39–R43, R46, R48, R49) adds no second gate. The facade builds one
merged view of its boxes (`catalog/boxes.ts`): an ordinary `ServerCatalog`
whose entries carry qualified names, deduplicated per box, whose `identity`
is the R41 server-set string, plus its members (each tool's box, bare entry
and qualified entry) and per-box tool counts. Everything that resolves a
name against a catalog — `findTool`, `decidePolicy` with facade policy keyed
by qualified names, the R36 binding hash, the blob's `pending` entries — is
therefore box-aware without a code path of its own. The few places that
must know they serve boxes ask `isBoxedCatalog` (a brand set only by
`buildBoxedCatalog`, never by shape): call routing (`routeCall` sends the
bare name to the box's connection, for `call_tool` and for the machine host
alike), the box-scoped did-you-mean and unknown-tool messages, the describe
and search headers, and the approval copy, which is built from the box's
own entry plus the host alias (R46, S6). A box's bare entry is copy-only: it
is never handed to `decidePolicy`, since its name can spell another box's
qualified name.

The key domain is declared, not inferred: each facade passes its kind
(`blobDomain: 'single' | 'multi'`) in the gate deps, and `blobKeyDomain`
checks it against the brand, failing closed (`terminal`) on a mismatch — a
spread copy of a view loses the brand, and must never seal or open in the
`single` domain. Undeclared (a direct library caller), a catalog carrying
the view's alias or a `multi:` identity without the brand is refused the
same way; a single-server facade declares `single`, so a server that
reports a `multi:` name still works there and R41's domains keep the kinds
apart.

The per-source approvals mode (R49) rides `PolicyContext.toolApprovals`,
resolved at wrap time from the view's members to one entry per qualified
tool whose box has a mode — the policy engine never re-derives a box by
splitting a name, so a server's dotted tool name can only take its own
box's mode. The policy fields every deciding surface takes (`policy`,
`approvals`, `toolApprovals`) are one `PolicyOptions` type.

Wrapping is fail-closed (R47): configuration mistakes — including a missing
`blob.key` and an `McpServer` already attached to a transport — are
`validate` errors before anything connects; once sources are connected,
any throw closes every connection Projection opened, and caller-owned
`Client`s stay open (after a failed wrap and after `close()`). The R48
total is counted before the per-box dedupe, so repeated names cannot slip
a server past it.

Interim gaps, until the follow-up PRs:

- `optional: true` is unsupported (fails the wrap; `optional: false` is
  accepted), and `introspectTimeoutMs` is not built (R47).

Tool boxes (2026-10-29, R43–R45): the `search_<alias>` tools, the box
overviews (in the first page of an empty-query box search and as
`projection://boxes/<alias>/overview.md` resources), `catalog.globalSearch`
and the full R44 shelf are served. The view records whether the global
search is on (`BoxedCatalog.globalSearch`), so every piece of copy that
names a search tool — the unknown-name hint, the `describe_tool` /
`call_tool` argument descriptions, the preamble, the facade API's errors —
derives from the same flag and never names a tool that is not served; a
qualified name whose box exists points at that box's own search tool. The
server text a box surface shows is first stripped of invisible characters
(Unicode format characters and the tag block, so no zero-width or
tag-character payload rides along unseen; bidi controls still show as
`�`), and a box whose server text is then empty or only `�` shows no
about, no overview and no resource. The rest is attributed by shape. The
first sentence — of the first line that is neither blank nor a Markdown
heading — is a JSON string literal followed by `(server's words)`; inside
it ASCII `"` becomes `”` and a literal `(server's words)` or tool count
is removed, so it cannot seem to close the quotation and one shelf line
never shows two attributions or counts. The overview is an indented block
under a library header, separated from it by a blank line: in the `.md`
resource that makes it a CommonMark indented code block (directly under the
header it would continue the header's paragraph, and its links, images and
raw HTML would render), so no line of it can pass for a tool line, a
header, a shelf line or markup. It is cut at a line break, else a space,
in the last tenth of the 8 KB window, never inside a grapheme cluster, and
its truncation marker is part of the overview text, so the structured
`overview`, the text rendering and the resource agree.

Implementation (code mode, R45, 2026-10-29): code mode is on by default on
multi-server facades, as on single-server ones, and either projection can be
turned off. Typegen takes the branded view and emits one `tools.<alias>`
object-type property per box — object types, not `namespace`s, so a
reserved-word alias is a valid property — with `<alias>_<Pascal>` type names
(unique because aliases have no `_`, and stable whichever other boxes are
wrapped), one `.d.ts` section per box in sorted alias order, and postures
decided on each tool's qualified entry with the shared `PolicyOptions`. The
bridge's `tools.<alias>.<name>` binds the qualified name, so a bridge call
and `toolCall('<alias>.<name>')` reach the host identically, and the machine
host routes both with `routeCall`. Nothing in the gate changed: the view
already made `pending`, the audit trail and the key domain box-aware, and
machine blobs use the `multi` domain because the facade declares it for both
gated tools. The single-server artifacts are built by the untouched path, so
their goldens are byte-identical; the multi-server text variants (contract
rule 10, qualified samples, grouped overview, box-named headers) are
selected by the brand. The samples call real tools of the first box in
sorted alias order — the first that runs immediately and the first that
asks for approval under the facade's policy, if its name is a plain
identifier (S5) — and fall back to generic names in that box, marked as
sample names, so a model is never shown a tool that does not exist without
being told. `buildBoxedCatalog` re-checks the alias grammar and the bridge
header is rendered inert like the single-server identity: aliases print raw
everywhere else, so the view refuses any alias the wrap would have refused.
Two wording choices: the machine's unknown-tool hint on a multi-server facade
now leads with the R40 did-you-mean (the single-server machine hint is
unchanged), and the shelf header names the tools that take a qualified name
for the projections served (`describe_tool`, `call_tool`, `toolCall`). The
multi-server preamble has a variant per projection selection, each naming
only the search tools served (`globalSearch`), and the R37 pointer in
`discover_apis` uses `searchToolsPhrase`. The box overview resources are the
tool-boxes slice's (`catalog/box-guidance.ts`), served after the code-mode
resources; `discover_apis` links every resource the facade serves except
the dashboard.

Alternative rejected: running `wrapMcpServer`'s pipeline once per box and
dispatching on the alias in front of N single-server facades — N blob
identities and key domains to reconcile, and policy, search and the
did-you-mean hint would each need a cross-facade layer anyway.

## D17 — Approvals mode: `every-write` or `destructive-only` (2026-10-29)

History: a flag to skip the approval on non-destructive writes was floated
on 2026-10-10 and parked — approval friction against safety, with no
behaviour change wanted then. It was decided on 2026-10-29, alongside
multi-server facades, where trust is naturally per server.

Decision (PRD R49): `approvals: 'every-write' | 'destructive-only'`,
default `'every-write'` (unchanged behaviour), on `WrapOptions` for the
whole facade and on each `ServerSourceConfig`, the per-source value taking
precedence. Under `'destructive-only'` a non-read-only tool runs without
approval only when it explicitly declares `destructiveHint: false`; a
missing hint, or anything but an explicit `false`, still asks — the MCP
default reads a non-read-only tool as destructive, and a server that says
nothing has not claimed safety. Precedence: per-tool `policy` override, then
per-source mode, then global mode, then the annotation default. Malformed
values fail the wrap.

Why the per-tool override stays on top: it is the integrator's most
specific statement, so a per-tool `ask` or `deny` must hold under a relaxed
mode, and a per-tool `auto` already meant "never ask". Why per source: the
mode trusts a server's `destructiveHint: false` the way R14 already trusts
`readOnlyHint: true`, and a hostile server can mislabel a damaging tool —
so the knob belongs on the servers an integrator vouches for. Why failing
the wrap on a malformed value, where a malformed per-tool override fails
safe to `ask`: the mode is one deploy-time switch, and a typo should
surface at deploy, not as approvals nobody can explain.

Alternatives rejected: **`destructive-only` as the default** — a behaviour
change for every existing facade, and it trusts third-party annotations by
default; **per-tool `auto` lists only** — the integrator would have to
enumerate every non-destructive write and keep the list current as servers
change.

Implementation (single-server, 2026-10-29): one decision function,
`decidePolicy(entry, context: PolicyContext)`, where `PolicyContext =
{ overrides?, approvals }` is built with `policyContext(options)` from the
`policy` / `approvals` options every surface already carries. `approvals` is
required in the context, so passing a bare overrides object (the pre-R49
second argument) is a type error — and, for untyped callers, a runtime
`TypeError` rather than a silently dropped `deny`: `decidePolicy` throws on
any context whose `approvals` is not one of the two modes, so even an old
overrides map naming a tool `approvals` fails closed. Annotation hints are
read with own-property semantics, like overrides. Direct library users of
`executeMachine` / `generateToolTypes` validate the option with the exported
`assertApprovalsMode`. The per-source mode of a multi-server facade is an
optional field of the same context, `toolApprovals`, resolved per qualified
tool (D16, implementation addendum).

The mode is deliberately not bound into blobs: it only ever relaxes `ask` to
`auto`, a pending entry always needs an accepted verdict to run, and `deny`
is re-checked on resume — so a blob carried to a facade with another mode
can never skip an approval.

Model-facing copy (2026-10-29): the preambles, the `execute_machine` and
`call_tool` descriptions and authoring-contract item 5 no longer say
"read-only tools run immediately; every other tool asks" — that is false
under `'destructive-only'` and under any per-tool `auto`. They now point at
the per-tool postures (R33: "runs immediately" / "asks for approval"), which
every surface already renders from the resolved decision, so the copy is
accurate under every mode and every per-tool override. This supersedes the
earlier mode-specific wording; models that matched on it see a minor-version
copy change.

## D19 — Upstream sign-in is just-in-time and bring-your-own (2026-10-29)

Context. Remote MCP servers that need authorization are usually wired up
today by pasting a token into an MCP client's configuration file, where it
sits in plaintext, gets copied between machines and is never rotated. PRD
§12.4 held per-user upstream OAuth as a stretch goal and had already
decided two things: authorization is semantically an approval, so it
belongs in an MRTR suspension; and credentials never enter the sandbox,
the blob or any model-visible surface. The maintainer wants getting started
to need nothing more than a URL, and wants Projection to ask for sign-in
only when a request first needs it. GitHub's remote MCP server, the most
common case, has no dynamic client registration, and its maintainers do not
plan to add it (github/github-mcp-server#1404). Its authorization server
does support the device flow: `https://github.com/login/oauth` advertises
`device_authorization_endpoint`, checked 2026-10-29. A GitHub OAuth app
allows the device flow without a client secret when "Enable Device Flow"
is ticked, but its authorization-code exchange requires a secret even with
PKCE.

Decision (PRD §6.10, R50–R62):

- **Sources by URL.** A source can be an `UpstreamSpec`, `{ url, oauth? }`,
  in `wrapMcpServer`, in `wrapMcpServers` and as a `ServerSourceConfig.source`.
  Projection then builds a Streamable HTTP transport (`https:` except on
  loopback) and installs its own `OAuthClientProvider`. Pre-built `Client`s
  keep integrator-owned auth, and their outputs stay byte-identical.
- **Bring-your-own registration.** Projection ships no OAuth app and
  recommends none. Client identity is resolved in the SDK `auth()` order:
  configured `oauth.clientId` (with an optional, discouraged
  `clientSecret`), then a CIMD URL when the server supports CIMD, then
  dynamic registration (both phase 1b). When none applies, the request
  ends directly in an `auth` error that names what to configure.
- **Flows.** The device flow (RFC 8628) is used whenever it is available,
  from metadata or the `oauth.deviceAuthorizationEndpoint` override. The
  device code is sealed in the sign-in blob. A retry first re-reads the
  token store, then holds the request and polls at the server's interval
  for up to 25 s before re-suspending. Sign-in round trips have their own
  counter, bounded by the device code's expiry rather than the R12 trip
  cap. Otherwise (phase 1b) Projection uses authorization code + PKCE S256
  with a loopback redirect on `127.0.0.1`, carrying the verifier in a
  sealed `state`. Every request carries RFC 8707 `resource`, but the
  audience binding is enforced on Projection's side, because servers may
  ignore it (GitHub does). Endpoint and scope overrides cover incomplete
  metadata. Hosted redirect URIs are out of scope.
- **Sign-in host rule.** The authorization, device-authorization and
  verification URLs must share the host of the validated issuer, unless
  the integrator overrode that endpoint or listed the host in
  `oauth.signInHosts`. The sign-in message names the resource host and the
  issuer host.
- **Locked boxes.** A 401 at wrap time locks the box rather than failing
  the wrap. The shelf shows it as `sign-in required`, and its
  `search_<alias>` is still served. The first request that needs the box
  suspends for sign-in. The retry introspects the box lazily on that
  instance, and the original request proceeds. The tool list never
  changes, a box's `search_<alias>` description is fixed at wrap time, and
  no list-changed notification is sent. Any request that names a box
  locked on this instance, a resume included, re-reads the token store
  first.
- **The sign-in request.** It is a URL-mode elicitation:
  `Sign in to <alias> (<resource host>)`, then
  `You'll be sent to <issuer host>`. It falls back to a form with an "I've
  signed in" confirmation, then to a normal `sign_in_required` result whose
  link the model shows the user, backed by a per-instance pending flow that
  the next call redeems. The request is carried by a new blob kind, `signin`, bound to the original
  request and the facade identity, single-use, and expiring with the flow.
  When the sign-in completes, the request continues and a write still asks
  for approval. A decline is `sign_in_declined`, or `TOOL_DENIED` in a
  machine (phase 1b). Failures get a new `auth` phase. A mid-workflow 401 re-locks the
  box and suspends; re-lock is compare-and-delete against the store, since
  two processes sharing one keychain entry is normal.
- **Token residence.** Tokens live only in a `TokenStore`: by default the
  OS credential store (macOS Keychain, Linux Secret Service, Windows
  Credential Manager) through the native keyring library
  `@napi-rs/keyring`, an optional dependency loaded on first use. When it
  is absent, fails to load, or the store is unavailable, locked or hung
  (5 s timeout per operation), Projection falls back to an in-memory store
  with a warning. Entries are keyed by the SHA-256 of the store key, so no
  URL appears in the store's metadata. The store is pluggable for hosted
  deployments. Refresh is automatic, and `signOut` re-locks.
- **Identity.** A URL source's identity is `url:<canonical url>`. It is
  stable whether the box is locked or unlocked, and it cannot equal a
  `name@version`, because a canonical URL has no `@`.
- **Scope and phases.** One principal; §12.4 keeps per-user principals,
  hosted redirects, secret references and credentials in source URLs.
  Phase 1, the GitHub milestone, is a configured `clientId`, the keyring
  store and its fallback, the device flow with hold-and-poll, URL and form
  elicitation and the `sign_in_required` fallback, locked boxes for the
  catalog tools (`search_<alias>`, `describe_tool`, `call_tool` and their
  single-server equivalents), re-lock on 401, `signOut` without revocation
  and the live GitHub smoke. Phase 1b adds authorization code + PKCE with
  the loopback listener, DCR and CIMD, `insufficient_scope` step-up, RFC
  7009 revocation, the `discover_apis` suspension and machine-held sign-in.
  Until then a machine `toolCall` to a locked box is a `TOOL_ERROR` naming
  the box's search tool, so the model signs in there and runs the workflow
  again.

Why the device flow first. It needs no redirect listener, no port, no
client secret and no browser on the same machine. It is the only one of the
two flows that works in a hosted deployment, and it is stateless across
MRTR retries: everything needed to finish it rides sealed in
`requestState`, so any instance can poll. For GitHub, the case that
motivated this work, it is also the only flow that works without a secret.
The authorization-code flow stays as the fallback for servers without a
device endpoint, and it is local-only by construction.

Why a new blob kind rather than a pending entry. `pending` is the S2
approval map. If a sign-in were a pending entry, every approval path would
need to know that one entry is not an approval, and a single missed check
in `call_tool`'s exactly-one-`call` rule would execute a gated call on an
`accept` meant for a sign-in. A separate kind, with R36's kind check
extended to the origin tool, makes that confusion impossible. It also
keeps sign-in and approval sequential: sign in first, then approve, never
one prompt doing both.

Why locked boxes. Failing the wrap on a 401 would make "start with nothing"
impossible. Skipping the source, as `optional` does, would hide the box
from the model, so it could never ask for it. A locked box keeps the
facade's tool set fixed: hosts cache tool lists and models plan from them,
and the 2026-07-28 wire has no session to send a list-changed notification
on. The shelf tells the model the box exists and what it needs, and the
box's own search tool is the natural place to trigger sign-in.

Why hold and poll. Clients retry the moment the user accepts the
elicitation, usually before the sign-in in the browser has finished. A
retry that polled once would mostly find `authorization_pending` and burn
a round trip; holding for up to 25 s at the server's interval turns the
common case into one retry. Counting sign-in round trips against the R12
cap would let a fast-retrying client exhaust it while the user is still
typing the code, so the loop is bounded by the code's own expiry instead.
That also removes the need for a background poller: a pending fallback
flow is redeemed by the next call that needs the box.

Why the OS store, through a native library. A token file in plaintext is
the problem this work replaces, just moved to a different place. A file
encrypted under the blob key would put the key that protects every blob
next to every token it unlocks, and an integrator who shares the blob key
across instances would be sharing tokens too. The OS credential store is
per user, encrypted at rest, and already where users expect credentials
to live. `@napi-rs/keyring` reaches it in-process on macOS, Linux and
Windows from prebuilt binaries: no subprocess, no argv, no size limit.
Being optional, it never blocks installation; when it is missing or the
store is unavailable, an in-memory store with a warning is honest about
the cost: the user signs in again after a restart. The threat model is
stated in R59: the store protects against other OS users and disk theft,
not against code running as the same user, which can read the item, as
it can under every OS-store approach.

Why the sign-in host rule. The SDK validates that metadata is internally
consistent, but a hostile server can point at a legitimate identity
provider that is not its own, and a user who sees a familiar sign-in page
approves it. Requiring the URLs the user is sent to to share the
validated issuer's host, and naming both the resource host and the issuer
host in the message, makes that visible; `oauth.signInHosts` covers
providers that legitimately split hosts (Google's device flow, for
example), as an explicit integrator decision.

Why a URL-based identity. A sign-in blob is minted while the box is locked,
before Projection has seen the server's `name@version`. An identity that
changed on unlock would make every first sign-in fail verification. The
host-chosen URL is known at wrap time and stable. Trade-off: an upgrade of
the server behind that URL no longer invalidates in-flight blobs. That is
acceptable because blobs live for minutes, and a resumed call is validated
against the catalog the instance holds when it resumes.

Alternatives rejected:

- **Projection-owned OAuth apps for popular providers** (a GitHub OAuth app
  shipped with the library, for example). This would give the lowest
  friction for those providers. But the maintainer does not want Projection
  to be prescriptive about which servers it wraps, and a shipped client id
  makes Projection the operator of an app that every user's token is issued
  to.
- **Failing the wrap on 401.** It contradicts the goal: a wrapper that
  needs a token before it starts brings the token back into configuration.
- **Static tokens with secret references as the primary path.** This is
  less machinery, but it keeps the user minting, storing and rotating
  long-lived tokens by hand. It stays available as integrator-owned
  `Client` auth, and secret references stay in §12.4.
- **A plaintext token file, or one encrypted under the blob key.** See the
  OS-store rationale above.
- **The OS store through helper processes** (`/usr/bin/security` on macOS,
  `secret-tool` on Linux). A secret passed on stdin to `security` is
  silently truncated or stored empty; passed in argv, it is visible to
  other local users in the process table; and the interactive mode has
  line-length and quoting limits. It also left Windows without a store.

Known gaps carried forward:

- The authorization-code flow cannot tell when the browser is on another
  machine.
- In the no-elicitation fallback, the link passes through the model, which
  brings the phishing and fixation risks R61 names. Fixation is accepted
  for single-user phase 1.
- A pending fallback flow (the no-elicitation path) lives on one
  instance. Behind a load balancer without a shared token store, the next
  call may reach another instance, which starts its own flow.
- The OS store does not protect tokens from other code running as the
  same user.

### D19 addendum — phase 1, part A implementation notes (2026-10-29)

PRD phase 1 ships in two parts. Part A is the foundation of §6.10:
`UpstreamSpec` sources (R51), the `url:` identity (R60), the token store
(R59), stored-token use and refresh (R58), `signOut` without revocation,
the `auth` error phase (R25), and `introspectTimeoutMs` (R47). Part B adds
locked boxes, the device flow and every sign-in suspension. (Phase 1b —
the authorization-code flow, DCR, CIMD, revocation — is unchanged and
comes after both.) Decisions made while building part A:

- **Interim behaviour for a source that needs sign-in.** Until locked boxes
  land, a 401 at wrap time with no usable token fails the wrap with an
  `auth` error saying sign-in is required and that just-in-time sign-in is
  not supported in this version. It contacts no authorization server: with
  nothing stored, `onUnauthorized` refuses before any discovery. A 401 at
  call time is an `auth`-phase outcome (`call_tool`'s R25 `auth` error,
  a machine's `TOOL_ERROR`), not an `upstream` one. Both carry a typed
  `UpstreamAuthProjectionError` (a `ProjectionError` with a `reason`):
  `UpstreamConnector.toError` / `callFailure` is the seam part B's lock and
  re-lock switch on.
- **The transport gets an `AuthProvider`, not the `OAuthClientProvider`.**
  Handed an `OAuthClientProvider`, the transport adapts it internally and
  runs `auth()` where Projection cannot bracket it, so the SDK's
  `console.warn` output (which quotes authorization-server bodies, refresh
  tokens included, as the tests showed) could not be confined to the auth
  run. Projection's `AuthProvider` reproduces `adaptOAuthProvider` — `token()`
  re-reads the store per request; `onUnauthorized` runs the SDK's `auth()` —
  over a fresh `ProjectionOAuthProvider` delegate per run. The per-run
  delegate is also what makes compare-and-delete exact: it remembers the
  stored value it presented, and `invalidateCredentials('tokens')` deletes
  only that one. Consequence: the transport's own step-up path never runs
  (it needs the `OAuthClientProvider`), which is what
  `onInsufficientScope: 'throw'` asks for anyway.
- **Console capture is a permanent filter, not a swap.** A first version
  swapped `console.warn` for the duration of each run and restored it after;
  that dropped other clients' `[mcp-sdk]` warnings process-wide while any
  run was in flight, and the restore clobbered a logger installed meanwhile.
  A second version wrapped the current function at every point of use,
  which still let a logger assigned mid-run, between two requests of the
  run, see SDK text. Now, on first auth use, `console.warn` becomes an
  accessor property: the setter stores whatever function is assigned, and
  the getter returns that very function — except inside an auth run (an
  `AsyncLocalStorage` flag only the run's own async context carries), where
  it returns a wrapper of it that drops `[mcp-sdk]` warnings. A replacement
  at any time is filtered inside runs and untouched (identity included)
  outside them; importing the library still changes nothing. The accessor
  is re-checked at every point of use and re-installed if something
  redefined the property.
- **Refresh is single-flight, and keyed to the failed token.** Concurrent
  401s on one record share one refresh (a module-level map per store and
  key), and the guarded fetch notes which bearer token each response
  answered, so `onUnauthorized` knows exactly which token failed: if the
  store now holds another one, the request is retried with it instead of
  refreshing (R58 "re-read before refresh / re-lock"). A record with no
  refresh token is also retried once — a token another process stored
  between the read and the retry is picked up — and a second 401 with the
  same token means sign-in. A failed refresh re-reads the store too before
  reporting. A refresh run is bounded by `AUTH_RUN_TIMEOUT_MS` (30 s, one
  deadline for the whole run, discovery included, joined to each request's
  own signal) and by its connection's life — `close()` aborts it — so a
  token endpoint that never answers cannot hold the single flight, which
  every facade over the same store would join, forever: the run ends as
  `refresh_failed`, the flight clears, and the next call starts afresh. Records whose `expires_at` has passed are refreshed before
  they are sent (`expires_at` was already stored, so this was cheap).
- **What counts as an auth failure.** Projection's marker, `UnauthorizedError`
  and `InsufficientScopeError` (R58's three), plus the transport's
  `SdkHttpError` with `ClientHttpAuthentication` — the 401 a request still
  gets after `onUnauthorized` succeeded. It is the same condition one step
  later, so it is classified with the three (R58 amended). Errors from
  `auth()` are reduced to a fixed-copy `UpstreamAuthError` with no `cause`;
  an OAuth `error` code survives only if it matches `^[a-z_]+$`. Part A
  does not carry `error_description` at all (R57 allows a neutralized,
  capped one; part B can add it with the sign-in copy). Distinct reasons
  keep the copy accurate: a transient refresh failure (5xx, malformed
  response, network) is `refresh_failed`, record kept — the SDK falls back
  to a new authorization there, which `state()` recognizes because a
  refresh grant was sent in the run; `invalid_client` / `unauthorized_client`
  is `client_rejected`, a configuration problem with the record kept (the
  delegate stops the run when the SDK invalidates `client`, before it would
  delete the tokens); a non-`https:` authorization-server endpoint for a
  source that is not loopback is `insecure_endpoint` (R61; the SDK's own
  token-endpoint check admits loopback `http:` for any source).
- **Credentials are redacted from everything a URL source returns.** A
  server sees the access token on every request and can echo it: in a 5xx
  body that becomes an SDK error message, in a tool error or result, in a
  tool description. Each connection remembers every secret it presented or
  was given (access and refresh tokens, the client secret, and their URL-,
  form-, JSON-, base64- and base64url-encoded spellings) and scrubs them, as
  `[redacted]`, from wrap errors, call errors and their details, tool
  results, the catalog and the server instructions. Wrap errors from a URL
  source are rebuilt as `ProjectionError`s without a cause (the raw SDK
  error's `data` keeps the body), and upstream error text is capped.
  Redaction is exact matching against accidental echoes, not a defence
  against a hostile server (which can re-encode a token any way it likes).
  The rules that keep it from doing harm: only string leaves are scrubbed,
  never property names or JSON syntax (scrubbing the serialized JSON let a
  one-character token rewrite `"name"` keys and break the catalog); a
  secret shorter than 8 characters is never substring-redacted (it would
  corrupt text without hiding anything); a value that cannot be checked or
  rebuilt — not serializable, too deep, a credential in a property name —
  fails closed with a `ProjectionError`, never `undefined` or `[]`; text in
  which a secret appears once invisible characters are stripped (box
  surfaces strip them) is returned stripped and redacted; and redaction
  runs before any truncation (the repeated `tools/list` cursor quoted in an
  error is redacted, then cut to 64 characters).
- **The token goes only to the canonical resource.** The SDK's default
  `redirectPolicy` follows same-origin redirects, carrying the
  `Authorization` header to another path. Projection's fetch refuses any
  redirect from the resource whose target differs in origin or path (a
  fixed-copy `protocol` error), refuses to send a bearer token anywhere but
  the resource, and sends nothing over `http:` for a source that is not
  loopback.
- **`TokenStore` is opaque strings.** An earlier draft of this part typed
  the interface (`TokenRecord` values, record equality for
  compare-and-delete). The maintainer chose strings: a store stays a dumb
  key-value map that never parses a credential, compare-and-delete compares
  the exact stored string, and phase 1b's registrations need no widened
  type. Keys are `<kind>:<JSON array>` — `tokens:[url, client, principal]`
  now, `registration:` reserved — so a store can route by kind. The record
  format is Projection's internal codec (`token-record.ts`, ASCII JSON).
- **Keyring specifics.** `@napi-rs/keyring` 2.1.2 is an optional
  dependency with prebuilt per-platform binaries and no install script, so
  `pnpm install --frozen-lockfile` needs no `allowBuilds` entry. It has no
  label setting, so entries carry none. On Linux its default silently falls
  back to the kernel keyring, which does not survive a reboot or logout;
  entries are pinned to the Secret Service so a machine without one takes
  Projection's in-memory fallback, with its warning, instead. The fallback
  is per store and process-wide for the default store, so the warning
  prints once. Operations on one entry are serialized within the process
  (a write and its read-back are one operation), so a slow write cannot
  land after a later one; a write that timed out but lands later is
  reconciled once it settles — rewritten with the newer value memory holds,
  or compare-and-deleted, since the caller was told it went to memory. A
  write that lands late can still overwrite another process's newer value
  before it is reconciled; then the entry is removed and that user signs in
  again. After the fallback, `delete` still deletes the OS entry when the
  module had loaded (a compare-and-delete only for an entry this process has
  seen) and throws when it cannot and the entry may be there — the key was
  seen in the OS store, or some OS-store operation has succeeded in this
  process; a sign-out that silently left the token in the OS store would be
  worse than an error. On a machine with no working OS store (headless
  Linux without a Secret Service) nothing ever reached it, so `delete`
  returns the in-memory result rather than failing every sign-out. A module
  that is not installed (`ERR_MODULE_NOT_FOUND`) is that normal case too;
  one that failed to load (timed out, threw) makes `delete` throw, since a
  store it could not reach may hold an earlier process's entry. A rotated
  value is written behind to an entry this process has seen, best effort,
  so the OS entry never keeps a refresh token that rotation killed; a
  write-behind that lands after its timeout is reconciled like any late
  write, so one that lands after a sign-out is deleted again.
- **The guarded fetches never let the runtime follow a redirect.** Both
  the connection's fetch and an auth run's force `redirect: 'manual'`
  whatever the caller passed: the SDK's own same-origin following goes
  through them again hop by hop (and is checked), while a caller that
  passed no `redirect` can no longer have the runtime carry the token, or a
  refresh token in a re-POSTed body, to wherever a 3xx points.
- **Compare-and-delete is not atomic across processes.** The keyring has
  no conditional delete: it is read, compare, delete. Two processes can
  interleave between the read and the delete; R58 accepts this — the worst
  case is one extra sign-in.
- **Endpoint overrides are validated but not yet used.** `tokenEndpoint`
  and `deviceAuthorizationEndpoint` are checked (R51's `https:` rule) and
  stored; the device-code redemption of part B uses them. A refresh in part
  A ignores `tokenEndpoint` and uses the discovered token endpoint; part B
  should apply the override to refreshes too, through the delegate's
  `discoveryState()`. `signInHosts` is likewise validated now and enforced
  with the sign-in host rule (R61) in part B; it takes hostnames only — an
  IP literal names no identity provider and is refused.
- **`clientId` is required inside `oauth`** for now (R52's CIMD and DCR
  alternatives are phase 1b); `oauth` itself is optional, so a public server
  can be wrapped by URL. `clientMetadataUrl` and `authorizationEndpoint`
  are refused by name rather than as unknown keys, and are not in the type.
- **URLs are bounded.** A source URL or endpoint override longer than 2048
  characters is a `validate` error, and hints quote at most 200 characters
  of a URL.
- **`introspectTimeoutMs` lands here** (R47), on single- and multi-server
  facades: default 30 s per source, a `protocol` error naming the alias (or
  the host on a single-server facade) when a source has not connected and
  listed its tools in time. The timed-out task is aborted — a URL source's
  half-open connection is closed, a pending `tools/list` cancelled — and a
  connection that completes after the sweep closes itself. `optional: true`
  is still unsupported.
- **Not yet enforced:** R54's "an `UpstreamSpec` with the catalog
  projection off is a `validate` error". It exists because nothing would
  reach a locked box; with no locked boxes yet, a code-mode-only facade
  over a URL with a stored token works, so the rule lands with locked boxes.

## D20 — An opt-in `multi-hard` eval tier with per-task turn budgets (2026-10-29)

Every existing tool-choice tier saturated (direct, Projection and its
variants all within a task or two of full marks), so they could no longer
separate surfaces on completion or cost. `multi-hard` adds 12 tasks in five
families (bulk read, bulk write, long chains, pagination, per-item
branching) over the multi world opened as a `hard` variant, which carries
much more data in all three boxes.

- **The extra data is gated behind the variant.** Base fixtures and the
  base GitHub fake answer exactly as before, so no existing task's outcome
  can move. The variant only adds: extra files, extra shop documents, and
  acme/widgets answers layered over the base fake's.
- **Opt-in.** `multi-hard` is not in `DEFAULT_TIERS`, so an unset
  `PROJ_EVAL_TIERS` (and the runner's default task set) runs what it always
  ran.
- **Per-task turn budgets.** A task may set `maxTurns`, and the runner then
  uses it in place of the run's budget, with a ceiling of twice it. The
  hard tier sets 2N + 10, where N is the number of per-item calls a
  one-call-per-item strategy needs. That way a run's length measures
  strategy, not an arbitrary cap. Results files record these budgets as
  `taskMaxTurns`.
- **Grading stays wording-free.** Answers are read from per-item lines (id,
  then first number) or a final `ANSWER:` line. Writes are graded on the
  exact recorded set or the real end state, and any write outside the set
  is forbidden.

## D21 — Eval failure classes, batch hygiene and cost bases for `multi-hard` (2026-10-30)

Review of the batch runner and the `multi-hard` tier (D20) settled how the
harness classifies and prices what that tier provokes.

- **Running out of context is a scored failure.** A 400
  `invalid_request_error` about prompt length, or the
  `model_context_window_exceeded` stop reason, ends the episode with
  `contextOverflow` and no harness error, on the interactive and batch paths
  alike. One-call-per-item strategies pile up tool results; dropping those
  episodes as API errors would hide exactly the cost the tier measures.
  Summaries count overflows per cell, tier and task.
- **The batch runner never retries an invalid request and never calls it
  infra.** The same request fails the same way. A batch it created and then
  lost (polls past the limit, a results read that throws) is canceled and
  its id logged for reconciliation. Each tick records cache reads and writes
  so the 5-minute TTL lapsing between ticks is visible; the TTL stays.
- **The hard world's search errors on what it does not implement.** Issue
  and PR search there parses date ranges, `-label:`, `no:label` and
  `no:assignee`; any other qualifier is a 422-style error, never silently
  ignored (which returned plausible but wrong lists). Its writes also
  persist for the episode (issues, labels, comments, reviews show in later
  reads), so a model that checks its work is not told it failed and does
  not write again; the state is per world, and graders still read the
  recorded calls. The base fake is unchanged (stateless, lenient search),
  so no existing tier moves.
- **Cost is per call and per tier.** Haiku 5.5 bills a call over 100K
  prompt tokens at its long-context card. The hill-climb scope gate keys
  observed costs by tier and refuses a tier with no observation, pilot or
  prior, except `multi-hard`, which takes a conservative $1/episode at list
  price. Batch `latency_s` spans lockstep ticks and is not comparable with
  interactive latency.

## D22 — Search weights rare words and breaks ties by name coverage; measured offline (2026-10-30)

D10's ranking counted every query word the same, so filler ("get", "list",
"repository") outvoted the one word that names the tool, and ties fell to
catalog position. Both were measured with a new offline eval
(`packages/harness/src/eval/offline/`, `pnpm --filter @astral-mcp/harness
run eval:offline`): 1,173 (surface, query, gold tools) cases — the 467
distinct queries models actually sent to `search_tools` / `search_<alias>`
in recorded eval episodes, labelled with the tools they went on to use,
their lift onto the 130-tool global search, 120 hand-written queries and
150 generated ones over a 1,003-tool synthetic catalog — run through the
real facade, no model, deterministic. Cases are split 60/40 by a fixed
seed; changes were judged on train and kept only if the held-out test
split improved too.

Decision, two changes (R33, R43 amended):

- **Token weights.** Each token's score is multiplied by `1 + ln(N / df)`,
  where `df` counts the tools it occurs in. A word every tool has weighs 1,
  as before; "branches" in "get repository branches" now decides the
  ranking. Matching is unchanged — any word, substring — so match sets,
  `total` and page sizes are exactly D10's. The alias token adds a name hit
  of the heaviest text token, so it keeps its relative strength.
- **Name-coverage tie-break.** Equal scores rank first the tool whose name
  the name-hit tokens spell more of (`list_issues` before
  `list_issue_types` for "list issues"), then catalog order. Ties now
  depend on the names, not the listing order: shuffling a catalog now
  moves gold ranks a seventh as much (mean |Δrank| 0.80 → 0.11, invariance
  0.929 → 0.989 on train).

Measured (train / test): recall@5 89.1 / 89.6 → 91.8 / 94.2, MRR 0.779 /
0.810 → 0.821 / 0.846, recall@1 69.5 / 74.2 → 74.4 / 77.2, mean first
page ~741 / ~767 → ~738 / ~764 tokens (chars / 4). One test changed its
expectation: in a facade test fixture "github issue" now leads with
`get_issue` instead of `issue_write` (equal score; the name "issue" covers
more of), and "(issue|branch)+" leads with its rarer word's tool.

S5: weights come from the catalog, so a hostile server can shift a word's
weight — but uniformly for every tool that has the word, its own included,
which buys nothing that stuffing its own name did not already buy. Alias
tokens are still never matched against tool text, so a foreign tool still
scores nothing for another box's alias.

Tried and rejected on the same eval: splitting camelCase query words
(`createIssue` → create, issue; train up, test flat; it does fix the
did-you-mean for camelCase guesses on a snake_case catalog, 0.51 → 1.00 on
the describe invariance check, so it is worth revisiting on that ground);
a Lucene-style coordination factor (train down); BM25 length normalization
of description hits (both splits down); indexing input-schema words —
`pull_request_read`'s `method` enum, `find`'s `sort` and `limit` (both MRRs
up, but result pages 21 % larger as a new matching field, and test
recall@5 down when it only re-ranked). Round log:
`.claude/hillclimb/multi-server/explore/offline-search.md`.

Still unanswerable by any ranking: 73 distinct queries (310 issued) search
the catalog for data — "CSV export", "widgets", "grace@example.com order"
— which is a facade question (what `search_<alias>` is for), not a ranking
one.

## D23 — call_tool relays content blocks, progress and cancellation (2026-10-30)

The spec-conformance audit (`packages/projection/test/conformance/`) wrapped
an upstream using the whole 2026-07-28 surface. Three cheap gaps were closed
on the `call_tool` path only: (1) a raw content array is rendered block by
block, with image, audio and embedded binary resources attached as native
content blocks instead of base64 JSON in the text — `structuredContent.output`
is unchanged (R35.5) and `resource_link` blocks are described, never attached,
because the facade cannot serve the upstream URI; (2) when the client sends a
`progressToken`, upstream `notifications/progress` are relayed under the
client's token, the message attributed `<tool>: …` (qualified on a
multi-server facade) and neutralized and capped at 200 characters (S5), and
each report resets the upstream request timeout; (3) the facade request's
abort signal is passed to the upstream call, so cancelling `call_tool`
cancels the wrapped tool. The `ToolExecutor` contract gains an optional
host-side `UpstreamCallOptions` argument; nothing model-authored reaches it.
Machines relay neither progress nor cancellation yet: a segment can span
many calls and resumes on another instance, so that needs its own design.

## D24 — Upstream questions: 2026-07-28 to every owned upstream, forwarding opt-in per box (2026-10-30)

The spec-conformance audit (gaps G1, G2) found every upstream driven as a
2025-era client with no capabilities, so a wrapped server's own question —
confirm, pick an account, open a link to connect — failed, and `call_tool`
told the model to check its arguments. PRD R63 and R64 record the result;
this entry records why.

**G2: the era.** An in-process `McpServer` hand-connected to a transport is
pinned to the 2025 era by the SDK, and `createMcpHandler` needs a fresh
instance per request (one shared instance fails concurrent requests). The
SDK's connection-pinned entry, `serveStdio`, accepts a supplied transport,
so the introspector serves the caller's instance over an in-memory pair
through it and pins the client to 2026-07-28: concurrent calls work, one
instance, no probe round trip. A server given by URL is probed (`'auto'`)
and falls back to the 2025 handshake. Auto-fulfilment is off everywhere, so
an `input_required` is data Projection decides about, never a prompt the SDK
answers. On 2026-07-28 the SDK checks a tool's output schema against
whatever comes back, `input_required` included, so in manual mode the
introspector hands the SDK the tool definition without `outputSchema` and
runs the same check (same validator, same wording) on complete results.

**Capabilities follow the setting.** A refusing box declares nothing, so a
server that adapts to its client keeps its no-elicitation path, and one that
asks anyway is refused by its own SDK. A forwarding box declares form and
URL elicitation, and only on 2026-07-28: a URL source that falls back to the
2025 era reconnects declaring nothing (one extra handshake at wrap, for that
case only), because a 2025 server would push its question, which a
stateless facade cannot hold across the human's answer (D7).

**Default `'refuse'`.** Forwarding gives a wrapped server a direct line to
the human, in the same client UI that shows Projection's approvals. The copy
makes it unmistakable that it is the server speaking, but no rendering can
stop a hostile server from asking for a password in plain words or linking
to a look-alike sign-in page. That is the same trust extension as
`approvals: 'destructive-only'` (D17), and it gets the same treatment: the
integrator opts in per source, for servers they trust. Refusing costs
little now that the refusal says what happened: the model is told the
arguments were fine and a retry asks again, so it stops instead of burning
turns (the cost goal), and nothing changes for servers that never ask.

**No pass-through.** A question is forwarded only from a call that already
ran under the gate. The answer re-issues the recorded call (name and args
from the blob, never the retry's), so a question can neither run a gated
call nor change what an approval authorized. Holds live in a new blob field,
`upstreamInput`, never in `pending`: like sign-in (R56), an entry an
`accept` must not execute does not belong in the S2 map. `call_tool` mints a
new kind, `upstream_input` (it opens both of its kinds), bound to the same
canonical request as the call; a machine blob carries its holds next to its
pending approvals, so one round trip can carry both (R15). Replay (R38),
expiry, identity and D9's deny-wins rule apply unchanged. `BLOB_SCHEMA_VERSION`
stays 1, as for `call` and `signin`.

**Copy and schema (S5, S6).** First line `Question from <alias> (not an
approval)`; the server's message quoted with a `│ ` prefix on every line,
so a forged `Approve:` heading reads as its quoted words; the requested
schema cut to the elicitation primitives, every string neutralized and
capped; the answer cut back to the fields the human saw. A link must be
plain `https:` and shows its origin. Wire keys are Projection's
(`upstream-<n>`, skipping any machine call id), so a server's keys never
reach the client.

**Not forwarded.** Sampling and roots (Q2; G6 stays a proposal), more than
four questions per round, a server state over 16 KB, and — for a source
given by URL — a server state that would need credential redaction, since
it would otherwise be sealed into a blob (S1) and must round-trip
byte-exact.

**Machines.** A step whose server asks is held: the actor keeps waiting for
that call's event, the segment settles everything else, then suspends. On
resume the held call is re-issued before the machine continues. A question
that cannot be forwarded is refused when the call is held, so the machine's
own `TOOL_ERROR` handling runs; at most four questions are held per
suspension across calls (a machine could otherwise fan one state out into
hundreds of prompts). A machine that finishes with only held calls left
completes without asking. Progress and cancellation are still not relayed
for machines (G3).

**Review follow-ups.** Two rules came out of the adversarial review. (1) A
held `auto` call whose tool now asks is not re-issued: before forwarding, a
call that needed no approval never crossed a round trip, so a new `ask`
override always applied, and a blob minted earlier must not outlive that.
(2) A long quoted line is hard-wrapped with each piece prefixed, and form
labels that mimic approval copy are prefixed `The server's text:`. The
in-process `serveStdio` path leaves the caller's `McpServer` with the
2026-07-28 handlers installed after `close()`; re-wrapping works, hand-
connecting it to a 2025-era client does not. That is documented rather than
worked around (a per-connection instance would need a factory from the
integrator). MRTR's state-only "call me again" is re-issued at once, at most
eight times, as the SDK's own driver would have done for the 2025-era
client Projection used to be.

## D25 — Approval UX: no prompts for calls that cannot run, refusals the model can see, opt-in batched prompts (2026-10-31)

Measured on the `hitl` eval tier (D26). What is gated did not change: tool
annotations plus the integrator's `policy` / `approvals` still decide, and
every approval stays sealed to its call (S1–S6 unchanged). What changed is
how approvals are presented and recovered from.

- **Decline copy (R15b).** `call_tool`'s declined result said only "Do not
  retry this call unless the user asks for it". Models filled the gap by
  abandoning the whole task, independent writes included (3 of 4 baseline
  fan-out episodes), or by asking the user to confirm a change the user had
  just asked for in the decline note. The copy now scopes the refusal to
  that call, forbids a repeat or a workaround, makes a note that asks for a
  change actionable, asks for the independent rest, and asks for a report.
  A first version said only "carry on with the rest"; models then announced
  a cancelled step as done, so it now says to skip what only makes sense if
  the call had run. Pass on the tier went from 15/20 to 18/20 on the default
  routing, at the same cost per episode.
- **Refusals restated on machine results (R15b).** A completed
  `execute_machine` result showed only the machine's output, which is
  model-authored: a machine that dropped `TOOL_DENIED` (or returned `null`)
  hid the refusal, and the model told the user an email was sent that the
  user had declined. Refused calls now follow the output as a text block.
  The audit already rode in `structuredContent`, but many hosts never show
  that to the model. The same reasoning covers `isError` results of a
  resumed workflow, which now list the approved calls that already ran, so
  the model does not ask the person for the same write again.
- **No prompt for a call that cannot run (R15a).** `call_tool` already
  checked argument shape before suspending; a machine's gated `toolCall`
  did not, and one Haiku episode put 20 calls with `"[undefined]"`
  arguments to the person, each approved and then refused by the server.
  The same structural check now fails such a call as `TOOL_ERROR` before
  any prompt. Nothing executes either way, so S2 is untouched.
- **Batched prompts, opt-in (R15).** `approvalPrompts: 'batched'` puts a
  suspension's several gated calls to the person as one elicitation with
  one unticked boolean per call. `pending` stays the only source of
  executable calls, one sealed entry each, and only an exact `true` in an
  accepted answer runs a call. No crypto change; one optional blob field.
  Amended after an adversarial review (same date):
  - **The layout is sealed** (`prompts: 'batched'` in the payload, absent
    for per-call, never on a `call` blob; any other value is malformed) and
    the resume answers by the sealed value. The first version re-derived it
    from the resuming instance's option, and the batch key `approvals`
    could equal a model-chosen call id: a blob minted batched and resumed
    per-call read the batched answer as that call's own approval and ran a
    call the person had unticked.
  - **The batch key is namespaced** (`projection:approvals`), and a machine
    `toolCall` id starting with `projection:` is a `validate` error, so no
    call can be keyed where a Projection answer lives.
  - **No `default` on the checkboxes.** With `default: true`, a client that
    applies form defaults (the SDK's `elicitation.form.applyDefaults`)
    turned an empty accept into "approve all". The fields carry neither
    `default` nor `required`; an empty accept declines everything.
  - **Capped.** At most 10 calls and 20 000 characters per batched message;
    above either, the suspension falls back to per-call prompts (sealed as
    such).
  - **Refusal and already-ran blocks** render the sealed arguments through
    the integrator's redaction hook (failing closed to `[redaction failed]`),
    neutralize control, C1, separator and bidi characters (S5), and cut on
    a code-point boundary.
    The blob schema version stays 1: the field is optional, and the exact
    `libv` match already fences blobs across releases.
    It stays opt-in, not the default, because a client that accepts the form
    without the booleans declines every call (fail-closed, but a regression
    for such clients), and because on the tier models rarely request several
    gated calls in one step (default routing used `call_tool` in 19 of 20
    episodes; under forced code mode about one Haiku fan-out in three did).
    Offline it turns six prompts into one; its live effect is still
    unmeasured.

Alternatives not taken: **editable approval forms** (accept with changed
arguments) would make the approval authorize something other than the
sealed call, and so break S2's "the approval authorizes the recorded args";
a person asks for an edit through the decline `reason`, which the copy now
makes actionable. **Distinguishing cancel from decline** in the copy: R17
treats them alike, and nothing measured suggested the model should.

Update (integration with D24 and direct listing, 2026-10-30): `prompts`
is sealed only on a `machine` blob with two or more pending calls; the
sealer rejects it on `call` and `upstream_input` blobs (both minted by
`call_tool`, which never batches; an `upstream_input` blob has nothing
pending to lay out) and on a machine blob with fewer than two pending.
A machine suspension may hold a batched approval and forwarded server
questions together: the questions stay their own elicitations under
`upstream-<n>`, the resume reads both (the batch by the sealed layout, the
questions by their sealed holds), and no question answer approves a call.
Directly listed tools (`projections.direct`) call `call_tool`'s handler
with the same upstream options and client capabilities, so they inherit
forwarding, progress, cancellation, the decline copy and audit redaction.

## D26 — A HITL layer for the tool-choice eval: personas, prompt records, HITL metrics, the `hitl` tier (2026-10-31)

The harness approved everything and only counted prompts, so nothing
measured approval UX. Now:

- **Personas** (`PROJ_EVAL_APPROVER`, or a task's own): `approve-all`
  (default), `deny-destructive`, `deny-matching`, `cancel` (after N
  approvals), `edit`. A persona reads only the prompt text and schema, as a
  person would: the tool and arguments it judges are parsed from the text.
  `edit` accepts with changed content when the schema has the field;
  Projection's schema carries only `reason` (S2), so it declines with the
  requested change as the reason.
- **Direct mode gets a simulated host gate** when an approver is set: every
  call that is not `readOnlyHint: true` is shown to the same persona first,
  with a host-style prompt (tool, server, arguments, destructive marker) and
  a host-style refusal text. Without it direct mode would execute every
  refused write and could not be compared. It is generous to direct mode: a
  real host may not mark destructive tools.
- **Every prompt and answer is recorded** on the episode
  (`elicitations`), and **HITL metrics** are computed per episode and
  summarised per cell: prompts per task, per gated call (batching) and per
  ideal gated write; clarity (the text names the box and the tool, shows
  every argument value the call sends, or a faithful prefix with a
  truncation marker, and flags destructiveness exactly when the tool
  declares it), checked only where the real call is known (the host gate,
  a `call_tool` request, or an approved code-mode call matched to its
  execution by agreeing arguments); and denial handling (no repeat of a
  refused call beyond one retry, no workaround through another call, the
  final answer says what was not done, the independent parts got done).
- **The `hitl` tier** (opt-in, not held out): five workplace-world write
  tasks, each with a persona. Success needs the end state and the denial
  handling. Offline tests run a reference, a naive retry, a workaround and a
  silent final answer for each, in direct and Projection modes.

## D27 — Integration security fixes: forwarded-form mimicry, direct-listing annotations, R15b on every failure, question blobs inherit expiry (2026-10-30)

An adversarial review of `integration-hillclimb` found four gaps where two
merged features met. Each fix keeps the stricter reading.

- **Forwarded forms vs. batched approvals (S6, R64.5).** The look-alike
  check matched only a leading `⚠`, `Approve` or `Tool:`, written for the
  per-call prompt. The batched prompt (D25) titles its fields `[k] ⚠
Approve: …` and names them `approve_<n>`, so a server question could
  reproduce it: `[1] ⚠ Approve: …` titles, `Approved:` or `1. Approve:`
  headings, enum values shown raw, and fields named `approve_1` or
  `Approve_delete_repo`. Now the check skips any leading `[k]`, digits,
  glyphs and punctuation, matches every `approv…` word and a `⚠` anywhere,
  and also runs on option values, untitled field names and string
  defaults. Option values are always shown by a title (marked when needed);
  look-alike defaults are dropped because a value cannot be marked; the
  approval forms' own field names (`approve_<n>`, `reason`) are dropped
  outright. Marking, not dropping, is the rule for labels, so an honest
  form that says "Approval date" stays usable, marked.
- **Direct-listing annotations (R35, S5).** A mediated `<alias>__<tool>`
  advertised the server's own annotations, while `call_tool` carries none.
  A host that auto-runs read-only tools would skip its own prompt on the
  server's word, even where Projection asks (an `ask` override) or refuses.
  The listing now advertises only what Projection decided:
  `readOnlyHint: true` only for an `auto` call the server also marks
  read-only and not destructive, `destructiveHint: true` only as a warning,
  nothing that reassures (`destructiveHint: false`, `idempotentHint`,
  `openWorldHint`) and no annotation `title`.
- **R15b after a suspension begins.** Failures raised while building the
  next suspension (the R18 trip cap, an unknown tool, a question that cannot
  be forwarded, an oversized blob) returned a bare error. The model re-ran
  the workflow and the person was asked again to approve a write that had
  already run. Every such failure now carries the "already done" and
  refusal blocks.
- **Question blobs inherit expiry (R38, R64.3).** Each forwarded round
  minted an `upstream_input` blob with a fresh `callTtlMs`, so an approval
  could live `maxRoundTrips × callTtlMs`. The blob now keeps the `exp` of
  the blob it continues (`buildBlobPayload`'s `notAfter`). A replay cache is
  recommended wherever forwarding is on.

## D28 — `projections.direct` defaults to `'auto'` (2026-10-30)

Context. Direct listing (`projections.direct`, `facade/direct.ts`) shipped
as an opt-in exploration: each wrapped tool also listed as a mediated
facade tool (`<tool>` on a single-server facade, `<alias>__<tool>` on a
multi-server one), a thin alias of `call_tool` under the same gate. The
hill-climb then ran it live, on the corrected harness, against the
five-tool surface. Haiku on the multi tier went from 33/34 at $0.022 per
episode to 34/34 at $0.011. Haiku on the held-out workplace tier went from
23/28 at $0.048 to 27/28 at $0.023. Sonnet on the multi tier was level on
both pass rate and cost. The one cost found: on multi-hard, Sonnet spent
17% more per episode when the listed boxes went unused, since their
definitions are paid for on every turn whether or not the task touches
them.

Decision (PRD R1, R32, R43). `projections.direct` defaults to `'auto'`.
When the estimated definitions of the wrapped tools fit
`directBudgetTokens` (default 8 000 estimated tokens), they are listed
directly; on a multi-server facade the budget is filled box by box,
smallest box first, and the other boxes keep their `search_<alias>`.
Listed tools stay mediated: validation, policy, the approval prompt, the
sealed blob and the result are `call_tool`'s, and the advertised
annotations are Projection's own (D27). `'auto'` stays off when the
catalog projection is off. `projections: { direct: false }` restores the
five-tool surface.

Why the default and not an opt-in: the gain is largest for the cheaper
model and for small catalogs, which is where most integrators start, and
the loss is bounded by the budget. A catalog large enough for search to
matter is never listed. R1's rule is unchanged in substance: the wrapped
tools are still never passed through. What changed is that a mediated
alias may carry the tool's name.

Consequences.

- The default tool list now depends on catalog size. A small server
  shows its tools by name plus `describe_tool`, `call_tool` and code mode,
  without `search_tools`. A large server shows the five tools, as before.
  Tests that are about the search surface pin `direct: false`.
- Integrators who prefer a fixed, catalog-independent surface (a host
  whose own tool search defers tools, or a token budget per turn) set
  `direct: false`. Those who wrap several boxes, with only some used per
  task, pay for the listed boxes on every turn: that is the multi-hard +17%
  case.
- The eval harness pins `direct: false` in its `projection` and
  `projection-boxes` modes, and in the offline search evals, so they keep
  measuring the search surface and stay comparable with earlier rounds.
  The `projection-auto` mode measures the new default.
- Adding a tool to a wrapped server can cross the budget and switch its
  facade from direct listing to search. The listing is decided at wrap
  time, like the rest of the catalog (R47), so a facade does not switch
  mid-session.

## D29 — Pass on the signals the server already sent: defaults, partial results, text as text (2026-10-30)

Context. Live eval traces on Haiku 4.5 showed failures where the wrapped
server had told the facade what the model needed and the facade dropped it
before the model saw it. A search tool's `limit` defaulted to 10; the
sanitizer removed `default`, the model omitted `limit`, received 10 of 40
documents and acted on them as the whole set. Each mechanism below is
general: it reads only the schema, the arguments and the result, and works
for any MCP server.

Decision 1 — keep scalar schema defaults (PRD R34). `default` joins the
sanitizer's allowlist, as a scalar only: a finite number, a boolean,
`null`, or a string of at most 64 characters with no control, bidi or
invisible character. A string that would need neutralizing is dropped
rather than shown altered, since the point is that the model reads the
value the server applies. Object and array defaults stay dropped: they are
free-form server data, and the scalar case is the one that changes what a
call returns. `describe_tool` restates the top-level defaults on one line
after the input schema (`Defaults the server applies when an argument is
omitted: "limit" = 10.`), and typegen documents each kept default as
`@default <JSON value>` on the property, through the same `safeDefault`
rule. Directly listed tools carry the default in their sanitized
`inputSchema`.

Decision 2 — a partial-result signal (PRD R35.6). The facade attaches
notes to a successful result: at most three single lines, printed by
`call_tool` between its head line and the body, returned in
`structuredContent.notes`, delivered to a machine on `TOOL_RESULT.notes`,
and restated after a completed `execute_machine`'s output (at most ten,
tool-prefixed), since the output is the model's own and the traces showed
machines that counted a page and returned the count. The detectors are
`catalog/result-notes.ts`: a total-like integer larger than the one
top-level array; an array exactly as long as the effective page size (the
argument sent, else the kept default); and short side text beside
`structuredContent` that is neither JSON nor a prose restatement of its
values. The notes sit above the body so the server's own text cannot be
placed before them; every server-controlled fragment is quoted on one
line.

Rejected, for false positives: any `/count|total/i` key (`unread_count`,
`total_pages` and `errorCount` are not the size of the array beside them;
the total-like key set is closed); results with several arrays (which one
the total counts is a guess); `has_more`/`nextCursor` fields (the model
already sees them in the body, and their naming varies too much to quote
reliably); and passing on every side text (a prose summary like "Oslo:
21C, clear" beside `{ city, tempC, sky }` is a mirror, and on every call
it would cost tokens and teach the model to skip notes).

Decision 3 — text as text, and computation to machines.

- `call_tool` prints a top-level string of three or more lines in a
  structured result as its own lines, indented under its quoted key below
  the JSON, with `[string: N lines, shown as text below]` in its place (at most
  five fields). As a JSON string a file's contents was one line of `\n`
  escapes, which the model had to unescape to count or quote lines.
  `structuredContent.output` is unchanged.
- A machine receives a single text block holding JSON for an object or an
  array parsed, as `TOOL_RESULT.result`, with the text on
  `TOOL_RESULT.text`. Many servers return their data only as JSON text, and
  machines looped over the characters of a string. This changes what an
  existing machine sees: one that called `JSON.parse(event.result)` now
  throws. The alternatives were a second field (`event.json`), which the
  traces suggest models would not find, or parsing in the introspector,
  which would also change `call_tool`'s `output` and its raw text
  rendering, which models read well. The raw text stays available, scalars
  and invalid JSON stay strings, and raw content arrays are untouched.
  The authoring contract, the generated `.d.ts` header, the example and
  `describe_tool`'s undeclared-output line say so.
- The routing copy (single- and multi-server preambles, the direct-listing
  preamble, `call_tool`'s pointer and the routed `execute_machine`
  description) names computing over a list — counting, filtering, summing,
  comparing or checking every item — as a reason for a machine. Traces
  showed the model adding up a long result by hand and getting it wrong.
  One clause, about 95 characters, in each.
- The auto-run call cap's error breaks the segment's executed calls down
  by tool (`— so far: 50 calls to "<tool>" (all failed, first error:
"…")`), and when every call to the most-called tool failed, its hint
  says retrying will not get further. The bare "more than 50 calls…
  batch the work" sent the model to batch a loop whose every call was
  being rejected.

Consequences. The routing copy grows by about 20 tokens per sentence that
carries it; the prefix stays below Haiku's 4 096-token cache minimum, as
before. The `tools.d.ts` header gains five comment lines. `call_tool` results and completed
`execute_machine` results may carry `notes`; a machine's `TOOL_RESULT` may
carry `notes` and `text`. Machines that parsed JSON text themselves must
drop the `JSON.parse` — a minor-version change.

Amendments (2026-10-31, review of the v0.9 climb).

- Notes are per segment. A completed `execute_machine` restates the notes
  of the segment that completed it; notes from a segment before an
  approval round trip are not sealed into the blob, so a workflow that
  resumes does not restate them. The machine still received them on
  `TOOL_RESULT.notes` in their own segment. Sealing them would grow the
  blob with server-derived text for a rare case; this is a known
  limitation.
- The server-note detector reads only the first eight text blocks, and
  walks the structured value once, iteratively, counting every node it
  visits against its 500-node budget. It used to walk the whole value once
  per text block and count only leaves, so 40,000 one-character blocks
  beside 40,000 empty arrays took about 20 s of CPU.
- JSON text nested deeper than 64 brackets is not parsed for a machine
  (nor for the notes): it reaches the machine as the string it is. A
  1,000-deep array overflowed the stack and crashed the segment.
- Events go into the machine's VM as a JSON string it parses
  (`JSON.parse`), not as an object literal in generated source: in a
  literal, a server's `__proto__` key set the prototype, so
  `{"__proto__": {"approved": true}}` read as `event.result.approved ===
true` with no own key. It is now an own key, as in
  `structuredContent.output`.

## D30 — Many gated calls in one round trip (`toolCalls`), and copy that says what it means (2026-10-30)

Context. A live eval on Haiku 4.5 asked for 14 writes. The machine looped
over the items with one gated `toolCall` per state, so each write cost one
approval round trip. The workflow hit the `maxRoundTrips` cap (8) after 8
writes and failed with a `terminal` error, and the model told the user the
task was complete. R15 already batches every gated call a machine has
outstanding at once into one suspension, but the only way to have several
outstanding was parallel regions, one region per call, written by hand for
a fixed number of items.

Decision (PRD R7, R15). The `@astral-mcp/tools` prelude exports
`toolCalls(name, argsList, { id }?)`: one action that queues one call per
item, with ids `<id>#0`, `<id>#1`, … in list order (`<id>` defaults to the
tool name), so the author can map an answer back to its item. `argsList` is
an array of plain objects or a function of the action arguments returning
one. Every item is checked like `toolCall`'s arguments before any is
queued, so a bad item queues nothing. An empty list queues nothing either,
so no event arrives; the contract's example leaves the state with an
`always` transition that compares the answers counted with the list's
length, which also covers the empty case. `whenCallIn(id)` is the guard
for every event of one `toolCalls`. Each call is still its own sealed
`pending` entry with its own verdict (S2); only the number of round trips
changes. Under `approvalPrompts: 'batched'`, up to 10 of them share one
prompt (D25).

Authoring contract rule 5 says each pause is one approval round trip, that
a workflow gets at most `maxRoundTrips` of them (the facade's clamped
value, quoted), and shows the pattern in twelve lines using the facade's
own gated sample tool. The `tools.d.ts` header names `toolCalls` in two
comment lines.

No new cap. The host has no limit on how many gated calls one suspension
holds; what bounds it is the R23 blob ceiling (each pending entry carries
its arguments), and for calls that run without approval
`maxReadCallsPerSegment`. Both fail with a structured error, never by
dropping calls. Above 10 calls, a batched layout falls back to per-call
prompts for all of them, as before. Two gated calls in flight under one id
are now a `validate` error: before, the second silently replaced the first
in the sealed map, which could happen when a `toolCalls` without an
explicit id met a `toolCall` default id (`write_file#1`).

Rejected: a `callIndex` field on events. The index is in the `callId`
already, a field would have to be parsed from ids the host does not
otherwise interpret, and plain `toolCall` ids of the form `name#N` would
grow an index that means nothing.

The round-trip limit's copy (PRD R18). The `terminal` error read
`this workflow reached the limit of 8 round trips …` with the hint
`Restructure the machine …`, followed by the R15b list of calls that had
already run. The model took the list for the work and the error for a
detail. Both sites (`mrtr/adapter.ts`: refusing the next suspension, and
resuming a blob minted under a higher cap) now share one text:

- message: `this workflow stopped unfinished: it reached the limit of N
round trips (approvals and forwarded server questions), so the machine
did not reach its final state`
- hint: `The calls the machine had not made yet were not made. Tell the
user the task is incomplete, or finish it: issue the remaining gated
calls together with toolCalls (one round trip for all of them), leaving
out the ones listed as already done, or make them with call_tool.`

The resume site used to throw before the audit was read, so it listed
nothing; it now carries the same "Already done before this error" list.

The text-field marker (PRD R35.5, amends D29). `call_tool`'s marker read
`[N lines, shown as text below]` under a `"key" (N lines):` header. A
Sonnet trace read that as a list: its machine treated the field as an
array of content blocks and miscounted. Both now name the type —
`[string: N lines, shown as text below]` and `"key" (string, N lines):` —
so the reader knows `result.key` is one string.

Consequences. The contract grows by about 280 tokens. A machine that
already used parallel regions is unchanged. Tests that matched the old
round-trip copy match the new one.

Amendment (2026-10-31): `toolCalls` ids are `<id>*0`, `<id>*1`, …, not
`<id>#k`. With the default `<id>` (the tool name) they were the same
strings as a plain `toolCall`'s default ids (`<name>#<n>`, a running
count), so `toolCall('write_file', …)` beside `toolCalls('write_file',
[a, b])` gave two calls the id `write_file#1`, and `whenCallIn('write_file')`
also matched the plain call's events. `whenCallIn(id)` now matches the
prefix `<id>*` only. An explicit `{ id }` gets the same separator, so the
rule is one rule. Machines match events to items by `event.args` (D31),
so no code needs the separator.

## D31 — Every tool event carries its call's `args` (2026-10-30)

Context. In a live eval a model used `toolCalls` and mapped each answer
back to its item with `nums[Number(callId.split('#')[1]) - 1]`, taking the
ids for 1-based (they are 0-based), and posted 9 comments on the wrong pull
requests. D30 had rejected an index field because the index is in the id;
the trace shows that index arithmetic on ids is the footgun.

Decision (PRD R7, R15; amends D30). `TOOL_RESULT`, `TOOL_ERROR` and
`TOOL_DENIED` each carry `args`: the arguments of the call they answer.
For a gated call they are the sealed `pending` arguments (S2), so the
event names what actually ran or was declined, not what the restored
machine might compute now. Every site that answers a specific call sets
them: a read run at once, an approved call run on resume, a decline, a
policy denial (first segment, resume, and a re-issued held call), an
R15a validation error, a refused forwarded question, and an upstream
failure. Errors that abort the workflow (caps, unknown tool) answer no
call and send no event, as before.

Contract rule 4 lists the field with one clause: match a result to its
item by `args`, not by order or id. Rule 5 drops "call k gets the id
'<id>#k'" and its example records `event.args.path` per answer; the
contract is a few characters shorter than before. The `tools.d.ts` header
says the same in its `toolCalls` lines. Ids are unchanged.

Order. Events need not arrive in list order: within one segment the host
answers calls in the order they were queued, but a `toolCalls` item that
fails the R15a check answers in the first segment while its siblings
answer after the round trip, and a call held for a forwarded server
question (G1) answers after the calls that did not need one. Matching by
`args` is correct under any order; `fan-out.test.ts` covers the first case.

Size. Nothing new is sealed: the blob stores `pending` (with its args) and
the machine snapshot, never events, and resume builds each event from the
sealed record. An event's `args` are the request's own object sent back
into the VM, bounded as the request was (sandbox memory, and for a gated
call the R23 blob ceiling).

## D32 — Search hits show how to call them; argument errors carry the signature (2026-10-31)

Context. On the v13 dev tiers (basecamp harness) every upstream
`call_tool` cost the model about one `search_<box>` plus 0.6–1.2
`describe_tool` calls: Haiku on `multi-hard` averaged 11.5 API turns, 2.78
of them `describe_tool` and 5.22 `call_tool`. On held-out servers
Projection took about twice the turns of direct mode (9.0 vs 4.9), and with
prompt caching a large direct tool list is cheap, so each extra turn — the
whole prompt re-sent — ate the token savings. The search page could not be
acted on: `search_github {query: "create issue"}` answered 25 one-liners
with no arguments, so a `describe_tool` turn always sat between the search
and the call.

Decision (PRD R29, R33, R35.1, R35.5; amends D10/D22's page shape).

- **Signatures on the top hits.** The first three hits of a query
  (`SIGNATURE_HITS`) carry a compact call signature, one line under the
  entry: `args: {method: "create"|"update", owner: string, repo: string,
title?: string, perPage?: number = 30}` — required arguments first, then
  optional ones, with types, enums (at most 12 members) and the scalar
  defaults R34 keeps (D29). Only the top level: a nested object or
  array-of-objects shows as `object` / `object[]`, and the line ends with
  `(describe_tool has the full schema)`, or with `(call describe_tool
first: …)` when a required argument is the nested one. Optional
  arguments stop at 480 characters (`…N more`). `structuredContent` entries
  carry the same `signature: { text, complete, callable }`. No signature on
  a listing without a query (catalog order says nothing about intent), past
  rank 3, or for a tool policy blocks.
- **Why three.** On the D22 offline corpus (1,173 cases) the tool the
  model went on to use ranks 1st in 75.5 % of cases, top 3 in 89.9 % (93.4 %
  of the recorded queries) and top 5 in 92.8 %. Two more signatures would
  buy 2.9 points on every search; a signature has a median of 109
  characters (~27 tokens) over the GitHub tools, against ~800–1,400 tokens
  for a `describe_tool` answer plus the turn that fetches it.
- **Query pages hold 15.** A ranked page holds 15 tools (a listing still
  50). The gold tool is in the top 15 in 96.6 % of cases and the top 50 in
  97.7 %; every row past the 15th cost ~30 tokens on every search that had
  it. The rest is a cursor away.
- **Self-correcting errors.** A `validate` error from `call_tool` (or a
  machine's `toolCall`) restates the signature: `"github.issue_write" takes
args: {…}. Fix argument "owner" and try again.` An `upstream` failure
  does too, because the server enforces what the shallow R35.1 check lets
  through (nested fields, formats, names the schema does not forbid). A
  call made without `describe_tool` costs at most one retry, where it used
  to cost a `describe_tool` turn and a retry.
- **Copy.** The preambles, the search and call descriptions and the page
  footer say a tool shown with its args can go straight to `call_tool`, and
  `describe_tool` is for any other tool or for what an argument means.

Measured offline (chars / 4; retrieval metrics unchanged, R@1 75.5 %, R@5
92.8 %, MRR 0.831). Mean first page over the corpus: 748 → 507 tokens
(github 788 → 577, multi:github 816 → 613, synthetic 1,046 → 442; the small
boxes grow by the signatures: mongo 233 → 307, multi:mongo 161 → 244, fs
339 → 391). One search each: `search_github "create issue"` 832 → 642,
`"list pull requests"` 1,301 → 805, `"comment on a pull request"` 1,616 →
641, `"search code"` 557 → 648; `search_mongo "find documents"` 222 → 314,
`"list collections"` 175 → 212. A `describe_tool` answer the signature
replaces costs 801–1,392 (github `list_pull_requests`, `issue_write`) and
885 (mongo `find`). Signatures are complete for 84 of the 95 GitHub tools,
17 of 21 MongoDB and 13 of 14 filesystem tools, and callable without
`describe_tool` for all but the seven whose required argument is nested
(`push_files`, `create_repository_ruleset`,
`check_dependency_vulnerabilities`, `aggregate`, `create-index`,
`explain`, `edit_file`); two GitHub tools are cut for length. The surface
table's sample search page: github 956 → 711, mongodb 208 → 301, multi 1,225
→ 738. Tool definitions grew ~40 tokens, the preambles 10–40.

S5. Signatures are built from the sanitized schema only (R34's allowlist,
neutralized strings, `safeDefault`). Property names are server data: a
plain identifier prints bare, anything else JSON-quoted after
neutralization, a name over 64 characters is left out rather than cut (a
cut name is a wrong key); a type word outside the JSON Schema vocabulary
prints as `any`. The line is ours, indented under the entry it belongs to,
after the posture label: a hostile schema cannot forge an entry or a
posture. Approval, gating and the posture labels are unchanged; a signature
grants nothing — the call still goes through `call_tool`'s gate.

Rejected: argument descriptions in the signature (they are most of a
`describe_tool` answer's size, and `describe_tool` serves them; D33 brings
back a capped gloss for the ones a call cannot do without); signatures on every
hit (a 15-row page of them costs more than the `describe_tool` it saves);
rejecting unknown arguments the schema does not forbid (D9: the server is
the authority).

Amendment (2026-10-31): a property name or an enum member that holds a
zero-width character (U+200B–U+200F), a word joiner or invisible operator
(U+2060–U+2064), a BOM (U+FEFF) or a tag character (U+E0000–U+E007F) shows
it as a visible JSON `\uXXXX` escape (a surrogate pair for a tag character, so a name copied into arguments decodes to the server's own), in the signature and so in argument-error
hints. Printed as is, `"pa\u200Bth"` looked like `path` and the model
sent the wrong name; stripped, it would still be the wrong name.

## D33 — Signed hits gloss the required arguments their names do not explain (2026-10-31)

Context. D32's `args:` line cut `describe_tool` calls by about 80 % and
cost by 7–18 %, but it carries names and types, not meanings. Sonnet read
`rename-collection args: {connectionId: string, database: string, …}`,
invented `connectionId: "default"`, got an upstream error and gave up;
before D32 it had called `describe_tool` and read that `connectionId` is
"the id returned by one of the connect tools, or \"preconfigured\"". GitHub
has the same kind of argument (`sha` takes a branch or tag name too;
`after` takes the previous page's `endCursor`). The error hint restated
only the signature, so the retry had nothing new to go on.

Decision (PRD R33, R35.1, R35.5; amends D32).

- **Glosses on the signed hits.** Each hit that shows an `args:` line (the
  first three of a query, not blocked) also carries
  `glosses: [{ name, text }]` for its _required_ arguments, rendered as one
  more indented line: `  where connectionId: "The connection to run the
operation against. Use the id returned by one of the connect tools, or
\"preconfigured\" to use…"`. A required argument is the one a call cannot
  go without, so it is the one a model invents when it cannot tell what it
  means; optional ones stay with `describe_tool`.
- **Only what the name does not say.** An argument gets no gloss when its
  description is made only of filler words (articles, prepositions,
  `name`, `number`, `id`, `value`, `new`, `required`, …) and words of the
  tool's or its arguments' names, matched as prefixes (`Repository name`
  for `repo`, `The number of the issue` for `issue_number`, `The new name
for the collection` for `newName`), when it is an `enum` or `const`
  (the line already lists the values; on the GitHub fixture those
  descriptions were a third of the gloss text and read "The method to
  execute" or listed the options again), or when it has no description.
- **Capped.** A gloss is cut at a word to 120 characters
  (`MAX_GLOSS_CHARS`), and one tool's glosses stop at 240. 120 keeps the
  median informative GitHub description whole (48 characters) and, in a
  longer one (Sentry's median is 124, MongoDB's `connectionId` 173), the
  instruction in its first sentences; past it are option lists and
  examples.
- **Once per page.** A gloss already on the page (same argument, same
  words) is not repeated on a later hit, so a MongoDB page pays for
  `connectionId` once. `structuredContent` keeps every hit's glosses.
- **Errors gloss what was sent.** An `upstream` rejection's hint adds the
  glosses of the arguments the call sent, optional ones included (`after`,
  `cursor`, `perPage`), at up to 240 characters each:
  `… takes args: {…}, where sha: "Commit SHA, branch name, or tag name".
Fix them and try again, …`. A `validate` hint glosses the argument it
  names. A rejection is rare and is exactly where the meaning was missed.

Why three hits, not just the first. Measured offline (chars / 4, D22
corpus, 1,173 cases; retrieval unchanged): glossing only rank 1 adds a
mean 16 tokens (median 0) and reaches the gold tool with a gloss in 38.1 %
of cases; ranks 2–3 add 6.5 points for 21 more tokens a page, about 325
tokens per extra case reached, against 800–1,400 for the `describe_tool`
answer (plus the turn) or the failed call it replaces. And a signed hit
without its meaning invites the same invented value.

Measured. Mean first page 507 → 539 tokens (median +31.5, p90 +83): github
577 → 622, multi:github 613 → 661, mongo 307 → 360, multi:mongo 244 → 289,
fs 391 → 392, synthetic 442 (no glosses). Surface table's sample search
page: github 711 → 744, mongodb 301 → 338, multi 738 → 771. Tools with at
least one gloss: GitHub 42 of 95 (57 glosses), MongoDB 20 of 21 (26), fs 1
of 14, synthetic 0 of 1,003; the summit fixtures Slack 3 of 8, Stripe 4 of
22, Notion 17 of 24, Sentry 52 of 66.

S5. A gloss is the server's text, built from the R34-sanitized schema (so
`description` was already neutralized, and the 16 KB cap may have dropped
it): invisible characters stripped, whitespace collapsed to one line,
control and bidi characters neutralized, raw text read to 2,000 characters
at most, then capped. Each is JSON-quoted on our own indented `where` line
under the entry, so it cannot end its quote and pass for another
argument's gloss, open a line, or forge an entry or a posture. A name
over 64 characters gets no gloss, as it gets no place in the signature.

Rejected: a gloss on optional arguments on the search page (over the
GitHub tools their glosses come to 9,640 characters against 3,504 for the
required ones); a first-sentence rule (the
instruction in `connectionId` is in its second); glossing every hit.

## D34 — A box's shared arguments are shown once, at the head of its pages (2026-10-31)

Context. D32/D33 cut `describe_tool` calls by 60–100 %, but the v15
transcripts show another wasted turn in most MongoDB episodes: the model
lists the box (`search_mongo {}`), whose one-liners carry no arguments,
then calls `mongo.list-databases` with `{}` or an invented
`connectionId`, reads the `validate` hint's gloss ("Use … or
\"preconfigured\"") and retries. The argument it lacked is the one almost
every tool of the box requires. Many servers work this way: MongoDB's
`connectionId` / `database` / `collection`, GitHub's `owner` / `repo`,
Sentry's `organizationSlug`, Slack's `channel_id`.

Decision (PRD R33, R44; amends D32, D33).

- **Shared arguments.** Per box (a single server is one box), a required
  argument is shared when at least half of the box's deduplicated tools,
  and at least three, require it under the same name with the same
  rendered type (`SHARED_ARG_SHARE = 0.5`, `MIN_SHARED_ARG_TOOLS = 3`). It
  must be flat (no nested shape, no cut enum, not `any`) and have no
  default; a name typed differently across tools counts only the tools of
  its most common type. At most four (`MAX_SHARED_ARGS`), most shared first,
  their `{…}` capped at 240 characters. Each carries the D33 gloss that at
  least half of the tools sharing it give it (so a per-tool description such
  as Slack's "The ID of the channel containing the thread" is not promoted).
- **At the head of the page.** A search page leads, above its `Tools …`
  header, with one line per box it shows calls for:
  `Shared args (most mongo tools take them): {connectionId: string,
database: string, collection: string}, where connectionId: "The
connection to run the operation against. Use the id returned by one of
the connect tools, or \"preconfigured\" to use…"` — on a listing page
  for every box with a tool on it (a listing has no `args:` lines, so this
  is what the model builds a call from), on a query page for every box
  with a signed hit (an unsigned hit is not called from the page), never
  for a box listed directly (its schemas are in the tool list). A hit's
  `where` line leaves out a gloss the shared line shows (D33's once per
  page).
- **Signed hits name them.** A signed hit's text writes a required shared
  argument whose type matches the line's by name alone:
  `args: {connectionId, database, collection, newName: string, dropTarget?:
boolean = false}`. `structuredContent` keeps the whole signature and
  every gloss, so a client reading the structure loses nothing.
- **Not on the shelf.** v16 first also put one `  shared args: {…}` line
  under each searched box on the shelf. Round v16 measured it: MongoDB
  call errors fell 47 → 16, but Haiku asked the user "which database and
  collection should I query?" before calling any tool (global-who-is-grace,
  2 of 6, never before), and its multi pass fell 50 → 46. On the shelf,
  required arguments read as facts the model must already have before it
  acts. The line was removed (v16b); the shared arguments lead the box's
  pages only.

The threshold. Run over every offline catalog, the arguments that recur
are required by 58–95 % of their box's tools — GitHub `owner` 63/95 (66
%), `repo` 55/95 (58 %); MongoDB `connectionId` 20/21, `database` 19/21,
`collection` 15/21 (71 %); filesystem `path` 11/14 (79 %); synthetic `id`
590/1,003 (59 %); Sentry `organizationSlug` 46/66 (70 %); Slack
`channel_id` 5/8 (63 %) — and the next most required by at most 25 %
(Notion `page_id` and `block_id` 6/24, Slack `thread_ts` 2/8, GitHub
`method` 15/95); Notion and Stripe have none. Anything from a third to a
half separates them; a half is the one the copy can state honestly
("most … tools take them"). Glossed: MongoDB `connectionId` and Sentry
`organizationSlug` (46 of 46 give the same gloss); GitHub `owner` gets
none (49 of its 63 descriptions restate the name).

Abbreviation, measured (D22 corpus, 1,173 cases, chars / 4, retrieval
unchanged: R@1 75.5 %, R@5 92.8 %, MRR 0.831). Mean first page: v15 539;
shared line with full signatures 560; names only 551; `...shared` (one
spread token for a tool that takes them all, names otherwise) 549. The
spread form saves two more tokens a page on average (12 on the MongoDB
box) but makes the model expand a token into arguments, and a tool that
takes only some of them still needs the names; names alone keep every
argument a call needs on the hit's own line. Chosen: names.

Measured (names). Mean first page 539 → 551 (github 622 → 630,
multi:github 661 → 669, mongo 360 → 372, multi:mongo 289 → 303, fs 392 →
400, multi:fs 414 → 422, synthetic 442 → 454). Box listing (first page,
no query): `search_mongo {}` 585 → 647 tokens (the line with the
`connectionId` gloss, +62), `search_github {}` 3,298 → 3,316, global
`search_tools {}` 1,495 → 1,513; single-server `search_tools {}` mongodb
549 → 611, github 1,413 → 1,431. Query pages: `search_mongo "list
collections"` 249 → 268, `"rename collection"` 534 → 544, `search_github
"create issue"` 673 → 683. Multi-server system prompt (shelf) 504 → 535
tokens in `projection` mode, 493 → 524 in `projection-boxes` (two lines,
github and mongo; fs is listed directly); single-server prompts unchanged.
The +62 on the MongoDB listing stands against the extra turn the
rejected `list-databases` call cost (the whole prompt re-sent, plus the
error).

S5. Computed from the R34-sanitized schemas only, as signatures and
glosses are. Names print as a signature prints them (a plain identifier
bare, anything else JSON-quoted after neutralization; over 64 characters
never shared), types are the signature's, and glosses are D33's (one
line, invisible characters stripped, neutralized, cut, JSON-quoted). The
line is ours, starts with our own words, and sits above the `Tools …`
header, so a hostile schema cannot forge an entry, a posture or a header;
on the shelf it is an indented line under the box's own line. A hostile
server can fill only its own box's line, within the caps. Approval and
gating are unchanged: the line grants nothing, and a call still goes
through `call_tool`'s gate.

Rejected: glosses on the shelf (the gloss is ~30 tokens per box in every
prompt, and the box's first page shows it); a one-third threshold (the
same arguments on these catalogs, and "most" would no longer be true);
dropping the shared arguments from the hits altogether (a tool that takes
only some of them, like `list-databases`, would no longer say which).

## D35 — A text field is printed verbatim in a fence, not indented (2026-10-31)

Context. D29 prints a top-level string of three or more lines (a file's
contents, a document body) below the JSON as its own lines, indented four
spaces like the other untrusted blocks. Models copy the indent. Writing a
file back after reading it, Haiku 4.5 wrote `    - buy milk` for `- buy
milk`. Across rounds v13-bc to v16b, 4–7 episodes a round wrote
indented content to a file, and 1–3 of them failed on it
(cross-email-to-todo, fs-append-todo). These were most of Haiku's
multi-tier failures.

Decision. The block is printed verbatim, with no indent, between two
lines of backticks under a header that says so: `"content" (string, 10
lines, verbatim between the ``` lines):`. The fence is one backtick
longer than the longest backtick run in the text, and at least three. So
the server's text cannot close it and continue as facade copy (S5), which
was the only work the indent did. The JSON marker is unchanged. The
`renderedSize` estimate now counts the header and fences.

Rejected: keeping the indent and telling the model to strip it (copy
does not fix a copying habit); a fixed fence such as `<<<`/`>>>` (the
server could print it); printing the text raw with no fence (a line
of the file could pass as facade copy).

Amendments (2026-10-31, review of the v0.9 climb).

- Tabs are kept inside the fence. "Verbatim" was not true: the
  neutralizer turned every tab into `�`, so a Makefile's `\tcc main.c`
  or a TSV row came back corrupted when a model wrote it back. A tab
  cannot start a line or close a fence, so `neutralizeControlChars` has
  an `allowTab` option, used for fenced text only; every other control
  and bidi character is still neutralized. Outside a fence a tab is a
  JSON `\t` escape, as before.
- A raw content array (several blocks, or blocks that are not text) is
  printed block by block, and its text blocks and embedded text resources
  are now fenced the same way, under `[text, verbatim between the ```
lines]` and `[embedded resource "<uri>" ("<mime>"), text verbatim
between the ``` lines]`. Printed raw at column 0, a block could forge
  another call's `call_tool "…": ok` head. A single text block is still
  printed raw, as before D35.
- `renderedSize` charged every string, at any depth, for a fence and a
  header (about 106 characters), so `{ ids: [2,500 short strings] }`
  estimated at 307k and was truncated under the 256 KB `maxResultBytes`.
  It now charges the fence, header and marker only where
  `structuredBody` prints them: a top-level field of a record with at
  least three lines, at most five. There it charges three fence lengths
  (the header names the fence, then the two fence lines), the quoted key
  (cut at 200) and a fixed margin; every other string costs its
  JSON-escaped length, counted without building it. Each container's
  closing line now counts its indent too. A test holds the estimate at or
  above the rendered body for a set of shapes. A content array's estimate
  adds each fenced block's fences and header.
