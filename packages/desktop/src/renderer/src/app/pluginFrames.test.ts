import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOAD_GRACE_MS, type SurfaceSpec } from '../plugins/relay'
import { FakeChannel, received, sayHello } from '../plugins/page.testkit'
import { bridge } from './bridge.testkit'
import {
  attachPluginFrame,
  detachPluginFrame,
  disposePluginFrame,
  disposePluginFrames,
  emitToPluginFrame,
  pluginFrameSpecs,
  queueToPluginFrame,
  reloadPluginFrame,
  resetPluginFrames,
  setPluginFrameHooks,
  usePluginFrameState
} from './pluginFrames'

vi.mock('./bridge', () => import('./bridge.testkit'))

/**
 * The window's plugin frames: one iframe per surface, kept outside React and
 * moved between the slots that show it, so a page survives every re-render,
 * tab switch and pane move. The page is played by the test; the relay's own
 * protocol is `relay.test.ts`'s.
 */

const ORIGIN = 'helm-plugin://sample'

const spec = (overrides: Partial<SurfaceSpec> = {}): SurfaceSpec => ({
  key: 'panel:sample/main',
  plugin: 'sample',
  revision: 1,
  url: `${ORIGIN}/dist/panels/main.html`,
  surface: 'panel',
  name: 'main',
  params: {},
  title: 'Sample',
  ...overrides
})

/** A slot on screen, as `PluginFrame` renders one. */
function slot(): HTMLDivElement {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return element
}

const frameIn = (parent: Element): HTMLIFrameElement | null => parent.querySelector(':scope > iframe')
const parking = (): HTMLElement | null => document.querySelector('[data-plugin-parking]')

/** Chromium's state-preserving move, which jsdom does not have: here an ordinary insert, counted. */
function stubMoveBefore(): ReturnType<typeof vi.fn> {
  const move = vi.fn(function moveBefore(this: Element, node: Node, child: Node | null) {
    this.insertBefore(node, child)
  })
  Object.defineProperty(Element.prototype, 'moveBefore', { value: move, configurable: true, writable: true })
  return move
}

beforeEach(() => {
  vi.stubGlobal('MessageChannel', FakeChannel)
  // The relay's first theme read: not what these tests are about.
  bridge.whenUnanswered('pending')
})

afterEach(() => {
  resetPluginFrames()
  delete (Element.prototype as { moveBefore?: unknown }).moveBefore
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  bridge.reset()
  document.body.replaceChildren()
})

describe('attaching', () => {
  it('makes the frame in its slot, on its URL, and tells the page it is on screen', () => {
    const first = slot()
    attachPluginFrame(spec(), first)
    const element = frameIn(first)
    expect(element?.getAttribute('src')).toBe(`${ORIGIN}/dist/panels/main.html`)
    expect(element?.dataset['pluginFrame']).toBe('panel:sample/main')
    expect(sayHello(element!, ORIGIN).connect.visible).toBe(true)
    expect(pluginFrameSpecs().map((each) => each.key)).toEqual(['panel:sample/main'])
  })

  it('moves the same frame to a new slot with moveBefore, so the page is not loaded again', () => {
    const move = stubMoveBefore()
    const first = slot()
    const second = slot()
    attachPluginFrame(spec(), first)
    const element = frameIn(first)!
    const append = vi.spyOn(second, 'appendChild')

    attachPluginFrame(spec(), second)
    expect(frameIn(second)).toBe(element)
    expect(frameIn(first)).toBeNull()
    expect(move).toHaveBeenCalledWith(element, null)
    expect(append).not.toHaveBeenCalled()
    // Attaching where it already is moves nothing.
    attachPluginFrame(spec(), second)
    expect(move).toHaveBeenCalledTimes(1)
  })

  it('falls back to appending, with a warning, when the engine refuses the move', () => {
    const move = stubMoveBefore()
    move.mockImplementation(() => {
      throw new Error('HierarchyRequestError')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const first = slot()
    const second = slot()
    attachPluginFrame(spec(), first)
    const element = frameIn(first)!

    attachPluginFrame(spec(), second)
    expect(frameIn(second)).toBe(element)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('appends where there is no moveBefore at all', () => {
    const first = slot()
    const second = slot()
    attachPluginFrame(spec(), first)
    const element = frameIn(first)!
    attachPluginFrame(spec(), second)
    expect(frameIn(second)).toBe(element)
  })
})

describe('detaching', () => {
  it('parks the frame in a hidden holder in the document, and tells the page it is off screen', () => {
    stubMoveBefore()
    const first = slot()
    attachPluginFrame(spec(), first)
    const { port } = sayHello(frameIn(first)!, ORIGIN)

    detachPluginFrame('panel:sample/main', first)
    const holder = parking()
    expect(holder?.isConnected).toBe(true)
    expect(holder?.style.display).toBe('none')
    expect(holder?.querySelector('iframe[data-plugin-frame="panel:sample/main"]')).not.toBeNull()
    expect(received(port)).toEqual([{ t: 'event', name: 'visibility', data: false }])
    // Still a frame: parked is not ended.
    expect(pluginFrameSpecs()).toHaveLength(1)
  })

  it('brings the parked frame back, the same element, when a slot shows it again', () => {
    stubMoveBefore()
    const first = slot()
    attachPluginFrame(spec(), first)
    const element = frameIn(first)!
    detachPluginFrame('panel:sample/main', first)

    const again = slot()
    attachPluginFrame(spec(), again)
    expect(frameIn(again)).toBe(element)
    expect(parking()?.children).toHaveLength(0)
  })

  it('leaves alone a frame that has already moved on to another slot', () => {
    stubMoveBefore()
    const first = slot()
    const second = slot()
    attachPluginFrame(spec(), first)
    const { port } = sayHello(frameIn(first)!, ORIGIN)
    attachPluginFrame(spec(), second)

    // The old slot's cleanup runs after the new one took the frame.
    detachPluginFrame('panel:sample/main', first)
    expect(frameIn(second)).not.toBeNull()
    expect(parking()).toBeNull()
    expect(received(port)).toEqual([])
  })

  it('does not move a frame out of a slot that has already left the document', () => {
    const first = slot()
    attachPluginFrame(spec(), first)
    const element = frameIn(first)!
    first.remove()

    detachPluginFrame('panel:sample/main', first)
    expect(element.parentElement).toBe(first)
    expect(parking()).toBeNull()
  })
})

describe('ending', () => {
  it('disposing a surface removes its frame and closes the page’s connection', () => {
    const first = slot()
    attachPluginFrame(spec(), first)
    const element = frameIn(first)!
    const { port } = sayHello(element, ORIGIN)

    disposePluginFrame('panel:sample/main')
    expect(element.isConnected).toBe(false)
    expect(port.peer?.closed).toBe(true)
    expect(pluginFrameSpecs()).toEqual([])
  })

  it('disposes only the frames the predicate names', () => {
    attachPluginFrame(spec(), slot())
    attachPluginFrame(spec({ key: 'tab:sample/item', surface: 'tab', name: 'item' }), slot())
    attachPluginFrame(spec({ key: 'panel:other/main', plugin: 'other', url: 'helm-plugin://other/index.html' }), slot())

    disposePluginFrames((each) => each.plugin === 'sample')
    expect(pluginFrameSpecs().map((each) => each.key)).toEqual(['panel:other/main'])
    expect(document.querySelectorAll('iframe')).toHaveLength(1)
  })

  it('disposing before any frame was ever made does nothing', () => {
    disposePluginFrame('panel:sample/main')
    disposePluginFrames(() => true)
    reloadPluginFrame('panel:sample/main')
    expect(pluginFrameSpecs()).toEqual([])
  })
})

describe('state', () => {
  it('is null with no frame, loading once made, failed when a loaded page never says HELLO, and loading again on reload', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => usePluginFrameState('panel:sample/main'))
    expect(result.current).toBeNull()

    const first = slot()
    act(() => attachPluginFrame(spec(), first))
    expect(result.current).toEqual({ kind: 'loading' })

    const element = frameIn(first)!
    act(() => {
      element.dispatchEvent(new Event('load'))
      vi.advanceTimersByTime(LOAD_GRACE_MS)
    })
    expect(result.current).toMatchObject({ kind: 'failed', reason: 'load' })

    act(() => reloadPluginFrame('panel:sample/main'))
    expect(result.current).toEqual({ kind: 'loading' })
    // The same element, navigated again rather than replaced.
    expect(frameIn(first)).toBe(element)
  })
})

describe('events', () => {
  it('holds an event for a page that has not connected yet, and hands it over on CONNECT', () => {
    const first = slot()
    attachPluginFrame(spec(), first)
    emitToPluginFrame('panel:sample/main', 'action', { id: 'add' })

    const { port } = sayHello(frameIn(first)!, ORIGIN)
    expect(received(port)).toEqual([{ t: 'event', name: 'action', data: { id: 'add' } }])
  })

  it('makes the frame for a surface not on screen yet, holding the event until a slot shows it', () => {
    const item = spec({ key: 'tab:sample/item', surface: 'tab', name: 'item', params: { id: '2' } })
    queueToPluginFrame(item, 'command', { id: 'new' })
    expect(pluginFrameSpecs().map((each) => each.key)).toEqual(['tab:sample/item'])
    expect(document.querySelector('iframe')).toBeNull()

    const first = slot()
    attachPluginFrame(item, first)
    const { port, connect } = sayHello(frameIn(first)!, ORIGIN)
    expect(connect.context.params).toEqual({ id: '2' })
    expect(received(port)).toEqual([{ t: 'event', name: 'command', data: { id: 'new' } }])
  })
})

describe('hooks', () => {
  it("hand the window a page's unhandled keys and the titles it names its surface with", () => {
    const key = vi.fn()
    const title = vi.fn()
    setPluginFrameHooks({ key, title })
    const first = slot()
    attachPluginFrame(spec(), first)
    const element = frameIn(first)!
    const { port } = sayHello(element, ORIGIN)

    port.postMessage({ t: 'key', key: { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true } })
    port.postMessage({ t: 'title', title: '  Second item  ' })
    port.postMessage({ t: 'title', title: null })

    expect(key).toHaveBeenCalledWith(expect.objectContaining({ key: 'panel:sample/main' }), element, {
      key: 'P',
      code: 'KeyP',
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      repeat: false
    })
    expect(title.mock.calls.map(([, named]: unknown[]) => named)).toEqual(['Second item', null])
  })
})
