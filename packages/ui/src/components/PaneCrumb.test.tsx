import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PaneCrumb } from './PaneGroup'

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

describe('PaneCrumb child tag and parent link', () => {
  const tagOf = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-crumb="tag"]')
  const parentOf = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-crumb="parent"]')

  it('S32: a command child begins with a command tag, fg-muted on a border-strong ring with no fill', () => {
    const { container } = render(
      <PaneCrumb tag={{ kind: 'command', text: 'command' }} parent={{ name: 'api-refactor' }} place="helm" />
    )
    const tag = tagOf(container)
    expect(tag?.textContent).toBe('command')
    expect(tag?.className).toContain('text-fg-muted')
    expect(tag?.className).toContain('border-border-strong')
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
