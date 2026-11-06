import { sessionFamilies, type FamilyMember, type FamilyRow } from '@helm/core/types'
import type { TreeSession } from '@helm/ui'

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
