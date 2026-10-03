import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ArchiveStats } from '@helm/core'
import { DEFAULT_SETTINGS } from '@helm/core/types'
import { SettingsPane, type SettingsPaneProps } from './SettingsPane'

/**
 * The settings pane's transcript archive group: the figures it states and the
 * one knob it has. The other groups are tested in their own files.
 */

const MB = 1024 * 1024
const GB = 1024 * MB

function stats(overrides: Partial<ArchiveStats> = {}): ArchiveStats {
  return {
    sessions: 3,
    evictedSessions: 2,
    messages: 41,
    rawBytes: 9 * MB,
    storedBytes: 3 * MB,
    maxBytes: 256 * MB,
    oldestAt: null,
    newestAt: null,
    ...overrides
  }
}

function renderPane(overrides: Partial<SettingsPaneProps> = {}) {
  const s = DEFAULT_SETTINGS
  const props: SettingsPaneProps = {
    status: null,
    checking: false,
    onRecheck: vi.fn(),
    onLocateClaude: vi.fn(),
    onClearClaudeOverride: vi.fn(),
    roots: [],
    projectCount: 0,
    scanning: false,
    onAddRoot: vi.fn(),
    onRemoveRoot: vi.fn(),
    pinnedProjects: [],
    onUnpinProject: vi.fn(),
    appearance: {
      theme: s.theme,
      themeDark: s.themeDark,
      themeLight: s.themeLight,
      paneGap: s.paneGap,
      cornerRadius: s.cornerRadius,
      density: s.density,
      accentColor: s.accentColor
    },
    onAppearanceChange: vi.fn(),
    themes: null,
    themeState: null,
    onOpenThemesFolder: vi.fn(),
    onDuplicateTheme: vi.fn(),
    usageDisplay: s.usageDisplay,
    updateCheck: false,
    onUpdateCheckChange: vi.fn(),
    onUsageDisplayChange: vi.fn(),
    appVersion: null,
    releasesUrl: null,
    update: null,
    updateChecking: false,
    onCheckForUpdate: vi.fn(),
    onOpenReleases: vi.fn(),
    hasCostEstimate: false,
    terminal: {
      terminalFontFamily: s.terminalFontFamily,
      terminalFontSize: s.terminalFontSize,
      terminalCursorStyle: s.terminalCursorStyle,
      terminalCursorBlink: s.terminalCursorBlink,
      terminalScrollback: s.terminalScrollback,
      terminalShell: s.terminalShell,
      projectShellHeightPct: s.projectShellHeightPct,
      paneSplitPct: s.paneSplitPct
    },
    onTerminalChange: vi.fn(),
    terminalFontStack: 'monospace',
    shells: [],
    onLocateShell: vi.fn(),
    archiveStats: stats(),
    transcriptArchiveMaxBytes: 256 * MB,
    onTranscriptArchiveMaxBytesChange: vi.fn(),
    templateCount: 0,
    templatesDir: 'C:\\templates',
    onManageTemplates: vi.fn(),
    onRevealTemplates: vi.fn(),
    contentWrap: s.contentWrap,
    onContentWrapChange: vi.fn(),
    contentWrapIndent: s.contentWrapIndent,
    onContentWrapIndentChange: vi.fn(),
    browserReach: s.browserReach,
    onBrowserReachChange: vi.fn(),
    browserMcp: s.browserMcp,
    onBrowserMcpChange: vi.fn(),
    browserMcpLocalOnly: s.browserMcpLocalOnly,
    onBrowserMcpLocalOnlyChange: vi.fn(),
    sessionMcp: s.sessionMcp,
    onSessionMcpChange: vi.fn(),
    restoreWithoutAsking: false,
    onRestoreWithoutAskingChange: vi.fn(),
    gh: null,
    onLocateGh: vi.fn(),
    onClearGhOverride: vi.fn(),
    prPollMinutes: s.prPollMinutes,
    onPrPollMinutesChange: vi.fn(),
    prStaleDays: s.prStaleDays,
    onPrStaleDaysChange: vi.fn(),
    prRepos: [],
    onPrIgnoredReposChange: vi.fn(),
    prReviewPrompt: s.prReviewPrompt,
    onPrReviewPromptChange: vi.fn(),
    prCheckout: s.prCheckout,
    onPrCheckoutChange: vi.fn(),
    prReviewModel: null,
    onPrReviewModelChange: vi.fn(),
    prReviewEffort: null,
    onPrReviewEffortChange: vi.fn(),
    ...overrides
  }
  render(<SettingsPane {...props} />)
  return props
}

function archiveGroup(): HTMLElement {
  const group = screen.getByRole('heading', { name: 'Transcript archive' }).closest('section')
  if (group === null) throw new Error('no archive group')
  return group
}

/** The value a caps label in the group states. */
function fact(label: string): string | null {
  return within(archiveGroup()).getByText(label).nextElementSibling?.textContent ?? null
}

const ceiling = (): HTMLSelectElement =>
  within(archiveGroup()).getByRole('combobox', { name: 'How much of the database the archive may use' })

describe('SettingsPane - transcript archive', () => {
  it('states the sessions, messages, stored bytes, dropped count and ceiling it was given', () => {
    renderPane()

    expect(within(archiveGroup()).getByText('3 conversations kept')).toBeTruthy()
    expect(fact('Kept')).toBe('3 sessions · 41 messages')
    expect(fact('Stored')).toBe('3.0 MB of 256.0 MB (1.2%)')
    expect(fact('Dropped')).toBe('2 sessions')
    expect(ceiling().value).toBe(String(256 * MB))
    expect(ceiling().selectedOptions[0]?.textContent).toBe('256 MB')
  })

  it('counts one of anything in the singular, and thousands with separators', () => {
    renderPane({ archiveStats: stats({ sessions: 1, messages: 1, evictedSessions: 1 }) })
    expect(within(archiveGroup()).getByText('1 conversation kept')).toBeTruthy()
    expect(fact('Kept')).toBe('1 session · 1 message')
    expect(fact('Dropped')).toBe('1 session')
    cleanup()

    renderPane({ archiveStats: stats({ sessions: 1200, messages: 45_000 }) })
    const n = new Intl.NumberFormat()
    expect(fact('Kept')).toBe(`${n.format(1200)} sessions · ${n.format(45_000)} messages`)
  })

  it('gives a small archive two significant figures rather than calling it nothing', () => {
    renderPane({ archiveStats: stats({ storedBytes: 1_540_000, maxBytes: GB }), transcriptArchiveMaxBytes: GB })
    expect(fact('Stored')).toBe('1.5 MB of 1 GB (0.14%)')
  })

  it('says so while the archive has not been read yet', () => {
    renderPane({ archiveStats: null })
    expect(within(archiveGroup()).getByText('Reading…')).toBeTruthy()
  })

  it('says plainly that an empty archive holds nothing', () => {
    renderPane({ archiveStats: stats({ sessions: 0, evictedSessions: 0, messages: 0, storedBytes: 0 }) })
    expect(within(archiveGroup()).getByText('Nothing archived yet')).toBeTruthy()
    expect(fact('Stored')).toBe('0 B of 256.0 MB (0%)')
  })

  it('writes the ceiling the user picks', async () => {
    const props = renderPane()
    await userEvent.selectOptions(ceiling(), '1 GB')
    expect(props.onTranscriptArchiveMaxBytesChange).toHaveBeenCalledWith(GB)
  })

  it('shows a ceiling outside the offered sizes as it is, rather than the nearest one', () => {
    renderPane({ transcriptArchiveMaxBytes: 5000, archiveStats: stats({ maxBytes: 5000 }) })
    expect(ceiling().value).toBe('5000')
    expect(ceiling().selectedOptions[0]?.textContent).toBe('4.9 KB')
    expect([...ceiling().options].map((option) => option.textContent)).toEqual([
      '4.9 KB',
      '256 MB',
      '512 MB',
      '1 GB',
      '2 GB',
      '4 GB',
      '8 GB'
    ])
  })
})
