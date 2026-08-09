---
name: contributing
description: The McCircuit contribution workflow — branch/PR conventions, the review→fix→merge subagent cycle, toolchain commands, and repo gotchas. Read before making any change in this repo.
---

# Contributing to McCircuit

## The cycle (non-negotiable)

One PR per feature or bug — never batch unrelated changes. For every PR:

1. `git fetch origin` **first**, then branch from `origin/main` (a stale
   local `origin/main` has caused missing-export build failures here).
2. Make the change; run `pnpm run format` then `pnpm run check` — both must
   be green before pushing.
3. Push, open the PR with `gh pr create`.
4. Spawn a **review subagent**: adversarial code + security review. Give it
   the diff range, the threat model (S1–S6 in `docs/PRD.md` §9), and the PRD
   sections the change implements. Tell it to verify findings with concrete
   repros and mark each CONFIRMED or PLAUSIBLE; no style nits.
5. Spawn a **fix subagent** to apply the confirmed findings (don't fix them
   in the main loop). It commits and pushes; it never touches PRs.
6. Verify green, `gh pr merge N --squash`, move to the next task.

Trivial one-liners still get at least a quick synchronous review agent.

## Commands

```bash
pnpm install
pnpm run check          # build + typecheck + lint + test (turbo, all packages)
pnpm run format         # prettier --write; CI runs format:check and FAILS on drift
pnpm --filter mccircuit test            # one package
pnpm --filter @mccircuit/tui start      # demo TUI (builds deps via turbo first)
```

CI = `pnpm run check` + `pnpm run format:check`. Formatting drift in ANY
committed file (including `.claude/*.json`) fails CI — always run
`pnpm run format` before committing.

## Commit / PR conventions

- Never put backticks in `git commit -m` strings (zsh executes them).
- End commit messages with the `Co-Authored-By: Claude ...` trailer and PR
  bodies with the Claude Code attribution line.
- Squash-merge. Small, reviewable diffs.

## Repo gotchas

- **`.env` is off-limits to agents** — deny rules + a PreToolUse hook in
  `.claude/settings.json` block reading it; it holds real secrets. Tests
  that need env files create their own under a temp dir at runtime.
- **Golden files** under `packages/mccircuit/test/typegen/__golden__/` are
  intentionally excluded from prettier (`.prettierignore`). Regenerate them
  via the typegen tests, don't hand-edit or format them.
- **Live-spend gates**: anything that calls the Anthropic API must be
  explicit opt-in (`MCC_LIVE_BENCH=1` + non-empty `ANTHROPIC_API_KEY`), so a
  plain `pnpm test` never spends tokens. Preserve this on new live tests.
- **XState is pinned exactly** (5.32.5) and `@sebastianwessel/quickjs` at
  3.1.0 (PRD §7). Don't bump casually — blobs bind to the XState version.
- **Perf-budget tests** (`test/integration/budgets.test.ts`) can flake under
  parallel turbo load; a p95 failure that passes on a solo re-run is load
  noise, not a regression.
- `src/types.ts` in the library is the shared contract; wire top-level
  exports through `src/index.ts` deliberately (see `docs/DECISIONS.md` D3).

## Where truth lives

- `docs/PRD.md` — requirements (R1–R31), security invariants (S1–S6), §10
  budgets/metrics, §13 harness+TUI.
- `docs/DECISIONS.md` — why things are the way they are (SDK v2 MRTR
  adoption, AEAD sealer rationale, D4 replay obligation). Append a decision
  entry when you make one worth remembering.
