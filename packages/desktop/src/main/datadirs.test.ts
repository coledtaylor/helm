import { homedir } from 'node:os'
import { join, posix, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isolatedBaseFor, isolatedRoot, realDataDirFor } from '../../scripts/isolate.mjs'

/**
 * Where Helm's data lives on each OS: the installed app in Electron's own
 * `userData`, and `pnpm dev` and every check in a folder of their own outside
 * it; templates and themes in `~/.config/helm` wherever the app is installed.
 */

/** Whether `child` is `parent` or anywhere under it, by the rules of `path`. */
function inside(path: typeof posix, parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

describe('the data directories', () => {
  it('on Windows: installed in %APPDATA%\\Helm, dev and checks in %LOCALAPPDATA%\\Helm', () => {
    const env = { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }
    expect(realDataDirFor('win32', env, 'C:\\Users\\me')).toBe('C:\\Users\\me\\AppData\\Roaming\\Helm')
    expect(isolatedBaseFor('win32', env, 'C:\\Users\\me')).toBe('C:\\Users\\me\\AppData\\Local\\Helm')
  })

  it('on macOS: installed in Application Support/Helm, dev and checks in a folder of their own beside it', () => {
    const real = realDataDirFor('darwin', {}, '/Users/me')
    const isolated = isolatedBaseFor('darwin', {}, '/Users/me')
    expect(real).toBe('/Users/me/Library/Application Support/Helm')
    expect(isolated).toBe('/Users/me/Library/Application Support/Helm Dev')
    expect(inside(posix, real, isolated)).toBe(false)
    expect(inside(posix, isolated, real)).toBe(false)
  })

  it('on Linux: installed in ~/.config/Helm, dev and checks in the data home, each following XDG', () => {
    expect(realDataDirFor('linux', {}, '/home/me')).toBe('/home/me/.config/Helm')
    expect(isolatedBaseFor('linux', {}, '/home/me')).toBe('/home/me/.local/share/Helm')
    const xdg = { XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/data' }
    expect(realDataDirFor('linux', xdg, '/home/me')).toBe('/cfg/Helm')
    expect(isolatedBaseFor('linux', xdg, '/home/me')).toBe('/data/Helm')
    expect(inside(posix, '/home/me/.config/Helm', '/home/me/.local/share/Helm')).toBe(false)
  })

  it('puts dev beside the checks under the isolated base, on this OS', () => {
    const base = isolatedBaseFor(process.platform, process.env, homedir())
    expect(isolatedRoot('dev', null)).toBe(join(base, 'dev'))
    expect(isolatedRoot('selftest')).toBe(join(base, 'checks', 'selftest'))
    expect(relative(realDataDirFor(process.platform, process.env, homedir()), base).startsWith('..')).toBe(true)
  })
})

describe('templates and themes', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.doUnmock('electron')
  })

  it('stay in ~/.config/helm for the installed app on every OS, and move with a dev or check run', async () => {
    vi.doMock('electron', async () => (await import('../../test/electron')).electronFake())
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', undefined)
    const installed = await import('./paths')
    expect(installed.templatesDir).toBe(join(homedir(), '.config', 'helm', 'templates'))
    expect(installed.themesDir).toBe(join(homedir(), '.config', 'helm', 'themes'))

    vi.resetModules()
    const run = join(homedir(), 'isolated-run')
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', run)
    const isolated = await import('./paths')
    expect(isolated.appMode).toBe('dev')
    expect(isolated.templatesDir).toBe(join(run, 'helm-data', 'templates'))
  })
})
