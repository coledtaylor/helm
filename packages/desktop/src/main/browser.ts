import { app, session, shell, WebContentsView, type BrowserWindow, type Session } from 'electron'
import {
  BROWSER_PROJECT_URLS_MAX,
  BROWSER_RECENT_URLS_MAX,
  browserReachAllows,
  isLoopbackUrl,
  resolveBrowserAddress,
  type AppSettings,
  type BrowserReach
} from '@helm/core'
import { TITLEBAR_OVERLAY } from './chrome'
import { BROWSER_TABS_MAX, type BrowserConsoleEntry, type BrowserState } from '../shared/ipc'

/**
 * The browser pane's main-process half: a dev-server viewport, not a browser.
 *
 * Five things live here and none of them can live anywhere else.
 *
 * **The view itself has to be a `WebContentsView`.** The renderer's CSP allows
 * `frame-src helm-content:` and nothing else (`renderer/index.html`), so an
 * `<iframe src="http://localhost:3000">` is blocked before it starts, and the
 * artifact path it *does* allow is deliberately network-less (`ARTIFACT_CSP` in
 * `content.ts`). A `WebContentsView` has web contents of its own and is
 * unaffected by either.
 *
 * **So the view is main-owned state, like a pty.** React paints a placeholder
 * rectangle and sends its bounds; everything about lifetime is here. That is
 * not tidiness: the workspace strip unmounts a pane on every tab switch, and a
 * view destroyed on unmount is a page whose scroll position, form state and
 * session cookie are gone every time somebody looks at something else.
 *
 * **One partition, shared by every view, and never the renderer's.**
 * `persist:helm-browser` puts cookies and localStorage under the app's own data
 * directory - which moves with `PORTABLE_EXECUTABLE_DIR`, so a check's browser
 * profile lands in the check's directory and a portable install keeps its
 * profile on the stick. Helm reads nothing out of it. It is configured exactly
 * once, in `browserSession()`, because a posture applied per view is a posture
 * a future view can be created without.
 *
 * **The app-global navigation deny is not loosened.** `index.ts` denies
 * `will-navigate` and every `window.open` on every web-contents Electron
 * creates. These views are exempted through a registry of `webContents.id`
 * consulted *inside* that guard - `browserWillNavigate` and
 * `browserWindowOpen` below - so the app's own renderers keep the lock and the
 * exemption is a lookup rather than a hole. The registry is filled the moment a
 * view is constructed and emptied the moment it is destroyed.
 *
 * **Hiding is `setVisible(false)`, and that was measured.** A native view
 * paints above all renderer DOM, so it has to get out of the way whenever a
 * dialog is up; and an agent will drive a tab the user is not looking at
 * (M17), so whatever hides it must leave it capturable, scriptable and
 * clickable. The spike run for this milestone put a `WebContentsView` through
 * all three states on Electron 43.3.0 - shown, `setVisible(false)`, and parked
 * outside the window - repainting the page a colour it had never been *after*
 * each hide so that a stale frame could not pass for a live capture. All three
 * came back with the fresh colour, the right `executeJavaScript` answer, and a
 * synthesised click counted in the page. `setVisible(false)` is therefore the
 * mechanism, because it is the one that also stops the view painting;
 * `BROWSER_LIVE_WHILE_HIDDEN` below is that answer pinned where the code is,
 * and `pnpm browser-check --only=hidden` is it pinned as an assertion.
 */

/**
 * The spike's answer, recorded.
 *
 * Measured 2026-08-16 on Electron 43.3.0: with `setVisible(false)`,
 * `capturePage` returns a **freshly painted** frame, `executeJavaScript`
 * resolves, and `sendInputEvent` reaches the document.
 *
 * Freshness was the part worth measuring properly, because a compositor that
 * suspended after a moment would make an early probe pass and M17 fail. So the
 * spike hid the view and then repainted the page a colour it had never been at
 * half a second, two, five, ten and twenty seconds - and captured the new
 * colour every time, with none of the old one. Parking the view outside the
 * window behaves identically, so the two are interchangeable on this point and
 * `setVisible(false)` wins on the other one: it is the only one of the two that
 * actually stops the view painting.
 *
 * If a future Electron changes that, the choice below changes with it - and
 * `BR-3` is what says so before anybody finds out through M17.
 */
export const BROWSER_LIVE_WHILE_HIDDEN = true

/** The partition every browser view shares. Never the window's session. */
export const BROWSER_PARTITION = 'persist:helm-browser'

/** How long a refused connection is retried before the pane gives up. */
const RETRY_FOR_MS = 30_000
/** The backoff between retries, in milliseconds, then every 4s. */
const RETRY_STEPS_MS = [300, 600, 1200, 2400, 4000]

/** Lines kept per view. Past this the oldest goes. */
const CONSOLE_RING = 1000

/**
 * Chromium's code for a connection that was refused outright.
 *
 * The only failure worth retrying: it is what a dev server that has not started
 * yet looks like, and it is distinguishable from a name that does not resolve,
 * a certificate that was rejected and a server that answered.
 */
const ERR_CONNECTION_REFUSED = -102
/** And the one for a load a *newer* navigation superseded, which is not a failure. */
const ERR_ABORTED = -3

interface View {
  id: number
  view: WebContentsView
  project: string | null
  console: BrowserConsoleEntry[]
  /** What the pane should say is wrong, or null. */
  problem: string | null
  /** The address a retry is trying to reach, and when it gives up. */
  retry: { url: string; until: number; step: number; timer: NodeJS.Timeout | null } | null
  find: { query: string; matches: number; active: number } | null
  /** Whether this view is attached to the window's content view right now. */
  attached: boolean
  /** What Helm last told Electron about painting. Read by `inspect`. */
  visible: boolean
}

export interface BrowserHost {
  open(request: { url?: string; project?: string | null }): {
    state: BrowserState | null
    problem: string | null
  }
  navigate(id: number, input: string): BrowserState | null
  back(id: number): BrowserState | null
  forward(id: number): BrowserState | null
  reload(id: number, hard: boolean): BrowserState | null
  close(id: number): void
  states(id?: number): BrowserState[]
  evaluate(id: number, source: string): Promise<{ ok: boolean; value: string; error: string | null }>
  devtools(id: number): BrowserState | null
  find(id: number, query: string, forward: boolean): void
  stopFind(id: number): void
  zoom(id: number, level: number): BrowserState | null
  clearStorage(id: number): Promise<BrowserState | null>
  entries(id: number): BrowserConsoleEntry[]
  bounds(payload: {
    id: number
    x: number
    y: number
    width: number
    height: number
    visible: boolean
  }): void
  /** Destroys every view. Called from `before-quit`, beside `sessions.shutdown()`. */
  shutdown(): void

  /**
   * What Electron is actually holding for a view.
   *
   * `browser-check`'s only route to any of this. A `WebContentsView` is not in
   * the DOM, so a driver holding the window through `executeJavaScript` cannot
   * see its bounds, its partition or its web contents at all - the same
   * deliberate seam `installTerminalInspector` is, and on the same terms:
   * product code carrying the one hook a check needs, exposing no capability
   * the process did not already have, and never a writer.
   *
   * `visible` is what Helm last **told** Electron, so it is a statement about
   * this file rather than about the screen. The check does not take its word
   * for it: whether the view is actually painting is settled by sampling the
   * window's own captured pixels, which is a reader the browser host has
   * nothing to do with.
   */
  inspect(id: number): {
    bounds: { x: number; y: number; width: number; height: number }
    visible: boolean
    partition: string
    webContentsId: number
    url: string
  } | null
  /** The view's own frame, for the hidden-but-live assertion. */
  capture(id: number): Promise<{ width: number; height: number; bitmap: Buffer } | null>
  /** A synthesised click **into the view**, which is the third of the three. */
  click(id: number, x: number, y: number): Promise<void>
}

export interface BrowserHostOptions {
  window: () => BrowserWindow | null
  /** Read through a function: the reach posture can change while a view is open. */
  settings: () => AppSettings
  /** Writes the remembered addresses. Main owns them, like the view. */
  writeSettings: (patch: Partial<AppSettings>) => void
  onChanged: (state: BrowserState) => void
  onOpened: (state: BrowserState) => void
  onClosed: (id: number) => void
  onLogged: (id: number, entry: BrowserConsoleEntry) => void
}

// ---------------------------------------------------------------------------
// The exemption registry
// ---------------------------------------------------------------------------

/**
 * The `webContents.id` of every live browser view.
 *
 * Module-level rather than on the host because the guard that reads it is
 * `app.on('web-contents-created')` in `index.ts`, which is armed before any
 * host exists and covers web contents this file did not make. A view is added
 * the instant it is constructed and removed the instant it is destroyed, so an
 * id that has been recycled onto some other web contents cannot inherit the
 * exemption.
 */
const exempt = new Set<number>()

/** For the check: proof the exemption is a finite set and not a mood. */
export function exemptedWebContents(): number[] {
  return [...exempt]
}

/**
 * The app-global `will-navigate` guard's one question.
 *
 * Returns true only for a browser view going somewhere `browserReachAllows`
 * allows. Everything else - the app's own renderer, the spike page, an
 * artifact frame - gets false and is prevented, which is the posture the app
 * had before this pane existed and still has.
 *
 * A refusal is recorded on the view so the pane can paint a sentence rather
 * than sit there having silently done nothing.
 */
export function browserWillNavigate(webContentsId: number, url: string): boolean {
  if (!exempt.has(webContentsId)) return false
  const host = hostForContents(webContentsId)
  if (host === null) return false
  return host.allowNavigation(webContentsId, url)
}

/**
 * The app-global window-open guard's one question.
 *
 * The Chromium window is denied either way - the guard still returns
 * `{ action: 'deny' }` for everything, which is what "never by loosening the
 * guard" means. What this adds is that for a browser view the URL becomes a new
 * Helm browser tab instead of nothing, capped at `BROWSER_TABS_MAX`.
 */
export function browserWindowOpen(webContentsId: number, url: string): void {
  if (!exempt.has(webContentsId)) return
  hostForContents(webContentsId)?.spawnFrom(webContentsId, url)
}

/**
 * The one host, found from a web contents id.
 *
 * There is exactly one window and therefore one host, but this is written as a
 * lookup rather than a global because the alternative - a module-level `let
 * host` - is a variable a second window would silently overwrite.
 */
const hosts = new Set<InternalHost>()
function hostForContents(id: number): InternalHost | null {
  for (const host of hosts) if (host.owns(id)) return host
  return null
}

interface InternalHost {
  owns(webContentsId: number): boolean
  allowNavigation(webContentsId: number, url: string): boolean
  spawnFrom(webContentsId: number, url: string): void
  /** A download this partition refused, so every open pane can say so. */
  noteDownload(url: string): void
}

// ---------------------------------------------------------------------------
// The shared partition
// ---------------------------------------------------------------------------

let configured: Session | null = null

/**
 * The browser profile, configured once.
 *
 * Everything a page might ask this process for is answered here, and every
 * answer is stated rather than left to a default - Electron's defaults do not
 * all deny, and a posture that depends on which ones do is a posture that
 * changes with the runtime.
 *
 * **Helm reads nothing out of this partition.** No cookie, no localStorage, no
 * credential of any kind. The one thing it ever does to it is
 * `clearStorageData`, from a button in the pane, and that is a write.
 */
export function browserSession(): Session {
  if (configured !== null) return configured
  const partition = session.fromPartition(BROWSER_PARTITION)

  /*
   * Every permission, denied. Named rather than filtered, because a list of
   * permissions to allow is a list somebody extends, and there is nothing in a
   * dev-server viewport that wants a camera.
   */
  partition.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  partition.setPermissionCheckHandler(() => false)
  partition.setDevicePermissionHandler(() => false)

  /*
   * Downloads, denied, with the handoff.
   *
   * Helm's browser does not put files on your disk - the app has no download
   * manager, no place to put one, and no business being the thing that wrote an
   * executable into somebody's Downloads folder. The URL goes to the system
   * browser instead, which does have all three.
   *
   * `shell.openExternal` on an arbitrary scheme is a way to run a program, so
   * the same http/https rule the pane navigates under applies here.
   */
  partition.on('will-download', (event, item) => {
    event.preventDefault()
    const url = item.getURL()
    if (browserReachAllows(url, 'web').allowed) void shell.openExternal(url)
    for (const host of hosts) host.noteDownload(url)
  })

  /**
   * A self-signed certificate is accepted for **loopback only**.
   *
   * A local dev server on https with a certificate it minted itself is the
   * exact case this pane exists for, and refusing it would make the pane
   * useless for the framework that turned https on by default. Everywhere else
   * `-3` hands the verdict back to Chromium, which refuses - and there is
   * deliberately **no `certificate-error` handler anywhere in Helm**, so there
   * is no click-through: a bad certificate on a real host is a page that does
   * not load and a sentence in the pane.
   */
  partition.setCertificateVerifyProc((request, callback) => {
    callback(isLoopbackHostname(request.hostname) ? 0 : -3)
  })

  configured = partition
  return partition
}

/**
 * The host part of a URL, or the empty string.
 *
 * A view can legitimately be at `about:blank` - that is what a new tab is - and
 * at a URL Chromium is still resolving, so this has to answer rather than throw.
 */
function hostOf(url: string): string {
  if (url === '') return ''
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** `isLoopbackUrl`'s question asked of a bare hostname, which is what a
 * certificate request carries. One list, in core, either way. */
function isLoopbackHostname(hostname: string): boolean {
  return isLoopbackUrl(`https://${hostname.includes(':') ? `[${hostname}]` : hostname}/`)
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

export function createBrowserHost(options: BrowserHostOptions): BrowserHost {
  const views = new Map<number, View>()
  let nextId = 1

  const settings = (): AppSettings => options.settings()
  const reach = (): BrowserReach => settings().browserReach

  const viewFor = (id: number): View | null => views.get(id) ?? null

  const state = (entry: View): BrowserState => {
    const wc = entry.view.webContents
    const alive = !wc.isDestroyed()
    const url = alive ? wc.getURL() : ''
    const host = hostOf(url)
    const errors = entry.console.filter(
      (line) => line.level === 'error' || line.level === 'warning'
    ).length
    return {
      id: entry.id,
      url,
      title: alive && wc.getTitle() !== '' ? wc.getTitle() : host,
      host,
      canGoBack: alive && wc.navigationHistory.canGoBack(),
      canGoForward: alive && wc.navigationHistory.canGoForward(),
      loading: alive && wc.isLoading(),
      problem: entry.problem,
      retryingUntil: entry.retry?.until ?? null,
      zoomLevel: alive ? wc.getZoomLevel() : 0,
      errors,
      devtoolsOpen: alive && wc.isDevToolsOpened(),
      find: entry.find,
      project: entry.project
    }
  }

  const announce = (entry: View): BrowserState => {
    const next = state(entry)
    options.onChanged(next)
    return next
  }

  const log = (entry: View, line: Omit<BrowserConsoleEntry, 'at'>): void => {
    const full: BrowserConsoleEntry = { ...line, at: Date.now() }
    entry.console.push(full)
    if (entry.console.length > CONSOLE_RING) entry.console.shift()
    options.onLogged(entry.id, full)
  }

  /**
   * Remember where a view got to.
   *
   * Written from main rather than from the window because main is the side that
   * knows a navigation *succeeded*: the renderer only ever sees what it asked
   * for, and a redirect, a retry that finally connected, or a `window.open`
   * would all be missing from a list the window kept.
   */
  const remember = (entry: View, url: string): void => {
    const current = settings()
    const recent = [url, ...current.browserRecentUrls.filter((seen) => seen !== url)].slice(
      0,
      BROWSER_RECENT_URLS_MAX
    )
    const patch: Partial<AppSettings> = { browserRecentUrls: recent }
    if (entry.project !== null) {
      const key = entry.project.toLowerCase()
      const projects = { ...current.browserProjectUrls, [key]: url }
      const keys = Object.keys(projects)
      if (keys.length > BROWSER_PROJECT_URLS_MAX) {
        for (const stale of keys.slice(0, keys.length - BROWSER_PROJECT_URLS_MAX)) {
          delete projects[stale]
        }
      }
      patch.browserProjectUrls = projects
    }
    try {
      options.writeSettings(patch)
    } catch {
      // A remembered address is a convenience. A validator refusing one is a
      // bug worth fixing and never a reason to fail the navigation the user
      // actually asked for.
    }
  }

  const stopRetry = (entry: View): void => {
    if (entry.retry?.timer) clearTimeout(entry.retry.timer)
    entry.retry = null
  }

  /**
   * The quiet reconnect.
   *
   * The papercut this pane's framing exists to remove: you open the viewport,
   * then start `pnpm dev`. Rather than an error page you have to reload, the
   * view keeps knocking for about half a minute and connects when the server
   * appears. Only `ERR_CONNECTION_REFUSED` gets this - a name that does not
   * resolve, a certificate that was refused and a 500 are all answers, and
   * retrying an answer is just asking twice.
   */
  const scheduleRetry = (entry: View, url: string): void => {
    const now = Date.now()
    const until = entry.retry?.until ?? now + RETRY_FOR_MS
    if (now >= until) {
      stopRetry(entry)
      entry.problem = `Nothing is listening at ${url}. Helm retried for ${String(
        RETRY_FOR_MS / 1000
      )} seconds; press reload once the server is up.`
      announce(entry)
      return
    }
    const step = entry.retry?.step ?? 0
    const wait = RETRY_STEPS_MS[Math.min(step, RETRY_STEPS_MS.length - 1)] ?? 4000
    const timer = setTimeout(() => {
      if (entry.view.webContents.isDestroyed()) return
      void entry.view.webContents.loadURL(url).catch(() => undefined)
    }, wait)
    entry.retry = { url, until, step: step + 1, timer }
    entry.problem = `Waiting for ${url} to answer…`
    announce(entry)
  }

  /**
   * Load a URL that has already been through the reach rule.
   *
   * The rule is applied here *and* in `will-navigate`, and that is not a second
   * copy of it: both call `browserReachAllows`. This one is what turns a
   * refusal into a sentence in the pane before anything is fetched; the
   * `will-navigate` one is what catches a redirect, a link click and a page
   * navigating itself, which never come through here at all.
   */
  const load = (entry: View, url: string): BrowserState => {
    const decision = browserReachAllows(url, reach())
    if (!decision.allowed) {
      stopRetry(entry)
      entry.problem = decision.problem
      log(entry, { level: 'error', message: decision.problem ?? 'refused', source: url, line: 0 })
      return announce(entry)
    }
    stopRetry(entry)
    entry.problem = null
    void entry.view.webContents.loadURL(url).catch(() => undefined)
    return announce(entry)
  }

  const attach = (entry: View): void => {
    const win = options.window()
    if (win === null || win.isDestroyed() || entry.attached) return
    win.contentView.addChildView(entry.view)
    entry.attached = true
  }

  const destroy = (entry: View, tellTheWindow: boolean): void => {
    stopRetry(entry)
    views.delete(entry.id)
    exempt.delete(entry.view.webContents.id)
    const win = options.window()
    if (entry.attached && win !== null && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(entry.view)
      } catch {
        // The window is on its way out; there is nothing to detach from.
      }
    }
    entry.attached = false
    const wc = entry.view.webContents
    if (!wc.isDestroyed()) {
      if (wc.isDevToolsOpened()) wc.closeDevTools()
      wc.close()
    }
    if (tellTheWindow) options.onClosed(entry.id)
  }

  const create = (project: string | null): View => {
    const view = new WebContentsView({
      webPreferences: {
        // Every one of these is stated, and the ones that are Electron's
        // default are stated *because* they are: this is the one place in Helm
        // that renders somebody else's HTML with a network behind it, and a
        // posture made of defaults is a posture that moves when Electron does.
        session: browserSession(),
        // No preload. Nothing of Helm's runs in a page, so there is no bridge
        // to abuse and nothing for a hostile page to find.
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webviewTag: false,
        // A page that could open another `<webview>`-shaped thing, or reach the
        // window through `window.opener`, would be a page with a route out.
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        spellcheck: false
      }
    })
    // Registered here, in the constructor path, so that by the time the guard in
    // `index.ts` runs its listener - which is when a navigation is attempted,
    // not when it was attached - this id is known.
    exempt.add(view.webContents.id)

    const entry: View = {
      id: nextId++,
      view,
      project,
      console: [],
      problem: null,
      retry: null,
      find: null,
      attached: false,
      // A new view paints nothing until the window has said where it goes. The
      // alternative is a view at whatever bounds Electron defaults to, over
      // the app, for the frame between construction and the first report.
      visible: false
    }
    views.set(entry.id, entry)

    const wc = view.webContents

    /*
     * The ground the page paints on before it has painted.
     *
     * Foreign ground (DESIGN.md 6): the view's own ground is the page's, and
     * Helm has no business tinting it. What it can do is not flash white on a
     * dark canvas for the frame between attaching and the first paint.
     */
    view.setBackgroundColor('#00000000')
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    view.setVisible(false)

    wc.on('page-title-updated', () => announce(entry))
    wc.on('did-start-loading', () => announce(entry))
    wc.on('did-stop-loading', () => announce(entry))

    /*
     * A navigation that **arrived somewhere**.
     *
     * `httpResponseCode` is the discriminator and it is load-bearing. Chromium
     * commits an *error page* when a load fails, which is a main-frame
     * navigation like any other - so this fires for a connection that was
     * refused, and without the guard it would cancel the retry that had just
     * been scheduled and write the address that failed into the list of places
     * the pane has been. A real response carries a status; an error page
     * carries `-1`.
     *
     * Caught by `BR-24` on its first run: the page still arrived eventually,
     * because the retry that was cancelled had already fired - so the only
     * visible symptom was a pane that never said it was waiting. A probe that
     * had only asked "did it connect in the end" would have passed.
     */
    wc.on('did-navigate', (_event, url, httpResponseCode) => {
      if (httpResponseCode <= 0) {
        announce(entry)
        return
      }
      stopRetry(entry)
      entry.problem = null
      entry.find = null
      remember(entry, url)
      announce(entry)
    })
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) remember(entry, url)
      announce(entry)
    })

    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      // A load a newer navigation replaced is not a failure, and painting it as
      // one would put an error on the pane every time somebody types fast.
      if (errorCode === ERR_ABORTED) return
      log(entry, {
        level: 'error',
        message: `${errorDescription} (${String(errorCode)}) loading ${validatedURL}`,
        source: validatedURL,
        line: 0
      })
      if (errorCode === ERR_CONNECTION_REFUSED) {
        scheduleRetry(entry, validatedURL)
        return
      }
      stopRetry(entry)
      entry.problem = certificateSentence(errorDescription, validatedURL)
      announce(entry)
    })

    /*
     * The console, generalised from the artifact capture in `content.ts`.
     *
     * The shape is checked rather than assumed, for the reason that one gives:
     * a future Electron that stopped populating these fields would make this
     * listener silently record nothing, and a console panel that is empty
     * because there was nothing to say looks exactly like one that is empty
     * because it stopped listening. An unrecognised event is recorded.
     */
    wc.on('console-message', (event) => {
      if (typeof event.level !== 'string' || typeof event.message !== 'string') {
        log(entry, {
          level: 'error',
          message: `console-message arrived in a shape Helm does not recognise: ${JSON.stringify(
            Object.keys(event)
          )}`,
          source: 'helm',
          line: 0
        })
        return
      }
      log(entry, {
        level: event.level,
        message: event.message,
        source: typeof event.sourceId === 'string' ? event.sourceId : '',
        line: typeof event.lineNumber === 'number' ? event.lineNumber : 0
      })
      announce(entry)
    })

    wc.on('found-in-page', (_event, result) => {
      entry.find = {
        query: entry.find?.query ?? '',
        matches: result.matches,
        active: result.activeMatchOrdinal
      }
      announce(entry)
    })

    wc.on('devtools-opened', () => announce(entry))
    wc.on('devtools-closed', () => announce(entry))

    // A page whose render process died leaves a view that paints nothing and
    // answers nothing. The tab goes with it rather than sitting there.
    wc.on('render-process-gone', () => {
      destroy(entry, true)
    })

    attach(entry)
    return entry
  }

  const host: BrowserHost & InternalHost = {
    owns(webContentsId) {
      for (const entry of views.values()) {
        if (!entry.view.webContents.isDestroyed() && entry.view.webContents.id === webContentsId) {
          return true
        }
      }
      return false
    },

    allowNavigation(webContentsId, url) {
      for (const entry of views.values()) {
        if (entry.view.webContents.isDestroyed()) continue
        if (entry.view.webContents.id !== webContentsId) continue
        const decision = browserReachAllows(url, reach())
        if (decision.allowed) return true
        entry.problem = decision.problem
        log(entry, {
          level: 'error',
          message: decision.problem ?? 'refused',
          source: url,
          line: 0
        })
        announce(entry)
        return false
      }
      return false
    },

    spawnFrom(webContentsId, url) {
      for (const entry of views.values()) {
        if (entry.view.webContents.isDestroyed()) continue
        if (entry.view.webContents.id !== webContentsId) continue
        if (views.size >= BROWSER_TABS_MAX) {
          entry.problem = `A page tried to open another window and Helm is already holding ${String(
            BROWSER_TABS_MAX
          )} browser tabs. Close one, or open the address in your own browser.`
          log(entry, {
            level: 'warning',
            message: `window.open(${url}) refused: ${String(BROWSER_TABS_MAX)} tabs is the cap`,
            source: url,
            line: 0
          })
          announce(entry)
          return
        }
        const opened = create(entry.project)
        load(opened, url)
        options.onOpened(state(opened))
        return
      }
    },

    noteDownload(url: string) {
      for (const entry of views.values()) {
        entry.problem = `Helm's browser does not download files. ${url} was handed to your own browser instead.`
        log(entry, {
          level: 'warning',
          message: `download refused and handed to the system browser: ${url}`,
          source: url,
          line: 0
        })
        announce(entry)
      }
    },

    open({ url, project }) {
      if (views.size >= BROWSER_TABS_MAX) {
        return {
          state: null,
          problem: `Helm holds at most ${String(BROWSER_TABS_MAX)} browser tabs. Close one first.`
        }
      }
      const entry = create(project ?? null)
      // No address is a legitimate new tab: the caret goes in the address bar
      // and nothing is fetched, which is what a new-tab button should do.
      const wanted =
        url ??
        (project === undefined || project === null
          ? undefined
          : settings().browserProjectUrls[project.toLowerCase()])
      if (wanted === undefined) return { state: state(entry), problem: null }
      const resolved = resolveBrowserAddress(wanted)
      if (resolved.url === null) {
        entry.problem = resolved.problem
        return { state: announce(entry), problem: resolved.problem }
      }
      const next = load(entry, resolved.url)
      return { state: next, problem: next.problem }
    },

    navigate(id, input) {
      const entry = viewFor(id)
      if (entry === null) return null
      const resolved = resolveBrowserAddress(input)
      if (resolved.url === null) {
        stopRetry(entry)
        entry.problem = resolved.problem
        // Nothing was fetched, and that is the claim `BR-15` makes: the address
        // bar never hands anything to a search engine, so a word produces a
        // sentence and no request at all.
        return announce(entry)
      }
      return load(entry, resolved.url)
    },

    back(id) {
      const entry = viewFor(id)
      if (entry === null) return null
      if (entry.view.webContents.navigationHistory.canGoBack()) {
        entry.view.webContents.navigationHistory.goBack()
      }
      return announce(entry)
    },

    forward(id) {
      const entry = viewFor(id)
      if (entry === null) return null
      if (entry.view.webContents.navigationHistory.canGoForward()) {
        entry.view.webContents.navigationHistory.goForward()
      }
      return announce(entry)
    },

    reload(id, hard) {
      const entry = viewFor(id)
      if (entry === null) return null
      stopRetry(entry)
      entry.problem = null
      if (hard) entry.view.webContents.reloadIgnoringCache()
      else entry.view.webContents.reload()
      return announce(entry)
    },

    close(id) {
      const entry = viewFor(id)
      if (entry !== null) destroy(entry, false)
    },

    states(id) {
      if (id === undefined) return [...views.values()].map(state)
      const entry = viewFor(id)
      return entry === null ? [] : [state(entry)]
    },

    async evaluate(id, source) {
      const entry = viewFor(id)
      if (entry === null) return { ok: false, value: '', error: 'That browser tab is gone.' }
      try {
        // `true` for a user gesture, because an expression typed into a console
        // is one - without it a page's own `requestFullscreen`-shaped APIs
        // reject and the panel would report a browser policy as a page error.
        const answer: unknown = await entry.view.webContents.executeJavaScript(source, true)
        return { ok: true, value: describeValue(answer), error: null }
      } catch (err) {
        return { ok: false, value: '', error: err instanceof Error ? err.message : String(err) }
      }
    },

    devtools(id) {
      const entry = viewFor(id)
      if (entry === null) return null
      const wc = entry.view.webContents
      if (wc.isDevToolsOpened()) wc.closeDevTools()
      // Detached, deliberately: a docked DevTools is a second rectangle inside
      // the window whose size Helm would then have to keep out of the
      // placeholder's bounds, which is the bounds-sync problem twice.
      else wc.openDevTools({ mode: 'detach' })
      return announce(entry)
    },

    find(id, query, forward) {
      const entry = viewFor(id)
      if (entry === null) return
      if (query === '') {
        entry.view.webContents.stopFindInPage('clearSelection')
        entry.find = null
        announce(entry)
        return
      }
      entry.find = { query, matches: entry.find?.matches ?? 0, active: entry.find?.active ?? 0 }
      /*
       * The page is focused first, and that is required rather than polite.
       *
       * Chromium's find controller belongs to the focused web contents, and the
       * caret is in the pane's find field - which is the *window's* contents,
       * not the view's. Measured: without this, `findInPage` on a visible view
       * showing text that plainly contains the word returns zero matches, which
       * is indistinguishable from a page that does not contain it.
       */
      entry.view.webContents.focus()
      entry.view.webContents.findInPage(query, { forward, findNext: entry.find.active > 0 })
    },

    stopFind(id) {
      const entry = viewFor(id)
      if (entry === null) return
      entry.view.webContents.stopFindInPage('clearSelection')
      entry.find = null
      announce(entry)
    },

    zoom(id, level) {
      const entry = viewFor(id)
      if (entry === null) return null
      entry.view.webContents.setZoomLevel(Math.max(-3, Math.min(3, level)))
      return announce(entry)
    },

    async clearStorage(id) {
      const entry = viewFor(id)
      if (entry === null) return null
      await browserSession().clearStorageData()
      log(entry, {
        level: 'info',
        message: 'Cleared cookies and storage for the browser profile.',
        source: 'helm',
        line: 0
      })
      return announce(entry)
    },

    entries(id) {
      return viewFor(id)?.console ?? []
    },

    bounds(payload) {
      const entry = viewFor(payload.id)
      const win = options.window()
      if (entry === null || win === null || win.isDestroyed()) return
      if (entry.view.webContents.isDestroyed()) return

      /*
       * CSS pixels to DIPs.
       *
       * `setBounds` is in DIPs and the placeholder measured itself in CSS
       * pixels, and the two are equal only at zoom factor 1. Converted rather
       * than asserted, because the window's zoom is a thing a person can change
       * with Ctrl+= and a view that silently drifted from its placeholder would
       * be a seam nobody could explain. The factor is read here because the
       * window is the side that has it.
       */
      const zoom = win.webContents.getZoomFactor()
      const x = Math.round(payload.x * zoom)
      const width = Math.round(payload.width * zoom)
      const wantedY = Math.round(payload.y * zoom)
      const wantedHeight = Math.round(payload.height * zoom)

      /*
       * And the title bar.
       *
       * The window hides the native frame and lets Windows draw the min/max/
       * close buttons in the top 36px (see `chrome.ts`). A native view is above
       * all of that, so a view whose rectangle reached into those pixels would
       * be a view sitting on top of the close button. The renderer's layout
       * already puts the placeholder well below it; this is the guarantee, not
       * the layout.
       */
      const top = TITLEBAR_OVERLAY.dark.height
      const y = Math.max(top, wantedY)
      const height = Math.max(0, wantedHeight - (y - wantedY))

      entry.view.setBounds({ x, y, width, height })
      /*
       * Hiding, and every reason for it, folded into one boolean by the window.
       *
       * `setVisible(false)` rather than parking the view outside the window,
       * and the spike above is why that choice is available: it leaves the page
       * capturable, scriptable and clickable, which is what M17 needs of a tab
       * nobody is looking at. It also stops the view painting, which parking
       * does not, so it is the one of the two that is actually a *hide*.
       */
      entry.view.setVisible(payload.visible)
      entry.visible = payload.visible
    },

    shutdown() {
      for (const entry of [...views.values()]) destroy(entry, false)
    },

    inspect(id) {
      const entry = viewFor(id)
      if (entry === null || entry.view.webContents.isDestroyed()) return null
      return {
        bounds: entry.view.getBounds(),
        visible: entry.visible,
        partition: BROWSER_PARTITION,
        webContentsId: entry.view.webContents.id,
        url: entry.view.webContents.getURL()
      }
    },

    async capture(id) {
      const entry = viewFor(id)
      if (entry === null || entry.view.webContents.isDestroyed()) return null
      const image = await entry.view.webContents.capturePage()
      const size = image.getSize()
      return { width: size.width, height: size.height, bitmap: image.toBitmap() }
    },

    async click(id, x, y) {
      const entry = viewFor(id)
      if (entry === null || entry.view.webContents.isDestroyed()) return
      const at = { x: Math.round(x), y: Math.round(y), button: 'left' as const, clickCount: 1 }
      entry.view.webContents.sendInputEvent({ type: 'mouseDown', ...at })
      entry.view.webContents.sendInputEvent({ type: 'mouseUp', ...at })
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
  }

  hosts.add(host)
  app.once('will-quit', () => hosts.delete(host))
  return host
}

/**
 * What a value evaluated to, as a string the panel can print.
 *
 * `executeJavaScript` already refuses to return anything that will not cross
 * the process boundary, so by the time a value gets here it is JSON-shaped or
 * `undefined`. What is left is making that readable: `undefined` has to be
 * distinguishable from the empty string, and an object has to be legible
 * without a viewer.
 */
function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * A load failure as a sentence, with the certificate case spelled out.
 *
 * A certificate error is the one failure where the honest message has to say
 * that there is no way past it, because every other browser offers one. Helm
 * does not: the exception is loopback and nothing else, and there is no button.
 */
function certificateSentence(description: string, url: string): string {
  if (description.startsWith('ERR_CERT') || description.includes('CERT_')) {
    return `${url} presented a certificate Helm will not accept (${description}). Self-signed certificates are accepted for localhost only, and there is no way past this - open the page in your own browser if you trust it.`
  }
  return `${url} could not be loaded: ${description}.`
}
