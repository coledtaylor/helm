import type { JSX, KeyboardEvent, ReactNode } from 'react'
import { Fragment, useMemo, useState } from 'react'
import type {
  ConfigFile,
  ConfigFileKind,
  ConfigScope,
  ConfigTree
} from '@helm/core'
import { cn } from '../lib/cn'
import { formatAge, formatBytes } from '../lib/time'
import { PaneBack } from './PaneBack'
import {
  AgentIcon,
  CaretIcon,
  CommandIcon,
  DocIcon,
  FolderIcon,
  HookIcon,
  PlugIcon,
  RefreshIcon,
  SearchIcon,
  SlidersIcon,
  SparkIcon
} from './icons'

export type ConfigViewKind = 'files' | 'effective' | 'mcp' | 'health'

export interface ConfigConsoleProps {
  scopes: ConfigScope[]
  scopePath: string
  onScopeChange: (path: string) => void

  view: ConfigViewKind
  onViewChange: (view: ConfigViewKind) => void

  tree: ConfigTree | null
  treeLoading: boolean
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

const KIND_ICON: Record<ConfigFileKind, typeof SparkIcon> = {
  'claude-md': DocIcon,
  settings: SlidersIcon,
  'settings-local': SlidersIcon,
  mcp: PlugIcon,
  skill: SparkIcon,
  command: CommandIcon,
  agent: AgentIcon,
  hook: HookIcon,
  rule: DocIcon,
  other: DocIcon
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
    const needle = filter.trim().toLowerCase()
    const files = (tree?.files ?? []).filter(
      (file) =>
        needle === '' ||
        file.name.toLowerCase().includes(needle) ||
        file.relPath.toLowerCase().includes(needle) ||
        (file.description ?? '').toLowerCase().includes(needle)
    )

    // Settings and settings.local are two kinds and one group; everything else
    // maps one to one. Insertion order is the tree's order, which is already
    // the order these should be read in.
    const byLabel = new Map<string, ConfigFile[]>()
    for (const file of files) {
      const label = KIND_LABEL[file.kind]
      byLabel.set(label, [...(byLabel.get(label) ?? []), file])
    }
    return [...byLabel.entries()]
  }, [tree, filter])

  const shown = groups.reduce((n, [, files]) => n + files.length, 0)
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
      <header className="flex h-11 shrink-0 items-center gap-3 rounded-island border border-border bg-surface px-4">
        <SlidersIcon width={15} height={15} className="shrink-0 text-accent" />
        <h1 className="shrink-0 text-[13px] font-medium tracking-tight text-fg">Config</h1>

        <label className="flex min-w-0 items-center gap-2">
          <span className="sr-only">Scope</span>
          <select
            data-config-scope
            aria-label="Scope"
            value={scopePath}
            onChange={(event) => onScopeChange(event.target.value)}
            className={cn(
              'h-7 max-w-64 min-w-40 rounded-well border border-border bg-surface-sunken px-2',
              'text-[12px] text-fg focus:border-accent focus:outline-none'
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

        {scope && (
          <p className="hidden min-w-0 truncate font-mono text-[11px] text-fg-subtle lg:block">
            {scope.kind === 'user' ? scope.claudeDir : scope.path}
          </p>
        )}

        <span className="flex-1" />

        <div
          role="group"
          aria-label="View"
          // A segmented control (DESIGN.md): sunken well, and the chosen
          // segment lifts to the raised surface with a hairline ring.
          className="flex gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
        >
          {VIEWS.map((option) => (
            <button
              key={option.id}
              type="button"
              data-config-view={option.id}
              aria-pressed={view === option.id}
              onClick={() => onViewChange(option.id)}
              className={cn(
                'rounded-[5px] px-2.5 py-0.5 text-[11px] transition-colors',
                view === option.id
                  ? 'bg-surface-raised text-fg ring-1 ring-border-strong'
                  : 'text-fg-muted hover:text-fg'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

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
      </header>

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
                <span className="tabular-nums">
                  {tree === null
                    ? 'Reading…'
                    : filter === ''
                      ? `${total} ${total === 1 ? 'file' : 'files'}`
                      : `${shown}/${total}`}
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
                groups.map(([label, files]) => {
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
      )}
    </div>
  )
}

function Row({
  file,
  selected,
  dirty,
  onSelect
}: {
  file: ConfigFile
  selected: boolean
  dirty: boolean
  onSelect: (file: ConfigFile) => void
}): JSX.Element {
  const Icon = KIND_ICON[file.kind]
  return (
    <button
      type="button"
      data-config-file={file.relPath}
      data-config-kind={file.kind}
      data-config-dirty={dirty}
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
          <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{file.name}</span>
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
        {/* The description when there is one, because that is what decides
            whether a skill is worth opening. Otherwise the path - unless the
            path *is* the name, as it is for CLAUDE.md and .mcp.json, where
            repeating it reads as a rendering bug. */}
        {file.description !== null ? (
          <span className="mt-0.5 line-clamp-2 block text-[10px] leading-snug text-fg-subtle">
            {file.description}
          </span>
        ) : (
          <span className="mt-0.5 block truncate text-[10px] text-fg-subtle">
            {file.relPath === file.name ? '' : `${file.relPath} · `}
            {formatAge(file.mtimeMs)}
          </span>
        )}
      </span>
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
