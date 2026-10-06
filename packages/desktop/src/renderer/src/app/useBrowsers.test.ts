import { createElement } from 'react'
import { act, render, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Overlay } from '@helm/ui'
import type { BrowserBounds, BrowserState } from '../../../shared/ipc'
import { bridge } from './bridge.testkit'
import { useBrowsers } from './useBrowsers'

vi.mock('./bridge', () => import('./bridge.testkit'))

const RECT = { x: 16, y: 120, width: 900, height: 600 }

const view = (id: number): BrowserState => ({
  id,
  url: 'http://localhost:3000/',
  title: 'Dev server',
  host: 'localhost:3000',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  problem: null,
  retryingUntil: null,
  zoomLevel: 0,
  errors: 0,
  devtoolsOpen: false,
  find: null,
  project: null,
  openedBy: null
})

/** A page main made, as `browser:opened` says it. */
const opened = (id: number, after: number | null = null, background = false) => ({
  state: view(id),
  after,
  background
})

/** Every `browser:bounds` the hook has sent since the last clear. */
const bounds = (): BrowserBounds[] => bridge.sent('browser:bounds')

beforeEach(() => {
  bridge.reset()
  // Main holds no views and has logged nothing.
  bridge.answer('browser:state', () => [])
  bridge.answer('browser:console', () => [])
})

describe('useBrowsers - whether the native view paints', () => {
  it('reports where the placeholder is and that the view should paint', () => {
    const { result } = renderHook(() => useBrowsers([]))
    act(() => result.current.sendBounds(3, RECT, true))
    expect(bounds()).toEqual([{ id: 3, ...RECT, visible: true }])
  })

  it('stands every view down while a dialog is up, subscribed once however often it renders', () => {
    const { result, rerender } = renderHook(() => useBrowsers([]))
    act(() => {
      result.current.sendBounds(3, RECT, true)
      result.current.sendBounds(4, { ...RECT, x: 940 }, true)
    })
    rerender()
    rerender()
    bridge.clearRecords()

    // A real dialog, through the one component every dialog is drawn with.
    const dialog = render(createElement(Overlay, { onDismiss: () => undefined, children: 'A dialog' }))
    expect(bounds()).toEqual([
      { id: 3, ...RECT, visible: false },
      { id: 4, ...RECT, x: 940, visible: false }
    ])

    bridge.clearRecords()
    dialog.unmount()
    expect(bounds()).toEqual([
      { id: 3, ...RECT, visible: true },
      { id: 4, ...RECT, x: 940, visible: true }
    ])
  })

  it('stands a view down when its tab goes behind another, and puts it back where it was', () => {
    const { result } = renderHook(() => useBrowsers([]))
    act(() => result.current.sendBounds(3, RECT, true))
    bridge.clearRecords()

    act(() => result.current.setShowing(3, false))
    expect(bounds()).toEqual([{ id: 3, ...RECT, visible: false }])
    act(() => result.current.setShowing(3, false))
    expect(bounds()).toHaveLength(1)
    act(() => result.current.setShowing(3, true))
    expect(bounds().at(-1)).toEqual({ id: 3, ...RECT, visible: true })

    // A view that never reported a rectangle has nowhere to be put back to.
    act(() => result.current.setShowing(9, true))
    expect(bounds().map((sent) => sent['id'])).not.toContain(9)
  })

  it('takes every view off the screen for a tab drag or the address dropdown, and back after', () => {
    const { result } = renderHook(() => useBrowsers([]))
    act(() => {
      result.current.sendBounds(3, RECT, true)
      result.current.sendBounds(4, RECT, true)
    })
    bridge.clearRecords()

    act(() => result.current.setSuppressed('tab-drag', true))
    expect(bounds().map((sent) => sent['visible'])).toEqual([false, false])
    // A resize mid-drag still reports the view hidden.
    act(() => result.current.sendBounds(3, { ...RECT, width: 800 }, true))
    expect(bounds().at(-1)).toEqual({ id: 3, ...RECT, width: 800, visible: false })

    bridge.clearRecords()
    act(() => result.current.setSuppressed('tab-drag', false))
    expect(bounds()).toEqual([
      { id: 3, ...RECT, width: 800, visible: true },
      { id: 4, ...RECT, visible: true }
    ])
  })

  it('holds each reason on its own, so the dropdown closing does not end a drag', () => {
    const { result } = renderHook(() => useBrowsers([]))
    act(() => result.current.sendBounds(3, RECT, true))
    act(() => result.current.setSuppressed('tab-drag', true))
    act(() => result.current.setSuppressed('address-list', true))
    bridge.clearRecords()

    // A browser pane mounting says its list is not open.
    act(() => result.current.setSuppressed('address-list', false))
    expect(bounds().map((sent) => sent['visible'])).toEqual([false])
    act(() => result.current.setSuppressed('tab-drag', false))
    expect(bounds().map((sent) => sent['visible'])).toEqual([false, true])
  })
})

describe('useBrowsers - the mirror of what main holds', () => {
  it('adds a tab main opened and drops one main closed, rectangle and all', () => {
    const { result } = renderHook(() => useBrowsers([]))
    act(() => bridge.emit('browser:opened', opened(5)))
    expect([...result.current.views.keys()]).toEqual([5])
    act(() => result.current.sendBounds(5, RECT, true))

    act(() => bridge.emit('browser:closed', { id: 5 }))
    expect(result.current.views.size).toBe(0)
    bridge.clearRecords()
    act(() => result.current.setShowing(5, false))
    expect(bounds()).toEqual([])
  })

  it('puts a failed call on the tab problem line rather than nowhere', async () => {
    const { result } = renderHook(() => useBrowsers([]))
    act(() => bridge.emit('browser:opened', opened(5)))
    bridge.answer('browser:navigate', () => {
      throw new Error('the main process said no')
    })
    act(() => result.current.navigate(5, 'localhost:3000'))
    await waitFor(() =>
      expect(result.current.views.get(5)?.problem).toBe('Helm could not navigate this tab: the main process said no')
    )
  })
})

describe('useBrowsers - the Browser tab strip', () => {
  it('puts a page beside the page that opened it, in front unless it was a middle click', () => {
    const { result } = renderHook(() => useBrowsers([]))
    act(() => {
      bridge.emit('browser:opened', opened(1))
      bridge.emit('browser:opened', opened(2))
    })
    expect(result.current.pages).toEqual([1, 2])
    expect(result.current.active).toBe(2)

    act(() => bridge.emit('browser:opened', opened(3, 1)))
    expect(result.current.pages).toEqual([1, 3, 2])
    expect(result.current.active).toBe(3)

    act(() => bridge.emit('browser:opened', opened(4, 1, true)))
    expect(result.current.pages).toEqual([1, 3, 4, 2])
    expect(result.current.active).toBe(3)
  })

  it('hands the front back to the opener when a page in front closes itself', () => {
    const { result } = renderHook(() => useBrowsers([]))
    act(() => {
      bridge.emit('browser:opened', opened(1))
      bridge.emit('browser:opened', opened(2))
      result.current.activate(1)
      bridge.emit('browser:opened', opened(3, 1))
    })
    expect(result.current.pages).toEqual([1, 3, 2])
    act(() => bridge.emit('browser:closed', { id: 3 }))
    expect(result.current.active).toBe(1)
  })

  it('adopts what main holds after a reload, and closes every page with the tab', () => {
    bridge.answer('browser:state', () => [view(7), view(8)])
    const { result } = renderHook(() => useBrowsers([]))
    return waitFor(() => expect(result.current.pages).toEqual([7, 8])).then(() => {
      expect(result.current.active).toBe(8)
      act(() => result.current.move(8, 0))
      expect(result.current.pages).toEqual([8, 7])
      act(() => result.current.closeAll())
      expect(result.current.pages).toEqual([])
      expect(bridge.invoked('browser:close').map((call) => call.id).sort()).toEqual([7, 8])
    })
  })
})
