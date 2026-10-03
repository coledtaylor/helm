import { describe, expect, it } from 'vitest'
import { overlayMounted, overlayOpen, subscribeOverlay } from './overlay'

/**
 * "Is a dialog up" - the one question the browser pane's native view hides on.
 */
describe('overlay', () => {
  it('is open while any overlay is up, counting rather than flagging', () => {
    expect(overlayOpen()).toBe(false)
    const releaseFirst = overlayMounted()
    expect(overlayOpen()).toBe(true)
    const releaseSecond = overlayMounted()

    // The first of two closing leaves the second still up.
    releaseFirst()
    expect(overlayOpen()).toBe(true)
    releaseSecond()
    expect(overlayOpen()).toBe(false)
  })

  it('releases once however often the cleanup runs, as StrictMode runs it', () => {
    const releaseFirst = overlayMounted()
    const releaseSecond = overlayMounted()
    releaseFirst()
    releaseFirst()
    expect(overlayOpen()).toBe(true)
    releaseSecond()
    expect(overlayOpen()).toBe(false)
  })

  it('tells a subscriber each time an overlay comes and goes, until it unsubscribes', () => {
    const seen: boolean[] = []
    const unsubscribe = subscribeOverlay(() => seen.push(overlayOpen()))
    const release = overlayMounted()
    release()
    expect(seen).toEqual([true, false])

    unsubscribe()
    overlayMounted()()
    expect(seen).toEqual([true, false])
  })
})
