# Projection

TypeScript monorepo: `@astral-mcp/projection` (the library — wraps any MCP
server in **code mode** (LLM-authored XState workflows) and a **tool catalog**
(search, describe, call), with **human-approved side effects** over MCP MRTR
(Multi Round-Trip Requests)), `@astral-mcp/harness` (scenario tests +
reasoning-loop benchmark), `@astral-mcp/tui` (Ink demo client),
`@astral-mcp/demo-host` (MCP Apps browser demo, `apps/demo-host`).

## Commands

- `pnpm run check` — build + typecheck + lint + test, all packages. The gate
  for every change.
- `pnpm run format` — always run before committing; CI fails on prettier
  drift in any committed file.

## Before you change anything

Read the `contributing` skill (`.claude/skills/contributing/SKILL.md`): one
PR per change, review subagents → fix subagent → squash-merge. Repo gotchas
(worktrees, Node 22, env-file hook, goldens, flaky budget test, releasing)
are in the `contributing` skill.

When writing machine fixtures or scenarios, use the `authoring-machines`
skill (`.claude/skills/authoring-machines/SKILL.md`).

Requirements live in `docs/PRD.md` (R-numbers, S1–S6 invariants);
integration guide in `docs/server-authors.md`; rationale in
`docs/DECISIONS.md` — append to it when you make a durable decision.
