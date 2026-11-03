import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The §10 timing budgets run on their own, after every package's tests,
    // through vitest.budgets.config.ts (`pnpm run test:budgets`) — see D41.
    exclude: [...configDefaults.exclude, 'test/integration/budgets.test.ts'],
    testTimeout: 30_000,
  },
});
