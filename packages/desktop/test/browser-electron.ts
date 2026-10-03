import { EventEmitter } from 'node:events'

/**
 * The part of Electron the browser pane's main-process half touches, faked for
 * `main/browser.test.ts`:
 *
 *   vi.mock('electron', async () => ({
 *     ...(await import('../../test/electron')).electronFake(),
 *     ...(await import('../../test/browser-electron')).browserElectronFake()
 *   }))
 *
 * Helm's side is real; Chromium's side is played by the test. A fake web
 * contents records what Helm asked of it (`loads`, `reloads`, `finds`) and the
 * test raises the events Chromium would raise in reply (`commit`, `failLoad`,
 * `closeItself`). That split is what lets a test prove Helm's own behaviour -
 * the retry on a refused connection, say - with no Chromium underneath to do
 * the same thing on its own.
 *
 * Nothing here imports `electron` or `vitest`, so the mock factory can load it.
 */

let nextContentsId = 1000

/** The event object Electron passes first. Helm calls `preventDefault` on some. */
const electronEvent = (): { preventDefault: () => void } => ({ preventDefault: () => undefined })

/** The handlers `browserSession()` installs, kept so a test can call them. */
export class FakeSession extends EventEmitter {
  permissionRequest: ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void) | null =
    null
  permissionCheck: ((...args: unknown[]) => boolean) | null = null
  devicePermission: ((...args: unknown[]) => boolean) | null = null
  certificateVerify: ((request: { hostname: string }, callback: (verdict: number) => void) => void) | null = null
  cleared = 0

  setPermissionRequestHandler(handler: NonNullable<FakeSession['permissionRequest']>): void {
    this.permissionRequest = handler
  }
  setPermissionCheckHandler(handler: NonNullable<FakeSession['permissionCheck']>): void {
    this.permissionCheck = handler
  }
  setDevicePermissionHandler(handler: NonNullable<FakeSession['devicePermission']>): void {
    this.devicePermission = handler
  }
  setCertificateVerifyProc(proc: NonNullable<FakeSession['certificateVerify']>): void {
    this.certificateVerify = proc
  }
  clearStorageData(): Promise<void> {
    this.cleared += 1
    return Promise.resolve()
  }
}

export class FakeWebContents extends EventEmitter {
  readonly id = nextContentsId++
  /** Every address Helm asked this page to load, in order. */
  readonly loads: string[] = []
  readonly reloads: Array<'ordinary' | 'ignoring-cache'> = []
  readonly finds: Array<{ query: string; forward: boolean; findNext: boolean }> = []
  readonly stoppedFinding: string[] = []
  readonly evaluated: Array<{ source: string; userGesture: boolean }> = []
  /** What `executeJavaScript` resolves with, or throws. */
  answer: (source: string) => unknown = () => undefined
  zoomFactor = 1

  private url = ''
  private title = ''
  private loading = false
  private destroyed = false
  private zoomLevel = 0
  private devtools = false
  private history: string[] = []
  private index = -1

  readonly navigationHistory = {
    canGoBack: (): boolean => this.index > 0,
    canGoForward: (): boolean => this.index < this.history.length - 1,
    goBack: (): void => this.travel(-1),
    goForward: (): void => this.travel(1)
  }

  getURL(): string {
    return this.url
  }
  getTitle(): string {
    return this.title
  }
  isLoading(): boolean {
    return this.loading
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  loadURL(url: string): Promise<void> {
    this.loads.push(url)
    this.loading = true
    return Promise.resolve()
  }
  reload(): void {
    this.reloads.push('ordinary')
  }
  reloadIgnoringCache(): void {
    this.reloads.push('ignoring-cache')
  }
  getZoomLevel(): number {
    return this.zoomLevel
  }
  setZoomLevel(level: number): void {
    this.zoomLevel = level
  }
  getZoomFactor(): number {
    return this.zoomFactor
  }
  isDevToolsOpened(): boolean {
    return this.devtools
  }
  openDevTools(): void {
    this.devtools = true
  }
  closeDevTools(): void {
    this.devtools = false
  }
  focus(): void {}
  findInPage(query: string, options: { forward?: boolean; findNext?: boolean }): number {
    this.finds.push({ query, forward: options.forward ?? true, findNext: options.findNext ?? false })
    return this.finds.length
  }
  stopFindInPage(action: string): void {
    this.stoppedFinding.push(action)
  }
  executeJavaScript(source: string, userGesture = false): Promise<unknown> {
    this.evaluated.push({ source, userGesture })
    try {
      return Promise.resolve(this.answer(source))
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }
  sendInputEvent(): void {}
  /** Helm closing the page. Electron reports the contents destroyed. */
  close(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('destroyed')
  }

  // -------------------------------------------------------------------------
  // Chromium's side, raised by the test
  // -------------------------------------------------------------------------

  /** A response arrived and the page committed: `did-navigate` with its status. */
  commit(url: string, options: { status?: number; title?: string } = {}): void {
    this.history = [...this.history.slice(0, this.index + 1), url]
    this.index = this.history.length - 1
    this.arrive(url, options.status ?? 200, options.title ?? '')
  }

  /**
   * A load that failed. Chromium reports the failure and then commits an error
   * page at the same address, which is a main-frame navigation with no status
   * (`-1`) - the order Helm's `did-navigate` guard exists for. A load a newer
   * one superseded (`ERR_ABORTED`) commits nothing: `errorPage: false`.
   */
  failLoad(code: number, description: string, url: string, options: { errorPage?: boolean } = {}): void {
    this.loading = false
    this.emit('did-fail-load', electronEvent(), code, description, url, true)
    if (options.errorPage === false) return
    this.url = url
    this.emit('did-navigate', electronEvent(), url, -1)
  }

  /** A line the page wrote to its console, in Electron's event shape. */
  log(level: string, message: string, sourceId = '', lineNumber = 0): void {
    this.emit('console-message', { level, message, sourceId, lineNumber })
  }

  /** The page itself ended: what Electron does after `window.close()`. */
  destroyedByPage(): void {
    this.destroyed = true
    this.emit('destroyed')
  }

  private travel(step: number): void {
    const target = this.history[this.index + step]
    if (target === undefined) return
    this.index += step
    this.arrive(target, 200, this.title)
  }

  private arrive(url: string, status: number, title: string): void {
    this.url = url
    this.title = title
    this.loading = false
    this.emit('did-navigate', electronEvent(), url, status)
    this.emit('page-title-updated', electronEvent(), title)
    this.emit('did-stop-loading')
  }
}

type Bounds = { x: number; y: number; width: number; height: number }

export class FakeWebContentsView {
  /** Every view constructed, newest last. */
  static readonly created: FakeWebContentsView[] = []

  webContents: FakeWebContents | undefined = new FakeWebContents()
  readonly webPreferences: Record<string, unknown>
  visible = true
  private bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 }

  constructor(options: { webPreferences?: Record<string, unknown> } = {}) {
    this.webPreferences = options.webPreferences ?? {}
    FakeWebContentsView.created.push(this)
  }

  setBounds(bounds: Bounds): void {
    this.bounds = { ...bounds }
  }
  getBounds(): Bounds {
    return { ...this.bounds }
  }
  setVisible(visible: boolean): void {
    this.visible = visible
  }
  setBackgroundColor(): void {}

  /**
   * The page called `window.close()`. Electron leaves `webContents` undefined
   * and reports the old contents destroyed. `announce: false` stops between
   * the two, which is the race `contentsOf` in `browser.ts` is written for.
   */
  closeItself(options: { announce?: boolean } = {}): FakeWebContents {
    const wc = this.webContents
    if (wc === undefined) throw new Error('closeItself: this view has already closed')
    this.webContents = undefined
    if (options.announce !== false) wc.destroyedByPage()
    return wc
  }
}

/**
 * A window: the app's own, handed to the host as `options.window`, or a popup
 * Electron made for a `window.open`.
 */
export class FakeBrowserWindow extends EventEmitter {
  readonly webContents = new FakeWebContents()
  readonly children: unknown[] = []
  readonly contentView = {
    addChildView: (view: unknown): void => {
      this.children.push(view)
    },
    removeChildView: (view: unknown): void => {
      const at = this.children.indexOf(view)
      if (at >= 0) this.children.splice(at, 1)
    }
  }
  title = ''
  contentBounds: Bounds = { x: 0, y: 0, width: 1600, height: 1000 }
  private destroyed = false

  isDestroyed(): boolean {
    return this.destroyed
  }
  getContentBounds(): Bounds {
    return { ...this.contentBounds }
  }
  setMenu(): void {}
  setTitle(title: string): void {
    this.title = title
  }
  /** Closing it, by anybody: Electron emits `closed`. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('closed')
  }
}

/** Everything the fake has been asked, for a test to read. */
export const fakeBrowser = {
  partitions: new Map<string, FakeSession>(),
  views: FakeWebContentsView.created,
  /** Addresses handed to the system browser through `shell.openExternal`. */
  openedExternally: [] as string[]
}

export function browserElectronFake(): Record<string, unknown> {
  return {
    WebContentsView: FakeWebContentsView,
    session: {
      fromPartition(name: string): FakeSession {
        let found = fakeBrowser.partitions.get(name)
        if (found === undefined) {
          found = new FakeSession()
          fakeBrowser.partitions.set(name, found)
        }
        return found
      }
    },
    shell: {
      openExternal: (url: string): Promise<void> => {
        fakeBrowser.openedExternally.push(url)
        return Promise.resolve()
      },
      openPath: () => Promise.resolve(''),
      showItemInFolder: (): void => undefined
    }
  }
}
