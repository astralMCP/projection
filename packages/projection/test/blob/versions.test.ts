import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LIB_VERSION,
  MCP_SDK_RANGE,
  MCP_SDK_VERSION,
  XSTATE_VERSION,
} from '../../src/blob/versions.js';

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

  it('MCP_SDK_VERSION matches the exact client and server devDependency pins', () => {
    const pkg = require('../../package.json') as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies['@modelcontextprotocol/server']).toBe(MCP_SDK_VERSION);
    expect(pkg.devDependencies['@modelcontextprotocol/client']).toBe(MCP_SDK_VERSION);
  });

  it('MCP_SDK_RANGE matches the client and server peer ranges and admits the pin (D40)', () => {
    const pkg = require('../../package.json') as {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
    };
    expect(pkg.peerDependencies['@modelcontextprotocol/server']).toBe(MCP_SDK_RANGE);
    expect(pkg.peerDependencies['@modelcontextprotocol/client']).toBe(MCP_SDK_RANGE);
    // A regular dependency would install a second, private SDK copy.
    expect(pkg.dependencies['@modelcontextprotocol/server']).toBeUndefined();
    expect(pkg.dependencies['@modelcontextprotocol/client']).toBeUndefined();
    // A tilde range on the pin: patch releases only, never the next minor.
    expect(MCP_SDK_RANGE).toBe(`~${MCP_SDK_VERSION}`);
  });

  it('the installed SDK packages are the pinned version', () => {
    for (const name of ['@modelcontextprotocol/server', '@modelcontextprotocol/client']) {
      const entry = require.resolve(name);
      const manifest = JSON.parse(
        readFileSync(
          join(entry.slice(0, entry.lastIndexOf(name) + name.length), 'package.json'),
          'utf8',
        ),
      ) as { version: string };
      expect(manifest.version, name).toBe(MCP_SDK_VERSION);
    }
  });
});
