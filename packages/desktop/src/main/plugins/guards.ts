import { session, type WebContents, type WebFrameMain } from 'electron'
import { PLUGIN_SCHEME } from '../../shared/ipc'

/**
 * What a plugin frame may do to the browser around it.
 *
 * A plugin page is sandboxed by its iframe (no top navigation, no popups, no
 * downloads, no modal dialogs) and closed off from the network by its CSP. Two
 * things neither of those reaches are settled here, in main, where a page
 * cannot argue with them.
 */

const PREFIX = `${PLUGIN_SCHEME}:`

/** `helm-plugin://<id>`, or null for anything not on the scheme. */
export function pluginOriginOf(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !url.startsWith(PREFIX)) return null
  try {
    // Node gives a scheme it does not know an opaque origin, so the origin is
    // spelled out from the host rather than read from `URL.origin`.
    const host = new URL(url).host
    return host === '' ? null : `${PLUGIN_SCHEME}://${host}`
  } catch {
    return null
  }
}

export interface FrameNavigation {
  /** Where the frame is going. */
  target: string
  /** The origin the frame is on now; null when it could not be read. */
  frameOrigin: string | null
  /** The origin of the frame that started the navigation; null when there was none, or it is gone. */
  initiatorOrigin: string | null
  /** The navigation was started by the top of a Helm page that frames plugins - the relay making or reloading a frame. */
  initiatorIsHelm: boolean
  /** The web contents is a Helm page that frames plugins: the window, or the background host. */
  framesPlugins: boolean
}

/**
 * Whether a subframe navigation may go ahead.
 *
 * A frame on a plugin's origin stays on that origin: it can move between its
 * own pages, and nowhere else - not to a website, which would put a page
 * outside the plugin's CSP inside Helm's window, and not to another plugin,
 * whose origin and storage it would then be. Only Helm's own page puts a
 * frame on a plugin's origin in the first place, and only in a page that
 * frames plugins. Everything else is not this guard's business.
 */
export function pluginNavigationAllowed(navigation: FrameNavigation): boolean {
  const target = pluginOriginOf(navigation.target)
  const current = pluginOriginOf(navigation.frameOrigin === null ? null : `${navigation.frameOrigin}/`)
  if (target === null && current === null) return true
  if (target === null) return false
  if (!navigation.framesPlugins) return false
  if (navigation.initiatorIsHelm) return true
  return navigation.initiatorOrigin === target && current === target
}

function originOf(frame: WebFrameMain | null | undefined): string | null {
  if (frame === null || frame === undefined) return null
  try {
    return frame.origin
  } catch {
    // Read after the frame went away.
    return null
  }
}

function isTopOf(contents: WebContents, frame: WebFrameMain | null): boolean {
  if (frame === null) return false
  try {
    return frame === contents.mainFrame
  } catch {
    return false
  }
}

/** The `will-frame-navigate` half: armed on every web contents, in `index.ts`. */
export function guardPluginFrames(contents: WebContents, framesPlugins: (contentsId: number) => boolean): void {
  contents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return
    const initiator = details.initiator ?? null
    const allowed = pluginNavigationAllowed({
      target: details.url,
      frameOrigin: originOf(details.frame),
      initiatorOrigin: originOf(initiator),
      initiatorIsHelm: isTopOf(contents, initiator),
      framesPlugins: framesPlugins(contents.id)
    })
    if (!allowed) details.preventDefault()
  })
}

/** The one permission a plugin page has: writing text to the clipboard, for its Copy buttons. */
const PLUGIN_PERMISSIONS = new Set(['clipboard-sanitized-write'])

/**
 * Permissions, for the session Helm's own pages and the plugin frames share.
 *
 * Electron grants every request when a session has no handler, which is what
 * Helm's own renderer has always had and keeps: these handlers answer as
 * before for everything that is not a plugin. A plugin frame gets the
 * clipboard write and nothing else - no camera, no notifications, no
 * geolocation, no opening of external URLs.
 */
export function installPluginPermissions(): void {
  const forPlugin = (url: string | undefined, permission: string): boolean | null =>
    pluginOriginOf(url) === null ? null : PLUGIN_PERMISSIONS.has(permission)
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(forPlugin(details.requestingUrl, permission) ?? true)
  })
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    const url = details.requestingUrl ?? (requestingOrigin === '' ? undefined : `${requestingOrigin}/`)
    return forPlugin(url, permission) ?? true
  })
}
