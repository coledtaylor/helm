// Runs a command with Node's compile cache kept out of the system temp folder.
//
// tsc, eslint, vite and npm turn the cache on (`module.enableCompileCache()`),
// and without NODE_COMPILE_CACHE Node keeps it in the system temp folder, where
// a check would leave it behind on every machine it runs on. Every process the
// command starts inherits what is set here.
//
//   node scripts/compile-cache.mjs local <command> [args...]
//   node scripts/compile-cache.mjs off <command> [args...]
//
// `local` keeps the cache in node_modules/.cache, where it still speeds up the
// next run and lives with the rest of the workspace's build output. `off` turns
// it off, for the test run: V8 collects less precise coverage for code read
// back from the cache.

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const modes = {
  local: { NODE_COMPILE_CACHE: join(root, 'node_modules', '.cache', 'node-compile-cache') },
  off: { NODE_DISABLE_COMPILE_CACHE: '1' }
}

const [mode, ...command] = process.argv.slice(2)
const cache = Object.hasOwn(modes, mode ?? '') ? modes[mode] : undefined
if (cache === undefined || command.length === 0) {
  console.error('usage: node scripts/compile-cache.mjs local|off <command> [args...]')
  process.exit(2)
}

// A word with no space or quote goes as it is, anything else in double
// quotes, which cmd.exe and sh both read back as one argument.
const word = (arg) => (/^[^\s"']+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`)

const result = spawnSync(command.map(word).join(' '), {
  stdio: 'inherit',
  // The command is a package script's own words (`pnpm -r typecheck`,
  // `eslint .`), found on the PATH pnpm gives scripts, so it goes through the
  // shell that runs every other script.
  shell: true,
  // Each mode sets one of the two and clears the other, so a value the caller
  // had cannot undo it.
  env: { ...process.env, NODE_COMPILE_CACHE: undefined, NODE_DISABLE_COMPILE_CACHE: undefined, ...cache }
})
if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
