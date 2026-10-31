// Builds the `floti` host in release and copies it to `dist-host/`, where
// electron-builder.yml's `extraResources` picks it up. A packaged Helm runs it
// from `process.resourcesPath` (`flotiBinary` in src/main/host/launcher.ts)
// when "Run sessions in the local host" is on. Beside it goes the pinned Node
// runtime the host runs plugin services on, fetched here, at build time only,
// and checked against its SHA-256 before anything is extracted.
//
// Copied rather than referenced in place because Cargo's output folder moves
// with CARGO_TARGET_DIR, and electron-builder's file sets are relative to this
// package.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { stageNode } from './node-runtime.mjs'

const desktopDir = resolve(import.meta.dirname, '..')
const repoRoot = resolve(desktopDir, '..', '..')
const name = process.platform === 'win32' ? 'floti.exe' : 'floti'

const build = spawnSync('cargo', ['build', '--release', '--locked', '-p', 'floti-host', '--bin', 'floti'], {
  cwd: repoRoot,
  stdio: 'inherit'
})
if (build.error !== undefined) {
  console.error(`Could not run cargo to build the local host: ${build.error.message}`)
  process.exit(1)
}
if (build.status !== 0) process.exit(build.status ?? 1)

const target = process.env['CARGO_TARGET_DIR'] || join(repoRoot, 'target')
const built = join(target, 'release', name)
if (!existsSync(built)) {
  console.error(`cargo finished but ${built} is not there`)
  process.exit(1)
}

const staged = join(desktopDir, 'dist-host')
mkdirSync(staged, { recursive: true })
// copyFileSync keeps the source's mode, so the executable bit survives on macOS and Linux.
copyFileSync(built, join(staged, name))
console.log(`Staged ${built} for packaging as ${join('dist-host', name)}`)

// The Node runtime the host runs plugin services on, staged as `dist-host/node/`
// (node-runtime.mjs). The archive is kept in Cargo's output folder, so a
// second build reuses it once it still matches its pin.
try {
  const node = await stageNode({ cacheDir: join(target, 'node-runtime'), stagedDir: join(staged, 'node') })
  const how = node.reused ? 'reused' : 'downloaded'
  console.log(`Staged Node ${node.pin.version} (${how} ${node.pin.archive}, SHA-256 verified) as ${join('dist-host', 'node')}`)
} catch (error) {
  console.error(`Could not stage the Node runtime: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
