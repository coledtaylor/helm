import { defineConfig } from '@playwright/test'
import { PATIENCE } from '../../../test/patience'

/**
 * End-to-end tests: the built app, driven through its window, in a world of
 * its own (see `test/world.ts`). Run with `pnpm test:e2e`, which builds first.
 *
 * No retries, by rule: a test that fails is reporting something broken, in the
 * app or in the test, and either way it gets fixed rather than re-run.
 */
export default defineConfig<{ sessionsInHost: boolean }>({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  // Every `expect` and `expect.poll` in a spec waits the shared patience and
  // no other.
  expect: { timeout: PATIENCE },
  retries: 0,
  // The run's root, which every world lands in, removed when the run ends.
  globalSetup: './run-root.ts',
  // Each test starts its own app and its own sessions; running them one at a
  // time keeps timing on a loaded machine from becoming a variable.
  workers: 1,
  reporter: [['list']],
  projects: [
    { name: 'helm' },
    // Every spec again with "Run sessions in the local host" on
    // (`e2e/helm.ts`, `sessionsInHost`), where sessions, terminals, discovery,
    // setup, templates, notes, files and the plugins registry are the host's.
    // A test whose subject exists on one side only skips the other, naming
    // the test that covers it there.
    { name: 'in the local host', use: { sessionsInHost: true } }
  ],
  outputDir: '../../../reports/e2e-results'
})
