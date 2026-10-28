// Runs a command with Node's compile cache kept in node_modules/.cache.
//
// tsc and eslint turn the cache on (`module.enableCompileCache()`), and
// without NODE_COMPILE_CACHE Node keeps it in the system temp folder, where
// `pnpm check` would leave it behind on every machine it runs on. Pointed
// here, the cache still speeds up the next run and lives with the rest of
// the workspace's build output. Every process the command starts inherits it.
//
//   node scripts/local-compile-cache.mjs <command> [args...]

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const command = process.argv.slice(2)
if (command.length === 0) {
  console.error('usage: node scripts/local-compile-cache.mjs <command> [args...]')
  process.exit(2)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const result = spawnSync(command.join(' '), {
  stdio: 'inherit',
  // The command is a package script's own words (`pnpm -r typecheck`,
  // `eslint .`), found on the PATH pnpm gives scripts, so it goes through the
  // shell that runs every other script.
  shell: true,
  env: { ...process.env, NODE_COMPILE_CACHE: join(root, 'node_modules', '.cache', 'node-compile-cache') }
})
if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
