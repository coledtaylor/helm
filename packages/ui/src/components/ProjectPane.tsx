import type { JSX, ReactNode } from 'react'
import type { Project } from '@helm/core'
import { cn } from '../lib/cn'
import { GitChip } from './GitChip'
import { FolderIcon, HarnessIcon, RepoIcon, TerminalIcon } from './icons'

const KIND_ICON = {
  harness: HarnessIcon,
  repo: RepoIcon,
  folder: FolderIcon
} as const

const KIND_LABEL = {
  harness: 'Harness',
  repo: 'Repo',
  folder: 'Folder'
} as const

export interface ProjectPaneProps {
  project: Project
  onReveal: (path: string) => void
  /** Opens a Claude Code session with this project as the working directory. */
  onLaunch: (project: Project) => void
  /** Shown in place of the button while a launch is in flight. */
  launching?: boolean | undefined
  /** Why the last launch failed, if it did. */
  launchError?: string | null | undefined
}

/**
 * Everything discovery knows about one project, and the button that turns it
 * into a session.
 *
 * The inventory table is the argument for the button: it is the same count the
 * sidebar chips carry, laid out so the number that matters - how much this
 * project would contribute to a session - is readable rather than glanceable.
 */
export function ProjectPane({
  project,
  onReveal,
  onLaunch,
  launching = false,
  launchError = null
}: ProjectPaneProps): JSX.Element {
  const KindIcon = KIND_ICON[project.kind]
  const { inventory } = project

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <header className="flex items-start gap-3">
          <KindIcon width={20} height={20} className="mt-1 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[20px] leading-tight font-semibold tracking-tight text-fg">
              {project.name}
            </h1>
            <button
              type="button"
              onClick={() => onReveal(project.path)}
              title="Show in Explorer"
              className="mt-1 block max-w-full truncate text-left font-mono text-[11px] text-fg-subtle transition-colors hover:text-accent"
            >
              {project.path}
            </button>
          </div>
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-fg-muted">
            {KIND_LABEL[project.kind]}
          </span>
        </header>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => onLaunch(project)}
            disabled={launching}
            className={cn(
              'flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium',
              'text-accent-fg shadow-panel transition',
              launching ? 'cursor-default opacity-70' : 'hover:brightness-110 active:brightness-95'
            )}
          >
            <TerminalIcon width={14} height={14} />
            {launching ? 'Starting…' : 'Start session here'}
          </button>
          <span className="text-[11px] text-fg-subtle">
            Runs <code className="font-mono">claude</code> with this folder as the working directory.
          </span>
        </div>

        {launchError !== null && (
          <p
            role="alert"
            className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger"
          >
            {launchError}
          </p>
        )}

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Panel title="Git">
            {project.git ? (
              <div className="flex flex-col gap-2">
                <GitChip git={project.git} />
                <dl className="grid grid-cols-3 gap-2 text-[11px]">
                  <Stat label="changed" value={project.git.dirty} />
                  <Stat label="ahead" value={project.git.ahead} />
                  <Stat label="behind" value={project.git.behind} />
                </dl>
              </div>
            ) : (
              <Muted>Not a git repository.</Muted>
            )}
          </Panel>

          <Panel title="Configuration">
            <ul className="flex flex-col gap-1 text-[12px]">
              <Flag on={project.hasClaudeDir}>.claude/</Flag>
              <Flag on={inventory.claudeMd}>CLAUDE.md</Flag>
              <Flag on={inventory.settings}>settings.json</Flag>
              <Flag on={inventory.hooks}>hooks/</Flag>
              <Flag on={inventory.mcp}>.mcp.json</Flag>
            </ul>
          </Panel>
        </div>

        <Panel title="What this project would contribute to a session" className="mt-3">
          <dl className="grid grid-cols-3 gap-3">
            <Stat large label="skills" value={inventory.skills} />
            <Stat large label="agents" value={inventory.agents} />
            <Stat large label="commands" value={inventory.commands} />
          </dl>
          {inventory.skills + inventory.agents + inventory.commands === 0 && (
            <Muted className="mt-3">
              Nothing to compose. A session launched elsewhere loses nothing by not reaching this
              project.
            </Muted>
          )}
        </Panel>
      </div>
    </div>
  )
}

function Panel({
  title,
  children,
  className
}: {
  title: string
  children: ReactNode
  className?: string | undefined
}): JSX.Element {
  return (
    <section
      className={cn('rounded-lg border border-border bg-surface p-4 shadow-panel', className)}
    >
      <h2 className="mb-3 text-[11px] font-medium tracking-wide text-fg-subtle uppercase">
        {title}
      </h2>
      {children}
    </section>
  )
}

function Stat({
  label,
  value,
  large = false
}: {
  label: string
  value: number
  large?: boolean | undefined
}): JSX.Element {
  return (
    <div>
      <dd
        className={cn(
          'tabular-nums',
          large ? 'text-[22px] leading-tight font-semibold' : 'text-[13px] font-medium',
          value === 0 ? 'text-fg-subtle' : 'text-fg'
        )}
      >
        {value}
      </dd>
      <dt className="text-[11px] text-fg-subtle">{label}</dt>
    </div>
  )
}

function Flag({ on, children }: { on: boolean; children: ReactNode }): JSX.Element {
  return (
    <li className={cn('flex items-center gap-2', on ? 'text-fg' : 'text-fg-subtle')}>
      <span
        aria-hidden
        className={cn('size-1.5 shrink-0 rounded-full', on ? 'bg-success' : 'bg-border-strong')}
      />
      <span className="font-mono text-[11px]">{children}</span>
      <span className="sr-only">{on ? 'present' : 'absent'}</span>
    </li>
  )
}

function Muted({
  children,
  className
}: {
  children: ReactNode
  className?: string | undefined
}): JSX.Element {
  return <p className={cn('text-[12px] text-fg-subtle', className)}>{children}</p>
}
