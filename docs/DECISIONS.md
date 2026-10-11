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
