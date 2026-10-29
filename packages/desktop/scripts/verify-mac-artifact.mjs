// Asserts that the macOS artefacts are what a person on a Mac needs them to
// be - by opening the dmg and the zip they download, not by looking at
// electron-builder's `mac-arm64/` scratch directory.
//
// For the app inside each artefact:
//
// - its executable is arm64, the only architecture the release builds;
// - it carries a code signature that verifies, and the signature is ad-hoc.
//   Apple Silicon refuses to run an arm64 binary with no signature at all, and
//   there is no Developer ID to sign with, so ad-hoc is the one signature the
//   app can have - and a Developer ID one appearing here unannounced would mean
//   the build picked up a certificate from somewhere;
// - Info.plist names an icon file, and that file is `build/icon.icns`, byte for
//   byte. Finder and the Dock draw the bundle's icon from exactly that, so this
//   is the check that the app shows Helm's wheel rather than Electron's atom;
// - it does not pin itself to the light appearance, which would keep the
//   `system` theme from ever following macOS into dark mode;
// - its native modules are unpacked beside the asar, as on Windows: a module
//   inside the archive cannot be loaded, and node-pty's spawn-helper cannot be
//   executed - nor can it outside the archive without its execute bit.
//
//   node scripts/verify-mac-artifact.mjs               # the dmg and zip in dist-app
//   node scripts/verify-mac-artifact.mjs a.dmg b.zip   # named artefacts
//   node scripts/verify-mac-artifact.mjs --icon        # build/icon.icns only; any OS
//
// Every failure is reported, not just the first, with what the tool that
// found it printed.

import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopDir = resolve(import.meta.dirname, '..')
const distDir = join(desktopDir, 'dist-app')
const committedIcon = join(desktopDir, 'build', 'icon.icns')

/**
 * The images the icon must carry, as [type, pixels]: the iconset `iconutil`
 * builds, which is what `make-icon.mjs` packs. The Dock on a Retina display
 * reads the 512pt@2x (1024px) image, so a pack without it shows a blurred icon.
 */
const ICNS_IMAGES = [
  ['icp4', 16],
  ['ic11', 32],
  ['icp5', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic13', 256],
  ['ic08', 256],
  ['ic14', 512],
  ['ic09', 512],
  ['ic10', 1024]
]

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Native files that must exist under `Contents/Resources/app.asar.unpacked`. */
const UNPACKED = [
  'node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
  'node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
  'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  'node_modules/@koromix/koffi-darwin-arm64'
]

/** Every problem with an .icns file, or none. */
function icnsProblems(file) {
  const problems = []
  const buf = readFileSync(file)
  if (buf.length < 8 || buf.toString('ascii', 0, 4) !== 'icns') return [`${file} is not an icns file`]
  if (buf.readUInt32BE(4) !== buf.length) problems.push(`${file} says it is ${String(buf.readUInt32BE(4))} bytes, is ${String(buf.length)}`)

  const found = new Map()
  for (let at = 8; at < buf.length; ) {
    const type = buf.toString('ascii', at, at + 4)
    const length = buf.readUInt32BE(at + 4)
    if (length < 8 || at + length > buf.length) {
      problems.push(`${file}: element ${type} at ${String(at)} runs past the end`)
      break
    }
    const data = buf.subarray(at + 8, at + length)
    if (data.subarray(0, 8).equals(PNG_SIGNATURE)) found.set(type, { width: data.readUInt32BE(16), height: data.readUInt32BE(20) })
    else found.set(type, null)
    at += length
  }

  for (const [type, size] of ICNS_IMAGES) {
    const image = found.get(type)
    if (image === undefined) problems.push(`${file} has no ${type} (${String(size)}px) image`)
    else if (image === null) problems.push(`${file}: ${type} is not a PNG`)
    else if (image.width !== size || image.height !== size) {
      problems.push(`${file}: ${type} is ${String(image.width)}x${String(image.height)}, expected ${String(size)}x${String(size)}`)
    }
  }
  return problems
}

/**
 * Runs a tool to its end. `stdout` is what it wrote there; `said` is
 * everything it printed, stderr first - `codesign -d` and most failures write
 * there, whatever the exit status - or why it could not be run at all.
 */
function tool(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.error) return { ok: false, stdout: '', said: `${cmd} could not be run: ${result.error.message}`, ended: 'not run' }
  const printed = [result.stderr, result.stdout].map((text) => (text ?? '').trim()).filter((text) => text !== '')
  const ended = result.status === null ? `killed by ${String(result.signal)}` : `exit ${String(result.status)}`
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    said: printed.length > 0 ? printed.join('\n') : `${cmd} printed nothing (${ended})`,
    ended
  }
}

/**
 * Why a `codesign -d --verbose=2` report is not of an ad-hoc signature, or
 * null when it is one. codesign writes the report to stderr, as lines like
 *
 *   Executable=/Volumes/Helm/Helm.app/Contents/MacOS/Helm
 *   Identifier=dev.coletaylor.helm
 *   Format=app bundle with Mach-O thin (arm64)
 *   CodeDirectory v=20400 size=1234 flags=0x2(adhoc) hashes=28+7 location=embedded
 *   Signature=adhoc
 *   TeamIdentifier=not set
 *
 * An ad-hoc signature says so as `Signature=adhoc`, and as the `adhoc` flag on
 * its CodeDirectory. One made with a certificate names the certificate chain
 * in `Authority=` lines instead, and an unsigned app is "not signed at all".
 * Every answer but null carries the whole report.
 */
export function signatureProblem(report) {
  const text = report.trim()
  if (text === '') return 'codesign printed nothing about the signature'
  if (/not signed at all/.test(text)) return `the app is not signed:\n${text}`
  const authority = /^Authority=.*$/m.exec(text)
  if (authority) return `the signature is made with a certificate (${authority[0]}), not ad-hoc:\n${text}`
  const adhoc = /^Signature=adhoc$/m.test(text) || /^CodeDirectory\b.*\bflags=0x[0-9a-f]+\([^)]*\badhoc\b[^)]*\)/m.test(text)
  return adhoc ? null : `the signature is not ad-hoc:\n${text}`
}

/** One key of an Info.plist, or why plutil could not read it. */
function plistValue(plist, key) {
  const read = tool('plutil', ['-extract', key, 'raw', '-o', '-', plist])
  return read.ok ? { value: read.stdout.trim(), said: null } : { value: null, said: read.said }
}

/** Every problem with one Helm.app, prefixed with where it came from. */
function appProblems(app, origin) {
  const problems = []
  const fail = (message) => problems.push(`${origin}: ${message}`)
  if (!existsSync(app)) return [`${origin}: no Helm.app inside`]

  const contents = join(app, 'Contents')
  const executable = join(contents, 'MacOS', 'Helm')
  if (!existsSync(executable)) fail('Contents/MacOS/Helm is missing')
  else {
    const lipo = tool('lipo', ['-archs', executable])
    const archs = lipo.stdout.trim()
    if (!lipo.ok) fail(`lipo could not read the executable's architectures: ${lipo.said}`)
    else if (archs !== 'arm64') fail(`the executable is built for "${archs}", expected "arm64"`)
  }

  const verify = tool('codesign', ['--verify', '--deep', '--strict', app])
  if (!verify.ok) fail(`the code signature does not verify: ${verify.said}`)
  const display = tool('codesign', ['-d', '--verbose=2', app])
  if (!display.ok) fail(`codesign could not display the signature (${display.ended}): ${display.said}`)
  else {
    const problem = signatureProblem(display.said)
    if (problem !== null) fail(problem)
  }

  const plist = join(contents, 'Info.plist')
  const icon = plistValue(plist, 'CFBundleIconFile')
  if (icon.value === null) fail(`Info.plist names no CFBundleIconFile: ${icon.said}`)
  else {
    const iconName = icon.value
    const iconFile = join(contents, 'Resources', iconName.endsWith('.icns') ? iconName : `${iconName}.icns`)
    if (!existsSync(iconFile)) fail(`Info.plist names ${iconName}, which is not in Contents/Resources`)
    else if (!readFileSync(iconFile).equals(readFileSync(committedIcon))) fail(`${basename(iconFile)} is not build/icon.icns`)
  }
  if (plistValue(plist, 'NSRequiresAquaSystemAppearance').value === 'true') {
    fail('Info.plist sets NSRequiresAquaSystemAppearance, so the app never follows macOS into dark mode')
  }

  const resources = join(contents, 'Resources')
  if (!existsSync(join(resources, 'app.asar'))) fail('Contents/Resources/app.asar is missing')
  for (const path of UNPACKED) {
    const full = join(resources, 'app.asar.unpacked', path)
    if (!existsSync(full)) fail(`app.asar.unpacked/${path} is missing`)
  }
  const helper = join(resources, 'app.asar.unpacked', 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper')
  if (existsSync(helper)) {
    try {
      accessSync(helper, constants.X_OK)
    } catch {
      const mode = (statSync(helper).mode & 0o777).toString(8).padStart(3, '0')
      fail(`node-pty spawn-helper is not executable (mode ${mode}), so no terminal can start`)
    }
  }
  // Where `flotiBinary` looks for the local host in a packaged build.
  const floti = join(resources, 'floti')
  if (!existsSync(floti)) fail('Contents/Resources/floti is missing, so sessions cannot run in the local host')
  else {
    try {
      accessSync(floti, constants.X_OK)
    } catch {
      fail('Contents/Resources/floti is not executable, so sessions cannot run in the local host')
    }
  }
  return problems
}

function dmgProblems(dmg) {
  const mount = mkdtempSync(join(tmpdir(), 'helm-dmg-'))
  const attach = tool('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount])
  if (!attach.ok) {
    rmSync(mount, { recursive: true, force: true })
    return [`${basename(dmg)}: hdiutil could not attach it: ${attach.said}`]
  }
  try {
    const problems = appProblems(join(mount, 'Helm.app'), basename(dmg))
    // The window a dmg opens to is the app beside an Applications link to drag
    // it onto; without the link, installing is a Finder chore.
    if (!existsSync(join(mount, 'Applications'))) problems.push(`${basename(dmg)}: no Applications link beside the app`)
    return problems
  } finally {
    const detach = tool('hdiutil', ['detach', mount, '-force'])
    if (detach.ok) rmSync(mount, { recursive: true, force: true })
    else console.error(`warning: hdiutil could not detach ${mount}: ${detach.said}`)
  }
}

function zipProblems(zip) {
  const out = mkdtempSync(join(tmpdir(), 'helm-zip-'))
  try {
    // ditto, not unzip: it is what Finder uses, and it keeps the symlinks and
    // extended attributes a framework's signature covers.
    const extract = tool('ditto', ['-x', '-k', zip, out])
    if (!extract.ok) return [`${basename(zip)}: ditto could not extract it: ${extract.said}`]
    return appProblems(join(out, 'Helm.app'), basename(zip))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

function main(args) {
  const problems = icnsProblems(committedIcon)

  if (!args.includes('--icon')) {
    if (process.platform !== 'darwin') {
      console.error('Checking the macOS artefacts needs macOS (codesign, hdiutil, ditto, lipo). Pass --icon to check only build/icon.icns.')
      return 2
    }
    const named = args.filter((a) => !a.startsWith('--')).map((a) => resolve(a))
    const artefacts =
      named.length > 0
        ? named
        : existsSync(distDir)
          ? readdirSync(distDir)
              .filter((name) => /^Helm-.+-arm64(-mac\.zip|\.dmg)$/.test(name))
              .map((name) => join(distDir, name))
          : []
    if (artefacts.length === 0) problems.push(`no Helm-*-arm64.dmg or Helm-*-arm64-mac.zip in ${distDir}; run pnpm dist:mac`)
    for (const artefact of artefacts) {
      if (!existsSync(artefact) || !statSync(artefact).isFile()) problems.push(`${artefact} does not exist`)
      else if (artefact.endsWith('.dmg')) problems.push(...dmgProblems(artefact))
      else if (artefact.endsWith('.zip')) problems.push(...zipProblems(artefact))
      else problems.push(`${basename(artefact)} is neither a dmg nor a zip`)
    }
    if (problems.length === 0) console.log(`verified: ${artefacts.map((a) => basename(a)).join(', ')}`)
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL ${problem}`)
    return 1
  }
  console.log(`verified: ${basename(committedIcon)} carries ${String(ICNS_IMAGES.length)} PNG images, 16 to 1024px`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
