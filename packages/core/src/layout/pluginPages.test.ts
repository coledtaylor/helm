import { describe, expect, it } from 'vitest'
import { PLUGIN_PAGES_MAX, pluginPageId, type PluginPage } from '../plugins/tabs'
import {
  activeRef,
  findTab,
  focusGroup,
  fromSaved,
  openTab,
  paneId,
  splitWith,
  toSaved,
  type PaneLayout,
  type PaneRef
} from './panes'
import {
  activatePluginPage,
  closePluginPage,
  frontPluginPage,
  movePluginPage,
  openPluginPage,
  openPluginPageIds,
  pluginPagesTab,
  retitlePluginSurface
} from './pluginPages'

const page = (id: string | null, title: string | null = null): PluginPage => ({
  tab: 'view',
  params: id === null ? {} : { id },
  title
})
const pageId = (id: string | null): string => pluginPageId('trackr', page(id))
const session = (id: number): PaneRef => ({ kind: 'session', id })

/** The layout with these pages opened one after another, in a window holding one session. */
function opened(...ids: Array<string | null>): PaneLayout {
  let layout = openTab(fromSaved(null), session(1))
  for (const id of ids) layout = openPluginPage(layout, 'trackr', page(id))
  return layout
}

/** The strip, as the ids' parameters in order, the front one marked with `*`. */
function strip(layout: PaneLayout): string[] {
  const ref = pluginPagesTab(layout, 'trackr')
  if (ref === null) return []
  const front = frontPluginPage(ref)
  return ref.pages.map((candidate) => `${candidate === front ? '*' : ''}${String(candidate.params['id'] ?? 'home')}`)
}

/** Each group's tab ids, front marked with `*`. */
function tabs(layout: PaneLayout): string[][] {
  return layout.groups.map((group) => group.tabs.map((ref) => (ref === activeRef(group) ? `*${paneId(ref)}` : paneId(ref))))
}

describe('a plugin with a page strip', () => {
  it('opens every page in one tab of its own, beside the sessions rather than among them', () => {
    const layout = opened(null, 'TC-1', 'TC-2')
    expect(tabs(layout)).toEqual([['session:1', '*plugin-pages:trackr']])
    expect(strip(layout)).toEqual(['home', 'TC-1', '*TC-2'])
  })

  it('brings forward a page already open with the same parameters, with the title asked for this time', () => {
    let layout = opened(null, 'TC-1', 'TC-2')
    layout = openTab(layout, session(2))
    layout = openPluginPage(layout, 'trackr', page('TC-1', 'First'))
    expect(strip(layout)).toEqual(['home', '*TC-1', 'TC-2'])
    expect(pluginPagesTab(layout, 'trackr')!.pages[1]!.title).toBe('First')
    // The plugin's tab comes to the front of its pane too.
    expect(tabs(layout)).toEqual([['session:1', '*plugin-pages:trackr', 'session:2']])

    // No title this time keeps the one it has.
    layout = openPluginPage(openPluginPage(layout, 'trackr', page('TC-2')), 'trackr', page('TC-1'))
    expect(pluginPagesTab(layout, 'trackr')!.pages[1]!.title).toBe('First')
  })

  it('opens a page in whichever pane holds the plugin tab, not the focused one', () => {
    let layout = opened('TC-1')
    const first = layout.groups[0]!.id
    layout = splitWith(layout, 'plugin-pages:trackr', first, 'right')
    const holder = findTab(layout, 'plugin-pages:trackr')!.group
    layout = focusGroup(layout, first)
    layout = openPluginPage(layout, 'trackr', page('TC-2'))
    expect(findTab(layout, 'plugin-pages:trackr')!.group).toBe(holder)
    expect(holder).not.toBe(first)
    expect(layout.focused).toBe(holder)
    expect(strip(layout)).toEqual(['TC-1', '*TC-2'])
  })

  it('makes room for a new page past the limit by letting go of the oldest one not in front', () => {
    let layout = opened(...Array.from({ length: PLUGIN_PAGES_MAX }, (_, index) => `TC-${String(index)}`))
    layout = activatePluginPage(layout, 'trackr', pageId('TC-0'))
    layout = openPluginPage(layout, 'trackr', page('TC-new'))
    const pages = pluginPagesTab(layout, 'trackr')!.pages
    expect(pages).toHaveLength(PLUGIN_PAGES_MAX)
    expect(pages.map((candidate) => candidate.params['id'])).not.toContain('TC-1')
    expect(pages[0]!.params['id']).toBe('TC-0')
    expect(strip(layout).at(-1)).toBe('*TC-new')
  })

  it('switches pages, and a page switched to brings its tab to the front', () => {
    let layout = openTab(opened('TC-1', 'TC-2'), session(2))
    layout = activatePluginPage(layout, 'trackr', pageId('TC-1'))
    expect(strip(layout)).toEqual(['*TC-1', 'TC-2'])
    expect(tabs(layout)).toEqual([['session:1', '*plugin-pages:trackr', 'session:2']])
    // A page the strip does not hold changes nothing.
    expect(activatePluginPage(layout, 'trackr', pageId('TC-9'))).toBe(layout)
  })

  it('closes a page, handing the front to the page that slides into its place', () => {
    let layout = activatePluginPage(opened('TC-1', 'TC-2', 'TC-3'), 'trackr', pageId('TC-2'))
    layout = closePluginPage(layout, 'trackr', pageId('TC-2'))
    expect(strip(layout)).toEqual(['TC-1', '*TC-3'])
    layout = closePluginPage(layout, 'trackr', pageId('TC-3'))
    expect(strip(layout)).toEqual(['*TC-1'])
  })

  it('leaves the front alone when a page behind it closes', () => {
    const layout = closePluginPage(opened('TC-1', 'TC-2', 'TC-3'), 'trackr', pageId('TC-1'))
    expect(strip(layout)).toEqual(['TC-2', '*TC-3'])
  })

  it('closes the tab with its last page', () => {
    const layout = closePluginPage(opened('TC-1'), 'trackr', pageId('TC-1'))
    expect(tabs(layout)).toEqual([['*session:1']])
    expect(pluginPagesTab(layout, 'trackr')).toBeNull()
  })

  it('moves a page along the strip, counted after it has left its place, and brings it to the front', () => {
    let layout = movePluginPage(opened('TC-1', 'TC-2', 'TC-3'), 'trackr', pageId('TC-1'), 2)
    expect(strip(layout)).toEqual(['TC-2', 'TC-3', '*TC-1'])
    layout = movePluginPage(layout, 'trackr', pageId('TC-1'), -5)
    expect(strip(layout)).toEqual(['*TC-1', 'TC-2', 'TC-3'])
  })

  it('takes a title from the page that sets one, without moving anything', () => {
    const before = openTab(opened('TC-1', 'TC-2'), session(2))
    const after = retitlePluginSurface(before, pageId('TC-1'), 'Fix the strip')
    expect(pluginPagesTab(after, 'trackr')!.pages[0]!.title).toBe('Fix the strip')
    expect(tabs(after)).toEqual(tabs(before))
    expect(after.focused).toBe(before.focused)
    expect(retitlePluginSurface(after, pageId('TC-1'), 'Fix the strip')).toBe(after)
  })

  it("renames a plugin's own tab as it did, for a plugin without a strip", () => {
    const ref: PaneRef = { kind: 'plugin', plugin: 'sample', tab: 'item', params: {}, title: null }
    const layout = retitlePluginSurface(openTab(fromSaved(null), ref), paneId(ref), 'Second item')
    expect(layout.groups[0]!.tabs[0]).toEqual({ ...ref, title: 'Second item' })
  })

  it('names every page open, for the frames that must stay', () => {
    expect(openPluginPageIds(opened(null, 'TC-1'))).toEqual(new Set([pageId(null), pageId('TC-1')]))
    expect(openPluginPageIds(opened())).toEqual(new Set())
  })

  it('is written down and read back with its pages and the one in front', () => {
    const layout = activatePluginPage(opened('TC-1', 'TC-2'), 'trackr', pageId('TC-1'))
    const back = fromSaved(JSON.parse(JSON.stringify(toSaved(layout))) as ReturnType<typeof toSaved>)
    expect(strip(back)).toEqual(['*TC-1', 'TC-2'])
  })

  it("keeps each plugin's pages in its own tab", () => {
    let layout = opened('TC-1')
    layout = openPluginPage(layout, 'other', page('X'))
    expect(tabs(layout)).toEqual([['session:1', 'plugin-pages:trackr', '*plugin-pages:other']])
    expect(strip(layout)).toEqual(['*TC-1'])
  })
})
