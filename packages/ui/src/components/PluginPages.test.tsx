import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { BROWSER_PAGE_MIME } from './BrowserPages'
import { PLUGIN_PAGE_MIME, PluginPages, type PluginPagesProps } from './PluginPages'
import { TAB_MIME } from './TabBar'

const PAGES: PluginPagesProps['pages'] = [
  { id: 'plugin-page:trackr/view', title: 'Helm', hint: 'Helm - Trackr' },
  { id: 'plugin-page:trackr/view?{"id":"HELM-12"}', title: 'HELM-12', hint: 'HELM-12 - Trackr' },
  { id: 'plugin-page:trackr/view?{"id":"HELM-13"}', title: 'HELM-13', hint: 'HELM-13 - Trackr' }
]

function renderPages(overrides: Partial<PluginPagesProps> = {}): PluginPagesProps {
  const props: PluginPagesProps = {
    label: 'Trackr pages',
    pages: PAGES,
    activeId: PAGES[1]!.id,
    icon: null,
    focused: true,
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onMove: vi.fn(),
    ...overrides
  }
  render(<PluginPages {...props} />)
  return props
}

/** A drag carrying `id` as `type`, for a drop on the strip. */
const carrying = (type: string, id: string): { dataTransfer: unknown } => ({
  dataTransfer: { types: [type, 'text/plain'], getData: (asked: string) => (asked === type ? id : ''), dropEffect: '' }
})

describe('PluginPages', () => {
  it('names each page by its title in a strip named for the plugin, with no + to open one', () => {
    renderPages()
    const strip = screen.getByRole('tablist', { name: 'Trackr pages' })
    const tabs = within(strip).getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Helm', 'HELM-12', 'HELM-13'])
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true')
    expect(tabs[2]!.getAttribute('title')).toBe('HELM-13 - Trackr')
    expect(screen.queryByRole('button', { name: /new/i })).toBeNull()
  })

  it('reports pages by their own ids: front and close', async () => {
    const props = renderPages()
    await userEvent.click(screen.getByRole('tab', { name: /^HELM-13/ }))
    expect(props.onActivate).toHaveBeenCalledWith(PAGES[2]!.id)
    await userEvent.click(screen.getByRole('button', { name: 'Close Helm' }))
    expect(props.onClose).toHaveBeenCalledWith(PAGES[0]!.id)
  })

  it('moves a page with Ctrl+Shift+Arrow, as the Browser tab moves its pages', () => {
    const props = renderPages()
    fireEvent.keyDown(screen.getByRole('tab', { name: /^HELM-12/ }), { key: 'ArrowRight', ctrlKey: true, shiftKey: true })
    expect(props.onMove).toHaveBeenCalledWith(PAGES[1]!.id, 2)
  })

  it("moves a page dragged along the strip, and ignores a pane's tab or a browser page dropped on it", () => {
    const props = renderPages()
    const last = screen.getByRole('tab', { name: /^HELM-13/ }).parentElement!
    fireEvent.drop(last, carrying(PLUGIN_PAGE_MIME, PAGES[0]!.id))
    expect(props.onMove).toHaveBeenCalledWith(PAGES[0]!.id, 1)

    fireEvent.drop(last, carrying(TAB_MIME, 'session:4'))
    fireEvent.drop(last, carrying(BROWSER_PAGE_MIME, 'page:1'))
    expect(props.onMove).toHaveBeenCalledTimes(1)
  })
})
