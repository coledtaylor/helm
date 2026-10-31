// Runs the Playwright CLI with its transform cache in node_modules/.cache.
//
//   node scripts/playwright.mjs test -c e2e
//
// Playwright compiles every spec and helper into a cache, and by default that
// cache is `playwright-transform-cache` in the OS temp folder. A test run then
// leaves a folder there that outlives it, which the leftovers check rightly
// reports: nothing a run makes may stay in the temp folder. PWTEST_CACHE_DIR
// moves it beside the other tools' caches in the workspace's node_modules,
// which git ignores. It has to be set before Playwright loads, which is why
// this is a wrapper and not a line in a config file: the CLI reads it while
// loading, before it reads any config.

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const cli = require.resolve('@playwright/test/cli')
const workspace = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const env = {
  ...process.env,
  PWTEST_CACHE_DIR: process.env.PWTEST_CACHE_DIR ?? join(workspace, 'node_modules', '.cache', 'playwright-transform'),
}

const { status, signal, error } = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env })
if (error) throw error
process.exit(status ?? (signal ? 1 : 0))
