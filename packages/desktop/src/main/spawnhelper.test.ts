import { spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import afterPack, { packagedNodePty } from '../../scripts/after-pack.mjs'
import { makeSpawnHelpersExecutable, spawnHelpers } from '../../scripts/spawn-helper.mjs'

/**
 * node-pty's macOS spawn-helper, which the package publishes without its
 * execute bit: made executable after install (the postinstall) and in the
 * packaged app (electron-builder's afterPack hook), and nowhere else. The
 * modes are POSIX's, so the tests that read them run on macOS and Linux, and
 * under WSL through `pnpm test:posix`.
 */

const DESKTOP = resolve(import.meta.dirname, '..', '..')
const SCRIPT = join(DESKTOP, 'scripts', 'spawn-helper.mjs')
const onPosix = it.runIf(process.platform !== 'win32')

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helm spawn-helper-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A node-pty folder laid out as the package publishes it, every file 0644. */
function nodePty(dir: string, prebuilds: string[]): string {
  for (const prebuild of prebuilds) {
    mkdirSync(join(dir, 'prebuilds', prebuild), { recursive: true })
    for (const file of prebuild.startsWith('darwin-') ? ['pty.node', 'spawn-helper'] : ['pty.node']) {
      writeFileSync(join(dir, 'prebuilds', prebuild, file), '')
      chmodSync(join(dir, 'prebuilds', prebuild, file), 0o644)
    }
  }
  return dir
}

const mode = (path: string): number => statSync(path).mode & 0o777

/** What afterPack is handed for a Mac build: the bundle's Resources are inside Helm.app. */
function macContext(platform: string): Parameters<typeof afterPack>[0] {
  return {
    appOutDir: join(root, 'mac-arm64'),
    electronPlatformName: platform,
    packager: { getResourcesDir: (appOutDir: string) => join(appOutDir, 'Helm.app', 'Contents', 'Resources') }
  }
}

describe("node-pty's spawn-helper", () => {
  onPosix('is made executable in every macOS prebuild, and nothing else is touched', () => {
    const dir = nodePty(join(root, 'node-pty'), ['darwin-arm64', 'darwin-x64', 'win32-x64'])
    chmodSync(join(dir, 'prebuilds', 'darwin-x64', 'spawn-helper'), 0o600)

    const helpers = [join(dir, 'prebuilds', 'darwin-arm64', 'spawn-helper'), join(dir, 'prebuilds', 'darwin-x64', 'spawn-helper')]
    expect([...spawnHelpers(dir)].sort()).toEqual(helpers)
    expect([...makeSpawnHelpersExecutable(dir)].sort()).toEqual(helpers)
    expect(mode(helpers[0]!)).toBe(0o755)
    expect(mode(helpers[1]!)).toBe(0o711)
    for (const helper of helpers) accessSync(helper, constants.X_OK)
    expect(mode(join(dir, 'prebuilds', 'darwin-arm64', 'pty.node'))).toBe(0o644)
    expect(mode(join(dir, 'prebuilds', 'win32-x64', 'pty.node'))).toBe(0o644)
  })

  onPosix('changes nothing when made executable again', () => {
    const dir = nodePty(join(root, 'node-pty'), ['darwin-arm64'])
    makeSpawnHelpersExecutable(dir)
    expect(makeSpawnHelpersExecutable(dir)).toEqual([])
    expect(mode(join(dir, 'prebuilds', 'darwin-arm64', 'spawn-helper'))).toBe(0o755)
  })

  it('finds none in a node-pty with no macOS prebuild, or none at all', () => {
    expect(spawnHelpers(nodePty(join(root, 'windows only'), ['win32-x64']))).toEqual([])
    expect(spawnHelpers(join(root, 'built from source'))).toEqual([])
    expect(makeSpawnHelpersExecutable(join(root, 'built from source'))).toEqual([])
  })

  it('runs as the postinstall: on macOS the installed node-pty can start a pty after it, and elsewhere it does nothing', () => {
    const run = spawnSync(process.execPath, [SCRIPT], { cwd: DESKTOP, encoding: 'utf8' })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    if (process.platform === 'darwin') {
      const installed = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
      expect(spawnHelpers(installed).length).toBeGreaterThan(0)
      for (const helper of spawnHelpers(installed)) accessSync(helper, constants.X_OK)
    } else {
      expect(run.stdout).toBe('')
    }
  })

  it('is wired to run after install and after packing', () => {
    const scripts = (JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    expect(scripts['postinstall']).toBe('node scripts/spawn-helper.mjs')
    expect(readFileSync(join(DESKTOP, 'electron-builder.yml'), 'utf8')).toMatch(/^afterPack: \.\/scripts\/after-pack\.mjs$/m)
  })
})

describe("electron-builder's afterPack hook", () => {
  onPosix("makes the Mac app's unpacked spawn-helper executable, before it is signed", () => {
    const context = macContext('darwin')
    const dir = nodePty(packagedNodePty(context), ['darwin-arm64'])
    expect(dir).toBe(join(root, 'mac-arm64', 'Helm.app', 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty'))
    afterPack(context)
    accessSync(join(dir, 'prebuilds', 'darwin-arm64', 'spawn-helper'), constants.X_OK)
  })

  onPosix('leaves a Windows or Linux package alone', () => {
    for (const platform of ['win32', 'linux']) {
      const context = macContext(platform)
      const dir = nodePty(packagedNodePty(context), ['darwin-arm64'])
      afterPack(context)
      expect(mode(join(dir, 'prebuilds', 'darwin-arm64', 'spawn-helper'))).toBe(0o644)
    }
  })

  it('fails a Mac build that has no spawn-helper, naming where it looked', () => {
    const context = macContext('darwin')
    nodePty(packagedNodePty(context), ['win32-x64'])
    expect(() => afterPack(context)).toThrow(/no node-pty spawn-helper under .*app\.asar\.unpacked.*could start no terminal/)
    expect(() => afterPack(macContext('win32'))).not.toThrow()
  })
})
