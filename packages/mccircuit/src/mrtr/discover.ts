/**
 * `discover_apis` — the tool that teaches the model to author a machine
 * (PRD G6, R3, R29).
 *
 * Returns a compact inline overview that is sufficient on its own, plus a
 * `resource_link` per artifact so a model can pull full contents only when
 * it wants them. Clients with weak resource support still function.
 */

import { AUTHORING_CONTRACT } from '../machine-host/index.js';
import { XSTATE_VERSION } from '../blob/index.js';
import type { ServerCatalog } from '../types.js';
import type { CompleteResult, ContentBlock } from './protocol.js';

/** Stable URIs the server serves via `resources/read` (R3). */
export const RESOURCE_URIS = {
  toolTypes: 'mccircuit://types/tools.d.ts',
  contract: 'mccircuit://docs/authoring-contract.md',
  happyPath: 'mccircuit://examples/happy-path.ts',
  denialFallback: 'mccircuit://examples/denial-fallback.ts',
} as const;

/** One resource McCircuit serves, ready to register on the MCP server. */
export interface McCircuitResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  text: string;
}

export const EXAMPLE_HAPPY_PATH = `import { setup, assign } from 'xstate';
import { toolCall } from '@mccircuit/tools';

// Read a file and return its contents. Read-only calls run immediately,
// so this whole machine completes in one round trip.
export default setup({}).createMachine({
  id: 'readNotes',
  context: ({ input }) => ({ path: input?.path ?? '/notes.txt', text: null }),
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall('read_file', ({ context }) => ({ path: context.path })),
      on: {
        TOOL_RESULT: {
          target: 'done',
          actions: assign({ text: ({ event }) => event.result }),
        },
        TOOL_ERROR: {
          target: 'failed',
          actions: assign({ text: ({ event }) => \`error: \${event.error.message}\` }),
        },
      },
    },
    done: { type: 'final' },
    failed: { type: 'final' },
  },
  output: ({ context }) => ({ text: context.text }),
});
`;

export const EXAMPLE_DENIAL_FALLBACK = `import { setup, assign } from 'xstate';
import { toolCall } from '@mccircuit/tools';

// Write a file, but keep going if the user declines. TOOL_DENIED is an
// ordinary transition — denial is never an automatic abort.
export default setup({}).createMachine({
  id: 'writeWithFallback',
  context: { status: 'pending', note: null },
  initial: 'writing',
  states: {
    writing: {
      entry: toolCall('write_file', () => ({ path: '/notes.txt', content: 'hello' })),
      on: {
        TOOL_RESULT: {
          target: 'summarizing',
          actions: assign({ status: 'written' }),
        },
        TOOL_DENIED: {
          // The user said no: record it and carry on with the read-only
          // part of the work instead of failing the whole workflow.
          target: 'summarizing',
          actions: assign({
            status: 'skipped',
            note: ({ event }) => event.reason ?? 'declined by user',
          }),
        },
        TOOL_ERROR: {
          target: 'summarizing',
          actions: assign({ status: 'failed' }),
        },
      },
    },
    summarizing: {
      entry: toolCall('list_dir', () => ({ path: '/' })),
      on: {
        TOOL_RESULT: { target: 'done' },
        TOOL_ERROR: { target: 'done' },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status, note: context.note }),
});
`;

/** Build the resources McCircuit serves for a wrapped server (R3). */
export function buildResources(catalog: ServerCatalog, dts: string): McCircuitResource[] {
  return [
    {
      uri: RESOURCE_URIS.toolTypes,
      name: 'tools.d.ts',
      description: `TypeScript definitions for the tools of ${catalog.identity}.`,
      mimeType: 'text/plain',
      text: dts,
    },
    {
      uri: RESOURCE_URIS.contract,
      name: 'authoring-contract.md',
      description: 'Rules an authored machine must follow.',
      mimeType: 'text/markdown',
      text: AUTHORING_CONTRACT,
    },
    {
      uri: RESOURCE_URIS.happyPath,
      name: 'happy-path.ts',
      description: 'Example machine: read-only work, completes in one call.',
      mimeType: 'text/plain',
      text: EXAMPLE_HAPPY_PATH,
    },
    {
      uri: RESOURCE_URIS.denialFallback,
      name: 'denial-fallback.ts',
      description: 'Example machine: continues gracefully when approval is declined.',
      mimeType: 'text/plain',
      text: EXAMPLE_DENIAL_FALLBACK,
    },
  ];
}

/**
 * The `discover_apis` result: an inline overview sufficient to author a
 * simple machine unaided, plus resource links for the full artifacts.
 */
export function discoverApis(catalog: ServerCatalog, overview: string): CompleteResult {
  const inline = [
    `McCircuit code mode over "${catalog.identity}".`,
    '',
    `XState version: ${XSTATE_VERSION} (pinned). Importable modules: 'xstate', '@mccircuit/tools'. Nothing else resolves; there is no network and no filesystem.`,
    '',
    overview,
    '',
    AUTHORING_CONTRACT,
  ].join('\n');

  const links: ContentBlock[] = buildResources(catalog, '').map((resource) => ({
    type: 'resource_link',
    uri: resource.uri,
    name: resource.name,
    description: resource.description,
    mimeType: resource.mimeType,
  }));

  return {
    resultType: 'complete',
    content: [{ type: 'text', text: inline }, ...links],
  };
}

/**
 * The wrapped server's `instructions`, followed by the code-mode preamble
 * (R29). The preamble is library copy the integrating developer can replace.
 */
export const DEFAULT_CODE_MODE_PREAMBLE = `This server runs in code mode: instead of calling its tools directly, author an XState v5 state machine and run it with execute_machine, which orchestrates the tool calls for you. Any tool that is not read-only pauses the machine and asks the user to approve that specific action before it runs. Call discover_apis first for the tool types, the authoring contract, and worked examples.`;

export function buildInstructions(catalog: ServerCatalog, preamble?: string): string {
  const wrapped = catalog.instructions?.trim();
  const codeMode = preamble ?? DEFAULT_CODE_MODE_PREAMBLE;
  return wrapped !== undefined && wrapped.length > 0 ? `${wrapped}\n\n${codeMode}` : codeMode;
}
