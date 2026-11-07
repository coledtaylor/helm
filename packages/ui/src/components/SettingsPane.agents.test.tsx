import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type JSX } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@helm/core/types'
import { SettingsPane, type SettingsPaneProps } from './SettingsPane'

/**
 * The settings pane's Agents section: whether sessions can start agents, and
 * the four limits on a family. The other sections are tested in their own files.
 */

function paneProps(overrides: Partial<SettingsPaneProps> = {}): SettingsPaneProps {
  const s = DEFAULT_SETTINGS
  return {
    section: 'agents',
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
      projectShellHeightPct: s.projectShellHeightPct
    },
    onTerminalChange: vi.fn(),
    terminalFontStack: 'monospace',
    shells: [],
    onLocateShell: vi.fn(),
    onShellPath: vi.fn(async () => null),
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
    browserSearch: s.browserSearch,
    onBrowserSearchChange: vi.fn(),
    onBrowserReachChange: vi.fn(),
    browserMcp: s.browserMcp,
    onBrowserMcpChange: vi.fn(),
    browserMcpLocalOnly: s.browserMcpLocalOnly,
    onBrowserMcpLocalOnlyChange: vi.fn(),
    sessionMcp: s.sessionMcp,
    onSessionMcpChange: vi.fn(),
    sessionAgents: s.sessionAgents,
    onSessionAgentsChange: vi.fn(),
    agentLimits: {
      agentChildrenPerParent: s.agentChildrenPerParent,
      agentSessionsPerHost: s.agentSessionsPerHost,
      agentHeavyPerHost: s.agentHeavyPerHost,
      agentDepth: s.agentDepth,
      agentStartsPerParent: s.agentStartsPerParent
    },
    onAgentLimitsChange: vi.fn(),
    showChildrenInParentTab: s.showChildrenInParentTab,
    onShowChildrenInParentTabChange: vi.fn(),
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
    hostInstall: {
      check: vi.fn(async () => ({
        kind: 'ready' as const,
        found: { version: '1.2.0', protocol: '1.0' },
        system: { os: 'linux' as const, cpu: 'x64', label: 'Linux · x86_64' }
      })),
      install: vi.fn(),
      cancel: vi.fn()
    },
    onHostInstalled: vi.fn(),
    devices: { hosts: [], onDisconnect: vi.fn() },
    ...overrides
  }
}

/**
 * The pane as the app holds it: what the user changes is kept and handed back,
 * as well as reported, so a field shows what was kept and not what it was given.
 */
function Kept({ props }: { props: SettingsPaneProps }): JSX.Element {
  const [sessionAgents, setSessionAgents] = useState(props.sessionAgents)
  const [agentLimits, setAgentLimits] = useState(props.agentLimits)
  const [inParentTab, setInParentTab] = useState(props.showChildrenInParentTab)
  return (
    <SettingsPane
      {...props}
      sessionAgents={sessionAgents}
      onSessionAgentsChange={(next) => {
        setSessionAgents(next)
        props.onSessionAgentsChange(next)
      }}
      showChildrenInParentTab={inParentTab}
      onShowChildrenInParentTabChange={(next) => {
        setInParentTab(next)
        props.onShowChildrenInParentTabChange(next)
      }}
      agentLimits={agentLimits}
      onAgentLimitsChange={(patch) => {
        setAgentLimits((current) => ({ ...current, ...patch }))
        props.onAgentLimitsChange(patch)
      }}
    />
  )
}

function renderPane(overrides: Partial<SettingsPaneProps> = {}): SettingsPaneProps {
  const props = paneProps(overrides)
  render(<Kept props={props} />)
  return props
}

const group = (): HTMLElement => screen.getByRole('region', { name: 'Agents' })
const limits = (): HTMLElement => screen.getByRole('region', { name: 'Limits' })
const limit = (name: string): HTMLInputElement =>
  within(limits()).getByRole('textbox', { name }) as HTMLInputElement

describe('SettingsPane - Agents', () => {
  it('shows the two choices the design draws, each a tick with its sentence beside it, and nothing else in the group', () => {
    renderPane()

    const rows = [...group().querySelectorAll('label')]
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.querySelector('input[type="checkbox"]')?.getAttribute('aria-label'))).toEqual([
      'Sessions can start agents',
      "Show children in their parent's tab"
    ])
    // The tick leads the row and the text follows it, so it sits to the left of its words.
    for (const row of rows) {
      const tick = row.querySelector('input[type="checkbox"]') as HTMLElement
      const words = row.querySelector('span.block') as HTMLElement
      expect(tick.compareDocumentPosition(words) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(row.firstElementChild?.contains(tick)).toBe(true)
    }
    expect(rows.map((row) => row.textContent)).toEqual([
      'Sessions can start agentsEvery session you start gets the floti-agents tools and floti agent. A profile can turn it off for its own sessions.',
      "Show children in their parent's tabOn this device. A parent's tab shows its running children beside its terminal while its pane has room, and never takes the focus from it. Off, the parent shows alone, with its children as chips in its crumb and rows in the tree."
    ])
    // No limit field and no hint of the group's own in it.
    expect(within(group()).queryAllByRole('textbox')).toHaveLength(0)
    expect(group().querySelector('header p')).toBeNull()
  })

  it('keeps the choice to show children in their parent’s tab, on by default and kept for this device', async () => {
    const props = renderPane()
    const tick = within(group()).getByRole('checkbox', { name: "Show children in their parent's tab" }) as HTMLInputElement
    expect(tick.checked).toBe(true)
    await userEvent.click(tick)
    expect(props.onShowChildrenInParentTabChange).toHaveBeenCalledWith(false)
    expect(tick.checked).toBe(false)
    cleanup()

    const off = renderPane({ showChildrenInParentTab: false })
    const offTick = within(group()).getByRole('checkbox', { name: "Show children in their parent's tab" }) as HTMLInputElement
    expect(offTick.checked).toBe(false)
    await userEvent.click(offTick)
    expect(off.onShowChildrenInParentTabChange).toHaveBeenCalledWith(true)
  })

  it('a tick is also switched by pressing its words', async () => {
    const props = renderPane()
    await userEvent.click(within(group()).getByText('Sessions can start agents', { selector: 'span.block' }))
    expect(props.onSessionAgentsChange).toHaveBeenCalledWith(false)
  })

  it('S16: shows Sessions can start agents and each limit with its default', () => {
    renderPane()

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Agents')
    const tick = within(group()).getByRole('checkbox', { name: 'Sessions can start agents' }) as HTMLInputElement
    expect(tick.checked).toBe(true)
    expect(group().textContent).toContain(
      'Every session you start gets the floti-agents tools and floti agent. A profile can turn it off for its own sessions.'
    )

    expect(limit('Children per parent').value).toBe('4')
    expect(limit('Agent sessions per host').value).toBe('8')
    expect(limit('Heavy agents on this host').value).toBe('1')
    expect(limit('Depth').value).toBe('2')
    expect(limit('Starts per parent').value).toBe('16')
  })

  it('S16: shows what the settings hold when they are not the defaults', () => {
    renderPane({
      sessionAgents: false,
      agentLimits: {
        agentChildrenPerParent: 6,
        agentSessionsPerHost: 12,
        agentHeavyPerHost: 3,
        agentDepth: 3,
        agentStartsPerParent: 40
      }
    })
    const tick = within(group()).getByRole('checkbox', { name: 'Sessions can start agents' }) as HTMLInputElement
    expect(tick.checked).toBe(false)
    expect(limit('Children per parent').value).toBe('6')
    expect(limit('Agent sessions per host').value).toBe('12')
    expect(limit('Heavy agents on this host').value).toBe('3')
    expect(limit('Depth').value).toBe('3')
    expect(limit('Starts per parent').value).toBe('40')
  })

  it('S16: keeps the choice to let sessions start agents', async () => {
    const props = renderPane()
    await userEvent.click(within(group()).getByRole('checkbox', { name: 'Sessions can start agents' }))
    expect(props.onSessionAgentsChange).toHaveBeenCalledWith(false)
    cleanup()

    const off = renderPane({ sessionAgents: false })
    await userEvent.click(within(group()).getByRole('checkbox', { name: 'Sessions can start agents' }))
    expect(off.onSessionAgentsChange).toHaveBeenCalledWith(true)
  })

  it('S16: keeps a value the user enters, for each limit, on Enter', async () => {
    const props = renderPane()
    const enter = async (name: string, value: string): Promise<void> => {
      const field = limit(name)
      await userEvent.clear(field)
      await userEvent.type(field, `${value}{Enter}`)
    }
    await enter('Children per parent', '6')
    await enter('Agent sessions per host', '20')
    await enter('Heavy agents on this host', '2')
    await enter('Depth', '3')
    await enter('Starts per parent', '50')

    expect(vi.mocked(props.onAgentLimitsChange).mock.calls).toEqual([
      [{ agentChildrenPerParent: 6 }],
      [{ agentSessionsPerHost: 20 }],
      [{ agentHeavyPerHost: 2 }],
      [{ agentDepth: 3 }],
      [{ agentStartsPerParent: 50 }]
    ])
  })

  it('S16: keeps a value on leaving the field, and writes nothing for a value that did not change', async () => {
    const props = renderPane()
    const field = limit('Depth')
    await userEvent.clear(field)
    await userEvent.type(field, '4')
    await userEvent.tab()
    expect(props.onAgentLimitsChange).toHaveBeenCalledWith({ agentDepth: 4 })

    const same = limit('Children per parent')
    await userEvent.click(same)
    await userEvent.tab()
    expect(props.onAgentLimitsChange).toHaveBeenCalledTimes(1)
  })

  it('S16: brings a number outside the range the host accepts to its nearest end, and drops a word', async () => {
    const props = renderPane()
    const enter = async (name: string, value: string): Promise<void> => {
      const field = limit(name)
      await userEvent.clear(field)
      await userEvent.type(field, `${value}{Enter}`)
    }
    await enter('Children per parent', '0')
    await enter('Heavy agents on this host', '40')
    await enter('Depth', '99')
    await enter('Starts per parent', '5000')
    expect(vi.mocked(props.onAgentLimitsChange).mock.calls).toEqual([
      [{ agentChildrenPerParent: 1 }],
      [{ agentHeavyPerHost: 8 }],
      [{ agentDepth: 8 }],
      [{ agentStartsPerParent: 1000 }]
    ])
    expect(limit('Children per parent').value).toBe('1')
    expect(limit('Depth').value).toBe('8')

    await enter('Agent sessions per host', 'many')
    expect(limit('Agent sessions per host').value).toBe('8')
    expect(props.onAgentLimitsChange).toHaveBeenCalledTimes(4)
  })

  it('shows the heavy limit at 1 and keeps a new value, counted in the limits with the others', async () => {
    const props = renderPane()
    expect(limit('Heavy agents on this host').value).toBe('1')
    expect(
      within(limits())
        .getAllByRole('textbox')
        .map((field) => field.getAttribute('aria-label'))
    ).toEqual([
      'Children per parent',
      'Agent sessions per host',
      'Heavy agents on this host',
      'Depth',
      'Starts per parent'
    ])

    const field = limit('Heavy agents on this host')
    await userEvent.clear(field)
    await userEvent.type(field, '3{Enter}')
    expect(props.onAgentLimitsChange).toHaveBeenCalledWith({ agentHeavyPerHost: 3 })
    expect(limit('Heavy agents on this host').value).toBe('3')
  })

  it('does not show the sessions group’s rows', () => {
    renderPane()
    expect(within(group()).queryByRole('button', { name: 'Stop host' })).toBeNull()
  })
})
