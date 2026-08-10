import type { JSX } from 'react'
import type { Project } from '@helm/core'
import { cn } from '../lib/cn'
import { GitChip } from './GitChip'
import { InventoryChips } from './InventoryChips'
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
  /** Harness roots sit flush; their repos are indented under them. */
  indent?: boolean | undefined
  /** A session is running in this project - the green dot beside the name. */
  live?: boolean | undefined
}

/**
 * Two lines, not one: name above, chips below.
 *
 * A single line has to choose between truncating the project name and dropping
 * chips once a sidebar is narrower than about 420px, and both are the answer
 * someone is looking at the row for. Stacking costs 18px of height and keeps
 * every value legible at the 280px the sidebar actually opens at.
 */
export function ProjectRow({
  project,
  selected,
  onSelect,
  indent = false,
  live = false
}: ProjectRowProps): JSX.Element {
  const KindIcon = KIND_ICON[project.kind]
  const hasMeta =
    project.git !== null ||
    project.inventory.skills > 0 ||
    project.inventory.agents > 0 ||
    project.inventory.commands > 0

  return (
    <button
      type="button"
      onClick={() => onSelect(project)}
      title={project.path}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'group relative flex w-full items-start gap-2 rounded-well py-1.5 pr-2 text-left transition-colors',
        indent ? 'pl-7' : 'pl-2',
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
        className={cn(
          'mt-[3px] shrink-0',
          selected ? 'text-accent' : 'text-fg-subtle group-hover:text-fg-muted'
        )}
      />

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              'min-w-0 truncate text-[13px] leading-[18px]',
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

        {hasMeta && (
          // Git left, inventory pinned right. The counts then line up as a
          // column down the sidebar instead of sitting at whatever offset each
          // branch name happens to end at, which is the difference between
          // reading them and hunting for them.
          <span className="mt-0.5 flex items-center gap-3">
            <GitChip git={project.git} className="min-w-0 flex-1" />
            <InventoryChips inventory={project.inventory} className="ml-auto shrink-0" />
          </span>
        )}
      </span>
    </button>
  )
}
