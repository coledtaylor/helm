import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { BROWSER_PAGE_MIME, BrowserPages, type BrowserPagesProps } from './BrowserPages'
import { TAB_MIME } from './TabBar'

const PAGES: BrowserPagesProps['pages'] = [
  { id: 1, title: 'Dashboard', url: 'http://localhost:5173/', openedBy: null },
  { id: 2, title: '', url: '', openedBy: null },
  { id: 3, title: 'Settings', url: 'http://localhost:5173/settings', openedBy: 'browser overhaul' }
]

function renderPages(overrides: Partial<BrowserPagesProps> = {}): BrowserPagesProps {
  const props: BrowserPagesProps = {
    pages: PAGES,
    activeId: 1,
    focused: true,
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onMove: vi.fn(),
    onNew: vi.fn(),
    ...overrides
  }
  render(<BrowserPages {...props} />)
  return props
}

/** A drag carrying `id` as `type`, for a drop on the strip. */
const carrying = (type: string, id: string): { dataTransfer: unknown } => ({
  dataTransfer: { types: [type, 'text/plain'], getData: (asked: string) => (asked === type ? id : ''), dropEffect: '' }
})

describe('BrowserPages', () => {
  it('names each page by its title, an empty one "New tab", and an agent\'s by the session that opened it', () => {
    renderPages()
    const strip = screen.getByRole('tablist', { name: 'Browser tabs' })
    const tabs = within(strip).getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Dashboard', 'New tab', 'Settingsbrowser overhaul'])
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
    expect(tabs[2]!.getAttribute('title')).toBe('http://localhost:5173/settings\nOpened by the session “browser overhaul”')
  })

  it('reports pages by their own ids: front, close, and a new one from the + that opens no menu', async () => {
    const props = renderPages()
    await userEvent.click(screen.getByRole('tab', { name: /^Settings/ }))
    expect(props.onActivate).toHaveBeenCalledWith(3)
    await userEvent.click(screen.getByRole('button', { name: 'Close Dashboard' }))
    expect(props.onClose).toHaveBeenCalledWith(1)

    const plus = screen.getByRole('button', { name: 'New browser tab' })
    expect(plus.hasAttribute('aria-haspopup')).toBe(false)
    await userEvent.click(plus)
    expect(props.onNew).toHaveBeenCalledTimes(1)
  })

  it("moves a page dragged along the strip, and ignores a pane's tab dropped on it", () => {
    const props = renderPages()
    const last = screen.getByRole('tab', { name: /^Settings/ }).parentElement!
    // Dropped on the last tab is "before it", counted once the page has left.
    fireEvent.drop(last, carrying(BROWSER_PAGE_MIME, 'page:1'))
    expect(props.onMove).toHaveBeenCalledWith(1, 1)

    fireEvent.drop(last, carrying(TAB_MIME, 'session:4'))
    expect(props.onMove).toHaveBeenCalledTimes(1)
  })
})
