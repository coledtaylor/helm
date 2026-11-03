import { LOCAL_HOST_KEY, hostOf, type PaneRef } from '@helm/core/types'

/** A session started from a project's row or page that did not start, on whichever host. */
export interface TreeLaunchFailure {
  /** `LOCAL_HOST_KEY`, or a host on another computer by id. */
  host: string
  /** The project's folder on that host. */
  path: string
  /** The project's name. */
  name: string
  /** Why, as the host said it. */
  text: string
}

/**
 * The line over the panes for a launch from the sidebar or a project page
 * that failed, or null where it would say it twice: the project's own page,
 * in front, already says why on its problem line. A launch from the tree has
 * no launcher to say it in, and whatever is on screen is unrelated, so
 * without this line it would be silent. A host on another computer is named.
 */
export function treeLaunchNotice(
  failure: TreeLaunchFailure | null,
  front: PaneRef | null,
  hostName: (host: string) => string
): string | null {
  if (failure === null) return null
  if (front?.kind === 'project' && hostOf(front) === failure.host && front.path === failure.path) return null
  const where = failure.host === LOCAL_HOST_KEY ? failure.name : `${failure.name} on ${hostName(failure.host)}`
  return `Could not start a session in ${where}: ${failure.text}`
}
