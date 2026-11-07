import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PaneCrumb, type CrumbChip } from './PaneGroup'

/**
 * The row under a session's tab. A program's own error message can be 200
 * characters, longer than any pane is wide, so the crumb's status has to give
 * way to the place and end in an ellipsis rather than being clipped by the
 * island's edge. jsdom lays nothing out, so this checks the classes that do it
 * and the hover text that gives the whole message back.
 */

describe('PaneCrumb status', () => {
  it('a long error message is cut with an ellipsis and kept whole in its hover text', () => {
    const text = `Error · ${'x'.repeat(200)}`
    const { container } = render(<PaneCrumb place="reporter" status={{ text, tone: 'danger' }} />)
    const status = container.querySelector<HTMLElement>('[data-crumb="status"]')
    expect(status).not.toBeNull()
    expect(status?.textContent).toBe(text)
    expect(status?.title).toBe(text)
    expect(status?.className).toContain('truncate')
    expect(status?.className).toContain('min-w-0')
    expect(status?.className).not.toContain('shrink-0')
    expect(status?.className).toContain('text-danger')
  })

  it('the place and branch keep their room while the status takes what is left', () => {
    const { container } = render(
      <PaneCrumb place="reporter" branch="main" status={{ text: 'Working · 3s', tone: 'accent' }} />
    )
    const place = container.querySelector<HTMLElement>('[data-crumb="place"]')
    expect(place?.className).toContain('shrink-0')
    // A zero basis: the status grows into the room left over and never claims
    // its text's width from the branch beside it.
    const status = container.querySelector<HTMLElement>('[data-crumb="status"]')
    expect(status?.className).toContain('basis-0')
    expect(status?.className).toContain('flex-1')
    expect(status?.className).toContain('text-right')
  })
})

/**
 * A parent whose pane has no room for the family view shows its children in its
 * crumb as chips, so they are on screen with the sidebar closed. A chip opens
 * the child's peek, which the window places under it.
 */
describe('PaneCrumb chips', () => {
  const chip = (overrides: Partial<CrumbChip> = {}): CrumbChip => ({
    chipKey: 'local:2',
    name: 'reviewer',
    mark: { glyph: 'dot', state: 'busy' },
    stateLabel: 'working',
    needsYou: false,
    open: false,
    onPress: vi.fn(),
    ...overrides
  })

  it('S7: each child is a chip with its state dot, or a terminal glyph for a command', () => {
    const { container } = render(
      <PaneCrumb
        place="helm"
        chips={[
          chip(),
          chip({ chipKey: 'local:3', name: 'worker-2', mark: { glyph: 'dot', state: 'waiting' }, stateLabel: 'waiting for you', needsYou: true }),
          chip({ chipKey: 'local:4', name: 'tests', mark: { glyph: 'command', state: 'running' }, stateLabel: 'running' })
        ]}
      />
    )
    const chips = [...container.querySelectorAll<HTMLElement>('[data-crumb-chip]')]
    expect(chips.map((each) => each.textContent)).toEqual(['reviewer', 'worker-2', 'tests'])
    expect(chips[0]?.querySelector('[data-child-dot="busy"]')).not.toBeNull()
    expect(chips[1]?.querySelector('[data-child-dot="waiting"]')).not.toBeNull()
    expect(chips[2]?.querySelector('[data-child-command="running"]')).not.toBeNull()
    expect(chips[2]?.querySelector('[data-child-dot]')).toBeNull()
    // A child that needs a person says so in warn.
    expect(chips[1]?.className).toContain('text-warn')
    expect(chips[0]?.className).not.toContain('text-warn')
  })

  it('S7: pressing a chip opens its child’s peek, and says it has one open while it does', async () => {
    const onPress = vi.fn()
    const { rerender } = render(<PaneCrumb place="helm" chips={[chip({ onPress })]} />)
    const button = screen.getByRole('button', { name: 'reviewer, working, peek' })
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(button)
    expect(onPress).toHaveBeenCalledTimes(1)
    rerender(<PaneCrumb place="helm" chips={[chip({ onPress, open: true })]} />)
    expect(button.getAttribute('aria-expanded')).toBe('true')
  })

  it('has no chips element for a parent with no children on screen as chips', () => {
    const { container } = render(<PaneCrumb place="helm" chips={[]} />)
    expect(container.querySelector('[data-crumb="chips"]')).toBeNull()
  })

  it('the chips are pushed to the end of the row and the status follows them', () => {
    const { container } = render(
      <PaneCrumb place="helm" chips={[chip()]} status={{ text: 'Working · 3s', tone: 'accent' }} />
    )
    const chips = container.querySelector<HTMLElement>('[data-crumb="chips"]')
    const status = container.querySelector<HTMLElement>('[data-crumb="status"]')
    expect(chips?.className).toContain('ml-auto')
    expect(chips?.nextElementSibling).toBe(status)
    // The chips took the row’s slack, so the status does not also grow into it.
    expect(status?.className).not.toContain('flex-1')
  })
})
