/**
 * Module mounting and import resolution for the QuickJS sandbox (R8, R9, S1).
 *
 * The sandbox's virtual filesystem contains exactly what module resolution
 * needs and nothing else:
 *
 * - `/src/machine.js`               — the (transpiled) authored module
 * - `/node_modules/xstate/*`        — the pinned XState ESM build (v5, or v6 when
 *                                     the facade opts in)
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
import type { XStateMajor } from '../blob/versions.js';

type NodeModulesMount = NonNullable<SandboxOptions['nodeModules']>;
type ModulePathNormalizer = NonNullable<SandboxOptions['modulePathNormalizer']>;
type GetModuleLoader = NonNullable<SandboxOptions['getModuleLoader']>;

/** In-sandbox path of the authored module. Driver code imports it as `./machine.js`. */
export const AUTHORED_MODULE_PATH = '/src/machine.js';

/** Specifier the authored code uses to import XState (R8). */
export const XSTATE_SPECIFIER = 'xstate';

/** The v6 drivers' import of `restoreActor` (experimental v6 runtime only). */
export const XSTATE_PERSIST_SPECIFIER = 'xstate/persist';

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

const cachedXStateMounts = new Map<XStateMajor, Record<string, string>>();

/**
 * Build the virtual `node_modules/xstate` directory from the pinned XState
 * package installed on the host, plus the sibling ESM chunk files the entry
 * references via relative imports. The chunks are self-contained (no bare
 * imports), so nothing else needs to resolve.
 *
 * - v5: the production ESM entry (`xstate.esm.js`, mounted as `index.js`).
 * - v6 (experimental, the `xstate-v6` alias): the DEVELOPMENT build
 *   (`xstate.development.esm.js` as `index.js`, `xstate-persist` as
 *   `persist.js`). Its production build reports authoring mistakes as bare
 *   codes (`XState error E4 ("X", "a", "guard")`); the development build
 *   says what to write instead, and deep-freezes context so an in-place
 *   mutation fails loudly instead of corrupting a sealed snapshot.
 */
export function getXStateMount(major: XStateMajor = 5): Record<string, string> {
  let mount = cachedXStateMounts.get(major);
  if (mount === undefined) {
    const require = createRequire(import.meta.url);
    const pkg = major === 6 ? 'xstate-v6' : 'xstate';
    const distDir = join(dirname(require.resolve(`${pkg}/package.json`)), 'dist');
    const wanted = (file: string): boolean =>
      major === 6
        ? file.endsWith('.development.esm.js')
        : file.endsWith('.esm.js') && !file.includes('development');
    const built: Record<string, string> = {};
    for (const file of readdirSync(distDir)) {
      if (wanted(file)) built[file] = readFileSync(join(distDir, file), 'utf8');
    }
    const entryName = major === 6 ? 'xstate.development.esm.js' : 'xstate.esm.js';
    const entry = built[entryName];
    if (entry === undefined) {
      throw new Error(`${pkg} package layout not recognized: dist/${entryName} missing`);
    }
    built['index.js'] = entry;
    if (major === 6) {
      const persist = built['xstate-persist.development.esm.js'];
      if (persist === undefined) {
        throw new Error(`${pkg} package layout not recognized: dist/xstate-persist missing`);
      }
      built['persist.js'] = persist;
    }
    mount = built;
    cachedXStateMounts.set(major, mount);
  }
  return mount;
}

/** Assemble the sandbox `node_modules` mount: xstate + the tools bridge. */
export function buildNodeModulesMount(bridgeJs: string, major: XStateMajor = 5): NodeModulesMount {
  return {
    xstate: { ...getXStateMount(major) },
    '@astral-mcp': { tools: { 'index.js': bridgeJs } },
  };
}

/**
 * Allowlisting module path normalizer (R8/R9) for the given XState major.
 * Relative imports resolve against the importing module; allowlisted bare
 * specifiers resolve into `/node_modules`; everything else maps to a denied
 * sentinel path.
 *
 * `xstate` and `@astral-mcp/tools` map directly to their `index.js` files
 * (rather than the package directory) so that the relative chunk imports
 * inside them resolve against the package directory. `xstate/persist`
 * resolves only for v6 sessions; on v5 it is denied like any other import.
 */
export function modulePathNormalizerFor(major: XStateMajor): ModulePathNormalizer {
  return (baseName, requestedName) => {
    if (requestedName.startsWith('.')) {
      const parts = baseName.split('/');
      parts.pop();
      return resolvePath(`/${parts.join('/')}`, requestedName);
    }
    const name = requestedName.replace(/^node:/, '');
    if (name === XSTATE_SPECIFIER) {
      return '/node_modules/xstate/index.js';
    }
    // The v6 drivers restore snapshots with restoreActor from xstate/persist.
    // Pure like the entry, and mounted only for v6.
    if (major === 6 && name === XSTATE_PERSIST_SPECIFIER) {
      return '/node_modules/xstate/persist.js';
    }
    if (name === TOOLS_SPECIFIER) {
      return '/node_modules/@astral-mcp/tools/index.js';
    }
    if (ALLOWED_SPECIFIERS.has(name)) {
      return join('/node_modules', name);
    }
    return `${DENIED_PREFIX}${requestedName}`;
  };
}

/** The v5 (default) module path normalizer. */
export const modulePathNormalizer: ModulePathNormalizer = modulePathNormalizerFor(5);

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
