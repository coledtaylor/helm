import {
  findTab,
  groupById,
  openTab,
  paneId,
  sessionRef,
  type ChildPlace,
  type PaneLayout,
  type SessionRecord
} from '@helm/core/types'
import { useEffect, useState, useSyncExternalStore } from 'react'

/**
 * The peek: a look at a running child that has nowhere on screen here, with its
 * screen live and read-only. It is opened by a press on the child's row or on
 * its chip in the parent's crumb, and it is the window's state only: which
 * child, on which host, and what opened it. What it draws is the view's.
 *
 * The screen comes through the host's watch-only attach, so nothing is typed
 * into the child and the child is never resized from here: this module has no
 * way to send either. The host starts the stream with the child's screen as it
 * is, and the bytes are kept (the most recent of them, up to `REPLAY_LIMIT`)
 * for the terminal that draws them, which mounts after the peek opens.
 *
 * It closes by itself when its child is shown here (it has a tab, or its
 * parent's family view holds it as a card or a header), when it is no longer
 * running, and when its stream ends.
 */

/** What a peek was opened from, which is where its popover goes. */
export type PeekAnchor = { kind: 'row' } | { kind: 'chip'; parentId: number }

export interface PeekTarget {
  host: string
  id: number
  anchor: PeekAnchor
}

/** What the store needs of the window. */
export interface PeekDeps {
  /** A watch-only stream of one session; returns the way to close it (`peek` in `host/sessions.ts`). */
  watch: (
    host: string,
    id: number,
    handlers: { data: (text: string) => void; closed: (reason: string | null) => void }
  ) => () => void
  /**
   * Asks whether to end the session, as stopping any running session asks,
   * and ends it when agreed. True when it ended, false when the user kept it
   * running (`session:close` on the host's bridge).
   */
  stop: (host: string, id: number) => Promise<boolean>
  /** Gives the child a tab and brings it forward. */
  openTab: (host: string, id: number) => void
}

/** How much of the child's output the peek keeps for a terminal that mounts after it opened. */
export const REPLAY_LIMIT = 512 * 1024

export interface PeekStore {
  get(): PeekTarget | null
  subscribe(listener: () => void): () => void
  /** Opens the peek on a child, closing any other. The same child again keeps its stream. */
  open(host: string, id: number, anchor: PeekAnchor): void
  /** Closes it, and its stream. */
  close(): void
  /**
   * Draws the peek's output: what has arrived so far, then each chunk as it
   * comes. Returns the way to stop. The terminal that mounts last wins.
   */
  attach(sink: (text: string) => void): () => void
  /** Stop: asks the question stopping a running session asks, then ends the child and closes the peek. */
  stop(): Promise<void>
  /** Open: gives the child a tab, and closes the peek. */
  openAsTab(): void
  /** The window's deps as of its latest render, which the store's next press reads. */
  setDeps(next: PeekDeps): void
  /**
   * Says where the peeked child is on screen now. Closes the peek when it is
   * shown here, or has ended, or is gone.
   */
  reconcile(state: { place: ChildPlace; running: boolean } | null): void
}

const sameAnchor = (a: PeekAnchor, b: PeekAnchor): boolean =>
  a.kind === b.kind && (a.kind === 'row' || (b.kind === 'chip' && a.parentId === b.parentId))

export function createPeek(initial: PeekDeps): PeekStore {
  let deps = initial
  let target: PeekTarget | null = null
  let stopWatching: (() => void) | null = null
  let sink: ((text: string) => void) | null = null
  let kept: string[] = []
  let keptLength = 0
  const listeners = new Set<() => void>()
  const changed = (): void => {
    for (const listener of [...listeners]) listener()
  }

  const end = (): void => {
    stopWatching?.()
    stopWatching = null
    kept = []
    keptLength = 0
    target = null
  }

  const take = (text: string): void => {
    kept.push(text)
    keptLength += text.length
    while (keptLength > REPLAY_LIMIT && kept.length > 1) keptLength -= kept.shift()!.length
    sink?.(text)
  }

  const store: PeekStore = {
    get: () => target,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    open(host, id, anchor) {
      if (target !== null && target.host === host && target.id === id) {
        if (!sameAnchor(target.anchor, anchor)) {
          target = { host, id, anchor }
          changed()
        }
        return
      }
      end()
      const mine: PeekTarget = { host, id, anchor }
      target = mine
      const close = deps.watch(host, id, {
        data: take,
        closed: () => {
          // The stream ended by itself: the child ended, or the connection went.
          if (target !== mine) return
          stopWatching = null
          end()
          changed()
        }
      })
      // The stream may have ended before it returned.
      if (target === mine) stopWatching = close
      else close()
      changed()
    },
    close() {
      if (target === null) return
      end()
      changed()
    },
    attach(next) {
      sink = next
      if (kept.length > 0) next(kept.join(''))
      return () => {
        if (sink === next) sink = null
      }
    },
    async stop() {
      const stopping = target
      if (stopping === null) return
      const ended = await deps.stop(stopping.host, stopping.id)
      if (ended && target === stopping) store.close()
    },
    openAsTab() {
      const opening = target
      if (opening === null) return
      end()
      deps.openTab(opening.host, opening.id)
      changed()
    },
    setDeps(next) {
      deps = next
    },
    reconcile(state) {
      if (target === null) return
      if (state === null || !state.running || (state.place !== 'nowhere' && state.place !== 'chip')) store.close()
    }
  }
  return store
}

/**
 * The layout with child `id` of `host` given a tab in front: in the pane
 * strip that holds its parent's tab where that tab is open here, and in the
 * focused pane otherwise. A child that already has a tab is brought forward
 * where it is.
 */
export function openChildTab(layout: PaneLayout, host: string, child: Pick<SessionRecord, 'id' | 'parentId'>): PaneLayout {
  const ref = sessionRef(child.id, host)
  if (findTab(layout, paneId(ref)) !== null) return openTab(layout, ref)
  const parentAt =
    child.parentId === undefined || child.parentId === null
      ? null
      : findTab(layout, paneId(sessionRef(child.parentId, host)))
  const group = parentAt === null ? layout.focused : (groupById(layout, parentAt.group)?.id ?? layout.focused)
  return openTab(layout, ref, group)
}

/** What the window gives the peek hook. */
export interface UsePeekDeps extends PeekDeps {
  /** Where the child of the open peek is on screen now, or null when it is not listed. */
  stateOf: (host: string, id: number) => { place: ChildPlace; running: boolean } | null
}

/** The peek as a hook: its target, and the store the view draws and presses through. */
export function usePeek(deps: UsePeekDeps): { target: PeekTarget | null; store: PeekStore } {
  const [store] = useState(() => createPeek(deps))
  useEffect(() => {
    store.setDeps(deps)
  })
  const target = useSyncExternalStore(store.subscribe, store.get)
  const state = target === null ? null : deps.stateOf(target.host, target.id)
  const place = state?.place
  const running = state?.running
  useEffect(() => {
    if (target === null) return
    store.reconcile(place === undefined || running === undefined ? null : { place, running })
  }, [store, target, place, running])
  useEffect(() => () => store.close(), [store])
  return { target, store }
}
