import {
  app,
  session,
  shell,
  WebContentsView,
  type BrowserWindow,
  type Session,
  type WebContents,
  type WebPreferences,
  type WindowOpenHandlerResponse
} from 'electron'
import {
  agentReach,
  BROWSER_PROJECT_URLS_MAX,
  BROWSER_RECENT_URLS_MAX,
  browserReachAllows,
  isLoopbackUrl,
  resolveBrowserAddress,
  type AppSettings,
  type BrowserReach
} from '@helm/core'
import { TITLEBAR_HEIGHT } from './chrome'
import { browserKeyCommand, COMMANDS_FOR_THE_WINDOW, COMMANDS_THAT_REPEAT } from '../shared/browserKeys'
import {
  BROWSER_TABS_MAX,
  type BrowserCommandEvent,
  type BrowserConsoleEntry,
  type BrowserOpened,
  type BrowserShare,
  type BrowserState
} from '../shared/ipc'

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
 * `BROWSER_LIVE_WHILE_HIDDEN` below is that answer pinned where the code is.
 *
 * **And a sixth thing, which M17 added.** A tab a session opened is never
 * mounted by the window, so it never reports a rectangle and its document would
 * never paint - and every one of the three guarantees above turns out to have
 * required a document that has painted once. `AGENT_PEEK` is the answer and the
 * comment there is the measurement; `openFor`, `showAgentView` and
 * `primeAgentView` are the three lines of it.
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
 * If a future Electron changes that, the choice below changes with it.
 */
export const BROWSER_LIVE_WHILE_HIDDEN = true

/** The partition every browser view shares. Never the window's session. */
export const BROWSER_PARTITION = 'persist:helm-browser'

/**
 * Which session opened a tab, and the identity a tool is checked against.
 *
 * `key` is the session's bearer token and is never shown anywhere: it is what
 * makes "only a tab this session opened" a comparison rather than a promise,
 * and it cannot be guessed or spoofed from inside a page. `name` is the tab's
 * label - the thing a person reads in the strip and the whole of the
 * attribution affordance.
 */
export interface BrowserOpener {
  key: string
  name: string
}

/** A share: the session's identity for the tools, and its id for the window. */
export interface BrowserShareTo {
  opener: BrowserOpener
  session: number
}

/**
 * The rectangle a view gets when **nothing is looking at it**.
 *
 * A tab the window has mounted reports its own rectangle every frame. A tab an
 * agent opened has no pane at all - the workspace strip only mounts the pane
 * for the tab in front - so without this it would sit at the 0x0 every view is
 * constructed with, and every claim M17 makes about a tab nobody is looking at
 * would be a claim about a view with no pixels: a screenshot of nothing, a
 * click at a coordinate outside the page, a layout that never ran.
 *
 * So an agent-opened view is given a page-sized rectangle up front, hidden. It
 * is replaced the moment the user brings that tab to the front and the pane
 * starts reporting - this is the *floor*, not a second layout.
 */
const AGENT_VIEW_SIZE = { width: 1280, height: 800 }

/**
 * The rectangle an agent's first page is loaded into, and the ceiling on how
 * long it stays there.
 *
 * **M16's guarantee has a precondition nobody had reason to notice: the
 * document has to have painted once while the view was shown.**
 * `setVisible(false)` leaves a view capturable, scriptable and clickable - that
 * is the spike - but every measurement behind it was made on a page that had
 * been on screen first, and the spike's freshness probe repainted a document
 * that was *already* composited. A view whose document has never
 * painted is a different thing, and it was measured while writing M17, on
 * Electron 43.3.0:
 *
 *   - `executeJavaScript` answers perfectly, so nothing looks broken;
 *   - `window.innerWidth` and `innerHeight` are **0**, whatever `setBounds` was
 *     told, so `body` is 0x0 and every element reads as invisible to a
 *     snapshot;
 *   - `capturePage()` comes back empty;
 *   - and a synthesised click lands on nothing, because hit-testing needs the
 *     compositor data a frame would have produced.
 *
 * Which is four of the five things M17 exists to do. Three ways round it were
 * tried and measured before this one:
 *
 *   - **parking the view outside the window** leaves it occluded, so the
 *     viewport stays 0x0 - `setVisible` is not the deciding factor;
 *   - **`webContents.enableDeviceEmulation`**, which forces a viewport size for
 *     DevTools, **crashes the process** on a `WebContentsView`: the run died
 *     with no report at all;
 *   - **showing it empty before the load** gives the page a viewport and a
 *     snapshot, and still leaves capture and click dead - which is what says
 *     the precondition is about the *document* painting rather than about the
 *     view having been shown.
 *
 * So the document is loaded into a view that is genuinely on screen, at the
 * **full size a page expects**, positioned so that all but a two-pixel corner
 * of it falls outside the window and is clipped away. Chromium sees a shown,
 * unoccluded, 1280-wide widget and gives the page a real viewport and a real
 * frame; the user sees two pixels in the bottom corner for as long as the page
 * takes to load. Then it is hidden, and only *moved* - never resized, because a
 * `setBounds` on a hidden view does not reach the renderer either, so a view
 * loaded small and enlarged afterwards keeps the small viewport for ever. That
 * was measured too.
 *
 * `BR-33` is what says all of it still holds, and it reads the screen rather
 * than this file: the window is photographed while every tool runs against the
 * tab, and the page's colour must appear nowhere in it.
 */
const AGENT_PEEK = 2
/** A page that never finishes loading is still a page. Past this it is hidden
 * anyway, with whatever it has painted. */
const AGENT_PRIME_MAX_MS = 15_000

/**
 * How many popup windows a browser view may have open at once.
 *
 * Small on purpose. A sign-in needs one, and a provider that hands off to
 * another provider needs two; past that the number stops describing an auth
 * flow and starts describing a page opening windows at somebody. The pane is
 * where the refusal is said, so a flow that genuinely needed a fifth window
 * fails with a sentence rather than silently.
 */
export const BROWSER_POPUPS_MAX = 4

/** The size a popup gets when the page named none. A sign-in dialog's shape. */
const POPUP_DEFAULT = { width: 520, height: 640 }
/** And the range one is clamped into, so `window.open` cannot size a window
 * off the screen or down to a slit. */
const POPUP_MIN = { width: 320, height: 320 }
const POPUP_MAX = { width: 1400, height: 1100 }

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
  /**
   * The `webContents.id` this view was constructed with, kept rather than read.
   *
   * It is the key into the navigation-guard registry, and the moment it is
   * needed most - retiring a view - is the moment it can no longer be asked
   * for: a page that closed itself leaves `view.webContents` undefined, so a
   * `destroy` that read the id off the object would throw on its way to
   * removing the exemption and leave the id in the registry for ever.
   */
  webContentsId: number
  project: string | null
  console: BrowserConsoleEntry[]
  /** What the pane should say is wrong, or null. */
  problem: string | null
  /** The address a retry is trying to reach, and when it gives up. */
  retry: { url: string; until: number; step: number; timer: NodeJS.Timeout | null } | null
  find: { query: string; matches: number; active: number } | null
  /** The id `findInPage` returned for the newest search. Results for any other are stale. */
  findRequest: number | null
  /** The session that opened this tab, or null when the user did. */
  openedBy: BrowserOpener | null
  /** Set once the session in `openedBy` has ended (`revoke`). Its name stays; its reach does not. */
  openerEnded: boolean
  /**
   * The session the user let read and drive this tab, and that session's id
   * for the window. Only ever on a tab the user opened, and gone the moment
   * that session ends.
   */
  sharedWith: BrowserShareTo | null
  /** Whether this view is attached to the window's content view right now. */
  attached: boolean
  /**
   * Whether this view is sitting outside the window because nothing has ever
   * reported a rectangle for it. True only for a tab an agent opened that the
   * user has not brought to the front; `bounds()` clears it for good.
   */
  parked: boolean
  /**
   * How many of an agent's key events are being delivered right now.
   * `sendInputEvent` raises `before-input-event` synchronously (measured on
   * Electron 43.3.0), so a key an agent presses arrives while this is above
   * zero - and it is the page's, never a Browser tab command: an agent pressing
   * Ctrl+T must not open the user a page, nor Ctrl+W close one.
   */
  agentInput: number
  /**
   * Set while the page has the whole screen (`requestFullscreen`): what sizes
   * the view to the window, kept so it can be unhooked from the window's
   * `resize` when the page lets go.
   */
  fullscreen: (() => void) | null
  /** Where the pane last put this view, and whether it showed. Fullscreen puts it back here. */
  placed: { x: number; y: number; width: number; height: number; visible: boolean } | null
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
  /** The page as a picture (a PNG data URL), for the window to show while the view stands down. */
  snapshot(id: number): Promise<string | null>
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

  // -------------------------------------------------------------------------
  // The agent surface (M17)
  //
  // Separate entry points rather than an extra argument on the ones above, and
  // that is the point: every call that carries a `BrowserOpener` is a call a
  // session made, and the two things that make an agent different from the
  // pane - attribution, and the narrower reach - are visible at the call site
  // rather than folded into a boolean somewhere inside.
  // -------------------------------------------------------------------------

  /**
   * Open a tab **for a session**, at a URL that has already been through the
   * reach rule. The tab carries the session's name and is hidden, with a
   * rectangle, because nothing is looking at it.
   */
  openFor(
    opener: BrowserOpener,
    url: string
  ): Promise<{ state: BrowserState | null; problem: string | null }>
  /**
   * Navigate a tab the session opened or the user shared with it. Refuses
   * anything else, in a sentence.
   */
  navigateFor(
    opener: BrowserOpener,
    id: number,
    url: string
  ): { state: BrowserState | null; problem: string | null }
  /** Close a tab the session opened. Refuses anything else, in a sentence. */
  closeFor(opener: BrowserOpener, id: number): { closed: boolean; problem: string | null }
  /** Who opened a view, or null. The comparison behind `closeFor`. */
  openerOf(id: number): BrowserOpener | null
  /** The session the user shared a view with, or null. */
  sharedWith(id: number): BrowserOpener | null
  /**
   * Let a session read and drive a tab the user opened, or (`null`) take it
   * back. One share at a time; a new one replaces the old. Answered unchanged
   * for a tab an agent opened, which is its session's already, and for a
   * session `sessionOpener` does not answer for.
   */
  share(id: number, session: number | null): BrowserState | null
  /** The sessions a tab can be shared with right now. */
  shareTargets(): BrowserShare[]
  /**
   * A session has ended and its token with it: every tab shared with it is
   * taken back, and the tabs it opened stop saying it can drive them.
   */
  revoke(key: string): void
  /** The view's rectangle and page-side size, for aiming input at it. */
  viewport(id: number): { width: number; height: number; zoom: number } | null
  /** The view's own frame as PNG bytes. What `browser_screenshot` returns. */
  capturePng(id: number): Promise<{ width: number; height: number; png: Buffer } | null>
  /** A real mouse press and release at a point in the view. */
  pointer(
    id: number,
    x: number,
    y: number,
    options?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }
  ): Promise<void>
  /** A real pointer move to a point in the view, and nothing pressed: a hover. */
  hover(id: number, x: number, y: number): Promise<void>
  /**
   * A real wheel turn at a point in the view, by `dx` and `dy` pixels -
   * positive is right and down. Whatever is under the point scrolls, as it
   * would under a person's wheel.
   */
  scroll(id: number, x: number, y: number, dx: number, dy: number): Promise<void>
  /** Real key events for each character. Goes wherever the page's focus is. */
  typeInto(id: number, text: string): Promise<void>
  /** One key, with modifiers. `Enter`, `Tab`, `ArrowDown`, `a`. */
  press(
    id: number,
    key: string,
    modifiers?: readonly ('shift' | 'control' | 'alt' | 'meta')[]
  ): Promise<void>
}

export interface BrowserHostOptions {
  window: () => BrowserWindow | null
  /** Read through a function: the reach posture can change while a view is open. */
  settings: () => AppSettings
  /** Writes the remembered addresses. Main owns them, like the view. */
  writeSettings: (patch: Partial<AppSettings>) => void
  onChanged: (state: BrowserState) => void
  /** A page the window did not ask for: a page's `window.open`, or an agent's. */
  onOpened: (opened: BrowserOpened) => void
  onClosed: (id: number) => void
  /** A Browser tab key pressed with the caret in a page - see `before-input-event` in `create`. */
  onCommand: (command: BrowserCommandEvent) => void
  /**
   * A session's identity at the tool endpoint, by the id the window names it
   * by - or null for one that cannot take a share: ended, started without the
   * tools, or the tools switched off. The token comes in here and goes no
   * further than the tab it is shared on.
   */
  sessionOpener: (session: number) => BrowserOpener | null
  /** Every session `sessionOpener` answers for. */
  shareTargets: () => BrowserShare[]
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

/** For the tests: proof the exemption is a finite set and not a mood. */
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
 * **Deny is still the answer for everything that is not a browser view**, and
 * that half has not moved: the window, the spike page, an artifact frame and
 * every future web-contents Electron makes are refused here without consulting
 * anything.
 *
 * What a browser view gets is one of two answers, chosen by what the page
 * actually asked for:
 *
 *   - a **page in the Browser tab**, for `target="_blank"`, a plain
 *     `window.open` and a middle click. The page adopts the web contents
 *     Chromium made for it, so `window.open` returns a live handle and the new
 *     page keeps `window.opener` - see `adoptPage`;
 *   - a **window**, for a `window.open` that asked for one - disposition
 *     `new-window` with features, a size or `popup` - because a sign-in dialog
 *     is a window in every browser.
 *
 * Both keep the opener, and that is the point of both. A popup OAuth flow is
 * two things: `window.open` must return a live handle, and the opened page
 * must reach the opener through `window.opener.postMessage` to hand back the
 * code. A page loaded fresh into a new tab had neither - the library reported
 * a blocked popup or never heard back, and the next attempt opened another
 * tab. Nothing else about the posture moves: the popup and the page are on
 * the same partition with the same permissions, refused downloads and
 * loopback-only certificate rule, they are exempted through the same registry
 * by id, and every navigation they make goes through `browserReachAllows`
 * exactly as the pane's do.
 */
export function browserWindowOpen(
  webContentsId: number,
  details: { url: string; disposition: string; features: string }
): WindowOpenHandlerResponse {
  if (!exempt.has(webContentsId)) return { action: 'deny' }
  return hostForContents(webContentsId)?.windowOpen(webContentsId, details) ?? { action: 'deny' }
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
  windowOpen(
    webContentsId: number,
    details: { url: string; disposition: string; features: string }
  ): WindowOpenHandlerResponse
  /** A download this partition refused, so every open pane can say so. */
  noteDownload(url: string): void
  /** Whether these are a page in the Browser tab: a view's contents, not a popup's. */
  isPage(webContentsId: number): boolean
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
   * Two permissions, for the page somebody is in, and nothing else.
   *
   * Writing to the clipboard, for the Copy buttons every docs site and
   * dashboard has, and the whole screen, for a video or a slide deck. Both go
   * only to a page in the Browser tab that has the keyboard: Chromium already
   * wants a click for either, and the focus test is what keeps them from a
   * page an agent is clicking in the background, and from popups, which are
   * sign-in windows and need neither. Measured on Electron 43.3.0: a Copy
   * button asks for `clipboard-sanitized-write`, `requestFullscreen` for
   * `fullscreen`.
   *
   * Reading the clipboard stays denied. Chrome asks before a page may read it,
   * Helm has nowhere to ask, and a clipboard holds passwords; Ctrl+V still
   * pastes, because a paste the user made needs no permission. Everything
   * else - camera, microphone, location, notifications - stays denied, and the
   * two are named rather than filtered, because a list of permissions to allow
   * is a list somebody extends.
   */
  partition.setPermissionRequestHandler((contents, permission, callback) => {
    callback(pageMay(contents, permission))
  })
  partition.setPermissionCheckHandler(
    (contents, permission) => contents !== null && BROWSER_PERMISSIONS.has(permission) && isPage(contents.id)
  )
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

/** What a page in the Browser tab may be granted. See `browserSession`. */
const BROWSER_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write', 'fullscreen'])

/** Whether these web contents are a page in some host's Browser tab. */
function isPage(webContentsId: number): boolean {
  for (const host of hosts) if (host.isPage(webContentsId)) return true
  return false
}

/** One of the two permissions, asked for by a page in the Browser tab that has the keyboard. */
function pageMay(contents: WebContents, permission: string): boolean {
  return (
    BROWSER_PERMISSIONS.has(permission) &&
    !contents.isDestroyed() &&
    isPage(contents.id) &&
    contents.isFocused()
  )
}

/**
 * The web preferences of every page Helm hosts: a view, a page a view opened,
 * and a popup window.
 *
 * Every one is stated, and the ones that are Electron's default are stated
 * *because* they are: this is the one place in Helm that renders somebody
 * else's HTML with a network behind it, and a posture made of defaults is a
 * posture that moves when Electron does. One list, so a page opened from
 * another page cannot end up with a second posture.
 */
function viewPreferences(): WebPreferences {
  return {
    // The partition is the one thing that must match exactly: a popup on a
    // different partition could not see the sign-in it was opened to complete.
    session: browserSession(),
    // No preload. Nothing of Helm's runs in a page, so there is no bridge to
    // abuse and nothing for a hostile page to find.
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    spellcheck: false
  }
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

/** A number held inside a range. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/**
 * The width and height out of a `window.open` feature string.
 *
 * Only those two, and only when they parse as positive numbers. Everything else
 * a page can ask for in that string - `location`, `menubar`, `toolbar`,
 * `alwaysRaised` - is either not Helm's to give or is a thing a page should not
 * be choosing about a window on somebody's screen, so the answer is the one in
 * `windowOpen` rather than whatever the page wrote.
 */
function parseWindowFeatures(features: string): { width?: number; height?: number } {
  const asked: { width?: number; height?: number } = {}
  for (const part of features.split(',')) {
    const [rawName, rawValue] = part.split('=')
    if (rawValue === undefined) continue
    const name = rawName?.trim().toLowerCase()
    const value = Number.parseInt(rawValue.trim(), 10)
    if (!Number.isFinite(value) || value <= 0) continue
    if (name === 'width' || name === 'innerwidth') asked.width = value
    if (name === 'height' || name === 'innerheight') asked.height = value
  }
  return asked
}

/**
 * A view's web contents, or null when there are none.
 *
 * **The one way this file is allowed to reach them**, and the reason is a fault
 * that took the whole pane down. A page may close itself - `window.close()` is
 * the last thing every OAuth popup does - and Chromium destroys those web
 * contents without asking anybody. Electron then leaves
 * `WebContentsView.webContents` **undefined**: not a destroyed object still
 * answering `isDestroyed()`, which is what forty call sites here assumed, but
 * nothing at all. So `entry.view.webContents.isDestroyed()` threw a
 * `TypeError`, and it threw from wherever the next call happened to come in:
 *
 *   - through an invoke - `browser:state`, `navigate`, `open` - it rejected,
 *     and every call site in `useBrowsers.ts` ends in `.catch(() => undefined)`,
 *     so the pane went blank and said nothing;
 *   - through the `browser:bounds` **send**, which has no reply to reject, it
 *     was an uncaught exception in the main process - and Electron answers one
 *     of those with its own error dialog. The pane re-reports its rectangle on
 *     every `ResizeObserver` tick, so the dialog came back as fast as it was
 *     dismissed.
 *
 * A `destroyed` listener now retires the view (see `create`), so an entry in
 * this shape is a race rather than a resting state - but the accessor is what
 * makes the race harmless instead of fatal, and it is cheaper than proving no
 * path can observe the gap.
 */
function contentsOf(entry: View): WebContents | null {
  const wc = entry.view.webContents as WebContents | undefined
  return wc === undefined || wc.isDestroyed() ? null : wc
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

  /**
   * A view **and** the web contents behind it, or null if either is missing.
   *
   * Every operation that actually touches a page goes through this rather than
   * through `viewFor`, so "there is no tab with that id" and "that tab's page
   * closed itself" reach the same answer at the same place - see `contentsOf`
   * for what the second one used to do instead.
   */
  const liveFor = (id: number): { entry: View; wc: WebContents } | null => {
    const entry = viewFor(id)
    if (entry === null) return null
    const wc = contentsOf(entry)
    return wc === null ? null : { entry, wc }
  }

  const state = (entry: View): BrowserState => {
    const wc = contentsOf(entry)
    const alive = wc !== null
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
      project: entry.project,
      // The name, never the key. This crosses to the renderer and is painted
      // in the tab strip; the token it is derived from stays in this process.
      openedBy: entry.openedBy?.name ?? null,
      openerRunning: entry.openedBy !== null && !entry.openerEnded,
      sharedWith:
        entry.sharedWith === null
          ? null
          : { session: entry.sharedWith.session, name: entry.sharedWith.opener.name }
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
      contentsOf(entry)
        ?.loadURL(url)
        .catch(() => undefined)
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
    const wc = contentsOf(entry)
    if (wc === null) {
      // A tab whose page closed itself, asked to go somewhere. Nothing can be
      // loaded into web contents that are gone, and the tab is on its way out
      // anyway - what it may not do is fail silently, which is what the
      // swallowed `TypeError` here used to do.
      stopRetry(entry)
      entry.problem = 'That page closed itself, so this tab has nothing left to load into.'
      log(entry, { level: 'error', message: entry.problem, source: url, line: 0 })
      return announce(entry)
    }
    stopRetry(entry)
    entry.problem = null
    void wc.loadURL(url).catch(() => undefined)
    return announce(entry)
  }

  const attach = (entry: View): void => {
    const win = options.window()
    if (win === null || win.isDestroyed() || entry.attached) return
    win.contentView.addChildView(entry.view)
    entry.attached = true
  }

  /**
   * A page that asked for the whole screen, given it.
   *
   * Electron makes the **window** fullscreen and leaves the view where it was:
   * measured on 43.3.0, the view kept its 800x500 inside a 2560x1440 window.
   * So the view is sized to the window here, raised above every other view,
   * and kept the window's size while it stays; the pane's own reports are set
   * aside until the page lets go (`bounds`). The top 36px are the page's too:
   * a fullscreen window has no title bar for the window controls to sit in.
   * Escape is Chromium's and needs nothing here.
   */
  const enterFullscreen = (entry: View): void => {
    const win = options.window()
    if (win === null || win.isDestroyed() || entry.fullscreen !== null) return
    const fill = (): void => {
      if (win.isDestroyed()) return
      const { width, height } = win.getContentBounds()
      // Adding a view its parent already holds raises it to the top.
      if (entry.attached) win.contentView.addChildView(entry.view)
      entry.view.setBounds({ x: 0, y: 0, width, height })
      entry.view.setVisible(true)
    }
    entry.fullscreen = fill
    win.on('resize', fill)
    fill()
  }

  /** The page let go of the screen, or is going: the view goes back where the pane had it. */
  const leaveFullscreen = (entry: View): void => {
    const fill = entry.fullscreen
    if (fill === null) return
    entry.fullscreen = null
    const win = options.window()
    if (win === null || win.isDestroyed()) return
    win.off('resize', fill)
    const placed = entry.placed
    if (placed === null) {
      entry.view.setVisible(false)
      return
    }
    entry.view.setBounds({ x: placed.x, y: placed.y, width: placed.width, height: placed.height })
    entry.view.setVisible(placed.visible)
  }

  /** An agent's key events, delivered so that none of them is read as a Browser tab key. */
  const asAgent = (entry: View, send: () => void): void => {
    entry.agentInput += 1
    try {
      send()
    } finally {
      entry.agentInput -= 1
    }
  }

  /**
   * The popup windows browser views have open, keyed by their `webContents.id`.
   *
   * A popup is not a tab and deliberately has no entry in `views`: it has no
   * pane, no address bar, no console and no place in the strip. What it does
   * have is the thing that made it necessary - a live `window.opener` back to
   * the page that opened it - and everything Helm asks of a browser view:
   * an entry in the `exempt` registry so the app-global guard knows it, and a
   * `will-navigate` that goes through `browserReachAllows` with its owner's
   * restrictions.
   *
   * Keyed by web-contents id because that is what both guards are asked about.
   */
  const popups = new Map<number, { window: BrowserWindow; ownerViewId: number }>()

  /** Popups a given view is holding. The cap counts these. */
  const popupsOf = (viewId: number): number =>
    [...popups.values()].filter((popup) => popup.ownerViewId === viewId).length

  /**
   * The view a web-contents id belongs to: the view itself, or - for a popup
   * that opens another popup, which chained sign-ins do - the view that owns
   * the popup. One answer, so a popup is held to its owner's reach however
   * deep the chain goes.
   */
  const openerFor = (webContentsId: number): View | null => {
    for (const entry of views.values()) {
      if (entry.webContentsId === webContentsId && contentsOf(entry) !== null) return entry
    }
    const popup = popups.get(webContentsId)
    if (popup === undefined) return null
    return views.get(popup.ownerViewId) ?? null
  }

  const destroy = (entry: View, tellTheWindow: boolean): void => {
    // Idempotent, because it now has three callers that can race: the pane's
    // close button, a render process that died, and a page that closed itself.
    // Telling the window twice would be a second `browser:closed` for a tab
    // that is already gone.
    if (!views.has(entry.id)) return
    stopRetry(entry)
    if (entry.fullscreen !== null) {
      leaveFullscreen(entry)
      // A page closed while it had the screen - Ctrl+W, or the page closing
      // itself - would leave the window fullscreen with nothing in it.
      const win = options.window()
      if (win !== null && !win.isDestroyed() && win.isFullScreen()) win.setFullScreen(false)
    }
    views.delete(entry.id)
    exempt.delete(entry.webContentsId)
    const win = options.window()
    if (entry.attached && win !== null && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(entry.view)
      } catch {
        // The window is on its way out; there is nothing to detach from.
      }
    }
    entry.attached = false
    const wc = contentsOf(entry)
    if (wc !== null) {
      if (wc.isDevToolsOpened()) wc.closeDevTools()
      wc.close()
    }
    if (tellTheWindow) options.onClosed(entry.id)
  }

  /**
   * A view, on new web contents or - `adopt` - on the ones Chromium made for a
   * page's `window.open`. Adopted contents were made with `viewPreferences()`
   * too: `windowOpen` hands them over as the override.
   */
  const create = (
    project: string | null,
    openedBy: BrowserOpener | null = null,
    adopt?: WebContents
  ): View => {
    const view = new WebContentsView(
      adopt === undefined ? { webPreferences: viewPreferences() } : { webContents: adopt }
    )
    // Registered here, in the constructor path, so that by the time the guard in
    // `index.ts` runs its listener - which is when a navigation is attempted,
    // not when it was attached - this id is known.
    exempt.add(view.webContents.id)

    const entry: View = {
      id: nextId++,
      view,
      webContentsId: view.webContents.id,
      project,
      console: [],
      problem: null,
      retry: null,
      find: null,
      findRequest: null,
      openedBy,
      attached: false,
      parked: openedBy !== null,
      openerEnded: false,
      sharedWith: null,
      agentInput: 0,
      fullscreen: null,
      placed: null
    }
    views.set(entry.id, entry)

    const wc = view.webContents

    /*
     * The ground the page paints on.
     *
     * Foreign ground (DESIGN.md 6): the view's own ground is the page's, and
     * Helm has no business tinting it. Clear while the view is an empty new
     * page, so it does not flash white on a dark canvas before anything has
     * loaded - and white from the first navigation on, which is the ground
     * every browser gives a page that sets none. Left clear, a page with no
     * background of its own - plain HTML, a dev server's raw JSON - was Helm's
     * canvas with black text on it, and a page in fullscreen had Helm's whole
     * window showing through it.
     */
    view.setBackgroundColor('#00000000')
    let grounded = false
    // A new view paints nothing until the window has said where it goes. The
    // alternative is a view at whatever bounds Electron defaults to, over
    // the app, for the frame between construction and the first report. An
    // agent's view is primed and then hidden instead - see `primeAgentView`.
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
      if (!grounded) {
        grounded = true
        view.setBackgroundColor('#ffffff')
      }
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
      // A search typed over by the next keystroke can still answer after it.
      if (entry.find === null || result.requestId !== entry.findRequest) return
      entry.find = {
        query: entry.find?.query ?? '',
        matches: result.matches,
        active: result.activeMatchOrdinal
      }
      announce(entry)
    })

    wc.on('devtools-opened', () => announce(entry))
    wc.on('devtools-closed', () => announce(entry))

    /*
     * The Browser tab's keys, pressed with the caret in the page.
     *
     * Keys typed into a page go to that page's process, so the window never
     * sees them, and Ctrl+W in a page that did nothing was the clearest way the
     * pane felt like something other than a browser. Main reads them here,
     * before the page does, from the table both sides share
     * (`shared/browserKeys.ts`), swallows the ones that are the browser's, and
     * hands the command to the window, which owns the strip, the find field and
     * the address bar - giving the window the keyboard first when the answer is
     * drawn there. An agent's keys (`agentInput`) and every other key are the
     * page's; a held key repeats only where repeating means something.
     */
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || entry.agentInput > 0) return
      const command = browserKeyCommand(input)
      if (command === null) return
      event.preventDefault()
      if (input.isAutoRepeat && !COMMANDS_THAT_REPEAT.has(command)) return
      if (COMMANDS_FOR_THE_WINDOW.has(command)) {
        const win = options.window()
        if (win !== null && !win.isDestroyed()) win.webContents.focus()
      }
      options.onCommand({ id: entry.id, command })
    })

    wc.on('enter-html-full-screen', () => enterFullscreen(entry))
    wc.on('leave-html-full-screen', () => leaveFullscreen(entry))

    // A page whose render process died leaves a view that paints nothing and
    // answers nothing. The tab goes with it rather than sitting there.
    wc.on('render-process-gone', () => {
      destroy(entry, true)
    })

    /*
     * And a page that closed **itself**.
     *
     * `window.close()` is not an edge case: it is the last thing every OAuth
     * popup does, and a page Helm turned into a tab can do it as freely as one
     * in a window. Chromium destroys the web contents and Electron leaves
     * `view.webContents` undefined - so without this listener the entry stayed
     * in `views` with nothing behind it, and the next thing to touch it threw.
     * Through `browser:bounds`, which is a send and therefore has nothing to
     * reject, that throw was an uncaught main-process exception and Electron's
     * own error dialog; through every invoke it was a rejection the renderer
     * swallowed, leaving a blank pane that refused every address without ever
     * saying why.
     *
     * `destroyed` rather than `closed`: `closed` is the page's *request*, and
     * this has to be the fact. The tab goes, exactly as it does for a render
     * process that died, and for the same reason - there is no page left.
     */
    wc.once('destroyed', () => {
      destroy(entry, true)
    })

    /*
     * A popup this page opened, once Electron has actually made it.
     *
     * The window-open handler decided *whether* - it is the only thing that can,
     * since it is the one Electron asks - but it never sees the window, so
     * everything that has to be true of a popup is arranged here: the id goes
     * into the `exempt` registry so the app-global `will-navigate` guard can
     * find it, the popup goes into `popups` so that guard is answered with the
     * **owner's** reach, and both are given up the moment the window closes.
     *
     * Registering here rather than in the handler is safe for the one
     * navigation that happens in between: a `window.open`'s initial URL is
     * browser-initiated, so Chromium does not emit `will-navigate` for it, and
     * it has already been through `browserReachAllows` in the handler. Every
     * redirect after it - which is all of an OAuth flow - arrives here first.
     */
    wc.on('did-create-window', (child, details) => {
      registerPopup(entry, child, details.url)
    })

    attach(entry)
    return entry
  }

  /**
   * Everything a popup window is held to, applied to the window Electron made.
   *
   * The partition carries most of it already - permissions denied, downloads
   * refused and handed to the system browser, self-signed certificates accepted
   * for loopback and nowhere else - because those are session handlers and a
   * popup is on the same session. What is left is per-window.
   */
  const registerPopup = (owner: View, child: BrowserWindow, url: string): void => {
    const cwc = child.webContents
    exempt.add(cwc.id)
    popups.set(cwc.id, { window: child, ownerViewId: owner.id })

    child.setMenu(null)

    /*
     * The address, in the title bar, always.
     *
     * A popup has no address bar - that is what makes it a popup - and a window
     * asking for a password with nothing on it saying where it came from is the
     * shape of every credential phish there has ever been. Helm cannot give it
     * an address bar without making it a tab, so it puts the host where the
     * window does have room. `preventDefault` because the page sets this title
     * on every navigation and would otherwise take the host straight back off.
     */
    const retitle = (): void => {
      if (child.isDestroyed() || cwc.isDestroyed()) return
      const host = hostOf(cwc.getURL())
      const title = cwc.getTitle()
      child.setTitle(host === '' ? title : title === '' ? host : `${host} - ${title}`)
    }
    cwc.on('page-title-updated', (event) => {
      event.preventDefault()
      retitle()
    })
    cwc.on('did-navigate', retitle)
    retitle()

    /*
     * What the pane says about it.
     *
     * A popup is a window the user did not open by hand, so the tab it came
     * from names it - and names it again when it goes, because "the sign-in
     * window closed" is the event the page is waiting for and the one worth
     * seeing in the console when it does not work.
     */
    // The URL from the open itself, not from the web contents: at
    // `did-create-window` the child has not navigated yet and `getURL()` is
    // empty, which made this line read "opened a popup window for ".
    log(owner, {
      level: 'info',
      message: `opened a popup window for ${url}`,
      source: url,
      line: 0
    })
    child.on('closed', () => {
      exempt.delete(cwc.id)
      popups.delete(cwc.id)
      log(owner, { level: 'info', message: 'the popup window closed', source: 'helm', line: 0 })
    })
  }

  /**
   * Give an agent's view a viewport, then take it off the screen.
   *
   * See `AGENT_PRIME_MS`. The size is the window's, floored at
   * `AGENT_VIEW_SIZE`, so a page an agent opens lays out at something a page is
   * normally laid out at rather than at whatever the user happens to have
   * dragged the window to - and `y` clears the title bar for the same reason
   * `bounds()` clamps it, since this rectangle really is on screen for a
   * moment.
   *
   * Awaited by the caller **before** anything is loaded, which is what keeps
   * that moment empty.
   */
  /** The window's content size, floored at the size a page expects. */
  const agentSize = (): { width: number; height: number } => {
    const win = options.window()
    const content = win !== null && !win.isDestroyed() ? win.getContentBounds() : null
    return {
      width: Math.max(AGENT_VIEW_SIZE.width, content?.width ?? 0),
      height: Math.max(AGENT_VIEW_SIZE.height, content?.height ?? 0)
    }
  }

  /**
   * Step one: full size, on screen, and all but `AGENT_PEEK` of it clipped away
   * by the window's own edge.
   */
  const showAgentView = (entry: View): void => {
    const win = options.window()
    const content = win !== null && !win.isDestroyed() ? win.getContentBounds() : null
    const size = agentSize()
    entry.view.setBounds({
      x: Math.max(0, (content?.width ?? size.width) - AGENT_PEEK),
      y: Math.max(TITLEBAR_HEIGHT, (content?.height ?? size.height) - AGENT_PEEK),
      ...size
    })
    entry.view.setVisible(true)
  }

  /** Step two: once the document has painted, off the screen and up to size. */
  const primeAgentView = async (entry: View): Promise<void> => {
    const deadline = Date.now() + AGENT_PRIME_MAX_MS
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 120))
      const wc = contentsOf(entry)
      if (wc === null) return
      if (!wc.isLoading()) break
      if (Date.now() > deadline) break
    }
    // A couple of frames past the load, so the paint the whole prime is for has
    // actually happened rather than been scheduled.
    await new Promise((resolve) => setTimeout(resolve, 120))
    if (contentsOf(entry) === null) return
    // `parked` is cleared by `bounds()`, so a user who brought this tab to the
    // front during the prime keeps it: the window's rectangle wins over this.
    if (!entry.parked) return
    entry.view.setVisible(false)
    // Position only. The **size** has been right since before the load, which
    // is the reason nothing has to be propagated to a hidden renderer: measured
    // on Electron 43.3.0, `setBounds` on a view that is not visible does not
    // reach it, so a view loaded small and enlarged afterwards keeps the small
    // viewport for ever.
    entry.view.setBounds({ x: 0, y: TITLEBAR_HEIGHT, ...agentSize() })
  }

  /**
   * A page's `target="_blank"`, plain `window.open` or middle click, as a page
   * in the Browser tab.
   *
   * Electron hands over the web contents Chromium already made for the new
   * page (`createWindow`), and the view **adopts** them rather than loading
   * the address into new ones. That is what keeps a sign-in working: the new
   * page has `window.opener`, and the `window.open` that made it got a live
   * handle back. Loading the address fresh - what this did before - gave the
   * page neither, so a library reported a blocked popup or never heard back,
   * and its next attempt opened another tab. Measured on Electron 43.3.0.
   *
   * A middle click arrives with no web contents: Chromium opens those from
   * the link itself, with no opener to keep, so that one is loaded here.
   *
   * The page belongs to whoever the opening one belonged to. A page an agent
   * opened that opens another has produced another of the agent's pages, in
   * the background, and the agent is the one that can tidy it up.
   */
  const adoptPage = (
    opener: View,
    url: string,
    background: boolean,
    guest: WebContents | undefined
  ): WebContents => {
    const entry = create(opener.project, opener.openedBy, guest)
    const agent = opener.openedBy !== null
    if (agent) showAgentView(entry)
    // Placed before anything is loaded: the load announces the page, and a
    // window that heard of it that way first would draw it at the end of the
    // strip for a frame.
    options.onOpened({ state: state(entry), after: opener.id, background: background || agent })
    if (guest === undefined) load(entry, url)
    if (agent) void primeAgentView(entry)
    // Electron checks that what comes back is the contents it handed over.
    return entry.view.webContents
  }

  /** The cap, said on the page that tried to open one more. */
  const refuseOverCap = (entry: View, url: string): WindowOpenHandlerResponse => {
    entry.problem = `A page tried to open another tab and Helm is already holding ${String(
      BROWSER_TABS_MAX
    )} browser tabs. Close one, or open the address in your own browser.`
    log(entry, {
      level: 'warning',
      message: `window.open(${url}) refused: ${String(BROWSER_TABS_MAX)} tabs is the cap`,
      source: url,
      line: 0
    })
    announce(entry)
    return { action: 'deny' }
  }

  const host: BrowserHost & InternalHost = {
    // A popup counts, and has to: the guard in `index.ts` asks `owns` first,
    // and a popup this host did not claim would be answered by nothing and
    // prevented - which is every redirect of the sign-in it was opened for.
    owns(webContentsId) {
      return openerFor(webContentsId) !== null
    },

    isPage(webContentsId) {
      for (const entry of views.values()) {
        if (entry.webContentsId === webContentsId) return contentsOf(entry) !== null
      }
      return false
    },

    allowNavigation(webContentsId, url) {
      const entry = openerFor(webContentsId)
      if (entry === null) return false
      /*
       * The intersection, in the second of its two places.
       *
       * `will-navigate` is what a *page* does - a link, a redirect, a
       * `location.href` an agent set through `browser_evaluate`. For a tab a
       * session opened, the agent's restriction applies to that too, or
       * `browserMcpLocalOnly` would be a rule about the tool names rather
       * than about where the agent's tabs may go. Both calls compose through
       * `agentReach`, so the two cannot drift.
       *
       * The pane's own navigation does not come through here at all -
       * Electron does not emit `will-navigate` for `loadURL` - which is why
       * "the pane may still go there by hand" stays true on the same tab.
       *
       * A popup arrives here as its **owner**, which is what `openerFor`
       * answers, so a sign-in window is held to the reach of the tab that
       * opened it and a refusal is said on that tab - the only surface a popup
       * has to say anything on.
       */
      const restrictions =
        entry.openedBy === null ? [reach()] : agentReach(reach(), settings().browserMcpLocalOnly)
      const decision = browserReachAllows(url, ...restrictions)
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
    },

    windowOpen(webContentsId, details) {
      const entry = openerFor(webContentsId)
      if (entry === null) return { action: 'deny' }
      const { url, disposition } = details

      /*
       * The reach rule, before anything is created.
       *
       * Same call, same composition as `load` and `allowNavigation`: a popup
       * can never take a page somewhere the tab that opened it could not go,
       * and an agent's tab composes `agentReach` here too.
       */
      const restrictions =
        entry.openedBy === null ? [reach()] : agentReach(reach(), settings().browserMcpLocalOnly)
      const decision = browserReachAllows(url, ...restrictions)
      if (!decision.allowed) {
        entry.problem = decision.problem
        log(entry, {
          level: 'error',
          message: `window.open(${url}) refused: ${decision.problem ?? 'out of reach'}`,
          source: url,
          line: 0
        })
        announce(entry)
        return { action: 'deny' }
      }

      /*
       * A window, but only for what a window means.
       *
       * `new-window` with features is a `window.open` that asked for a size or
       * for `popup`, which is a popup and nothing else - a sign-in dialog, a
       * picker, a payment sheet. `target="_blank"`, a plain `window.open` and a
       * middle click arrive as `foreground-tab` and `background-tab`, and those
       * *are* tabs. A shift-click is `new-window` with no features: a page,
       * because nothing in it asked for a dialog's shape.
       *
       * And never for a page an agent opened. The reach rules already say an
       * agent may not go anywhere the pane could not; this says it may not put
       * a window on the user's screen either. Its `window.open` gets another
       * of its pages, with the opener kept, which is the surface `browser_tabs`
       * and `browser_close` already describe.
       */
      const wantsWindow =
        disposition === 'new-window' && details.features.trim() !== '' && entry.openedBy === null
      if (!wantsWindow) {
        if (views.size >= BROWSER_TABS_MAX) return refuseOverCap(entry, url)
        return {
          action: 'allow',
          // A page outlives the page that opened it, as a tab does in any
          // browser. A popup does not - see below.
          outlivesOpener: true,
          overrideBrowserWindowOptions: { webPreferences: viewPreferences() },
          createWindow: (made) =>
            adoptPage(
              entry,
              url,
              disposition === 'background-tab',
              // Not in Electron's type, and documented: the contents Chromium
              // made for the page, absent for a middle click.
              (made as { webContents?: WebContents }).webContents
            )
        }
      }

      if (popupsOf(entry.id) >= BROWSER_POPUPS_MAX) {
        entry.problem = `This page has ${String(
          BROWSER_POPUPS_MAX
        )} popup windows open already, which is the most Helm allows one tab. Close one, or open the address in your own browser.`
        log(entry, {
          level: 'warning',
          message: `window.open(${url}) refused: ${String(BROWSER_POPUPS_MAX)} popups is the cap`,
          source: url,
          line: 0
        })
        announce(entry)
        return { action: 'deny' }
      }

      const asked = parseWindowFeatures(details.features)
      const win = options.window()
      return {
        action: 'allow',
        // The popup goes when the page that opened it goes. A sign-in window
        // outliving the tab it belongs to is a window nothing can close and
        // nothing can explain.
        outlivesOpener: false,
        overrideBrowserWindowOptions: {
          width: clamp(asked.width ?? POPUP_DEFAULT.width, POPUP_MIN.width, POPUP_MAX.width),
          height: clamp(asked.height ?? POPUP_DEFAULT.height, POPUP_MIN.height, POPUP_MAX.height),
          ...(win !== null && !win.isDestroyed() ? { parent: win } : {}),
          autoHideMenuBar: true,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          // The list every page gets: a popup that inherited its posture from
          // a default would be a second posture, moving when Electron moves.
          webPreferences: viewPreferences()
        }
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
      // The address bar is the one caller that searches: a phrase becomes the
      // engine's results address here, and `load` holds that to the reach rule
      // like any other.
      const resolved = resolveBrowserAddress(input, settings().browserSearch)
      if (resolved.url === null) {
        stopRetry(entry)
        entry.problem = resolved.problem
        // Nothing was fetched: with searching off, a phrase produces a sentence
        // and no request at all.
        return announce(entry)
      }
      return load(entry, resolved.url)
    },

    back(id) {
      const entry = viewFor(id)
      if (entry === null) return null
      const wc = contentsOf(entry)
      if (wc !== null && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
      return announce(entry)
    },

    forward(id) {
      const entry = viewFor(id)
      if (entry === null) return null
      const wc = contentsOf(entry)
      if (wc !== null && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
      return announce(entry)
    },

    reload(id, hard) {
      const entry = viewFor(id)
      if (entry === null) return null
      stopRetry(entry)
      entry.problem = null
      const wc = contentsOf(entry)
      if (wc === null) return announce(entry)
      if (hard) wc.reloadIgnoringCache()
      else wc.reload()
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
      const live = liveFor(id)
      if (live === null) return { ok: false, value: '', error: 'That browser tab is gone.' }
      try {
        // `true` for a user gesture, because an expression typed into a console
        // is one - without it a page's own `requestFullscreen`-shaped APIs
        // reject and the panel would report a browser policy as a page error.
        const answer: unknown = await live.wc.executeJavaScript(source, true)
        return { ok: true, value: describeValue(answer), error: null }
      } catch (err) {
        return { ok: false, value: '', error: err instanceof Error ? err.message : String(err) }
      }
    },

    devtools(id) {
      const live = liveFor(id)
      if (live === null) return null
      const { entry, wc } = live
      if (wc.isDevToolsOpened()) wc.closeDevTools()
      // Detached, deliberately: a docked DevTools is a second rectangle inside
      // the window whose size Helm would then have to keep out of the
      // placeholder's bounds, which is the bounds-sync problem twice.
      else wc.openDevTools({ mode: 'detach' })
      return announce(entry)
    },

    find(id, query, forward) {
      const live = liveFor(id)
      if (live === null) return
      const { entry, wc } = live
      if (query === '') {
        wc.stopFindInPage('clearSelection')
        entry.find = null
        announce(entry)
        return
      }
      /*
       * `findNext: true` **starts** a search, despite the name, and `false`
       * steps through the one already running (Electron's own docs). So a
       * changed query is a new search and the same query again is a step.
       * This was inverted once, and every first search was sent as a step
       * through a search that never started: zero matches, always.
       *
       * And the page is **not** focused. The caret is in the pane's find field
       * and has to stay there; focusing the view sent every keystroke after
       * the first into the page instead.
       */
      const starting = entry.find?.query !== query
      if (starting) entry.find = { query, matches: 0, active: 0 }
      entry.findRequest = wc.findInPage(query, { forward, findNext: starting })
    },

    stopFind(id) {
      const live = liveFor(id)
      if (live === null) return
      live.wc.stopFindInPage('clearSelection')
      live.entry.find = null
      // The find field is closing, and the caret goes back to the page it was
      // searching, as it does in every browser. Never while searching - see
      // `find` - only once the field is gone.
      live.wc.focus()
      announce(live.entry)
    },

    zoom(id, level) {
      const live = liveFor(id)
      if (live === null) return null
      live.wc.setZoomLevel(Math.max(-3, Math.min(3, level)))
      return announce(live.entry)
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

    /*
     * The page as it is now, for the window to paint where the view was while
     * something is drawn over it. A native view cannot sit under a menu, so it
     * stands down for one (`useBrowsers`); without this the page vanished every
     * time the overflow menu opened. PNG rather than JPEG, so text in the still
     * is the page's text and not an approximation of it.
     */
    async snapshot(id) {
      const live = liveFor(id)
      if (live === null) return null
      try {
        const image = await live.wc.capturePage()
        return image.isEmpty() ? null : image.toDataURL()
      } catch {
        return null
      }
    },

    entries(id) {
      return viewFor(id)?.console ?? []
    },

    bounds(payload) {
      const entry = viewFor(payload.id)
      const win = options.window()
      if (entry === null || win === null || win.isDestroyed()) return
      // The pane reports its rectangle on every ResizeObserver tick, and this
      // is a send: a throw here has no reply to reject into and becomes an
      // uncaught main-process exception, which is Electron's own error dialog
      // once per tick. See `contentsOf`.
      if (contentsOf(entry) === null) return

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
      const top = TITLEBAR_HEIGHT
      const y = Math.max(top, wantedY)
      const height = Math.max(0, wantedHeight - (y - wantedY))

      // The page has the whole screen. What the pane says now is about a window
      // laid out at that size; where the view goes back to is where it was.
      if (entry.fullscreen !== null) return

      // The window has a pane for this tab, so it is no longer parked and never
      // will be again: from here it hides and shows like every other view.
      entry.parked = false
      entry.placed = { x, y, width, height, visible: payload.visible }
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
    },

    shutdown() {
      // Popups first. Each is a child of the app window and would be closed
      // with it anyway, but a sign-in window still on screen while the app is
      // going down is a window nothing owns.
      for (const popup of [...popups.values()]) {
        if (!popup.window.isDestroyed()) popup.window.destroy()
      }
      popups.clear()
      for (const entry of [...views.values()]) destroy(entry, false)
    },

    // -----------------------------------------------------------------------
    // The agent surface
    // -----------------------------------------------------------------------

    async openFor(opener, url) {
      if (views.size >= BROWSER_TABS_MAX) {
        return {
          state: null,
          problem: `Helm is already holding ${String(
            BROWSER_TABS_MAX
          )} browser tabs, which is the cap. Close one of yours with browser_close, or ask the user to close one of theirs.`
        }
      }
      const entry = create(null, opener)
      showAgentView(entry)
      // At the end of the strip and behind the page in front: an agent opening
      // a page is no reason to take the user's page away from them. Placed
      // before the load announces it, as `adoptPage` does.
      options.onOpened({ state: state(entry), after: null, background: true })
      const next = load(entry, url)
      await primeAgentView(entry)
      return { state: next, problem: next.problem }
    },

    navigateFor(opener, id, url) {
      const entry = viewFor(id)
      if (entry === null) return { state: null, problem: unknownTab(id) }
      const drives = entry.openedBy?.key === opener.key || entry.sharedWith?.opener.key === opener.key
      if (!drives) return { state: null, problem: notYours(id, entry, opener) }
      const next = load(entry, url)
      return { state: next, problem: next.problem }
    },

    closeFor(opener, id) {
      const entry = viewFor(id)
      if (entry === null) return { closed: false, problem: unknownTab(id) }
      // A shared tab is still the user's: it was shared to be read and
      // driven, and closing it is theirs.
      if (entry.openedBy?.key !== opener.key) return { closed: false, problem: notYours(id, entry, opener) }
      // `true`, so the window is told: an agent-opened tab is in the strip like
      // any other, and a tab left painting nothing would be one the user has to
      // close by hand.
      destroy(entry, true)
      return { closed: true, problem: null }
    },

    openerOf(id) {
      return viewFor(id)?.openedBy ?? null
    },

    sharedWith(id) {
      return viewFor(id)?.sharedWith?.opener ?? null
    },

    share(id, session) {
      const entry = viewFor(id)
      if (entry === null) return null
      if (entry.openedBy !== null) return state(entry)
      if (session === null) {
        entry.sharedWith = null
        return announce(entry)
      }
      const opener = options.sessionOpener(session)
      if (opener === null) return state(entry)
      entry.sharedWith = { opener, session }
      return announce(entry)
    },

    shareTargets: () => options.shareTargets(),

    revoke(key) {
      for (const entry of views.values()) {
        const shared = entry.sharedWith?.opener.key === key
        const opened = entry.openedBy?.key === key && !entry.openerEnded
        if (shared) entry.sharedWith = null
        if (opened) entry.openerEnded = true
        if (shared || opened) announce(entry)
      }
    },

    viewport(id) {
      const live = liveFor(id)
      if (live === null) return null
      const bounds = live.entry.view.getBounds()
      return {
        width: bounds.width,
        height: bounds.height,
        zoom: live.wc.getZoomFactor()
      }
    },

    async capturePng(id) {
      const live = liveFor(id)
      if (live === null) return null
      /*
       * The **view's own** `capturePage`, and that distinction is the whole of
       * why this method exists rather than a `nativeImage` built in the caller.
       *
       * `window.webContents.capturePage()` - which every driver in this
       * repository uses, and the obvious thing to reach for - cannot see a
       * `WebContentsView` at all: measured during M16 with the page plainly on
       * screen, it returned zero of the page's pixels in every state. A native
       * child view is composited beside the window's web contents rather than
       * into it. So a screenshot tool built on the window would have handed
       * back a picture of a hole, forever, and looked like it worked.
       */
      const image = await live.wc.capturePage()
      const size = image.getSize()
      return { width: size.width, height: size.height, png: image.toPNG() }
    },

    async pointer(id, x, y, opts) {
      const live = liveFor(id)
      if (live === null) return
      const at = {
        x: Math.round(x),
        y: Math.round(y),
        button: opts?.button ?? ('left' as const),
        clickCount: opts?.clickCount ?? 1
      }
      const wc = live.wc
      // The move first. A page that only reacts on hover - a menu, a control
      // that arms itself - has had no pointer over it at all otherwise, and a
      // press arriving out of nowhere is not the sequence a person produces.
      wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y })
      wc.sendInputEvent({ type: 'mouseDown', ...at })
      wc.sendInputEvent({ type: 'mouseUp', ...at })
      await settle()
    },

    async hover(id, x, y) {
      const live = liveFor(id)
      if (live === null) return
      live.wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) })
      await settle()
    },

    async scroll(id, x, y, dx, dy) {
      const live = liveFor(id)
      if (live === null) return
      const at = { x: Math.round(x), y: Math.round(y) }
      const wc = live.wc
      // The pointer goes there first: a wheel scrolls what is under it.
      wc.sendInputEvent({ type: 'mouseMove', ...at })
      wc.sendInputEvent({
        type: 'mouseWheel',
        ...at,
        // A wheel's delta is the wheel's direction, the opposite of the
        // page's: a positive delta scrolls up and left. Precise, as a
        // touchpad reports, so the page moves by exactly this much at once
        // rather than easing through an animation the next read would race.
        deltaX: -Math.round(dx),
        deltaY: -Math.round(dy),
        hasPreciseScrollingDeltas: true,
        canScroll: true
      })
      await settle()
    },

    async typeInto(id, text) {
      const live = liveFor(id)
      if (live === null) return
      const wc = live.wc
      for (const ch of text) {
        // The same three events `bridge.ts` sends, and for the same measured
        // reason: Chromium inserts text only when a `char` follows a `keyDown`,
        // and without the shift modifier a capital arrives lower-cased.
        const shifted = ch !== ch.toLowerCase() && ch === ch.toUpperCase()
        const modifiers = shifted ? (['shift'] as const) : ([] as const)
        asAgent(live.entry, () => {
          wc.sendInputEvent({ type: 'keyDown', keyCode: ch, modifiers: [...modifiers] })
          wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers: [...modifiers] })
          wc.sendInputEvent({ type: 'keyUp', keyCode: ch, modifiers: [...modifiers] })
        })
        await new Promise((resolve) => setTimeout(resolve, 8))
      }
      await settle()
    },

    async press(id, key, modifiers = []) {
      const live = liveFor(id)
      if (live === null) return
      const wc = live.wc
      const mods = [...modifiers]
      // The page's key, even when it is one of the Browser tab's: an agent
      // pressing Ctrl+W is driving the page, not closing the user's tab.
      asAgent(live.entry, () => {
        wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods })
        // Only for an unmodified printable key, or Ctrl+A would insert an "a".
        if (/^[\x20-\x7e]$/.test(key) && !mods.some((m) => m === 'control' || m === 'alt')) {
          wc.sendInputEvent({ type: 'char', keyCode: key, modifiers: mods })
        }
        wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods })
      })
      await settle()
    }
  }

  hosts.add(host)
  app.once('will-quit', () => hosts.delete(host))
  return host
}

/**
 * Long enough for the page to have run its handler.
 *
 * A tool that returned the instant the event was posted would let the next call
 * read the page before it had reacted, and the model would see a click that did
 * nothing. 120ms is what M16's click probe used and measured working.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 120))

/** The two refusals a tool makes about a tab, as whole sentences. */
const unknownTab = (id: number): string =>
  `There is no browser tab ${String(id)} in Helm. Call browser_tabs to see what is open.`

const notYours = (id: number, entry: View, asking: BrowserOpener): string =>
  entry.openedBy !== null
    ? `Browser tab ${String(id)} belongs to the session "${entry.openedBy.name}". A session may only drive the tabs it opened itself and the ones the user shares with it.`
    : entry.sharedWith?.opener.key === asking.key
      ? `Browser tab ${String(id)} is the user's. They shared it with this session to read and drive, and closing it is theirs.`
      : `Browser tab ${String(id)} was opened by the user and is not shared with this session. Open your own with browser_open, or ask the user to share it from the Share button in Helm's browser bar.`

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
