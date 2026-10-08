import type { JSX, ReactNode } from 'react'
import { TabBar, type Tab } from './TabBar'

/** One page in a plugin's strip. `id` is its `pluginPageId`, never shaped like a pane's tab id. */
export interface PluginPageTab {
  id: string
  title: string
  /** Hover text: the title in full, and the plugin it belongs to. */
  hint: string
}

/**
 * The drag type of a plugin page. Its own, so a page cannot be dropped among a
 * pane's tabs or a browser's pages, nor they among a plugin's.
 */
export const PLUGIN_PAGE_MIME = 'application/x-helm-plugin-page'

export interface PluginPagesProps {
  /** What the strip is called: "<plugin> pages". */
  label: string
  pages: readonly PluginPageTab[]
  activeId: string | null
  /** The plugin's icon, on every page. */
  icon: ReactNode
  /** Whether the pane holding the plugin's tab is the focused one. */
  focused: boolean
  onActivate: (id: string) => void
  onClose: (id: string) => void
  /** A page should end up at `toIndex`, counted after it has left its place. */
  onMove: (id: string, toIndex: number) => void
}

/**
 * The strip of pages inside the one tab of a plugin that declares `pageStrip`.
 *
 * The pane's `TabBar`, as the Browser tab's strip is, so a page looks, closes,
 * middle-clicks and reorders exactly like every other tab in Helm - and a
 * strip of its own, so a plugin that opens a list, then an item, then another
 * does not fill the pane's strip beside the sessions. There is no `+`: a
 * plugin opens its own pages.
 */
export function PluginPages({
  label,
  pages,
  activeId,
  icon,
  focused,
  onActivate,
  onClose,
  onMove
}: PluginPagesProps): JSX.Element {
  const tabs: Tab[] = pages.map((page) => ({ id: page.id, title: page.title, hint: page.hint, icon }))
  return (
    <div data-plugin-pages>
      <TabBar
        label={label}
        tabs={tabs}
        activeId={activeId}
        focused={focused}
        onActivate={onActivate}
        onClose={onClose}
        onMove={onMove}
        dragType={PLUGIN_PAGE_MIME}
      />
    </div>
  )
}
