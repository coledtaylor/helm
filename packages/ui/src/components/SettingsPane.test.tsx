import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  BUILTIN_THEMES,
  CORNER_RADIUS,
  DEFAULT_SETTINGS,
  PANE_GAP,
  quitChoice,
  type ThemeDefinition,
  type ThemeListing,
  type ThemeState
} from '@helm/core/types'
import type { SettingsHost } from './HostsSettings'
import {
  SettingsPane,
  updateOutcome,
  type AppearanceSettings,
  type SettingsPaneProps,
  type UpdateCheckResult
} from './SettingsPane'
import type { SetupClaudeStatus } from './SetupPane'
import { SETTINGS_SECTIONS, type SettingsSectionId } from './SettingsSections'

const builtin = (id: string): ThemeDefinition => {
  const theme = BUILTIN_THEMES.find((t) => t.id === id)
  if (!theme) throw new Error(`no built-in theme ${id}`)
  return theme
}

const LISTING: ThemeListing = { dir: 'C:\\helm data\\themes', themes: [...BUILTIN_THEMES], errors: [] }

/** The theme main says is on screen. */
const showing = (theme: ThemeDefinition, preference: ThemeState['preference'] = theme.kind): ThemeState => ({
  preference,
  resolved: theme.kind,
  applied: { id: theme.id, name: theme.name, kind: theme.kind, tokens: theme.tokens, shadow: '', fallback: false }
})

const APPEARANCE: AppearanceSettings = {
  theme: 'dark',
  themeDark: 'nocturne',
  themeLight: 'daylight',
  paneGap: PANE_GAP.default,
  cornerRadius: CORNER_RADIUS.default,
  density: 'comfortable',
  accentColor: null
}

const DISCOVERED: SetupClaudeStatus = {
  path: 'C:\\Users\\someone\\.local\\bin\\claude.exe',
  source: 'discovered',
  version: '2.1.999 (Claude Code)',
  semver: '2.1.999',
  tested: true,
  testedRange: { min: '2.1.0', max: '2.2.0' },
  configDir: 'C:\\Users\\someone\\.claude',
  configDirExists: true,
  auth: 'authenticated',
  authSignal: '.credentials.json is present',
  error: null
}

function renderPane(overrides: Partial<SettingsPaneProps> = {}) {
  const props: SettingsPaneProps = {
    section: 'general',
    status: DISCOVERED,
    checking: false,
    onRecheck: vi.fn(),
    onLocateClaude: vi.fn(),
    onClearClaudeOverride: vi.fn(),
    roots: ['C:\\work\\my repos'],
    projectCount: 3,
    scanning: false,
    onAddRoot: vi.fn(),
    onRemoveRoot: vi.fn(),
    pinnedProjects: [],
    onUnpinProject: vi.fn(),
    appearance: APPEARANCE,
    onAppearanceChange: vi.fn(),
    themes: LISTING,
    themeState: showing(builtin('nocturne')),
    onOpenThemesFolder: vi.fn(),
    onDuplicateTheme: vi.fn(),
    usageDisplay: 'percent',
    updateCheck: true,
    onUpdateCheckChange: vi.fn(),
    onUsageDisplayChange: vi.fn(),
    hasCostEstimate: false,
    appVersion: '1.2.0',
    releasesUrl: 'https://github.com/example/helm/releases/latest',
    update: null,
    updateChecking: false,
    onCheckForUpdate: vi.fn(),
    onOpenReleases: vi.fn(),
    terminal: {
      terminalFontFamily: null,
      terminalFontSize: DEFAULT_SETTINGS.terminalFontSize,
      terminalCursorStyle: DEFAULT_SETTINGS.terminalCursorStyle,
      terminalCursorBlink: DEFAULT_SETTINGS.terminalCursorBlink,
      terminalScrollback: DEFAULT_SETTINGS.terminalScrollback,
      terminalShell: null,
      projectShellHeightPct: DEFAULT_SETTINGS.projectShellHeightPct
    },
    onTerminalChange: vi.fn(),
    terminalFontStack: 'Cascadia Mono, monospace',
    shells: [],
    onLocateShell: vi.fn(),
    onShellPath: vi.fn(async () => null),
    archiveStats: null,
    transcriptArchiveMaxBytes: DEFAULT_SETTINGS.transcriptArchiveMaxBytes,
    onTranscriptArchiveMaxBytesChange: vi.fn(),
    templateCount: 0,
    templatesDir: 'C:\\helm data\\templates',
    onManageTemplates: vi.fn(),
    onRevealTemplates: vi.fn(),
    filesWrap: false,
    onFilesWrapChange: vi.fn(),
    browserReach: 'web',
    browserSearch: 'google',
    onBrowserSearchChange: vi.fn(),
    onBrowserReachChange: vi.fn(),
    browserMcp: true,
    onBrowserMcpChange: vi.fn(),
    browserMcpLocalOnly: false,
    onBrowserMcpLocalOnlyChange: vi.fn(),
    sessionMcp: true,
    onSessionMcpChange: vi.fn(),
    restoreWithoutAsking: false,
    onRestoreWithoutAskingChange: vi.fn(),
    quitSessions: 'end',
    onQuitSessionsChange: vi.fn(),
    onStopHost: vi.fn(),
    hostLogFile: null,
    hosts: [],
    onAddHost: vi.fn(),
    onRemoveHost: vi.fn(),
    onHostQuitChange: vi.fn(),
    hostInstall: { check: vi.fn(async () => ({ kind: 'ready' as const, found: { version: '1.2.0', protocol: '1.0' }, system: { os: 'linux' as const, cpu: 'x64', label: 'Linux · x86_64' } })), install: vi.fn(), cancel: vi.fn() },
    onHostInstalled: vi.fn(),
    onReconnectHost: vi.fn(),
    devices: { hosts: [], onDisconnect: vi.fn() },
    ...overrides
  }
  const view = render(<SettingsPane {...props} />)
  return { props, rerender: (next: Partial<SettingsPaneProps>) => view.rerender(<SettingsPane {...props} {...next} />) }
}

const group = (title: string): HTMLElement => screen.getByRole('region', { name: title })

/** The value beside a fact's caps label, as it reads on screen. */
function fact(container: HTMLElement, label: string): string {
  const term = within(container).getByText(label, { selector: 'dt' })
  return term.nextElementSibling?.textContent ?? ''
}

describe('SettingsPane', () => {
  it('draws each section on its own: its title, its groups in order, and their controls', () => {
    const { rerender } = renderPane()
    const sections: Array<[SettingsSectionId, string, string[]]> = [
      ['general', 'General', ['Claude CLI', 'Status bar']],
      ['appearance', 'Appearance', ['Appearance']],
      ['terminal', 'Terminal', ['Terminal']],
      ['sessions', 'Sessions', ['Sessions']],
      ['hosts', 'Hosts', ['Hosts']],
      ['devices', 'Devices', ['Devices']],
      ['workspace', 'Workspace', ['Workspace', 'Harness templates']],
      ['files', 'Files', ['Files']],
      ['browser', 'Browser', ['Browser']],
      ['archive', 'Archive', ['Transcript archive']],
      ['updates', 'Updates', ['Updates']]
    ]
    // Plugins and Secrets are listed with the rest but drawn by pages of their
    // own (PluginSettings, SecretsSettings), each with its tests.
    const drawnElsewhere = new Set<SettingsSectionId>(['plugins', 'secrets'])
    expect(sections.map(([id]) => id)).toEqual(
      SETTINGS_SECTIONS.map((entry) => entry.id).filter((id) => !drawnElsewhere.has(id))
    )

    const controls: Record<string, Array<[string, string]>> = {
      'Claude CLI': [
        ['button', 'Check again'],
        ['button', 'Locate manually…'],
        ['button', 'Clear override']
      ],
      Workspace: [
        ['button', 'Stop scanning C:\\work\\my repos'],
        ['button', 'Add a folder']
      ],
      'Harness templates': [
        ['button', 'C:\\helm data\\templates'],
        ['button', 'Manage templates']
      ],
      Appearance: [
        ['radiogroup', 'Theme'],
        ['checkbox', 'Follow Windows'],
        ['button', 'Duplicate Nocturne'],
        ['button', 'Open folder'],
        ['button', 'Increase space between panes'],
        ['button', 'Decrease corner radius'],
        ['radiogroup', 'Density'],
        ['radiogroup', 'Accent']
      ],
      'Status bar': [['radiogroup', 'Usage display']],
      Files: [['checkbox', 'Wrap long lines in files']],
      Browser: [
        ['combobox', 'Where the browser pane may go'],
        ['combobox', 'Search from the address bar'],
        ['checkbox', 'Let Claude drive the browser'],
        ['checkbox', 'Confine Claude’s browser tools to this machine']
      ],
      Sessions: [
        ['checkbox', 'Let Claude see the other sessions'],
        ['checkbox', 'Resume after a crash without asking'],
        ['combobox', 'When you quit Helm'],
        ['button', 'Stop host']
      ],
      Updates: [
        ['checkbox', 'Check for new releases on launch'],
        ['button', 'Check now'],
        ['button', 'Release notes']
      ],
      Terminal: [
        ['radiogroup', 'Cursor style'],
        ['checkbox', 'Blink the terminal cursor']
      ],
      'Transcript archive': [['combobox', 'How much of the database the archive may use']]
    }
    for (const [section, title, groups] of sections) {
      rerender({ section })
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(title)
      const named = (region: HTMLElement): string | null =>
        region.getAttribute('aria-label') ??
        document.getElementById(region.getAttribute('aria-labelledby') ?? '')?.textContent ??
        null
      expect(screen.getAllByRole('region').map(named)).toEqual(groups)
      // A section of one group is that group: its title is the page's, so it
      // draws no heading of its own.
      expect(screen.queryAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(
        groups.length === 1 ? [] : groups
      )
      for (const name of groups) {
        for (const [role, label] of controls[name] ?? []) {
          expect(within(group(name)).getByRole(role, { name: label }), `${name}: ${role} ${label}`).toBeTruthy()
        }
      }
    }
  })

  it('sets what the address bar searches with, and says what Off means', async () => {
    const user = userEvent.setup()
    const { props } = renderPane({ section: 'browser' })
    const search = screen.getByRole('combobox', { name: 'Search from the address bar' })
    expect([...search.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'Google',
      'DuckDuckGo',
      'Bing',
      'Off'
    ])
    expect(group('Browser').textContent).toContain('goes to Google when you press Enter')
    await user.selectOptions(search, 'off')
    expect(props.onBrowserSearchChange).toHaveBeenCalledWith('off')
  })

  it('never shows the state Helm keeps for itself, in any section', () => {
    const { rerender } = renderPane()
    for (const { id } of SETTINGS_SECTIONS) {
      rerender({ section: id })
      const text = document.body.textContent ?? ''
      for (const key of ['windowBounds', 'firstRunCompletedAt', 'paneLayout', 'browserRecentUrls', 'browserProjectUrls', 'railHidden', 'profilesCopiedToHostAt', 'pluginsCopiedToHostAt']) {
        expect(text).not.toContain(key)
      }
    }
  })

  it('opens the template manager', async () => {
    const { props } = renderPane({ section: 'workspace' })
    await userEvent.click(within(group('Harness templates')).getByRole('button', { name: 'Manage templates' }))
    expect(props.onManageTemplates).toHaveBeenCalledTimes(1)
  })

  describe('Claude CLI', () => {
    it('shows the CLI discovery found and the version it reported, with nothing to clear', async () => {
      const { props } = renderPane()
      const claude = group('Claude CLI')

      expect(within(claude).getByText('Found on this machine')).toBeTruthy()
      expect(fact(claude, 'Path')).toBe('C:\\Users\\someone\\.local\\bin\\claude.exe')
      expect(fact(claude, 'Version')).toBe('2.1.999 (Claude Code)')
      expect(within(claude).getByRole('button', { name: 'Clear override' })).toHaveProperty('disabled', true)

      await userEvent.click(within(claude).getByRole('button', { name: 'Locate manually…' }))
      expect(props.onLocateClaude).toHaveBeenCalledTimes(1)
      await userEvent.click(within(claude).getByRole('button', { name: 'Check again' }))
      expect(props.onRecheck).toHaveBeenCalledTimes(1)
    })

    it('shows a CLI the user picked, with its own version, and clears it', async () => {
      const { props } = renderPane({
        status: { ...DISCOVERED, source: 'setting', path: 'D:\\picked\\claude.cmd', version: '2.1.500 (Claude Code)' }
      })
      const claude = group('Claude CLI')

      expect(within(claude).getByText('Set by you')).toBeTruthy()
      expect(fact(claude, 'Path')).toBe('D:\\picked\\claude.cmd')
      expect(fact(claude, 'Version')).toBe('2.1.500 (Claude Code)')

      await userEvent.click(within(claude).getByRole('button', { name: 'Clear override' }))
      expect(props.onClearClaudeOverride).toHaveBeenCalledTimes(1)
    })
  })

  describe('Workspace', () => {
    it('adds a folder, and stops scanning one from its own row', async () => {
      const { props } = renderPane({ section: 'workspace', roots: ['C:\\work\\my repos', 'D:\\other'], projectCount: 3 })
      const workspace = group('Workspace')

      expect(within(workspace).getByText('2 folders · 3 projects')).toBeTruthy()
      await userEvent.click(within(workspace).getByRole('button', { name: 'Stop scanning D:\\other' }))
      expect(props.onRemoveRoot).toHaveBeenCalledWith('D:\\other')

      await userEvent.click(within(workspace).getByRole('button', { name: 'Add a folder' }))
      expect(props.onAddRoot).toHaveBeenCalledTimes(1)
    })

    it('lists every pin, a vanished folder included, and unpins from there', async () => {
      const pins = ['C:\\work\\api', 'E:\\unplugged\\tools']
      const { props } = renderPane({ section: 'workspace', pinnedProjects: pins })
      const workspace = group('Workspace')

      expect(within(workspace).queryByText('Nothing is pinned.')).toBeNull()
      for (const pin of pins) expect(within(workspace).getByText(pin)).toBeTruthy()

      await userEvent.click(within(workspace).getByRole('button', { name: 'Unpin E:\\unplugged\\tools' }))
      expect(props.onUnpinProject).toHaveBeenCalledWith('E:\\unplugged\\tools')
    })

    it('says so when nothing is pinned', () => {
      renderPane({ section: 'workspace', pinnedProjects: [] })
      expect(within(group('Workspace')).getByText('Nothing is pinned.')).toBeTruthy()
    })
  })

  describe('Appearance', () => {
    const theme = (name: RegExp): HTMLElement =>
      within(screen.getByRole('radiogroup', { name: 'Theme' })).getByRole('radio', { name })

    it('writes the picked theme into its kind’s slot and shows that kind', async () => {
      const { props } = renderPane({ section: 'appearance' })

      await userEvent.click(theme(/^Daylight/))
      expect(props.onAppearanceChange).toHaveBeenLastCalledWith({ themeLight: 'daylight', theme: 'light' })

      await userEvent.click(theme(/^Graphite/))
      expect(props.onAppearanceChange).toHaveBeenLastCalledWith({ themeDark: 'graphite', theme: 'dark' })
    })

    it('marks the theme main says is on screen, not the one the slot names', () => {
      // The dark slot names a theme file that has gone, so main resolved the
      // built-in standing in for it.
      renderPane({
        section: 'appearance',
        appearance: { ...APPEARANCE, themeDark: 'ink' },
        themeState: showing(builtin('nocturne'))
      })
      expect(theme(/^Nocturne/).getAttribute('aria-checked')).toBe('true')
      expect(theme(/^Graphite/).getAttribute('aria-checked')).toBe('false')
      expect(theme(/^Daylight/).getAttribute('aria-checked')).toBe('false')
    })

    it('follows Windows: writes system, records a card in its slot only, and tags each slot’s card', async () => {
      const { props, rerender } = renderPane({ section: 'appearance' })
      const follow = screen.getByRole('checkbox', { name: 'Follow Windows' })
      expect(follow).toHaveProperty('checked', false)
      expect(screen.queryByText('when dark')).toBeNull()

      await userEvent.click(follow)
      expect(props.onAppearanceChange).toHaveBeenLastCalledWith({ theme: 'system' })

      rerender({
        appearance: { ...props.appearance, theme: 'system' },
        themeState: showing(builtin('nocturne'), 'system')
      })
      expect(screen.getByRole('checkbox', { name: 'Follow Windows' })).toHaveProperty('checked', true)
      expect(within(theme(/^Nocturne/)).getByText('when dark')).toBeTruthy()
      expect(within(theme(/^Daylight/)).getByText('when light')).toBeTruthy()
      expect(within(theme(/^Graphite/)).queryByText(/^when /)).toBeNull()

      await userEvent.click(theme(/^Graphite/))
      expect(props.onAppearanceChange).toHaveBeenLastCalledWith({ themeDark: 'graphite' })

      // Turning it off pins the kind on screen, so the click changes nothing visible.
      await userEvent.click(screen.getByRole('checkbox', { name: 'Follow Windows' }))
      expect(props.onAppearanceChange).toHaveBeenLastCalledWith({ theme: 'dark' })
    })

    it('names a theme file that could not be read, and draws no card for it', () => {
      renderPane({
        section: 'appearance',
        themes: { ...LISTING, errors: [{ file: 'midnight.json', message: 'Unexpected end of JSON input' }] }
      })
      const appearance = group('Appearance')
      expect(within(appearance).getByText('midnight.json')).toBeTruthy()
      expect(within(appearance).getByText('Unexpected end of JSON input')).toBeTruthy()
      expect(within(appearance).queryByRole('radio', { name: /midnight/i })).toBeNull()
      expect(within(screen.getByRole('radiogroup', { name: 'Theme' })).getAllByRole('radio')).toHaveLength(3)
    })

    it('duplicates the theme on screen and opens the themes folder', async () => {
      const { props } = renderPane({ section: 'appearance', themeState: showing(builtin('graphite')) })

      await userEvent.click(screen.getByRole('button', { name: 'Duplicate Graphite' }))
      expect(props.onDuplicateTheme).toHaveBeenCalledWith('graphite')
      await userEvent.click(screen.getByRole('button', { name: 'Open folder' }))
      expect(props.onOpenThemesFolder).toHaveBeenCalledTimes(1)
    })

    it('steps the gap and the corner radius one pixel at a time, within their range', async () => {
      const { props } = renderPane({
        section: 'appearance',
        appearance: { ...APPEARANCE, paneGap: 6, cornerRadius: CORNER_RADIUS.max }
      })

      await userEvent.click(screen.getByRole('button', { name: 'Increase space between panes' }))
      expect(props.onAppearanceChange).toHaveBeenLastCalledWith({ paneGap: 7 })
      await userEvent.click(screen.getByRole('button', { name: 'Decrease space between panes' }))
      expect(props.onAppearanceChange).toHaveBeenLastCalledWith({ paneGap: 5 })

      expect(screen.getByRole('button', { name: 'Increase corner radius' })).toHaveProperty('disabled', true)
      await userEvent.click(screen.getByRole('button', { name: 'Decrease corner radius' }))
      expect(props.onAppearanceChange).toHaveBeenLastCalledWith({ cornerRadius: CORNER_RADIUS.max - 1 })
    })

    it('writes density and accent, and the theme’s own accent clears the choice', async () => {
      const { props, rerender } = renderPane({ section: 'appearance' })

      await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Density' })).getByRole('radio', { name: 'Compact' }))
      expect(props.onAppearanceChange).toHaveBeenLastCalledWith({ density: 'compact' })

      const accent = (): HTMLElement => screen.getByRole('radiogroup', { name: 'Accent' })
      await userEvent.click(within(accent()).getByRole('radio', { name: 'Teal' }))
      expect(props.onAppearanceChange).toHaveBeenLastCalledWith({ accentColor: '#4fc3b4' })

      rerender({ appearance: { ...props.appearance, accentColor: '#4fc3b4' } })
      expect(within(accent()).getByRole('radio', { name: 'Teal' }).getAttribute('aria-checked')).toBe('true')
      const own = within(accent()).getByRole('radio', { name: "Nocturne's own" })
      expect(own.getAttribute('aria-checked')).toBe('false')

      await userEvent.click(own)
      expect(props.onAppearanceChange).toHaveBeenLastCalledWith({ accentColor: null })
    })
  })

  describe('Files', () => {
    it('writes wrapping from its checkbox', async () => {
      const user = userEvent.setup()
      const { props } = renderPane({ section: 'files', filesWrap: false })
      await user.click(screen.getByRole('checkbox', { name: 'Wrap long lines in files' }))
      expect(props.onFilesWrapChange).toHaveBeenCalledWith(true)
    })
  })

  describe('Updates', () => {
    const answer = (over: Partial<UpdateCheckResult>): UpdateCheckResult => ({
      current: '1.2.0',
      latest: '1.2.0',
      newer: false,
      error: null,
      checkedAt: new Date().toISOString(),
      ...over
    })

    it('says what the last check found, in a sentence of its own for each answer', () => {
      const { rerender } = renderPane({ section: 'updates', update: null })
      const updates = group('Updates')
      expect(within(updates).getByText('Helm has not asked GitHub since it started.')).toBeTruthy()

      rerender({ update: answer({ latest: '1.3.0', newer: true }) })
      expect(within(updates).getByText('1.3.0 is available. This build is 1.2.0.')).toBeTruthy()

      rerender({ update: answer({}) })
      expect(within(updates).getByText('1.2.0 is the newest release. Asked just now.')).toBeTruthy()
      expect(within(updates).queryByText(/still opens the releases page/)).toBeNull()

      rerender({ update: answer({ latest: null, error: 'getaddrinfo ENOTFOUND api.github.com' }) })
      expect(within(updates).getByText('Could not ask GitHub - getaddrinfo ENOTFOUND api.github.com.')).toBeTruthy()
      expect(within(updates).getByText(/still opens the releases page/)).toBeTruthy()
    })

    it('shows this build’s version, and the latest only while the last answer carried one', () => {
      const { rerender } = renderPane({ section: 'updates', appVersion: '1.2.0', update: answer({ latest: '1.3.0', newer: true }) })
      const updates = group('Updates')
      expect(fact(updates, 'Version')).toBe('1.2.0')
      expect(fact(updates, 'Latest')).toBe('1.3.0')

      rerender({ update: answer({ latest: null, error: 'no answer within 6000 ms' }) })
      expect(fact(updates, 'Latest')).toBe('-')
    })

    it('asks whatever the launch setting says, and is busy only while a check is in flight', async () => {
      const { props, rerender } = renderPane({ section: 'updates', updateCheck: false })
      const updates = group('Updates')
      const checkNow = (): HTMLElement => within(updates).getByRole('button', { name: 'Check now' })

      expect(checkNow()).toHaveProperty('disabled', false)
      await userEvent.click(checkNow())
      await userEvent.click(checkNow())
      expect(props.onCheckForUpdate).toHaveBeenCalledTimes(2)
      expect(props.onUpdateCheckChange).not.toHaveBeenCalled()

      rerender({ updateChecking: true })
      expect(checkNow()).toHaveProperty('disabled', true)
      expect(within(updates).getByText('Asking GitHub…')).toBeTruthy()

      rerender({ updateChecking: false, update: answer({}) })
      expect(checkNow()).toHaveProperty('disabled', false)
    })

    it('keeps Release notes open, to the same page, whatever the last check said', async () => {
      const url = 'https://github.com/example/helm/releases/latest'
      const { props, rerender } = renderPane({ section: 'updates', releasesUrl: url, updateChecking: true })
      const notes = (): HTMLElement => within(group('Updates')).getByRole('button', { name: 'Release notes' })

      for (const state of [
        { updateChecking: true, update: null },
        { updateChecking: false, update: answer({}) },
        { updateChecking: false, update: answer({ latest: null, error: 'offline' }) }
      ]) {
        rerender(state)
        expect(notes()).toHaveProperty('disabled', false)
        expect(notes().getAttribute('title')).toBe(url)
      }
      await userEvent.click(notes())
      expect(props.onOpenReleases).toHaveBeenCalledTimes(1)
    })

    it('turns the launch check off, and on again', async () => {
      const { props, rerender } = renderPane({ section: 'updates', updateCheck: true })
      const tick = (): HTMLElement => screen.getByRole('checkbox', { name: 'Check for new releases on launch' })

      await userEvent.click(tick())
      expect(props.onUpdateCheckChange).toHaveBeenLastCalledWith(false)
      rerender({ updateCheck: false })
      await userEvent.click(tick())
      expect(props.onUpdateCheckChange).toHaveBeenLastCalledWith(true)
    })
  })

  it('turns resuming after a crash without asking on, and says what each answer does', async () => {
    const { props, rerender } = renderPane({ section: 'sessions', restoreWithoutAsking: false })
    const sessions = group('Sessions')
    const tick = within(sessions).getByRole('checkbox', { name: 'Resume after a crash without asking' })
    expect(sessions.textContent).toContain('lists the sessions it was running and asks which to reopen')

    await userEvent.click(tick)
    expect(props.onRestoreWithoutAskingChange).toHaveBeenLastCalledWith(true)
    rerender({ section: 'sessions', restoreWithoutAsking: true })
    expect(group('Sessions').textContent).toContain('reopens every session it was running, in the tab it had')
  })

  it('S1: has no Run sessions in the local host switch, and always offers what quitting does on this PC’s host, End by default, and Stop host', async () => {
    const { props, rerender } = renderPane({ section: 'sessions' })
    expect(within(group('Sessions')).queryByRole('checkbox', { name: 'Run sessions in the local host' })).toBeNull()
    expect(group('Sessions').textContent).not.toContain('Run sessions in the local host')
    expect(within(group('Sessions')).getByRole('button', { name: 'Stop host' })).toHaveProperty('disabled', false)
    const quit = within(group('Sessions')).getByRole<HTMLSelectElement>('combobox', { name: 'When you quit Helm' })
    expect(quit.value).toBe('end')
    expect([...quit.options].map((option) => option.textContent)).toEqual([
      'End the sessions it started',
      'Keep them running'
    ])
    expect(group('Sessions').textContent).toContain('For this PC’s host. Quitting ends the sessions Helm started there')

    await userEvent.selectOptions(quit, 'keep')
    expect(props.onQuitSessionsChange).toHaveBeenLastCalledWith('keep')
    rerender({ section: 'sessions', quitSessions: 'keep' })
    expect(within(group('Sessions')).getByRole<HTMLSelectElement>('combobox', { name: 'When you quit Helm' }).value).toBe(
      'keep'
    )
    expect(group('Sessions').textContent).toContain('Quitting leaves the sessions Helm started running there')
  })

  it('S11: lists each remote host with its own When you quit choice, Keep them running when never set, and changes only that host’s', async () => {
    const hosts: SettingsHost[] = [
      {
        host: { id: 'h-build', name: 'build-box', transport: { kind: 'ssh', target: 'build-box' } },
        quit: quitChoice({ quitSessions: {} }, 'h-build'),
        connection: null
      },
      {
        host: { id: 'h-lab', name: 'lab', transport: { kind: 'command', program: 'wsl.exe', args: ['-d', 'Ubuntu Dev'] } },
        quit: quitChoice({ quitSessions: { 'h-lab': 'end' } }, 'h-lab'),
        connection: null
      }
    ]
    const { props, rerender } = renderPane({ section: 'hosts', hosts })
    const build = screen.getByRole('group', { name: 'build-box' })
    const lab = screen.getByRole('group', { name: 'lab' })
    // How each is reached, in mono.
    expect(within(build).getByText('ssh build-box').className).toContain('font-mono')
    expect(within(lab).getByText('wsl.exe -d "Ubuntu Dev"').className).toContain('font-mono')

    const buildQuit = within(build).getByRole<HTMLSelectElement>('combobox', { name: 'When you quit, on build-box' })
    const labQuit = within(lab).getByRole<HTMLSelectElement>('combobox', { name: 'When you quit, on lab' })
    expect([...buildQuit.options].map((option) => option.textContent)).toEqual([
      'End my sessions there',
      'Keep them running'
    ])
    // Never set: Keep them running. This PC's own still defaults to End.
    expect(buildQuit.value).toBe('keep')
    expect(labQuit.value).toBe('end')
    expect(quitChoice({ quitSessions: {} })).toBe('end')

    await userEvent.selectOptions(buildQuit, 'end')
    expect(props.onHostQuitChange).toHaveBeenCalledTimes(1)
    expect(props.onHostQuitChange).toHaveBeenLastCalledWith('h-build', 'end')
    expect(props.onQuitSessionsChange).not.toHaveBeenCalled()

    await userEvent.click(within(lab).getByRole('button', { name: 'Remove' }))
    expect(props.onRemoveHost).toHaveBeenCalledWith('h-lab')
    rerender({ section: 'hosts', hosts: [] })
    expect(screen.queryByRole('group', { name: 'lab' })).toBeNull()
  })

  it('S1: each row shows its name, how it is reached, floti’s version and the OS there, its state, quit choice and Remove; Add a host… opens the dialog', async () => {
    const { props } = renderPane({
      section: 'hosts',
      hosts: [
        {
          host: {
            id: 'h-build',
            name: 'build-box',
            transport: { kind: 'ssh', target: 'build-box' },
            system: { os: 'Linux', cpu: 'x86_64' }
          },
          quit: 'keep',
          connection: { state: 'connected', version: '3.0.0' }
        }
      ]
    })
    const row = screen.getByRole('group', { name: 'build-box' })
    expect(row.querySelector('[data-settings-host-reached]')?.textContent).toBe('ssh build-box · floti 3.0.0 · Linux x86_64')
    expect(row.textContent).toContain('Connected')
    expect(within(row).getByRole<HTMLSelectElement>('combobox', { name: 'When you quit, on build-box' }).value).toBe('keep')
    expect(within(row).getByRole('button', { name: 'Remove' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Add a host…' }))
    expect(props.onAddHost).toHaveBeenCalledTimes(1)
    // The dialog is the only way in: the page has no form of its own.
    expect(screen.queryByRole('form', { name: 'Add a host' })).toBeNull()
  })

  it('S1: with no host the page says so and offers Add a host…', async () => {
    const { props } = renderPane({ section: 'hosts', hosts: [] })
    const empty = document.querySelector('[data-settings-hosts-empty]') as HTMLElement
    expect(empty.textContent).toContain('No other hosts yet.')
    await userEvent.click(within(empty).getByRole('button', { name: 'Add a host…' }))
    expect(props.onAddHost).toHaveBeenCalledTimes(1)
  })

  it('fills each host’s connection slot: connected, retrying, a changed key, and the last line ssh wrote with its fix', () => {
    const host = (id: string, connection: SettingsHost['connection']): SettingsHost => ({
      host: { id, name: id, transport: { kind: 'ssh', target: `you@${id}` } },
      quit: 'keep',
      connection
    })
    renderPane({
      section: 'hosts',
      hosts: [
        host('up', { state: 'connected' }),
        host('down', { state: 'retrying' }),
        host('moved', { state: 'keyChanged' }),
        host('locked', {
          state: 'failed',
          lastLine: 'you@locked: Permission denied (publickey,password).'
        })
      ]
    })
    expect(screen.getByRole('group', { name: 'up' }).textContent).toContain('Connected')
    expect(screen.getByRole('group', { name: 'down' }).textContent).toContain('Not connected, retrying')
    expect(screen.getByRole('group', { name: 'moved' }).textContent).toContain('Key changed')
    const locked = screen.getByRole('group', { name: 'locked' })
    expect(within(locked).getByText('you@locked: Permission denied (publickey,password).')).toBeTruthy()
    // Said the way the add-a-host dialog says it: the chip, the title and the fix.
    expect(locked.textContent).toContain('Needs a key')
    expect(locked.querySelector('[data-settings-host-failed]')?.getAttribute('data-settings-host-failed')).toBe('password')
    expect(locked.querySelector('[data-settings-host-fix]')?.textContent).toContain('ssh you@locked gets in without asking')
    expect(locked.textContent).toContain('Try it by hand in a terminal: ssh you@locked floti connect')
  })

  it('S5: a host whose ssh fails shows on its row the last line unedited, the line to try by hand, and Reconnect now; nothing asks for a password', async () => {
    const lines = [
      'you@build-box: Permission denied (publickey,password).',
      'ssh: Could not resolve hostname build-box: Name or service not known',
      'ssh: connect to host build-box port 22: Connection timed out'
    ]
    for (const lastLine of lines) {
      const { props, rerender } = renderPane({
        section: 'hosts',
        hosts: [
          {
            host: { id: 'h-build', name: 'build-box', transport: { kind: 'ssh', target: 'you@build-box' } },
            quit: 'keep',
            connection: { state: 'failed', lastLine }
          }
        ]
      })
      const row = screen.getByRole('group', { name: 'build-box' })
      expect(row.querySelector('[data-settings-host-last-line]')?.textContent).toBe(lastLine)
      expect(row.querySelector('[data-settings-host-try]')?.textContent).toBe('ssh you@build-box floti connect')
      // No field to type a password or code into.
      expect(row.querySelector('input')).toBeNull()
      await userEvent.click(within(row).getByRole('button', { name: 'Reconnect now' }))
      expect(props.onReconnectHost).toHaveBeenCalledWith('h-build')
      rerender({ section: 'hosts', hosts: [] })
    }
  })

  it('S5: a command host with no floti there shows what its shell said and the command followed by floti connect', () => {
    renderPane({
      section: 'hosts',
      hosts: [
        {
          host: { id: 'h-lab', name: 'lab', transport: { kind: 'command', program: 'wsl.exe', args: ['-d', 'Ubuntu', '--'] } },
          quit: 'keep',
          connection: { state: 'missing', lastLine: 'bash: line 1: floti: command not found' }
        },
        {
          host: { id: 'h-up', name: 'up', transport: { kind: 'ssh', target: 'up' } },
          quit: 'keep',
          connection: { state: 'connected' }
        }
      ]
    })
    const lab = screen.getByRole('group', { name: 'lab' })
    expect(lab.querySelector('[data-settings-host-last-line]')?.textContent).toBe('bash: line 1: floti: command not found')
    expect(lab.querySelector('[data-settings-host-try]')?.textContent).toBe('wsl.exe -d Ubuntu -- floti connect')
    // A connected host has nothing to reconnect.
    expect(within(screen.getByRole('group', { name: 'up' })).queryByRole('button', { name: 'Reconnect now' })).toBeNull()
  })

  it('S4: a WSL host’s row says it is reached through wsl.exe, here or through its Windows host, with floti’s version and the OS, keeping its sessions by default', () => {
    renderPane({
      section: 'hosts',
      hosts: [
        {
          host: {
            id: 'h-debian',
            name: 'Debian',
            transport: { kind: 'wsl', distro: 'Debian' },
            system: { os: 'Linux', cpu: 'x86_64' }
          },
          quit: 'keep',
          connection: { state: 'connected', version: '3.0.0' }
        },
        {
          host: {
            id: 'h-ubuntu',
            name: 'Ubuntu on win-box',
            transport: { kind: 'wsl', distro: 'Ubuntu', through: 'win-box' }
          },
          quit: 'keep',
          connection: { state: 'connected', version: '3.0.0' }
        }
      ]
    })
    const debian = screen.getByRole('group', { name: 'Debian' })
    expect(debian.querySelector('[data-settings-host-reached]')?.textContent).toBe(
      'wsl.exe -d Debian · floti 3.0.0 · Linux x86_64'
    )
    expect(
      within(debian).getByRole<HTMLSelectElement>('combobox', {
        name: 'When you quit, on Debian'
      }).value
    ).toBe('keep')
    const ubuntu = screen.getByRole('group', { name: 'Ubuntu on win-box' })
    expect(ubuntu.querySelector('[data-settings-host-reached]')?.textContent).toBe(
      'ssh win-box wsl.exe -d Ubuntu · floti 3.0.0'
    )
  })

  it('S5: each host shows its name, target, connection state and quit choice, with no role, role picker, pairing code or approve step', () => {
    const transport = { kind: 'ssh' as const, target: 'you@lab' }
    renderPane({
      section: 'hosts',
      hosts: [
        {
          host: { id: 'up', name: 'lab', transport },
          quit: 'end',
          connection: { state: 'connected' }
        }
      ]
    })
    const up = screen.getByRole('group', { name: 'lab' })
    expect(up.textContent).toContain('lab')
    expect(up.querySelector('[data-settings-host-reached]')?.textContent).toBe('ssh you@lab')
    expect(up.textContent).toContain('Connected')
    expect(up.querySelector('[data-settings-host-quit]')?.getAttribute('data-settings-host-quit')).toBe('end')
    expect(up.textContent).not.toMatch(/admin|operator|viewer|role|approve|pairing|code/i)
  })

  it('S7: says a host’s key changed, naming the host, until it is removed and added again', () => {
    const transport = { kind: 'ssh' as const, target: 'build-box' }
    renderPane({
      section: 'hosts',
      hosts: [
        {
          host: { id: 'b', name: 'build-box', transport },
          quit: 'keep',
          connection: { state: 'keyChanged' }
        }
      ]
    })
    const box = screen.getByRole('group', { name: 'build-box' })
    expect(box.getAttribute('data-settings-host-connection')).toBe('keyChanged')
    expect(box.textContent).toContain('Key changed')
    const said = box.querySelector('[data-settings-host-key-changed]')?.textContent ?? ''
    expect(said).toContain('build-box’s key changed')
    expect(said).toContain('remove build-box and add it again')
    expect(within(box).getByRole('button', { name: 'Remove' })).toBeTruthy()
  })

  it('S8: Remove asks to forget the host on this PC and says its sessions keep running there', async () => {
    const transport = { kind: 'ssh' as const, target: 'build-box' }
    const { props } = renderPane({
      section: 'hosts',
      hosts: [
        {
          host: { id: 'b', name: 'build-box', transport },
          quit: 'keep',
          connection: { state: 'connected' }
        }
      ]
    })
    expect(group('Hosts').textContent).toContain('Its sessions keep running there')
    await userEvent.click(
      within(screen.getByRole('group', { name: 'build-box' })).getByRole('button', { name: 'Remove' })
    )
    expect(props.onRemoveHost).toHaveBeenCalledWith('b')
  })

  it('stops this PC’s host from Settings through the question', async () => {
    const { props } = renderPane({ section: 'sessions' })
    await userEvent.click(within(group('Sessions')).getByRole('button', { name: 'Stop host' }))
    expect(props.onStopHost).toHaveBeenCalledTimes(1)
  })

  it('names this PC’s host’s log file by its full path, and nothing while the host names none', () => {
    const path = 'C:\\Users\\me\\AppData\\Local\\Floti\\logs\\host.log'
    const { rerender } = renderPane({ section: 'sessions', hostLogFile: path })
    const row = within(group('Sessions')).getByText(path)
    expect(row.className).toContain('font-mono')
    expect(row.getAttribute('title')).toBe(path)
    expect(group('Sessions').textContent).toContain('Log file')

    rerender({ section: 'sessions', hostLogFile: null })
    expect(group('Sessions').textContent).not.toContain('Log file')
  })
})

describe('updateOutcome', () => {
  const at = new Date().toISOString()

  it('is ok when current, and never a warning for a newer release or an unreachable GitHub', () => {
    expect(updateOutcome({ current: '1.2.0', latest: '1.2.0', newer: false, error: null, checkedAt: at }, false).tone).toBe('ok')
    expect(updateOutcome({ current: '1.2.0', latest: '1.3.0', newer: true, error: null, checkedAt: at }, false).tone).toBe('todo')
    expect(updateOutcome({ current: '1.2.0', latest: null, newer: false, error: 'offline', checkedAt: at }, false).tone).toBe('todo')
    expect(updateOutcome(null, true).tone).toBe('todo')
  })
})

