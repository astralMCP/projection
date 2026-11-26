/**
 * The program authoring contract (EXPERIMENTAL, DECISIONS D48) — what a
 * model reads on a facade whose `codeRuntime` is `psychoscript`: plain
 * JavaScript that awaits tool functions, instead of an XState machine.
 *
 * Every other model-facing text (tool descriptions, preambles, prompts,
 * `tools.d.ts`) is shared with the machine runtime and rewritten by
 * {@link forProgram}, so the two runtimes cannot drift apart silently: a
 * test asserts that no machine vocabulary survives on a program facade.
 */

import { DTS_IMPORT_LINES, DTS_TRANSPORT_LINES } from '../typegen/generate.js';
import { SAMPLE_NAMES_NOTE, sampleNote, type ToolSamples } from '../machine-host/contract.js';
import { DEFAULT_CAPS } from '../types.js';

/** How a sample tool is called in a program: `tools.read_file`, `tools.fs.read_file`. */
function callee(name: string): string {
  return name
    .split('.')
    .map((part, i) =>
      i === 0
        ? `tools.${part}`
        : /^[A-Za-z_$][\w$]*$/.test(part)
          ? `.${part}`
          : `[${JSON.stringify(part)}]`,
    )
    .join('');
}

/**
 * The authoring contract for programs (R3). `samples` is set on a
 * multi-server facade (R45) and adds the qualified-name rule; `caps` quote
 * the facade's own limits.
 */
export function programContract(
  samples?: ToolSamples,
  maxRoundTrips: number = DEFAULT_CAPS.maxRoundTrips,
): string {
  const read = samples?.read ?? { name: 'read_file', placeholder: false };
  const gated = samples?.gated ?? { name: 'write_file', placeholder: false };
  const qualifiedRule =
    samples === undefined
      ? ''
      : `9. Tool names on this server are qualified, <box>.<tool>, and each box is a
   property of tools: call ${callee(read.name)}(args) ${SAMPLE_NAMES_NOTE}.
   One program may call tools in several boxes; every call that asks for
   approval is approved on its own.
`;
  return `Projection authoring contract (execute_machine)

This server runs the code you send as a plain JavaScript PROGRAM — not an
XState machine, no imports, no exports. Write the body of an async function:
await tool calls at top level, and return the result.

  const file = await ${callee(read.name)}({ path: input.path })${sampleNote(read)}
  return { file }

Rules:
1. Call tools as async functions on the global tools object, with one plain
   object of arguments: await ${callee(read.name)}({ ... }). The input argument
   of execute_machine is the global input (null when you pass none). tools
   holds only the wrapped server's tools: search_tools, describe_tool and
   call_tool are tools of this MCP server, so call them directly, before
   writing the program, not as tools.search_tools(...) inside it.
2. Tools marked "asks for approval" pause the program until the user
   approves that exact call; the arguments at that moment are the ones that
   run. When the user answers, the program continues where it paused: calls
   already made are not made again, and variables keep their values.
3. Each pause is one approval round trip, and a workflow gets at most ${maxRoundTrips}.
   Start every gated call you can before awaiting any: Promise.allSettled
   (or Promise.all) over a list asks for all of them in ONE round trip,
   while awaiting them one by one in a loop costs a round trip each.

     const results = await Promise.allSettled(
       input.paths.map((path) => ${callee(gated.name)}({ path, content: 'hello' })),${sampleNote(gated)}
     )
     return results.map((r, i) => ({ path: input.paths[i], ok: r.status === 'fulfilled' }))

4. A declined call — or one this server's policy blocks — throws an Error
   named ToolDenied (e.reason: the user's note, if any; e.byPolicy: true when
   policy blocked it). A call that fails throws one named ToolError, with the
   server's message. Denial is not an abort: catch it and carry on or finish.
   An error you do not catch ends the run; calls that already ran stay done.
5. A tool's result is its structuredContent when the server returns one (see
   its Output type in tools.d.ts); otherwise the text of its single text
   block — already parsed when that text is JSON for an object or an array —
   null for an empty result, or the raw content array for anything else.
   Tools without an Output type return unknown, and that does not mean text.
   Never parse a result you have not seen: run the read on its own first
   (call_tool, or a program that returns it) and write against its shape.
6. Tool inputs such as paths, ids and names are server-specific. Do not guess
   them: take them from input, or discover them first with a read-only call.
7. The language is strict modern JavaScript (TypeScript types are stripped):
   async/await, destructuring, classes, Map, Set, JSON, Math, Date, RegExp.
   There is no eval, Proxy, Reflect, timers (setTimeout), fetch, filesystem
   or network: everything outside the program is a tool. console.log output
   comes back with the result.
8. Return what the user needs, not raw data: the result must be JSON and is
   capped in size, and calls that run without approval are capped per run.
${qualifiedRule}
Example — read-only work, completes in one call (run with input: { path }):

${exampleProgramHappyPath(samples)}
Example — handling a declined approval (run with input: { path, dir }):

${exampleProgramDenialFallback(samples)}`;
}

/** Example: read-only work, completes in one call. */
export function exampleProgramHappyPath(samples?: ToolSamples): string {
  const read = samples?.read ?? { name: 'read_file', placeholder: false };
  return `  // Runs immediately: no approval needed.
  try {
    const result = await ${callee(read.name)}({ path: input.path })${sampleNote(read)}
    return { result, error: null }
  } catch (e) {
    return { result: null, error: e.message }
  }
`;
}

/** Example: a gated write the user may decline, then a read-only step either way. */
export function exampleProgramDenialFallback(samples?: ToolSamples): string {
  const gated = samples?.gated ?? { name: 'write_file', placeholder: false };
  const list = samples?.list ?? { name: 'list_dir', placeholder: false };
  return `  let status
  let note = null
  try {
    // Asks for approval: the program pauses here until the user answers.
    await ${callee(gated.name)}({ path: input.path, content: 'hello' })${sampleNote(gated)}
    status = 'written'
  } catch (e) {
    if (e.name !== 'ToolDenied') throw e
    status = 'skipped'
    note = e.reason ?? null
  }
  const listing = await ${callee(list.name)}({ path: input.dir })${sampleNote(list)}
  return { status, note, listing }
`;
}

/** The `execute_machine` input schema's `code` text on a program facade. */
export const PROGRAM_CODE_DESCRIPTION =
  'The program: plain JavaScript (TypeScript types are stripped) that awaits tools.<tool>(args) and returns its result.';

/** The program paragraph of an `execute_machine` description (single or multi-server). */
function programParagraph(qualified: boolean): string {
  return `Send the body of an async JavaScript program as code: call tools with ${qualified ? 'await tools.<box>.<tool>(args) (one program may use tools from several boxes)' : 'await tools.<tool>(args)'}, and return the result. A tool marked "asks for approval" pauses the program until the user approves that exact call, then it continues where it paused; a declined call throws an error named ToolDenied, which you catch to carry on. Start gated calls together (Promise.allSettled over a list) to ask for all of them in one approval round trip.`;
}

const MACHINE_PARAGRAPH =
  /Author a module that default-exports a machine built with XState v5 setup\(\.\.\.\)\.createMachine\(\.\.\.\), and request tools with the toolCall action from '@astral-mcp\/tools'(?<qualified> by qualified name: toolCall\('<box>\.<tool>', args\)\. One machine may use tools from several boxes)?\. A tool marked "asks for approval" pauses the machine until the user approves that exact call, so handle TOOL_RESULT, TOOL_ERROR and TOOL_DENIED\. Machine context must stay JSON-serializable, and invoke\/fromPromise is rejected\./gu;

/**
 * Phrase-level rewrites from the machine runtime's model-facing text to the
 * program runtime's, longest first. Each is a whole phrase, so a rewrite
 * never produces a half-machine sentence.
 */
const PHRASES: ReadonlyArray<readonly [string, string]> = [
  ['an LLM-authored XState v5 state machine', 'an LLM-authored JavaScript program'],
  ['author an XState v5 state machine and run it', 'write a short JavaScript program and run it'],
  ['Author an XState v5 state machine and run it', 'Write a short JavaScript program and run it'],
  ['pause the machine', 'pause the program'],
  ['the machine authoring contract', 'the program authoring contract'],
  ['authoring a machine for execute_machine', 'writing a program for execute_machine'],
  ['when authoring a machine', 'when writing a program'],
  ['(for authoring a machine)', '(for writing a program)'],
  ['author a machine and use execute_machine', 'write a program and use execute_machine'],
  [
    'pass the full name to toolCall in a machine:',
    'call it as tools.<box>.<tool>(args) in a program:',
  ],
  ['call_tool and toolCall', 'call_tool and tools.<box>.<tool>(args) in a program'],
  [' and toolCall take', ' and programs take'],
  ['reaches a machine parsed', 'reaches a program parsed'],
  ['Before a machine reads its fields', 'Before a program reads its fields'],
  ['event.result is that same value', 'the program gets that same value'],
  // The save-workflow and visualize-workflow prompts.
  [
    'the most recent machine you executed via execute_machine',
    'the most recent program you ran via execute_machine',
  ],
  [
    'the most recent machine module you successfully executed with',
    'the most recent program you successfully ran with',
  ],
  [
    "the machine's `input` (a `context: ({ input }) => …` factory), and write",
    'the `input` global (read as `input.<field>`), and write',
  ],
  [
    'Keep the module inside the authoring contract',
    'Keep the program inside the authoring contract',
  ],
  [
    'default-export one setup().createMachine()\n   machine, toolCall + TOOL_RESULT/TOOL_ERROR/TOOL_DENIED only,\n   JSON-serializable context, no invoke/fromPromise.',
    'plain JavaScript, tools\n   called as await tools.<tool>(args), denials caught as ToolDenied.',
  ],
  ['Verify the generalized module still passes', 'Verify the generalized program still passes'],
  ['reaches its fallback state still proves', 'reaches its fallback still proves'],
  ['the complete machine module, verbatim', 'the complete program, verbatim'],
  ['this machine targets', 'this program targets'],
  ['unless the machine put it in output', 'unless the program returned it'],
  ["Look at the machine's output", "Look at the program's result"],
  ['anything the machine logged', 'anything the program logged'],
  ['— not "TOOL_DENIED"', '— not "ToolDenied"'],
];

/** The machine runtime's `.d.ts` header and box lines, rewritten for programs. */
function dtsForProgram(dts: string): string {
  return dts
    .replace(
      DTS_IMPORT_LINES.join('\n'),
      ['//', '// The global `tools` object of an execute_machine program:'].join('\n'),
    )
    .replace(
      DTS_TRANSPORT_LINES.join('\n'),
      [
        '//',
        '// Await a tool function for its result: the structuredContent (its',
        "// Output type below), else its single text block's text, parsed when",
        '// that text is JSON for an object or array. A declined call throws an',
        '// Error named ToolDenied; a failed call one named ToolError.',
      ].join('\n'),
    )
    .replace(
      "// tools are properties of that (tools.<box>.<tool>). Call a tool with\n// toolCall('<box>.<tool>', args).",
      '// tools are properties of that: await tools.<box>.<tool>(args).',
    )
    .replace(
      /\/\/ Box (\S+): tools\.\1\.<tool>, called as toolCall\('\1\.<tool>', args\)\./gu,
      '// Box $1: await tools.$1.<tool>(args).',
    );
}

/**
 * Rewrite model-facing machine-runtime text for the program runtime:
 * descriptions, preambles, prompts, catalog pointers and `tools.d.ts`.
 * Text with nothing machine-specific comes back unchanged.
 */
export function forProgram(text: string): string {
  let out = text.replace(MACHINE_PARAGRAPH, (...match: unknown[]) => {
    const groups = match.at(-1) as { qualified?: string };
    return programParagraph(groups.qualified !== undefined);
  });
  for (const [from, to] of PHRASES) out = out.split(from).join(to);
  if (out.includes('// Generated by Projection')) out = dtsForProgram(out);
  return out;
}

/**
 * {@link forProgram} over every string of a copy object (the catalog tools'
 * descriptions on a program facade), arrays and nested objects included.
 */
export function forProgramCopy<T>(copy: T): T {
  if (typeof copy === 'string') return forProgram(copy) as T;
  if (Array.isArray(copy)) return copy.map((item: unknown) => forProgramCopy(item)) as T;
  if (typeof copy === 'object' && copy !== null) {
    return Object.fromEntries(
      Object.entries(copy).map(([key, value]) => [key, forProgramCopy(value)]),
    ) as T;
  }
  return copy;
}
