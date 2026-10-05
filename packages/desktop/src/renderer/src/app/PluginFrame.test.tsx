import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CRASH_GRACE_MS, LOAD_GRACE_MS, type SurfaceSpec } from '../plugins/relay'
import { FakeChannel, sayHello, type FakePort } from '../plugins/page.testkit'
import { bridge } from './bridge.testkit'
import { PluginFrame } from './PluginFrame'
import { pluginFrameSpecs, resetPluginFrames } from './pluginFrames'

vi.mock('./bridge', () => import('./bridge.testkit'))

/**
 * Where a plugin surface appears: the slot its frame is put in, and the
 * failure drawn in the surface's own place when the page does not load or its
 * process ends.
 */

const ORIGIN = 'helm-plugin://sample'

const spec = (overrides: Partial<SurfaceSpec> = {}): SurfaceSpec => ({
  key: 'tab:sample/item',
  plugin: 'sample',
  revision: 1,
  url: `${ORIGIN}/dist/tabs/item.html`,
  surface: 'tab',
  name: 'item',
  params: { id: '2' },
  title: 'Second item',
  ...overrides
})

const frame = (): HTMLIFrameElement => {
  const element = document.querySelector<HTMLIFrameElement>('[data-plugin-slot] > iframe')
  if (element === null) throw new Error('no frame in the slot')
  return element
}

const failure = (): HTMLElement | null => document.querySelector('[data-plugin-error]')

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('MessageChannel', FakeChannel)
  bridge.whenUnanswered('pending')
})

afterEach(() => {
  resetPluginFrames()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  bridge.reset()
})

/** The page loads and never says HELLO: what a missing or unbuilt page looks like. */
function neverAnswers(): void {
  act(() => {
    frame().dispatchEvent(new Event('load'))
    vi.advanceTimersByTime(LOAD_GRACE_MS)
  })
}

describe('PluginFrame', () => {
  it('puts the surface’s frame in its slot and draws nothing over a page that is loading or connected', () => {
    render(<PluginFrame spec={spec()} pluginName="Sample" />)
    expect(frame().getAttribute('src')).toBe(`${ORIGIN}/dist/tabs/item.html`)
    expect(failure()).toBeNull()
    act(() => {
      sayHello(frame(), ORIGIN)
    })
    expect(failure()).toBeNull()
  })

  it('parks the frame when it unmounts rather than ending the page', () => {
    const { unmount } = render(<PluginFrame spec={spec()} pluginName="Sample" />)
    const element = frame()
    unmount()
    expect(element.isConnected).toBe(true)
    expect(element.closest('[data-plugin-parking]')).not.toBeNull()
    expect(pluginFrameSpecs().map((each) => each.key)).toEqual(['tab:sample/item'])
  })

  it('keeps the same page through a re-render with an equal spec in a new object', () => {
    const { rerender } = render(<PluginFrame spec={spec()} pluginName="Sample" />)
    const element = frame()
    act(() => {
      sayHello(element, ORIGIN)
    })
    rerender(<PluginFrame spec={spec({ params: { id: '2' } })} pluginName="Sample" />)
    expect(frame()).toBe(element)
    neverAnswers()
    // Connected, and never told to load again: no failure to draw.
    expect(failure()).toBeNull()
  })

  it('says a page that never answered did not load, and offers Reload and the plugin’s settings', () => {
    const onOpenSettings = vi.fn()
    render(<PluginFrame spec={spec()} pluginName="Sample" onOpenSettings={onOpenSettings} />)
    neverAnswers()

    expect(failure()?.textContent).toContain('Sample did not load')
    expect(failure()?.textContent).toContain('The page did not load. It may be missing from the plugin folder, or still being built.')
    fireEvent.click(screen.getByRole('button', { name: 'Plugin settings' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(failure()).toBeNull()
  })

  it('says a page whose process ended stopped', () => {
    render(<PluginFrame spec={spec()} pluginName="Sample" />)
    let port: FakePort | undefined
    act(() => {
      port = sayHello(frame(), ORIGIN).port
    })
    act(() => {
      port?.close()
      vi.advanceTimersByTime(CRASH_GRACE_MS)
    })

    expect(failure()?.textContent).toContain('Sample stopped')
    expect(failure()?.textContent).toContain('The page ended unexpectedly.')
  })

  it('has no Plugin settings button when there is nowhere to send it', () => {
    render(<PluginFrame spec={spec()} pluginName="Sample" />)
    neverAnswers()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Plugin settings' })).toBeNull()
  })

  it('loads the page again for a new revision of its plugin', () => {
    const { rerender } = render(<PluginFrame spec={spec()} pluginName="Sample" />)
    const element = frame()
    neverAnswers()
    expect(failure()).not.toBeNull()

    rerender(<PluginFrame spec={spec({ revision: 2 })} pluginName="Sample" />)
    expect(failure()).toBeNull()
    expect(frame()).toBe(element)
  })
})
