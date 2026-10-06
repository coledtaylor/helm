import type { JSX } from 'react'
import { GlobeIcon } from './icons'
import { TabBar, type Tab } from './TabBar'

/** One page in the Browser tab's strip. */
export interface BrowserPage {
  id: number
  title: string
  url: string
  /** The session that opened it, or null when the user did. */
  openedBy: string | null
}

/**
 * The drag type of a page tab. Its own, so a page cannot be dropped among a
 * pane's tabs and a pane's tab cannot be dropped among the pages.
 */
export const BROWSER_PAGE_MIME = 'application/x-helm-browser-page'

export interface BrowserPagesProps {
  pages: readonly BrowserPage[]
  activeId: number | null
  /** Whether the pane holding the Browser tab is the focused one. */
  focused: boolean
  onActivate: (id: number) => void
  onClose: (id: number) => void
  /** A page should end up at `toIndex`, counted after it has left its place. */
  onMove: (id: number, toIndex: number) => void
  onNew: () => void
}

/** A page's id in the strip. Never shaped like a pane's tab id. */
const tabId = (id: number): string => `page:${String(id)}`

/**
 * The Browser tab's own strip of pages.
 *
 * The pane's `TabBar`, so a page tab looks, closes, middle-clicks and
 * reorders exactly like every other tab in Helm - and a strip of its own,
 * inside the Browser tab, so pages never sit among the sessions. That was the
 * complaint: a sign-in that opened four pages left four tabs between the
 * sessions somebody was working in.
 *
 * A page an agent opened carries the session's name, as its tab did before.
 */
export function BrowserPages({
  pages,
  activeId,
  focused,
  onActivate,
  onClose,
  onMove,
  onNew
}: BrowserPagesProps): JSX.Element {
  const byTab = new Map(pages.map((page) => [tabId(page.id), page.id]))
  const tabs: Tab[] = pages.map((page) => {
    // The address, which tells three pages on one dev server apart, is in the
    // hint. An empty page is "New tab": a tab with no label is a tab you
    // cannot aim at.
    const where = page.url === '' ? 'A browser tab with no address yet' : page.url
    return {
      id: tabId(page.id),
      title: page.title === '' ? 'New tab' : page.title,
      ...(page.openedBy === null ? {} : { badge: page.openedBy }),
      hint: page.openedBy === null ? where : `${where}\nOpened by the session “${page.openedBy}”`,
      icon: <GlobeIcon width={13} height={13} />
    }
  })
  /** The page behind a strip id, or nothing for an id that is not one of ours. */
  const page = (id: string, then: (page: number) => void): void => {
    const found = byTab.get(id)
    if (found !== undefined) then(found)
  }

  return (
    <div data-browser-pages>
      <TabBar
        label="Browser tabs"
        tabs={tabs}
        activeId={activeId === null ? null : tabId(activeId)}
        focused={focused}
        onActivate={(id) => page(id, onActivate)}
        onClose={(id) => page(id, onClose)}
        onMove={(id, toIndex) => page(id, (found) => onMove(found, toIndex))}
        onNewTab={onNew}
        newTabLabel="New browser tab"
        newTabMenu={false}
        dragType={BROWSER_PAGE_MIME}
      />
    </div>
  )
}
