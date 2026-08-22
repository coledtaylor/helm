import type { JSX, ReactNode } from 'react'
import type {
  LiveSession,
  SessionPort,
  SessionProcess,
  SessionRecord,
  SessionResources
} from '@helm/core'
import { sessionLabel } from '@helm/core/types'
import { cn } from '../lib/cn'
import { ROW_SELECTED } from '../lib/rows'
import { SESSION_STATE_DOT, SESSION_STATE_LABEL, type SessionState } from '../lib/sessionstate'
import { formatAge, formatMoment } from '../lib/time'
import { Chip } from './Chip'
import { PaneBack } from './PaneBack'
import { BranchIcon, GlobeIcon, PlugIcon, TerminalIcon, WarnIcon } from './icons'

/**
 * Every live Claude Code session on this machine, and what Helm's own are
 * holding.
 *
 * ## The scope split, which falls out rather than being imposed
 *
 * **Listing is machine-wide.** A `claude` started in Windows Terminal registers
 * beside anything Helm hosts, and it collides with a working tree exactly as
 * hard as a tab does. Leaving it out would make this pane answer the one
 * question it exists for - "is anybody else in this repository" - wrongly, and
 * quietly. Same rule `browser_tabs` established from the other side: listing is
 * not driving.
 *
 * **Detail is Helm's own.** Branch, argv, the process tree, the ports: Helm has
 * none of that for a session it did not spawn, so the degradation needs no
 * special case. A foreign row carries what the registry recorded and says so;
 * there is nothing to hide because there is nothing to know.
 *
 * ## Why a process tree belongs in Helm at all
 *
 * Because Helm spawned the pty, so the tree under it is **Helm's own process
 * tree** - not a reading of anybody's conversation. Nothing here parses session
 * output. What it buys is the answer metadata cannot give: that a session has a
 * container up and a dev server on 5173, which is what stops the next agent
 * being pointed at the same port.
 *
 * ## What it never merges
 *
 * "Could not look" and "nothing there" are different claims and this pane keeps
 * them apart at every level - the tree, the ports, and each process's command
 * line. A pass that failed says **unknown**; a pass that succeeded over a
 * childless session says so in those words. The alternative - an empty list for
 * both - would tell somebody a session is holding nothing at exactly the moment
 * Helm had failed to ask.
 *
 * A pass is also a **sample** and says so on screen. Long-lived children are
 * the point here; a `rg` that started and finished between two passes was never
 * caught, and the pane claims no more than it saw.
 */

/** How often main re-reads the tree while this pane is open. See `resources.ts`. */
const PASS_SECONDS = 4

export interface SessionsPaneProps {
  /** Every live session on the machine, hosted first. */
  sessions: readonly LiveSession[]
  /** When main last read the registry, epoch ms. Null before the first answer. */
  readAtMs: number | null
  /**
   * Helm's own rows, by session id - the detail half for a hosted session.
   *
   * Passed in rather than duplicated onto `LiveSession`: this is the same row
   * the tab strip is drawn from, and a second copy of a session's argv would be
   * a second thing to keep true.
   */
  records: ReadonlyMap<number, SessionRecord>
  /** What each hosted session is holding, by session id. */
  resources: ReadonlyMap<number, SessionResources>
  /** The row on screen, by pid. Null for none. */
  selectedPid: number | null
  onSelect: (session: LiveSession | null) => void
  /** Brings a hosted session's terminal tab forward. */
  onOpenSession?: ((id: number) => void) | undefined
  onReveal: (path: string) => void
  /** Docked beside a session split: list *or* detail, never both. */
  compact?: boolean | undefined
}

/**
 * What a live session's dot says.
 *
 * `running` for a session that is alive and publishing nothing, which is the
 * same fallback the tab uses and for the same reason: a status this build does
 * not recognise, or a record that has not appeared yet, must degrade to "alive"
 * rather than to a guess.
 */
function stateOf(session: LiveSession): SessionState {
  return session.activity ?? 'running'
}

function nameOf(session: LiveSession): string {
  return session.name ?? `pid ${String(session.pid)}`
}

export function SessionsPane({
  sessions,
  readAtMs,
  records,
  resources,
  selectedPid,
  onSelect,
  onOpenSession,
  onReveal,
  compact = false
}: SessionsPaneProps): JSX.Element {
  const selected = sessions.find((session) => session.pid === selectedPid) ?? null
  const showList = !compact || selected === null
  const showDetail = !compact || selected !== null

  const hosted = sessions.filter((session) => session.helmSessionId !== null)
  const foreign = sessions.filter((session) => session.helmSessionId === null)

  /*
   * Directories with more than one live session in them.
   *
   * The same collision the launch warning is about, seen from the list rather
   * than from the launch button. Counted over every session whoever started it,
   * because two agents in one working tree is the same problem whether or not
   * Helm started both.
   */
  const crowded = new Set<string>()
  const seenDirs = new Set<string>()
  for (const session of sessions) {
    if (session.cwd === null) continue
    const key = session.cwd.toLowerCase()
    if (seenDirs.has(key)) crowded.add(key)
    seenDirs.add(key)
  }

  return (
    // Islands with canvas gutters, like every other console (DESIGN.md 3).
    <div data-sessions-pane className="flex h-full min-h-0 flex-col gap-2">
      {/* The strip measures **itself**, not the window - DESIGN.md's pane-header
          rule, which is about the box a pane actually occupies. Docked beside a
          session split at the window's `minWidth` this is 171px, and the age
          on the right is `shrink-0`, so without a threshold it painted past the
          island's own edge and read as "read just". */}
      <header className="@container/head flex h-11 shrink-0 items-center gap-3 rounded-island border border-border bg-surface px-4">
        <TerminalIcon width={15} height={15} className="shrink-0 text-accent" />
        <h1 className="text-[13px] font-medium tracking-tight text-fg">Sessions</h1>
        <p className="hidden min-w-0 truncate text-[11px] text-fg-subtle @[420px]/head:block">
          {sessions.length === 0
            ? 'No Claude Code session is running on this machine'
            : `${describeCount(hosted.length, 'in Helm')} · ${describeCount(foreign.length, 'outside Helm')}`}
        </p>
        <span className="flex-1" />
        {readAtMs !== null && (
          <span
            className="hidden shrink-0 text-[10.5px] tabular-nums text-fg-subtle @[260px]/head:inline"
            title={`Claude Code's session registry was last read ${formatMoment(readAtMs)}`}
          >
            {formatAge(readAtMs) === 'now' ? 'read just now' : `read ${formatAge(readAtMs)} ago`}
          </span>
        )}
      </header>

      <div className="flex min-h-0 flex-1 gap-2">
        {/* ------------------------------------------------------------- */}
        {/* The list - machine-wide                                        */}
        {/* ------------------------------------------------------------- */}
        {showList && (
          <div
            className={cn(
              'flex flex-col overflow-hidden rounded-island border border-border bg-surface',
              compact ? 'min-w-0 flex-1' : 'w-[38%] max-w-[520px] min-w-[320px] shrink-0'
            )}
          >
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {sessions.length === 0 ? (
                <p className="px-2 py-8 text-center text-[12px] text-fg-muted">
                  Nothing is running. A session started anywhere on this machine appears here,
                  whether or not Helm started it.
                </p>
              ) : (
                <>
                  <Section label="In Helm" count={hosted.length}>
                    {hosted.map((session) => (
                      <Row
                        key={session.pid}
                        session={session}
                        selected={session.pid === selectedPid}
                        crowded={session.cwd !== null && crowded.has(session.cwd.toLowerCase())}
                        resources={
                          session.helmSessionId === null
                            ? undefined
                            : resources.get(session.helmSessionId)
                        }
                        onSelect={onSelect}
                      />
                    ))}
                    {hosted.length === 0 && (
                      <p className="px-2.5 py-2 text-[11px] text-fg-subtle">
                        Helm is hosting no sessions.
                      </p>
                    )}
                  </Section>

                  {/* Its own group rather than a badge on a flat list. The
                      difference is not decoration: everything below this
                      heading has a different set of knowable facts, and a
                      heading is how a list says that once instead of on every
                      row. */}
                  {foreign.length > 0 && (
                    <Section label="Elsewhere on this machine" count={foreign.length}>
                      {foreign.map((session) => (
                        <Row
                          key={session.pid}
                          session={session}
                          selected={session.pid === selectedPid}
                          crowded={session.cwd !== null && crowded.has(session.cwd.toLowerCase())}
                          onSelect={onSelect}
                        />
                      ))}
                    </Section>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* ------------------------------------------------------------- */}
        {/* The detail - Helm's own, for the sessions Helm has one for      */}
        {/* ------------------------------------------------------------- */}
        {showDetail && (
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-island border border-border bg-surface">
            {compact && selected !== null && (
              <PaneBack label="All sessions" onBack={() => onSelect(null)} />
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {selected === null ? (
                <NothingSelected count={sessions.length} />
              ) : (
                <Detail
                  // Remounted per session, so nothing from one row's tree is
                  // still on screen under the next one's heading.
                  key={selected.pid}
                  session={selected}
                  record={
                    selected.helmSessionId === null
                      ? null
                      : (records.get(selected.helmSessionId) ?? null)
                  }
                  resources={
                    selected.helmSessionId === null
                      ? null
                      : (resources.get(selected.helmSessionId) ?? null)
                  }
                  {...(onOpenSession ? { onOpenSession } : {})}
                  onReveal={onReveal}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function describeCount(n: number, suffix: string): string {
  return `${String(n)} ${n === 1 ? 'session' : 'sessions'} ${suffix}`
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

function Section({
  label,
  count,
  children
}: {
  label: string
  count: number
  children: ReactNode
}): JSX.Element {
  return (
    <section className="mb-1">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <span className="text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
          {label}
        </span>
        <span className="text-[9.5px] tabular-nums text-fg-subtle">{count}</span>
      </div>
      {children}
    </section>
  )
}

/**
 * One session, in the shape every list row in this app has: a state dot where a
 * kind icon would go, the name above, machine data below, a count pinned right
 * (DESIGN.md 5).
 *
 * The row carries no buttons. What there is to do with a session - bring its
 * terminal forward, look at what it is holding - is on the pane it opens, which
 * has room to say it.
 */
function Row({
  session,
  selected,
  crowded,
  resources,
  onSelect
}: {
  session: LiveSession
  selected: boolean
  crowded: boolean
  resources?: SessionResources | undefined
  onSelect: (session: LiveSession) => void
}): JSX.Element {
  const state = stateOf(session)
  const name = nameOf(session)
  const ports = resources?.ports ?? null

  return (
    <button
      type="button"
      aria-current={selected}
      data-session-pid={session.pid}
      data-session-state={state}
      data-session-hosted={session.helmSessionId !== null}
      onClick={() => onSelect(session)}
      title={`${name} - ${SESSION_STATE_LABEL[state]}\n${session.cwd ?? 'working directory not recorded'}`}
      className={cn(
        'relative flex w-full flex-col gap-0.5 rounded-well px-2.5 py-1.5 text-left transition-colors',
        selected ? ROW_SELECTED : 'hover:bg-hover'
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          data-session-dot
          className={cn('size-1.5 shrink-0 rounded-full', SESSION_STATE_DOT[state])}
        />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{name}</span>
        {session.waitingFor !== null && (
          // The CLI's own sentence, verbatim and never matched against - it
          // comes from whichever dialog is on top. It fits here where it does
          // not fit on a 240px tab, which is why the tab puts it in a hint.
          <Chip tone="warn" dense truncate title={`Waiting: ${session.waitingFor}`}>
            {session.waitingFor}
          </Chip>
        )}
        {ports !== null && ports.length > 0 && (
          <Chip
            tone="accent"
            dense
            icon={<PlugIcon width={9} height={9} />}
            title={ports.map(describePort).join('\n')}
          >
            {ports.length}
          </Chip>
        )}
      </span>
      {/* Wrapping, with a floor under the path.
          The chips are `shrink-0` and the path is not, so in a 171px pane -
          this row docked beside a session split at the window's `minWidth` -
          "shared" and "starting" took the whole line and the path rendered as
          `C:…`, which identifies nothing. The path is the fact the row is
          *about*, so it keeps 8rem and the chips drop to a line of their own,
          which is the pane header's rule one level down: things wrap rather
          than starve the thing they sit beside. */}
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-[14px]">
        <span className="min-w-[8rem] flex-1 truncate font-mono text-[10.5px] text-fg-subtle">
          {session.cwd ?? '(no working directory recorded)'}
        </span>
        {crowded && (
          // The collision, said in the list. Two sessions in one working tree
          // is the fact this whole surface exists to surface, so it is on the
          // row rather than only on the pane the row opens.
          <Chip tone="warn" dense icon={<WarnIcon width={9} height={9} />} title="More than one live session is running in this folder">
            shared
          </Chip>
        )}
        {!session.registered && (
          <Chip tone="neutral" dense title="Helm holds this process; Claude Code has not written its record yet">
            starting
          </Chip>
        )}
      </span>
    </button>
  )
}

function NothingSelected({ count }: { count: number }): JSX.Element {
  return (
    <div className="grid h-full place-items-center px-6 py-10 text-center">
      <div className="max-w-[420px]">
        <TerminalIcon width={22} height={22} className="mx-auto mb-3 text-fg-subtle" />
        <p className="text-[12.5px] text-fg-muted">
          {count === 0
            ? 'No Claude Code session is running on this machine.'
            : 'Pick a session to see what it is working in - and, for the ones Helm started, what it is holding.'}
        </p>
        <p className="mt-2 text-[11px] leading-[1.6] text-fg-subtle">
          Every live session on the machine is listed, whoever started it. Helm can only show the
          process tree and the ports for the ones it started itself.
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The detail
// ---------------------------------------------------------------------------

function Detail({
  session,
  record,
  resources,
  onOpenSession,
  onReveal
}: {
  session: LiveSession
  record: SessionRecord | null
  resources: SessionResources | null
  onOpenSession?: ((id: number) => void) | undefined
  onReveal: (path: string) => void
}): JSX.Element {
  const state = stateOf(session)
  const name = record === null ? nameOf(session) : sessionLabel(record)
  const helmSessionId = session.helmSessionId
  const cwd = session.cwd

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center gap-2.5">
        <span
          aria-hidden
          className={cn('size-2 shrink-0 rounded-full', SESSION_STATE_DOT[state])}
        />
        <h2 className="min-w-0 truncate text-[15px] font-medium tracking-tight text-fg">{name}</h2>
        {/* A hairline outline in a semantic tone, never a fill - DESIGN.md 4's
            state chip, the same one a pull request's open/merged/closed uses.
            One word carrying the whole status of the thing on screen is exactly
            what that pill is for. */}
        <StateChip state={state} waitingFor={session.waitingFor} />
        {helmSessionId === null && (
          <span className="shrink-0 rounded-full border border-border-strong px-2.5 py-0.5 text-[10px] text-fg-muted">
            outside Helm
          </span>
        )}
        <span className="flex-1" />
        {helmSessionId !== null && onOpenSession && (
          <button
            type="button"
            data-open-session-tab
            onClick={() => onOpenSession(helmSessionId)}
            className={cn(
              'flex shrink-0 items-center gap-2 rounded-well border border-border-strong px-3 py-1',
              'text-[12px] text-fg transition-colors hover:bg-hover'
            )}
          >
            <TerminalIcon width={13} height={13} className="text-accent" />
            Show the terminal
          </button>
        )}
      </header>

      <Facts>
        <Fact label="Working directory">
          {cwd === null ? (
            <Unknown>not recorded</Unknown>
          ) : (
            <button
              type="button"
              onClick={() => onReveal(cwd)}
              title="Show in Explorer"
              className="min-w-0 truncate text-left font-mono text-[11px] text-fg-muted transition-colors hover:text-accent-text"
            >
              {cwd}
            </button>
          )}
        </Fact>
        {record?.branch != null && (
          <Fact label="Branch">
            <span className="flex items-center gap-1.5 font-mono text-[11px] text-fg-muted">
              <BranchIcon width={11} height={11} className="text-fg-subtle" />
              {record.branch}
            </span>
          </Fact>
        )}
        <Fact label="Process">
          <span className="font-mono text-[11px] tabular-nums text-fg-muted">
            {session.registered
              ? String(session.pid)
              : `${String(session.pid)} (pty; no record yet)`}
          </span>
        </Fact>
        <Fact label="Started">
          <span className="text-[11px] text-fg-muted">
            {session.startedAtMs === null ? (
              <Unknown>not recorded</Unknown>
            ) : (
              <span title={formatMoment(session.startedAtMs)}>
                {formatAge(session.startedAtMs)} ago
              </span>
            )}
          </span>
        </Fact>
        {session.version !== null && (
          <Fact label="Claude Code">
            <span className="font-mono text-[11px] text-fg-muted">{session.version}</span>
          </Fact>
        )}
        {session.claudeSessionId !== null && (
          <Fact label="Conversation">
            <span className="truncate font-mono text-[11px] text-fg-muted">
              {session.claudeSessionId}
            </span>
          </Fact>
        )}
      </Facts>

      {record !== null && record.argv.length > 0 && (
        <Group label="Launched as">
          {/* Wrapped rather than scrolled, and `wrap-anywhere` because an argv
              is mostly one unbreakable Windows path: with `overflow-x-auto`
              alone a 171px pane got a tall wrapped block *and* a horizontal
              scrollbar under it, which is both degradations at once. The
              pull-request pane's diff rows settled this the same way. */}
          <pre className="rounded-raised border border-border bg-surface-raised px-3 py-2 font-mono text-[11px] leading-[1.7] wrap-anywhere whitespace-pre-wrap text-fg-muted select-text">
            {record.argv.join(' ')}
          </pre>
        </Group>
      )}

      {helmSessionId === null ? (
        <Group label="What Helm knows">
          <p className="text-[11.5px] leading-[1.6] text-fg-subtle">
            Helm did not start this session, so it has no branch, no profile, no argv, no process
            tree and no ports for it. Everything above is what Claude Code recorded about it, and
            that is the whole of what is knowable from here.
          </p>
        </Group>
      ) : (
        <>
          <Ports resources={resources} />
          <Tree resources={resources} />
        </>
      )}
    </div>
  )
}

function StateChip({
  state,
  waitingFor
}: {
  state: SessionState
  waitingFor: string | null
}): JSX.Element {
  const TONE: Record<SessionState, string> = {
    busy: 'border-accent/40 text-accent-text',
    waiting: 'border-warn/40 text-warn',
    shell: 'border-success/40 text-success',
    idle: 'border-success/40 text-success',
    running: 'border-success/40 text-success',
    ended: 'border-border-strong text-fg-muted',
    failed: 'border-danger/40 text-danger'
  }
  return (
    <span
      data-session-state-chip={state}
      title={waitingFor === null ? undefined : `Waiting: ${waitingFor}`}
      className={cn(
        'shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] whitespace-nowrap',
        TONE[state]
      )}
    >
      {SESSION_STATE_LABEL[state]}
      {waitingFor === null ? '' : ` · ${waitingFor}`}
    </span>
  )
}

/**
 * The two-column fact grid, measured against **this pane** and not the window.
 *
 * DESIGN.md's pane-header rule, at the second surface it applies to: a pane is
 * the workspace half of a split, so a `sm:` media query is a question about the
 * wrong box. Measured in `sessions-pane-dark.png` before this was a container
 * query - a 900px window put the pane in 175px and `sm:` was still true, so
 * "Working directory" and "Branch" sat side by side in 87px each and the path
 * rendered as `C:\Users…`. 420px is where two columns of a path and a branch
 * stop being two truncations.
 */
function Facts({ children }: { children: ReactNode }): JSX.Element {
  return (
    // The container is the wrapper and the query is on the grid inside it: an
    // element cannot query the container it declares, which is the mistake this
    // shape exists to avoid repeating.
    <div className="@container/facts min-w-0">
      <dl className="grid grid-cols-[minmax(0,1fr)] gap-2 @[420px]/facts:grid-cols-2">
        {children}
      </dl>
    </div>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
        {label}
      </dt>
      <dd className="flex min-w-0 items-center">{children}</dd>
    </div>
  )
}

function Group({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <h3 className="text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
        {label}
      </h3>
      {children}
    </section>
  )
}

/** Helm has nothing to say here, and says that rather than painting a zero. */
function Unknown({ children }: { children: ReactNode }): JSX.Element {
  return <span className="text-[11px] text-fg-subtle italic">{children}</span>
}

function describePort(port: SessionPort): string {
  const where = port.addresses.length === 0 ? 'address not recorded' : port.addresses.join(', ')
  return `${String(port.port)} - ${port.process} (pid ${String(port.pid)}) on ${where}`
}

/**
 * Whether a port is reachable from anywhere but this machine.
 *
 * A wildcard bind is the consequential one and it is worth saying out loud: a
 * dev server on `127.0.0.1` cannot collide with anybody else's machine, and one
 * on `0.0.0.0` can.
 */
function isLoopbackOnly(port: SessionPort): boolean {
  if (port.addresses.length === 0) return false
  return port.addresses.every(
    (address) => address === '127.0.0.1' || address === '::1' || address.startsWith('127.')
  )
}

function Ports({ resources }: { resources: SessionResources | null }): JSX.Element {
  return (
    <Group label="Listening ports">
      {resources === null || resources.ports === null ? (
        // Not an empty list. "The socket query could not run" and "this session
        // is listening on nothing" are different claims, and only one of them
        // is something to act on.
        <p data-ports-unknown className="text-[11.5px] text-fg-subtle">
          <Unknown>Unknown</Unknown> - Helm could not read the machine&rsquo;s listening sockets on
          the last pass.
        </p>
      ) : resources.ports.length === 0 ? (
        <p className="text-[11.5px] text-fg-subtle">
          Nothing in this session&rsquo;s process tree is listening.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {resources.ports.map((port) => (
            <li
              key={`${String(port.pid)}:${String(port.port)}`}
              data-session-port={port.port}
              className="flex min-w-0 items-center gap-2 rounded-well bg-surface-raised px-2.5 py-1"
            >
              <PlugIcon width={11} height={11} className="shrink-0 text-accent" />
              <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-fg">
                {port.port}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-fg-muted">
                {port.process}
                <span className="text-fg-subtle"> · {String(port.pid)}</span>
              </span>
              <Chip
                tone={isLoopbackOnly(port) ? 'neutral' : 'warn'}
                dense
                icon={<GlobeIcon width={9} height={9} />}
                title={port.addresses.join(', ')}
              >
                {isLoopbackOnly(port) ? 'loopback' : (port.addresses[0] ?? 'unknown')}
              </Chip>
            </li>
          ))}
        </ul>
      )}
    </Group>
  )
}

function Tree({ resources }: { resources: SessionResources | null }): JSX.Element {
  if (resources === null || resources.processes === null) {
    return (
      <Group label="Process tree">
        <p data-tree-unknown className="text-[11.5px] leading-[1.6] text-fg-subtle">
          <Unknown>Unknown</Unknown> - Helm could not enumerate the machine&rsquo;s processes on the
          last pass. This is not the same as the session having no children.
        </p>
      </Group>
    )
  }

  if (!resources.rootSeen) {
    return (
      <Group label="Process tree">
        <p className="text-[11.5px] leading-[1.6] text-fg-subtle">
          The session&rsquo;s own process was not in the last pass, so it has exited since Helm last
          looked.
        </p>
      </Group>
    )
  }

  const children = resources.processes.filter((process) => process.depth > 0)

  return (
    <Group label="Process tree">
      {children.length === 0 ? (
        <p className="text-[11.5px] text-fg-subtle">
          Nothing but the session itself was running when Helm last looked.
        </p>
      ) : (
        <ul data-session-tree className="flex flex-col">
          {resources.processes.map((process) => (
            <TreeRow key={process.pid} process={process} />
          ))}
        </ul>
      )}
      <p className="text-[10.5px] leading-[1.6] text-fg-subtle">
        Sampled every {PASS_SECONDS}s while this pane is open, so a child that started and finished
        between two passes was never here.
        {resources.opaque > 0 && (
          <>
            {' '}
            {resources.opaque} of {resources.processes.length}{' '}
            {resources.opaque === 1 ? 'process' : 'processes'} would not give up a command line;
            Helm assumes no elevation and reports that as unknown rather than as nothing.
          </>
        )}
      </p>
    </Group>
  )
}

function TreeRow({ process }: { process: SessionProcess }): JSX.Element {
  return (
    <li
      data-tree-pid={process.pid}
      className="flex min-w-0 items-baseline gap-2 rounded-well px-1.5 py-[3px] hover:bg-hover"
      // Indented by depth rather than nested, because a list of twelve
      // processes six deep in nested `<ul>`s spends most of its width on
      // structure that a 12px step already says.
      style={{ paddingLeft: `${String(6 + process.depth * 12)}px` }}
      title={process.commandLine ?? 'The command line was not readable for this process.'}
    >
      <span className="shrink-0 font-mono text-[11px] text-fg">{process.name}</span>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-fg-subtle">
        {process.pid}
      </span>
      {process.ports !== null && process.ports.length > 0 && (
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-accent-text">
          :{process.ports.join(' :')}
        </span>
      )}
      <span
        className={cn(
          'min-w-0 flex-1 truncate font-mono text-[10.5px]',
          process.commandLine === null ? 'text-fg-subtle italic' : 'text-fg-muted'
        )}
      >
        {process.commandLine ?? 'command line not readable'}
      </span>
    </li>
  )
}
