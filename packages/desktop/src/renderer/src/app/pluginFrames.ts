import { useSyncExternalStore } from 'react'
import { createPluginRelay, type FrameState, type PluginRelay, type RelayHooks, type SurfaceSpec } from '../plugins/relay'
import { helm } from './bridge'

/**
 * The window's plugin frames: one iframe per open panel or tab, owned outside
 * React.
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
 * surface is closed, its plugin is switched off or removed, or the page moves
 * to a new revision - never because a render happened to unmount it.
 *
 * Everything said to or heard from the pages is the relay's (`relay.ts`).
 */

let relay: PluginRelay | null = null
let holder: HTMLDivElement | null = null

function frames(): PluginRelay {
  relay ??= createPluginRelay({ win: window, ipc: helm })
  return relay
}

/** `Element.moveBefore` - in Chromium since 133, not yet in TypeScript's DOM types. */
interface MovableParent {
  moveBefore(node: Node, child: Node | null): void
}

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
 * already in the document is the reload this file exists to avoid.
 */
function place(parent: HTMLElement, element: HTMLIFrameElement): void {
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

/** Shows the surface's frame in `slot`, making it the first time. */
export function attachPluginFrame(spec: SurfaceSpec, slot: HTMLElement): void {
  const relayed = frames()
  place(slot, relayed.open(spec))
  relayed.setVisible(spec.key, true)
}

/** The slot is going away: park the frame, unless it has already moved on to another slot. */
export function detachPluginFrame(key: string, slot: HTMLElement): void {
  const element = slot.querySelector<HTMLIFrameElement>(`:scope > iframe[data-plugin-frame="${CSS.escape(key)}"]`)
  if (element === null) return
  frames().setVisible(key, false)
  // Too late to move when the slot has already left the document with the
  // frame in it; the next attach makes the page again.
  if (slot.isConnected) place(parking(), element)
}

/** The surface was closed: the page ends here. */
export function disposePluginFrame(key: string): void {
  relay?.dispose(key)
}

/** Every frame of a plugin that was switched off or removed, or of surfaces it no longer declares. */
export function disposePluginFrames(predicate: (spec: SurfaceSpec) => boolean): void {
  relay?.disposeWhere(predicate)
}

export function reloadPluginFrame(key: string): void {
  relay?.reload(key)
}

export function pluginFrameSpecs(): SurfaceSpec[] {
  return relay?.specs() ?? []
}

/** An event for one surface - a panel's header action, a command - held until its page is connected. */
export function emitToPluginFrame(key: string, name: 'command' | 'action', data: unknown): void {
  frames().emit(key, name, data)
}

/**
 * The same, for a surface that may not be on screen yet: its frame is made
 * now, holding the event, and loads when its slot renders and takes it.
 */
export function queueToPluginFrame(spec: SurfaceSpec, name: 'command' | 'action', data: unknown): void {
  const relayed = frames()
  relayed.open(spec)
  relayed.emit(spec.key, name, data)
}

/** What the window does with a page's keys and titles. Set by the app once; it outlives renders. */
export function setPluginFrameHooks(hooks: RelayHooks): void {
  frames().setHooks(hooks)
}

/** A surface's frame state, for drawing its error over it. Null when there is no frame yet. */
export function usePluginFrameState(key: string): FrameState | null {
  return useSyncExternalStore(
    (listener) => frames().subscribe(listener),
    () => frames().state(key)
  )
}

/** For a test's teardown: every frame and listener gone, the next use starts fresh. */
export function resetPluginFrames(): void {
  relay?.destroy()
  relay = null
  holder?.remove()
  holder = null
}
