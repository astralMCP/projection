import {
  createSandboxSession,
  type SandboxSession,
  type SandboxSessionOptions,
} from '../../src/sandbox/index.js';

/**
 * Minimal hand-rolled bridge stub standing in for the typegen-generated
 * `@astral-mcp/tools` module: forwards every call to the host binding.
 */
export const BRIDGE_STUB = `
export async function callTool(name, args) {
  return await env.__projection_toolCall(name, args ?? {});
}
`;

/** A trivial authored machine module (JS). */
export const TOGGLE_MACHINE_JS = `
import { setup } from 'xstate';

export default setup({}).createMachine({
  id: 'toggle',
  initial: 'off',
  context: { flips: 0 },
  states: {
    off: { on: { TOGGLE: 'on' } },
    on: { on: { TOGGLE: 'off' } },
  },
});
`;

/** Create a session with test defaults and guarantee disposal. */
export async function withSession<T>(
  options: Partial<SandboxSessionOptions>,
  fn: (session: SandboxSession) => Promise<T>,
): Promise<T> {
  const session = await createSandboxSession({
    code: options.code ?? TOGGLE_MACHINE_JS,
    bridgeSource: options.bridgeSource ?? BRIDGE_STUB,
    onToolCall: options.onToolCall ?? (() => ({ ok: true })),
    ...(options.lang !== undefined ? { lang: options.lang } : {}),
    ...(options.caps !== undefined ? { caps: options.caps } : {}),
    ...(options.segment !== undefined ? { segment: options.segment } : {}),
  });
  try {
    return await fn(session);
  } finally {
    await session.dispose();
  }
}
