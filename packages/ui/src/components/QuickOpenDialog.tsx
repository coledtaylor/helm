import type { JSX, KeyboardEvent } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ContentSearchResult, FileListing } from '@helm/core'
import { rankPaths, type PathMatch } from '@helm/core/types'
import { cn } from '../lib/cn'
import { CONTENT_KIND_ICON } from '../lib/contentIcons'
import { ROW_SELECTED } from '../lib/rows'
import { SEGMENT_ON } from '../lib/segmented'
import { DocIcon, SearchIcon } from './icons'
import { Overlay } from './Overlay'

/**
 * Ctrl+P: a file in this project, by a few letters of its name - or, in its
 * Text mode (Ctrl+Shift+F), by a few words of what is in it.
 *
 * Names: the list comes from main once per opening and is ranked here on every
 * keystroke (`rankPaths`), so typing never waits on a round trip. With nothing
 * typed it offers the files opened most recently, which is what somebody
 * reaching for Ctrl+P a second time usually wants.
 *
 * Text: the search the content viewer had, moved here when that view merged
 * into Files. Main holds the corpus in memory per project, so a search after
 * the first is milliseconds; a row is a matching line, and opening it puts the
 * file on that line with the words marked.
 */

export type QuickOpenMode = 'files' | 'text'

/** Where a text match is, so the file can open on it. */
export interface QuickOpenAt {
  line: number
  term: string
}

export interface QuickOpenDialogProps {
  /** The project's name, for the field's placeholder. */
  rootLabel: string
  /** Every file in the project, or null while it is being listed. */
  listing: FileListing | null
  /** Project-relative paths opened lately, most recent first. */
  recent: readonly string[]
  /** Which half it opens on. */
  initialMode?: QuickOpenMode | undefined
  /** Searches the project's text. Resolves null when the search itself failed. */
  onSearchText: (query: string) => Promise<ContentSearchResult | null>
  /** A file, from either half; `at` when it was a matching line. */
  onOpen: (relPath: string, at?: QuickOpenAt) => void
  onDismiss: () => void
}

/** How many rows are drawn: past this, typing another letter is quicker than scrolling. */
const SHOWN = 60
/** Long enough that a word typed at speed is one search, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 120

const CAPS = 'text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase'

/**
 * A row is chosen with the pointer without taking focus from the field, so the
 * arrows and Enter go on working from wherever the pointer left the highlight.
 */
const keepFocus = (event: { preventDefault: () => void }): void => event.preventDefault()

/** One row the arrows can land on, in either half. */
type Row =
  | { kind: 'file'; key: string; match: PathMatch }
  | {
      kind: 'line'
      key: string
      relPath: string
      line: number
      text: string
      from: number
      to: number
      term: string
      /** The first of its file's lines, so the file's name goes above it. */
      first: boolean
    }

export function QuickOpenDialog({
  rootLabel,
  listing,
  recent,
  initialMode = 'files',
  onSearchText,
  onOpen,
  onDismiss
}: QuickOpenDialogProps): JSX.Element {
  const ids = useId()
  const [mode, setMode] = useState<QuickOpenMode>(initialMode)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const typed = query.trim() !== ''

  // ---- Text: a debounced search, and the answer for the query it was asked.
  const [asked, setAsked] = useState('')
  const [answer, setAnswer] = useState<{ query: string; result: ContentSearchResult | null } | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setAsked(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])
  useEffect(() => {
    if (mode !== 'text' || asked === '') return
    let current = true
    void onSearchText(asked).then((result) => {
      if (current) setAnswer({ query: asked, result })
    })
    return () => {
      current = false
    }
  }, [mode, asked, onSearchText])
  // The last answer stays on screen while the next is asked, so a word typed
  // one letter at a time narrows a list rather than blinking it out each time.
  const current = answer !== null && answer.query === query.trim()
  const search = typed ? (answer?.result ?? null) : null
  const failed = current && answer.result === null
  const searching = mode === 'text' && typed && !current

  const rows = useMemo((): Row[] => {
    if (mode === 'files') {
      if (typed) return rankPaths(query, listing?.files ?? [], SHOWN).map((match) => ({ kind: 'file', key: match.path, match }))
      const known = new Set(listing?.files ?? [])
      return recent
        .filter((path) => listing === null || known.has(path))
        .map((path) => ({ kind: 'file', key: path, match: { path, score: 0, hits: [] } }))
    }
    if (!typed || search === null) return []
    const out: Row[] = []
    const term = search.query.trim()
    for (const hit of search.hits) {
      if (hit.lines.length === 0) {
        out.push({ kind: 'line', key: hit.path, relPath: hit.relPath, line: 1, text: hit.title, from: 0, to: 0, term: '', first: true })
        continue
      }
      for (const [index, line] of hit.lines.entries()) {
        out.push({
          kind: 'line',
          key: `${hit.path}:${String(line.line)}`,
          relPath: hit.relPath,
          line: line.line,
          text: line.text,
          from: line.from,
          to: line.to,
          term,
          first: index === 0
        })
      }
    }
    return out
  }, [mode, typed, query, listing, recent, search])

  const at = Math.min(cursor, Math.max(0, rows.length - 1))
  const highlighted = rows[at]

  // The highlighted row stays in view as the arrows walk past the edge.
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${String(at)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [at])

  const open = (row: Row | undefined): void => {
    if (row === undefined) return
    if (row.kind === 'file') onOpen(row.match.path)
    else onOpen(row.relPath, row.term === '' ? undefined : { line: row.line, term: row.term })
  }

  const switchTo = (next: QuickOpenMode): void => {
    setMode(next)
    setCursor(0)
    inputRef.current?.focus()
  }

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
      open(highlighted)
      return
    }
    // The shortcut for the other half switches to it, from inside the dialog
    // as from outside it.
    if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'f' && event.shiftKey) {
      event.preventDefault()
      switchTo('text')
      return
    }
    if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'p') {
      event.preventDefault()
      switchTo('files')
    }
  }

  return (
    <Overlay
      aria-label={mode === 'files' ? 'Go to file' : 'Search the text'}
      align="top"
      className="max-w-[640px] bg-surface-raised"
      onDismiss={onDismiss}
      onKeyDown={onKeyDown}
    >
      <header className="flex h-[50px] shrink-0 items-center gap-2.5 border-b border-border pr-2.5 pl-4">
        <SearchIcon width={15} height={15} className="shrink-0 text-accent" />
        <input
          ref={inputRef}
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setCursor(0)
          }}
          role="combobox"
          aria-label={mode === 'files' ? 'File name' : 'Text to find'}
          aria-expanded="true"
          aria-controls={`${ids}-list`}
          aria-activedescendant={highlighted === undefined ? undefined : `${ids}-${String(at)}`}
          aria-autocomplete="list"
          spellCheck={false}
          placeholder={mode === 'files' ? `Go to a file in ${rootLabel}` : `Search the text of ${rootLabel}`}
          className="min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-subtle focus:outline-none"
        />
        <div
          role="radiogroup"
          aria-label="Search by"
          className="flex shrink-0 items-center gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
        >
          {(
            [
              ['files', 'Names', 'Ctrl+P'],
              ['text', 'Text', 'Ctrl+Shift+F']
            ] as const
          ).map(([id, label, keys]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              title={`${label} (${keys})`}
              onMouseDown={keepFocus}
              onClick={() => switchTo(id)}
              className={cn(
                'rounded-raised px-2 py-0.5 text-[11.5px] transition-colors',
                mode === id ? SEGMENT_ON : 'text-fg-subtle hover:text-fg'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      <div
        ref={listRef}
        id={`${ids}-list`}
        role="listbox"
        aria-label={mode === 'files' ? 'Files' : 'Matches'}
        tabIndex={-1}
        className="max-h-[420px] min-h-0 overflow-y-auto px-1.5 pt-1.5 pb-1 outline-none"
      >
        {mode === 'files' && !typed && rows.length > 0 && (
          <div className={cn(CAPS, 'px-2.5 pt-2 pb-[5px]')}>Recently opened</div>
        )}
        {rows.map((row, index) => {
          if (row.kind === 'file') {
            return (
              <FileOption
                key={row.key}
                id={`${ids}-${String(index)}`}
                index={index}
                match={row.match}
                highlighted={index === at}
                onPick={() => setCursor(index)}
                onOpen={() => open(row)}
              />
            )
          }
          // Grouped under their file: the file's name once, then its lines.
          return (
            <div key={row.key}>
              {row.first && <FileHeading relPath={row.relPath} />}
              <LineOption
                id={`${ids}-${String(index)}`}
                index={index}
                row={row}
                highlighted={index === at}
                onPick={() => setCursor(index)}
                onOpen={() => open(row)}
              />
            </div>
          )
        })}
        {mode === 'files' ? (
          listing === null ? (
            <p className="px-2.5 pt-1 pb-3 text-[12px] text-fg-subtle">Listing {rootLabel}&hellip;</p>
          ) : typed && rows.length === 0 ? (
            <p className="px-2.5 pt-1 pb-3 text-[12px] text-fg-muted">No file in {rootLabel} matches “{query.trim()}”.</p>
          ) : !typed && rows.length === 0 ? (
            <p className="px-2.5 pt-1 pb-3 text-[12px] text-fg-muted">
              Type part of a file’s name - letters in order, so <span className="font-mono">tbar</span> finds{' '}
              <span className="font-mono">TabBar.tsx</span>.
            </p>
          ) : null
        ) : !typed ? (
          <p className="px-2.5 pt-1 pb-3 text-[12px] text-fg-muted">
            Type a word or part of one. Notes, data and code are searched for it; every file by its name.
          </p>
        ) : failed ? (
          <p role="alert" className="px-2.5 pt-1 pb-3 text-[12px] text-danger">
            The search could not run in {rootLabel}.
          </p>
        ) : searching && rows.length === 0 ? (
          <p className="px-2.5 pt-1 pb-3 text-[12px] text-fg-subtle">Searching {rootLabel}&hellip;</p>
        ) : rows.length === 0 ? (
          <p className="px-2.5 pt-1 pb-3 text-[12px] text-fg-muted">Nothing in {rootLabel} says “{query.trim()}”.</p>
        ) : null}
      </div>

      <footer className="flex h-[34px] shrink-0 items-center gap-3 border-t border-border bg-surface px-4 text-[11px] text-fg-subtle">
        <span>
          <span className="font-mono text-fg-muted">↵</span> Open
        </span>
        <span>
          <span className="font-mono text-fg-muted">↑↓</span> Choose
        </span>
        <span className="min-w-0 flex-1 truncate text-right" data-quick-open-status>
          {mode === 'files'
            ? listing === null
              ? ''
              : listing.truncated
                ? `The first ${listing.files.length.toLocaleString()} files - this folder is not a repository, so it was walked and the walk stopped`
                : `${listing.files.length.toLocaleString()} files${listing.source === 'git' ? ', as git lists them' : ''}`
            : search === null
              ? ''
              : `${search.totalMatches.toLocaleString()} ${search.totalMatches === 1 ? 'match' : 'matches'} in ${search.hits.length.toLocaleString()} ${search.hits.length === 1 ? 'file' : 'files'} · ${search.filesSearched.toLocaleString()} searched${search.truncated ? ', more than are listed' : ''}`}
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
      <FileIcon name={name} size={14} />
      <span className="max-w-[55%] shrink-0 truncate text-[13px] text-fg">
        <Marked text={name} offset={cut} hits={hit} />
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-subtle">
        <Marked text={path.slice(0, Math.max(0, cut - 1))} offset={0} hits={hit} />
      </span>
    </div>
  )
}

/** The file a run of matching lines belongs to. Not a row the arrows stop on. */
function FileHeading({ relPath }: { relPath: string }): JSX.Element {
  const cut = relPath.lastIndexOf('/') + 1
  const name = relPath.slice(cut)
  return (
    <div role="presentation" className="flex h-[28px] items-center gap-2 px-2.5 pt-1" title={relPath}>
      <FileIcon name={name} size={13} />
      <span className="shrink-0 text-[12.5px] text-fg">{name}</span>
      <span className="min-w-0 truncate font-mono text-[11px] text-fg-subtle">{relPath.slice(0, Math.max(0, cut - 1))}</span>
    </div>
  )
}

function LineOption({
  id,
  index,
  row,
  highlighted,
  onPick,
  onOpen
}: {
  id: string
  index: number
  row: Extract<Row, { kind: 'line' }>
  highlighted: boolean
  onPick: () => void
  onOpen: () => void
}): JSX.Element {
  return (
    <div
      id={id}
      data-index={index}
      role="option"
      aria-selected={highlighted}
      aria-label={row.term === '' ? `${row.relPath}: name matches` : `${row.relPath} line ${String(row.line)}: ${row.text}`}
      onMouseDown={keepFocus}
      onMouseMove={highlighted ? undefined : onPick}
      onClick={onOpen}
      className={cn(
        'relative flex h-[28px] cursor-default items-center gap-2.5 rounded-raised pr-2.5 pl-[30px] transition-colors',
        highlighted ? ROW_SELECTED : 'hover:bg-hover'
      )}
    >
      {highlighted && <span aria-hidden className="absolute top-[6px] bottom-[6px] left-0 w-[2px] rounded-full bg-accent" />}
      <span className="w-8 shrink-0 text-right font-mono text-[11px] text-fg-subtle tabular-nums">
        {row.term === '' ? '' : row.line}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-fg-muted">
        {row.term === '' ? (
          // Found by its name, not its text: there is no line to show.
          <span className="text-fg-subtle">Its name matches</span>
        ) : row.to > row.from ? (
          <>
            {row.text.slice(0, row.from)}
            <span className="font-medium text-accent-text">{row.text.slice(row.from, row.to)}</span>
            {row.text.slice(row.to)}
          </>
        ) : (
          row.text
        )}
      </span>
    </div>
  )
}

/** A note's glyph for a note, the plain document's for anything else. */
function FileIcon({ name, size }: { name: string; size: number }): JSX.Element {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  const Markdown = CONTENT_KIND_ICON.markdown
  return ext === 'md' || ext === 'markdown' ? (
    <Markdown width={size} height={size} className="shrink-0 text-fg-muted" />
  ) : (
    <DocIcon width={size} height={size} className="shrink-0 text-fg-muted" />
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
