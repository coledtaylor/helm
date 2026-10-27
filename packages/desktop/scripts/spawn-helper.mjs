// node-pty starts every pty on macOS through `spawn-helper`, a small
// executable beside its native module, and node-pty 1.1.0 publishes its macOS
// prebuilds of it without the execute bit (0644 in the package). Its install
// scripts never set one, so on a Mac every terminal fails with
// "posix_spawnp failed" until something does. This sets it:
//
// - after `pnpm install`, as @helm/desktop's postinstall, so `pnpm check` and
//   `pnpm dev` start terminals on a Mac;
// - in the packaged app, through `after-pack.mjs`, on the copy under
//   app.asar.unpacked, before electron-builder signs the app.
//
//   node scripts/spawn-helper.mjs    # the installed node-pty; nothing off macOS
//
// Running it again changes nothing.

import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Execute for the owner, the group and everyone else. */
const EXECUTE = 0o111

/** The spawn-helper of each macOS prebuild in a node-pty folder, as `prebuilds/darwin-<arch>/spawn-helper`. */
export function spawnHelpers(nodePtyDir) {
  const prebuilds = join(nodePtyDir, 'prebuilds')
  if (!existsSync(prebuilds)) return []
  return readdirSync(prebuilds)
    .filter((name) => name.startsWith('darwin-'))
    .map((name) => join(prebuilds, name, 'spawn-helper'))
    .filter((helper) => existsSync(helper))
}

/**
 * Gives every macOS spawn-helper in a node-pty folder its execute bits, keeping
 * the rest of its mode. Returns the ones it changed: none when run again.
 */
export function makeSpawnHelpersExecutable(nodePtyDir) {
  const changed = []
  for (const helper of spawnHelpers(nodePtyDir)) {
    const mode = statSync(helper).mode & 0o7777
    if ((mode & EXECUTE) === EXECUTE) continue
    chmodSync(helper, mode | EXECUTE)
    changed.push(helper)
  }
  return changed
}

/** The installed node-pty, as @helm/desktop resolves it. */
function installedNodePty() {
  const require = createRequire(import.meta.url)
  return dirname(require.resolve('node-pty/package.json'))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.platform === 'darwin') {
  for (const helper of makeSpawnHelpersExecutable(installedNodePty())) console.log(`made ${helper} executable`)
}
