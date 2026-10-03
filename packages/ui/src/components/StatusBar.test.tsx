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
