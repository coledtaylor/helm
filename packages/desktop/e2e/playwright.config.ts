import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests: the built app, driven through its window, in a world of
 * its own (see `test/world.ts`). Run with `pnpm test:e2e`, which builds first.
 *
 * No retries, by rule: a test that fails is reporting something broken, in the
 * app or in the test, and either way it gets fixed rather than re-run.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  // Each test starts its own app and its own sessions; running them one at a
  // time keeps timing on a loaded machine from becoming a variable.
  workers: 1,
  reporter: [['list']],
  outputDir: '../../../reports/e2e-results'
})
