# Exploration summary: robustness, HITL and cost (2026-10-30/31)

Goal from the maintainer: high performance, good human-in-the-loop, low cost, for any MCP server, with full spec
support. One fixed point: approvals stay driven by tool annotations + the integrator's policy config, over MRTR
elicitation. Method: claude.dev "Automating eval design and hillclimbing" (held-out sets, mechanisms over copy,
suspect tasks that fail every rep). Everything below is on `integration-hillclimb` (see INTEGRATION.md).

## What changed

| area | branch                    | what                                                                                                                                                                                                           |
| ---- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| eval | eval-world-fidelity       | GitHub fake answers unmodeled reads with `[]`/404, not `{ok:true}`; fs box described as specifically as the others; system-prompt cache breakpoint (static prefix cached across episodes, as a real host does) |
| eval | eval-workplace-world      | held-out `workplace` tier: chat / tracker / errors / docs / mail fakes, 14 cross-server tasks (joins, fan-out, idempotency, injection, pagination, degradation)                                                |
| eval | eval-offline-search       | zero-cost retrieval eval (1,173 cases, train/test), invariance checks, surface-size meter                                                                                                                      |
| eval | eval-hitl                 | approver personas, prompt clarity, denial handling, prompts per gated write; `hitl` tier                                                                                                                       |
| eval | eval-spec-conformance     | "everything" upstream fake + conformance matrix (35 tests, gaps as todos)                                                                                                                                      |
| lib  | eval-offline-search       | search ranking: IDF weighting, name-coverage tie-break (test R@5 89.6 → 94.2)                                                                                                                                  |
| lib  | explore-adaptive-surface  | `projections.direct: 'auto'`: boxes under an 8k-token budget list their tools as mediated `<alias>__<tool>` aliases of `call_tool` (same gate)                                                                 |
| lib  | eval-spec-conformance     | call_tool passes images/audio/resources as content, forwards progress, propagates cancellation                                                                                                                 |
| lib  | feat-upstream-elicitation | upstream clients speak 2026-07-28; opt-in forwarding of an upstream's own questions over MRTR (`upstream_input` blob), attributed, never an approval                                                           |
| lib  | eval-hitl                 | decline/refusal copy, refused and already-run calls listed, arg check before gated machine calls, opt-in batched approval prompts (layout sealed in the blob)                                                  |
| lib  | integration-sec-fixes     | S6 look-alike marking in forwarded forms; direct tools advertise Projection's posture, not the server's hints; outcome blocks on every suspension failure; question blobs never extend expiry                  |

Security: four adversarial reviews (hitl, upstream elicitation x2, integration). Every CONFIRMED finding is fixed
with a test that fails without the fix. No S2 break survives.

## Results (live, list price, corrected harness)

Re-baseline, `rebaseline-fixed-harness` (multi + workplace 2 reps, filesystem + mongodb 1 rep), pass and $/episode:

| tier                 | model      | direct       | v4 projection | projection-auto  |
| -------------------- | ---------- | ------------ | ------------- | ---------------- |
| multi                | haiku45    | 28/34, .0242 | 33/34, .0219  | **34/34, .0110** |
| multi                | sonnet-low | 32/34, .0565 | 34/34, .0162  | **34/34, .0162** |
| workplace (held out) | haiku45    | 28/28, .0191 | 23/28, .0476  | **27/28, .0233** |
| workplace (held out) | sonnet-low | 28/28, .0364 | 28/28, .0473  | **28/28, .0395** |
| filesystem           | haiku45    | 15/15, .0095 | 15/15, .0185  | 15/15, .0116     |
| filesystem           | sonnet-low | 15/15, .0066 | 15/15, .0101  | 15/15, .0077     |
| mongodb              | haiku45    | 15/15, .0099 | 14/15, .0189  | 14/15, .0190     |
| mongodb              | sonnet-low | 15/15, .0182 | 15/15, .0127  | 15/15, .0105     |

Integration build, 3 reps: multi-hard haiku 23/36 → 25/36 (−17% $/ep), sonnet 36/36 → 35/36 (+17% $/ep, the listed
fs box's prefix on GitHub/Mongo tasks). hitl 2 reps: haiku 8/10 → 9/10 at a third of the cost, sonnet 10/10.
HITL changes alone (eval-hitl): normal routing 15/20 → 18/20, code mode 6/10 → 9/10, Haiku prompts per gated write
2.65 → 0.88.

## What we learned

- `global-csv-released` (0/3 in every v4 cell) was measuring the eval, not the facade: an unbalanced host
  description (GitHub specific, fs vague) plus a fake that answered `list_releases` with `{ok:true}`. Balanced, v4
  passes 4/5 and 5/5. Copy hints (v5–v7), a search-tool rename and tool-noun box summaries did not move it: Sonnet
  routes on integrator text. Docs should tell integrators to describe every box by the data it holds.
- One in six real `search_<box>` queries asks for data, not tools.
- Cost comparisons need host-like caching: without the system breakpoint, direct looked ~2× cheaper than it is
  relative to Projection on Haiku. Haiku 4.5's 4,096-token cache minimum means a small prefix is not always cheaper
  (mongodb: Projection 2× direct on Haiku).
- Multi is saturated (34/34); headroom is in multi-hard (Haiku ~70%), workplace on Haiku, and hitl.

## Open decisions (maintainer)

1. Approve the harness changes (`--approve-harness`) and re-baseline the official rounds on them.
2. PRD R1 still says wrapped tools are never exposed directly; `direct: 'auto'` keeps the gate but not the letter.
   Amend R1/R32/R43 and decide the default (data supports `'auto'` at 8k; Sonnet pays +10–20% on tasks that never
   touch a listed box).
3. Defaults: `upstreamElicitation: 'refuse'` and `approvalPrompts: 'per-call'` (both opt-in by design).
4. Ship: split `integration-hillclimb` into reviewed PRs per the contributing cycle; minor version bump.

## Spend

About $40 live: probes $3.59, workplace pilot $2.31, adaptive surface $8.28, hitl $3.54, re-baseline $13.24,
validation $8.99. No batch runs left billing.
