import { PLUGIN_PAGES_MAX, pluginPageId, pluginPagesId, type PluginPage } from '../plugins/tabs'
import { activateTab, closeTab, findTab, groupById, openTab, retitleTab, type PaneLayout, type PaneRef } from './panes'

/**
 * The pages of a plugin that declares `pageStrip`, as data.
 *
 * Such a plugin has one tab (`plugin-pages`), and every `helm.tabs.open` is a
 * page in a strip inside it rather than a tab among a pane's tabs - the way
 * the Browser tab holds its pages (`browserStrip.ts`). The pages live in the
 * tab's ref, so they move, split and are written down with it, and every rule
 * about them is here rather than discovered in a window.
 *
 * A page is named by `pluginPageId`, which is also its frame's key. Every
 * operation takes a layout and returns one; a plugin with no such tab open,
 * or a page its strip does not hold, leaves the layout as it was.
 */

export type PluginPagesRef = Extract<PaneRef, { kind: 'plugin-pages' }>

/** The page in front: `active`, or the last page when that one is gone. */
export function frontPluginPage(ref: PluginPagesRef): PluginPage | null {
  if (ref.active !== null) {
    const found = ref.pages.find((page) => pluginPageId(ref.plugin, page) === ref.active)
    if (found !== undefined) return found
  }
  return ref.pages.at(-1) ?? null
}

/** The plugin's pages tab, wherever it is, or null when it has none open. */
export function pluginPagesTab(layout: PaneLayout, plugin: string): PluginPagesRef | null {
  const at = findTab(layout, pluginPagesId(plugin))
  if (at === null) return null
  const ref = groupById(layout, at.group)!.tabs[at.index]!
  return ref.kind === 'plugin-pages' ? ref : null
}

/**
 * The plugin's pages tab replaced where it stands. Nothing else in the layout
 * moves, so what happens inside the strip is not a change of focus.
 */
function withPages(layout: PaneLayout, next: PluginPagesRef): PaneLayout {
  const mine = (tab: PaneRef): boolean => tab.kind === 'plugin-pages' && tab.plugin === next.plugin
  return {
    ...layout,
    groups: layout.groups.map((group) =>
      group.tabs.some(mine) ? { ...group, tabs: group.tabs.map((tab) => (mine(tab) ? next : tab)) } : group
    )
  }
}

/** The pages with one more at the end, and the oldest not in front making room for it when the strip is full. */
function appended(ref: PluginPagesRef, page: PluginPage): PluginPage[] {
  const pages = [...ref.pages, page]
  if (pages.length <= PLUGIN_PAGES_MAX) return pages
  const front = ref.active
  const oldest = pages.findIndex((candidate) => pluginPageId(ref.plugin, candidate) !== front)
  return pages.filter((_, index) => index !== oldest)
}

/**
 * `helm.tabs.open` for a plugin with a page strip: the page comes to the front
 * of the plugin's tab, and that tab to the front of its pane.
 *
 * A page with the same tab and parameters is brought forward rather than
 * opened twice, and the title it was asked for this time is the one it shows
 * (null keeps the one it has). A new page goes at the end of the strip. With
 * no tab of the plugin's open, one opens in group `group` - the focused group
 * unless told otherwise - holding this page.
 */
export function openPluginPage(
  layout: PaneLayout,
  plugin: string,
  page: PluginPage,
  group = layout.focused
): PaneLayout {
  const id = pluginPageId(plugin, page)
  const ref = pluginPagesTab(layout, plugin)
  if (ref === null) {
    return openTab(layout, { kind: 'plugin-pages', plugin, pages: [page], active: id }, group)
  }
  const index = ref.pages.findIndex((candidate) => pluginPageId(plugin, candidate) === id)
  const pages =
    index < 0
      ? appended(ref, page)
      : page.title !== null && ref.pages[index]!.title !== page.title
        ? ref.pages.map((candidate, at) => (at === index ? { ...candidate, title: page.title } : candidate))
        : ref.pages
  return activateTab(withPages(layout, { ...ref, pages, active: id }), pluginPagesId(plugin))
}

/** A page clicked in the strip: in front of it, and the plugin's tab in front of its pane. */
export function activatePluginPage(layout: PaneLayout, plugin: string, id: string): PaneLayout {
  const ref = pluginPagesTab(layout, plugin)
  if (ref === null || !ref.pages.some((page) => pluginPageId(plugin, page) === id)) return layout
  const next = ref.active === id ? layout : withPages(layout, { ...ref, active: id })
  return activateTab(next, pluginPagesId(plugin))
}

/**
 * A page closed. The one in front hands the front to the page that slides into
 * its place - its right-hand neighbour, or the left-hand one when it was last -
 * as a pane's tab does. The last page closing closes the plugin's tab, as the
 * Browser tab's last page closes it.
 */
export function closePluginPage(layout: PaneLayout, plugin: string, id: string): PaneLayout {
  const ref = pluginPagesTab(layout, plugin)
  if (ref === null) return layout
  const index = ref.pages.findIndex((page) => pluginPageId(plugin, page) === id)
  if (index < 0) return layout
  const pages = ref.pages.filter((_, at) => at !== index)
  if (pages.length === 0) return closeTab(layout, pluginPagesId(plugin))
  const front = frontPluginPage(ref)
  const wasFront = front !== null && pluginPageId(plugin, front) === id
  const neighbour = pages[index] ?? pages[index - 1]!
  return withPages(layout, { ...ref, pages, active: wasFront ? pluginPageId(plugin, neighbour) : ref.active })
}

/**
 * A page moved along the strip, to `toIndex` counted after it has left its
 * place - what the strip's drag and Ctrl+Shift+Arrow report. It comes to the
 * front, as a dragged tab does everywhere.
 */
export function movePluginPage(layout: PaneLayout, plugin: string, id: string, toIndex: number): PaneLayout {
  const ref = pluginPagesTab(layout, plugin)
  if (ref === null) return layout
  const page = ref.pages.find((candidate) => pluginPageId(plugin, candidate) === id)
  if (page === undefined) return layout
  const rest = ref.pages.filter((candidate) => candidate !== page)
  const at = Math.max(0, Math.min(toIndex, rest.length))
  const pages = [...rest.slice(0, at), page, ...rest.slice(at)]
  return activateTab(withPages(layout, { ...ref, pages, active: id }), pluginPagesId(plugin))
}

/**
 * A plugin surface renamed itself (`helm.surface.setTitle`), or put the
 * manifest's title back (null). `key` is its frame's key: a plugin tab's id,
 * or a page's. Nothing moves and nothing takes the focus.
 */
export function retitlePluginSurface(layout: PaneLayout, key: string, title: string | null): PaneLayout {
  if (findTab(layout, key) !== null) return retitleTab(layout, key, title)
  for (const group of layout.groups) {
    for (const ref of group.tabs) {
      if (ref.kind !== 'plugin-pages') continue
      const index = ref.pages.findIndex((page) => pluginPageId(ref.plugin, page) === key)
      if (index < 0) continue
      if (ref.pages[index]!.title === title) return layout
      return withPages(layout, {
        ...ref,
        pages: ref.pages.map((page, at) => (at === index ? { ...page, title } : page))
      })
    }
  }
  return layout
}

/** Every page open in any plugin's strip, by its id: the frames that must stay. */
export function openPluginPageIds(layout: PaneLayout): Set<string> {
  const ids = new Set<string>()
  for (const group of layout.groups) {
    for (const ref of group.tabs) {
      if (ref.kind === 'plugin-pages') for (const page of ref.pages) ids.add(pluginPageId(ref.plugin, page))
    }
  }
  return ids
}
