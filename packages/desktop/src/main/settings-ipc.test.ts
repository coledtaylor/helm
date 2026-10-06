import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { readSettings, type ThemeListing, type ThemeState } from '@helm/core'
import { createWorld, disposeWorld, seedSettings, type World } from '../../test/world'
import type { EventChannel, RequestChannel, RequestPayload, RequestResult } from '../shared/ipc'
import type { Services } from './services'
import type { ThemeService } from './themes'
import type * as UpdateModule from './update'

/**
 * Electron as `registerIpc` meets it: the request handlers are captured so the
 * test can call them the way the renderer's `invoke` would, a directory or file
 * picker answers with whatever the test chose, and Windows' light or dark mode
 * is the test's to flip.
 */
const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  /** Whether Windows is in dark mode, as `nativeTheme` reports it. */
  windowsDark: true,
  windowsModeListeners: [] as Array<() => void>,
  pick: null as string | null
}))

vi.mock('electron', async () => {
  const fake = (await import('../../test/electron')).electronFake()
  return {
    ...fake,
    ipcMain: {
      ...(fake['ipcMain'] as object),
      handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
        electron.handlers.set(channel, handler)
      }
    },
    dialog: {
      ...(fake['dialog'] as object),
      showOpenDialog: () =>
        Promise.resolve(
          electron.pick === null
            ? { canceled: true, filePaths: [] }
            : { canceled: false, filePaths: [electron.pick] }
        )
    },
    nativeTheme: {
      get shouldUseDarkColors() {
        return electron.windowsDark
      },
      themeSource: 'system',
      on: (event: string, listener: () => void) => {
        if (event === 'updated') electron.windowsModeListeners.push(listener)
      }
    }
  }
})

// The content viewer's highlighter loads every shiki grammar; nothing here
// reaches it.
vi.mock('./content', () => ({ highlightForEditor: () => Promise.resolve(null) }))

/**
 * The settings surface's main half, through `registerIpc` with the real store,
 * the real theme service on a real folder, and the fake `claude` on PATH: what
 * each request does to the database and to the window, and what goes back to
 * the renderer. The renderer half is `renderer/src/app/settings-hooks.test.tsx`.
 */
describe('settings over IPC', () => {
  let world: World
  let services: Services
  let themes: ThemeService
  let themesDir: string
  /** A second CLI, somewhere else, that answers a version of its own. */
  let picked: string
  let nativeTheme: Electron.NativeTheme
  let update: typeof UpdateModule
  const events: Array<{ channel: EventChannel; payload: unknown }> = []
  const win = {
    isDestroyed: () => false,
    setBackgroundColor: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    setAccentColor: vi.fn(),
    webContents: { send: (channel: EventChannel, payload: unknown) => events.push({ channel, payload }) }
  }

  const invoke = async <K extends RequestChannel>(
    channel: K,
    ...args: RequestPayload<K> extends void ? [] : [RequestPayload<K>]
  ): Promise<RequestResult<K>> => {
    const handler = electron.handlers.get(channel)
    if (!handler) throw new Error(`no handler for ${channel}`)
    return (await handler({}, args[0])) as RequestResult<K>
  }

  const emitted = <T>(channel: EventChannel): T[] =>
    events.filter((event) => event.channel === channel).map((event) => event.payload as T)
  const lastTheme = (): ThemeState | undefined => emitted<ThemeState>('theme:changed').at(-1)
  const stored = () => readSettings(services.store)

  beforeAll(async () => {
    world = createWorld()
    seedSettings(world, { claudePath: null })
    // Read when the modules load: the data directory, Claude's home, and PATH,
    // where discovery finds the world's `claude` before anything else.
    Object.assign(process.env, {
      PORTABLE_EXECUTABLE_DIR: world.portableDir,
      USERPROFILE: world.home,
      HOME: world.home,
      PATH: `${dirname(world.claude)}${delimiter}${process.env['PATH'] ?? ''}`
    })
    delete process.env['CLAUDE_CONFIG_DIR']

    const pickedDir = join(world.root, 'picked bin')
    mkdirSync(pickedDir)
    picked = join(pickedDir, 'claude.cmd')
    writeFileSync(picked, ['@echo off', 'echo 2.1.500 (Claude Code)', ''].join('\r\n'))

    nativeTheme = (await import('electron')).nativeTheme
    update = await import('./update')
    const { createServices } = await import('./services')
    const { createThemeService } = await import('./themes')
    const { registerIpc } = await import('./ipc')
    services = createServices()
    themesDir = join(world.root, 'themes')
    themes = createThemeService(themesDir)
    registerIpc({
      services,
      window: () => win as unknown as BrowserWindow,
      sessions: {} as never,
      restore: {} as never,
      activity: {} as never,
      resources: {} as never,
      pterm: {} as never,
      browsers: {} as never,
      browserMcp: null,
      history: {} as never,
      archive: {} as never,
      usage: {} as never,
      plugins: { pushTheme: vi.fn() } as never,
      config: {} as never,
      content: {} as never,
      files: {} as never,
      templates: {} as never,
      themes,
      rendererReady: () => undefined
    })
  })

  afterAll(() => {
    update.pointReleases(null)
    themes.stop()
    services.store.close()
    disposeWorld(world)
  })

  beforeEach(() => {
    events.length = 0
    win.setBackgroundColor.mockClear()
    win.setTitleBarOverlay.mockClear()
    electron.pick = null
  })

  describe('validation', () => {
    it('refuses a malformed value with the validator’s sentence, and keeps what was stored', async () => {
      await invoke('settings:write', { paneGap: 8 })
      events.length = 0

      await expect(invoke('settings:write', { paneGap: 999 })).rejects.toThrow(/paneGap/)
      expect(stored().paneGap).toBe(8)
      expect(emitted('settings:changed')).toEqual([])
    })
  })

  describe('themes', () => {
    it('applies a chosen theme to Windows, the window background and the title-bar buttons', async () => {
      await invoke('settings:write', { theme: 'light', themeLight: 'daylight' })

      expect(nativeTheme.themeSource).toBe('light')
      expect(lastTheme()?.applied).toMatchObject({ id: 'daylight', kind: 'light' })
      // Daylight's canvas and its muted foreground, from its palette.
      expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#e6e8ee')
      if (process.platform === 'win32') {
        expect(win.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: '#e6e8ee', symbolColor: '#555a69', height: 36 })
        // The window's edge: Daylight's hairline as it lands on its canvas, opaque.
        expect(win.setAccentColor).toHaveBeenLastCalledWith('#d1d3da')
      }

      await invoke('settings:write', { theme: 'dark', themeDark: 'graphite' })
      expect(nativeTheme.themeSource).toBe('dark')
      expect(lastTheme()?.applied).toMatchObject({ id: 'graphite', kind: 'dark' })
      expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#25282e')
      expect(stored()).toMatchObject({ theme: 'dark', themeDark: 'graphite', themeLight: 'daylight' })
    })

    it('following Windows paints whichever slot Windows’ mode picks, and repaints when it changes', async () => {
      await invoke('settings:write', { theme: 'dark' })
      expect(nativeTheme.themeSource).toBe('dark')

      electron.windowsDark = false
      await invoke('settings:write', { theme: 'system', themeDark: 'graphite', themeLight: 'daylight' })
      expect(nativeTheme.themeSource).toBe('system')
      expect(lastTheme()).toMatchObject({ preference: 'system', resolved: 'light', applied: { id: 'daylight' } })

      electron.windowsDark = true
      for (const listener of electron.windowsModeListeners) listener()
      expect(lastTheme()).toMatchObject({ preference: 'system', resolved: 'dark', applied: { id: 'graphite' } })
      expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#25282e')
    })

    it('turns a theme file saved into the folder into a theme, and repaints on every later save', async () => {
      const file = join(themesDir, 'ink.json')
      writeFileSync(file, JSON.stringify({ name: 'Ink', kind: 'dark', colors: { bg: '#000000' } }))
      await vi.waitFor(() => {
        expect(emitted<ThemeListing>('themes:changed').at(-1)?.themes.map((t) => t.id)).toContain('ink')
      }, { timeout: 5000 })

      await invoke('settings:write', { theme: 'dark', themeDark: 'ink' })
      expect(lastTheme()?.applied).toMatchObject({ id: 'ink', fallback: false })
      expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#000000')

      writeFileSync(file, JSON.stringify({ name: 'Ink', kind: 'dark', colors: { bg: '#101820' } }))
      await vi.waitFor(() => expect(lastTheme()?.applied.tokens.bg).toBe('#101820'), { timeout: 5000 })
      expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#101820')
      if (process.platform === 'win32') {
        expect(win.setTitleBarOverlay).toHaveBeenLastCalledWith(expect.objectContaining({ color: '#101820' }))
      }
    })

    it('names a theme file broken mid-edit, drops it, and falls back to the dark slot’s built-in', async () => {
      const file = join(themesDir, 'ink.json')
      writeFileSync(file, JSON.stringify({ name: 'Ink', kind: 'dark', colors: { bg: '#000000' } }))
      await vi.waitFor(() => {
        expect(emitted<ThemeListing>('themes:changed').at(-1)?.themes.map((t) => t.id)).toContain('ink')
      }, { timeout: 5000 })
      await invoke('settings:write', { theme: 'dark', themeDark: 'ink' })
      expect(lastTheme()?.applied.id).toBe('ink')

      writeFileSync(file, '{ "name": "Ink", "kind": "dark", "colors": {')
      await vi.waitFor(() => {
        const listing = emitted<ThemeListing>('themes:changed').at(-1)
        expect(listing?.errors.map((error) => error.file)).toContain('ink.json')
        expect(listing?.themes.map((t) => t.id)).not.toContain('ink')
      }, { timeout: 5000 })
      await vi.waitFor(() => expect(lastTheme()?.applied).toMatchObject({ id: 'nocturne', kind: 'dark', fallback: true }))
      expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#12131f')
    })

    it('duplicates a theme into the folder, where it is a new theme at once', async () => {
      const { file } = await invoke('themes:duplicate', { id: 'graphite' })

      expect(file).toBe(join(themesDir, 'graphite-copy.json'))
      expect(existsSync(file)).toBe(true)
      expect(emitted<ThemeListing>('themes:changed').at(-1)?.themes.map((t) => t.id)).toContain('graphite-copy')
      const listing = await invoke('themes:list')
      expect(listing.themes.find((t) => t.id === 'graphite-copy')?.tokens.bg).toBe('#25282e')
    })
  })

  describe('the Claude CLI', () => {
    it('reports the claude discovery finds on PATH, with the version that executable gives', async () => {
      const status = await invoke('setup:status')
      expect(status).toMatchObject({ source: 'discovered', version: '2.1.999 (Claude Code)' })
      // PATHEXT spells the extension in capitals; it is the same file.
      expect(status.path?.toLowerCase()).toBe(world.claude.toLowerCase())
    })

    it('locates a CLI by the picker, stores it, and reports its own version until it is cleared', async () => {
      electron.pick = picked
      const located = await invoke('setup:locateClaude')

      expect(located).toMatchObject({ source: 'setting', path: picked, version: '2.1.500 (Claude Code)' })
      expect(stored().claudePath).toBe(picked)
      expect(emitted<{ claudePath: string | null }>('settings:changed').at(-1)?.claudePath).toBe(picked)
      expect(await invoke('setup:status')).toMatchObject({ source: 'setting', path: picked })

      await invoke('settings:write', { claudePath: null })
      expect(stored().claudePath).toBeNull()
      const cleared = await invoke('setup:status')
      expect(cleared).toMatchObject({ source: 'discovered', version: '2.1.999 (Claude Code)' })
      expect(cleared.path?.toLowerCase()).toBe(world.claude.toLowerCase())
    })
  })

  describe('scan roots and pins', () => {
    const projectPaths = (result: { projects: Array<{ path: string }> }): string[] =>
      result.projects.map((project) => project.path.toLowerCase()).sort()

    it('adds a picked folder as a root, and the next scan lists what is in it', async () => {
      const more = join(world.root, 'more projects')
      const gamma = join(more, 'gamma')
      mkdirSync(gamma, { recursive: true })
      writeFileSync(join(gamma, 'README.md'), '# gamma\n')
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: gamma, stdio: 'ignore' })

      electron.pick = more
      expect(await invoke('roots:add')).toEqual([world.projectsDir, more])
      expect(stored().scanRoots).toEqual([world.projectsDir, more])

      const scanned = await invoke('discovery:scan', { includeGit: false })
      expect(projectPaths(scanned)).toEqual(
        [world.projects.alpha, world.projects.beta, gamma].map((path) => path.toLowerCase()).sort()
      )
    })

    it('removes a root: its projects and their cached rows go, the other root’s stay, and nothing on disk moves', async () => {
      const more = join(world.root, 'more projects')
      expect(stored().scanRoots).toEqual([world.projectsDir, more])

      expect(await invoke('roots:remove', { path: world.projectsDir })).toEqual([more])
      expect(stored().scanRoots).toEqual([more])
      const cached = (await invoke('discovery:cached')).map((project) => project.path.toLowerCase())
      expect(cached).toEqual([join(more, 'gamma').toLowerCase()])

      const scanned = await invoke('discovery:scan', { includeGit: false })
      expect(projectPaths(scanned)).toEqual([join(more, 'gamma').toLowerCase()])
      expect(existsSync(world.projects.alpha)).toBe(true)
      expect(readFileSync(join(world.projects.alpha, 'README.md'), 'utf8')).toBe('# main\n')
    })

    it('leaves every pin in place across a rescan, one whose folder is gone included', async () => {
      const gone = join(world.root, 'unplugged', 'tools')
      const pins = [world.projects.alpha, gone].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      await invoke('settings:write', { pinnedProjects: pins })

      await invoke('discovery:scan', { includeGit: false })
      expect(stored().pinnedProjects).toEqual(pins)
    })
  })

  describe('updates', () => {
    it('asks the release source on every press, with no throttle and whether or not the launch check is on', async () => {
      await invoke('settings:write', { updateCheck: false })
      let asked = 0
      update.pointReleases(() => {
        asked += 1
        return Promise.resolve('v9.9.9')
      })

      const first = await invoke('update:check')
      const second = await invoke('update:check')
      expect(asked).toBe(2)
      expect(first).toMatchObject({ current: '0.0.0-test', latest: '9.9.9', newer: true, error: null })
      expect(second.newer).toBe(true)
      expect(stored().updateCheck).toBe(false)
    })

    it('counts a release equal to the running build as current', async () => {
      update.pointReleases(() => Promise.resolve('v0.0.0'))
      expect(await invoke('update:check')).toMatchObject({ latest: '0.0.0', newer: false, error: null })
    })

    it('says why it could not ask, and hands back the same releases page either way', async () => {
      const info = await invoke('app:info')
      expect(info.version).toBe('0.0.0-test')
      expect(info.releasesUrl).toMatch(/^https:\/\//)

      update.pointReleases(() => Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com')))
      const failed = await invoke('update:check')
      expect(failed).toMatchObject({ latest: null, newer: false, error: 'getaddrinfo ENOTFOUND api.github.com' })

      update.pointReleases(() => Promise.resolve('v9.9.9'))
      const answered = await invoke('update:check')
      expect(failed.url).toBe(info.releasesUrl)
      expect(answered.url).toBe(info.releasesUrl)
    })

    it('never stamps a manual check as the launch check, on success or failure', async () => {
      update.pointReleases(() => Promise.resolve('v9.9.9'))
      await invoke('update:check')
      update.pointReleases(() => Promise.reject(new Error('offline')))
      await invoke('update:check')
      expect(stored().lastUpdateCheckAt).toBeNull()

      // The launch check does stamp one, which is what makes the line above a
      // statement about the manual one rather than about a timestamp nothing writes.
      await invoke('settings:write', { updateCheck: true })
      update.pointReleases(() => Promise.resolve('v9.9.9'))
      await update.maybeCheckForUpdate(services, null)
      expect(stored().lastUpdateCheckAt).not.toBeNull()
    })
  })
})
