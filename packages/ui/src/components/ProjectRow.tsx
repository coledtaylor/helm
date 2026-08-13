import type { JSX } from 'react'
import type { Project } from '@helm/core'
import { cn } from '../lib/cn'
import { GitChip } from './GitChip'
import { FolderIcon, HarnessIcon, PinIcon, RepoIcon } from './icons'

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
  /** In the Pinned section rather than under its harness. */
  pinned?: boolean | undefined
  /** Omitted, the row carries no star at all. */
  onTogglePin?: ((project: Project) => void) | undefined
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
 * the scope links above them carry `aria-label` instead. The pin below keeps to
 * that rule: it is a second `<button>` inside `nav` and it carries no `title`,
 * because giving it one would make every "the first project row" selector in
 * the drivers and in `design-shot` a coin flip.
 */
export function ProjectRow({
  project,
  selected,
  onSelect,
  live = false,
  pinned = false,
  onTogglePin
}: ProjectRowProps): JSX.Element {
  const KindIcon = KIND_ICON[project.kind]

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => onSelect(project)}
        title={project.path}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'relative flex w-full items-start gap-2 rounded-well py-1.5 pl-2.5 text-left transition-colors',
          // The star's gutter, held open whether or not the star is showing.
          // Reserved rather than overlaid: a control that appears on hover and
          // pushes the name it is beside is a row that moves under the pointer,
          // and one that floats over the second line covers the tail of the
          // branch exactly when someone is reading it.
          onTogglePin ? 'pr-7' : 'pr-2',
          // `group-hover` rather than `hover`, so the tint follows the row and
          // not the button: the star sits outside this element, and a row that
          // went flat while the pointer was on its own star would read as two
          // controls rather than one row.
          selected ? 'bg-accent-soft' : 'group-hover:bg-hover'
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

      {onTogglePin && (
        <PinButton
          pinned={pinned}
          name={project.name}
          path={project.path}
          onToggle={() => onTogglePin(project)}
        />
      )}
    </div>
  )
}

/**
 * A pinned path discovery no longer finds.
 *
 * Kept rather than dropped, and said out loud rather than painted as an
 * ordinary row. A pin is a deliberate act and an unplugged drive is not a
 * decision to un-pin, so the entry survives; but the pane must never offer a
 * launch that cannot happen, so this is **not a button**. There is nothing to
 * click, which is the honest shape for a row with nothing behind it, and the
 * one thing still worth doing to it - taking the pin off - is the star, which
 * is shown outright here rather than on hover because it is the row's only
 * control and hover has nothing else to reveal.
 *
 * "folder gone" is `SessionHistory`'s word for the same fact, deliberately: a
 * session whose project directory has vanished wears that badge, and a second
 * vocabulary for one condition is how two surfaces come to disagree about it.
 */
export function MissingProjectRow({
  path,
  onTogglePin
}: {
  path: string
  onTogglePin?: ((path: string) => void) | undefined
}): JSX.Element {
  return (
    <div
      className={cn(
        'group relative flex w-full items-start gap-2 rounded-well py-1.5 pl-2.5',
        onTogglePin ? 'pr-7' : 'pr-2'
      )}
      title={path}
    >
      <FolderIcon width={12} height={12} className="mt-[2px] shrink-0 text-fg-subtle opacity-50" />

      <span className="min-w-0 flex-1">
        <span className="block min-w-0 truncate text-[12.5px] leading-[15px] text-fg-muted">
          {baseName(path)}
        </span>
        <span className="mt-px flex min-w-0 items-baseline">
          <span className="shrink-0 rounded-sm border border-border px-1 text-[9px] tracking-wide text-fg-subtle uppercase">
            folder gone
          </span>
        </span>
      </span>

      {onTogglePin && (
        <PinButton
          pinned={true}
          always={true}
          name={baseName(path)}
          path={path}
          onToggle={() => onTogglePin(path)}
        />
      )}
    </div>
  )
}

/**
 * The star, and the one place in the tree where a row carries a button.
 *
 * DESIGN.md §5 states the rule this is the exception to, and states this as the
 * exception: a row's own action stays the row, and a control that changes
 * *which list the row is in* is not the row's action. It is hidden at rest and
 * revealed by `group-hover`, so a tree of a dozen rows still reads as names.
 *
 * Revealed by **opacity**, never by mounting it on a hover state. Three things
 * depend on the element being there the whole time: keyboard focus can reach it
 * (`focus-visible` shows it), the reserved gutter above does not have to guess,
 * and `pnpm affordance-check` can enumerate it - that walk skips `display:none`
 * and `visibility:hidden`, so a star that only existed under the pointer would
 * be a control it reports on and a control nothing measures, which is the
 * coverage gap AFF-2 exists to name.
 */
function PinButton({
  pinned,
  name,
  path,
  always = false,
  onToggle
}: {
  pinned: boolean
  name: string
  path: string
  always?: boolean | undefined
  onToggle: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      data-pin-project={path}
      aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
      onClick={onToggle}
      className={cn(
        'absolute top-1/2 right-1 grid size-5 -translate-y-1/2 place-items-center rounded-[5px]',
        'transition hover:bg-hover',
        pinned ? 'text-accent' : 'text-fg-subtle hover:text-fg',
        !always && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
      )}
    >
      <PinIcon width={12} height={12} />
    </button>
  )
}

/**
 * The last segment of a path, for a project no scan can name.
 *
 * Discovery is where a project's `name` comes from and it will not return one
 * for a directory that is not there, so this is what is left. Both separators,
 * because a value typed into the setting by hand is still a value this has to
 * render; the whole path is on the row's `title` either way.
 */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '')
  return parts[parts.length - 1] ?? path
}
