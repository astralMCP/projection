import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.tsx'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
});
