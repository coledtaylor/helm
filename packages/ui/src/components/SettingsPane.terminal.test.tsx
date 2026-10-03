import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  type DetectedShell,
  type UsageDisplayMode,
  type UsageSnapshot
} from '@helm/core/types'
import { SettingsPane, type SettingsPaneProps, type TerminalSettings } from './SettingsPane'
import { StatusBar } from './StatusBar'

/**
 * The Settings pane's Terminal group and its usage-display control, rendered
 * from props. Other groups have files of their own.
 */

const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const SHELLS: DetectedShell[] = [
  { path: PWSH, name: 'pwsh.exe', label: 'PowerShell 7', args: ['-NoLogo'] },
  { path: BASH, name: 'bash.exe', label: 'Bash', args: [] }
]

const TERMINAL: TerminalSettings = {
  terminalFontFamily: DEFAULT_SETTINGS.terminalFontFamily,
  terminalFontSize: DEFAULT_SETTINGS.terminalFontSize,
  terminalCursorStyle: DEFAULT_SETTINGS.terminalCursorStyle,
  terminalCursorBlink: DEFAULT_SETTINGS.terminalCursorBlink,
  terminalScrollback: DEFAULT_SETTINGS.terminalScrollback,
  terminalShell: DEFAULT_SETTINGS.terminalShell,
  projectShellHeightPct: DEFAULT_SETTINGS.projectShellHeightPct,
  paneSplitPct: DEFAULT_SETTINGS.paneSplitPct
}

function paneProps(overrides: Partial<SettingsPaneProps> = {}): SettingsPaneProps {
  return {
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
      theme: DEFAULT_SETTINGS.theme,
      themeDark: DEFAULT_SETTINGS.themeDark,
      themeLight: DEFAULT_SETTINGS.themeLight,
      paneGap: DEFAULT_SETTINGS.paneGap,
      cornerRadius: DEFAULT_SETTINGS.cornerRadius,
      density: DEFAULT_SETTINGS.density,
      accentColor: DEFAULT_SETTINGS.accentColor
    },
    onAppearanceChange: vi.fn(),
    themes: null,
    themeState: null,
    onOpenThemesFolder: vi.fn(),
    onDuplicateTheme: vi.fn(),
    usageDisplay: 'percent',
    updateCheck: false,
    onUpdateCheckChange: vi.fn(),
    onUsageDisplayChange: vi.fn(),
    appVersion: '1.2.0',
    releasesUrl: null,
    update: null,
    updateChecking: false,
    onCheckForUpdate: vi.fn(),
    onOpenReleases: vi.fn(),
    hasCostEstimate: false,
    terminal: TERMINAL,
    onTerminalChange: vi.fn(),
    terminalFontStack: '"Cascadia Mono", "Consolas", monospace',
    shells: SHELLS,
    onLocateShell: vi.fn(),
    archiveStats: null,
    transcriptArchiveMaxBytes: DEFAULT_SETTINGS.transcriptArchiveMaxBytes,
    onTranscriptArchiveMaxBytesChange: vi.fn(),
    templateCount: 0,
    templatesDir: 'C:\\Users\\someone\\.config\\helm\\templates',
    onManageTemplates: vi.fn(),
    onRevealTemplates: vi.fn(),
    contentWrap: DEFAULT_SETTINGS.contentWrap,
    onContentWrapChange: vi.fn(),
    contentWrapIndent: DEFAULT_SETTINGS.contentWrapIndent,
    onContentWrapIndentChange: vi.fn(),
    browserReach: DEFAULT_SETTINGS.browserReach,
    onBrowserReachChange: vi.fn(),
    browserMcp: DEFAULT_SETTINGS.browserMcp,
    onBrowserMcpChange: vi.fn(),
    browserMcpLocalOnly: DEFAULT_SETTINGS.browserMcpLocalOnly,
    onBrowserMcpLocalOnlyChange: vi.fn(),
    sessionMcp: true,
    onSessionMcpChange: vi.fn(),
    restoreWithoutAsking: false,
    onRestoreWithoutAskingChange: vi.fn(),
    gh: null,
    onLocateGh: vi.fn(),
    onClearGhOverride: vi.fn(),
    prPollMinutes: DEFAULT_SETTINGS.prPollMinutes,
    onPrPollMinutesChange: vi.fn(),
    prStaleDays: DEFAULT_SETTINGS.prStaleDays,
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
}

function renderPane(overrides: Partial<SettingsPaneProps> = {}): SettingsPaneProps {
  const props = paneProps(overrides)
  render(<SettingsPane {...props} />)
  return props
}

/** A group is a card titled by its heading. */
function group(title: string): HTMLElement {
  const card = screen.getByRole('heading', { name: title }).closest('section')
  if (card === null) throw new Error(`no ${title} group`)
  return card
}

/**
 * A machine with "Fira Code" installed and nothing else past the fallbacks: a
 * family that resolves changes the width a probe string measures at, and one
 * that does not leaves the fallback's width alone.
 */
const INSTALLED: Record<string, number> = { 'Fira Code': 640 }
const FALLBACK: Record<string, number> = { monospace: 600, serif: 520, 'sans-serif': 540 }

function fakeCanvas(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
    const context = {
      font: '',
      measureText(): TextMetrics {
        const family = /"([^"]+)"/.exec(context.font)?.[1]
        const fallback = context.font.split(',').at(-1)?.trim().split(' ').at(-1) ?? ''
        const width = (family !== undefined ? INSTALLED[family] : undefined) ?? FALLBACK[fallback] ?? 0
        return { width } as TextMetrics
      }
    }
    return context as unknown as CanvasRenderingContext2D
  } as unknown as HTMLCanvasElement['getContext'])
}

beforeEach(() => {
  fakeCanvas()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the Terminal group', () => {
  it('commits a font family on Enter, a blank one as null, and drops an edit on Escape', async () => {
    const user = userEvent.setup()
    const props = renderPane()
    const field = within(group('Terminal')).getByRole('textbox', { name: 'Terminal font family' })

    await user.type(field, '  Fira Code {Enter}')
    expect(props.onTerminalChange).toHaveBeenLastCalledWith({ terminalFontFamily: 'Fira Code' })
    expect(props.onTerminalChange).toHaveBeenCalledTimes(1)

    await user.type(field, 'Iosevka{Escape}')
    expect(field).toHaveProperty('value', '')
    expect(props.onTerminalChange).toHaveBeenCalledTimes(1)
  })

  it('clears a chosen family back to the built-in stack, and has nothing to clear without one', async () => {
    const user = userEvent.setup()
    const props = paneProps({ terminal: { ...TERMINAL, terminalFontFamily: 'Fira Code' } })
    const view = render(<SettingsPane {...props} />)
    const terminal = within(group('Terminal'))
    expect(terminal.getByRole('textbox', { name: 'Terminal font family' })).toHaveProperty('value', 'Fira Code')

    await user.click(terminal.getByRole('button', { name: 'Clear' }))
    expect(props.onTerminalChange).toHaveBeenCalledWith({ terminalFontFamily: null })

    view.rerender(<SettingsPane {...props} terminal={TERMINAL} />)
    expect(within(group('Terminal')).getByRole('button', { name: 'Clear' })).toHaveProperty('disabled', true)
    expect(within(group('Terminal')).getByRole('textbox', { name: 'Terminal font family' })).toHaveProperty(
      'value',
      ''
    )
  })

  it('names a family this machine does not have, and says nothing of one it does', () => {
    const { rerender } = render(
      <SettingsPane {...paneProps({ terminal: { ...TERMINAL, terminalFontFamily: 'Nonesuch Mono' } })} />
    )
    expect(
      within(group('Terminal')).getByText(/^Nonesuch Mono is not installed on this machine/)
    ).toBeDefined()

    rerender(<SettingsPane {...paneProps({ terminal: { ...TERMINAL, terminalFontFamily: 'Fira Code' } })} />)
    expect(within(group('Terminal')).queryByText(/is not installed/)).toBeNull()
  })

  it('writes size, cursor, blink and scrollback from their controls', async () => {
    const user = userEvent.setup()
    const props = renderPane()
    const terminal = within(group('Terminal'))

    await user.click(terminal.getByRole('button', { name: 'Increase terminal font size' }))
    await user.click(terminal.getByRole('radio', { name: 'Bar' }))
    await user.click(terminal.getByRole('checkbox', { name: 'Blink the terminal cursor' }))
    const scrollback = terminal.getByRole('textbox', { name: 'Scrollback lines' })
    await user.clear(scrollback)
    await user.type(scrollback, '100{Enter}')

    expect(vi.mocked(props.onTerminalChange).mock.calls).toEqual([
      [{ terminalFontSize: 15 }],
      [{ terminalCursorStyle: 'bar' }],
      [{ terminalCursorBlink: false }],
      // Below the floor, so it lands on the floor.
      [{ terminalScrollback: 500 }]
    ])
  })

  it('picks the default shell for project panes, or leaves it to detection', async () => {
    const user = userEvent.setup()
    const props = renderPane()
    const picker = within(group('Terminal')).getByRole('combobox', { name: 'Default shell' })
    expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Detect automatically',
      'pwsh.exe - PowerShell 7',
      'bash.exe - Bash'
    ])

    await user.selectOptions(picker, 'bash.exe - Bash')
    await user.selectOptions(picker, 'Detect automatically')

    expect(vi.mocked(props.onTerminalChange).mock.calls).toEqual([
      [{ terminalShell: BASH }],
      [{ terminalShell: null }]
    ])
  })

  it('keeps a shell chosen by hand in the picker, selected', () => {
    const chosen = 'D:\\Tools\\nu.exe'
    renderPane({ terminal: { ...TERMINAL, terminalShell: chosen } })

    const picker = within(group('Terminal')).getByRole('combobox', { name: 'Default shell' })
    expect(within(picker).getByRole('option', { name: 'nu.exe - Chosen by you' })).toHaveProperty('selected', true)
  })
})

describe('the usage display control', () => {
  it('sets each offered mode, and marks the one in force', async () => {
    const user = userEvent.setup()
    const props = renderPane({ usageDisplay: 'cost', hasCostEstimate: true })
    const control = screen.getByRole('radiogroup', { name: 'Usage display' })

    expect(within(control).getByRole('radio', { name: 'Cost' }).getAttribute('aria-checked')).toBe('true')
    expect(within(control).getByRole('radio', { name: 'Percent' }).getAttribute('aria-checked')).toBe('false')

    await user.click(within(control).getByRole('radio', { name: 'Off' }))
    await user.click(within(control).getByRole('radio', { name: 'Percent' }))
    expect(vi.mocked(props.onUsageDisplayChange).mock.calls).toEqual([['off'], ['percent']])
  })

  it('offers cost only once the index has an estimate, and says why not before', () => {
    renderPane({ hasCostEstimate: false })
    const cost = within(screen.getByRole('radiogroup', { name: 'Usage display' })).getByRole('radio', {
      name: 'Cost'
    })

    expect(cost).toHaveProperty('disabled', true)
    expect(cost.title).toMatch(/index has caught up/)
  })

  it('follows the status bar segment, and the segment follows it, through the one setting', async () => {
    const user = userEvent.setup()
    const now = Date.now()
    const usage: UsageSnapshot = {
      file: 'C:\\Users\\someone\\.claude.json',
      fetchedAtMs: now - 60_000,
      limits: [
        {
          kind: 'session',
          group: 'session',
          percent: 23,
          severity: 'normal',
          resetsAtMs: now + 3_600_000,
          scope: null,
          isActive: true
        }
      ],
      problem: null,
      spend: {
        session: { tokens: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 }, dollars: 2.5, messages: 1 },
        today: { tokens: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 }, dollars: 2.5, messages: 1 },
        week: { tokens: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 }, dollars: 2.5, messages: 1 },
        pricedAt: '2026-08-10',
        unpricedModels: [],
        indexMs: 3
      }
    }
    const writes: UsageDisplayMode[] = []

    // The app's wiring in miniature: both surfaces render `usageDisplay` from
    // the settings and write it back through one writer.
    function Window(): JSX.Element {
      const [usageDisplay, setUsageDisplay] = useState<UsageDisplayMode>('percent')
      const write = (mode: UsageDisplayMode): void => {
        writes.push(mode)
        setUsageDisplay(mode)
      }
      return (
        <>
          <SettingsPane {...paneProps({ usageDisplay, onUsageDisplayChange: write, hasCostEstimate: true })} />
          <StatusBar
            sessions={{ working: 0, waiting: 0, idle: 0 }}
            onShowWaiting={vi.fn()}
            mode={null}
            version="1.2.0"
            claudeMissing={false}
            usage={usage}
            usageDisplay={usageDisplay}
            onUsageDisplayChange={write}
            update={null}
            onOpenUpdate={vi.fn()}
          />
        </>
      )
    }
    render(<Window />)
    const radio = (name: string): HTMLElement =>
      within(screen.getByRole('radiogroup', { name: 'Usage display' })).getByRole('radio', { name })
    const segment = (): HTMLElement => within(screen.getByRole('contentinfo')).getByRole('button')

    expect(segment().textContent).toContain('Session 23%')
    await user.click(radio('Cost'))
    expect(segment().textContent).toMatch(/^Est\./)

    fireEvent.click(segment())
    expect(radio('Off').getAttribute('aria-checked')).toBe('true')
    expect(radio('Cost').getAttribute('aria-checked')).toBe('false')
    expect(writes).toEqual(['cost', 'off'])
  })
})
