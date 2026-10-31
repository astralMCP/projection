# Integration branch: `integration-hillclimb`

Base: `origin/rebaseline-fixed-harness` at `5b14d81`. It already holds
`explore-adaptive-surface` (per-box direct listing, `projections.direct:
'auto'`, harness modes `projection-direct` and `projection-auto`),
`eval-workplace-world` (held-out workplace tier) and `eval-world-fidelity`
(GitHub-fake answers, balanced fs box description, system-prompt cache
breakpoint).

## Branches merged, in order

| #   | Branch                             | Tip SHA   | Merge commit |
| --- | ---------------------------------- | --------- | ------------ |
| 1   | `origin/eval-offline-search`       | `a414429` | `0458d2b`    |
| 2   | `origin/feat-upstream-elicitation` | `df2b114` | `9428999`    |
| 3   | `origin/eval-hitl`                 | `7088bb6` | `6a27078`    |

`feat-upstream-elicitation` contains `eval-spec-conformance` (`5486199`).
Each merge was followed by `pnpm run format` and `pnpm run check`. No
golden under `packages/projection/test/typegen/__golden__/` changed in any
merge.

## DECISIONS renumbering

All three branches appended entries after D21. Unique, sequential numbers,
with every reference (docs, src, tests, `.claude/hillclimb` notes) updated:

| Branch                      | Was | Now | Entry                                                        |
| --------------------------- | --- | --- | ------------------------------------------------------------ |
| `eval-offline-search`       | D22 | D22 | Search weights rare words, name-coverage tie-break           |
| `feat-upstream-elicitation` | D22 | D23 | `call_tool` relays content blocks, progress and cancellation |
| `feat-upstream-elicitation` | D23 | D24 | Upstream questions: 2026-07-28 upstreams, forwarding opt-in  |
| `eval-hitl`                 | D22 | D25 | Approval UX: no prompts for calls that cannot run, batching  |
| `eval-hitl`                 | D23 | D26 | HITL layer for the tool-choice eval, the `hitl` tier         |

D25 gained an "Update (integration)" paragraph recording the decisions
below. The older "Update (D24)" note in the D7 entry was renumbered too.

## Conflict resolutions

### Merge 1: `eval-offline-search`

No textual conflicts. One semantic conflict: the workplace world widened
`ServerWorldName`/`WorldName`, so `src/eval/offline/surface.ts` no longer
typechecked. The meter now measures only the worlds that have a fixture
catalog (`github`, `filesystem`, `mongodb`, and `multi` over them) via
local `CatalogWorldName`/`SurfaceWorldName` types. It also measures `multi`
under `projection-direct` and `projection-auto` (11 rows, test updated).
When every box is listed directly the facade offers no search, so the
meter skips the search page in that case.

### Merge 2: `feat-upstream-elicitation`

- `docs/DECISIONS.md`: both sides appended. See the renumbering table.
- `facade/server.ts`: kept `registerDirectTools`/`advertisedSchema` (adaptive
  surface) and `upstreamCallOptions`/`clientUrlElicitation` (conformance,
  elicitation). Mediated `<alias>__<tool>` tools now pass the same
  `upstream` options (progress under the client token, cancellation) and
  the client's URL-elicitation capability that `call_tool` passes. Progress
  is attributed to the catalog name (`tool.target`), so a relayed message
  reads the same on both paths.
- New tests (`test/conformance/spec-conformance.test.ts`, "direct listing
  (projections.direct)"): over the wire, a mediated `every__ask_user` call
  on a forwarding box gives the same prompts, request params, server state
  echo and result as `call_tool({ name: 'every.ask_user' })`. Decline and
  cancel match too, a refusing box gives the identical error, and progress
  carries the catalog-name attribution. A mutation check showed that
  dropping the `upstream` option fails the progress test.

### Merge 3: `eval-hitl`

- `blob/sealer.ts`: the union of both constraint sets (see "Blob payload
  rules" below).
- `mrtr/adapter.ts` (auto-merged, but wrong): hitl's batched resume
  returned early and dropped `held`, which carries the answers to forwarded
  server questions. A machine suspension holding a batched approval and a
  forwarded question would have lost the answer. The fix picks verdicts by
  layout (`batchedVerdicts` or the new `perCallVerdicts`) and always reads
  the held answers. Two tests in `test/mrtr/upstream-input.test.ts`: both
  answers are honoured, and a question answer (even one smuggling
  `approve_1: true`) approves no batched call. Reverting the fix fails both.
- `facade/options.ts`, `wrap.ts`, `multi/facade.ts`, `index.ts`: both
  validators (`assertUpstreamElicitationMode`, `assertApprovalPrompts`) and
  both export groups kept.
- `docs/PRD.md`: the R20 table keeps `upstream_input`/`upstreamInput` and
  gains the `prompts` row with the merged rule. R15 now says how batching
  and forwarded questions coexist. hitl's R15, R15b and §7 footer refer to
  D25. R33 (offline ranking, D22), R35.5 (content blocks) and §6.11
  R63/R64 (D24) are unchanged.
- Harness `modes.ts`: kept `openSingleProjectionSession(world, mode)` with
  per-mode `projections.direct`, added `approvalPrompts`, and passed the
  full `SessionOptions` to `connectFacade` (hitl's new signature) in every
  Projection mode. `run.ts`: kept `directCalls`, with hitl's approvals
  wording.
- HITL prompt records: a prompt raised by a mediated tool was recorded
  without its `call` (attributed only for `call_tool`), so the HITL metrics
  under `projection-direct`/`projection-auto` fell back to reading the
  call off the prompt text. `mediatedToolTarget` (exported from
  `eval/hitl.ts`) maps an exact listed name back to its catalog name. The
  test shows the record matches `call_tool`'s.
- `test/mrtr/batch.test.ts`: the sealer test batched a one-call machine
  blob. It now uses two pending calls and asserts that one is rejected.
- `docs/server-authors.md`: direct listing inherits forwarding, decline
  copy, progress and cancellation, and a forwarded question is never folded
  into a batch. It also said `directBudgetTokens` defaults to 12 000. That
  was wrong in the base; the code (`DEFAULT_DIRECT_BUDGET_TOKENS`) and its
  measured rationale say 8 000, so the doc now says 8 000.

## Blob payload rules (merged)

| Field           | `machine`                                     | `call`             | `upstream_input`                    |
| --------------- | --------------------------------------------- | ------------------ | ----------------------------------- |
| `pending`       | any                                           | exactly `{ call }` | must be empty                       |
| `upstreamInput` | optional (held calls, keyed by call id)       | forbidden          | exactly `{ call }`, `id: 'call'`    |
| `prompts`       | optional, only `'batched'`, ≥ 2 pending calls | forbidden          | **forbidden** (decision, see below) |
| `snapshot`      | machine snapshot                              | `null`             | `null`                              |
| `audit`         | accumulated                                   | `[]`               | `[]`                                |
| `trip`          | ≥ 1, R18 cap                                  | `1`                | ≥ 1                                 |

Decision: `prompts` may **not** appear on an `upstream_input` blob. The
field records how pending approvals were laid out, and an `upstream_input`
blob has none pending. It is minted by `call_tool`, which never batches.
Allowing it would let a resume read batched verdicts for an empty map.
That would be harmless today, but it is a shape the minting never
produces, and the sealer fails closed on such shapes. For the same reason a
batched `machine` blob must hold at least two pending calls
(`chooseLayout` never batches fewer). Tested in
`test/mrtr/upstream-input.test.ts` ("the sealer shape rules for
upstream_input", "for prompts") and `test/mrtr/batch.test.ts`.

## New options and their defaults

| Option                                       | Where                                               | Default                                             | From                      |
| -------------------------------------------- | --------------------------------------------------- | --------------------------------------------------- | ------------------------- |
| `projections.direct: boolean \| 'auto'`      | `WrapOptions`, `WrapServersOptions`                 | `false`                                             | base (adaptive surface)   |
| `projections.directBudgetTokens`             | with `direct: 'auto'`                               | 8 000                                               | base (adaptive surface)   |
| `upstreamElicitation: 'forward' \| 'refuse'` | `WrapOptions`, `WrapServersOptions`, per-box source | `'refuse'` (a per-box value overrides the facade's) | feat-upstream-elicitation |
| `approvalPrompts: 'per-call' \| 'batched'`   | `WrapOptions`, `WrapServersOptions`                 | `'per-call'`                                        | eval-hitl                 |
| Introspector upstream era                    | owned upstreams                                     | 2026-07-28 (2025 handshake fallback by URL)         | feat-upstream-elicitation |

Harness: `PROJ_EVAL_MODES` accepts `projection-direct` and `projection-auto`
(opt-in); `PROJ_EVAL_APPROVAL_PROMPTS` sets `approvalPrompts`; the `hitl`
tier and approver personas are opt-in (default tiers unchanged).
`pnpm --filter @astral-mcp/harness run eval:offline` and
`snapshot:catalogs` are new scripts. No live API call was made.

## Check output (final tree; the commit after `6a27078` is docs only)

`pnpm run check`: 16/16 turbo tasks successful. Projection: 54 files,
1523 passed, 1 skipped, 5 todo. Harness: 26 files passed (5 skipped),
457 passed, 129 skipped. TUI: 14 passed. Lint: 0 errors.
`pnpm run format:check`: clean. The perf-budget p95 test
(`test/integration/budgets.test.ts`) failed under parallel turbo load after
merges 1 and 2 (resume-leg p95 192 ms against a 100 ms budget, median
53 ms, load average about 10 from live runs in other worktrees). It passed
solo every time and in the final full run.

## Security fixes after integration (DECISIONS D27)

An adversarial review of this branch found four gaps where merged features
met. Fixed on `integration-sec-fixes`, fast-forwarded here:

1. **S6 (confirmed).** A forwarded question could mimic the batched
   approval form: `[1] ⚠ Approve: …` titles, `Approved:` headings, raw
   option values, and fields named `approve_1` or `Approve_delete_repo`.
   `mrtr/upstream-input.ts` now detects look-alikes after any leading
   `[k]`, numbering or punctuation (`approv…` words, `⚠` anywhere), marks
   option values and untitled field names, drops look-alike defaults, and
   drops `approve_<n>` and `reason` fields. Ordinary forms pass unchanged
   (tested).
2. **Direct-listing annotations.** `<alias>__<tool>` advertised the
   server's annotations; it now advertises only Projection's decided
   posture (`advertisedAnnotations` in `facade/direct.ts`): `readOnlyHint`
   only for `auto` calls the server marks read-only and not destructive,
   `destructiveHint: true` only as a warning, no annotation `title`.
3. **R15b.** Failures raised while building the next suspension in
   `mrtr/adapter.ts` (trip cap, unknown tool, unforwardable question, blob
   too big) now carry the "already done" and refusal blocks.
4. **Question blob expiry.** An `upstream_input` blob keeps the `exp` of
   the blob it continues (`buildBlobPayload({ notAfter })`); PRD R38 and
   the docs recommend `replayCache` wherever forwarding is on.

Each fix has a test that failed before it (`test/mrtr/upstream-input.test.ts`,
`test/facade/direct.test.ts`, `test/mrtr/e2e.test.ts`). The adapter test
covers the trip-cap branch; the other three branches share the same helper.

`pnpm run check` after the fixes: 16/16 turbo tasks. Projection: 54 files,
1532 passed, 1 skipped, 5 todo. Harness: 457 passed, 129 skipped. TUI: 14
passed. Lint: 0 errors. `format:check` clean. The perf-budget p95 test
failed once under load (resume-leg p95 138 ms, load average about 12),
passed solo, and passed in the final full run.

## Left inconsistent / open

- `LIB_VERSION` and the package version are not bumped. Three public
  surface additions (`approvalPrompts`, `upstreamElicitation`, direct
  listing) call for a minor bump at release.
- The contributing skill and CLAUDE.md still say "R1–R62". The PRD now runs
  to R64 (plus R15a/R15b).
- The harness approver (`connectFacade`'s `elicitation/create` handler)
  counts every elicitation as an approval prompt. No eval world sets
  `upstreamElicitation: 'forward'`, so this holds today. A world that
  forwards questions would need the handler to tell `Question from …`
  prompts apart from approvals.
- `mediatedToolTarget` matches exact names only. A mediated name the
  facade had to shorten or hash-suffix (more than 64 characters, or a
  collision) falls back to text parsing. The facade's direct plan is not
  public, so the harness cannot read it.
- The integration commit (D25 update, INTEGRATION.md, the server-authors
  default fix) has had no separate review-agent pass. The contributing
  cycle's code and security reviews are still owed before any PR.
- `.claude/hillclimb/multi-server/explore/offline-search.md` reports the
  surface table as measured before the merge (9 rows). The meter now
  emits 11, and the doc's numbers were not re-run.
- hitl's DECISIONS entries are dated 2026-10-31, after the integration
  date. They were kept as written.
- The conformance suite's "upstream tools are never direct (R1)" holds
  only at the default (`direct` off). R1/R43 do not mention the opt-in
  direct listing. That gap predates this integration (adaptive surface).
