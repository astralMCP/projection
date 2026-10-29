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
`assertApprovalsMode`. The per-source mode of a multi-server facade will be
an optional field of the same context.

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
