import type { JSX, ReactNode } from 'react'
import type { Project } from '@helm/core'
import type { IgnoredRepo, PullRepo, PullsSnapshot, PullSummary } from '@helm/core/types'
import { cn } from '../lib/cn'
import { GitChip } from './GitChip'
import { fetchedCaption } from './PullsPane'
import { PullRow, useNow } from './PullRow'
import { BookIcon, LayersIcon, RefreshIcon, SlidersIcon, TerminalIcon } from './icons'

const KIND_LABEL = {
  harness: 'Harness',
  repo: 'Repo',
  folder: 'Folder'
} as const

/** DESIGN.md 2's caps label, named once because `Panel` renders it two ways. */
const LABEL = 'text-[9.5px] font-semibold tracking-[.08em] text-fg-subtle uppercase'

/**
 * What the pull-request surface has to say about **one** project.
 *
 * Derived here rather than in the window, and off the same `PullsSnapshot` the
 * Pulls pane paints, so the two surfaces cannot disagree about a repository:
 * one reduction of one snapshot, in the package that draws both.
 *
 * `ignored` is why this is a function and not a `find`. An ignored repository
 * is *structurally absent* from `snapshot.repos` - that is deliberate, so no
 * count can include one by forgetting a filter - which means a project pane
 * that only looked at `repos` would show nothing at all for it, and "nothing"
 * on this pane reads as "no pull requests". The setting is not allowed to hide
 * itself, which is the same rule the Pulls pane's Ignored section exists for.
 */
export function projectPulls(
  snapshot: PullsSnapshot | null,
  projectPath: string
): { repo: PullRepo | null; ignored: IgnoredRepo | null } {
  if (snapshot === null) return { repo: null, ignored: null }
  const wanted = projectPath.toLowerCase()
  const repo = snapshot.repos.find((candidate) => candidate.path.toLowerCase() === wanted) ?? null
  if (repo !== null) return { repo, ignored: null }
  const ignored =
    snapshot.ignored.find((candidate) =>
      candidate.paths.some((path) => path.toLowerCase() === wanted)
    ) ?? null
  return { repo: null, ignored }
}

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
  /** Opens the config console with this project as its scope. */
  onOpenConfig?: ((project: Project) => void) | undefined
  /** Opens the content viewer with this project as its scope. */
  onOpenContent?: ((project: Project) => void) | undefined
  /**
   * The whole pull-request snapshot, reduced to this project by `projectPulls`.
   * Null before the first read; the panel is simply absent for a project the
   * surface has nothing to say about.
   */
  pulls?: PullsSnapshot | null | undefined
  /** Opens one pull request in a tab of its own. */
  onOpenPull?: ((repo: PullRepo, pull: PullSummary) => void) | undefined
  /** Checks this one repository now. */
  onRefreshPulls?: ((repoPath: string) => void) | undefined
  /** Takes this repository back off the ignore list. */
  onUnignoreRepo?: ((slug: string) => void) | undefined
}

/**
 * Everything discovery knows about one project, and the button that turns it
 * into a session.
 *
 * The inventory table is the argument for the button: it is the same count the
 * sidebar chips carry, laid out so the number that matters - how much this
 * project would contribute to a session - is readable rather than glanceable.
 *
 * The pane is also the project's **hub**. The config console and the content
 * viewer are global entry points in the sidebar and stay that way - DESIGN.md
 * 5b says why, and nothing here changes it: a destination reachable only
 * through a project pane would be a destination a collapsed tree could hide.
 * What the links here add is the *scope*. From the sidebar both panes open on
 * whatever scope they last had and the user picks this project out of a
 * switcher; from here they open on it already. A second route to a pane that is
 * still reachable without it is not the failure that rule is about.
 */
export function ProjectPane({
  project,
  onReveal,
  onLaunch,
  launching = false,
  launchError = null,
  onSaveAsProfile,
  onOpenConfig,
  onOpenContent,
  pulls = null,
  onOpenPull,
  onRefreshPulls,
  onUnignoreRepo
}: ProjectPaneProps): JSX.Element {
  const { inventory } = project
  const { repo, ignored } = projectPulls(pulls, project.path)

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
          {/* Pushed to the far end, and ghosts rather than outlines: these go
              somewhere, the two on the left do something. Two more bordered
              controls in the row would read as a four-button toolbar and bury
              the launch button in it - the same call the title bar's settings
              button makes beside the theme toggle. They carry the sidebar's own
              icons, so a link and its destination are the same object. */}
          {(onOpenConfig ?? onOpenContent) && (
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {onOpenConfig && (
                <PaneLink
                  mark="config"
                  onClick={() => onOpenConfig(project)}
                  title={`Open the config console on ${project.name}`}
                  icon={<SlidersIcon width={13} height={13} />}
                >
                  Config
                </PaneLink>
              )}
              {onOpenContent && (
                <PaneLink
                  mark="content"
                  onClick={() => onOpenContent(project)}
                  title={`Open the content viewer on ${project.name}`}
                  icon={<BookIcon width={13} height={13} />}
                >
                  Content
                </PaneLink>
              )}
            </span>
          )}
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

        <PullRequests
          repo={repo}
          ignored={ignored}
          snapshot={pulls}
          {...(onOpenPull ? { onOpenPull } : {})}
          {...(onRefreshPulls ? { onRefresh: onRefreshPulls } : {})}
          {...(onUnignoreRepo ? { onUnignore: onUnignoreRepo } : {})}
        />
      </div>
    </div>
  )
}

/**
 * This project's open pull requests, or the reason there is no list.
 *
 * **Absent, not empty, for a project the surface has nothing to say about.** A
 * folder with no github.com origin is most folders, and a panel on every one of
 * them saying so would be a paragraph of nothing repeated down the tree. What
 * earns the panel is a repository the sweep has mapped - including one with no
 * pull requests open, which is a fact - or one the ignore list is keeping off
 * the surface, which is a fact about a setting and may never be silent.
 *
 * The **age caption is mandatory**, as it is on the Pulls pane and for the same
 * reason: this list is a mirror of something on a server, so it is always old,
 * and a count with no age is a claim about right now that nothing here can
 * make. Degradation is stale-with-age - the rows stay and the reason goes
 * beside them - which is the opposite of what the usage figures do, because a
 * pull request that was open two hours ago is a true fact about two hours ago.
 */
function PullRequests({
  repo,
  ignored,
  snapshot,
  onOpenPull,
  onRefresh,
  onUnignore
}: {
  repo: PullRepo | null
  ignored: IgnoredRepo | null
  snapshot: PullsSnapshot | null
  onOpenPull?: ((repo: PullRepo, pull: PullSummary) => void) | undefined
  onRefresh?: ((repoPath: string) => void) | undefined
  onUnignore?: ((slug: string) => void) | undefined
}): JSX.Element | null {
  // One clock for the panel, ticking whether or not the snapshot moves - an
  // age that only repainted with new data would go on saying "fetched 1m ago"
  // for the rest of the afternoon.
  const now = useNow()

  if (repo === null && ignored === null) return null

  if (repo === null) {
    // Ignored. The panel says which setting, and stands beside its undo - the
    // reveal direction only, exactly as the Pulls pane does. Ticking it back on
    // is in Settings, with the rest of the settings.
    const slug = ignored?.slug ?? ''
    return (
      <Panel title="Pull requests" mark="pulls-ignored" className="mt-2">
        <p className="text-[12px] text-fg-muted">
          Pull requests for <span className="font-mono text-[11.5px]">{slug}</span> are not being
          fetched - the repository is on Helm&apos;s ignore list.
        </p>
        {onUnignore && (
          <button
            type="button"
            data-project-unignore={slug}
            onClick={() => onUnignore(slug)}
            className={cn(
              'mt-2.5 rounded-well border border-border-strong px-3 py-1',
              'text-[11.5px] text-fg transition-colors hover:bg-hover'
            )}
          >
            Fetch this repository again
          </button>
        )}
      </Panel>
    )
  }

  const problem = snapshot?.gh.problem ?? null
  const fetching = snapshot?.fetching ?? false

  return (
    <Panel
      title="Pull requests"
      mark="pulls"
      className="mt-2"
      caption={
        <>
          <span className="font-mono text-[10.5px]">{repo.slug}</span>
          {/* Full strength, like the Pulls pane header's own separators: this
              is a caption a reader parses, not a row they scan past. */}
          <span aria-hidden>·</span>
          {/* Mandatory. See the component comment. */}
          <span data-project-pulls-caption>{fetchedCaption(repo.fetchedAtMs, now)}</span>
        </>
      }
      action={
        onRefresh && (
          <button
            type="button"
            data-project-pulls-refresh
            onClick={() => onRefresh(repo.path)}
            disabled={fetching}
            title={`Check ${repo.slug ?? repo.name} for open pull requests now`}
            aria-label="Check for open pull requests"
            className={cn(
              'grid size-6 shrink-0 place-items-center rounded text-fg-subtle transition-colors',
              'hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-50'
            )}
          >
            <RefreshIcon className={cn(fetching && 'animate-spin')} />
          </button>
        )
      }
    >
      {/* The repository's own failure, painted above rows that survive it. A
          machine-wide problem is not repeated here: the sidebar and the Pulls
          pane both carry it, and a third copy on every project pane would be
          the same sentence three times on one screen. */}
      {repo.error !== null && (
        <p
          data-project-pulls-error
          className="mb-2 rounded-raised border border-warn/30 bg-warn/10 px-3 py-1.5 text-[11.5px] leading-[1.55] text-warn"
        >
          {repo.error}
        </p>
      )}

      {repo.pulls.length === 0 ? (
        <p className="text-[12px] text-fg-subtle">
          {repo.error !== null || problem !== null
            ? 'Nothing was fetched.'
            : 'Nothing open in this repository.'}
        </p>
      ) : (
        // Negative inset so a row's hover well and its 2px selection edge line
        // up with the panel's own padding rather than sitting inside it.
        <div className="-mx-2 -mb-1">
          {repo.pulls.map((pull) => (
            <PullRow
              key={pull.number}
              repo={repo}
              pull={pull}
              now={now}
              // The panel names the repository twice already - in the caption
              // and in the pane's own title. DESIGN.md's source pill is for a
              // list flattened out of its groups, which this is not.
              showRepo={false}
              {...(onOpenPull ? { onOpen: onOpenPull } : {})}
            />
          ))}
        </div>
      )}
    </Panel>
  )
}

function Panel({
  title,
  mark,
  caption,
  action,
  children,
  className
}: {
  title: string
  /** `data-project-panel`, so a driver can scope a read to one panel. */
  mark?: string
  /** Sits beside the label, in the meta style. For facts about the panel. */
  caption?: ReactNode
  /** Pinned right on the label row. For a control that acts on the panel. */
  action?: ReactNode
  children: ReactNode
  className?: string | undefined
}): JSX.Element {
  return (
    // A raised surface inside the island: one ramp step lighter, 8px radius,
    // no shadow (DESIGN.md "Island anatomy").
    <section
      {...(mark === undefined ? {} : { 'data-project-panel': mark })}
      className={cn('rounded-raised border border-border bg-surface-raised px-4 py-3.5', className)}
    >
      {/* A bare label is a bare `h2`, not a one-child flex row. The row exists
          only when there is something to sit beside, because a flex item does
          not wrap the way a block does: the longest of these labels is "What
          this project would contribute to a session", and as a `shrink-0` flex
          child it held the panel wider than a 300px docked pane and put a
          horizontal scrollbar under the whole thing. */}
      {caption === undefined && !action ? (
        <h2 className={cn('mb-2.5', LABEL)}>{title}</h2>
      ) : (
        <div className="mb-2.5 flex items-baseline gap-2">
          <h2 className={LABEL}>{title}</h2>
          {caption !== undefined && (
            <p className="flex min-w-0 items-baseline gap-1.5 truncate text-[10.5px] text-fg-muted">
              {caption}
            </p>
          )}
          {action !== undefined && action !== false && (
            <span className="-my-1 ml-auto shrink-0 self-center">{action}</span>
          )}
        </div>
      )}
      {children}
    </section>
  )
}

/**
 * A link out of this pane and into another one, scoped to this project.
 *
 * A **secondary button** (DESIGN.md 4), the same shape as "Save as profile"
 * beside it. It was a ghost first, on the reasoning that four outlined controls
 * in one row read as a toolbar - and that was the wrong trade. Nothing in this
 * app has a pointer cursor (`body { cursor: default }` in theme.css: it is
 * desktop chrome, not a document), so a control's whole claim to being a
 * control is its shape. Strip the outline and what is left is two words that
 * happen to sit at the end of a row, with a hover tint nobody hovers long
 * enough to find.
 *
 * What separates these from the two actions is the gap, not the weight: they
 * are pushed to the far end of the row, and the launch button keeps the only
 * accent outline on screen. Weight was being asked to carry a distinction that
 * position already carried, and it cost the affordance.
 */
function PaneLink({
  mark,
  onClick,
  title,
  icon,
  children
}: {
  /** `data-project-link`, so a driver can reach the link by where it goes. */
  mark: string
  onClick: () => void
  title: string
  icon: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      data-project-link={mark}
      onClick={onClick}
      title={title}
      className={cn(
        'flex items-center gap-2 rounded-well border border-border-strong px-3 py-1.5',
        'text-[12px] text-fg transition-colors hover:bg-hover active:bg-active'
      )}
    >
      <span className="text-accent">{icon}</span>
      {children}
    </button>
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
