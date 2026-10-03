import type { PaneRef } from '@helm/core/types'

/** What the sidebar can show: the lists the rail opens and tabs are opened from. */
export type SidebarView = 'sessions' | 'files' | 'profiles' | 'settings'

/**
 * The sidebar a tab carries on from, or null for a tab that needs none.
 *
 * The rail starts a piece of work and the tab it leaves open carries on with
 * it: clicking the tab brings this view back, so nobody has to return to the
 * rail for a list the tab already belongs to. A tab with its list inside it
 * (History, Pull requests, Config) or no list at all (Browser) leaves the
 * sidebar as it is. Profiles is reached from the rail alone - a session started
 * from a profile is a session, and belongs to Sessions.
 */
export function sidebarFor(ref: PaneRef): SidebarView | null {
  switch (ref.kind) {
    case 'session':
    case 'project':
    case 'sessions':
    case 'restore':
      return 'sessions'
    case 'file':
      return 'files'
    case 'settings':
      return 'settings'
    case 'history':
    case 'pulls':
    case 'pr':
    case 'config':
    case 'browser':
      return null
  }
}
