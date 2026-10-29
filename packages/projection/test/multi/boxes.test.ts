/**
 * The boxed view's fail-closed seams (PRD R40, R41, R45, R49; DECISIONS
 * D16): the key domain never silently falls back to `single` for a copied
 * view, per-source modes are resolved per qualified tool from the view's
 * members, and the machine host routes a qualified `toolCall` to its box.
 */

import { describe, expect, it } from 'vitest';
import {
  approvalSubject,
  blobKeyDomain,
  buildBoxedCatalog,
  routeCall,
  toolApprovalsFor,
  type BoxedCatalog,
} from '../../src/catalog/boxes.js';
import { callTool } from '../../src/catalog/index.js';
import { ProjectionError } from '../../src/errors.js';
import { runSegment } from '../../src/machine-host/index.js';
import { resolveCallPolicy } from '../../src/policy/index.js';
import type { ServerCatalog, ToolCallOutcome, ToolExecutor } from '../../src/types.js';
import { BRIDGE_SOURCE, entry } from '../machine-host/fixtures.js';
import { structured } from '../mrtr/helpers.js';
import { KEY } from './helpers.js';

const FS: ServerCatalog = {
  alias: 'fs',
  identity: 'files@1.0.0',
  tools: [
    entry({ name: 'read_file', annotations: { readOnlyHint: true } }),
    entry({ name: 'write_file', description: 'Write a file.' }),
    entry({ name: 'github.tag', annotations: { destructiveHint: false } }),
  ],
};
const GITHUB: ServerCatalog = {
  alias: 'github',
  identity: 'gh-server@0.9.1',
  tools: [
    entry({ name: 'tag', annotations: { destructiveHint: false } }),
    entry({ name: 'tag', description: 'A duplicate: first occurrence wins (S5).' }),
  ],
};

function view(): BoxedCatalog {
  return buildBoxedCatalog([
    { alias: 'github', catalog: GITHUB },
    { alias: 'fs', catalog: FS },
  ]);
}

/** Records the alias each call was routed to. */
class RoutingExecutor implements ToolExecutor {
  readonly calls: { alias: string; name: string }[] = [];

  callTool(alias: string, name: string): Promise<ToolCallOutcome> {
    this.calls.push({ alias, name });
    return Promise.resolve({ ok: true, result: `${alias}:${name}` });
  }
}

function thrown(run: () => unknown): ProjectionError {
  let caught: unknown;
  try {
    run();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ProjectionError);
  return caught as ProjectionError;
}

/** A machine that calls `name` once and outputs the result. */
function machine(name: string): string {
  return `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'read',
  context: { result: null, error: null },
  initial: 'reading',
  states: {
    reading: {
      entry: toolCall(${JSON.stringify(name)}, () => ({ path: '/a' }), { id: 'r1' }),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ result: ({ event }) => event.result }) },
        TOOL_ERROR: { target: 'done', actions: assign({ error: ({ event }) => event.error }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ result: context.result }),
});
`;
}

/** A pending call named `name` from machine state `s`. */
function call(name: string): Parameters<typeof resolveCallPolicy>[0] {
  return { id: 'c1', name, args: {}, stateName: 's' };
}

describe('the key domain fails closed (R41)', () => {
  it('derives multi from the brand and checks a declared domain against it', () => {
    const boxed = view();
    expect(blobKeyDomain(boxed)).toBe('multi');
    expect(blobKeyDomain(boxed, 'multi')).toBe('multi');
    thrown(() => blobKeyDomain(boxed, 'single'));
  });

  it('refuses a spread copy of a boxed view instead of falling back to single', () => {
    const copy: ServerCatalog = { ...view() };
    expect(thrown(() => blobKeyDomain(copy)).message).toContain('copy of a multi-server view');
    thrown(() => blobKeyDomain(copy, 'multi'));
    thrown(() => routeCall(copy, 'fs.read_file'));
    thrown(() => approvalSubject(copy, entry({ name: 'fs.write_file' })));
  });

  it('refuses an undeclared multi: identity, but serves it when the facade declares single', () => {
    const impostor: ServerCatalog = {
      alias: 'default',
      identity: 'multi:[["fs","files@1.0.0"]]',
      tools: [],
    };
    thrown(() => blobKeyDomain(impostor));
    expect(blobKeyDomain(impostor, 'single')).toBe('single');
    thrown(() => blobKeyDomain(impostor, 'multi'));
  });

  it('a gate handed a copied view seals nothing and runs nothing', async () => {
    const executor = new RoutingExecutor();
    const result = await callTool(
      { name: 'fs.write_file', args: {} },
      {
        catalog: { ...view() },
        blobDomain: 'multi',
        executor,
        blob: { key: KEY },
        protocolEra: 'modern',
      },
    );
    expect(structured(result)['phase']).toBe('terminal');
    expect(executor.calls).toEqual([]);
  });
});

describe('the boxed view (R40, R49)', () => {
  it('counts tools per box after the per-box dedupe', () => {
    expect([...view().counts]).toEqual([
      ['fs', 3],
      ['github', 1],
    ]);
  });

  it('resolves per-source modes per qualified tool from its members, never by splitting', () => {
    const modes = toolApprovalsFor(view(), new Map([['github', 'destructive-only' as const]]));
    expect([...modes]).toEqual([['github.tag', 'destructive-only']]);
    // fs's "github.tag" is fs.github.tag: it does not take github's mode.
    expect(modes.has('fs.github.tag')).toBe(false);
  });
});

describe('the machine host on a boxed view (R40, R45)', () => {
  it('routes a qualified toolCall to its box with the bare name', async () => {
    const executor = new RoutingExecutor();
    const outcome = await runSegment({
      catalog: view(),
      bridgeSource: BRIDGE_SOURCE,
      code: machine('fs.read_file'),
      executor,
    });
    expect(outcome.status).toBe('completed');
    expect(executor.calls).toEqual([{ alias: 'fs', name: 'read_file' }]);
  });

  it('names boxes in the unknown-tool error', () => {
    const boxed = view();
    const unqualified = resolveCallPolicy(call('read_file'), boxed);
    expect(unqualified.ok).toBe(false);
    if (unqualified.ok) return;
    expect(unqualified.error.message).toContain('qualified as <box>.<tool> (boxes: fs, github)');
    expect(unqualified.error.hint).toContain('qualified tool names');
    const unknownBox = resolveCallPolicy(call('gh.tag'), boxed);
    expect(!unknownBox.ok && unknownBox.error.message).toContain('there is no box "gh"');
    const unknownTool = resolveCallPolicy(call('fs.nope'), boxed);
    expect(!unknownTool.ok && unknownTool.error.message).toContain(
      'the fs box does not declare it',
    );
  });
});
