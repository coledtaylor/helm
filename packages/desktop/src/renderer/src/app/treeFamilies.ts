import {
  commandState,
  isCommandChild,
  pressSessionRow,
  sessionFamilies,
  type FamilyMember,
  type FamilyPress,
  type FamilyRow,
  type FamilyRoomOf,
  type PaneLayout
} from '@helm/core/types'
import type { TreeSession } from '@helm/ui'

/**
 * What a command child's row says of itself, or null for a session that is not
 * one. A command has no conversation to be busy or waiting in, so its state is
 * only whether it runs and, once it ended, its exit code: whatever an agent's
 * records say of the process is not read for it. Its word is `running`, then
 * `exited <code>`, as the family view's ended header says it.
 */
export function commandRow(session: {
  status: string
  exitCode?: number | null
  stopped?: boolean
  command?: string | null
}): Pick<TreeSession, 'state' | 'command' | 'note'> | null {
  if (!isCommandChild(session)) return null
  return { state: commandState(session), command: true, note: commandWord(session) }
}

/**
 * The word for a command child's state: `running`, then `exited <code>`,
 * `stopped` where the host ended it, or `ended` where its code was never seen.
 * The row's note, the row's accessible label and the glyph's hover text in the
 * family view all say this.
 */
export function commandWord(session: { status: string; exitCode?: number | null; stopped?: boolean }): string {
  if (commandState(session) === 'running') return 'running'
  if (session.stopped === true) return 'stopped'
  const code = session.exitCode ?? null
  return code === null ? 'ended' : `exited ${String(code)}`
}

/** A session the Sessions tree lists in a folder's own list, and the row it draws. */
export interface TreeEntry<T> {
  session: T
  /** Its row, with the rows of the sessions it started nested under it. */
  row: TreeSession
}

/**
 * The Sessions tree's rows for `sessions`: each child's row nested under its
 * parent's, in whatever folder either runs, and one entry for every other
 * session - the ones the caller lists under the folder each runs in.
 *
 * A child whose parent has ended (or is not listed) is such an entry too, and
 * its row names the parent, because the row that held it is no longer there.
 * `rowOf` draws one session's own row; the nesting is added here, so the
 * folder a child runs in decides nothing about where it is drawn.
 */
export function treeEntries<T extends FamilyMember>(
  sessions: readonly T[],
  rowOf: (session: T) => TreeSession
): TreeEntry<T>[] {
  const build = (family: FamilyRow<T>): TreeSession => {
    const nested = family.children.map(build)
    return {
      ...rowOf(family.session),
      ...(nested.length > 0 ? { nested } : {}),
      ...(family.parentName !== null ? { parentName: family.parentName } : {})
    }
  }
  return sessionFamilies(sessions).map((family) => ({ session: family.session, row: build(family) }))
}

/** What a press on a session's row in the tree reads and changes of this window. */
export interface TreePressDeps {
  /** The panes now. */
  layout: PaneLayout
  /** Whether this device shows children in their parent's tab. */
  enabled: boolean
  /** How many cards the parent tab `tab` holds, or null when its pane has not been measured. */
  capacityOf: (tab: string) => number | null
  /** Whether the pane of parent tab `tab` has room for its family view; every pane has when left out. */
  roomOf?: FamilyRoomOf
  /** The one way the panes change; a functional update, composed with any other in the same event. */
  commit: (op: (layout: PaneLayout) => PaneLayout) => void
}

/**
 * A press on session `id`'s row in the tree, on `host`, whose sessions are
 * `there`: where it goes (`FamilyPress`), and `id` on it is the session whose
 * tab comes forward or opens, or the one to peek at.
 *
 * A child with no tab whose parent's tab is here is shown in that tab's family
 * view first, the last card shrinking in its place when it was a header, and
 * the parent's tab is what comes forward; no tab is added. Only a child with
 * neither opens a tab, on this press (`pressSessionRow`). A running child with
 * nowhere on screen here is a `peek`, and nothing changes in the panes.
 */
export function pressTreeSession(
  host: string,
  there: readonly FamilyMember[],
  id: number,
  deps: TreePressDeps
): FamilyPress {
  const scope = {
    enabled: deps.enabled,
    capacityOf: deps.capacityOf,
    ...(deps.roomOf === undefined ? {} : { roomOf: deps.roomOf })
  }
  const { press } = pressSessionRow(deps.layout, there, id, host, scope)
  if (press.to === 'parent-tab') {
    deps.commit((current) => pressSessionRow(current, there, id, host, scope).layout)
  }
  return press
}
