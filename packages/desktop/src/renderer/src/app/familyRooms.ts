import { useMemo, useSyncExternalStore } from 'react'
import type { FamilyRoomOf } from '@helm/core/types'

/**
 * What the window last measured of each parent tab's pane: whether it has room
 * for the family view, and how many cards it holds. Outside React, like the
 * terminals, because the pane that measures it is not always drawn - a tab
 * that is not in front measures nothing, and pressing a child's row in the
 * Sessions tree still has to know how many cards its parent's tab holds.
 *
 * A tab that has not been measured has room, so a child is carried and shown
 * from the moment its parent's tab is open, and a pane found to have none says
 * so as soon as it is drawn.
 */
export interface MeasuredRoom {
  fits: boolean
  /** How many children show as cards when it fits. */
  capacity: number
}

/** Replaced, never changed in place, so a reader holding one sees a consistent set of measurements. */
let rooms: ReadonlyMap<string, MeasuredRoom> = new Map()
const listeners = new Set<() => void>()

/** Records what a parent tab's pane measured, and tells everything that reads it when that changed. */
export function reportFamilyRoom(tab: string, room: MeasuredRoom): void {
  const before = rooms.get(tab)
  if (before !== undefined && before.fits === room.fits && before.capacity === room.capacity) return
  rooms = new Map(rooms).set(tab, room)
  for (const listener of listeners) listener()
}

/** Forgets a tab's measurement, for a tab that has closed. */
export function forgetFamilyRoom(tab: string): void {
  if (!rooms.has(tab)) return
  const next = new Map(rooms)
  next.delete(tab)
  rooms = next
  for (const listener of listeners) listener()
}

/** Whether the pane of parent tab `tab` has room for its family view; true until it is measured. */
export function familyRoomFits(tab: string): boolean {
  return rooms.get(tab)?.fits ?? true
}

/** How many cards the parent tab `tab` holds, or null until it is measured or while it has no room. */
export function familyCapacity(tab: string): number | null {
  const room = rooms.get(tab)
  return room === undefined || !room.fits ? null : room.capacity
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The room predicate for core's open-here functions, changing identity when any
 * pane's measurement does so that what depends on it asks again.
 */
export function useFamilyRoomOf(): FamilyRoomOf {
  const measured = useSyncExternalStore(subscribe, () => rooms)
  return useMemo(() => (tab: string) => measured.get(tab)?.fits ?? true, [measured])
}
