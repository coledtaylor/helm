import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  BUILTIN_THEMES,
  CORNER_RADIUS,
  DEFAULT_SETTINGS,
  PANE_GAP,
  type ThemeDefinition,
  type ThemeListing,
  type ThemeState
} from '@helm/core/types'
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
      projectShellHeightPct: DEFAULT_SETTINGS.projectShellHeightPct,
      paneSplitPct: DEFAULT_SETTINGS.paneSplitPct
    },
    onTerminalChange: vi.fn(),
    terminalFontStack: 'Cascadia Mono, monospace',
    shells: [],
    onLocateShell: vi.fn(),
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
    onBrowserReachChange: vi.fn(),
    browserMcp: true,
    onBrowserMcpChange: vi.fn(),
    browserMcpLocalOnly: false,
    onBrowserMcpLocalOnlyChange: vi.fn(),
    sessionMcp: true,
    onSessionMcpChange: vi.fn(),
    restoreWithoutAsking: false,
    onRestoreWithoutAskingChange: vi.fn(),
    gh: null,
    onLocateGh: vi.fn(),
    onClearGhOverride: vi.fn(),
    prPollMinutes: 15,
    onPrPollMinutesChange: vi.fn(),
    prStaleDays: 3,
    onPrStaleDaysChange: vi.fn(),
    prRepos: [],
    onPrIgnoredReposChange: vi.fn(),
    prReviewPrompt: DEFAULT_SETTINGS.prReviewPrompt,
    onPrReviewPromptChange: vi.fn(),
    prCheckout: DEFAULT_SETTINGS.prCheckout,
    onPrCheckoutChange: vi.fn(),
    prReviewModel: null,
    onPrReviewModelChange: vi.fn(),
    prReviewEffort: null,
    onPrReviewEffortChange: vi.fn(),
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
      ['workspace', 'Workspace', ['Workspace', 'Harness templates']],
      ['files', 'Files', ['Files']],
      ['browser', 'Browser', ['Browser']],
      ['github', 'GitHub', ['GitHub']],
      ['archive', 'Archive', ['Transcript archive']],
      ['updates', 'Updates', ['Updates']]
    ]
    expect(sections.map(([id]) => id)).toEqual(SETTINGS_SECTIONS.map((entry) => entry.id))

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
        ['checkbox', 'Let Claude drive the browser'],
        ['checkbox', 'Confine Claude’s browser tools to this machine']
      ],
      Sessions: [
        ['checkbox', 'Let Claude see the other sessions'],
        ['checkbox', 'Resume after a crash without asking']
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
      'Transcript archive': [['combobox', 'How much of the database the archive may use']],
      GitHub: [
        ['combobox', 'How often to check for pull requests'],
        ['combobox', 'When the Pulls pane calls a pull request stale']
      ]
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

  it('never shows the state Helm keeps for itself, in any section', () => {
    const { rerender } = renderPane()
    for (const { id } of SETTINGS_SECTIONS) {
      rerender({ section: id })
      const text = document.body.textContent ?? ''
      for (const key of ['windowBounds', 'firstRunCompletedAt', 'paneLayout', 'browserRecentUrls', 'browserProjectUrls', 'railHidden']) {
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

