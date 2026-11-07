import { fireEvent, render, screen } from '@testing-library/react'
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

  it('S26: an agent keeps its dot and each command’s glyph is toned success while it runs, fg-subtle once it exited 0 and danger for any other code', () => {
    const { container } = render(
      <PaneCrumb
        place="helm"
        chips={[
          chip(),
          chip({ chipKey: 'local:4', name: 'tests', mark: { glyph: 'command', state: 'running' }, stateLabel: 'running' }),
          chip({ chipKey: 'local:5', name: 'lint', mark: { glyph: 'command', state: 'ended' }, stateLabel: 'exited 0' }),
          chip({ chipKey: 'local:6', name: 'build', mark: { glyph: 'command', state: 'failed' }, stateLabel: 'exited 2' })
        ]}
      />
    )
    const chips = [...container.querySelectorAll<HTMLElement>('[data-crumb-chip]')]
    expect(chips[0]?.querySelector('[data-child-dot]')).not.toBeNull()
    expect(chips[1]?.querySelector('[data-child-command="running"]')?.className).toContain('text-success')
    expect(chips[2]?.querySelector('[data-child-command="ended"]')?.className).toContain('text-fg-subtle')
    expect(chips[3]?.querySelector('[data-child-command="failed"]')?.className).toContain('text-danger')
    expect(chips.map((each) => each.getAttribute('aria-label'))).toEqual([
      'reviewer, working, peek',
      'tests, running, peek',
      'lint, exited 0, peek',
      'build, exited 2, peek'
    ])
    // The glyph is the chip’s lead, ahead of the name.
    expect(chips[1]?.firstElementChild?.hasAttribute('data-child-command')).toBe(true)
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

describe('PaneCrumb child tag and parent link', () => {
  it('spaces the row 8px apart, with the for <parent> link 3px nearer its tag', () => {
    const { container } = render(
      <PaneCrumb tag={{ kind: 'role', text: 'reviewer' }} parent={{ name: 'api-refactor', onOpen: () => {} }} place='helm' />
    )
    expect(container.querySelector('[data-pane-crumb]')?.className).toContain(' gap-2 ')
    expect(container.querySelector('[data-crumb="parent"]')?.className).toContain('-ml-[3px]')
  })

  const tagOf = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-crumb="tag"]')
  const parentOf = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-crumb="parent"]')

  it('S32: a command child begins with a command tag, fg-muted on an inset border-strong ring with no fill and no layout', () => {
    const { container } = render(
      <PaneCrumb tag={{ kind: 'command', text: 'command' }} parent={{ name: 'api-refactor' }} place="helm" />
    )
    const tag = tagOf(container)
    expect(tag?.textContent).toBe('command')
    expect(tag?.className).toContain('text-fg-muted')
    // The ring is an inset shadow, so the pill is its 16px line tall and takes no border.
    expect(tag?.className).toContain('ring-border-strong')
    expect(tag?.className).toContain('ring-inset')
    expect(tag?.className).toContain('leading-4')
    expect(tag?.className).not.toMatch(/(^| )border( |$)/)
    expect(tag?.className).not.toContain('bg-')
    // It comes before the parent link and the place.
    const order = [...container.querySelectorAll('[data-crumb]')].map((el) => el.getAttribute('data-crumb'))
    expect(order).toEqual(['tag', 'parent', 'place'])
  })

  it('S32: an agent child begins with its role in accent-text on accent-soft', () => {
    const { container } = render(<PaneCrumb tag={{ kind: 'role', text: 'reviewer' }} place="helm" />)
    const tag = tagOf(container)
    expect(tag?.textContent).toBe('reviewer')
    expect(tag?.className).toContain('text-accent-text')
    expect(tag?.className).toContain('bg-accent-soft')
  })

  it('has no tag for a child with no role, and none for a session that is no child', () => {
    const { container } = render(<PaneCrumb parent={{ name: 'api-refactor', onOpen: () => {} }} place="helm" />)
    expect(tagOf(container)).toBeNull()
    expect(parentOf(container)?.textContent).toBe('for api-refactor')
    const plain = render(<PaneCrumb place="helm" />)
    expect(tagOf(plain.container)).toBeNull()
    expect(parentOf(plain.container)).toBeNull()
  })

  it('S32: pressing for <parent> opens the parent', () => {
    const onOpen = vi.fn()
    const { container } = render(<PaneCrumb parent={{ name: 'api-refactor', onOpen }} place="helm" />)
    const link = parentOf(container)
    expect(link?.tagName).toBe('BUTTON')
    expect(link?.className).toContain('text-fg-muted')
    expect(link?.className).toContain('hover:text-fg')
    expect(link?.className).toContain('hover:underline')
    fireEvent.click(link as HTMLElement)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('S32: for <parent> is plain text, not a button, when the window does not list the parent', () => {
    const { container } = render(<PaneCrumb parent={{ name: 'api-refactor' }} place="helm" />)
    const link = parentOf(container)
    expect(link?.textContent).toBe('for api-refactor')
    expect(link?.tagName).toBe('SPAN')
    expect(container.querySelector('button')).toBeNull()
  })
})
