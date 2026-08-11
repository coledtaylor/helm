// Runs `electron . <args>` against a check's own data directory.
//
// For the modes launched straight from package.json, which have no driver of
// their own to put the isolation in. Everything else goes through run-*.mjs.
//
//   node scripts/run-isolated.mjs <name> <electron args...>
//
// `--fresh` starts from an empty database instead of a copy of the real one.

import { spawnSync } from 'node:child_process'
import { isolate } from './isolate.mjs'

const [name, ...rest] = process.argv.slice(2)
if (!name) {
  console.error('usage: node scripts/run-isolated.mjs <name> <electron args...>')
  process.exit(2)
}

const fresh = rest.includes('--fresh')
const args = rest.filter((arg) => arg !== '--fresh')
// `concurrent`, because this is what launches a window somebody sits in front
// of and leaves open. A second launch is a second window, not a mistake.
const { env, root } = isolate(name, { seed: !fresh, concurrent: true })
console.log(`${name} is running against ${root}`)

const { default: electron } = await import('electron')
const { status } = spawnSync(electron, ['.', ...args], { stdio: 'inherit', env })
process.exit(status ?? 1)
