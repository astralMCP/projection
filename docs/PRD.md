# PRD — Projection

**A TypeScript library that wraps any MCP server in code mode (LLM-authored XState workflows) and a tool catalog (search, describe, call), with human-approved side effects, built on MCP 2026-07-28 MRTR and XState.**

Status: Living requirements, implemented through the current release · Package: `@astral-mcp/projection` (npm) · Target spec: MCP 2026-07-28 (final)

"v1" in this document means the scope the PRD commits to, not a package version (the package is 0.x).

---

## 1. Summary

Projection wraps an existing MCP server (or a remote connection to one) and exposes two small projections of it: **code mode** — `execute_machine`, which runs an LLM-authored XState v5 state machine inside a QuickJS WebAssembly sandbox, and `discover_apis`, which returns generated TypeScript type definitions describing the wrapped server's tool API — and the **catalog projection** (`search_tools`, `describe_tool`, `call_tool`). Five tools in all, never the wrapped server's own.

The machine orchestrates calls to the wrapped server's tools. Read-only tool calls execute immediately. Any non-read-only tool call suspends the machine, serializes its snapshot into a sealed opaque blob, and returns an MRTR `InputRequiredResult` asking the human to approve the action. When the client retries the call with the approval and the echoed `requestState`, the library rehydrates the machine from the blob and continues exactly where it left off.

Because all suspension state travels in the MRTR payload, the library is fully compatible with stateless, horizontally scaled deployments: any server instance can resume any workflow.

Alongside code mode, the same facade exposes a **catalog projection** (§6.8): `search_tools`, `describe_tool` and a polymorphic `call_tool` for single actions and for servers whose tool surface is too large to describe up front. Both projections run through one policy engine, one approval path and one blob sealer, so a direct call is gated exactly like a step inside a machine.

## 2. Background and motivation

The code-mode pattern (one execute-code tool instead of N tools) reduces context bloat, lets models compose multi-step workflows in a single call, and keeps intermediate data out of the model's context. Its historical weakness is side-effect safety: once code is running, every write it performs is invisible until it is done.

MCP 2026-07-28 removes that weakness. The spec is stateless at the protocol core, and Multi Round-Trip Requests (MRTR, SEP-2322) let a `tools/call` return `resultType: input_required` with a map of `inputRequests` (elicitation or sampling requests) and an opaque `requestState` blob. The client gathers answers and re-issues the original call — original arguments included — with `inputResponses` and the echoed state. This gives us, for free: (a) mid-execution human approval without holding a stream open, (b) the original code re-delivered on every resume, and (c) a spec-blessed vehicle for carrying serialized machine state.

XState v5 is the execution substrate because its actors are designed to be persisted and restored (`getPersistedSnapshot()` / `createActor(machine, { snapshot })`), because explicit states make write actions statically auditable, and because denial of an approval becomes an ordinary transition the machine can handle gracefully.

## 3. Goals

G1. Wrap any MCP server — from a server class instance in-process, or from a remote server via `tools/list` introspection — into code mode and a tool catalog with no changes to the wrapped server.

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

N5. MCP Apps rendering beyond the static workflow dashboard (approval previews, SSR) is a stretch goal (§12.1).

N6. No filesystem surface for authored code in v1 (see R9, §12.3), and no mid-run sampling requests (deprecated; see Q2).

## 5. Users

The **integrating developer** installs the library, points it at their MCP server, and configures policy and limits. The **model** (any MCP client's LLM) calls `discover_apis`, authors a machine, and calls `execute_machine`, self-correcting from structured errors — or, for a single action, finds the tool with `search_tools`/`describe_tool` and runs it with `call_tool`. The **end user** sees approval prompts rendered by their MCP client from our elicitation requests and approves or declines individual actions.

## 6. Product requirements

Requirement numbers are stable identifiers, not an ordering; R29–R31 sit with the section they belong to.

### 6.1 Exposed tool surface

R1. The library exposes two projections of the wrapped server over one facade, both on by default: **code mode** (`execute_machine`, `discover_apis`) and the **catalog projection** (`search_tools`, `describe_tool`, `call_tool`; §6.8). The integrating developer MAY disable either projection: `WrapOptions.projections?: { codeMode?: boolean; catalog?: boolean }`, each default `true`; both `false` is a `terminal` `ProjectionError` at wrap time. The wrapped server's own tools MUST NOT be exposed directly to the client: `call_tool` is a mediated entry point that validates, applies policy and binds approval to the exact call, never a pass-through. The facade also serves the `projection://` resources (R3) and two prompts (prompts: code mode only), `save-workflow` and `visualize-workflow` (D8).

R2. `execute_machine` accepts `{ code, lang?, input? }`. `lang` defaults to `"js"`; TypeScript syntax requires `lang: "ts"` (transpiled, not type-checked, R10). `input` is passed as the machine's input. A completed run returns `structuredContent { output, approvals, logs }`, where `approvals` is the audit trail `[{ callId, tool, args, decision: auto | approved | declined | denied_by_policy | error, reason? }]`, plus a text rendering of `output` and any console output. The tool also carries `_meta.ui.resourceUri` for MCP Apps hosts (D5). The description MUST summarize the authoring contract and point to `discover_apis`.

R3. `discover_apis` returns a compact inline overview (pinned XState version, allowed imports, the tool-call event protocol, serializability rules) plus one `resource_link` content block per artifact: `tools.d.ts`, the authoring contract (`projection://docs/authoring-contract.md`) and the example machines (`happy-path.ts`, `denial-fallback.ts`). The server declares the `resources` capability and serves these at stable URIs (`projection://types/tools.d.ts`, `projection://examples/denial-fallback.ts`, …) via `resources/read`, letting the model pull full contents only when it wants them. The facade also serves `ui://projection/dashboard.html` (D5), which `discover_apis` does not link. Cache hints are not set; the SDK default (`ttlMs` 0) applies. The inline overview MUST be sufficient to author a simple machine unaided, so clients with weak resource support still function.

R4. Types are generated from the wrapped server's `tools/list` JSON Schemas. An in-process `McpServer` is introspected over an in-memory transport exactly like a remote `Client`, so there is one path (a hand-rolled JSON Schema → TypeScript converter that degrades unsupported constructs to `unknown`). Tool names are namespaced into a single `tools` API surface importable as `@astral-mcp/tools`.

R29. The library forwards the wrapped server's `instructions` field verbatim, then appends a short (2–3 sentence) preamble that states the **routing rule** between the two projections: a single action goes through `call_tool` (with `search_tools` / `describe_tool` to find the tool and its arguments); several steps, branching on results, or a workflow worth saving are authored as a state machine and run with `execute_machine` (after `discover_apis`); and either way any non-read-only action pauses for user approval. When a projection is disabled the preamble describes only the one that is on. The preamble is library-supplied copy, overridable by the integrating developer (`codeModePreamble` replaces the whole preamble, whichever projections are on).

R30. The internal tool catalog, generated types, and blob format MUST NOT assume a single wrapped server. The catalog is keyed by server alias (v1 ships with exactly one, default alias omitted from generated type paths for ergonomics), and the blob records the server identity it was minted against. This keeps the door open for the multi-server stretch goal (§12.2) without a blob-format break.

### 6.2 Authoring contract (what the LLM must write)

R5. The submitted module's top level MUST only define and default-export a machine created with XState v5 `setup(...)`/`createMachine(...)`. A tool call requested at module top level is rejected (phase `validate`), because the module is re-evaluated from the re-sent `code` argument on every resume.

R6. Machine `context` MUST be JSON-serializable at all times. Validation round-trips a snapshot through JSON to enforce this before first execution. Only the initial context is probed; a non-JSON value introduced later is not detected and degrades at seal time under JSON semantics (`undefined` and functions dropped, `Date` to string, `Map`/`Set` to `{}`).

R7. Tool calls MUST NOT be modeled as invoked promise actors (any `invoke` in the machine config is rejected at validation — restored snapshots restart invoked actors, which would re-execute approved writes). Instead, the contract provides a library-supplied action creator: the machine emits `toolCall(name, argsFromContext)` and waits in a state for `TOOL_RESULT`, `TOOL_ERROR`, or `TOOL_DENIED` events. The host — not the machine — performs all I/O. Result events carry the call's `callId`; `toolCall` accepts `{ id }` and the bridge exports `whenCall(id)`, a guard for machines with several calls outstanding (parallel regions), because XState delivers an event to every region that can handle it.

R8. The sandbox mounts a pinned XState v5 build at `xstate` and the generated bridge at `@astral-mcp/tools`. The only other specifiers that resolve are the pure utilities the QuickJS runtime boots with — `buffer`, `util`, `url` and the `@node_compatibility/*` shims (`event-target`, `headers`, `request`, `response`) — none of which perform I/O; every other import fails at validation with a structured error. The authoring contract tells models only `xstate` and `@astral-mcp/tools` resolve.

R9. No filesystem surface is exposed to authored code in v1. The sandbox mounts only what the library itself needs internally (module resolution for `xstate` and `@astral-mcp/tools`); `node:fs` imports and FS access from authored code fail at validation. The authoring contract states plainly: all working state lives in machine context. Scratch FS is a stretch goal (§12.3).

### 6.3 Execution engine and resource caps

R10. Execution uses `@sebastianwessel/quickjs` (quickjs-ng WASM variants). TypeScript input is transpiled on the host with the TypeScript compiler API (syntax only, `ts.transpile`) before the VM starts; there is no type checking (G5, N1).

R11. `allowFetch` is hard-disabled. This is an invariant, not a configuration default: the tools bridge is the only I/O channel, otherwise the approval gate is bypassable via arbitrary HTTP.

R12. Default resource caps, all configurable downward and clamped at the stated maxima:

| Cap                                                     | Default | Hard max |
| ------------------------------------------------------- | ------- | -------- |
| Wall-clock per execution segment (per round trip)       | 30 s    | 60 s     |
| WASM memory                                             | 128 MB  | 256 MB   |
| Submitted code size                                     | 128 KB  | 256 KB   |
| Machine input (JSON serialization size)                 | 128 KB  | 256 KB   |
| Auto-run (policy `auto`) tool calls per segment         | 50      | 200      |
| MRTR round trips per workflow                           | 8       | 16       |
| Events delivered by the host to the machine per segment | 10 000  | 50 000   |
| Final result payload                                    | 256 KB  | 1 MB     |
| Machine state nodes (static count at validation)        | 100     | 1 000    |
| Captured console output per segment                     | 64 KB   | 256 KB   |

Values below a small floor (e.g. 1 round trip, 100 ms) are clamped up so a misconfiguration cannot disable the flow; non-finite values are ignored.

R13. Interrupt handlers enforce the wall-clock budget inside the VM (not only around it), so tight loops cannot outrun the host timer. Each MRTR resume gets a fresh segment budget.

### 6.4 Approval policy and MRTR flow

R14. Default policy derives from tool annotations on the wrapped server: `readOnlyHint: true` → execute immediately; annotation absent or `readOnlyHint: false` → require approval. Annotations are hints from a possibly third-party server, so the integrating developer can override per tool with `auto`, `ask` or `deny`; an override always wins and an unrecognized value fails safe to `ask`. Overrides are read once, at wrap time. Policy is re-evaluated on every resume and outranks a stale approval: a tool that is `deny` when the retry arrives yields `TOOL_DENIED` (machine) or `{ status: "denied_by_policy" }` (`call_tool`) whatever the user answered (D9). `destructiveHint: true` tools SHOULD render with stronger warning language in the elicitation.

R15. On suspension, the library returns `resultType: input_required` with one elicitation entry per pending tool call. When the machine reaches a state (including parallel states) with multiple pending gated calls, all of them MUST be batched into the single `inputRequests` map for one round trip.

R16. Each elicitation MUST present a CONCISE, human-readable summary aimed at a non-technical approver: a headline `Approve: <action>` (prefixed ⚠, with a plain warning line, for destructive tools), where the action is the tool's annotation title, else its humanized id, suffixed for method-dispatched tools with the enum-constrained `method`/`action` argument value (e.g. `Create or update issue — create`); the first sentence of the tool description, quoted and attributed ("What the server says it does: …"); the call's arguments after the redaction hook as an indented JSON block (each string capped at 512 characters, the block at 4,096, with a marker naming any argument cut off); and a compact footer: the exact tool id and, for a machine step, the requesting state as a quoted literal. The full model-facing tool description MUST NOT be rendered verbatim. A redaction hook lets the integrating developer mask sensitive argument fields before they leave the server; it receives a copy of the arguments, and if it throws, the block is replaced by `[redaction failed]`, never the arguments.

R17. On retry, an approved request executes the tool call and delivers `TOOL_RESULT` (or `TOOL_ERROR` if the underlying call fails) to the rehydrated machine. A declined request delivers `TOOL_DENIED` with the decline reason if provided (client-supplied text, neutralized and capped at 500 characters). A request missing from `inputResponses` is treated as declined. The workflow then continues; denial is not an automatic abort.

R18. Exceeding the round-trip cap is a `terminal` error; a retry after blob expiry is a `blob_verification` error. Both are structured (R25) and name their cause.

### 6.5 Suspension blob (`requestState`)

R19. The blob is versioned, authenticated, and encrypted (AEAD, e.g. AES-256-GCM with an HKDF-derived key). Encryption is required, not optional, because machine context may contain data returned by read-only tool calls that would otherwise never transit to the client in code mode.

R20. Blob payload fields:

| Field                 | Purpose                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`                   | Blob schema version; unknown versions are rejected with a `blob_verification` error                                                                                                |
| `libv` / `xstatev`    | Library and XState versions that produced the snapshot                                                                                                                             |
| `kind`                | `machine` (minted by `execute_machine`) or `call` (minted by `call_tool`); a blob opened by the other tool is rejected (R36)                                                       |
| `codeHash`            | Binding hash (S4): SHA-256 of the original `code` for `machine` blobs, of the canonical `{ kind: "call", name, args }` request for `call` blobs (R36); the retried call must match |
| `serverIdentity`      | Identity of the wrapped server the blob was minted against (R30); the resuming facade must match                                                                                   |
| `snapshot`            | `getPersistedSnapshot()` output of the machine actor (`null` for `call` blobs)                                                                                                     |
| `pending`             | Map of inputRequest key → gated tool call (name, args, requesting state) awaiting a verdict; exactly one entry keyed `call` for `call` blobs (R35.3)                               |
| `audit`               | Per-call approval audit trail accumulated in earlier segments (§8); `[]` for `call` blobs                                                                                          |
| `trip`                | Round-trip counter for R18 (always 1 for `call` blobs)                                                                                                                             |
| `nonce`, `iat`, `exp` | Replay scoping and expiry; default TTL 15 min for `machine` blobs (`blob.ttlMs`), 5 min for `call` blobs (`blob.callTtlMs`, R38), both configurable                                |

R21. On resume the library MUST verify, in order: decrypt/authenticate, version compatibility, expiry, `kind` matches the opening tool, and the binding hash matches the re-sent `code` (`machine`) or the canonical request (`call`), plus `serverIdentity` — then, for `machine` blobs, re-evaluate the module, restore the actor from `snapshot` and inject verdict events; for `call` blobs, execute the single `pending` entry per R35.4. Any verification failure is a structured `blob_verification` error; the library never executes gated calls from an unverified blob.

R22. Keys are provided by the integrating developer (env/config) and MUST be shared across instances of a horizontally scaled deployment. Key rotation with a grace window (accept N previous keys for decryption) is required.

R23. Serialized-and-compressed blob size SHOULD stay under 32 KB in typical flows; exceeding a configurable ceiling (default 128 KB) fails the suspension with an error advising the model to slim its context.

### 6.6 Validation and reactive self-healing

R24. Before first execution of any submitted code, the library transpiles (if TS) on the host, then runs a validation pass inside the sandbox: evaluate the module, confirm a default-exported v5 machine, reject banned patterns (R5, R7), count state nodes against the R12 cap, and round-trip a serializability probe (R6). Validation shares the segment budget; it is not a separate round trip.

R25. Every failure — transpile, validation, runtime exception, cap exceeded, blob verification, upstream — returns a normal tool result with `isError: true` and a structured body: `{ phase, message, diagnostics[], hint, logs[] }`, where `hint` is a one-line actionable fix (e.g. "Tool calls must use the toolCall action, not fromPromise; see discover_apis"). `upstream` is an `isError` result or transport failure from the wrapped tool, surfaced only by `call_tool` — inside a machine the same condition is a `TOOL_ERROR` event. Outcomes that are not failures — a human decline, a policy denial — are normal results: `TOOL_DENIED` in code mode, `{ status: "declined" | "denied_by_policy" }` from `call_tool` (D9). The design goal is that the model can rewrite and resucceed in one attempt without any human involvement. Phases: `transpile` (TS syntax); `validate` (contract violations, bad args, unknown tool, disallowed import, bad cursor); `runtime` (uncaught sandbox error, stuck machine); `cap_exceeded` (any R12 cap); `blob_verification` (R21/R36 failures, replay); `protocol` (era/capability, introspection); `upstream` (wrapped tool failure, `call_tool` only); `terminal` (the workflow cannot continue: trip cap, blob over the R23 ceiling, key misconfiguration, no projection enabled).

R31. The sandbox captures all `console.log/info/warn/error/debug` output as structured entries `{ level, message, ts, segment }` and includes them in every completed result, every completed result and every `isError` result (a resumed segment's logs ride its own response), so the model can printf-debug its own machines. Capture is capped per the R12 table with an explicit truncation marker (drop middle, keep head and tail). Logs are execution telemetry only: never rendered into elicitation prompts (S6) and not persisted in the blob. Exception: the 2026-07-28 `input_required` result carries only `resultType`, `inputRequests` and `requestState` (D1), so the console output of the segment that suspends is not delivered.

R26. There is no compile-only or lint-only tool in v1. Validation always runs as the front of `execute_machine`, keeping the **code-mode** surface at two tools and the loop reactive.

### 6.7 Statelessness

R27. The library holds zero cross-request state, except the optional replay cache of R38, which the integrator supplies. All resume information rides in `requestState`; all configuration is process-static. Compatibility target: plain round-robin load balancing per the 2026-07-28 transport model, including the `Mcp-Method`/`Mcp-Name` routing headers emitted by the host SDK.

R28. Down-negotiation. A client on a pre-2026-07-28 revision (no MRTR) can use every read-only path: `discover_apis`, `search_tools`, `describe_tool`, `auto`-policy `call_tool` calls, and machines whose calls are all `auto`. The moment a gated call would suspend, `execute_machine` and `call_tool` fail fast with a `protocol` error naming the required revision. Opt-in: `WrapOptions.compat.legacyElicitation` serves suspensions to legacy clients through the SDK's server→client `elicitation/create` shim (D6). The shim's re-invocation carries the same `requestState` echo and `inputResponses` as an MRTR retry, so R21 and S2–S4 are unchanged. It works only on held connections (stdio); per-request legacy HTTP has no server→client channel and fails cleanly. A client that did not declare the `elicitation` capability still gets Projection's structured fail-fast error at suspend time, not the SDK's unstructured one. Fail-fast is the default.

### 6.8 Catalog projection

The catalog projection is the second way to drive the wrapped server: three tools in a lazy-catalog shape (search → describe → call). The search/describe half mirrors deferred tool loading as in Anthropic's tool-search feature and Goose; the polymorphic `call_tool` is Projection's addition, forced by R1 — the wrapped tools must never appear as callable tools themselves. It exists for two reasons code mode does not serve well: a single action should not cost a 25-line machine, and a server with hundreds of tools cannot be described inline by `discover_apis` without flooding the context. It is deliberately not a second product: it shares the introspected catalog, the policy engine (R14), the elicitation copy (R16), the redaction hook, the blob sealer (R19–R23), the MRTR adapter and the legacy compat path (R28). Only the sandbox, the machine host and typegen's bridge are bypassed.

R32. The catalog projection consists of exactly three tools: `search_tools`, `describe_tool`, `call_tool`. It is on by default and can be disabled per facade (`WrapOptions.projections.catalog: false`, R1); disabling it leaves code mode unchanged (and vice versa).

R33. `search_tools({ query?: string, cursor?: string })` returns a page of tools in catalog order, or ranked when `query` is given. Each entry is `{ name, purpose, posture, destructive }`: `purpose` is the first sentence of the full description, neutralized and capped per S5; `posture` is one of three normative strings — `runs immediately`, `asks for approval`, `blocked by policy` — the same words every surface uses (the `discover_apis` overview and `search_tools` show them verbatim in brackets; the `.d.ts` doc comments lead each tool with them in sentence case); `destructive: boolean` comes from `destructiveHint`. Matching: the query is lowercased, NFC-normalized and split on any run of characters that are not a letter, combining mark or digit; duplicate tokens are dropped; tokens shorter than two characters are dropped, and if none survives the whole trimmed query is the single token (so `a b` matches the literal `a b`; a whitespace-only query matches nothing; an absent or empty query lists every tool). A tool matches when any token is a case-insensitive substring of its name, annotation title or full description. Matches are ranked by `2 × (tokens in the name) + (tokens in the title or description)`; the counts are independent, so a token in both name and description scores 3. Ties keep catalog order (D10). `query` is truncated at 200 characters and is never interpreted as a regex. The result carries `structuredContent: { tools: [{ name, purpose, posture, destructive }], nextCursor?, total }` plus a text rendering. Pages hold 50 tools (a fixed transport bound, independent of the R37 threshold) and carry `nextCursor` when more remain; `cursor` is opaque and bound to the `query` that produced it, so a malformed cursor or one issued for a different `query` is a `validate`-phase error. The result tells the model to call `describe_tool` before calling a tool it has not seen the schema of.

R34. `describe_tool({ name, types? })` returns everything the model needs to call one tool: the neutralized and capped description, `inputSchema` and `outputSchema` as JSON Schema, annotations, and the resolved policy posture. With `types: true` it also returns the generated TypeScript types for that tool — the `<Pascal>Input` / `<Pascal>Output` aliases and the `tools.<name>` member signature exactly as they appear in `projection://types/tools.d.ts`, so a machine authored from `describe_tool` output type-checks against the full resource. Types are opt-in because the JSON Schema already carries the shape and the types roughly double the payload; `call_tool` callers never need them. The schemas are an S5 surface in their own right: beyond `description`, a server controls free text in `title`, nested `description`, `examples`, `default`, `$comment`, `x-*`, `enum` and `pattern`. They MUST therefore pass through a key allowlist — `type, properties, required, items, prefixItems, enum, const, anyOf, oneOf, allOf, not, $ref, $defs, additionalProperties, description, title, format, minimum, maximum, minLength, maxLength, pattern` — with every string value neutralized (control and bidi characters) and the rendered schema capped at 16 KB per tool with an explicit truncation marker; `annotations.title` is neutralized the same way. An unknown name is a `validate`-phase error whose hint names the closest declared tools — the name's tokens ranked as a `search_tools` query (D10), kept only when a token matched the tool's name, at most three, neutralized and capped per S5 — and then points at `search_tools`. The result also carries `destructive` and `schemaTruncated` (true when either schema was reduced by the size, depth or name caps).

R35. `call_tool({ name, args })` runs one wrapped tool under the same gate as a machine step:

1. **Validate** the name against the catalog (an unknown name fails as in R34, with the same did-you-mean hint) and `args` structurally against `inputSchema`. `args` MUST be a JSON object (not an array or `null`) serializing to at most `maxInputBytes` (R12); larger is `cap_exceeded`. Structural checks — required properties present; top-level property types match; top-level primitive values are members of the property's `enum`; no unknown top-level properties when the schema forbids them — use own-property semantics (`__proto__` and `constructor` as keys are ordinary data). Failures are `validate`-phase errors whose hint names the offending property and points at `describe_tool`. Full JSON Schema validation is out of scope; the wrapped server remains the authority, and its rejection surfaces as an `upstream` error (R25).
2. **Decide policy** (R14). `auto` executes immediately. `deny` returns a normal (non-error) result `{ status: "denied_by_policy", tool, reason }`. `ask` suspends.
3. **Suspend** with one MRTR elicitation built by the R16 copy builder and a sealed `call` blob (R36) whose single `pending` entry is `{ id: "call", name, args, stateName: "call_tool" }` — the blob shape is unchanged. The copy builder takes an `origin` option (`"machine" | "direct"`) that selects the footer, kept plain for a non-technical approver: `Tool: <id>` for direct calls, `Tool: <id> · workflow step "<state>"` for machines. R28 and `compat.legacyElicitation` apply unchanged; an `auto`-policy `call_tool` always works on a legacy connection.
4. **Resume**: the retry re-sends `{ name, args }` and the echoed `requestState`. After R21 verification (and the R38 replay check when a cache is configured) an accepted elicitation executes the call with the args recorded in the blob's `pending` entry (S2 — never the retry's own args); a declined, missing or non-elicitation response returns a normal result `{ status: "declined", tool, reason? }` (R17 semantics). Policy is decided on the retried name before the blob is opened: a tool that is now `deny` returns `denied_by_policy` without opening the blob or spending a replay nonce (D9).
5. **Result shape**: success is `{ status: "ok", tool, output }` where `output` follows the `TOOL_RESULT.result` rule (structuredContent when present, else the single text block, else `null` / the raw content array); an upstream failure is an `isError` result with phase `upstream`. If the output's JSON exceeds `maxResultBytes` (R12) the result is still `ok` — the call ran, and an error would read as "retry" — with `output` replaced by the first 1,000 characters of that JSON, `truncated: true` and `outputBytes`. A decline is an outcome, not an error: the tool description MUST tell the model not to retry an identical call without the user asking for it. The description also points to `describe_tool` first and to `execute_machine` for multi-step work. Facade tool annotations: `search_tools` and `describe_tool` carry `readOnlyHint: true`; `call_tool` carries none, so hosts that gate on annotations never auto-run it.

R36. `call` blobs reuse the R20 payload with `kind: "call"`, `snapshot: null`, `trip: 1`, `audit: []`, all other fields as for `machine` blobs, and `codeHash` computed over the canonical JSON of `{ kind: "call", name, args }` — domain-separated from code hashes by construction, not by the accident that a machine module can never equal a JSON literal. The binding hash is a coherence check, not the approval binding: S2 is carried by `pending` alone. It exists so a result is only ever returned to the request the approver saw (a stale approved blob cannot be attached to an unrelated `call_tool` request). Canonical JSON: only object keys are sorted, by UTF-16 code unit order; array order is significant; canonicalization runs on the _parsed_ request, so `1`/`1.0`, `-0`/`0`, escaped vs literal characters and duplicate keys (last wins) canonicalize identically; no Unicode normalization is applied (NFC and NFD differ — fail closed); absent `args` ⇒ `{}`; the canonicalizer MUST throw `validate` on non-JSON values (`undefined`, functions, bigint, non-finite numbers) rather than drop them. `openBlob` already hashes a caller-supplied string, so the adapter passes the canonical text where `execute_machine` passes `code`. Verification MUST reject — as `blob_verification` errors, before anything executes — a payload without `kind` (malformed), a blob whose `kind` does not match the tool opening it, a `call` blob whose binding hash does not match the retried request, and a `call` blob whose `pending` has anything other than exactly one entry keyed `call`. `BLOB_SCHEMA_VERSION` stays 1.

R37. Catalog scale. When the catalog projection is enabled and the catalog exceeds a size threshold (default 40 tools; `WrapOptions.catalogInlineThreshold`), `discover_apis` omits the per-tool list from its inline overview and prints the tool count plus a pointer to `search_tools` / `describe_tool`; the `.d.ts` resource stays complete. Otherwise the inline overview — already one line per tool — is unchanged. The threshold is a prompt-budget bound and the R33 page size is a transport bound; the two knobs are independent.

R38. Replay cache (optional). `WrapOptions.replayCache?: { seen(nonce: string, exp: number): Promise<boolean> }`. When configured, the adapter consults it after R21 verification and before executing any gated call, for both blob kinds; a nonce already seen is a `blob_verification` error. No default implementation ships — an in-memory one would silently break horizontal scaling (G4). The nonce is recorded on first sight, whatever the verdict, so an approval blob is single-use. `call` blobs use the shorter TTL of R20 because an approved `call` blob has no forward step and is a standing capability until `exp` (D4, D9).

## 7. Architecture

Eight components, cleanly separable for parallel workstreams:

**Introspector** — connects to the wrapped server (instance or remote), reads `tools/list`, annotations, and `instructions`, maintains the tool catalog. Interfaces accept a set of aliased server connections even though v1 instantiates exactly one (R30). **Typegen** — produces `@astral-mcp/tools` runtime bridge + `.d.ts` from the catalog (JSON Schema → TypeScript). **Sandbox runtime** — `@sebastianwessel/quickjs` lifecycle, module mounting, caps, interrupts, marshaling. **Machine host** — evaluates the module, validates the contract, drives the actor, translates `toolCall` effects into host-side execution or suspension, injects result/verdict events. **Policy engine** — annotation defaults plus developer overrides; decides auto/ask/deny per resolved call. **Blob sealer** — snapshot packaging, AEAD, versioning, verification. **MRTR adapter** — maps suspensions to `InputRequiredResult`, parses `inputResponses` on retry, enforces trip caps; owns the MRTR vocabulary (`mrtr/protocol.ts`); the catalog projection builds its single `input_required` and reads its verdict through that same module. **Catalog projection** — search/describe over the catalog plus `call_tool`'s structural validation and canonical request hashing; reuses the policy engine, sealer and MRTR adapter.

Two modules sit beside them: the MCP Apps dashboard (D5) and the workflow prompts (D8).

Dependency notes: pin XState v5.x exactly (snapshot compatibility across minor versions must be verified in CI before bumping); pin the quickjs-ng WASM variant; target the 2026-07-28 TypeScript SDK stable line.

## 8. Key flows

**Happy path, no writes.** Client calls `execute_machine`. Validation passes; machine runs; all tool calls are read-only and execute inline; machine reaches final state within budget; result returns as `resultType: complete`.

**Single approval.** Machine emits a gated `toolCall`. Host snapshots the actor, seals the blob, returns `input_required` with one elicitation. Client shows the prompt; user approves; client retries with the response and echoed blob. Library verifies (R21), restores, executes the write, injects `TOOL_RESULT`, machine runs to completion.

**Denial with fallback.** As above, but the user declines. `TOOL_DENIED` is injected; the machine transitions to its authored fallback branch (e.g. record "skipped", continue) and completes. The final result includes a per-call approval audit trail.

**Batched approvals.** A parallel state gates three writes; one `input_required` carries three keyed elicitations; the retry carries three verdicts; each maps to its own event.

**Direct call, read-only.** Client calls `search_tools`, then `describe_tool({ name: "read_file" })`, then `call_tool({ name: "read_file", args })`. Policy is `auto`; the call executes inline; the result is `{ status: "ok", tool, output }` in one round trip.

**Direct call, approved.** `call_tool({ name: "write_file", args })`. Policy is `ask`; the adapter seals a `call` blob binding the canonical request, returns `input_required` with one elicitation; the user approves; the client retries with the echoed blob; verification passes (R21); the recorded args execute; `{ status: "ok", ... }`. A decline returns `{ status: "declined" }` and nothing executes.

**Self-heal.** Submitted code uses v4 `Machine()` syntax. Validation fails in ~tens of milliseconds; `isError` result with phase `validate` and a v5 hint returns; model rewrites; second call succeeds.

**Expiry / tamper.** Retry arrives after TTL or with a modified blob: verification fails with a structured `blob_verification` error; no side effects executed.

## 9. Security invariants

S1. The tools bridge is the only I/O channel out of the sandbox (no fetch, no host FS, no env beyond an explicit allowlist).

S2. No gated tool call ever executes without a verified approval verdict bound to that exact call (name + args captured in the sealed `pending` map — the approval authorizes the recorded args, not whatever the resumed machine asks for next).

S3. Blobs are authenticated and encrypted; clients carry them but can neither read nor alter them.

S4. `codeHash` binding prevents resuming a snapshot under different code. For `call_tool` the same field binds the blob to the canonical request as a coherence check (the approval itself is bound by `pending`, S2), and `kind` prevents a blob minted by one tool from being opened by the other.

S5. Annotations from third-party wrapped servers are untrusted hints; unannotated tools default to `ask`.

S6. Approval text is derived from server-side data (the catalog entry's title, first description sentence and tool id) and the call's resolved arguments after the redaction hook. The only model-authored fragments are the argument values and the requesting state name, both rendered as inert quoted data. The model can never write prose into an approval prompt.

## 10. Success metrics

First-attempt valid-machine rate ≥ 60% and ≤ 2 attempts to valid ≥ 90% (measured against a benchmark suite of task prompts across 3 frontier models; the live benchmark runs one model per invocation over 4 file-server tasks with coarser gates). Validation latency p95 < 250 ms (not currently measured). Suspend→resume overhead (blob seal + verify + rehydrate) p95 < 100 ms. Zero gated executions without a matching verified approval in adversarial test suite. Median blob size < 8 KB on benchmark workflows.

## 11. Resolved questions

Q1. Scratch FS across suspensions — no FS surface at all (R9); scratch FS is stretch (§12.3).
Q2. Mid-run sampling requests — out of scope; sampling is deprecated, and the event protocol leaves room for new event kinds.
Q3. Snapshot migration across XState upgrades — none; strict `libv`/`xstatev` rejection (R20/R21). Blobs are short-lived, so a deploy fails the few in-flight workflows with a clean `blob_verification` error and the model re-runs.
Q4. Should `discover_apis` expose resources — yes, `resource_link` blocks backed by `resources/read` (R3).
Q5. Multi-tenant key derivation — a single developer-supplied key with the R22 rotation window; per-tenant HKDF revisits if a hosted deployment exists.
Q6. Cap machine complexity at validation — yes, a static state-node count (default 100, max 1 000, R12); runtime event caps remain the true safety net.

## 12. Stretch goals (not built; the current architecture must not preclude them)

### 12.1 MCP Apps rendering

The 2026-07-28 spec ships MCP Apps (server-delivered HTML in a sandboxed iframe) as an official extension. **Shipped:** a static, library-authored workflow dashboard (`ui://projection/dashboard.html`, declared through `execute_machine`'s `_meta.ui.resourceUri`) that renders output, audit trail, logs and structured errors for app-capable hosts (D5); it is a compile-time constant with no model-authored code and no host capabilities. **Stretch:** rich approval previews (a diff or summary of a pending write instead of a bare schema form), blocked until the spec gives an `input_required` result a vehicle for an app reference, and SSR of model-authored UI (`@sebastianwessel/quickjs` can plausibly run `react-dom/server`). Design constraint decided now: UI-rendering code has zero access to the tools bridge and executes in a separate VM instance, so rendering can never become an approval bypass. `execute_machine` MAY later accept an optional `ui` argument.

### 12.2 Multiple wrapped servers

One code-mode facade over N upstream servers, so a single machine can orchestrate across, say, GitHub + Slack + Postgres. v1 lays the groundwork (R30: aliased catalog, server-bound blobs, `tools.<alias>.<name>` namespacing reserved) but implements none of the hard parts: per-server auth contexts, partial-availability semantics when one upstream is down mid-workflow, merged `instructions`, and cross-server approval batching UX. Do not build; do not break.

### 12.3 Scratch filesystem

Expose the sandbox's virtual FS to authored code as ephemeral per-segment scratch, with a size-capped FS delta optionally serialized into the blob for cross-suspension persistence. Deferred because "all state in context" is a simpler contract for the model and keeps blobs small; revisit if benchmark workflows show context bloat from large intermediate data.

### 12.4 Per-user upstream OAuth

**Not the stretch goal:** a service-identity OAuth upstream works today — the integrator connects an SDK `Client` with an auth provider on its transport (client-credentials grant, provisioned refresh token) and wraps it. Design constraint already holding by construction, kept normative here: **upstream credentials never enter the sandbox, the blob, or any model-visible surface.** S1 makes the tools bridge the machine's only I/O, so authored code names tools while the host-side executor makes the authenticated call; a hostile machine cannot exfiltrate a token it never touches. Upstream auth expiry surfaces as an ordinary `TOOL_ERROR` event; token refresh is the transport auth provider's job.

**The stretch goal** is on-behalf-of access: each end user's own identity reaching the upstream (user A's GitHub, not the service's). Three coupled pieces, none built in v1:

1. **Per-principal upstream connections.** The introspector holds one connection made at wrap time; per-user auth needs connections resolved per principal at call time. This is the same seam multi-server needs (12.2 / R30 aliases) — design the connection-context refactor once for both.
2. **Principal-bound blobs.** An approved blob must resume only under the principal that approved it, or user A's approved workflow could execute under user B's token. Adopt the SDK requestState codec's `bind` concept (deferred in DECISIONS.md D1); this is a blob-format change gated on the fuzz/tamper suites and a version bump.
3. **Token residence.** Stateless resume (R27) means every instance needs the principal's token. Preferred: a server-side token store keyed by principal — the second shared state R27 would admit, after the R38 replay cache, chosen over serializing refresh tokens into the AEAD blob (architecturally purer, but it makes the client a courier of their own upstream credentials and stretches revocation windows; rejected unless an adversarial review overturns this).

**Authorization as a suspension** (the MRTR-shaped part): an upstream 401 with `WWW-Authenticate` is semantically an approval — the workflow cannot proceed without a human acting. Suspend over MRTR with an elicitation directing the user to authorize out-of-band; the retry finds a fresh token via (3). No held connections, R27 preserved. S6 caveat decided now: the authorization URL originates from a third-party server and MUST be rendered with the same inert-text discipline as all other untrusted catalog data.

## 13. Verification and test plan

**Smoke-test matrix.** Source candidate servers from the Glama directory (https://glama.ai/mcp/servers) and pin a narrow initial set of three, chosen for shape diversity rather than coverage — the long-term goal is "any server"; the goal for these three is "flawlessly":

1. **Official filesystem reference server** — `@modelcontextprotocol/server-filesystem`, pinned, spawned over stdio; well-annotated, genuinely destructive writes (delete/move). Exercises annotation-driven policy and destructive-warning copy (`packages/harness/test/smoke/filesystem.test.ts`).
2. **GitHub MCP server** — a large remote API surface, rich JSON Schemas, mixed read/write. Stresses typegen fidelity and catalog size. Live and opt-in (`PROJ_LIVE_GITHUB=1` plus a token; `github.live.test.ts`).
3. **A SQLite server** — `mcp-sqlite`, pinned, spawned over stdio: a fully unannotated server whose `query` tool takes opaque SQL: exercises the default-`ask` posture (S5) and developer overrides (`auto` for a vouched-for read, `deny` for `query`), and proves the policy engine copes with tools whose safety isn't knowable from annotations (`sqlite.test.ts`).

A fourth smoke test, `pack-install.test.ts`, packs the library with `npm pack`, installs the tarball into a fresh project and runs a machine end to end — the only check that catches works-in-workspace, broken-when-published bugs. R37 (catalog scale) is covered only by synthetic-catalog tests; the one smoke server over the threshold (GitHub) is live-only.

**Catalog projection cases** (§6.8; `packages/projection/test/catalog/call.test.ts` and `test/integration/call-tool.test.ts`), all asserting that nothing executes: a `call` blob replayed to `execute_machine` and a `machine` blob to `call_tool` (R36 kind check); an approved `call_tool` retried with different `args` (binding-hash mismatch); a retry whose `inputResponses` omits the key (treated as declined); and `call_tool` on a `deny`-policy tool. Plus approve-then-replay within TTL, which re-executes the call (D4 known limitation, mirroring `packages/harness/test/replay.test.ts`); the assertion flips to exactly-once when a replay cache is configured (R38).

**Automated harness.** A test harness drives the wrapped server end-to-end using the Anthropic TypeScript SDK as the reasoning loop and the MCP TypeScript SDK as the client: scripted task prompts → model authors machines → harness auto-answers elicitations per scenario script (approve all / deny one / ignore one / tamper with blob / truncate blob). Assertions cover the S1–S6 invariants, self-heal attempt counts (§10 metrics), and blob-size budgets. Runs in CI against the pinned filesystem and sqlite servers; the GitHub server is live and opt-in.

**Manual TUI.** A thin Ink terminal client for exploratory testing: wraps the in-memory demo file server (embeddable against any facade via `App`/`driveTask`), type a task, watch the model's code + validation results + captured console logs stream by, and approve/deny pending elicitations interactively with single keys. Displays blob size and trip count per suspension. This doubles as the demo surface for the team.

## 14. Milestones

M1–M5 and MT are delivered. Remaining: Stretch (§12).
