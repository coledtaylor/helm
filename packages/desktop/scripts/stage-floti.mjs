// Builds the `floti` host in release and copies it to `dist-host/`, where
// electron-builder.yml's `extraResources` picks it up. A packaged Helm runs it
// from `process.resourcesPath` (`flotiBinary` in src/main/host/launcher.ts)
// when "Run sessions in the local host" is on. Beside it goes the pinned Node
// runtime the host runs plugin services on, fetched here, at build time only,
// and checked against its SHA-256 before anything is extracted.
//
// The release workflow builds floti once for each OS and CPU
// (.github/workflows/floti.yml) and hands the desktop's jobs those files:
// FLOTI_PREBUILT names the one for this platform, which is staged in place of
// a local build, and FLOTI_SHA256SUMS the release's SHA-256 list, which must
// list that file with its SHA-256 and is staged beside it as
// `floti-SHA256SUMS` (floti-release.mjs). Without FLOTI_PREBUILT floti is
// built here, and no list is carried.
//
// Copied rather than referenced in place because Cargo's output folder moves
// with CARGO_TARGET_DIR, and electron-builder's file sets are relative to this
// package.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { STAGED_SUMS_NAME, desktopVersion, stagePrebuilt } from './floti-release.mjs'
import { stageNode } from './node-runtime.mjs'

const desktopDir = resolve(import.meta.dirname, '..')
const repoRoot = resolve(desktopDir, '..', '..')
const name = process.platform === 'win32' ? 'floti.exe' : 'floti'
const staged = join(desktopDir, 'dist-host')
const target = process.env['CARGO_TARGET_DIR'] || join(repoRoot, 'target')
const prebuilt = process.env['FLOTI_PREBUILT'] || undefined
const sums = process.env['FLOTI_SHA256SUMS'] || undefined

if (prebuilt !== undefined) {
  try {
    const result = stagePrebuilt({ prebuilt, sums, stagedDir: staged, version: desktopVersion() })
    console.log(`Staged the release's ${prebuilt} for packaging as ${join('dist-host', name)}`)
    if (result.sums !== null) console.log(`Staged ${sums} as ${join('dist-host', STAGED_SUMS_NAME)}`)
  } catch (error) {
    console.error(`Could not stage the release's floti: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
} else {
  if (sums !== undefined) {
    console.error("FLOTI_SHA256SUMS lists the release's files, so it needs FLOTI_PREBUILT naming the one to carry")
    process.exit(1)
  }
  const build = spawnSync('cargo', ['build', '--release', '--locked', '-p', 'floti-host', '--bin', 'floti'], {
    cwd: repoRoot,
    stdio: 'inherit'
  })
  if (build.error !== undefined) {
    console.error(`Could not run cargo to build the local host: ${build.error.message}`)
    process.exit(1)
  }
  if (build.status !== 0) process.exit(build.status ?? 1)

  const built = join(target, 'release', name)
  if (!existsSync(built)) {
    console.error(`cargo finished but ${built} is not there`)
    process.exit(1)
  }

  mkdirSync(staged, { recursive: true })
  // copyFileSync keeps the source's mode, so the executable bit survives on macOS and Linux.
  copyFileSync(built, join(staged, name))
  // A local build has no release sums, and a list an earlier run staged does not describe it.
  rmSync(join(staged, STAGED_SUMS_NAME), { force: true })
  console.log(`Staged ${built} for packaging as ${join('dist-host', name)}`)
}

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
