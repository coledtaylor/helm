import type { JSX, KeyboardEvent } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FileListing } from '@helm/core'
import { rankPaths, type PathMatch } from '@helm/core/types'
import { cn } from '../lib/cn'
import { CONTENT_KIND_ICON } from '../lib/contentIcons'
import { ROW_SELECTED } from '../lib/rows'
import { DocIcon, SearchIcon } from './icons'
import { Overlay } from './Overlay'

/**
 * Ctrl+P: a file in this project, by a few letters of its name.
 *
 * The list comes from main once per opening and is ranked here on every
 * keystroke (`rankPaths`), so typing never waits on a round trip. With nothing
 * typed it offers the files opened most recently, which is what somebody
 * reaching for Ctrl+P a second time usually wants.
 */

export interface QuickOpenDialogProps {
  /** The project's name, for the field's placeholder. */
  rootLabel: string
  /** Every file in the project, or null while it is being listed. */
  listing: FileListing | null
  /** Project-relative paths opened lately, most recent first. */
  recent: readonly string[]
  onOpen: (relPath: string) => void
  onDismiss: () => void
}

/** How many rows are drawn: past this, typing another letter is quicker than scrolling. */
const SHOWN = 60

const CAPS = 'text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase'

/**
 * A row is chosen with the pointer without taking focus from the field, so the
 * arrows and Enter go on working from wherever the pointer left the highlight.
 */
const keepFocus = (event: { preventDefault: () => void }): void => event.preventDefault()

export function QuickOpenDialog({ rootLabel, listing, recent, onOpen, onDismiss }: QuickOpenDialogProps): JSX.Element {
  const ids = useId()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const typed = query.trim() !== ''
  const rows = useMemo((): PathMatch[] => {
    if (typed) return rankPaths(query, listing?.files ?? [], SHOWN)
    const known = new Set(listing?.files ?? [])
    return recent.filter((path) => listing === null || known.has(path)).map((path) => ({ path, score: 0, hits: [] }))
  }, [typed, query, listing, recent])

  const at = Math.min(cursor, Math.max(0, rows.length - 1))
  const highlighted = rows[at]

  // The highlighted row stays in view as the arrows walk past the edge.
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${String(at)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [at])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length === 0) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setCursor((at + step + rows.length) % rows.length)
      return
    }
    if (event.key === 'Enter' && highlighted !== undefined) {
      event.preventDefault()
      onOpen(highlighted.path)
    }
  }

  return (
    <Overlay
      aria-label="Go to file"
      align="top"
      className="max-w-[620px] bg-surface-raised"
      onDismiss={onDismiss}
      onKeyDown={onKeyDown}
    >
      <header className="flex h-[50px] shrink-0 items-center gap-2.5 border-b border-border px-4">
        <SearchIcon width={15} height={15} className="shrink-0 text-accent" />
        <input
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setCursor(0)
          }}
          role="combobox"
          aria-label="File name"
          aria-expanded="true"
          aria-controls={`${ids}-list`}
          aria-activedescendant={highlighted === undefined ? undefined : `${ids}-${String(at)}`}
          aria-autocomplete="list"
          spellCheck={false}
          placeholder={`Go to a file in ${rootLabel}`}
          className="min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-subtle focus:outline-none"
        />
      </header>

      <div
        ref={listRef}
        id={`${ids}-list`}
        role="listbox"
        aria-label="Files"
        tabIndex={-1}
        className="max-h-[420px] min-h-0 overflow-y-auto px-1.5 pt-1.5 pb-1 outline-none"
      >
        {!typed && rows.length > 0 && <div className={cn(CAPS, 'px-2.5 pt-2 pb-[5px]')}>Recently opened</div>}
        {rows.map((row, index) => (
          <FileOption
            key={row.path}
            id={`${ids}-${String(index)}`}
            index={index}
            match={row}
            highlighted={index === at}
            onPick={() => setCursor(index)}
            onOpen={() => onOpen(row.path)}
          />
        ))}
        {listing === null ? (
          <p className="px-2.5 pt-1 pb-3 text-[12px] text-fg-subtle">Listing {rootLabel}&hellip;</p>
        ) : typed && rows.length === 0 ? (
          <p className="px-2.5 pt-1 pb-3 text-[12px] text-fg-muted">No file in {rootLabel} matches “{query.trim()}”.</p>
        ) : !typed && rows.length === 0 ? (
          <p className="px-2.5 pt-1 pb-3 text-[12px] text-fg-muted">
            Type part of a file’s name - letters in order, so <span className="font-mono">tbar</span> finds{' '}
            <span className="font-mono">TabBar.tsx</span>.
          </p>
        ) : null}
      </div>

      <footer className="flex h-[34px] shrink-0 items-center gap-3 border-t border-border bg-surface px-4 text-[11px] text-fg-subtle">
        <span>
          <span className="font-mono text-fg-muted">↵</span> Open
        </span>
        <span>
          <span className="font-mono text-fg-muted">↑↓</span> Choose
        </span>
        <span className="min-w-0 flex-1 truncate text-right">
          {listing === null
            ? ''
            : listing.truncated
              ? `The first ${listing.files.length.toLocaleString()} files - this folder is not a repository, so it was walked and the walk stopped`
              : `${listing.files.length.toLocaleString()} files${listing.source === 'git' ? ', as git lists them' : ''}`}
        </span>
        <span>
          <span className="font-mono text-fg-muted">Esc</span> Close
        </span>
      </footer>
    </Overlay>
  )
}

function FileOption({
  id,
  index,
  match,
  highlighted,
  onPick,
  onOpen
}: {
  id: string
  index: number
  match: PathMatch
  highlighted: boolean
  onPick: () => void
  onOpen: () => void
}): JSX.Element {
  const { path, hits } = match
  const cut = path.lastIndexOf('/') + 1
  const name = path.slice(cut)
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  const Icon = ext === 'md' || ext === 'markdown' ? CONTENT_KIND_ICON.markdown : DocIcon
  const hit = new Set(hits)
  return (
    <div
      id={id}
      data-index={index}
      role="option"
      aria-selected={highlighted}
      aria-label={path}
      title={path}
      onMouseDown={keepFocus}
      onMouseMove={highlighted ? undefined : onPick}
      onClick={onOpen}
      className={cn(
        'relative flex h-[34px] cursor-default items-center gap-2.5 rounded-raised px-2.5 transition-colors',
        highlighted ? ROW_SELECTED : 'hover:bg-hover'
      )}
    >
      {highlighted && <span aria-hidden className="absolute top-[8px] bottom-[8px] left-0 w-[2px] rounded-full bg-accent" />}
      <Icon width={14} height={14} className="shrink-0 text-fg-muted" />
      <span className="max-w-[55%] shrink-0 truncate text-[13px] text-fg">
        <Marked text={name} offset={cut} hits={hit} />
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-subtle">
        <Marked text={path.slice(0, Math.max(0, cut - 1))} offset={0} hits={hit} />
      </span>
    </div>
  )
}

/** A run of text with the characters the query matched in the accent's text tone. */
function Marked({ text, offset, hits }: { text: string; offset: number; hits: ReadonlySet<number> }): JSX.Element {
  const parts: JSX.Element[] = []
  let run = ''
  let lit = false
  const flush = (key: number): void => {
    if (run === '') return
    parts.push(
      lit ? (
        <span key={key} className="text-accent-text">
          {run}
        </span>
      ) : (
        <span key={key}>{run}</span>
      )
    )
    run = ''
  }
  for (let i = 0; i < text.length; i += 1) {
    const on = hits.has(offset + i)
    if (on !== lit) {
      flush(i)
      lit = on
    }
    run += text[i]
  }
  flush(text.length)
  return <>{parts}</>
}
