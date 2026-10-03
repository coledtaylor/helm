import type { ProjectKind } from '@helm/core/types'
import { FolderIcon, HarnessIcon, RepoIcon } from '../components/icons'

/**
 * A project's glyph by what it is: a harness, a repository, or a plain folder.
 * One table, so the tree, the launcher and the new-tab popover cannot draw the
 * same folder three ways. A table rather than a function for the reason
 * `CONTENT_KIND_ICON` gives.
 */
export const PROJECT_KIND_ICON: Record<ProjectKind, typeof FolderIcon> = {
  harness: HarnessIcon,
  repo: RepoIcon,
  folder: FolderIcon
}
