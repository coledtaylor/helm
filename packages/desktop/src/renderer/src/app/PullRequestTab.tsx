import type { JSX } from 'react'
import { PullRequestPane } from '@helm/ui'
import { usePullDetail } from './usePullDetail'

/**
 * The pull-request pane, with a fetch behind it.
 *
 * A component of its own rather than a branch inside `App`, for the reason
 * `ProjectShellPane` is one: the state belongs to *this* pull request, so the
 * hook has to mount and unmount with the tab, and a hook called from `App`
 * would either be called conditionally or would have to hold every open tab's
 * answer at once.
 */
export function PullRequestTab({
  repoPath,
  number,
  onOpenExternal,
  compact
}: {
  repoPath: string
  number: number
  onOpenExternal: (url: string) => void
  compact: boolean
}): JSX.Element {
  const detail = usePullDetail(repoPath, number)

  return (
    <PullRequestPane
      view={detail.view}
      loading={detail.loading}
      error={detail.error}
      onRefresh={detail.refresh}
      refreshing={detail.refreshing}
      onOpenExternal={onOpenExternal}
      compact={compact}
    />
  )
}
