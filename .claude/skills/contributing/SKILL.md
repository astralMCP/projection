---
name: contributing
description: The Projection contribution workflow — branch/PR conventions, the review→fix→merge subagent cycle, toolchain commands, and repo gotchas. Read before making any change in this repo.
---

# Contributing to Projection

## The cycle (non-negotiable)

One PR per feature or bug — never batch unrelated changes. For every PR:

1. `git fetch origin`, then branch from `origin/main`. Parallel agents each
   work in their own git worktree under `.claude/worktrees/` (ignored by git
   and oxfmt). Never switch branches in the shared checkout.
2. Make the change; run `pnpm run format` then `pnpm run check` — both must
   be green before pushing.
3. Push, open the PR with `gh pr create`.
4. Spawn two review subagents in parallel — a code review and an adversarial
   security review (threat model S1–S6, `docs/PRD.md` §9; give each the diff
   range and the PRD sections the change implements; findings verified with
   concrete repros, marked CONFIRMED or PLAUSIBLE; no style nits).
5. Then a **fix subagent** applies the accepted findings (don't fix them in
   the main loop). It commits and pushes; it never touches PRs.
6. Verify green, then squash-merge with
   `gh pr merge N --squash --delete-branch`, and move to the next task.

Trivial one-liners still get at least a quick synchronous review agent.

## Commands

```bash
pnpm install
pnpm run check                                   # build + typecheck + lint + test (turbo, all packages)
pnpm run format                                  # oxfmt (writes); CI runs format:check and FAILS on drift
pnpm run format:check                            # what CI runs after check
pnpm --filter @astral-mcp/projection test        # one package
pnpm run test:budgets                            # §10 perf budgets alone (check runs them after the parallel tests)
```

CI = `pnpm run check` + `pnpm run format:check`. Formatting drift in ANY
committed file (including `.claude/*.json`) fails CI — always run
`pnpm run format` before committing.

Node ≥22.12 is required (`engine-strict`; vitest 5 needs 22.12). The
maintainer's machine provides Node via mise (24 LTS, on PATH by default), so
commands need no PATH prefix. CI runs `check` on Node 22 and 24.

## Commit / PR conventions

- Never put backticks in `git commit -m` strings (zsh executes them).
- End commit messages with the `Co-Authored-By: Claude ...` trailer and PR
  bodies with the Claude Code attribution line.
- Squash-merge. Small, reviewable diffs.

## Releasing

- `packages/projection/CHANGELOG.md` (Keep a Changelog; shipped in the npm
  tarball) has an `## [Unreleased]` section at the top. Any PR that changes
  the public surface (an export or its signature, tools, options, result
  shapes, defaults, model-facing copy) adds a line there in the same PR,
  and a signature change or behaviour break goes under `### Breaking`.
- Bump `packages/projection/package.json` and `LIB_VERSION` in
  `src/blob/versions.ts` together (`test/blob/versions.test.ts` enforces it;
  bump `XSTATE_VERSION` only if xstate changes) in a PR titled `vX.Y.Z: …`.
- That release PR moves the `[Unreleased]` entries into a new
  `## [X.Y.Z] - YYYY-MM-DD` section and leaves an empty `[Unreleased]`
  above it. At the bottom it repoints the `[Unreleased]` compare link to
  `vX.Y.Z...HEAD` and adds the `[X.Y.Z]` link. Check **Breaking** by
  diffing the previous tag's built `dist/index.d.mts` (build it in a temp
  worktree) against the release branch's.
- Minor bump for any public-surface change (new tools, options, result
  shapes, prompt copy models match on); patch for pure hardening.
- After merge: `git tag vX.Y.Z && git push origin vX.Y.Z`.
- The maintainer publishes by hand: `npm whoami` first — the login token
  lapses — then `pnpm --filter @astral-mcp/projection publish --access public`
  (OTP prompt). `prepublishOnly` runs build/typecheck/test. CI never
  publishes.

## Repo gotchas

- **The repo-root `.env` file is off-limits to agents** — it holds real
  secrets. Deny rules + PreToolUse hooks in `.claude/settings.json` enforce
  it: the Bash hook rejects any command whose text contains the filename
  (heredocs, `sed`, `--exclude=` included), and Read/Grep/Glob are blocked
  on the path. Edit docs that mention the file with Edit/Write, not Bash.
  Tests that need env files create their own under a temp dir at runtime.
- **Golden files** under `packages/projection/test/typegen/__golden__/`:
  regenerate with `UPDATE_GOLDEN=1 pnpm exec vitest run test/typegen` from
  `packages/projection`, then review `git diff`. Any value of
  `UPDATE_GOLDEN` triggers a rewrite. Goldens live under `test/`, the
  `tools.d.ts` golden is typechecked by `tsc --noEmit`, and all of them are
  oxfmt-exempt (`ignorePatterns` in `.oxfmtrc.json`) — never hand-edit or format them.
- **Live-spend gates**: anything that calls the Anthropic API must be
  explicit opt-in (`PROJ_LIVE_BENCH=1` + non-empty `ANTHROPIC_API_KEY`), so a
  plain `pnpm test` never spends tokens. Preserve this on new live tests.
  Live GitHub smoke needs `PROJ_LIVE_GITHUB=1` and `GITHUB_TOKEN` (or
  `GITHUB_PERSONAL_ACCESS_TOKEN`).
  `packages/harness/test/smoke/pack-install.test.ts` packs and installs from
  the npm registry on every `check` (with the consumer's own SDK, asserting a
  single copy, D40); set `PROJ_SKIP_PACK_SMOKE=1` when offline.
- **The MCP SDK is a peer dependency** (DECISIONS D40). In
  `packages/projection/package.json`, `@modelcontextprotocol/{client,server}`
  are `peerDependencies` at `~X.Y.Z` plus exact `devDependencies` at `X.Y.Z`
  for our own builds; harness and demo-host pin the same exact version. To
  bump: diff the new release's `dist` against what Projection uses (as D12
  did for 2.4.0), move every pin (projection devDependencies, harness,
  demo-host) together, and set `MCP_SDK_VERSION` in `src/blob/versions.ts`.
  On a patch release (2.4.0 → 2.4.1), move only the pins and keep the peer
  range. On a minor (2.4 → 2.5), also move the range to `~2.5.0` and
  `MCP_SDK_RANGE` with it. That narrows the range, so it is a public-surface
  change and needs a minor release. `test/blob/versions.test.ts` checks the
  pins, the range and the installed copy. Regenerate the goldens and re-run
  the pack smoke, because SDK minors have changed what the model sees (D12).
  Never put the SDK back in `dependencies`: that installs a second, private
  copy, and the consumer's `McpServer` fails Projection's `instanceof` check.
- **XState is pinned exactly** (5.32.5) and `@sebastianwessel/quickjs` at
  3.1.0 (PRD §7). Don't bump casually — blobs bind to the XState version.
- **Perf-budget tests** (`test/integration/budgets.test.ts`) are excluded
  from the parallel `test` run. `check` runs them afterwards through
  `pnpm run test:budgets` (`vitest.budgets.config.ts`). Each timing asserts
  the median p95 of 5 batches, so a failure there is a real regression: at
  least 3 of 5 batches were slow. The message lists every batch p95. Don't add the file back
  to the parallel run or loosen a ceiling (DECISIONS D41). Running other
  heavy work while you run `check` can still slow every batch.
- **Sandbox memory-cap tests** (`test/sandbox/caps.test.ts`) once flaked on
  CI by racing the wall-clock budget: QuickJS's own `memoryLimit` bounds a
  single allocation request, not total memory, so a hoard of sub-cap
  allocations ran to ~2 GB. Since DECISIONS D15 each session's WebAssembly
  memory `maximum` is the cap, hoards fail within tens of milliseconds, and
  the floor is 16 MB (the module's initial heap). A memory-cap test may
  hoard, but keep the per-request and doubling-sequence cases (D14): they
  pin the refusal of a single oversize request and the cap-determined end
  of a doubling sequence independently of machine load. Both are now
  enforced by the memory `maximum`; QuickJS's `memoryLimit` stays as a
  cheap early refusal, and no test detects its removal.
- `src/types.ts` is the shared contract. Export new public API through
  `src/index.ts` deliberately (DECISIONS D3).

## Where truth lives

- `docs/PRD.md` — requirements (R1–R64, plus R15a/R15b), security invariants (S1–S6), §10
  budgets/metrics, §13 verification and harness.
- `docs/DECISIONS.md` — why things are the way they are (SDK v2 MRTR
  adoption, AEAD sealer rationale, D4 replay obligation, D9 two
  projections). Append a decision entry when you make one worth remembering.
- Docs that restate behaviour and must change with it: `README.md`,
  `packages/projection/README.md`, `docs/server-authors.md` (options,
  defaults, tool descriptions), and the `AUTHORING_CONTRACT` text
  (`packages/projection/src/machine-host/contract.ts`) that the
  `authoring-machines` skill summarises.
