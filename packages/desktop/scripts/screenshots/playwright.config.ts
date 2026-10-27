import { defineConfig } from '@playwright/test'

/**
 * The screenshot run: the built app in a fake-claude world, photographed for a
 * person to look at. It asserts only what it needs to reach each view, so it is
 * not a test and belongs to no suite - `pnpm test:e2e` reads `e2e/` and never
 * this directory. `pnpm screenshots` builds first and runs it; the macOS
 * screenshot workflow runs that on macos-latest.
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'screenshots.run.ts',
  timeout: 300_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: '../../../../reports/screenshots-results'
})
