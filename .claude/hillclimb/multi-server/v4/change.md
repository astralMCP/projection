# v4 candidate: v2 + v3's routing copy on multi-server facades only

## Applied

Applied on `hillclimb-multi` on top of v3 (`911d64d`, not kept) by reverting
v3's single-server changes. `change.patch` is the diff against v2
(`e49f551`), restricted to `packages/` and `docs/`.

- **Reverted to v2:** `DEFAULT_ROUTING_PREAMBLE` (src/mrtr/discover.ts) and
  the single-server `execute_machine` / `call_tool` copy (src/wrap.ts; the
  `ROUTED_CODE_MODE_COPY` split is gone). Both files are byte-identical to
  v2, and so is test/mrtr/discover.test.ts.
- **Kept from v3:** the multi-server routing variant of
  `defaultMultiPreamble`, the routed multi `execute_machine` description
  (served only when `call_tool` is also served) and the multi `call_tool`
  copy (src/multi/facade.ts, unchanged from v3), and their tests
  (test/multi/wire.test.ts, test/multi/code-mode.test.ts).
- **Docs:** PRD R29 is back to v2's wording, the single-server rule. R44 now
  states that the multi-server routing rule also sends a short
  lookup-then-act chain to `call_tool`, and that the multi
  `execute_machine` / `call_tool` descriptions carry the same rule.
  server-authors.md keeps v3's multi preamble excerpt and adds one line:
  the short-chain rule is multi-server only.
- **Tests:** test/integration/catalog-projection.test.ts now asserts that a
  single-server facade with both projections on has no short-chain copy in
  its instructions, `execute_machine` or `call_tool`. It still checks that
  the code-mode-only `execute_machine` never mentions `call_tool`.

`pnpm run check` is green. The first run failed only on the known
`budgets.test.ts` resume-leg p95 flake; that file passed when rerun alone,
and the full `turbo run build typecheck lint test --continue` then passed
16/16.

## Byte-identity check (single-server)

A render script wrapped one in-process server (instructions, one read tool,
one read tool with an `outputSchema`, one write tool) with `wrapMcpServer`
under each projection selection: both, code mode only, catalog only. For
each it dumped `facade.instructions`, the client-side `getInstructions()`,
the full `tools/list` (names, descriptions, input/output schemas,
annotations), `prompts/list`, and the text of `discover_apis`,
`search_tools` and `describe_tool` (with and without `types: true`). It ran
against the v2 source (`git archive e49f551`) and the v4 working tree. The
two outputs are byte-identical: 37,985 bytes each, sha256 `8fe0f999…dcbb2a`.
As a control, the same script on v3 (`HEAD` before this change) differs at
the instructions.

## Why

v3 moved haiku's routing on the multi tier: machine episodes fell 9→3
(gating) and 10→4 (boxes), and `cross-shipped-to-comment` got its first
pass. It failed the guard hold against v2, with haiku 59→53/60 (0 up / 6
down, −10.0 against a paired ±7.7 floor). The guard is single-server
throughout (basic, hard, filesystem, mongodb through `projection`), so the
only thing v3 changed there was its single-server copy. One rep cannot tell whether
that copy really costs single-server tasks or v2's 59/60 was a high draw.
Scoping the copy to multi-server facades removes the question. The
single-server surface is v2's byte for byte, so the guard measures the v2
library again, and the multi tier keeps the routing change that engaged.

## Expected

- **Multi tier (gating, tracked):** about v3's numbers. Only the
  multi-server copy affects these cells, and it is v3's unchanged.
- **Guard:** v2's library, so v2's distribution (baseline 55, v1 53, v2 59,
  v3 53 of 60 for haiku). Any difference from v2 is noise from the library's
  side, but see `harness-change-2.md`: the eval harness changes before this
  run, so v4 is a re-baseline and its guard is not directly comparable to
  earlier rounds.

## Risks

- None on the single-server library surface (byte-identical to v2).
- Multi-server integrators get routing copy that differs from single-server
  copy. That is documented in R44 and server-authors.md.
- S5: no server-sourced text added; all copy is library-supplied.
