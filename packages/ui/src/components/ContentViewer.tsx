import type { JSX, KeyboardEvent, ReactNode } from 'react'
import { Fragment, useMemo, useState } from 'react'
import type {
  ContentDirListing,
  ContentFile,
  ContentRootKind,
  ContentScope,
  ContentSearchHit,
  ContentSearchResult,
  ContentTree,
  ContentViewMode
} from '@helm/core'
import { cn } from '../lib/cn'
import { CONTENT_KIND_ICON } from '../lib/contentIcons'
import { ROW_SELECTED } from '../lib/rows'
import { SEGMENT_ON } from '../lib/segmented'
import { formatAge, formatBytes } from '../lib/time'
import { ContentTreeList } from './ContentTreeList'
import { PaneBack } from './PaneBack'
import { PaneHeader } from './PaneHeader'
import {
  BookIcon,
  CaretIcon,
  DocIcon,
  FolderIcon,
  RefreshIcon,
  SearchIcon,
  SlidersIcon,
  SparkIcon
} from './icons'

/**
 * What each mode promises, in the header, in the words the rule is written in.
 *
 * The caption is the whole reason the control is not just two buttons. A mode
 * that is *chosen* rather than implied needs to say what it does, and the two
 * rules are short enough to fit: without it the reader is back to inferring a
 * heuristic from what happens to be on the list, which is the complaint this
 * surface was rebuilt to answer.
 */
const VIEW_RULE: Record<ContentViewMode, string> = {
  curated: 'curated roots',
  tree: 'every file, lazy per directory, gitignore-aware'
}

export interface ContentViewerProps {
  scopes: ContentScope[]
  scopePath: string
  onScopeChange: (path: string) => void

  tree: ContentTree | null
  treeLoading: boolean

  view: ContentViewMode
  onViewChange: (view: ContentViewMode) => void
  /** True while the mode is still the one the scope's kind chose. */
  viewIsDefault: boolean
  dirs: ReadonlyMap<string, ContentDirListing>
  expanded: ReadonlySet<string>
  onToggleDir: (relPath: string) => void
  loadingDirs: ReadonlySet<string>

  query: string
  onQueryChange: (query: string) => void
  search: ContentSearchResult | null
  searching: boolean

  selected: ContentFile | null
  /** What the list marks as current - known before the document has loaded. */
  selectedPath: string | null
  onSelect: (file: ContentFile, line?: number) => void
  /** Opens by absolute path, which is how a tree row opens a file. */
  onOpenPath: (path: string) => void
  /** Shows a file in Explorer - the only thing to do with a binary. */
  onReveal: (path: string) => void
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
  view,
  onViewChange,
  viewIsDefault,
  dirs,
  expanded,
  onToggleDir,
  loadingDirs,
  query,
  onQueryChange,
  search,
  searching,
  selected,
  selectedPath,
  onSelect,
  onOpenPath,
  onReveal,
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

  // Every root, including the ones that turned out to be empty. An empty
  // `docs/` is present-and-empty and says so on its own row; filtering it out
  // here would undo the decision `readContentTree` makes to keep it.
  const groups = useMemo(() => {
    if (!tree) return []
    const byRoot = new Map<string, ContentFile[]>()
    for (const file of tree.files) {
      byRoot.set(file.root, [...(byRoot.get(file.root) ?? []), file])
    }
    return tree.roots.map((root) => ({ root, files: byRoot.get(root.relPath) ?? [] }))
  }, [tree])

  const rootListing = dirs.get('')
  const emptyNamed = useMemo(
    () => (tree?.roots ?? []).filter((root) => root.files === 0).map((root) => root.relPath),
    [tree]
  )

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
      <PaneHeader
        name="content"
        icon={<BookIcon width={15} height={15} />}
        title="Content"
        scope={
          <label className="flex min-w-0 flex-1 items-center gap-2">
            <span className="sr-only">Scope</span>
            <select
              data-content-scope
              aria-label="Scope"
              value={scopePath}
              onChange={(event) => onScopeChange(event.target.value)}
              className={cn(
                // Stretches only in the last band, and capped even there: a
                // 400px select holding the word "dev" is not what the room
                // freed by dropping the title is for.
                'h-7 w-full max-w-64 min-w-0 rounded-well border border-border bg-surface-sunken px-2',
                '@[384px]:w-auto @[384px]:min-w-40',
                'text-[12px] text-fg transition-colors',
                'hover:border-border-strong focus:border-accent focus:outline-none'
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
        }
        {...(scope
          ? {
              caption: (
                <div className="min-w-0">
                  {/* Titled, because what a truncated path drops is its tail,
                      and the tail is the half that identifies a scope. */}
                  <p className="truncate font-mono text-[11px] text-fg-subtle" title={scope.path}>
                    {scope.path}
                  </p>
                  {/* The rule the mode is following, named. `viewIsDefault`
                      says whose choice it was, so "harness default" is a fact
                      about this scope rather than a label that keeps claiming
                      the default after somebody has switched. */}
                  <p data-content-view-rule={view} className="truncate text-[10.5px] text-fg-subtle">
                    {viewIsDefault ? `${scope.kind} default - ` : ''}
                    {VIEW_RULE[view]}
                  </p>
                </div>
              )
            }
          : {})}
        {...(view === 'curated'
          ? tree && tree.roots.length > 0
            ? {
                meta: (
                  <p
                    data-content-count="curated"
                    className="flex items-baseline gap-1.5 text-[11px] text-fg-subtle"
                  >
                    <span className="tabular-nums">{total}</span>
                    <span>{total === 1 ? 'file in' : 'files in'}</span>
                    <span className="tabular-nums">{tree.roots.length}</span>
                    <span>{tree.roots.length === 1 ? 'root' : 'roots'}</span>
                    {emptyNamed.length > 0 && (
                      <>
                        <span aria-hidden>·</span>
                        <span
                          className="truncate"
                          title={`Named roots that exist and hold nothing: ${emptyNamed.join(', ')}`}
                        >
                          {emptyNamed.length === 1 ? `${emptyNamed[0]}/ empty` : `${emptyNamed.length} empty`}
                        </span>
                      </>
                    )}
                  </p>
                )
              }
            : {}
          : rootListing
            ? {
                meta: (
                  <p
                    data-content-count="tree"
                    className="flex items-baseline gap-1.5 text-[11px] text-fg-subtle"
                  >
                    <span className="tabular-nums">{rootListing.entries.length}</span>
                    <span>
                      {rootListing.entries.length === 1 ? 'top-level entry' : 'top-level entries'}
                    </span>
                    <span aria-hidden>·</span>
                    <span
                      className="tabular-nums"
                      title={
                        rootListing.ignoreSource === 'gitignore'
                          ? 'Ignored by this repository’s own rules, as git reports them'
                          : 'No repository here, so Helm’s built-in list decided'
                      }
                    >
                      {rootListing.ignored} ignored
                    </span>
                  </p>
                )
              }
            : {})}
        controls={
          <div
            role="group"
            aria-label="View"
            // A segmented control (DESIGN.md 4): sunken well, chosen segment
            // lifted to the raised surface with a hairline ring. The same
            // recipe the config console's view switcher uses, because it is the
            // same gesture.
            className="flex min-w-0 gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
          >
            {(['curated', 'tree'] as const).map((option) => (
              <button
                key={option}
                type="button"
                data-content-view={option}
                aria-pressed={view === option}
                onClick={() => onViewChange(option)}
                title={VIEW_RULE[option]}
                className={cn(
                  'min-w-0 truncate rounded-[5px] px-1.5 py-0.5 text-[11px] transition-colors',
                  '@[560px]:px-2.5',
                  view === option ? SEGMENT_ON : 'text-fg-muted hover:text-fg'
                )}
              >
                {option === 'curated' ? 'Curated' : 'Tree'}
              </button>
            ))}
          </div>
        }
        action={
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
        }
      />

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
                // Says which corpus before the search rather than after it.
                // The box is the same in both modes and searches the same set
                // in both - see the note on the status row below.
                placeholder={view === 'tree' ? 'Search the curated roots' : 'Search this scope'}
                spellCheck={false}
                aria-label="Search the text of this scope’s content"
                className={cn(
                  'h-7 w-full rounded-well border border-border bg-surface-sunken pr-2 pl-7',
                  'text-[12px] text-fg select-text placeholder:text-fg-subtle',
                  'focus:border-accent focus:outline-none'
                )}
              />
            </div>
            <div data-content-status className="mt-2 text-[11px] text-fg-subtle">
              <p className="flex items-baseline gap-1.5">
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
                ) : view === 'tree' ? (
                  <>
                    <span>
                      {rootListing === undefined
                        ? 'Reading…'
                        : `${rootListing.entries.length} ${rootListing.entries.length === 1 ? 'entry' : 'entries'} here`}
                    </span>
                    <span className="flex-1" />
                    {rootListing?.error != null && (
                      <span className="text-danger" title={rootListing.error}>
                        unreadable
                      </span>
                    )}
                  </>
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

              {/* What the search actually read.
                  The scope of the search is one set in both modes - the curated
                  roots - and this line is where that is said rather than left
                  to be discovered. Full-text search is the *vault's* feature:
                  the corpus is a harness's own directories, and extending it to
                  every file a tree can reach would make it a code search engine
                  over `node_modules`, which is a different product. Which kinds
                  had their bytes read is main's decision (`SEARCHED_BODY_KINDS`
                  in `core/content/search.ts`) and arrives with the result, so
                  this cannot drift from it. */}
              {searchingNow && search !== null && (
                <p
                  data-search-scope={search.bodyKinds.join(',')}
                  className="mt-1 truncate text-[10.5px] text-fg-subtle"
                  title={`Text read for: ${search.bodyKinds.join(', ')}. Every file is matched on its name, whatever its kind. Binary is never read.`}
                >
                  {view === 'tree' ? 'curated roots · ' : ''}
                  text in <span className="tabular-nums">{search.filesWithText}</span>, names in{' '}
                  <span className="tabular-nums">{search.filesSearched}</span>
                </p>
              )}
            </div>
          </div>

          <div
            role="group"
            aria-label="Content files"
            onKeyDown={onListKeyDown}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
          >
            {searchingNow ? (
              <SearchResults
                result={search}
                searching={searching}
                filesByPath={filesByPath}
                selected={selected}
                onSelect={onSelect}
              />
            ) : view === 'tree' ? (
              <ContentTreeList
                scopeLabel={scope?.label ?? ''}
                dirs={dirs}
                expandedDirs={expanded}
                loadingDirs={loadingDirs}
                selectedPath={selectedPath}
                onToggleDir={onToggleDir}
                onOpenPath={onOpenPath}
                onReveal={onReveal}
              />
            ) : tree === null || treeLoading ? (
              <p className="px-2 py-6 text-center text-[12px] text-fg-subtle">Reading&hellip;</p>
            ) : groups.length === 0 ? (
              <Empty scope={scope} />
            ) : (
              groups.map(({ root, files }) => {
                const Icon = ROOT_ICON[root.kind]
                const open = !collapsed.has(root.relPath)
                return (
                  <Fragment key={root.relPath}>
                    <button
                      type="button"
                      onClick={() => toggleSection(root.relPath)}
                      aria-expanded={open}
                      data-content-section={root.relPath}
                      data-content-root-offer={root.offer}
                      className={cn(
                        'sticky top-0 z-10 mt-3 flex w-full items-center gap-1.5 bg-surface px-2 py-1',
                        'text-left text-[11px] font-medium tracking-wide text-fg-subtle uppercase',
                        'transition-colors first:mt-0 hover:text-fg'
                      )}
                    >
                      <CaretIcon
                        width={8}
                        height={8}
                        className={cn('shrink-0 transition-transform', open && 'rotate-90')}
                      />
                      <Icon width={11} height={11} className="shrink-0" />
                      <span className="min-w-0 truncate">{root.label}</span>
                      {/* Why this directory is on the list, on the row. The
                          curation model is the thing the old pane asked the
                          reader to infer, and one word per root is what makes
                          it visible instead. */}
                      <span
                        className={cn(
                          'shrink-0 rounded-full border px-1.5 text-[9px] leading-[15px] tracking-[.06em]',
                          root.offer === 'named'
                            ? 'border-border text-fg-subtle'
                            : 'border-accent/30 text-accent-text'
                        )}
                        title={
                          root.offer === 'named'
                            ? 'Offered by rule: the spec names this directory, so it is listed whether or not it holds anything'
                            : 'Found: this directory is here because walking it turned up something readable'
                        }
                      >
                        {root.offer === 'named' ? 'NAMED' : 'DISCOVERED'}
                      </span>
                      <span className="flex-1" />
                      <span className="shrink-0 tabular-nums">{files.length}</span>
                    </button>
                    {open &&
                      (files.length === 0 ? (
                        // Present and empty, which is a finding rather than a
                        // reason to drop the row.
                        <p
                          data-content-root-empty={root.relPath}
                          className="px-2 py-1.5 pl-[30px] text-[11px] text-fg-subtle italic"
                        >
                          empty
                        </p>
                      ) : (
                        files.map((file) => (
                          <Row
                            key={file.path}
                            file={file}
                            selected={selectedPath === file.path}
                            dirty={dirty && selectedPath === file.path}
                            onSelect={onSelect}
                          />
                        ))
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
  const Icon = CONTENT_KIND_ICON[file.kind]
  // Listed and greyed, but not readable here. It still *opens* - onto a pane
  // that says what it is and offers Explorer - rather than throwing the reader
  // out of the app on a single click. Every row in this list behaves the same
  // way; what differs is what it opens onto.
  const unopenable = file.kind === 'binary'
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
      title={unopenable ? `${file.path}\nNot a kind Helm reads` : file.path}
      className={cn(
        'relative flex w-full items-start gap-2 rounded-well px-2 py-1.5 text-left transition-colors',
        selected ? ROW_SELECTED : 'hover:bg-hover'
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
        className={cn(
          'mt-0.5 shrink-0',
          selected ? 'text-accent' : unopenable ? 'text-fg-subtle/60' : 'text-fg-subtle'
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[12px]',
              unopenable ? 'text-fg-subtle' : 'text-fg'
            )}
          >
            {file.title}
          </span>
          {/* The extension, for anything that is not prose or an artifact.
              Machine data, so mono (DESIGN.md 2). It is what says a row will
              open as source rather than as a document.
              Not for a dotfile whose whole name *is* its extension: a
              `.gitignore` row wearing a `gitignore` chip is the same word
              twice. */}
          {file.ext !== '' && file.ext !== file.title.replace(/^\./, '') && file.kind !== 'markdown' && file.kind !== 'html' && (
            <span
              data-content-ext={file.ext}
              className="shrink-0 rounded-sm bg-surface-sunken px-1 font-mono text-[9.5px] text-fg-subtle"
            >
              {file.ext}
            </span>
          )}
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
            Only for the two kinds that take a title from *inside* the file.
            Everything else is titled with its own filename, so its slug is that
            same name with the extension shaved off - "dot mcp" under
            "dot mcp dot json", which reads as a rendering bug rather than as
            information. */}
        {(file.noteType !== null ||
          file.tags.length > 0 ||
          (file.slug !== file.title && (file.kind === 'markdown' || file.kind === 'html'))) && (
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

/**
 * Shown in the detail column when nothing is open.
 *
 * It says what the *mode* is doing, not what the curated walk found. Repeating
 * "555 files" beside a file tree would be quoting a number from the other view
 * - true of the scope, and not true of anything on screen.
 */
export function ContentNothingSelected({
  scope,
  view,
  fileCount
}: {
  scope: ContentScope | null
  view: ContentViewMode
  fileCount: number
}): JSX.Element {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-md text-center">
        <BookIcon width={22} height={22} className="mx-auto text-fg-subtle" />
        <p className="mt-3 text-[13px] text-fg-muted">
          {scope === null
            ? 'Pick a scope to read what is in it.'
            : view === 'tree'
              ? `Every file in ${scope.label}.`
              : `${fileCount} ${fileCount === 1 ? 'file' : 'files'} in ${scope.label}.`}
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-fg-subtle">
          {view === 'tree' ? (
            <>
              Directories are read as you open them, and what the repository ignores is listed
              rather than hidden. Markdown, HTML and data open the way they do anywhere else;
              everything else opens as source.
            </>
          ) : (
            <>
              Markdown renders with its frontmatter as a header and its{' '}
              <strong className="font-medium text-fg-muted">[[wikilinks]]</strong> live. HTML opens
              in a sandboxed frame with no network behind it.
            </>
          )}
        </p>
      </div>
    </div>
  )
}
