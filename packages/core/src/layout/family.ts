import type { SessionActivity } from '../types'

/**
 * Sessions that started other sessions, as the Sessions tree and the tabs draw
 * them. Pure and browser-safe, like `panes.ts`, so every rule about where a
 * child is drawn and what pressing it does is tested here and not found in a
 * window.
 *
 * A child is a full session the host started for a parent. It is drawn under
 * its parent whatever folder it runs in, it is shown inside its parent's tab,
 * and it never gets a tab or a pane of its own by being started.
 */

/** What the family rules read of a session: its row id, whether it runs, and the parent it names. */
export interface FamilyMember {
  id: number
  status: string
  /** The session that started this one, by row id, or absent / null for one a person started. */
  parentId?: number | null
  /** What the parent is called on screen. It outlasts the parent's row being open anywhere. */
  parentName?: string | null
}

/** One row of the tree: a session, the children nested under it, and the mark a child shown on its own carries. */
export interface FamilyRow<T extends FamilyMember> {
  session: T
  /** Its children in the order they were given, each with its own. */
  children: FamilyRow<T>[]
  /**
   * The parent's name, for a child drawn at the top level because its parent is
   * not running (it outlived it, or its parent is not listed). Null for every
   * other row.
   */
  parentName: string | null
}

/** Whether a session is one an agent started: it names a parent. */
export function isChild(session: { parentId?: number | null }): boolean {
  return session.parentId !== undefined && session.parentId !== null
}

/**
 * The tree's rows: each session nested under its parent by `parentId`, in
 * whatever folder either runs, with the rest at the top level in the order
 * given.
 *
 * A child nests only under a parent that is running and listed. One whose
 * parent has ended is a top-level row marked with the parent's name, because a
 * child ends with its parent unless it was started to outlive it, and the
 * parent's row is no longer there to hold it. A parent link that loops back on
 * itself cannot be drawn as nesting, so each session on the loop is top level.
 */
export function sessionFamilies<T extends FamilyMember>(sessions: readonly T[]): FamilyRow<T>[] {
  const byId = new Map<number, T>()
  for (const session of sessions) byId.set(session.id, session)

  /** The listed, running session `session` nests under, or null. */
  const holder = (session: T): T | null => {
    if (!isChild(session)) return null
    const parent = byId.get(session.parentId as number)
    return parent !== undefined && parent !== session && parent.status === 'running' ? parent : null
  }

  /** Whether following holders from `session` comes back to it. */
  const loops = (session: T): boolean => {
    const seen = new Set<number>([session.id])
    for (let up = holder(session); up !== null; up = holder(up)) {
      if (up === session) return true
      if (seen.has(up.id)) return false
      seen.add(up.id)
    }
    return false
  }

  const rows = new Map<number, FamilyRow<T>>()
  for (const session of sessions) rows.set(session.id, { session, children: [], parentName: null })

  const top: FamilyRow<T>[] = []
  for (const session of sessions) {
    const row = rows.get(session.id) as FamilyRow<T>
    const parent = loops(session) ? null : holder(session)
    if (parent === null) {
      if (isChild(session)) row.parentName = session.parentName ?? null
      top.push(row)
    } else {
      ;(rows.get(parent.id) as FamilyRow<T>).children.push(row)
    }
  }
  return top
}

/**
 * Which state a dot shows when it stands for several sessions: the one that
 * most wants you. Waiting first, then a reported error, then working, then a
 * failure, then the rest. A folded project and a folded parent both read it.
 */
export const SESSION_URGENCY: readonly UrgentState[] = [
  'waiting',
  'error',
  'busy',
  'failed',
  'running',
  'shell',
  'idle',
  'ended'
]

/** Everything a session's dot can say: what Helm knows of the process, then what the session says of itself. */
export type UrgentState = 'running' | 'ended' | 'failed' | SessionActivity

/** The most pressing of `states`, or null when none has one. */
export function mostPressingState<S extends UrgentState>(states: Iterable<S | null>): S | null {
  let best: S | null = null
  for (const state of states) {
    if (state === null) continue
    if (best === null || SESSION_URGENCY.indexOf(state) < SESSION_URGENCY.indexOf(best)) best = state
  }
  return best
}

/**
 * The state a folded parent shows beside its own: its most pressing
 * descendant's, so a child waiting for you is seen with the family folded.
 * Null when it has no children or none of them has a state.
 */
export function foldedState<T extends FamilyMember, S extends UrgentState>(
  row: FamilyRow<T>,
  stateOf: (session: T) => S | null
): S | null {
  const states: Array<S | null> = []
  const collect = (rows: readonly FamilyRow<T>[]): void => {
    for (const child of rows) {
      states.push(stateOf(child.session))
      collect(child.children)
    }
  }
  collect(row.children)
  return mostPressingState(states)
}

/**
 * What pressing a child's row does:
 *
 * - `own-tab`: the child has a tab in this window, and it comes forward.
 * - `parent-tab`: it has none, so the tab of the nearest running parent that
 *   has one comes forward - the family view in it is where the child is on
 *   screen here.
 * - `open`: neither has a tab here and the session is not a running child of a
 *   running parent, so it is opened as any running session not open here is.
 *   This is the one way a session gets a tab from a press, and it is the user's
 *   press.
 * - `peek`: a running child with nowhere on screen here - its parent's tab is
 *   not open here, its pane has no room for the family view, or this device
 *   does not show children in their parent's tab. Nothing opens or moves; the
 *   window shows the child in a peek, a read-only look at its screen.
 *
 * `id` is the session whose tab comes forward, the one to open, or the one to
 * peek at.
 */
export interface FamilyPress {
  to: 'own-tab' | 'parent-tab' | 'open' | 'peek'
  id: number
}

/**
 * Where a press on session `id`'s row goes, given the sessions listed and the
 * ids this window has a tab for (`sessionTabIds`).
 */
export function resolveFamilyPress<T extends FamilyMember>(
  sessions: readonly T[],
  id: number,
  tabbed: ReadonlySet<number>
): FamilyPress {
  if (tabbed.has(id)) return { to: 'own-tab', id }
  const holder = tabHolder(new Map(sessions.map((session) => [session.id, session])), id, tabbed)
  return holder === null ? { to: 'open', id } : { to: 'parent-tab', id: holder }
}

/**
 * Whether session `id` is a child of a session that is running and listed: the
 * Sessions tree nests it under that parent, and it is a child of a family
 * whether or not any tab here holds it.
 */
export function hasRunningParent<T extends FamilyMember>(byId: ReadonlyMap<number, T>, id: number): boolean {
  const session = byId.get(id)
  if (session === undefined || !isChild(session)) return false
  const parent = byId.get(session.parentId as number)
  return parent !== undefined && parent.id !== id && parent.status === 'running'
}

/**
 * The nearest ancestor of session `id` that is running and has a tab, by row
 * id, or null. A parent that ended is not holding its children any more, so
 * only running parents are climbed through; a loop in the links is not climbed
 * twice.
 */
export function tabHolder<T extends FamilyMember>(
  byId: ReadonlyMap<number, T>,
  id: number,
  tabbed: ReadonlySet<number>
): number | null {
  const seen = new Set<number>([id])
  let current = byId.get(id)
  while (current !== undefined && isChild(current)) {
    const parent = byId.get(current.parentId as number)
    if (parent === undefined || parent.status !== 'running' || seen.has(parent.id)) break
    if (tabbed.has(parent.id)) return parent.id
    seen.add(parent.id)
    current = parent
  }
  return null
}
