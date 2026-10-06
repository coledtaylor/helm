import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from 'electron'
import { DEFAULT_SETTINGS, type AppSettings } from '@helm/core'
import {
  FakeBrowserWindow,
  FakeWebContents,
  FakeWebContentsView,
  fakeBrowser,
  type FakeSession
} from '../../test/browser-electron'
import {
  browserWillNavigate,
  browserWindowOpen,
  createBrowserHost,
  exemptedWebContents,
  type BrowserHost
} from './browser'
import type { BrowserConsoleEntry, BrowserOpened, BrowserState } from '../shared/ipc'

vi.mock('electron', async () => ({
  ...(await import('../../test/electron')).electronFake(),
  ...(await import('../../test/browser-electron')).browserElectronFake()
}))

/**
 * The browser pane's main-process half, against a fake Electron.
 *
 * The host is real; Chromium is played by the test (`test/browser-electron.ts`).
 * So every claim here is about what **Helm** does with what Chromium reports -
 * which is exactly the part a real page cannot isolate. A refused connection
 * that later loads proves nothing about Helm's retry when Chromium may have held
 * the socket open itself; here nothing but Helm can ask for the page again.
 */

interface Harness {
  host: BrowserHost
  window: FakeBrowserWindow
  settings: () => AppSettings
  patch: (next: Partial<AppSettings>) => void
  opened: BrowserOpened[]
  closed: number[]
}

let current: Harness | null = null

function harness(patch: Partial<AppSettings> = {}): Harness {
  let settings: AppSettings = { ...DEFAULT_SETTINGS, browserRecentUrls: [], browserProjectUrls: {}, ...patch }
  const window = new FakeBrowserWindow()
  const opened: BrowserOpened[] = []
  const closed: number[] = []
  const host = createBrowserHost({
    window: () => window as unknown as BrowserWindow,
    settings: () => settings,
    writeSettings: (next) => {
      settings = { ...settings, ...next }
    },
    onChanged: () => undefined,
    onOpened: (page) => opened.push(page),
    onClosed: (id) => closed.push(id),
    onLogged: (_id: number, _entry: BrowserConsoleEntry) => undefined
  })
  current = {
    host,
    window,
    settings: () => settings,
    patch: (next) => {
      settings = { ...settings, ...next }
    },
    opened,
    closed
  }
  return current
}

afterEach(() => {
  current?.host.shutdown()
  current = null
  vi.useRealTimers()
})

/** A tab opened from the strip, and the fake view and page behind it. */
function openTab(h: Harness, url?: string): { id: number; view: FakeWebContentsView; wc: FakeWebContents } {
  const { state, problem } = h.host.open(url === undefined ? {} : { url })
  if (state === null) throw new Error(`open refused: ${String(problem)}`)
  const view = FakeWebContentsView.created.at(-1)!
  return { id: state.id, view, wc: view.webContents! }
}

const stateOf = (h: Harness, id: number): BrowserState => {
  const found = h.host.states(id)[0]
  if (found === undefined) throw new Error(`no browser tab ${String(id)}`)
  return found
}

const messages = (h: Harness, id: number): string[] => h.host.entries(id).map((entry) => entry.message)

/**
 * What Electron hands `createWindow`: the window options, with the web contents
 * Chromium made for the page - or none, for a middle click.
 */
const handedOver = (guest?: FakeWebContents): BrowserWindowConstructorOptions =>
  (guest === undefined ? {} : { webContents: guest as unknown as WebContents }) as BrowserWindowConstructorOptions

const partition = (): FakeSession => {
  const found = fakeBrowser.partitions.get('persist:helm-browser')
  if (found === undefined) throw new Error('the browser partition was never configured')
  return found
}

describe('browser host - navigation and the address bar', () => {
  it('remembers an address only once a page has arrived there, newest first, ten at most', () => {
    const h = harness()
    const { id, wc } = openTab(h)
    expect(wc.loads).toEqual([])

    h.host.navigate(id, 'localhost:3000')
    expect(wc.loads).toEqual(['http://localhost:3000/'])
    // Asked for is not arrived.
    expect(h.settings().browserRecentUrls).toEqual([])
    // Nor is an error page, which Chromium commits like any other navigation.
    wc.failLoad(-105, 'ERR_NAME_NOT_RESOLVED', 'http://localhost:3000/')
    expect(h.settings().browserRecentUrls).toEqual([])

    wc.commit('http://localhost:3000/')
    expect(h.settings().browserRecentUrls).toEqual(['http://localhost:3000/'])

    const pages = Array.from({ length: 11 }, (_, n) => `http://localhost:3000/page-${String(n)}`)
    for (const url of pages) wc.commit(url)
    expect(h.settings().browserRecentUrls).toEqual(pages.slice(1).reverse())

    // A revisit moves to the front rather than appearing twice.
    wc.commit(pages[5]!)
    const recent = h.settings().browserRecentUrls
    expect(recent[0]).toBe(pages[5])
    expect(recent).toHaveLength(10)
    expect(new Set(recent).size).toBe(10)
  })

  it("opens a tab beside a project on that project's last address, and one beside none empty", () => {
    const h = harness()
    const project = 'C:\\Projects\\A Project'
    const first = h.host.open({ url: 'http://localhost:5173/', project })
    const firstPage = FakeWebContentsView.created.at(-1)!.webContents!
    expect(first.state?.project).toBe(project)
    firstPage.commit('http://localhost:5173/app')
    expect(h.settings().browserProjectUrls).toEqual({ 'c:\\projects\\a project': 'http://localhost:5173/app' })

    // The same project, however it is cased.
    const again = openTabFor(h, 'c:\\PROJECTS\\a project')
    expect(again.wc.loads).toEqual(['http://localhost:5173/app'])

    const elsewhere = openTabFor(h, 'C:\\Projects\\Another')
    expect(elsewhere.wc.loads).toEqual([])
    const none = openTabFor(h, null)
    expect(none.wc.loads).toEqual([])
    expect(stateOf(h, none.id).url).toBe('')
  })

  it('never searches: a phrase is a sentence on the tab and nothing is loaded', () => {
    const h = harness()
    const { id, wc } = openTab(h)
    const state = h.host.navigate(id, 'what is a webcontentsview')
    expect(state?.problem).toContain('never searches')
    expect(stateOf(h, id).problem).toContain('never searches')
    expect(wc.loads).toEqual([])
  })

  it('reloads ignoring the cache when asked to, and ordinarily otherwise', () => {
    const h = harness()
    const { id, wc } = openTab(h, 'http://localhost:3000/')
    wc.commit('http://localhost:3000/')
    h.host.reload(id, true)
    h.host.reload(id, false)
    expect(wc.reloads).toEqual(['ignoring-cache', 'ordinary'])
  })

  it('zooms the page, three steps either way at most', () => {
    const h = harness()
    const { id } = openTab(h, 'http://localhost:3000/')
    expect(h.host.zoom(id, 0.5)?.zoomLevel).toBe(0.5)
    expect(h.host.zoom(id, 9)?.zoomLevel).toBe(3)
    expect(h.host.zoom(id, -9)?.zoomLevel).toBe(-3)
    expect(h.host.zoom(id, 0)?.zoomLevel).toBe(0)
  })

  it('clears the shared browser profile and says so in the console', async () => {
    const h = harness()
    const { id } = openTab(h, 'http://localhost:3000/')
    const before = partition().cleared
    await h.host.clearStorage(id)
    expect(partition().cleared).toBe(before + 1)
    expect(messages(h, id).at(-1)).toContain('Cleared cookies and storage')
  })

  it('finds in the page: a new query starts a search, the same query steps, and stopping clears the find state', () => {
    const h = harness()
    const { id, wc } = openTab(h, 'http://localhost:3000/')
    wc.commit('http://localhost:3000/')

    // Electron's `findNext` is true for the request that *starts* a search.
    h.host.find(id, 'tok', true)
    h.host.find(id, 'token', true)
    expect(wc.finds).toEqual([
      { query: 'tok', forward: true, findNext: true },
      { query: 'token', forward: true, findNext: true }
    ])
    // The answer to the search the next keystroke typed over changes nothing.
    wc.emit('found-in-page', {}, { requestId: 1, matches: 9, activeMatchOrdinal: 1 })
    expect(stateOf(h, id).find).toEqual({ query: 'token', matches: 0, active: 0 })
    wc.emit('found-in-page', {}, { requestId: 2, matches: 3, activeMatchOrdinal: 1 })
    expect(stateOf(h, id).find).toEqual({ query: 'token', matches: 3, active: 1 })

    // The same query again steps through that search, backwards here.
    h.host.find(id, 'token', false)
    expect(wc.finds.at(-1)).toEqual({ query: 'token', forward: false, findNext: false })
    wc.emit('found-in-page', {}, { requestId: 3, matches: 3, activeMatchOrdinal: 3 })
    expect(stateOf(h, id).find).toEqual({ query: 'token', matches: 3, active: 3 })

    // The caret stays in the pane's find field: the page is never focused.
    expect(wc.focused).toBe(0)

    h.host.stopFind(id)
    expect(stateOf(h, id).find).toBeNull()
    expect(wc.stoppedFinding).toEqual(['clearSelection'])

    // An emptied find field is a stop too.
    h.host.find(id, 'token', true)
    h.host.find(id, '', true)
    expect(stateOf(h, id).find).toBeNull()
  })
})

/** A tab opened beside a project: `project: null` is "beside nothing". */
function openTabFor(h: Harness, project: string | null): { id: number; wc: FakeWebContents } {
  const { state } = h.host.open({ project })
  if (state === null) throw new Error('open refused')
  return { id: state.id, wc: FakeWebContentsView.created.at(-1)!.webContents! }
}

describe('browser host - a dev server that is not up yet', () => {
  it('retries a refused connection on its own and connects once the server answers', () => {
    vi.useFakeTimers()
    const h = harness()
    const url = 'http://localhost:5173/'
    const { id, wc } = openTab(h, url)
    expect(wc.loads).toEqual([url])
    const start = Date.now()

    wc.failLoad(-102, 'ERR_CONNECTION_REFUSED', url)
    const waiting = stateOf(h, id)
    expect(waiting.problem).toContain('Waiting for')
    expect(waiting.problem).toContain(url)
    expect(waiting.retryingUntil).toBe(start + 30_000)
    expect(h.settings().browserRecentUrls).toEqual([])

    // The backoff: a third of a second, then twice that.
    vi.advanceTimersByTime(299)
    expect(wc.loads).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(wc.loads).toEqual([url, url])
    wc.failLoad(-102, 'ERR_CONNECTION_REFUSED', url)
    vi.advanceTimersByTime(599)
    expect(wc.loads).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(wc.loads).toHaveLength(3)
    // The deadline runs from the first refusal, not from each one.
    expect(stateOf(h, id).retryingUntil).toBe(start + 30_000)

    // The server is up: the third attempt arrives. Nothing was pressed.
    wc.commit(url, { title: 'Dev server' })
    const loaded = stateOf(h, id)
    expect(loaded.problem).toBeNull()
    expect(loaded.retryingUntil).toBeNull()
    expect(loaded.title).toBe('Dev server')
    expect(h.settings().browserRecentUrls).toEqual([url])
    vi.advanceTimersByTime(60_000)
    expect(wc.loads).toHaveLength(3)
  })

  it('gives up after thirty seconds and says to reload', () => {
    vi.useFakeTimers()
    const h = harness()
    const url = 'http://localhost:5173/'
    const { id, wc } = openTab(h, url)
    const start = Date.now()
    wc.failLoad(-102, 'ERR_CONNECTION_REFUSED', url)
    for (let attempt = 0; attempt < 40 && stateOf(h, id).retryingUntil !== null; attempt++) {
      vi.advanceTimersToNextTimer()
      wc.failLoad(-102, 'ERR_CONNECTION_REFUSED', url)
    }
    const gaveUp = stateOf(h, id)
    expect(gaveUp.retryingUntil).toBeNull()
    expect(gaveUp.problem).toContain('30 seconds')
    expect(gaveUp.problem).toContain('reload')
    // At the first refusal past the deadline, which is at most one 4s step late.
    expect(Date.now() - start).toBeGreaterThanOrEqual(30_000)
    expect(Date.now() - start).toBeLessThanOrEqual(34_000)

    const attempts = wc.loads.length
    vi.advanceTimersByTime(60_000)
    expect(wc.loads).toHaveLength(attempts)
  })

  it('retries nothing but a refused connection: a name or a certificate is an answer', () => {
    vi.useFakeTimers()
    const h = harness()

    const name = openTab(h, 'http://nowhere.invalid/')
    name.wc.failLoad(-105, 'ERR_NAME_NOT_RESOLVED', 'http://nowhere.invalid/')
    expect(stateOf(h, name.id).retryingUntil).toBeNull()
    expect(stateOf(h, name.id).problem).toContain('ERR_NAME_NOT_RESOLVED')

    const cert = openTab(h, 'https://127.0.0.2:8443/')
    cert.wc.failLoad(-202, 'ERR_CERT_AUTHORITY_INVALID', 'https://127.0.0.2:8443/')
    const refused = stateOf(h, cert.id)
    expect(refused.retryingUntil).toBeNull()
    expect(refused.problem).toContain('certificate')
    expect(refused.problem).toContain('no way past')

    vi.advanceTimersByTime(60_000)
    expect(name.wc.loads).toHaveLength(1)
    expect(cert.wc.loads).toHaveLength(1)
  })

  it('says nothing about a load a newer one replaced', () => {
    const h = harness()
    const { id, wc } = openTab(h, 'http://localhost:3000/')
    wc.failLoad(-3, 'ERR_ABORTED', 'http://localhost:3000/', { errorPage: false })
    expect(stateOf(h, id).problem).toBeNull()
    expect(h.host.entries(id)).toEqual([])
  })

  it('stops retrying when the tab is reloaded or sent somewhere else', () => {
    vi.useFakeTimers()
    const h = harness()
    const url = 'http://localhost:5173/'
    const { id, wc } = openTab(h, url)
    wc.failLoad(-102, 'ERR_CONNECTION_REFUSED', url)
    h.host.navigate(id, 'http://localhost:4000/')
    expect(stateOf(h, id).retryingUntil).toBeNull()
    vi.advanceTimersByTime(60_000)
    expect(wc.loads).toEqual([url, 'http://localhost:4000/'])
  })
})

describe('browser host - where the view is', () => {
  it('paints nothing until placed, then sits on the placeholder in DIPs at the window zoom', () => {
    const h = harness()
    h.window.webContents.zoomFactor = 1.5
    const { id, view } = openTab(h, 'http://localhost:3000/')
    expect(h.window.children).toContain(view)
    expect(view.visible).toBe(false)
    expect(view.getBounds()).toEqual({ x: 0, y: 0, width: 0, height: 0 })

    // A phone-width placeholder: 390 CSS pixels at 150% is 585 DIPs.
    h.host.bounds({ id, x: 10, y: 100, width: 390, height: 400, visible: true })
    expect(view.getBounds()).toEqual({ x: 15, y: 150, width: 585, height: 600 })
    expect(view.visible).toBe(true)
  })

  it('never lets the view into the top 36px, whatever the window reports', () => {
    const h = harness()
    const { id, view } = openTab(h, 'http://localhost:3000/')
    h.host.bounds({ id, x: 0, y: 0, width: 800, height: 500, visible: true })
    expect(view.getBounds()).toEqual({ x: 0, y: 36, width: 800, height: 464 })
    h.host.bounds({ id, x: 0, y: 10, width: 800, height: 20, visible: true })
    expect(view.getBounds()).toEqual({ x: 0, y: 36, width: 800, height: 0 })
  })

  it('hides a view by not painting it, and keeps its page and its history', () => {
    const h = harness()
    const { id, view, wc } = openTab(h, 'http://localhost:3000/')
    wc.commit('http://localhost:3000/')
    wc.commit('http://localhost:3000/two')
    h.host.bounds({ id, x: 0, y: 80, width: 800, height: 500, visible: true })

    h.host.bounds({ id, x: 0, y: 80, width: 800, height: 500, visible: false })
    expect(view.visible).toBe(false)
    expect(h.window.children).toContain(view)
    expect(wc.isDestroyed()).toBe(false)
    expect(stateOf(h, id)).toMatchObject({ url: 'http://localhost:3000/two', canGoBack: true })

    h.host.bounds({ id, x: 0, y: 80, width: 800, height: 500, visible: true })
    expect(view.visible).toBe(true)
  })

  it('goes back and forward through the history the page made', () => {
    const h = harness()
    const { id, wc } = openTab(h, 'http://localhost:3000/')
    wc.commit('http://localhost:3000/')
    wc.commit('http://localhost:3000/two')
    expect(h.host.back(id)?.url).toBe('http://localhost:3000/')
    expect(stateOf(h, id)).toMatchObject({ canGoBack: false, canGoForward: true })
    expect(h.host.forward(id)?.url).toBe('http://localhost:3000/two')
  })
})

describe('browser host - the console', () => {
  it("keeps what the page logs, counts errors and warnings, and holds the last thousand lines", () => {
    const h = harness()
    const { id, wc } = openTab(h, 'http://localhost:3000/')
    wc.log('info', 'hello', 'http://localhost:3000/app.js', 4)
    wc.log('warning', 'careful')
    wc.log('error', 'broken')
    expect(h.host.entries(id).map(({ level, message, source, line }) => ({ level, message, source, line }))).toEqual([
      { level: 'info', message: 'hello', source: 'http://localhost:3000/app.js', line: 4 },
      { level: 'warning', message: 'careful', source: '', line: 0 },
      { level: 'error', message: 'broken', source: '', line: 0 }
    ])
    expect(stateOf(h, id).errors).toBe(2)

    // An event in a shape Helm does not know is recorded, not dropped.
    wc.emit('console-message', { message: 'no level' })
    expect(messages(h, id).at(-1)).toContain('does not recognise')

    for (let n = 0; n < 1000; n++) wc.log('info', `line ${String(n)}`)
    expect(h.host.entries(id)).toHaveLength(1000)
    expect(messages(h, id)[0]).toBe('line 0')
    expect(messages(h, id).at(-1)).toBe('line 999')
  })

  it('evaluates in the page as a user gesture and prints what came back', async () => {
    const h = harness()
    const { id, wc } = openTab(h, 'http://localhost:3000/')
    wc.answer = (source) => {
      if (source === 'thing') return { a: 1 }
      if (source === 'text') return 'FIXTURE-VALUE'
      if (source === 'nothing') return undefined
      throw new Error('ReferenceError: boom is not defined')
    }
    expect(await h.host.evaluate(id, 'thing')).toEqual({ ok: true, value: '{\n  "a": 1\n}', error: null })
    expect(await h.host.evaluate(id, 'text')).toEqual({ ok: true, value: 'FIXTURE-VALUE', error: null })
    expect(await h.host.evaluate(id, 'nothing')).toEqual({ ok: true, value: 'undefined', error: null })
    const failed = await h.host.evaluate(id, 'boom')
    expect(failed.ok).toBe(false)
    expect(failed.error).toContain('boom is not defined')
    expect(wc.evaluated.every((call) => call.userGesture)).toBe(true)

    h.host.close(id)
    expect((await h.host.evaluate(id, 'thing')).ok).toBe(false)
  })
})

describe('browser host - security posture', () => {
  it('on "This machine only", refuses a remote address with a sentence and fetches nothing; loopback still loads', () => {
    const h = harness({ browserReach: 'local' })
    const { id, wc } = openTab(h)

    h.host.navigate(id, 'http://example.com/docs')
    expect(wc.loads).toEqual([])
    const refused = stateOf(h, id)
    expect(refused.problem).toContain('example.com')
    expect(refused.problem).toContain('This machine only')
    expect(h.host.entries(id).at(-1)?.level).toBe('error')

    h.host.navigate(id, 'http://127.0.0.1:8080/')
    expect(wc.loads).toEqual(['http://127.0.0.1:8080/'])
    expect(stateOf(h, id).problem).toBeNull()
    wc.commit('http://127.0.0.1:8080/')

    // A link the page follows goes through the same rule.
    expect(browserWillNavigate(wc.id, 'http://example.com/')).toBe(false)
    expect(stateOf(h, id).problem).toContain('example.com')
    expect(browserWillNavigate(wc.id, 'http://localhost:3000/next')).toBe(true)

    // The setting is read per navigation, not when the tab was made.
    h.patch({ browserReach: 'web' })
    h.host.navigate(id, 'http://example.com/docs')
    expect(wc.loads.at(-1)).toBe('http://example.com/docs')
  })

  it('runs every page sandboxed, isolated, with no preload, on the persistent browser partition', () => {
    const h = harness()
    const { view } = openTab(h, 'http://localhost:3000/')
    const prefs = view.webPreferences
    expect(prefs['session']).toBe(partition())
    expect(prefs).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    })
    expect(prefs['preload']).toBeUndefined()
  })

  it('refuses a file URL with a sentence and stays where it was', () => {
    const h = harness()
    const { id, wc } = openTab(h, 'http://localhost:3000/')
    wc.commit('http://localhost:3000/')
    h.host.navigate(id, 'file:///C:/Windows/win.ini')
    expect(wc.loads).toEqual(['http://localhost:3000/'])
    expect(stateOf(h, id)).toMatchObject({ url: 'http://localhost:3000/' })
    expect(stateOf(h, id).problem).toContain('http and https')
    expect(browserWillNavigate(wc.id, 'file:///C:/Windows/win.ini')).toBe(false)
  })

  it('holds ten tabs at most, from the strip and from a page', () => {
    const h = harness()
    const tabs = Array.from({ length: 10 }, () => openTab(h, 'http://localhost:3000/'))
    const made = FakeWebContentsView.created.length

    const eleventh = h.host.open({ url: 'http://localhost:3000/' })
    expect(eleventh.state).toBeNull()
    expect(eleventh.problem).toContain('10')

    const page = tabs[0]!
    expect(
      browserWindowOpen(page.wc.id, { url: 'http://localhost:3000/two', disposition: 'foreground-tab', features: '' })
    ).toEqual({ action: 'deny' })
    expect(stateOf(h, page.id).problem).toContain('10')
    expect(h.host.entries(page.id).at(-1)?.level).toBe('warning')
    expect(FakeWebContentsView.created.length).toBe(made)
  })

  it("exempts exactly the live browser views from the app's navigation lock, never the window", () => {
    const h = harness()
    expect(exemptedWebContents()).toEqual([])
    const a = openTab(h, 'http://localhost:3000/')
    const b = openTab(h, 'http://localhost:3001/')
    expect([...exemptedWebContents()].sort()).toEqual([a.wc.id, b.wc.id].sort())

    const windowId = h.window.webContents.id
    expect(exemptedWebContents()).not.toContain(windowId)
    expect(browserWillNavigate(windowId, 'http://localhost:3000/')).toBe(false)
    expect(
      browserWindowOpen(windowId, { url: 'http://localhost:3000/', disposition: 'new-window', features: 'width=400' })
    ).toEqual({ action: 'deny' })

    h.host.close(a.id)
    expect(exemptedWebContents()).toEqual([b.wc.id])
    b.view.closeItself()
    expect(exemptedWebContents()).toEqual([])
    expect(browserWillNavigate(b.wc.id, 'http://localhost:3001/')).toBe(false)
  })

  it('accepts a self-signed certificate on loopback and hands every other verdict back to Chromium', () => {
    const h = harness()
    openTab(h)
    const verify = partition().certificateVerify!
    const verdict = (hostname: string): number | null => {
      let answer: number | null = null
      verify({ hostname }, (value) => {
        answer = value
      })
      return answer
    }
    expect(verdict('127.0.0.1')).toBe(0)
    expect(verdict('localhost')).toBe(0)
    expect(verdict('::1')).toBe(0)
    expect(verdict('127.0.0.2')).toBe(-3)
    expect(verdict('example.com')).toBe(-3)
    expect(verdict('localhost.example.com')).toBe(-3)
  })

  it('refuses a download, hands a web address to the system browser, and says so on every tab', () => {
    const h = harness()
    const a = openTab(h, 'http://127.0.0.1:8080/download')
    a.wc.commit('http://127.0.0.1:8080/download')
    const b = openTab(h, 'http://127.0.0.1:8080/')
    const handedOff = fakeBrowser.openedExternally.length

    let prevented = false
    partition().emit(
      'will-download',
      { preventDefault: () => (prevented = true) },
      { getURL: () => 'http://127.0.0.1:8080/payload.bin' }
    )
    expect(prevented).toBe(true)
    expect(fakeBrowser.openedExternally.slice(handedOff)).toEqual(['http://127.0.0.1:8080/payload.bin'])
    for (const tab of [a, b]) {
      expect(stateOf(h, tab.id).problem).toContain('does not download')
      expect(messages(h, tab.id).at(-1)).toContain('download refused')
    }
    expect(a.wc.loads).toEqual(['http://127.0.0.1:8080/download'])
    expect(stateOf(h, a.id).url).toBe('http://127.0.0.1:8080/download')

    // Anything that is not a web address is refused and handed nowhere.
    let alsoPrevented = false
    partition().emit(
      'will-download',
      { preventDefault: () => (alsoPrevented = true) },
      { getURL: () => 'file:///C:/payload.exe' }
    )
    expect(alsoPrevented).toBe(true)
    expect(fakeBrowser.openedExternally.slice(handedOff)).toEqual(['http://127.0.0.1:8080/payload.bin'])
  })

  it('refuses every permission without asking', () => {
    const h = harness()
    const { wc } = openTab(h, 'http://127.0.0.1:8080/')
    const answers: boolean[] = []
    for (const permission of ['geolocation', 'media', 'notifications', 'clipboard-read', 'openExternal']) {
      partition().permissionRequest!(wc, permission, (granted) => answers.push(granted))
    }
    expect(answers).toEqual([false, false, false, false, false])
    expect(partition().permissionCheck!(wc, 'geolocation', 'http://127.0.0.1:8080', {})).toBe(false)
    expect(partition().devicePermission!({ deviceType: 'usb' })).toBe(false)
  })
})

describe('browser host - popups and pages that close themselves', () => {
  it('retires the tab of a page that closed itself, and nothing touching that id throws afterwards', async () => {
    const h = harness()
    const { id, view, wc } = openTab(h, 'http://127.0.0.1:8080/selfclose')
    wc.commit('http://127.0.0.1:8080/selfclose')

    view.closeItself()
    expect(h.closed).toEqual([id])
    expect(h.host.states().map((state) => state.id)).not.toContain(id)
    expect(h.host.states(id)).toEqual([])
    expect(() => h.host.bounds({ id, x: 0, y: 80, width: 400, height: 300, visible: true })).not.toThrow()
    expect(h.host.navigate(id, 'http://127.0.0.1:8080/')).toBeNull()
    expect(h.host.back(id)).toBeNull()
    expect(h.host.zoom(id, 1)).toBeNull()
    expect((await h.host.evaluate(id, '1')).ok).toBe(false)

    // Closing it from the strip afterwards tells the window nothing twice.
    h.host.close(id)
    expect(h.closed).toEqual([id])
  })

  it('answers rather than throws in the moment between a page closing and Electron saying so', () => {
    const h = harness()
    const { id, view, wc } = openTab(h, 'http://127.0.0.1:8080/selfclose')
    wc.commit('http://127.0.0.1:8080/selfclose')
    view.closeItself({ announce: false })

    expect(() => h.host.states()).not.toThrow()
    expect(stateOf(h, id).url).toBe('')
    expect(() => h.host.bounds({ id, x: 0, y: 80, width: 400, height: 300, visible: true })).not.toThrow()
    expect(h.host.navigate(id, 'http://127.0.0.1:8080/')?.problem).toContain('closed itself')
    expect(h.host.zoom(id, 1)).toBeNull()
    expect(() => h.host.find(id, 'x', true)).not.toThrow()
    expect(() => h.host.stopFind(id)).not.toThrow()
  })

  it('opens target=_blank, a plain window.open and a middle click as pages that keep their opener, never windows', () => {
    const h = harness()
    const opener = openTab(h, 'http://127.0.0.1:8080/opener')
    opener.wc.commit('http://127.0.0.1:8080/opener')
    const made = FakeWebContentsView.created.length
    const attached = h.window.children.length

    // A plain window.open: Chromium has already made the page's web contents,
    // and the view adopts them rather than loading the address afresh.
    const answer = browserWindowOpen(opener.wc.id, {
      url: 'http://127.0.0.1:8080/two',
      disposition: 'foreground-tab',
      features: ''
    })
    if (answer.action !== 'allow' || answer.createWindow === undefined) throw new Error('the page was refused')
    expect(answer.outlivesOpener).toBe(true)
    expect(answer.overrideBrowserWindowOptions?.webPreferences).toMatchObject({
      session: partition(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    })
    const guest = new FakeWebContents()
    expect(answer.createWindow(handedOver(guest))).toBe(guest)
    expect(FakeWebContentsView.created.at(-1)!.webContents).toBe(guest)
    expect(guest.loads).toEqual([])
    expect(exemptedWebContents()).toContain(guest.id)
    expect(h.window.children.length).toBe(attached + 1)
    const page = h.opened.at(-1)!
    expect(page).toMatchObject({ after: opener.id, background: false })
    expect(page.state.openedBy).toBeNull()

    // A middle click: no contents to adopt, so the address is loaded here, and
    // the page in front stays in front.
    const middle = browserWindowOpen(opener.wc.id, {
      url: 'http://127.0.0.1:8080/three',
      disposition: 'background-tab',
      features: ''
    })
    if (middle.action !== 'allow' || middle.createWindow === undefined) throw new Error('the page was refused')
    middle.createWindow(handedOver())
    expect(FakeWebContentsView.created.at(-1)!.webContents?.loads).toEqual(['http://127.0.0.1:8080/three'])
    expect(h.opened.at(-1)).toMatchObject({ after: opener.id, background: true })

    // A shift-click is new-window with nothing asked of the window: a page too.
    const shifted = browserWindowOpen(opener.wc.id, {
      url: 'http://127.0.0.1:8080/four',
      disposition: 'new-window',
      features: ''
    })
    expect(shifted.action === 'allow' && shifted.createWindow !== undefined).toBe(true)
    expect(shifted.action === 'allow' && shifted.overrideBrowserWindowOptions?.parent).toBeFalsy()

    // Pages, not windows, and they outlive the page that opened them.
    expect(FakeWebContentsView.created.length).toBe(made + 2)
    h.host.close(opener.id)
    expect(h.host.states().map((state) => state.id)).toEqual([page.state.id, page.state.id + 1])
  })

  it('gives window.open with features a real popup, held to the posture and the reach of the tab that opened it', () => {
    const h = harness()
    const { id, wc } = openTab(h, 'http://127.0.0.1:8080/signin')
    wc.commit('http://127.0.0.1:8080/signin')
    const made = FakeWebContentsView.created.length

    const answer = browserWindowOpen(wc.id, {
      url: 'http://127.0.0.1:8080/popup',
      disposition: 'new-window',
      features: 'width=480,height=5000'
    })
    if (answer.action !== 'allow') throw new Error('the popup was refused')
    expect(answer.outlivesOpener).toBe(false)
    const options = answer.overrideBrowserWindowOptions!
    expect(options.width).toBe(480)
    expect(options.height).toBeLessThan(5000)
    expect(options.parent).toBe(h.window)
    expect(options.webPreferences).toMatchObject({
      session: partition(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    })
    // A window, not a tab.
    expect(FakeWebContentsView.created.length).toBe(made)

    // Electron makes it.
    const popup = new FakeBrowserWindow()
    wc.emit('did-create-window', popup, { url: 'http://127.0.0.1:8080/popup' })
    expect(exemptedWebContents()).toContain(popup.webContents.id)
    expect(messages(h, id)).toContain('opened a popup window for http://127.0.0.1:8080/popup')
    popup.webContents.commit('http://127.0.0.1:8080/popup', { title: 'Sign in' })
    expect(popup.title).toBe('127.0.0.1:8080 - Sign in')

    // A redirect inside it answers to the opener's reach, and is refused on the opener's tab.
    h.patch({ browserReach: 'local' })
    expect(browserWillNavigate(popup.webContents.id, 'http://example.com/oauth')).toBe(false)
    expect(stateOf(h, id).problem).toContain('example.com')
    expect(browserWillNavigate(popup.webContents.id, 'http://localhost:9000/callback')).toBe(true)

    // It closes itself.
    popup.destroy()
    expect(exemptedWebContents()).not.toContain(popup.webContents.id)
    expect(messages(h, id).at(-1)).toContain('popup window closed')
  })

  it('refuses a popup to an address out of reach, on the tab that asked', () => {
    const h = harness({ browserReach: 'local' })
    const { id, wc } = openTab(h, 'http://127.0.0.1:8080/signin')
    wc.commit('http://127.0.0.1:8080/signin')
    const made = FakeWebContentsView.created.length
    expect(
      browserWindowOpen(wc.id, { url: 'http://127.0.0.2:9000/popup', disposition: 'new-window', features: 'width=480' })
    ).toEqual({ action: 'deny' })
    expect(FakeWebContentsView.created.length).toBe(made)
    expect(stateOf(h, id).problem).toContain('This machine only')
    expect(stateOf(h, id).problem).toContain('127.0.0.2')
  })

  it("gives window.open from a session's tab another of that session's pages, never a window", async () => {
    vi.useFakeTimers()
    const h = harness()
    const opener = { key: 'token-alpha', name: 'agent alpha' }
    const pending = h.host.openFor(opener, 'http://127.0.0.1:8080/signin')
    const agentPage = FakeWebContentsView.created.at(-1)!.webContents!
    agentPage.commit('http://127.0.0.1:8080/signin')
    await vi.advanceTimersByTimeAsync(1000)
    const agentTab = (await pending).state!
    expect(agentTab.openedBy).toBe('agent alpha')

    // At the end of the strip, behind the page in front.
    expect(h.opened.at(-1)).toMatchObject({ after: null, background: true })

    const answer = browserWindowOpen(agentPage.id, {
      url: 'http://127.0.0.1:8080/popup',
      disposition: 'new-window',
      features: 'width=480,height=640'
    })
    if (answer.action !== 'allow' || answer.createWindow === undefined) throw new Error('the page was refused')
    // Not a window: nothing was handed to Electron to make one with.
    expect(answer.overrideBrowserWindowOptions?.parent).toBeUndefined()
    const guest = new FakeWebContents()
    answer.createWindow(handedOver(guest))
    const spawned = h.opened.at(-1)!
    expect(spawned.state.id).not.toBe(agentTab.id)
    expect(spawned).toMatchObject({ after: agentTab.id, background: true })
    expect(spawned.state.openedBy).toBe('agent alpha')
    expect(h.host.openerOf(spawned.state.id)).toEqual(opener)
    expect(FakeWebContentsView.created.at(-1)!.webContents).toBe(guest)
    guest.commit('http://127.0.0.1:8080/popup')
    await vi.advanceTimersByTimeAsync(1000)
  })
})
