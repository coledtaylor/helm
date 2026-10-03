import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPane, type BrowserPaneProps, type BrowserPaneState } from './BrowserPane'

const STATE: BrowserPaneState = {
  id: 7,
  url: 'http://localhost:3000/',
  title: 'Dev server',
  host: 'localhost:3000',
  canGoBack: true,
  canGoForward: false,
  loading: false,
  problem: null,
  retryingUntil: null,
  zoomLevel: 0,
  errors: 0,
  devtoolsOpen: false,
  find: null,
  project: null
}

const RECENT = ['http://localhost:3000/b', 'http://localhost:5173/', 'https://example.com/docs']

/**
 * jsdom does no layout, so the placeholder's box is emulated: the space the
 * pane gives it, narrowed by a `max-width` the way CSS narrows a block. That is
 * all a width preset is, and it is enough to follow a preset through to the
 * rectangle the pane reports.
 */
let space = { x: 16, y: 120, width: 1200, height: 600 }
let resized: Array<() => void> = []

beforeEach(() => {
  space = { x: 16, y: 120, width: 1200, height: 600 }
  resized = []
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const max = Number.parseFloat(this.style.maxWidth)
    const width = Number.isFinite(max) ? Math.min(space.width, max) : space.width
    return { ...space, width, top: space.y, left: space.x, right: space.x + width, bottom: space.y + space.height, toJSON: () => ({}) }
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resized.push(callback)
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderPane(overrides: Partial<BrowserPaneProps> = {}): BrowserPaneProps {
  const props: BrowserPaneProps = {
    state: STATE,
    entries: [],
    onBounds: vi.fn(),
    onNavigate: vi.fn(),
    onBack: vi.fn(),
    onForward: vi.fn(),
    onReload: vi.fn(),
    onDevTools: vi.fn(),
    onOpenExternal: vi.fn(),
    onFind: vi.fn(),
    onStopFind: vi.fn(),
    onZoom: vi.fn(),
    onClearStorage: vi.fn(),
    onEvaluate: vi.fn(() => Promise.resolve({ ok: true, value: '', error: null })),
    onCovering: vi.fn(),
    recent: RECENT,
    focusAddressAt: 0,
    ...overrides
  }
  render(<BrowserPane {...props} />)
  return props
}

const address = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Address' })
const lastCall = <T,>(fn: unknown): T => (fn as { mock: { calls: T[][] } }).mock.calls.at(-1)![0]!

describe('BrowserPane - the address bar', () => {
  it('opens the recent addresses on a click, in order, and the view stands down until Escape', async () => {
    const user = userEvent.setup()
    const props = renderPane()
    expect(screen.queryByRole('list')).toBeNull()

    await user.click(address())
    const list = screen.getByRole('list')
    expect(within(list).getAllByRole('button').map((button) => button.textContent)).toEqual(RECENT)
    expect(lastCall<boolean>(props.onCovering)).toBe(true)

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('list')).toBeNull()
    expect(lastCall<boolean>(props.onCovering)).toBe(false)
  })

  it('opens nothing over the page when there is nothing to list', async () => {
    const user = userEvent.setup()
    const props = renderPane({ recent: [] })
    await user.click(address())
    expect(screen.queryByRole('list')).toBeNull()
    expect(props.onCovering).not.toHaveBeenCalledWith(true)
  })

  it('goes to a recent address when one is chosen', async () => {
    const user = userEvent.setup()
    const props = renderPane()
    await user.click(address())
    await user.click(within(screen.getByRole('list')).getByRole('button', { name: 'http://localhost:5173/' }))
    expect(props.onNavigate).toHaveBeenCalledWith('http://localhost:5173/')
    expect(screen.queryByRole('list')).toBeNull()
  })

  it("goes where Enter says, and then shows the page's own address again", async () => {
    const user = userEvent.setup()
    const props = renderPane()
    expect(address().value).toBe('http://localhost:3000/')
    await user.clear(address())
    await user.type(address(), 'localhost:5173{Enter}')
    expect(props.onNavigate).toHaveBeenCalledWith('localhost:5173')
    expect(address().value).toBe('http://localhost:3000/')
  })

  it('paints what is wrong with the tab as a sentence', () => {
    const problem = '"what is this" is not an address. Helm\'s browser never searches - type a URL.'
    renderPane({ state: { ...STATE, problem } })
    expect(screen.getByRole('status').textContent).toBe(problem)
  })
})

describe('BrowserPane - the controls', () => {
  it('goes back, and cannot go forward with nowhere to go', async () => {
    const user = userEvent.setup()
    const props = renderPane()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(props.onBack).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: 'Forward' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('reloads, and ignores the cache with Shift held', async () => {
    const user = userEvent.setup()
    const props = renderPane()
    const reload = screen.getByRole('button', { name: 'Reload (hold Shift to ignore the cache)' })
    await user.click(reload)
    await user.keyboard('{Shift>}')
    await user.click(reload)
    await user.keyboard('{/Shift}')
    expect(vi.mocked(props.onReload).mock.calls).toEqual([[false], [true]])
  })

  it('zooms by half a step and reads the level as a percentage', async () => {
    const user = userEvent.setup()
    const props = renderPane({ state: { ...STATE, zoomLevel: 1 } })
    const zoom = screen.getByRole('group', { name: 'Zoom' })
    expect(zoom.textContent).toContain('120%')
    await user.click(within(zoom).getByRole('button', { name: 'Zoom in' }))
    await user.click(within(zoom).getByRole('button', { name: 'Zoom out' }))
    expect(vi.mocked(props.onZoom).mock.calls).toEqual([[1.5], [0.5]])
  })

  it('clears the browsing data when asked', async () => {
    const user = userEvent.setup()
    const props = renderPane()
    await user.click(screen.getByRole('button', { name: 'Clear storage' }))
    expect(props.onClearStorage).toHaveBeenCalledTimes(1)
  })

  it('finds in the page as it is typed, steps with Enter, and stops on Escape', async () => {
    const user = userEvent.setup()
    const props = renderPane({ state: { ...STATE, find: { query: 'tok', matches: 3, active: 1 } } })
    await user.click(screen.getByRole('button', { name: 'Find in page' }))
    const field = screen.getByRole('textbox', { name: 'Find in page' })
    await user.type(field, 'tok')
    expect(lastCall<string>(props.onFind)).toBe('tok')
    expect(screen.getByText('1 / 3')).toBeTruthy()

    await user.keyboard('{Enter}')
    expect(vi.mocked(props.onFind).mock.calls.at(-1)).toEqual(['tok', true])
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(vi.mocked(props.onFind).mock.calls.at(-1)).toEqual(['tok', false])

    await user.keyboard('{Escape}')
    expect(props.onStopFind).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('textbox', { name: 'Find in page' })).toBeNull()
  })

  it('stops finding when the find button is pressed again', async () => {
    const user = userEvent.setup()
    const props = renderPane()
    await user.click(screen.getByRole('button', { name: 'Find in page' }))
    await user.click(screen.getByRole('button', { name: 'Find in page' }))
    expect(props.onStopFind).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('textbox', { name: 'Find in page' })).toBeNull()
  })

  it("has a console that evaluates in the page", async () => {
    const user = userEvent.setup()
    renderPane()
    await user.click(screen.getByRole('button', { name: /^Console/ }))
    expect(screen.getByRole('textbox', { name: 'Evaluate JavaScript in the page' })).toBeTruthy()
  })
})

describe('BrowserPane - where the view goes', () => {
  it('reports the placeholder on mount, on a resize of it, and on a window resize', () => {
    const props = renderPane()
    expect(lastCall(props.onBounds)).toEqual({ x: 16, y: 120, width: 1200, height: 600 })

    // A split drag narrows the pane.
    space = { ...space, width: 900 }
    act(() => {
      for (const callback of resized) callback()
    })
    expect(lastCall(props.onBounds)).toEqual({ x: 16, y: 120, width: 900, height: 600 })

    // The window moves the pane down without resizing it.
    space = { ...space, y: 160 }
    fireEvent(window, new Event('resize'))
    expect(lastCall(props.onBounds)).toEqual({ x: 16, y: 160, width: 900, height: 600 })
  })

  it('narrows the view to a phone and back to the full pane', async () => {
    const user = userEvent.setup()
    const props = renderPane()
    const widths = screen.getByRole('group', { name: 'Viewport width' })
    expect(within(widths).getByRole('button', { name: 'Full' }).getAttribute('aria-pressed')).toBe('true')

    await user.click(within(widths).getByRole('button', { name: 'Phone' }))
    expect(within(widths).getByRole('button', { name: 'Phone' }).getAttribute('aria-pressed')).toBe('true')
    expect(lastCall<{ width: number }>(props.onBounds).width).toBe(390)

    await user.click(within(widths).getByRole('button', { name: 'Full' }))
    expect(lastCall<{ width: number }>(props.onBounds).width).toBe(1200)
  })
})
