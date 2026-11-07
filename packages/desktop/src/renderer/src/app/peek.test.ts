import {
  LOCAL_HOST_KEY,
  fromSaved,
  groupById,
  openTab,
  paneId,
  sessionRef,
  type PaneLayout,
  type SavedPane
} from '@helm/core/types'
import { describe, expect, it } from 'vitest'
import { REPLAY_LIMIT, createPeek, openChildTab, type PeekDeps } from './peek'

/** A host's watch-only streams as the store opens them: what was opened, and the way to push bytes or end one. */
function world(options: { stop?: (host: string, id: number) => Promise<boolean> } = {}) {
  const opened: Array<{
    host: string
    id: number
    closedHere: boolean
    data: (text: string) => void
    closed: (reason: string | null) => void
  }> = []
  const tabs: Array<{ host: string; id: number }> = []
  const stops: Array<{ host: string; id: number }> = []
  const deps: PeekDeps = {
    watch: (host, id, handlers) => {
      const stream = { host, id, closedHere: false, ...handlers }
      opened.push(stream)
      return () => {
        stream.closedHere = true
      }
    },
    stop: (host, id) => {
      stops.push({ host, id })
      return (options.stop ?? (() => Promise.resolve(true)))(host, id)
    },
    openTab: (host, id) => {
      tabs.push({ host, id })
    }
  }
  return { store: createPeek(deps), opened, tabs, stops }
}

describe('the peek', () => {
  it('S1: opens on a child from its row and watches only that child, on a stream of its own', () => {
    const { store, opened } = world()
    store.open(LOCAL_HOST_KEY, 8, { kind: 'row' })
    expect(store.get()).toEqual({ host: LOCAL_HOST_KEY, id: 8, anchor: { kind: 'row' } })
    expect(opened.map(({ host, id }) => ({ host, id }))).toEqual([{ host: LOCAL_HOST_KEY, id: 8 }])
  })

  it('S7: opens from a chip in the parent’s crumb, and a second press on the same child keeps its stream', () => {
    const { store, opened } = world()
    store.open('devbox', 8, { kind: 'chip', parentId: 3 })
    store.open('devbox', 8, { kind: 'chip', parentId: 3 })
    expect(opened).toHaveLength(1)
    store.open('devbox', 8, { kind: 'row' })
    expect(opened).toHaveLength(1)
    expect(store.get()?.anchor).toEqual({ kind: 'row' })
  })

  it('closes the stream of the child it leaves when another child is peeked, and when it closes', () => {
    const { store, opened } = world()
    store.open(LOCAL_HOST_KEY, 8, { kind: 'row' })
    store.open(LOCAL_HOST_KEY, 9, { kind: 'row' })
    expect(opened.map((each) => each.closedHere)).toEqual([true, false])
    store.close()
    expect(store.get()).toBeNull()
    expect(opened.map((each) => each.closedHere)).toEqual([true, true])
  })

  it('S1: hands a terminal that mounts after it opened the screen the host started with, then each chunk live', () => {
    const { store, opened } = world()
    store.open(LOCAL_HOST_KEY, 8, { kind: 'row' })
    opened[0]?.data('\x1b[H\x1b[2Jscreen as it is')
    const drawn: string[] = []
    store.attach((text) => drawn.push(text))
    opened[0]?.data(' and more')
    expect(drawn).toEqual(['\x1b[H\x1b[2Jscreen as it is', ' and more'])
  })

  it('keeps no more than the replay limit of the child’s output for a terminal that mounts late', () => {
    const { store, opened } = world()
    store.open(LOCAL_HOST_KEY, 8, { kind: 'row' })
    const chunk = 'x'.repeat(REPLAY_LIMIT / 4)
    for (let i = 0; i < 8; i++) opened[0]?.data(chunk)
    const drawn: string[] = []
    store.attach((text) => drawn.push(text))
    expect(drawn.join('').length).toBeLessThanOrEqual(REPLAY_LIMIT)
    expect(drawn.join('').length).toBeGreaterThan(0)
  })

  it('closes when the host ends its stream: the child ended, or the connection went', () => {
    const { store, opened } = world()
    store.open(LOCAL_HOST_KEY, 8, { kind: 'row' })
    let told = 0
    store.subscribe(() => told++)
    opened[0]?.closed(null)
    expect(store.get()).toBeNull()
    expect(told).toBe(1)
  })

  it('S3: closes when its child is shown here, as a tab, a card or a header, and stays for a chip or nowhere', () => {
    for (const place of ['tab', 'card', 'header'] as const) {
      const { store } = world()
      store.open(LOCAL_HOST_KEY, 8, { kind: 'row' })
      store.reconcile({ place: 'nowhere', running: true })
      store.reconcile({ place: 'chip', running: true })
      expect(store.get()).not.toBeNull()
      store.reconcile({ place, running: true })
      expect(store.get()).toBeNull()
    }
  })

  it('closes when its child ends or is no longer listed', () => {
    const ended = world()
    ended.store.open(LOCAL_HOST_KEY, 8, { kind: 'row' })
    ended.store.reconcile({ place: 'nowhere', running: false })
    expect(ended.store.get()).toBeNull()
    const gone = world()
    gone.store.open(LOCAL_HOST_KEY, 8, { kind: 'row' })
    gone.store.reconcile(null)
    expect(gone.store.get()).toBeNull()
  })

  it('S5: Stop ends the child once the user agrees to the question, and closes the peek', async () => {
    const { store, stops, opened } = world()
    store.open('devbox', 8, { kind: 'row' })
    await store.stop()
    expect(stops).toEqual([{ host: 'devbox', id: 8 }])
    expect(store.get()).toBeNull()
    expect(opened[0]?.closedHere).toBe(true)
  })

  it('S5: leaves the peek open and the child running when the user declines the question', async () => {
    const { store, stops } = world({ stop: () => Promise.resolve(false) })
    store.open(LOCAL_HOST_KEY, 8, { kind: 'row' })
    await store.stop()
    expect(stops).toEqual([{ host: LOCAL_HOST_KEY, id: 8 }])
    expect(store.get()).not.toBeNull()
  })

  it('S6: Open gives the child a tab and closes the peek and its stream', () => {
    const { store, tabs, opened } = world()
    store.open('devbox', 8, { kind: 'chip', parentId: 3 })
    store.openAsTab()
    expect(tabs).toEqual([{ host: 'devbox', id: 8 }])
    expect(store.get()).toBeNull()
    expect(opened[0]?.closedHere).toBe(true)
  })

  it('S4: has no way to type into the child or to size it', () => {
    const { store } = world()
    expect(Object.keys(store).sort()).toEqual(
      ['attach', 'close', 'get', 'open', 'openAsTab', 'reconcile', 'setDeps', 'stop', 'subscribe'].sort()
    )
  })
})

describe('where Open gives a peeked child its tab', () => {
  /** Two panes side by side: the first holds `left`, the second `right`; the first is focused. */
  const twoPanes = (left: SavedPane[], right: SavedPane[]): PaneLayout =>
    fromSaved({
      root: {
        axis: 'row',
        sizes: [50, 50],
        children: [
          { panes: left, activeId: null },
          { panes: right, activeId: null }
        ]
      },
      focused: 0
    })
  const tabsOf = (layout: PaneLayout, id: number, host = LOCAL_HOST_KEY): string[] =>
    layout.groups.find((group) => group.tabs.some((tab) => paneId(tab) === paneId(sessionRef(id, host))))?.tabs.map(paneId) ??
    []

  it('S6: is the pane strip that holds the parent’s tab when it is open here, in front', () => {
    const layout = twoPanes([sessionRef(5)], [sessionRef(1)])
    const opened = openChildTab(layout, LOCAL_HOST_KEY, { id: 2, parentId: 1 })
    expect(tabsOf(opened, 2)).toEqual([paneId(sessionRef(1)), paneId(sessionRef(2))])
    const group = opened.groups.find((each) => each.tabs.some((tab) => paneId(tab) === paneId(sessionRef(2))))!
    expect(groupById(opened, group.id)?.activeId).toBe(paneId(sessionRef(2)))
    expect(opened.focused).toBe(group.id)
  })

  it('S6: is the focused pane when the parent’s tab is not open here', () => {
    const layout = twoPanes([sessionRef(5)], [sessionRef(6)])
    const opened = openChildTab(layout, LOCAL_HOST_KEY, { id: 2, parentId: 1 })
    expect(tabsOf(opened, 2)).toEqual([paneId(sessionRef(5)), paneId(sessionRef(2))])
    expect(opened.focused).toBe(layout.focused)
  })

  it('names the parent on the child’s own host, not another host’s session of the same number', () => {
    const layout = twoPanes([sessionRef(5)], [sessionRef(1, 'devbox')])
    expect(tabsOf(openChildTab(layout, LOCAL_HOST_KEY, { id: 2, parentId: 1 }), 2)).toEqual([
      paneId(sessionRef(5)),
      paneId(sessionRef(2))
    ])
    expect(tabsOf(openChildTab(layout, 'devbox', { id: 2, parentId: 1 }), 2, 'devbox')).toEqual([
      paneId(sessionRef(1, 'devbox')),
      paneId(sessionRef(2, 'devbox'))
    ])
  })

  it('brings a child that already has a tab forward where it is, and opens no second', () => {
    const layout = openTab(twoPanes([sessionRef(5)], [sessionRef(1)]), sessionRef(2))
    const again = openChildTab(layout, LOCAL_HOST_KEY, { id: 2, parentId: 1 })
    expect(again.groups.flatMap((group) => group.tabs).filter((tab) => paneId(tab) === paneId(sessionRef(2)))).toHaveLength(1)
  })
})
