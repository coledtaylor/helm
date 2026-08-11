import type { JSX, KeyboardEvent, ReactNode } from 'react'
import { Fragment, useMemo } from 'react'
import type { HistoryPage, HistoryPrompt, HistorySession, HistorySummary } from '@helm/core'
import { cn } from '../lib/cn'
import { formatAge, formatBytes, formatMoment } from '../lib/time'
import { PaneBack } from './PaneBack'
import { CloseIcon, HistoryIcon, RefreshIcon, ResumeIcon, SearchIcon } from './icons'

export type HistoryGrouping = 'recent' | 'project'

export interface SessionHistoryProps {
  summary: HistorySummary | null
  page: HistoryPage | null
  loading: boolean
  error?: string | null | undefined

  search: string
  onSearchChange: (value: string) => void
  grouping: HistoryGrouping
  onGroupingChange: (value: HistoryGrouping) => void
  resumableOnly: boolean
  onResumableOnlyChange: (value: boolean) => void
  project: string | null
  onProjectChange: (value: string | null) => void

  selected: HistorySession | null
  onSelect: (session: HistorySession | null) => void
  prompts: HistoryPrompt[]
  promptsLoading: boolean

  onRefresh: () => void
  refreshing: boolean

  onResume: (session: HistorySession) => void
  /** Session id whose resume is in flight. */
  resuming: string | null
  resumeError?: string | null | undefined
  onDismissResumeError: () => void

  onReveal: (path: string) => void

  /**
   * Docked beside a session split, where the list and the detail cannot both be
   * readable. The pane then shows one at a time: the list until a session is
   * picked, then the detail with a way back.
   */
  compact?: boolean | undefined
}

/**
 * Why a session cannot be reopened, or null when it can.
 *
 * The same two conditions the main process checks before it will spawn
 * anything, kept apart rather than collapsed into a boolean: a reaped
 * transcript is permanent and a missing folder is not, and telling the user
 * which one they are looking at is the difference between an explanation and a
 * shrug.
 */
type Blocked = 'reaped' | 'folder-gone' | null

function blockedBy(session: HistorySession): Blocked {
  if (!session.projectExists) return 'folder-gone'
  if (session.transcriptFile === null) return 'reaped'
  return null
}

const BADGE: Record<Exclude<Blocked, null>, string> = {
  reaped: 'history only',
  'folder-gone': 'folder gone'
}

/**
 * Every session on the machine, which `/resume` cannot show you.
 *
 * The CLI's picker reads the working directory it was started in. This reads
 * `~/.claude/history.jsonl`, which is every prompt ever submitted anywhere -
 * 799 sessions across 36 projects on the machine this was built against - and
 * cross-references the transcripts that survive.
 *
 * The load-bearing honesty is that only some of them can be reopened. Claude
 * Code reaps transcripts on its own schedule and keeps the prompts forever, so
 * most of this list is a record rather than a door. A row that offered a resume
 * and then dropped the user into a terminal printing "No conversation found"
 * would be worse than not listing it, so resumability is on the row, on the
 * badge and on the button, and the reaped ones show what is actually left.
 */
export function SessionHistory({
  summary,
  page,
  loading,
  error = null,
  search,
  onSearchChange,
  grouping,
  onGroupingChange,
  resumableOnly,
  onResumableOnlyChange,
  project,
  onProjectChange,
  selected,
  onSelect,
  prompts,
  promptsLoading,
  onRefresh,
  refreshing,
  onResume,
  resuming,
  resumeError = null,
  onDismissResumeError,
  onReveal,
  compact = false
}: SessionHistoryProps): JSX.Element {
  const sessions = useMemo(() => page?.sessions ?? [], [page])
  // One at a time, and only when narrow: at full width both fit and swapping
  // them would cost a click for nothing.
  const showList = !compact || selected === null
  const showDetail = !compact || selected !== null

  /** Sessions in strip order, with a header before each project's first row. */
  const groups = useMemo(() => {
    if (grouping !== 'project') return null
    const byProject = new Map<string, { label: string; path: string; rows: HistorySession[] }>()
    for (const session of sessions) {
      const key = session.project.toLowerCase()
      const group = byProject.get(key) ?? {
        label: session.projectName,
        path: session.project,
        rows: []
      }
      group.rows.push(session)
      byProject.set(key, group)
    }
    // The map preserves insertion order, and `sessions` is already ordered by
    // recency - so the busiest-most-recent project leads without a second sort.
    return [...byProject.values()]
  }, [sessions, grouping])

  /** Arrow keys walk the list; the rows are buttons, so focus is the selection. */
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-session]')]
    const at = rows.findIndex((row) => row === document.activeElement)
    const next = rows[at < 0 ? 0 : at + step]
    if (!next) return
    event.preventDefault()
    next.focus()
    next.click()
  }

  return (
    // Islands with canvas gutters, like every other console (DESIGN.md).
    <div className="flex h-full min-h-0 flex-col gap-2">
      <header className="flex h-11 shrink-0 items-center gap-3 rounded-island border border-border bg-surface px-4">
        <HistoryIcon width={15} height={15} className="shrink-0 text-accent" />
        <h1 className="text-[13px] font-medium tracking-tight text-fg">Session history</h1>
        {summary && (
          <p className="min-w-0 truncate text-[11px] text-fg-subtle">
            <Count n={summary.sessions} one="session" /> · <Count n={summary.prompts} one="prompt" />{' '}
            · <Count n={summary.projects} one="project" /> ·{' '}
            <span className="text-fg-muted">{summary.resumable.toLocaleString()} resumable</span>
          </p>
        )}
        <span className="flex-1" />
        {summary?.error !== undefined && (
          <span className="truncate text-[11px] text-danger" title={summary.error}>
            {summary.error}
          </span>
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          title={
            summary
              ? `Re-read ${summary.historyFile}`
              : 'Re-read the history file'
          }
          aria-label="Re-read the history file"
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded text-fg-subtle transition-colors',
            'hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-50'
          )}
        >
          <RefreshIcon className={cn(refreshing && 'animate-spin')} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 gap-2">
        {/* ------------------------------------------------------------- */}
        {/* The list                                                       */}
        {/* ------------------------------------------------------------- */}
        {/* Proportional rather than fixed: the rows carry prompt text, which is
            what the list is for, and a fixed 380px truncated most of it while
            leaving the detail pane two thirds empty. Bounded at both ends so a
            narrow window still leaves room for the detail and a wide one does
            not stretch a list of one-line rows across half a monitor. */}
        {showList && (
        <div
          className={cn(
            'flex flex-col overflow-hidden rounded-island border border-border bg-surface',
            compact ? 'min-w-0 flex-1' : 'w-[38%] max-w-[560px] min-w-[340px] shrink-0'
          )}
        >
          <div className="shrink-0 space-y-2 p-2">
            <div className="relative">
              <SearchIcon
                width={13}
                height={13}
                className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-subtle"
              />
              <input
                data-history-search
                value={search}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="Search prompts and projects"
                spellCheck={false}
                aria-label="Search prompts and projects"
                className={cn(
                  'h-7 w-full rounded-well border border-border bg-surface-sunken pr-7 pl-7',
                  'text-[12px] text-fg select-text placeholder:text-fg-subtle',
                  'focus:border-accent focus:outline-none'
                )}
              />
              {search !== '' && (
                <button
                  type="button"
                  onClick={() => onSearchChange('')}
                  aria-label="Clear the search"
                  title="Clear the search"
                  className="absolute top-1/2 right-1.5 grid size-4 -translate-y-1/2 place-items-center rounded text-fg-subtle hover:text-fg"
                >
                  <CloseIcon width={10} height={10} />
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <div
                role="group"
                aria-label="Grouping"
                className="flex gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
              >
                <Segment
                  active={grouping === 'recent'}
                  onClick={() => onGroupingChange('recent')}
                  label="Recent"
                />
                <Segment
                  active={grouping === 'project'}
                  onClick={() => onGroupingChange('project')}
                  label="By project"
                />
              </div>
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-fg-muted">
                <input
                  type="checkbox"
                  checked={resumableOnly}
                  onChange={(event) => onResumableOnlyChange(event.target.checked)}
                  className="size-3 accent-[var(--helm-accent)]"
                />
                Resumable only
              </label>
            </div>

            {project !== null && (
              <button
                type="button"
                onClick={() => onProjectChange(null)}
                title={`Stop filtering by ${project}`}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded border border-accent/40 bg-accent-soft',
                  'px-2 py-1 text-left text-[11px] text-fg'
                )}
              >
                <span className="min-w-0 flex-1 truncate font-mono">{project}</span>
                <CloseIcon width={10} height={10} className="shrink-0 text-fg-subtle" />
              </button>
            )}

            <p className="flex items-baseline gap-1.5 text-[11px] text-fg-subtle">
              <span className="tabular-nums">
                {page ? `${page.total.toLocaleString()} shown` : 'Reading…'}
              </span>
              {page && page.total > page.sessions.length && (
                <span className="tabular-nums">
                  (first {page.sessions.length.toLocaleString()})
                </span>
              )}
              <span className="flex-1" />
              {page && (
                <span
                  className="tabular-nums"
                  title={`The index answered this query in ${page.tookMs.toFixed(2)} ms`}
                >
                  {page.tookMs < 1 ? '<1' : Math.round(page.tookMs)} ms
                </span>
              )}
            </p>
          </div>

          {error !== null && (
            <p className="m-2 rounded-raised border border-danger/30 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
              {error}
            </p>
          )}

          {/* A plain group of buttons, not a listbox: the rows are activated
              rather than picked from, and the arrow keys below move focus,
              which is what a button group is expected to do. */}
          <div
            role="group"
            aria-label="Sessions"
            onKeyDown={onListKeyDown}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
          >
            {sessions.length === 0 ? (
              <EmptyList loading={loading} filtering={search !== '' || resumableOnly || project !== null} />
            ) : groups ? (
              groups.map((group) => (
                <Fragment key={group.path.toLowerCase()}>
                  <button
                    type="button"
                    onClick={() => onProjectChange(group.path)}
                    title={`Show only ${group.path}`}
                    className={cn(
                      'sticky top-0 z-10 mt-3 flex w-full items-baseline gap-2 bg-surface px-2 py-1',
                      'text-left text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase',
                      'first:mt-0 hover:text-fg'
                    )}
                  >
                    <span className="min-w-0 truncate">{group.label}</span>
                    <span className="tabular-nums">{group.rows.length}</span>
                  </button>
                  {group.rows.map((session) => (
                    <Row
                      key={session.sessionId}
                      session={session}
                      search={search}
                      selected={selected?.sessionId === session.sessionId}
                      onSelect={onSelect}
                      showProject={false}
                    />
                  ))}
                </Fragment>
              ))
            ) : (
              sessions.map((session) => (
                <Row
                  key={session.sessionId}
                  session={session}
                  search={search}
                  selected={selected?.sessionId === session.sessionId}
                  onSelect={onSelect}
                  showProject
                />
              ))
            )}
          </div>
        </div>
        )}

        {/* ------------------------------------------------------------- */}
        {/* The detail                                                     */}
        {/* ------------------------------------------------------------- */}
        {showDetail && (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-island border border-border bg-surface">
          {compact && selected !== null && (
            <PaneBack label="All sessions" onBack={() => onSelect(null)} />
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
          {selected === null ? (
            <NothingSelected summary={summary} />
          ) : (
            <Detail
              session={selected}
              prompts={prompts}
              promptsLoading={promptsLoading}
              onResume={onResume}
              resuming={resuming === selected.sessionId}
              resumeError={resumeError}
              onDismissResumeError={onDismissResumeError}
              onReveal={onReveal}
              onProjectChange={onProjectChange}
              totalSessions={summary?.sessions ?? 0}
              totalResumable={summary?.resumable ?? 0}
            />
          )}
          </div>
        </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function Row({
  session,
  search,
  selected,
  onSelect,
  showProject
}: {
  session: HistorySession
  search: string
  selected: boolean
  onSelect: (session: HistorySession) => void
  showProject: boolean
}): JSX.Element {
  const blocked = blockedBy(session)
  // The searched-for text if this row matched on something other than its
  // opening prompt, so a hit deep in a conversation is visible from the list.
  const headline = session.match ?? session.firstPrompt
  const isMatch = session.match !== undefined && session.match !== session.firstPrompt

  return (
    <button
      type="button"
      aria-current={selected}
      data-session={session.sessionId}
      data-resumable={blocked === null}
      onClick={() => onSelect(session)}
      title={`${session.projectName} · ${formatMoment(session.lastAt)}`}
      className={cn(
        'relative flex w-full flex-col gap-0.5 rounded-well py-1.5 pr-2 pl-4 text-left',
        'transition-colors',
        selected ? 'bg-accent-soft' : 'hover:bg-hover'
      )}
    >
      {/* Resumability, drawn twice on purpose: a filled mark here for scanning
          the list, and the word on the badge for anyone who cannot use the
          difference between a filled and a hollow dot. */}
      <span
        aria-hidden
        className={cn(
          'absolute top-[9px] left-1.5 size-1.5 rounded-full',
          blocked === null ? 'bg-accent' : 'border border-fg-subtle opacity-60'
        )}
      />
      <span
        className={cn(
          'block truncate text-[12px]',
          blocked === null ? 'text-fg' : 'text-fg-muted'
        )}
      >
        {headline.trim() === '' ? (
          <span className="text-fg-subtle italic">no prompt</span>
        ) : (
          <Highlight text={headline} needle={search} />
        )}
      </span>
      <span className="flex items-baseline gap-1.5 text-[10px] text-fg-subtle">
        {showProject && <span className="min-w-0 truncate">{session.projectName}</span>}
        <span className="shrink-0 tabular-nums">{formatAge(session.lastAt)}</span>
        <span className="shrink-0 tabular-nums">
          {session.promptCount} {session.promptCount === 1 ? 'prompt' : 'prompts'}
        </span>
        {isMatch && <span className="shrink-0 text-accent">matched</span>}
        <span className="flex-1" />
        {blocked !== null && (
          <span className="shrink-0 rounded-sm border border-border px-1 text-[9px] tracking-wide text-fg-subtle uppercase">
            {BADGE[blocked]}
          </span>
        )}
      </span>
    </button>
  )
}

/**
 * The searched-for run, marked in place.
 *
 * Matched with `indexOf` on lowercased copies rather than a built regex: the
 * needle is whatever was typed, and `.` or `(` in a search box must not become
 * syntax.
 */
function Highlight({ text, needle }: { text: string; needle: string }): JSX.Element {
  const term = needle.trim()
  if (term === '') return <>{text}</>

  const haystack = text.toLowerCase()
  const lower = term.toLowerCase()
  const parts: ReactNode[] = []
  let at = 0
  let found = haystack.indexOf(lower, at)
  let key = 0
  while (found >= 0) {
    if (found > at) parts.push(text.slice(at, found))
    parts.push(
      <mark key={key++} className="rounded-[2px] bg-accent/25 px-px text-inherit">
        {text.slice(found, found + term.length)}
      </mark>
    )
    at = found + term.length
    found = haystack.indexOf(lower, at)
  }
  if (parts.length === 0) return <>{text}</>
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

function Segment({
  active,
  onClick,
  label
}: {
  active: boolean
  onClick: () => void
  label: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-[5px] px-2.5 py-0.5 text-[11px] transition-colors',
        active
          ? 'bg-surface-raised text-fg ring-1 ring-border-strong'
          : 'text-fg-muted hover:text-fg'
      )}
    >
      {label}
    </button>
  )
}

function EmptyList({ loading, filtering }: { loading: boolean; filtering: boolean }): JSX.Element {
  if (loading) return <p className="px-2 py-6 text-center text-[12px] text-fg-subtle">Reading&hellip;</p>
  return (
    <p className="px-3 py-6 text-center text-[12px] text-fg-subtle">
      {filtering ? 'No session matches that.' : 'No sessions recorded yet.'}
    </p>
  )
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function NothingSelected({ summary }: { summary: HistorySummary | null }): JSX.Element {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-md text-center">
        <HistoryIcon width={22} height={22} className="mx-auto text-fg-subtle" />
        <p className="mt-3 text-[13px] text-fg-muted">
          Every Claude Code session on this machine, not just the ones started here.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-fg-subtle">
          {summary
            ? `${summary.sessions.toLocaleString()} sessions across ${String(summary.projects)} projects. ${summary.resumable.toLocaleString()} still have a transcript and can be reopened; the rest are a record of what was asked.`
            : 'Reading the history file…'}
        </p>
      </div>
    </div>
  )
}

function Detail({
  session,
  prompts,
  promptsLoading,
  onResume,
  resuming,
  resumeError,
  onDismissResumeError,
  onReveal,
  onProjectChange,
  totalSessions,
  totalResumable
}: {
  session: HistorySession
  prompts: HistoryPrompt[]
  promptsLoading: boolean
  onResume: (session: HistorySession) => void
  resuming: boolean
  resumeError: string | null | undefined
  onDismissResumeError: () => void
  onReveal: (path: string) => void
  onProjectChange: (value: string | null) => void
  totalSessions: number
  totalResumable: number
}): JSX.Element {
  const blocked = blockedBy(session)

  return (
    <div className="mx-auto max-w-3xl px-8 py-7">
      <header>
        <h2 className="text-[17px] leading-snug font-medium tracking-tight text-fg">
          {session.firstPrompt.trim() === '' ? (
            <span className="text-fg-subtle italic">Session with no recorded prompt</span>
          ) : (
            <span className="line-clamp-3 break-words">{session.firstPrompt}</span>
          )}
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-subtle">
          <button
            type="button"
            onClick={() => onProjectChange(session.project)}
            title={`Show only ${session.project}`}
            className="max-w-full truncate font-mono text-fg-muted transition-colors hover:text-accent-text"
          >
            {session.project}
          </button>
          {session.projectExists && (
            <button
              type="button"
              onClick={() => onReveal(session.project)}
              className="text-accent-text transition-colors hover:underline"
            >
              Show in Explorer
            </button>
          )}
        </div>
      </header>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-2 text-[12px] sm:grid-cols-4">
        <Meta label="Started" value={formatMoment(session.firstAt)} />
        {/* The absolute moment on the value line and the age under it, rather
            than "Jul 8, 2026, 09:11 PM · 4w ago" as one string - in a quarter
            of the pane that wraps after the middle dot and reads as a broken
            sentence. */}
        <Meta
          label="Last prompt"
          value={formatMoment(session.lastAt)}
          hint={`${formatAge(session.lastAt)} ago`}
        />
        <Meta label="Prompts" value={session.promptCount.toLocaleString()} />
        <Meta
          label="Transcript"
          value={
            session.transcriptFile === null
              ? 'removed'
              : formatBytes(session.transcriptBytes ?? 0)
          }
          muted={session.transcriptFile === null}
        />
      </dl>

      <div className="mt-5">
        {blocked === null ? (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-resume={session.sessionId}
              onClick={() => onResume(session)}
              disabled={resuming}
              className={cn(
                'flex items-center gap-2 rounded-well border border-accent px-3.5 py-1.5',
                'text-[12px] font-medium text-accent-text transition-colors',
                resuming ? 'cursor-default opacity-60' : 'hover:bg-accent-soft active:bg-active'
              )}
            >
              <ResumeIcon width={14} height={14} />
              {resuming ? 'Reopening…' : 'Resume in a tab'}
            </button>
            <span className="text-[11px] text-fg-subtle">
              Runs <code className="font-mono">claude --resume</code> in{' '}
              <span className="font-mono">{session.projectName}</span>.
            </span>
          </div>
        ) : (
          <Unavailable
            reason={blocked}
            session={session}
            totalSessions={totalSessions}
            totalResumable={totalResumable}
          />
        )}
      </div>

      {resumeError !== null && resumeError !== undefined && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-3 rounded-raised border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        >
          <span className="min-w-0 flex-1">{resumeError}</span>
          <button
            type="button"
            onClick={onDismissResumeError}
            aria-label="Dismiss"
            className="shrink-0 text-danger/70 hover:text-danger"
          >
            ×
          </button>
        </div>
      )}

      <section className="mt-7">
        <h3 className="mb-2 flex items-baseline gap-2 text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
          Prompts
          <span className="tabular-nums normal-case">{session.promptCount}</span>
        </h3>
        {promptsLoading && prompts.length === 0 ? (
          <p className="text-[12px] text-fg-subtle">Reading&hellip;</p>
        ) : (
          <ol className="overflow-hidden rounded-raised border border-border bg-surface-raised">
            {prompts.map((prompt, index) => (
              <li
                key={prompt.seq}
                className={cn(
                  'flex gap-3 px-3 py-2 text-[12px]',
                  index > 0 && 'border-t border-border'
                )}
              >
                <span
                  className="w-14 shrink-0 pt-px text-right text-[10px] tabular-nums text-fg-subtle"
                  title={formatMoment(prompt.at)}
                >
                  {formatAge(prompt.at)}
                </span>
                <span className="min-w-0 flex-1 break-words whitespace-pre-wrap text-fg-muted select-text">
                  {prompt.text.trim() === '' ? (
                    <span className="text-fg-subtle italic">empty</span>
                  ) : (
                    prompt.text
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

/**
 * What is left of a session that cannot be reopened.
 *
 * Deliberately not an error. Nothing has gone wrong - Claude Code reaps
 * transcripts and keeps prompts, and that ratio is a fact about the machine
 * worth stating rather than a failure to apologise for. The prompts below this
 * panel are the point: they are what survived.
 */
function Unavailable({
  reason,
  session,
  totalSessions,
  totalResumable
}: {
  reason: Exclude<Blocked, null>
  session: HistorySession
  totalSessions: number
  totalResumable: number
}): JSX.Element {
  return (
    <div data-unavailable={reason} className="rounded-raised border border-border bg-surface-sunken p-4">
      <p className="flex items-center gap-2 text-[12px] font-medium text-fg">
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full border border-fg-subtle opacity-60"
        />
        {reason === 'reaped'
          ? 'This conversation cannot be reopened'
          : 'The folder this ran in is gone'}
      </p>
      <p className="mt-2 text-[12px] leading-relaxed text-fg-muted">
        {reason === 'reaped' ? (
          <>
            Claude Code has removed the transcript, so there is nothing for{' '}
            <code className="font-mono">--resume</code> to restore. It keeps prompts in{' '}
            <code className="font-mono">history.jsonl</code> indefinitely and reaps the
            conversations behind them
            {totalSessions > 0 && (
              <>
                {' '}
                — {totalResumable.toLocaleString()} of {totalSessions.toLocaleString()} sessions on
                this machine still have one
              </>
            )}
            . The prompts below are what is left of this session.
          </>
        ) : (
          <>
            The transcript is still on disk, but{' '}
            <code className="font-mono break-all">{session.project}</code> is not. Claude Code
            resolves a session id against the working directory, so this conversation can only be
            reopened from that folder — restoring it is enough to make this row resumable again.
          </>
        )}
      </p>
    </div>
  )
}

function Meta({
  label,
  value,
  hint,
  muted = false
}: {
  label: string
  value: string
  hint?: string | undefined
  muted?: boolean | undefined
}): JSX.Element {
  return (
    <div>
      <dt className="text-[10px] tracking-wide text-fg-subtle uppercase">{label}</dt>
      <dd className={cn('mt-0.5 tabular-nums', muted ? 'text-fg-subtle' : 'text-fg')}>
        {value}
        {hint !== undefined && (
          <span className="block text-[11px] text-fg-subtle">{hint}</span>
        )}
      </dd>
    </div>
  )
}

function Count({ n, one }: { n: number; one: string }): JSX.Element {
  return (
    <span className="tabular-nums">
      {n.toLocaleString()} {n === 1 ? one : `${one}s`}
    </span>
  )
}
