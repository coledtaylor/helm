import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TabBar, type Tab } from './TabBar'

const renderBar = (tabs: Tab[]) =>
  render(
    <TabBar
      tabs={tabs}
      activeId={tabs[0]?.id ?? null}
      focused
      onActivate={vi.fn()}
      onClose={vi.fn()}
    />
  )

describe('TabBar host', () => {
  it('names a session on another host after its title, in mono, with the host and folder in its hover text; a This PC tab names none', () => {
    const { container } = renderBar([
      { id: 'session:3', title: 'my-work', hint: 'my-work · C:\\work\\my-work', indicator: 'idle' },
      {
        id: 'host:h1/session:3',
        title: 'deploy',
        host: 'build-box',
        hint: 'deploy · build-box · /home/you/work/infra',
        indicator: 'busy'
      }
    ])

    const remote = container.querySelector('[data-tab="host:h1/session:3"]')!
    const host = remote.querySelector('[data-tab-host]')!
    expect(host.textContent).toBe('build-box')
    expect(host.className).toContain('font-mono')
    expect(host.className).toContain('text-fg-subtle')
    // After the title.
    expect(remote.querySelector('[data-tab-title]')?.compareDocumentPosition(host)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(remote.getAttribute('title')).toBe('deploy · build-box · /home/you/work/infra')

    const local = container.querySelector('[data-tab="session:3"]')!
    expect(local.querySelector('[data-tab-host]')).toBeNull()
    expect(screen.getAllByRole('tab')).toHaveLength(2)
  })

  it('S7: a session tab whose host link dropped has a warning ring for its dot and says the connection was lost', () => {
    const { container } = renderBar([
      { id: 'session:3', title: 'my-work', indicator: 'idle' },
      { id: 'host:h1/session:4', title: 'deploy', host: 'build-box', indicator: 'busy', away: true }
    ])

    const remote = container.querySelector('[data-tab="host:h1/session:4"]')!
    const dot = remote.querySelector('[data-tab-away]')!
    expect(dot.className).toContain('border-warn')
    expect(dot.className).not.toContain('bg-accent')
    expect(remote.getAttribute('aria-label')).toBe('deploy, connection lost')

    // A tab whose host is connected keeps its own state's dot.
    const local = container.querySelector('[data-tab="session:3"]')!
    expect(local.querySelector('[data-tab-away]')).toBeNull()
    expect(local.getAttribute('aria-label')).toBe('my-work, ready')
  })
})
