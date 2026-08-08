6.2 Authoring contract (what the LLM must write in McCircut code mode)

R5. The submitted module's top level MUST only define and default-export a machine created with XState v5 setup(...)/createMachine(...). Top-level side effects are rejected at validation, because the module is re-evaluated from the re-sent code argument on every resume.

R6. Machine context MUST be JSON-serializable at all times. Validation round-trips a snapshot through JSON to enforce this before first execution.

R7. Tool calls MUST NOT be modeled as invoked promise actors (fromPromise wrapping a tool call is a banned pattern — restored snapshots restart invoked actors, which would re-execute approved writes). Instead, the contract provides a library-supplied action creator: the machine emits toolCall(name, argsFromContext) and waits in a state for TOOL_RESULT, TOOL_ERROR, or TOOL_DENIED events. The host — not the machine — performs all I/O.

R8. The sandbox mounts a pinned XState v5 build at xstate and the generated bridge at @mccircuit/tools. No other imports resolve except an allowlisted set of pure utilities (TBD, e.g. none in v1).

R9. No filesystem surface is exposed to authored code in v1. The sandbox mounts only what the library itself needs internally (module resolution for xstate and @mccircuit/tools, transpilation scratch); node:fs imports and FS access from authored code fail at validation. The authoring contract states plainly: all working state lives in machine context. Scratch FS is a stretch goal (Section 12.3).