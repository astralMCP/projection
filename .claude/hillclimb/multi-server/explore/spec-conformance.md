# Spec conformance: Projection wrapping a whole-spec upstream

Target: MCP 2026-07-28 through SDK v2.4.0 (`@modelcontextprotocol/{client,server}`).
Evidence: `packages/projection/test/conformance/everything-server.ts` (the
upstream fake) and `spec-conformance.test.ts` (35 passing assertions, 9
`it.todo` gaps). Zero API spend: everything runs in-process.

Fixed design point: approvals (MRTR elicitation from tool annotations plus
integrator policy) are unchanged by everything below. Gap ranking weighs the
maintainer's three goals: **performance** (latency, round trips),
**human-in-the-loop** (what the person sees and can do) and **cost** (model
tokens).

## What the SDK actually offers on 2026-07-28

- Server-to-client input (elicitation form and URL mode, sampling, roots) is
  MRTR only: a tool returns `inputRequired({ inputRequests, requestState })`.
  Push-style `elicitInput` / `createMessage` / `listRoots` throw on a modern
  request; on a legacy connection the SDK's shim turns `inputRequired` into
  push requests.
- `tasks/*` are deleted from the modern wire, and the SDK's typed surface no
  longer offers them. Long-running work is progress plus cancellation.
- `logging/setLevel` and `resources/subscribe` are not on the modern wire
  (log level travels in request `_meta`; subscriptions use
  `subscriptions/listen`). A modern client gets a local SDK error for both.
- **Projection's introspector negotiates the legacy era with every upstream**
  (`new Client(..., { capabilities: {} })` with no `versionNegotiation`). The
  upstream sees a 2025-era client with no capabilities. This drives several
  rows below.

## Matrix

Legend: **P** passed through faithfully · **T** transformed · **D** dropped
silently · **E** error (upstream-phase / TOOL_ERROR) · **F** fixed in this
branch. Columns: single facade (`wrapMcpServer`), multi facade
(`wrapMcpServers`, two boxes), the `call_tool` path, and code mode
(`execute_machine`).

| Upstream feature                                        | single                                                       | multi                                                          | call_tool                                                    | execute_machine          |
| ------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------ |
| Tools listed as direct tools                            | D (by design, R1)                                            | D (R1)                                                         | n/a                                                          | n/a                      |
| Server `instructions`                                   | P verbatim + preamble                                        | T: shelf line quoted and attributed; full text in box overview | n/a                                                          | n/a                      |
| Server title / icons / serverInfo                       | D                                                            | D                                                              | n/a                                                          | n/a                      |
| `tools/list` pagination                                 | P (bounded, D12)                                             | P                                                              | last-page tool callable                                      | P                        |
| `outputSchema`                                          | T: allowlisted in `describe_tool`; typegen                   | T                                                              | n/a                                                          | T: `.d.ts` Output type   |
| `structuredContent`                                     | —                                                            | —                                                              | T: `{status, tool, output}`                                  | T: `TOOL_RESULT.result`  |
| text content                                            | —                                                            | —                                                              | T: text, neutralized                                         | P (string)               |
| image / audio                                           | —                                                            | —                                                              | **F**: native blocks (was base64 JSON in text)               | T: raw array with base64 |
| embedded resource (text / blob)                         | —                                                            | —                                                              | **F**: text inline under URI; blob native                    | T: raw array             |
| `resource_link`                                         | —                                                            | —                                                              | **F**: described, not attached (facade cannot serve the URI) | T: raw array             |
| annotations readOnly / destructive / idempotent / title | P (drive policy)                                             | P                                                              | P in `describe_tool`                                         | P (posture in `.d.ts`)   |
| `openWorldHint`                                         | D                                                            | D                                                              | D                                                            | D                        |
| missing annotations                                     | T: `ask` (S5)                                                | T                                                              | approval prompt                                              | approval prompt          |
| tool `title` / `icons`                                  | D                                                            | D                                                              | D                                                            | D                        |
| progress notifications                                  | —                                                            | —                                                              | **F**: relayed, `<tool>: msg`, neutralized, capped           | D                        |
| logging (`notifications/message`)                       | D (facade declares no `logging`)                             | D                                                              | D                                                            | D                        |
| upstream form elicitation                               | E                                                            | E                                                              | E upstream, no prompt                                        | E TOOL_ERROR             |
| upstream URL elicitation                                | E                                                            | E                                                              | E                                                            | E                        |
| push-style `elicitInput`                                | E                                                            | E                                                              | E                                                            | E                        |
| sampling (`createMessage`)                              | E                                                            | E                                                              | E                                                            | E                        |
| roots (`roots/list`)                                    | E                                                            | E                                                              | E                                                            | E                        |
| cancellation                                            | —                                                            | —                                                              | **F**: abort reaches upstream                                | D (call runs on)         |
| resources list / templates / read                       | D (`resources/read` not found)                               | D (box overviews only)                                         | n/a                                                          | n/a                      |
| resource subscribe / updated                            | D                                                            | D                                                              | n/a                                                          | n/a                      |
| prompts list / get                                      | D (workflow prompts only)                                    | D                                                              | n/a                                                          | n/a                      |
| completions                                             | E Method not found                                           | E                                                              | n/a                                                          | n/a                      |
| `tools/list_changed` add                                | D: new tool unknown (`validate`)                             | D (R47)                                                        | validate error                                               | TOOL_ERROR               |
| `tools/list_changed` remove                             | D: stale entry; call fails upstream                          | D                                                              | upstream error                                               | TOOL_ERROR               |
| tasks                                                   | n/a (deleted in 2026-07-28)                                  | n/a                                                            | n/a                                                          | n/a                      |
| Legacy-era client                                       | same as modern for reads; gated calls via shim when opted in | same                                                           | same, F fixes hold                                           | same                     |

Security results (asserted in the suite):

- S6 holds by construction today: an upstream question never reaches the
  human. The fake's elicitation message is a spoofed approval
  (`Approve: Read the weather …`); the only prompts the human sees are
  Projection's own (`⚠ Approve: nuke` / `⚠ Approve (every): nuke`).
- S5: relayed progress text is attributed (`hostile: …`, `every.slow_count: …`),
  bidi/control characters replaced, capped at 200 characters; content-block
  text is neutralized like the rest of the `call_tool` body.
- S1: progress messages from a source given by URL pass the connector's
  redaction before leaving the introspector.

## Gaps, ranked

Rank = rough user impact against performance, human-in-the-loop and cost.

### G1. Upstream elicitation is refused (HITL: high · perf: — · cost: medium)

Any upstream that asks its user something (confirm, pick an account, OAuth
URL connect) fails, and the model burns turns on an error whose hint says
"check the arguments" (wrong advice). Biggest functional gap for real servers.

Proposal (keeps approvals intact; follows D7):

1. Introspector speaks 2026-07-28 to upstreams that support it (G2) and
   declares `elicitation: { form: {}, url: {} }` but sets
   `inputRequired.autoFulfill: false`, so an upstream `input_required` comes
   back to Projection as data, not as a push.
2. `call_tool` (and the machine host) turns the upstream `inputRequests` into
   Projection's own `input_required`: each request gets a namespaced key
   (`upstream:<alias>:<key>`), and the upstream's opaque `requestState`
   plus the pending call are **nested inside Projection's sealed blob**
   (new blob kind `upstream_input`, bound to name+args like `call`). Resume
   stays stateless (R27): the retry reopens the blob, re-issues the upstream
   call with the upstream `requestState` and the matching `inputResponses`.
3. Copy: forwarded messages are third-party text. Render them inert and
   attributed, never in Projection's approval shape: title
   `Question from <alias> (not an approval by this app)`, the upstream message
   as an indented quoted block, the requested-schema fields as the form. No
   `Approve` prefix, ever; a message starting with `Approve` is still shown
   quoted under the header. URL mode: show the URL host prominently (like R55
   sign-in copy) and pass the URL only in the URL-mode `url` field.
4. Policy: forwarding is per box opt-in (`forwardElicitation: true` on
   `ServerSourceConfig` / `WrapOptions`), default off, because a hostile
   server could phish. An approval-gated call that then asks an upstream
   question needs both: approval first (unchanged), the question on the next
   round trip.
5. Cheap interim (could ship alone): replace the misleading `upstream` hint
   for SDK "Cannot request input" errors with "The tool asked for user input,
   which this facade does not forward; tell the user to run it directly."

### G2. Introspector speaks the legacy era to upstreams (perf: medium · HITL: enabler · cost: low)

Every upstream is driven as a 2025 client with no capabilities. Blocks G1/G6,
loses modern features (per-request log level, `subscriptions/listen`, cache
hints, `Mcp-Method` headers for HTTP routing) and pays the legacy handshake.

Proposal: `versionNegotiation: { mode: 'auto' }` on owned clients
(in-process and URL sources), `inputRequired: { autoFulfill: false }`. Blob
identity is unaffected. Needs a sweep of the auth connector tests (401 on
probe paths) and the pack-install smoke.

### G3. Machines relay neither progress nor cancellation (perf: high · HITL: medium · cost: low)

`execute_machine` is where long work happens, yet the client sees nothing
until the segment ends, and a cancelled machine keeps calling upstream tools
until the wall-clock cap.

Proposal: thread the same `UpstreamCallOptions` through `runSegment` and the
host's executor call (host.ts:415): the facade request's signal aborts the
in-flight upstream call and stops the segment (a `runtime` "cancelled"
result is never delivered — the client is gone). Progress: forward upstream
reports as `<alias>.<tool>: …` and add host progress per completed step
(`progress = steps done`, no total). Nothing enters the blob, so resume is
unchanged.

### G4. `tools/list_changed` is ignored (HITL: low · cost: medium · perf: low)

Servers that add tools after login (common for SaaS servers) look empty or
stale; removed tools fail with an upstream error.

Proposal: on `list_changed`, re-introspect that box (bounded as today) into a
**pending** catalog and swap it in at the next request boundary; emit the
facade's own `notifications/tools/list_changed` only when Projection's served
tool set changes (it changes only for a new or removed box). Identity:
include a hash of the tool list in `serverIdentity` is wrong (would break
in-flight blobs on harmless changes); instead keep identity as is and, on
resume, re-check that the recorded tool still exists with the same posture
(R14 already re-evaluates policy). Stateless deployments: each instance
refreshes itself; disagreement window equals the notification fan-out time.
R47 text says "refreshes nothing" — needs a PRD amendment.

### G5. Upstream resources and prompts are not projected (cost: medium · HITL: medium · perf: —)

A tool returning a `resource_link` points at something the model cannot
read; server prompts (often the best "how to use me" guidance) are invisible.

Proposal: serve box resources under a facade namespace,
`projection://boxes/<alias>/r/<percent-encoded upstream URI>`, read-through
to the upstream (`resources/read`), contents size-capped and text
neutralized, list/templates paged through. Rewrite `resource_link` URIs in
`call_tool` results to that namespace (then attach them natively). Prompts:
expose as `<alias>.<prompt>` with arguments passed through and messages
marked as server-authored (S5: prompt text is third-party; never put it in
instructions). Completions forward for both. Read-only, no approval
involvement. Code mode: a `resources.read(uri)` bridge is a bigger change
(S1 channel) — keep out.

### G6. Sampling and roots requests are refused (HITL: low · cost: risk · perf: —)

Proposal: roots — answer from integrator config (`WrapOptions.roots`), never
from the client (the client's roots describe its machine, not the
upstream's). Sampling — keep refused by default (Q2; and every sampled token
is cost the user did not ask for); if ever enabled, forward through MRTR like
G1 with an explicit per-box opt-in and a `maxTokens` cap.

### G7. Upstream logs are dropped (HITL: low · cost: avoid · perf: —)

Proposal: do not feed logs to the model (cost). Offer `WrapOptions.onUpstreamLog(alias, entry)`
for the integrator's own telemetry, and optionally relay as
`notifications/message` with `logger: <alias>` when the client set a level.

### G8. `openWorldHint`, tool `title`, `icons` dropped (HITL: low · cost: tiny)

Proposal: carry `openWorldHint` into `describe_tool` annotations and the
approval copy ("reaches outside services"); use the tool `title` as the
action when `annotations.title` is absent (R16 ordering); pass icons through
`describe_tool` only. All neutralized and capped (S5).

### G9. Machine `TOOL_RESULT` carries base64 media (perf: low · cost: medium)

Media in a machine result costs context if the machine outputs it. Proposal:
let typegen document it, or replace binary data with `{ type, mimeType,
bytes }` stubs in `TOOL_RESULT` unless the machine asks (`toolCall(..., {
media: true })`).

## Fixed in this branch

1. **Content blocks** (`catalog/call.ts`): native image / audio / embedded
   binary resource blocks; text and embedded text read as text; base64 never
   in the text; `resource_link` described; `structuredContent.output`
   unchanged. Cost win: a 1x1 PNG was ~400 characters of JSON per call;
   a real screenshot is tens of thousands of tokens.
2. **Progress relay on `call_tool`** (`facade/server.ts`,
   `introspector.ts`): opt-in by the client's `progressToken`; attributed,
   neutralized, capped; resets the upstream timeout.
3. **Cancellation on `call_tool`**: the facade request's abort signal
   reaches the upstream call (modern HTTP and held legacy connections).

`ToolExecutor.callTool` gained an optional host-side `UpstreamCallOptions`
argument (non-breaking). DECISIONS D22 records it; `docs/server-authors.md`
describes it.

## PRD proposals (not edited)

- R35.5: add the content-block rendering rule and the progress/cancellation
  relay.
- R47 last sentence: replace "refreshes nothing" with G4's swap rule.
- N6 / Q2: keep sampling out; add "upstream elicitation forwarding is
  opt-in per box, MRTR-only (D7)" as a requirement once G1 is built.
- New: the introspector negotiates 2026-07-28 with upstreams (G2).
