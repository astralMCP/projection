import { defineConfig } from 'vitest/config';

// The §10 timing budgets (test/integration/budgets.test.ts). The root `check`
// runs this after the parallel turbo run has finished, so nothing else
// competes for the CPU while it measures — see D41.
export default defineConfig({
  test: {
    include: ['test/integration/budgets.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
