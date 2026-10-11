import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { LIB_VERSION, MCP_SDK_VERSION, XSTATE_VERSION } from '../../src/blob/versions.js';

const require = createRequire(import.meta.url);

describe('version constants (R20 stamps, D2 pins)', () => {
  it('LIB_VERSION matches the package.json version', () => {
    const pkg = require('../../package.json') as { version: string };
    expect(LIB_VERSION).toBe(pkg.version);
  });

  it('XSTATE_VERSION matches the installed (exactly pinned) xstate version', () => {
    const xstatePkg = require('xstate/package.json') as { version: string };
    expect(XSTATE_VERSION).toBe(xstatePkg.version);
  });

  it('MCP_SDK_VERSION matches the exact client and server SDK pins', () => {
    const pkg = require('../../package.json') as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@modelcontextprotocol/server']).toBe(MCP_SDK_VERSION);
    expect(pkg.dependencies['@modelcontextprotocol/client']).toBe(MCP_SDK_VERSION);
  });
});
