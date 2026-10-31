# Basecamp: servers-real (`summit-local` tier)

A new opt-in, **held-out** eval tier, `summit-local`: 24 tasks on six
**real** MCP servers that run locally for free, seeded with one company's
data (a billing service called tidepool). Calibrated in `direct` mode only.
No facade code or hill-climb notes were read; Projection modes were never
run on this tier.

## What was built

- `packages/harness/src/eval/summit-local-world.ts`: the world. It builds a
  temp dir per episode (the git checkout, the memory graph file, the SQLite
  database), serves the intranet on a loopback port, spawns the six servers
  over stdio behind `createRecordingProxy`, and records every call as
  `<alias>.<tool>`. It checks each server's reported name and version and
  its exact tool list. `close` stops the servers and the intranet and
  removes the dir.
- `summit-local-fixtures.ts`: all seed data, and every expected answer
  derived from it (the tests pin them as literals).
- `summit-local-tasks.ts`: 24 tasks and their graders.
- `test/eval/summit-local.test.ts`: offline tests. They cover
  registration and composition, pinned expected values, every grader
  against correct answers and near misses, and forbid predicates. With the
  servers installed they also run the real world: identities and tool
  lists, the fixture as the servers serve it, every write task's correct
  path and a near miss replayed through the real servers and graded on
  the end state, deterministic hashes, and teardown (dir removed,
  intranet closed).
- The tier is registered in `task-core.ts` (`TaskTier`, `TASK_TIERS`,
  `TIER_WORLDS`; not in `DEFAULT_TIERS`), `world.ts` (`WorldName`,
  `BoxAlias`, `openWorld`), `tasks.ts`, `multi-tasks.ts` (`isBoxWrite`),
  `index.ts`, the live test's knob docs and pre-flight check, and the
  harness README.

## Servers (pinned) and how to install

| Box      | Server                                           | Version                            | Install                                                   |
| -------- | ------------------------------------------------ | ---------------------------------- | --------------------------------------------------------- |
| `fs`     | `@modelcontextprotocol/server-filesystem`        | 1.0.0                              | existing workspace devDependency                          |
| `git`    | `mcp-server-git` (Python)                        | 2026.10.19                         | `vendor/servers-real/requirements.txt` → `.venv`          |
| `memory` | `@modelcontextprotocol/server-memory`            | 2.0.0                              | `vendor/servers-real/package.json` + lock                 |
| `sqlite` | `mcp-server-sqlite` (Python, archived reference) | 2025.4.25 (reports `sqlite` 0.1.0) | `requirements-sqlite.txt` → `.venv-sqlite` (pins `mcp<2`) |
| `fetch`  | `mcp-server-fetch` (Python)                      | 2026.10.19                         | `.venv`                                                   |
| `time`   | `mcp-server-time` (Python)                       | 2026.10.19                         | `.venv`                                                   |

`pnpm run setup:servers-real` in `packages/harness` runs
`scripts/setup-servers-real.sh`: `npm ci` for the memory server, then `uv`
venvs on Python 3.12 synced from hash-pinned requirements. Versions were
picked to be at least 7 days old (`uv pip compile --exclude-newer
2026-10-24`). The archived SQLite server crashes on the 2.x Python MCP SDK
(it registers `list_resources`), so it gets its own venv on 1.x. When the
servers are missing, the world tests skip with that message, and a live run
that selects the tier throws before spending anything.

Offline guarantees:

- fetch runs with `HTTP(S)_PROXY` set to a dead port, `NO_PROXY` set to
  loopback, `--allow-private-ips` and `--ignore-robots-txt`. Node is not on
  its PATH, because readabilipy otherwise runs `npm install` on first use.
  The test confirms `https://example.com/` fails.
- git runs with a private HOME and no system or global config. The history
  comes from `git fast-import` with fixed identities and dates, so hashes
  are identical across episodes and machines.

Not used: `server-everything` is a protocol test server, not something
users connect to.

## Run it

```bash
pnpm --filter @astral-mcp/harness run setup:servers-real
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN PROJ_LIVE_EVAL=1 PROJ_EVAL_MODES=direct \
  PROJ_EVAL_TIERS=summit-local PROJ_EVAL_RUNS=2 PROJ_EVAL_CONCURRENCY=4 \
  pnpm --filter @astral-mcp/harness exec vitest run test/tool-choice.live.test.ts
```

## Fidelity sources

These are the real servers, not fakes: tool names, descriptions, schemas,
annotations, output schemas, errors, paging and result formats are the
servers' own. Server quirks the tasks rely on, all verified against the
installed source:

- `git_diff` takes a single ref and rejects ranges.
- `git_log` follows HEAD only and defaults to `max_count` 10.
- There is no tag-listing tool.
- `git_branch` has `contains`/`not_contains`.
- `fetch` pages at 5000 characters with a `start_index` hint, and returns
  JSON raw with a prefix note.
- sqlite's `read_query` returns a Python repr.
- `convert_time` converts on today's date.
- The memory server skips duplicate `create_entities`.

## The tasks (10 single-box, 14 cross-box)

| Task                            | Boxes                | One line                                                                                                      |
| ------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `sl-git-kenji-owned-commits`    | git                  | Commits on main since v2.3.0 that touch files CODEOWNERS gives @kenji-s (last match wins; by hash)            |
| `sl-git-release-files`          | git                  | Files changed between v2.2.0 and v2.3.0 (no range diff; a revert inside the range)                            |
| `sl-git-commit-staged`          | git                  | Commit exactly what's staged, leave the other work in progress alone                                          |
| `sl-git-unmerged-branches`      | git                  | Local branches with commits not on main (`not_contains: main` trap: two fast-forwarded branches)              |
| `sl-sql-close-stale`            | sqlite               | Close pending tickets last updated before 2026-09-01 (one old-helpdesk `2026/08/19` row)                      |
| `sl-sql-overdue-follow-up`      | sqlite               | Per overdue customer: comment (as agent id) on the newest open ticket, or open one (slashed dates sort wrong) |
| `sl-mem-billing-manager`        | memory               | Billing's owner and their manager (former owner decoy)                                                        |
| `sl-mem-kenji-moves`            | memory               | Move Kenji from Billing to Platform and add a note; nothing else changes                                      |
| `sl-fetch-primary-weeks`        | fetch                | Primary weeks per engineer for rota weeks starting Jul–Dec (page boundary at 5000 chars)                      |
| `sl-fetch-q3-incidents`         | fetch                | Sev1+sev2 incidents per service in Q3 UTC across 4 API pages (23:40 / 00:20 boundary)                         |
| `sl-x-deploy-times`             | memory, time         | Billing team's local times for Dana's 16:00 deploy                                                            |
| `sl-x-ticket-call-time`         | sqlite, memory, time | Ticket #1057's account owner and the owner's time for the customer's 10:00                                    |
| `sl-x-codeowners-timezones`     | fs/git, memory       | Code owners of export.py and their time zones                                                                 |
| `sl-x-release-ticket-customers` | git, sqlite          | Customers whose tickets were fixed by changes that shipped in v2.3.0 (reverted fix excluded)                  |
| `sl-x-untagged-deploys`         | sqlite, git/fs       | Deployed versions with no git tag                                                                             |
| `sl-x-overdue-csv`              | sqlite, fs           | Write reports/overdue-enterprise.csv, largest first                                                           |
| `sl-x-reassign-on-leave`        | memory, sqlite       | Reassign Lena's open/pending tickets to her manager per the graph                                             |
| `sl-x-team-page-sync`           | fetch, memory        | Reconcile the graph with the team page: two hires, a promotion, a move, no duplicates                         |
| `sl-x-unreleased-commits`       | fetch, git           | Commits on main since the last release cut from main (>10, so past git_log's default)                         |
| `sl-x-release-commit`           | fs, git              | Bump VERSION and CHANGELOG, commit only those two files while another file is already staged                  |
| `sl-x-incident-culprit`         | fetch, git, memory   | The INC-2041 culprit commit's author and their manager                                                        |
| `sl-x-after-hours-tickets`      | memory, sqlite       | Lena's reports' tickets opened outside 09–17 customer-local (DST switches, Arizona, +5:30)                    |
| `sl-x-incident-tickets`         | fetch, sqlite        | Ensure an INC-2041 ticket per affected customer (legal names, one not ours, one already has one)              |
| `sl-x-oncall-assign`            | fetch, sqlite        | Assign unassigned urgent open tickets to the week's primary on call                                           |

Every task has a deterministic grader. Answers come from an `ANSWER:` line
or are read row by row. Writes are graded on the real end state, and
harmful writes are forbidden. Each task has a 2N + 10 action-turn budget.
The box descriptions in `SUMMIT_BOX_DESCRIPTIONS` are one line each and
equally specific.

## Live calibration (direct mode, 2 runs, final task set)

Results file: `eval-results/2026-10-31T18-03-11.106Z.json`, re-scored
offline after fixing a row-parser bug. Haiku's `sl-fetch-primary-weeks` had
the right counts; the parser was reading a dated line as a row. The
re-scored file is `*.rescored.json`.

| Model      | Success         | Mean turns | Cost  |
| ---------- | --------------- | ---------- | ----- |
| sonnet-low | **47/48 (98%)** | 4.7        | $2.25 |
| haiku45    | **35/48 (73%)** | 7.4        | $1.22 |

| Task                          | Sonnet | Haiku |
| ----------------------------- | ------ | ----- |
| sl-git-kenji-owned-commits    | 2/2    | 1/2   |
| sl-git-release-files          | 2/2    | 1/2   |
| sl-git-commit-staged          | 2/2    | 2/2   |
| sl-git-unmerged-branches      | 1/2    | 0/2   |
| sl-sql-close-stale            | 2/2    | 0/2   |
| sl-sql-overdue-follow-up      | 2/2    | 2/2   |
| sl-mem-billing-manager        | 2/2    | 2/2   |
| sl-mem-kenji-moves            | 2/2    | 2/2   |
| sl-fetch-primary-weeks        | 2/2    | 2/2   |
| sl-fetch-q3-incidents         | 2/2    | 0/2   |
| sl-x-deploy-times             | 2/2    | 2/2   |
| sl-x-ticket-call-time         | 2/2    | 2/2   |
| sl-x-codeowners-timezones     | 2/2    | 2/2   |
| sl-x-release-ticket-customers | 2/2    | 1/2   |
| sl-x-untagged-deploys         | 2/2    | 2/2   |
| sl-x-overdue-csv              | 2/2    | 1/2   |
| sl-x-reassign-on-leave        | 2/2    | 2/2   |
| sl-x-team-page-sync           | 2/2    | 1/2   |
| sl-x-unreleased-commits       | 2/2    | 2/2   |
| sl-x-release-commit           | 2/2    | 1/2   |
| sl-x-incident-culprit         | 2/2    | 2/2   |
| sl-x-after-hours-tickets      | 2/2    | 2/2   |
| sl-x-incident-tickets         | 2/2    | 2/2   |
| sl-x-oncall-assign            | 2/2    | 1/2   |

No task fails every Sonnet rep. Every Haiku failure I read was genuine. For
example, it missed the slashed-date row, counted billing as 5, fell for
`not_contains: main`, ran `git_checkout` in a dirty tree (forbidden), added
the new role next to the old one, and missed Marco's auth commit.

## Open problems

- **Sonnet is saturated (98%), above the 70–90% target.** It took three
  hardening rounds, all of which Sonnet mostly saw through: a revert inside
  the release range, legacy date formats, DST and half-hour offsets,
  CODEOWNERS last-match, legal-name matching, a `not_contains` trap, a
  graph reconciliation, and a branching write. The spend cap stopped a
  fourth round. Next candidates:
  - longer accumulation (N ≥ 25 per-item hops across two boxes);
  - tasks whose only correct path needs paging that a single big
    `max_length` cannot shortcut;
  - silent-truncation traps.
- `sl-x-after-hours-tickets` depends on the run date if a model uses
  `convert_time`, which converts on today's date. The grader is fixed, but
  the trap's bite varies with the season. Every other time task uses zones
  without DST.
- The memory server needs Node ≥ 24, while CI also runs Node 22. CI does
  not install the tier, so its world tests skip there. Adding
  `setup:servers-real` to CI needs uv on the runner and a maintainer
  decision on `.github/workflows`.
- `sl-x-after-hours-tickets` requires consulting the graph (`expect`), even
  though `agents.team` plus "not Lena" happens to give the same set.

## Spend

| Run       | What                                              | Cost               |
| --------- | ------------------------------------------------- | ------------------ |
| 1         | Sonnet, first 24-task draft, 1 rep                | $1.03              |
| 2         | Sonnet, 7 hardened tasks, 2 reps                  | $0.73              |
| 3         | Sonnet, 5 new tasks, 2 reps                       | $0.51              |
| 4         | Both models, final 24 tasks, 2 reps (calibration) | $3.47              |
| **Total** |                                                   | **$5.73** (cap $6) |
