import { describe, expect, it } from 'vitest';
import { createSandboxSession } from '../../src/sandbox/index.js';
import { BRIDGE_STUB } from '../sandbox/helpers.js';

const MACHINE = `
import { setup } from 'xstate';
export default setup({}).createMachine({
  id: 'toggle',
  initial: 'off',
  context: { flips: 0 },
  states: {
    off: { on: { TOGGLE: { target: 'on', context: ({ context }) => ({ flips: context.flips + 1 }) } } },
    on: { on: { TOGGLE: { target: 'off' } } },
  },
});
`;

describe('XState v6 in the QuickJS sandbox', () => {
  it('loads the development build, runs, persists and restores', async () => {
    const session = await createSandboxSession({
      code: MACHINE,
      bridgeSource: BRIDGE_STUB,
      onToolCall: () => null,
      xstate: 6,
    });
    try {
      const t0 = performance.now();
      const persisted = await session.evaluate(`
        import { createActor } from 'xstate';
        import machine from './machine.js';
        const a = createActor(machine).start();
        a.send({ type: 'TOGGLE' });
        export default JSON.parse(JSON.stringify(a.getPersistedSnapshot()));
      `);
      const restored = await session.evaluate(`
        import { restoreActor } from 'xstate/persist';
        import machine from './machine.js';
        const a = restoreActor(machine, ${JSON.stringify(persisted)}).start();
        a.send({ type: 'TOGGLE' });
        export default { value: a.getSnapshot().value, context: a.getSnapshot().context };
      `);
      console.log('v6 sandbox ms', Math.round(performance.now() - t0));
      expect(restored).toEqual({ value: 'off', context: { flips: 1 } });
    } finally {
      await session.dispose();
    }
  });
});
