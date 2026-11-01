# Harness change 2: output schemas through the recording proxy; box descriptions on for the multi tier

Maintainer decision, for eval fidelity: the eval should show Projection the
upstream surface an integrator's facade would see. Two places fell short.

## What changed

1. **The recording proxy mirrors output schemas**
   (`packages/harness/src/eval/recording-proxy.ts`). Each mirrored tool is
   registered with the real server's `outputSchema` when it declares one,
   and `structuredContent` is still forwarded. Before this change the proxy
   dropped output schemas. Projection therefore introspected every
   filesystem and MongoDB tool as "Output schema: none declared", generated
   no `Output` types for them, and applied contract rule 8's
   undeclared-output wording. Wrapping those servers directly would have
   shown their schemas.
   - Declared and now visible: **filesystem 14/14** and **MongoDB 21/21**
     tools. None had to be excluded.
   - Mirroring a schema makes the proxy's SDK validate each forwarded
     `structuredContent` against it, and turn a non-error result that has
     none into a tool error. Both servers conform. A probe called all 35
     tools once or more, including empty results (find/aggregate with no
     match, an empty directory, a search with no hits, no-op update/delete,
     dropping a missing collection) and an error path, and found no output
     validation failure. The worlds' golden-fidelity tests replay every
     golden through the proxy and fail on any error result.
   - `WorldTool` gains an optional `outputSchema`. Direct mode never shows
     it to the model (the Messages API tool definition has no output
     schema), and direct-mode results render content first as before, so
     direct mode is unaffected.
   - **The GitHub fake is unchanged.** It registers no output schemas: its
     canned answers are JSON text with no `structuredContent`, which does
     not conform to GitHub's real output schemas. The dumped fixture has an
     `outputSchema` field but records none (0/95). The `github` box
     therefore still shows "none declared". This is noted in
     `github-fake.ts` and the harness README.
2. **Box descriptions on for the multi tier** (`run-round.sh`). The `multi`
   phase now runs with `PROJ_EVAL_BOX_DESCRIPTIONS=1`, so `wrapMcpServers`
   gets the host's box descriptions (`MULTI_BOX_DESCRIPTIONS`), as an
   integrator would configure them. The guard tiers are single-server and
   have no boxes, so the flag does not apply to them. The direct reference
   phase is unchanged.
3. **Recorded in every round.** The live test writes `outputSchemas: true`
   into the results file next to `boxDescriptions` (`ResultsMeta`).
   `export.mjs` copies both into `summary.json` under `phases.<phase>`. The
   v4 multi phase will read `boxDescriptions: true, outputSchemas: true`,
   and the guard phase `boxDescriptions: false, outputSchemas: true`.
   `run-round.sh` refuses to adopt a results file whose flags do not match
   the phase's (exit 1).
4. **Tests** (`packages/harness/test/eval/`):
   - filesystem: all 14 tools carry an output schema, `tools/list` through
     the proxy serves each verbatim, `describe_tool` through a Projection
     facade shows `Output schema (JSON Schema):` for `read_text_file`, and
     a structured `call_tool` result passes the proxy's validation.
   - MongoDB: all 21 tools carry one, and `describe_tool` shows it for
     `find`, `count` and `drop-collection`.
   - multi: `describe_tool` on the multi facade shows output schemas for
     `fs.read_text_file` and `mongo.count`, and "none declared" for
     `github.get_me`.
   - multi: `runToolChoiceEval({ boxDescriptions })` reaches
     `wrapMcpServers`. With `true`, every description is on the shelf in
     both projection modes; with `false`, none is.

## Comparability

Rounds before this change (baseline, v1–v3) and after it are **not directly
comparable**. The change touches every Projection cell:

- **Multi tier:** the `fs` and `mongo` boxes now show output schemas and
  `Output` types, and every box has a host description on the shelf.
- **Guard:** the filesystem and MongoDB tiers (30 of its 60 tasks per
  model) now show output schemas. Box descriptions do not apply.
- **Direct reference:** unaffected (context only).

The next run, **`v4`, is the re-baseline**: v2's single-server library plus
v3's multi-only routing copy (`v4/change.md`), under the new harness. Its
numbers are the reference for later rounds. They cannot be split into
library effect and harness effect. Its guard measures v2's single-server
library (byte-identical copy) under the new harness, so it re-baselines
the guard as well. `_state.json.best`, `baseline` and the noise floors
describe the old harness, and should be re-anchored on v4 once it lands.

The harness hash (`_state.json.harness_sha`) no longer matches, so
`run-round.sh` stops with exit 2 until the maintainer re-runs it with
`--approve-harness`.
