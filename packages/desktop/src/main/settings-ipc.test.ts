import { existsSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { readSettings, UPDATE_CHECK_EVERY_MS, writeSettings, type ThemeListing, type ThemeState } from '@helm/core'
import { createWorld, disposeWorld, seedSettings, type World } from '../../test/world'
import type { EventChannel, RequestChannel, RequestPayload, RequestResult } from '../shared/ipc'
import type { Services } from './services'
import type { ThemeService } from './themes'
import type * as UpdateModule from './update'
import { PATIENCE } from '../../../../test/patience'

/**
 * Electron as `registerIpc` meets it: the request handlers are captured so the
 * test can call them the way the renderer's `invoke` would, a directory
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

/**
 * This device's own settings, main's half, through `registerIpc` with the real
 * store and the real theme service on a real folder: what each request does to
 * the database and to the window, and what goes back to the renderer. The
 * host's half of the settings is the host's; the renderer half is
 * `renderer/src/app/settings-hooks.test.tsx`.
 */
describe('settings over IPC', () => {
  let world: World
  let services: Services
  let themes: ThemeService
  let themesDir: string
  let nativeTheme: Electron.NativeTheme
  let update: typeof UpdateModule
  const events: Array<{ channel: EventChannel; payload: unknown }> = []
  /** What tells the local host Helm's settings again, as `index.ts` passes it. */
  const hostSettingsChanged = vi.fn()
  /** The folders the window's picker handed to the host's scan roots. */
  const acceptedRoots: string[][] = []
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
      pageLinks: {} as never,
      remoteHosts: {} as never,
      remoteInstall: {} as never,
      remoteAdd: {} as never,
      sshHosts: () => Promise.resolve({ found: false, hosts: [] }),
      wslDistros: () => Promise.resolve([]),
      forwards: {} as never,
      browsers: {} as never,
      browserMcp: null,
      workspace: {
        acceptRoots: (paths: string[]) => {
          acceptedRoots.push(paths)
          return Promise.resolve([world.projectsDir, ...paths])
        },
        settings: () => Promise.resolve(stored())
      } as never,
      files: {} as never,
      themes,
      plugins: { pushTheme: vi.fn() } as never,
      hostPlugins: {} as never,
      remotePlugins: {} as never,
      pluginBackground: () => null,
      localHost: {} as never,
      ownData: {} as never,
      rendererReady: () => undefined,
      hostSettingsChanged
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

  describe('the local host', () => {
    it('tells the host at once when the browser tools are switched off or on or held to this machine, and not for what it is not given', async () => {
      hostSettingsChanged.mockClear()
      await invoke('ownSettings:write', { browserMcp: false })
      expect(hostSettingsChanged).toHaveBeenCalledTimes(1)
      await invoke('ownSettings:write', { browserMcp: true })
      await invoke('ownSettings:write', { browserMcpLocalOnly: true })
      await invoke('ownSettings:write', { browserMcpLocalOnly: false })
      expect(hostSettingsChanged).toHaveBeenCalledTimes(4)
      expect(stored()).toMatchObject({ browserMcp: true, browserMcpLocalOnly: false })

      await invoke('ownSettings:write', { browserSearch: 'off' })
      expect(hostSettingsChanged).toHaveBeenCalledTimes(4)
    })

    it('tells the host at once when the archive’s ceiling changes', async () => {
      hostSettingsChanged.mockClear()
      await invoke('ownSettings:write', { transcriptArchiveMaxBytes: 512 * 1024 * 1024 })
      expect(hostSettingsChanged).toHaveBeenCalledTimes(1)
      expect(stored()).toMatchObject({ transcriptArchiveMaxBytes: 512 * 1024 * 1024 })
    })

    it('tells the host at once when the session tools are switched off or on', async () => {
      hostSettingsChanged.mockClear()
      await invoke('ownSettings:write', { sessionMcp: false })
      expect(hostSettingsChanged).toHaveBeenCalledTimes(1)
      await invoke('ownSettings:write', { sessionMcp: true })
      expect(hostSettingsChanged).toHaveBeenCalledTimes(2)
      expect(stored()).toMatchObject({ sessionMcp: true })
    })

    it('tells the host at once when sessions are allowed to start agents or not, and when any limit on them changes', async () => {
      hostSettingsChanged.mockClear()
      await invoke('ownSettings:write', { sessionAgents: false })
      expect(hostSettingsChanged).toHaveBeenCalledTimes(1)
      await invoke('ownSettings:write', { sessionAgents: true })
      expect(hostSettingsChanged).toHaveBeenCalledTimes(2)

      for (const [key, value] of [
        ['agentChildrenPerParent', 6],
        ['agentSessionsPerHost', 12],
        ['agentDepth', 3],
        ['agentStartsPerParent', 20],
        ['agentCommandsPerParent', 2]
      ] as const) {
        const before = hostSettingsChanged.mock.calls.length
        await invoke('ownSettings:write', { [key]: value })
        expect(hostSettingsChanged).toHaveBeenCalledTimes(before + 1)
      }
      expect(stored()).toMatchObject({
        sessionAgents: true,
        agentChildrenPerParent: 6,
        agentSessionsPerHost: 12,
        agentDepth: 3,
        agentStartsPerParent: 20,
        agentCommandsPerParent: 2
      })
    })

    it('keeps the limits it was given and tells the host nothing when one is refused', async () => {
      hostSettingsChanged.mockClear()
      await expect(invoke('ownSettings:write', { agentDepth: 0 })).rejects.toThrow(/agentDepth/)
      await expect(invoke('ownSettings:write', { agentChildrenPerParent: 2.5 })).rejects.toThrow(
        /agentChildrenPerParent/
      )
      await expect(invoke('ownSettings:write', { sessionAgents: 'false' as never })).rejects.toThrow(/sessionAgents/)
      expect(hostSettingsChanged).not.toHaveBeenCalled()
      expect(stored()).toMatchObject({ agentDepth: 3, agentChildrenPerParent: 6, sessionAgents: true })
    })
  })

  describe('validation', () => {
    it('refuses a malformed value with the validator’s sentence, and keeps what was stored', async () => {
      await invoke('ownSettings:write', { paneGap: 8 })
      events.length = 0

      await expect(invoke('ownSettings:write', { paneGap: 999 })).rejects.toThrow(/paneGap/)
      expect(stored().paneGap).toBe(8)
      expect(emitted('ownSettings:changed')).toEqual([])
    })
  })

  describe('themes', () => {
    it('applies a chosen theme to Windows, the window background and the title-bar buttons', async () => {
      await invoke('ownSettings:write', { theme: 'light', themeLight: 'daylight' })

      expect(nativeTheme.themeSource).toBe('light')
      expect(lastTheme()?.applied).toMatchObject({ id: 'daylight', kind: 'light' })
      // Daylight's canvas and its muted foreground, from its palette.
      expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#e6e8ee')
      if (process.platform === 'win32') {
        expect(win.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: '#e6e8ee', symbolColor: '#555a69', height: 36 })
        // The window's edge: Daylight's hairline as it lands on its canvas, opaque.
        expect(win.setAccentColor).toHaveBeenLastCalledWith('#d1d3da')
      }

      await invoke('ownSettings:write', { theme: 'dark', themeDark: 'graphite' })
      expect(nativeTheme.themeSource).toBe('dark')
      expect(lastTheme()?.applied).toMatchObject({ id: 'graphite', kind: 'dark' })
      expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#25282e')
      expect(stored()).toMatchObject({ theme: 'dark', themeDark: 'graphite', themeLight: 'daylight' })
    })

    it('following Windows paints whichever slot Windows’ mode picks, and repaints when it changes', async () => {
      await invoke('ownSettings:write', { theme: 'dark' })
      expect(nativeTheme.themeSource).toBe('dark')

      electron.windowsDark = false
      await invoke('ownSettings:write', { theme: 'system', themeDark: 'graphite', themeLight: 'daylight' })
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
      }, { timeout: PATIENCE })

      await invoke('ownSettings:write', { theme: 'dark', themeDark: 'ink' })
      expect(lastTheme()?.applied).toMatchObject({ id: 'ink', fallback: false })
      expect(win.setBackgroundColor).toHaveBeenLastCalledWith('#000000')

      writeFileSync(file, JSON.stringify({ name: 'Ink', kind: 'dark', colors: { bg: '#101820' } }))
      await vi.waitFor(() => expect(lastTheme()?.applied.tokens.bg).toBe('#101820'), { timeout: PATIENCE })
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
      }, { timeout: PATIENCE })
      await invoke('ownSettings:write', { theme: 'dark', themeDark: 'ink' })
      expect(lastTheme()?.applied.id).toBe('ink')

      writeFileSync(file, '{ "name": "Ink", "kind": "dark", "colors": {')
      await vi.waitFor(() => {
        const listing = emitted<ThemeListing>('themes:changed').at(-1)
        expect(listing?.errors.map((error) => error.file)).toContain('ink.json')
        expect(listing?.themes.map((t) => t.id)).not.toContain('ink')
      }, { timeout: PATIENCE })
      await vi.waitFor(() => expect(lastTheme()?.applied).toMatchObject({ id: 'nocturne', kind: 'dark', fallback: true }), { timeout: PATIENCE })
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

  describe('scan roots', () => {
    it('hands a folder picked in the window to the host’s scan roots, and nothing when the picker is cancelled', async () => {
      const more = join(world.root, 'more projects')
      electron.pick = more
      expect(await invoke('roots:add')).toEqual([world.projectsDir, more])
      expect(acceptedRoots).toEqual([[more]])

      electron.pick = null
      await invoke('roots:add')
      expect(acceptedRoots).toEqual([[more]])
    })
  })

  describe('updates', () => {
    it('asks the release source on every press, with no throttle and whether or not the launch check is on', async () => {
      await invoke('ownSettings:write', { updateCheck: false })
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
      const info = await invoke('ownApp:info')
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
      await invoke('ownSettings:write', { updateCheck: true })
      update.pointReleases(() => Promise.resolve('v9.9.9'))
      await update.maybeCheckForUpdate(services, null)
      expect(stored().lastUpdateCheckAt).not.toBeNull()
    })

    it('S9: asks GitHub at most once a day at start, keeps the time in helm.db and tells the window of a newer version', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const start = new Date('2026-11-03T08:00:00.000Z')
        vi.setSystemTime(start)
        writeSettings(services.store, { updateCheck: true, lastUpdateCheckAt: null })
        services.settings = readSettings(services.store)
        update.pointReleases(() => Promise.resolve('v9.9.9'))
        const told = () => emitted<{ newer: boolean; latest: string | null }>('update:checked')
        const toldBefore = told().length

        await update.maybeCheckForUpdate(services, win as unknown as BrowserWindow)
        expect(update.releasesAsked()).toBe(1)
        expect(stored().lastUpdateCheckAt).toBe(start.toISOString())
        expect(told().slice(toldBefore)).toEqual([expect.objectContaining({ newer: true, latest: '9.9.9' })])

        // A second start within the day asks nothing and tells the window nothing.
        vi.setSystemTime(start.getTime() + UPDATE_CHECK_EVERY_MS - 1)
        await update.maybeCheckForUpdate(services, win as unknown as BrowserWindow)
        expect(update.releasesAsked()).toBe(1)
        expect(told().length).toBe(toldBefore + 1)

        // A start once the day has passed asks again and keeps the new time.
        const later = new Date(start.getTime() + UPDATE_CHECK_EVERY_MS)
        vi.setSystemTime(later)
        await update.maybeCheckForUpdate(services, win as unknown as BrowserWindow)
        expect(update.releasesAsked()).toBe(2)
        expect(stored().lastUpdateCheckAt).toBe(later.toISOString())
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
