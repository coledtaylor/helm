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
//   executed.
//
//   node scripts/verify-mac-artifact.mjs               # the dmg and zip in dist-app
//   node scripts/verify-mac-artifact.mjs a.dmg b.zip   # named artefacts
//   node scripts/verify-mac-artifact.mjs --icon        # build/icon.icns only; any OS
//
// Every failure is reported, not just the first.

import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

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

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** `codesign -d` writes what it displays to stderr, and exits 0. */
function codesignDisplay(app) {
  try {
    execFileSync('codesign', ['-d', '--verbose=2', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return ''
  } catch (err) {
    return String(err.stderr ?? err.message)
  }
}

function plistValue(plist, key) {
  try {
    return run('plutil', ['-extract', key, 'raw', '-o', '-', plist]).trim()
  } catch {
    return null
  }
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
    const archs = run('lipo', ['-archs', executable]).trim()
    if (archs !== 'arm64') fail(`the executable is built for "${archs}", expected "arm64"`)
  }

  try {
    run('codesign', ['--verify', '--deep', '--strict', app])
  } catch (err) {
    fail(`the code signature does not verify: ${String(err.stderr ?? err.message).trim()}`)
  }
  const display = codesignDisplay(app)
  if (!/^Signature=adhoc$/m.test(display)) fail(`the signature is not ad-hoc:\n${display.trim()}`)

  const plist = join(contents, 'Info.plist')
  const iconName = plistValue(plist, 'CFBundleIconFile')
  if (iconName === null) fail('Info.plist names no CFBundleIconFile')
  else {
    const icon = join(contents, 'Resources', iconName.endsWith('.icns') ? iconName : `${iconName}.icns`)
    if (!existsSync(icon)) fail(`Info.plist names ${iconName}, which is not in Contents/Resources`)
    else if (!readFileSync(icon).equals(readFileSync(committedIcon))) fail(`${basename(icon)} is not build/icon.icns`)
  }
  if (plistValue(plist, 'NSRequiresAquaSystemAppearance') === 'true') {
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
      fail('node-pty spawn-helper is not executable, so no terminal can start')
    }
  }
  return problems
}

function dmgProblems(dmg) {
  const mount = mkdtempSync(join(tmpdir(), 'helm-dmg-'))
  try {
    run('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount])
  } catch (err) {
    rmSync(mount, { recursive: true, force: true })
    return [`${basename(dmg)}: hdiutil could not attach it: ${String(err.stderr ?? err.message).trim()}`]
  }
  try {
    const problems = appProblems(join(mount, 'Helm.app'), basename(dmg))
    // The window a dmg opens to is the app beside an Applications link to drag
    // it onto; without the link, installing is a Finder chore.
    if (!existsSync(join(mount, 'Applications'))) problems.push(`${basename(dmg)}: no Applications link beside the app`)
    return problems
  } finally {
    run('hdiutil', ['detach', mount, '-force'])
    rmSync(mount, { recursive: true, force: true })
  }
}

function zipProblems(zip) {
  const out = mkdtempSync(join(tmpdir(), 'helm-zip-'))
  try {
    // ditto, not unzip: it is what Finder uses, and it keeps the symlinks and
    // extended attributes a framework's signature covers.
    run('ditto', ['-x', '-k', zip, out])
    return appProblems(join(out, 'Helm.app'), basename(zip))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

const args = process.argv.slice(2)
const problems = icnsProblems(committedIcon)

if (!args.includes('--icon')) {
  if (process.platform !== 'darwin') {
    console.error('Checking the macOS artefacts needs macOS (codesign, hdiutil, ditto, lipo). Pass --icon to check only build/icon.icns.')
    process.exit(2)
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
  process.exit(1)
}
console.log(`verified: ${basename(committedIcon)} carries ${String(ICNS_IMAGES.length)} PNG images, 16 to 1024px`)
