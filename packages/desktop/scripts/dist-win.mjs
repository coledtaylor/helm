// Builds the Windows artefacts, after making sure electron-builder can find a
// working pnpm.
//
// Why this file exists, measured on 2026-08-10:
//
// electron-builder 26 asks the package manager for the production dependency
// graph, and that graph is what decides which node_modules get packaged. It
// resolves the command with `which('pnpm')`, which on Windows walks PATHEXT and
// therefore prefers `pnpm.EXE` over `pnpm.CMD`. pnpm's own home directory can
// legitimately contain both: a `pnpm.CMD` shim that forwards to the managed
// version, and a bare `pnpm.exe` left behind by an older standalone install.
// This machine had 10.28.0 behind the shim and 8.15.3 as the exe, so
// electron-builder ran the old one, `pnpm list --json` answered
// `{"error":{"code":"pnpm","message":"undefined is not a function"}}`, and the
// build failed.
//
// The failure mode when it *doesn't* fail outright is worse. Run without pnpm
// detectable at all, electron-builder falls back to the npm collector, reports
// "cannot find path for dependency ...@undefined" for every production package
// as a warning, and produces artefacts with **no `app.asar.unpacked`** - an exe
// that looks fine, is 95 MB, and dies the moment it tries to `dlopen`
// better-sqlite3. `pnpm packaging-check --only=package` asserts the unpacked native
// modules are there for exactly that reason.
//
// So: resolve pnpm the way electron-builder will, check it answers the version
// this workspace declares, and if it does not, put a shim that does first on
// PATH for the child process only. Nothing outside this process is modified.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const desktopDir = resolve(import.meta.dirname, '..')
const repoRoot = resolve(desktopDir, '..', '..')

/** `pnpm@10.28.0` -> `10.28.0`. The version this workspace is pinned to. */
function declaredPnpmVersion() {
  try {
    const field = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).packageManager
    const match = /^pnpm@(\d+\.\d+\.\d+)/.exec(field ?? '')
    return match?.[1] ?? null
  } catch {
    return null
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Every `pnpm` on PATH, in the order `which` on Windows would consider them. */
function pnpmCandidates() {
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const found = []
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, `pnpm${ext}`)
      // A directory can appear on PATH twice; `which` would still only ever
      // return the first hit, so a duplicate here is noise in the diagnostics.
      if (isFile(candidate) && !found.includes(candidate)) found.push(candidate)
    }
  }
  return found
}

/**
 * `pnpm --version`, asked of one specific file.
 *
 * A `.cmd` goes through `cmd /c`: Node has refused to spawn batch files
 * directly since CVE-2024-27980, and a shim reported as "no answer" purely
 * because of that would send this script looking for a problem that is not
 * there.
 */
function versionOf(command) {
  const batch = /\.(cmd|bat)$/i.test(command)
  const [file, args] = batch
    ? [process.env.COMSPEC ?? 'cmd.exe', ['/c', command, '--version']]
    : [command, ['--version']]
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000
    }).trim()
  } catch {
    return null
  }
}

const env = { ...process.env }

/**
 * The key this environment actually spells PATH with.
 *
 * `process.env` is a case-insensitive proxy on Windows; `{ ...process.env }` is
 * a plain object and is not, and it keeps whatever casing the parent used.
 * Launched from PowerShell that is `Path`, so `env.PATH` reads `undefined` -
 * and `env.PATH = shim + delimiter + (env.PATH ?? '')` then wrote a *second*
 * key holding the shim directory and nothing else, while the real PATH sat
 * beside it under `Path`. Node collapses the pair case-insensitively when it
 * builds the child's environment block, the shim-only one won, and
 * electron-builder died with `spawn powershell.exe ENOENT` - having lost
 * System32 - every time this branch was taken.
 *
 * Invisible from a POSIX-style shell, where the key is already `PATH` and the
 * assignment lands on it. That is why it survived: the branch only runs on a
 * machine with a shadowing pnpm, and the bug only bites from the shell that
 * machine's owner uses.
 */
const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'

const declared = declaredPnpmVersion()
const candidates = pnpmCandidates()
const first = candidates[0] ?? null
const firstVersion = first === null ? null : versionOf(first)

if (declared !== null && first !== null && firstVersion !== declared) {
  const working = candidates.find((candidate) => versionOf(candidate) === declared)
  if (working === undefined) {
    console.error(
      `No pnpm on PATH reports ${declared}, which this workspace declares.\n` +
        candidates.map((c) => `  ${c} -> ${versionOf(c) ?? 'no answer'}`).join('\n') +
        '\nelectron-builder would use the first of those and package no native modules.'
    )
    process.exit(1)
  }
  // A directory holding one file, first on PATH. Deliberately `.cmd` and not
  // `.exe`: `which` prefers `.EXE`, so an exe here would be found before the
  // shim in every *other* directory too, which is the problem being fixed.
  const shimDir = mkdtempSync(join(tmpdir(), 'helm-pnpm-shim-'))
  writeFileSync(join(shimDir, 'pnpm.cmd'), `@"${working}" %*\r\n`, 'utf8')
  env[pathKey] = `${shimDir}${delimiter}${env[pathKey] ?? ''}`
  console.log(
    `pnpm on PATH is ${firstVersion ?? 'unreadable'} (${first}); this workspace declares ${declared}.\n` +
      `Using ${working} through a shim in ${shimDir} for this build only.`
  )
}

const builder = join(repoRoot, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
if (!existsSync(builder)) {
  console.error(`electron-builder was not found at ${builder}`)
  process.exit(1)
}

const { status } = spawnSync(process.execPath, [builder, ...process.argv.slice(2)], {
  cwd: desktopDir,
  stdio: 'inherit',
  env
})
process.exit(status ?? 1)
