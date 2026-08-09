/**
 * Module mounting and import resolution for the QuickJS sandbox (R8, R9, S1).
 *
 * The sandbox's virtual filesystem contains exactly what module resolution
 * needs and nothing else:
 *
 * - `/src/machine.js`               — the (transpiled) authored module
 * - `/node_modules/xstate/*`        — the pinned XState v5 ESM build
 * - `/node_modules/@astral-mcp/tools/index.js` — the caller-supplied bridge
 *
 * Import resolution is allowlist-based: only `xstate` and `@astral-mcp/tools`
 * resolve for authored code (plus the handful of pure-utility modules the
 * QuickJS runtime itself boots with: `buffer`, `util`, `url` and the
 * `@node_compatibility/*` shims — none of which perform I/O). Every other
 * specifier — including `node:fs`, `node:child_process`, `http`, arbitrary
 * package names — resolves to a sentinel path whose load fails with a
 * structured, model-actionable error message.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { getModuleLoader, type SandboxOptions } from '@sebastianwessel/quickjs';

type NodeModulesMount = NonNullable<SandboxOptions['nodeModules']>;
type ModulePathNormalizer = NonNullable<SandboxOptions['modulePathNormalizer']>;
type GetModuleLoader = NonNullable<SandboxOptions['getModuleLoader']>;

/** In-sandbox path of the authored module. Driver code imports it as `./machine.js`. */
export const AUTHORED_MODULE_PATH = '/src/machine.js';

/** Specifier the authored code uses to import XState (R8). */
export const XSTATE_SPECIFIER = 'xstate';

/** Specifier the authored code uses to import the generated tools bridge (R8). */
export const TOOLS_SPECIFIER = '@astral-mcp/tools';

/** Sentinel path prefix produced by the normalizer for disallowed imports. */
const DENIED_PREFIX = '/__projection_denied__/';

/** Marker embedded in denied-import error messages; used for error classification. */
export const DENIED_IMPORT_MARKER = 'cannot be imported inside the sandbox';

/**
 * Bare specifiers that resolve inside the sandbox. `xstate` and
 * `@astral-mcp/tools` are the authoring contract (R8); the rest are pure
 * utilities required by the QuickJS runtime's own node-compatibility
 * bootstrap (`node:buffer`, `node:util`, `node:url` and the
 * `@node_compatibility/*` shims). None of them expose I/O.
 */
const ALLOWED_SPECIFIERS: ReadonlySet<string> = new Set([
  XSTATE_SPECIFIER,
  TOOLS_SPECIFIER,
  'buffer',
  'util',
  'url',
  '@node_compatibility/event-target',
  '@node_compatibility/headers',
  '@node_compatibility/request',
  '@node_compatibility/response',
]);

let cachedXStateMount: Record<string, string> | undefined;

/**
 * Build the virtual `node_modules/xstate` directory from the pinned XState v5
 * package installed on the host: the production ESM entry (`xstate.esm.js`,
 * mounted additionally as `index.js`) plus its sibling ESM chunk files, which
 * it references via relative imports. The chunks are self-contained (no bare
 * imports), so nothing else needs to resolve.
 */
export function getXStateMount(): Record<string, string> {
  if (cachedXStateMount === undefined) {
    const require = createRequire(import.meta.url);
    const distDir = join(dirname(require.resolve('xstate/package.json')), 'dist');
    const mount: Record<string, string> = {};
    for (const file of readdirSync(distDir)) {
      if (file.endsWith('.esm.js') && !file.includes('development')) {
        mount[file] = readFileSync(join(distDir, file), 'utf8');
      }
    }
    const entry = mount['xstate.esm.js'];
    if (entry === undefined) {
      throw new Error('xstate package layout not recognized: dist/xstate.esm.js missing');
    }
    mount['index.js'] = entry;
    cachedXStateMount = mount;
  }
  return cachedXStateMount;
}

/** Assemble the sandbox `node_modules` mount: xstate + the tools bridge. */
export function buildNodeModulesMount(bridgeJs: string): NodeModulesMount {
  return {
    xstate: { ...getXStateMount() },
    '@astral-mcp': { tools: { 'index.js': bridgeJs } },
  };
}

/**
 * Allowlisting module path normalizer (R8/R9). Relative imports resolve
 * against the importing module; allowlisted bare specifiers resolve into
 * `/node_modules`; everything else maps to a denied sentinel path.
 *
 * `xstate` and `@astral-mcp/tools` map directly to their `index.js` files
 * (rather than the package directory) so that the relative chunk imports
 * inside them resolve against the package directory.
 */
export const modulePathNormalizer: ModulePathNormalizer = (baseName, requestedName) => {
  if (requestedName.startsWith('.')) {
    const parts = baseName.split('/');
    parts.pop();
    return resolvePath(`/${parts.join('/')}`, requestedName);
  }
  const name = requestedName.replace(/^node:/, '');
  if (name === XSTATE_SPECIFIER) {
    return '/node_modules/xstate/index.js';
  }
  if (name === TOOLS_SPECIFIER) {
    return '/node_modules/@astral-mcp/tools/index.js';
  }
  if (ALLOWED_SPECIFIERS.has(name)) {
    return join('/node_modules', name);
  }
  return `${DENIED_PREFIX}${requestedName}`;
};

/**
 * Module loader wrapping the package default: turns denied sentinel paths
 * into a structured, actionable error (R25); defers everything else to the
 * default memfs-backed loader.
 */
export const getSandboxModuleLoader: GetModuleLoader = (fs, runtimeOptions) => {
  const defaultLoader = getModuleLoader(fs, runtimeOptions);
  return (name, context) => {
    if (name.startsWith(DENIED_PREFIX)) {
      const specifier = name.slice(DENIED_PREFIX.length);
      return {
        error: new Error(
          `'${specifier}' ${DENIED_IMPORT_MARKER}; only '${XSTATE_SPECIFIER}' and '${TOOLS_SPECIFIER}' are importable`,
        ),
      };
    }
    return defaultLoader(name, context);
  };
};
