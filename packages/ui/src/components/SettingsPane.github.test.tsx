import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type GhStatus } from '@helm/core/types'
import { pullRepoChoices, SettingsPane, type SettingsPaneProps } from './SettingsPane'
import { pullRepo, SIGNED_IN } from './pullFixtures.testkit'

/** The GitHub group of the settings pane. */

function renderPane(overrides: Partial<SettingsPaneProps> = {}) {
  const s = DEFAULT_SETTINGS
  const props: SettingsPaneProps = {
    section: 'github',
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
    archiveStats: null,
    transcriptArchiveMaxBytes: s.transcriptArchiveMaxBytes,
    onTranscriptArchiveMaxBytesChange: vi.fn(),
    templateCount: 0,
    templatesDir: 'C:\\templates',
    onManageTemplates: vi.fn(),
    onRevealTemplates: vi.fn(),
    filesWrap: s.filesWrap,
    onFilesWrapChange: vi.fn(),
    browserReach: s.browserReach,
    onBrowserReachChange: vi.fn(),
    browserMcp: false,
    onBrowserMcpChange: vi.fn(),
    browserMcpLocalOnly: true,
    onBrowserMcpLocalOnlyChange: vi.fn(),
    sessionMcp: false,
    onSessionMcpChange: vi.fn(),
    restoreWithoutAsking: false,
    onRestoreWithoutAskingChange: vi.fn(),
    gh: SIGNED_IN,
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
    prReviewModel: s.prReviewModel,
    onPrReviewModelChange: vi.fn(),
    prReviewEffort: s.prReviewEffort,
    onPrReviewEffortChange: vi.fn(),
    ...overrides
  }
  const view = render(<SettingsPane {...props} />)
  return { props, ...view }
}

/** The GitHub group, found by its heading. */
function group(): HTMLElement {
  return screen.getByRole('region', { name: 'GitHub' })
}

const select = (name: string): HTMLSelectElement => within(group()).getByRole('combobox', { name }) as HTMLSelectElement
const optionsOf = (name: string): Array<[string, string]> =>
  [...select(name).options].map((option) => [option.value, option.text])

describe('SettingsPane GitHub group', () => {
  it('shows the gh Helm found and its version, and has nothing to clear', async () => {
    const user = userEvent.setup()
    const { props } = renderPane()

    expect(within(group()).getByText(SIGNED_IN.path!)).toBeTruthy()
    expect(within(group()).getByText(SIGNED_IN.version!)).toBeTruthy()
    expect(within(group()).getByText('Found and signed in')).toBeTruthy()
    expect((within(group()).getByRole('button', { name: 'Clear override' }) as HTMLButtonElement).disabled).toBe(true)

    await user.click(within(group()).getByRole('button', { name: 'Locate manually…' }))
    expect(props.onLocateGh).toHaveBeenCalledTimes(1)
  })

  it('names a gh picked by hand, with its version, and offers to clear it', async () => {
    const user = userEvent.setup()
    const picked: GhStatus = { ...SIGNED_IN, path: 'D:\\tools\\gh.exe', source: 'setting', version: 'gh version 9.9.9' }
    const { props } = renderPane({ gh: picked })

    expect(within(group()).getByText('D:\\tools\\gh.exe')).toBeTruthy()
    expect(within(group()).getByText('gh version 9.9.9')).toBeTruthy()
    expect(within(group()).getByText('Set by you')).toBeTruthy()
    await user.click(within(group()).getByRole('button', { name: 'Clear override' }))
    expect(props.onClearGhOverride).toHaveBeenCalledTimes(1)
  })

  it('says what is wrong with gh in the words main sent', () => {
    const message = 'GitHub CLI is not signed in. Run `gh auth login` in a terminal.'
    renderPane({ gh: { ...SIGNED_IN, authenticated: false, problem: { kind: 'unauthenticated', message } } })
    expect(within(group()).getByText(message)).toBeTruthy()
  })

  it('offers polling off and on, and writes the minutes chosen', async () => {
    const user = userEvent.setup()
    const { props } = renderPane()
    const poll = 'How often to check for pull requests'
    expect(optionsOf(poll)).toEqual(expect.arrayContaining([['0', 'Off - only when I ask'], ['15', 'Every 15 minutes']]))

    await user.selectOptions(select(poll), '0')
    await user.selectOptions(select(poll), '15')
    expect(vi.mocked(props.onPrPollMinutesChange).mock.calls).toEqual([[0], [15]])
  })

  it('offers the stale cutoff off and on, and writes the days chosen', async () => {
    const user = userEvent.setup()
    const { props } = renderPane()
    const cutoff = 'When the Pulls pane calls a pull request stale'
    expect(optionsOf(cutoff)).toEqual(expect.arrayContaining([['0', 'Off - one Open list'], ['7', 'A week']]))

    await user.selectOptions(select(cutoff), '0')
    await user.selectOptions(select(cutoff), '7')
    expect(vi.mocked(props.onPrStaleDaysChange).mock.calls).toEqual([[0], [7]])
  })

  it('keeps a value it does not offer selectable, rather than showing another', () => {
    renderPane({ prPollMinutes: 45, prStaleDays: 5 })
    expect(select('How often to check for pull requests').value).toBe('45')
    expect(select('When the Pulls pane calls a pull request stale').value).toBe('5')
  })

  it('commits a typed review prompt once, on Enter, and Reset restores the built-in one', async () => {
    const user = userEvent.setup()
    const { props, rerender } = renderPane()
    const field = within(group()).getByRole('textbox', { name: 'Review prompt template' })
    const reset = within(group()).getByRole('button', { name: 'Reset' }) as HTMLButtonElement
    expect((field as HTMLInputElement).value).toBe('/code-review {number}')
    expect(reset.disabled).toBe(true)

    await user.clear(field)
    // `{{` is a literal brace to user-event.
    await user.type(field, '/review {{slug}#{{number}{Enter}')
    expect(vi.mocked(props.onPrReviewPromptChange).mock.calls).toEqual([['/review {slug}#{number}']])

    rerender(<SettingsPane {...props} prReviewPrompt="/review {slug}#{number}" />)
    expect(reset.disabled).toBe(false)
    await user.click(reset)
    expect(props.onPrReviewPromptChange).toHaveBeenLastCalledWith('/code-review {number}')
  })

  it('writes the checkout mode, and the review model and effort, clearing each back to null with the default', async () => {
    const user = userEvent.setup()
    const { props, rerender } = renderPane()
    const checkout = 'What a review does to the working tree'
    const model = 'The model a review session runs on'
    const effort = 'The reasoning effort a review session runs at'

    await user.selectOptions(select(checkout), 'checkout')
    await user.selectOptions(select(model), 'opus')
    await user.selectOptions(select(effort), 'high')
    expect(props.onPrCheckoutChange).toHaveBeenLastCalledWith('checkout')
    expect(props.onPrReviewModelChange).toHaveBeenLastCalledWith('opus')
    expect(props.onPrReviewEffortChange).toHaveBeenLastCalledWith('high')

    rerender(<SettingsPane {...props} prCheckout="checkout" prReviewModel="opus" prReviewEffort="high" />)
    await user.selectOptions(select(checkout), 'none')
    await user.selectOptions(select(model), 'Claude Code’s default')
    await user.selectOptions(select(effort), 'Claude Code’s default')
    expect(props.onPrCheckoutChange).toHaveBeenLastCalledWith('none')
    expect(props.onPrReviewModelChange).toHaveBeenLastCalledWith(null)
    expect(props.onPrReviewEffortChange).toHaveBeenLastCalledWith(null)
  })

  it('lists every known repository with the ignored ones unticked, and writes the whole list on a toggle', async () => {
    const user = userEvent.setup()
    const repos = pullRepoChoices(
      [pullRepo('beta', []), pullRepo('alpha', [])],
      [
        { slug: 'acme/delta', name: 'delta', present: true, paths: ['C:\\work space\\delta'] },
        { slug: 'acme/gone', name: 'gone', present: false, paths: [] }
      ]
    )
    const { props } = renderPane({ prRepos: repos })
    const tick = (slug: string): HTMLInputElement =>
      within(group()).getByRole('checkbox', { name: `Fetch pull requests from ${slug}` }) as HTMLInputElement

    expect(
      within(group())
        .getAllByRole('checkbox')
        .map((box) => [box.getAttribute('aria-label'), (box as HTMLInputElement).checked])
    ).toEqual([
      ['Fetch pull requests from acme/alpha', true],
      ['Fetch pull requests from acme/beta', true],
      ['Fetch pull requests from acme/delta', false],
      ['Fetch pull requests from acme/gone', false]
    ])
    expect(within(group()).getByText('2 of 4 fetched')).toBeTruthy()
    expect(within(group()).getByText('not scanned')).toBeTruthy()

    await user.click(tick('acme/alpha'))
    expect(props.onPrIgnoredReposChange).toHaveBeenLastCalledWith(['acme/alpha', 'acme/delta', 'acme/gone'])
    await user.click(tick('acme/delta'))
    expect(props.onPrIgnoredReposChange).toHaveBeenLastCalledWith(['acme/gone'])
  })
})
