import type { JSX, KeyboardEvent, ReactNode } from 'react'
import { Fragment, useMemo, useState } from 'react'
import type {
  ContentFile,
  ContentRootKind,
  ContentScope,
  ContentSearchHit,
  ContentSearchResult,
  ContentTree
} from '@helm/core'
import { cn } from '../lib/cn'
import { formatAge, formatBytes } from '../lib/time'
import { PaneBack } from './PaneBack'
import {
  ArtifactIcon,
  BookIcon,
  CaretIcon,
  DocIcon,
  FolderIcon,
  RefreshIcon,
  SearchIcon,
  SlidersIcon,
  SparkIcon
} from './icons'

export interface ContentViewerProps {
  scopes: ContentScope[]
  scopePath: string
  onScopeChange: (path: string) => void

  tree: ContentTree | null
  treeLoading: boolean

  query: string
  onQueryChange: (query: string) => void
  search: ContentSearchResult | null
  searching: boolean

  selected: ContentFile | null
  onSelect: (file: ContentFile, line?: number) => void
  /** The open file has unsaved changes. Marked on its row. */
  dirty?: boolean | undefined

  onRefresh: () => void
  refreshing: boolean

  /**
   * Docked beside a session split, where the list and the document cannot both
   * be readable. The pane then shows one at a time: the list until a file is
   * picked, then the document with a way back.
   */
  compact?: boolean | undefined
  /** Clears the selection, which is what puts the list back. */
  onBack?: (() => void) | undefined

  /** The document, the artifact frame, or the editor. */
  children: ReactNode
}

const ROOT_ICON: Record<ContentRootKind, typeof DocIcon> = {
  notes: BookIcon,
  context: SlidersIcon,
  skills: SparkIcon,
  docs: DocIcon,
  root: FolderIcon,
  found: FolderIcon
}

/**
 * Everything readable in a project or harness, as one surface.
 *
 * Laid out like the config console and the session history on purpose - header
 * bar, bounded list, detail filling the rest - because they are the same kind
 * of surface, and a third layout for the same shape is a third thing to learn.
 *
 * The one deliberate difference is the box at the top of the list. In the
 * config console it filters a list of file names, because that is all a
 * `.claude` tree has to filter. Here it is a full-text search across every
 * markdown file in the scope, so the list it produces is *matches* - file,
 * count, and the lines that matched - rather than a shorter version of the same
 * list. Typing a word switches the column from "what is here" to "where is
 * this", which is the question a vault is usually asked.
 */
export function ContentViewer({
  scopes,
  scopePath,
  onScopeChange,
  tree,
  treeLoading,
  query,
  onQueryChange,
  search,
  searching,
  selected,
  onSelect,
  dirty = false,
  onRefresh,
  refreshing,
  compact = false,
  onBack,
  children
}: ContentViewerProps): JSX.Element {
  const scope = scopes.find((s) => s.path.toLowerCase() === scopePath.toLowerCase()) ?? null
  const searchingNow = query.trim() !== ''
  // One at a time, and only when narrow: at full width both fit and swapping
  // them would cost a click for nothing.
  const showList = !compact || selected === null
  const showDetail = !compact || selected !== null

  const groups = useMemo(() => {
    if (!tree) return []
    const byRoot = new Map<string, ContentFile[]>()
    for (const file of tree.files) {
      byRoot.set(file.root, [...(byRoot.get(file.root) ?? []), file])
    }
    return tree.roots
      .map((root) => ({ root, files: byRoot.get(root.relPath) ?? [] }))
      .filter((group) => group.files.length > 0)
  }, [tree])

  const filesByPath = useMemo(() => {
    const map = new Map<string, ContentFile>()
    for (const file of tree?.files ?? []) map.set(file.path, file)
    return map
  }, [tree])

  const total = tree?.files.length ?? 0

  // Only the roots someone has deliberately shut, so one discovered later starts
  // expanded. No "searching opens everything" rule is needed here the way there
  // is in the config console: a search replaces this list with its hits rather
  // than filtering it in place, so a collapsed root cannot hide a match.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const toggleSection = (key: string): void =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-content-file]')]
    const at = rows.findIndex((row) => row === document.activeElement)
    const next = rows[at < 0 ? 0 : at + step]
    if (!next) return
    event.preventDefault()
    next.focus()
    next.click()
  }

  return (
    // Islands with canvas gutters, like the config console (DESIGN.md).
    <div className="flex h-full min-h-0 flex-col gap-2">
      <header className="flex h-11 shrink-0 items-center gap-3 rounded-island border border-border bg-surface px-4">
        <BookIcon width={15} height={15} className="shrink-0 text-accent" />
        <h1 className="shrink-0 text-[13px] font-medium tracking-tight text-fg">Content</h1>

        <label className="flex min-w-0 items-center gap-2">
          <span className="sr-only">Scope</span>
          <select
            data-content-scope
            aria-label="Scope"
            value={scopePath}
            onChange={(event) => onScopeChange(event.target.value)}
            className={cn(
              'h-7 max-w-64 min-w-40 rounded-well border border-border bg-surface-sunken px-2',
              'text-[12px] text-fg focus:border-accent focus:outline-none'
            )}
          >
            {['harness', 'project'].map((kind) => {
              const inKind = scopes.filter((s) => s.kind === kind)
              if (inKind.length === 0) return null
              return (
                <optgroup key={kind} label={kind === 'harness' ? 'Harnesses' : 'Projects'}>
                  {inKind.map((s) => (
                    <option key={s.path} value={s.path}>
                      {s.label}
                    </option>
                  ))}
                </optgroup>
              )
            })}
          </select>
        </label>

        {scope && (
          <p className="hidden min-w-0 truncate font-mono text-[11px] text-fg-subtle lg:block">
            {scope.path}
          </p>
        )}

        <span className="flex-1" />

        {tree && tree.roots.length > 0 && (
          <p className="hidden shrink-0 items-baseline gap-1.5 text-[11px] text-fg-subtle xl:flex">
            <span className="tabular-nums">{total}</span>
            <span>files in</span>
            <span className="tabular-nums">{tree.roots.length}</span>
            <span>{tree.roots.length === 1 ? 'place' : 'places'}</span>
          </p>
        )}

        <button
          type="button"
          data-content-refresh
          onClick={onRefresh}
          disabled={refreshing}
          title="Re-read this scope from disk"
          aria-label="Re-read this scope from disk"
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded text-fg-subtle transition-colors',
            'hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-50'
          )}
        >
          <RefreshIcon className={cn(refreshing && 'animate-spin')} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 gap-2">
        {showList && (
        <div
          className={cn(
            'flex flex-col overflow-hidden rounded-island border border-border bg-surface',
            compact ? 'min-w-0 flex-1' : 'w-[32%] max-w-[440px] min-w-[290px] shrink-0'
          )}
        >
          <div className="shrink-0 p-2">
            <div className="relative">
              <SearchIcon
                width={13}
                height={13}
                className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-subtle"
              />
              <input
                data-content-search
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder="Search this scope"
                spellCheck={false}
                aria-label="Search the markdown in this scope"
                className={cn(
                  'h-7 w-full rounded-well border border-border bg-surface-sunken pr-2 pl-7',
                  'text-[12px] text-fg select-text placeholder:text-fg-subtle',
                  'focus:border-accent focus:outline-none'
                )}
              />
            </div>
            <p
              data-content-status
              className="mt-2 flex items-baseline gap-1.5 text-[11px] text-fg-subtle"
            >
              {searchingNow ? (
                search === null ? (
                  <span>Searching&hellip;</span>
                ) : (
                  <>
                    <span className="tabular-nums">
                      {search.hits.length} {search.hits.length === 1 ? 'file' : 'files'}
                    </span>
                    <span aria-hidden>·</span>
                    <span className="tabular-nums" data-search-matches={search.totalMatches}>
                      {search.totalMatches} {search.totalMatches === 1 ? 'match' : 'matches'}
                    </span>
                    <span className="flex-1" />
                    {/* The measurement, on screen. A search budget nobody can
                        see is a search budget nobody notices missing. */}
                    <span
                      className="tabular-nums"
                      data-search-took={search.tookMs.toFixed(2)}
                      title={`${String(search.filesSearched)} files, ${formatBytes(search.bytesSearched)}${search.cold ? ', first search in this scope read them from disk' : ''}`}
                    >
                      {search.tookMs < 1 ? '<1' : Math.round(search.tookMs)} ms
                    </span>
                  </>
                )
              ) : (
                <>
                  <span className="tabular-nums">
                    {tree === null ? 'Reading…' : `${total} ${total === 1 ? 'file' : 'files'}`}
                  </span>
                  <span className="flex-1" />
                  {tree !== null && tree.errors.length > 0 && (
                    <span className="text-danger" title={tree.errors.join('\n')}>
                      {tree.errors.length} unreadable
                    </span>
                  )}
                </>
              )}
            </p>
          </div>

          <div
            role="group"
            aria-label="Content files"
            onKeyDown={onListKeyDown}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
          >
            {tree === null || treeLoading ? (
              <p className="px-2 py-6 text-center text-[12px] text-fg-subtle">Reading&hellip;</p>
            ) : searchingNow ? (
              <SearchResults
                result={search}
                searching={searching}
                filesByPath={filesByPath}
                selected={selected}
                onSelect={onSelect}
              />
            ) : groups.length === 0 ? (
              <Empty scope={scope} />
            ) : (
              groups.map(({ root, files }) => {
                const Icon = ROOT_ICON[root.kind]
                const expanded = !collapsed.has(root.relPath)
                return (
                  <Fragment key={root.relPath}>
                    <button
                      type="button"
                      onClick={() => toggleSection(root.relPath)}
                      aria-expanded={expanded}
                      data-content-section={root.relPath}
                      className={cn(
                        'sticky top-0 z-10 mt-3 flex w-full items-center gap-2 bg-surface px-2 py-1',
                        'text-left text-[11px] font-medium tracking-wide text-fg-subtle uppercase',
                        'transition-colors first:mt-0 hover:text-fg'
                      )}
                    >
                      <CaretIcon
                        width={8}
                        height={8}
                        className={cn('shrink-0 transition-transform', expanded && 'rotate-90')}
                      />
                      <Icon width={11} height={11} className="shrink-0" />
                      <span className="min-w-0 truncate">{root.label}</span>
                      <span className="tabular-nums">{files.length}</span>
                    </button>
                    {expanded &&
                      files.map((file) => (
                        <Row
                          key={file.path}
                          file={file}
                          selected={selected?.path === file.path}
                          dirty={dirty && selected?.path === file.path}
                          onSelect={onSelect}
                        />
                      ))}
                  </Fragment>
                )
              })
            )}
          </div>
        </div>
        )}

        {showDetail && (
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-island border border-border bg-surface">
            {compact && selected !== null && onBack && (
              <PaneBack label="All files" onBack={onBack} />
            )}
            <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
          </div>
        )}
      </div>
    </div>
  )
}

function Row({
  file,
  selected,
  dirty,
  onSelect
}: {
  file: ContentFile
  selected: boolean
  dirty: boolean
  onSelect: (file: ContentFile) => void
}): JSX.Element {
  const Icon = file.kind === 'html' ? ArtifactIcon : file.kind === 'markdown' ? DocIcon : SlidersIcon
  return (
    <button
      type="button"
      data-content-file={file.relPath}
      data-content-kind={file.kind}
      // Not `data-content-dirty`: that belongs to the editor's own status, and
      // two elements answering to one selector is how a driver ends up reading
      // the first list row's state and calling it the editor's.
      data-content-row-dirty={dirty}
      aria-current={selected}
      onClick={() => onSelect(file)}
      title={file.path}
      className={cn(
        'relative flex w-full items-start gap-2 rounded-well px-2 py-1.5 text-left transition-colors',
        selected ? 'bg-accent-soft' : 'hover:bg-hover'
      )}
    >
      {selected && (
        <span
          aria-hidden
          className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-accent"
        />
      )}
      <Icon
        width={13}
        height={13}
        className={cn('mt-0.5 shrink-0', selected ? 'text-accent' : 'text-fg-subtle')}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{file.title}</span>
          {dirty ? (
            <span className="flex shrink-0 items-center gap-1 text-[10px] text-warn">
              <span aria-hidden className="size-1.5 rounded-full bg-warn" />
              unsaved
            </span>
          ) : (
            <span className="shrink-0 text-[10px] tabular-nums text-fg-subtle">
              {file.date ?? formatAge(file.mtimeMs)}
            </span>
          )}
        </span>
        {/* The frontmatter, in the width a row has. `type` is what separates a
            journal from a reference at a glance, and the tags are how this
            vault is actually navigated - so they are on the row rather than
            waiting behind an open.
            With neither, the file name: `Helm - session launcher` does not
            say it lives in `journal-2026-08-09-session-launcher.md`.
            Unless the name *is* the title, as it is for `.mcp.json`, where
            repeating it reads as a rendering bug. */}
        {(file.noteType !== null || file.tags.length > 0 || file.slug !== file.title) && (
          <span className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-[10px] text-fg-subtle">
            {file.noteType !== null && (
              <span className="shrink-0 rounded-sm bg-surface-sunken px-1 text-fg-muted">
                {file.noteType}
              </span>
            )}
            <span className="min-w-0 truncate">
              {file.tags.length > 0
                ? file.tags.map((tag) => `#${tag}`).join(' ')
                : file.slug === file.title
                  ? ''
                  : file.slug}
            </span>
          </span>
        )}
      </span>
    </button>
  )
}

/**
 * What matched, and where.
 *
 * A hit shows its lines rather than only its name, because the point of
 * searching a vault is usually to read the sentence rather than to open the
 * file - and when it is to open the file, the sentence is what tells you which
 * one. Clicking a line opens the file at it.
 */
function SearchResults({
  result,
  searching,
  filesByPath,
  selected,
  onSelect
}: {
  result: ContentSearchResult | null
  searching: boolean
  filesByPath: Map<string, ContentFile>
  selected: ContentFile | null
  onSelect: (file: ContentFile, line?: number) => void
}): JSX.Element {
  if (result === null) {
    return <p className="px-2 py-6 text-center text-[12px] text-fg-subtle">Searching&hellip;</p>
  }
  if (result.hits.length === 0) {
    return (
      <p className="px-2 py-6 text-center text-[12px] text-fg-subtle">
        {searching ? 'Searching…' : `Nothing in this scope says “${result.query.trim()}”.`}
      </p>
    )
  }
  return (
    <>
      {result.hits.map((hit) => {
        const file = filesByPath.get(hit.path)
        if (!file) return null
        return (
          <Hit
            key={hit.path}
            hit={hit}
            file={file}
            selected={selected?.path === hit.path}
            onSelect={onSelect}
          />
        )
      })}
      {result.truncated && (
        <p className="px-2 py-3 text-center text-[11px] text-fg-subtle">
          More files matched than are listed. Narrow the search.
        </p>
      )}
    </>
  )
}

function Hit({
  hit,
  file,
  selected,
  onSelect
}: {
  hit: ContentSearchHit
  file: ContentFile
  selected: boolean
  onSelect: (file: ContentFile, line?: number) => void
}): JSX.Element {
  return (
    <div className={cn('mt-1 rounded-well first:mt-0', selected && 'bg-accent-soft')}>
      <button
        type="button"
        data-content-file={file.relPath}
        data-content-kind={file.kind}
        data-content-hit={hit.matches}
        onClick={() => onSelect(file)}
        title={file.path}
        className={cn(
          'flex w-full items-baseline gap-2 rounded-well px-2 py-1.5 text-left transition-colors',
          !selected && 'hover:bg-hover'
        )}
      >
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{file.title}</span>
        {hit.nameMatch && hit.matches === 0 ? (
          <span className="shrink-0 text-[10px] text-fg-subtle">name</span>
        ) : (
          <span className="shrink-0 text-[10px] tabular-nums text-fg-subtle">
            {hit.matches}
          </span>
        )}
      </button>
      {hit.lines.map((line) => (
        <button
          key={line.line}
          type="button"
          data-content-hit-line={line.line}
          onClick={() => onSelect(file, line.line)}
          className={cn(
            'block w-full rounded px-2 py-0.5 pl-4 text-left font-mono text-[10.5px] leading-snug',
            'text-fg-subtle transition-colors hover:bg-hover hover:text-fg-muted'
          )}
        >
          <span className="mr-2 tabular-nums opacity-60">{line.line}</span>
          {line.text.slice(0, line.from)}
          <mark className="rounded-sm bg-warn/25 text-fg">
            {line.text.slice(line.from, line.to)}
          </mark>
          {line.text.slice(line.to)}
        </button>
      ))}
    </div>
  )
}

function Empty({ scope }: { scope: ContentScope | null }): JSX.Element {
  return (
    <div className="px-3 py-8 text-center">
      <FolderIcon width={20} height={20} className="mx-auto text-fg-subtle" />
      <p className="mt-2 text-[12px] text-fg-muted">
        {scope === null
          ? 'Pick a scope.'
          : `${scope.label} has no notes, docs, context or skills to read.`}
      </p>
    </div>
  )
}

/** Shown in the detail column when nothing is open. */
export function ContentNothingSelected({
  scope,
  fileCount
}: {
  scope: ContentScope | null
  fileCount: number
}): JSX.Element {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-md text-center">
        <BookIcon width={22} height={22} className="mx-auto text-fg-subtle" />
        <p className="mt-3 text-[13px] text-fg-muted">
          {scope === null
            ? 'Pick a scope to read what is in it.'
            : `${fileCount} ${fileCount === 1 ? 'file' : 'files'} in ${scope.label}.`}
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-fg-subtle">
          Markdown renders with its frontmatter as a header and its{' '}
          <strong className="font-medium text-fg-muted">[[wikilinks]]</strong> live. HTML opens in a
          sandboxed frame with no network behind it.
        </p>
      </div>
    </div>
  )
}
