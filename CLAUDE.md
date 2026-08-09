# Projection

TypeScript monorepo: `@astral-mcp/projection` (the library — wraps any MCP server into a
code-mode server with human-approved side effects, on MCP 2026-07-28 MRTR +
XState v5), `@astral-mcp/harness` (scenario tests + reasoning-loop benchmark),
`@astral-mcp/tui` (Ink demo client).

## Commands

- `pnpm run check` — build + typecheck + lint + test, all packages. The gate
  for every change.
- `pnpm run format` — always run before committing; CI fails on prettier
  drift in any committed file.

## Before you change anything

Read the `contributing` skill (`.claude/skills/contributing/SKILL.md`): one
PR per change, review subagent → fix subagent → squash-merge, and the repo
gotchas (.env is hook-blocked, golden files are format-exempt, live API
tests are opt-in gated, XState pinned exactly).

When writing machine fixtures or scenarios, use the `authoring-machines`
skill (`.claude/skills/authoring-machines/SKILL.md`).

Requirements live in `docs/PRD.md` (R-numbers, S1–S6 invariants); rationale
in `docs/DECISIONS.md` — append to it when you make a durable decision.
