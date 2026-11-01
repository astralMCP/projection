# v4 Step 4.5 categorization: remaining multi-tier train failures

Scope: every failing v4 train episode of `global-csv-released` (12/12 fail) and
`global-last-log-entry` (sonnet-low, 2 fail), across both Projection modes.
For contrast I read the passing v3 episodes of `global-csv-released`. I read
train traces only. Report is lite, so the links below are trace paths.

Cell scores (multi phase, tasks passing all reps · episodes):

| cell               | v3            | v4            | csv v3 → v4   | last-log v3 → v4 |
| ------------------ | ------------- | ------------- | ------------- | ---------------- |
| projection haiku45 | 12/17 · 42/51 | 16/17 · 48/51 | 1,0,1 → 0,0,0 | 3/3 → 3/3        |
| projection sonnet  | 14/17 · 48/51 | 15/17 · 47/51 | 1,0,1 → 0,0,0 | 0,1,1 → 0,1,1    |
| boxes haiku45      | 11/17 · 38/51 | 16/17 · 48/51 | 0,0,0 → 0,0,0 | 3/3 → 3/3        |
| boxes sonnet       | 16/17 · 50/51 | 15/17 · 47/51 | 1,0,1 → 0,0,0 | 3/3 → 0,1,1      |

## Grader and fixture (as read)

- Prompt: "Has the CSV export feature been released yet? Tell me where you
  found the answer."
- `expect`: an `fs` read of `CHANGELOG.md`. `verify`: `/changelog/i` **and**
  `/unreleased|not (yet )?(been )?released|n['o]t (yet )?(been )?released|not yet/i`
  **and not** `/^\W*yes\b/i`. `pass` = `expect && verify` (run.ts:289-296).
- Fixture: `FIXTURE_CHANGELOG` lists `- Add CSV export` under `## Unreleased`
  (filesystem-world.ts:54). The GitHub fake has no CSV issue/PR, and
  `acme/widgets`' tree has no CHANGELOG.
- `last-log`: `expect` = an fs read of `logs/app.log`; `verify` = the answer
  contains `1399`.

## Per-episode buckets

| #   | episode (trace)                                                         | bucket                | final answer (verbatim, abridged)                                                                                                                                        | grader condition failed                                             |
| --- | ----------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 1   | `v4/traces/global-csv-released.haiku45.projection_rep0.json`            | Harness (eval config) | none: turn-capped (24 turns) after 10 GitHub calls; last call `github.get_repository_tree`                                                                               | `expect` (no fs read); no final text                                |
| 2   | `v4/traces/global-csv-released.haiku45.projection_rep1.json`            | Harness (eval config) | "Based on my search, **there is no evidence that the CSV export feature has been released yet**." (sources: GitHub issues, PRs, code search, releases only)              | `expect`; `verify` (no "changelog", no not-released phrase)         |
| 3   | `v4/traces/global-csv-released.haiku45.projection_rep2.json`            | Harness (eval config) | none: turn-capped; last call `github.list_discussions` returned `{"ok":true}`                                                                                            | `expect`; no final text                                             |
| 4   | `v4/traces/global-csv-released.haiku45.projection-boxes_rep0.json`      | Harness (eval config) | none: turn-capped; last result `404 Not Found: issue #42.`                                                                                                               | `expect`; no final text                                             |
| 5   | `v4/traces/global-csv-released.haiku45.projection-boxes_rep1.json`      | Harness (eval config) | none: turn-capped; reached fs at turn ~19 (`fs.search_files` `**/*CSV*` → "No matches found"), then GitHub `readme.md`                                                   | `expect`; no final text                                             |
| 6   | `v4/traces/global-csv-released.haiku45.projection-boxes_rep2.json`      | Harness (eval config) | none: turn-capped; reached `search_fs` at the end, last call `fs.search_files` failed validation ("path" missing)                                                        | `expect`; no final text                                             |
| 7   | `v4/traces/global-csv-released.sonnet-low.projection_rep0.json`         | Harness (eval config) | "I can't confirm that the CSV export feature has been released. I found no evidence about it either way. … I didn't search the code, commits, project files or MongoDB." | `expect`; `verify` (no "changelog", no not-released phrase)         |
| 8   | `v4/traces/global-csv-released.sonnet-low.projection_rep1.json`         | Harness (eval config) | "I couldn't confirm whether the CSV export feature has been released. … A changelog or release notes in the project files might answer this."                            | `expect`; `verify` (has "changelog", fails the not-released clause) |
| 9   | `v4/traces/global-csv-released.sonnet-low.projection_rep2.json`         | Harness (eval config) | "I can't confirm that the CSV export feature has been released. I found no evidence either way. … I didn't check the project files or the MongoDB deployment"            | `expect`; `verify`                                                  |
| 10  | `v4/traces/global-csv-released.sonnet-low.projection-boxes_rep0.json`   | Harness (eval config) | "I couldn't confirm whether the CSV export feature has been released. … If you want, I can search the local files, for example a changelog"                              | `expect`; `verify` (has "changelog", fails the not-released clause) |
| 11  | `v4/traces/global-csv-released.sonnet-low.projection-boxes_rep1.json`   | Harness (eval config) | "I couldn't confirm whether the CSV export feature has been released. … such as a different repo, a different name for it, or a changelog file"                          | `expect`; `verify` (has "changelog", fails the not-released clause) |
| 12  | `v4/traces/global-csv-released.sonnet-low.projection-boxes_rep2.json`   | Harness (eval config) | "I couldn't find an answer. The searches returned nothing about a CSV export feature, so I can't say whether it has been released."                                      | `expect`; `verify`                                                  |
| 13  | `v4/traces/global-last-log-entry.sonnet-low.projection_rep0.json`       | Variance              | "I can't answer this because there's no `app.log` in the project files."                                                                                                 | `expect` (never read `logs/app.log`); `verify` (no `1399`)          |
| 14  | `v4/traces/global-last-log-entry.sonnet-low.projection-boxes_rep0.json` | Variance              | "I can't answer that because there's no `app.log` in the project directory. I tried reading it directly, and I also searched for `app.log` and for any `*.log` file."    | `expect`; `verify`                                                  |

Counts: harness (eval config) 12, variance 2, grader disagreement 0, artifact
gap 0, structural 0. **0 of 14 remaining failures are grader errors, and none
is a v3→v4 Projection copy regression.**

## Why `global-csv-released` is a harness-config shift, not a grader error, not variance

**The grader is right.** No episode read `CHANGELOG.md`. No final answer says
the feature is unreleased _because of evidence_. Sonnet says "no evidence
either way", and haiku rep1 says "no evidence that … has been released yet",
both from GitHub-only searches. Three sonnet answers contain "changelog", but
only as a place to look next. They correctly fail the not-released clause,
and they would fail `expect` anyway. The prompt asks "where you found the
answer", so requiring the changelog matches the prompt. No predicate change
would correctly pass any of these 12.

**It is not variance.** v3 passed 6/12 of these episodes and v4 passes 0/12
(Fisher one-sided p ≈ 0.007). The mechanism shows up in the first turn,
before any tool result:

| first-turn search calls include `search_fs` | v3   | v4   |
| ------------------------------------------- | ---- | ---- |
| sonnet-low (both modes)                     | 5/6  | 0/6  |
| haiku45 (both modes)                        | 1/6  | 0/6  |
| episodes that ever touched an fs tool       | 7/12 | 2/12 |

Every v3 pass came from an episode that opened `fs` (e.g.
`v3/traces/global-csv-released.sonnet-low.projection-boxes_rep0.json`:
`search_github` + `search_fs` in parallel, then `fs.list_allowed_directories`,
`fs.search_files`, `fs.read_text_file CHANGELOG.md`, then "No. The CSV export
feature hasn't been released yet. I found this in `CHANGELOG.md` …"). The
v3 sonnet traces show why it looked around: "I don't know which repo, so I'll
search for it." / "I don't know the repo yet".

**What changed the first turn:** the system prompt differs from v3 to v4 in
exactly three lines, the shelf. The multi preamble and the
`call_tool`/`execute_machine` copy are v3's, unchanged:

```
-- fs (14 tools)
-- github — "The GitHub MCP Server provides tools to interact with GitHub platform." (server's words) (95 tools)
-- mongo (21 tools)
+- fs — The user's project files (14 tools)
+- github — GitHub: issues, PRs and repos for acme/widgets (95 tools)
+- mongo — The shop MongoDB deployment (21 tools)
```

The same text heads each `search_<box>` tool description (`boxSearchCopy`).
The GitHub description names the repository and lists "issues, PRs". That
answers the one question that sent v3 sonnet into `fs` (which repo?), and it
maps "has the feature been released" onto GitHub. "The user's project files"
gives no hint of a changelog. Every v4 episode opened with `search_github`
alone. Sonnet ran three GitHub reads (PR search, releases, issue search),
got nothing, and stopped, often naming the right next step ("A changelog or
release notes in the project files might answer this") without taking it.
Haiku hunted GitHub until the turn cap (5/6 capped). It spent 2-5 turns
passing content queries ("CSV export", "CSV", "export") to `search_github`,
which searches tool names. It reached `fs` in only two episodes, too late.

**Output schemas did not matter here.** GitHub declares none ("Output
schema: none declared" in every `describe_tool` of a GitHub tool in these
traces). The `fs` `call_tool` rendering is unchanged from v3, which already
printed the forwarded `structuredContent` (`{ "content": "No matches found" }`
in both rounds). Only 2/12 episodes called any fs tool, both after the
GitHub-first decision.

**Why "harness" and not "artifact gap":** the cause is an eval-config input
the maintainer chose on purpose (host box descriptions, harness-change-2),
not missing or regressed Projection copy. It is not an infra error: the
episodes are scorable and the descriptions are truthful. The task's
difficulty changed. Under a realistic host config it now measures whether
the model looks past the box the host labelled for the project's
issues/PRs/repos. The descriptions are net positive elsewhere: haiku gating
12/17 → 16/17 tasks. That gain mixes in the output-schema change and is not
cleanly attributable.

**Secondary fidelity defects in the GitHub fake.** These are not causal for
the 0/12, but they muddy the evidence the model sees:

- `list_releases`, `get_latest_release`, `search_code` and
  `list_discussions` on `acme/widgets` return the fake's default
  `{"ok":true}` (github-fake.ts:665-667: "Anything not listed answers
  `{ ok: true }`"). Real GitHub returns `[]` / 404. Sonnet flags this in
  every episode: "The repo may have no releases, or the tool may not have
  returned the data. I can't tell which."
- `search_issues` / `search_pull_requests` without `owner`/`repo` return the
  basic tier's static hits (issue #42 "Crash on startup", PRs #7/#9), which
  then 404 on `acme/widgets` (`404 Not Found: issue #42.`, `404 Not Found:
  pull request #7.`). This cost haiku boxes rep0/rep2 several turns before
  the cap.

## Why `global-last-log-entry` (sonnet) is variance

Both failures follow the same path. `fs.read_text_file {"path":"app.log","tail":5}`
returns ENOENT. Then `fs.search_files` with `path: "."` and `pattern: "app.log"`
/ `"*.log"` / `"log"` returns `{ "content": "No matches found" }`. That is the
upstream server's correct glob behaviour, since the file is
`logs/app.log` and the pattern is not recursive. Sonnet then stops without
`directory_tree`. Sonnet skipped `describe_tool`, which shows the server's
`'**/*.ext'` hint, although Projection's copy says to describe first. The
passing reps of the same cells add `directory_tree` or `list_directory` and
read `logs/app.log`. The identical failure occurred in v3
(the same calls, `fs.read_text_file, fs.search_files, fs.search_files`,
answer "I couldn't find app.log, so I can't give you a request id", in
`v3/traces/global-last-log-entry.sonnet-low.projection_rep0.json`). The
gating cell is 2/3 in both rounds, and boxes 3/3 → 2/3 is one episode. Output
schemas changed nothing: v3 rendered the same `{ "content": "No matches
found" }`. The `tool_ok=1` on these rows comes from the `steps` check (an fs
read tool was called), not from `expect`. `expect` fails, so the episodes
are correctly failed.

## Recommendations

1. **Grader: no change.** None of the 14 failures is a grader disagreement,
   so nothing needs re-grading. v4 stands as scored: haiku gating
   **16/17 · 48/51**, sonnet gating **15/17 · 47/51**; boxes haiku 16/17 ·
   48/51, boxes sonnet 15/17 · 47/51.
2. **Box descriptions (harness config): keep them, and do not tune them to
   the task.** Adding "changelog" to the fs description would teach to the
   test. Record in `narrative.md` that, under host descriptions,
   `global-csv-released` measures cross-box persistence. Its v3→v4 drop
   (6/12 → 0/12) is a harness effect inside the v4 re-baseline, not a
   library regression.
3. **Projection hypothesis (optional, below the noise floor for a full
   round).** The behaviour is concluding "not found" after the one box the
   host's description points at. Ceiling: `global-csv-released` is 6 gating
   episodes, 5.9 pts pooled, at the ±6.1 floor. Per the guide, a full fix
   lands inside noise, so it should not get a full round by itself. If you
   want to test it, run a targeted probe first: the csv task only, ~10 reps
   per cell, v4 vs v4+patch, about $1-2. Run a full round (multi + guard)
   only if the probe moves it. The guard is single-server, so this copy
   cannot reach it. One hypothesis, as a diff:

   ```diff
   --- a/packages/projection/src/multi/facade.ts
   +++ b/packages/projection/src/multi/facade.ts
   @@ export function defaultMultiPreamble(options: MultiPreambleOptions): string {
      const listing = `${find}; without a query, a box's search lists the box and leads with its own guidance.`;
   +  const elsewhere =
   +    'When the user does not say which box holds the answer and a lookup in one box finds nothing, look in the other boxes that could hold it before answering that it is not there.';
      const steps = `${listing} Then call describe_tool to see a tool's arguments and call_tool to run it.`;
      if (!projections.codeMode) {
   -    return `This server fronts several toolboxes, each wrapping another server. Call ${steps} Tools that change something may pause ${APPROVAL_SENTENCE_TAIL}`;
   +    return `This server fronts several toolboxes, each wrapping another server. Call ${steps} ${elsewhere} Tools that change something may pause ${APPROVAL_SENTENCE_TAIL}`;
      }
   -  return `This server fronts several toolboxes, each wrapping another server, and offers two ways to use their tools. For a single action or a short chain where you look something up and then act on it, call ${listing} Then call describe_tool to see a tool's arguments and call_tool for each step, reading each result before the next. Author an XState v5 state machine and run it with execute_machine only when the work loops or branches over results, takes many steps, or is a workflow worth saving (call discover_apis first for every box's tool types, the authoring contract, and worked examples). Either way, tools that change something may pause ${APPROVAL_SENTENCE_TAIL}`;
   +  return `This server fronts several toolboxes, each wrapping another server, and offers two ways to use their tools. For a single action or a short chain where you look something up and then act on it, call ${listing} Then call describe_tool to see a tool's arguments and call_tool for each step, reading each result before the next. ${elsewhere} Author an XState v5 state machine and run it with execute_machine only when the work loops or branches over results, takes many steps, or is a workflow worth saving (call discover_apis first for every box's tool types, the authoring contract, and worked examples). Either way, tools that change something may pause ${APPROVAL_SENTENCE_TAIL}`;
   ```

   If applied, this also touches the preamble assertions in
   `test/multi/wire.test.ts`, the R44 text in `docs/PRD.md` and the
   multi-preamble excerpt in `docs/server-authors.md`. A separate
   observation, deliberately not bundled: haiku passes content queries to
   `search_<box>`, which matches tool names only. This was also present in
   v3, and the copy already says so.

4. **GitHub fake fidelity (separate harness change, low priority).** Make
   `list_releases` return `[]` and `get_latest_release` return a 404 for
   `acme/widgets`. Scope repo-less `search_issues`/`search_pull_requests` to
   hits that exist on the repo the model then reads. Not expected to flip
   csv on its own, since the answer still needs the changelog. It removes
   evidence the model can't interpret. It needs `--approve-harness` and a
   re-run, not a re-grade, and starts another re-baseline, so batch it with
   any other harness work.
5. **`global-last-log-entry`: variance, no action.** Same failure at the same
   rate as v3. If it recurs at 1/3 over more reps, the lever is the existing
   describe-before-call copy, not a new rule.
