import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StatusBar, type StatusBarProps } from './StatusBar'

function renderBar(overrides: Partial<StatusBarProps> = {}) {
  const props: StatusBarProps = {
    sessions: { working: 0, waiting: 0, idle: 0 },
    onShowWaiting: vi.fn(),
    mode: null,
    version: '0.4.2',
    claudeVersion: '2.1.288',
    claudeMissing: false,
    usage: null,
    usageDisplay: 'percent',
    onUsageDisplayChange: vi.fn(),
    update: null,
    onOpenUpdate: vi.fn(),
    ...overrides
  }
  return render(<StatusBar {...props} />)
}

/** What the bar says, segment by segment, dividers as `|`. */
function segments(): string[] {
  return [...screen.getByRole('contentinfo').children].map((child) =>
    child.getAttribute('aria-hidden') === 'true' ? '|' : (child.textContent ?? '')
  )
}

describe('StatusBar: which Helm and which claude', () => {
  it('leads with the version, the build and a newer release, then claude, then the sessions', () => {
    renderBar({ mode: 'dev', update: { latest: '0.5.0', newer: true, url: 'https://example.test' } })
    expect(segments().slice(0, 7)).toEqual([
      'Helm 0.4.2',
      'dev',
      '0.5.0 available',
      '|',
      'claude 2.1.288',
      '|',
      'No sessions running'
    ])
  })

  it('says so in place of the version when claude cannot be found', () => {
    renderBar({ claudeVersion: null, claudeMissing: true })
    expect(segments().slice(0, 3)).toEqual(['Helm 0.4.2', '|', 'claude CLI not found'])
  })

  it('draws neither version, nor a divider for them, before either is known', () => {
    renderBar({ version: null, claudeVersion: null })
    expect(segments()[0]).toBe('No sessions running')
  })
})

describe('StatusBar: plugin items', () => {
  it("draws each plugin's word in its tone, right of the sessions, and a press opens it", () => {
    const onSelect = vi.fn()
    renderBar({
      plugins: [
        { id: 'sample', name: 'Sample', text: '2 unread', tone: 'accent', tooltip: 'Sample items', onSelect },
        { id: 'other', name: 'Other', text: 'Offline', tone: 'danger', tooltip: null, onSelect: vi.fn() }
      ]
    })
    const sample = screen.getByRole('button', { name: '2 unread' })
    expect(sample.getAttribute('data-status-plugin')).toBe('sample')
    expect(sample.getAttribute('title')).toBe('Sample items')
    expect(sample.className).toContain('text-accent-text')
    const other = screen.getByRole('button', { name: 'Offline' })
    // No tooltip of its own: the plugin's name says whose word it is.
    expect(other.getAttribute('title')).toBe('Other')
    expect(other.className).toContain('text-danger')
    sample.click()
    expect(onSelect).toHaveBeenCalledTimes(1)
    const all = segments()
    expect(all.indexOf('2 unread')).toBeGreaterThan(all.indexOf('No sessions running'))
    // A rule between them and the usage figures.
    expect(all[all.indexOf('Offline') + 1]).toBe('|')
  })

  it('draws no rule for plugins when none has an item', () => {
    renderBar({ plugins: [] })
    expect(document.querySelectorAll('[data-status-plugin]')).toHaveLength(0)
    expect(segments().filter((segment) => segment === '|')).toHaveLength(2)
  })
})

describe('StatusBar: the host sessions run in', () => {
  it('names this PC’s host and that quitting ends its sessions, and a press opens Settings', () => {
    const onOpen = vi.fn()
    renderBar({ host: { name: 'This PC', quitEnds: true, onOpen } })
    const item = screen.getByRole('button', { name: 'This PC · quit ends sessions' })
    expect(item.getAttribute('data-status-host')).toBe('ends')
    const all = segments()
    // After the sessions, behind a rule of its own.
    expect(all.slice(all.indexOf('No sessions running') + 1, all.indexOf('No sessions running') + 3)).toEqual([
      '|',
      'This PC · quit ends sessions'
    ])
    item.click()
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('says quitting keeps them when the setting does', () => {
    renderBar({ host: { name: 'This PC', quitEnds: false, onOpen: vi.fn() } })
    expect(screen.getByRole('button', { name: 'This PC · quit keeps sessions' }).getAttribute('data-status-host')).toBe(
      'keeps'
    )
  })

  it('shows no host item while sessions run in Helm itself', () => {
    renderBar({ host: null })
    expect(document.querySelectorAll('[data-status-host]')).toHaveLength(0)
    expect(segments().filter((segment) => segment === '|')).toHaveLength(2)
  })
})
