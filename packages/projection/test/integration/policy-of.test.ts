/**
 * `facade.policyOf(name)` (R14, R49): the integrator's read of the resolved
 * policy. For every tool of a fixture catalog, under every approvals mode
 * and with overrides, the lookup must equal what the gate actually does —
 * through `call_tool` and `execute_machine` — and the posture
 * `search_tools` shows, on a single-server and a multi-server facade.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  wrapMcpServer,
  wrapMcpServers,
  type MultiProjectionFacade,
  type PolicyDecision,
  type ProjectionFacade,
  type WrapOptions,
  type WrapServersOptions,
} from '../../src/index.js';
import { completed, isSuspended, structured } from '../mrtr/helpers.js';
import { KEY, recordingServer, type RecordedCall, type ToolSpec } from '../multi/helpers.js';

/** One tool per annotation shape the decision distinguishes. */
const TOOLS: ToolSpec[] = [
  { name: 'read', description: 'Read a thing.', readOnly: true },
  {
    name: 'read_destructive',
    description: 'Read, oddly destructive.',
    readOnly: true,
    destructive: true,
  },
  { name: 'touch', description: 'Touch a thing.', readOnly: false, destructive: false },
  { name: 'tag', description: 'Tag a thing.', destructive: false },
  { name: 'write', description: 'Write a thing.' },
  { name: 'remove', description: 'Remove a thing.', destructive: true },
  { name: 'patch', description: 'Patch a thing.', readOnly: false },
];
const NAMES = TOOLS.map((tool) => tool.name);

let facades: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const facade of facades.reverse()) await facade.close();
  facades = [];
});

async function single(options: Partial<WrapOptions>): Promise<ProjectionFacade> {
  const log: RecordedCall[] = [];
  const facade = await wrapMcpServer(
    recordingServer({ name: 'one', version: '1.0.0' }, TOOLS, log),
    {
      blob: { key: KEY },
      ...options,
    },
  );
  facades.push(facade);
  return facade;
}

async function multi(
  options: Partial<WrapServersOptions>,
  fsApprovals?: 'every-write' | 'destructive-only',
): Promise<MultiProjectionFacade> {
  const log: RecordedCall[] = [];
  const fs = recordingServer({ name: 'files', version: '1.0.0' }, TOOLS, log);
  const facade = await wrapMcpServers(
    {
      fs: fsApprovals === undefined ? fs : { source: fs, approvals: fsApprovals },
      github: recordingServer({ name: 'gh', version: '1.0.0' }, TOOLS, log),
    },
    { blob: { key: KEY }, ...options, projections: { direct: false } },
  );
  facades.push(facade);
  return facade;
}

type AnyFacade = ProjectionFacade | MultiProjectionFacade;

/** What `call_tool` actually did with a first attempt. */
async function callToolDecision(facade: AnyFacade, name: string): Promise<PolicyDecision> {
  const result = await facade.callTool({ name, args: {} }, 'modern');
  if (isSuspended(result)) return 'ask';
  const status = structured(result)['status'];
  if (status === 'ok') return 'auto';
  if (status === 'denied_by_policy') return 'deny';
  throw new Error(`unexpected call_tool result for ${name}: ${JSON.stringify(result)}`);
}

/** What `execute_machine` actually did with a machine making one call. */
async function machineDecision(facade: AnyFacade, name: string): Promise<PolicyDecision> {
  const code = `
import { setup, assign } from 'xstate';
import { toolCall } from '@astral-mcp/tools';

export default setup({}).createMachine({
  id: 'one',
  context: { status: 'pending' },
  initial: 'calling',
  states: {
    calling: {
      entry: toolCall(${JSON.stringify(name)}, () => ({}), { id: 'c1' }),
      on: {
        TOOL_RESULT: { target: 'done', actions: assign({ status: 'ran' }) },
        TOOL_DENIED: { target: 'done', actions: assign({ status: 'denied' }) },
      },
    },
    done: { type: 'final' },
  },
  output: ({ context }) => ({ status: context.status }),
});
`;
  const result = await facade.executeMachine({ code }, 'modern');
  if (isSuspended(result)) return 'ask';
  const done = completed(result);
  if (done.isError === true) throw new Error(`machine error: ${JSON.stringify(done)}`);
  const status = (structured(result)['output'] as { status: string }).status;
  if (status === 'ran') return 'auto';
  if (status === 'denied') return 'deny';
  throw new Error(`unexpected machine output for ${name}: ${status}`);
}

/** Every listed tool's search_tools posture, by name. */
function searchPostures(facade: AnyFacade): Record<string, string> {
  const tools = structured(facade.searchTools({}))['tools'] as { name: string; posture: string }[];
  return Object.fromEntries(tools.map((tool) => [tool.name, tool.posture]));
}

/** Assert policyOf agrees with the gate (both paths) and the search posture for every name. */
async function expectAgreement(
  facade: AnyFacade,
  names: string[],
  expected: Record<string, PolicyDecision>,
): Promise<void> {
  const postures = searchPostures(facade);
  expect(Object.keys(postures).sort()).toEqual([...names].sort());
  for (const name of names) {
    const policy = facade.policyOf(name);
    expect(policy, name).toBeDefined();
    expect({ name, decision: policy?.decision }).toEqual({ name, decision: expected[name] });
    expect({ name, posture: policy?.posture }).toEqual({ name, posture: postures[name] });
    expect({ name, gate: await callToolDecision(facade, name) }).toEqual({
      name,
      gate: policy?.decision,
    });
    expect({ name, machine: await machineDecision(facade, name) }).toEqual({
      name,
      machine: policy?.decision,
    });
  }
}

const EVERY_WRITE: Record<string, PolicyDecision> = {
  read: 'auto',
  read_destructive: 'auto',
  touch: 'ask',
  tag: 'ask',
  write: 'ask',
  remove: 'ask',
  patch: 'ask',
};
const DESTRUCTIVE_ONLY: Record<string, PolicyDecision> = {
  ...EVERY_WRITE,
  touch: 'auto',
  tag: 'auto',
};

describe('policyOf on a single-server facade (R14, R49)', () => {
  it.each([
    ['the default', {}, EVERY_WRITE],
    ["'every-write'", { approvals: 'every-write' }, EVERY_WRITE],
    ["'destructive-only'", { approvals: 'destructive-only' }, DESTRUCTIVE_ONLY],
    [
      "'destructive-only' with overrides",
      {
        approvals: 'destructive-only',
        policy: { touch: 'ask', remove: 'auto', write: 'deny', patch: 'deny', read: 'deny' },
      },
      {
        ...DESTRUCTIVE_ONLY,
        touch: 'ask',
        remove: 'auto',
        write: 'deny',
        patch: 'deny',
        read: 'deny',
      },
    ],
    [
      "'every-write' with overrides",
      { policy: { tag: 'auto', read_destructive: 'ask' } },
      { ...EVERY_WRITE, tag: 'auto', read_destructive: 'ask' },
    ],
    [
      'a malformed override (fails safe to ask)',
      { approvals: 'destructive-only', policy: { touch: 'yes' as never } },
      { ...DESTRUCTIVE_ONLY, touch: 'ask' },
    ],
  ] as [string, Partial<WrapOptions>, Record<string, PolicyDecision>][])(
    'agrees with the gate and search_tools under %s',
    async (_label, options, expected) => {
      await expectAgreement(await single(options), NAMES, expected);
    },
  );

  it('returns undefined for a name the facade does not declare', async () => {
    const facade = await single({ policy: { ghost: 'auto' } as never });
    for (const name of [
      'ghost',
      '',
      'READ',
      'one.read',
      'constructor',
      '__proto__',
      'hasOwnProperty',
    ]) {
      expect(facade.policyOf(name), name).toBeUndefined();
    }
    expect(facade.policyOf(42 as never)).toBeUndefined();
  });

  it('reads the frozen wrap-time settings, not the caller’s live options', async () => {
    const policy: Record<string, 'auto' | 'ask' | 'deny'> = { write: 'deny' };
    const options: Partial<WrapOptions> = { policy, approvals: 'every-write' };
    const facade = await single(options);
    policy['write'] = 'auto';
    policy['remove'] = 'auto';
    (options as { approvals: string }).approvals = 'destructive-only';
    expect(facade.policyOf('write')).toEqual({ decision: 'deny', posture: 'blocked by policy' });
    expect(facade.policyOf('remove')).toEqual({ decision: 'ask', posture: 'asks for approval' });
    expect(facade.policyOf('touch')?.decision).toBe('ask');
    expect(await callToolDecision(facade, 'write')).toBe('deny');
  });

  it('returns a frozen value the caller cannot use to change anything', async () => {
    const facade = await single({});
    const policy = facade.policyOf('write');
    expect(Object.isFrozen(policy)).toBe(true);
    expect(() => {
      (policy as { decision: string }).decision = 'auto';
    }).toThrow(TypeError);
    expect(facade.policyOf('write')?.decision).toBe('ask');
    expect(await callToolDecision(facade, 'write')).toBe('ask');
  });
});

describe('policyOf on a multi-server facade (R45, R49)', () => {
  const qualified = (alias: string) => NAMES.map((name) => `${alias}.${name}`);
  const boxed = (
    fs: Record<string, PolicyDecision>,
    github: Record<string, PolicyDecision>,
  ): Record<string, PolicyDecision> => ({
    ...Object.fromEntries(Object.entries(fs).map(([name, d]) => [`fs.${name}`, d])),
    ...Object.fromEntries(Object.entries(github).map(([name, d]) => [`github.${name}`, d])),
  });
  const ALL = [...qualified('fs'), ...qualified('github')];

  it.each([
    ['the default', {}, undefined, boxed(EVERY_WRITE, EVERY_WRITE)],
    [
      "global 'destructive-only'",
      { approvals: 'destructive-only' },
      undefined,
      boxed(DESTRUCTIVE_ONLY, DESTRUCTIVE_ONLY),
    ],
    [
      "per-source 'destructive-only' on fs only",
      {},
      'destructive-only',
      boxed(DESTRUCTIVE_ONLY, EVERY_WRITE),
    ],
    [
      "per-source 'every-write' under a global 'destructive-only'",
      { approvals: 'destructive-only' },
      'every-write',
      boxed(EVERY_WRITE, DESTRUCTIVE_ONLY),
    ],
    [
      'qualified overrides above the modes',
      {
        approvals: 'destructive-only',
        policy: {
          'fs.tag': 'ask',
          'github.remove': 'auto',
          'github.patch': 'deny',
          'fs.read': 'deny',
        },
      },
      undefined,
      boxed(
        { ...DESTRUCTIVE_ONLY, tag: 'ask', read: 'deny' },
        { ...DESTRUCTIVE_ONLY, remove: 'auto', patch: 'deny' },
      ),
    ],
  ] as [
    string,
    Partial<WrapServersOptions>,
    'every-write' | 'destructive-only' | undefined,
    Record<string, PolicyDecision>,
  ][])(
    'agrees with the gate and search_tools under %s',
    async (_label, options, fsApprovals, expected) => {
      await expectAgreement(await multi(options, fsApprovals), ALL, expected);
    },
  );

  it('takes only qualified names: bare names, unknown boxes and direct aliases are undefined', async () => {
    const facade = await multi({}, 'destructive-only');
    for (const name of [
      'tag',
      'gitlab.tag',
      'fs__tag',
      'fs.',
      '.tag',
      'fs.github.tag',
      'fs.ghost',
    ]) {
      expect(facade.policyOf(name), name).toBeUndefined();
    }
    expect(facade.policyOf('fs.tag')?.decision).toBe('auto');
    expect(facade.policyOf('github.tag')?.decision).toBe('ask');
  });
});
