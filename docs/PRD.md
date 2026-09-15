# PRD — Projection

**A TypeScript library that turns any MCP server into a code-mode server with human-approved side effects, built on MCP 2026-07-28 MRTR and XState.**

Status: Draft for team review · Package: `@astral-mcp/projection` (npm + GitHub reserved) · Owner: TBD · Target spec: MCP 2026-07-28 (final)

---

## 1. Summary

Projection wraps an existing MCP server (or a remote connection to one) and exposes a minimal code-mode surface: one tool that executes an LLM-authored XState v5 state machine inside a QuickJS WebAssembly sandbox, and one tool that returns generated TypeScript type definitions describing the wrapped server's tool API.

The machine orchestrates calls to the wrapped server's tools. Read-only tool calls execute immediately. Any non-read-only tool call suspends the machine, serializes its snapshot into a sealed opaque blob, and returns an MRTR `InputRequiredResult` asking the human to approve the action. When the client retries the call with the approval and the echoed `requestState`, the library rehydrates the machine from the blob and continues exactly where it left off.

Because all suspension state travels in the MRTR payload, the library is fully compatible with stateless, horizontally scaled deployments: any server instance can resume any workflow.

## 2. Background and motivation

The code-mode pattern (one execute-code tool instead of N tools) reduces context bloat, lets models compose multi-step workflows in a single call, and keeps intermediate data out of the model's context. Its historical weakness is side-effect safety: once code is running, every write it performs is invisible until it is done.

MCP 2026-07-28 removes that weakness. The spec is stateless at the protocol core, and Multi Round-Trip Requests (MRTR, SEP-2322) let a `tools/call` return `resultType: input_required` with a map of `inputRequests` (elicitation or sampling requests) and an opaque `requestState` blob. The client gathers answers and re-issues the original call — original arguments included — with `inputResponses` and the echoed state. This gives us, for free: (a) mid-execution human approval without holding a stream open, (b) the original code re-delivered on every resume, and (c) a spec-blessed vehicle for carrying serialized machine state.

XState v5 is the execution substrate because its actors are designed to be persisted and restored (`getPersistedSnapshot()` / `createActor(machine, { snapshot })`), because explicit states make write actions statically auditable, and because denial of an approval becomes an ordinary transition the machine can handle gracefully.

## 3. Goals

G1. Wrap any MCP server — from a server class instance in-process, or from a remote server via `tools/list` introspection — into a code-mode server with no changes to the wrapped server.

G2. Execute LLM-authored XState v5 machines (JS or TS) in an isolated QuickJS sandbox with hard resource caps.

G3. Gate every non-read-only tool invocation behind an MRTR elicitation approval, with suspend/resume carried entirely in the signed, encrypted `requestState` blob.

G4. Operate correctly on stateless infrastructure: no server-side session store, no sticky routing; any instance can resume any suspended workflow.

G5. Provide a fast reactive self-healing loop: malformed or invalid code returns structured `isError` results rich enough for the model to correct and retry, with no host-side type checking in the hot path.

G6. Ship a `discover_apis` tool that returns generated `.d.ts` files and the authoring contract so the model can write correct code on the first or second attempt.

## 4. Non-goals

N1. No host-side TypeScript type checking before execution (explicitly rejected for latency; see G5).

N2. No general-purpose plain-JS execution mode in v1. The only accepted program shape is an XState v5 machine conforming to the authoring contract.

N3. No network access from the sandbox. `fetch` is never injected, regardless of configuration.

N4. No durable server-side persistence of workflow state. State lives in the blob or nowhere.

N5. MCP Apps / SSR UI rendering is a stretch goal (Section 12), not a v1 requirement.

N6. No filesystem surface for authored code in v1 (see R9, Section 12.3), and no mid-run sampling requests (deprecated; see Q2).

## 5. Users

The **integrating developer** installs the library, points it at their MCP server, and configures policy and limits. The **model** (any MCP client's LLM) calls `discover_apis`, authors a machine, and calls `execute_machine`, self-correcting from structured errors. The **end user** sees approval prompts rendered by their MCP client from our elicitation requests and approves or declines individual actions.

## 6. Product requirements

### 6.1 Exposed tool surface

R1. The library MUST expose exactly two tools by default: `execute_machine` and `discover_apis`. The wrapped server's own tools MUST NOT be exposed directly to the client.

R2. `execute_machine` accepts `{ code: string, lang?: "ts" | "js", input?: object }` where `input` is passed as the machine's input. The tool description MUST summarize the authoring contract and point to `discover_apis`.

R3. `discover_apis` returns a compact inline overview (pinned XState version, allowed imports, the tool-call event protocol, serializability rules) plus one `resource_link` content block per artifact: each generated `.d.ts` file and each example machine (at minimum one happy path and one handling a denied approval). The server declares the `resources` capability and serves these at stable URIs (e.g. `projection://types/tools.d.ts`, `projection://examples/denial-fallback.ts`) via `resources/read`, letting the model pull full contents only when it wants them. Resources and list responses SHOULD carry cache hints (`ttlMs`) keyed to the wrapped server's tool list. The inline overview MUST be sufficient to author a simple machine unaided, so clients with weak resource support still function.

R4. Type generation MUST support two sources: direct extraction from an in-process server instance (preferred fidelity, e.g. Zod schemas → types) and JSON Schema conversion from a remote `tools/list`. Tool names are namespaced into a single `tools` API surface importable as `@astral-mcp/tools`.

R29. The library forwards the wrapped server's `instructions` field verbatim, then appends a short (2–3 sentence) code-mode preamble explaining that tools are invoked by authoring a state machine via `execute_machine`, that non-read-only actions will pause for user approval, and that `discover_apis` describes the API. The preamble is library-supplied copy, overridable by the integrating developer.

R30. The internal tool catalog, generated types, and blob format MUST NOT assume a single wrapped server. The catalog is keyed by server alias (v1 ships with exactly one, default alias omitted from generated type paths for ergonomics), and the blob records the server identity it was minted against. This keeps the door open for the multi-server stretch goal (Section 12.2) without a v2 blob-format break.

### 6.2 Authoring contract (what the LLM must write)

R5. The submitted module's top level MUST only define and default-export a machine created with XState v5 `setup(...)`/`createMachine(...)`. Top-level side effects are rejected at validation, because the module is re-evaluated from the re-sent `code` argument on every resume.

R6. Machine `context` MUST be JSON-serializable at all times. Validation round-trips a snapshot through JSON to enforce this before first execution.

R7. Tool calls MUST NOT be modeled as invoked promise actors (`fromPromise` wrapping a tool call is a banned pattern — restored snapshots restart invoked actors, which would re-execute approved writes). Instead, the contract provides a library-supplied action creator: the machine emits `toolCall(name, argsFromContext)` and waits in a state for `TOOL_RESULT`, `TOOL_ERROR`, or `TOOL_DENIED` events. The host — not the machine — performs all I/O.

R8. The sandbox mounts a pinned XState v5 build at `xstate` and the generated bridge at `@astral-mcp/tools`. No other imports resolve except an allowlisted set of pure utilities (TBD, e.g. none in v1).

R9. No filesystem surface is exposed to authored code in v1. The sandbox mounts only what the library itself needs internally (module resolution for `xstate` and `@astral-mcp/tools`, transpilation scratch); `node:fs` imports and FS access from authored code fail at validation. The authoring contract states plainly: all working state lives in machine context. Scratch FS is a stretch goal (Section 12.3).

### 6.3 Execution engine and resource caps

R10. Execution uses `@sebastianwessel/quickjs` (quickjs-ng WASM variants). TypeScript input is transpiled in-sandbox; there is no type checking (see G5, N1).

R11. `allowFetch` is hard-disabled. This is an invariant, not a configuration default: the tools bridge is the only I/O channel, otherwise the approval gate is bypassable via arbitrary HTTP.

R12. Default resource caps, all configurable downward and clamped at the stated maxima:

| Cap                                               | Default | Hard max |
| ------------------------------------------------- | ------- | -------- |
| Wall-clock per execution segment (per round trip) | 30 s    | 60 s     |
| WASM memory                                       | 128 MB  | 256 MB   |
| Submitted code size                               | 128 KB  | 256 KB   |
| Machine input (JSON serialization size)           | 128 KB  | 256 KB   |
| Read-only tool calls per segment                  | 50      | 200      |
| MRTR round trips per workflow                     | 8       | 16       |
| Machine events processed per segment              | 10 000  | 50 000   |
| Final result payload                              | 256 KB  | 1 MB     |
| Machine state nodes (static count at validation)  | 100     | 1 000    |
| Captured console output per segment               | 64 KB   | 256 KB   |

R13. Interrupt handlers enforce the wall-clock budget inside the VM (not only around it), so tight loops cannot outrun the host timer. Each MRTR resume gets a fresh segment budget.

### 6.4 Approval policy and MRTR flow

R14. Default policy derives from tool annotations on the wrapped server: `readOnlyHint: true` → execute immediately; annotation absent or `readOnlyHint: false` → require approval. Annotations are hints from a possibly third-party server, so the integrating developer can override per tool: `auto`, `ask` (default for unannotated), or `deny`. `destructiveHint: true` tools SHOULD render with stronger warning language in the elicitation.

R15. On suspension, the library returns `resultType: input_required` with one elicitation entry per pending tool call. When the machine reaches a state (including parallel states) with multiple pending gated calls, all of them MUST be batched into the single `inputRequests` map for one round trip.

R16. Each elicitation MUST present a CONCISE, human-readable summary aimed at a non-technical approver: lead with a plain-English action (the tool's annotation title, else its humanized id) and a one-line purpose (the first sentence of the wrapped server's tool description), then the fully resolved arguments as readable details. The exact tool id and the requesting machine state are included compactly (a footer), not dumped — the full model-facing tool description MUST NOT be rendered verbatim. A redaction hook lets the integrating developer mask sensitive argument fields before they leave the server.

R17. On retry, an approved request executes the tool call and delivers `TOOL_RESULT` (or `TOOL_ERROR` if the underlying call fails) to the rehydrated machine. A declined request delivers `TOOL_DENIED` with the decline reason if provided. A request missing from `inputResponses` is treated as declined. The workflow then continues; denial is not an automatic abort.

R18. Exceeding the round-trip cap, or receiving a retry after blob expiry, terminates the workflow with a structured terminal error naming the cause.

### 6.5 Suspension blob (`requestState`)

R19. The blob is versioned, authenticated, and encrypted (AEAD, e.g. AES-256-GCM with an HKDF-derived key). Encryption is required, not optional, because machine context may contain data returned by read-only tool calls that would otherwise never transit to the client in code mode.

R20. Blob payload fields:

| Field                 | Purpose                                                                     |
| --------------------- | --------------------------------------------------------------------------- |
| `v`                   | Blob schema version; unknown versions are rejected with a terminal error    |
| `libv` / `xstatev`    | Library and XState versions that produced the snapshot                      |
| `codeHash`            | SHA-256 of the original `code` argument; the retried call's code must match |
| `snapshot`            | `getPersistedSnapshot()` output of the machine actor                        |
| `pending`             | Map of inputRequest key → gated tool call (name, args) awaiting a verdict   |
| `trip`                | Round-trip counter for R18                                                  |
| `nonce`, `iat`, `exp` | Replay scoping and expiry (default TTL 15 min, configurable)                |

R21. On resume the library MUST verify, in order: decrypt/authenticate, version compatibility, expiry, and `codeHash` equality against the re-sent code — then re-evaluate the module, restore the actor from `snapshot`, and inject verdict events. Any verification failure is a terminal structured error; the library never executes gated calls from an unverified blob.

R22. Keys are provided by the integrating developer (env/config) and MUST be shared across instances of a horizontally scaled deployment. Key rotation with a grace window (accept N previous keys for decryption) is required.

R23. Serialized-and-compressed blob size SHOULD stay under 32 KB in typical flows; exceeding a configurable ceiling (default 128 KB) fails the suspension with an error advising the model to slim its context.

### 6.6 Validation and reactive self-healing

R24. Before first execution of any submitted code, the library runs a validation pass inside the sandbox: transpile (if TS), evaluate the module, confirm a default-exported v5 machine, reject banned patterns (R5, R7), count state nodes against the R12 cap, and round-trip a serializability probe (R6). Validation shares the segment budget; it is not a separate round trip.

R25. Every failure — transpile, validation, runtime exception, cap exceeded, blob verification — returns a normal tool result with `isError: true` and a structured body: `{ phase, message, diagnostics[], hint, logs[] }`, where `hint` is a one-line actionable fix (e.g. "Tool calls must use the toolCall action, not fromPromise; see discover_apis"). The design goal is that the model can rewrite and resucceed in one attempt without any human involvement.

R31. The sandbox captures all `console.log/info/warn/error/debug` output as structured entries `{ level, message, ts, segment }` and includes them in **every** result — success, `isError`, and alongside `input_required` suspensions — so the model can printf-debug its own machines. Capture is capped per the R12 table with an explicit truncation marker (drop middle, keep head and tail). Logs are execution telemetry only: they are never rendered into elicitation prompts (see S6) and are not persisted in the blob — each segment's logs ship in that segment's response.

R26. There is no compile-only or lint-only tool in v1. Validation always runs as the front of `execute_machine`, keeping the surface at two tools and the loop reactive.

### 6.7 Statelessness

R27. The library holds zero cross-request state. All resume information rides in `requestState`; all configuration is process-static. Compatibility target: plain round-robin load balancing per the 2026-07-28 transport model, including the `Mcp-Method`/`Mcp-Name` routing headers emitted by the host SDK.

R28. Down-negotiation: when a client speaks a pre-2026-07-28 revision without MRTR, `execute_machine` MUST still function for fully read-only machines and MUST fail fast with a clear error the moment a gated call would suspend, naming the required protocol revision. Amendment (see DECISIONS.md D6): the integrator MAY opt in per facade (`compat.legacyElicitation`) to serving suspensions to legacy clients through the SDK's server→client `elicitation/create` shim; the shim's re-invocation carries the same `requestState` echo and `inputResponses` as an MRTR retry, so S2–S4 verification is unchanged. The opt-in only functions on held connections (stdio); per-request legacy HTTP serving has no server→client channel and fails cleanly. Fail-fast remains the default.

## 7. Architecture

Seven components, cleanly separable for parallel workstreams:

**Introspector** — connects to the wrapped server (instance or remote), reads `tools/list`, annotations, and `instructions`, maintains the tool catalog. Interfaces accept a set of aliased server connections even though v1 instantiates exactly one (R30). **Typegen** — produces `@astral-mcp/tools` runtime bridge + `.d.ts` from the catalog (Zod path and JSON-Schema path). **Sandbox runtime** — `@sebastianwessel/quickjs` lifecycle, module mounting, caps, interrupts, marshaling. **Machine host** — evaluates the module, validates the contract, drives the actor, translates `toolCall` effects into host-side execution or suspension, injects result/verdict events. **Policy engine** — annotation defaults plus developer overrides; decides auto/ask/deny per resolved call. **Blob sealer** — snapshot packaging, AEAD, versioning, verification. **MRTR adapter** — maps suspensions to `InputRequiredResult`, parses `inputResponses` on retry, enforces trip caps; the only component touching the MCP SDK's transport types.

Dependency notes: pin XState v5.x exactly (snapshot compatibility across minor versions must be verified in CI before bumping); pin the quickjs-ng WASM variant; target the 2026-07-28 TypeScript SDK stable line.

## 8. Key flows

**Happy path, no writes.** Client calls `execute_machine`. Validation passes; machine runs; all tool calls are read-only and execute inline; machine reaches final state within budget; result returns as `resultType: complete`.

**Single approval.** Machine emits a gated `toolCall`. Host snapshots the actor, seals the blob, returns `input_required` with one elicitation. Client shows the prompt; user approves; client retries with the response and echoed blob. Library verifies (R21), restores, executes the write, injects `TOOL_RESULT`, machine runs to completion.

**Denial with fallback.** As above, but the user declines. `TOOL_DENIED` is injected; the machine transitions to its authored fallback branch (e.g. record "skipped", continue) and completes. The final result includes a per-call approval audit trail.

**Batched approvals.** A parallel state gates three writes; one `input_required` carries three keyed elicitations; the retry carries three verdicts; each maps to its own event.

**Self-heal.** Submitted code uses v4 `Machine()` syntax. Validation fails in ~tens of milliseconds; `isError` result with phase `validate` and a v5 hint returns; model rewrites; second call succeeds.

**Expiry / tamper.** Retry arrives after TTL or with a modified blob: verification fails, terminal structured error, no side effects executed.

## 9. Security invariants

S1. The tools bridge is the only I/O channel out of the sandbox (no fetch, no host FS, no env beyond an explicit allowlist). S2. No gated tool call ever executes without a verified approval verdict bound to that exact call (name + args captured in the sealed `pending` map — the approval authorizes the recorded args, not whatever the resumed machine asks for next). S3. Blobs are authenticated and encrypted; clients are treated as honest-but-curious couriers. S4. `codeHash` binding prevents resuming a snapshot under different code. S5. Annotations from third-party wrapped servers are untrusted hints; unannotated tools default to `ask`. S6. Elicitation text is derived only from server-side data (catalog descriptions + resolved args through the redaction hook), never from model-authored free text, to prevent the machine from writing its own misleading approval prompt.

## 10. Success metrics

First-attempt valid-machine rate ≥ 60% and ≤ 2 attempts to valid ≥ 90% (measured against a benchmark suite of task prompts across 3 frontier models). Validation latency p95 < 250 ms. Suspend→resume overhead (blob seal + verify + rehydrate) p95 < 100 ms. Zero gated executions without a matching verified approval in adversarial test suite. Median blob size < 8 KB on benchmark workflows.

## 11. Open questions

Q1. ~~Scratch FS across suspensions?~~ **Resolved:** no FS surface in v1 at all (R9); ephemeral scratch FS and any blob-persisted delta move to stretch (Section 12.3).
Q2. ~~Mid-run sampling requests?~~ **Resolved:** out of scope — sampling is deprecated; the machine host's event protocol leaves room to add new event kinds later if the spec replaces it with something worth supporting.
Q3. ~~Snapshot migration across XState upgrades?~~ **Resolved:** strict `libv`/`xstatev` rejection is sufficient (R20/R21); no migration hook. Blobs are short-lived (15 min TTL), so a deploy simply fails the few in-flight workflows with a clean terminal error and the model re-runs.
Q4. ~~Should `discover_apis` expose resources?~~ **Resolved:** yes — discover returns `resource_link` blocks backed by `resources/read` (R3).
Q5. ~~Multi-tenant key derivation?~~ **Resolved for v1:** single developer-supplied key (R22 rotation grace window retained); local-first deployment is the target. Per-tenant HKDF revisits if/when a hosted deployment exists.
Q6. ~~Cap machine complexity at validation?~~ **Resolved:** yes — a static state-node count during validation (essentially free; it's a tree walk on the already-instantiated machine definition), default 100, clamped at 1 000 (R12 table). Runtime event caps remain the true safety net.

## 12. Stretch goals (not in v1; v1 architecture must not preclude them)

### 12.1 MCP Apps rendering

The 2026-07-28 spec ships MCP Apps (server-delivered HTML in a sandboxed iframe) as an official extension, and `@sebastianwessel/quickjs` can plausibly run `react-dom/server` for SSR. Two fenced use cases, in priority order: rich approval previews (render a diff/summary of a pending write instead of a bare schema form) and post-completion result dashboards. Design constraint decided now: UI-rendering code has zero access to the tools bridge and executes in a separate VM instance, so rendering can never become an approval bypass. `execute_machine` MAY later accept an optional `ui` argument; absent in v1.

### 12.2 Multiple wrapped servers

One code-mode facade over N upstream servers, so a single machine can orchestrate across, say, GitHub + Slack + Postgres. v1 lays the groundwork (R30: aliased catalog, server-bound blobs, `tools.<alias>.<name>` namespacing reserved) but implements none of the hard parts: per-server auth contexts, partial-availability semantics when one upstream is down mid-workflow, merged `instructions`, and cross-server approval batching UX. Do not build; do not break.

### 12.3 Scratch filesystem

Expose the sandbox's virtual FS to authored code as ephemeral per-segment scratch, with a size-capped FS delta optionally serialized into the blob for cross-suspension persistence. Deferred because "all state in context" is a simpler contract for the model and keeps blobs small; revisit if benchmark workflows show context bloat from large intermediate data.

### 12.4 Per-user upstream OAuth

**Not the stretch goal:** a service-identity OAuth upstream works today — the integrator connects an SDK `Client` with an auth provider on its transport (client-credentials grant, provisioned refresh token) and wraps it. Design constraint already holding by construction, kept normative here: **upstream credentials never enter the sandbox, the blob, or any model-visible surface.** S1 makes the tools bridge the machine's only I/O, so authored code names tools while the host-side executor makes the authenticated call; a hostile machine cannot exfiltrate a token it never touches. Upstream auth expiry surfaces as an ordinary `TOOL_ERROR` event; token refresh is the transport auth provider's job.

**The stretch goal** is on-behalf-of access: each end user's own identity reaching the upstream (user A's GitHub, not the service's). Three coupled pieces, none built in v1:

1. **Per-principal upstream connections.** The introspector holds one connection made at wrap time; per-user auth needs connections resolved per principal at call time. This is the same seam multi-server needs (12.2 / R30 aliases) — design the connection-context refactor once for both.
2. **Principal-bound blobs.** An approved blob must resume only under the principal that approved it, or user A's approved workflow could execute under user B's token. Adopt the SDK requestState codec's `bind` concept (deferred in DECISIONS.md D1); this is a blob-format change gated on the fuzz/tamper suites and a version bump.
3. **Token residence.** Stateless resume (R27) means every instance needs the principal's token. Preferred: a server-side token store keyed by principal — the first shared state R27 admits, chosen over serializing refresh tokens into the AEAD blob (architecturally purer, but it makes the client a courier of their own upstream credentials and stretches revocation windows; rejected unless an adversarial review overturns this).

**Authorization as a suspension** (the MRTR-shaped part): an upstream 401 with `WWW-Authenticate` is semantically an approval — the workflow cannot proceed without a human acting. Suspend over MRTR with an elicitation directing the user to authorize out-of-band; the retry finds a fresh token via (3). No held connections, R27 preserved. S6 caveat decided now: the authorization URL originates from a third-party server and MUST be rendered with the same inert-text discipline as all other untrusted catalog data.

## 13. Verification and test plan

**Smoke-test matrix.** Source candidate servers from the Glama directory (https://glama.ai/mcp/servers) and pin a narrow initial set of three, chosen for shape diversity rather than coverage — long-term goal is "any server," v1 goal is "these three, flawlessly":

1. **Official filesystem reference server** — local stdio, well-annotated, genuinely destructive writes (delete/move). Exercises annotation-driven policy and destructive-warning copy.
2. **GitHub MCP server** — large remote API surface, rich JSON Schemas, mixed read/write. Stresses typegen fidelity, catalog size, and batched approvals (e.g. "label these 4 issues").
3. **A Postgres/database server** — the adversarial policy case: a `query` tool whose arguments are opaque SQL, where `readOnlyHint` can't be trusted to bound behavior. Exercises developer overrides (force `ask`) and proves the policy engine handles tools whose safety isn't knowable from annotations.

Additionally, one deliberately _unannotated_ server (any small community server) verifies the default-`ask` posture (R14, S5).

**Automated harness.** A test harness drives the wrapped server end-to-end using the Anthropic TypeScript SDK as the reasoning loop and the MCP TypeScript SDK as the client: scripted task prompts → model authors machines → harness auto-answers elicitations per scenario script (approve all / deny one / ignore one / tamper with blob / replay expired blob). Assertions cover the S1–S6 invariants, self-heal attempt counts (Section 10 metrics), and blob-size budgets. Runs in CI against the pinned smoke-test servers with recorded fixtures where upstreams are flaky.

**Manual TUI.** A thin terminal client (e.g. Ink or pi/clack-based) for exploratory testing: pick a wrapped server, type a task, watch the model's code + validation results + captured console logs stream by, and approve/deny pending elicitations interactively with single keys. Displays blob size and trip count per suspension. This doubles as the demo surface for the team.

## 14. Milestones (swarmable workstreams)

**M1 — Sandbox + Typegen (parallel):** QuickJS runtime with caps/interrupts and module mounting; typegen from Zod and JSON Schema; golden-file tests for `.d.ts` output.
**M2 — Machine host + validation:** authoring contract enforcement, banned-pattern detection, `toolCall` protocol, structured `isError` shape, self-heal benchmark harness.
**M3 — Suspend/resume:** blob sealer (AEAD, versioning, rotation), MRTR adapter on the 2026-07-28 SDK, batching, trip caps, expiry, adversarial tests for S1–S6.
**M4 — Policy + DX:** annotation policy engine and overrides, redaction hook, elicitation copy, `discover_apis` content, docs and examples.
**M5 — Hardening:** load tests on multi-instance stateless deploy, blob-size and latency budgets, down-negotiation behavior (R28), fuzzing the blob parser.
**MT — Test harness + TUI (parallel from M2):** Anthropic-SDK-driven agent loop, scenario scripts, smoke-test server fixtures, Ink TUI with interactive approve/deny. Grows alongside M2–M4 so every feature lands with a scenario.
**Stretch — MCP Apps and multi-server** per Section 12.

M1 and M2 can start immediately and in parallel; MT starts as soon as M2 has a callable surface; M3 depends on M2's host interface; M4 depends on M1's catalog and M3's flow; M5 gates release.
