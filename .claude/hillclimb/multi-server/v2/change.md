# v2: stop calling undeclared tool results "text"; show the shape before a machine parses it

## Applied

Applied on `hillclimb-multi` after reverting v1's source change (`c742bdd`;
v1's flow files kept as the record). The proposal patch applied cleanly.
De-fluff pass: two trims, no change of meaning: the describe head says "may
be a structured object or text" (dropped "still"), and rule 8 ends "run the
read on its own first (…) and write the machine against the shape it
returns" (dropped the redundant "look at it, then"). Added one contract test
(`test/multi/code-mode.test.ts`: rule 8 no longer says "usually a string").
No golden changes. `pnpm run check` green. `change.patch` is the diff as
applied (against the v1-reverted tree); `copy.txt` has the full new copy.

## Behaviour targeted: (B) Haiku writes a machine around a result shape it has never seen

On a tool with no `outputSchema`, Projection tells the model the result is text, and the model believes it. In this world that is false for every
box. fs and mongo return `structuredContent` objects (`{ count: 4 }`,
`{ documents: [...] }`, `{ content: "..." }`), and the GitHub fake returns
JSON **text**. Haiku 4.5 reads `describe_tool`, then writes an
`execute_machine` workflow that `parseInt`s or regexes `event.result` as a
string. The first write (a public comment, a file) goes out with `NaN`,
`[object Object]`, an empty string or one title out of four.

The false copy appears in two places, both read just before the machine is written:

- `describe_tool` (src/catalog/describe.ts:158):
  `Output schema: none declared — results arrive as text.`
- the authoring contract in `discover_apis`, rule 8
  (src/machine-host/contract.ts:194): `Tools without an Output type are
  typed unknown — usually a string.`

The output schemas are missing in this world because the harness's recording proxy does not re-register output schemas
(`packages/harness/src/eval/recording-proxy.ts` header). The fs server
declares `{ content: string }` upstream, but the proxy drops it. That is a
fixed harness choice. Servers that return `structuredContent` without
declaring a schema, or that return JSON as text, are common in production
too, and the single-server tiers see the same false copy.

### Counts (train ids only, both rounds)

| cell                          | episodes with `execute_machine` | parsed blind (no `call_tool` of the read first) | failed |
| ----------------------------- | ------------------------------- | ----------------------------------------------- | ------ |
| haiku45 `projection` (gating) | 13                              | 13                                              | 9      |
| haiku45 `projection-boxes`    | 15                              | 15                                              | 10     |
| sonnet-low (both modes)       | 0 of 204                        | –                                               | –      |

Among haiku's gating episodes, every cross-box episode that used only `call_tool` passed. Every
cross-box failure is a blind machine. Per round, the gating haiku failures
from this behaviour are:

- baseline: 5 (`cross-shipped-to-comment` ×3, `cross-open-prs-to-notes`
  rep 2, `cross-email-to-todo` rep 1)
- v1: 4 (`cross-shipped-to-comment` ×3, `cross-open-prs-to-notes` rep 1)

`cross-shipped-to-comment` is 0/3 in all four haiku cells-rounds (12/12 failures).

### Evidence (verbatim)

The decision-time line is shown in every describe of an undeclared tool, e.g.
`v1/traces/global-who-is-grace.haiku45.projection_rep1.json`
(describe `mongo.list-databases`):

> Output schema: none declared — results arrive as text.

`baseline/traces/cross-shipped-to-comment.haiku45.projection_rep0.json`. The machine wrote:

```js
actions: assign({ shippedCount: ({ event }) => parseInt(event.result, 10) }),
...
body: `The shop database has ${context.shippedCount} orders with status "shipped".`,
```

It output `"shippedCount": null` (NaN). The model then used `call_tool` and saw:

> call_tool "mongo.count": ok
>
> { "count": 4 }

The episode still fails because the wrong count was already posted publicly.

`baseline/traces/cross-shipped-to-comment.haiku45.projection_rep1.json`:

```js
const match = event.result.toString().match(/\d+/);
commentBody: ({ context }) => `There are ${event.result} orders with status "shipped".`;
```

followed by: "I see the issue - the result is an object, not a string."

`v1/traces/cross-shipped-to-comment.haiku45.projection_rep0.json`:

```js
// Parse the result - it should be a number or string representation
if (typeof result === 'string') return parseInt(result, 10);
```

`v1/traces/cross-shipped-to-comment.haiku45.projection_rep1.json`, after
the comment was posted: "The machine returned 0 because the result came as
a structured object, not just text."

`v1/traces/cross-open-prs-to-notes.haiku45.projection_rep1.json`:

```js
// Parse the result - it comes as text with PR data
```

The first machine wrote an empty file. After a `call_tool`, a second
machine wrote 3 of 4 titles and ignored `"has_next_page":true`.

`baseline/traces/cross-open-prs-to-notes.haiku45.projection_rep2.json` treated the
compact JSON string as lines of text:

```js
const titleLines = lines.filter(line => line.includes('title')).map(line => { const match = line.match(/title['":\s]*:?\s*['"](.*?)['"]/i); ...
```

The file got one title.

`baseline/traces/cross-email-to-todo.haiku45.projection_rep1.json`:

```js
if (typeof result === 'string') { const match = result.match(/"email"\s*:\s*"([^"]+)"/);
```

This produced `"email": null`. Next, `content.endsWith` on fs's `{content}` object failed repeatedly with
`TypeError: not a function`, and the episode looped to the turn cap
(12 machines).

## Change

This is a single behaviour fix: tell the truth about undeclared result shapes at the two
places the model reads just before writing a machine, and give it a
way to look first.

1. **`describe_tool`** (src/catalog/describe.ts) now says the result
   of an undeclared output may be an object or text, and that JSON text reaches a machine as a
   string. For a tool that both runs immediately and is marked
   `readOnlyHint`, it also says to call it once with `call_tool` and
   look before a machine reads its fields, notes that `event.result` is that same
   value, and explains how `call_tool` prints an object versus text. Any other tool gets
   "Do not write code that depends on a result shape you have not seen."
   The line still starts with `Output schema: none declared`.
2. **Contract rule 8** (src/machine-host/contract.ts) replaces "usually a
   string" with "that does not mean text…". It adds: never parse a result you have
   not seen; run the read on its own first (`call_tool`, or a machine whose
   output is `event.result`). That wording works on the code-mode-only
   facade too.
3. Docs: `.claude/skills/authoring-machines/SKILL.md` gets the same
   correction (not model-facing).

```diff
diff --git a/packages/projection/src/catalog/describe.ts b/packages/projection/src/catalog/describe.ts
--- a/packages/projection/src/catalog/describe.ts
+++ b/packages/projection/src/catalog/describe.ts
@@ -155,7 +155,7 @@
   if (tool.outputSchema !== undefined) {
     lines.push('', 'Output schema (JSON Schema):', jsonBlock(tool.outputSchema));
   } else {
-    lines.push('', 'Output schema: none declared — results arrive as text.');
+    lines.push('', undeclaredOutput(tool));
   }
   if (tool.schemaTruncated) {
     lines.push(
@@ -173,6 +173,26 @@
     );
   }
   return lines.join('\n');
+}
+
+/**
+ * The output line for a tool that declares no `outputSchema`. Such a tool's
+ * result is not necessarily text: servers often return `structuredContent`
+ * without declaring a schema, and JSON text arrives as a string, so the
+ * `TOOL_RESULT.result` a machine receives (R35.5) can be an object or a
+ * string the model has never seen. A model told "text" writes
+ * `parseInt(event.result)` against `{ count: 4 }`. The line says the shape
+ * is unknown and, for a tool that only reads and runs without approval,
+ * says how to see it before code depends on it. Library copy; the posture
+ * and `readOnlyHint` it branches on are already shown or applied (R14, R33).
+ */
+function undeclaredOutput(tool: ToolDescription): string {
+  const head =
+    'Output schema: none declared — the result may still be a structured object, or text (sometimes JSON text, which a machine receives as a string).';
+  if (tool.posture === 'runs immediately' && tool.annotations.readOnlyHint === true) {
+    return `${head} Before a machine reads its fields, call it once with call_tool and look at the result: event.result is that same value (call_tool prints an object as indented JSON, text as it is).`;
+  }
+  return `${head} Do not write code that depends on a result shape you have not seen.`;
 }

 /**
diff --git a/packages/projection/src/machine-host/contract.ts b/packages/projection/src/machine-host/contract.ts
--- a/packages/projection/src/machine-host/contract.ts
+++ b/packages/projection/src/machine-host/contract.ts
@@ -191,7 +191,11 @@
    one (see its Output type in tools.d.ts); otherwise the text of its single
    text block, null for an empty result, or the raw content array for
    anything else. A tool that returns isError arrives as TOOL_ERROR. Tools
-   without an Output type are typed unknown — usually a string.
+   without an Output type are typed unknown, and that does not mean text:
+   many servers return an object without declaring it, and JSON text
+   arrives as a string. Never parse a result you have not seen — run the
+   read on its own first (call_tool, or a machine whose output is
+   event.result), look at it, then write the machine against that shape.
 9. Tool inputs such as paths, ids and names are server-specific. Do not guess
    them: take them from the machine's input, or discover them first with a
    read-only call (a list/search tool) and keep what you learn in context.
```

The full patch, with the test and the SKILL.md edit, is in `change.patch` in this directory. It
passes `git apply --check` against the worktree.

In this world, `mongo.count` gets this `describe_tool` line:

> Output schema: none declared — the result may still be a structured object, or text (sometimes JSON text, which a machine receives as a string). Before a machine reads its fields, call it once with call_tool and look at the result: event.result is that same value (call_tool prints an object as indented JSON, text as it is).

## Cases it should fix

- `cross-shipped-to-comment` (haiku45, both modes). In all 6 gating
  failures, haiku described `mongo.count` and then wrote the machine with no
  call in between. With the new line, the expected path is `call_tool mongo.count` →
  `{ count: 4 }` → post 4. Baseline rep 0 and v1 rep 1 show
  haiku doing exactly this once it saw the object, only after the wrong
  comment had already been posted.
- `cross-email-to-todo` (sporadic, 1/3 baseline): the `{content}` / `{documents}`
  shapes.
- `cross-open-prs-to-notes` (sporadic, 1/3 per round): the blind parse of the
  JSON string. This fix does **not** address the paging miss in the v1 rep 1
  failure (3 of 4 titles after seeing `has_next_page:true`). Partial at best.

## Expected gain

- **haiku45 gating:** max +5 episodes/round (+9.8 pts, 5/51). Expected
  +6 to +8 pts: `cross-shipped-to-comment` 0/3→3/3 is +5.9 pts and one
  more task fully passing (9→10 against v1 or 10→11 against baseline). The
  sporadic open-prs and email reps add another +0 to +2 pts. **This is inside the ±10.9-pt
  cell noise floor.** However, `cross-shipped-to-comment` failed every rep
  in both rounds, so it contributes 0 to the paired floor. A 3/3 flip on that
  task is a clean task-level signal even when the cell-level number is not.
- **sonnet-low gating:** 0. Sonnet never wrote a machine in 204
  train episodes.
- **Pooled gating:** about +3 to +4 pts, inside ±6.7.
- **Tracked haiku `projection-boxes`:** similar, with the same shipped task at 0/3 in both rounds.

## Why not (A), the unnamed-box prompts, although it is the larger pool

(A) is the larger pool: about 8 haiku and 1–2 sonnet gating episodes per round. I don't
target it because I can't see a fix with a real chance of landing:

- In 5 of the 5 `global-who-is-grace` gating failures, haiku made **zero tool calls**.
  For example, `baseline/traces/global-who-is-grace.haiku45.projection_rep1.json` says:
  "I don't have access to tools that can look up user information or order
  status directly … Could you provide more details about where this
  customer and order information is located?" The only surface it reads is
  the system prompt. v1's look-before-asking sentence and the shelf
  samples went there and did not move the task (0/3 → 1/3, within noise). The
  harness's own first line already names "MongoDB deployment". The narrative's
  direct-mode probe failed this task too on haiku, so it is a model prior,
  not a Projection surface.
- What the model lacks is what each box **holds**: a `shop` db with
  `customers`/`orders`, or that the project folder is "widgets". Projection
  cannot know this without calling each server's own listing tools
  (`list-databases`, `list_allowed_directories`). That is server-specific,
  would put live server data into the system prompt (an S5 surface), and
  the host-description route is harness-owned.
- The `search_tools` route only helps after a search. In
  `global-version-branch`/`global-csv-released`, haiku's searches matched
  GitHub tools ("get_latest_release", "list_releases") and it then asked. For example:
  "I need to know which repository you're referring to"
  (`v1/traces/global-version-branch.haiku45.projection_rep1.json`). A
  "no match" hint would not fire there.

If (A) is attempted later, the most promising option is host-supplied box descriptions saying what each
box holds. That is a harness or host change, not library copy.

## Requirement and security implications

- **No requirement change.** The `TOOL_RESULT.result` and R35.5 semantics are unchanged.
  Only the library's description of them is corrected. Suggest a one-paragraph
  DECISIONS.md entry: undeclared outputs are described as "unknown shape,
  look first", never as "text".
- **S5:** no server-sourced text is added. The branch on `readOnlyHint`, an
  untrusted hint, only picks between two library strings. A server that lies
  `readOnlyHint: true` already runs without approval under R14, so the
  "call it once" nudge grants nothing new. `posture` must also be
  `runs immediately`, so a host override to `ask`/`deny` suppresses it.
- **Guard:** single-server output is **not** byte-identical. Single-server
  facades share `describe_tool` and the contract. The same false claim
  reaches the guard's fs, mongodb and github tiers today, so the
  direction should be neutral to positive. The risk is an extra read call
  per machine-authoring episode, which costs a few tokens and is not a grader failure for read-only
  peeks. If the maintainer wants byte-identical single-server output,
  gate both edits on `isBoxedCatalog(catalog)` and on `samples !== undefined`
  in `authoringContract`. I recommend against that: the bug is not
  multi-specific.
- **Spend:** about +60 tokens per `describe_tool` of an undeclared tool and about +45
  tokens in `discover_apis`. Plus one `call_tool` per machine episode where
  the model takes the advice.

## Tests to update or add

- `packages/projection/test/catalog/describe.test.ts`: the existing assertion
  `toContain('Output schema: none declared')` (line 100) still holds. Add the
  new case in the patch: the read-only, runs-immediately branch says
  `call it once with call_tool`, the gated branch does not mention
  `call_tool`, and a declared schema is unchanged.
- No golden changes. `test/typegen/__golden__/*` contain neither string.
  The contract-substring assertions in `test/multi/code-mode.test.ts`
  (lines 628, 717–722) target rule 10 and the samples, which are unchanged.
- Optional: a contract test asserting rule 8 no longer says "usually a
  string".

## Follow-up if open-prs keeps failing

`call_tool` prints JSON text and objects both as JSON, compact and
indented. A short kind marker on the ok head (`ok (structured result)` /
`ok (text result)`) would remove the remaining string-versus-object ambiguity.
It is left out here to keep this to one behaviour and one set of surfaces.
