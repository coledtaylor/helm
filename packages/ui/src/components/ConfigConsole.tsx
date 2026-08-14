import type { JSX, KeyboardEvent, ReactNode } from 'react'
import { Fragment, useMemo, useState } from 'react'
import type {
  ConfigFile,
  ConfigFileKind,
  ConfigLive,
  ConfigScope,
  ConfigTree,
  EffectiveView
} from '@helm/core'
// A value, so it comes from `@helm/core/types` - the entry point with no
// `node:` imports behind it (CLAUDE.md, hard rules).
import { computeConfigLive } from '@helm/core/types'
import { cn } from '../lib/cn'
import { ROW_SELECTED } from '../lib/rows'
import { SEGMENT_ON } from '../lib/segmented'
import { formatAge, formatBytes } from '../lib/time'
import { isLiveWarning, LiveDot } from './ConfigLive'
import { PaneBack } from './PaneBack'
import { PaneHeader } from './PaneHeader'
import { CaretIcon, FolderIcon, RefreshIcon, SearchIcon, SlidersIcon } from './icons'

export type ConfigViewKind = 'files' | 'effective' | 'mcp' | 'health'

export interface ConfigConsoleProps {
  scopes: ConfigScope[]
  scopePath: string
  onScopeChange: (path: string) => void

  view: ConfigViewKind
  onViewChange: (view: ConfigViewKind) => void

  tree: ConfigTree | null
  treeLoading: boolean
  /**
   * What a session in one working directory would resolve, which is where every
   * row's live state comes from. Null while it is being computed, or while the
   * one held is the answer to a different question - the rows then say nothing
   * rather than the wrong thing.
   */
  live: EffectiveView | null
  selected: ConfigFile | null
  onSelect: (file: ConfigFile) => void
  /** The open file has unsaved changes. Marked on its row. */
  dirty?: boolean | undefined
  onRefresh: () => void
  refreshing: boolean

  /**
   * Docked beside a session split, where the list and the editor cannot both be
   * readable. The pane then shows one at a time: the list until a file is
   * picked, then the editor with a way back.
   */
  compact?: boolean | undefined
  /** Clears the selection, which is what puts the list back. */
  onBack?: (() => void) | undefined

  /** The editor, the effective view, the MCP panel or the health panel. */
  children: ReactNode
}

const KIND_LABEL: Record<ConfigFileKind, string> = {
  'claude-md': 'Instructions',
  settings: 'Settings',
  'settings-local': 'Settings',
  mcp: 'MCP',
  skill: 'Skills',
  command: 'Commands',
  agent: 'Agents',
  hook: 'Hooks',
  rule: 'Rules',
  other: 'Other'
}

/**
 * A row, and whatever a skill bundles beside its `SKILL.md`.
 *
 * `prompts.md` next to a `SKILL.md` is not a file in the tree - it is part of
 * the skill, and the skill is what a session addresses. Listed flat it landed
 * in `Other` beside the CLI's caches, which is where a `.claude` tree's most
 * relevant files went to be lost.
 *
 * The nesting is presentation and nothing else: `readConfigTree` still returns
 * one flat, kind-ordered list, so the tree, the counts and every check that
 * walks it are unchanged.
 */
interface ConfigRow {
  file: ConfigFile
  children: ConfigFile[]
}

/** `skills/think/SKILL.md` -> `skills/think`, the directory that is the skill. */
function skillDirectory(relPath: string): string {
  return relPath.slice(0, relPath.lastIndexOf('/'))
}

const VIEWS: Array<{ id: ConfigViewKind; label: string }> = [
  { id: 'files', label: 'Files' },
  { id: 'effective', label: 'Effective' },
  { id: 'mcp', label: 'MCP' },
  { id: 'health', label: 'Health' }
]

/**
 * The `.claude/` directory of whatever scope you point at, as an interface.
 *
 * Laid out like the session-history pane on purpose - a header bar, a bounded
 * list, a detail that fills the rest - because they are the same kind of
 * surface and a second layout for the same shape is a second thing to learn.
 *
 * The list groups by *what a thing is to Claude Code* rather than by directory.
 * `commands/spec/plan.md` is `/spec:plan` and `skills/think/SKILL.md` is
 * `think`; a tree that showed the paths would be showing the one representation
 * that answers no question anybody has while editing them.
 *
 * `Effective`, `MCP` and `Health` take the whole pane rather than sitting beside
 * the list: none of them is about a single file, and a list of files next to an
 * answer about the session as a whole would suggest the two were related.
 */
export function ConfigConsole({
  scopes,
  scopePath,
  onScopeChange,
  view,
  onViewChange,
  tree,
  treeLoading,
  live,
  selected,
  onSelect,
  dirty = false,
  onRefresh,
  refreshing,
  compact = false,
  onBack,
  children
}: ConfigConsoleProps): JSX.Element {
  const [filter, setFilter] = useState('')
  // One at a time, and only when narrow: at full width both fit and swapping
  // them would cost a click for nothing.
  const showList = !compact || selected === null
  const showDetail = !compact || selected !== null

  const scope = scopes.find((s) => s.path.toLowerCase() === scopePath.toLowerCase()) ?? null

  const groups = useMemo(() => {
    const files = tree?.files ?? []

    // Adoption first, filtering second. A child that matches keeps its parent
    // on screen and a parent that matches keeps its children, which is what
    // makes the nest a thing rather than a decoration that survives until the
    // first search.
    const adopted = new Map<string, ConfigFile[]>()
    const claimed = new Set<string>()
    for (const skill of files) {
      if (skill.kind !== 'skill') continue
      const prefix = `${skillDirectory(skill.relPath).toLowerCase()}/`
      const bundled = files.filter(
        (file) =>
          file.kind === 'other' &&
          file.relPath.toLowerCase().startsWith(prefix) &&
          // Directly inside the skill, not inside a nested skill of its own,
          // which has its own row and its own bundle.
          !file.relPath.slice(prefix.length).includes('/')
      )
      if (bundled.length === 0) continue
      adopted.set(skill.path, bundled)
      for (const file of bundled) claimed.add(file.path)
    }

    const needle = filter.trim().toLowerCase()
    const hit = (file: ConfigFile): boolean =>
      needle === '' ||
      file.name.toLowerCase().includes(needle) ||
      file.relPath.toLowerCase().includes(needle) ||
      (file.description ?? '').toLowerCase().includes(needle)

    // Settings and settings.local are two kinds and one group; everything else
    // maps one to one. Insertion order is the tree's order, which is already
    // the order these should be read in.
    const byLabel = new Map<string, ConfigRow[]>()
    for (const file of files) {
      if (claimed.has(file.path)) continue
      const children = adopted.get(file.path) ?? []
      if (!hit(file) && !children.some(hit)) continue
      const label = KIND_LABEL[file.kind]
      byLabel.set(label, [...(byLabel.get(label) ?? []), { file, children }])
    }
    return [...byLabel.entries()]
  }, [tree, filter])

  const rows = groups.reduce((n, [, group]) => n + group.length, 0)
  const shown = groups.reduce(
    (n, [, group]) => n + group.reduce((each, row) => each + 1 + row.children.length, 0),
    0
  )
  const total = tree?.files.length ?? 0

  // Only the sections someone has deliberately shut are in here, so a kind that
  // appears in a scope opened later starts expanded rather than hidden behind a
  // key nothing has written. Same rule the sidebar's harness groups follow.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const toggleSection = (key: string): void =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  // A filter that hides its own matches is a filter that looks broken, so
  // filtering opens every section it matched.
  const isExpanded = (key: string): boolean => filter.trim() !== '' || !collapsed.has(key)

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-config-file]')]
    const at = rows.findIndex((row) => row === document.activeElement)
    const next = rows[at < 0 ? 0 : at + step]
    if (!next) return
    event.preventDefault()
    next.focus()
    next.click()
  }

  return (
    // A column of islands with 8px of canvas between them: the header strip,
    // then the file list beside the editor. The header is the island the
    // active folder tab lifts into.
    <div className="flex h-full min-h-0 flex-col gap-2">
      <PaneHeader
        name="config"
        icon={<SlidersIcon width={15} height={15} />}
        title="Config"
        scope={
          <label className="flex min-w-0 flex-1 items-center gap-2">
            <span className="sr-only">Scope</span>
            <select
              data-config-scope
              aria-label="Scope"
              value={scopePath}
              onChange={(event) => onScopeChange(event.target.value)}
              className={cn(
                // Stretches only in the last band, and capped even there: a
                // 400px select holding the word "User" is not what the room
                // freed by dropping the title is for.
                'h-7 w-full max-w-64 min-w-0 rounded-well border border-border bg-surface-sunken px-2',
                '@[384px]:w-auto @[384px]:min-w-40',
                'text-[12px] text-fg transition-colors',
                'hover:border-border-strong focus:border-accent focus:outline-none'
              )}
            >
              {['user', 'harness', 'project'].map((kind) => {
                const inKind = scopes.filter((s) => s.kind === kind)
                if (inKind.length === 0) return null
                return (
                  <optgroup
                    key={kind}
                    label={kind === 'user' ? 'User' : kind === 'harness' ? 'Harnesses' : 'Projects'}
                  >
                    {inKind.map((s) => (
                      <option key={s.path} value={s.path}>
                        {s.label}
                        {s.exists ? '' : ' (no config)'}
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
                // Titled, because what a truncated path drops is its tail, and
                // the tail is the half that identifies a scope.
                <p
                  className="truncate font-mono text-[11px] text-fg-subtle"
                  title={scope.kind === 'user' ? scope.claudeDir : scope.path}
                >
                  {scope.kind === 'user' ? scope.claudeDir : scope.path}
                </p>
              )
            }
          : {})}
        controls={
          <div
            role="group"
            aria-label="View"
            // A segmented control (DESIGN.md): sunken well, and the chosen
            // segment lifts to the raised surface with a hairline ring.
            // On its own row below 560px, where it is the widest thing in the
            // header and the row it came from has a scope switcher to keep.
            className="flex min-w-0 gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
          >
            {VIEWS.map((option) => (
              <button
                key={option.id}
                type="button"
                data-config-view={option.id}
                aria-pressed={view === option.id}
                onClick={() => onViewChange(option.id)}
                className={cn(
                  'min-w-0 truncate rounded-[5px] px-1.5 py-0.5 text-[11px] transition-colors',
                  '@[560px]:px-2.5',
                  view === option.id
                    ? SEGMENT_ON
                    : 'text-fg-muted hover:text-fg'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        }
        action={
          <button
            type="button"
            data-config-refresh
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

      {view !== 'files' ? (
        <div className="min-h-0 flex-1 overflow-hidden rounded-island border border-border bg-surface">
          {children}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-2">
          {/* Proportional and bounded, the same way the history list is: the
              rows carry a skill's description, which is what makes one worth
              opening, and a fixed width either truncates it or wastes half a
              wide monitor on a list of short names. */}
          {showList && (
          <div
            className={cn(
              'flex flex-col overflow-hidden rounded-island border border-border bg-surface',
              compact ? 'min-w-0 flex-1' : 'w-[34%] max-w-[480px] min-w-[300px] shrink-0'
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
                  data-config-filter
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter this scope"
                  spellCheck={false}
                  aria-label="Filter this scope"
                  className={cn(
                    'h-[26px] w-full rounded-well border border-border bg-surface-sunken pr-2 pl-7',
                    'text-[12px] text-fg select-text placeholder:text-fg-subtle',
                    'focus:border-accent focus:outline-none'
                  )}
                />
              </div>
              <p className="mt-2 flex items-baseline gap-1.5 text-[11px] text-fg-subtle">
                {/* Entries and files are different numbers once a skill's
                    bundle is inside it, and saying both is what explains where
                    a file somebody can see in Explorer has gone. */}
                <span className="tabular-nums">
                  {tree === null
                    ? 'Reading…'
                    : filter !== ''
                      ? `${shown}/${total}`
                      : rows === total
                        ? `${total} ${total === 1 ? 'file' : 'files'}`
                        : `${rows} entries · ${total} files`}
                </span>
                <span className="flex-1" />
                {tree !== null && tree.errors.length > 0 && (
                  <span className="text-danger" title={tree.errors.join('\n')}>
                    {tree.errors.length} unreadable
                  </span>
                )}
              </p>
            </div>

            <div
              role="group"
              aria-label="Configuration files"
              onKeyDown={onListKeyDown}
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
            >
              {tree === null || treeLoading ? (
                <p className="px-2 py-6 text-center text-[12px] text-fg-subtle">Reading&hellip;</p>
              ) : groups.length === 0 ? (
                <Empty scope={scope} filtering={filter !== '' && total > 0} />
              ) : (
                groups.map(([label, group]) => {
                  const expanded = isExpanded(label)
                  return (
                    <Fragment key={label}>
                      <button
                        type="button"
                        onClick={() => toggleSection(label)}
                        aria-expanded={expanded}
                        data-config-section={label}
                        className={cn(
                          'sticky top-0 z-10 mt-3 flex w-full items-center gap-1.5 bg-surface px-2 py-1',
                          'text-left text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase',
                          'transition-colors first:mt-0 hover:text-fg'
                        )}
                      >
                        <CaretIcon
                          width={8}
                          height={8}
                          className={cn('shrink-0 transition-transform', expanded && 'rotate-90')}
                        />
                        <span className="min-w-0 truncate">{label}</span>
                        <span className="tabular-nums">{group.length}</span>
                      </button>
                      {expanded &&
                        group.map((row) => (
                          <Row
                            key={row.file.path}
                            file={row.file}
                            bundled={row.children}
                            live={computeConfigLive(row.file, live)}
                            selected={selected?.path === row.file.path}
                            selectedPath={selected?.path ?? null}
                            dirty={dirty && selected?.path === row.file.path}
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
      )}
    </div>
  )
}

/**
 * One entry: what it is called, whether it is live, and what it bundles.
 *
 * The kind icon is gone from the head of the row and a state dot is in its
 * place. The group heading two rows up already says `Skills`, so the icon was
 * the one fact on the row that was written twice - and whether the thing under
 * the pointer is actually reaching a session is the fact that was written
 * nowhere.
 */
function Row({
  file,
  bundled,
  live,
  selected,
  selectedPath,
  dirty,
  onSelect
}: {
  file: ConfigFile
  bundled: ConfigFile[]
  live: ConfigLive | null
  selected: boolean
  /** The open file, so a bundled one that is open can be marked. */
  selectedPath: string | null
  dirty: boolean
  onSelect: (file: ConfigFile) => void
}): JSX.Element {
  // The live note replaces the description rather than joining it: the row has
  // one second line, and "does this reach a session" outranks "what is it for"
  // on a row somebody is already looking at because they know what it is for.
  // The description survives on the row's title and as a chip on the pane.
  const note = live?.note ?? null
  return (
    <button
      type="button"
      data-config-file={file.relPath}
      data-config-kind={file.kind}
      data-config-dirty={dirty}
      data-config-live={live?.state ?? ''}
      aria-current={selected}
      onClick={() => onSelect(file)}
      title={[file.path, file.description, live?.reason].filter(Boolean).join('\n')}
      className={cn(
        'relative block w-full rounded-well px-2 py-1.5 text-left transition-colors',
        selected ? ROW_SELECTED : 'hover:bg-hover'
      )}
    >
      {selected && (
        <span
          aria-hidden
          className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-accent"
        />
      )}
      <span className="flex items-center gap-2">
        <LiveDot live={live} />
        {/* Mono: a name here is what somebody types at a prompt - `spec:plan`,
            `settings.local.json` - which is machine data, not a title. */}
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg">{file.name}</span>
        {/* The byte count is replaced rather than joined: an unsaved file's
            size on disk is the one number that is about to stop being true. */}
        {dirty ? (
          <span className="flex shrink-0 items-center gap-1 text-[10px] text-warn">
            <span aria-hidden className="size-1.5 rounded-full bg-warn" />
            unsaved
          </span>
        ) : (
          <span className="shrink-0 text-[10px] tabular-nums text-fg-subtle">
            {formatBytes(file.size)}
          </span>
        )}
      </span>

      {/* Indented past the dot, so the second line starts under the name. */}
      <span
        className={cn(
          'mt-0.5 block truncate pl-[14px] text-[10px]',
          live !== null && isLiveWarning(live.state) ? 'text-warn' : 'text-fg-subtle'
        )}
      >
        {note ??
          (file.description !== null
            ? file.description
            : `${file.relPath === file.name ? '' : `${file.relPath} · `}${formatAge(file.mtimeMs)}`)}
      </span>

      {bundled.length > 0 && (
        <span className="mt-0.5 block truncate pl-[14px] font-mono text-[9.5px] text-fg-subtle">
          <span aria-hidden>└ </span>
          {bundled.map((child, at) => (
            <Fragment key={child.path}>
              {at > 0 && <span aria-hidden> · </span>}
              <span className={cn(child.path === selectedPath && 'text-accent-text')}>
                {child.relPath.slice(child.relPath.lastIndexOf('/') + 1)}
              </span>
            </Fragment>
          ))}
        </span>
      )}
    </button>
  )
}

function Empty({
  scope,
  filtering
}: {
  scope: ConfigScope | null
  filtering: boolean
}): JSX.Element {
  if (filtering) {
    return <p className="px-2 py-6 text-center text-[12px] text-fg-subtle">No match.</p>
  }
  return (
    <div className="px-3 py-8 text-center">
      <FolderIcon width={20} height={20} className="mx-auto text-fg-subtle" />
      <p className="mt-2 text-[12px] text-fg-muted">
        {scope === null
          ? 'Pick a scope.'
          : `${scope.label} has no .claude directory, no CLAUDE.md and no .mcp.json.`}
      </p>
    </div>
  )
}

/** Shown in the detail column when nothing is selected. */
export function ConfigNothingSelected({
  scope,
  fileCount
}: {
  scope: ConfigScope | null
  fileCount: number
}): JSX.Element {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-md text-center">
        <SlidersIcon width={22} height={22} className="mx-auto text-fg-subtle" />
        <p className="mt-3 text-[13px] text-fg-muted">
          {scope === null
            ? 'Pick a scope to see its configuration.'
            : `${fileCount} ${fileCount === 1 ? 'file' : 'files'} in ${scope.label}.`}
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-fg-subtle">
          Pick one to edit it, or switch to <strong className="font-medium text-fg-muted">Effective</strong> to
          see which of them a session would actually resolve, and under what name.
        </p>
      </div>
    </div>
  )
}
