import type { JSX } from 'react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ContentDirEntry, ContentDirListing, ContentScope, FilesStatus, GitFileState } from '@helm/core'
import { changedDirectories, GIT_STATE_LABEL, GIT_STATE_LETTER } from '@helm/core/types'
import { cn } from '../lib/cn'
import { ROW_SELECTED_GROUP } from '../lib/rows'
import { CaretIcon, CheckIcon, CodeIcon, CopyIcon, DocIcon, FolderIcon, HarnessIcon, LinkIcon, SearchIcon } from './icons'
import { Menu } from './Menu'

/**
 * A project's files, in the sidebar, with git's letters on them.
 *
 * The content viewer's tree with one judgement added: what changed. Read the
 * same lazy way - a directory is listed when it is opened and not before - and
 * drawn from a map of listings keyed by project-relative path, so a folder
 * nobody opened costs nothing.
 *
 * Every row carries its own hand-offs on hover - VS Code, Explorer, the path -
 * because "open this somewhere better" is half of what the view is for, and a
 * file you have to open in a tab before you can send it elsewhere is a click
 * spent on nothing.
 */

export interface FilesTreeProps {
  /** The project's name, for the empty and unreadable states. */
  rootLabel: string
  /** One listing per directory read, keyed by project-relative path. `''` is the root. */
  dirs: ReadonlyMap<string, ContentDirListing>
  expanded: ReadonlySet<string>
  loading: ReadonlySet<string>
  status: FilesStatus | null
  /** The file in front of the focused pane, absolute, or null. */
  selectedPath: string | null
  /**
   * Changed to scroll `selectedPath`'s row into view, once it is drawn - its
   * folders may still be being read. Absent, the tree never scrolls itself.
   */
  revealSeq?: number
  onToggleDir: (relPath: string) => void
  /** A file to open: `keep` false for a single click, which opens a preview. */
  onOpen: (path: string, keep: boolean) => void
  onReveal: (path: string) => void
  onCopyPath: (path: string) => void
  /** Null where VS Code is not installed: the button is then not offered. */
  onOpenInEditor: ((path: string) => void) | null
  onGoToFile: () => void
}

/** How deep a row is indented, in pixels per level. */
const INDENT = 12

const LETTER_TONE: Record<GitFileState, string> = {
  modified: 'text-warn',
  added: 'text-success',
  untracked: 'text-success',
  renamed: 'text-accent-text',
  deleted: 'text-danger',
  conflicted: 'text-danger'
}

export function FilesTree(props: FilesTreeProps): JSX.Element {
  const { rootLabel, dirs, loading, status, selectedPath, revealSeq, onGoToFile } = props
  const root = dirs.get('')
  const files = status?.files ?? null
  const dirty = useMemo(() => (files === null ? new Set<string>() : changedDirectories(files)), [files])

  const listRef = useRef<HTMLDivElement>(null)
  const revealed = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (revealSeq === undefined || revealed.current === revealSeq) return
    const row = listRef.current?.querySelector<HTMLElement>('[aria-current="true"]')
    if (row) {
      row.scrollIntoView({ block: 'nearest' })
      revealed.current = revealSeq
      return
    }
    // Everything on the way is read and the row is still not drawn: the file
    // is not in the tree (deleted, or behind a folder that is never walked).
    // Stop waiting, so a folder opened later does not yank the tree to it.
    if (root !== undefined && loading.size === 0) revealed.current = revealSeq
  }, [revealSeq, selectedPath, root, dirs, loading])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button
        type="button"
        onClick={onGoToFile}
        data-files-go-to
        className={cn(
          'mx-2 mb-1.5 flex h-7 shrink-0 items-center gap-[7px] rounded-well border border-border bg-surface-sunken px-[9px] text-left text-fg-subtle',
          'transition-colors hover:border-border-strong hover:text-fg-muted'
        )}
      >
        <SearchIcon width={12} height={12} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[12.5px]">Go to file</span>
        <span className="shrink-0 font-mono text-[10.5px]">Ctrl P</span>
      </button>

      <div ref={listRef} role="group" aria-label="Project files" className="min-h-0 flex-1 overflow-y-auto px-1.5 pt-0.5 pb-1.5 text-[12.5px]">
        {root === undefined ? (
          <p className="px-2 py-6 text-center text-[12px] text-fg-subtle">Reading&hellip;</p>
        ) : root.error !== null ? (
          <p role="alert" className="px-3 py-6 text-center text-[12px] text-danger">
            {rootLabel} could not be read: {root.error}
          </p>
        ) : root.entries.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <FolderIcon width={20} height={20} className="mx-auto text-fg-subtle" />
            <p className="mt-2 text-[12px] text-fg-muted">{rootLabel} is empty.</p>
          </div>
        ) : (
          <Level relPath="" depth={0} dirty={dirty} files={files} {...props} />
        )}
      </div>
    </div>
  )
}

/**
 * Which project the tree shows, beside the view's title: a control as wide as
 * the project's name, and a list Helm draws itself (`Menu`). The native
 * `<select>` it replaces opened a white list with the theme's light text on
 * it, in every theme.
 *
 * A folder that is not in the list (a session's working directory no scan
 * reached) is added to it, so the picker never claims to show something other
 * than what the tree does.
 */
export function FilesRootPicker({
  roots,
  value,
  onChange
}: {
  roots: readonly ContentScope[]
  value: string | null
  onChange: (root: string) => void
}): JSX.Element {
  const [open, setOpen] = useState<DOMRect | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const key = value?.toLowerCase() ?? ''
  const listed = roots.some((scope) => scope.path.toLowerCase() === key)
  const options =
    value === null || listed
      ? roots
      : [{ kind: 'project' as const, path: value, label: value.split(/[\\/]/).filter(Boolean).at(-1) ?? value }, ...roots]
  const current = options.find((scope) => scope.path.toLowerCase() === key)
  const show = (): void => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect !== undefined) setOpen(rect)
  }
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Project"
        aria-haspopup="listbox"
        aria-expanded={open !== null}
        title={current?.path}
        data-files-root-picker
        onClick={() => (open === null ? show() : setOpen(null))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && open === null) {
            event.preventDefault()
            show()
          }
        }}
        className={cn(
          'flex h-[22px] max-w-full min-w-0 items-center gap-[5px] rounded-well border border-border-strong px-[7px]',
          'text-[12px] text-fg transition-colors hover:bg-hover',
          open !== null && 'bg-hover'
        )}
      >
        <span className="min-w-0 truncate">{current?.label ?? 'Choose a project'}</span>
        <CaretIcon width={8} height={8} className="shrink-0 rotate-90 text-fg-subtle" />
      </button>
      {open !== null && (
        <Menu
          label="Projects"
          role="listbox"
          at={{ below: open }}
          anchorRef={buttonRef}
          minWidth={Math.max(220, open.width)}
          entries={options.map((scope) => ({
            kind: 'item' as const,
            id: scope.path,
            label: scope.label,
            checked: scope.path.toLowerCase() === key,
            title: scope.path,
            icon:
              scope.kind === 'harness' ? (
                <HarnessIcon width={13} height={13} />
              ) : (
                <FolderIcon width={13} height={13} />
              )
          }))}
          onSelect={onChange}
          onDismiss={() => setOpen(null)}
        />
      )}
    </>
  )
}

/**
 * The line under the tree that says what git could and could not say. Absent
 * when there is nothing to say: a repository git answered for is the ordinary
 * case and needs no caption.
 */
export function FilesStatusNote({ status }: { status: FilesStatus | null }): JSX.Element | null {
  if (status === null) return null
  if (status.repo === null) {
    return <p className="px-2 py-1 text-[11px] text-fg-subtle">Not a git repository - no changes to mark</p>
  }
  if (status.files === null) {
    return (
      <p role="status" title={status.error ?? undefined} className="truncate px-2 py-1 text-[11px] text-warn">
        Could not read git status{status.error === null ? '' : `: ${status.error}`}
      </p>
    )
  }
  return null
}

type LevelProps = FilesTreeProps & {
  relPath: string
  depth: number
  dirty: ReadonlySet<string>
  files: Readonly<Record<string, GitFileState>> | null
}

function Level(props: LevelProps): JSX.Element | null {
  const { relPath, depth, dirs, expanded } = props
  const listing = dirs.get(relPath)
  if (listing === undefined) return null
  return (
    <>
      {/* `.git` is the repository's database rather than any of its files, and
          this tree's letters are already everything worth reading out of it.
          Ignored folders stay listed, greyed - `node_modules` is part of the
          project somebody might want to look inside; `.git` is not. */}
      {listing.entries.filter((entry) => entry.name.toLowerCase() !== '.git').map((entry) => (
        <Fragment key={entry.path}>
          <Row {...props} entry={entry} />
          {entry.directory && expanded.has(entry.relPath) && (
            <Level {...props} relPath={entry.relPath} depth={depth + 1} />
          )}
        </Fragment>
      ))}
      {listing.error !== null && (
        <p
          className="py-1 text-[10.5px] text-danger"
          style={{ paddingLeft: `${String(depth * INDENT + 24)}px` }}
        >
          {listing.error}
        </p>
      )}
    </>
  )
}

function Row({
  entry,
  depth,
  expanded,
  loading,
  selectedPath,
  dirty,
  files,
  onToggleDir,
  onOpen,
  onReveal,
  onCopyPath,
  onOpenInEditor
}: LevelProps & { entry: ContentDirEntry }): JSX.Element {
  // A directory that is ignored or is a link is a row and not a door - listed
  // so the reader knows it is there, never walked (`filetree.ts`).
  const walkable = entry.directory && !entry.ignored && !entry.link
  const open = expanded.has(entry.relPath)
  const selected = !entry.directory && selectedPath?.toLowerCase() === entry.path.toLowerCase()
  const state = files?.[entry.relPath]
  const changedInside = entry.directory && dirty.has(entry.relPath)
  // One glyph for every file, as the tree in the mockup draws it: what a file
  // is, the name says, and a column of mixed glyphs is noise beside the letters.
  const Icon = DocIcon
  const muted = entry.ignored

  const activate = (keep: boolean): void => {
    if (walkable) return onToggleDir(entry.relPath)
    // A folder Helm will not walk has nothing to open onto but Explorer.
    if (entry.directory) return onReveal(entry.path)
    onOpen(entry.path, keep)
  }

  const hint = [
    entry.path,
    state === undefined ? null : GIT_STATE_LABEL[state],
    changedInside ? 'Holds changed files' : null,
    entry.ignored ? 'Ignored by git - listed, not read' : null,
    entry.link ? 'A link. Helm lists it and does not follow it.' : null
  ]
    .filter((line) => line !== null)
    .join('\n')

  return (
    <div
      data-files-entry={entry.relPath}
      data-files-state={state}
      className={cn(
        'group relative flex h-6 items-center rounded-raised transition-colors',
        selected ? ROW_SELECTED_GROUP : 'hover:bg-hover'
      )}
    >
      {selected && <span aria-hidden className="absolute top-[5px] bottom-[5px] left-0 w-[2px] rounded-full bg-accent" />}
      <button
        type="button"
        title={hint}
        {...(walkable ? { 'aria-expanded': open } : {})}
        aria-current={selected ? 'true' : undefined}
        onClick={() => activate(false)}
        onDoubleClick={() => {
          if (!entry.directory) activate(true)
        }}
        style={{ paddingLeft: `${String(depth * INDENT + 6)}px` }}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-2 text-left outline-none focus-visible:rounded-raised focus-visible:ring-1 focus-visible:ring-accent"
      >
        {/* The caret's slot is held for files too, so names line up down a
            level instead of stepping in and out with them. */}
        <span aria-hidden className="grid size-3 shrink-0 place-items-center text-fg-subtle">
          {walkable && (
            <CaretIcon
              width={8}
              height={8}
              className={cn('transition-transform', open && 'rotate-90', loading.has(entry.relPath) && 'animate-pulse text-accent')}
            />
          )}
        </span>
        {!entry.directory && (
          <Icon
            width={12}
            height={12}
            className={cn('shrink-0', selected ? 'text-accent' : muted ? 'text-fg-subtle/60' : 'text-fg-subtle')}
          />
        )}
        <span
          className={cn(
            'min-w-0 flex-1 truncate',
            muted ? 'text-fg-subtle' : entry.directory || selected ? 'text-fg' : 'text-fg-muted'
          )}
        >
          {entry.name}
        </span>
        {entry.link && <LinkIcon width={10} height={10} className="shrink-0 text-fg-subtle" aria-label="A link, not followed" />}
        {/* Hidden while the row's own actions are showing, which take its place. */}
        {state !== undefined && (
          <span
            aria-label={GIT_STATE_LABEL[state]}
            className={cn('shrink-0 font-mono text-[10.5px] group-hover:hidden group-has-[:focus-visible]:hidden', LETTER_TONE[state])}
          >
            {GIT_STATE_LETTER[state]}
          </span>
        )}
        {changedInside && (
          <span
            aria-label="Holds changed files"
            className="size-[5px] shrink-0 rounded-full bg-warn group-hover:hidden group-has-[:focus-visible]:hidden"
          />
        )}
      </button>

      <RowActions
        path={entry.path}
        directory={entry.directory}
        onReveal={onReveal}
        onCopyPath={onCopyPath}
        onOpenInEditor={onOpenInEditor}
      />
    </div>
  )
}

/**
 * VS Code, Explorer and the path, on the row under the pointer or the
 * keyboard. Out of the row's own button - a button inside a button is invalid
 * and every click on one would also open the file.
 */
function RowActions({
  path,
  directory,
  onReveal,
  onCopyPath,
  onOpenInEditor
}: {
  path: string
  directory: boolean
  onReveal: (path: string) => void
  onCopyPath: (path: string) => void
  onOpenInEditor: ((path: string) => void) | null
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])

  const what = directory ? 'folder' : 'file'
  return (
    <span className="hidden shrink-0 items-center pr-1 group-hover:flex group-has-[:focus-visible]:flex">
      {onOpenInEditor !== null && (
        <RowAction label={`Open ${what} in VS Code`} onClick={() => onOpenInEditor(path)}>
          <CodeIcon width={12} height={12} />
        </RowAction>
      )}
      <RowAction label="Reveal in Explorer" onClick={() => onReveal(path)}>
        <FolderIcon width={12} height={12} />
      </RowAction>
      <RowAction
        label={copied ? 'Path copied' : 'Copy path'}
        onClick={() => {
          onCopyPath(path)
          setCopied(true)
        }}
      >
        {copied ? <CheckIcon width={12} height={12} className="text-success" /> : <CopyIcon width={12} height={12} />}
      </RowAction>
    </span>
  )
}

function RowAction({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-5 place-items-center rounded-xs text-fg-subtle transition-colors hover:bg-border-strong hover:text-fg"
    >
      {children}
    </button>
  )
}
