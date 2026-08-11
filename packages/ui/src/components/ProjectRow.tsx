import type { JSX } from 'react'
import type { Project } from '@helm/core'
import { cn } from '../lib/cn'
import { GitChip } from './GitChip'
import { FolderIcon, HarnessIcon, RepoIcon } from './icons'

const KIND_ICON = {
  harness: HarnessIcon,
  repo: RepoIcon,
  folder: FolderIcon
} as const

export interface ProjectRowProps {
  project: Project
  selected: boolean
  onSelect: (project: Project) => void
  /** A session is running in this project - the green dot beside the name. */
  live?: boolean | undefined
}

/**
 * Two lines, not one: name above, git below.
 *
 * A single line has to choose between truncating the project name and dropping
 * the branch once a sidebar is narrower than about 420px, and both are the
 * answer someone is looking at the row for. Stacking costs 18px of height and
 * keeps every value legible at the 280px the sidebar actually opens at.
 *
 * The kind icon stays - harness, repo or plain folder is the one thing about a
 * row that its name and branch cannot say. The inventory counts do not: what a
 * project would contribute to a session (skills, agents, commands) is answered
 * in full by the project pane rather than guessed at from three numbers in a
 * 280px rail.
 *
 * `title` is deliberately the only one in the tree - the drivers reach the
 * first project row with `aside nav button[title]`, so the group headers and
 * the scope links above them carry `aria-label` instead.
 */
export function ProjectRow({ project, selected, onSelect, live = false }: ProjectRowProps): JSX.Element {
  const KindIcon = KIND_ICON[project.kind]

  return (
    <button
      type="button"
      onClick={() => onSelect(project)}
      title={project.path}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'group relative flex w-full items-start gap-2 rounded-well py-1.5 pr-2 pl-2.5 text-left transition-colors',
        selected ? 'bg-accent-soft' : 'hover:bg-hover'
      )}
    >
      {selected && (
        <span
          aria-hidden
          className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-accent"
        />
      )}

      <KindIcon
        width={12}
        height={12}
        className={cn(
          'mt-[2px] shrink-0',
          selected ? 'text-accent' : 'text-fg-subtle group-hover:text-fg-muted'
        )}
      />

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              'min-w-0 truncate text-[12.5px] leading-[15px]',
              selected ? 'font-medium text-fg' : 'text-fg'
            )}
          >
            {project.name}
          </span>
          {live && (
            <span
              aria-hidden
              title="A session is running here"
              className="size-[5px] shrink-0 rounded-full bg-success"
            />
          )}
        </span>

        {project.git !== null && <GitChip git={project.git} dense className="mt-px min-w-0" />}
      </span>
    </button>
  )
}
