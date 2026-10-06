import type { JSX } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
  project: null,
  openedBy: null,
  openerRunning: false,
  sharedWith: null
}

const TARGETS = [
  { session: 1, name: 'alpha' },
  { session: 2, name: 'beta' }
]

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
    focusRequest: null,
    onFocusRequestDone: vi.fn(),
    searchEngine: 'Google',
    still: null,
    canShare: true,
    onShareTargets: vi.fn(() => Promise.resolve(TARGETS)),
    onShare: vi.fn(),
    ...overrides
  }
  redraw = render(<BrowserPane {...props} />).rerender
  return props
}

/** Draws the pane rendered last again, as the window does on any change of its own. */
let redraw: (ui: JSX.Element) => void = () => undefined

const address = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Address' })

/** The overflow menu, opened. */
async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'More' }))
  return screen.getByRole('menu', { name: 'Browser' })
}

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

  it('says the list is open once, however often the pane is drawn while it is', async () => {
    const user = userEvent.setup()
    const first = vi.fn()
    const props = renderPane({ onCovering: first })
    await user.click(address())
    const opened = [...first.mock.calls]
    expect(opened.at(-1)).toEqual([true])

    // The window draws the pane again with a new callback - a still of the
    // page arriving does exactly this - and the list is still open.
    const next = vi.fn()
    redraw(<BrowserPane {...props} onCovering={next} />)
    redraw(<BrowserPane {...props} onCovering={next} still="data:image/png;base64,cGFnZQ==" />)
    expect(first.mock.calls).toEqual(opened)
    expect(next).not.toHaveBeenCalled()
    expect(screen.getByRole('list')).toBeTruthy()

    // Closing it is said to the callback the pane has now.
    await user.keyboard('{Escape}')
    expect(lastCall<boolean>(next)).toBe(false)
    expect(next).not.toHaveBeenCalledWith(true)
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
    const problem = 'Nothing is listening at http://localhost:3000/.'
    renderPane({ state: { ...STATE, problem } })
    expect(screen.getByRole('status').textContent).toBe(problem)
  })

  it('says in the empty bar whether a phrase will be searched', () => {
    renderPane({ state: { ...STATE, url: '' } })
    expect(address().placeholder).toBe('Search Google or type an address')
  })

  it('says only addresses go there when searching is off', () => {
    renderPane({ state: { ...STATE, url: '' }, searchEngine: null })
    expect(address().placeholder).toBe('Address, or a port number')
  })

  it('takes the caret into the address bar or the find field when asked, once', () => {
    const asked = renderPane({ focusRequest: 'address' })
    expect(document.activeElement).toBe(address())
    expect(asked.onFocusRequestDone).toHaveBeenCalledTimes(1)
  })

  it('opens the find field for Ctrl+F with the caret in it', () => {
    const asked = renderPane({ focusRequest: 'find' })
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Find in page' }))
    expect(asked.onFocusRequestDone).toHaveBeenCalledTimes(1)
  })

  it('takes nothing when nothing asked, so a page coming to the front leaves the caret alone', () => {
    const asked = renderPane()
    expect(document.activeElement).not.toBe(address())
    expect(asked.onFocusRequestDone).not.toHaveBeenCalled()
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

  it('keeps a slim bar: zoom, width, DevTools and clearing data are in the menu, not on it', () => {
    renderPane()
    const bar = document.querySelector<HTMLElement>('[data-browser-bar]')!
    expect(within(bar).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Back',
      'Forward',
      'Reload (hold Shift to ignore the cache)',
      'Share with a session',
      'Find in page',
      'Open in your own browser',
      'More'
    ])
  })

  describe('sharing', () => {
    const shareButton = (): HTMLElement | null => document.querySelector('[data-browser="share"]')

    /** The Share menu, opened, once the sessions have been asked for. */
    async function openShare(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
      await user.click(shareButton()!)
      return screen.findByRole('menu', { name: 'Share' })
    }

    it("offers a page of the user's, and never an agent's page, an empty one, or anything with the tools off", () => {
      for (const [overrides, offered] of [
        [{}, true],
        [{ canShare: false }, false],
        [{ state: { ...STATE, openedBy: 'alpha', openerRunning: true } }, false],
        [{ state: { ...STATE, url: '' } }, false]
      ] as const) {
        cleanup()
        renderPane(overrides)
        expect(shareButton() !== null, JSON.stringify(overrides)).toBe(offered)
      }
    })

    it('asks for the sessions as the menu opens, and shares with the one picked', async () => {
      const user = userEvent.setup()
      const props = renderPane()
      expect(props.onShareTargets).not.toHaveBeenCalled()
      const menu = await openShare(user)
      expect(props.onShareTargets).toHaveBeenCalledTimes(1)
      expect(menu.textContent).toContain('Share with')
      expect(within(menu).queryByRole('menuitem', { name: 'Stop sharing' })).toBeNull()
      await user.click(within(menu).getByRole('menuitemcheckbox', { name: /beta/ }))
      expect(props.onShare).toHaveBeenCalledWith(2)
      expect(screen.queryByRole('menu', { name: 'Share' })).toBeNull()
    })

    it('says who a shared page is shared with, ticks them, and stops sharing from the menu', async () => {
      const user = userEvent.setup()
      const props = renderPane({ state: { ...STATE, sharedWith: { session: 1, name: 'alpha' } } })
      expect(shareButton()!.querySelector('span > span:not([aria-hidden])')?.textContent).toBe('Shared')
      expect(shareButton()!.getAttribute('aria-label')).toBe('Shared with alpha')

      let menu = await openShare(user)
      expect(within(menu).getByRole('menuitemcheckbox', { name: /alpha/ }).getAttribute('aria-checked')).toBe('true')
      expect(within(menu).getByRole('menuitemcheckbox', { name: /beta/ }).getAttribute('aria-checked')).toBe('false')
      // Picking the session it is already shared with changes nothing.
      await user.click(within(menu).getByRole('menuitemcheckbox', { name: /alpha/ }))
      expect(props.onShare).not.toHaveBeenCalled()

      menu = await openShare(user)
      await user.click(within(menu).getByRole('menuitem', { name: 'Stop sharing' }))
      expect(props.onShare).toHaveBeenCalledWith(null)
    })

    it('says there is nobody to share with when no session can take the page', async () => {
      const user = userEvent.setup()
      renderPane({ onShareTargets: vi.fn(() => Promise.resolve([])) })
      const menu = await openShare(user)
      const none = within(menu).getByRole('menuitem', { name: 'No session to share with' })
      expect(none.getAttribute('aria-disabled')).toBe('true')
    })

    it('says above the page which session can drive it, while it can, with a way to stop sharing', async () => {
      const user = userEvent.setup()
      const props = renderPane({ state: { ...STATE, sharedWith: { session: 1, name: 'alpha' } } })
      const note = screen.getByRole('note')
      expect(note.textContent).toBe('Shared with “alpha”: that session can read and drive this page.Stop sharing')
      await user.click(within(note).getByRole('button', { name: 'Stop sharing' }))
      expect(props.onShare).toHaveBeenCalledWith(null)
    })

    it("says an agent's page is the session's while it runs, and nothing once it has ended", () => {
      renderPane({ state: { ...STATE, openedBy: 'alpha', openerRunning: true } })
      expect(screen.getByRole('note').textContent).toBe('“alpha” opened this page and can drive it.')
      cleanup()
      renderPane({ state: { ...STATE, openedBy: 'alpha', openerRunning: false } })
      expect(screen.queryByRole('note')).toBeNull()
      cleanup()
      renderPane()
      expect(screen.queryByRole('note')).toBeNull()
    })
  })

  it('lists zoom, the widths, DevTools and clearing data in the menu, with their keys', async () => {
    const user = userEvent.setup()
    renderPane({ state: { ...STATE, zoomLevel: 1 } })
    const menu = await openMenu(user)
    expect(menu.textContent).toContain('Zoom 120%')
    const rows = [...menu.querySelectorAll('[data-menu-item]')].map((row) => row.textContent)
    expect(rows).toEqual([
      'Zoom inCtrl =',
      'Zoom outCtrl -',
      'Actual sizeCtrl 0',
      'Full',
      'Tablet820 px',
      'Phone390 px',
      'Open DevToolsF12',
      'Clear cookies and site data'
    ])
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Full/ }).getAttribute('aria-checked')).toBe('true')
    expect(within(menu).getByRole('menuitem', { name: /Zoom in/ }).getAttribute('role')).toBe('menuitem')
  })

  it('zooms by half a step from the menu, and back to actual size', async () => {
    const user = userEvent.setup()
    const props = renderPane({ state: { ...STATE, zoomLevel: 1 } })
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: /Zoom in/ }))
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: /Zoom out/ }))
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: /Actual size/ }))
    expect(vi.mocked(props.onZoom).mock.calls).toEqual([[1.5], [0.5], [0]])
  })

  it('cannot zoom past the ends, nor reset what is already actual size', async () => {
    const user = userEvent.setup()
    renderPane({ state: { ...STATE, zoomLevel: 3 } })
    const menu = await openMenu(user)
    expect(within(menu).getByRole('menuitem', { name: /Zoom in/ }).getAttribute('aria-disabled')).toBe('true')
    await user.keyboard('{Escape}')
  })

  it('says the zoom in the address bar only when it is not 100%, and resets it from there', async () => {
    const user = userEvent.setup()
    const props = renderPane({ state: { ...STATE, zoomLevel: 0.5 } })
    const chip = screen.getByRole('button', { name: 'Zoom 110%, back to actual size' })
    expect(chip.textContent).toBe('110%')
    await user.click(chip)
    expect(props.onZoom).toHaveBeenCalledWith(0)
  })

  it('shows no zoom in the address bar at 100%', () => {
    renderPane()
    expect(screen.queryByRole('button', { name: /back to actual size/ })).toBeNull()
  })

  it('opens DevTools and clears the browsing data from the menu', async () => {
    const user = userEvent.setup()
    const props = renderPane()
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: /Open DevTools/ }))
    await user.click(within(await openMenu(user)).getByRole('menuitem', { name: /Clear cookies and site data/ }))
    expect(props.onDevTools).toHaveBeenCalledTimes(1)
    expect(props.onClearStorage).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
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
    await user.click(within(await openMenu(user)).getByRole('menuitemcheckbox', { name: /Phone/ }))
    expect(lastCall<{ width: number }>(props.onBounds).width).toBe(390)
    const menu = await openMenu(user)
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Phone/ }).getAttribute('aria-checked')).toBe('true')

    await user.click(within(menu).getByRole('menuitemcheckbox', { name: /Full/ }))
    expect(lastCall<{ width: number }>(props.onBounds).width).toBe(1200)
  })

  it('paints a still of the page in the hole while the view is off the screen, and nothing otherwise', () => {
    renderPane({ still: 'data:image/png;base64,cGFnZQ==' })
    const hole = document.querySelector('[data-browser-hole]')!
    const still = hole.querySelector('img')!
    expect(still.getAttribute('src')).toBe('data:image/png;base64,cGFnZQ==')
    // Decoration, out of the accessibility tree and out of the pointer's way.
    expect(still.getAttribute('alt')).toBe('')
    expect(still.className).toContain('pointer-events-none')
  })
})
