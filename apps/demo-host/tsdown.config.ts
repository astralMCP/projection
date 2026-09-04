import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: ['src/server.ts'],
    format: ['esm'],
    platform: 'node',
    dts: false,
    sourcemap: true,
    clean: true,
  },
  {
    // The host page bundle: SDK client + host logic, browser-only.
    entry: ['src/host.ts'],
    format: ['iife'],
    platform: 'browser',
    noExternal: [/.*/],
    outDir: 'public',
    dts: false,
    sourcemap: false,
    clean: false,
  },
]);
