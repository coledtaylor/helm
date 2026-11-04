import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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

  it('the place keeps its room while the status gives way', () => {
    const { container } = render(
      <PaneCrumb place="reporter" status={{ text: 'Working · 3s', tone: 'accent' }} />
    )
    const place = container.querySelector<HTMLElement>('[data-crumb="place"]')
    expect(place?.className).toContain('shrink-0')
  })
})
