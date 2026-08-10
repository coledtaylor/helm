import type { JSX, ReactNode } from 'react'
import { useMemo, useState } from 'react'
import type { DiscoveryResult, Harness, Project } from '@helm/core'
import { cn } from '../lib/cn'
import { ProjectRow } from './ProjectRow'
import { BookIcon, HarnessIcon, HistoryIcon, PlusIcon, RefreshIcon, SlidersIcon } from './icons'

export interface SidebarProps {
  /**
   * Saved profiles, above the tree. The launcher shows both (SPEC 4.1) and they
   * are one scroll container's worth of sidebar, not two panels - so the list
   * is passed in rather than reimplemented here, and this component keeps
   * knowing only about discovery.
   */
  profiles?: ReactNode | undefined
  /** Opens the session-history pane. */
  onOpenHistory?: (() => void) | undefined
  /** Sessions the index holds, and how many of them can still be reopened. */
  historyCount?: number | undefined
  historyResumable?: number | undefined
  /** True while the history pane is the tab on screen. */
  historyActive?: boolean | undefined
  /** Opens the config console. */
  onOpenConfig?: (() => void) | undefined
  configActive?: boolean | undefined
  /** How many `.claude` trees the console can reach. */
  configScopes?: number | undefined
  /** Opens the content viewer. */
  onOpenContent?: (() => void) | undefined
  contentActive?: boolean | undefined
  /** Files the viewer can reach in the scope it is pointed at. */
  contentFiles?: number | undefined
  contentScopeLabel?: string | undefined
  discovery: DiscoveryResult | null
  scanning: boolean
  scanError?: string | undefined
  selectedPath: string | null
  /** Lower-cased project paths with a running session - the green dots. */
  livePaths?: ReadonlySet<string> | undefined
  onSelect: (project: Project) => void
  onRescan: () => void
  onAddRoot: () => void
  /**
   * Scaffold a harness. Deliberately not first-run-only: someone who starts
   * with one folder of repos and later wants a second workspace should not have
   * to reinstall to get the action back.
   */
  onCreateHarness?: (() => void) | undefined
}

interface Group {
  key: string
  harness: Harness | null
  root: Project | null
  members: Project[]
}

function groupProjects(discovery: DiscoveryResult | null): Group[] {
  if (!discovery) return []

  const byHarness = new Map<string, Group>()
  const loose: Project[] = []

  for (const harness of discovery.harnesses) {
    byHarness.set(harness.path.toLowerCase(), {
      key: harness.path,
      harness,
      root: null,
      members: []
    })
  }

  for (const project of discovery.projects) {
    if (project.harnessPath === null) {
      loose.push(project)
      continue
    }
    const group = byHarness.get(project.harnessPath.toLowerCase())
    if (!group) {
      loose.push(project)
      continue
    }
    if (project.kind === 'harness') group.root = project
    else group.members.push(project)
  }

  const groups = [...byHarness.values()]
  if (loose.length > 0) {
    groups.push({ key: '__loose__', harness: null, root: null, members: loose })
  }
  return groups
}

function matches(project: Project, query: string): boolean {
  if (query === '') return true
  const needle = query.toLowerCase()
  return project.name.toLowerCase().includes(needle) || project.path.toLowerCase().includes(needle)
}

export function Sidebar({
  profiles,
  onOpenHistory,
  historyCount,
  historyResumable,
  historyActive = false,
  onOpenConfig,
  configActive = false,
  configScopes,
  onOpenContent,
  contentActive = false,
  contentFiles,
  contentScopeLabel,
  discovery,
  scanning,
  scanError,
  selectedPath,
  livePaths,
  onSelect,
  onRescan,
  onAddRoot,
  onCreateHarness
}: SidebarProps): JSX.Element {
  const [query, setQuery] = useState('')
  const groups = useMemo(() => groupProjects(discovery), [discovery])

  const filtered = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          // A harness root that does not match itself is kept as long as one of
          // its repos does, so filtering never orphans a visible child.
          root: group.root && matches(group.root, query) ? group.root : null,
          members: group.members.filter((p) => matches(p, query))
        }))
        .filter((group) => group.root !== null || group.members.length > 0),
    [groups, query]
  )

  const total = discovery?.projects.length ?? 0
  const shown = filtered.reduce((n, g) => n + g.members.length + (g.root ? 1 : 0), 0)

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col overflow-hidden rounded-island border border-border bg-surface">
      {/* Above the profiles, because it is the one row that is about the whole
          machine rather than about anything configured in Helm - and because
          "where did I do that thing last week" is how a session starts at
          least as often as picking a project does. */}
      {(onOpenHistory || onOpenConfig || onOpenContent) && (
        <div className="shrink-0 space-y-0.5 p-2 pb-1.5">
          {onOpenHistory && (
            <button
              type="button"
              data-open-history
              onClick={onOpenHistory}
              aria-current={historyActive}
              title="Every Claude Code session on this machine"
              className={cn(
                'flex w-full items-center gap-2 rounded-well px-2 py-1.5 text-left transition-colors',
                historyActive ? 'bg-accent-soft' : 'hover:bg-hover'
              )}
            >
              <HistoryIcon
                width={13}
                height={13}
                className={cn('shrink-0', historyActive ? 'text-accent' : 'text-fg-subtle')}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-fg">Session history</span>
                <span className="block truncate text-[10px] text-fg-subtle">
                  {historyCount === undefined
                    ? 'Reading…'
                    : `${historyCount.toLocaleString()} sessions · ${String(historyResumable ?? 0)} resumable`}
                </span>
              </span>
            </button>
          )}
          {onOpenConfig && (
            <button
              type="button"
              data-open-config
              onClick={onOpenConfig}
              aria-current={configActive}
              title="Browse and edit the .claude configuration of any scope"
              className={cn(
                'flex w-full items-center gap-2 rounded-well px-2 py-1.5 text-left transition-colors',
                configActive ? 'bg-accent-soft' : 'hover:bg-hover'
              )}
            >
              <SlidersIcon
                width={13}
                height={13}
                className={cn('shrink-0', configActive ? 'text-accent' : 'text-fg-subtle')}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-fg">Config</span>
                <span className="block truncate text-[10px] text-fg-subtle">
                  {configScopes === undefined || configScopes === 0
                    ? 'Skills, settings, MCP'
                    : `${configScopes} scopes · what a session would see`}
                </span>
              </span>
            </button>
          )}
          {onOpenContent && (
            <button
              type="button"
              data-open-content
              onClick={onOpenContent}
              aria-current={contentActive}
              title="Read the notes, docs and artifacts in a project or harness"
              className={cn(
                'flex w-full items-center gap-2 rounded-well px-2 py-1.5 text-left transition-colors',
                contentActive ? 'bg-accent-soft' : 'hover:bg-hover'
              )}
            >
              <BookIcon
                width={13}
                height={13}
                className={cn('shrink-0', contentActive ? 'text-accent' : 'text-fg-subtle')}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-fg">Content</span>
                <span className="block truncate text-[10px] text-fg-subtle">
                  {contentFiles === undefined || contentFiles === 0
                    ? 'Notes, docs, skills, artifacts'
                    : `${contentFiles} files · ${contentScopeLabel ?? 'this scope'}`}
                </span>
              </span>
            </button>
          )}
        </div>
      )}
      <div aria-hidden className="island-rule mx-3 my-0.5" />
      {profiles}
      <div aria-hidden className="island-rule mx-3 my-0.5" />
      <header className="flex h-9 shrink-0 items-center gap-2 px-3.5">
        <span className="text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
          Projects
        </span>
        <span className="text-[10px] tabular-nums text-fg-subtle">
          {query === '' ? total : `${shown}/${total}`}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onRescan}
          disabled={scanning}
          title="Rescan all roots"
          aria-label="Rescan all roots"
          className={cn(
            'grid size-6 place-items-center rounded text-fg-subtle transition-colors',
            'hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-50'
          )}
        >
          <RefreshIcon className={cn(scanning && 'animate-spin')} />
        </button>
        {onCreateHarness && (
          <button
            type="button"
            data-create-harness
            onClick={onCreateHarness}
            title="Create a new harness"
            aria-label="Create a new harness"
            className="grid size-6 place-items-center rounded text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
          >
            <HarnessIcon />
          </button>
        )}
        <button
          type="button"
          data-add-root
          onClick={onAddRoot}
          title="Add a folder to scan"
          aria-label="Add a folder to scan"
          className="grid size-6 place-items-center rounded text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
        >
          <PlusIcon />
        </button>
      </header>

      <div className="shrink-0 px-2 pb-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter"
          spellCheck={false}
          aria-label="Filter projects"
          className={cn(
            'h-[26px] w-full rounded-well border border-border bg-surface-sunken px-2.5 text-[12px]',
            'text-fg placeholder:text-fg-subtle select-text',
            'focus:border-accent focus:outline-none'
          )}
        />
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
        {scanError !== undefined && (
          <p className="mb-2 rounded-raised border border-danger/30 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
            {scanError}
          </p>
        )}

        {filtered.length === 0 ? (
          <EmptyState
            scanning={scanning}
            filtering={query !== '' && total > 0}
            hasRoots={(discovery?.roots.length ?? 0) > 0}
            onAddRoot={onAddRoot}
          />
        ) : (
          filtered.map((group) => (
            <section key={group.key} className="mb-3 last:mb-1">
              {group.harness ? (
                group.root ? (
                  <ProjectRow
                    project={group.root}
                    selected={group.root.path === selectedPath}
                    live={livePaths?.has(group.root.path.toLowerCase()) ?? false}
                    onSelect={onSelect}
                  />
                ) : (
                  <p className="px-2 py-1 text-[10.5px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
                    {group.harness.name}
                  </p>
                )
              ) : (
                <p className="px-2 py-1 text-[10.5px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
                  Folders
                </p>
              )}

              {group.members.map((project) => (
                <ProjectRow
                  key={project.path}
                  project={project}
                  selected={project.path === selectedPath}
                  live={livePaths?.has(project.path.toLowerCase()) ?? false}
                  onSelect={onSelect}
                  indent={group.harness !== null}
                />
              ))}
            </section>
          ))
        )}
      </nav>
    </aside>
  )
}

function EmptyState({
  scanning,
  filtering,
  hasRoots,
  onAddRoot
}: {
  scanning: boolean
  filtering: boolean
  hasRoots: boolean
  onAddRoot: () => void
}): JSX.Element {
  if (filtering) {
    return <p className="px-2 py-6 text-center text-[12px] text-fg-subtle">No match.</p>
  }
  if (scanning) {
    return <p className="px-2 py-6 text-center text-[12px] text-fg-subtle">Scanning&hellip;</p>
  }
  return (
    <div className="px-2 py-6 text-center">
      <p className="text-[12px] text-fg-muted">
        {hasRoots ? 'Nothing found in the scanned folders.' : 'No folders are being scanned yet.'}
      </p>
      <button
        type="button"
        onClick={onAddRoot}
        className="mt-3 rounded-well border border-border-strong px-2.5 py-1 text-[12px] text-fg transition-colors hover:bg-hover"
      >
        Add a folder
      </button>
    </div>
  )
}
