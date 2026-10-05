import { PLUGIN_SCHEME } from '../../../shared/ipc'

/**
 * One iframe per plugin surface, owned outside React.
 *
 * Moving an iframe reloads it. `appendChild` of a connected node removes it
 * first, and a frame that leaves the document loses its page. Helm moves panes
 * all the time - a tab switch unmounts the page in front, a tab dragged to
 * another pane renders under another parent, putting the sidebar away
 * unmounts it - and each of those would restart the plugin with its state
 * gone.
 *
 * So the frame lives here and a component only says where it should be, the
 * shape `terminals.ts` has for the same reason. A frame is moved with
 * `moveBefore`, Chromium's state-preserving move, and a frame with no slot on
 * screen is parked in a hidden holder rather than removed. It ends when its
 * surface is closed, never because a render happened to unmount it.
 */

interface Frame {
  plugin: string
  element: HTMLIFrameElement
  loads: number
}

/** `Element.moveBefore` - in Chromium since 133, not yet in TypeScript's DOM types. */
interface MovableParent {
  moveBefore(node: Node, child: Node | null): void
}

const frames = new Map<string, Frame>()
let holder: HTMLDivElement | null = null

/** Where a frame waits with no slot on screen: in the document, so it keeps its page, and not drawn. */
function parking(): HTMLDivElement {
  if (holder?.isConnected === true) return holder
  holder = document.createElement('div')
  holder.dataset['pluginParking'] = ''
  holder.style.display = 'none'
  document.body.appendChild(holder)
  return holder
}

/**
 * Puts a frame under `parent` without reloading it when the engine can. A
 * fresh frame, or one whose move is refused, is appended - which for a frame
 * already in the document is the reload this file exists to avoid, so it is
 * counted where the spike can see it.
 */
function place(parent: HTMLElement, frame: Frame): void {
  const { element } = frame
  if (element.parentElement === parent) return
  if (element.isConnected && 'moveBefore' in parent) {
    try {
      ;(parent as unknown as MovableParent).moveBefore(element, null)
      return
    } catch (error) {
      console.warn('[plugins] moveBefore refused, the frame will reload:', error)
    }
  }
  parent.appendChild(element)
}

/** Shows the frame for `key` in `slot`, creating it the first time. */
export function attachPluginFrame(key: string, plugin: string, url: string, title: string, slot: HTMLElement): void {
  let frame = frames.get(key)
  if (frame === undefined) {
    const element = document.createElement('iframe')
    // Its own origin already keeps it out of Helm's page; the sandbox takes
    // away what an origin alone would still allow - top navigation, popups,
    // modal dialogs. `allow-same-origin` keeps that origin (and its storage)
    // instead of an opaque one, which is safe only because it is not Helm's.
    element.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms')
    element.referrerPolicy = 'no-referrer'
    element.title = title
    element.src = url
    element.dataset['pluginFrame'] = key
    element.dataset['loads'] = '0'
    element.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent'
    frame = { plugin, element, loads: 0 }
    const counted = frame
    element.addEventListener('load', () => {
      counted.loads += 1
      element.dataset['loads'] = String(counted.loads)
    })
    frames.set(key, frame)
  }
  place(slot, frame)
}

/** The slot is going away: park the frame, unless it has already moved on to another slot. */
export function detachPluginFrame(key: string, slot: HTMLElement): void {
  const frame = frames.get(key)
  if (frame === undefined || frame.element.parentElement !== slot) return
  if (!slot.isConnected) {
    // Too late to move: the slot left the document with the frame in it.
    console.warn(`[plugins] ${key} was unmounted before it could be parked; it will reload`)
    return
  }
  place(parking(), frame)
}

/** The surface was closed: the page ends here. */
export function disposePluginFrame(key: string): void {
  frames.get(key)?.element.remove()
  frames.delete(key)
}

/**
 * The plugin a message came from, or null if it did not come from one.
 *
 * Two checks. The origin is set by the browser and names the plugin; the
 * source must also be the window of a frame Helm made for that plugin, so a
 * page that is merely *on* a plugin's origin - a frame the plugin opened
 * inside itself - is not taken for the plugin.
 */
export function pluginOf(event: MessageEvent): string | null {
  const prefix = `${PLUGIN_SCHEME}://`
  if (!event.origin.startsWith(prefix)) return null
  const id = event.origin.slice(prefix.length)
  for (const frame of frames.values()) {
    if (frame.plugin === id && frame.element.contentWindow === event.source) return id
  }
  return null
}
