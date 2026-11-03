# Projection

TypeScript monorepo: `@astral-mcp/projection` (the library — wraps any MCP
server in **code mode** (LLM-authored XState workflows) and a **tool catalog**
(search, describe, call), with **human-approved side effects** over MCP
MRTR), `@astral-mcp/harness` (scenario tests +
reasoning-loop benchmark), `@astral-mcp/demo-host` (MCP Apps browser demo, `apps/demo-host`).

## Commands

- `pnpm run check` — build + typecheck + lint + test, all packages. The gate
  for every change.
- `pnpm run format` — always run before committing; CI fails on oxfmt
  drift in any committed file.
- Node ≥22.12 is required (`engine-strict`). The maintainer's machine provides
  Node via mise (24 LTS, on PATH in every shell — no PATH prefix needed); CI
  tests Node 22 and 26.

## Before you change anything

Read the `contributing` skill (`.claude/skills/contributing/SKILL.md`): one
PR per change, review subagents → fix subagent → squash-merge. Repo gotchas
and release steps are in the `contributing` skill (worktrees, Node ≥22.12,
env-file hook, goldens, flaky budget test, XState pin, live-spend gates,
releasing).

When writing machine fixtures or scenarios, use the `authoring-machines`
skill (`.claude/skills/authoring-machines/SKILL.md`).

Requirements live in `docs/PRD.md` (R-numbers, S1–S6 invariants);
integration guide in `docs/server-authors.md`; rationale in
`docs/DECISIONS.md` — append to it when you make a durable decision.
