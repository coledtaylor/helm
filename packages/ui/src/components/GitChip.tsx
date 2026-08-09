import type { JSX } from 'react'
import type { GitState } from '@helm/core'
import { Chip } from './Chip'
import { AheadIcon, BehindIcon, BranchIcon, DirtyIcon } from './icons'
import { cn } from '../lib/cn'

export interface GitChipProps {
  git: GitState | null
  className?: string | undefined
}

/**
 * Branch, dirty count, ahead/behind - the four numbers SPEC 4.1 asks for at a
 * glance. Renders nothing for a directory that is not a repo rather than a
 * placeholder, so a row's chips only ever mean something.
 *
 * The branch is the only part allowed to shrink. It is the one value with an
 * unbounded length and the one whose tail carries the least information, so a
 * narrow sidebar ellipsises `feature/normalize-…` rather than pushing the
 * counts off the right edge.
 */
export function GitChip({ git, className }: GitChipProps): JSX.Element | null {
  if (!git) return null

  if (git.error !== undefined) {
    return (
      <Chip tone="danger" icon={<BranchIcon />} title={git.error} className={className}>
        git error
      </Chip>
    )
  }

  const label = git.detached ? 'detached' : (git.branch ?? 'no branch')

  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      <Chip
        icon={<BranchIcon />}
        tone={git.detached ? 'warn' : 'neutral'}
        title={git.detached ? 'HEAD is detached' : `On branch ${label}`}
        truncate
      >
        {label}
      </Chip>
      {git.dirty > 0 && (
        <Chip
          tone="warn"
          icon={<DirtyIcon width={8} height={8} />}
          title={`${git.dirty} changed file${git.dirty === 1 ? '' : 's'}`}
        >
          {git.dirty}
        </Chip>
      )}
      {git.ahead > 0 && (
        <Chip
          tone="success"
          icon={<AheadIcon width={11} height={11} />}
          title={`${git.ahead} commit${git.ahead === 1 ? '' : 's'} ahead of upstream`}
        >
          {git.ahead}
        </Chip>
      )}
      {git.behind > 0 && (
        <Chip
          tone="accent"
          icon={<BehindIcon width={11} height={11} />}
          title={`${git.behind} commit${git.behind === 1 ? '' : 's'} behind upstream`}
        >
          {git.behind}
        </Chip>
      )}
    </span>
  )
}
