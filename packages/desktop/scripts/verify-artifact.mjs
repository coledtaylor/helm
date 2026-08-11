// Asserts that a built Windows artefact actually carries its unpacked native
// modules - by looking inside the exe, not beside it.
//
// Why this exists:
//
// electron-builder asks the package manager for the production dependency
// graph, and that graph decides what gets packaged. When it cannot get a usable
// answer it does not fail: it falls back to the npm collector, warns "cannot
// find path for dependency ...@undefined" once per package, and produces an exe
// that looks fine and is only ~8% small. What is missing is
// `app.asar.unpacked` - and better-sqlite3 and node-pty are both native, both
// listed in `asarUnpack`, and both die on their first `dlopen` from inside an
// asar. The app launches and immediately cannot open its database or spawn a
// pty. This happened on a real machine on 2026-08-10; scripts/dist-win.mjs is
// the guard against the cause, and this is the check on the result.
//
// Checking `dist-app/win-unpacked/` would be checking electron-builder's
// scratch directory, not the thing a person downloads. Both artefacts are
// NSIS-3 executables wrapping a single nested payload at
// `$PLUGINSDIR/app-64.7z`, so the app tree is two archives deep. This unwraps
// both levels with 7-Zip and asserts on the entries it finds there.
//
//   node scripts/verify-artifact.mjs                     # every exe in dist-app
//   node scripts/verify-artifact.mjs path/to/Helm-x.exe  # named artefacts
//
// Every failure is reported, not just the first, because "which of these is
// missing" is the question you have when this fails.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const desktopDir = resolve(import.meta.dirname, '..')
const distDir = join(desktopDir, 'dist-app')

/** The nested archive electron-builder's NSIS targets wrap the app tree in. */
const PAYLOAD = 'app-64.7z'

/**
 * Paths that must be present, as files, inside the payload.
 *
 * Deliberately the win32-x64 set and not a wildcard: these are the binaries
 * that actually load when the artefact runs on the platform it is built for.
 * A build can carry every other architecture's prebuild and still be dead. The
 * conpty/winpty helpers are here because docs/PACKAGING.md names them as the
 * second reason `asarUnpack` exists - they are spawned as executables, which an
 * asar cannot provide a real path for.
 */
const REQUIRED = [
  'resources\\app.asar',
  'resources\\app.asar.unpacked\\node_modules\\better-sqlite3\\prebuilds\\win32-x64.node',
  'resources\\app.asar.unpacked\\node_modules\\node-pty\\prebuilds\\win32-x64\\pty.node',
  'resources\\app.asar.unpacked\\node_modules\\node-pty\\prebuilds\\win32-x64\\conpty.node',
  'resources\\app.asar.unpacked\\node_modules\\node-pty\\prebuilds\\win32-x64\\conpty\\conpty.dll',
  'resources\\app.asar.unpacked\\node_modules\\node-pty\\prebuilds\\win32-x64\\conpty\\OpenConsole.exe',
  'resources\\app.asar.unpacked\\node_modules\\node-pty\\prebuilds\\win32-x64\\winpty-agent.exe',
  'resources\\app.asar.unpacked\\node_modules\\node-pty\\prebuilds\\win32-x64\\winpty.dll'
]

/**
 * A listing that comes back empty must fail as "the listing failed", never as
 * "every required file is absent" - the two have very different fixes, and a
 * check that cannot tell them apart is one that reports a broken 7-Zip as a
 * broken build. The good artefact has 409 entries; this is a floor, not a
 * measurement.
 */
const MIN_ENTRIES = 50

function locate7z() {
  const candidates = [
    process.env.SEVENZIP,
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    '7z'
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      // `i` prints the supported formats and exits 0. Cheaper than a listing
      // and it proves the binary runs, which `existsSync` would not.
      execFileSync(candidate, ['i'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 })
      return candidate
    } catch {
      continue
    }
  }
  return null
}

/**
 * Every entry in an archive, as `{ path, size, directory }`.
 *
 * `-slt` is the machine-readable listing: a `----------` line, then blank-line
 * separated `Key = Value` blocks. The default human listing is column-aligned
 * text whose columns move depending on the widest value in them, which is not
 * something to parse when the archive format offers this.
 */
function listEntries(sevenZip, archive) {
  const raw = execFileSync(sevenZip, ['l', '-slt', archive], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
    timeout: 15 * 60_000
  }).replace(/\r\n/g, '\n')

  const marker = '\n----------\n'
  const start = raw.indexOf(marker)
  if (start === -1) return []

  const entries = []
  for (const block of raw.slice(start + marker.length).split('\n\n')) {
    const record = {}
    for (const line of block.split('\n')) {
      const split = line.indexOf(' = ')
      if (split !== -1) record[line.slice(0, split)] = line.slice(split + 3)
    }
    if (record.Path === undefined) continue
    entries.push({
      // 7-Zip reports NSIS paths with backslashes and .7z paths as stored;
      // normalise so REQUIRED can be written one way.
      path: record.Path.replace(/\//g, '\\'),
      size: Number(record.Size ?? '0'),
      directory: (record.Attributes ?? '').includes('D')
    })
  }
  return entries
}

/** @returns {string[]} the reasons this artefact fails, empty if it passes. */
function verify(sevenZip, exe, scratch) {
  const label = basename(exe)
  if (!existsSync(exe)) return [`${label}: no such file (${exe})`]

  const outer = listEntries(sevenZip, exe)
  if (outer.length === 0) {
    return [`${label}: 7-Zip read no entries at all - not an NSIS artefact, or 7-Zip could not open it`]
  }

  const payload = outer.find((entry) => entry.path.endsWith(`\\${PAYLOAD}`) || entry.path === PAYLOAD)
  if (payload === undefined) {
    return [
      `${label}: no ${PAYLOAD} inside it. electron-builder's NSIS targets wrap the app tree in one; ` +
        `this artefact carries ${String(outer.length)} entries and none of them is it, so either the ` +
        'packaging changed shape or this is not a Helm artefact.'
    ]
  }

  const into = mkdtempSync(join(scratch, 'payload-'))
  execFileSync(sevenZip, ['e', exe, `-o${into}`, payload.path, '-y'], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 15 * 60_000
  })

  const inner = listEntries(sevenZip, join(into, PAYLOAD))
  const files = new Map(inner.filter((e) => !e.directory).map((e) => [e.path, e.size]))

  if (files.size < MIN_ENTRIES) {
    return [
      `${label}: ${PAYLOAD} listed only ${String(files.size)} files (expected at least ` +
        `${String(MIN_ENTRIES)}). Treating this as a failed read rather than a failed build.`
    ]
  }

  const failures = []
  for (const required of REQUIRED) {
    const size = files.get(required)
    if (size === undefined) failures.push(`${label}: missing ${required}`)
    else if (size === 0) failures.push(`${label}: ${required} is zero bytes`)
  }

  const unpacked = [...files.keys()].filter((p) => p.startsWith('resources\\app.asar.unpacked\\')).length
  const megabytes = (statSync(exe).size / 1024 / 1024).toFixed(1)
  if (failures.length === 0) {
    console.log(
      `  ${label}  ${megabytes} MB, ${String(files.size)} files, ` +
        `${String(unpacked)} under app.asar.unpacked - all ${String(REQUIRED.length)} required present`
    )
  } else {
    console.log(`  ${label}  ${megabytes} MB, ${String(files.size)} files, ${String(unpacked)} under app.asar.unpacked`)
  }
  return failures
}

// `pnpm verify:artifact -- foo.exe` forwards the `--` itself, so it arrives
// here as an argument and would be read as a filename. Drop it rather than
// report `--: no such file`, which is a confusing answer to a correct command.
const named = process.argv.slice(2).filter((argument) => argument !== '--')
let artefacts
if (named.length > 0) {
  artefacts = named.map((path) => resolve(path))
} else {
  if (!existsSync(distDir)) {
    console.error(`No ${distDir} to check. Run \`pnpm dist:win\` first, or name the artefacts as arguments.`)
    process.exit(1)
  }
  artefacts = readdirSync(distDir)
    .filter((name) => /^Helm-.*\.exe$/.test(name))
    .map((name) => join(distDir, name))
  if (artefacts.length === 0) {
    console.error(`No Helm-*.exe in ${distDir}. Run \`pnpm dist:win\` first.`)
    process.exit(1)
  }
}

const sevenZip = locate7z()
if (sevenZip === null) {
  console.error(
    'No working 7z found. Looked at $SEVENZIP, both Program Files locations and PATH.\n' +
      'It ships on the GitHub windows-latest image and with the 7-Zip installer.'
  )
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'helm-verify-artifact-'))
let failures = []
try {
  console.log(`Verifying ${String(artefacts.length)} artefact(s) with ${sevenZip}:`)
  for (const artefact of artefacts) failures = failures.concat(verify(sevenZip, artefact, scratch))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${String(failures.length)} problem(s):`)
  for (const failure of failures) console.error(`  ${failure}`)
  console.error(
    '\nAn artefact with no app.asar.unpacked is one that dies on its first dlopen.\n' +
      'See the header of scripts/dist-win.mjs for the cause this is guarding against.'
  )
  process.exit(1)
}

console.log(`\nOK - every artefact carries its unpacked native modules.`)
