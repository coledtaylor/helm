import type { JSX, ReactNode } from 'react'
import type { Project } from '@helm/core'
import { cn } from '../lib/cn'
import { GitChip } from './GitChip'
import { LayersIcon, TerminalIcon } from './icons'

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
  /** Opens the profile editor seeded with this project as the root. */
  onSaveAsProfile?: ((project: Project) => void) | undefined
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
  launchError = null,
  onSaveAsProfile
}: ProjectPaneProps): JSX.Element {
  const { inventory } = project

  return (
    // The pane island the active folder tab lifts into.
    <div className="h-full overflow-y-auto rounded-island border border-border bg-surface">
      <div className="px-6 py-5">
        <header className="flex items-baseline gap-3">
          <h1 className="shrink-0 truncate text-[21px] leading-tight font-medium tracking-tight text-fg">
            {project.name}
          </h1>
          <button
            type="button"
            onClick={() => onReveal(project.path)}
            title="Show in Explorer"
            className="min-w-0 truncate text-left font-mono text-[11px] text-fg-subtle transition-colors hover:text-accent-text"
          >
            {project.path}
          </button>
          <span className="ml-auto shrink-0 self-center rounded-full border border-border-strong px-2.5 py-0.5 text-[10px] text-fg-muted">
            {KIND_LABEL[project.kind]}
          </span>
        </header>

        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => onLaunch(project)}
            disabled={launching}
            className={cn(
              // Outlined in the accent, never filled (DESIGN.md "no solid
              // accent fills") - the tint arrives on hover, not at rest.
              'flex items-center gap-2 rounded-well border border-accent px-3.5 py-1.5',
              'text-[12px] font-medium text-accent-text transition-colors',
              launching ? 'cursor-default opacity-60' : 'hover:bg-accent-soft active:bg-active'
            )}
          >
            <TerminalIcon width={14} height={14} />
            {launching ? 'Starting…' : 'Start session here'}
          </button>
          {onSaveAsProfile && (
            <button
              type="button"
              onClick={() => onSaveAsProfile(project)}
              className={cn(
                'flex items-center gap-2 rounded-well border border-border-strong px-3.5 py-1.5',
                'text-[12px] text-fg transition-colors hover:bg-hover'
              )}
            >
              <LayersIcon width={14} height={14} className="text-accent" />
              Save as profile
            </button>
          )}
          <span className="text-[11px] text-fg-subtle">
            Runs <code className="font-mono">claude</code> with this folder as the working directory.
          </span>
        </div>

        {launchError !== null && (
          <p
            role="alert"
            className="mt-3 rounded-raised border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger"
          >
            {launchError}
          </p>
        )}

        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <Panel title="Git">
            {project.git ? (
              <div className="flex flex-col gap-2">
                <GitChip git={project.git} />
                <dl className="flex flex-wrap gap-x-7 gap-y-2 text-[11px]">
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

        <Panel title="What this project would contribute to a session" className="mt-2">
          {/* Clustered, not spread: a stat group reads as one phrase, and
              justifying three numbers across a wide card breaks it into three. */}
          <dl className="flex flex-wrap gap-x-11 gap-y-3">
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
    // A raised surface inside the island: one ramp step lighter, 8px radius,
    // no shadow (DESIGN.md "Island anatomy").
    <section
      className={cn('rounded-raised border border-border bg-surface-raised px-4 py-3.5', className)}
    >
      <h2 className="mb-2.5 text-[9.5px] font-semibold tracking-[.08em] text-fg-subtle uppercase">
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
          // Weight stops at 500: hierarchy is size and space, not boldness
          // (DESIGN.md "no heading weight past 500").
          'tabular-nums',
          large ? 'text-[21px] leading-tight font-medium' : 'text-[13px] font-medium',
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
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          on ? 'bg-success' : 'bg-fg-subtle opacity-50'
        )}
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
