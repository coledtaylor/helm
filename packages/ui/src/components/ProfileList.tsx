import type { DragEvent, JSX, KeyboardEvent } from 'react'
import { useState } from 'react'
import type { Profile } from '@helm/core'
import { cn } from '../lib/cn'
import {
  ExportIcon,
  ImportIcon,
  LayersIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  TrashIcon
} from './icons'

export interface ProfileListProps {
  profiles: Profile[]
  /** Profiles with a session starting right now. */
  launchingIds?: readonly number[] | undefined
  onLaunch: (profile: Profile) => void
  onCreate: () => void
  onEdit: (profile: Profile) => void
  onDelete: (profile: Profile) => void
  onExport: (profile: Profile) => void
  onImport: () => void
  onTogglePin: (profile: Profile) => void
  /** New pinned order, as ids. Only pinned profiles are reorderable. */
  onReorder: (ids: number[]) => void
}

/**
 * Saved launch compositions, pinned ones first (SPEC 4.1).
 *
 * A row is a button that launches, because launching is what a profile is for
 * and every other action on it is a rarity by comparison. The rarities live in
 * a hover strip rather than a context menu: five of them fit, and a menu is one
 * more click on the two - edit and delete - that a person reaches for while
 * still working out what a profile should contain.
 */
export function ProfileList({
  profiles,
  launchingIds = [],
  onLaunch,
  onCreate,
  onEdit,
  onDelete,
  onExport,
  onImport,
  onTogglePin,
  onReorder
}: ProfileListProps): JSX.Element {
  const [dragging, setDragging] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const pinned = profiles.filter((profile) => profile.pinnedOrder !== null)

  const finishDrag = (): void => {
    setDragging(null)
    setDropIndex(null)
  }

  /** Reordering is only meaningful among the pinned, which are the ones with an
   * order to change; the rest are alphabetical and stay that way. */
  const moveTo = (id: number, toIndex: number): void => {
    const from = pinned.findIndex((profile) => profile.id === id)
    if (from < 0) return
    const next = pinned.map((profile) => profile.id)
    next.splice(from, 1)
    next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, id)
    onReorder(next)
  }

  const moveWithKeyboard = (event: KeyboardEvent<HTMLElement>, index: number): void => {
    if (!event.ctrlKey || !event.shiftKey) return
    const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
    if (delta === 0) return
    const profile = pinned[index]
    if (!profile) return
    const target = index + delta
    if (target < 0 || target >= pinned.length) return
    event.preventDefault()
    moveTo(profile.id, target)
  }

  return (
    <section className="flex shrink-0 flex-col border-b border-border">
      <header className="flex h-11 shrink-0 items-center gap-2 px-3">
        <span className="text-[13px] font-semibold tracking-tight text-fg">Profiles</span>
        <span className="text-[11px] tabular-nums text-fg-subtle">{profiles.length}</span>
        <span className="flex-1" />
        <IconButton label="Import a profile" onClick={onImport}>
          <ImportIcon />
        </IconButton>
        <IconButton label="New profile" onClick={onCreate}>
          <PlusIcon />
        </IconButton>
      </header>

      {profiles.length === 0 ? (
        <p className="px-3 pb-3 text-[11px] leading-relaxed text-fg-subtle">
          A profile launches one working directory with other repos&rsquo; skills and agents
          composed in.
        </p>
      ) : (
        <ul
          className="max-h-[40vh] overflow-y-auto overscroll-contain px-2 pb-2"
          aria-label="Saved profiles"
        >
          {profiles.map((profile, index) => {
            const isPinned = profile.pinnedOrder !== null
            const pinnedIndex = pinned.findIndex((p) => p.id === profile.id)
            const launching = launchingIds.includes(profile.id)
            return (
              <li
                key={profile.id}
                draggable={isPinned}
                onDragStart={(event: DragEvent<HTMLLIElement>) => {
                  setDragging(profile.id)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', String(profile.id))
                }}
                onDragEnd={finishDrag}
                onDragOver={(event) => {
                  if (!isPinned || dragging === null) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  const box = event.currentTarget.getBoundingClientRect()
                  setDropIndex(
                    event.clientY < box.top + box.height / 2 ? pinnedIndex : pinnedIndex + 1
                  )
                }}
                onDragLeave={() =>
                  setDropIndex((current) =>
                    current === pinnedIndex || current === pinnedIndex + 1 ? null : current
                  )
                }
                onDrop={(event) => {
                  event.preventDefault()
                  if (dragging === null) return
                  const to = dropIndex ?? pinnedIndex
                  const from = pinned.findIndex((p) => p.id === dragging)
                  moveTo(dragging, from >= 0 && from < to ? to - 1 : to)
                  finishDrag()
                }}
                className={cn(
                  'group relative rounded-md',
                  dragging === profile.id && 'opacity-40',
                  // A hairline between the last pinned profile and the rest, so
                  // "pinned" is visible rather than merely true.
                  isPinned &&
                    pinnedIndex === pinned.length - 1 &&
                    index < profiles.length - 1 &&
                    'mb-1 border-b border-border pb-1'
                )}
              >
                {/* Guarded on `isPinned`, not only on the index: an unpinned row
                    has `pinnedIndex === -1`, so `pinnedIndex + 1` is 0 - a real
                    drop position - and it would draw a drop line under a row
                    that cannot be dropped on. */}
                {isPinned && dropIndex === pinnedIndex && (
                  <span aria-hidden className="absolute inset-x-1 top-0 h-[2px] rounded bg-accent" />
                )}
                {isPinned && dropIndex === pinnedIndex + 1 && (
                  <span
                    aria-hidden
                    className="absolute inset-x-1 bottom-0 h-[2px] rounded bg-accent"
                  />
                )}

                <div className="flex items-center">
                  <button
                    type="button"
                    data-profile={profile.id}
                    onClick={() => onLaunch(profile)}
                    onKeyDown={(event) => moveWithKeyboard(event, pinnedIndex)}
                    disabled={launching}
                    title={`${profile.name} — ${profile.root}`}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left',
                      'transition-colors hover:bg-hover disabled:cursor-default'
                    )}
                  >
                    <LayersIcon
                      width={13}
                      height={13}
                      className={cn('shrink-0', launching ? 'text-fg-subtle' : 'text-accent')}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-fg">{profile.name}</span>
                      <span className="block truncate text-[10px] text-fg-subtle">
                        {launching ? 'Starting…' : summarise(profile)}
                      </span>
                    </span>
                    {isPinned && (
                      <PinIcon
                        width={10}
                        height={10}
                        className="shrink-0 text-fg-subtle group-hover:opacity-0"
                      />
                    )}
                  </button>

                  <div
                    className={cn(
                      'absolute right-1 flex items-center gap-0.5 rounded bg-surface pl-1',
                      'opacity-0 transition group-hover:opacity-100 focus-within:opacity-100'
                    )}
                  >
                    <IconButton
                      label={isPinned ? `Unpin ${profile.name}` : `Pin ${profile.name}`}
                      onClick={() => onTogglePin(profile)}
                      active={isPinned}
                    >
                      <PinIcon width={12} height={12} />
                    </IconButton>
                    <IconButton label={`Edit ${profile.name}`} onClick={() => onEdit(profile)}>
                      <PencilIcon width={12} height={12} />
                    </IconButton>
                    <IconButton label={`Export ${profile.name}`} onClick={() => onExport(profile)}>
                      <ExportIcon width={12} height={12} />
                    </IconButton>
                    <IconButton
                      label={`Delete ${profile.name}`}
                      onClick={() => onDelete(profile)}
                      danger
                    >
                      <TrashIcon width={12} height={12} />
                    </IconButton>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** What this profile composes, in the width a sidebar row has. */
function summarise(profile: Profile): string {
  const parts: string[] = []
  if (profile.overlays.length > 0) {
    parts.push(`${String(profile.overlays.length)} overlay${profile.overlays.length === 1 ? '' : 's'}`)
  }
  if (profile.model) parts.push(profile.model)
  if (profile.effort) parts.push(profile.effort)
  return parts.length > 0 ? parts.join(' · ') : profile.root
}

function IconButton({
  label,
  onClick,
  children,
  active = false,
  danger = false
}: {
  label: string
  onClick: () => void
  children: JSX.Element
  active?: boolean | undefined
  danger?: boolean | undefined
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'grid size-6 place-items-center rounded transition-colors',
        active ? 'text-accent' : 'text-fg-subtle',
        danger ? 'hover:bg-danger/15 hover:text-danger' : 'hover:bg-hover hover:text-fg'
      )}
    >
      {children}
    </button>
  )
}
