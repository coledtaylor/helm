import type { JSX } from 'react'
import { Fragment } from 'react'
import type { ContentDirEntry, ContentDirListing } from '@helm/core'
import { cn } from '../lib/cn'
import { CONTENT_KIND_ICON } from '../lib/contentIcons'
import { ROW_SELECTED } from '../lib/rows'
import { CaretIcon, FolderIcon, LinkIcon } from './icons'

/**
 * A scope as an ordinary file tree.
 *
 * The other half of SPEC 4.3's split, and the half that makes no judgements:
 * every entry a directory holds is a row. What it *does* judge is which
 * directories to read, and it reads exactly the ones somebody opened - so the
 * component renders from a map of listings rather than from a walk, and a
 * directory that has never been expanded has no listing and no rows.
 *
 * Two kinds of row do not expand and both say why on themselves rather than by
 * being absent: an **ignored** directory, which the repository's own rules put
 * out of bounds, and a **link**, because an overlay shim's junction points back
 * into a real repository and following one would list another project's files
 * as this scope's. That rule is the same one `readContentTree` and
 * `readConfigTree` follow, and it is enforced in `filetree.ts` - this component
 * only draws the consequence.
 */

export interface ContentTreeListProps {
  scopeLabel: string
  /** One listing per directory read, keyed by scope-relative path. `''` is the root. */
  dirs: ReadonlyMap<string, ContentDirListing>
  expandedDirs: ReadonlySet<string>
  loadingDirs: ReadonlySet<string>
  selectedPath: string | null
  onToggleDir: (relPath: string) => void
  onOpenPath: (path: string) => void
  onReveal: (path: string) => void
}

/** How deep a row is indented, in pixels per level. */
const INDENT = 12

export function ContentTreeList({
  scopeLabel,
  dirs,
  expandedDirs,
  loadingDirs,
  selectedPath,
  onToggleDir,
  onOpenPath,
  onReveal
}: ContentTreeListProps): JSX.Element {
  const root = dirs.get('')

  if (root === undefined) {
    return <p className="px-2 py-6 text-center text-[12px] text-fg-subtle">Reading&hellip;</p>
  }
  if (root.error !== null) {
    return (
      <p className="px-3 py-6 text-center text-[12px] text-danger" data-content-tree-error>
        {scopeLabel} could not be read: {root.error}
      </p>
    )
  }
  if (root.entries.length === 0) {
    return (
      <div className="px-3 py-8 text-center">
        <FolderIcon width={20} height={20} className="mx-auto text-fg-subtle" />
        <p className="mt-2 text-[12px] text-fg-muted">{scopeLabel} is empty.</p>
      </div>
    )
  }

  return (
    <div data-content-tree={root.ignoreSource}>
      <Level
        relPath=""
        depth={0}
        dirs={dirs}
        expandedDirs={expandedDirs}
        loadingDirs={loadingDirs}
        selectedPath={selectedPath}
        onToggleDir={onToggleDir}
        onOpenPath={onOpenPath}
        onReveal={onReveal}
      />
      {/* The rule, under the tree it governs. Somebody looking at a greyed
          `node_modules/` should not have to work out whether Helm decided that
          or the repository did. */}
      <p className="px-2 py-3 text-[10.5px] leading-relaxed text-fg-subtle">
        Directories read lazily on expand ·{' '}
        {root.ignoreSource === 'gitignore'
          ? '.gitignore respected'
          : 'no repository here, so Helm’s own list decides'}
      </p>
    </div>
  )
}

function Level({
  relPath,
  depth,
  dirs,
  expandedDirs,
  loadingDirs,
  selectedPath,
  onToggleDir,
  onOpenPath,
  onReveal
}: {
  relPath: string
  depth: number
} & Omit<ContentTreeListProps, 'scopeLabel'>): JSX.Element | null {
  const listing = dirs.get(relPath)
  if (listing === undefined) return null

  return (
    <>
      {listing.entries.map((entry) => (
        <Fragment key={entry.path}>
          <TreeRow
            entry={entry}
            depth={depth}
            open={expandedDirs.has(entry.relPath)}
            loading={loadingDirs.has(entry.relPath)}
            selected={selectedPath?.toLowerCase() === entry.path.toLowerCase()}
            onToggleDir={onToggleDir}
            onOpenPath={onOpenPath}
            onReveal={onReveal}
          />
          {entry.directory && expandedDirs.has(entry.relPath) && (
            <Level
              relPath={entry.relPath}
              depth={depth + 1}
              dirs={dirs}
              expandedDirs={expandedDirs}
              loadingDirs={loadingDirs}
              selectedPath={selectedPath}
              onToggleDir={onToggleDir}
              onOpenPath={onOpenPath}
              onReveal={onReveal}
            />
          )}
        </Fragment>
      ))}
      {listing.error !== null && (
        <p
          className="py-1 text-[10.5px] text-danger"
          style={{ paddingLeft: `${String(depth * INDENT + 22)}px` }}
        >
          {listing.error}
        </p>
      )}
    </>
  )
}

function TreeRow({
  entry,
  depth,
  open,
  loading,
  selected,
  onToggleDir,
  onOpenPath,
  onReveal
}: {
  entry: ContentDirEntry
  depth: number
  open: boolean
  loading: boolean
  selected: boolean
  onToggleDir: (relPath: string) => void
  onOpenPath: (path: string) => void
  onReveal: (path: string) => void
}): JSX.Element {
  // A directory that is ignored or is a link is a row and not a door. Both are
  // listed so the reader knows they are there; neither is walked.
  const walkable = entry.directory && !entry.ignored && !entry.link
  const unopenable = !entry.directory && entry.kind === 'binary'
  const Icon = entry.directory ? FolderIcon : CONTENT_KIND_ICON[entry.kind ?? 'binary']

  const onClick = (): void => {
    if (walkable) return onToggleDir(entry.relPath)
    // A directory Helm will not read has nothing to open onto, so Explorer is
    // the only answer left. A *file* always opens - a binary onto the pane that
    // says what it is and offers Explorer from there, which is a click the
    // reader chooses rather than one that throws them out of the app.
    if (entry.directory) return onReveal(entry.path)
    onOpenPath(entry.path)
  }

  return (
    <button
      type="button"
      data-content-tree-entry={entry.relPath}
      data-content-kind={entry.directory ? 'dir' : entry.kind}
      data-content-ignored={entry.ignored}
      {...(walkable ? { 'aria-expanded': open } : {})}
      aria-current={selected}
      onClick={onClick}
      title={
        entry.ignored
          ? `${entry.path}\nIgnored by ${entry.ignoredBy === 'gitignore' ? 'this repository’s .gitignore' : 'Helm’s built-in list'} - listed, not read`
          : entry.link
            ? `${entry.path}\nA link. Helm lists it and does not follow it.`
            : unopenable
              ? `${entry.path}\nNot a kind Helm reads`
              : entry.path
      }
      style={{ paddingLeft: `${String(depth * INDENT + 8)}px` }}
      className={cn(
        'relative flex w-full items-center gap-1.5 rounded-well py-[3px] pr-2 text-left transition-colors',
        selected ? ROW_SELECTED : 'hover:bg-hover'
      )}
    >
      {selected && (
        <span aria-hidden className="absolute top-1 bottom-1 left-0 w-[2px] rounded-full bg-accent" />
      )}

      {/* The caret's slot is held whether or not there is a caret, so names
          line up down a level instead of stepping in and out with them. */}
      <span aria-hidden className="grid size-3 shrink-0 place-items-center">
        {walkable && (
          <CaretIcon
            width={8}
            height={8}
            className={cn(
              'transition-transform',
              open && 'rotate-90',
              loading && 'animate-pulse text-accent'
            )}
          />
        )}
      </span>

      <Icon
        width={12}
        height={12}
        className={cn(
          'shrink-0',
          selected ? 'text-accent' : entry.ignored || unopenable ? 'text-fg-subtle/60' : 'text-fg-subtle'
        )}
      />

      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[12px]',
          entry.ignored || unopenable ? 'text-fg-subtle' : 'text-fg'
        )}
      >
        {entry.name}
        {entry.directory && '/'}
      </span>

      {entry.link && (
        <LinkIcon
          width={10}
          height={10}
          className="shrink-0 text-fg-subtle"
          aria-label="A link, not followed"
        />
      )}

      {entry.ignored && (
        <span className="shrink-0 rounded-full border border-border px-1.5 text-[9px] leading-[15px] tracking-[.06em] text-fg-subtle">
          IGNORED
        </span>
      )}
    </button>
  )
}
