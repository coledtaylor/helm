import type { JSX } from 'react'
import { ProjectPane, type ProjectPaneProps } from '@helm/ui'
import { useAgentWorktrees } from './useAgentWorktrees'

/**
 * The project page for a folder on this PC, with the agent worktrees its host
 * holds for it.
 *
 * Only this PC's pages are drawn here: the section is the host's own list, read
 * over this window's connection to it, and a page for a folder on another
 * computer does not ask. `activity` is whatever changes when a session in the
 * project starts or ends (`sessionActivityIn`), and the list is read again then.
 */
export function LocalProjectPane({
  activity,
  ...pane
}: Omit<ProjectPaneProps, 'agentWorktrees' | 'onRemoveAgentWorktree'> & {
  activity: string
}): JSX.Element {
  const { worktrees, remove } = useAgentWorktrees(pane.project.path, activity)
  return <ProjectPane {...pane} agentWorktrees={worktrees} onRemoveAgentWorktree={remove} />
}
